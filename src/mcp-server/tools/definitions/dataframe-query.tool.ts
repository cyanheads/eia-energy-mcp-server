/**
 * @fileoverview Tool definition for eia_dataframe_query. Runs a single-statement
 * SELECT against canvas dataframes registered by eia_query_route. Read-only
 * enforcement in the framework SQL gate: text deny-list, statement count,
 * statement type, EXPLAIN-plan walk, and system-catalog deny (denySystemCatalogs).
 * EIA data values are VARCHAR — cast to DOUBLE for arithmetic.
 * @module mcp-server/tools/definitions/dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const dataframeQueryTool = tool('eia_dataframe_query', {
  title: 'Query EIA Dataframes',
  description:
    'Run a single-statement SELECT against canvas dataframes registered by eia_query_route. Standard DuckDB SQL — joins, aggregates, window functions, CTEs all supported. Reference dataframes by the df_<id> handles returned by eia_query_route or listed by eia_dataframe_describe. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected. System catalogs (information_schema, pg_catalog, sqlite_master, duckdb_*) are denied. EIA data values are VARCHAR — use CAST(col AS DOUBLE) for arithmetic and aggregation. Optional register_as chains results as a new dataframe with a fresh TTL.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas service is not configured for this deployment.',
      recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable dataframes.',
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
      .optional()
      .describe(
        'When set, persist the result as a new dataframe with a fresh TTL. Use to chain analyses without re-running upstream queries. Conflicts with an existing name throw Conflict.',
      ),
    preview: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe(
        'Rows to include in the immediate response. Defaults to row_limit. Set lower when chaining via register_as and only a sample is needed inline.',
      ),
    row_limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(1000)
      .describe('Hard cap on rows materialized in the response (default 1000, max 10000).'),
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
      .describe('Materialized rows, bounded by preview / row_limit.'),
    registered_as: z
      .string()
      .optional()
      .describe('Set when register_as was supplied and the new dataframe was materialized.'),
    expires_at: z
      .string()
      .optional()
      .describe('ISO 8601 expiry for the newly registered dataframe, when applicable.'),
  }),

  enrichment: {
    totalRows: z
      .number()
      .describe('Total rows the query produced (may exceed rows.length when capped by row_limit).'),
    returnedRows: z.number().describe('Rows included in this response.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when results are capped — shows how many rows were omitted.'),
  },

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.', {
        ...ctx.recoveryFor('canvas_unavailable'),
      });
    }

    const { result, meta } = await bridge.query(ctx, input.sql, {
      ...(input.register_as !== undefined && { registerAs: input.register_as }),
      ...(input.preview !== undefined && { preview: input.preview }),
      rowLimit: input.row_limit,
      sourceTool: 'eia_dataframe_query',
      queryParams: { sql: input.sql },
    });

    ctx.log.info('EIA dataframe query executed', {
      rowCount: result.rowCount,
      returned: result.rows.length,
      registeredAs: meta?.tableName,
    });

    ctx.enrich({ totalRows: result.rowCount, returnedRows: result.rows.length });
    if (result.rowCount > result.rows.length) {
      ctx.enrich.notice(
        `Showing ${result.rows.length.toLocaleString()} of ${result.rowCount.toLocaleString()} rows — increase row_limit or use register_as to chain into a new dataframe.`,
      );
    }

    return {
      columns: result.columns,
      rows: result.rows,
      registered_as: meta?.tableName,
      expires_at: meta?.expiresAt,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    if (result.registered_as) {
      lines.push(
        `Registered as ${result.registered_as} (expires ${result.expires_at ?? 'unknown'}).`,
      );
    }

    if (result.rows.length === 0) {
      lines.push('_No rows._');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    const header = `| ${result.columns.join(' | ')} |`;
    const sep = `| ${result.columns.map(() => '---').join(' | ')} |`;
    lines.push(header, sep);

    for (const row of result.rows) {
      const cells = result.columns.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') return v.replace(/\|/g, '\\|');
        if (typeof v === 'object') return JSON.stringify(v).replace(/\|/g, '\\|');
        return String(v);
      });
      lines.push(`| ${cells.join(' | ')} |`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
