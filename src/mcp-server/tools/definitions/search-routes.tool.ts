/**
 * @fileoverview Tool definition for eia_search_routes. Fuzzy text search across
 * route names, descriptions, and category labels using an in-memory Fuse.js
 * index. Resolves natural-language queries to route paths. Two further entry
 * classes join the index and answer with a `filter_hint`: named series (STEO's
 * 1,469 and SEDS's 968 `seriesId` values) and facet values — fuel types,
 * sectors, coal ranks, RTO respondents, and the `series` and `product` values of
 * the daily and weekly petroleum and natural-gas routes, where benchmarks such
 * as Henry Hub, WTI, and Cushing live — so a query naming a value resolves to
 * the route that exposes it. Facet values of any route the caller describes
 * join too. A multi-term query is additionally matched term by term, which is
 * what reaches the route behind a commodity + metric + sector question, and a
 * query spelling the end of a route's path ("retail sales") ranks that route
 * first as an exact match; `route-cache.ts` carries the mechanism and
 * `scripts/eval-search.ts` measures it.
 *
 * The first call waits for the whole corpus to warm, because a ranking over a
 * half-filled index is indistinguishable from a ranking over the full one: the
 * entry that belongs in the top slot is simply absent, and a mediocre hit takes
 * its place. That wait is capped, so an upstream slow enough to outlast the
 * caller still gets an answer out. `indexComplete` reports whether the wait
 * ended in a complete corpus; `indexGaps` names what is missing when it did not,
 * and the next search retries an index pass named there.
 *
 * `truncated` is measured, not inferred: the service looks one match past the
 * cap, so a search that ends exactly at `limit` reads as complete. `limit`
 * accepts positive integers but each call returns at most `SEARCH_RESULT_CAP`; a larger
 * value is served at the cap and disclosed rather than rejected.
 *
 * A query shaped like a legacy APIv1 series ID (`PET.RWTC.W`) is resolved
 * through EIA's `/v2/seriesid` lookup before any text search: a hit is the one
 * result, at score 0, carrying `frequency` and `columns` beside its route and
 * `filter_hint`, and needs no warm index. A miss or a failed lookup answers
 * with the text search plus a notice; lookup failures never fail the call, so
 * `errors[]` names none of them.
 * @module mcp-server/tools/definitions/search-routes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEiaApiService } from '@/services/eia/eia-service.js';
import { MAX_SEARCHED_QUERY_LENGTH } from '@/services/eia/route-cache.js';

/** Most results one call returns, whatever `limit` asks for. */
const SEARCH_RESULT_CAP = 30;

/**
 * Score above which a hit is labelled a weak match.
 *
 * Derived by running `scripts/search-battery.ts` through `scripts/eval-search.ts`
 * against the live corpus, 5,459 entries as warmed before any describe. The
 * measurement finds two clusters: the routes the battery's answerable queries
 * surface score at or below 0.6582, and the queries the taxonomy cannot answer
 * score at or above 0.7632. 0.72 sits between them, and no battery query falls
 * between 0.6582 and 0.7632. The off-target floor is `ticket prices` against
 * the `Spot Prices` route, as it was at 3,165 entries, before benchmark series,
 * products, and RTO respondents were indexed. Indexing the 161 plant names of
 * the annual `densified-biomass/wood-pellet-plants` route's `respondent` facet
 * too would lower it to 0.7454 (`cat food` reaching `Vulcan Wood Products`),
 * which is why that facet stays out of the warm.
 *
 * One case falls on the wrong side, and it does not move by choosing a
 * different number — it sits above every off-target score, so any threshold
 * that clears it stops flagging noise. `recoverable reserves` scores 0.8326 on
 * the route whose description contains that exact phrase, and is labelled weak.
 * Fuse penalizes a match this far into a long description, and scoring the
 * terms separately does not help because each term is buried just as deep. This
 * is the benign direction: the caller is told to try again on an answer that
 * was in fact good.
 *
 * The number this replaced (0.9) was miscalibrated independently of the
 * tokenized path. The battery's own off-target queries understate it — they
 * are mostly long nonsense that scores 1.0000 under either path, so 0.9 leaves
 * two unflagged (`ticket prices` 0.7632, `airline ticket prices` 0.8581).
 * Short two- and three-word probes are where the label earns its keep: over 30
 * of them, measured at 3,165 entries, 0.9 left four
 * unanswerable queries unflagged and 0.72 left one (`rent prices`, 0.385 —
 * `rent` is a substring of `current`, which `VERBATIM_TERM_LENGTH` admits and a
 * word-boundary rule would not).
 *
 * Two things move this value, and both need `eval-search.ts` re-run. A fuse.js
 * upgrade moves the whole scale — weighted scores shifted upward wholesale
 * between 7.4.2 and 7.5.0, when raw key weights began being normalized before
 * becoming score exponents. Editing `FUSE_OPTIONS` or the candidate-gate
 * constants in `route-cache.ts` moves it for the same reason. Growing the
 * corpus does not move the phrase path — Fuse scores each entry against the
 * pattern on its own — but it does move the tokenized path, whose term weights
 * are document frequencies over the whole corpus.
 * `tests/services/route-cache.test.ts` guards the calibration.
 */
export const WEAK_MATCH_SCORE = 0.72;

export const searchRoutesTool = tool('eia_search_routes', {
  title: 'Search EIA Routes',
  description:
    'Fuzzy text search across route names, descriptions, and category labels. Resolves natural-language queries like "electricity retail sales by state" or "natural gas imports" to matching route paths. Multi-term queries are also matched term by term, so combining a commodity, a metric, and a sector — "electricity price residential", "coal generation industrial sector" — reaches the route carrying that data even when no single entry reads like the whole phrase. A query spelling the end of a route path in words — "retail sales" for electricity/retail-sales — ranks that route first. STEO and SEDS series names are indexed so queries like "crude oil production forecast" or "motor gasoline total consumption" also resolve, and so are facet values, so a fuel type or sector term like "wind" or "anthracite coal" resolves to the route that exposes it, with filter_hint carrying the filter to pass on. That includes the series and product names of the daily and weekly petroleum and natural-gas routes and the RTO balancing authorities, so benchmarks like "Henry Hub", "WTI crude spot price", "Cushing", or "Electric Reliability Council of Texas" resolve before any describe. A legacy APIv1 series ID as the EIA website and Excel add-in write them — "PET.RWTC.W", "ELEC.PRICE.TX-RES.M" — is resolved through the EIA series lookup into one result with its route, filter_hint, frequency, and columns, ready for eia_query_route, without waiting on the index. Results include isLeaf so you know whether to browse further or query directly. Results with score > 0.72 are weak matches — try a more specific query or use eia_browse_routes to explore the taxonomy. The first call after server start waits 20-40s while the index warms, and at most 45s; later calls answer from the built index. Check indexComplete before reading anything into a short or empty result set.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    query: z
      .string()
      .trim()
      .min(1, 'query must contain at least one non-whitespace character')
      .describe(
        `Free-text search terms to match against route names and descriptions, or a legacy APIv1 series ID (e.g. "PET.RWTC.W": three or more dot-separated segments ending in a frequency code A, Q, M, W, D, H, HL, or 4; any case). Leading and trailing whitespace is ignored, and only the first ${MAX_SEARCHED_QUERY_LENGTH} characters are searched.`,
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .default(10)
      .describe(
        `Maximum results to return (default 10). One call returns at most ${SEARCH_RESULT_CAP}; a larger limit is served at ${SEARCH_RESULT_CAP}, and truncated says whether more matches exist.`,
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            route: z
              .string()
              .describe('Route path — usable directly in eia_describe_route or eia_query_route.'),
            name: z.string().describe('Human-readable route name.'),
            description: z.string().describe('Route description.'),
            score: z
              .number()
              .describe(
                'Match score: 0 = exact, 1 = no match. Lower is better; above 0.72 the match is unreliable. On a multi-term query it is the better of the whole-phrase score and a per-term score that penalizes each query term the entry does not carry. A resolved series ID scores 0.',
              ),
            isLeaf: z
              .boolean()
              .describe(
                'True when the route is a queryable leaf; false when it has sub-routes to browse.',
              ),
            filter_hint: z
              .record(z.string(), z.string())
              .optional()
              .describe(
                'Pre-built filter for eia_query_route when a specific facet value is required. Present on STEO and SEDS series results and facet-value results — fuel, sector, and RTO respondent values, and the series and product values of daily and weekly petroleum and natural-gas routes (e.g. {"series": "RNGWHHD"} on natural-gas/pri/fut) — and on a resolved series ID, where it holds every facet EIA maps the ID to, values as EIA writes them (e.g. {"sectorid": "RES", "stateid": "TX"}). Pass directly as filters (e.g. eia_query_route(route="seds", filters=filter_hint)).',
              ),
            frequency: z
              .string()
              .optional()
              .describe(
                'Frequency ID the series is published at (e.g. "weekly", "local-hourly"). Present only on a resolved series ID; pass as eia_query_route frequency.',
              ),
            columns: z
              .array(z.string())
              .optional()
              .describe(
                'Data column IDs the series reads (e.g. ["price"]). Present only on a resolved series ID; pass as eia_query_route columns.',
              ),
          })
          .describe('A search result entry.'),
      )
      .describe('Ranked matches, best first.'),
  }),

  enrichment: {
    effectiveQuery: z
      .string()
      .describe(
        `Query as searched — the submitted text with surrounding whitespace trimmed, cut to its first ${MAX_SEARCHED_QUERY_LENGTH} characters.`,
      ),
    totalIndexed: z
      .number()
      .describe(
        'Total entries in the search index: routes, STEO and SEDS series names, and the facet values indexed at warm time, plus the facet values of every route described since the server started — so the count grows with describe calls.',
      ),
    indexComplete: z
      .boolean()
      .describe(
        'True when this answer was ranked against the complete warm-time corpus. False means part of it is missing (see indexGaps) — results may be short, and a better match may exist that was never scored. Facet values folded in by eia_describe_route are additional and never count toward completeness. A resolved series ID is answered by EIA, not ranked, so it does not depend on this.',
      ),
    indexGaps: z
      .array(z.string())
      .optional()
      .describe(
        'Present only when indexComplete is false: route paths whose metadata could not be fetched (call eia_browse_routes on one to re-fetch it) and index passes that did not land ("steo_series", "seds_series", "facet_values"), which the next search retries.',
      ),
    truncated: z
      .boolean()
      .describe('True when more matches exist past the ones returned; false when these are all.'),
    shown: z.number().describe('Number of results returned.'),
    cap: z
      .number()
      .describe(
        `Most results this call could return — limit, or ${SEARCH_RESULT_CAP} when limit was larger.`,
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Discloses requested/effective limits when clamped and says when only the start of the query was searched; names a resolved series ID (saying so when EIA reports no rows for it), or says the lookup of a query shaped like one found nothing or failed (the results are then the text search); and gives guidance when no routes matched or more matches exist.',
      ),
  },

  /** A custom render supplies the whole trailer line, label included. */
  enrichmentTrailer: {
    indexGaps: { render: (gaps: string[]) => `**indexGaps:** ${gaps.join(', ')}` },
  },

  errors: [
    {
      reason: 'upstream_invalid_response',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'EIA returned an unusable response body or a missing route or data envelope.',
      recovery: 'Retry after a short wait; if it persists, check api.eia.gov availability.',
    },
    {
      reason: 'upstream_unavailable',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'EIA answered with a retryable HTTP service failure.',
      recovery: 'Retry after a short wait; if it persists, check api.eia.gov availability.',
    },
    {
      reason: 'upstream_timeout',
      thrownBy: 'service',
      code: JsonRpcErrorCode.Timeout,
      retryable: true,
      when: 'EIA did not answer in time while the first call after server start built the route tree. An index pass that times out does not fail the search; it is reported in indexGaps.',
      recovery:
        'Retry after a short wait — EIA is answering slowly; if it keeps timing out, check api.eia.gov availability.',
    },
    {
      reason: 'rate_limited',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'EIA rate limit hit (OVER_RATE_LIMIT) while building the route tree on the first call after server start.',
      recovery: 'Back off and retry; use a production EIA API key for higher rate limits.',
    },
    {
      reason: 'upstream_unreachable',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'EIA could not be reached (connection refused or reset, DNS failure) while building the route tree on the first call after server start.',
      recovery:
        'Retry after a short wait — EIA could not be reached; if it keeps failing, check api.eia.gov availability.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing eia_search_routes', { query: input.query, limit: input.limit });
    const service = getEiaApiService();
    const cap = Math.min(input.limit, SEARCH_RESULT_CAP);
    const { results, hasMore, seriesId, status } = await service.search(input.query, cap, ctx);

    const gaps = [...status.incompleteRoutes, ...status.pendingPasses];
    const searched = input.query.slice(0, MAX_SEARCHED_QUERY_LENGTH);

    ctx.enrich.echo(searched);
    ctx.enrich({
      totalIndexed: status.size,
      shown: results.length,
      cap,
      truncated: false,
      indexComplete: status.complete,
      ...(gaps.length > 0 && { indexGaps: gaps }),
    });
    let resultsNotice: string | undefined;
    if (results.length === 0) {
      resultsNotice = status.complete
        ? `No routes matched "${searched}". Try different search terms or use eia_browse_routes to explore the taxonomy.`
        : `No routes matched "${searched}", but part of the corpus is missing (see indexGaps) — a match may exist that was never scored. Try eia_browse_routes to explore the taxonomy directly.`;
    } else if (hasMore) {
      ctx.enrich({ truncated: true });
      resultsNotice =
        input.limit < SEARCH_RESULT_CAP
          ? `More matches exist — narrow the query or raise limit (max ${SEARCH_RESULT_CAP}).`
          : `More matches exist — one call returns at most ${SEARCH_RESULT_CAP}; narrow the query to reach the rest.`;
    }
    let seriesIdNotice: string | undefined;
    switch (seriesId?.outcome) {
      case 'resolved':
        seriesIdNotice = seriesId.empty
          ? `Resolved APIv1 series ID ${seriesId.seriesId} to route ${seriesId.entry.route} through EIA's series lookup, but EIA reports no rows for that mapping, so eia_query_route with it returns none; search for the series by name, or use eia_describe_route with values_query to find its current ID.`
          : `Resolved APIv1 series ID ${seriesId.seriesId} to route ${seriesId.entry.route} through EIA's series lookup; pass filter_hint, frequency, and columns to eia_query_route.`;
        break;
      case 'unrecognized':
        seriesIdNotice = `${seriesId.seriesId} has the shape of an APIv1 series ID, but EIA does not recognize it; these are text-search results for "${searched}".`;
        break;
      case 'failed':
        seriesIdNotice = `${seriesId.seriesId} has the shape of an APIv1 series ID, but looking it up failed${seriesId.reason ? ` (${seriesId.reason})` : ''}; these are text-search results${seriesId.retryable ? ' — retry to resolve the ID' : ''}.`;
        break;
    }
    const notice = [
      input.limit > cap ? `Requested limit ${input.limit} was clamped to ${cap}.` : undefined,
      searched.length < input.query.length
        ? `Only the first ${MAX_SEARCHED_QUERY_LENGTH} characters of the query were searched.`
        : undefined,
      seriesIdNotice,
      resultsNotice,
    ]
      .filter(Boolean)
      .join(' ');
    if (notice) ctx.enrich.notice(notice);

    return {
      results: results.map(({ entry, score }) => ({
        route: entry.route,
        name: entry.name,
        description: entry.description,
        score,
        isLeaf: entry.isLeaf,
        ...(entry.filter_hint !== undefined && { filter_hint: entry.filter_hint }),
        ...(entry.frequency !== undefined && { frequency: entry.frequency }),
        ...(entry.columns !== undefined && { columns: entry.columns }),
      })),
    };
  },

  format: (result) => {
    const lines: string[] = [];

    if (result.results.length === 0) {
      lines.push(
        'No matching routes found. Try different search terms or browse with eia_browse_routes.',
      );
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push(`**${result.results.length} result(s)**\n`);
    for (const r of result.results) {
      const tag = r.isLeaf ? '[leaf]' : '[cat]';
      const weakMatch = r.score > WEAK_MATCH_SCORE ? ' ⚠ weak match' : '';
      lines.push(`${tag} **${r.route}** (score: ${r.score.toFixed(3)}${weakMatch})`);
      lines.push(`  ${r.name}`);
      if (r.description) lines.push(`  ${r.description}`);
      // Every argument is written as JSON, so the line runs as a call verbatim.
      const args: string[] = [];
      if (r.filter_hint) {
        const hint = Object.entries(r.filter_hint)
          .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
          .join(', ');
        args.push(`filters={${hint}}`);
      }
      if (r.frequency !== undefined) args.push(`frequency=${JSON.stringify(r.frequency)}`);
      if (r.columns !== undefined)
        args.push(`columns=[${r.columns.map((c) => JSON.stringify(c)).join(', ')}]`);
      if (args.length > 0) {
        lines.push(
          `  Query with: \`eia_query_route(route=${JSON.stringify(r.route)}, ${args.join(', ')})\``,
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
