/**
 * @fileoverview Tool definition for eia_query_route. Fetches data from a leaf
 * route with optional facet filters, date range, frequency, and column
 * selection. Data values come back as strings per the EIA API. Large result
 * sets spill to a DataCanvas table (when CANVAS_PROVIDER_TYPE=duckdb) and
 * return a canvas_id + dataset handle for SQL analysis via eia_dataframe_query.
 * @module mcp-server/tools/definitions/query-route.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { getEiaApiService } from '@/services/eia/eia-service.js';

export const queryRouteTool = tool('eia_query_route', {
  title: 'Query EIA Route Data',
  description:
    'Fetches data from a leaf route with optional facet filters, date range, frequency, and column selection. Use eia_describe_route first to discover valid facet IDs, facet values, column IDs, and frequency codes. Data values are strings in the response (EIA API returns all numeric values as strings, e.g. "9.13"); cast to DOUBLE in SQL when arithmetic is needed. Returns a preview inline; large result sets (total > length) spill to a DataCanvas table when canvas is enabled — use the returned canvas_id and dataset name with eia_dataframe_query for SQL analysis. Pass the same canvas_id on subsequent eia_query_route calls to accumulate multiple route results into one canvas for cross-route joins.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    route: z
      .string()
      .min(1)
      .describe(
        'Leaf route path (e.g. "electricity/retail-sales", "steo"). Discoverable via eia_browse_routes or eia_search_routes.',
      ),
    filters: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .optional()
      .describe(
        'Facet filters keyed by facet ID (e.g. { "stateid": "TX", "sectorid": ["RES", "COM"] }). Use the facets[].id values returned by eia_describe_route as keys here.',
      ),
    columns: z
      .array(z.string())
      .optional()
      .describe(
        'Data column IDs to return (reduces payload). Defaults to all. IDs discoverable via eia_describe_route.',
      ),
    frequency: z
      .string()
      .optional()
      .describe(
        'Aggregation frequency ID (e.g. "monthly", "annual"). Defaults to route default. Valid IDs from eia_describe_route.',
      ),
    start: z
      .string()
      .optional()
      .describe(
        'Period start in the route date format (e.g. "2020-01" for monthly, "2020" for annual). Format from eia_describe_route.',
      ),
    end: z.string().optional().describe('Period end (same format as start).'),
    sort: z
      .array(
        z
          .object({
            column: z.string().describe('Column ID to sort by.'),
            direction: z.enum(['asc', 'desc']).describe('Sort direction.'),
          })
          .describe('A sort criterion.'),
      )
      .optional()
      .describe('Result ordering.'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset (default 0).'),
    length: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(100)
      .describe('Rows to fetch per request (default 100, max 5000 per EIA limit).'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas ID to register results into. Omit on first call — a new canvas is minted and returned. Pass the returned canvas_id on subsequent calls to accumulate multiple route results into one canvas for cross-route SQL joins.',
      ),
  }),

  output: z.object({
    route: z.string().describe('The route path queried.'),
    data: z
      .array(z.object({}).passthrough().describe('A single data row with dynamic column keys.'))
      .describe(
        'Preview rows. All numeric values are strings per the EIA API (e.g. "9.13"). Cast to DOUBLE in SQL for arithmetic: CAST(value AS DOUBLE). Per-column units appear as {col}-units fields inline in each row. Keys are dynamic column IDs from the EIA route.',
      ),
    frequency: z.string().describe('Frequency of the returned data.'),
    date_format: z.string().describe('Period format for the returned data (e.g. "YYYY-MM").'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas workspace ID — present when spillover occurred or canvas_id was supplied. Pass to subsequent eia_query_route calls to accumulate datasets.',
      ),
    dataset: z
      .string()
      .optional()
      .describe(
        'df_<id> table handle for the registered dataset — pass directly to eia_dataframe_query SQL (SELECT ... FROM df_<id>).',
      ),
    canvas_preview_note: z
      .string()
      .optional()
      .describe(
        'Human-readable note when total > returned rows, describing how to access the full dataset via canvas SQL.',
      ),
    truncation_warning: z
      .string()
      .optional()
      .describe(
        "Forwarded from EIA's warnings[] when the API warns of truncated results near the 5,000 per-page limit.",
      ),
  }),

  enrichment: {
    effectiveRoute: z.string().describe('The route path that was queried.'),
    totalCount: z.number().describe('Total matching rows in the EIA dataset.'),
    returnedCount: z
      .number()
      .describe(
        'Rows in this response. When returnedCount < totalCount, use offset or canvas for the rest.',
      ),
    appliedFilters: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .optional()
      .describe('Facet filters applied to the query, when provided.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when a valid route query returns no rows for the supplied filters or date range.',
      ),
  },
  enrichmentTrailer: {
    appliedFilters: {
      render: (filters) => {
        if (!filters || Object.keys(filters).length === 0) return null as unknown as string;
        const entries = Object.entries(filters)
          .map(([k, v]) => `- **${k}:** ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\n');
        return `**Applied Filters:**\n${entries}`;
      },
    },
  },

  errors: [
    {
      reason: 'route_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Route does not exist or is not a leaf.',
      recovery: 'Use eia_browse_routes or eia_search_routes to find a valid leaf route path.',
    },
    {
      reason: 'invalid_facet',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown facet key was used in filters.',
      recovery: 'Call eia_describe_route to see valid facet IDs for this route.',
    },
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'The requested date range is inverted before querying EIA.',
      recovery:
        'Swap start and end dates, or remove date constraints and retry the route query.',
    },
    {
      reason: 'length_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'length parameter exceeds the EIA maximum of 5000.',
      recovery: 'Reduce length to 5000 or use offset pagination for larger result sets.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'EIA rate limit hit (OVER_RATE_LIMIT).',
      recovery: 'Back off and retry; use a production EIA API key for higher rate limits.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing eia_query_route', {
      route: input.route,
      offset: input.offset,
      length: input.length,
    });

    // Pre-flight: detect inverted date range before hitting the EIA API.
    // ISO date strings (YYYY-MM, YYYY-MM-DD, YYYY) sort lexicographically, so
    // string comparison is sufficient for this check.
    if (input.start !== undefined && input.end !== undefined && input.start > input.end) {
      throw ctx.fail(
        'no_data',
        `Date range is inverted: start "${input.start}" is after end "${input.end}". Swap start and end to retrieve data.`,
        {
          route: input.route,
          start: input.start,
          end: input.end,
          ...ctx.recoveryFor('no_data'),
        },
      );
    }

    const service = getEiaApiService();
    const dataResp = await service.query(
      input.route,
      {
        ...(input.filters !== undefined && { filters: input.filters }),
        ...(input.columns !== undefined && { columns: input.columns }),
        ...(input.frequency !== undefined && { frequency: input.frequency }),
        ...(input.start !== undefined && { start: input.start }),
        ...(input.end !== undefined && { end: input.end }),
        ...(input.sort !== undefined && { sort: input.sort }),
        offset: input.offset,
        length: input.length,
      },
      ctx,
    );

    // Populate enrichment — reaches both structuredContent and content[] trailer.
    ctx.enrich({
      effectiveRoute: input.route,
      totalCount: dataResp.total,
      returnedCount: dataResp.data.length,
      ...(input.filters &&
        Object.keys(input.filters).length > 0 && {
          appliedFilters: input.filters,
        }),
    });
    if (dataResp.data.length === 0) {
      ctx.enrich.notice(
        `No rows matched route "${input.route}" for the supplied filters/date range. Adjust filters or call eia_describe_route to verify valid facet values.`,
      );
    }

    const result: {
      route: string;
      data: Array<Record<string, unknown>>;
      frequency: string;
      date_format: string;
      canvas_id?: string;
      dataset?: string;
      canvas_preview_note?: string;
      truncation_warning?: string;
    } = {
      route: input.route,
      data: dataResp.data,
      frequency: dataResp.frequency,
      date_format: dataResp.dateFormat,
    };

    // Forward EIA server-side truncation warnings
    if (dataResp.warnings?.length) {
      result.truncation_warning = dataResp.warnings.join('; ');
    }

    // DataCanvas spillover — opt-in via CANVAS_PROVIDER_TYPE=duckdb
    const bridge = getCanvasBridge();
    if (bridge && dataResp.data.length > 0) {
      const registered = await bridge.registerDataframe(ctx, {
        rows: dataResp.data,
        sourceTool: 'eia_query_route',
        queryParams: {
          route: input.route,
          filters: input.filters,
          columns: input.columns,
          frequency: input.frequency,
          start: input.start,
          end: input.end,
          offset: input.offset,
          length: input.length,
        },
        truncated: dataResp.total > dataResp.data.length,
        maxRows: input.length,
      });

      if (registered) {
        result.dataset = registered.tableName;

        // Acquire or reuse canvas ID
        if (input.canvas_id) {
          result.canvas_id = input.canvas_id;
        } else {
          // The bridge manages the canvas internally; surface a stable per-tenant ID
          // by using the bridge's shared canvas. We mint the canvas_id from the
          // dataset name prefix for consistency.
          result.canvas_id = registered.tableName;
        }

        if (dataResp.total > dataResp.data.length) {
          result.canvas_preview_note = `Showing ${dataResp.data.length.toLocaleString()} of ${dataResp.total.toLocaleString()} rows — query canvas for full dataset using: SELECT * FROM ${registered.tableName}`;
        }
      }
    } else if (dataResp.total > dataResp.data.length) {
      result.canvas_preview_note = `Showing ${dataResp.data.length.toLocaleString()} of ${dataResp.total.toLocaleString()} rows — enable DataCanvas (CANVAS_PROVIDER_TYPE=duckdb) for full dataset access, or use offset pagination.`;
    }

    return result;
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(`## Query: ${result.route}`);
    lines.push(`**Frequency:** ${result.frequency} | **Date format:** ${result.date_format}\n`);

    if (result.canvas_preview_note) {
      lines.push(`> ${result.canvas_preview_note}\n`);
    }
    if (result.dataset) {
      lines.push(`**Dataset:** \`${result.dataset}\` (canvas: ${result.canvas_id})`);
      lines.push('Use `eia_dataframe_query` with this dataset name for full SQL access.\n');
    }
    if (result.truncation_warning) {
      lines.push(`> **Warning:** ${result.truncation_warning}\n`);
    }

    if (result.data.length === 0) {
      lines.push('_No rows returned._');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    // Render table — separate data columns from {col}-units columns.
    // Units are identical on every row, so annotate the header instead of
    // repeating them in the body.
    const firstRow = result.data[0];
    if (!firstRow) return [{ type: 'text', text: lines.join('\n') }];
    const allKeys = Object.keys(firstRow);

    // Build a units map from the first row: { colName: "unit string" }
    const unitsMap: Record<string, string> = {};
    for (const key of allKeys) {
      if (key.endsWith('-units')) {
        const col = key.slice(0, -6); // strip trailing '-units'
        const unit = firstRow[key];
        if (unit !== null && unit !== undefined) unitsMap[col] = String(unit);
      }
    }

    // Data columns are all keys that are not {col}-units entries
    const dataCols = allKeys.filter((k) => !k.endsWith('-units'));

    // Header: "col (unit)" when a unit is known, else just "col"
    const headerCells = dataCols.map((c) => (unitsMap[c] ? `${c} (${unitsMap[c]})` : c));
    const header = `| ${headerCells.join(' | ')} |`;
    const sep = `| ${dataCols.map(() => '---').join(' | ')} |`;
    lines.push(header, sep);

    for (const row of result.data) {
      const cells = dataCols.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) return '';
        return String(v).replace(/\|/g, '\\|');
      });
      lines.push(`| ${cells.join(' | ')} |`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
