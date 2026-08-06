/**
 * @fileoverview Tests for the eia_dataframe_query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import * as canvasBridge from '@/services/canvas-bridge/canvas-bridge.js';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  initCanvasBridge: vi.fn(),
  _resetCanvasBridge: vi.fn(),
}));

const mockQuery = vi.fn();

describe('dataframeQueryTool', () => {
  beforeEach(() => {
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      query: mockQuery,
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
    mockQuery.mockReset();
  });

  it('throws canvas_unavailable when bridge is absent', async () => {
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue(undefined);

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_TEST' });

    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_unavailable' },
    });
  });

  it('executes SQL and returns results', async () => {
    mockQuery.mockResolvedValue({
      result: {
        columns: ['period', 'value'],
        rows: [{ period: '2024-01', value: '9.13' }],
        rowCount: 1,
        tableName: undefined,
      },
    });

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT period, value FROM df_TEST' });
    const result = await dataframeQueryTool.handler(input, ctx);

    expect(result.columns).toEqual(['period', 'value']);
    expect(result.rows).toHaveLength(1);
    expect(result.registered_as).toBeUndefined();

    // row_count moved to enrichment
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalRows).toBe(1);
    expect(enrichment.returnedRows).toBe(1);
  });

  it('populates capped notice when rowCount > rows.length', async () => {
    mockQuery.mockResolvedValue({
      result: {
        columns: ['period', 'value'],
        rows: [{ period: '2024-01', value: '9.13' }],
        rowCount: 5000,
      },
    });

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT * FROM df_TEST',
      row_limit: 10000,
      preview: 1,
    });
    await dataframeQueryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalRows).toBe(5000);
    // The count is exact on this path, so the notice may state it as a total.
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.notice).toMatch(/Showing 1 of 5,000 rows/);
    expect(enrichment.notice).toMatch(/preview/);
  });

  it('discloses a row_limit-capped result and names both escapes (#40)', async () => {
    // The provider caps at row_limit: rowCount === rows.length, truncated: true.
    mockQuery.mockResolvedValue({
      result: {
        columns: ['period', 'price'],
        rows: Array.from({ length: 1000 }, (_, i) => ({ period: `2024-${i}`, price: '9.13' })),
        rowCount: 1000,
        truncated: true,
      },
    });

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT period, price FROM df_TEST' });
    await dataframeQueryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    // rowCount === rows.length here — the preview comparison alone cannot disclose this.
    expect(enrichment.totalRows).toBe(enrichment.returnedRows);
    expect(enrichment.notice).toMatch(/row_limit cap of 1,000/);
    expect(enrichment.notice).toMatch(/register_as/);
    // totalRows is the cap, so the notice must not present it as a total.
    expect(enrichment.notice).not.toMatch(/of 1,000 rows/);
  });

  it('gives one non-contradictory disclosure when row_limit and preview both bind (#40)', async () => {
    mockQuery.mockResolvedValue({
      result: {
        columns: ['period'],
        rows: [{ period: '2024-01' }, { period: '2024-02' }],
        rowCount: 3,
        truncated: true,
      },
    });

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT period FROM df_TEST',
      row_limit: 3,
      preview: 2,
    });
    await dataframeQueryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.notice).toMatch(/Showing 2 rows/);
    expect(enrichment.notice).toMatch(/row_limit cap of 3/);
    // "Showing 2 of 3 rows" was the wrong claim — 3 is the cap, not the total.
    expect(enrichment.notice).not.toMatch(/of 3 rows/);
  });

  it('reports truncated false and no notice on a complete result (#40)', async () => {
    mockQuery.mockResolvedValue({
      result: {
        columns: ['period'],
        rows: [{ period: '2024-01' }, { period: '2024-02' }],
        rowCount: 2,
      },
    });

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT period FROM df_TEST' });
    await dataframeQueryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.notice).toBeUndefined();
  });

  it('returns registered_as when register_as is supplied', async () => {
    const now = new Date().toISOString();
    mockQuery.mockResolvedValue({
      result: {
        columns: ['period', 'total'],
        rows: [{ period: '2024', total: '100.5' }],
        rowCount: 1,
        tableName: 'df_RESULT',
      },
      meta: {
        tableName: 'df_RESULT',
        expiresAt: now,
        sourceTool: 'eia_dataframe_query',
        queryParams: { sql: 'SELECT ...' },
        createdAt: now,
        rowCount: 1,
        truncated: false,
        maxRows: undefined,
        columnSchema: [],
      },
    });

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT period, SUM(CAST(value AS DOUBLE)) AS total FROM df_TEST GROUP BY period',
      register_as: 'df_RESULT',
    });
    const result = await dataframeQueryTool.handler(input, ctx);

    expect(result.registered_as).toBe('df_RESULT');
    expect(result.expires_at).toBe(now);
  });

  describe('format()', () => {
    it('renders table markdown', () => {
      const result = {
        columns: ['period', 'value'],
        rows: [
          { period: '2024-01', value: '9.13' },
          { period: '2024-02', value: '8.45' },
        ],
      };
      const blocks = dataframeQueryTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('| period | value |');
      expect(text).toContain('9.13');
      expect(text).toContain('8.45');
    });

    it('renders no-rows state', () => {
      const result = { columns: ['period'], rows: [] };
      const blocks = dataframeQueryTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('_No rows._');
    });

    it('shows register info when registered_as present', () => {
      const result = {
        columns: ['val'],
        rows: [{ val: '1' }],
        registered_as: 'df_OUT',
        expires_at: '2026-01-01T00:00:00Z',
      };
      const blocks = dataframeQueryTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('df_OUT');
    });
  });
});
