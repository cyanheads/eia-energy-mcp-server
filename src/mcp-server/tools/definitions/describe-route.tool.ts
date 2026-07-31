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
 * @module mcp-server/tools/definitions/describe-route.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getEiaApiService } from '@/services/eia/eia-service.js';

/**
 * Facet values rendered per facet in `content[]`. Independent of the
 * structuredContent cap: this is a readability preview inside a prose block,
 * that is a payload budget. The two surfaces therefore stop at different
 * offsets, and each truncation hint names the offset its own surface reached.
 */
const FORMAT_PREVIEW_VALUES = 5;

export const describeRouteTool = tool('eia_describe_route', {
  title: 'Describe EIA Route',
  description:
    'Returns metadata for a leaf route: available facets with their valid values, data column names and units, frequency options, and date range. Call this before eia_query_route to discover valid facet IDs, facet values, column IDs, and frequency codes. Each facet returns a capped window of its values with value_count and values_truncated alongside; pass facet and values_offset to page through the rest of one facet. Facet values are fetched from separate EIA endpoints and merged — results are cached per-route for the process lifetime to minimize API calls.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    route: z
      .string()
      .min(1)
      .describe(
        'Leaf route path (e.g. "electricity/retail-sales", "steo"). Discoverable via eia_browse_routes or eia_search_routes.',
      ),
    facet: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Restrict the response to one facet by ID (e.g. "stateid"). Use with values_offset to page a facet whose values were truncated. Omit to get every facet.',
      ),
    values_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Index of the first facet value to return, applied to every facet in the response. Use the value named in a truncation hint to continue past the cap.',
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
                    name: z.string().describe('Human-readable name.'),
                    alias: z.string().optional().describe('Short alias, when provided by EIA.'),
                  })
                  .describe('A valid facet value.'),
              )
              .describe(
                'Valid values for this facet dimension, starting at values_offset and capped at EIA_FACET_VALUE_CAP.',
              ),
            value_count: z
              .number()
              .describe(
                'Total values this facet has upstream, independent of the returned window.',
              ),
            values_truncated: z
              .boolean()
              .describe(
                'True when values stops short of value_count. Call eia_describe_route again with this facet ID and values_offset set to values_offset + values.length for the next page.',
              ),
          })
          .describe('A filterable dimension for this route.'),
      )
      .describe(
        'Filterable dimensions. Each facet has an ID and a window of its valid values. Restricted to one entry when the facet input is set.',
      ),
    values_offset: z
      .number()
      .describe('Index of the first facet value returned, echoing the requested offset.'),
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
        start: z.string().describe('Earliest available period.'),
        end: z.string().describe('Latest available period.'),
      })
      .describe('Available date range for this route.'),
    default_frequency: z.string().describe('Default frequency ID used when none is specified.'),
    default_date_format: z
      .string()
      .describe('Period format for the default frequency (e.g. "YYYY-MM").'),
  }),

  errors: [
    {
      reason: 'route_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Route does not exist in the EIA taxonomy.',
      recovery: 'Use eia_browse_routes or eia_search_routes to discover valid leaf route paths.',
    },
    {
      reason: 'route_not_queryable',
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
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'EIA rate limit hit during facet fan-out.',
      recovery: 'Back off and retry; use a production EIA API key for higher rate limits.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing eia_describe_route', {
      route: input.route,
      facet: input.facet,
      valuesOffset: input.values_offset,
    });
    const service = getEiaApiService();
    const meta = await service.describe(input.route, ctx);

    let facets = meta.facets;
    if (input.facet) {
      const selected = facets.find((f) => f.id === input.facet);
      if (!selected) {
        throw ctx.fail('facet_not_found', `Route "${input.route}" has no facet "${input.facet}".`, {
          route: input.route,
          availableFacets: facets.map((f) => f.id),
          ...ctx.recoveryFor('facet_not_found'),
        });
      }
      facets = [selected];
    }

    const cap = getServerConfig().facetValueCap;
    const offset = input.values_offset;

    return {
      route: meta.route,
      description: meta.description,
      values_offset: offset,
      facets: facets.map((f) => {
        const window = f.values.slice(offset, offset + cap);
        return {
          id: f.id,
          description: f.description,
          values: window.map((v) => ({
            id: v.id,
            name: v.name,
            ...(v.alias !== undefined && { alias: v.alias }),
          })),
          value_count: f.values.length,
          values_truncated: offset + window.length < f.values.length,
        };
      }),
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

    lines.push(`**Date range:** ${result.date_range.start} → ${result.date_range.end}`);
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

    if (result.facets.length) {
      lines.push('### Facets (filter dimensions)');
      for (const facet of result.facets) {
        const preview = facet.values.slice(0, FORMAT_PREVIEW_VALUES);
        // This surface stops at its own preview length, which is shorter than
        // the window structuredContent carries — so the offset named here is
        // the one this reader actually reached, not that surface's.
        const nextOffset = result.values_offset + preview.length;
        const remaining = facet.value_count - nextOffset;
        const more =
          remaining > 0
            ? ` (+${remaining} more — eia_describe_route(route="${result.route}", facet="${facet.id}", values_offset=${nextOffset}))`
            : '';
        // A window is anything short of the whole set — capped at the end, or
        // started past the beginning. The last page of a paged facet is not
        // truncated but is still a window, and reporting it as the full count
        // would contradict the values printed beside it.
        const scope =
          facet.values_truncated || result.values_offset > 0
            ? `${facet.values.length} of ${facet.value_count} values from offset ${result.values_offset}`
            : `${facet.value_count} values`;
        const valueList = preview
          .map((v) => (v.alias ? `${v.id}=${v.name} (${v.alias})` : `${v.id}=${v.name}`))
          .join(', ');
        lines.push(`- **${facet.id}** (${scope}): ${facet.description} — ${valueList}${more}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
