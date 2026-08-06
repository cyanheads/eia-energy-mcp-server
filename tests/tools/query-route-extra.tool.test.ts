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

  it('echoes appliedStart/appliedEnd/appliedFrequency/appliedColumns when provided', async () => {
    mockQuery.mockResolvedValue(BASE_RESPONSE);

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      start: '2024-01',
      end: '2024-12',
      frequency: 'monthly',
      columns: ['sales', 'revenue'],
    });
    await queryRouteTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.appliedStart).toBe('2024-01');
    expect(enrichment.appliedEnd).toBe('2024-12');
    expect(enrichment.appliedFrequency).toBe('monthly');
    expect(enrichment.appliedColumns).toEqual(['sales', 'revenue']);
  });

  it('omits applied-echo enrichment fields when not provided', async () => {
    mockQuery.mockResolvedValue(BASE_RESPONSE);

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    await queryRouteTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.appliedStart).toBeUndefined();
    expect(enrichment.appliedEnd).toBeUndefined();
    expect(enrichment.appliedFrequency).toBeUndefined();
    expect(enrichment.appliedColumns).toBeUndefined();
  });

  it('echoes appliedOffset/appliedLength on every call', async () => {
    mockQuery.mockResolvedValue(BASE_RESPONSE);

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      offset: 250,
      length: 25,
    });
    await queryRouteTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.appliedOffset).toBe(250);
    expect(enrichment.appliedLength).toBe(25);
  });

  it('echoes the schema defaults for offset/length when neither is supplied', async () => {
    mockQuery.mockResolvedValue(BASE_RESPONSE);

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    await queryRouteTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.appliedOffset).toBe(0);
    expect(enrichment.appliedLength).toBe(100);
  });

  // ------------------------------------------------------------------
  // Canvas: accumulation replaces the dropped canvas_id threading
  // ------------------------------------------------------------------

  it('strips a canvas_id input — the parameter no longer exists', () => {
    const parsed = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      canvas_id: 'df_EXISTING_CANVAS',
    });
    expect(parsed).not.toHaveProperty('canvas_id');
    expect(Object.keys(queryRouteTool.input.shape)).not.toContain('canvas_id');
  });

  it('requests accumulation only when a canvas bridge is present', async () => {
    mockQuery.mockResolvedValue(BASE_RESPONSE);

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    await queryRouteTool.handler(input, ctx);

    expect(mockQuery).toHaveBeenCalledWith(
      'electricity/retail-sales',
      expect.objectContaining({ accumulate: false }),
      ctx,
    );

    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      registerDataframe: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
    await queryRouteTool.handler(input, createMockContext({ errors: queryRouteTool.errors }));

    expect(mockQuery).toHaveBeenLastCalledWith(
      'electricity/retail-sales',
      expect.objectContaining({ accumulate: true }),
      expect.anything(),
    );
  });

  it('registers the accumulated rows, not the inline preview', async () => {
    const accumulatedRows = Array.from({ length: 40 }, (_, i) => ({
      period: `2024-${String(i + 1).padStart(2, '0')}`,
      value: String(i),
    }));
    const mockRegister = vi.fn().mockResolvedValue({
      tableName: 'df_STAGED',
      rowCount: 40,
      expiresAt: new Date().toISOString(),
      columnSchema: [],
    });
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      registerDataframe: mockRegister,
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);

    mockQuery.mockResolvedValue({
      ...BASE_RESPONSE,
      total: 40,
      accumulated: { rows: accumulatedRows, capped: false, cap: 25000 },
    });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await queryRouteTool.handler(input, ctx);

    expect(mockRegister.mock.calls[0]?.[1].rows).toHaveLength(40);
    expect(mockRegister.mock.calls[0]?.[1].truncated).toBe(false);
    // Inline preview is untouched by accumulation.
    expect(result.data).toHaveLength(2);
    expect(result.returned_count).toBe(2);
    expect(result.dataset).toBe('df_STAGED');
    // The note names the real staged count, not the preview count.
    expect(result.canvas_preview_note).toContain('40 rows staged as df_STAGED');
    expect(result.canvas_preview_note).not.toContain('EIA_CANVAS_MAX_ROWS');
  });

  it('names the cap in the note when accumulation was capped short of total', async () => {
    const accumulatedRows = Array.from({ length: 25 }, (_, i) => ({
      period: `2024-${String((i % 12) + 1).padStart(2, '0')}`,
      value: String(i),
    }));
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      registerDataframe: vi.fn().mockResolvedValue({
        tableName: 'df_CAPPED',
        rowCount: 25,
        expiresAt: new Date().toISOString(),
        columnSchema: [],
      }),
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);

    mockQuery.mockResolvedValue({
      ...BASE_RESPONSE,
      total: 113460,
      accumulated: { rows: accumulatedRows, capped: true, cap: 25000 },
    });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await queryRouteTool.handler(input, ctx);

    expect(result.canvas_preview_note).toContain('25 rows staged as df_CAPPED');
    expect(result.canvas_preview_note).toContain('EIA_CANVAS_MAX_ROWS');
    expect(result.canvas_preview_note).toContain('113,460');
    expect(result.canvas_preview_note).toContain('re-query with offset 25');
    // Never claims the canvas holds the full dataset.
    expect(result.canvas_preview_note).not.toContain('full dataset');
  });

  it('names the shortfall without blaming the cap when staging stopped early', async () => {
    const accumulatedRows = Array.from({ length: 5100 }, (_, i) => ({
      period: `2024-${String((i % 12) + 1).padStart(2, '0')}`,
      value: String(i),
    }));
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      registerDataframe: vi.fn().mockResolvedValue({
        tableName: 'df_PARTIAL',
        rowCount: 5100,
        expiresAt: new Date().toISOString(),
        columnSchema: [],
      }),
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);

    mockQuery.mockResolvedValue({
      ...BASE_RESPONSE,
      total: 20000,
      accumulated: { rows: accumulatedRows, capped: false, cap: 25000 },
    });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await queryRouteTool.handler(input, ctx);

    expect(result.canvas_preview_note).toContain('5,100 rows staged as df_PARTIAL');
    expect(result.canvas_preview_note).toContain('Staging stopped before the end');
    expect(result.canvas_preview_note).toContain('1–5,100 of 20,000');
    expect(result.canvas_preview_note).toContain('offset 5,100');
    // The cap did not bind — the note must not claim it did.
    expect(result.canvas_preview_note).not.toContain('EIA_CANVAS_MAX_ROWS');
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
  // #44 — sort reaches dataframe provenance and the enrichment echo, and no
  // input the caller omitted is recorded as an undefined-valued param.
  // ------------------------------------------------------------------

  describe('sort provenance (#44)', () => {
    const SORT = [{ column: 'period', direction: 'asc' as const }];

    const stagingBridge = () => {
      const mockRegister = vi.fn().mockResolvedValue({
        tableName: 'df_SORTED',
        rowCount: 2,
        expiresAt: new Date().toISOString(),
        columnSchema: [],
      });
      vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
        registerDataframe: mockRegister,
      } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
      return mockRegister;
    };

    it('carries sort into the staged dataframe provenance and the enrichment echo', async () => {
      const mockRegister = stagingBridge();
      mockQuery.mockResolvedValue(BASE_RESPONSE);

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        columns: ['price'],
        sort: SORT,
      });
      await queryRouteTool.handler(input, ctx);

      // Provenance is only honest if the ordering it records is the one the
      // upstream request actually ran under.
      expect(mockQuery.mock.calls[0]?.[1].sort).toEqual(SORT);
      expect(mockRegister.mock.calls[0]?.[1].queryParams.sort).toEqual(SORT);
      expect(getEnrichment(ctx).appliedSort).toEqual(SORT);
    });

    it('records no param the caller omitted', async () => {
      const mockRegister = stagingBridge();
      mockQuery.mockResolvedValue(BASE_RESPONSE);

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
      await queryRouteTool.handler(input, ctx);

      // Undefined-valued keys would reach eia_dataframe_describe's rendered
      // params line as `columns=undefined` while structuredContent drops them.
      expect(Object.keys(mockRegister.mock.calls[0]?.[1].queryParams)).toEqual([
        'route',
        'offset',
        'length',
      ]);
      expect(getEnrichment(ctx).appliedSort).toBeUndefined();
    });

    it('renders the sort echo for the clients that read content[] rather than structuredContent', () => {
      const render = queryRouteTool.enrichmentTrailer?.appliedSort?.render;
      expect(
        render?.([
          { column: 'period', direction: 'asc' },
          { column: 'price', direction: 'desc' },
        ]),
      ).toBe('**Applied Sort:** period asc, price desc');
    });
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
