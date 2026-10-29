/**
 * @fileoverview Tool definition for eia_dataframe_query. Runs a single-statement
 * SELECT against canvas dataframes registered by eia_query_route's opt-in
 * staging path. Read-only enforcement in the framework SQL gate: text deny-list,
 * statement count, statement type, parse-tree function and file-reference check,
 * EXPLAIN-plan walk, and system-catalog deny (denySystemCatalogs), over a DuckDB
 * engine that runs with external file access off.
 * EIA data values are VARCHAR — cast to DOUBLE for arithmetic.
 * Two bounds can end the inline rows and each gets its own disclosure:
 * `row_limit` drops rows the canvas never counted (`truncated`, `totalRows` is
 * then the cap), while `preview` only narrows the inline slice of what is in
 * hand.
 * @module mcp-server/tools/definitions/dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { clampCount, countSchema, modeDescription } from '../count-limit.js';
import { literalTableCell, tableRow } from '../literal-table-cell.js';

/**
 * Most rows one statement materializes — the canvas provider's default row
 * ceiling (`CANVAS_DEFAULT_ROW_LIMIT`), past which it refuses the query.
 */
const MAX_ROW_LIMIT = 10_000;

/** Inline rows when the caller names no preview, lowered to a smaller row_limit. */
const DEFAULT_PREVIEW = 25;

/** The handler's return value, which `format()` renders. */
interface DataframeQueryResult {
  columns: string[];
  expires_at?: string | undefined;
  registered_as?: string | undefined;
  rows: Array<Record<string, unknown>>;
}

/** The markdown `format()` returns. */
function renderQueryResult(result: DataframeQueryResult): string {
  const lines: string[] = [];
  if (result.registered_as) {
    lines.push(
      `Registered as ${result.registered_as} (expires ${result.expires_at ?? 'unknown'}).`,
    );
  }
  lines.push(
    `| ${result.columns.map(literalTableCell).join(' | ')} |`,
    `| ${result.columns.map(() => '---').join(' | ')} |`,
  );
  for (const row of result.rows) lines.push(tableRow(row, result.columns));
  // The blank line ends the header-only table, which would otherwise take the note as a row.
  if (result.rows.length === 0) lines.push('', '_No rows._');
  return lines.join('\n');
}

export const dataframeQueryTool = tool('eia_dataframe_query', {
  title: 'Query EIA Dataframes',
  description:
    'Run a single-statement SELECT against canvas dataframes registered by eia_query_route calls that passed stage: true — a query that staged nothing leaves no table to select from. Standard DuckDB SQL — joins, aggregates, window functions, CTEs all supported. Reference dataframes by the df_<id> handles returned by eia_query_route or listed by eia_dataframe_describe. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, file reads (read_* functions or a quoted file path), engine-setting functions (current_setting), and SQL built from a string (query_table) are rejected. System catalogs (information_schema, pg_catalog, sqlite_master, duckdb_*) are denied. EIA data values are VARCHAR — use CAST(col AS DOUBLE) for arithmetic and aggregation. Optional register_as chains results as a new dataframe with a fresh expiry. Every dataframe named in the statement has its expiry extended by the query. Inline rows stop at preview; a result cut short says how to reach the rest, including paging a register_as table with LIMIT/OFFSET and no ORDER BY, which keeps the order the preview showed.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'denied_function',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL calls a denied function, including engine settings, file reads, or SQL built from strings.',
      recovery:
        'Select from staged dataframes using ordinary SQL expressions; eia_dataframe_describe lists their columns.',
    },
    {
      reason: 'multi_statement',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL contains more than one statement.',
      recovery: 'Send one SELECT per eia_dataframe_query call; use register_as to chain results.',
    },
    {
      reason: 'sql_read_only',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL attempts a write, external file access, or another operation refused by the read-only gate.',
      recovery:
        'Query staged dataframes with a read-only SELECT; use register_as to persist results.',
    },
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
    preview: countSchema('preview', 0, MAX_ROW_LIMIT)
      .optional()
      .meta(
        modeDescription(
          'Rows to include in the immediate response. Default 25; a larger value returns at most row_limit and says so. 0 returns none, useful when chaining via register_as.',
          'Rows to include in the immediate response. Default 25; at most 10,000, and a value above row_limit returns at most row_limit and says so. 0 returns none, useful when chaining via register_as.',
        ),
      ),
    row_limit: countSchema('row_limit', 1, MAX_ROW_LIMIT)
      .default(1000)
      .meta(
        modeDescription(
          'Hard cap on rows materialized. Default 1,000; a larger value returns at most 10,000 and says so. Rows past the cap are dropped without being counted — the response then carries truncated: true and a totalRows equal to the cap rather than a true total. Pass register_as to materialize the whole result instead and get an exact count.',
          'Hard cap on rows materialized. Default 1,000; at most 10,000. Rows past the cap are dropped without being counted — the response then carries truncated: true and a totalRows equal to the cap rather than a true total. Pass register_as to materialize the whole result instead and get an exact count.',
        ),
      ),
  }),

  output: z.object({
    columns: z.array(z.string()).describe('Column names in projection order.'),
    rows: z
      .array(
        z
          .object({})
          .passthrough()
          .describe('A result row with dynamic keys matching the SQL projection columns.'),
      )
      .describe('Inline rows, bounded by preview and row_limit.'),
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
        'Rows included in this response. Below totalRows when preview ended the inline rows; the notice names how to reach the rest.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when row_limit cut the result: more rows matched than the cap and the remainder was dropped without being counted. False when every matching row was materialized, including on the register_as path, which counts the new dataframe exactly.',
      ),
    executedSql: z
      .string()
      .describe('Echo of the SQL statement that was executed — confirms the exact query that ran.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Discloses requested/effective row_limit and preview when clamped, including on short or empty results. When row_limit or preview ended the inline rows, names each bound and how to reach the rows it withheld (raise a bound below its cap, or page a register_as table with LIMIT/OFFSET and no ORDER BY).',
      ),
  },

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.');
    }

    const rowLimit = clampCount(
      ctx,
      'eia_dataframe_query',
      'row_limit',
      input.row_limit,
      MAX_ROW_LIMIT,
    );
    /**
     * `preview` is capped by this call's row_limit, since the canvas refuses a
     * preview larger than the rows it materializes. An omitted preview takes
     * the default, lowered without a notice to a smaller row_limit — the caller
     * asked for nothing that was cut.
     */
    const preview =
      input.preview === undefined
        ? { applied: Math.min(DEFAULT_PREVIEW, rowLimit.applied) }
        : clampCount(ctx, 'eia_dataframe_query', 'preview', input.preview, rowLimit.applied);

    const { result, meta } = await bridge.query(ctx, input.sql, {
      ...(input.register_as !== undefined && { registerAs: input.register_as }),
      preview: preview.applied,
      rowLimit: rowLimit.applied,
      sourceTool: 'eia_dataframe_query',
      queryParams: { sql: input.sql },
    });

    const truncated = result.truncated === true;
    const shown = result.rows.length;

    /**
     * How the inline rows were bounded and how to reach the rest. `row_limit`
     * (`truncated`) drops rows uncounted, so `totalRows` is then the cap, never
     * a total; `preview` only narrows the inline slice of what is in hand.
     * Paging points at a `register_as` table read with a bare LIMIT/OFFSET: the
     * canvas previews that table with `SELECT * FROM <name> LIMIT n`, and DuckDB
     * keeps a single table's stored order through LIMIT and OFFSET, so the
     * pages continue the preview with no row repeated or skipped. An ORDER BY
     * re-sorts — unstably, on VARCHAR — away from the order the preview showed.
     */
    const boundNotice = ((): string | undefined => {
      const shownText = shown.toLocaleString();
      const shownRows = `${shownText} row${shown === 1 ? '' : 's'}`;
      const rowLimitCut = `more rows matched than the row_limit cap of ${rowLimit.applied.toLocaleString()} and the remainder was dropped uncounted, so totalRows is that cap and not a total`;
      // A preview of 0 showed nothing, so paging starts at the first row with a default-sized page.
      const step = shown || DEFAULT_PREVIEW;
      // SQL numbers carry no digit grouping — `LIMIT 3,977` does not parse.
      const page = (table: string) =>
        `page it with SELECT * FROM ${table} LIMIT ${step} OFFSET ${shown}, raising OFFSET by ${step} for each further page (no ORDER BY: the table keeps the order the preview showed, and a sort reorders it).`;
      const stageAndPage = `with register_as to stage the whole result as a dataframe${truncated ? ' with an exact row count' : ''}, then ${page('<name>')}`;
      // An omitted preview below its default was lowered to row_limit, which preview never exceeds.
      const previewCap =
        input.preview === undefined && preview.applied < DEFAULT_PREVIEW
          ? `preview capped the inline slice at ${preview.applied.toLocaleString()}, its default of ${DEFAULT_PREVIEW} lowered to row_limit`
          : `preview capped the inline slice (it defaults to ${DEFAULT_PREVIEW})`;
      if (truncated) {
        // A row_limit-cut result never carries a register_as table: that path counts the whole result.
        return shown < result.rowCount
          ? `Showing ${shownRows} — ${rowLimitCut}, and preview then ended the inline rows at ${shownText} of the ${result.rowCount.toLocaleString()} materialized. Raise preview to see more of them, or re-run ${stageAndPage}`
          : `Showing ${shownRows} — ${rowLimitCut}. ${rowLimit.applied < MAX_ROW_LIMIT ? 'Raise row_limit, or re-run' : 'Re-run'} with register_as to stage the whole result as a new dataframe, which reports an exact row count.`;
      }
      if (result.rowCount > shown) {
        const guidance =
          preview.applied < rowLimit.applied
            ? `; raise it to see more${meta?.tableName ? `, or query ${meta.tableName} directly` : ''}.`
            : meta?.tableName
              ? `. The whole result is staged as ${meta.tableName}: ${page(meta.tableName)}`
              : `. Re-run ${stageAndPage}`;
        return `Showing ${shownText} of ${result.rowCount.toLocaleString()} rows — ${previewCap}${guidance}`;
      }
      return;
    })();

    ctx.log.info('EIA dataframe query executed', {
      rowCount: result.rowCount,
      returned: shown,
      truncated,
      registeredAs: meta?.tableName,
    });

    ctx.enrich({
      totalRows: result.rowCount,
      returnedRows: shown,
      truncated,
      executedSql: input.sql,
    });
    const notice = [rowLimit.notice, preview.notice, boundNotice].filter(Boolean).join(' ');
    if (notice) ctx.enrich.notice(notice);

    return {
      columns: result.columns,
      rows: result.rows,
      registered_as: meta?.tableName,
      expires_at: meta?.expiresAt,
    };
  },

  format: (result) => [{ type: 'text', text: renderQueryResult(result) }],
});
