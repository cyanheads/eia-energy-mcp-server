/**
 * @fileoverview Declared recovery reaches both EIA tool error surfaces.
 * @module tests/tools/declared-recovery.tool.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { queryRouteTool } from '@/mcp-server/tools/definitions/query-route.tool.js';
import { _resetCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

// An inverted range fails only once EIA answers it with no rows, so the query
// answers with an empty annual page.
vi.mock('@/services/eia/eia-service.js', () => ({
  getEiaApiService: () => ({
    query: async () => ({
      route: 'electricity/retail-sales',
      total: 0,
      data: [],
      frequency: 'annual',
      dateFormat: 'YYYY',
    }),
  }),
}));

describe('declared recovery', () => {
  beforeEach(_resetCanvasBridge);

  for (const [definition, input, reason] of [
    [dataframeDescribeTool, {}, 'canvas_unavailable'],
    [dataframeDropTool, { name: 'df_missing' }, 'canvas_unavailable'],
    [dataframeQueryTool, { sql: 'SELECT 1' }, 'canvas_unavailable'],
    [queryRouteTool, { route: 'electricity/retail-sales', start: '2025', end: '2024' }, 'no_data'],
  ] as const) {
    it(`${definition.name} carries its declared hint on both surfaces`, async () => {
      const contract = definition.errors!.find((entry) => entry.reason === reason)!;
      const result = await runToolContract(definition, input);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: contract.code, data: { reason, recovery: { hint: contract.recovery } } },
      });
      expect(result.content).toContainEqual(
        expect.objectContaining({ text: expect.stringContaining(contract.recovery) }),
      );
    });
  }
});
