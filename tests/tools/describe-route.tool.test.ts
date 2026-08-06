/**
 * @fileoverview Tests for the eia_describe_route tool.
 * @module tests/tools/describe-route.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
        { id: 'TX', name: 'Texas', alias: '(TX) Texas' },
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

  it('keeps the alias output field even when format() leaves it off the line', async () => {
    mockDescribe.mockResolvedValue(FULL_META);

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await describeRouteTool.handler(input, ctx);

    const txValue = result.facets[0]?.values.find((v) => v.id === 'TX');
    expect(txValue?.alias).toBe('(TX) Texas');

    const caValue = result.facets[0]?.values.find((v) => v.id === 'CA');
    expect(caValue?.alias).toBeUndefined();

    // Suppressing a restating alias is a rendering choice on this one call —
    // the field a structuredContent reader gets is untouched.
    const text = (describeRouteTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('TX=Texas,');
    expect(text).not.toContain('((TX) Texas)');
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
      // The empty window is otherwise indistinguishable from an exhausted one,
      // so the notice has to name the offset, the facet, its count, and an
      // offset that comes back with values.
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('999');
      expect(notice).toContain('stateid (10 values, last valid offset 9)');
      expect(notice).toContain('Reduce values_offset');
    });

    it('merges the notice into the surface both client families read', async () => {
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('stateid', 10)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        values_offset: 999,
      });
      const result = await describeRouteTool.handler(input, ctx);

      // ctx.enrich only reaches structuredContent and the content[] trailer when
      // the definition declares the field — populating the store is not enough.
      const enrichment = describeRouteTool.enrichment;
      expect(enrichment?.notice).toBeDefined();
      const merged = describeRouteTool.output
        .extend(enrichment as NonNullable<typeof enrichment>)
        .parse({ ...result, ...getEnrichment(ctx) });
      expect(merged.notice).toContain('last valid offset 9');
    });

    it('names every facet an offset emptied, not just the requested one', async () => {
      mockDescribe.mockResolvedValue({
        ...FULL_META,
        facets: [wideFacet('stateid', 62), wideFacet('sectorid', 6)],
      });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        values_offset: 50,
      });
      const result = await describeRouteTool.handler(input, ctx);

      // stateid still has a tail at offset 50; sectorid ran out at 6.
      expect(result.facets[0]?.values).toHaveLength(12);
      expect(result.facets[1]?.values).toHaveLength(0);
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('sectorid (6 values, last valid offset 5)');
      expect(notice).not.toContain('stateid');
    });

    it('omits the notice when every facet returned values', async () => {
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('sectorid', 6)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
      await describeRouteTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('does not report a facet with no upstream values as an overshoot', async () => {
      mockDescribe.mockResolvedValue({
        ...FULL_META,
        facets: [{ id: 'emptyfacet', description: 'Empty', values: [] }],
      });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        values_offset: 5,
      });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.facets[0]?.value_count).toBe(0);
      expect(getEnrichment(ctx).notice).toBeUndefined();
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
            values: [{ id: 'TX', name: 'Texas', alias: 'Region: (TX) Texas' }],
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
      expect(text).toContain('TX=Texas (Region: (TX) Texas)');
      expect(text).toContain('sales');
      expect(text).toContain('MWh');
      expect(text).toContain('1 values');
    });

    it('renders the whole window and names the next call past it', () => {
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

      // Every value the output carries is rendered, so the hint resumes where
      // the structured window stops — one next call, not two.
      expect(text).toContain('S0=State 0');
      expect(text).toContain('S49=State 49');
      expect(text).toContain('+12 more');
      expect(text).toContain('values_offset=50');
      expect(text).not.toContain('values_offset=5)');
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

      expect(text).toContain('values_offset=100');
      expect(text).toContain('+1369 more');
    });

    it('renders a facet under the cap whole, with nothing left to page', () => {
      const result = {
        route: 'electricity/retail-sales',
        description: 'Retail electricity sales',
        values_offset: 0,
        facets: [
          {
            id: 'sectorid',
            description: 'Sector',
            values: Array.from({ length: 6 }, (_, i) => ({ id: `SEC${i}`, name: `Sector ${i}` })),
            value_count: 6,
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

      expect(text).toContain('SEC5=Sector 5');
      expect(text).toContain('6 values');
      expect(text).not.toContain('more —');
      expect(text).not.toContain('values_offset=');
    });

    it('renders an emptied facet without a dangling em dash', () => {
      const result = {
        route: 'electricity/retail-sales',
        description: 'Retail electricity sales',
        values_offset: 500,
        facets: [
          {
            id: 'sectorid',
            description: 'Sector',
            values: [],
            value_count: 6,
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

      expect(text).toContain('- **sectorid** (0 of 6 values from offset 500): Sector');

      const facetLine = text.split('\n').find((l) => l.startsWith('- **sectorid**'));
      expect(facetLine).toBeDefined();
      expect(facetLine).not.toMatch(/—\s*$/);
      expect(facetLine).not.toContain('—');
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

    // ----------------------------------------------------------------
    // Alias rendering (#46)
    // ----------------------------------------------------------------

    describe('alias rendering', () => {
      /** Renders one facet holding `values`, and returns just its line. */
      function facetLine(values: Array<{ id: string; name: string; alias?: string }>) {
        const blocks = describeRouteTool.format!({
          route: 'electricity/retail-sales',
          description: 'Retail electricity sales',
          values_offset: 0,
          facets: [
            {
              id: 'stateid',
              description: 'State / Census Region',
              values,
              value_count: values.length,
              values_truncated: false,
            },
          ],
          data_columns: [],
          frequencies: [],
          date_range: { start: '', end: '' },
          default_frequency: '',
          default_date_format: '',
        });
        const text = (blocks[0] as { text: string }).text;
        const line = text.split('\n').find((l) => l.startsWith('- **stateid**'));
        expect(line).toBeDefined();
        return line as string;
      }

      it('drops the `(id) name` alias EIA generates for most facet values', () => {
        expect(
          facetLine([
            { id: 'IN', name: 'Indiana', alias: '(IN) Indiana' },
            { id: 'OTH', name: 'other', alias: '(OTH) other' },
          ]),
        ).toBe('- **stateid** (2 values): State / Census Region — IN=Indiana, OTH=other');
      });

      it('keeps an alias that prefixes a class the pair does not name', () => {
        // Both of these contain the exact `(id) name` string the restating
        // aliases are, so a substring test drops precisely the informative ones.
        expect(
          facetLine([
            { id: 'MAT', name: 'Middle Atlantic', alias: 'Region: (MAT) Middle Atlantic' },
            { id: 'TEX', name: 'Texas', alias: 'PJM: (TEX) Texas' },
          ]),
        ).toBe(
          '- **stateid** (2 values): State / Census Region — MAT=Middle Atlantic (Region: (MAT) Middle Atlantic), TEX=Texas (PJM: (TEX) Texas)',
        );
      });

      it('keeps an alias that qualifies the pair it restates', () => {
        expect(
          facetLine([
            {
              id: 'US',
              name: 'U.S. Total',
              alias: 'Total: (US) United States (not including territory data)',
            },
          ]),
        ).toBe(
          '- **stateid** (1 values): State / Census Region — US=U.S. Total (Total: (US) United States (not including territory data))',
        );
      });

      it('drops an alias equal to the name on its own', () => {
        expect(
          facetLine([
            { id: 'TOT', name: 'All sectors', alias: 'All sectors' },
            { id: 'EU', name: 'Electric Utilities', alias: 'Electric Utilities' },
          ]),
        ).toBe(
          '- **stateid** (2 values): State / Census Region — TOT=All sectors, EU=Electric Utilities',
        );
      });

      it('matches the restatement ignoring case and surrounding whitespace', () => {
        expect(facetLine([{ id: 'IN', name: 'Indiana', alias: '  (in) INDIANA  ' }])).toBe(
          '- **stateid** (1 values): State / Census Region — IN=Indiana',
        );
      });

      it('renders both classes side by side within one facet', () => {
        const line = facetLine([
          { id: 'MAT', name: 'Middle Atlantic', alias: 'Region: (MAT) Middle Atlantic' },
          { id: 'IN', name: 'Indiana', alias: '(IN) Indiana' },
          { id: 'CA', name: 'California' },
        ]);

        expect(line).toContain('MAT=Middle Atlantic (Region: (MAT) Middle Atlantic)');
        expect(line).toContain('IN=Indiana,');
        expect(line).not.toContain('((IN) Indiana)');
        // A value EIA supplies no alias for is unaffected either way.
        expect(line).toMatch(/CA=California$/);
      });
    });
  });
});
