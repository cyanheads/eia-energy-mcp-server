/**
 * @fileoverview Tool definition for eia_dataframe_describe. Lists canvas
 * dataframes materialized by eia_query_route with provenance, expiry, row
 * count, and column schema. Reconciles stored provenance against the canvas's
 * live tables before responding so the list is always current, and reports a
 * name that does not resolve as a miss against the staged set rather than as an
 * empty workspace.
 * @module mcp-server/tools/definitions/dataframe-describe.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const dataframeDescribeTool = tool('eia_dataframe_describe', {
  title: 'Describe EIA Dataframes',
  description:
    'List canvas dataframes (df_<id>) materialized by eia_query_route, with provenance, expiry, row count, and column schema. Drops entries for dataframes the canvas no longer holds before responding, so the list is always current. Pass a specific name to inspect one dataframe; omit to list all active dataframes for this tenant. A name that is not staged comes back as found=false alongside the handles that are, never as an empty list. Listing is not use: only an eia_dataframe_query statement naming a dataframe extends its expiry, so a dataframe polled with this tool and never queried still lapses on schedule.',
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
    name: z
      .string()
      .optional()
      .describe(
        'df_<id> handle to describe a single dataframe. Omit to list all active dataframes.',
      ),
  }),

  output: z.object({
    requested_name: z
      .string()
      .optional()
      .describe('Echo of the name input. Absent when no name was supplied.'),
    found: z
      .boolean()
      .optional()
      .describe(
        'True when the requested name is staged, false when it is not. Absent when no name was supplied — an unscoped list has nothing to resolve.',
      ),
    active_names: z
      .array(z.string())
      .describe(
        'Every df_<id> handle staged for this tenant, regardless of the requested scope. On a miss these are the handles that are still usable.',
      ),
    dataframes: z
      .array(
        z
          .object({
            name: z.string().describe('Canvas table name (df_<id>).'),
            source_tool: z.string().describe('Tool that produced this dataframe.'),
            query_params: z
              .record(z.string(), z.unknown())
              .describe('Input parameters the source tool was called with.'),
            created_at: z.string().describe('ISO 8601 creation timestamp.'),
            expires_at: z
              .string()
              .optional()
              .describe(
                'ISO 8601 expiry, extended each time an eia_dataframe_query statement references this dataframe. Reading it here does not extend it. Absent when the dataframe carries no expiry of its own and follows the canvas lifecycle.',
              ),
            row_count: z.number().describe('Rows materialized in the dataframe.'),
            truncated: z
              .boolean()
              .describe('True when the EIA upstream had more rows than were registered.'),
            max_rows: z
              .number()
              .optional()
              .describe('Materialization cap that produced truncated, when applicable.'),
            column_schema: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name.'),
                    type: z.string().describe('DuckDB column type (VARCHAR for EIA data values).'),
                    nullable: z.boolean().describe('Whether the column permits NULL.'),
                  })
                  .describe('A column in the dataframe schema.'),
              )
              .describe('Column schema (all EIA data columns are VARCHAR and nullable).'),
          })
          .describe('A canvas dataframe entry.'),
      )
      .describe(
        'Dataframes matching the requested scope, newest first. Empty when nothing is staged, or when a supplied name does not resolve — read found and active_names to tell those apart.',
      ),
  }),

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.', {
        ...ctx.recoveryFor('canvas_unavailable'),
      });
    }

    // Always list unscoped, then narrow locally: the full set is what
    // distinguishes "that handle is not staged" from "nothing is staged", and
    // it is what a caller who mistyped a handle needs back.
    const entries = await bridge.describe(ctx);
    const scoped =
      input.name === undefined ? entries : entries.filter((e) => e.tableName === input.name);

    return {
      ...(input.name !== undefined && {
        requested_name: input.name,
        found: scoped.length > 0,
      }),
      active_names: entries.map((meta) => meta.tableName),
      dataframes: scoped.map((meta) => ({
        name: meta.tableName,
        source_tool: meta.sourceTool,
        query_params: meta.queryParams,
        created_at: meta.createdAt,
        expires_at: meta.expiresAt,
        row_count: meta.rowCount,
        truncated: meta.truncated,
        max_rows: meta.maxRows,
        column_schema: meta.columnSchema.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable ?? true,
        })),
      })),
    };
  },

  format: (result) => {
    const active =
      result.active_names.length > 0
        ? `${result.active_names.length} active dataframe(s): ${result.active_names.join(', ')}`
        : 'No active dataframes';

    if (result.requested_name !== undefined && result.dataframes.length === 0) {
      return [{ type: 'text', text: `${result.requested_name} not found. ${active}.` }];
    }

    const heading =
      result.requested_name !== undefined
        ? `**${result.requested_name}** is staged. ${active}.`
        : `**${active}.**`;

    if (result.dataframes.length === 0) {
      return [{ type: 'text', text: heading }];
    }

    const lines: string[] = [`${heading}\n`];
    for (const df of result.dataframes) {
      const truncated = df.truncated
        ? ` (truncated${df.max_rows != null ? ` at ${df.max_rows}` : ''})`
        : '';
      lines.push(`### ${df.name}`);
      lines.push(`- Source: ${df.source_tool}`);
      lines.push(`- Rows: ${df.row_count}${truncated}`);
      lines.push(
        `- Created: ${df.created_at}${df.expires_at ? ` — Expires: ${df.expires_at}` : ''}`,
      );
      /**
       * `structuredContent` drops undefined-valued keys on serialization, so
       * rendering them here would put parameters in `content[]` that the
       * structured surface never reported — and `JSON.stringify(undefined)`
       * renders them as the literal `undefined` rather than as a value.
       */
      const paramEntries = Object.entries(df.query_params).filter(([, v]) => v !== undefined);
      if (paramEntries.length > 0) {
        const params = paramEntries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
        lines.push(`- Params: ${params}`);
      }
      const cols = df.column_schema
        .map((c) => `${c.name}:${c.type}(nullable=${c.nullable})`)
        .join(', ');
      lines.push(`- Columns: ${cols}`);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
