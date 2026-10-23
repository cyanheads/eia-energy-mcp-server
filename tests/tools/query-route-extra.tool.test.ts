/**
 * @fileoverview Additional coverage for eia_query_route — input validation,
 * inverted date range pre-flight, canvas accumulation path, security (API key
 * not leaked), and format edge cases.
 * @module tests/tools/query-route-extra.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryRouteTool } from '@/mcp-server/tools/definitions/query-route.tool.js';
import { ECHO_BUDGET_BYTES, INLINE_BUDGET_BYTES } from '@/mcp-server/tools/inline-budget.js';
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
  route: 'electricity/retail-sales',
  total: 2,
  dateFormat: 'YYYY-MM',
  frequency: 'monthly',
  data: [
    { period: '2024-01', stateid: 'TX', value: '9.13', 'value-units': 'million kWh' },
    { period: '2024-02', stateid: 'TX', value: '8.45', 'value-units': 'million kWh' },
  ],
  warnings: undefined,
};

/** Point the canvas bridge at a registration that answers `outcome`; returns the register mock. */
function bridgeAnswering(outcome: Record<string, unknown>) {
  const register = vi.fn().mockResolvedValue(outcome);
  vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
    registerDataframe: register,
  } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
  return register;
}

/** A canvas that stages the rows as `tableName`; returns the register mock. */
function registeringBridge(
  tableName: string,
  rowCount: number,
  renamedColumns: Array<{ from: string; to: string }> = [],
) {
  return bridgeAnswering({
    status: 'registered',
    tableName,
    rowCount,
    expiresAt: new Date().toISOString(),
    columnSchema: [],
    renamedColumns,
  });
}

describe('queryRouteTool — additional coverage', () => {
  beforeEach(() => {
    vi.mocked(eiaService.getEiaApiService).mockReturnValue({
      query: mockQuery,
    } as unknown as ReturnType<typeof eiaService.getEiaApiService>);
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue(undefined);
    mockQuery.mockReset();
  });

  it.each([undefined, 'monthly'])(
    'discloses year bounds from effective monthly metadata (%s requested)',
    async (frequency) => {
      mockQuery.mockResolvedValue(BASE_RESPONSE);
      const result = await runToolContract(queryRouteTool, {
        route: 'electricity/retail-sales',
        start: '2020',
        end: '2021',
        ...(frequency && { frequency }),
      });
      expect(result.isError).not.toBe(true);
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain('start "2020" means 2020-01');
      expect(notice).toContain('end "2021" means 2021-01');
      expect(notice).toContain('2021-12');
      expect(JSON.stringify(result.content)).toContain('2021-12');
      expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({ start: '2020', end: '2021' });
      expect(result.structuredContent).toMatchObject({ appliedStart: '2020', appliedEnd: '2021' });
    },
  );

  it.each([
    ['annual', 'YYYY', '2021'],
    ['monthly', 'YYYY-MM', '2021-12'],
    ['daily', 'YYYY-MM-DD', '2021'],
    ['monthly', '', '2021'],
  ])('preserves fully specified or unverified %s/%s bounds', async (frequency, dateFormat, end) => {
    mockQuery.mockResolvedValue({ ...BASE_RESPONSE, frequency, dateFormat });
    const result = await runToolContract(queryRouteTool, { route: 'steo', end });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it.each([false, true])(
    'composes coarse bounds with empty/staged responses (stage %s)',
    async (stage) => {
      const register = registeringBridge('df_MONTHLY', 2);
      mockQuery.mockResolvedValue({
        ...BASE_RESPONSE,
        ...(stage ? {} : { total: 0, data: [] }),
        notices: ['Cached facet diagnostic.'],
        warnings: [{ warning: 'advisory', description: 'Keep this upstream message.' }],
      });
      const result = await runToolContract(queryRouteTool, { route: 'steo', end: '2021', stage });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        notice: expect.stringContaining('2021-12'),
        truncation_warning: 'advisory: Keep this upstream message.',
      });
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toContain('Cached facet diagnostic.');
      expect(text).toContain('2021-12');
      if (stage) {
        expect(register.mock.calls[0]?.[1].queryParams.end).toBe('2021');
        expect(result.structuredContent).toMatchObject({ dataset: 'df_MONTHLY' });
      } else expect(text).toContain('No rows matched');
    },
  );

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

    it('accepts length > 5000 for clamping', () => {
      expect(() => queryRouteTool.input.parse({ route: 'steo', length: 5001 })).not.toThrow();
    });

    it('accepts length exactly at max (5000)', () => {
      expect(() => queryRouteTool.input.parse({ route: 'steo', length: 5000 })).not.toThrow();
    });

    it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects non-integer/non-finite length %s',
      (length) => {
        expect(() => queryRouteTool.input.parse({ route: 'steo', length })).toThrow();
      },
    );

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

  it.each([false, true])(
    'clamps length before fetch, echoes, and staged provenance (stage %s)',
    async (stage) => {
      const register = registeringBridge('df_CLAMP', 2);
      mockQuery.mockResolvedValue({ ...BASE_RESPONSE, ...(stage ? {} : { total: 0, data: [] }) });
      const result = await runToolContract(queryRouteTool, { route: 'steo', length: 5001, stage });
      expect(result.isError).not.toBe(true);
      expect(mockQuery.mock.calls[0]?.[1].length).toBe(5000);
      expect(result.structuredContent).toMatchObject({
        appliedLength: 5000,
        notice: expect.stringContaining('length 5001 was clamped to 5000'),
      });
      expect(JSON.stringify(result.content)).toContain('length 5001 was clamped to 5000');
      if (stage)
        expect(register.mock.calls[0]?.[1]).toMatchObject({
          maxRows: 5000,
          queryParams: { length: 5000 },
        });
    },
  );

  // ------------------------------------------------------------------
  // Pre-flight: inverted date range
  // ------------------------------------------------------------------

  /**
   * #88 — the inverted-range check runs after the query, only on a zero-row
   * answer, comparing the period each bound selects at the frequency EIA
   * reports. It replaces #15's pre-flight string comparison; #15's decision —
   * a plainly inverted range is an explicit no_data error, never a bare empty
   * result — stands.
   */
  describe('inverted date range (#88)', () => {
    const empty = (frequency: string, dateFormat = '') => ({
      ...BASE_RESPONSE,
      frequency,
      dateFormat,
      total: 0,
      data: [],
    });
    const row = (frequency: string, period: string, dateFormat = '') => ({
      ...BASE_RESPONSE,
      frequency,
      dateFormat,
      total: 1,
      data: [{ period, value: '1', 'value-units': 'units' }],
    });

    it('throws no_data when start > end (monthly format), after one query', async () => {
      mockQuery.mockResolvedValue(empty('monthly', 'YYYY-MM'));
      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        start: '2024-06',
        end: '2024-01',
      });

      await expect(queryRouteTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'no_data', start: '2024-06', end: '2024-01', frequency: 'monthly' },
      });

      // The query itself is the only upstream call, with the bounds as submitted.
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({ start: '2024-06', end: '2024-01' });
    });

    it('throws no_data when start > end (annual format)', async () => {
      mockQuery.mockResolvedValue(empty('annual', 'YYYY'));
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

    it('never refuses a call EIA answered with rows, even when it reports total 0', async () => {
      mockQuery.mockResolvedValue({ ...row('monthly', '2023-06', 'YYYY-MM'), total: 0 });
      const result = await runToolContract(queryRouteTool, {
        route: 'electricity/retail-sales',
        frequency: 'monthly',
        start: '2023-06',
        end: '2023-01',
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        returned_count: 1,
        data: [{ period: '2023-06' }],
      });
    });

    it('returns the reproduction row with the coarse-end notice', async () => {
      mockQuery.mockResolvedValue(row('monthly', '2023-01', 'YYYY-MM'));
      const result = await runToolContract(queryRouteTool, {
        route: 'electricity/retail-sales',
        frequency: 'monthly',
        start: '2023-01',
        end: '2023',
        filters: { stateid: 'TX', sectorid: 'RES' },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        returned_count: 1,
        appliedStart: '2023-01',
        appliedEnd: '2023',
        notice: expect.stringContaining('Use 2023-12 as end'),
      });
      expect(JSON.stringify(result.content)).toContain('Use 2023-12 as end');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    // Every row-returning pair EIA answered in the #88 measurements.
    it.each([
      ['monthly', '2023-01', '2023', '2023-01'],
      ['monthly', '2023-Q1', '2023-02', '2023-01'],
      ['quarterly', '2023-Q4', '2023-12', '2023-Q4'],
      ['annual', '2023-06', '2023-05', '2023'],
      ['daily', '2024-02-01', '2024-02', '2024-02-01'],
      ['hourly', '2024-02-01T05', '2024-02-01', '2024-02-01T05'],
      ['local-hourly', '2024-02-01T08-00', '2024-02-01T03-06', '2024-02-01T02-06'],
    ])(
      'never refuses a %s range EIA answers with rows (%s / %s)',
      async (frequency, start, end, period) => {
        mockQuery.mockResolvedValue(row(frequency, period));
        const result = await runToolContract(queryRouteTool, {
          route: 'electricity/retail-sales',
          frequency,
          start,
          end,
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ returned_count: 1, data: [{ period }] });
      },
    );

    it.each([
      [
        'monthly',
        '2023-12',
        '2020-01',
        'selects 2023-12',
        'which selects 2020-01',
        'Swap start and end.',
      ],
      [
        'monthly',
        '2023-02',
        '2023',
        'selects 2023-02',
        'which selects 2023-01',
        'pass end "2023-12"',
      ],
      [
        'monthly',
        '2023-10',
        '2023-Q3',
        'selects 2023-10',
        'which selects 2023-07',
        'Swap start and end.',
      ],
      [
        'quarterly',
        '2023-10',
        '2023-Q3',
        'selects 2023-Q4',
        'which selects 2023-Q3',
        'Swap start and end.',
      ],
      [
        'daily',
        '2024-02-02',
        '2024-02',
        'selects 2024-02-02',
        'which selects 2024-02-01',
        'pass end "2024-02-29"',
      ],
      [
        'weekly',
        '2024-02-06',
        '2024-02-05',
        'selects 2024-02-06',
        'which selects 2024-02-05',
        'Swap start and end.',
      ],
      [
        'hourly',
        '2024-02-02T05',
        '2024-02-01',
        'selects 2024-02-02T05 UTC',
        'which selects 2024-02-01T23 UTC',
        'Swap start and end.',
      ],
      [
        'local-hourly',
        '2024-02-01T02-06',
        '2024-02-01T07-00',
        'selects 2024-02-01T08 UTC',
        'which selects 2024-02-01T07 UTC',
        'Swap start and end.',
      ],
    ])(
      'fails a zero-row %s range %s / %s as no_data naming both selected periods',
      async (frequency, start, end, startSelects, endSelects, fix) => {
        mockQuery.mockResolvedValue(empty(frequency));
        const contract = queryRouteTool.errors!.find((entry) => entry.reason === 'no_data')!;
        const result = await runToolContract(queryRouteTool, {
          route: 'electricity/retail-sales',
          frequency,
          start,
          end,
        });
        expect(result.isError).toBe(true);
        const error = (result.structuredContent as { error: { message: string } }).error;
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'no_data', recovery: { hint: contract.recovery } },
        });
        const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
        for (const fragment of [
          `effective ${frequency} frequency`,
          startSelects,
          endSelects,
          fix,
        ]) {
          expect(error.message).toContain(fragment);
          expect(text).toContain(fragment);
        }
        expect(contract.recovery).toContain('2023-12');
        expect(contract.recovery).not.toMatch(/^Swap/);
      },
    );

    it.each([
      ['ordered bounds', 'monthly', '2023-01', '2023-06'],
      ['an unparseable start', 'monthly', 'June 2023', '2023-01'],
      ['an unparseable end', 'monthly', '2023-06', '2023/01'],
      ['an out-of-range month', 'monthly', '2023-13', '2023-01'],
      ['one offset-bearing bound', 'hourly', '2024-02-02T05-06', '2024-02-01T03'],
      ['an unmodeled frequency', 'four-week', '2024-02-06', '2024-02-05'],
      ['a missing reported frequency', '', '2024-06', '2024-01'],
    ])('keeps the empty-result notice for %s', async (_case, frequency, start, end) => {
      mockQuery.mockResolvedValue(empty(frequency));
      const result = await runToolContract(queryRouteTool, {
        route: 'electricity/retail-sales',
        start,
        end,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        total: 0,
        notice: expect.stringContaining('No rows matched'),
      });
    });

    /**
     * The inverted-range check and registration gate on opposite row counts,
     * so which runs first is not observable on its own: registration's own
     * zero-row gate is pinned by "stages nothing and says nothing of it on an
     * offset past the last row". This case fails when that gate admits an
     * empty fetch and the check runs after registration.
     */
    it('fails an inverted stage: true range without registering a table', async () => {
      const register = registeringBridge('df_NEVER', 0);
      mockQuery.mockResolvedValue(empty('monthly', 'YYYY-MM'));
      const result = await runToolContract(queryRouteTool, {
        route: 'electricity/retail-sales',
        start: '2023-10',
        end: '2023-Q3',
        stage: true,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { data: { reason: 'no_data' } } });
      expect(register).not.toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledTimes(1);
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
    mockQuery.mockResolvedValue({ ...BASE_RESPONSE, appliedColumns: ['sales', 'revenue'] });

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

  // #55 — a filter whose value list is empty sends EIA nothing, so it is unset:
  // dropped before the request, the appliedFilters echo, and staged provenance.
  describe('empty collections are unset (#55)', () => {
    it('drops a filter whose value list is empty from the request, echo, and provenance', async () => {
      const mockRegister = registeringBridge('df_UNSET', 2);
      mockQuery.mockResolvedValue(BASE_RESPONSE);

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        filters: { stateid: [] },
        stage: true,
      });
      await queryRouteTool.handler(input, ctx);

      expect(mockQuery.mock.calls[0]?.[1]).not.toHaveProperty('filters');
      expect(getEnrichment(ctx).appliedFilters).toBeUndefined();
      expect(mockRegister.mock.calls[0]?.[1].queryParams).not.toHaveProperty('filters');
    });

    it('keeps the filters that carry values beside one that does not', async () => {
      const mockRegister = registeringBridge('df_UNSET', 2);
      mockQuery.mockResolvedValue(BASE_RESPONSE);

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        filters: { stateid: ['TX'], sectorid: [] },
        stage: true,
      });
      await queryRouteTool.handler(input, ctx);

      expect(mockQuery.mock.calls[0]?.[1].filters).toEqual({ stateid: ['TX'] });
      expect(getEnrichment(ctx).appliedFilters).toEqual({ stateid: ['TX'] });
      expect(mockRegister.mock.calls[0]?.[1].queryParams.filters).toEqual({ stateid: ['TX'] });
    });

    it('passes filter values through untrimmed — a single space is a real facet value', async () => {
      mockQuery.mockResolvedValue(BASE_RESPONSE);

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/facility-fuel',
        filters: { primeMover: ' ', state: 'TX', fuel2002: [' '] },
      });
      await queryRouteTool.handler(input, ctx);

      const sent = { primeMover: ' ', state: 'TX', fuel2002: [' '] };
      expect(mockQuery.mock.calls[0]?.[1].filters).toEqual(sent);
      expect(getEnrichment(ctx).appliedFilters).toEqual(sent);
    });

    it('records no empty columns or sort in staged provenance', async () => {
      const mockRegister = registeringBridge('df_UNSET', 2);
      mockQuery.mockResolvedValue(BASE_RESPONSE);

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        columns: [],
        sort: [],
        stage: true,
      });
      await queryRouteTool.handler(input, ctx);

      expect(Object.keys(mockRegister.mock.calls[0]?.[1].queryParams)).toEqual([
        'route',
        'offset',
        'length',
      ]);
      expect(getEnrichment(ctx).appliedColumns).toBeUndefined();
      expect(getEnrichment(ctx).appliedSort).toBeUndefined();
    });

    it('treats null filters, columns, and sort as omitted on the wire', async () => {
      mockQuery.mockResolvedValue(BASE_RESPONSE);

      // Clients send null for an unset optional field; the schema itself refuses it.
      const result = await runToolContract(queryRouteTool, {
        route: 'electricity/retail-sales',
        filters: null,
        columns: null,
        sort: null,
      } as unknown as { route: string });

      expect(result.isError).not.toBe(true);
      const opts = mockQuery.mock.calls[0]?.[1];
      expect(opts).not.toHaveProperty('filters');
      expect(opts).not.toHaveProperty('sort');
      expect(opts.columns ?? []).toEqual([]);
      for (const key of ['appliedFilters', 'appliedColumns', 'appliedSort']) {
        expect(result.structuredContent).not.toHaveProperty(key);
      }
    });
  });

  // #65 — the service drops `period` and facet IDs from `columns`; the echo and
  // staged provenance name the projection it sent, not the caller's list.
  describe('column projection as sent (#65)', () => {
    it('echoes and records the projection the service sent', async () => {
      const mockRegister = registeringBridge('df_PROJECTED', 2);
      mockQuery.mockResolvedValue({ ...BASE_RESPONSE, appliedColumns: ['price'] });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        columns: ['stateid', 'period', 'price'],
        stage: true,
      });
      await queryRouteTool.handler(input, ctx);

      expect(mockQuery.mock.calls[0]?.[1].columns).toEqual(['stateid', 'period', 'price']);
      expect(getEnrichment(ctx).appliedColumns).toEqual(['price']);
      expect(mockRegister.mock.calls[0]?.[1].queryParams.columns).toEqual(['price']);
    });

    it('echoes and records no projection when the list named no data column', async () => {
      const mockRegister = registeringBridge('df_ALLCOLUMNS', 2);
      mockQuery.mockResolvedValue(BASE_RESPONSE);

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        columns: ['period'],
        stage: true,
      });
      await queryRouteTool.handler(input, ctx);

      expect(getEnrichment(ctx).appliedColumns).toBeUndefined();
      expect(mockRegister.mock.calls[0]?.[1].queryParams).not.toHaveProperty('columns');
    });
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

  it('rejects a canvas_id input by name — the parameter no longer exists', () => {
    expect(Object.keys(queryRouteTool.input.shape)).not.toContain('canvas_id');

    const result = queryRouteTool.input.safeParse({
      route: 'electricity/retail-sales',
      canvas_id: 'df_EXISTING_CANVAS',
    });

    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.code).toBe('unrecognized_keys');
    expect((issue as { keys?: readonly string[] } | undefined)?.keys).toEqual(['canvas_id']);
  });

  it('requests accumulation only when the caller stages and a canvas bridge is present', async () => {
    mockQuery.mockResolvedValue(BASE_RESPONSE);

    const staged = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      stage: true,
    });
    const ctx = createMockContext({ errors: queryRouteTool.errors });
    await queryRouteTool.handler(staged, ctx);

    // stage: true with no canvas to register into still costs nothing extra.
    expect(mockQuery).toHaveBeenCalledWith(
      'electricity/retail-sales',
      expect.objectContaining({ accumulate: false }),
      ctx,
    );

    bridgeAnswering({ status: 'skipped' });

    // A canvas alone is not the trigger — the caller has to ask.
    const unstaged = queryRouteTool.input.parse({ route: 'electricity/retail-sales' });
    await queryRouteTool.handler(unstaged, createMockContext({ errors: queryRouteTool.errors }));

    expect(mockQuery).toHaveBeenLastCalledWith(
      'electricity/retail-sales',
      expect.objectContaining({ accumulate: false }),
      expect.anything(),
    );

    await queryRouteTool.handler(staged, createMockContext({ errors: queryRouteTool.errors }));

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
    const mockRegister = registeringBridge('df_STAGED', 40);

    mockQuery.mockResolvedValue({
      ...BASE_RESPONSE,
      total: 40,
      accumulated: { rows: accumulatedRows, capped: false, cap: 25000 },
    });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      stage: true,
    });
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
    registeringBridge('df_CAPPED', 25);

    mockQuery.mockResolvedValue({
      ...BASE_RESPONSE,
      total: 113460,
      accumulated: { rows: accumulatedRows, capped: true, cap: 25000 },
    });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      stage: true,
    });
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
    registeringBridge('df_PARTIAL', 5100);

    mockQuery.mockResolvedValue({
      ...BASE_RESPONSE,
      total: 20000,
      accumulated: { rows: accumulatedRows, capped: false, cap: 25000 },
    });

    const ctx = createMockContext({ errors: queryRouteTool.errors });
    const input = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      stage: true,
    });
    const result = await queryRouteTool.handler(input, ctx);

    expect(result.canvas_preview_note).toContain('5,100 rows staged as df_PARTIAL');
    expect(result.canvas_preview_note).toContain('Staging stopped before the end');
    expect(result.canvas_preview_note).toContain('1–5,100 of 20,000');
    expect(result.canvas_preview_note).toContain('offset 5,100');
    // The cap did not bind — the note must not claim it did.
    expect(result.canvas_preview_note).not.toContain('EIA_CANVAS_MAX_ROWS');
  });

  it('says time ran out, on both surfaces, when the call deadline ended staging', async () => {
    const accumulatedRows = Array.from({ length: 5100 }, (_, i) => ({
      period: `2024-${String((i % 12) + 1).padStart(2, '0')}`,
      value: String(i),
    }));
    registeringBridge('df_LATE', 5100);
    mockQuery.mockResolvedValue({
      ...BASE_RESPONSE,
      total: 20000,
      accumulated: { rows: accumulatedRows, capped: false, cap: 25000, timedOut: true },
    });

    const result = await runToolContract(queryRouteTool, {
      route: 'electricity/retail-sales',
      stage: true,
    });
    const note = (result.structuredContent as { canvas_preview_note?: string }).canvas_preview_note;
    const text = (result.content ?? []).map((b) => (b as { text?: string }).text ?? '').join('');

    expect(result.isError).toBeFalsy();
    expect(note).toContain('5,100 rows staged as df_LATE');
    expect(note).toContain("Staging stopped when the call's time limit ran out");
    expect(note).toContain('1–5,100 of 20,000');
    expect(note).toContain('Re-query with offset 5,100 and stage: true');
    // Neither a failed page nor the row cap.
    expect(note).not.toContain('Staging stopped before the end');
    expect(note).not.toContain('EIA_CANVAS_MAX_ROWS');
    expect(text).toContain(note as string);
  });

  // ------------------------------------------------------------------
  // #62 — a staged dataset names the tool that lists its columns before the
  // one that runs SQL, on both surfaces, whenever dataset is set.
  // ------------------------------------------------------------------

  describe('dataframe pointer (#62)', () => {
    const VALUE_RENAME = [{ from: 'value-units', to: 'value_units' }];
    const POINTER_TAIL = 'then eia_dataframe_query to run SQL over it.';

    const textOf = (result: { content?: unknown[] }) =>
      (result.content ?? []).map((b) => (b as { text?: string }).text ?? '').join('');
    const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

    it('points at describe then query even when the whole match fits the preview', async () => {
      registeringBridge('df_XYZ', 2, VALUE_RENAME);
      mockQuery.mockResolvedValue({ ...BASE_RESPONSE, total: 2 });

      const result = await runToolContract(queryRouteTool, {
        route: 'electricity/retail-sales',
        stage: true,
      });
      const sc = result.structuredContent as Record<string, unknown>;

      expect(sc.dataset).toBe('df_XYZ');
      expect(sc.canvas_preview_note).toBe(
        `2 rows staged as df_XYZ — call eia_dataframe_describe for its column names (hyphens become underscores: value-units → value_units), ${POINTER_TAIL}`,
      );
      const text = textOf(result);
      expect(text).toContain(sc.canvas_preview_note as string);
      // One pointer per surface: the note replaces the old fixed format() line.
      expect(occurrences(text, 'eia_dataframe_describe')).toBe(1);
      expect(occurrences(text, 'eia_dataframe_query')).toBe(1);
      expect(text).toContain('**Dataset:** `df_XYZ`');
    });

    it('adds no rename clause when staging renamed nothing', async () => {
      registeringBridge('df_XYZ', 2);
      mockQuery.mockResolvedValue({
        ...BASE_RESPONSE,
        route: 'steo',
        total: 2,
        data: [
          { period: '2024-01', seriesId: 'PAPR_WORLD', value: '1.2', unit: 'million b/d' },
          { period: '2024-02', seriesId: 'PAPR_WORLD', value: '1.3', unit: 'million b/d' },
        ],
      });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const result = await queryRouteTool.handler(
        queryRouteTool.input.parse({ route: 'steo', stage: true }),
        ctx,
      );

      expect(result.canvas_preview_note).toBe(
        `2 rows staged as df_XYZ — call eia_dataframe_describe for its column names, ${POINTER_TAIL}`,
      );
    });

    it('quotes a hyphen rename over another kind when staging made both', async () => {
      registeringBridge('df_XYZ', 2, [
        { from: '2024total', to: '_2024total' },
        { from: 'respondent-name', to: 'respondent_name' },
      ]);
      mockQuery.mockResolvedValue({ ...BASE_RESPONSE, total: 2 });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const result = await queryRouteTool.handler(
        queryRouteTool.input.parse({ route: 'electricity/retail-sales', stage: true }),
        ctx,
      );

      expect(result.canvas_preview_note).toContain(
        '(hyphens become underscores: respondent-name → respondent_name)',
      );
    });

    it('names a non-hyphen rename as it is when no hyphen was renamed', async () => {
      registeringBridge('df_XYZ', 2, [{ from: '2024total', to: '_2024total' }]);
      mockQuery.mockResolvedValue({ ...BASE_RESPONSE, total: 2 });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const result = await queryRouteTool.handler(
        queryRouteTool.input.parse({ route: 'electricity/retail-sales', stage: true }),
        ctx,
      );

      expect(result.canvas_preview_note).toContain(
        '(staged names are SQL-safe identifiers: 2024total → _2024total)',
      );
      expect(result.canvas_preview_note).not.toContain('hyphens');
    });

    it('leads with the pointer and keeps the cap and resume sentences after it', async () => {
      registeringBridge('df_CAPPED', 25000, VALUE_RENAME);
      mockQuery.mockResolvedValue({
        ...BASE_RESPONSE,
        total: 113460,
        accumulated: {
          rows: Array.from({ length: 25000 }, (_, i) => ({ period: String(i) })),
          capped: true,
          cap: 25000,
        },
      });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const result = await queryRouteTool.handler(
        queryRouteTool.input.parse({ route: 'electricity/retail-sales', stage: true }),
        ctx,
      );

      const note = result.canvas_preview_note ?? '';
      expect(note.startsWith('25,000 rows staged as df_CAPPED — call eia_dataframe_describe')).toBe(
        true,
      );
      const cap =
        'Accumulation stopped at the EIA_CANVAS_MAX_ROWS cap (25,000), so the staged rows are 1–25,000 of 113,460. Narrow with filters, start, or end — or re-query with offset 25,000 — to reach the rest.';
      expect(note).toContain(`${POINTER_TAIL} ${cap}`);
    });

    it('names eia_dataframe_query on the unstaged note where a canvas is configured', async () => {
      vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
        registerDataframe: vi.fn(),
      } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
      mockQuery.mockResolvedValue({ ...BASE_RESPONSE, total: 113460 });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const result = await queryRouteTool.handler(
        queryRouteTool.input.parse({ route: 'electricity/retail-sales', length: 2 }),
        ctx,
      );

      expect(result.canvas_preview_note).toContain(
        'Re-run with stage: true to stage the matching rows for SQL with eia_dataframe_query, or page through with offset',
      );
    });

    it('leaves the canvas-off note free of dataframe tool names', async () => {
      mockQuery.mockResolvedValue({ ...BASE_RESPONSE, total: 113460 });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const result = await queryRouteTool.handler(
        queryRouteTool.input.parse({ route: 'electricity/retail-sales', length: 2 }),
        ctx,
      );

      expect(result.canvas_preview_note).toContain('CANVAS_PROVIDER_TYPE=duckdb');
      expect(result.canvas_preview_note).not.toContain('eia_dataframe');
    });
  });

  // ------------------------------------------------------------------
  // Following next_offset with stage still on registers a second table and
  // re-spends the accumulation, so a registered stage with rows left to page
  // says to page with stage off — after the inline sentences, and only then.
  // ------------------------------------------------------------------

  describe('paging the inline rows after a registered stage', () => {
    const PAGE_WITHOUT_STAGING =
      'Page the inline rows with stage left off — another stage: true call stages a new table.';
    const pointer = (rowCount: number) =>
      `${rowCount} rows staged as df_XYZ — call eia_dataframe_describe for its column names (hyphens become underscores: value-units → value_units), then eia_dataframe_query to run SQL over it.`;

    const rows = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        period: `2024-${String(from + i + 1).padStart(2, '0')}`,
        stateid: 'TX',
        value: String(9 + from + i),
        'value-units': 'million kWh',
      }));

    const registered = (rowCount: number) =>
      registeringBridge('df_XYZ', rowCount, [{ from: 'value-units', to: 'value_units' }]);

    /** Both surfaces exactly as the caller receives them. */
    async function stageCall(input: Record<string, unknown>) {
      const result = await runToolContract(queryRouteTool, {
        route: 'electricity/retail-sales',
        stage: true,
        ...input,
      });
      expect(result.isError).not.toBe(true);
      const sc = result.structuredContent as Record<string, unknown>;
      const text = (result.content ?? []).map((b) => (b as { text?: string }).text ?? '').join('');
      return { sc, text };
    }

    it('closes the note with it when a table registered and rows remain', async () => {
      registered(5);
      mockQuery.mockResolvedValue({
        ...BASE_RESPONSE,
        total: 5,
        data: rows(0, 2),
        accumulated: { rows: rows(0, 5), capped: false, cap: 25_000 },
      });

      const { sc, text } = await stageCall({ length: 2 });

      expect(sc.dataset).toBe('df_XYZ');
      expect(sc.next_offset).toBe(2);
      expect(sc.canvas_preview_note).toBe(
        `${pointer(5)} Showing 2 of 5 rows inline. Continue the inline page at next_offset 2. ${PAGE_WITHOUT_STAGING}`,
      );
      expect(text).toContain(`> ${sc.canvas_preview_note as string}`);
    });

    it('follows the cap and resume sentences too, when the stage stopped short of total', async () => {
      registered(4);
      mockQuery.mockResolvedValue({
        ...BASE_RESPONSE,
        total: 9,
        data: rows(0, 2),
        accumulated: { rows: rows(0, 4), capped: true, cap: 4 },
      });

      const { sc, text } = await stageCall({ length: 2 });

      expect(sc.canvas_preview_note).toBe(
        `${pointer(4)} Accumulation stopped at the EIA_CANVAS_MAX_ROWS cap (4), so the staged rows are 1–4 of 9. Narrow with filters, start, or end — or re-query with offset 4 — to reach the rest. Showing 2 of 9 rows inline. Continue the inline page at next_offset 2. ${PAGE_WITHOUT_STAGING}`,
      );
      expect(text).toContain(sc.canvas_preview_note as string);
    });

    it('leaves it out on the last page, where there is nothing to page to', async () => {
      registered(2);
      mockQuery.mockResolvedValue({ ...BASE_RESPONSE, total: 5, data: rows(3, 2) });

      const { sc, text } = await stageCall({ offset: 3, length: 2 });

      expect(sc).not.toHaveProperty('next_offset');
      expect(sc.canvas_preview_note).toBe(
        `${pointer(2)} The staged rows are 4–5 of 5. Showing 2 of 5 rows inline.`,
      );
      expect(text).toContain(sc.canvas_preview_note as string);
      expect(text).not.toContain(PAGE_WITHOUT_STAGING);
    });

    it('leaves it out when the whole match fits the inline page', async () => {
      registered(2);
      mockQuery.mockResolvedValue({ ...BASE_RESPONSE, total: 2, data: rows(0, 2) });

      const { sc, text } = await stageCall({});

      expect(sc).not.toHaveProperty('next_offset');
      expect(sc.canvas_preview_note).toBe(pointer(2));
      expect(text).not.toContain(PAGE_WITHOUT_STAGING);
    });

    it('leaves it out when staging failed, though rows remain', async () => {
      bridgeAnswering({ status: 'failed', message: 'appender failed' });
      mockQuery.mockResolvedValue({
        ...BASE_RESPONSE,
        total: 5,
        data: rows(0, 2),
        accumulated: { rows: rows(0, 5), capped: false, cap: 25_000 },
      });

      const { sc, text } = await stageCall({ length: 2 });

      expect(sc).not.toHaveProperty('dataset');
      expect(sc.next_offset).toBe(2);
      expect(sc.canvas_preview_note).toBe(
        'Staging failed, so no dataframe was created — re-run with stage: true to try again, or page through with offset. Showing 2 of 5 rows inline. Continue the inline page at next_offset 2.',
      );
      expect(text).toContain(sc.canvas_preview_note as string);
      expect(text).not.toContain(PAGE_WITHOUT_STAGING);
    });

    it('stages nothing and says nothing of it on an offset past the last row', async () => {
      const register = registered(0);
      mockQuery.mockResolvedValue({ ...BASE_RESPONSE, total: 5, data: [] });

      const { sc, text } = await stageCall({ offset: 9 });

      expect(register).not.toHaveBeenCalled();
      expect(sc).not.toHaveProperty('dataset');
      expect(sc).not.toHaveProperty('canvas_preview_note');
      expect(sc.notice).toMatch(/^Offset 9 is past the last row/);
      expect(text).not.toContain(PAGE_WITHOUT_STAGING);
    });
  });

  // ------------------------------------------------------------------
  // #50 — staging is the caller's call. A preview must not pay for offset
  // pages and a canvas insert nobody asked for, and the response has to name
  // the lever, or the capability is invisible.
  // ------------------------------------------------------------------

  describe('opt-in staging (#50)', () => {
    const bridgeWithRegister = () => registeringBridge('df_STAGED', 25000);

    it('stages nothing and asks for no accumulation when stage is omitted', async () => {
      const mockRegister = bridgeWithRegister();
      mockQuery.mockResolvedValue({ ...BASE_RESPONSE, total: 113460 });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales', length: 2 });
      const result = await queryRouteTool.handler(input, ctx);

      expect(mockQuery.mock.calls[0]?.[1].accumulate).toBe(false);
      // Not even the previewed page — registering that alone would stage a
      // 2-row prefix of a 113,460-row match under a handle that reads whole.
      expect(mockRegister).not.toHaveBeenCalled();
      expect(result.dataset).toBeUndefined();
    });

    it('names stage: true when a canvas is configured but staging was not asked for', async () => {
      bridgeWithRegister();
      mockQuery.mockResolvedValue({ ...BASE_RESPONSE, total: 113460 });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({ route: 'electricity/retail-sales', length: 2 });
      const result = await queryRouteTool.handler(input, ctx);

      expect(result.canvas_preview_note).toContain('Showing 2 of 113,460 rows');
      expect(result.canvas_preview_note).toContain('stage: true');
      // The canvas is already on — sending the caller after a server env var
      // would name a change that fixes nothing.
      expect(result.canvas_preview_note).not.toContain('CANVAS_PROVIDER_TYPE');
      expect((queryRouteTool.format!(result)[0] as { text: string }).text).toContain('stage: true');
    });

    it('keeps the deployment-level advice where there is no canvas to stage into', async () => {
      mockQuery.mockResolvedValue({ ...BASE_RESPONSE, total: 113460 });

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        length: 2,
        stage: true,
      });
      const result = await queryRouteTool.handler(input, ctx);

      // stage: true is not the lever here — it is already set and there is
      // still nothing to register into.
      expect(result.canvas_preview_note).toContain('CANVAS_PROVIDER_TYPE=duckdb');
      expect(result.canvas_preview_note).not.toContain('stage: true');
      expect(result.dataset).toBeUndefined();
    });

    it('stages the whole match up to the cap, never just the previewed page', async () => {
      const mockRegister = bridgeWithRegister();
      mockQuery.mockResolvedValue({
        ...BASE_RESPONSE,
        total: 113460,
        accumulated: {
          rows: Array.from({ length: 25000 }, (_, i) => ({ period: String(i) })),
          capped: true,
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

      expect(mockQuery.mock.calls[0]?.[1].accumulate).toBe(true);
      const registered = mockRegister.mock.calls[0]?.[1];
      expect(registered.rows).toHaveLength(25000);
      expect(registered.truncated).toBe(true);
      // The cap that bound is what the dataframe records as its ceiling — the
      // preview length would understate it by four orders of magnitude.
      expect(registered.maxRows).toBe(25000);
      expect(result.data).toHaveLength(2);
    });
  });

  // ------------------------------------------------------------------
  // #53 — the route the response names is the one the service resolved to,
  // so it is reusable verbatim and provenance reads as one source.
  // ------------------------------------------------------------------

  describe('normalized route echo (#53)', () => {
    it('echoes the service-resolved route rather than the caller spelling', async () => {
      mockQuery.mockResolvedValue(BASE_RESPONSE);

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({ route: '/electricity/retail-sales/' });
      const result = await queryRouteTool.handler(input, ctx);

      expect(result.route).toBe('electricity/retail-sales');
      expect(getEnrichment(ctx).effectiveRoute).toBe('electricity/retail-sales');
    });

    it('records the normalized route in staged dataframe provenance', async () => {
      const mockRegister = registeringBridge('df_STAGED', 2);
      mockQuery.mockResolvedValue(BASE_RESPONSE);

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity//retail-sales',
        stage: true,
      });
      await queryRouteTool.handler(input, ctx);

      // Two spellings of one route must not read as two sources in
      // eia_dataframe_describe's provenance.
      expect(mockRegister.mock.calls[0]?.[1].queryParams.route).toBe('electricity/retail-sales');
    });
  });

  // ------------------------------------------------------------------
  // #44 — sort reaches dataframe provenance and the enrichment echo, and no
  // input the caller omitted is recorded as an undefined-valued param.
  // ------------------------------------------------------------------

  describe('sort provenance (#44)', () => {
    const SORT = [{ column: 'period', direction: 'asc' as const }];

    const stagingBridge = () => registeringBridge('df_SORTED', 2);

    it('carries sort into the staged dataframe provenance and the enrichment echo', async () => {
      const mockRegister = stagingBridge();
      mockQuery.mockResolvedValue(BASE_RESPONSE);

      const ctx = createMockContext({ errors: queryRouteTool.errors });
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        columns: ['price'],
        sort: SORT,
        stage: true,
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
      const input = queryRouteTool.input.parse({
        route: 'electricity/retail-sales',
        stage: true,
      });
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

    // ----------------------------------------------------------------
    // #49 — a {col}-units companion is decided from the whole preview. The
    // header may only assert a unit every row agrees on; anything else keeps
    // the units column in the body, and an all-null one is dropped.
    // ----------------------------------------------------------------

    describe('{col}-units rendering (#49)', () => {
      const base = {
        route: 'electricity/retail-sales',
        total: 2,
        returned_count: 2,
        frequency: 'monthly',
        date_format: 'YYYY-MM',
      };

      it('annotates the header when every row carries the same unit', () => {
        const text = (
          queryRouteTool.format!({
            ...base,
            data: [
              { period: '2024-01', sales: '9.13', 'sales-units': 'million kilowatthours' },
              { period: '2024-02', sales: '8.45', 'sales-units': 'million kilowatthours' },
            ],
          })[0] as { text: string }
        ).text;

        // The width win #10 was after: one annotation, no repeated body column.
        expect(text).toContain('| period | sales (million kilowatthours) |');
        expect(text).not.toContain('sales-units');
        expect(text).toContain('| 2024-01 | 9.13 |');
      });

      it('keeps the units column in the body when the unit varies row to row', () => {
        const text = (
          queryRouteTool.format!({
            ...base,
            route: 'electricity/electric-power-operational-data',
            data: [
              {
                period: '2023',
                fuelTypeDescription: 'all fuels',
                'consumption-for-eg': '0',
                'consumption-for-eg-units': 'thousand physical units',
              },
              {
                period: '2023',
                fuelTypeDescription: 'coal, excluding waste coal',
                'consumption-for-eg': '50705.996',
                'consumption-for-eg-units': 'thousand short tons',
              },
            ],
          })[0] as { text: string }
        ).text;

        // The header must not stamp row 0's unit on a column the rows disagree on.
        expect(text).not.toContain('consumption-for-eg (thousand physical units)');
        expect(text).toContain(
          '| period | fuelTypeDescription | consumption-for-eg | consumption-for-eg-units |',
        );
        expect(text).toContain('| 2023 | all fuels | 0 | thousand physical units |');
        expect(text).toContain(
          '| 2023 | coal, excluding waste coal | 50705.996 | thousand short tons |',
        );
      });

      it('keeps the units column when row 0 is null and a later row carries a unit', () => {
        const text = (
          queryRouteTool.format!({
            ...base,
            route: 'electricity/facility-fuel',
            data: [
              {
                period: '2023',
                fuelTypeDescription: 'Total',
                'total-consumption': '7945766',
                'total-consumption-units': null,
              },
              {
                period: '2023',
                fuelTypeDescription: 'Natural Gas',
                'total-consumption': '7945766',
                'total-consumption-units': 'Mcf',
              },
            ],
          })[0] as { text: string }
        ).text;

        // Row 0's null must not silently drop the unit the rows below carry.
        expect(text).toContain(
          '| period | fuelTypeDescription | total-consumption | total-consumption-units |',
        );
        expect(text).toContain('| 2023 | Total | 7945766 |  |');
        expect(text).toContain('| 2023 | Natural Gas | 7945766 | Mcf |');
      });

      it('drops the units column entirely when no row carries a unit', () => {
        const text = (
          queryRouteTool.format!({
            ...base,
            data: [
              { period: '2024-01', sales: '9.13', 'sales-units': null },
              { period: '2024-02', sales: '8.45', 'sales-units': null },
            ],
          })[0] as { text: string }
        ).text;

        // An all-null companion carries nothing — rendering it would add a
        // blank column rather than information.
        expect(text).toContain('| period | sales |');
        expect(text).not.toContain('sales-units');
        expect(text).toContain('| 2024-01 | 9.13 |');
      });
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

// ---------------------------------------------------------------------------
// #58 — each response surface holds to a fixed byte budget, cut between whole
// rows, with next_offset naming where the inline page continues.
// ---------------------------------------------------------------------------

describe('queryRouteTool — inline byte budget (#58)', () => {
  const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

  /** A row whose first cell is a unique id, so its position shows on both surfaces. */
  const row = (i: number, note = '') => ({
    id: `r${String(i).padStart(4, '0')}`,
    period: `2024-${String((i % 12) + 1).padStart(2, '0')}`,
    stateid: 'TX',
    note,
  });
  /** About the width of an electricity/operating-generator-capacity row (~1,100 bytes). */
  const wide = (i: number) => row(i, `plant ${i} `.padEnd(1_040, 'w'));
  /** About the width of an electricity/retail-sales row (~200 bytes). */
  const narrow = (i: number) => row(i, 'cents per kilowatt-hour'.padEnd(120, '.'));

  const respond = (data: Array<Record<string, unknown>>, total: number, extra = {}) =>
    mockQuery.mockResolvedValue({
      route: 'electricity/operating-generator-capacity',
      total,
      dateFormat: 'YYYY-MM',
      frequency: 'monthly',
      data,
      warnings: undefined,
      ...extra,
    });

  /** Both surfaces exactly as the caller receives them. */
  async function call(input: Record<string, unknown>) {
    const result = await runToolContract(queryRouteTool, {
      route: 'electricity/operating-generator-capacity',
      ...input,
    });
    expect(result.isError).not.toBe(true);
    const sc = result.structuredContent as Record<string, unknown> & {
      data: Array<Record<string, unknown>>;
    };
    const text = (result.content ?? []).map((b) => (b as { text?: string }).text ?? '').join('');
    return { sc, text, scBytes: bytes(JSON.stringify(sc)), textBytes: bytes(text) };
  }

  /** Row ids in the order the content[] table lists them. */
  const textIds = (text: string) => [...text.matchAll(/^\| (r\d{4}) \|/gm)].map((m) => m[1]);

  beforeEach(() => {
    vi.mocked(eiaService.getEiaApiService).mockReturnValue({
      query: mockQuery,
    } as unknown as ReturnType<typeof eiaService.getEiaApiService>);
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue(undefined);
    mockQuery.mockReset();
  });

  it('pins the budget at 64,000 bytes per surface and an echo at 4,000', () => {
    expect(INLINE_BUDGET_BYTES).toBe(64_000);
    expect(ECHO_BUDGET_BYTES).toBe(4_000);
  });

  it('keeps a default 100-row page whole on a narrow route', async () => {
    const fetched = Array.from({ length: 100 }, (_, i) => narrow(i));
    respond(fetched, 5000);

    const { sc, text, scBytes, textBytes } = await call({});

    expect(sc.data).toEqual(fetched);
    expect(sc.returned_count).toBe(100);
    expect(textIds(text)).toEqual(fetched.map((r) => r.id));
    expect(scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
  });

  it('ends a wide default page early, with the same rows and next call on both surfaces', async () => {
    const fetched = Array.from({ length: 100 }, (_, i) => wide(i));
    respond(fetched, 26_000);

    const { sc, text, scBytes, textBytes } = await call({});
    const shown = sc.data.length;

    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(100);
    expect(sc.data).toEqual(fetched.slice(0, shown));
    expect(textIds(text)).toEqual(fetched.slice(0, shown).map((r) => r.id));
    expect(sc.returned_count).toBe(shown);
    expect(sc.next_offset).toBe(shown);
    expect(sc.returnedCount).toBe(shown);
    expect(scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    // The page is as long as the budget allows: one more row overflows a surface.
    const next = fetched[shown] as ReturnType<typeof wide>;
    const nextJson = bytes(JSON.stringify(next)) + 1;
    const nextLine = bytes(`\n| ${next.id} | ${next.period} | ${next.stateid} | ${next.note} |`);
    expect(
      scBytes + nextJson > INLINE_BUDGET_BYTES || textBytes + nextLine > INLINE_BUDGET_BYTES,
    ).toBe(true);

    const note = sc.canvas_preview_note as string;
    expect(note).toContain(
      `The 64,000-byte response budget ended this page at ${shown} of the 100 rows fetched; continue the inline page at next_offset ${shown}.`,
    );
    expect(text).toContain(note);
    expect(text).toContain(`**Next offset:** ${shown}`);
  });

  it('holds both surfaces to the budget at the maximum length with wide multibyte strings', async () => {
    const fetched = Array.from({ length: 5000 }, (_, i) =>
      row(i, `é|<${'ü'.repeat(400)}>\n${'x'.repeat(300)}`),
    );
    respond(fetched, 5000);

    const { sc, text, scBytes, textBytes } = await call({ length: 5000 });

    expect(scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(sc.data.length).toBeGreaterThan(0);
    expect(sc.returned_count).toBe(sc.data.length);
    expect(sc.next_offset).toBe(sc.data.length);
    expect(textIds(text)).toEqual(sc.data.map((r) => r.id));
  });

  /**
   * Exact boundaries: the padding on the last row is tuned so the binding
   * surface lands on exactly 64,000 bytes with every row inline, then one byte
   * past it. Measured through the framework's own composition, so the
   * handler's trailer estimate is held to what the caller actually receives.
   */
  async function tuneLastRow(
    rows: (pad: number) => Array<Record<string, unknown>>,
    total: number,
    surface: 'scBytes' | 'textBytes',
    input: Record<string, unknown> = {},
  ) {
    respond(rows(0), total);
    const base = await call(input);
    expect(base.sc.data).toHaveLength(rows(0).length);
    const pad = INLINE_BUDGET_BYTES - base[surface];
    expect(pad).toBeGreaterThan(0);
    respond(rows(pad), total);
    const exact = await call(input);
    respond(rows(pad + 1), total);
    const over = await call(input);
    return { exact, over, count: rows(0).length };
  }

  it('fills structuredContent to exactly 64,000 bytes and drops a row one byte past it', async () => {
    const rows = (pad: number) => [
      ...Array.from({ length: 50 }, (_, i) => wide(i)),
      row(50, `${'p'.repeat(pad)}`),
    ];
    const { exact, over, count } = await tuneLastRow(rows, 51, 'scBytes');

    expect(exact.scBytes).toBe(INLINE_BUDGET_BYTES);
    expect(exact.textBytes).toBeLessThan(INLINE_BUDGET_BYTES);
    expect(exact.sc.data).toHaveLength(count);
    expect(exact.sc).not.toHaveProperty('next_offset');

    expect(over.sc.data).toHaveLength(count - 1);
    expect(over.sc.next_offset).toBe(count - 1);
    expect(over.scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
  });

  it('fills content[] to exactly 64,000 bytes when escaped text binds, filters in the trailer', async () => {
    // Every `<` costs one byte in JSON and four as `&lt;` in the table, so the
    // text surface binds; the filter list ends in a bullet, which the trailer
    // separates from the next field with a blank line.
    const filters = { stateid: ['TX', 'CA'], sectorid: 'RES' };
    const rows = (pad: number) => [
      ...Array.from({ length: 36 }, (_, i) => row(i, '<'.repeat(380))),
      row(36, `${'<'.repeat(100)}${'p'.repeat(pad)}`),
    ];
    const { exact, over, count } = await tuneLastRow(rows, 37, 'textBytes', { filters });

    expect(exact.text).toContain('- **sectorid:** RES\n\n**appliedOffset:** 0');
    expect(exact.textBytes).toBe(INLINE_BUDGET_BYTES);
    expect(exact.scBytes).toBeLessThan(INLINE_BUDGET_BYTES);
    expect(exact.sc.data).toHaveLength(count);

    expect(over.sc.data).toHaveLength(count - 1);
    expect(over.textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(textIds(over.text)).toEqual(over.sc.data.map((r) => r.id));
  });

  it('withholds a row larger than the budget and names the offset that skips it', async () => {
    respond([row(0, 'x'.repeat(70_000)), wide(1)], 5000);

    const { sc, text, scBytes, textBytes } = await call({ offset: 10, length: 2 });

    expect(sc.data).toEqual([]);
    expect(sc.returned_count).toBe(0);
    // next_offset stays on the withheld row; the note says how to step past it.
    expect(sc.next_offset).toBe(10);
    const note = sc.canvas_preview_note as string;
    expect(note).toContain(
      'The row at offset 10 alone exceeds the 64,000-byte response budget, so no rows are shown inline — narrow it with columns, or skip it with offset 11.',
    );
    expect(text).toContain(note);
    expect(text).toContain('_No rows returned._');
    expect(sc).not.toHaveProperty('notice');
    expect(scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
  });

  it('pages a mixed-width match by next_offset with no gap or overlap', async () => {
    // Widths vary row to row; row 137 alone overflows the budget.
    const dataset = Array.from({ length: 420 }, (_, i) =>
      i === 137 ? row(i, 'x'.repeat(80_000)) : row(i, 'v'.repeat((i * 97) % 2_400)),
    );
    mockQuery.mockImplementation(
      async (_route: string, opts: { offset: number; length: number }) => ({
        route: 'electricity/operating-generator-capacity',
        total: dataset.length,
        dateFormat: 'YYYY-MM',
        frequency: 'monthly',
        data: dataset.slice(opts.offset, opts.offset + opts.length),
        warnings: undefined,
      }),
    );

    const seen: Array<Record<string, unknown>> = [];
    const skipped: number[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const { sc, scBytes, textBytes } = await call({ offset, length: 100 });
      pages++;
      expect(scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
      expect(textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
      seen.push(...sc.data);
      if (sc.next_offset === undefined) break;
      expect(sc.next_offset).toBe(offset + (sc.returned_count as number));
      if (sc.returned_count === 0) {
        // The withheld-row note's own instruction: skip with offset + 1.
        skipped.push(offset);
        offset += 1;
      } else {
        offset = sc.next_offset as number;
      }
      expect(pages).toBeLessThan(100);
    }

    expect(skipped).toEqual([137]);
    expect(seen).toEqual(dataset.filter((_, i) => i !== 137));
    expect(pages).toBeGreaterThan(5);
  });

  it('omits next_offset on the last page, an empty match, and an offset past the end', async () => {
    respond([narrow(0), narrow(1)], 52);
    expect((await call({ offset: 50 })).sc).not.toHaveProperty('next_offset');

    respond([], 0);
    const empty = await call({});
    expect(empty.sc).not.toHaveProperty('next_offset');
    expect(empty.sc.notice).toMatch(/^No rows matched the filters/);

    respond([], 52);
    const past = await call({ offset: 60 });
    expect(past.sc).not.toHaveProperty('next_offset');
    expect(past.sc.notice).toMatch(/^Offset 60 is past the last row/);
  });

  it('stages every fetched row when the budget trims the inline page, pointer → range → inline', async () => {
    const register = registeringBridge('df_WIDE', 500);
    const fetched = Array.from({ length: 100 }, (_, i) => wide(i));
    const accumulated = Array.from({ length: 500 }, (_, i) => wide(i));
    respond(fetched, 26_000, { accumulated: { rows: accumulated, capped: true, cap: 500 } });

    const { sc, text, scBytes, textBytes } = await call({ stage: true });
    const shown = sc.data.length;

    expect(register.mock.calls[0]?.[1].rows).toEqual(accumulated);
    expect(shown).toBeLessThan(100);
    expect(sc.next_offset).toBe(shown);
    expect(scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);

    const note = sc.canvas_preview_note as string;
    const pointer = note.indexOf('500 rows staged as df_WIDE');
    const range = note.indexOf('Accumulation stopped at the EIA_CANVAS_MAX_ROWS cap (500)');
    const inline = note.indexOf(`Showing ${shown} of 26,000 rows inline.`);
    const budget = note.indexOf(`The 64,000-byte response budget ended this page at ${shown}`);
    const pageWithoutStaging = note.indexOf('Page the inline rows with stage left off');
    expect(pointer).toBe(0);
    expect(range).toBeGreaterThan(pointer);
    expect(inline).toBeGreaterThan(range);
    expect(budget).toBeGreaterThan(inline);
    expect(pageWithoutStaging).toBeGreaterThan(budget);
    expect(text).toContain(note);
  });

  it('bounds a huge filter echo with a marker and still sends every value', async () => {
    const values = Array.from({ length: 20_000 }, (_, i) => `PLANT${String(i).padStart(6, '0')}`);
    respond(
      Array.from({ length: 100 }, (_, i) => wide(i)),
      26_000,
    );

    const { sc, text, scBytes, textBytes } = await call({
      filters: { plantid: values, stateid: 'TX' },
    });

    expect(mockQuery.mock.calls[0]?.[1].filters.plantid).toHaveLength(20_000);
    expect(scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(sc.data.length).toBeGreaterThan(0);

    const echo = sc.appliedFilters as Record<string, string | string[]>;
    expect(bytes(JSON.stringify(echo))).toBeLessThanOrEqual(ECHO_BUDGET_BYTES);
    const kept = echo.plantid as string[];
    expect(kept).toEqual(values.slice(0, kept.length));
    expect(echo).not.toHaveProperty('stateid');
    // A facet cut whole is still named in the marker, with its count.
    expect(echo['…']).toBe(
      `${(20_001 - kept.length).toLocaleString()} of 20,001 filter values not echoed (plantid: ${(20_000 - kept.length).toLocaleString()}, stateid: 1) — the query applied every one.`,
    );
    expect(text).toContain(`- **…:** ${echo['…']}`);
  });

  it('echoes a filter set under the echo budget unchanged', async () => {
    respond([narrow(0)], 1);
    const filters = { stateid: ['TX', 'CA'], sectorid: 'RES' };

    const { sc } = await call({ filters });

    expect(sc.appliedFilters).toEqual(filters);
  });
});
