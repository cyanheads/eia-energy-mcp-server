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
  route: 'electricity/retail-sales',
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
      route: 'electricity/retail-sales',
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
          warning: 'parameter out of range: length',
          description: 'The maximum value is 5000.',
        },
      ],
    });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await queryRouteTool.handler(input, ctx);

    expect(result.truncation_warning).toBe(
      'parameter out of range: length: The maximum value is 5000.',
    );
    expect(result.truncation_warning).not.toContain('[object Object]');
  });

  it('joins multiple EIA warnings', async () => {
    // A stage capped short of total is the case where both advisories still
    // apply: the gap is real, so the incomplete-return entry is not suppressed
    // and joins the one beside it.
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      registerDataframe: vi.fn().mockResolvedValue({
        tableName: 'df_CAPPED',
        rowCount: 25000,
        expiresAt: new Date().toISOString(),
        columnSchema: [],
      }),
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
    mockQuery.mockResolvedValue({
      ...SAMPLE_DATA_RESPONSE,
      total: 113460,
      accumulated: {
        rows: Array.from({ length: 25000 }, (_, i) => ({ period: String(i) })),
        capped: true,
        cap: 25000,
      },
      warnings: [
        { warning: 'parameter out of range: length', description: 'The maximum value is 5000.' },
        { warning: 'incomplete return', description: 'Use offset to paginate results.' },
      ],
    });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      stage: true,
    });
    const result = await queryRouteTool.handler(input, ctx);

    expect(result.truncation_warning).toBe(
      'parameter out of range: length: The maximum value is 5000.; incomplete return: Use offset to paginate results.',
    );
  });

  // ------------------------------------------------------------------
  // #41 — EIA's per-page "incomplete return" advisory fires whenever the
  // requested length is under total. It must not ride along on a response that
  // already states where the caller stands.
  // ------------------------------------------------------------------

  describe('incomplete-return advisory suppression (#41)', () => {
    const INCOMPLETE_RETURN = {
      warning: 'incomplete return',
      description:
        'The API can only return 5000 rows in JSON format.  Please consider constraining your request with facet, start, or end, or using offset to paginate results.',
    };
    const OUT_OF_RANGE = {
      warning: 'parameter out of range: length',
      description: 'The maximum value is 5000.',
    };

    const stagingBridge = (rowCount: number) =>
      vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
        registerDataframe: vi.fn().mockResolvedValue({
          tableName: 'df_STAGED',
          rowCount,
          expiresAt: new Date().toISOString(),
          columnSchema: [],
        }),
      } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);

    it('drops the advisory when the staged table covers total', async () => {
      stagingBridge(1830);
      mockQuery.mockResolvedValue({
        ...SAMPLE_DATA_RESPONSE,
        total: 1830,
        accumulated: {
          rows: Array.from({ length: 1830 }, (_, i) => ({ period: String(i) })),
          capped: false,
          cap: 25000,
        },
        warnings: [INCOMPLETE_RETURN],
      });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        length: 3,
        stage: true,
      });
      const result = await queryRouteTool.handler(input, ctx);

      expect(result.truncation_warning).toBeUndefined();
      // The response still says where the caller stands — the advisory is
      // redundant, not the only account of the gap.
      expect(result.canvas_preview_note).toContain('1,830 rows staged as df_STAGED');
      // A stage starting at row 1 needs no range — the count already locates it.
      expect(result.canvas_preview_note).not.toContain('staged rows are');
      expect((queryRouteTool.format!(result)[0] as { text: string }).text).not.toContain(
        '5000 rows in JSON format',
      );
    });

    it('drops the advisory when a notice explains the row-less page', async () => {
      mockQuery.mockResolvedValue({
        route: 'electricity/retail-sales',
        total: 6,
        dateFormat: 'YYYY-MM',
        frequency: 'monthly',
        data: [],
        warnings: [INCOMPLETE_RETURN],
      });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        offset: 99,
        length: 5,
      });
      const result = await queryRouteTool.handler(input, ctx);

      expect(result.truncation_warning).toBeUndefined();
      expect(result.notice).toContain('Reduce offset');
    });

    // #54 — the canvas-absent branch writes a canvas_preview_note that accounts
    // for the same gap, so the advisory must drop there too.
    it('drops the advisory when canvas_preview_note accounts for the gap with no canvas', async () => {
      mockQuery.mockResolvedValue({
        ...SAMPLE_DATA_RESPONSE,
        total: 113460,
        warnings: [INCOMPLETE_RETURN],
      });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        length: 3,
      });
      const result = await queryRouteTool.handler(input, ctx);

      expect(result.truncation_warning).toBeUndefined();
      // The note is the account of the gap the advisory duplicated — its
      // fixed "5000 rows" text also misdescribes a 3-row request.
      expect(result.canvas_preview_note).toContain('113,460');
      expect(result.canvas_preview_note).toContain('CANVAS_PROVIDER_TYPE=duckdb');
      expect((queryRouteTool.format!(result)[0] as { text: string }).text).not.toContain(
        '5000 rows in JSON format',
      );
    });

    it('keeps a non-suppressed advisory on the canvas-absent gap path', async () => {
      mockQuery.mockResolvedValue({
        ...SAMPLE_DATA_RESPONSE,
        total: 113460,
        warnings: [OUT_OF_RANGE, INCOMPLETE_RETURN],
      });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
      const result = await queryRouteTool.handler(input, ctx);

      expect(result.truncation_warning).toBe(
        'parameter out of range: length: The maximum value is 5000.',
      );
    });

    it('keeps advisories the response does not explain when one is suppressed', async () => {
      stagingBridge(1830);
      mockQuery.mockResolvedValue({
        ...SAMPLE_DATA_RESPONSE,
        total: 1830,
        accumulated: {
          rows: Array.from({ length: 1830 }, (_, i) => ({ period: String(i) })),
          capped: false,
          cap: 25000,
        },
        warnings: [OUT_OF_RANGE, INCOMPLETE_RETURN],
      });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        stage: true,
      });
      const result = await queryRouteTool.handler(input, ctx);

      expect(result.truncation_warning).toBe(
        'parameter out of range: length: The maximum value is 5000.',
      );
      expect(result.truncation_warning).not.toContain('incomplete return');
    });

    it('drops the advisory when an offset-bound stage reaches the last row', async () => {
      stagingBridge(30);
      mockQuery.mockResolvedValue({
        ...SAMPLE_DATA_RESPONSE,
        total: 1830,
        accumulated: {
          rows: Array.from({ length: 30 }, (_, i) => ({ period: String(i) })),
          capped: false,
          cap: 25000,
        },
        warnings: [INCOMPLETE_RETURN],
      });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        offset: 1800,
        length: 3,
        stage: true,
      });
      const result = await queryRouteTool.handler(input, ctx);

      // Staging ran from row 1,801 to the last one, so nothing past the
      // caller's offset is left to page to. Both the suppression and the note
      // read the same offset-relative position — a staged count mistaken for an
      // absolute row number would forward the advisory and name offset 30 as
      // the place to resume.
      expect(result.truncation_warning).toBeUndefined();
      expect(result.canvas_preview_note).toContain('30 rows staged as df_STAGED');
      expect(result.canvas_preview_note).not.toContain('offset 30');
      // 30 rows out of 1,830 is the same count a prefix of this query would
      // stage, holding entirely different rows — only the range separates them.
      expect(result.canvas_preview_note).toContain('The staged rows are 1,801–1,830 of 1,830.');
    });

    it('forwards the advisory when staging stopped short of total', async () => {
      stagingBridge(25000);
      mockQuery.mockResolvedValue({
        ...SAMPLE_DATA_RESPONSE,
        total: 113460,
        accumulated: {
          rows: Array.from({ length: 25000 }, (_, i) => ({ period: String(i) })),
          capped: true,
          cap: 25000,
        },
        warnings: [INCOMPLETE_RETURN],
      });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        stage: true,
      });
      const result = await queryRouteTool.handler(input, ctx);

      // 25,000 of 113,460 staged — the rest is genuinely unreached, so EIA's
      // pagination advice still applies.
      expect(result.truncation_warning).toContain('incomplete return');
    });
  });

  it('emits an offset-past-the-end notice when total is positive but no rows came back', async () => {
    mockQuery.mockResolvedValue({
      route: 'electricity/retail-sales',
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
    // The gap has to be real and the rows have to reach the canvas, or the
    // branch under test is never taken: a row-less page is answered by the
    // notice above regardless of whether a bridge exists, so asserting the
    // absence of the advice there holds however the branch is wired.
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      registerDataframe: vi.fn().mockResolvedValue({
        tableName: 'df_STAGED',
        rowCount: 240,
        expiresAt: new Date().toISOString(),
        columnSchema: [],
      }),
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
    mockQuery.mockResolvedValue({
      ...SAMPLE_DATA_RESPONSE,
      accumulated: {
        rows: Array.from({ length: 240 }, (_, i) => ({ period: String(i) })),
        capped: false,
        cap: 25000,
      },
    });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      length: 2,
      stage: true,
    });
    const result = await queryRouteTool.handler(input, ctx);

    const rendered = (queryRouteTool.format!(result)[0] as { text: string }).text;
    expect(rendered).not.toContain('CANVAS_PROVIDER_TYPE');
    expect(rendered).toContain('240 rows staged as df_STAGED');
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
    const input = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      stage: true,
    });
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
