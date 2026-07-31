/**
 * @fileoverview Tests for the eia_describe_route tool.
 * @module tests/tools/describe-route.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetServerConfig } from '@/config/server-config.js';
import { describeRouteTool } from '@/mcp-server/tools/definitions/describe-route.tool.js';
import * as eiaService from '@/services/eia/eia-service.js';

vi.mock('@/services/eia/eia-service.js', () => ({
  getEiaApiService: vi.fn(),
  initEiaApiService: vi.fn(),
  _resetEiaApiService: vi.fn(),
}));

const mockDescribe = vi.fn();

const FULL_META = {
  route: 'electricity/retail-sales',
  description: 'Retail electricity sales by state and sector',
  facets: [
    {
      id: 'stateid',
      description: 'State',
      values: [
        { id: 'TX', name: 'Texas', alias: 'TX' },
        { id: 'CA', name: 'California' },
      ],
    },
  ],
  dataColumns: [
    { id: 'sales', alias: 'Electricity sales', units: 'million kilowatthours' },
    { id: 'revenue', alias: 'Revenue', units: 'million dollars' },
  ],
  frequencies: [
    { id: 'monthly', description: 'Monthly', query: 'monthly', format: 'YYYY-MM' },
    { id: 'annual', description: 'Annual', query: 'annual', format: 'YYYY' },
  ],
  dateRange: { start: '2001-01', end: '2024-11' },
  defaultFrequency: 'monthly',
  defaultDateFormat: 'YYYY-MM',
};

/** A facet with `count` values, used to exercise the output cap. */
function wideFacet(id: string, count: number) {
  return {
    id,
    description: 'State',
    values: Array.from({ length: count }, (_, i) => ({ id: `S${i}`, name: `State ${i}` })),
  };
}

describe('describeRouteTool', () => {
  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    _resetServerConfig();
    vi.mocked(eiaService.getEiaApiService).mockReturnValue({
      describe: mockDescribe,
    } as unknown as ReturnType<typeof eiaService.getEiaApiService>);
    mockDescribe.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetServerConfig();
  });

  it('returns full metadata for a leaf route', async () => {
    mockDescribe.mockResolvedValue(FULL_META);

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await describeRouteTool.handler(input, ctx);

    expect(result.route).toBe('electricity/retail-sales');
    expect(result.facets).toHaveLength(1);
    expect(result.facets[0]?.id).toBe('stateid');
    expect(result.facets[0]?.values).toHaveLength(2);
    expect(result.data_columns).toHaveLength(2);
    expect(result.frequencies).toHaveLength(2);
    expect(result.date_range.start).toBe('2001-01');
    expect(result.default_frequency).toBe('monthly');
  });

  it('includes optional alias on facet values when present', async () => {
    mockDescribe.mockResolvedValue(FULL_META);

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await describeRouteTool.handler(input, ctx);

    const txValue = result.facets[0]?.values.find((v) => v.id === 'TX');
    expect(txValue?.alias).toBe('TX');

    const caValue = result.facets[0]?.values.find((v) => v.id === 'CA');
    expect(caValue?.alias).toBeUndefined();
  });

  it('propagates route_not_found', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockDescribe.mockRejectedValue(notFound('Not found', { reason: 'route_not_found' }));

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'bad/route' });

    await expect(describeRouteTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('propagates route_not_queryable for categories', async () => {
    const { invalidParams } = await import('@cyanheads/mcp-ts-core/errors');
    mockDescribe.mockRejectedValue(invalidParams('Not a leaf', { reason: 'route_not_queryable' }));

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'electricity' });

    await expect(describeRouteTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
  });

  // ------------------------------------------------------------------
  // Facet value cap and offset paging (#29)
  // ------------------------------------------------------------------

  describe('facet value cap', () => {
    it('caps values at EIA_FACET_VALUE_CAP and reports the full count', async () => {
      vi.stubEnv('EIA_FACET_VALUE_CAP', '50');
      _resetServerConfig();
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('stateid', 62)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.facets[0]?.values).toHaveLength(50);
      expect(result.facets[0]?.value_count).toBe(62);
      expect(result.facets[0]?.values_truncated).toBe(true);
      expect(result.values_offset).toBe(0);
      // The uncapped set is never mutated — the cap is a response-shaping step.
      expect(result.facets[0]?.values[0]?.id).toBe('S0');
      expect(result.facets[0]?.values[49]?.id).toBe('S49');
    });

    it('leaves a facet under the cap untruncated', async () => {
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('sectorid', 6)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.facets[0]?.values).toHaveLength(6);
      expect(result.facets[0]?.value_count).toBe(6);
      expect(result.facets[0]?.values_truncated).toBe(false);
    });

    it('honours EIA_FACET_VALUE_CAP', async () => {
      vi.stubEnv('EIA_FACET_VALUE_CAP', '3');
      _resetServerConfig();
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('stateid', 10)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.facets[0]?.values).toHaveLength(3);
      expect(result.facets[0]?.values_truncated).toBe(true);
    });

    it('pages past the cap with values_offset', async () => {
      vi.stubEnv('EIA_FACET_VALUE_CAP', '50');
      _resetServerConfig();
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('stateid', 62)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        facet: 'stateid',
        values_offset: 50,
      });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.values_offset).toBe(50);
      expect(result.facets[0]?.values).toHaveLength(12);
      expect(result.facets[0]?.values[0]?.id).toBe('S50');
      expect(result.facets[0]?.value_count).toBe(62);
      // The window now reaches the end — nothing left to page.
      expect(result.facets[0]?.values_truncated).toBe(false);
    });

    it('returns an empty window when values_offset is past the last value', async () => {
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('stateid', 10)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        facet: 'stateid',
        values_offset: 999,
      });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.facets[0]?.values).toHaveLength(0);
      expect(result.facets[0]?.value_count).toBe(10);
    });

    it('restricts the response to the requested facet', async () => {
      mockDescribe.mockResolvedValue({
        ...FULL_META,
        facets: [wideFacet('stateid', 62), wideFacet('sectorid', 6)],
      });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        facet: 'sectorid',
      });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.facets).toHaveLength(1);
      expect(result.facets[0]?.id).toBe('sectorid');
      // The rest of the metadata still comes back.
      expect(result.data_columns).toHaveLength(2);
      expect(result.frequencies).toHaveLength(2);
    });

    it('fails with facet_not_found for an unknown facet ID', async () => {
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('stateid', 62)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        facet: 'nosuchfacet',
      });

      await expect(describeRouteTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'facet_not_found',
          availableFacets: ['stateid'],
          recovery: { hint: expect.stringContaining('without facet') },
        },
      });
    });

    it('keeps the STEO-scale facet payload bounded', async () => {
      vi.stubEnv('EIA_FACET_VALUE_CAP', '50');
      _resetServerConfig();
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('seriesId', 1469)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({ route: 'steo' });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.facets[0]?.values).toHaveLength(50);
      expect(result.facets[0]?.value_count).toBe(1469);
      expect(result.facets[0]?.values_truncated).toBe(true);
    });
  });

  describe('format()', () => {
    it('renders all required fields including query and alias', () => {
      const result = {
        route: 'electricity/retail-sales',
        description: 'Retail electricity sales',
        values_offset: 0,
        facets: [
          {
            id: 'stateid',
            description: 'State',
            values: [{ id: 'TX', name: 'Texas', alias: 'TX' }],
            value_count: 1,
            values_truncated: false,
          },
        ],
        data_columns: [{ id: 'sales', alias: 'Sales', units: 'MWh' }],
        frequencies: [
          { id: 'monthly', description: 'Monthly', query: 'monthly', format: 'YYYY-MM' },
        ],
        date_range: { start: '2001-01', end: '2024-11' },
        default_frequency: 'monthly',
        default_date_format: 'YYYY-MM',
      };

      const blocks = describeRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('electricity/retail-sales');
      expect(text).toContain('query: monthly');
      expect(text).toContain('TX=Texas (TX)');
      expect(text).toContain('sales');
      expect(text).toContain('MWh');
      expect(text).toContain('1 values');
    });

    it('names a next call at its own preview offset, not the structured cap', () => {
      const result = {
        route: 'electricity/retail-sales',
        description: 'Retail electricity sales',
        values_offset: 0,
        facets: [
          {
            id: 'stateid',
            description: 'State',
            values: Array.from({ length: 50 }, (_, i) => ({ id: `S${i}`, name: `State ${i}` })),
            value_count: 62,
            values_truncated: true,
          },
        ],
        data_columns: [],
        frequencies: [],
        date_range: { start: '', end: '' },
        default_frequency: '',
        default_date_format: '',
      };

      const blocks = describeRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;

      // content[] previews 5, so 57 remain from ITS offset — not the 12 that
      // remain past structuredContent's 50-value window.
      expect(text).toContain('+57 more');
      expect(text).toContain('values_offset=5');
      expect(text).not.toContain('values_offset=50');
      expect(text).toContain('facet="stateid"');
      expect(text).toContain('50 of 62 values from offset 0');
    });

    it('carries the requested offset into the next-call hint', () => {
      const result = {
        route: 'steo',
        description: 'STEO',
        values_offset: 50,
        facets: [
          {
            id: 'seriesId',
            description: 'Series',
            values: Array.from({ length: 50 }, (_, i) => ({ id: `X${i}`, name: `Series ${i}` })),
            value_count: 1469,
            values_truncated: true,
          },
        ],
        data_columns: [],
        frequencies: [],
        date_range: { start: '', end: '' },
        default_frequency: '',
        default_date_format: '',
      };

      const blocks = describeRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('values_offset=55');
      expect(text).toContain('+1414 more');
    });

    it('reports the last page as a window, not as the whole value set', () => {
      const result = {
        route: 'steo',
        description: 'STEO',
        values_offset: 1450,
        facets: [
          {
            id: 'seriesId',
            description: 'Series',
            values: Array.from({ length: 19 }, (_, i) => ({ id: `X${i}`, name: `Series ${i}` })),
            value_count: 1469,
            // The window reaches the end, so nothing is truncated — but it
            // still starts at 1450 and holds 19 of 1469.
            values_truncated: false,
          },
        ],
        data_columns: [],
        frequencies: [],
        date_range: { start: '', end: '' },
        default_frequency: '',
        default_date_format: '',
      };

      const blocks = describeRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('19 of 1469 values from offset 1450');
      expect(text).not.toContain('(1469 values)');
    });
  });
});
