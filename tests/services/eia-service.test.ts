/**
 * @fileoverview Tests for EiaApiService against a mocked `fetch` — the
 * offset-paging accumulation loop, the top-level `warnings` envelope, the typed
 * reasons the 404/400 remaps produce, upstream shape-variance normalization,
 * and the facet-value search indexing driven from route metadata. These paths
 * are invisible to the tool-level suites, which mock `getEiaApiService()`
 * wholesale.
 * @module tests/services/eia-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetServerConfig } from '@/config/server-config.js';
import {
  _resetEiaApiService,
  getEiaApiService,
  initEiaApiService,
} from '@/services/eia/eia-service.js';
import {
  _resetRouteCache,
  getIndexSize,
  initRouteCache,
  searchRoutes,
} from '@/services/eia/route-cache.js';
import type { DataRow, EiaWarning } from '@/services/eia/types.js';

const LEAF = 'electricity/retail-sales';
const CATEGORY = 'electricity';

const INCOMPLETE_RETURN: EiaWarning = {
  warning: 'incomplete return',
  description:
    'The API can only return 5000 rows in JSON format.  Please consider constraining your request with facet, start, or end, or using offset to paginate results.',
};

/** A row shaped like EIA's — every value a string, plus the {col}-units companion. */
function row(i: number): DataRow {
  return {
    period: `2024-${String((i % 12) + 1).padStart(2, '0')}`,
    stateid: 'TX',
    price: String(10 + i),
    'price-units': 'cents per kilowatt-hour',
  };
}

interface PageFixture {
  body: unknown;
  status?: number;
}

/** Minimal stand-in for the subset of Response the service reads. */
function httpResponse(fixture: PageFixture) {
  const status = fixture.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () =>
      typeof fixture.body === 'string' ? fixture.body : JSON.stringify(fixture.body),
  } as unknown as Response;
}

/**
 * Fake the EIA data endpoint over a synthetic corpus, honouring the `offset`
 * and `length` query params so the paging loop is exercised for real. Records
 * every (offset, length) pair the service asked for.
 */
function stubDataEndpoint(options: {
  total: number;
  warnings?: EiaWarning[];
  /** Runs before each response, with the 1-based call number — lets a test abort mid-loop. */
  onCall?: (call: number) => void;
  /** From this 1-based call onward, answer 404 (non-transient, so withRetry gives up at once). */
  failFromCall?: number;
}) {
  const calls: Array<{ offset: number; length: number }> = [];
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const length = Number(url.searchParams.get('length') ?? '100');
    calls.push({ offset, length });
    options.onCall?.(calls.length);
    if (options.failFromCall !== undefined && calls.length >= options.failFromCall) {
      return httpResponse({ status: 404, body: { error: 'gone' } });
    }

    const slice: DataRow[] = [];
    for (let i = offset; i < Math.min(offset + length, options.total); i++) slice.push(row(i));

    return httpResponse({
      body: {
        ...(options.warnings && { warnings: options.warnings }),
        response: {
          total: String(options.total),
          dateFormat: 'YYYY-MM',
          frequency: 'monthly',
          data: slice,
        },
      },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/** Seed the route tree so query()'s pre-flight resolves without network calls. */
function seedRouteCache() {
  initRouteCache(
    [
      {
        id: 'electricity',
        name: 'Electricity',
        routes: [
          {
            id: 'retail-sales',
            name: 'Retail sales',
            frequency: [],
            facets: [],
            data: {},
          },
        ],
      },
    ],
    [],
  );
}

describe('EiaApiService.query', () => {
  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    vi.stubEnv('EIA_BASE_URL', 'https://api.eia.gov/v2');
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
    initEiaApiService();
    seedRouteCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
  });

  // ------------------------------------------------------------------
  // Offset paging accumulation (#26)
  // ------------------------------------------------------------------

  describe('canvas accumulation', () => {
    it('leaves accumulated undefined when accumulate is not requested', async () => {
      const { calls } = stubDataEndpoint({ total: 40 });
      const ctx = createMockContext();

      const result = await getEiaApiService().query(
        LEAF,
        { columns: ['price'], length: 5, offset: 0 },
        ctx,
      );

      expect(result.data).toHaveLength(5);
      expect(result.total).toBe(40);
      expect(result.accumulated).toBeUndefined();
      expect(calls).toEqual([{ offset: 0, length: 5 }]);
    });

    it('pages forward from the preview until the result set is exhausted', async () => {
      vi.stubEnv('EIA_CANVAS_MAX_ROWS', '25');
      _resetServerConfig();
      const { calls } = stubDataEndpoint({ total: 12 });
      const ctx = createMockContext();

      const result = await getEiaApiService().query(
        LEAF,
        { accumulate: true, columns: ['price'], length: 3, offset: 0 },
        ctx,
      );

      // Inline preview stays at the caller's length — accumulation never widens it.
      expect(result.data).toHaveLength(3);
      expect(result.accumulated?.rows).toHaveLength(12);
      expect(result.accumulated?.capped).toBe(false);
      // Preview page, then one follow-up bounded by the remaining cap headroom.
      expect(calls).toEqual([
        { offset: 0, length: 3 },
        { offset: 3, length: 22 },
      ]);
      // The accumulated set starts with the preview rows, in order.
      expect(result.accumulated?.rows[0]).toEqual(result.data[0]);
      expect(result.accumulated?.rows[11]?.price).toBe('21');
    });

    it('stops at the cumulative cap and flags capped', async () => {
      vi.stubEnv('EIA_CANVAS_MAX_ROWS', '25');
      _resetServerConfig();
      const { calls } = stubDataEndpoint({ total: 500 });
      const ctx = createMockContext();

      const result = await getEiaApiService().query(
        LEAF,
        { accumulate: true, columns: ['price'], length: 5, offset: 0 },
        ctx,
      );

      expect(result.accumulated?.rows).toHaveLength(25);
      expect(result.accumulated?.capped).toBe(true);
      // The cap that applied travels with the rows so callers can name it.
      expect(result.accumulated?.cap).toBe(25);
      expect(calls).toEqual([
        { offset: 0, length: 5 },
        { offset: 5, length: 20 },
      ]);
    });

    it('caps each page at the EIA 5000-row per-request ceiling', async () => {
      vi.stubEnv('EIA_CANVAS_MAX_ROWS', '12000');
      _resetServerConfig();
      const { calls } = stubDataEndpoint({ total: 12000 });
      const ctx = createMockContext();

      const result = await getEiaApiService().query(
        LEAF,
        { accumulate: true, columns: ['price'], length: 100, offset: 0 },
        ctx,
      );

      expect(result.accumulated?.rows).toHaveLength(12000);
      expect(result.accumulated?.capped).toBe(false);
      expect(calls.map((c) => c.length)).toEqual([100, 5000, 5000, 1900]);
    });

    it('accumulates forward from a non-zero offset', async () => {
      vi.stubEnv('EIA_CANVAS_MAX_ROWS', '25');
      _resetServerConfig();
      const { calls } = stubDataEndpoint({ total: 30 });
      const ctx = createMockContext();

      const result = await getEiaApiService().query(
        LEAF,
        { accumulate: true, columns: ['price'], length: 4, offset: 10 },
        ctx,
      );

      // 20 rows remain past offset 10; all fit under the 25-row cap.
      expect(result.accumulated?.rows).toHaveLength(20);
      expect(result.accumulated?.capped).toBe(false);
      expect(calls[0]).toEqual({ offset: 10, length: 4 });
      expect(result.accumulated?.rows[0]?.price).toBe('20');
    });

    it('does not page when the preview already covers the result set', async () => {
      const { calls } = stubDataEndpoint({ total: 3 });
      const ctx = createMockContext();

      const result = await getEiaApiService().query(
        LEAF,
        { accumulate: true, columns: ['price'], length: 100, offset: 0 },
        ctx,
      );

      expect(result.accumulated).toBeUndefined();
      expect(calls).toHaveLength(1);
    });

    it('keeps the rows already gathered when a follow-up page fails', async () => {
      vi.stubEnv('EIA_CANVAS_MAX_ROWS', '25000');
      _resetServerConfig();
      stubDataEndpoint({ total: 20000, failFromCall: 3 });
      const ctx = createMockContext();

      const result = await getEiaApiService().query(
        LEAF,
        { accumulate: true, columns: ['price'], length: 100, offset: 0 },
        ctx,
      );

      // The preview the caller asked for survives; staging keeps what landed.
      expect(result.data).toHaveLength(100);
      expect(result.total).toBe(20000);
      expect(result.accumulated?.rows).toHaveLength(5100);
      // Not the cap — the note must not blame EIA_CANVAS_MAX_ROWS for this.
      expect(result.accumulated?.capped).toBe(false);
    });

    it('propagates the failure when the caller aborted mid-accumulation', async () => {
      const controller = new AbortController();
      stubDataEndpoint({
        total: 20000,
        failFromCall: 2,
        onCall: (call) => {
          if (call >= 2) controller.abort();
        },
      });
      const ctx = createMockContext({ signal: controller.signal });

      await expect(
        getEiaApiService().query(
          LEAF,
          { accumulate: true, columns: ['price'], length: 100, offset: 0 },
          ctx,
        ),
      ).rejects.toThrow();
    });

    it('does not page when the requested offset is past the last row', async () => {
      const { calls } = stubDataEndpoint({ total: 25 });
      const ctx = createMockContext();

      const result = await getEiaApiService().query(
        LEAF,
        { accumulate: true, columns: ['price'], length: 3, offset: 9999 },
        ctx,
      );

      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(25);
      expect(result.accumulated).toBeUndefined();
      expect(calls).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------
  // Top-level warnings envelope (#27)
  // ------------------------------------------------------------------

  describe('warnings envelope', () => {
    it('reads warnings from the top level of the payload', async () => {
      stubDataEndpoint({ total: 113460, warnings: [INCOMPLETE_RETURN] });
      const ctx = createMockContext();

      const result = await getEiaApiService().query(
        LEAF,
        { columns: ['price'], length: 1, offset: 0 },
        ctx,
      );

      expect(result.warnings).toEqual([INCOMPLETE_RETURN]);
      expect(result.warnings?.[0]?.warning).toBe('incomplete return');
      expect(result.warnings?.[0]?.description).toContain('offset to paginate');
    });

    it('returns undefined warnings on a sparse payload with no warnings key', async () => {
      stubDataEndpoint({ total: 2 });
      const ctx = createMockContext();

      const result = await getEiaApiService().query(
        LEAF,
        { columns: ['price'], length: 2, offset: 0 },
        ctx,
      );

      expect(result.warnings).toBeUndefined();
    });

    it('ignores a warnings key nested under response', async () => {
      // EIA always leaves response.warnings null; a value there is not the
      // advisory channel and must not be forwarded.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          httpResponse({
            body: {
              response: {
                total: '10',
                dateFormat: 'YYYY-MM',
                frequency: 'monthly',
                data: [row(0)],
                warnings: [{ warning: 'nested', description: 'should be ignored' }],
              },
            },
          }),
        ),
      );
      const ctx = createMockContext();

      const result = await getEiaApiService().query(
        LEAF,
        { columns: ['price'], length: 1, offset: 0 },
        ctx,
      );

      expect(result.warnings).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // Typed error reasons (#35)
  // ------------------------------------------------------------------

  describe('error reasons', () => {
    function stubError(status: number, error: string) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => httpResponse({ status, body: { error, code: status } })),
      );
    }

    it('maps an invalid facet key to invalid_facet', async () => {
      stubError(400, "Invalid facet 'nope' provided. The only valid facets are 'stateid'.");
      const ctx = createMockContext();

      await expect(
        getEiaApiService().query(LEAF, { columns: ['price'], filters: { nope: 'TX' } }, ctx),
      ).rejects.toMatchObject({
        code: -32007,
        data: {
          reason: 'invalid_facet',
          recovery: { hint: expect.stringContaining('facets[].id') },
        },
      });
    });

    it('maps an invalid data column to invalid_column', async () => {
      stubError(400, "Invalid data 'bogus' provided. The only valid data are 'price'.");
      const ctx = createMockContext();

      await expect(
        getEiaApiService().query(LEAF, { columns: ['bogus'] }, ctx),
      ).rejects.toMatchObject({
        code: -32007,
        data: {
          reason: 'invalid_column',
          recovery: { hint: expect.stringContaining('data_columns[].id') },
        },
      });
    });

    it('maps an invalid frequency to invalid_frequency', async () => {
      stubError(
        400,
        "Invalid frequency 'hourly' provided. The only valid frequencies are 'monthly'.",
      );
      const ctx = createMockContext();

      await expect(
        getEiaApiService().query(LEAF, { columns: ['price'], frequency: 'hourly' }, ctx),
      ).rejects.toMatchObject({
        code: -32007,
        data: {
          reason: 'invalid_frequency',
          recovery: { hint: expect.stringContaining('frequencies[].id') },
        },
      });
    });

    it('falls back to invalid_facet on an unrecognized 400 message', async () => {
      stubError(400, 'Something else went wrong.');
      const ctx = createMockContext();

      await expect(
        getEiaApiService().query(LEAF, { columns: ['price'] }, ctx),
      ).rejects.toMatchObject({
        code: -32007,
        data: { reason: 'invalid_facet' },
      });
    });

    it('surfaces the upstream EIA message verbatim', async () => {
      stubError(400, "Invalid data 'bogus' provided. The only valid data are 'price'.");
      const ctx = createMockContext();

      await expect(getEiaApiService().query(LEAF, { columns: ['bogus'] }, ctx)).rejects.toThrow(
        /Invalid data 'bogus' provided/,
      );
    });

    it('maps a 404 on the data endpoint to route_not_found', async () => {
      stubError(404, 'not found');
      const ctx = createMockContext();

      await expect(
        getEiaApiService().query(LEAF, { columns: ['price'] }, ctx),
      ).rejects.toMatchObject({
        code: -32001,
        data: { reason: 'route_not_found' },
      });
    });

    it('rejects a category route with route_not_queryable, not route_not_found', async () => {
      const { fetchMock } = stubDataEndpoint({ total: 10 });
      const ctx = createMockContext();

      await expect(
        getEiaApiService().query(CATEGORY, { columns: ['price'] }, ctx),
      ).rejects.toMatchObject({
        code: -32007,
        data: { reason: 'route_not_queryable' },
      });
      // Pre-flight short-circuits before any upstream call.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('no longer guards length server-side — the input schema owns the 5000 bound', async () => {
      const { calls } = stubDataEndpoint({ total: 10 });
      const ctx = createMockContext();

      await expect(
        getEiaApiService().query(LEAF, { columns: ['price'], length: 6000 }, ctx),
      ).resolves.toBeDefined();
      expect(calls[0]?.length).toBe(6000);
    });
  });
});

/**
 * Route metadata and facet endpoints, keyed by the API path so a test can
 * describe the exact upstream shape each one answers with. Records every path
 * fetched so a test can assert what was *not* requested.
 */
function stubApiPaths(bodies: Record<string, unknown>) {
  const paths: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v2\/?/, '').replace(/\/$/, '');
    paths.push(path);
    const body = bodies[path];
    if (body === undefined) return httpResponse({ status: 404, body: { error: 'not found' } });
    return httpResponse({ body });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { paths, fetchMock };
}

describe('EiaApiService.describe — upstream shape variance', () => {
  const ROUTE = 'electricity/retail-sales';

  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    vi.stubEnv('EIA_BASE_URL', 'https://api.eia.gov/v2');
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
    initEiaApiService();
    seedRouteCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
  });

  /** Route metadata with a caller-chosen `frequency` shape and no facets. */
  function metaWith(frequency: unknown) {
    return {
      [ROUTE]: {
        response: {
          id: 'electricity',
          name: 'Retail sales',
          description: 'Retail electricity sales',
          facets: [],
          frequency,
          data: { price: { alias: 'Price', units: 'cents per kilowatt-hour' } },
          startPeriod: '2001-01',
          endPeriod: '2024-11',
          defaultFrequency: 'monthly',
          defaultDateFormat: 'YYYY-MM',
        },
      },
    };
  }

  const MONTHLY = {
    id: 'monthly',
    description: 'Monthly',
    query: 'monthly',
    format: 'YYYY-MM',
  };

  it('passes an array frequency through unchanged', async () => {
    stubApiPaths(metaWith([MONTHLY]));
    const meta = await getEiaApiService().describe(ROUTE, createMockContext());
    expect(meta.frequencies).toEqual([MONTHLY]);
    expect(meta.defaultFrequency).toBe('monthly');
  });

  it('flattens an object-map frequency to an array', async () => {
    // The crash shape: `?? []` leaves a non-null object in place under a
    // RawFrequency[] annotation, and describe-route's frequencies.map() throws.
    stubApiPaths(metaWith({ monthly: MONTHLY }));
    const meta = await getEiaApiService().describe(ROUTE, createMockContext());
    expect(Array.isArray(meta.frequencies)).toBe(true);
    expect(meta.frequencies).toEqual([MONTHLY]);
  });

  it('degrades a scalar frequency to an empty array', async () => {
    stubApiPaths(metaWith('monthly'));
    const meta = await getEiaApiService().describe(ROUTE, createMockContext());
    expect(meta.frequencies).toEqual([]);
  });

  it('degrades a null frequency to an empty array', async () => {
    stubApiPaths(metaWith(null));
    const meta = await getEiaApiService().describe(ROUTE, createMockContext());
    expect(meta.frequencies).toEqual([]);
  });

  it('falls back to the first normalized frequency when defaultFrequency is absent', async () => {
    const bodies = metaWith({ monthly: MONTHLY }) as Record<
      string,
      { response: Record<string, unknown> }
    >;
    delete bodies[ROUTE]?.response.defaultFrequency;
    stubApiPaths(bodies);
    const meta = await getEiaApiService().describe(ROUTE, createMockContext());
    expect(meta.defaultFrequency).toBe('monthly');
  });
});

describe('EiaApiService — facet values in the search index', () => {
  const ROUTE = 'electricity/retail-sales';

  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    vi.stubEnv('EIA_BASE_URL', 'https://api.eia.gov/v2');
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
    initEiaApiService();
    seedRouteCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
  });

  const FUEL_FACET_META = {
    [ROUTE]: {
      response: {
        id: 'electricity',
        name: 'Retail sales',
        description: 'Retail electricity sales',
        facets: [{ id: 'fueltypeid', description: 'Fuel Type' }],
        frequency: [],
        data: { price: { alias: 'Price', units: 'cents' } },
      },
    },
    [`${ROUTE}/facet/fueltypeid`]: {
      response: {
        totalFacets: 2,
        facets: [
          { id: 'WND', name: 'wind' },
          { id: 'SPV', name: 'solar photovoltaic' },
        ],
      },
    },
  };

  it("indexes a described route's facet values with a ready-to-use filter_hint", async () => {
    stubApiPaths(FUEL_FACET_META);
    const before = getIndexSize();

    await getEiaApiService().describe(ROUTE, createMockContext());

    expect(getIndexSize()).toBe(before + 2);
    const [hit] = searchRoutes('solar photovoltaic', 5);
    expect(hit?.entry.route).toBe(ROUTE);
    expect(hit?.entry.filter_hint).toEqual({ fueltypeid: 'SPV' });
  });

  it('does not re-add facet values when the same route is described again', async () => {
    stubApiPaths(FUEL_FACET_META);
    const ctx = createMockContext();

    await getEiaApiService().describe(ROUTE, ctx);
    const afterFirst = getIndexSize();
    // The metadata cache short-circuits the second call; even if it did not,
    // the index dedupes on route + filter_hint.
    await getEiaApiService().describe(ROUTE, ctx);

    expect(getIndexSize()).toBe(afterFirst);
  });

  it('indexes vocabulary facets during the background warm pass', async () => {
    _resetRouteCache();
    const { paths } = stubApiPaths({
      '': {
        response: {
          routes: [
            {
              id: 'electricity',
              name: 'Electricity',
              routes: [
                {
                  id: 'electric-power-operational-data',
                  name: 'Electric Power Operations',
                  facets: [
                    { id: 'fueltypeid', description: 'Energy Source' },
                    { id: 'duoarea', description: 'DuoArea' },
                  ],
                  frequency: [],
                  data: {},
                },
              ],
            },
          ],
        },
      },
      'steo/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
      'electricity/electric-power-operational-data/facet/fueltypeid': {
        response: {
          totalFacets: 2,
          facets: [
            { id: 'WND', name: 'wind' },
            { id: 'SPV', name: 'solar photovoltaic' },
          ],
        },
      },
    });

    await getEiaApiService().search('electricity', 5, createMockContext());

    await vi.waitFor(() => {
      const [hit] = searchRoutes('solar photovoltaic', 5);
      expect(hit?.entry.filter_hint).toEqual({ fueltypeid: 'SPV' });
      expect(hit?.entry.route).toBe('electricity/electric-power-operational-data');
    });
    // The vocabulary facet is fetched; the 165-route volume facet never is.
    expect(paths).toContain('electricity/electric-power-operational-data/facet/fueltypeid');
    expect(paths).not.toContain('electricity/electric-power-operational-data/facet/duoarea');
  });

  it('keeps indexing when one facet endpoint fails during the warm pass', async () => {
    _resetRouteCache();
    stubApiPaths({
      '': {
        response: {
          routes: [
            {
              id: 'coal',
              name: 'Coal',
              routes: [
                {
                  id: 'mine-production',
                  name: 'Mine Production',
                  // No stub for coalRankId — the path 404s.
                  facets: [{ id: 'coalRankId', description: 'Coal Rank' }],
                  frequency: [],
                  data: {},
                },
                {
                  id: 'consumption-and-quality',
                  name: 'Consumption and Quality',
                  facets: [{ id: 'sector', description: 'Sector' }],
                  frequency: [],
                  data: {},
                },
              ],
            },
          ],
        },
      },
      'steo/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
      'coal/consumption-and-quality/facet/sector': {
        response: { totalFacets: 1, facets: [{ id: 'IND', name: 'industrial' }] },
      },
    });

    await getEiaApiService().search('coal', 5, createMockContext());

    await vi.waitFor(() => {
      const [hit] = searchRoutes('industrial', 5);
      expect(hit?.entry.filter_hint).toEqual({ sector: 'IND' });
    });
  });

  it('leaves the cached metadata uncapped for high-cardinality facets', async () => {
    const values = Array.from({ length: 400 }, (_, i) => ({ id: `V${i}`, name: `Value ${i}` }));
    stubApiPaths({
      [ROUTE]: {
        response: {
          id: 'electricity',
          name: 'Retail sales',
          facets: [{ id: 'mineMSHAId', description: 'Mine' }],
          frequency: [],
          data: {},
        },
      },
      [`${ROUTE}/facet/mineMSHAId`]: { response: { totalFacets: 400, facets: values } },
    });
    const before = getIndexSize();

    const meta = await getEiaApiService().describe(ROUTE, createMockContext());

    // The cache keeps every value — #29's cap lives at the tool boundary.
    expect(meta.facets[0]?.values).toHaveLength(400);
    // But an opaque-identifier facet that size stays out of the index.
    expect(getIndexSize()).toBe(before);
  });
});
