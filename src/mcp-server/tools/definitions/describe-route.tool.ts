/**
 * @fileoverview Tool definition for eia_describe_route. Returns metadata for a
 * leaf route: facets with valid values, data columns, frequencies, units, and
 * date range. Required reading before constructing filters for eia_query_route.
 * Facet values are fetched from separate /facet/{id} endpoints and merged.
 *
 * High-cardinality facets are capped at this boundary — `EIA_FACET_VALUE_CAP`
 * values per facet, paged with `facet` + `values_offset`. The cap is applied to
 * the response only; the service's per-route metadata cache keeps the full
 * value set, which is what the search index and offset paging read from.
 *
 * One window serves both surfaces: `format()` renders the same values the
 * output carries, so the two name the same next call. An offset past a facet's
 * last value empties the window and returns a notice naming what to page
 * against, since an empty window is otherwise shaped like an exhausted one.
 * Within that window, `format()` prints a value's alias only when it says
 * something the `id=name` pair does not; the `alias` output field is untouched.
 *
 * `values_query` narrows each facet to the values whose `id`, `name`, or
 * `alias` contains it, read from the same cached list, before the window is
 * cut — so a plant or entity ID among tens of thousands of values is one call
 * away instead of hundreds of pages. The offset then indexes the matches.
 * @module mcp-server/tools/definitions/describe-route.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getEiaApiService } from '@/services/eia/eia-service.js';

/**
 * True when a facet value's alias only repeats the `id=name` pair the rendered
 * line already carries. Surveyed across every facet in the taxonomy, an alias
 * that says nothing new takes one of two forms: the `(id) name` string EIA
 * generates for most values — `(IN) Indiana` beside `IN=Indiana` — or `name`
 * on its own.
 *
 * The second form also covers a value EIA sent without a `name`: the service
 * labels it from its own alias, so the pair reads `id=alias` and the alias is
 * printed once rather than twice.
 *
 * The comparison is whole-string, and that is the load-bearing part. Every
 * alias that does carry information carries it as a prefix on the same pair —
 * `Region: (MAT) Middle Atlantic`, `Total: (US) United States (not including
 * territory data)`, the balancing-authority codes `PJM:` / `SWPP:` / `ISNE:` —
 * so a substring test would drop precisely the aliases worth printing.
 */
const restatesPair = (alias: string, id: string, name: string): boolean => {
  const seen = alias.trim().toLowerCase();
  return seen === `(${id}) ${name}`.trim().toLowerCase() || seen === name.trim().toLowerCase();
};

/**
 * EIA sends one facet value in the taxonomy whose identifier is a single space
 * — `electricity/facility-fuel`'s `primeMover`, its unspecified-prime-mover
 * bucket, which filters real rows and so cannot be dropped. Printed raw it
 * leaves a hole in the comma-joined line (`FW=FW,  = , PV=PV`), so a reader of
 * `content[]` alone cannot see the value is there or what to pass. Quoting
 * makes the blank visible and its bounds copyable; every other value in the
 * taxonomy is non-blank and prints unchanged.
 */
const showBlank = (s: string): string => (s.trim() === '' ? `"${s}"` : s);

/**
 * True when a facet value's `id`, `name`, or `alias` contains `needle`, which
 * the caller has already lower-cased. A plain substring test rather than a
 * pattern: the query is caller text matched against EIA labels, and nothing
 * in it should read as syntax.
 */
const matchesQuery = (v: { id: string; name: string; alias?: string }, needle: string): boolean =>
  v.id.toLowerCase().includes(needle) ||
  v.name.toLowerCase().includes(needle) ||
  v.alias?.toLowerCase().includes(needle) === true;

/** An epoch-ms instant as ISO 8601 UTC to the second — `2026-10-28T09:00:00Z`. */
const utc = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

export const describeRouteTool = tool('eia_describe_route', {
  title: 'Describe EIA Route',
  description:
    'Returns metadata for a leaf route: available facets with their valid values, data column names and units, frequency options, and date range. Call this before eia_query_route to discover valid facet IDs, facet values, column IDs, and frequency codes. Each facet returns a capped window of its values with value_count and values_truncated alongside; pass facet and values_offset to page through the rest of one facet. To find a value by name in a large facet (plant, entity, and mine IDs run to thousands), pass values_query: each facet keeps only the values whose id, name, or alias contains it, values_matched counts them, and values_offset pages the matches. A values_offset past the last value of a facet returns an empty window for it and a notice naming the count to page against. Facet values are fetched from separate EIA endpoints, merged, and cached per route for 24 hours, after which the next call fetches the route again; a facet whose values EIA did not return is left out of facets, named in unavailable_facets, and fetched again by the next call. When a refresh fails, the cached values are served instead, with a notice naming when they were fetched.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputAliases: { path: 'route' },

  input: z.object({
    route: z
      .string()
      .min(1)
      .describe(
        'Leaf route path (e.g. "electricity/retail-sales", "steo"). Discoverable via eia_browse_routes or eia_search_routes. Whitespace and slashes are normalized, then one complete leading v2 segment is removed: "/v2/electricity/retail-sales/" resolves to "electricity/retail-sales". Full URLs and /data suffixes are not normalized.',
      ),
    facet: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Restrict the response to one facet by ID (e.g. "stateid"). Use with values_offset to page a facet whose values were truncated, or with values_query to find a value in it. Omit to get every facet.',
      ),
    values_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Index of the first facet value to return, applied to every facet in the response. Use the value named in a truncation hint to continue past the cap. With values_query, indexes the matching values.',
      ),
    values_query: z
      .string()
      .trim()
      .min(1, 'values_query must contain at least one non-whitespace character')
      .optional()
      .describe(
        'Keep only the facet values whose id, name, or alias contains this text, ignoring case (e.g. "palo verde" on plantCode). A plain substring match, not a pattern or a ranked search. Applied to every facet in the response, before values_offset and the cap. Leading and trailing whitespace is ignored. Omit to list every value.',
      ),
  }),

  output: z.object({
    route: z.string().describe('The route path described.'),
    description: z.string().describe('Human-readable description of the dataset.'),
    facets: z
      .array(
        z
          .object({
            id: z
              .string()
              .describe(
                'Facet ID — use as key in the filters parameter of eia_query_route (e.g. filters: { "stateid": "TX" }).',
              ),
            description: z.string().describe('Facet description.'),
            values: z
              .array(
                z
                  .object({
                    id: z.string().describe('Facet value ID — use as filter value.'),
                    name: z
                      .string()
                      .describe(
                        'Human-readable name. Falls back to the alias, then to the id, on the values EIA sends without one.',
                      ),
                    alias: z.string().optional().describe('Short alias, when provided by EIA.'),
                  })
                  .describe('A valid facet value.'),
              )
              .describe(
                'Valid values for this facet dimension, starting at values_offset and capped at EIA_FACET_VALUE_CAP. With values_query, only the matching values, in upstream order.',
              ),
            value_count: z
              .number()
              .describe(
                'Total values this facet has upstream, independent of the returned window and of values_query.',
              ),
            values_matched: z
              .number()
              .optional()
              .describe(
                'Values of this facet whose id, name, or alias contains values_query — what values_offset indexes and values_truncated is measured against. One ID listed under two historical names counts twice. Present only when values_query is set.',
              ),
            values_truncated: z
              .boolean()
              .describe(
                'True when values stops short of values_matched when values_query is set, otherwise of value_count. Call eia_describe_route again with this facet ID, the same values_query, and values_offset set to values_offset + values.length for the next page.',
              ),
          })
          .describe('A filterable dimension for this route.'),
      )
      .describe(
        'Filterable dimensions. Each facet has an ID and a window of its valid values. Restricted to one entry when the facet input is set. A facet named in unavailable_facets is left out.',
      ),
    unavailable_facets: z
      .array(z.string().describe('Facet ID whose value list EIA did not return.'))
      .optional()
      .describe(
        'Facet IDs whose value lists EIA did not return after retries, left out of facets. Each ID still filters eia_query_route — only its values are missing. Call eia_describe_route again to re-fetch these lists alone. Absent when every facet is in facets.',
      ),
    values_offset: z
      .number()
      .describe('Index of the first facet value returned, echoing the requested offset.'),
    values_query: z
      .string()
      .optional()
      .describe(
        'The values_query each facet was narrowed by, as matched after trimming. Absent when no values_query was sent.',
      ),
    data_columns: z
      .array(
        z
          .object({
            id: z.string().describe('Column ID — use in the columns parameter of eia_query_route.'),
            alias: z.string().describe('Human-readable column alias.'),
            units: z.string().describe('Measurement units (e.g. "cents per kilowatt-hour").'),
          })
          .describe('A data column available for this route.'),
      )
      .describe('Data columns available for this route.'),
    frequencies: z
      .array(
        z
          .object({
            id: z.string().describe('Frequency ID (e.g. "monthly", "annual").'),
            description: z.string().describe('Human-readable description.'),
            query: z.string().describe('API query value for this frequency.'),
            format: z.string().describe('Period format string (e.g. "YYYY-MM", "YYYY").'),
          })
          .describe('A frequency option for eia_query_route.'),
      )
      .describe('Valid frequency options for eia_query_route.'),
    date_range: z
      .object({
        start: z
          .string()
          .describe(
            'Metadata start period for the default frequency; another frequency may extend earlier.',
          ),
        end: z
          .string()
          .describe(
            'Metadata end period for the default frequency; another frequency may extend later.',
          ),
      })
      .describe(
        'Route metadata date range in the default-frequency context, not a bound across all frequencies.',
      ),
    default_frequency: z.string().describe('Default frequency ID used when none is specified.'),
    default_date_format: z
      .string()
      .describe('Period format for the default frequency (e.g. "YYYY-MM").'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Default-frequency date-range context, composed with guidance for exhausted facet windows, a values_query no value matched, unavailable facet values, or cached values served because their refresh failed.',
      ),
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
      when: 'EIA did not answer the route metadata request or the route-tree build in time: one attempt passed 45 s, or the call passed its 56 s deadline across retries. A value list that times out is named in unavailable_facets instead.',
      recovery:
        'Retry after a short wait — EIA is answering slowly; if it keeps timing out, check api.eia.gov availability.',
    },
    {
      reason: 'route_not_found',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'Route does not exist in the EIA taxonomy.',
      recovery: 'Use eia_browse_routes or eia_search_routes to discover valid leaf route paths.',
    },
    {
      reason: 'route_not_queryable',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Route is a category node with sub-routes, not a queryable leaf.',
      recovery:
        'Use eia_browse_routes to drill into sub-routes, or eia_search_routes to find leaf routes.',
    },
    {
      reason: 'facet_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The facet input names an ID the route does not expose.',
      recovery:
        "Call eia_describe_route without facet to list this route's facet IDs, then retry with one of them.",
    },
    {
      reason: 'facet_unavailable',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'The facet input names a facet whose value list EIA did not return after retries.',
      recovery:
        'Retry the same call after a short wait; without the facet input the route describes with its other facets.',
    },
    {
      reason: 'rate_limited',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'EIA rate limit hit on the route metadata request, or on the value list the facet input names.',
      recovery: 'Back off and retry; use a production EIA API key for higher rate limits.',
    },
    {
      reason: 'upstream_unreachable',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'EIA could not be reached (connection refused or reset, DNS failure) on the route metadata request or the route-tree build. A value list the facet input names fails as facet_unavailable instead.',
      recovery:
        'Retry after a short wait — EIA could not be reached; if it keeps failing, check api.eia.gov availability.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing eia_describe_route', {
      route: input.route,
      facet: input.facet,
      valuesOffset: input.values_offset,
      valuesQuery: input.values_query,
    });
    const service = getEiaApiService();
    // Naming the facet lets the service fail the call when that one list is
    // the one EIA did not return, rather than hand back an empty window.
    const meta = await service.describe(input.route, ctx, {
      ...(input.facet !== undefined && { facet: input.facet }),
    });

    const unavailable = new Set(meta.unfetchedFacets);
    let facets = meta.facets.filter((f) => !unavailable.has(f.id));
    if (input.facet) {
      const selected = facets.find((f) => f.id === input.facet);
      if (!selected) {
        throw ctx.fail('facet_not_found', `Route "${input.route}" has no facet "${input.facet}".`, {
          route: input.route,
          availableFacets: meta.facets.map((f) => f.id),
          ...ctx.recoveryFor('facet_not_found'),
        });
      }
      facets = [selected];
    }
    // A response restricted to one facet does not report on the others.
    const unavailableFacets = input.facet ? [] : [...unavailable];

    const cap = getServerConfig().facetValueCap;
    const offset = input.values_offset;
    const query = input.values_query;
    const needle = query?.toLowerCase();

    const windows = facets.map((f) => {
      // The match runs over the full cached list, never over a window, so
      // values_matched is exact and the offset pages the matches themselves.
      const pool =
        needle === undefined ? f.values : f.values.filter((v) => matchesQuery(v, needle));
      const window = pool.slice(offset, offset + cap);
      return {
        id: f.id,
        description: f.description,
        values: window.map((v) => ({
          id: v.id,
          name: v.name,
          ...(v.alias !== undefined && { alias: v.alias }),
        })),
        value_count: f.values.length,
        ...(needle !== undefined && { values_matched: pool.length }),
        values_truncated: offset + window.length < pool.length,
      };
    });

    /**
     * An offset past a facet's last value returns the same shape as a facet
     * enumerated to its end — empty values, nothing truncated — and the offset
     * applies to every facet, so one large enough to page a wide facet empties
     * every narrower one beside it. Name those facets and their counts so the
     * two cases read apart and the caller has an offset to come back with.
     * With values_query the offset indexes the matches, so the count named is
     * values_matched; a facet nothing matched is reported once, as a miss.
     */
    const notices: string[] = [
      `date_range reports route metadata for the default frequency (${meta.defaultFrequency || 'unspecified'}); another frequency may extend outside this range.`,
    ];
    const pageable = (f: (typeof windows)[number]) => f.values_matched ?? f.value_count;
    const overshot = windows.filter((f) => f.values.length === 0 && pageable(f) > 0);
    if (overshot.length > 0) {
      const named = overshot
        .map((f) => {
          const count = pageable(f);
          const counted =
            f.values_matched === undefined
              ? `${count.toLocaleString()} values`
              : `values_matched ${count.toLocaleString()}`;
          return `${f.id} (${counted}, last valid offset ${(count - 1).toLocaleString()})`;
        })
        .join(', ');
      const past =
        query === undefined ? 'value' : `value matching values_query ${JSON.stringify(query)}`;
      notices.push(
        `values_offset ${offset.toLocaleString()} is past the last ${past} of ${named}. Reduce values_offset to at most that facet's last valid offset, or pass facet to page one facet at a time so a shared offset stops emptying the narrower ones.`,
      );
    }
    /**
     * Zero matches is a successful empty window, not an error: the route and
     * facet exist and the query is well-formed. Without a notice it would read
     * like a facet with no values at all.
     */
    const missed = windows.filter((f) => f.values_matched === 0);
    if (missed.length > 0) {
      notices.push(
        `No value of ${missed.map((f) => f.id).join(', ')} has an id, name, or alias containing values_query ${JSON.stringify(query)} (case-insensitive). Try a shorter or differently spelled substring, or omit values_query to page every value.`,
      );
    }
    /**
     * A list EIA did not return is not an empty facet, so it is named rather
     * than shown with a value_count of 0 — and the retry is cheap, since the
     * next call re-fetches only these lists.
     */
    if (unavailableFacets.length > 0) {
      const one = unavailableFacets.length === 1;
      notices.push(
        `EIA did not return the values of ${unavailableFacets.join(', ')} after retries, so ${one ? 'it is' : 'they are'} left out of facets. ${one ? 'The ID still filters' : 'The IDs still filter'} eia_query_route; call eia_describe_route again to re-fetch only the missing value lists.`,
      );
    }
    /**
     * A list served from an earlier fetch because EIA did not answer its
     * refresh still pages and filters as before, so it stays in facets — but it
     * can lack values EIA added since, so the time it was fetched is named.
     */
    if (meta.stale) {
      const lists = meta.stale.facets.filter((f) => !input.facet || f.id === input.facet);
      const stale: string[] = [];
      if (meta.stale.route) {
        stale.push(
          `EIA did not answer the refresh of this route, so the description cached at ${utc(meta.fetchedAt)} is served as it stood; date_range, frequencies, data columns, and facet values may have changed since.`,
        );
      }
      if (lists.length > 0) {
        const one = lists.length === 1;
        stale.push(
          `EIA did not answer the refresh of the value ${one ? 'list' : 'lists'} of ${lists.map((f) => `${f.id} (fetched ${utc(f.fetchedAt)})`).join(', ')}, so ${one ? 'it is' : 'they are'} served as last fetched and may lack values EIA has added since.`,
        );
      }
      if (stale.length > 0) {
        notices.push(`${stale.join(' ')} The next eia_describe_route call retries the refresh.`);
      }
    }
    ctx.enrich.notice(notices.join(' '));

    return {
      route: meta.route,
      description: meta.description,
      values_offset: offset,
      ...(query !== undefined && { values_query: query }),
      facets: windows,
      ...(unavailableFacets.length > 0 && { unavailable_facets: unavailableFacets }),
      data_columns: meta.dataColumns.map((c) => ({
        id: c.id,
        alias: c.alias,
        units: c.units,
      })),
      frequencies: meta.frequencies.map((freq) => ({
        id: freq.id,
        description: freq.description,
        query: freq.query,
        format: freq.format,
      })),
      date_range: {
        start: meta.dateRange.start,
        end: meta.dateRange.end,
      },
      default_frequency: meta.defaultFrequency,
      default_date_format: meta.defaultDateFormat,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.route}`);
    if (result.description) lines.push(`\n${result.description}\n`);

    lines.push(
      `**Date range (default frequency ${result.default_frequency || 'unspecified'}):** ${result.date_range.start} → ${result.date_range.end}`,
    );
    lines.push(
      `**Default frequency:** ${result.default_frequency} (format: ${result.default_date_format})\n`,
    );

    if (result.data_columns.length) {
      lines.push('### Data columns');
      for (const col of result.data_columns) {
        lines.push(`- **${col.id}** (${col.alias}) — ${col.units}`);
      }
      lines.push('');
    }

    if (result.frequencies.length) {
      lines.push('### Frequencies');
      for (const freq of result.frequencies) {
        lines.push(
          `- **${freq.id}** (query: ${freq.query}) — ${freq.description} (format: ${freq.format})`,
        );
      }
      lines.push('');
    }

    // Quoted as a JSON string so the query reads back exactly as matched, and
    // copies into the next call intact even when it holds a quote.
    const query =
      result.values_query === undefined ? undefined : JSON.stringify(result.values_query);
    if (query !== undefined) {
      lines.push(
        `**Values query:** ${query} — each facet lists only the values whose id, name, or alias contains it, ignoring case.\n`,
      );
    }

    if (result.facets.length) {
      lines.push('### Facets (filter dimensions)');
      for (const facet of result.facets) {
        // Both surfaces render the same window, so the next call named here is
        // the one the structured fields describe. With a query, the window and
        // the offset run over the matches, not the whole facet.
        const pageable = facet.values_matched ?? facet.value_count;
        const nextOffset = result.values_offset + facet.values.length;
        const more = facet.values_truncated
          ? ` (+${pageable - nextOffset} more — eia_describe_route(route="${result.route}", facet="${facet.id}"${query === undefined ? '' : `, values_query=${query}`}, values_offset=${nextOffset}))`
          : '';
        // A window is anything short of the whole set — capped at the end, or
        // started past the beginning. The last page of a paged facet is not
        // truncated but is still a window, and reporting it as the full count
        // would contradict the values printed beside it. A narrowed facet is
        // always a window on the whole, so it always names both counts.
        const scope =
          facet.values_matched !== undefined
            ? `${facet.values.length} of ${facet.values_matched} matching values from offset ${result.values_offset}; ${facet.value_count} values in all`
            : facet.values_truncated || result.values_offset > 0
              ? `${facet.values.length} of ${facet.value_count} values from offset ${result.values_offset}`
              : `${facet.value_count} values`;
        // An emptied window has nothing to trail the em dash with. An alias
        // that only restates the pair is dropped from the line and kept on the
        // output field, where a reader can still read it directly.
        const valueList = facet.values.length
          ? ` — ${facet.values
              .map((v) => {
                const pair = `${showBlank(v.id)}=${showBlank(v.name)}`;
                return v.alias && !restatesPair(v.alias, v.id, v.name)
                  ? `${pair} (${v.alias})`
                  : pair;
              })
              .join(', ')}`
          : '';
        lines.push(`- **${facet.id}** (${scope}): ${facet.description}${valueList}${more}`);
      }
    }

    if (result.unavailable_facets?.length) {
      lines.push(
        `\n**Unavailable facets:** ${result.unavailable_facets.join(', ')} — EIA did not return their values; each ID still filters eia_query_route. Call eia_describe_route(route="${result.route}") again to re-fetch only these lists.`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
