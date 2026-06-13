/**
 * @fileoverview Additional coverage for eia_query_route — input validation,
 * inverted date range pre-flight, canvas accumulation path, security (API key
 * not leaked), and format edge cases.
 * @module tests/tools/query-route-extra.tool.test
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

const BASE_RESPONSE = {
  total: 2,
  dateFormat: 'YYYY-MM',
  frequency: 'monthly',
  data: [
    { period: '2024-01', stateid: 'TX', value: '9.13', 'value-units': 'million kWh' },
    { period: '2024-02', stateid: 'TX', value: '8.45', 'value-units': 'million kWh' },
  ],
  warnings: undefined,
};

describe('queryRouteTool — additional coverage', () => {
  beforeEach(() => {
    vi.mocked(eiaService.getEiaApiService).mockReturnValue({
      query: mockQuery,
    } as unknown as ReturnType<typeof eiaService.getEiaApiService>);
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue(undefined);
    mockQuery.mockReset();
  });

  // ------------------------------------------------------------------
  // Input validation via Zod schema
  // ------------------------------------------------------------------

  describe('input validation', () => {
    it('rejects empty route string (min 1)', () => {
      expect(() => queryRouteTool.input.parse({ route: '' })).toThrow();
    });

    it('rejects negative offset', () => {
      expect(() => queryRouteTool.input.parse({ route: 'steo', offset: -1 })).toThrow();
    });

    it('rejects length = 0 (min 1)', () => {
      expect(() => queryRouteTool.input.parse({ route: 'steo', length: 0 })).toThrow();
    });

    it('rejects length > 5000 (max 5000)', () => {
      expect(() => queryRouteTool.input.parse({ route: 'steo', length: 5001 })).toThrow();
    });

    it('accepts length exactly at max (5000)', () => {
      expect(() => queryRouteTool.input.parse({ route: 'steo', length: 5000 })).not.toThrow();
    });

    it('accepts offset = 0 (boundary)', () => {
      expect(() => queryRouteTool.input.parse({ route: 'steo', offset: 0 })).not.toThrow();
    });

    it('rejects sort direction that is not asc or desc', () => {
      expect(() =>
        queryRouteTool.input.parse({
          route: 'steo',
          sort: [{ column: 'period', direction: 'invalid' }],
        }),
      ).toThrow();
    });

    it('accepts valid sort direction asc', () => {
      expect(() =>
        queryRouteTool.input.parse({
          route: 'steo',
          sort: [{ column: 'period', direction: 'asc' }],
        }),
      ).not.toThrow();
    });
  });

  // ------------------------------------------------------------------
  // Pre-flight: inverted date range
  // ------------------------------------------------------------------

  describe('inverted date range pre-flight', () => {
    it('throws no_data when start > end (monthly format)', async () => {
      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        start: '2024-06',
        end: '2024-01',
      });

      await expect(queryRouteTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'no_data' },
      });

      // Service should NOT have been called
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('throws no_data when start > end (annual format)', async () => {
      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'steo',
        start: '2025',
        end: '2020',
      });

      await expect(queryRouteTool.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'no_data' },
      });
    });

    it('does not throw when start equals end', async () => {
      mockQuery.mockResolvedValue({
        ...BASE_RESPONSE,
        total: 1,
        data: [{ period: '2024-01', value: '9.13', 'value-units': 'million kWh' }],
      });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        start: '2024-01',
        end: '2024-01',
      });

      await expect(queryRouteTool.handler(input, ctx)).resolves.toBeDefined();
    });

    it('does not throw when only start is supplied', async () => {
      mockQuery.mockResolvedValue(BASE_RESPONSE);

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        start: '2024-01',
      });

      await expect(queryRouteTool.handler(input, ctx)).resolves.toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Enrichment: appliedFilters when filters are provided
  // ------------------------------------------------------------------

  it('populates appliedFilters enrichment when filters are non-empty', async () => {
    mockQuery.mockResolvedValue(BASE_RESPONSE);

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      filters: { stateid: 'TX', sectorid: ['RES', 'COM'] },
    });
    await queryRouteTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.appliedFilters).toBeDefined();
    expect((enrichment.appliedFilters as Record<string, unknown>).stateid).toBe('TX');
    expect((enrichment.appliedFilters as Record<string, unknown>).sectorid).toEqual(['RES', 'COM']);
  });

  it('does not populate appliedFilters enrichment when no filters provided', async () => {
    mockQuery.mockResolvedValue(BASE_RESPONSE);

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    await queryRouteTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.appliedFilters).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // Canvas: spillover with explicit canvas_id reuse
  // ------------------------------------------------------------------

  it('reuses supplied canvas_id when registering a dataset', async () => {
    const mockRegister = vi.fn().mockResolvedValue({
      tableName: 'df_NEW_TABLE',
      rowCount: 2,
      expiresAt: new Date().toISOString(),
      columnSchema: [],
    });
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      registerDataframe: mockRegister,
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);

    mockQuery.mockResolvedValue(BASE_RESPONSE);

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      canvas_id: 'df_EXISTING_CANVAS',
    });
    const result = await queryRouteTool.handler(input, ctx);

    // canvas_id should be the supplied one, not the newly minted table name
    expect(result.canvas_id).toBe('df_EXISTING_CANVAS');
    expect(result.dataset).toBe('df_NEW_TABLE');
  });

  it('uses dataset name as canvas_id when no canvas_id supplied', async () => {
    const mockRegister = vi.fn().mockResolvedValue({
      tableName: 'df_MINTED',
      rowCount: 2,
      expiresAt: new Date().toISOString(),
      columnSchema: [],
    });
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      registerDataframe: mockRegister,
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);

    mockQuery.mockResolvedValue(BASE_RESPONSE);

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await queryRouteTool.handler(input, ctx);

    expect(result.canvas_id).toBe('df_MINTED');
    expect(result.dataset).toBe('df_MINTED');
  });

  it('canvas_preview_note omitted when canvas is available and total equals length', async () => {
    const mockRegister = vi.fn().mockResolvedValue({
      tableName: 'df_XYZ',
      rowCount: 2,
      expiresAt: new Date().toISOString(),
      columnSchema: [],
    });
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      registerDataframe: mockRegister,
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);

    // total === data.length — no spillover note
    mockQuery.mockResolvedValue({ ...BASE_RESPONSE, total: 2 });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await queryRouteTool.handler(input, ctx);

    expect(result.canvas_preview_note).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // Security: tool output (data rows) must not contain env var name or value
  // ------------------------------------------------------------------

  it('does not include EIA_API_KEY env var name in successful data output', async () => {
    // A successful response from the service must not have api_key content
    // injected anywhere by the tool handler — only the service constructs URLs.
    mockQuery.mockResolvedValue(BASE_RESPONSE);

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await queryRouteTool.handler(input, ctx);

    // The result object should contain data rows and metadata — none referencing api_key
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('api_key');
    expect(resultStr).not.toContain('EIA_API_KEY');
  });

  it('error from service does not get embellished with api_key by tool handler', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    mockQuery.mockRejectedValue(serviceUnavailable('Rate limited', { reason: 'rate_limited' }));

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });

    let caughtError: unknown;
    try {
      await queryRouteTool.handler(input, ctx);
    } catch (e) {
      caughtError = e;
    }

    // The tool re-throws the service error verbatim — it must not add api_key content
    expect(caughtError).toBeDefined();
    const errMsg = (caughtError as { message?: string }).message ?? '';
    // Tool handler must not inject api_key information into the error message
    expect(errMsg).not.toContain('api_key=');
  });

  // ------------------------------------------------------------------
  // format() edge cases
  // ------------------------------------------------------------------

  describe('format() edge cases', () => {
    it('escapes pipe characters in cell values', () => {
      const result = {
        route: 'steo',
        data: [{ period: '2024-01', description: 'value | with | pipes' }],
        total: 1,
        returned_count: 1,
        frequency: 'monthly',
        date_format: 'YYYY-MM',
      };
      const blocks = queryRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('value \\| with \\| pipes');
    });

    it('renders empty-data state without crashing', () => {
      const result = {
        route: 'steo',
        data: [],
        total: 0,
        returned_count: 0,
        frequency: 'monthly',
        date_format: 'YYYY-MM',
      };
      const blocks = queryRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('No rows returned');
    });

    it('renders units in header from {col}-units fields', () => {
      const result = {
        route: 'electricity/retail-sales',
        data: [
          {
            period: '2024-01',
            sales: '9.13',
            'sales-units': 'million kilowatthours',
          },
        ],
        total: 1,
        returned_count: 1,
        frequency: 'monthly',
        date_format: 'YYYY-MM',
      };
      const blocks = queryRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      // Units should appear in header, not in every cell
      expect(text).toContain('million kilowatthours');
      // The actual value rows should not repeat the units column verbatim
      expect(text).toContain('9.13');
    });

    it('renders truncation_warning when present', () => {
      const result = {
        route: 'steo',
        data: [{ period: '2024-01', value: '1.23' }],
        total: 1,
        returned_count: 1,
        frequency: 'monthly',
        date_format: 'YYYY-MM',
        truncation_warning: 'Results may be truncated near the 5000 row limit',
      };
      const blocks = queryRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('truncated');
    });

    it('handles null cell values gracefully', () => {
      const result = {
        route: 'steo',
        data: [{ period: '2024-01', value: null }],
        total: 1,
        returned_count: 1,
        frequency: 'monthly',
        date_format: 'YYYY-MM',
      };
      const blocks = queryRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(typeof text).toBe('string');
    });
  });
});
