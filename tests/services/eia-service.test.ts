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
import { queryRouteTool } from '@/mcp-server/tools/definitions/query-route.tool.js';
import {
  searchRoutesTool,
  WEAK_MATCH_SCORE,
} from '@/mcp-server/tools/definitions/search-routes.tool.js';
import {
  _resetEiaApiService,
  getEiaApiService,
  initEiaApiService,
  ROUTE_METADATA_TTL_MS,
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
 * Assert a tool result is the caller's own cancellation. Once the caller's
 * signal fires the framework relabels whatever the handler throws as
 * `RequestCancelled`, so the message — the caller's abort reason, carried
 * through — is what shows the service rethrew the abort instead of reporting
 * it as EIA failing or running out of time.
 */
function expectCancelledBy(result: Awaited<ReturnType<typeof runToolContract>>, reason: Error) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.RequestCancelled, message: reason.message },
  });
  expect(JSON.stringify(result)).not.toMatch(
    /upstream_|did not answer|could not reach|returned HTTP/i,
  );
}

/**
 * Fire `abort` and return what `call` settled to, failing if it had not settled
 * before the fake clock moved: the abort itself must end the call, not a
 * timeout or backoff behind it.
 */
async function settleOnAbort<T>(call: Promise<T>, abort: () => void): Promise<T> {
  let settled = false;
  call.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(settled, 'settled on the abort, before the clock moved').toBe(true);
  return call;
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

describe('cached facet diagnostics (#81)', () => {
  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    _resetServerConfig();
    _resetEiaApiService();
    _resetRouteCache();
    initEiaApiService();
    seedRouteCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    _resetEiaApiService();
    _resetRouteCache();
    _resetServerConfig();
  });

  it.each([undefined, 3, 2])(
    'uses only proven complete vocabularies (total %s)',
    async (totalFacets) => {
      const { paths, urls } = stubApiPaths({
        [LEAF]: {
          response: {
            id: 'retail-sales',
            facets: [{ id: 'stateid', description: 'State' }],
            data: { price: { alias: 'Price', units: 'cents' } },
          },
        },
        [`${LEAF}/facet/stateid`]: {
          response: {
            totalFacets,
            facets: [
              { id: 'TX', name: 'Texas' },
              { id: 'CA', name: 'California' },
            ],
          },
        },
        [`${LEAF}/data`]: {
          response: {
            total: '1',
            frequency: 'annual',
            dateFormat: 'YYYY',
            data: [{ stateid: 'TX', price: '10' }],
          },
        },
      });
      await getEiaApiService().describe(LEAF, createMockContext());
      paths.length = 0;
      const filters = { stateid: ['TX', 'ZZ', 'tx'] };
      const result = await runToolContract(queryRouteTool, { route: LEAF, filters });
      expect(paths).toEqual([`${LEAF}/data`]);
      expect(urls.at(-1)?.searchParams.getAll('facets[stateid][]')).toEqual(['TX', 'ZZ', 'tx']);
      expect(result.structuredContent).toMatchObject({ appliedFilters: filters });
      if (totalFacets === 2) {
        const expectedNotice =
          'Filter stateid values "ZZ", "tx" are not in the complete cached vocabulary. Facet values are case-sensitive; For "tx", did you mean "TX"? The submitted filter was preserved.';
        expect(result.structuredContent).toMatchObject({ notice: expectedNotice });
        expect(result.content).toContainEqual(
          expect.objectContaining({ text: expect.stringContaining(expectedNotice) }),
        );
      } else {
        expect(result.structuredContent).not.toHaveProperty('notice');
      }
    },
  );

  it.each([0, 1])(
    'composes diagnostics on an empty page with total %i using values beyond the describe window',
    async (total) => {
      vi.stubEnv('EIA_FACET_VALUE_CAP', '1');
      _resetServerConfig();
      const { paths } = stubApiPaths({
        [LEAF]: {
          response: {
            id: 'retail-sales',
            facets: [{ id: 'stateid', description: 'State' }],
            data: {},
          },
        },
        [`${LEAF}/facet/stateid`]: {
          response: {
            totalFacets: 2,
            facets: [
              { id: 'CA', name: 'California' },
              { id: 'TX', name: 'Texas' },
            ],
          },
        },
        [`${LEAF}/data`]: { response: { total: String(total), data: [] } },
      });
      const described = await runToolContract(describeRouteTool, { route: LEAF });
      expect(described.structuredContent).toMatchObject({
        facets: [{ values: [{ id: 'CA' }], value_count: 2 }],
      });
      paths.length = 0;
      const result = await runToolContract(queryRouteTool, {
        route: LEAF,
        columns: ['price'],
        filters: { stateid: ['TX', 'ZZ'] },
        offset: 4,
      });
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain(total ? 'Offset 4' : 'No rows matched');
      expect(notice).toContain('value "ZZ"');
      expect(notice).not.toContain('value "TX"');
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toContain('value "ZZ"');
      expect(text).toContain(total ? 'Offset 4' : 'No rows matched');
      expect(paths).toEqual([`${LEAF}/data`]);
    },
  );

  it('does not fetch a vocabulary to diagnose a cold query', async () => {
    const { paths } = stubApiPaths({ [`${LEAF}/data`]: { response: { total: '0', data: [] } } });
    await getEiaApiService().query(
      LEAF,
      { filters: { stateid: 'ZZ' }, columns: ['price'] },
      createMockContext(),
    );
    expect(paths).toEqual([`${LEAF}/data`]);
  });

  it.each([
    ['repeated', Array<string>(1000).fill('ZZ')],
    ['distinct', Array.from({ length: 120 }, (_, i) => `S${String(i).padStart(3, '0')}`)],
  ] as const)('keeps every %s filter value in the diagnostics', async (kind, values) => {
    const { paths, urls } = stubApiPaths({
      [LEAF]: {
        response: {
          id: 'retail-sales',
          facets: [{ id: 'stateid', description: 'State' }],
          data: {},
        },
      },
      [`${LEAF}/facet/stateid`]: {
        response: { totalFacets: 1, facets: [{ id: 'TX', name: 'Texas' }] },
      },
      [`${LEAF}/data`]: { response: { total: '0', data: [] } },
    });
    await getEiaApiService().describe(LEAF, createMockContext());
    paths.length = 0;
    const result = await runToolContract(queryRouteTool, {
      route: LEAF,
      filters: { stateid: values },
      columns: ['price'],
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { notice: string };
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    for (const value of new Set(values)) {
      expect(structured.notice).toContain(JSON.stringify(value));
      expect(text).toContain(JSON.stringify(value));
    }
    expect(urls.at(-1)?.searchParams.getAll('facets[stateid][]')).toEqual(values);
    expect(paths).toEqual([`${LEAF}/data`]);
    if (kind === 'distinct') expect(urls.at(-1)?.href.length).toBeLessThan(8192);
    else expect(structured.notice.match(/"ZZ"/g)).toHaveLength(1);
  });

  it('renders unmatched values literally while retaining raw notice data', async () => {
    const value = '`code` [link](https://example.test) <b> & _text_';
    stubApiPaths({
      [LEAF]: {
        response: {
          id: 'retail-sales',
          facets: [{ id: 'stateid', description: 'State' }],
          data: {},
        },
      },
      [`${LEAF}/facet/stateid`]: {
        response: { totalFacets: 1, facets: [{ id: 'TX', name: 'Texas' }] },
      },
      [`${LEAF}/data`]: { response: { total: '0', data: [] } },
    });
    await getEiaApiService().describe(LEAF, createMockContext());
    const result = await runToolContract(queryRouteTool, {
      route: LEAF,
      columns: ['price'],
      filters: { stateid: value },
    });
    expect((result.structuredContent as { notice: string }).notice).toContain(value);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    const noticeLine = text.split('\n').find((line) => line.startsWith('> '));
    expect(noticeLine).toContain('\\`code\\`');
    expect(noticeLine).toContain('\\[link\\]\\(https://example.test\\)');
    expect(noticeLine).toContain('&lt;b&gt; &amp;');
  });
});

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

    /**
     * #89 — at local-hourly EIA answers a bound without its UTC offset with
     * HTTP 500, never rows; it is refused before the request rather than
     * retried as an outage.
     */
    describe('local-hourly bounds without a UTC offset (#89)', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it.each<['start' | 'end', { start?: string; end?: string }]>([
        ['start', { start: '2024-02-01T02', end: '2024-02-01T07-06' }],
        ['end', { start: '2024-02-01T02-06', end: '2024-02-01' }],
        ['start', { start: '2024-02' }],
        ['end', { end: '2024' }],
      ])('fails %s as invalid_period with no request or timer', async (side, bounds) => {
        vi.useFakeTimers();
        const { fetchMock } = stubDataEndpoint({ total: 1 });
        const value = bounds[side];

        await expect(
          getEiaApiService().query(
            LEAF,
            { columns: ['price'], frequency: 'local-hourly', ...bounds },
            createMockContext(),
          ),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining(`${side} ${JSON.stringify(value)} has no UTC offset`),
          data: {
            reason: 'invalid_period',
            recovery: { hint: expect.stringContaining('"2024-02-01T02-06" is 02:00 at UTC−6') },
          },
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      });

      it('sends offset-bearing bounds to EIA unchanged', async () => {
        const urls: URL[] = [];
        const { fetchMock } = stubDataEndpoint({ total: 1, onCall: () => undefined });
        fetchMock.mockImplementation(async (input: string | URL) => {
          urls.push(new URL(String(input)));
          return httpResponse({
            body: { response: { total: '1', frequency: 'local-hourly', data: [row(0)] } },
          });
        });

        const result = await getEiaApiService().query(
          LEAF,
          {
            columns: ['price'],
            frequency: 'local-hourly',
            start: '2024-02-01T14+06',
            end: '2024-02-01T07-06',
          },
          createMockContext(),
        );
        expect(result.total).toBe(1);
        expect(urls).toHaveLength(1);
        expect(urls[0]?.searchParams.get('start')).toBe('2024-02-01T14+06');
        expect(urls[0]?.searchParams.get('end')).toBe('2024-02-01T07-06');
        expect(urls[0]?.search).toContain('start=2024-02-01T14%2B06');
      });

      it.each(['hourly', 'daily', undefined])(
        'leaves the same bounds alone at frequency %s',
        async (frequency) => {
          const { calls } = stubDataEndpoint({ total: 1 });
          await getEiaApiService().query(
            LEAF,
            {
              columns: ['price'],
              start: '2024-02-01T02',
              end: '2024-02-01',
              ...(frequency && { frequency }),
            },
            createMockContext(),
          );
          expect(calls).toHaveLength(1);
        },
      );

      it("refuses an omitted frequency when the warmed node's default is local-hourly", async () => {
        const route = 'electricity/rto/local-region';
        initRouteCache(
          [
            {
              id: 'electricity',
              name: 'Electricity',
              routes: [
                {
                  id: 'rto',
                  name: 'RTO',
                  routes: [
                    {
                      id: 'local-region',
                      name: 'Local region',
                      defaultFrequency: 'local-hourly',
                      frequency: [
                        {
                          id: 'local-hourly',
                          description: 'Hourly (Local Time Zone)',
                          query: 'LH',
                          format: 'YYYY-MM-DD"T"HH24TZH',
                        },
                      ],
                      facets: [],
                      data: { value: { alias: 'Value', units: 'MWh' } },
                    },
                  ],
                },
              ],
            },
          ],
          [],
        );
        const { fetchMock } = stubDataEndpoint({ total: 1 });

        await expect(
          getEiaApiService().query(route, { start: '2024-02-01T02' }, createMockContext()),
        ).rejects.toMatchObject({ data: { reason: 'invalid_period' } });
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('fails through eia_query_route with the offset form on both surfaces', async () => {
        const { fetchMock } = stubDataEndpoint({ total: 1 });
        const result = await runToolContract(queryRouteTool, {
          route: LEAF,
          columns: ['price'],
          frequency: 'local-hourly',
          start: '2024-02-01T02',
          end: '2024-02-01T07',
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: {
              reason: 'invalid_period',
              recovery: { hint: expect.stringContaining('UTC−6') },
            },
          },
        });
        const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
        expect(text).toContain('"2024-02-01T02-06" is 02:00 at UTC−6');
        expect(text).toContain('start "2024-02-01T02" has no UTC offset');
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });

    describe('bounds naming a month, day, or hour that does not exist (#93)', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      // The four bounds EIA answered with HTTP 500, plus the end side of two of them.
      it.each<[string, 'start' | 'end', { start?: string; end?: string }, string]>([
        ['hourly', 'start', { start: '2024-02-01T24', end: '2024-02-02T02' }, 'hour 24'],
        ['hourly', 'start', { start: '2024-02-01T25', end: '2024-02-02T02' }, 'hour 25'],
        ['local-hourly', 'start', { start: '2024-02-01T24-06' }, 'hour 24'],
        ['daily', 'start', { start: '2024-02-30' }, 'day 30, but 2024-02 has 29 days'],
        ['hourly', 'end', { start: '2024-02-01T20', end: '2024-02-01T24' }, 'hour 24'],
        ['daily', 'end', { start: '2024-02-25', end: '2024-02-30' }, 'day 30'],
        ['weekly', 'start', { start: '2023-02-29' }, 'day 29, but 2023-02 has 28 days'],
      ])(
        'fails %s %s as invalid_period with no request or timer',
        async (frequency, side, bounds, problem) => {
          vi.useFakeTimers();
          const { fetchMock } = stubDataEndpoint({ total: 1 });

          await expect(
            getEiaApiService().query(
              LEAF,
              { columns: ['price'], frequency, ...bounds },
              createMockContext(),
            ),
          ).rejects.toMatchObject({
            code: JsonRpcErrorCode.ValidationError,
            message: expect.stringContaining(
              `At ${frequency} frequency EIA cannot read ${side} ${JSON.stringify(bounds[side])}: it has ${problem}`,
            ),
            data: {
              reason: 'invalid_period',
              recovery: { hint: expect.stringContaining('February 29 only in leap years') },
            },
          });
          expect(fetchMock).not.toHaveBeenCalled();
          expect(vi.getTimerCount()).toBe(0);
        },
      );

      it.each([
        ['daily', '2024-02-29', '2024-03-05'],
        ['hourly', '2024-02-01T23', '2024-02-02T02'],
        ['local-hourly', '2024-02-01T05-99', '2024-02-02T02-06'],
        // Shapes EIA reads leniently at these frequencies, answering with rows.
        ['monthly', '2024-13', '2025-06'],
        ['hourly', '2024-02-30', '2024-03-02T02'],
        ['daily', '2024-02-01T24', '2024-03-05'],
      ])('sends a %s start of %s to EIA unchanged', async (frequency, start, end) => {
        const urls: URL[] = [];
        const { fetchMock } = stubDataEndpoint({ total: 1 });
        const answer = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (input: string | URL) => {
          urls.push(new URL(String(input)));
          return answer(input);
        });

        await getEiaApiService().query(
          LEAF,
          { columns: ['price'], frequency, start, end },
          createMockContext(),
        );
        expect(urls).toHaveLength(1);
        expect(urls[0]?.searchParams.get('start')).toBe(start);
        expect(urls[0]?.searchParams.get('end')).toBe(end);
      });

      it('still classifies a real EIA 500 on a valid bound as upstream_unavailable', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(async () =>
          httpResponse({ status: 500, body: '"Something unexpected happened."' }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const call = getEiaApiService()
          .query(
            LEAF,
            { columns: ['price'], frequency: 'daily', start: '2024-02-29' },
            createMockContext(),
          )
          .catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(30_000);

        expect(await call).toMatchObject({
          data: { reason: 'upstream_unavailable', retryable: true },
        });
        expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
      });

      it("refuses an omitted frequency against the warmed node's daily default", async () => {
        const route = 'electricity/rto/daily-region';
        initRouteCache(
          [
            {
              id: 'electricity',
              name: 'Electricity',
              routes: [
                {
                  id: 'rto',
                  name: 'RTO',
                  routes: [
                    {
                      id: 'daily-region',
                      name: 'Daily region',
                      defaultFrequency: 'daily',
                      frequency: [
                        { id: 'daily', description: 'Daily', query: 'D', format: 'YYYY-MM-DD' },
                      ],
                      facets: [],
                      data: { value: { alias: 'Value', units: 'MWh' } },
                    },
                  ],
                },
              ],
            },
          ],
          [],
        );
        const { fetchMock } = stubDataEndpoint({ total: 1 });

        await expect(
          getEiaApiService().query(route, { end: '2024-04-31' }, createMockContext()),
        ).rejects.toMatchObject({ data: { reason: 'invalid_period' } });
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('fails through eia_query_route naming the bound and the valid range on both surfaces', async () => {
        const { fetchMock } = stubDataEndpoint({ total: 1 });
        const result = await runToolContract(queryRouteTool, {
          route: LEAF,
          frequency: 'hourly',
          start: '2024-02-01T24',
          end: '2024-02-02T02',
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: {
              reason: 'invalid_period',
              recovery: { hint: expect.stringContaining('00–23') },
            },
          },
        });
        const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
        expect(text).toContain(
          'At hourly frequency EIA cannot read start "2024-02-01T24": it has hour 24, but the hour is two digits, 00–23.',
        );
        expect(text).toContain('February 29 only in leap years');
        expect(fetchMock).not.toHaveBeenCalled();
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
      {
        id: 'stateId',
        description: 'State',
        values: [{ id: 'WY', name: 'Wyoming' }],
        complete: true,
        fetchedAt: expect.any(Number),
      },
    ]);
    // Fetched for the entry the query wrote, never stamped before its metadata.
    expect(meta.facets[0]?.fetchedAt).toBeGreaterThanOrEqual(meta.fetchedAt);
    expect(meta).not.toHaveProperty('stale');
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
      expect(result.structuredContent).toMatchObject({
        notice: expect.stringContaining('default frequency'),
      });
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
// #91 — a cached route entry expires 24 h after its fetch. The next describe
// refreshes the route metadata and every facet list; a refresh that fails
// serves what was cached, marked stale, and a 404 drops the entry. A query
// never refreshes, and its unmatched-filter notice skips an expired list.
// ------------------------------------------------------------------

describe('EiaApiService.describe — cached entries expire and refresh (#91)', () => {
  const ROUTE = 'alpha';

  type Mode = 'ok' | 'unavailable' | 'not-found' | 'cancel' | 'hold';

  interface Upstream {
    /** Aborted by a `cancel` path, from inside the fetch — the call's own signal. */
    controller?: AbortController;
    endPeriod: string;
    held?: PromiseWithResolvers<void>;
    lists: Record<string, Array<{ id: string; name: string }>>;
    /** How each path answers; absent means `ok`. */
    mode: Record<string, Mode>;
    /** Released to answer a `hold` path; `held` resolves once one is waiting. */
    release?: PromiseWithResolvers<void>;
  }

  const metaOf = (endPeriod: string) => ({
    id: 'alpha',
    name: 'Alpha',
    description: 'Alpha leaf',
    facets: [
      { id: 'fuel', description: 'Fuel' },
      { id: 'plant', description: 'Plant' },
    ],
    frequency: [{ id: 'monthly', description: 'Monthly', query: 'M', format: 'YYYY-MM' }],
    data: { generation: { alias: 'Generation', units: 'MWh' } },
    startPeriod: '2001-01',
    endPeriod,
    defaultFrequency: 'monthly',
    defaultDateFormat: 'YYYY-MM',
  });

  /** A mutable EIA: the alpha route, its two facet lists, and its data page. */
  function stubUpstream(up: Upstream) {
    const hits: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname.replace(/^\/v2\/?/, '').replace(/\/$/, '');
        hits.push(path);
        switch (up.mode[path] ?? 'ok') {
          case 'unavailable':
            return Response.json({ error: 'upstream unavailable' }, { status: 503 });
          case 'not-found':
            return Response.json({ error: 'not found' }, { status: 404 });
          case 'cancel':
            up.controller?.abort();
            throw new DOMException('The operation was aborted.', 'AbortError');
          case 'hold': {
            up.mode[path] = 'ok';
            up.held?.resolve();
            // A held request still ends when its signal aborts, as a real fetch does.
            const { promise: aborted, reject } = Promise.withResolvers<never>();
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('The operation was aborted.', 'AbortError')),
              { once: true },
            );
            await Promise.race([up.release?.promise, aborted]);
            break;
          }
        }
        if (path === ROUTE) return Response.json({ response: metaOf(up.endPeriod) });
        if (path === `${ROUTE}/data`) {
          return Response.json({ response: { total: '0', frequency: 'monthly', data: [] } });
        }
        const list = up.lists[path.slice(`${ROUTE}/facet/`.length)];
        if (!path.startsWith(`${ROUTE}/facet/`) || !list) {
          return Response.json({ error: 'not found' }, { status: 404 });
        }
        return Response.json({ response: { totalFacets: list.length, facets: list } });
      }),
    );
    return hits;
  }

  const FUEL = [{ id: 'SUN', name: 'Solar' }];
  const PLANTS = [
    { id: '1001', name: 'Palo Verde' },
    { id: '1002', name: 'Comanche Peak' },
  ];
  const PLANTS_AFTER_RELEASE = [...PLANTS, { id: '70425', name: 'Sebree Solar II' }];

  const upstream = (): Upstream => ({
    endPeriod: '2026-07',
    lists: { fuel: FUEL, plant: PLANTS },
    mode: {},
  });

  /** Settle a call while running out any retry backoff on the fake clock. */
  async function settle<T>(call: () => Promise<T>): Promise<T> {
    const pending = call();
    pending.catch(() => undefined);
    await vi.runAllTimersAsync();
    return pending;
  }

  const describeAlpha = (ctx = createMockContext()) =>
    settle(() => getEiaApiService().describe(ROUTE, ctx));

  const countOf = (hits: string[], path: string) => hits.filter((h) => h === path).length;

  /** The instant the first describe of each test fetches at. */
  const T0 = Date.parse('2026-10-01T09:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
    vi.stubEnv('EIA_API_KEY', 'test-key');
    vi.stubEnv('EIA_BASE_URL', 'https://api.eia.gov/v2');
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
    initEiaApiService();
    initRouteCache([metaOf('2026-07')], []);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
  });

  it('pins the TTL at exactly 24 hours', () => {
    expect(ROUTE_METADATA_TTL_MS).toBe(86_400_000);
  });

  it('answers from the cache until 24 h after the fetch, with no request', async () => {
    const up = upstream();
    const hits = stubUpstream(up);
    await describeAlpha();

    // EIA publishes meanwhile; the entry is not yet due.
    up.endPeriod = '2026-08';
    up.lists.plant = PLANTS_AFTER_RELEASE;
    vi.setSystemTime(T0 + ROUTE_METADATA_TTL_MS - 1);
    hits.length = 0;
    const meta = await describeAlpha();

    expect(hits).toEqual([]);
    expect(meta.dateRange.end).toBe('2026-07');
    expect(meta.facets.find((f) => f.id === 'plant')?.values).toHaveLength(2);
    expect(meta).not.toHaveProperty('stale');
  });

  it('re-fetches the route metadata and every list once at 24 h, and indexes added values', async () => {
    const up = upstream();
    const hits = stubUpstream(up);
    await describeAlpha();
    expect(
      searchRoutes('Sebree Solar II', 5).some((r) => r.entry.filter_hint?.plant === '70425'),
    ).toBe(false);

    up.endPeriod = '2026-08';
    up.lists.plant = PLANTS_AFTER_RELEASE;
    vi.setSystemTime(T0 + ROUTE_METADATA_TTL_MS);
    hits.length = 0;
    const meta = await describeAlpha();

    expect([...hits].sort()).toEqual([ROUTE, `${ROUTE}/facet/fuel`, `${ROUTE}/facet/plant`]);
    expect(meta.dateRange.end).toBe('2026-08');
    expect(meta.fetchedAt).toBe(T0 + ROUTE_METADATA_TTL_MS);
    expect(meta.facets.find((f) => f.id === 'plant')?.values).toEqual(PLANTS_AFTER_RELEASE);
    expect(meta).not.toHaveProperty('stale');
    expect(meta.unfetchedFacets).toBeUndefined();
    expect(searchRoutes('Sebree Solar II', 5)[0]?.entry.filter_hint).toEqual({ plant: '70425' });

    // The refreshed entry is the new 24 h baseline.
    hits.length = 0;
    await describeAlpha();
    expect(hits).toEqual([]);
  });

  it('serves a list whose refresh fails from its previous values, marked stale, then retries it alone', async () => {
    const up = upstream();
    const hits = stubUpstream(up);
    await describeAlpha();

    up.endPeriod = '2026-08';
    up.lists.fuel = [...FUEL, { id: 'WND', name: 'Wind' }];
    up.lists.plant = PLANTS_AFTER_RELEASE;
    up.mode[`${ROUTE}/facet/plant`] = 'unavailable';
    vi.setSystemTime(T0 + ROUTE_METADATA_TTL_MS);
    hits.length = 0;
    const meta = await describeAlpha();

    // Its retries ran out; the metadata and the other list refreshed.
    expect(countOf(hits, `${ROUTE}/facet/plant`)).toBe(4);
    expect(meta.dateRange.end).toBe('2026-08');
    expect(meta.facets.find((f) => f.id === 'fuel')?.values).toHaveLength(2);
    expect(meta.facets.find((f) => f.id === 'plant')?.values).toEqual(PLANTS);
    expect(meta.unfetchedFacets).toBeUndefined();
    expect(meta.stale).toEqual({ route: false, facets: [{ id: 'plant', fetchedAt: T0 }] });

    // The next describe retries that list alone, and clears the mark once it lands.
    delete up.mode[`${ROUTE}/facet/plant`];
    vi.setSystemTime(T0 + ROUTE_METADATA_TTL_MS + 60_000);
    hits.length = 0;
    const next = await describeAlpha();
    expect(hits).toEqual([`${ROUTE}/facet/plant`]);
    expect(next.facets.find((f) => f.id === 'plant')?.values).toEqual(PLANTS_AFTER_RELEASE);
    expect(next).not.toHaveProperty('stale');

    hits.length = 0;
    await describeAlpha();
    expect(hits).toEqual([]);
  });

  it('serves the whole previous entry when the route metadata refresh fails, fetching no list', async () => {
    const up = upstream();
    const hits = stubUpstream(up);
    await describeAlpha();

    up.endPeriod = '2026-08';
    up.lists.plant = PLANTS_AFTER_RELEASE;
    up.mode[ROUTE] = 'unavailable';
    vi.setSystemTime(T0 + ROUTE_METADATA_TTL_MS);
    hits.length = 0;
    const meta = await describeAlpha();

    expect(hits).toEqual([ROUTE, ROUTE, ROUTE, ROUTE]);
    expect(meta.dateRange.end).toBe('2026-07');
    expect(meta.fetchedAt).toBe(T0);
    expect(meta.facets.find((f) => f.id === 'plant')?.values).toEqual(PLANTS);
    expect(meta.stale).toEqual({ route: true, facets: [] });

    // Still due: the next describe tries the refresh again, and it lands.
    delete up.mode[ROUTE];
    hits.length = 0;
    const next = await describeAlpha();
    expect([...hits].sort()).toEqual([ROUTE, `${ROUTE}/facet/fuel`, `${ROUTE}/facet/plant`]);
    expect(next.dateRange.end).toBe('2026-08');
    expect(next).not.toHaveProperty('stale');
  });

  it('names a list older than the served entry when the metadata refresh fails again', async () => {
    const up = upstream();
    stubUpstream(up);
    await describeAlpha();

    // The first refresh lands for the metadata but not for plant.
    up.mode[`${ROUTE}/facet/plant`] = 'unavailable';
    const T1 = T0 + ROUTE_METADATA_TTL_MS;
    vi.setSystemTime(T1);
    await describeAlpha();

    // A day later the metadata refresh fails too: the entry from T1 is served,
    // and plant's values are still those fetched at T0.
    up.mode[ROUTE] = 'unavailable';
    vi.setSystemTime(T1 + ROUTE_METADATA_TTL_MS);
    const meta = await describeAlpha();
    expect(meta.fetchedAt).toBe(T1);
    expect(meta.stale).toEqual({ route: true, facets: [{ id: 'plant', fetchedAt: T0 }] });
  });

  it('drops the entry and fails route_not_found when the refresh is answered 404', async () => {
    const up = upstream();
    const hits = stubUpstream(up);
    await describeAlpha();

    up.mode[ROUTE] = 'not-found';
    vi.setSystemTime(T0 + ROUTE_METADATA_TTL_MS);
    hits.length = 0;
    await expect(describeAlpha()).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'route_not_found' },
    });
    // A 404 is EIA's answer, not an outage: answered once, never retried.
    expect(hits).toEqual([ROUTE]);

    // Nothing is left to fall back to: an outage now fails the call outright
    // instead of serving the dropped entry as stale.
    up.mode[ROUTE] = 'unavailable';
    await expect(describeAlpha()).rejects.toMatchObject({
      data: { reason: 'upstream_unavailable' },
    });
  });

  it.each([
    ['the route metadata', ROUTE],
    ['a facet list', `${ROUTE}/facet/plant`],
  ])(
    'propagates a caller cancellation during the refresh of %s and keeps the previous entry',
    async (_, cancelled) => {
      const up = upstream();
      stubUpstream(up);
      await describeAlpha();

      up.endPeriod = '2026-08';
      up.lists.plant = PLANTS_AFTER_RELEASE;
      up.mode[cancelled] = 'cancel';
      up.controller = new AbortController();
      vi.setSystemTime(T0 + ROUTE_METADATA_TTL_MS);
      await expect(
        describeAlpha(createMockContext({ signal: up.controller.signal })),
      ).rejects.toMatchObject({ name: 'AbortError' });

      // The previous entry is still there for the next caller: with EIA now
      // down, that caller is served it as stale rather than failing.
      up.mode = { [ROUTE]: 'unavailable' };
      const meta = await describeAlpha();
      expect(meta.dateRange.end).toBe('2026-07');
      expect(meta.facets.find((f) => f.id === 'plant')?.values).toEqual(PLANTS);
      expect(meta.stale).toEqual({ route: true, facets: [] });
    },
  );

  it('keeps the refresh a concurrent describe lands when the other is cancelled mid-refresh', async () => {
    const up = upstream();
    const hits = stubUpstream(up);
    await describeAlpha();

    up.endPeriod = '2026-08';
    up.lists.plant = PLANTS_AFTER_RELEASE;
    vi.setSystemTime(T0 + ROUTE_METADATA_TTL_MS);

    // The first describe's refresh stalls on its plant list.
    up.mode[`${ROUTE}/facet/plant`] = 'hold';
    up.held = Promise.withResolvers();
    up.release = Promise.withResolvers();
    const controller = new AbortController();
    const cancelled = getEiaApiService().describe(
      ROUTE,
      createMockContext({ signal: controller.signal }),
    );
    cancelled.catch(() => undefined);
    await up.held.promise;

    // A second describe refreshes in full meanwhile. Every request here answers
    // at once, so no call runs the fake clock — which would fire the stalled
    // call's attempt timeout.
    const refreshed = await getEiaApiService().describe(ROUTE, createMockContext());
    expect(refreshed.dateRange.end).toBe('2026-08');
    expect(refreshed.facets.find((f) => f.id === 'plant')?.values).toEqual(PLANTS_AFTER_RELEASE);

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    // The cancellation neither drops nor reverts the refreshed entry.
    hits.length = 0;
    const meta = await getEiaApiService().describe(ROUTE, createMockContext());
    expect(hits).toEqual([]);
    expect(meta.dateRange.end).toBe('2026-08');
    expect(meta.fetchedAt).toBe(T0 + ROUTE_METADATA_TTL_MS);
    expect(meta).not.toHaveProperty('stale');
  });

  it('keeps a refreshed entry when a describe begun from the expired one lands after it', async () => {
    const up = upstream();
    const hits = stubUpstream(up);
    // plant fails on the first describe, so the entry holds it unfetched.
    up.mode[`${ROUTE}/facet/plant`] = 'not-found';
    await describeAlpha();

    // Just inside the TTL, a describe starts repairing plant from that entry
    // and stalls on it.
    up.mode[`${ROUTE}/facet/plant`] = 'hold';
    up.held = Promise.withResolvers();
    up.release = Promise.withResolvers();
    vi.setSystemTime(T0 + ROUTE_METADATA_TTL_MS - 1);
    const slow = getEiaApiService().describe(ROUTE, createMockContext());
    await up.held.promise;

    // The entry expires and another describe refreshes it in full. Every
    // request here answers at once, so no call runs the fake clock — which
    // would fire the stalled call's attempt timeout.
    up.endPeriod = '2026-08';
    vi.setSystemTime(T0 + ROUTE_METADATA_TTL_MS);
    const refreshed = await getEiaApiService().describe(ROUTE, createMockContext());
    expect(refreshed.dateRange.end).toBe('2026-08');

    // The stalled repair lands last; it must not put the older entry back.
    up.release.resolve();
    await slow;
    hits.length = 0;
    const meta = await getEiaApiService().describe(ROUTE, createMockContext());
    expect(hits).toEqual([]);
    expect(meta.dateRange.end).toBe('2026-08');
    expect(meta.fetchedAt).toBe(T0 + ROUTE_METADATA_TTL_MS);
  });

  it('skips an expired list in the query notice, and the query refreshes nothing', async () => {
    const up = upstream();
    const hits = stubUpstream(up);
    await describeAlpha();
    const query = () =>
      getEiaApiService().query(ROUTE, { filters: { plant: '70425' } }, createMockContext());

    // One millisecond inside the TTL the complete cached list diagnoses the
    // unmatched value (the #81 suite carries that notice to both tool surfaces).
    vi.setSystemTime(T0 + ROUTE_METADATA_TTL_MS - 1);
    hits.length = 0;
    expect((await query()).notices).toEqual([
      'Filter plant value "70425" is not in the complete cached vocabulary. The submitted filter was preserved.',
    ]);
    expect(hits).toEqual([`${ROUTE}/data`]);

    // From the TTL on, EIA may have added the value since: no claim, and no refresh.
    vi.setSystemTime(T0 + ROUTE_METADATA_TTL_MS);
    hits.length = 0;
    expect((await query()).notices).toBeUndefined();
    expect(hits).toEqual([`${ROUTE}/data`]);
  });

  describe('through eia_describe_route', () => {
    it('keeps a stale list in facets, out of unavailable_facets, with a notice naming when it was fetched', async () => {
      const up = upstream();
      stubUpstream(up);
      await settle(() => runToolContract(describeRouteTool, { route: ROUTE }));

      up.mode[`${ROUTE}/facet/plant`] = 'unavailable';
      vi.setSystemTime(T0 + ROUTE_METADATA_TTL_MS);
      const result = await settle(() =>
        runToolContract(describeRouteTool, { route: ROUTE, facet: 'plant', values_query: 'palo' }),
      );

      // The facet input pages the previous list rather than failing facet_unavailable.
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).not.toHaveProperty('unavailable_facets');
      expect(result.structuredContent).toMatchObject({
        facets: [{ id: 'plant', value_count: 2, values_matched: 1, values: [{ id: '1001' }] }],
      });
      const stale =
        'EIA did not answer the refresh of the value list of plant (fetched 2026-10-01T09:00:00Z), so it is served as last fetched and may lack values EIA has added since. The next eia_describe_route call retries the refresh.';
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice.endsWith(stale)).toBe(true);
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toContain('2026-10-01T09:00:00Z');
      expect(text).toContain('may lack values EIA has added since');
    });

    it('fails a facet input whose list was never fetched when the metadata refresh fails', async () => {
      const up = upstream();
      stubUpstream(up);
      up.mode[`${ROUTE}/facet/plant`] = 'not-found';
      await settle(() => runToolContract(describeRouteTool, { route: ROUTE }));

      up.mode = { [ROUTE]: 'unavailable' };
      vi.setSystemTime(T0 + ROUTE_METADATA_TTL_MS);
      const result = await settle(() =>
        runToolContract(describeRouteTool, { route: ROUTE, facet: 'plant' }),
      );

      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'facet_unavailable', retryable: true } },
      });
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
    `/v2/${CANONICAL}/`,
    ` //v2///${CANONICAL}// `,
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

    for (const variant of ['/electricity', 'electricity/', '/electricity/', '/v2/electricity/']) {
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

    for (const variant of ['/electricity', 'electricity/', '/electricity/', '/v2/electricity/']) {
      await expect(
        getEiaApiService().query(variant, { columns: ['price'] }, ctx),
      ).rejects.toMatchObject({ data: { reason: 'route_not_queryable' } });
    }

    // The pre-flight reads the node map, which only the canonical spelling used
    // to hit — every variant used to cost an upstream round trip to learn the
    // same thing.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('browses /v2/ as root without a fetch', async () => {
    const { fetchMock } = stubApiPaths({});
    const result = await getEiaApiService().browse(' //v2/// ', createMockContext());
    expect(result.path).toBe('');
    expect(result.children.map((child) => child.route)).toEqual(['electricity']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['v20/electricity', 'v20/electricity'],
    ['electricity/v2/retail-sales', 'electricity/v2/retail-sales'],
    ['v2/v2/steo', 'v2/steo'],
    ['v2/steo/data', 'steo/data'],
    ['https://api.eia.gov/v2/steo', 'https:/api.eia.gov/v2/steo'],
  ])('only removes one leading complete v2 segment from %s', async (route, canonical) => {
    const { urls } = stubApiPaths({
      [`${canonical}/data`]: { response: { total: '0', data: [] } },
    });
    const result = await getEiaApiService().query(
      route,
      { columns: ['price'] },
      createMockContext(),
    );
    expect(result.route).toBe(canonical);
    expect(urls[0]?.pathname).toBe(`/v2/${canonical}/data/`);
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
    const bodies = fixture();
    stubApiPaths(bodies);
    const ctx = createMockContext();
    await getEiaApiService().search('coal', 5, ctx);

    // The re-fetch is answered, but not with route metadata.
    bodies.coal = { notRouteMetadata: true };
    await expect(getEiaApiService().browse('coal', ctx)).rejects.toThrow(
      /did not return metadata for route "coal"/,
    );
    expect(getNode('coal')?.incomplete).toBe(true);
  });

  it('fails the browse as route_not_found when EIA no longer has the route', async () => {
    stubApiPaths(fixture());
    const ctx = createMockContext();
    await getEiaApiService().search('coal', 5, ctx);

    // `coal` still answers 404, as it did during the warm.
    await expect(getEiaApiService().browse('coal', ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'route_not_found' },
    });
  });

  it('repairs the node and resolves its children, keeping a failed child incomplete', async () => {
    const bodies = fixture();
    const { paths } = stubApiPaths(bodies);
    const ctx = createMockContext();
    await getEiaApiService().search('coal', 5, ctx);

    // The repaired node lists one child already classified and one bare stub
    // that still fails — the warm's own rule applies to it.
    bodies.coal = {
      response: {
        id: 'coal',
        name: 'Coal',
        routes: [
          { id: 'mine-production', name: 'Mine Production', facets: [], frequency: [], data: {} },
          { id: 'exports', name: 'Exports' },
        ],
      },
    };
    const result = await getEiaApiService().browse('coal', ctx);

    expect(result.children.map((c) => [c.route, c.isLeaf])).toEqual([
      ['coal/mine-production', true],
      ['coal/exports', false],
    ]);
    expect(paths.filter((p) => p === 'coal/exports')).toHaveLength(1);
    expect(getNode('coal/exports')?.incomplete).toBe(true);
    expect(getNode('coal')?.incomplete).toBeUndefined();
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
// #90 — every EIA request is bounded: each attempt by a timeout, and every
// attempt, backoff, and chained request of a call by one deadline that
// settles inside the MCP SDK's 60 s client request timeout.
// ------------------------------------------------------------------

/**
 * A fetch that accepts the request and never finishes it — before headers, or
 * after headers with the body left open. Either way it ends only when the
 * signal it was handed aborts, as real `fetch` does. `answerFrom` lets calls
 * from that 1-based number onward answer with `body` instead.
 */
function stallingFetch(stall: 'headers' | 'body', answerFrom?: { call: number; body: unknown }) {
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    signals.push(signal);
    if (answerFrom && signals.length >= answerFrom.call)
      return httpResponse({ body: answerFrom.body });
    if (stall === 'headers') {
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"response":{"total":"1","data":['));
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, signals };
}

describe('EiaApiService — requests are bounded in time (#90)', () => {
  const ONE_ROW = { response: { total: '1', frequency: 'monthly', data: [row(0)] } };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.stubEnv('EIA_API_KEY', 'test-key');
    vi.stubEnv('EIA_BASE_URL', 'https://api.eia.gov/v2');
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
    initEiaApiService();
    seedRouteCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
    _resetRouteCache();
    _resetEiaApiService();
  });

  /** Run `call` to settlement under the fake clock; resolves with its outcome and elapsed ms. */
  async function settle<T>(call: Promise<T>) {
    const startedAt = Date.now();
    let settledAt: number | undefined;
    const outcome = call.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    void outcome.then(() => {
      settledAt = Date.now();
    });
    for (let i = 0; i < 70 && settledAt === undefined; i++)
      await vi.advanceTimersByTimeAsync(1_000);
    return { ...(await outcome), elapsedMs: (settledAt ?? Number.NaN) - startedAt };
  }

  it.each(['headers', 'body'] as const)(
    'fails a query stalled at %s as retryable upstream_timeout inside the 60 s client timeout',
    async (stall) => {
      const { fetchMock } = stallingFetch(stall);
      const contract = queryRouteTool.errors!.find((entry) => entry.reason === 'upstream_timeout')!;

      const result = await settle(
        runToolContract(queryRouteTool, { route: LEAF, columns: ['price'] }),
      );

      expect(result.ok).toBe(true);
      const response = result.ok ? result.value : undefined;
      expect(response?.isError).toBe(true);
      expect(response?.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.Timeout,
          message: expect.stringContaining('EIA did not answer in time'),
          data: {
            reason: 'upstream_timeout',
            retryable: true,
            recovery: { hint: contract.recovery },
          },
        },
      });
      // A 45 s attempt, a backoff, then a second attempt cut by the 56 s deadline.
      expect(result.elapsedMs).toBeLessThanOrEqual(56_000);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(55_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('names the call deadline, not the leftover budget, when a late request runs out', async () => {
    // The route metadata answers after 25 s; the data page that follows stalls.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        if (new URL(String(input)).pathname.endsWith('/data/')) {
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 25_000));
        return httpResponse({
          body: { response: { id: 'other', frequency: [], facets: [], data: { price: {} } } },
        });
      }),
    );

    const result = await settle(
      getEiaApiService().query('electricity/other', {}, createMockContext()),
    );

    expect(result.ok).toBe(false);
    const message = result.ok ? '' : (result.error as Error).message;
    expect(message).toContain('the 56 s deadline ran out during this request');
    // 31 s of the deadline was left when the data request started.
    expect(message).not.toMatch(/\b31 s\b/);
    expect(result).toMatchObject({ error: { data: { reason: 'upstream_timeout' } } });
  });

  it('retries a timed-out attempt within the deadline', async () => {
    const { fetchMock } = stallingFetch('headers', { call: 2, body: ONE_ROW });

    const result = await settle(
      getEiaApiService().query(LEAF, { columns: ['price'] }, createMockContext()),
    );

    expect(result.ok && result.value.total).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The first attempt was cut at 45 s, the second answered after its backoff.
    expect(result.elapsedMs).toBeGreaterThanOrEqual(45_000);
    expect(result.elapsedMs).toBeLessThan(47_000);
  });

  /**
   * A data endpoint whose pages each answer after `pageMs` (`pageMs(offset)`
   * when a function), honouring the attempt's signal, over a matching set of
   * `total` rows. Records the offset of every request.
   */
  function timedPages(pageMs: number | ((offset: number) => number), total: number) {
    const offsets: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const params = new URL(String(input)).searchParams;
        const offset = Number(params.get('offset'));
        const length = Number(params.get('length'));
        offsets.push(offset);
        const signal = init?.signal as AbortSignal;
        const delayMs = typeof pageMs === 'number' ? pageMs : pageMs(offset);
        await new Promise<void>((resolve, reject) => {
          if (!Number.isFinite(delayMs)) {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            return;
          }
          const timer = setTimeout(resolve, delayMs);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
        return httpResponse({
          body: {
            response: {
              total: String(total),
              frequency: 'monthly',
              data: Array.from({ length: Math.min(length, total - offset) }, (_, i) =>
                row(offset + i),
              ),
            },
          },
        });
      }),
    );
    return { offsets };
  }

  it('waits out a slow healthy answer instead of cutting it: EIA answers deep offsets in 34–37 s', async () => {
    // Measured live: fuel-type-data at offset 6,000,000 answered 200 in 35.5 s,
    // facility-fuel at offset 8,000,000 in 34.5 s.
    const { offsets } = timedPages(37_000, 1);

    const result = await settle(
      getEiaApiService().query(LEAF, { columns: ['price'] }, createMockContext()),
    );

    expect(result.ok && result.value.total).toBe(1);
    expect(offsets).toEqual([0]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(37_000);
    expect(result.elapsedMs).toBeLessThan(38_000);
  });

  it('stages every row of a healthy chain that ends inside the client timeout', async () => {
    // Six requests at 9 s each, the wide-route timing measured live
    // (electricity/operating-generator-capacity stages 25,000 rows in about 54 s).
    const { offsets } = timedPages(9_000, 30_000);

    const result = await settle(
      getEiaApiService().query(
        LEAF,
        { columns: ['price'], accumulate: true, length: 100 },
        createMockContext(),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accumulated).toMatchObject({ capped: true });
    expect(result.value.accumulated?.timedOut).toBeUndefined();
    expect(result.value.accumulated?.rows).toHaveLength(25_000);
    expect(offsets).toEqual([0, 100, 5_100, 10_100, 15_100, 20_100]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(54_000);
    expect(result.elapsedMs).toBeLessThan(56_000);
  });

  it('never starts a staging page that could not land before the deadline', async () => {
    // 13 s pages: the fourth lands at 52 s, leaving 4 s — shorter than any page so far.
    const { offsets } = timedPages(13_000, 30_000);

    const result = await settle(
      getEiaApiService().query(
        LEAF,
        { columns: ['price'], accumulate: true, length: 100 },
        createMockContext(),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(offsets).toEqual([0, 100, 5_100, 10_100]);
    expect(result.value.accumulated).toMatchObject({ capped: false, timedOut: true });
    expect(result.value.accumulated?.rows).toHaveLength(15_100);
    // Answered as the last page landed, not at the deadline a fifth page would have hit.
    expect(result.elapsedMs).toBeGreaterThanOrEqual(52_000);
    expect(result.elapsedMs).toBeLessThan(53_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('measures the preview too: a slow preview leaves no room for a staging page', async () => {
    vi.stubEnv('EIA_CANVAS_MAX_ROWS', '300');
    _resetServerConfig();
    // The preview answers after 29 s of the call's 56 s, leaving 27 s — too little for a page as slow.
    const { offsets } = timedPages((offset) => (offset === 0 ? 29_000 : 1_000), 300);

    const result = await settle(
      getEiaApiService().query(
        LEAF,
        { columns: ['price'], accumulate: true, length: 100 },
        createMockContext(),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data).toHaveLength(100);
    expect(result.value.accumulated).toMatchObject({ capped: false, timedOut: true });
    expect(result.value.accumulated?.rows).toHaveLength(100);
    expect(offsets).toEqual([0]);
    expect(result.elapsedMs).toBeLessThan(30_000);
  });

  it('bounds the chain, not each request: a staging page that stalls past the deadline ends staging', async () => {
    vi.stubEnv('EIA_CANVAS_MAX_ROWS', '300');
    _resetServerConfig();
    // The preview answers in 1 s; every later page stalls until its attempt is cut.
    const { offsets } = timedPages(
      (offset) => (offset === 0 ? 1_000 : Number.POSITIVE_INFINITY),
      300,
    );

    const result = await settle(
      getEiaApiService().query(
        LEAF,
        { columns: ['price'], accumulate: true, length: 100 },
        createMockContext(),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data).toHaveLength(100);
    expect(result.value.accumulated).toMatchObject({ capped: false, timedOut: true });
    expect(result.value.accumulated?.rows).toHaveLength(100);
    expect(offsets[0]).toBe(0);
    expect(offsets.slice(1).every((offset) => offset === 100)).toBe(true);
    expect(offsets.length).toBeGreaterThanOrEqual(2);
    expect(result.elapsedMs).toBeLessThanOrEqual(56_000);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(55_000);
  });

  it('does not report a failed staging page as running out of time', async () => {
    vi.stubEnv('EIA_CANVAS_MAX_ROWS', '300');
    _resetServerConfig();
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return httpResponse({
            body: {
              response: {
                total: '300',
                frequency: 'monthly',
                data: Array.from({ length: 100 }, (_, i) => row(i)),
              },
            },
          });
        }
        return httpResponse({ status: 503, body: 'down' });
      }),
    );

    const result = await settle(
      getEiaApiService().query(LEAF, { columns: ['price'], accumulate: true }, createMockContext()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accumulated?.rows).toHaveLength(100);
    expect(result.value.accumulated?.timedOut).toBeUndefined();
    expect(result.value.accumulated?.capped).toBe(false);
  });

  it('keeps a caller abort during a stalled attempt a cancellation', async () => {
    const { fetchMock } = stallingFetch('headers');
    const caller = new AbortController();
    const reason = new Error('client cancelled');
    const call = runToolContract(
      queryRouteTool,
      { route: LEAF, columns: ['price'] },
      { context: { signal: caller.signal } },
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expectCancelledBy(await settleOnAbort(call, () => caller.abort(reason)), reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a caller abort during a backoff a cancellation', async () => {
    const fetchMock = vi.fn(async () => httpResponse({ status: 503, body: 'down' }));
    vi.stubGlobal('fetch', fetchMock);
    const caller = new AbortController();
    const reason = new Error('client cancelled');
    const call = runToolContract(
      queryRouteTool,
      { route: LEAF, columns: ['price'] },
      { context: { signal: caller.signal } },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expectCancelledBy(await settleOnAbort(call, () => caller.abort(reason)), reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves a fast call unchanged and arms no timer past it', async () => {
    const { fetchMock } = stallingFetch('headers', { call: 1, body: ONE_ROW });

    const result = await getEiaApiService().query(
      LEAF,
      { columns: ['price'] },
      createMockContext(),
    );

    expect(result).toMatchObject({ total: 1, data: [row(0)] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lands a stalled warm facet fetch in the index gaps instead of holding the pass open', async () => {
    _resetRouteCache();
    const api = stubHeldApiPaths(warmBodies());
    const sectorPath = 'electricity/retail-sales/facet/sectorid';
    const release = api.hold(sectorPath);
    const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
      result.content.map((block) => block.text ?? '').join('\n');

    // The search answers at its 45 s budget with the facet that landed and the gap named.
    const first = await settle(runToolContract(searchRoutesTool, { query: 'wind', limit: 5 }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.elapsedMs).toBeLessThanOrEqual(45_000);
    expect(first.value.isError).not.toBe(true);
    expect(first.value.structuredContent).toMatchObject({
      indexComplete: false,
      indexGaps: ['facet_values'],
      results: [{ filter_hint: { energy_source_code: 'WND' } }],
    });
    expect(textOf(first.value)).toContain('**indexGaps:** facet_values');

    // The warm's own 56 s deadline ends the stalled fetch: the pass closes, nothing stays armed.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(getIndexStatus().pendingPasses).toEqual(['facet_values']);

    // A closed pass is re-run by the next search for the one facet it missed — an open one
    // would be joined instead, with no request. EIA answers this time and the gap closes.
    release();
    const requestsBefore = api.paths.length;
    const second = await settle(
      runToolContract(searchRoutesTool, { query: 'residential', limit: 5 }),
    );
    expect(api.paths.slice(requestsBefore)).toEqual([sectorPath]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.structuredContent).toMatchObject({
      indexComplete: true,
      results: [{ filter_hint: { sectorid: 'RES' } }],
    });
    expect(second.value.structuredContent).not.toHaveProperty('indexGaps');
    expect(textOf(second.value)).not.toContain('indexGaps');
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
    const caller = new AbortController();
    const ctx = createMockContext({ signal: caller.signal });

    await getEiaApiService().search('wind', 5, ctx);

    /**
     * Each fetch carries its own attempt timeout, so each gets a signal of its
     * own — derived from the service's lifetime, never the caller's: the
     * caller aborting reaches none of them, and shutdown reaches every one.
     */
    const warmPaths = [
      '',
      'steo/facet/seriesId',
      'seds/facet/seriesId',
      'electricity/retail-sales/facet/sectorid',
    ];
    caller.abort(new Error('Connection closed'));
    for (const path of warmPaths) {
      const signal = api.signals.get(path);
      expect(signal, path).toBeInstanceOf(AbortSignal);
      expect(signal, path).not.toBe(ctx.signal);
      expect(signal?.aborted, path).toBe(false);
    }
    shutdownEiaApiService();
    for (const path of warmPaths) expect(api.signals.get(path)?.aborted, path).toBe(true);
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
// #78 — the benchmarks analysts ask for first (Henry Hub, WTI, Cushing, ERCOT)
// live in `series`, `product`, and RTO `respondent` values, which reached the
// index only once someone described the owning route. The warm-time facet pass
// now fetches them: `series` and `product` on leaves publishing a daily or
// weekly series, `series` indexed whole, and `respondent` on the hourly and
// daily RTO leaves — never on an annual survey route, whose respondents are plants.
// ------------------------------------------------------------------

describe('EiaApiService — benchmark series, products, and respondents at warm time (#78)', () => {
  const SPT = 'petroleum/pri/spt';
  const WSTK = 'petroleum/stoc/wstk';
  const MONTHLY = 'petroleum/pri/dfp1';
  const FUT = 'natural-gas/pri/fut';
  const RTO = 'electricity/rto/region-data';
  const PELLETS = 'densified-biomass/wood-pellet-plants';

  const freq = (id: string) => ({ id, description: id, query: id, format: 'YYYY-MM-DD' });
  const volumeFacets = ['duoarea', 'product', 'process', 'series'].map((id) => ({
    id,
    description: id,
  }));
  const many = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix} item ${i}` }));

  /** Daily and weekly leaves in both shapes EIA serves `frequency` in, a monthly leaf, and an RTO leaf. */
  function benchmarkBodies(): Record<string, unknown> {
    return {
      '': {
        response: {
          routes: [
            {
              id: 'petroleum',
              name: 'Petroleum',
              routes: [
                {
                  id: 'pri',
                  name: 'Prices',
                  routes: [
                    {
                      id: 'spt',
                      name: 'Spot Prices',
                      frequency: [freq('monthly'), freq('weekly'), freq('daily')],
                      facets: volumeFacets,
                      data: {},
                    },
                    {
                      id: 'dfp1',
                      name: 'Domestic Crude Oil First Purchase Prices',
                      frequency: [freq('monthly'), freq('annual')],
                      facets: volumeFacets,
                      data: {},
                    },
                  ],
                },
                {
                  id: 'stoc',
                  name: 'Stocks',
                  routes: [
                    {
                      id: 'wstk',
                      name: 'Weekly Stocks',
                      // The object-map shape — keyed by frequency id.
                      frequency: { weekly: freq('weekly') },
                      facets: volumeFacets,
                      data: {},
                    },
                  ],
                },
              ],
            },
            {
              id: 'natural-gas',
              name: 'Natural Gas',
              routes: [
                {
                  id: 'pri',
                  name: 'Prices',
                  routes: [
                    {
                      id: 'fut',
                      name: 'Spot and Futures Prices',
                      frequency: [freq('daily')],
                      facets: volumeFacets,
                      data: {},
                    },
                  ],
                },
              ],
            },
            {
              id: 'electricity',
              name: 'Electricity',
              routes: [
                {
                  id: 'rto',
                  name: 'Electric Power Operations (Daily and Hourly)',
                  routes: [
                    {
                      id: 'region-data',
                      name: 'Hourly Demand By Region',
                      frequency: [freq('hourly'), freq('local-hourly')],
                      facets: [
                        { id: 'respondent', description: 'Balancing Authority / Region' },
                        { id: 'type', description: 'Type of Data' },
                      ],
                      data: {},
                    },
                  ],
                },
              ],
            },
            {
              id: 'densified-biomass',
              name: 'Densified Biomass',
              routes: [
                {
                  // An annual survey route whose respondents are reporting plants.
                  id: 'wood-pellet-plants',
                  name: 'Wood Pellet Plant Capacity',
                  frequency: [freq('annual')],
                  facets: [
                    { id: 'region', description: 'Region' },
                    { id: 'respondent', description: 'Respondent' },
                  ],
                  data: {},
                },
              ],
            },
          ],
        },
      },
      'steo/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
      'seds/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
      [`${SPT}/facet/series`]: {
        response: {
          totalFacets: 2,
          facets: [
            { id: 'RWTC', name: 'Cushing, OK WTI Spot Price FOB' },
            { id: 'RBRTE', name: 'Europe Brent Spot Price FOB' },
          ],
        },
      },
      [`${SPT}/facet/product`]: {
        response: {
          totalFacets: 2,
          facets: [
            { id: 'EPCWTI', name: 'WTI Crude Oil' },
            { id: 'EPCBRENT', name: 'UK Brent Crude Oil' },
          ],
        },
      },
      // Past the 200-value bound: `series` is indexed whole, `product` is not.
      [`${WSTK}/facet/series`]: {
        response: {
          totalFacets: 205,
          facets: [
            {
              id: 'W_EPC0_SAX_YCUOK_MBBL',
              name: 'Cushing, OK Ending Stocks excluding SPR of Crude Oil (Thousand Barrels)',
            },
            ...many('WSTK', 204),
          ],
        },
      },
      [`${WSTK}/facet/product`]: { response: { totalFacets: 201, facets: many('PROD', 201) } },
      [`${FUT}/facet/series`]: {
        response: {
          totalFacets: 1,
          facets: [
            { id: 'RNGWHHD', name: 'Henry Hub Natural Gas Spot Price (Dollars per Million Btu)' },
          ],
        },
      },
      [`${FUT}/facet/product`]: {
        response: { totalFacets: 1, facets: [{ id: 'EPG0', name: 'Natural Gas' }] },
      },
      [`${RTO}/facet/respondent`]: {
        response: {
          totalFacets: 2,
          facets: [
            { id: 'ERCO', name: 'Electric Reliability Council of Texas, Inc.' },
            { id: 'CISO', name: 'California Independent System Operator' },
          ],
        },
      },
    };
  }

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

  /** Indexed entries filtering on `facetId`, as `route facetId=value`. */
  function hintsOn(facetId: string): string[] {
    return getIndexEntries().flatMap((e) => {
      const value = e.filter_hint?.[facetId];
      return value === undefined ? [] : [`${e.route} ${facetId}=${value}`];
    });
  }

  it('fetches series and product on daily and weekly leaves only, and respondent on hourly ones', async () => {
    const api = stubHeldApiPaths(benchmarkBodies());

    const { status } = await getEiaApiService().search('Cushing', 5, createMockContext());

    expect(status.complete).toBe(true);
    const facetPaths = api.paths.filter((path) => path.includes('/facet/')).sort();
    expect(facetPaths).toEqual(
      [
        `${FUT}/facet/product`,
        `${FUT}/facet/series`,
        `${RTO}/facet/respondent`,
        `${SPT}/facet/product`,
        `${SPT}/facet/series`,
        `${WSTK}/facet/product`,
        `${WSTK}/facet/series`,
        'seds/facet/seriesId',
        'steo/facet/seriesId',
      ].sort(),
    );
    // Never fetched: the monthly leaf's series and product, any duoarea or process,
    // the RTO type, and the annual pellet-plant route's respondents.
    for (const path of [
      `${MONTHLY}/facet/series`,
      `${MONTHLY}/facet/product`,
      `${RTO}/facet/type`,
      `${PELLETS}/facet/respondent`,
    ])
      expect(api.paths).not.toContain(path);
    expect(api.paths.some((path) => /\/facet\/(duoarea|process)$/.test(path))).toBe(false);
    expect(hintsOn('duoarea')).toEqual([]);
    expect(hintsOn('process')).toEqual([]);
  });

  it('indexes a series facet whole past the 200-value bound and holds product and respondent to it', async () => {
    const bodies = benchmarkBodies();
    bodies[`${RTO}/facet/respondent`] = { response: { totalFacets: 201, facets: many('BA', 201) } };
    stubHeldApiPaths(bodies);

    const { status } = await getEiaApiService().search('Cushing', 5, createMockContext());

    expect(status.complete).toBe(true);
    // 2 on spt + 205 on wstk (whole) + 1 on fut.
    expect(hintsOn('series')).toHaveLength(2 + 205 + 1);
    expect(hintsOn('series')).toContain(`${WSTK} series=W_EPC0_SAX_YCUOK_MBBL`);
    // wstk's 201 products and the 201 respondents stay out.
    expect(hintsOn('product').sort()).toEqual(
      [`${FUT} product=EPG0`, `${SPT} product=EPCBRENT`, `${SPT} product=EPCWTI`].sort(),
    );
    expect(hintsOn('respondent')).toEqual([]);
  });

  it('resolves the benchmarks on the first search, before any describe', async () => {
    stubHeldApiPaths(benchmarkBodies());
    const ctx = createMockContext();

    const henry = await getEiaApiService().search('Henry Hub', 5, ctx);
    expect(henry.results[0]?.entry).toMatchObject({
      route: FUT,
      filter_hint: { series: 'RNGWHHD' },
    });
    expect(henry.results[0]?.score).toBeLessThan(WEAK_MATCH_SCORE);

    const wti = await getEiaApiService().search('WTI crude oil', 5, ctx);
    expect(wti.results[0]?.entry).toMatchObject({ route: SPT, filter_hint: { product: 'EPCWTI' } });

    // Two series name Cushing — the WTI spot price and the stocks there — and lead in either order.
    const cushing = await getEiaApiService().search('Cushing', 5, ctx);
    expect(
      cushing.results
        .slice(0, 2)
        .map((r) => `${r.entry.route} series=${r.entry.filter_hint?.series}`)
        .sort(),
    ).toEqual([`${SPT} series=RWTC`, `${WSTK} series=W_EPC0_SAX_YCUOK_MBBL`]);

    const ercot = await getEiaApiService().search('Electric Reliability Council of Texas', 5, ctx);
    expect(ercot.results[0]?.entry).toMatchObject({
      route: RTO,
      filter_hint: { respondent: 'ERCO' },
    });
    expect(ercot.results[0]?.score).toBeLessThan(WEAK_MATCH_SCORE);
  });

  it('answers a benchmark query on both surfaces of the tool', async () => {
    stubHeldApiPaths(benchmarkBodies());

    const result = await runToolContract(searchRoutesTool, { query: 'Henry Hub' });
    const structured = result.structuredContent as {
      results: Array<{ route: string; filter_hint?: Record<string, string> }>;
      indexComplete: boolean;
    };
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');

    expect(structured.indexComplete).toBe(true);
    expect(structured.results[0]).toMatchObject({ route: FUT, filter_hint: { series: 'RNGWHHD' } });
    expect(text).toContain(`eia_query_route(route="${FUT}", filters={"series": "RNGWHHD"})`);
  });

  it('reports a failed benchmark target as a facet_values gap and re-fetches only it', async () => {
    const bodies = benchmarkBodies();
    const seriesPath = `${SPT}/facet/series`;
    const series = bodies[seriesPath];
    delete bodies[seriesPath];
    const api = stubHeldApiPaths(bodies);

    const first = await getEiaApiService().search('Cushing', 5, createMockContext());
    expect(first.status.complete).toBe(false);
    expect(first.status.pendingPasses).toEqual(['facet_values']);
    expect(hintsOn('series')).not.toContain(`${SPT} series=RWTC`);

    bodies[seriesPath] = series;
    const fetchedBefore = api.paths.length;
    const second = await getEiaApiService().search('Cushing', 5, createMockContext());

    expect(api.paths.slice(fetchedBefore)).toEqual([seriesPath]);
    expect(second.status.complete).toBe(true);
    expect(hintsOn('series')).toContain(`${SPT} series=RWTC`);
  });

  it('leaves describe-time folding bounded: a described monthly route keeps a large series facet out', async () => {
    const bodies = benchmarkBodies();
    bodies[MONTHLY] = {
      response: {
        id: 'dfp1',
        name: 'Domestic Crude Oil First Purchase Prices',
        frequency: [freq('monthly')],
        facets: [
          { id: 'series', description: 'Series' },
          { id: 'product', description: 'Product' },
        ],
        data: {},
      },
    };
    bodies[`${MONTHLY}/facet/series`] = {
      response: { totalFacets: 201, facets: many('DFP', 201) },
    };
    bodies[`${MONTHLY}/facet/product`] = {
      response: { totalFacets: 1, facets: [{ id: 'EPC0', name: 'Crude Oil' }] },
    };
    stubHeldApiPaths(bodies);
    await getEiaApiService().search('Cushing', 5, createMockContext());

    await getEiaApiService().describe(MONTHLY, createMockContext());

    expect(hintsOn('series').filter((hint) => hint.startsWith(MONTHLY))).toEqual([]);
    expect(hintsOn('product').filter((hint) => hint.startsWith(MONTHLY))).toEqual([
      `${MONTHLY} product=EPC0`,
    ]);
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
    expect(structured.notice).toBe('Requested limit 50 was clamped to 30.');
    expect(text).not.toMatch(/More matches|at most 30/);
  });

  it('keeps the no-match notice, untruncated, on an empty result', async () => {
    const { structured, routes } = await searchThroughTool({ query: 'qqxjjvv', limit: 5 });

    expect(routes).toEqual([]);
    expect(structured).toMatchObject({ truncated: false, shown: 0, cap: 5 });
    expect(structured.notice).toMatch(/^No routes matched "qqxjjvv"/);
  });

  it('clamps limit 101 over a real index without false truncation', async () => {
    const { result, structured, routes, text } = await searchThroughTool({
      query: 'zinc',
      limit: 101,
    });
    expect(result.isError).not.toBe(true);
    expect(routes).toHaveLength(3);
    expect(structured).toMatchObject({
      cap: 30,
      truncated: false,
      notice: 'Requested limit 101 was clamped to 30.',
    });
    expect(text).toContain('Requested limit 101 was clamped to 30.');
  });

  for (const limit of [0]) {
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

// ------------------------------------------------------------------
// #79 — a query shaped like a legacy APIv1 series ID is resolved through
// /v2/seriesid before the search waits on the warm. A hit answers alone, cold
// or warm; a 404 is the miss; any other failure degrades to the text search.
// ------------------------------------------------------------------

/** `/v2/seriesid` answers as EIA sent them on 2026-10-22, trimmed to one row's worth. */
const SERIES_ID_ANSWERS: Record<string, unknown> = {
  'PET.RWTC.W': {
    response: {
      total: 2129,
      frequency: 'weekly',
      data: [{ period: '2026-10-16', series: 'RWTC', value: 99.93 }],
      description: 'EIA petroleum gas survey data',
      id: 'petroleum',
    },
    request: {
      command: '/v2/seriesid/PET.RWTC.W',
      params: {
        frequency: 'weekly',
        data: ['value'],
        facets: { series: ['RWTC'] },
        start: null,
        end: null,
        sort: [{ column: 'period', direction: 'desc' }],
        offset: 0,
        length: 1,
      },
      route: 'petroleum/pri/spt',
    },
    apiVersion: '2.1.14',
  },
  'ELEC.GEN.ALL-US-99.Q': {
    response: {
      total: 100,
      frequency: 'quarterly',
      data: [],
      id: 'electric-power-operational-data',
    },
    request: {
      params: {
        frequency: 'quarterly',
        data: ['generation'],
        facets: { fueltypeid: ['ALL'], location: ['US'], sectorid: [99] },
      },
      route: 'electricity/electric-power-operational-data',
    },
  },
  // EIA maps this ID to a seriesId its aeo/2023 facet does not list, and its own
  // lookup reports the mapping matches no rows.
  'AEO.2023.REF2023.CNSM_NA_RESD_NA_ELC_NA_NA_QBTU.A': {
    response: { total: 0, dateFormat: 'YYYY', frequency: 'annual', data: [], id: '2023' },
    request: {
      command: '/v2/seriesid/AEO.2023.REF2023.CNSM_NA_RESD_NA_ELC_NA_NA_QBTU.A',
      params: {
        frequency: 'annual',
        data: ['value'],
        facets: { scenario: ['ref2023'], seriesId: ['cnsm_NA_resd_NA_elc_NA_NA_qbtu'] },
      },
      route: 'aeo/2023',
    },
  },
  'SEDS.TETCB.TX.A': {
    response: { total: 63, frequency: 'annual', data: [], id: 'seds' },
    request: {
      params: {
        frequency: 'annual',
        data: ['value'],
        facets: { seriesId: ['TETCB'], stateId: ['TX'] },
      },
      route: 'seds',
    },
  },
};

type LookupAnswer = 'stall' | 'unreachable' | PageFixture;

/**
 * The warm's endpoints from `bodies`, plus `/v2/seriesid/{id}` answered by
 * `answer` — called with the 1-based lookup number. A stalled lookup ends only
 * when its signal aborts. Any path can be held open; any host but EIA's throws.
 */
function stubSeriesLookup(
  answer: (id: string, call: number) => LookupAnswer,
  bodies: Record<string, unknown> = warmBodies(),
) {
  const paths: string[] = [];
  const urls: URL[] = [];
  const holds = new Map<string, Promise<void>>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname !== 'api.eia.gov') throw new Error(`Unmocked fetch to ${url.hostname}`);
      const path = url.pathname.replace(/^\/v2\/?/, '').replace(/\/$/, '');
      paths.push(path);
      urls.push(url);
      const signal = init?.signal as AbortSignal;
      const aborted = () =>
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });

      if (path.startsWith('seriesid/')) {
        const id = path.slice('seriesid/'.length);
        const reply = answer(id, paths.filter((p) => p.startsWith('seriesid/')).length);
        if (reply === 'stall') return aborted();
        if (reply === 'unreachable')
          throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });
        return httpResponse(reply);
      }

      const hold = holds.get(path);
      if (hold) await Promise.race([hold, aborted()]);
      signal.throwIfAborted();
      const body = bodies[path];
      if (body === undefined) return httpResponse({ status: 404, body: { error: 'not found' } });
      return httpResponse({ body });
    }),
  );
  return {
    paths,
    urls,
    lookups: () => paths.filter((path) => path.startsWith('seriesid/')),
    /** Hold `path` open until the warm's signal aborts. */
    hold: (path: string) => holds.set(path, new Promise<void>(() => {})),
  };
}

/** A lookup answered from `SERIES_ID_ANSWERS`, and EIA's 404 for any other ID. */
function knownIds(id: string): LookupAnswer {
  const body = SERIES_ID_ANSWERS[id];
  return body === undefined
    ? { status: 404, body: { error: `Series ID '${id}' is not valid.`, code: 404 } }
    : { body };
}

describe('EiaApiService.search — legacy APIv1 series IDs (#79)', () => {
  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', API_KEY);
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

  /** Run `call` to settlement under the fake clock; resolves with its outcome and elapsed ms. */
  async function settle<T>(call: Promise<T>) {
    const startedAt = Date.now();
    let settledAt: number | undefined;
    const outcome = call.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    void outcome.then(() => {
      settledAt = Date.now();
    });
    for (let i = 0; i < 70 && settledAt === undefined; i++)
      await vi.advanceTimersByTimeAsync(1_000);
    return { ...(await outcome), elapsedMs: (settledAt ?? Number.NaN) - startedAt };
  }

  it('answers a cold server with the one resolved result and starts no warm', async () => {
    const api = stubSeriesLookup(knownIds);

    const { results, hasMore, seriesId, status } = await getEiaApiService().search(
      'PET.RWTC.W',
      10,
      createMockContext(),
    );

    expect(api.paths).toEqual(['seriesid/PET.RWTC.W']);
    expect(api.urls[0]?.searchParams.get('length')).toBe('1');
    expect(results).toEqual([
      {
        entry: {
          route: 'petroleum/pri/spt',
          name: 'PET.RWTC.W',
          description: 'EIA petroleum gas survey data',
          category: undefined,
          isLeaf: true,
          filter_hint: { series: 'RWTC' },
          frequency: 'weekly',
          columns: ['value'],
        },
        score: 0,
      },
    ]);
    expect(hasMore).toBe(false);
    expect(seriesId).toMatchObject({ outcome: 'resolved', seriesId: 'PET.RWTC.W' });
    expect(status.size).toBe(0);
  });

  it('resolves a lowercase ID as its uppercase spelling, on both surfaces of the tool', async () => {
    const api = stubSeriesLookup(knownIds);

    const result = await runToolContract(searchRoutesTool, { query: 'pet.rwtc.w' });

    expect(api.lookups()).toEqual(['seriesid/PET.RWTC.W']);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      results: [
        {
          route: 'petroleum/pri/spt',
          filter_hint: { series: 'RWTC' },
          frequency: 'weekly',
          columns: ['value'],
          score: 0,
        },
      ],
      shown: 1,
      effectiveQuery: 'pet.rwtc.w',
      notice: expect.stringContaining('Resolved APIv1 series ID PET.RWTC.W'),
    });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain(
      'eia_query_route(route="petroleum/pri/spt", filters={"series": "RWTC"}, frequency="weekly", columns=["value"])',
    );
  });

  it.each([
    [
      'ELEC.GEN.ALL-US-99.Q',
      'electricity/electric-power-operational-data',
      { fueltypeid: 'ALL', location: 'US', sectorid: '99' },
    ],
    ['SEDS.TETCB.TX.A', 'seds', { seriesId: 'TETCB', stateId: 'TX' }],
  ])('maps %s to %s with every facet as a string', async (id, route, filters) => {
    stubSeriesLookup(knownIds);

    const { results } = await getEiaApiService().search(id, 10, createMockContext());

    expect(results).toHaveLength(1);
    expect(results[0]?.entry).toMatchObject({ route, filter_hint: filters });
  });

  it('marks a resolved ID whose lookup reports no rows, and only that one', async () => {
    stubSeriesLookup(knownIds);
    const aeo = 'AEO.2023.REF2023.CNSM_NA_RESD_NA_ELC_NA_NA_QBTU.A';

    const empty = await getEiaApiService().search(aeo, 10, createMockContext());
    expect(empty.seriesId).toMatchObject({ outcome: 'resolved', seriesId: aeo, empty: true });
    expect(empty.results[0]?.entry).toMatchObject({
      route: 'aeo/2023',
      filter_hint: { scenario: 'ref2023', seriesId: 'cnsm_NA_resd_NA_elc_NA_NA_qbtu' },
    });

    for (const id of ['PET.RWTC.W', 'SEDS.TETCB.TX.A']) {
      const { seriesId } = await getEiaApiService().search(id, 10, createMockContext());
      expect(seriesId?.outcome, id).toBe('resolved');
      expect(seriesId, id).not.toHaveProperty('empty');
    }
  });

  it.each([
    ['a string zero', '0', true],
    ['a string count', '307', false],
    ['no total', undefined, false],
  ])('reads %s as the row total', async (_name, total, empty) => {
    const body = structuredClone(SERIES_ID_ANSWERS['PET.RWTC.W']) as {
      response: Record<string, unknown>;
    };
    if (total === undefined) delete body.response.total;
    else body.response.total = total;
    stubSeriesLookup(() => ({ body }));

    const { seriesId } = await getEiaApiService().search('PET.RWTC.W', 10, createMockContext());

    expect(seriesId?.outcome).toBe('resolved');
    expect(seriesId && 'empty' in seriesId).toBe(empty);
  });

  it('tells the caller, on both surfaces, that a mapping with no rows returns none', async () => {
    stubSeriesLookup(knownIds);
    const aeo = 'AEO.2023.REF2023.CNSM_NA_RESD_NA_ELC_NA_NA_QBTU.A';

    const result = await runToolContract(searchRoutesTool, { query: aeo });

    const notice = `Resolved APIv1 series ID ${aeo} to route aeo/2023 through EIA's series lookup, but EIA reports no rows for that mapping, so eia_query_route with it returns none; search for the series by name, or use eia_describe_route with values_query to find its current ID.`;
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ shown: 1, notice });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain(notice);
  });

  it('answers a warm server with the resolved result alone, ahead of any text match', async () => {
    const api = stubSeriesLookup(knownIds);
    await getEiaApiService().search('wind', 5, createMockContext());
    const warmRequests = api.paths.length;

    const { results, status } = await getEiaApiService().search(
      'PET.RWTC.W',
      10,
      createMockContext(),
    );

    expect(api.paths.slice(warmRequests)).toEqual(['seriesid/PET.RWTC.W']);
    expect(results.map((r) => r.entry.route)).toEqual(['petroleum/pri/spt']);
    expect(status.complete).toBe(true);
  });

  it.each([
    [
      'a 404',
      { status: 404, body: { error: "Series ID 'RETAIL.SALES.M' is not valid.", code: 404 } },
    ],
    ['a 400', { status: 400, body: { error: 'Invalid series ID', code: 400 } }],
    ['a 414', { status: 414, body: '<html><body>Request-URI Too Long</body></html>' }],
  ])('falls back to the text search on %s, asking once', async (_name, reply) => {
    const api = stubSeriesLookup(() => reply);

    // Shaped like an ID, and a text match for a route in the warmed corpus.
    const { results, seriesId, status } = await getEiaApiService().search(
      'Retail.Sales.M',
      10,
      createMockContext(),
    );

    expect(api.lookups()).toEqual(['seriesid/RETAIL.SALES.M']);
    expect(seriesId).toEqual({ outcome: 'unrecognized', seriesId: 'RETAIL.SALES.M' });
    // The warm ran after the lookup, and the text search answered from it.
    expect(api.paths.indexOf('')).toBeGreaterThan(0);
    expect(status.complete).toBe(true);
    expect(results[0]?.entry.route).toBe('electricity/retail-sales');
    expect(results[0]?.entry).not.toHaveProperty('frequency');
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it('looks up a non-ID that fits the grammar, then answers with the text search', async () => {
    const api = stubSeriesLookup(knownIds);

    const result = await runToolContract(searchRoutesTool, { query: 'U.S.A' });

    expect(api.lookups()).toEqual(['seriesid/U.S.A']);
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { notice: string }).notice).toContain(
      'U.S.A has the shape of an APIv1 series ID, but EIA does not recognize it',
    );
  });

  it.each(['Henry Hub', 'petroleum/pri/spt', 'U.S. crude oil stocks', 'retail sales'])(
    'makes no lookup for %s',
    async (query) => {
      const api = stubSeriesLookup(knownIds);

      const { seriesId } = await getEiaApiService().search(query, 10, createMockContext());

      expect(api.lookups()).toEqual([]);
      expect(seriesId).toBeUndefined();
    },
  );

  it.each([
    ['5xx', { status: 503, body: 'Service Unavailable' }, 'upstream_unavailable'],
    ['rate limit', { status: 429, body: 'OVER_RATE_LIMIT' }, 'rate_limited'],
    ['unreachable host', 'unreachable' as const, 'upstream_unreachable'],
  ])(
    'falls back with a retryable failure once a persistent %s spends its retries',
    async (_name, reply, reason) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const api = stubSeriesLookup(() => reply);

      const result = await settle(getEiaApiService().search('PET.RWTC.W', 10, createMockContext()));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.seriesId).toEqual({
        outcome: 'failed',
        seriesId: 'PET.RWTC.W',
        retryable: true,
        reason,
      });
      // One request and three retries, all inside the 10 s lookup budget.
      expect(api.lookups()).toHaveLength(4);
      expect(api.paths).toContain('');
      expect(result.value.status.complete).toBe(true);
      expect(result.elapsedMs).toBeLessThanOrEqual(10_000);
    },
  );

  it('cuts a stalled lookup at its 10 s budget as upstream_timeout, then answers from text', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const api = stubSeriesLookup(() => 'stall');

    const result = await settle(runToolContract(searchRoutesTool, { query: 'PET.RWTC.W' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isError).not.toBe(true);
    expect((result.value.structuredContent as { notice: string }).notice).toContain(
      'PET.RWTC.W has the shape of an APIv1 series ID, but looking it up failed (upstream_timeout); these are text-search results — retry to resolve the ID.',
    );
    expect(api.lookups()).toEqual(['seriesid/PET.RWTC.W']);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(10_000);
    expect(result.elapsedMs).toBeLessThan(11_000);
  });

  it('holds a stalled lookup and a stalled warm together inside the 45 s search ceiling', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const api = stubSeriesLookup(() => 'stall');
    api.hold('');

    const result = await settle(getEiaApiService().search('PET.RWTC.W', 10, createMockContext()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.seriesId).toMatchObject({ outcome: 'failed', reason: 'upstream_timeout' });
    expect(result.value.status.size).toBe(0);
    // 10 s of lookup, then what is left of the 45 s warm budget — not 10 + 45.
    expect(result.elapsedMs).toBeGreaterThanOrEqual(44_000);
    expect(result.elapsedMs).toBeLessThanOrEqual(45_000);
    shutdownEiaApiService();
  });

  it('reports an answer missing its route or facets as a failed lookup, asking once', async () => {
    const api = stubSeriesLookup(() => ({ body: { response: { total: 0, data: [] } } }));

    const { seriesId } = await getEiaApiService().search('PET.RWTC.W', 10, createMockContext());

    expect(seriesId).toEqual({
      outcome: 'failed',
      seriesId: 'PET.RWTC.W',
      retryable: true,
      reason: 'upstream_invalid_response',
    });
    expect(api.lookups()).toHaveLength(1);
  });

  it('reports a non-retryable failure without retrying it', async () => {
    const api = stubSeriesLookup(() => ({ status: 501, body: 'Not Implemented' }));

    const { seriesId } = await getEiaApiService().search('PET.RWTC.W', 10, createMockContext());

    expect(seriesId).toMatchObject({ outcome: 'failed', retryable: false });
    expect(api.lookups()).toHaveLength(1);
  });

  it('keeps a caller abort during the lookup a cancellation and starts no warm', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const api = stubSeriesLookup(() => 'stall');
    const caller = new AbortController();
    const reason = new Error('client cancelled');
    const call = runToolContract(
      searchRoutesTool,
      { query: 'PET.RWTC.W' },
      { context: { signal: caller.signal } },
    );

    await vi.advanceTimersByTimeAsync(2_000);

    expectCancelledBy(await settleOnAbort(call, () => caller.abort(reason)), reason);
    expect(api.paths).toEqual(['seriesid/PET.RWTC.W']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
