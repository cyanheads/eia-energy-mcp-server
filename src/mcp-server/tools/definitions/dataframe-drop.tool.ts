/**
 * @fileoverview Tool definition for eia_dataframe_drop. Drops a canvas
 * dataframe by name. Opt-in — only registered in createApp() when
 * EIA_DATAFRAME_DROP_ENABLED=true and a canvas is configured
 * (CANVAS_PROVIDER_TYPE=duckdb). Idempotent: returns dropped=false when
 * nothing matched. A canvas that cannot perform the drop fails the call with
 * the retryable canvas_drop_failed reason, leaving the dataframe staged and
 * listed — never a dropped=true it did not earn. The per-dataframe expiry
 * (default 24 h, extended by every query that references the dataframe)
 * handles cleanup in normal operation; this tool is for manual cleanup in
 * long-running sessions.
 * @module mcp-server/tools/definitions/dataframe-drop.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const dataframeDropTool = tool('eia_dataframe_drop', {
  title: 'Drop EIA Dataframe',
  description:
    'Drop a canvas dataframe by name. Idempotent — returns dropped=false when nothing matched. Use to free canvas resources ahead of the per-dataframe expiry when an analysis is complete. In normal operation, expiry cleanup (default 24 h, extended by every query that references the dataframe) is sufficient and this tool is unnecessary. Only available when EIA_DATAFRAME_DROP_ENABLED=true and a DataCanvas is configured.',
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: true,
    openWorldHint: false,
  },

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas service is not configured for this deployment.',
      recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable dataframes.',
    },
    {
      reason: 'canvas_drop_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'The canvas could not be reached or threw while dropping the dataframe.',
      recovery:
        'Retry eia_dataframe_drop shortly — the dataframe is still staged and listed by eia_dataframe_describe, and it expires on its own schedule if the drop keeps failing.',
    },
  ],

  input: z.object({
    name: z.string().min(1).describe('df_<id> handle to drop.'),
  }),

  output: z.object({
    name: z.string().describe('The name that was requested.'),
    dropped: z
      .boolean()
      .describe(
        'True when the canvas held the dataframe and removed it; false when nothing matched. A drop the canvas could not perform fails the call instead of returning either.',
      ),
  }),

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.');
    }

    const outcome = await bridge.drop(ctx, input.name);
    if (outcome.status === 'failed') {
      throw ctx.fail(
        'canvas_drop_failed',
        `Dropping ${input.name} failed: ${outcome.message}. The dataframe is still staged.`,
        { name: input.name },
      );
    }
    const dropped = outcome.status === 'dropped';
    ctx.log.info('EIA dataframe drop requested', { name: input.name, dropped });
    return { name: input.name, dropped };
  },

  format: (result) => [
    {
      type: 'text',
      text: result.dropped ? `Dropped ${result.name}.` : `${result.name} not found.`,
    },
  ],
});
