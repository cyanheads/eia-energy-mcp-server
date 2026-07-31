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

  it('renders EIA warning objects as "warning: description"', async () => {
    mockQuery.mockResolvedValue({
      ...SAMPLE_DATA_RESPONSE,
      warnings: [
        {
          warning: 'incomplete return',
          description: 'The API can only return 5000 rows in JSON format.',
        },
      ],
    });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await queryRouteTool.handler(input, ctx);

    expect(result.truncation_warning).toBe(
      'incomplete return: The API can only return 5000 rows in JSON format.',
    );
    expect(result.truncation_warning).not.toContain('[object Object]');
  });

  it('joins multiple EIA warnings', async () => {
    mockQuery.mockResolvedValue({
      ...SAMPLE_DATA_RESPONSE,
      warnings: [
        { warning: 'parameter out of range: length', description: 'The maximum value is 5000.' },
        { warning: 'incomplete return', description: 'Use offset to paginate results.' },
      ],
    });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await queryRouteTool.handler(input, ctx);

    expect(result.truncation_warning).toBe(
      'parameter out of range: length: The maximum value is 5000.; incomplete return: Use offset to paginate results.',
    );
  });

  it('emits an offset-past-the-end notice when total is positive but no rows came back', async () => {
    mockQuery.mockResolvedValue({
      total: 25,
      dateFormat: 'YYYY',
      frequency: 'annual',
      data: [],
      warnings: undefined,
    });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      offset: 9999,
    });
    const result = await queryRouteTool.handler(input, ctx);

    expect(result.returned_count).toBe(0);
    expect(result.notice).toContain('9,999');
    expect(result.notice).toContain('25');
    expect(result.notice).toContain('Reduce offset');
    // The canvas-disabled advice must not fire on a past-the-end page.
    expect(result.canvas_preview_note).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('CANVAS_PROVIDER_TYPE');
  });

  it('does not emit "enable DataCanvas" advice when a bridge is present', async () => {
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      registerDataframe: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
    mockQuery.mockResolvedValue({
      total: 25,
      dateFormat: 'YYYY',
      frequency: 'annual',
      data: [],
      warnings: undefined,
    });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      offset: 9999,
    });
    const result = await queryRouteTool.handler(input, ctx);

    const rendered = (queryRouteTool.format!(result)[0] as { text: string }).text;
    expect(rendered).not.toContain('CANVAS_PROVIDER_TYPE');
    expect(rendered).toContain('Reduce offset');
  });

  it('omits canvas_id from the output entirely', async () => {
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      registerDataframe: vi.fn().mockResolvedValue({
        tableName: 'df_ABCDE_FGHIJ',
        rowCount: 2,
        expiresAt: new Date().toISOString(),
        columnSchema: [],
      }),
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
    mockQuery.mockResolvedValue(SAMPLE_DATA_RESPONSE);

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await queryRouteTool.handler(input, ctx);

    expect(result.dataset).toBe('df_ABCDE_FGHIJ');
    expect(result).not.toHaveProperty('canvas_id');
    expect(Object.keys(queryRouteTool.output.shape)).not.toContain('canvas_id');
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
        dataset: 'df_ABCDE_FGHIJ',
        canvas_preview_note: 'Showing 100 of 5,000 rows',
      };

      const blocks = queryRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('df_ABCDE_FGHIJ');
      expect(text).toContain('5,000');
      expect(text).not.toContain('canvas:');
    });
  });
});
