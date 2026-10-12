/**
 * @fileoverview Tests for EiaApiService against a mocked `fetch` — the
 * offset-paging accumulation loop, the top-level `warnings` envelope, the typed
 * reasons the 404/400 remaps produce, upstream shape-variance normalization,
 * and the facet-value search indexing driven from route metadata. These paths
 * are invisible to the tool-level suites, which mock `getEiaApiService()`
 * wholesale.
 * @module tests/services/eia-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetServerConfig } from '@/config/server-config.js';
import { describeRouteTool } from '@/mcp-server/tools/definitions/describe-route.tool.js';
import { searchRoutesTool } from '@/mcp-server/tools/definitions/search-routes.tool.js';
import {
  _resetEiaApiService,
  getEiaApiService,
  initEiaApiService,
  shutdownEiaApiService,
  TREE_BUILD_CONCURRENCY,
} from '@/services/eia/eia-service.js';
import {
  _resetRouteCache,
  getIndexEntries,
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

/** Real Response keeps the HTTP error mapper's headers and status semantics. */
function httpResponse(fixture: PageFixture) {
  const status = fixture.status ?? 200;
  return new Response(
    typeof fixture.body === 'string' ? fixture.body : JSON.stringify(fixture.body),
    { status },
  );
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

/** The key `beforeEach` stubs into `EIA_API_KEY`, asserted against by the log tests. */
const API_KEY = 'test-key';

/** Every `ctx.log` call the mock logger recorded, in order. */
function logCalls(ctx: { log: unknown }): Array<{ level: string; msg: string; data?: unknown }> {
  return (ctx.log as MockContextLogger).calls;
}

/** Every recorded log call flattened to one string — message and metadata alike. */
function loggedText(ctx: { log: unknown }): string {
  return logCalls(ctx)
    .map((call) => `${call.msg} ${JSON.stringify(call.data ?? {})}`)
    .join('\n');
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

    /**
     * `ctx.log` is dual-sink as of mcp-ts-core 0.12.0 — every level also emits
     * `notifications/message` to the client. The API key rides in every request
     * URL as `api_key=`, so a log line that carried a URL would hand it to the
     * caller. These pin that no service log line does.
     */
    it('keeps the API key out of every log line on the happy path', async () => {
      vi.stubEnv('EIA_CANVAS_MAX_ROWS', '25000');
      _resetServerConfig();
      stubDataEndpoint({ total: 300 });
      const ctx = createMockContext();

      await getEiaApiService().query(
        LEAF,
        { accumulate: true, columns: ['price'], length: 100, offset: 0 },
        ctx,
      );

      const emitted = loggedText(ctx);
      expect(emitted).not.toBe('');
      expect(emitted).not.toContain(API_KEY);
      expect(emitted).not.toContain('api_key');
    });

    it('keeps the API key out of the log line an upstream failure produces', async () => {
      vi.stubEnv('EIA_CANVAS_MAX_ROWS', '25000');
      _resetServerConfig();
      stubDataEndpoint({ total: 20000, failFromCall: 3 });
      const ctx = createMockContext();

      await getEiaApiService().query(
        LEAF,
        { accumulate: true, columns: ['price'], length: 100, offset: 0 },
        ctx,
      );

      const stoppedEarly = logCalls(ctx).filter(
        (call) => call.msg === 'EIA canvas accumulation stopped early',
      );
      expect(stoppedEarly).toHaveLength(1);

      const emitted = loggedText(ctx);
      expect(emitted).not.toContain(API_KEY);
      expect(emitted).not.toContain('api_key');
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

    it('maps an invalid sort column to invalid_sort', async () => {
      stubError(
        400,
        "Invalid sort 'bogus_col' provided. The only valid sort parameters are 'revenue', 'sales', 'price', 'customers', 'period', 'stateid', and 'sectorid' in either 'asc' or 'desc' order.",
      );
      const ctx = createMockContext();

      await expect(
        getEiaApiService().query(
          LEAF,
          { columns: ['price'], sort: [{ column: 'bogus_col', direction: 'desc' }] },
          ctx,
        ),
      ).rejects.toMatchObject({
        code: -32007,
        data: {
          reason: 'invalid_sort',
          recovery: { hint: expect.stringContaining('data_columns[].id') },
        },
      });
    });

    it('maps an invalid date format to invalid_period', async () => {
      stubError(
        400,
        "Invalid date format 'not-a-date' provided. The only valid date formats for this data are 'YYYY-MM', 'YYYY-\"Q\"Q', 'YYYY'.",
      );
      const ctx = createMockContext();

      await expect(
        getEiaApiService().query(
          LEAF,
          { columns: ['price'], start: 'not-a-date', end: 'nzz' },
          ctx,
        ),
      ).rejects.toMatchObject({
        code: -32007,
        data: {
          reason: 'invalid_period',
          recovery: { hint: expect.stringContaining('frequencies[].format') },
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

    it('fails a 414 on the data endpoint as uri_too_long, unretried, not as a remapped 400', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response('<html><head><title>414 Request-URI Too Large</title></head></html>', {
            status: 414,
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const ctx = createMockContext();

      await expect(
        getEiaApiService().query(LEAF, { columns: ['price'], filters: { stateid: ['TX'] } }, ctx),
      ).rejects.toMatchObject({
        code: -32007,
        data: { reason: 'uri_too_long', retryable: false },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
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
  const urls: URL[] = [];
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v2\/?/, '').replace(/\/$/, '');
    paths.push(path);
    urls.push(url);
    const body = bodies[path];
    if (body === undefined) return httpResponse({ status: 404, body: { error: 'not found' } });
    return httpResponse({ body });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { paths, urls, fetchMock };
}

/** The `data[]` columns of every request made to a route's data endpoint, in order. */
function dataColumnsSent(urls: URL[]): string[][] {
  return urls
    .filter((url) => url.pathname.endsWith('/data/'))
    .map((url) => url.searchParams.getAll('data[]'));
}

// ------------------------------------------------------------------
// #69 — a query without `columns` has to send every data column as `data[]`.
// It reads them from the warmed route node, or from the route metadata alone
// when the node is incomplete, and never fetches a facet value list to do it.
// ------------------------------------------------------------------

describe('EiaApiService.query — data columns for a query without columns (#69)', () => {
  const RETAIL = 'electricity/retail-sales';

  /** A data page that echoes which columns it was asked for. */
  const DATA_PAGE = {
    response: {
      total: '1',
      dateFormat: 'YYYY',
      frequency: 'annual',
      data: [{ period: '2024', stateid: 'TX', price: '14.1', 'price-units': 'cents' }],
    },
  };

  /** Route metadata for `coal` — the node the warm could not fetch. */
  const COAL_META = {
    response: {
      id: 'coal',
      name: 'Coal',
      facets: [{ id: 'stateId', description: 'State' }],
      frequency: [{ id: 'annual', description: 'Annual', query: 'A', format: 'YYYY' }],
      data: {
        production: { alias: 'Production', units: 'short tons' },
        price: { alias: 'Price', units: 'dollars per short ton' },
      },
    },
  };

  const COAL_STATE_VALUES = {
    response: { totalFacets: 1, facets: [{ id: 'WY', name: 'Wyoming' }] },
  };

  /** A warmed tree: one complete leaf, one category, and a node the warm missed. */
  function seedWarmedTree() {
    initRouteCache(
      [
        {
          id: 'electricity',
          name: 'Electricity',
          routes: [
            {
              id: 'retail-sales',
              name: 'Retail sales',
              facets: [
                { id: 'stateid', description: 'State' },
                { id: 'sectorid', description: 'Sector' },
              ],
              frequency: [{ id: 'annual', description: 'Annual', query: 'A', format: 'YYYY' }],
              data: {
                revenue: { alias: 'Revenue', units: 'million dollars' },
                price: { alias: 'Price', units: 'cents per kilowatt-hour' },
              },
            },
          ],
        },
        {
          id: 'steo',
          name: 'STEO',
          facets: [{ id: 'seriesId', description: 'Series' }],
          data: { value: [] },
        },
        { id: 'coal', name: 'Coal', incomplete: true },
      ],
      [],
    );
  }

  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    vi.stubEnv('EIA_BASE_URL', 'https://api.eia.gov/v2');
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
    initEiaApiService();
    seedWarmedTree();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
  });

  it('sends only the columns the caller named, with no request beyond the data request', async () => {
    const { paths, urls } = stubApiPaths({ [`${RETAIL}/data`]: DATA_PAGE });

    const result = await getEiaApiService().query(
      RETAIL,
      { columns: ['price'] },
      createMockContext(),
    );

    expect(paths).toEqual([`${RETAIL}/data`]);
    expect(dataColumnsSent(urls)).toEqual([['price']]);
    expect(result.data).toEqual(DATA_PAGE.response.data);
  });

  it('reads every data column from a warmed node in one upstream request', async () => {
    const { paths, urls } = stubApiPaths({ [`${RETAIL}/data`]: DATA_PAGE });

    const result = await getEiaApiService().query(RETAIL, { length: 1 }, createMockContext());

    expect(paths).toEqual([`${RETAIL}/data`]);
    expect(dataColumnsSent(urls)).toEqual([['revenue', 'price']]);
    expect(result.total).toBe(1);
    expect(result.data).toEqual(DATA_PAGE.response.data);
  });

  it('reads the value-array column a time-series node advertises as data: { value: [] }', async () => {
    const { paths, urls } = stubApiPaths({ 'steo/data': DATA_PAGE });

    await getEiaApiService().query('steo', {}, createMockContext());

    expect(paths).toEqual(['steo/data']);
    expect(dataColumnsSent(urls)).toEqual([['value']]);
  });

  it('falls back to one metadata request for a node the warm could not fetch', async () => {
    const { paths, urls } = stubApiPaths({
      coal: COAL_META,
      'coal/facet/stateId': COAL_STATE_VALUES,
      'coal/data': DATA_PAGE,
    });
    const ctx = createMockContext();

    await getEiaApiService().query('coal', {}, ctx);
    expect(paths).toEqual(['coal', 'coal/data']);
    expect(dataColumnsSent(urls)).toEqual([['production', 'price']]);

    // The columns are kept, so the next query on that route is one request again.
    await getEiaApiService().query('coal', {}, ctx);
    expect(paths).toEqual(['coal', 'coal/data', 'coal/data']);
  });

  it('falls back to one metadata request for a route the tree does not hold', async () => {
    const route = 'petroleum/pri/spt';
    const { paths } = stubApiPaths({
      [route]: {
        response: {
          id: 'petroleum',
          facets: [{ id: 'duoarea', description: 'Area' }],
          data: { value: { alias: 'Value', units: '$/bbl' } },
        },
      },
      [`${route}/facet/duoarea`]: { response: { totalFacets: 0, facets: [] } },
      [`${route}/data`]: DATA_PAGE,
    });

    await getEiaApiService().query(route, {}, createMockContext());

    expect(paths).toEqual([route, `${route}/data`]);
  });

  it('keeps route_not_found and route_not_queryable on the metadata fallback', async () => {
    stubApiPaths({ 'natural-gas': { response: { id: 'natural-gas', routes: [{ id: 'pri' }] } } });
    const ctx = createMockContext();

    await expect(getEiaApiService().query('nuclear-outages', {}, ctx)).rejects.toMatchObject({
      data: { reason: 'route_not_found' },
    });
    await expect(getEiaApiService().query('natural-gas', {}, ctx)).rejects.toMatchObject({
      data: { reason: 'route_not_queryable' },
    });
  });

  it('leaves the facet values to the next describe, which fetches each one once', async () => {
    const { paths } = stubApiPaths({
      coal: COAL_META,
      'coal/facet/stateId': COAL_STATE_VALUES,
      'coal/data': DATA_PAGE,
    });
    const ctx = createMockContext();

    await getEiaApiService().query('coal', {}, ctx);
    const meta = await getEiaApiService().describe('coal', ctx);

    // The query fetched no value list; the describe fetched the one it needs,
    // without fetching the metadata the query already has.
    expect(paths).toEqual(['coal', 'coal/data', 'coal/facet/stateId']);
    expect(meta.facets).toEqual([
      { id: 'stateId', description: 'State', values: [{ id: 'WY', name: 'Wyoming' }] },
    ]);
    expect(meta.dataColumns.map((c) => c.id)).toEqual(['production', 'price']);
    expect(searchRoutes('Wyoming', 5)[0]?.entry.filter_hint).toEqual({ stateId: 'WY' });

    // Complete now — a second describe is served from the cache.
    await getEiaApiService().describe('coal', ctx);
    expect(paths).toHaveLength(3);
  });
});

// ------------------------------------------------------------------
// #65 — every row already carries `period` and each facet ID, but EIA's
// `data[]` accepts only data columns. Naming one of those in `columns` is
// dropped before the request instead of failing the call.
// ------------------------------------------------------------------

describe('EiaApiService.query — period and facet IDs in columns (#65)', () => {
  const RETAIL = 'electricity/retail-sales';
  const CO2 = 'co2-emissions/co2-emissions-aggregates';

  const DATA_PAGE = {
    response: {
      total: '2',
      dateFormat: 'YYYY',
      frequency: 'annual',
      data: [
        { period: '2024', stateid: 'TX', price: '14.1' },
        { period: '2023', stateid: 'TX', price: '13.9' },
      ],
    },
  };

  /** Every data endpoint answers with the same page; metadata requests 404 unless listed. */
  function stubData(extra: Record<string, unknown> = {}) {
    return stubApiPaths({
      [`${RETAIL}/data`]: DATA_PAGE,
      [`${CO2}/data`]: DATA_PAGE,
      'coal/data': DATA_PAGE,
      'overlap/data': DATA_PAGE,
      ...extra,
    });
  }

  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    vi.stubEnv('EIA_BASE_URL', 'https://api.eia.gov/v2');
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
    initEiaApiService();
    initRouteCache(
      [
        {
          id: 'electricity',
          name: 'Electricity',
          routes: [
            {
              id: 'retail-sales',
              name: 'Retail sales',
              facets: [
                { id: 'stateid', description: 'State' },
                { id: 'sectorid', description: 'Sector' },
              ],
              data: {
                revenue: { alias: 'Revenue', units: 'million dollars' },
                price: { alias: 'Price', units: 'cents per kilowatt-hour' },
              },
            },
          ],
        },
        {
          id: 'co2-emissions',
          name: 'CO2',
          routes: [
            {
              id: 'co2-emissions-aggregates',
              name: 'Aggregates',
              facets: [
                { id: 'sectorId', description: 'Sector' },
                { id: 'fuelId', description: 'Fuel' },
                { id: 'stateId', description: 'State' },
              ],
              data: { value: { alias: 'Value', units: 'million metric tons' } },
            },
          ],
        },
        // A data column that shares its name with a facet ID — the guard case.
        {
          id: 'overlap',
          name: 'Overlap',
          facets: [{ id: 'sector', description: 'Sector' }],
          data: {
            sector: { alias: 'Sector total', units: '' },
            value: { alias: 'Value', units: '' },
          },
        },
        { id: 'coal', name: 'Coal', incomplete: true },
      ],
      [],
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
  });

  it.each([
    [['stateid', 'price'], ['price']],
    [['period', 'price'], ['price']],
    [
      ['price', 'sectorid', 'period', 'revenue'],
      ['price', 'revenue'],
    ],
  ])('sends %j as %j, with no request beyond the data request', async (columns, sent) => {
    const { paths, urls } = stubData();

    const result = await getEiaApiService().query(RETAIL, { columns }, createMockContext());

    expect(paths).toEqual([`${RETAIL}/data`]);
    expect(dataColumnsSent(urls)).toEqual([sent]);
    expect(result.appliedColumns).toEqual(sent);
    expect(result.data).toEqual(DATA_PAGE.response.data);
  });

  it.each([[['period']], [['stateid']], [['period', 'stateid', 'sectorid']]])(
    'treats %j, which names no data column, as omitted columns',
    async (columns) => {
      const { paths, urls } = stubData();

      const result = await getEiaApiService().query(RETAIL, { columns }, createMockContext());

      expect(paths).toEqual([`${RETAIL}/data`]);
      expect(dataColumnsSent(urls)).toEqual([['revenue', 'price']]);
      expect(result.appliedColumns).toBeUndefined();
    },
  );

  it("matches a route's own facet-ID spelling (stateId on co2-emissions-aggregates)", async () => {
    const { urls } = stubData();

    const result = await getEiaApiService().query(
      CO2,
      { columns: ['stateId', 'value'] },
      createMockContext(),
    );

    expect(dataColumnsSent(urls)).toEqual([['value']]);
    expect(result.appliedColumns).toEqual(['value']);
  });

  it('keeps a name that is a data column as well as a facet ID', async () => {
    const { urls } = stubData();

    await getEiaApiService().query(
      'overlap',
      { columns: ['sector', 'value'] },
      createMockContext(),
    );

    expect(dataColumnsSent(urls)).toEqual([['sector', 'value']]);
  });

  it.each([
    [['stateDescription', 'price']],
    [['price-units', 'price']],
    [['bogus']],
    [['stateid', 'bogus']],
  ])('sends %j on, so names that are not row keys still fail upstream', async (columns) => {
    const { urls } = stubData();

    await getEiaApiService().query(RETAIL, { columns }, createMockContext());

    const expected = columns.filter((c) => c !== 'stateid');
    expect(dataColumnsSent(urls)).toEqual([expected]);
  });

  it('sends columns unchanged when neither the node nor a describe holds the route', async () => {
    const { paths, urls } = stubData();

    const result = await getEiaApiService().query(
      'coal',
      { columns: ['stateId', 'production'] },
      createMockContext(),
    );

    // No metadata request is spent to strip a caller slip.
    expect(paths).toEqual(['coal/data']);
    expect(dataColumnsSent(urls)).toEqual([['stateId', 'production']]);
    expect(result.appliedColumns).toEqual(['stateId', 'production']);
  });

  it('strips against a prior describe when the node is incomplete', async () => {
    const { paths, urls } = stubData({
      coal: {
        response: {
          id: 'coal',
          facets: [{ id: 'stateId', description: 'State' }],
          data: { production: { alias: 'Production', units: 'short tons' } },
        },
      },
      'coal/facet/stateId': {
        response: { totalFacets: 1, facets: [{ id: 'WY', name: 'Wyoming' }] },
      },
    });
    const ctx = createMockContext();
    await getEiaApiService().describe('coal', ctx);
    paths.length = 0;

    await getEiaApiService().query('coal', { columns: ['period', 'stateId', 'production'] }, ctx);

    expect(paths).toEqual(['coal/data']);
    expect(dataColumnsSent(urls)).toEqual([['production']]);
  });

  it('keeps a describe that lands while the query-path metadata fetch is in flight', async () => {
    const COAL_META = {
      response: {
        id: 'coal',
        facets: [{ id: 'stateId', description: 'State' }],
        data: { production: { alias: 'Production', units: 'short tons' } },
      },
    };
    const held = Promise.withResolvers<void>();
    const queryMetadataRequested = Promise.withResolvers<void>();
    let metadataRequests = 0;
    const paths: string[] = [];
    const urls: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        const path = url.pathname.replace(/^\/v2\/?/, '').replace(/\/$/, '');
        paths.push(path);
        urls.push(url);
        if (path === 'coal') {
          // The query's request is held until the describe has landed.
          if (++metadataRequests === 1) {
            queryMetadataRequested.resolve();
            await held.promise;
          }
          return httpResponse({ body: COAL_META });
        }
        if (path === 'coal/facet/stateId') {
          return httpResponse({
            body: { response: { totalFacets: 1, facets: [{ id: 'WY', name: 'Wyoming' }] } },
          });
        }
        if (path === 'coal/data') return httpResponse({ body: DATA_PAGE });
        return httpResponse({ status: 404, body: { error: 'not found' } });
      }),
    );
    const ctx = createMockContext();

    // No columns, and neither the incomplete node nor a describe holds the
    // route: the query falls back to fetching the route metadata.
    const query = getEiaApiService().query('coal', {}, ctx);
    await queryMetadataRequested.promise;
    const described = await getEiaApiService().describe('coal', ctx);
    expect(described.unfetchedFacets).toBeUndefined();
    expect(metadataRequests).toBe(2);

    held.resolve();
    await query;
    expect(dataColumnsSent(urls)).toEqual([['production']]);

    // The complete describe entry survived the query's late write.
    paths.length = 0;
    const again = await getEiaApiService().describe('coal', ctx);
    expect(paths).toEqual([]);
    expect(again.unfetchedFacets).toBeUndefined();
    expect(again.facets[0]?.values).toEqual([{ id: 'WY', name: 'Wyoming' }]);
  });
});

// ------------------------------------------------------------------
// #59 — a `/facet/{id}` request that fails past its retries is recorded on the
// cached metadata, never cached as an empty facet; the next describe re-fetches
// that list alone, and `eia_describe_route` names it in `unavailable_facets`.
// ------------------------------------------------------------------

describe('EiaApiService.describe — a facet value list that fails past its retries (#59)', () => {
  const ROUTE = 'alpha';

  const ALPHA_META = {
    id: 'alpha',
    name: 'Alpha',
    description: 'Alpha leaf',
    facets: [
      { id: 'good', description: 'Good facet' },
      { id: 'bad', description: 'Bad facet' },
      { id: 'empty', description: 'Empty facet' },
    ],
    frequency: [{ id: 'annual', description: 'Annual', query: 'A', format: 'YYYY' }],
    data: { price: { alias: 'Price', units: 'cents' } },
    defaultFrequency: 'annual',
    defaultDateFormat: 'YYYY',
  };

  type BadLeg = 'unavailable' | 'rate-limited' | 'healthy' | 'cancelled';

  /**
   * The `alpha` leaf's metadata and facet endpoints. `good` and `empty` always
   * answer (one value, none); `bad` answers as `state.bad` says. Records every
   * path requested.
   */
  function stubAlpha(state: { bad: BadLeg; controller?: AbortController }) {
    const hits: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const path = new URL(String(input)).pathname.replace(/^\/v2\/?/, '').replace(/\/$/, '');
        hits.push(path);
        if (path === ROUTE) return Response.json({ response: ALPHA_META });
        if (path === `${ROUTE}/facet/good`) {
          return Response.json({
            response: { totalFacets: 1, facets: [{ id: 'G1', name: 'Golf one' }] },
          });
        }
        if (path === `${ROUTE}/facet/empty`) {
          return Response.json({ response: { totalFacets: 0, facets: [] } });
        }
        if (path === `${ROUTE}/facet/bad`) {
          switch (state.bad) {
            case 'healthy':
              return Response.json({
                response: {
                  totalFacets: 2,
                  facets: [
                    { id: 'B1', name: 'Bravo one' },
                    { id: 'B2', name: 'Bravo two' },
                  ],
                },
              });
            case 'rate-limited':
              return Response.json({ error: 'OVER_RATE_LIMIT' }, { status: 429 });
            case 'cancelled':
              state.controller?.abort();
              throw new DOMException('The operation was aborted.', 'AbortError');
            default:
              return Response.json({ error: 'upstream unavailable' }, { status: 503 });
          }
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      }),
    );
    return hits;
  }

  /** Settle a call while running out the retry backoff on the fake clock. */
  async function settle<T>(call: () => Promise<T>): Promise<T> {
    const pending = call();
    pending.catch(() => undefined);
    await vi.runAllTimersAsync();
    return pending;
  }

  const countOf = (hits: string[], path: string) => hits.filter((h) => h === path).length;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('EIA_API_KEY', 'test-key');
    vi.stubEnv('EIA_BASE_URL', 'https://api.eia.gov/v2');
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
    initEiaApiService();
    initRouteCache([{ ...ALPHA_META }], []);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
  });

  it('records the failed list on the cached metadata rather than caching it as empty', async () => {
    const hits = stubAlpha({ bad: 'unavailable' });

    const meta = await settle(() => getEiaApiService().describe(ROUTE, createMockContext()));

    // The retry budget ran out on the one leg; the others carry their values.
    expect(countOf(hits, `${ROUTE}/facet/bad`)).toBe(4);
    expect(meta.unfetchedFacets).toEqual(['bad']);
    expect(meta.facets.map((f) => [f.id, f.values.length])).toEqual([
      ['good', 1],
      ['bad', 0],
      ['empty', 0],
    ]);
  });

  it('re-fetches only the failed list on the next describe, and indexes its values', async () => {
    const state: { bad: BadLeg } = { bad: 'unavailable' };
    const hits = stubAlpha(state);
    const ctx = createMockContext();
    await settle(() => getEiaApiService().describe(ROUTE, ctx));

    state.bad = 'healthy';
    hits.length = 0;
    const meta = await settle(() => getEiaApiService().describe(ROUTE, ctx));

    expect(hits).toEqual([`${ROUTE}/facet/bad`]);
    expect(meta.unfetchedFacets).toBeUndefined();
    expect(meta.facets.map((f) => f.id)).toEqual(['good', 'bad', 'empty']);
    expect(meta.facets[1]?.values).toEqual([
      { id: 'B1', name: 'Bravo one' },
      { id: 'B2', name: 'Bravo two' },
    ]);
    expect(searchRoutes('Bravo two', 5)[0]?.entry.filter_hint).toEqual({ bad: 'B2' });

    // Complete now: a third describe is served from the cache.
    hits.length = 0;
    await settle(() => getEiaApiService().describe(ROUTE, ctx));
    expect(hits).toEqual([]);
  });

  it('keeps the list recorded while it still fails, trying only that leg', async () => {
    const hits = stubAlpha({ bad: 'unavailable' });
    const ctx = createMockContext();
    await settle(() => getEiaApiService().describe(ROUTE, ctx));

    hits.length = 0;
    const meta = await settle(() => getEiaApiService().describe(ROUTE, ctx));

    expect(new Set(hits)).toEqual(new Set([`${ROUTE}/facet/bad`]));
    expect(meta.unfetchedFacets).toEqual(['bad']);
  });

  it('repairs several recorded lists independently, keeping facet order', async () => {
    const bodies: Record<string, unknown> = {
      [ROUTE]: { response: ALPHA_META },
      [`${ROUTE}/facet/good`]: {
        response: { totalFacets: 1, facets: [{ id: 'G1', name: 'Golf' }] },
      },
    };
    // `bad` and `empty` both 404 on the first describe — a definitive refusal,
    // so each fails at once rather than after the retry budget.
    const { paths } = stubApiPaths(bodies);
    const ctx = createMockContext();
    const first = await settle(() => getEiaApiService().describe(ROUTE, ctx));
    expect(first.unfetchedFacets).toEqual(['bad', 'empty']);

    bodies[`${ROUTE}/facet/empty`] = { response: { totalFacets: 0, facets: [] } };
    paths.length = 0;
    const second = await settle(() => getEiaApiService().describe(ROUTE, ctx));

    expect(new Set(paths)).toEqual(new Set([`${ROUTE}/facet/bad`, `${ROUTE}/facet/empty`]));
    expect(second.unfetchedFacets).toEqual(['bad']);
    expect(second.facets.map((f) => f.id)).toEqual(['good', 'bad', 'empty']);
  });

  it.each([
    [
      'the first describe',
      false,
      [ROUTE, `${ROUTE}/facet/good`, `${ROUTE}/facet/bad`, `${ROUTE}/facet/empty`],
    ],
    ['the describe that repairs a recorded list', true, [`${ROUTE}/facet/bad`]],
  ])(
    'propagates a caller cancellation during %s instead of a degraded success',
    async (_, repair, refetched) => {
      const state: { bad: BadLeg; controller?: AbortController } = { bad: 'unavailable' };
      const hits = stubAlpha(state);
      if (repair) await settle(() => getEiaApiService().describe(ROUTE, createMockContext()));

      const controller = new AbortController();
      state.bad = 'cancelled';
      state.controller = controller;
      const ctx = createMockContext({ signal: controller.signal });

      // The abort itself, not a facet_unavailable built from it.
      await expect(settle(() => getEiaApiService().describe(ROUTE, ctx))).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(hits.filter((h) => h === `${ROUTE}/facet/bad`)).toHaveLength(repair ? 5 : 1);

      // The cancelled call cached nothing: an uncancelled describe re-requests
      // every leg it left pending — the whole fan-out on a first describe, the
      // recorded list on a repair — rather than answering from the cache.
      state.bad = 'healthy';
      hits.length = 0;
      const meta = await settle(() => getEiaApiService().describe(ROUTE, createMockContext()));
      expect(new Set(hits)).toEqual(new Set(refetched));
      expect(meta.unfetchedFacets).toBeUndefined();
      expect(meta.facets.find((f) => f.id === 'bad')?.values).toHaveLength(2);
    },
  );

  describe('through eia_describe_route', () => {
    it('leaves the failed facet out of facets[] and names it in unavailable_facets', async () => {
      stubAlpha({ bad: 'unavailable' });

      const result = await settle(() => runToolContract(describeRouteTool, { route: ROUTE }));

      expect(result.isError).not.toBe(true);
      const out = result.structuredContent as {
        facets: Array<{ id: string; value_count: number }>;
        unavailable_facets?: string[];
        notice?: string;
      };
      expect(out.facets.map((f) => [f.id, f.value_count])).toEqual([
        ['good', 1],
        ['empty', 0],
      ]);
      expect(out.unavailable_facets).toEqual(['bad']);
      expect(out.notice).toContain('bad');
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toMatch(/Unavailable facets[^\n]*bad/);
      // A facet whose endpoint answered with no values is empty, not unavailable.
      expect(text).toContain('- **empty** (0 values)');
    });

    it('omits unavailable_facets once every list is in hand', async () => {
      stubAlpha({ bad: 'healthy' });

      const result = await settle(() => runToolContract(describeRouteTool, { route: ROUTE }));

      expect(result.structuredContent).not.toHaveProperty('unavailable_facets');
      expect(result.structuredContent).not.toHaveProperty('notice');
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).not.toContain('Unavailable');
    });

    it.each([
      ['unavailable', JsonRpcErrorCode.ServiceUnavailable, 'facet_unavailable'],
      ['rate-limited', JsonRpcErrorCode.ServiceUnavailable, 'rate_limited'],
    ] as const)(
      'fails a facet input whose list is %s retryably, never as facet_not_found',
      async (bad, code, reason) => {
        stubAlpha({ bad });

        const result = await settle(() =>
          runToolContract(describeRouteTool, { route: ROUTE, facet: 'bad' }),
        );

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code,
            data: { reason, retryable: true, recovery: { hint: expect.any(String) } },
          },
        });
      },
    );

    it('re-fetches the named list on a later call and pages it once it answers', async () => {
      const state: { bad: BadLeg } = { bad: 'unavailable' };
      const hits = stubAlpha(state);
      await settle(() => runToolContract(describeRouteTool, { route: ROUTE }));

      // Still failing: the cache-hit path retries the leg and fails the call.
      hits.length = 0;
      const failed = await settle(() =>
        runToolContract(describeRouteTool, { route: ROUTE, facet: 'bad' }),
      );
      expect(failed.structuredContent).toMatchObject({
        error: { data: { reason: 'facet_unavailable' } },
      });
      expect(new Set(hits)).toEqual(new Set([`${ROUTE}/facet/bad`]));

      state.bad = 'healthy';
      const result = await settle(() =>
        runToolContract(describeRouteTool, { route: ROUTE, facet: 'bad' }),
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        facets: [{ id: 'bad', value_count: 2 }],
      });
      expect(result.structuredContent).not.toHaveProperty('unavailable_facets');
    });
  });
});

// ------------------------------------------------------------------
// #53 — EIA's own docs write routes as `/v2/electricity/retail-sales/`, so
// those spellings reach the tools verbatim. All three route-taking methods
// normalize before resolving, or one route is three cache entries and browse
// rejects a path the other two accept.
// ------------------------------------------------------------------

describe('EiaApiService — route path normalization (#53)', () => {
  const CANONICAL = 'electricity/retail-sales';
  const VARIANTS = [
    `/${CANONICAL}`,
    `${CANONICAL}/`,
    `/${CANONICAL}/`,
    'electricity//retail-sales',
    ` ${CANONICAL} `,
  ];

  /** Leaf metadata for the canonical path only — a variant that leaks through 404s. */
  const LEAF_META = {
    [CANONICAL]: {
      response: {
        id: 'electricity',
        name: 'Retail sales',
        description: 'Retail electricity sales',
        facets: [],
        frequency: [{ id: 'monthly', description: 'Monthly', query: 'monthly', format: 'YYYY-MM' }],
        data: { price: { alias: 'Price', units: 'cents per kilowatt-hour' } },
        startPeriod: '2001-01',
        endPeriod: '2024-11',
        defaultFrequency: 'monthly',
        defaultDateFormat: 'YYYY-MM',
      },
    },
  };

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

  it('browses every spelling of a leaf path the way it browses the canonical one', async () => {
    stubApiPaths({});
    const ctx = createMockContext();

    for (const variant of VARIANTS) {
      const result = await getEiaApiService().browse(variant, ctx);
      expect(result).toEqual({ path: CANONICAL, children: [], isLeaf: true });
    }
  });

  it('browses every spelling of a category path', async () => {
    stubApiPaths({});
    const ctx = createMockContext();

    for (const variant of ['/electricity', 'electricity/', '/electricity/']) {
      const result = await getEiaApiService().browse(variant, ctx);
      expect(result.path).toBe('electricity');
      expect(result.isLeaf).toBe(false);
      expect(result.children.map((c) => c.route)).toEqual([CANONICAL]);
    }
  });

  it('describes every spelling from one cache entry and one facet fan-out', async () => {
    const { paths } = stubApiPaths(LEAF_META);
    const ctx = createMockContext();

    for (const variant of [CANONICAL, ...VARIANTS]) {
      const meta = await getEiaApiService().describe(variant, ctx);
      // The metadata carries the canonical spelling, which is what the tool
      // echoes back for the caller to reuse.
      expect(meta.route).toBe(CANONICAL);
    }

    // Six spellings, one upstream fetch — the defect was three spellings
    // costing three full facet fan-outs against EIA.
    expect(paths).toEqual([CANONICAL]);
  });

  it('queries every spelling against the canonical upstream path', async () => {
    const { fetchMock } = stubDataEndpoint({ total: 4 });
    const ctx = createMockContext();

    for (const variant of VARIANTS) {
      const result = await getEiaApiService().query(
        variant,
        { columns: ['price'], length: 2 },
        ctx,
      );
      expect(result.route).toBe(CANONICAL);
      expect(result.data).toHaveLength(2);
    }

    for (const call of fetchMock.mock.calls) {
      expect(new URL(String(call[0])).pathname).toBe(`/v2/${CANONICAL}/data/`);
    }
  });

  it('fails a category spelling from the cached pre-flight rather than a live fetch', async () => {
    const { fetchMock } = stubDataEndpoint({ total: 4 });
    const ctx = createMockContext();

    for (const variant of ['/electricity', 'electricity/', '/electricity/']) {
      await expect(
        getEiaApiService().query(variant, { columns: ['price'] }, ctx),
      ).rejects.toMatchObject({ data: { reason: 'route_not_queryable' } });
    }

    // The pre-flight reads the node map, which only the canonical spelling used
    // to hit — every variant used to cost an upstream round trip to learn the
    // same thing.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

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
      'seds/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
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
      'seds/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
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

  it("indexes seds's stateId values on describe, but none of its 968 seriesId values", async () => {
    initRouteCache(
      [
        {
          id: 'seds',
          name: 'State Energy Data System (SEDS)',
          facets: [
            { id: 'seriesId', description: 'Unique series identifier' },
            { id: 'stateId', description: 'State' },
          ],
          frequency: [],
          data: {},
        },
      ],
      [],
    );
    const seriesValues = Array.from({ length: 968 }, (_, i) => ({
      id: `S${i}B`,
      name: `Series ${i}`,
    }));
    stubApiPaths({
      seds: {
        response: {
          id: 'seds',
          name: 'State Energy Data System (SEDS)',
          facets: [
            { id: 'seriesId', description: 'Unique series identifier' },
            { id: 'stateId', description: 'State' },
          ],
          frequency: [{ id: 'annual', description: 'Annual', query: 'A', format: 'YYYY' }],
          data: { value: { alias: 'Value', units: '' } },
        },
      },
      'seds/facet/seriesId': { response: { totalFacets: 968, facets: seriesValues } },
      'seds/facet/stateId': {
        response: {
          totalFacets: 2,
          facets: [
            { id: 'TX', name: 'Texas' },
            { id: 'WA', name: 'Washington' },
          ],
        },
      },
    });

    await getEiaApiService().describe('seds', createMockContext());

    const sedsEntries = getIndexEntries().filter((e) => e.filter_hint);
    expect(sedsEntries.map((e) => e.filter_hint)).toEqual([{ stateId: 'TX' }, { stateId: 'WA' }]);
  });
});

/**
 * EIA's two null shapes in `/facet/{id}` mean different things: a null `id` is
 * not a filter value, a missing `name` is only a missing label. These run the
 * real service under `eia_describe_route` — the caller-visible surface — so the
 * assertions cover the returned window, the output contract, and the rendered
 * line rather than the service helper alone.
 */
describe('EiaApiService.describe — facet values EIA sends without a name', () => {
  const METERS = 'electricity/state-electricity-profiles/meters';

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

  /** Leaf metadata carrying one facet, whose values the caller supplies. */
  function facetFixture(route: string, facetId: string, values: unknown[]) {
    return {
      [route]: {
        response: {
          id: 'electricity',
          name: 'Meters',
          description: 'Advanced metering counts',
          facets: [{ id: facetId, description: 'Meter Technology' }],
          frequency: [],
          data: { meters: { alias: 'Meter Count', units: 'number of meters' } },
        },
      },
      [`${route}/facet/${facetId}`]: {
        response: { totalFacets: values.length, facets: values },
      },
    };
  }

  /** Drive the real service through the tool the way a client reaches it. */
  async function describeThroughTool(route: string, facetId?: string) {
    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route, ...(facetId && { facet: facetId }) });
    const result = await describeRouteTool.handler(input, ctx);
    return {
      result,
      // The schema declares id/name as non-null strings — #12's failure mode.
      parsed: describeRouteTool.output.parse(result),
      text: (describeRouteTool.format!(result)[0] as { text: string }).text,
    };
  }

  /** `technology` on the meters route: every value omits `name`, all carry an alias. */
  const TECHNOLOGY_VALUES = [
    { id: 'Automatic Meter Reading', alias: 'Automated Meter Reading (AMR)' },
    { id: 'Standard meters', alias: 'Standard (non-AMR/AMI) Meters' },
    { id: 'Advanced Meter Infrastructure', alias: 'Advanced Metering Infrastructure (AMI)' },
    { id: 'All meters', alias: 'All meters' },
  ];

  it('keeps a facet whose values all omit name, labelling each from its alias', async () => {
    stubApiPaths(facetFixture(METERS, 'technology', TECHNOLOGY_VALUES));

    const { result, text } = await describeThroughTool(METERS);

    const technology = result.facets[0];
    expect(technology?.id).toBe('technology');
    expect(technology?.value_count).toBe(4);
    expect(technology?.values).toEqual([
      {
        id: 'Automatic Meter Reading',
        name: 'Automated Meter Reading (AMR)',
        alias: 'Automated Meter Reading (AMR)',
      },
      {
        id: 'Standard meters',
        name: 'Standard (non-AMR/AMI) Meters',
        alias: 'Standard (non-AMR/AMI) Meters',
      },
      {
        id: 'Advanced Meter Infrastructure',
        name: 'Advanced Metering Infrastructure (AMI)',
        alias: 'Advanced Metering Infrastructure (AMI)',
      },
      { id: 'All meters', name: 'All meters', alias: 'All meters' },
    ]);

    // The rendered line names the filter vocabulary rather than "(0 values)",
    // and the alias-suppression rule keeps the label from printing twice.
    expect(text).toContain('**technology** (4 values)');
    expect(text).toContain('Advanced Meter Infrastructure=Advanced Metering Infrastructure (AMI),');
    expect(text).not.toContain('(AMI) (Advanced Metering Infrastructure (AMI))');
  });

  it('labels a value from its own name when EIA supplies both a name and an alias', async () => {
    // Most of the taxonomy carries both, and the alias restates the pair rather
    // than replacing the name. Taking the alias first still renders a plausible
    // line, so the order is only pinned by a value whose two labels differ.
    stubApiPaths(
      facetFixture(METERS, 'technology', [
        { id: 'IN', name: 'Indiana', alias: '(IN) Indiana' },
        { id: 'MAT', name: 'Middle Atlantic', alias: 'Region: (MAT) Middle Atlantic' },
      ]),
    );

    const { result, text } = await describeThroughTool(METERS);

    expect(result.facets[0]?.values).toEqual([
      { id: 'IN', name: 'Indiana', alias: '(IN) Indiana' },
      { id: 'MAT', name: 'Middle Atlantic', alias: 'Region: (MAT) Middle Atlantic' },
    ]);
    expect(text).toContain('IN=Indiana, MAT=Middle Atlantic (Region: (MAT) Middle Atlantic)');
  });

  it('drops a value with no id, keeping the ones that can filter', async () => {
    // The balancing-authority shape: a null id with a name is still unusable.
    stubApiPaths(
      facetFixture(METERS, 'technology', [
        { id: null, name: 'Hawaiian Electric Co Inc', alias: '() Hawaiian Electric Co Inc' },
        { id: 'PJM', name: 'PJM Interconnection, LLC', alias: 'PJM: PJM Interconnection, LLC' },
      ]),
    );

    const { result } = await describeThroughTool(METERS);

    expect(result.facets[0]?.value_count).toBe(1);
    expect(result.facets[0]?.values.map((v) => v.id)).toEqual(['PJM']);
  });

  it('drops a value whose id and name are both null', async () => {
    stubApiPaths(
      facetFixture(METERS, 'technology', [
        { id: 'MBBL', name: 'millions barrels' },
        { id: null, name: null },
      ]),
    );

    const { result } = await describeThroughTool(METERS);

    expect(result.facets[0]?.values).toEqual([{ id: 'MBBL', name: 'millions barrels' }]);
  });

  it('falls back to the id when EIA supplies neither a name nor an alias', async () => {
    stubApiPaths(facetFixture(METERS, 'technology', [{ id: 'AMI' }, { id: 'AMR', name: null }]));

    const { result, text } = await describeThroughTool(METERS);

    expect(result.facets[0]?.values).toEqual([
      { id: 'AMI', name: 'AMI' },
      { id: 'AMR', name: 'AMR' },
    ]);
    expect(text).toContain('AMI=AMI, AMR=AMR');
  });

  it('describes an international-shaped facet without a schema failure (#12)', async () => {
    const ROUTE = 'international';
    stubApiPaths(
      facetFixture(ROUTE, 'dataFlagId', [
        { id: '1', name: 'Data are unavailable (permanently)' },
        { id: '11', name: 'Data row has been initialized' },
        { id: null, name: null },
      ]),
    );

    const { result, parsed } = await describeThroughTool(ROUTE);

    // The null pair that used to throw `expected string, received null` is gone,
    // and everything that reaches the schema is a string.
    expect(parsed.facets[0]?.value_count).toBe(2);
    expect(result.facets[0]?.values.map((v) => v.id)).toEqual(['1', '11']);
  });

  it('indexes an alias-labelled value under the id that filters', async () => {
    stubApiPaths(facetFixture(METERS, 'technology', TECHNOLOGY_VALUES));
    const before = getIndexSize();

    await describeThroughTool(METERS);

    expect(getIndexSize()).toBe(before + 4);
    const [hit] = searchRoutes('advanced metering infrastructure', 5);
    expect(hit?.entry.route).toBe(METERS);
    expect(hit?.entry.filter_hint).toEqual({ technology: 'Advanced Meter Infrastructure' });
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
      'seds/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
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
      'seds/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
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
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
  });

  it('answers from what is indexed when a pass outlasts the budget', async () => {
    // Only the clock the budget reads is faked, so the deadline passes when the
    // test moves it — after the tree has landed — never because a loaded
    // machine took longer than the budget to build the tree.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const steoRequested = Promise.withResolvers<void>();
    const steoHeld = Promise.withResolvers<void>();
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
      'seds/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const path = new URL(String(input)).pathname.replace(/^\/v2\/?/, '').replace(/\/$/, '');
        if (path === 'steo/facet/seriesId') {
          steoRequested.resolve();
          await steoHeld.promise;
        }
        return httpResponse({ body: bodies[path] });
      }),
    );

    const warmed = getEiaApiService().ensureIndexWarmed(createMockContext(), 25);
    // The index passes start only once the tree is in hand.
    await steoRequested.promise;
    await vi.advanceTimersByTimeAsync(25);
    await warmed;

    // The tree landed, so the answer is real — it is just short one pass, and
    // says which one rather than reporting a settled corpus.
    const status = getIndexStatus();
    expect(status.complete).toBe(false);
    expect(status.pendingPasses).toEqual(['steo_series']);
    expect(searchRoutes('retail sales', 5)[0]?.entry.route).toBe('electricity/retail-sales');

    steoHeld.resolve();
  });

  it('still surfaces a failed tree build rather than answering empty', async () => {
    stubApiPaths({});

    await expect(
      getEiaApiService().ensureIndexWarmed(createMockContext(), 5_000),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'EIA API error: not found',
    });
  });
});

// ------------------------------------------------------------------
// #67 — the warm is shared by every caller, so it cannot run under the signal
// of the request that happened to start it. Stateless HTTP aborts each
// request's signal as its response is sent; a cold browse used to take the
// index passes down with it, and the settled warm was never retried.
// ------------------------------------------------------------------

/** A taxonomy small enough to read, carrying every index pass's targets. */
function warmBodies(): Record<string, unknown> {
  return {
    '': {
      response: {
        routes: [
          {
            id: 'electricity',
            name: 'Electricity',
            routes: [
              {
                id: 'retail-sales',
                name: 'Retail Sales',
                facets: [{ id: 'sectorid', description: 'Sector' }],
                frequency: [],
                data: {},
              },
              {
                id: 'operating-generator-capacity',
                name: 'Operating Generator Capacity',
                facets: [{ id: 'energy_source_code', description: 'Energy Source' }],
                frequency: [],
                data: {},
              },
            ],
          },
        ],
      },
    },
    'steo/facet/seriesId': {
      response: { totalFacets: 1, facets: [{ id: 'BREPUUS', name: 'Brent crude oil spot price' }] },
    },
    'seds/facet/seriesId': {
      response: {
        totalFacets: 1,
        facets: [{ id: 'MGTCB', name: 'Motor gasoline total consumption' }],
      },
    },
    'electricity/retail-sales/facet/sectorid': {
      response: { totalFacets: 1, facets: [{ id: 'RES', name: 'residential' }] },
    },
    'electricity/operating-generator-capacity/facet/energy_source_code': {
      response: { totalFacets: 1, facets: [{ id: 'WND', name: 'wind' }] },
    },
  };
}

/**
 * `stubApiPaths`, with two additions real `fetch` has and the warm depends on:
 * a request honours the `signal` it was handed, and any path can be held open
 * until the test releases it. Records the signal each path was fetched under,
 * and resolves `requested(path)` the moment that path is first fetched.
 */
function stubHeldApiPaths(bodies: Record<string, unknown>) {
  const paths: string[] = [];
  const signals = new Map<string, AbortSignal | undefined>();
  const holds = new Map<string, Promise<void>>();
  const arrivals = new Map<string, PromiseWithResolvers<void>>();
  const arrival = (path: string) => {
    let entry = arrivals.get(path);
    if (!entry) {
      entry = Promise.withResolvers<void>();
      arrivals.set(path, entry);
    }
    return entry;
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace(/^\/v2\/?/, '').replace(/\/$/, '');
      paths.push(path);
      const signal = init?.signal ?? undefined;
      signals.set(path, signal);
      arrival(path).resolve();
      const hold = holds.get(path);
      if (hold) {
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason);
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          hold.then(resolve);
        });
      }
      signal?.throwIfAborted();
      const body = bodies[path];
      if (body === undefined) return httpResponse({ status: 404, body: { error: 'not found' } });
      return httpResponse({ body });
    }),
  );

  return {
    paths,
    signals,
    /** Resolves once `path` has been fetched — at once if it already was. */
    requested: (path: string): Promise<void> => arrival(path).promise,
    /** Hold `path` open; the returned function releases it. */
    hold(path: string): () => void {
      let release: () => void = () => {};
      holds.set(
        path,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        holds.delete(path);
        release();
      };
    },
  };
}

describe('EiaApiService — the warm outlives the request that started it (#67)', () => {
  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    vi.stubEnv('EIA_BASE_URL', 'https://api.eia.gov/v2');
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
    initEiaApiService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
  });

  it('completes the index passes after the browse that started them has ended', async () => {
    const api = stubHeldApiPaths(warmBodies());
    const releaseSteo = api.hold('steo/facet/seriesId');
    const controller = new AbortController();

    await getEiaApiService().browse(
      'electricity',
      createMockContext({ signal: controller.signal }),
    );
    // Stateless HTTP aborts the request's signal as soon as its response is sent.
    await api.requested('steo/facet/seriesId');
    controller.abort(new Error('Connection closed'));
    releaseSteo();

    const { status, results } = await getEiaApiService().search(
      'Brent crude oil spot price',
      5,
      createMockContext(),
    );

    expect(status.complete).toBe(true);
    expect(status.pendingPasses).toEqual([]);
    expect(results[0]?.entry.filter_hint).toEqual({ seriesId: 'BREPUUS' });
  });

  it('runs every warm fetch under a signal no request owns', async () => {
    const api = stubHeldApiPaths(warmBodies());
    const ctx = createMockContext({ signal: new AbortController().signal });

    await getEiaApiService().search('wind', 5, ctx);

    // One signal, the service's own, carries the whole warm.
    const warmSignal = api.signals.get('');
    expect(warmSignal).toBeInstanceOf(AbortSignal);
    expect(warmSignal).not.toBe(ctx.signal);
    expect(warmSignal?.aborted).toBe(false);
    for (const path of [
      'steo/facet/seriesId',
      'seds/facet/seriesId',
      'electricity/retail-sales/facet/sectorid',
    ]) {
      expect(api.signals.get(path), path).toBe(warmSignal);
    }
  });

  it('rejects only the caller that cancelled while the tree was building', async () => {
    const api = stubHeldApiPaths(warmBodies());
    const releaseRoot = api.hold('');
    const cancelling = new AbortController();

    const browse = getEiaApiService().browse(
      'electricity',
      createMockContext({ signal: cancelling.signal }),
    );
    const search = getEiaApiService().search('residential', 5, createMockContext());
    await api.requested('');

    cancelling.abort(new Error('Connection closed'));
    await expect(browse).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });

    releaseRoot();
    const { status, results } = await search;
    expect(status.complete).toBe(true);
    expect(results[0]?.entry.filter_hint).toEqual({ sectorid: 'RES' });
  });

  it('rejects a search whose caller cancels while it waits on the index', async () => {
    const api = stubHeldApiPaths(warmBodies());
    const releaseSteo = api.hold('steo/facet/seriesId');
    const cancelling = new AbortController();

    const search = getEiaApiService().search(
      'wind',
      5,
      createMockContext({ signal: cancelling.signal }),
    );
    await api.requested('steo/facet/seriesId');
    cancelling.abort(new Error('client cancelled'));

    await expect(search).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    // The pass the cancelled search was waiting on is still running for everyone else.
    expect(api.signals.get('steo/facet/seriesId')?.aborted).toBe(false);
    releaseSteo();
    const { status } = await getEiaApiService().search('wind', 5, createMockContext());
    expect(status.complete).toBe(true);
  });

  it('re-runs only the STEO pass on the next search after it failed', async () => {
    const bodies = warmBodies();
    const steo = bodies['steo/facet/seriesId'];
    delete bodies['steo/facet/seriesId'];
    const api = stubHeldApiPaths(bodies);

    const first = await getEiaApiService().search('wind', 5, createMockContext());
    expect(first.status.pendingPasses).toEqual(['steo_series']);

    bodies['steo/facet/seriesId'] = steo;
    const fetchedBefore = api.paths.length;
    const second = await getEiaApiService().search('Brent crude', 5, createMockContext());

    expect(api.paths.slice(fetchedBefore)).toEqual(['steo/facet/seriesId']);
    expect(second.status.complete).toBe(true);
    expect(second.status.pendingPasses).toEqual([]);
    expect(second.results[0]?.entry.filter_hint).toEqual({ seriesId: 'BREPUUS' });
  });

  it('re-fetches only the facet targets that failed, and clears the gap when they land', async () => {
    const bodies = warmBodies();
    const windPath = 'electricity/operating-generator-capacity/facet/energy_source_code';
    const wind = bodies[windPath];
    delete bodies[windPath];
    const api = stubHeldApiPaths(bodies);

    const first = await getEiaApiService().search('residential', 5, createMockContext());
    expect(first.status.pendingPasses).toEqual(['facet_values']);
    expect(searchRoutes('wind', 5).some((r) => r.entry.filter_hint)).toBe(false);

    // Still failing: the retry re-fetches the one target, and the gap stays.
    const fetchedBeforeRetry = api.paths.length;
    const retried = await getEiaApiService().search('wind', 5, createMockContext());
    expect(api.paths.slice(fetchedBeforeRetry)).toEqual([windPath]);
    expect(retried.status.pendingPasses).toEqual(['facet_values']);

    bodies[windPath] = wind;
    const fetchedBefore = api.paths.length;
    const second = await getEiaApiService().search('wind', 5, createMockContext());

    expect(api.paths.slice(fetchedBefore)).toEqual([windPath]);
    expect(second.status.complete).toBe(true);
    expect(second.results[0]?.entry.filter_hint).toEqual({ energy_source_code: 'WND' });
  });

  it('runs one retry for concurrent searches, not one per caller', async () => {
    const bodies = warmBodies();
    const steo = bodies['steo/facet/seriesId'];
    delete bodies['steo/facet/seriesId'];
    const api = stubHeldApiPaths(bodies);
    await getEiaApiService().search('wind', 5, createMockContext());

    bodies['steo/facet/seriesId'] = steo;
    const fetchedBefore = api.paths.length;
    const answers = await Promise.all([
      getEiaApiService().search('wind', 5, createMockContext()),
      getEiaApiService().search('residential', 5, createMockContext()),
      getEiaApiService().search('Brent', 5, createMockContext()),
    ]);

    expect(api.paths.slice(fetchedBefore)).toEqual(['steo/facet/seriesId']);
    for (const { status } of answers) expect(status.complete).toBe(true);
  });

  it('does not retry a corpus that landed in full', async () => {
    const api = stubHeldApiPaths(warmBodies());
    await getEiaApiService().search('wind', 5, createMockContext());

    const fetchedBefore = api.paths.length;
    await getEiaApiService().search('residential', 5, createMockContext());

    expect(api.paths.length).toBe(fetchedBefore);
  });

  it('logs the warm to the global logger, never to the request that started it', async () => {
    stubHeldApiPaths(warmBodies());
    const info = vi.spyOn(logger, 'info');
    const ctx = createMockContext();

    await getEiaApiService().search('wind', 5, ctx);

    const requestLog = logCalls(ctx).map((call) => call.msg);
    expect(requestLog).not.toContain('Warming EIA route tree cache');
    expect(requestLog).not.toContain('EIA search corpus warmed');
    const globalLog = info.mock.calls.map(([msg]) => msg);
    expect(globalLog).toContain('Warming EIA route tree cache');
    expect(globalLog).toContain('EIA search corpus warmed');
  });

  it('aborts the warm at shutdown', async () => {
    const api = stubHeldApiPaths(warmBodies());
    api.hold('steo/facet/seriesId');
    await getEiaApiService().browse('electricity', createMockContext());
    await api.requested('steo/facet/seriesId');

    shutdownEiaApiService();

    expect(api.signals.get('steo/facet/seriesId')?.aborted).toBe(true);
  });

  it('rebuilds the tree on the next call after a failed build', async () => {
    const bodies: Record<string, unknown> = {};
    stubApiPaths(bodies);
    await expect(
      getEiaApiService().browse('electricity', createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'EIA API error: not found',
    });

    Object.assign(bodies, warmBodies());
    const result = await getEiaApiService().browse('electricity', createMockContext());

    expect(result.children.map((c) => c.route)).toEqual([
      'electricity/retail-sales',
      'electricity/operating-generator-capacity',
    ]);
  });
});

// ------------------------------------------------------------------
// #57 — SEDS's 968 `seriesId` values are named series, like STEO's, but run
// past the 200-value bound that keeps opaque-identifier facets out of the
// index. Both reach it through the named-series allowlist, each as its own pass.
// ------------------------------------------------------------------

describe('EiaApiService — named-series facets indexed whole (#57)', () => {
  const SEDS_PATH = 'seds/facet/seriesId';

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

  /** Run eia_search_routes the way a client reaches it and return both surfaces. */
  async function searchThroughTool(query: string) {
    const result = await runToolContract(searchRoutesTool, { query });
    const structured = result.structuredContent as Record<string, unknown> & {
      results: Array<{ route: string; filter_hint?: Record<string, string> }>;
    };
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    return { structured, text };
  }

  /** How many indexed entries filter on `facetId`. */
  function entriesFiltering(facetId: string): number {
    return getIndexEntries().filter((e) => e.filter_hint?.[facetId] !== undefined).length;
  }

  it('indexes a STEO series in the shape it has always had', async () => {
    stubHeldApiPaths(warmBodies());

    await getEiaApiService().search('Brent', 5, createMockContext());

    expect(getIndexEntries().find((e) => e.route === 'steo')).toEqual({
      route: 'steo',
      name: 'Brent crude oil spot price',
      description: 'STEO series: Brent crude oil spot price (BREPUUS)',
      isLeaf: true,
      category: 'steo',
      filter_hint: { seriesId: 'BREPUUS' },
    });
  });

  it('answers a SEDS series name with the seds route and its seriesId, on both surfaces', async () => {
    const api = stubHeldApiPaths(warmBodies());

    const { structured, text } = await searchThroughTool('motor gasoline total consumption');

    expect(structured.results[0]).toMatchObject({
      route: 'seds',
      name: 'Motor gasoline total consumption',
      description: 'SEDS series: Motor gasoline total consumption (MGTCB)',
      isLeaf: true,
      filter_hint: { seriesId: 'MGTCB' },
    });
    expect(structured).toMatchObject({ indexComplete: true });
    expect(structured.indexGaps).toBeUndefined();
    expect(text).toContain(
      'Query with: `eia_query_route(route="seds", filters={"seriesId": "MGTCB"})`',
    );
    // One request fetches the whole facet.
    expect(api.paths.filter((p) => p === SEDS_PATH)).toHaveLength(1);
  });

  it('fetches the SEDS facet alongside the other passes, not after them', async () => {
    const api = stubHeldApiPaths(warmBodies());
    const releaseSteo = api.hold('steo/facet/seriesId');
    const releaseSeds = api.hold(SEDS_PATH);

    const search = getEiaApiService().search('wind', 5, createMockContext());
    // Both named-series requests are in flight at once while the facet pass
    // lands; a SEDS fetch queued behind the held STEO one hangs here.
    await Promise.all(
      ['steo/facet/seriesId', SEDS_PATH, 'electricity/retail-sales/facet/sectorid'].map(
        api.requested,
      ),
    );
    releaseSteo();
    releaseSeds();

    expect((await search).status.complete).toBe(true);
  });

  it('names seds_series alone in indexGaps when its fetch fails, and keeps everything else', async () => {
    const bodies = warmBodies();
    delete bodies[SEDS_PATH];
    stubHeldApiPaths(bodies);

    const { structured, text } = await searchThroughTool('wind');

    expect(structured).toMatchObject({ indexComplete: false, indexGaps: ['seds_series'] });
    expect(text).toContain('**indexGaps:** seds_series');
    // The tree, the STEO pass, and the facet pass all landed around the gap.
    expect(getNode('electricity/retail-sales')).toMatchObject({
      id: 'retail-sales',
      name: 'Retail Sales',
    });
    expect(getIndexStatus().incompleteRoutes).toEqual([]);
    expect(searchRoutes('Brent crude oil spot price', 5)[0]?.entry.filter_hint).toEqual({
      seriesId: 'BREPUUS',
    });
    expect(structured.results[0]?.filter_hint).toEqual({ energy_source_code: 'WND' });
    expect(entriesFiltering('seriesId')).toBe(1);
  });

  it('retries only the SEDS pass on later searches until it lands', async () => {
    const bodies = warmBodies();
    const seds = bodies[SEDS_PATH];
    delete bodies[SEDS_PATH];
    const api = stubHeldApiPaths(bodies);
    await getEiaApiService().search('wind', 5, createMockContext());

    // Still failing: one request, for the SEDS facet only, and the gap stays.
    const beforeRetry = api.paths.length;
    const retried = await getEiaApiService().search('wind', 5, createMockContext());
    expect(api.paths.slice(beforeRetry)).toEqual([SEDS_PATH]);
    expect(retried.status.pendingPasses).toEqual(['seds_series']);

    bodies[SEDS_PATH] = seds;
    const beforeLanding = api.paths.length;
    const landed = await getEiaApiService().search(
      'motor gasoline total consumption',
      5,
      createMockContext(),
    );
    expect(api.paths.slice(beforeLanding)).toEqual([SEDS_PATH]);
    expect(landed.status.complete).toBe(true);
    expect(landed.results[0]?.entry.filter_hint).toEqual({ seriesId: 'MGTCB' });

    // Landed for good: nothing more to fetch.
    const beforeSettled = api.paths.length;
    await getEiaApiService().search('wind', 5, createMockContext());
    expect(api.paths.length).toBe(beforeSettled);
  });

  it('keeps a same-name SEDS pair as two entries, one per seriesId', async () => {
    const name = 'All petroleum products consumed by the commercial sector';
    stubHeldApiPaths({
      ...warmBodies(),
      [SEDS_PATH]: {
        response: {
          totalFacets: 2,
          facets: [
            { id: 'PACCB', name },
            { id: 'PACCP', name },
          ],
        },
      },
    });

    const { results } = await getEiaApiService().search(name, 5, createMockContext());

    expect(results.filter((r) => r.entry.route === 'seds').map((r) => r.entry.filter_hint)).toEqual(
      [{ seriesId: 'PACCB' }, { seriesId: 'PACCP' }],
    );
  });

  it('indexes an allowlisted facet past 200 values and leaves any other facet that size out', async () => {
    const many = (prefix: string) =>
      Array.from({ length: 201 }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix} item ${i}` }));
    stubHeldApiPaths({
      ...warmBodies(),
      [SEDS_PATH]: { response: { totalFacets: 201, facets: many('SEDS') } },
      // A vocabulary facet the warm fetches, but too large to be vocabulary.
      'electricity/operating-generator-capacity/facet/energy_source_code': {
        response: { totalFacets: 201, facets: many('SRC') },
      },
    });

    const { status } = await getEiaApiService().search('wind', 5, createMockContext());

    expect(status.complete).toBe(true);
    expect(entriesFiltering('seriesId')).toBe(1 + 201);
    expect(entriesFiltering('energy_source_code')).toBe(0);
  });

  it('settles an empty SEDS facet as landed, adding nothing', async () => {
    stubHeldApiPaths({
      ...warmBodies(),
      [SEDS_PATH]: { response: { totalFacets: 0, facets: [] } },
    });

    const { status } = await getEiaApiService().search('wind', 5, createMockContext());

    expect(status.complete).toBe(true);
    expect(getIndexEntries().filter((e) => e.route === 'seds')).toEqual([]);
  });
});

// ------------------------------------------------------------------
// #56, #70, #55 — eia_search_routes over a real index, through the tool's
// public contract so both surfaces are asserted. `truncated` means a match
// exists past what was returned (#56); a `limit` past the 30-per-call cap is
// served at the cap and disclosed (#70); a blank query is a caller error (#55).
// ------------------------------------------------------------------

describe('eia_search_routes — truthful truncation over a real index (#56, #70, #55)', () => {
  /** Leaves under one category: exactly three `zinc` routes, forty `cobalt` ones. */
  function seedSearchCorpus() {
    const leaf = (id: string, name: string): RawRouteNode => ({
      id,
      name,
      frequency: [],
      facets: [],
      data: {},
    });
    initRouteCache(
      [
        {
          id: 'metals',
          name: 'Metals',
          routes: [
            leaf('zinc-a', 'Zinc Alpha'),
            leaf('zinc-b', 'Zinc Beta'),
            leaf('zinc-c', 'Zinc Gamma'),
            ...Array.from({ length: 40 }, (_, i) => leaf(`cobalt-${i}`, `Cobalt Series ${i}`)),
          ],
        },
        { id: 'electricity', name: 'Electricity', routes: [leaf('retail-sales', 'Retail Sales')] },
      ],
      [],
    );
  }

  let fetchMock: ReturnType<typeof stubApiPaths>['fetchMock'];

  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    vi.stubEnv('EIA_BASE_URL', 'https://api.eia.gov/v2');
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
    initEiaApiService();
    seedSearchCorpus();
    ({ fetchMock } = stubApiPaths({
      'steo/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
      'seds/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
  });

  /** Run the tool the way a client reaches it and return both surfaces. */
  async function searchThroughTool(input: { query: string; limit?: number }) {
    const result = await runToolContract(searchRoutesTool, input);
    const structured = result.structuredContent as Record<string, unknown> & {
      results?: Array<{ route: string }>;
    };
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    return { result, structured, text, routes: structured.results?.map((r) => r.route) ?? [] };
  }

  it('the corpus holds exactly three zinc matches and more than thirty cobalt ones', () => {
    expect(searchRoutes('zinc', 1000)).toHaveLength(3);
    expect(searchRoutes('cobalt', 1000).length).toBeGreaterThan(30);
  });

  it('service: hasMore is false when the matches end exactly at limit', async () => {
    const { results, hasMore } = await getEiaApiService().search('zinc', 3, createMockContext());

    expect(results).toHaveLength(3);
    expect(hasMore).toBe(false);
  });

  it('service: hasMore is true when one match lies past limit', async () => {
    const { results, hasMore } = await getEiaApiService().search('zinc', 2, createMockContext());

    expect(results).toHaveLength(2);
    expect(hasMore).toBe(true);
  });

  it('reports no truncation when the matches end exactly at limit', async () => {
    const { structured, text, routes } = await searchThroughTool({ query: 'zinc', limit: 3 });

    expect(routes).toHaveLength(3);
    expect(structured).toMatchObject({ truncated: false, shown: 3, cap: 3 });
    expect(structured.notice).toBeUndefined();
    expect(text).not.toMatch(/More matches/);
  });

  it('reports truncation, on both surfaces, when a match lies past limit', async () => {
    const { structured, text, routes } = await searchThroughTool({ query: 'zinc', limit: 2 });

    expect(routes).toHaveLength(2);
    expect(structured).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    expect(structured.notice).toMatch(/^More matches exist — narrow the query or raise limit/);
    expect(text).toContain('More matches exist');
  });

  it('reports truncation at a limit of 30 when more than 30 match', async () => {
    const { structured, routes } = await searchThroughTool({ query: 'cobalt', limit: 30 });

    expect(routes).toHaveLength(30);
    expect(structured).toMatchObject({ truncated: true, shown: 30, cap: 30 });
  });

  it('serves a limit past the per-call cap at the cap, and names the cap', async () => {
    const { structured, text, routes } = await searchThroughTool({ query: 'cobalt', limit: 50 });

    expect(routes).toHaveLength(30);
    expect(structured).toMatchObject({ truncated: true, shown: 30, cap: 30 });
    expect(structured.notice).toMatch(/at most 30/);
    expect(structured.notice).not.toMatch(/raise limit/);
    expect(text).toMatch(/at most 30/);
  });

  it('returns every match, untruncated, when a limit past the cap finds few', async () => {
    const { structured, text, routes } = await searchThroughTool({ query: 'zinc', limit: 50 });

    expect(routes).toHaveLength(3);
    expect(structured).toMatchObject({ truncated: false, shown: 3, cap: 30 });
    expect(structured.notice).toBeUndefined();
    expect(text).not.toMatch(/More matches|at most 30/);
  });

  it('keeps the no-match notice, untruncated, on an empty result', async () => {
    const { structured, routes } = await searchThroughTool({ query: 'qqxjjvv', limit: 5 });

    expect(routes).toEqual([]);
    expect(structured).toMatchObject({ truncated: false, shown: 0, cap: 5 });
    expect(structured.notice).toMatch(/^No routes matched "qqxjjvv"/);
  });

  for (const limit of [0, 101]) {
    it(`rejects limit ${limit} at input validation`, async () => {
      const { result } = await searchThroughTool({ query: 'zinc', limit });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    });
  }

  for (const query of ['', '   ', '\t\n']) {
    it(`rejects the blank query ${JSON.stringify(query)} before any upstream request`, async () => {
      const { result, text } = await searchThroughTool({ query });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32602, data: { reason: 'invalid_arguments' } },
      });
      expect(fetchMock).not.toHaveBeenCalled();

      // The schema's own minimum message reads as "expected >=1 characters",
      // which contradicts a whitespace query several characters long.
      const message = 'query must contain at least one non-whitespace character';
      const error = (result.structuredContent as { error: { message: string } }).error;
      expect(error.message).toContain(message);
      expect(error).toMatchObject({ data: { recovery: { hint: `query: ${message}` } } });
      expect(text).toContain(message);
      expect(text).not.toContain('>=1 characters');
    });
  }

  it('searches a padded query as its trimmed text, and echoes the trimmed text', async () => {
    const padded = await searchThroughTool({ query: '  zinc  ' });
    const bare = await searchThroughTool({ query: 'zinc' });

    expect(padded.structured.effectiveQuery).toBe('zinc');
    expect(padded.routes).toEqual(bare.routes);
  });

  it('leaves inner whitespace alone — the terms still resolve their route', async () => {
    const { structured, routes } = await searchThroughTool({ query: 'retail   sales' });

    expect(routes[0]).toBe('electricity/retail-sales');
    expect(structured.effectiveQuery).toBe('retail   sales');
  });
});

// ------------------------------------------------------------------
// #73 — electricity/retail-sales is named "Electricity Sales to Ultimate
// Customers", so the only text carrying "retail" is its path. The STEO series
// named "Retail Sales of Electricity in …" outranked it on "retail sales".
// ------------------------------------------------------------------

describe('eia_search_routes — a query spelling a route path (#73)', () => {
  const STEO_RETAIL_SERIES = ['Residential', 'Commercial', 'Industrial', 'Transportation'].flatMap(
    (sector) =>
      ['Mountain', 'Pacific'].map((region) => ({
        id: `EL${sector.slice(0, 3).toUpperCase()}_${region.slice(0, 3).toUpperCase()}`,
        name: `Retail Sales of Electricity in ${sector} Sector, ${region}`,
      })),
  );

  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    vi.stubEnv('EIA_BASE_URL', 'https://api.eia.gov/v2');
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
    initEiaApiService();
    stubApiPaths({
      '': {
        response: {
          routes: [
            {
              id: 'electricity',
              name: 'Electricity',
              description: 'EIA electricity survey data',
              routes: [
                {
                  id: 'retail-sales',
                  name: 'Electricity Sales to Ultimate Customers',
                  description:
                    'Electricity sales to ultimate customer by state and sector (number of customers, average price, revenue, and megawatthours of sales).',
                  facets: [{ id: 'sectorid', description: 'Sector' }],
                  frequency: [],
                  data: {},
                },
              ],
            },
            { id: 'steo', name: 'Short Term Energy Outlook', facets: [], frequency: [], data: {} },
          ],
        },
      },
      'steo/facet/seriesId': {
        response: { totalFacets: STEO_RETAIL_SERIES.length, facets: STEO_RETAIL_SERIES },
      },
      'seds/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
      'electricity/retail-sales/facet/sectorid': {
        response: { totalFacets: 1, facets: [{ id: 'RES', name: 'residential' }] },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
  });

  it('answers "retail sales" with the route first, on both surfaces', async () => {
    const result = await runToolContract(searchRoutesTool, { query: 'retail sales', limit: 30 });
    const structured = result.structuredContent as {
      indexComplete: boolean;
      results: Array<{ route: string; score: number; filter_hint?: unknown }>;
    };
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');

    expect(structured.indexComplete).toBe(true);
    expect(structured.results[0]).toMatchObject({ route: 'electricity/retail-sales', score: 0 });
    expect(structured.results[0]).not.toHaveProperty('filter_hint');
    // The series still answer, behind the route.
    expect(structured.results.slice(1).some((r) => r.route === 'steo')).toBe(true);
    const firstHit = text.split('\n').find((line) => line.startsWith('['));
    expect(firstHit).toBe('[leaf] **electricity/retail-sales** (score: 0.000)');
  });
});
