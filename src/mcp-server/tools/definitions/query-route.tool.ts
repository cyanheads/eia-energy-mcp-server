/**
 * @fileoverview Tool definition for eia_query_route. Fetches data from a leaf
 * route with optional facet filters, date range, frequency, and column
 * selection. Data values come back as strings per the EIA API. Staging is
 * opt-in: with `stage: true` and a canvas configured
 * (CANVAS_PROVIDER_TYPE=duckdb) the service walks offset pages up to
 * EIA_CANVAS_MAX_ROWS and registers the accumulated set, returning a dataset
 * handle whose note points at eia_dataframe_describe for its column names and
 * eia_dataframe_query for SQL. Left off, the call costs one upstream
 * request and nothing is registered. The route echoed back is the canonical
 * spelling the service resolved to, which is also what dataframe provenance
 * records.
 * @module mcp-server/tools/definitions/query-route.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { type ColumnRename, getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { getEiaApiService } from '@/services/eia/eia-service.js';
import type { EiaWarning } from '@/services/eia/types.js';
import {
  ECHO_BUDGET_BYTES,
  fitRows,
  INLINE_BUDGET_BYTES,
  longestFittingPrefix,
  trailerBytes,
  utf8Bytes,
} from '../inline-budget.js';
import { literalTableCell, tableRow } from '../literal-table-cell.js';

/**
 * EIA's per-page advisory: it fires whenever the requested `length` is smaller
 * than the query's `total`, and its "5000 rows in JSON format" text is fixed
 * boilerplate that appears at any size. It describes the inline page rather
 * than the result set, so once the response itself states where the caller
 * stands — the staged table reaches the last row, a notice explains the
 * row-less page, or `canvas_preview_note` places the inline page against
 * `total` because nothing was staged — forwarding it contradicts the
 * response and sends an agent back for rows it already has. Matched on the
 * `warning` label so every other advisory EIA reports, which the response does
 * not otherwise explain, still reaches the caller.
 */
function isIncompleteReturn(warning: EiaWarning): boolean {
  return warning.warning.trim().toLowerCase() === 'incomplete return';
}

/**
 * The stage-outcome sentence for a registered dataset: the tool that lists its
 * column names, then the one that runs SQL. Staging renames every column that
 * is not a SQL identifier, so SQL written from the preview's keys misses them;
 * the clause quotes one real rename from this table — a hyphen one when there
 * is one, the common case (`price-units`) — and is absent when nothing was
 * renamed, as on `steo`.
 */
function stagedPointer(rowCount: number, tableName: string, renamed: ColumnRename[]): string {
  const example = renamed.find((r) => r.from.includes('-')) ?? renamed[0];
  const clause = !example
    ? ''
    : example.from.includes('-')
      ? ` (hyphens become underscores: ${example.from} → ${example.to})`
      : ` (staged names are SQL-safe identifiers: ${example.from} → ${example.to})`;
  return `${rowCount.toLocaleString()} rows staged as ${tableName} — call eia_dataframe_describe for its column names${clause}, then eia_dataframe_query to run SQL over it.`;
}

/**
 * Trailer renderers for the structured echoes, which would otherwise render as
 * JSON blobs. Module-level so the handler can measure the trailer it adds to
 * content[] against the inline budget.
 */
const enrichmentTrailer = {
  appliedFilters: {
    render: (filters: Filters | undefined) => {
      if (!filters || Object.keys(filters).length === 0) return null as unknown as string;
      const entries = Object.entries(filters)
        .map(([k, v]) => `- **${k}:** ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\n');
      return `**Applied Filters:**\n${entries}`;
    },
  },
  appliedColumns: {
    render: (columns: string[] | undefined) =>
      columns && columns.length > 0
        ? `**Applied Columns:** ${columns.join(', ')}`
        : (null as unknown as string),
  },
  appliedSort: {
    render: (sort: Array<{ column: string; direction: 'asc' | 'desc' }> | undefined) =>
      sort && sort.length > 0
        ? `**Applied Sort:** ${sort.map((s) => `${s.column} ${s.direction}`).join(', ')}`
        : (null as unknown as string),
  },
};

type Filters = Record<string, string | string[]>;

/**
 * The appliedFilters echo, held to `ECHO_BUDGET_BYTES` on both surfaces. A
 * filter set past that keeps its leading values whole, in order, and gains a
 * `…` entry counting the values left out per facet — so a facet cut whole is
 * still named — under a key no facet ID can be, so the marker is never read as
 * a value that was applied.
 */
function echoedFilters(filters: Filters): Filters {
  const cost = (f: Filters) =>
    Math.max(utf8Bytes(JSON.stringify(f)), utf8Bytes(enrichmentTrailer.appliedFilters.render(f)));
  if (cost(filters) <= ECHO_BUDGET_BYTES) return filters;
  const values = Object.entries(filters).flatMap(([key, v]) =>
    Array.isArray(v)
      ? v.map((value) => ({ key, value, list: true }))
      : [{ key, value: v, list: false }],
  );
  const kept = (m: number): Filters => {
    const echo: Filters = {};
    for (const { key, value, list } of values.slice(0, m)) {
      const echoed = echo[key];
      if (!list) echo[key] = value;
      else if (Array.isArray(echoed)) echoed.push(value);
      else echo[key] = [value];
    }
    const cut = new Map<string, number>();
    for (const { key } of values.slice(m)) cut.set(key, (cut.get(key) ?? 0) + 1);
    const byFacet = [...cut].map(([key, n]) => `${key}: ${n.toLocaleString()}`).join(', ');
    echo['…'] =
      `${(values.length - m).toLocaleString()} of ${values.length.toLocaleString()} filter values not echoed (${byFacet}) — the query applied every one.`;
    return echo;
  };
  return kept(
    longestFittingPrefix(
      Math.min(values.length, ECHO_BUDGET_BYTES),
      (m) => cost(kept(m)) <= ECHO_BUDGET_BYTES,
    ),
  );
}

/** The handler's return value, which `format()` renders. */
interface QueryRouteResult {
  canvas_preview_note?: string | undefined;
  data: Array<Record<string, unknown>>;
  dataset?: string | undefined;
  date_format: string;
  frequency: string;
  next_offset?: number | undefined;
  notice?: string | undefined;
  returned_count: number;
  route: string;
  total: number;
  truncation_warning?: string | undefined;
}

/** Body columns and header lines for a preview table. */
interface TableLayout {
  columns: string[];
  header: string[];
}

/**
 * Lay out the preview table — each `{col}-units` companion is decided from the
 * whole preview, not from row 0. The unit follows a facet value on some routes
 * (fuel type, most obviously), so one row cannot speak for the column:
 * annotating the header from row 0 stamps its unit on rows measured in
 * something else, and a null on row 0 drops units later rows carry. Absent
 * from every row, the companion is dropped — the body column would be blank.
 * Identical on every row, it annotates the header, which is the width win and
 * correct on most routes. Anything else stays as its own body column.
 */
function tableLayout(rows: Array<Record<string, unknown>>): TableLayout {
  const allKeys = Object.keys(rows[0] ?? {});
  const unitsMap: Record<string, string> = {};
  const absorbedUnitKeys = new Set<string>();
  for (const key of allKeys) {
    if (!key.endsWith('-units')) continue;
    const units = rows.map((row) => row[key]);
    const first = units[0];
    if (units.every((u) => u === null || u === undefined)) {
      absorbedUnitKeys.add(key);
    } else if (units.every((u) => u === first)) {
      unitsMap[key.slice(0, -6)] = String(first); // strip trailing '-units'
      absorbedUnitKeys.add(key);
    }
  }

  // Body columns: data columns, plus every {col}-units column the header could not absorb.
  const columns = allKeys.filter((k) => !absorbedUnitKeys.has(k));
  // Header: "col (unit)" when a unit is known, else just "col"
  const headerCells = columns.map((c) =>
    unitsMap[c] ? `${literalTableCell(c)} (${literalTableCell(unitsMap[c])})` : literalTableCell(c),
  );
  return {
    columns,
    header: [`| ${headerCells.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`],
  };
}

/** The markdown `format()` returns, as one string the handler can also measure. */
function renderQueryResult(result: QueryRouteResult): string {
  const lines: string[] = [];

  lines.push(`## Query: ${result.route}`);
  const next =
    result.next_offset !== undefined
      ? ` | **Next offset:** ${result.next_offset.toLocaleString()}`
      : '';
  lines.push(
    `**Frequency:** ${result.frequency} | **Date format:** ${result.date_format} | **Rows:** ${result.returned_count.toLocaleString()} of ${result.total.toLocaleString()}${next}\n`,
  );

  if (result.notice) {
    lines.push(`> ${result.notice}\n`);
  }
  if (result.canvas_preview_note) {
    lines.push(`> ${result.canvas_preview_note}\n`);
  }
  if (result.dataset) {
    lines.push(`**Dataset:** \`${result.dataset}\`\n`);
  }
  if (result.truncation_warning) {
    lines.push(`> **Warning:** ${result.truncation_warning}\n`);
  }

  if (result.data.length === 0) {
    lines.push('_No rows returned._');
    return lines.join('\n');
  }

  const layout = tableLayout(result.data);
  lines.push(...layout.header);
  for (const row of result.data) lines.push(tableRow(row, layout.columns));
  return lines.join('\n');
}

export const queryRouteTool = tool('eia_query_route', {
  inputAliases: { path: 'route' },
  title: 'Query EIA Route Data',
  description:
    'Fetches data from a leaf route with optional facet filters, date range, frequency, and column selection. Use eia_describe_route first to discover valid facet IDs, facet values, column IDs, and frequency codes. Data values are strings in the response (EIA API returns all numeric values as strings, e.g. "9.13"); cast to DOUBLE in SQL when arithmetic is needed. Returns a preview inline and stages nothing by default — one upstream request, whatever total says. Pass stage: true to also page past the preview and stage the accumulated set as a DataCanvas table, then pass the returned dataset name to eia_dataframe_describe for its column names and eia_dataframe_query for SQL. Every dataset a tenant stages lands in the same canvas, so tables from different routes cross-join by name with nothing to thread between calls.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    route: z
      .string()
      .min(1)
      .describe(
        'Leaf route path (e.g. "electricity/retail-sales", "steo"). Discoverable via eia_browse_routes or eia_search_routes. Leading, trailing, and doubled slashes are stripped, so an EIA-doc spelling like "/electricity/retail-sales/" resolves to the same route.',
      ),
    filters: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .optional()
      .describe(
        'Facet filters keyed by facet ID (e.g. { "stateid": "TX", "sectorid": ["RES", "COM"] }). Use the facets[].id values returned by eia_describe_route as keys here. Every value travels in the request URI, which EIA caps at about 8 KB — a few hundred values across all filters; split a longer list across calls.',
      ),
    columns: z
      .array(z.string())
      .optional()
      .describe(
        'Data column IDs to return (reduces payload). Defaults to all. IDs discoverable via eia_describe_route data_columns[].id. Every row also carries period and each facet ID whatever this lists, so naming those here is unnecessary and they are dropped from the request.',
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
        'Rows to fetch for the inline page (default 100, max 5000 per EIA limit). Every fetched row is used, but the response carries only as many as fit a 64,000-byte budget per surface — wide routes end the page early, said so in canvas_preview_note, with next_offset naming where to continue. With stage: true, staging is not bounded by this — it pages past the preview on its own.',
      ),
    stage: z
      .boolean()
      .default(false)
      .describe(
        'Stage the matching rows as a DataCanvas table for SQL (default false). Off, the call makes one upstream request and returns the preview alone. On, the service pages past the preview up to EIA_CANVAS_MAX_ROWS and registers the accumulated rows, returning the handle in dataset — several extra upstream requests and seconds of latency on a large route, so turn it on when moving to analysis, not while exploring. Requires a canvas (CANVAS_PROVIDER_TYPE=duckdb); without one nothing is staged whatever this is set to.',
      ),
  }),

  output: z.object({
    route: z
      .string()
      .describe(
        'The route path queried, in canonical spelling — any leading, trailing, or doubled slashes the input carried are stripped. Reusable verbatim in a follow-up call.',
      ),
    data: z
      .array(z.object({}).passthrough().describe('A single data row with dynamic column keys.'))
      .describe(
        'Inline rows: the first length rows from offset, ended early when the next whole row would push either response surface past the 64,000-byte budget. All numeric values are strings per the EIA API (e.g. "9.13"). Cast to DOUBLE in SQL for arithmetic: CAST(value AS DOUBLE). Per-column units appear as {col}-units fields inline in each row. Keys are dynamic column IDs from the EIA route.',
      ),
    total: z
      .number()
      .describe(
        'Total matching rows in the EIA dataset for this query (may exceed returned rows when pagination or spillover applies).',
      ),
    returned_count: z
      .number()
      .describe(
        'Number of rows in data. When returned_count < total, continue at next_offset or stage the rest for SQL.',
      ),
    next_offset: z
      .number()
      .optional()
      .describe(
        'Offset that continues right after the rows in data (offset + returned_count) — pass it as offset for the next page, with no gap or overlap. Present whenever rows remain past this page; absent on the last page.',
      ),
    frequency: z.string().describe('Frequency of the returned data.'),
    date_format: z.string().describe('Period format for the returned data (e.g. "YYYY-MM").'),
    notice: z
      .string()
      .optional()
      .describe(
        'Informational message when EIA returned no rows — either zero rows matched the filters (broaden the query) or offset paged past the last row (reduce offset below total). A page left empty because its first row alone exceeds the response budget carries no notice; canvas_preview_note names the offset that skips it.',
      ),
    dataset: z
      .string()
      .optional()
      .describe(
        'df_<id> handle for the staged rows — eia_dataframe_describe lists its column names; eia_dataframe_query runs SQL over it (SELECT … FROM df_<id>). Present only when a stage: true call registered a table on a deployment with a canvas configured; absent otherwise, since nothing was staged. Every dataset a tenant stages shares one canvas, so handles from different routes join directly.',
      ),
    canvas_preview_note: z
      .string()
      .optional()
      .describe(
        'Human-readable note, present whenever dataset is set or staging failed, and otherwise when total exceeds the inline rows. On a stage: true call it opens with the stage outcome: the staged row count and dataset name, naming eia_dataframe_describe for the staged column names (quoting one rename when staging renamed a column) and then eia_dataframe_query for SQL — or, when the canvas failed, that no dataframe was created (dataset is then absent), with the retry and offset paging. Next, where in the matching set the staged rows sit whenever the stage does not start at row 1, and when staging stopped short of total (the EIA_CANVAS_MAX_ROWS cap, or an upstream page that did not return) the offset to resume from; last, the inline page against total and next_offset — saying when the 64,000-byte response budget rather than length ended the page, or that a single row too large for the budget was withheld and offset + 1 steps past it — and, after a registered stage, that the inline rows page with stage left off, since another stage: true call stages a new table. Where staging was not requested it places the inline page against total and names stage: true and eia_dataframe_query as the way to get SQL access to the rest; where no canvas is configured at all, staging is unavailable, so it names offset paging and CANVAS_PROVIDER_TYPE=duckdb instead.',
      ),
    truncation_warning: z
      .string()
      .optional()
      .describe(
        "Upstream advisories forwarded verbatim from EIA's warnings[], joined with '; ' when more than one applies. These describe the inline page — EIA's \"incomplete return\" entry fires whenever the requested length is under total, at any size — not a 5,000-row ceiling on this response. Absent when the response already accounts for the gap the advisory names (the staged table reaches the last row, notice explains the empty page, or canvas_preview_note places the inline page against total because nothing was staged).",
      ),
  }),

  enrichment: {
    effectiveRoute: z.string().describe('The route path that was queried.'),
    totalCount: z.number().describe('Total matching rows in the EIA dataset.'),
    returnedCount: z
      .number()
      .describe(
        'Rows in this response. When returnedCount < totalCount, continue at next_offset or stage the rest.',
      ),
    appliedFilters: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .optional()
      .describe(
        'Facet filters applied to the query, when provided. Past 4,000 bytes the echo keeps the leading values and adds a "…" entry counting those not echoed per facet — every value was still applied.',
      ),
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
      .describe(
        'Echo of the column projection as sent to EIA, when columns named at least one data column — period and facet IDs, which every row carries anyway, are not part of it.',
      ),
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
  enrichmentTrailer,

  errors: [
    {
      reason: 'route_not_found',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'Route does not exist in the EIA taxonomy.',
      recovery: 'Use eia_browse_routes or eia_search_routes to find a valid leaf route path.',
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
      reason: 'invalid_facet',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown facet key was used in filters.',
      recovery: 'Call eia_describe_route and pick a facet key from facets[].id.',
    },
    {
      reason: 'invalid_column',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown data column ID was passed in columns.',
      recovery: 'Call eia_describe_route and pick a column from data_columns[].id.',
    },
    {
      reason: 'invalid_frequency',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown frequency code was passed.',
      recovery: 'Call eia_describe_route and pick a frequency from frequencies[].id.',
    },
    {
      reason: 'invalid_sort',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A sort entry named a column the route does not sort by.',
      recovery:
        'Call eia_describe_route and sort by a column ID from data_columns[].id or a facet ID from facets[].id.',
    },
    {
      reason: 'invalid_period',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start or end was not in a period format the route accepts.',
      recovery:
        'Call eia_describe_route and use the period format frequencies[].format gives for the chosen frequency.',
    },
    {
      reason: 'uri_too_long',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      retryable: false,
      when: 'The request URI passed the EIA limit of about 8 KB (HTTP 414) — typically a filter list of several hundred values.',
      recovery:
        'Split the filter values across several calls, or narrow the list; EIA rejects a request URI past about 8 KB. A filter covering most of a facet can be dropped instead, since an absent filter returns every value.',
    },
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Date range is inverted (start is after end).',
      recovery: 'Swap start and end values — start must be earlier than or equal to end.',
    },
    {
      reason: 'rate_limited',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'EIA rate limit hit (OVER_RATE_LIMIT).',
      recovery: 'Back off and retry; use a production EIA API key for higher rate limits.',
    },
    {
      reason: 'upstream_unreachable',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'EIA could not be reached (connection refused or reset, DNS failure) on the data request, the route metadata request, or the route-tree build.',
      recovery:
        'Retry after a short wait — EIA could not be reached; if it keeps failing, check api.eia.gov availability.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing eia_query_route', {
      route: input.route,
      offset: input.offset,
      length: input.length,
      stage: input.stage,
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
        },
      );
    }

    /**
     * A filter whose value list is empty sends EIA nothing, so it is unset —
     * dropped here, before the request, the appliedFilters echo, and staged
     * provenance, so none of them names a filter EIA never received. Values
     * themselves pass through as given: a single space is a real facet value.
     */
    const filters = Object.fromEntries(
      Object.entries(input.filters ?? {}).filter(
        ([, values]) => !Array.isArray(values) || values.length > 0,
      ),
    );
    const hasFilters = Object.keys(filters).length > 0;

    /**
     * Staging is what makes the service page past the preview, and it needs
     * both the caller's opt-in and a canvas to register into — so both are
     * resolved before the query, not after. Without the opt-in the call costs
     * one upstream request whatever `total` says.
     */
    const bridge = getCanvasBridge();
    const stagingBridge = input.stage ? bridge : undefined;

    const service = getEiaApiService();
    const dataResp = await service.query(
      input.route,
      {
        accumulate: stagingBridge !== undefined,
        ...(hasFilters && { filters }),
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

    const fetched = dataResp.data;
    const { total } = dataResp;

    /**
     * DataCanvas spillover — the caller asked for it and a canvas is
     * configured, so the service has already accumulated offset pages. Staging
     * runs on the whole fetch before the inline page is cut to the response
     * budget, so a budget-trimmed page stages exactly what an untrimmed one
     * would.
     */
    const canvasRows = dataResp.accumulated?.rows ?? fetched;
    const staging =
      fetched.length > 0 && stagingBridge
        ? await stagingBridge.registerDataframe(ctx, {
            rows: canvasRows,
            sourceTool: 'eia_query_route',
            queryParams: {
              // The canonical route, not the caller's spelling — two spellings of
              // one route must not read as two different sources in provenance.
              route: dataResp.route,
              ...(hasFilters && { filters }),
              ...(dataResp.appliedColumns && { columns: dataResp.appliedColumns }),
              ...(input.frequency !== undefined && { frequency: input.frequency }),
              ...(input.start !== undefined && { start: input.start }),
              ...(input.end !== undefined && { end: input.end }),
              // Sort order decides which rows a stage that stops short of total
              // holds, so provenance without it cannot distinguish two opposite
              // orderings of the same query.
              ...(input.sort !== undefined && input.sort.length > 0 && { sort: input.sort }),
              offset: input.offset,
              length: input.length,
            },
            truncated: canvasRows.length < total,
            maxRows: dataResp.accumulated?.cap ?? input.length,
          })
        : undefined;

    /**
     * The stage-outcome sentences, which do not depend on how many rows go
     * inline. Sentence order is fixed: the outcome (pointer or failure), then
     * where the staged rows sit and how to resume staging, then the inline
     * page (`inlineSentences`).
     */
    let stageOutcome: string | undefined;
    let stageCoversTotal = false;
    if (staging?.status === 'registered') {
      const lastStaged = input.offset + staging.rowCount;
      stageCoversTotal = lastStaged >= total;
      const accumulated = dataResp.accumulated;
      const range = `staged rows are ${(input.offset + 1).toLocaleString()}–${lastStaged.toLocaleString()} of ${total.toLocaleString()}`;
      let stagedRange: string | undefined;
      if (!accumulated || stageCoversTotal) {
        /**
         * An offset-bound stage holds a slice the row count alone cannot
         * locate — without the range it reads like a prefix of the same
         * query, which holds disjoint rows.
         */
        if (input.offset > 0) stagedRange = `The ${range}.`;
      } else if (accumulated.capped) {
        stagedRange = `Accumulation stopped at the EIA_CANVAS_MAX_ROWS cap (${accumulated.cap.toLocaleString()}), so the ${range}. Narrow with filters, start, or end — or re-query with offset ${lastStaged.toLocaleString()} — to reach the rest.`;
      } else {
        stagedRange = `Staging stopped before the end of the matching set, so the ${range}. Re-query with offset ${lastStaged.toLocaleString()} to continue.`;
      }
      stageOutcome = [
        stagedPointer(staging.rowCount, staging.tableName, staging.renamedColumns),
        stagedRange,
      ]
        .filter(Boolean)
        .join(' ');
    } else if (staging?.status === 'failed') {
      /**
       * The inline rows are valid and the upstream request is spent, so a
       * failed stage stays a successful call — the missing dataset is the
       * signal, and the note is the account of it.
       */
      stageOutcome =
        'Staging failed, so no dataframe was created — re-run with stage: true to try again, or page through with offset.';
    }

    const budget = `${INLINE_BUDGET_BYTES.toLocaleString()}-byte response budget`;
    /**
     * Where the inline page ends and how to continue it. `length` rows were
     * fetched, but only as many go inline as fit the budget, so this says when
     * the budget rather than `length` ended the page — a row too large to fit
     * on its own is withheld whole rather than cut.
     */
    const pageEnd = (shown: number, nextOffset: number | undefined): string | undefined => {
      if (shown === 0) {
        return `The row at offset ${input.offset.toLocaleString()} alone exceeds the ${budget}, so no rows are shown inline — narrow it with columns, or skip it with offset ${(input.offset + 1).toLocaleString()}.`;
      }
      if (nextOffset === undefined) return;
      return shown < fetched.length
        ? `The ${budget} ended this page at ${shown.toLocaleString()} of the ${fetched.length.toLocaleString()} rows fetched; continue the inline page at next_offset ${nextOffset.toLocaleString()}.`
        : `Continue the inline page at next_offset ${nextOffset.toLocaleString()}.`;
    };

    const appliedFilters = hasFilters ? echoedFilters(filters) : undefined;
    const enrichmentFor = (shown: number) => ({
      effectiveRoute: dataResp.route,
      totalCount: total,
      returnedCount: shown,
      ...(appliedFilters && { appliedFilters }),
      ...(input.start !== undefined && { appliedStart: input.start }),
      ...(input.end !== undefined && { appliedEnd: input.end }),
      ...(input.frequency !== undefined && { appliedFrequency: input.frequency }),
      ...(dataResp.appliedColumns && { appliedColumns: dataResp.appliedColumns }),
      ...(input.sort !== undefined && input.sort.length > 0 && { appliedSort: input.sort }),
      appliedOffset: input.offset,
      appliedLength: input.length,
    });

    /** The response carrying the first `shown` fetched rows inline. */
    const resultFor = (shown: number): QueryRouteResult => {
      const nextOffset = input.offset + shown < total ? input.offset + shown : undefined;
      const result: QueryRouteResult = {
        route: dataResp.route,
        data: fetched.slice(0, shown),
        total,
        returned_count: shown,
        ...(nextOffset !== undefined && { next_offset: nextOffset }),
        frequency: dataResp.frequency,
        date_format: dataResp.dateFormat,
      };

      /**
       * Whether the response already states where the caller stands relative
       * to `total` — a notice explaining the row-less page, a staged table
       * running from the caller's `offset` to the last row (leaving nothing
       * further to page to), or a `canvas_preview_note` placing the inline page
       * against `total` because nothing was staged. Decides whether EIA's
       * per-page advisory still tells the caller anything (see
       * `isIncompleteReturn`).
       */
      let gapAccountedFor = false;
      const inline =
        total > shown
          ? [
              shown > 0
                ? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} rows inline.`
                : undefined,
              pageEnd(shown, nextOffset),
            ]
          : [];

      // A row-less response is a valid success, but the two causes need
      // different guidance and neither can spill to canvas.
      if (fetched.length === 0) {
        result.notice =
          total > 0
            ? `Offset ${input.offset.toLocaleString()} is past the last row — total is ${total.toLocaleString()}. Reduce offset below total to page through the matching rows.`
            : 'No rows matched the filters. Broaden filters, remove date constraints, or call eia_describe_route to verify facet values — an invalid facet value silently returns zero rows.';
        gapAccountedFor = true;
      } else if (stageOutcome !== undefined) {
        if (staging?.status === 'registered') result.dataset = staging.tableName;
        /**
         * Another stage: true call at next_offset registers a second table and
         * re-spends the accumulation, so paging the inline rows is a stage-off call.
         */
        const pageWithoutStaging =
          staging?.status === 'registered' && nextOffset !== undefined
            ? 'Page the inline rows with stage left off — another stage: true call stages a new table.'
            : undefined;
        result.canvas_preview_note = [stageOutcome, ...inline, pageWithoutStaging]
          .filter(Boolean)
          .join(' ');
        gapAccountedFor = staging?.status === 'failed' || stageCoversTotal;
      } else if (total > shown) {
        /**
         * Nothing was staged, and the two reasons need different advice. A
         * canvas is configured and the caller simply did not ask to stage —
         * naming `stage: true` is the only way they learn the capability is
         * there, and the canvas-off wording would send them after a deployment
         * change they do not need. With no canvas the lever does not exist, so
         * offset paging is what is left.
         */
        const head = `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} rows`;
        const advice = bridge
          ? `${head} — nothing was staged. Re-run with stage: true to stage the matching rows for SQL with eia_dataframe_query, or page through with offset.`
          : `${head} — enable DataCanvas (CANVAS_PROVIDER_TYPE=duckdb) to stage the full result for SQL, or page through with offset.`;
        result.canvas_preview_note = [advice, pageEnd(shown, nextOffset)].filter(Boolean).join(' ');
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
    };

    /**
     * Inline as many whole fetched rows as fit the budget on both surfaces:
     * structuredContent is the result merged with enrichment, content[] the
     * rendered markdown plus the enrichment trailer. Row costs come from one
     * table layout over the whole fetch; a prefix only ever absorbs more unit
     * columns, so those costs never undercount.
     */
    let layout: TableLayout | undefined;
    const shown = fitRows(
      fetched.length,
      (k) => {
        const result = resultFor(k);
        const enrichment = enrichmentFor(k);
        return {
          structured: utf8Bytes(JSON.stringify({ ...result, ...enrichment })),
          text: utf8Bytes(renderQueryResult(result)) + trailerBytes(enrichment, enrichmentTrailer),
        };
      },
      (i) => {
        const row = fetched[i] ?? {};
        layout ??= tableLayout(fetched);
        return {
          structured: utf8Bytes(JSON.stringify(row)) + 1,
          text: utf8Bytes(tableRow(row, layout.columns)) + 1,
        };
      },
    );

    // Populate enrichment — reaches both structuredContent and content[] trailer.
    ctx.enrich(enrichmentFor(shown));
    return resultFor(shown);
  },

  format: (result) => [{ type: 'text', text: renderQueryResult(result) }],
});
