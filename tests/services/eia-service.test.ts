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
  TREE_BUILD_CONCURRENCY,
} from '@/services/eia/eia-service.js';
import {
  _resetRouteCache,
  getIndexSize,
  getIndexStatus,
  getNode,
  initRouteCache,
  isLeafNode,
  searchRoutes,
} from '@/services/eia/route-cache.js';
import type { DataRow, EiaWarning, RawRouteNode } from '@/services/eia/types.js';

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

  it('holds the search until the facet vocabulary is in the index', async () => {
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

    // The very first search — no waiting, no second call. A facet value the
    // vocabulary pass supplies is already rankable when it returns.
    const { results, status } = await getEiaApiService().search(
      'solar photovoltaic',
      5,
      createMockContext(),
    );

    expect(status.complete).toBe(true);
    expect(results[0]?.entry.filter_hint).toEqual({ fueltypeid: 'SPV' });
    expect(results[0]?.entry.route).toBe('electricity/electric-power-operational-data');
    // The vocabulary facet is fetched; the 165-route volume facet never is.
    expect(paths).toContain('electricity/electric-power-operational-data/facet/fueltypeid');
    expect(paths).not.toContain('electricity/electric-power-operational-data/facet/duoarea');
  });

  it('keeps indexing when one facet endpoint fails, and reports the pass as short', async () => {
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

    const { status } = await getEiaApiService().search('coal', 5, createMockContext());

    // The surviving facet still lands...
    expect(searchRoutes('industrial', 5)[0]?.entry.filter_hint).toEqual({ sector: 'IND' });
    // ...but the corpus is short by one facet's vocabulary, and says so.
    expect(status.complete).toBe(false);
    expect(status.pendingPasses).toEqual(['facet_values']);
    expect(status.incompleteRoutes).toEqual([]);
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

/**
 * A warm-time metadata fetch that fails past its retry budget used to fall back
 * to the parent's stub, which carries no routes/facets/data and so read as a
 * queryable leaf — hiding both the real subtree and the fact that anything went
 * wrong, for the life of the process.
 */
describe('EiaApiService — a route the warm could not fetch', () => {
  /** Root advertises two bare stubs; only `electricity` has a metadata stub. */
  function fixture(): Record<string, unknown> {
    return {
      '': {
        response: {
          routes: [
            { id: 'electricity', name: 'Electricity' },
            { id: 'coal', name: 'Coal' },
          ],
        },
      },
      electricity: {
        response: {
          id: 'electricity',
          name: 'Electricity',
          routes: [
            {
              id: 'retail-sales',
              name: 'Retail Sales',
              facets: [],
              frequency: [],
              data: {},
            },
          ],
        },
      },
      'steo/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
    };
  }

  const COAL_METADATA = {
    response: {
      id: 'coal',
      name: 'Coal',
      routes: [
        { id: 'mine-production', name: 'Mine Production', facets: [], frequency: [], data: {} },
      ],
    },
  };

  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    vi.stubEnv('EIA_BASE_URL', 'https://api.eia.gov/v2');
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
    initEiaApiService();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
  });

  it('marks the node incomplete rather than passing the stub off as a leaf', async () => {
    stubApiPaths(fixture());

    const { status } = await getEiaApiService().search('coal', 5, createMockContext());

    expect(isLeafNode(getNode('coal') as RawRouteNode)).toBe(false);
    // Both index passes landed — the corpus is incomplete purely because of the
    // missing subtree, and the two conditions are reported apart.
    expect(status.pendingPasses).toEqual([]);
    expect(status.incompleteRoutes).toEqual(['coal']);
    expect(status.complete).toBe(false);
  });

  it('sweeps only the node that missed, and stops after one sweep', async () => {
    const { paths } = stubApiPaths(fixture());

    await getEiaApiService().search('coal', 5, createMockContext());

    // `electricity` answered on the first pass, so the sweep leaves it alone;
    // `coal` is tried once more and then given up on rather than swept again.
    expect(paths.filter((p) => p === 'electricity')).toHaveLength(1);
    expect(paths.filter((p) => p === 'coal')).toHaveLength(2);
  });

  it('re-fetches the node on the next browse instead of caching the miss', async () => {
    const bodies = fixture();
    stubApiPaths(bodies);
    const ctx = createMockContext();
    await getEiaApiService().search('coal', 5, ctx);

    // The route answers on a later call — as an intermittent failure would.
    bodies.coal = COAL_METADATA;
    const result = await getEiaApiService().browse('coal', ctx);

    expect(result.isLeaf).toBe(false);
    expect(result.children.map((c) => c.route)).toEqual(['coal/mine-production']);
    // The repaired subtree joins the corpus, and the gap closes.
    expect(searchRoutes('mine production', 5)[0]?.entry.route).toBe('coal/mine-production');
    expect(getIndexStatus().incompleteRoutes).toEqual([]);
    expect(getIndexStatus().complete).toBe(true);
  });

  it('drops the stale leaf claim the stub left in the index', async () => {
    const bodies = fixture();
    stubApiPaths(bodies);
    const ctx = createMockContext();
    await getEiaApiService().search('coal', 5, ctx);

    bodies.coal = COAL_METADATA;
    await getEiaApiService().browse('coal', ctx);

    const [coalEntry] = searchRoutes('Coal', 10).filter((r) => r.entry.route === 'coal');
    expect(coalEntry?.entry.isLeaf).toBe(false);
  });

  it('fails the browse when the re-fetch fails too, rather than answering from the stub', async () => {
    stubApiPaths(fixture());
    const ctx = createMockContext();
    await getEiaApiService().search('coal', 5, ctx);

    await expect(getEiaApiService().browse('coal', ctx)).rejects.toThrow(
      /did not return metadata for route "coal"/,
    );
  });

  it('leaves an incomplete node to the live fetch instead of rejecting it as a category', async () => {
    const bodies = fixture();
    stubApiPaths(bodies);
    const ctx = createMockContext();
    await getEiaApiService().search('coal', 5, ctx);

    // `coal` is a leaf after all — the cached classification must not pre-empt
    // that, in either direction.
    bodies.coal = {
      response: {
        id: 'coal',
        name: 'Coal',
        facets: [],
        frequency: [],
        data: { value: { alias: 'Value', units: 'tons' } },
      },
    };

    const meta = await getEiaApiService().describe('coal', ctx);
    expect(meta.route).toBe('coal');
    expect(meta.dataColumns.map((c) => c.id)).toEqual(['value']);
  });
});

/**
 * The tree build paces its metadata fetches through one gate shared by the
 * whole recursion, and a node's children are fetched from inside its own task.
 * That is the shape that deadlocks if a parent holds its slot across the
 * recursion: once every slot belongs to a parent waiting on a child, no child
 * can ever acquire one. The gate is only ever held around the leaf fetch, and
 * these fixtures are wide and deep enough to wedge it if that stops being true.
 */
describe('EiaApiService — tree-build pacing under recursive fan-out', () => {
  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    vi.stubEnv('EIA_BASE_URL', 'https://api.eia.gov/v2');
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
    initEiaApiService();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
  });

  /**
   * A taxonomy of bare stubs — every node costs a metadata fetch. `childCounts`
   * gives the fan-out per level; a node past the last level answers as a leaf.
   */
  function nestedTaxonomy(rootWidth: number, childCounts: number[]): Record<string, unknown> {
    const bodies: Record<string, unknown> = {
      'steo/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
    };
    const stub = (id: string) => ({ id, name: id });

    const expand = (path: string, level: number): void => {
      const fanOut = childCounts[level];
      if (fanOut === undefined) {
        bodies[path] = { response: { id: path, name: path, facets: [], frequency: [], data: {} } };
        return;
      }
      const childIds = Array.from(
        { length: fanOut },
        (_, i) => `${path.replaceAll('/', '-')}-${i}`,
      );
      bodies[path] = { response: { id: path, name: path, routes: childIds.map(stub) } };
      for (const childId of childIds) expand(`${path}/${childId}`, level + 1);
    };

    const rootIds = Array.from({ length: rootWidth }, (_, i) => `cat${i}`);
    bodies[''] = { response: { routes: rootIds.map(stub) } };
    for (const id of rootIds) expand(id, 0);
    return bodies;
  }

  /** `stubApiPaths`, with each response deferred a tick so overlap is observable. */
  function stubPacedApiPaths(bodies: Record<string, unknown>) {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight--;
        const path = new URL(String(input)).pathname.replace(/^\/v2\/?/, '').replace(/\/$/, '');
        const body = bodies[path];
        return body === undefined
          ? httpResponse({ status: 404, body: { error: 'not found' } })
          : httpResponse({ body });
      }),
    );
    return { peak: () => peak };
  }

  // A hang here IS the failure — it means a parent held its gate slot while
  // awaiting the children queued behind it.
  it('builds a tree wider at the root than the gate allows in flight', {
    timeout: 10_000,
  }, async () => {
    stubApiPaths(nestedTaxonomy(12, [3, 2]));

    const { status } = await getEiaApiService().search('cat', 5, createMockContext());

    // 12 categories + 36 children + 72 grandchildren.
    expect(status.size).toBe(120);
    expect(status.complete).toBe(true);
  });

  it('holds the whole recursion to one gate rather than one per level', async () => {
    const { peak } = stubPacedApiPaths(nestedTaxonomy(12, [3, 2]));

    await getEiaApiService().search('cat', 5, createMockContext());

    // 120 nodes want a metadata fetch; a per-level bound would let a level's
    // full width run at once, and no bound at all would run 72.
    expect(peak()).toBe(TREE_BUILD_CONCURRENCY);
  });
});

/**
 * The whole warm lands well inside the budget on a healthy run, so this path is
 * about the degraded one: an upstream slow enough to outlast the caller's own
 * request timeout must not turn a slow answer into a transport error that
 * carries none of the tool's recovery hint.
 */
describe('EiaApiService — the search wait is bounded', () => {
  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    vi.stubEnv('EIA_BASE_URL', 'https://api.eia.gov/v2');
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
    initEiaApiService();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
  });

  it('answers from what is indexed when a pass outlasts the budget', async () => {
    let releaseSteo: () => void = () => {};
    const steoHeld = new Promise<void>((resolve) => {
      releaseSteo = resolve;
    });
    const bodies: Record<string, unknown> = {
      '': { response: { routes: [{ id: 'electricity', name: 'Electricity' }] } },
      electricity: {
        response: {
          id: 'electricity',
          name: 'Electricity',
          routes: [
            { id: 'retail-sales', name: 'Retail Sales', facets: [], frequency: [], data: {} },
          ],
        },
      },
      'steo/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const path = new URL(String(input)).pathname.replace(/^\/v2\/?/, '').replace(/\/$/, '');
        if (path === 'steo/facet/seriesId') await steoHeld;
        return httpResponse({ body: bodies[path] });
      }),
    );

    await getEiaApiService().ensureIndexWarmed(createMockContext(), 25);

    // The tree landed, so the answer is real — it is just short one pass, and
    // says which one rather than reporting a settled corpus.
    const status = getIndexStatus();
    expect(status.complete).toBe(false);
    expect(status.pendingPasses).toEqual(['steo_series']);
    expect(searchRoutes('retail sales', 5)[0]?.entry.route).toBe('electricity/retail-sales');

    releaseSteo();
  });

  it('still surfaces a failed tree build rather than answering empty', async () => {
    stubApiPaths({});

    await expect(
      getEiaApiService().ensureIndexWarmed(createMockContext(), 5_000),
    ).rejects.toThrow();
  });
});
