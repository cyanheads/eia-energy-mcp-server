/**
 * @fileoverview Tool definition for eia_dataframe_query. Runs a single-statement
 * SELECT against canvas dataframes registered by eia_query_route's opt-in
 * staging path. Read-only enforcement in the framework SQL gate: text deny-list,
 * statement count, statement type, parse-tree function and file-reference check,
 * EXPLAIN-plan walk, and system-catalog deny (denySystemCatalogs), over a DuckDB
 * engine that runs with external file access off.
 * EIA data values are VARCHAR — cast to DOUBLE for arithmetic.
 * Three bounds can end the inline rows and each gets its own disclosure:
 * `row_limit` drops rows the canvas never counted (`truncated`, `totalRows` is
 * then the cap), while `preview` and the 64,000-byte inline budget only narrow
 * the inline slice of what is in hand.
 * @module mcp-server/tools/definitions/dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import {
  boundedEcho,
  fitRows,
  INLINE_BUDGET_BYTES,
  longestFittingPrefix,
  trailerBytes,
  utf8Bytes,
} from '../inline-budget.js';
import { literalTableCell, tableRow } from '../literal-table-cell.js';

/** The handler's return value, which `format()` renders. */
interface DataframeQueryResult {
  columns: string[];
  expires_at?: string | undefined;
  registered_as?: string | undefined;
  rows: Array<Record<string, unknown>>;
}

/** The markdown `format()` returns, as one string the handler can also measure. */
function renderQueryResult(result: DataframeQueryResult): string {
  const lines: string[] = [];
  if (result.registered_as) {
    lines.push(
      `Registered as ${result.registered_as} (expires ${result.expires_at ?? 'unknown'}).`,
    );
  }
  if (result.rows.length === 0) {
    lines.push('_No rows._');
    return lines.join('\n');
  }
  lines.push(
    `| ${result.columns.map(literalTableCell).join(' | ')} |`,
    `| ${result.columns.map(() => '---').join(' | ')} |`,
  );
  for (const row of result.rows) lines.push(tableRow(row, result.columns));
  return lines.join('\n');
}

export const dataframeQueryTool = tool('eia_dataframe_query', {
  title: 'Query EIA Dataframes',
  description:
    'Run a single-statement SELECT against canvas dataframes registered by eia_query_route calls that passed stage: true — a query that staged nothing leaves no table to select from. Standard DuckDB SQL — joins, aggregates, window functions, CTEs all supported. Reference dataframes by the df_<id> handles returned by eia_query_route or listed by eia_dataframe_describe. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, file reads (read_* functions or a quoted file path), engine-setting functions (current_setting), and SQL built from a string (query_table) are rejected. System catalogs (information_schema, pg_catalog, sqlite_master, duckdb_*) are denied. EIA data values are VARCHAR — use CAST(col AS DOUBLE) for arithmetic and aggregation. Optional register_as chains results as a new dataframe with a fresh expiry. Every dataframe named in the statement has its expiry extended by the query. Inline rows stop at a 64,000-byte budget per response surface; a result cut short says how to page the rest from a register_as table with ORDER BY … LIMIT/OFFSET.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas service is not configured for this deployment.',
      recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable dataframes.',
    },
    {
      reason: 'system_catalog_access',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL references a denied system catalog (information_schema, pg_catalog, sqlite_master, duckdb_*).',
      recovery: 'Query only df_<id> tables — list them with eia_dataframe_describe.',
    },
    {
      reason: 'missing_table',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'SQL references a df_<id> table that is not staged — mistyped, already dropped, or past its expiry.',
      recovery:
        'Call eia_dataframe_describe to list the staged handles, or re-run eia_query_route with stage: true to stage the data again.',
    },
    {
      reason: 'non_select_statement',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The statement is not a single read-only SELECT — writes, DDL, DROP, COPY, PRAGMA, and ATTACH are rejected.',
      recovery:
        'Rewrite the statement as one SELECT; to persist a result, pass register_as instead of writing to the canvas.',
    },
    {
      reason: 'invalid_sql',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'DuckDB could not parse or bind the statement — a syntax error, or a column or alias that does not exist on the referenced dataframe.',
      recovery:
        'Correct the statement and retry — eia_dataframe_describe reports the exact column names of every staged dataframe, where any hyphen in a preview column name is an underscore (price-units is price_units, respondent-name is respondent_name).',
    },
    {
      reason: 'register_as_clash',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'register_as names a dataframe that is already staged for this tenant.',
      recovery:
        'Pass a different register_as name — any unused name works; eia_dataframe_describe lists the taken ones.',
    },
  ],

  input: z.object({
    sql: z
      .string()
      .min(1)
      .describe(
        'Single-statement SELECT against df_<id> tables. EIA data columns are VARCHAR — use CAST(col AS DOUBLE) for arithmetic. Example: SELECT period, CAST(value AS DOUBLE) AS val FROM df_XXXXX ORDER BY period',
      ),
    register_as: z
      .string()
      .min(1)
      .optional()
      .describe(
        'When set, persist the result as a new dataframe with a fresh expiry. Use to chain analyses without re-running upstream queries. The name must be unused — reusing a staged name is rejected, and the fix is a different name, not dropping the existing dataframe. eia_dataframe_describe lists the names already taken.',
      ),
    preview: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe(
        'Rows to include in the immediate response. Defaults to row_limit. Set lower when chaining via register_as and only a sample is needed inline. The 64,000-byte response budget can end the inline rows sooner.',
      ),
    row_limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(1000)
      .describe(
        'Hard cap on rows materialized (default 1000, max 10000). Rows past the cap are dropped without being counted — the response then carries truncated: true and a totalRows equal to the cap rather than a true total. Pass register_as to materialize the whole result instead and get an exact count. Of the rows materialized, only as many go inline as fit the 64,000-byte response budget.',
      ),
  }),

  output: z.object({
    columns: z
      .array(z.string())
      .describe(
        'Column names in projection order. When no row is inline and the names pass 32,000 bytes, the list ends early with an entry counting the columns left out.',
      ),
    rows: z
      .array(
        z
          .object({})
          .passthrough()
          .describe('A result row with dynamic keys matching the SQL projection columns.'),
      )
      .describe(
        'Inline rows, bounded by preview, row_limit, and a 64,000-byte budget on each response surface — whole rows only; a row too large for the budget alone is withheld.',
      ),
    registered_as: z
      .string()
      .optional()
      .describe('Set when register_as was supplied and the new dataframe was materialized.'),
    expires_at: z
      .string()
      .optional()
      .describe(
        'ISO 8601 expiry for the newly registered dataframe, when applicable. Extended each time a later query references it.',
      ),
  }),

  enrichment: {
    totalRows: z
      .number()
      .describe(
        'Rows the query materialized. Exact when truncated is false — including on the register_as path, which stages and counts the whole result past row_limit. Equal to row_limit when truncated is true: a floor on the real match count, not a total.',
      ),
    returnedRows: z
      .number()
      .describe(
        'Rows included in this response. Below totalRows when preview or the response budget ended the inline rows; the notice names how to page the rest.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when row_limit cut the result: more rows matched than the cap and the remainder was dropped without being counted. False when every matching row was materialized, including on the register_as path, which counts the new dataframe exactly.',
      ),
    executedSql: z
      .string()
      .describe(
        'Echo of the SQL statement that was executed — confirms the exact query that ran. A statement past 4,000 bytes is echoed cut, ending with a marker that gives its full size; the whole statement ran.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when row_limit, preview, or the 64,000-byte response budget ended the inline rows — names each bound that applied and how to reach the rows it withheld (raise the cap, or page a register_as table with ORDER BY … LIMIT/OFFSET).',
      ),
  },

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.');
    }

    const { result, meta } = await bridge.query(ctx, input.sql, {
      ...(input.register_as !== undefined && { registerAs: input.register_as }),
      ...(input.preview !== undefined && { preview: input.preview }),
      rowLimit: input.row_limit,
      sourceTool: 'eia_dataframe_query',
      queryParams: { sql: input.sql },
    });

    const truncated = result.truncated === true;
    const materialized = result.rows.length;
    const budget = `${INLINE_BUDGET_BYTES.toLocaleString()}-byte response budget`;

    /**
     * The disclosure for `shown` inline rows. `row_limit` (`truncated`) drops
     * rows uncounted, so `totalRows` is then the cap, never a total; `preview`
     * and the response budget only narrow the inline slice of what is in hand.
     * A budget-ended page points at `register_as` paged with LIMIT/OFFSET, the
     * one retrieval path that is stable across calls.
     */
    const noticeFor = (shown: number): string | undefined => {
      const shownText = shown.toLocaleString();
      const shownRows = `${shownText} row${shown === 1 ? '' : 's'}`;
      const rowLimitCut = `more rows matched than the row_limit cap of ${input.row_limit.toLocaleString()} and the remainder was dropped uncounted, so totalRows is that cap and not a total`;
      // SQL numbers carry no digit grouping — `LIMIT 3,977` does not parse.
      const page = `ORDER BY <columns> LIMIT ${shown} OFFSET ${shown}`;
      const paging = meta?.tableName
        ? `The whole result is staged as ${meta.tableName}: page it with SELECT * FROM ${meta.tableName} ${page}.`
        : `Re-run with register_as to stage the whole result as a dataframe${truncated ? ' with an exact row count' : ''}, then page it with SELECT * FROM <name> ${page}.`;
      if (shown === 0 && materialized > 0) {
        return `The first row alone exceeds the ${budget}, so no rows are shown inline${truncated ? ` (${rowLimitCut})` : ''} — select fewer or narrower columns; left(col, n) shortens long text.`;
      }
      if (shown < materialized) {
        return truncated
          ? `Showing ${shownRows} — ${rowLimitCut}, and the ${budget} then ended the inline rows at ${shownText} of the ${materialized.toLocaleString()} ${materialized < input.row_limit ? 'previewed' : 'materialized'}. ${paging}`
          : `Showing ${shownText} of ${result.rowCount.toLocaleString()} rows — the ${budget} ended the inline rows. ${paging}`;
      }
      if (truncated) {
        return `Showing ${shownRows} — ${rowLimitCut}. Raise row_limit, or re-run with register_as to stage the whole result as a new dataframe, which reports an exact row count.`;
      }
      if (result.rowCount > materialized) {
        return `Showing ${shownText} of ${result.rowCount.toLocaleString()} rows — preview capped the inline slice (it defaults to row_limit); raise it to see more${meta?.tableName ? `, or query ${meta.tableName} directly` : ''}.`;
      }
      return;
    };

    /**
     * The column list a response with no inline row carries. A shown row's own
     * keys already cost as much as the whole list, so beside rows it stays
     * whole; alone, a projection wider than half the budget — a PIVOT over
     * thousands of periods — ends early with an entry counting the rest.
     */
    const columnsWithoutRows = (() => {
      const cap = INLINE_BUDGET_BYTES / 2;
      const cost = (list: string[]) => utf8Bytes(JSON.stringify(list));
      if (cost(result.columns) <= cap) return result.columns;
      const listed = (m: number) => [
        ...result.columns.slice(0, m),
        `… ${(result.columns.length - m).toLocaleString()} more columns`,
      ];
      return listed(
        longestFittingPrefix(Math.min(result.columns.length, cap), (m) => cost(listed(m)) <= cap),
      );
    })();
    const executedSql = boundedEcho(
      input.sql,
      (bytes) => ` … [echo cut here — the full ${bytes.toLocaleString()}-byte statement ran]`,
    );

    const outputFor = (shown: number) => ({
      columns: shown > 0 ? result.columns : columnsWithoutRows,
      rows: result.rows.slice(0, shown),
      registered_as: meta?.tableName,
      expires_at: meta?.expiresAt,
    });
    const enrichmentFor = (shown: number) => ({
      totalRows: result.rowCount,
      returnedRows: shown,
      truncated,
      executedSql,
      notice: noticeFor(shown),
    });

    /**
     * Inline as many whole rows as fit the budget on both surfaces:
     * structuredContent is the output merged with enrichment, content[] the
     * rendered table plus the enrichment trailer, `notice` as a block quote.
     */
    const shown = fitRows(
      materialized,
      (k) => {
        const output = outputFor(k);
        const enrichment = enrichmentFor(k);
        return {
          structured: utf8Bytes(JSON.stringify({ ...output, ...enrichment })),
          text: utf8Bytes(renderQueryResult(output)) + trailerBytes(enrichment, {}, ['notice']),
        };
      },
      (i) => {
        const row = result.rows[i] ?? {};
        return {
          structured: utf8Bytes(JSON.stringify(row)) + 1,
          text: utf8Bytes(tableRow(row, result.columns)) + 1,
        };
      },
    );

    ctx.log.info('EIA dataframe query executed', {
      rowCount: result.rowCount,
      returned: shown,
      truncated,
      registeredAs: meta?.tableName,
    });

    const { notice, ...enrichment } = enrichmentFor(shown);
    ctx.enrich(enrichment);
    if (notice !== undefined) ctx.enrich.notice(notice);

    return outputFor(shown);
  },

  format: (result) => [{ type: 'text', text: renderQueryResult(result) }],
});
