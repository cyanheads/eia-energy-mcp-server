/**
 * @fileoverview Tool definition for eia_search_routes. Fuzzy text search across
 * route names, descriptions, and category labels using an in-memory Fuse.js
 * index. Resolves natural-language queries to route paths. Two further entry
 * classes join the index and answer with a `filter_hint`: STEO series names
 * (1,469 entries) and facet values — fuel types, sectors, coal ranks — so a
 * query naming a value resolves to the route that exposes it. A multi-term
 * query is additionally matched term by term, which is what reaches the route
 * behind a commodity + metric + sector question; `route-cache.ts` carries the
 * mechanism and `scripts/eval-search.ts` measures it.
 *
 * The first call waits for the whole corpus to warm, because a ranking over a
 * half-filled index is indistinguishable from a ranking over the full one: the
 * entry that belongs in the top slot is simply absent, and a mediocre hit takes
 * its place. That wait is capped, so an upstream slow enough to outlast the
 * caller still gets an answer out. `indexComplete` reports whether the wait
 * ended in a complete corpus; `indexGaps` names what is missing when it did not.
 * @module mcp-server/tools/definitions/search-routes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getEiaApiService } from '@/services/eia/eia-service.js';

/**
 * Score above which a hit is labelled a weak match.
 *
 * Derived by running `scripts/search-battery.ts` through `scripts/eval-search.ts`
 * against the live 2,103-entry corpus. The measurement found two clusters: the
 * routes the battery's answerable queries surface score at or below 0.6600, and
 * the queries the taxonomy cannot answer score at or above 0.7632. 0.72 sits
 * between them, and no battery query falls between 0.6600 and 0.7632.
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
 * tokenized path. The battery's own off-target queries do not show it — they
 * are mostly long nonsense that scores 1.0000 under either path, so 0.9 leaves
 * only `ticket prices` (0.7632) unflagged. Short two- and three-word probes are
 * where the label earns its keep: over 30 of them, 0.9 leaves four unanswerable
 * queries unflagged and 0.72 leaves one (`rent prices`, 0.385 — `rent` is a
 * substring of `current`, which `VERBATIM_TERM_LENGTH` admits and a
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
    'Fuzzy text search across route names, descriptions, and category labels. Resolves natural-language queries like "electricity retail sales by state" or "natural gas imports" to matching route paths. Multi-term queries are also matched term by term, so combining a commodity, a metric, and a sector — "electricity price residential", "coal generation industrial sector" — reaches the route carrying that data even when no single entry reads like the whole phrase. STEO series names are indexed so queries like "ethanol net imports" or "crude oil production forecast" also resolve, and so are facet values, so a fuel type or sector term like "wind" or "anthracite coal" resolves to the route that exposes it, with filter_hint carrying the filter to pass on. Results include isLeaf so you know whether to browse further or query directly. Results with score > 0.72 are weak matches — try a more specific query or use eia_browse_routes to explore the taxonomy. The first call after server start waits 24-30s while the index warms, and at most 45s; every later call returns in milliseconds. Check indexComplete before reading anything into a short or empty result set.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe('Free-text search terms to match against route names and descriptions.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(10)
      .describe('Maximum results to return (default 10, max 30).'),
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
                'Match score: 0 = exact, 1 = no match. Lower is better; above 0.72 the match is unreliable. On a multi-term query it is the better of the whole-phrase score and a per-term score that penalizes each query term the entry does not carry.',
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
                'Pre-built filter for eia_query_route when a specific facet value is required. Present on STEO series and facet-value results — pass directly as filters (e.g. eia_query_route(route="steo", filters=filter_hint)).',
              ),
          })
          .describe('A search result entry.'),
      )
      .describe('Ranked matches, best first.'),
  }),

  enrichment: {
    effectiveQuery: z.string().describe('Query as submitted to the Fuse.js index.'),
    totalIndexed: z
      .number()
      .describe('Total entries in the search index (routes + STEO series names + facet values).'),
    indexComplete: z
      .boolean()
      .describe(
        'True when this answer was ranked against the complete corpus. False means part of it is missing (see indexGaps) — results may be short, and a better match may exist that was never scored.',
      ),
    indexGaps: z
      .array(z.string())
      .optional()
      .describe(
        'Present only when indexComplete is false: route paths whose metadata could not be fetched (call eia_browse_routes on one to re-fetch it) and index passes that did not land ("steo_series", "facet_values").',
      ),
    truncated: z.boolean().describe('True when matches were capped at limit; more may exist.'),
    shown: z.number().describe('Number of results returned.'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no routes matched — suggests alternative queries or using eia_browse_routes.',
      ),
  },

  /** A custom render supplies the whole trailer line, label included. */
  enrichmentTrailer: {
    indexGaps: { render: (gaps: string[]) => `**indexGaps:** ${gaps.join(', ')}` },
  },

  async handler(input, ctx) {
    ctx.log.info('Executing eia_search_routes', { query: input.query, limit: input.limit });
    const service = getEiaApiService();
    const { results, status } = await service.search(input.query, input.limit, ctx);

    const gaps = [...status.incompleteRoutes, ...status.pendingPasses];

    ctx.enrich.echo(input.query);
    ctx.enrich({
      totalIndexed: status.size,
      shown: results.length,
      cap: input.limit,
      truncated: false,
      indexComplete: status.complete,
      ...(gaps.length > 0 && { indexGaps: gaps }),
    });
    if (results.length === 0) {
      ctx.enrich.notice(
        status.complete
          ? `No routes matched "${input.query}". Try different search terms or use eia_browse_routes to explore the taxonomy.`
          : `No routes matched "${input.query}", but part of the corpus is missing (see indexGaps) — a match may exist that was never scored. Try eia_browse_routes to explore the taxonomy directly.`,
      );
    } else if (results.length >= input.limit) {
      ctx.enrich.truncated({
        shown: results.length,
        cap: input.limit,
        guidance: 'More matches may exist — narrow the query or raise limit (max 30).',
      });
    }

    return {
      results: results.map(({ entry, score }) => ({
        route: entry.route,
        name: entry.name,
        description: entry.description,
        score,
        isLeaf: entry.isLeaf,
        ...(entry.filter_hint !== undefined && { filter_hint: entry.filter_hint }),
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
      if (r.filter_hint) {
        const hint = Object.entries(r.filter_hint)
          .map(([k, v]) => `"${k}": "${v}"`)
          .join(', ');
        lines.push(`  Query with: \`eia_query_route(route="${r.route}", filters={${hint}})\``);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
