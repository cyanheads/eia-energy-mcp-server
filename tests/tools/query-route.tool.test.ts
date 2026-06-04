/**
 * @fileoverview Tests for the eia_query_route tool.
 * @module tests/tools/query-route.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryRouteTool } from '@/mcp-server/tools/definitions/query-route.tool.js';
import * as canvasBridge from '@/services/canvas-bridge/canvas-bridge.js';
import * as eiaService from '@/services/eia/eia-service.js';

vi.mock('@/services/eia/eia-service.js', () => ({
  getEiaApiService: vi.fn(),
  initEiaApiService: vi.fn(),
  _resetEiaApiService: vi.fn(),
}));

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  initCanvasBridge: vi.fn(),
  _resetCanvasBridge: vi.fn(),
}));

const mockQuery = vi.fn();

const SAMPLE_DATA_RESPONSE = {
  total: 240,
  dateFormat: 'YYYY-MM',
  frequency: 'monthly',
  data: [
    {
      period: '2024-01',
      stateid: 'TX',
      sectorid: 'RES',
      sales: '9.13',
      'sales-units': 'million kilowatthours',
    },
    {
      period: '2024-02',
      stateid: 'TX',
      sectorid: 'RES',
      sales: '8.45',
      'sales-units': 'million kilowatthours',
    },
  ],
  warnings: undefined,
};

describe('queryRouteTool', () => {
  beforeEach(() => {
    vi.mocked(eiaService.getEiaApiService).mockReturnValue({
      query: mockQuery,
    } as unknown as ReturnType<typeof eiaService.getEiaApiService>);
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue(undefined);
    mockQuery.mockReset();
  });

  it('returns data with all required fields', async () => {
    mockQuery.mockResolvedValue(SAMPLE_DATA_RESPONSE);

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await queryRouteTool.handler(input, ctx);

    expect(result.route).toBe('electricity/retail-sales');
    expect(result.data).toHaveLength(2);
    expect(result.frequency).toBe('monthly');
    expect(result.date_format).toBe('YYYY-MM');
    expect(result.total).toBe(240);
    expect(result.returned_count).toBe(2);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(240);
    expect(enrichment.returnedCount).toBe(2);
    expect(enrichment.effectiveRoute).toBe('electricity/retail-sales');
  });

  it('data values are strings not numbers', async () => {
    mockQuery.mockResolvedValue(SAMPLE_DATA_RESPONSE);

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await queryRouteTool.handler(input, ctx);

    expect(typeof result.data[0]?.sales).toBe('string');
    expect(result.data[0]?.sales).toBe('9.13');
  });

  it('returns structured empty data when zero rows matched', async () => {
    mockQuery.mockResolvedValue({
      total: 0,
      dateFormat: 'YYYY-MM',
      frequency: 'monthly',
      data: [],
      warnings: undefined,
    });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      filters: { stateid: 'ZZ' },
    });

    const result = await queryRouteTool.handler(input, ctx);
    expect(result.route).toBe('electricity/retail-sales');
    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.returned_count).toBe(0);
    expect(result.notice).toBeDefined();
    expect(result.notice).toContain('eia_describe_route');
  });

  it('forwards truncation_warning from EIA warnings', async () => {
    mockQuery.mockResolvedValue({
      ...SAMPLE_DATA_RESPONSE,
      warnings: ['Results may be truncated near the 5000 row limit'],
    });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await queryRouteTool.handler(input, ctx);

    expect(result.truncation_warning).toContain('truncated');
  });

  it('includes canvas_preview_note when total > returned and no canvas', async () => {
    mockQuery.mockResolvedValue({ ...SAMPLE_DATA_RESPONSE, total: 5000 });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await queryRouteTool.handler(input, ctx);

    expect(result.canvas_preview_note).toContain('5,000');
    expect(result.canvas_preview_note).toContain('CANVAS_PROVIDER_TYPE=duckdb');
  });

  it('propagates rate_limited from service', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    mockQuery.mockRejectedValue(serviceUnavailable('Rate limited', { reason: 'rate_limited' }));

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });

    await expect(queryRouteTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  describe('format()', () => {
    it('renders table with all data row fields', () => {
      const result = {
        route: 'electricity/retail-sales',
        data: [
          {
            period: '2024-01',
            stateid: 'TX',
            sales: '9.13',
            'sales-units': 'million kilowatthours',
          },
        ],
        total: 240,
        returned_count: 1,
        frequency: 'monthly',
        date_format: 'YYYY-MM',
      };

      const blocks = queryRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('electricity/retail-sales');
      expect(text).toContain('2024-01');
      expect(text).toContain('9.13');
    });

    it('renders canvas info when dataset present', () => {
      const result = {
        route: 'electricity/retail-sales',
        data: [{ period: '2024-01', value: '9.13' }],
        total: 5000,
        returned_count: 100,
        frequency: 'monthly',
        date_format: 'YYYY-MM',
        canvas_id: 'df_ABCDE_FGHIJ',
        dataset: 'df_ABCDE_FGHIJ',
        canvas_preview_note: 'Showing 100 of 5,000 rows',
      };

      const blocks = queryRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('df_ABCDE_FGHIJ');
      expect(text).toContain('5,000');
    });
  });
});
