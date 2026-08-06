/**
 * @fileoverview Tool definition for eia_query_route. Fetches data from a leaf
 * route with optional facet filters, date range, frequency, and column
 * selection. Data values come back as strings per the EIA API. Large result
 * sets spill to a DataCanvas table (when CANVAS_PROVIDER_TYPE=duckdb): the
 * service walks offset pages up to EIA_CANVAS_MAX_ROWS and registers the
 * accumulated set, returning a dataset handle for eia_dataframe_query SQL.
 * @module mcp-server/tools/definitions/query-route.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { getEiaApiService } from '@/services/eia/eia-service.js';
import type { EiaWarning } from '@/services/eia/types.js';

/**
 * EIA's per-page advisory: it fires whenever the requested `length` is smaller
 * than the query's `total`, and its "5000 rows in JSON format" text is fixed
 * boilerplate that appears at any size. It describes the inline page rather
 * than the result set, so once the response itself states where the caller
 * stands — the staged table reaches the last row, a notice explains the
 * row-less page, or `canvas_preview_note` places the inline page against
 * `total` where no canvas is configured — forwarding it contradicts the
 * response and sends an agent back for rows it already has. Matched on the
 * `warning` label so every other advisory EIA reports, which the response does
 * not otherwise explain, still reaches the caller.
 */
function isIncompleteReturn(warning: EiaWarning): boolean {
  return warning.warning.trim().toLowerCase() === 'incomplete return';
}

export const queryRouteTool = tool('eia_query_route', {
  title: 'Query EIA Route Data',
  description:
    'Fetches data from a leaf route with optional facet filters, date range, frequency, and column selection. Use eia_describe_route first to discover valid facet IDs, facet values, column IDs, and frequency codes. Data values are strings in the response (EIA API returns all numeric values as strings, e.g. "9.13"); cast to DOUBLE in SQL when arithmetic is needed. Returns a preview inline; when canvas is enabled and more rows match than the preview holds, additional pages are fetched and the accumulated set is staged as a DataCanvas table — pass the returned dataset name to eia_dataframe_query for SQL. Every dataset a tenant stages lands in the same canvas, so tables from different routes cross-join by name with nothing to thread between calls.',
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
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Row offset into the matching set (default 0). An offset at or beyond total returns zero rows.',
      ),
    length: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(100)
      .describe(
        'Rows in the inline preview (default 100, max 5000 per EIA limit). Canvas staging is not bounded by this — it pages past the preview on its own.',
      ),
  }),

  output: z.object({
    route: z.string().describe('The route path queried.'),
    data: z
      .array(z.object({}).passthrough().describe('A single data row with dynamic column keys.'))
      .describe(
        'Preview rows. All numeric values are strings per the EIA API (e.g. "9.13"). Cast to DOUBLE in SQL for arithmetic: CAST(value AS DOUBLE). Per-column units appear as {col}-units fields inline in each row. Keys are dynamic column IDs from the EIA route.',
      ),
    total: z
      .number()
      .describe(
        'Total matching rows in the EIA dataset for this query (may exceed returned rows when pagination or spillover applies).',
      ),
    returned_count: z
      .number()
      .describe(
        'Number of rows in this response. When returned_count < total, use offset pagination or DataCanvas for the rest.',
      ),
    frequency: z.string().describe('Frequency of the returned data.'),
    date_format: z.string().describe('Period format for the returned data (e.g. "YYYY-MM").'),
    notice: z
      .string()
      .optional()
      .describe(
        'Informational message when the response carries no rows — either zero rows matched the filters (broaden the query) or offset paged past the last row (reduce offset below total).',
      ),
    dataset: z
      .string()
      .optional()
      .describe(
        'df_<id> table handle for the registered dataset — pass directly to eia_dataframe_query SQL (SELECT ... FROM df_<id>). Every dataset a tenant stages shares one canvas, so handles from different routes join directly.',
      ),
    canvas_preview_note: z
      .string()
      .optional()
      .describe(
        'Human-readable note when total exceeds the inline preview. With a canvas configured it names how many rows actually reached the canvas table, and where in the matching set those rows sit whenever the stage does not start at row 1; when staging also stopped short of total (the EIA_CANVAS_MAX_ROWS cap, or an upstream page that did not return), it says so and gives the offset to resume from. With no canvas configured nothing is staged, so it places the inline page against total and names offset paging and CANVAS_PROVIDER_TYPE=duckdb as the ways to reach the rest.',
      ),
    truncation_warning: z
      .string()
      .optional()
      .describe(
        "Upstream advisories forwarded verbatim from EIA's warnings[], joined with '; ' when more than one applies. These describe the inline page — EIA's \"incomplete return\" entry fires whenever the requested length is under total, at any size — not a 5,000-row ceiling on this response. Absent when the response already accounts for the gap the advisory names (the staged table reaches the last row, notice explains the empty page, or canvas_preview_note places the inline page against total where no canvas is configured).",
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
    appliedStart: z
      .string()
      .optional()
      .describe('Echo of the start period as applied, when a start was provided.'),
    appliedEnd: z
      .string()
      .optional()
      .describe('Echo of the end period as applied, when an end was provided.'),
    appliedFrequency: z
      .string()
      .optional()
      .describe('Echo of the frequency as applied, when a frequency was provided.'),
    appliedColumns: z
      .array(z.string())
      .optional()
      .describe('Echo of the column projection as applied, when columns were provided.'),
    appliedSort: z
      .array(
        z
          .object({
            column: z.string().describe('Column ID sorted by.'),
            direction: z.enum(['asc', 'desc']).describe('Sort direction.'),
          })
          .describe('A sort criterion as applied.'),
      )
      .optional()
      .describe(
        'Echo of the result ordering as applied, when a sort was provided — the ordering that decided which rows a capped stage holds.',
      ),
    appliedOffset: z
      .number()
      .describe('Row offset applied to the query — the cause when a page comes back empty.'),
    appliedLength: z.number().describe('Preview row count requested for this call.'),
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
    appliedColumns: {
      render: (columns) =>
        columns && columns.length > 0
          ? `**Applied Columns:** ${columns.join(', ')}`
          : (null as unknown as string),
    },
    appliedSort: {
      render: (sort) =>
        sort && sort.length > 0
          ? `**Applied Sort:** ${sort.map((s) => `${s.column} ${s.direction}`).join(', ')}`
          : (null as unknown as string),
    },
  },

  errors: [
    {
      reason: 'route_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Route does not exist in the EIA taxonomy.',
      recovery: 'Use eia_browse_routes or eia_search_routes to find a valid leaf route path.',
    },
    {
      reason: 'route_not_queryable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Route is a category node with sub-routes, not a queryable leaf.',
      recovery:
        'Use eia_browse_routes to drill into sub-routes, or eia_search_routes to find leaf routes.',
    },
    {
      reason: 'invalid_facet',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown facet key was used in filters.',
      recovery: 'Call eia_describe_route and pick a facet key from facets[].id.',
    },
    {
      reason: 'invalid_column',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown data column ID was passed in columns.',
      recovery: 'Call eia_describe_route and pick a column from data_columns[].id.',
    },
    {
      reason: 'invalid_frequency',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown frequency code was passed.',
      recovery: 'Call eia_describe_route and pick a frequency from frequencies[].id.',
    },
    {
      reason: 'invalid_sort',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A sort entry named a column the route does not sort by.',
      recovery:
        'Call eia_describe_route and sort by a column ID from data_columns[].id or a facet ID from facets[].id.',
    },
    {
      reason: 'invalid_period',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start or end was not in a period format the route accepts.',
      recovery:
        'Call eia_describe_route and use the period format frequencies[].format gives for the chosen frequency.',
    },
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Date range is inverted (start is after end).',
      recovery: 'Swap start and end values — start must be earlier than or equal to end.',
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

    // Canvas presence decides whether the service pages past the preview, so it
    // has to be resolved before the query, not after.
    const bridge = getCanvasBridge();

    const service = getEiaApiService();
    const dataResp = await service.query(
      input.route,
      {
        accumulate: bridge !== undefined,
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
      ...(input.start !== undefined && { appliedStart: input.start }),
      ...(input.end !== undefined && { appliedEnd: input.end }),
      ...(input.frequency !== undefined && { appliedFrequency: input.frequency }),
      ...(input.columns !== undefined &&
        input.columns.length > 0 && { appliedColumns: input.columns }),
      ...(input.sort !== undefined && input.sort.length > 0 && { appliedSort: input.sort }),
      appliedOffset: input.offset,
      appliedLength: input.length,
    });

    const result: {
      route: string;
      data: Array<Record<string, unknown>>;
      total: number;
      returned_count: number;
      frequency: string;
      date_format: string;
      notice?: string;
      dataset?: string;
      canvas_preview_note?: string;
      truncation_warning?: string;
    } = {
      route: input.route,
      data: dataResp.data,
      total: dataResp.total,
      returned_count: dataResp.data.length,
      frequency: dataResp.frequency,
      date_format: dataResp.dateFormat,
    };

    /**
     * Whether the response already states where the caller stands relative to
     * `total` — a notice explaining the row-less page, a staged table running
     * from the caller's `offset` to the last row (leaving nothing further to
     * page to), or, with no canvas configured, a `canvas_preview_note` naming
     * the inline page against `total`. Decides whether EIA's per-page advisory
     * still tells the caller anything (see `isIncompleteReturn`).
     */
    let gapAccountedFor = false;

    // A row-less response is a valid success, but the two causes need different
    // guidance and neither can spill to canvas.
    if (dataResp.data.length === 0) {
      result.notice =
        dataResp.total > 0
          ? `Offset ${input.offset.toLocaleString()} is past the last row — total is ${dataResp.total.toLocaleString()}. Reduce offset below total to page through the matching rows.`
          : 'No rows matched the filters. Broaden filters, remove date constraints, or call eia_describe_route to verify facet values — an invalid facet value silently returns zero rows.';
      gapAccountedFor = true;
    } else if (bridge) {
      // DataCanvas spillover — opt-in via CANVAS_PROVIDER_TYPE=duckdb. The
      // service has already accumulated offset pages when a bridge is present.
      const canvasRows = dataResp.accumulated?.rows ?? dataResp.data;
      const registered = await bridge.registerDataframe(ctx, {
        rows: canvasRows,
        sourceTool: 'eia_query_route',
        queryParams: {
          route: input.route,
          ...(input.filters !== undefined && { filters: input.filters }),
          ...(input.columns !== undefined && { columns: input.columns }),
          ...(input.frequency !== undefined && { frequency: input.frequency }),
          ...(input.start !== undefined && { start: input.start }),
          ...(input.end !== undefined && { end: input.end }),
          // Sort order decides which rows a stage that stops short of total
          // holds, so provenance without it cannot distinguish two opposite
          // orderings of the same query.
          ...(input.sort !== undefined && { sort: input.sort }),
          offset: input.offset,
          length: input.length,
        },
        truncated: canvasRows.length < dataResp.total,
        maxRows: dataResp.accumulated?.cap ?? input.length,
      });

      if (registered) {
        result.dataset = registered.tableName;

        const staged = registered.rowCount;
        const lastStaged = input.offset + staged;
        const coversTotal = lastStaged >= dataResp.total;
        gapAccountedFor = coversTotal;

        const accumulated = dataResp.accumulated;
        if (dataResp.total > dataResp.data.length) {
          const head = `Showing ${dataResp.data.length.toLocaleString()} of ${dataResp.total.toLocaleString()} rows inline; ${staged.toLocaleString()} rows staged as ${registered.tableName} — SQL over the staged rows: SELECT * FROM ${registered.tableName}`;
          const range = `staged rows are ${(input.offset + 1).toLocaleString()}–${lastStaged.toLocaleString()} of ${dataResp.total.toLocaleString()}`;
          if (!accumulated || coversTotal) {
            /**
             * An offset-bound stage holds a slice the row count alone cannot
             * locate — without the range it reads like a prefix of the same
             * query, which holds disjoint rows.
             */
            result.canvas_preview_note = input.offset > 0 ? `${head}. The ${range}.` : head;
          } else if (accumulated.capped) {
            result.canvas_preview_note = `${head}. Accumulation stopped at the EIA_CANVAS_MAX_ROWS cap (${accumulated.cap.toLocaleString()}), so the ${range}. Narrow with filters, start, or end — or re-query with offset ${lastStaged.toLocaleString()} — to reach the rest.`;
          } else {
            result.canvas_preview_note = `${head}. Staging stopped before the end of the matching set, so the ${range}. Re-query with offset ${lastStaged.toLocaleString()} to continue.`;
          }
        }
      }
    } else if (dataResp.total > dataResp.data.length) {
      result.canvas_preview_note = `Showing ${dataResp.data.length.toLocaleString()} of ${dataResp.total.toLocaleString()} rows — enable DataCanvas (CANVAS_PROVIDER_TYPE=duckdb) to stage the full result for SQL, or page through with offset.`;
      gapAccountedFor = true;
    }

    // Forward EIA's own top-level advisories. Each entry is
    // { warning, description } — flatten to one readable line, dropping only
    // the per-page advisory the response above has already answered.
    const advisories = (dataResp.warnings ?? []).filter(
      (w) => !(gapAccountedFor && isIncompleteReturn(w)),
    );
    if (advisories.length > 0) {
      result.truncation_warning = advisories
        .map((w) => `${w.warning}: ${w.description}`)
        .join('; ');
    }

    return result;
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(`## Query: ${result.route}`);
    lines.push(
      `**Frequency:** ${result.frequency} | **Date format:** ${result.date_format} | **Rows:** ${result.returned_count.toLocaleString()} of ${result.total.toLocaleString()}\n`,
    );

    if (result.notice) {
      lines.push(`> ${result.notice}\n`);
    }
    if (result.canvas_preview_note) {
      lines.push(`> ${result.canvas_preview_note}\n`);
    }
    if (result.dataset) {
      lines.push(`**Dataset:** \`${result.dataset}\``);
      lines.push('Use `eia_dataframe_query` with this dataset name for SQL access.\n');
    }
    if (result.truncation_warning) {
      lines.push(`> **Warning:** ${result.truncation_warning}\n`);
    }

    if (result.data.length === 0) {
      lines.push('_No rows returned._');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    /**
     * Render table — each `{col}-units` companion is decided from the whole
     * preview, not from row 0. The unit follows a facet value on some routes
     * (fuel type, most obviously), so one row cannot speak for the column:
     * annotating the header from row 0 stamps its unit on rows measured in
     * something else, and a null on row 0 drops units later rows carry. Absent
     * from every row, the companion is dropped — the body column would be
     * blank. Identical on every row, it annotates the header, which is the
     * width win and correct on most routes. Anything else stays as its own
     * body column.
     */
    const firstRow = result.data[0];
    if (!firstRow) return [{ type: 'text', text: lines.join('\n') }];
    const allKeys = Object.keys(firstRow);

    const unitsMap: Record<string, string> = {};
    const absorbedUnitKeys = new Set<string>();
    for (const key of allKeys) {
      if (!key.endsWith('-units')) continue;
      const units = result.data.map((row) => row[key]);
      const first = units[0];
      if (units.every((u) => u === null || u === undefined)) {
        absorbedUnitKeys.add(key);
      } else if (units.every((u) => u === first)) {
        unitsMap[key.slice(0, -6)] = String(first); // strip trailing '-units'
        absorbedUnitKeys.add(key);
      }
    }

    // Body columns: data columns, plus every {col}-units column the header could not absorb.
    const dataCols = allKeys.filter((k) => !absorbedUnitKeys.has(k));

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
