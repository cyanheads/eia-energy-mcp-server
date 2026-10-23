/**
 * @fileoverview Additional coverage for eia_search_routes — input validation,
 * filter_hint rendering, and weak-match flag in format.
 * @module tests/tools/search-routes-extra.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchRoutesTool } from '@/mcp-server/tools/definitions/search-routes.tool.js';
import * as eiaService from '@/services/eia/eia-service.js';
import type { IndexStatus } from '@/services/eia/route-cache.js';

vi.mock('@/services/eia/eia-service.js', () => ({
  getEiaApiService: vi.fn(),
  initEiaApiService: vi.fn(),
  _resetEiaApiService: vi.fn(),
}));

/** A fully warmed corpus of the given size — what search returns normally. */
function settled(size: number): IndexStatus {
  return { complete: true, incompleteRoutes: [], pendingPasses: [], size };
}

const mockSearch = vi.fn();

/** `count` distinct leaf results, shaped as the service returns them. */
function ranked(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    entry: {
      route: `electricity/r${i}`,
      name: `Route ${i}`,
      description: 'desc',
      isLeaf: true,
      category: 'electricity',
    },
    score: 0.1,
  }));
}

describe('searchRoutesTool — additional coverage', () => {
  beforeEach(() => {
    vi.mocked(eiaService.getEiaApiService).mockReturnValue({
      search: mockSearch,
    } as unknown as ReturnType<typeof eiaService.getEiaApiService>);
    mockSearch.mockReset();
  });

  // ------------------------------------------------------------------
  // Input validation
  // ------------------------------------------------------------------

  describe('input validation', () => {
    it('rejects empty query string (min 1)', () => {
      expect(() => searchRoutesTool.input.parse({ query: '' })).toThrow();
    });

    it('rejects a query of whitespace alone (#55)', () => {
      const message = 'query must contain at least one non-whitespace character';
      expect(() => searchRoutesTool.input.parse({ query: '   ' })).toThrow(message);
      expect(() => searchRoutesTool.input.parse({ query: '\t\n' })).toThrow(message);
    });

    it('trims surrounding whitespace and keeps inner whitespace (#55)', () => {
      expect(searchRoutesTool.input.parse({ query: '  coal  ' }).query).toBe('coal');
      expect(searchRoutesTool.input.parse({ query: 'retail   sales' }).query).toBe(
        'retail   sales',
      );
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects limit %s', (limit) => {
      expect(() => searchRoutesTool.input.parse({ query: 'energy', limit })).toThrow();
    });

    it.each([1, 30, 31, 100, 101, 500])('accepts limit %i', (limit) => {
      expect(searchRoutesTool.input.parse({ query: 'energy', limit }).limit).toBe(limit);
    });
  });

  it.each([0, 1])('discloses a clamped limit on %i matches', async (count) => {
    mockSearch.mockResolvedValue({
      results: count
        ? [{ entry: { route: 'steo', name: 'STEO', description: '', isLeaf: true }, score: 0 }]
        : [],
      hasMore: false,
      status: settled(1),
    });
    const result = await runToolContract(searchRoutesTool, { query: 'energy', limit: 500 });
    expect(result.isError).not.toBe(true);
    expect(mockSearch.mock.calls[0]?.[1]).toBe(30);
    expect(result.structuredContent).toMatchObject({
      cap: 30,
      truncated: false,
      notice: expect.stringContaining('limit 500 was clamped to 30'),
    });
    expect(JSON.stringify(result.content)).toContain('limit 500 was clamped to 30');
  });

  // ------------------------------------------------------------------
  // filter_hint forwarding
  // ------------------------------------------------------------------

  it('includes filter_hint in result when entry has one', async () => {
    mockSearch.mockResolvedValue({
      results: [
        {
          entry: {
            route: 'steo',
            name: 'Crude Oil Production',
            description: 'STEO series: Crude Oil Production (COPRPUS)',
            isLeaf: true,
            category: 'steo',
            filter_hint: { seriesId: 'COPRPUS' },
          },
          score: 0.05,
        },
      ],
      status: settled(1500),
    });

    const ctx = createMockContext({ errors: searchRoutesTool.errors });
    const input = searchRoutesTool.input.parse({ query: 'crude oil production' });
    const result = await searchRoutesTool.handler(input, ctx);

    expect(result.results[0]?.filter_hint).toEqual({ seriesId: 'COPRPUS' });
  });

  it('carries a facet-value hit back with its facet filter', async () => {
    mockSearch.mockResolvedValue({
      results: [
        {
          entry: {
            route: 'electricity/electric-power-operational-data',
            name: 'solar photovoltaic',
            description:
              'Energy Source value of Electric Power Operations (electricity/electric-power-operational-data) — filter with fueltypeid="SPV".',
            isLeaf: true,
            category: 'electricity',
            filter_hint: { fueltypeid: 'SPV' },
          },
          score: 0.76,
        },
      ],
      status: settled(2103),
    });

    const ctx = createMockContext({ errors: searchRoutesTool.errors });
    const input = searchRoutesTool.input.parse({ query: 'solar photovoltaic generation' });
    const result = await searchRoutesTool.handler(input, ctx);

    expect(result.results[0]?.route).toBe('electricity/electric-power-operational-data');
    expect(result.results[0]?.filter_hint).toEqual({ fueltypeid: 'SPV' });

    const text = (searchRoutesTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('"fueltypeid": "SPV"');
    expect(text).toContain('eia_query_route');
  });

  it('omits filter_hint when entry does not have one', async () => {
    mockSearch.mockResolvedValue({
      results: [
        {
          entry: {
            route: 'electricity/retail-sales',
            name: 'Retail Sales',
            description: 'Retail sales by state',
            isLeaf: true,
            category: 'electricity',
          },
          score: 0.1,
        },
      ],
      status: settled(150),
    });

    const ctx = createMockContext({ errors: searchRoutesTool.errors });
    const input = searchRoutesTool.input.parse({ query: 'retail sales' });
    const result = await searchRoutesTool.handler(input, ctx);

    expect('filter_hint' in (result.results[0] ?? {})).toBe(false);
  });

  // ------------------------------------------------------------------
  // format() — filter_hint and weak-match rendering
  // ------------------------------------------------------------------

  describe('format()', () => {
    it('renders filter_hint as eia_query_route call template', () => {
      const result = {
        results: [
          {
            route: 'steo',
            name: 'Crude Oil Production',
            description: 'STEO crude oil production forecast',
            score: 0.05,
            isLeaf: true,
            filter_hint: { seriesId: 'COPRPUS' },
          },
        ],
      };
      const blocks = searchRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('COPRPUS');
      expect(text).toContain('eia_query_route');
    });

    it('renders weak-match warning above the weak-match threshold', () => {
      const result = {
        results: [
          {
            route: 'coal/shipments',
            name: 'Coal Shipments',
            description: 'Coal shipment data',
            score: 0.95,
            isLeaf: true,
          },
        ],
      };
      const blocks = searchRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('weak match');
    });

    it('does not render weak-match warning at or below the weak-match threshold', () => {
      const result = {
        results: [
          {
            route: 'electricity/retail-sales',
            name: 'Retail Sales',
            description: 'Retail electricity sales',
            score: 0.1,
            isLeaf: true,
          },
        ],
      };
      const blocks = searchRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).not.toContain('weak match');
    });

    it('renders [cat] tag for non-leaf results', () => {
      const result = {
        results: [
          {
            route: 'electricity',
            name: 'Electricity',
            description: 'Electricity category',
            score: 0.2,
            isLeaf: false,
          },
        ],
      };
      const blocks = searchRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('[cat]');
    });
  });

  // ------------------------------------------------------------------
  // #79 — legacy APIv1 series IDs resolved through /v2/seriesid
  // ------------------------------------------------------------------

  describe('legacy APIv1 series IDs (#79)', () => {
    /** A series-ID hit, shaped as the service returns it. */
    function resolved(
      seriesId: string,
      entry: {
        route: string;
        filter_hint?: Record<string, string>;
        frequency: string;
        columns?: string[];
      },
    ) {
      const full = {
        name: seriesId,
        description: 'EIA dataset description',
        isLeaf: true,
        category: undefined,
        ...entry,
      };
      return {
        results: [{ entry: full, score: 0 }],
        hasMore: false,
        seriesId: { outcome: 'resolved', seriesId, entry: full },
        status: settled(0),
      };
    }

    /** The text of every content block, joined. */
    function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
      return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    }

    it.each([
      {
        id: 'PET.RWTC.W',
        entry: {
          route: 'petroleum/pri/spt',
          filter_hint: { series: 'RWTC' },
          frequency: 'weekly',
          columns: ['value'],
        },
        call: 'eia_query_route(route="petroleum/pri/spt", filters={"series": "RWTC"}, frequency="weekly", columns=["value"])',
      },
      {
        id: 'NG.RNGWHHD.D',
        entry: {
          route: 'natural-gas/pri/fut',
          filter_hint: { series: 'RNGWHHD' },
          frequency: 'daily',
          columns: ['value'],
        },
        call: 'eia_query_route(route="natural-gas/pri/fut", filters={"series": "RNGWHHD"}, frequency="daily", columns=["value"])',
      },
      {
        id: 'ELEC.PRICE.TX-RES.M',
        entry: {
          route: 'electricity/retail-sales',
          filter_hint: { sectorid: 'RES', stateid: 'TX' },
          frequency: 'monthly',
          columns: ['price'],
        },
        call: 'eia_query_route(route="electricity/retail-sales", filters={"sectorid": "RES", "stateid": "TX"}, frequency="monthly", columns=["price"])',
      },
    ])('answers $id with one result on both surfaces', async ({ id, entry, call }) => {
      mockSearch.mockResolvedValue(resolved(id, entry));

      const result = await runToolContract(searchRoutesTool, { query: id });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        results: [{ ...entry, name: id, score: 0, isLeaf: true }],
        shown: 1,
        truncated: false,
        notice: `Resolved APIv1 series ID ${id} to route ${entry.route} through EIA's series lookup; pass filter_hint, frequency, and columns to eia_query_route.`,
      });
      const results = (result.structuredContent as { results: unknown[] }).results;
      expect(results).toHaveLength(1);
      const text = contentText(result);
      expect(text).toContain(`Query with: \`${call}\``);
      expect(text).toContain(`Resolved APIv1 series ID ${id} to route ${entry.route}`);
    });

    it('says on both surfaces when EIA reports no rows for the mapping', async () => {
      const id = 'AEO.2023.REF2023.CNSM_NA_RESD_NA_ELC_NA_NA_QBTU.A';
      const hit = resolved(id, {
        route: 'aeo/2023',
        filter_hint: { scenario: 'ref2023', seriesId: 'cnsm_NA_resd_NA_elc_NA_NA_qbtu' },
        frequency: 'annual',
        columns: ['value'],
      });
      mockSearch.mockResolvedValue({ ...hit, seriesId: { ...hit.seriesId, empty: true } });

      const result = await runToolContract(searchRoutesTool, { query: id });

      const notice = `Resolved APIv1 series ID ${id} to route aeo/2023 through EIA's series lookup, but EIA reports no rows for that mapping, so eia_query_route with it returns none; search for the series by name, or use eia_describe_route with values_query to find its current ID.`;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ shown: 1, notice });
      expect(contentText(result)).toContain(notice);
      // The mapping itself is still shown, so the caller can see what EIA answered.
      expect(contentText(result)).toContain('filters={"scenario": "ref2023"');
    });

    it('renders frequency and columns on a result without a filter_hint', () => {
      const text = (
        searchRoutesTool.format!({
          results: [
            {
              route: 'total-energy',
              name: 'TOTAL.X.M',
              description: '',
              score: 0,
              isLeaf: true,
              frequency: 'monthly',
              columns: ['value'],
            },
          ],
        })[0] as { text: string }
      ).text;
      expect(text).toContain(
        'Query with: `eia_query_route(route="total-energy", frequency="monthly", columns=["value"])`',
      );
    });

    it('falls back to the text search with a not-recognized notice on a 404', async () => {
      mockSearch.mockResolvedValue({
        results: ranked(2),
        hasMore: false,
        seriesId: { outcome: 'unrecognized', seriesId: 'U.S.A' },
        status: settled(5459),
      });

      const result = await runToolContract(searchRoutesTool, { query: 'u.s.a' });

      expect(result.structuredContent).toMatchObject({
        shown: 2,
        notice:
          'U.S.A has the shape of an APIv1 series ID, but EIA does not recognize it; these are text-search results for "u.s.a".',
      });
      expect(contentText(result)).toContain('but EIA does not recognize it');
      expect(contentText(result)).not.toContain('frequency=');
    });

    it.each([
      {
        reason: 'upstream_timeout',
        retryable: true,
        notice:
          'PET.RWTC.W has the shape of an APIv1 series ID, but looking it up failed (upstream_timeout); these are text-search results — retry to resolve the ID.',
      },
      {
        reason: undefined,
        retryable: true,
        notice:
          'PET.RWTC.W has the shape of an APIv1 series ID, but looking it up failed; these are text-search results — retry to resolve the ID.',
      },
      {
        reason: undefined,
        retryable: false,
        notice:
          'PET.RWTC.W has the shape of an APIv1 series ID, but looking it up failed; these are text-search results.',
      },
    ])(
      'falls back with a lookup-failed notice (reason $reason, retryable $retryable)',
      async ({ reason, retryable, notice }) => {
        mockSearch.mockResolvedValue({
          results: ranked(1),
          hasMore: false,
          seriesId: {
            outcome: 'failed',
            seriesId: 'PET.RWTC.W',
            retryable,
            ...(reason && { reason }),
          },
          status: settled(5459),
        });

        const result = await runToolContract(searchRoutesTool, { query: 'PET.RWTC.W' });

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ shown: 1, notice });
      },
    );

    it('combines the ID notice with the clamped-limit and no-match notices', async () => {
      mockSearch.mockResolvedValue({
        results: [],
        hasMore: false,
        seriesId: { outcome: 'unrecognized', seriesId: 'PET.ZZZZZZ.W' },
        status: settled(5459),
      });

      const result = await runToolContract(searchRoutesTool, { query: 'PET.ZZZZZZ.W', limit: 50 });

      expect((result.structuredContent as { notice: string }).notice).toBe(
        'Requested limit 50 was clamped to 30. PET.ZZZZZZ.W has the shape of an APIv1 series ID, but EIA does not recognize it; these are text-search results for "PET.ZZZZZZ.W". No routes matched "PET.ZZZZZZ.W". Try different search terms or use eia_browse_routes to explore the taxonomy.',
      );
    });

    it('combines a hit notice with the clamped-limit notice', async () => {
      mockSearch.mockResolvedValue(
        resolved('PET.RWTC.W', {
          route: 'petroleum/pri/spt',
          filter_hint: { series: 'RWTC' },
          frequency: 'weekly',
          columns: ['value'],
        }),
      );

      const result = await runToolContract(searchRoutesTool, { query: 'PET.RWTC.W', limit: 40 });

      expect((result.structuredContent as { notice: string }).notice).toMatch(
        /^Requested limit 40 was clamped to 30\. Resolved APIv1 series ID PET\.RWTC\.W to route petroleum\/pri\/spt/,
      );
    });

    it('adds no ID notice, frequency, or columns to an ordinary search', async () => {
      mockSearch.mockResolvedValue({ results: ranked(1), hasMore: false, status: settled(5459) });

      const result = await runToolContract(searchRoutesTool, { query: 'Henry Hub' });

      expect(result.structuredContent).not.toHaveProperty('notice');
      const [first] = (result.structuredContent as { results: object[] }).results;
      expect(first).not.toHaveProperty('frequency');
      expect(first).not.toHaveProperty('columns');
    });
  });

  // ------------------------------------------------------------------
  // Only the first 256 characters of a query are searched
  // ------------------------------------------------------------------

  describe('searched query length', () => {
    const NOTICE = 'Only the first 256 characters of the query were searched.';

    it('searches and echoes the first 256 characters and says so on both surfaces', async () => {
      mockSearch.mockResolvedValue({ results: ranked(1), hasMore: false, status: settled(5459) });
      const query = `${'coal generation '.repeat(16)}wind`;
      const head = query.slice(0, 256);

      const result = await runToolContract(searchRoutesTool, { query });

      expect(result.isError).not.toBe(true);
      // The service gets the whole query; route-cache reads the first 256 characters.
      expect(mockSearch.mock.calls[0]?.[0]).toBe(query);
      expect(result.structuredContent).toMatchObject({ effectiveQuery: head, notice: NOTICE });
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain(NOTICE);
      expect(text).not.toContain('wind');
    });

    it('quotes the searched text in the no-match notice', async () => {
      mockSearch.mockResolvedValue({ results: [], hasMore: false, status: settled(5459) });
      const head = 'x'.repeat(256);

      const result = await runToolContract(searchRoutesTool, { query: `${head}tail` });

      expect((result.structuredContent as { notice: string }).notice).toBe(
        `${NOTICE} No routes matched "${head}". Try different search terms or use eia_browse_routes to explore the taxonomy.`,
      );
    });

    it('adds no notice to a query of exactly 256 characters', async () => {
      mockSearch.mockResolvedValue({ results: ranked(1), hasMore: false, status: settled(5459) });
      const query = `${'coal generation '.repeat(16).slice(0, 255)}x`;
      expect(query).toHaveLength(256);

      // Surrounding whitespace is trimmed before the length counts.
      const result = await runToolContract(searchRoutesTool, { query: `  ${query}  ` });

      expect(result.structuredContent).toMatchObject({ effectiveQuery: query });
      expect(result.structuredContent).not.toHaveProperty('notice');
    });
  });

  // ------------------------------------------------------------------
  // Edge case: unicode query
  // ------------------------------------------------------------------

  it('handles unicode query without crashing', async () => {
    mockSearch.mockResolvedValue({ results: [], status: settled(100) });

    const ctx = createMockContext({ errors: searchRoutesTool.errors });
    const input = searchRoutesTool.input.parse({ query: 'électricité données' });
    const result = await searchRoutesTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
  });
});
