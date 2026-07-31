/**
 * @fileoverview Tests for the eia_dataframe_describe tool.
 * @module tests/tools/dataframe-describe.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import * as canvasBridge from '@/services/canvas-bridge/canvas-bridge.js';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  initCanvasBridge: vi.fn(),
  _resetCanvasBridge: vi.fn(),
}));

const mockDescribe = vi.fn();

describe('dataframeDescribeTool', () => {
  beforeEach(() => {
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      describe: mockDescribe,
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
    mockDescribe.mockReset();
  });

  it('throws canvas_unavailable when bridge is absent', async () => {
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue(undefined);

    const ctx = createMockContext({ errors: dataframeDescribeTool.errors, tenantId: 'test' });
    const input = dataframeDescribeTool.input.parse({});

    await expect(dataframeDescribeTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_unavailable' },
    });
  });

  it('returns empty dataframes list when none registered', async () => {
    mockDescribe.mockResolvedValue([]);

    const ctx = createMockContext({ errors: dataframeDescribeTool.errors, tenantId: 'test' });
    const input = dataframeDescribeTool.input.parse({});
    const result = await dataframeDescribeTool.handler(input, ctx);

    expect(result.dataframes).toHaveLength(0);
    expect(result.active_names).toEqual([]);
    expect(result.found).toBeUndefined();
    expect(result.requested_name).toBeUndefined();
  });

  it('returns dataframe metadata with all fields', async () => {
    const now = new Date().toISOString();
    mockDescribe.mockResolvedValue([
      {
        tableName: 'df_ABCDE_FGHIJ',
        sourceTool: 'eia_query_route',
        queryParams: { route: 'electricity/retail-sales', filters: { stateid: 'TX' } },
        createdAt: now,
        expiresAt: now,
        rowCount: 240,
        truncated: true,
        maxRows: 100,
        columnSchema: [
          { name: 'period', type: 'VARCHAR', nullable: true },
          { name: 'value', type: 'VARCHAR', nullable: true },
        ],
      },
    ]);

    const ctx = createMockContext({ errors: dataframeDescribeTool.errors, tenantId: 'test' });
    const input = dataframeDescribeTool.input.parse({});
    const result = await dataframeDescribeTool.handler(input, ctx);

    expect(result.dataframes).toHaveLength(1);
    const df = result.dataframes[0]!;
    expect(df.name).toBe('df_ABCDE_FGHIJ');
    expect(df.source_tool).toBe('eia_query_route');
    expect(df.row_count).toBe(240);
    expect(df.truncated).toBe(true);
    expect(df.max_rows).toBe(100);
    expect(df.column_schema).toHaveLength(2);
    expect(df.column_schema[0]?.nullable).toBe(true);
  });

  describe('format()', () => {
    it('renders empty state message', () => {
      const blocks = dataframeDescribeTool.format!({ dataframes: [], active_names: [] });
      expect((blocks[0] as { text: string }).text).toContain('No active dataframes');
    });

    it('renders dataframe metadata including nullable column info', () => {
      const now = new Date().toISOString();
      const result = {
        active_names: ['df_TEST'],
        dataframes: [
          {
            name: 'df_TEST',
            source_tool: 'eia_query_route',
            query_params: { route: 'steo', filters: { seriesId: 'PATCPUS' } },
            created_at: now,
            expires_at: now,
            row_count: 50,
            truncated: false,
            column_schema: [{ name: 'value', type: 'VARCHAR', nullable: true }],
          },
        ],
      };
      const blocks = dataframeDescribeTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('df_TEST');
      expect(text).toContain('nullable=true');
      expect(text).toContain('PATCPUS');
    });
  });
});
