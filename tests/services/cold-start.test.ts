/**
 * @fileoverview The first calls on a fresh process, against a mocked `fetch`:
 * a cold browse, describe, or query waits on the shared route-tree build for at
 * most `ROUTE_WARM_BUDGET_MS`, then answers from a live fetch of its own route
 * while the warm keeps running (#74); and `rate_limited` from the cold build
 * reaches browse and search with a declared recovery (#75). Driven through the
 * real service and its retry, rate-limit, and route-normalization paths.
 * @module tests/services/cold-start.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetServerConfig } from '@/config/server-config.js';
import { browseRoutesTool } from '@/mcp-server/tools/definitions/browse-routes.tool.js';
import { describeRouteTool } from '@/mcp-server/tools/definitions/describe-route.tool.js';
import { queryRouteTool } from '@/mcp-server/tools/definitions/query-route.tool.js';
import { searchRoutesTool } from '@/mcp-server/tools/definitions/search-routes.tool.js';
import {
  _resetEiaApiService,
  getEiaApiService,
  initEiaApiService,
  ROUTE_WARM_BUDGET_MS,
} from '@/services/eia/eia-service.js';
import { _resetRouteCache, getIndexStatus, isRouteCacheReady } from '@/services/eia/route-cache.js';

const LEAF_META = (id: string, facetId: string) => ({
  id,
  name: id,
  description: `${id} leaf`,
  facets: [{ id: facetId, description: 'Facet' }],
  frequency: [{ id: 'annual', description: 'Annual', query: 'A', format: 'YYYY' }],
  data: { price: { alias: 'Price', units: 'cents per kilowatt-hour' } },
  defaultFrequency: 'annual',
  defaultDateFormat: 'YYYY',
});

/**
 * A two-level taxonomy of bare stubs, the shape EIA serves: every child below
 * the root costs a metadata request before anything knows whether it is a leaf.
 */
function coldBodies(): Record<string, unknown> {
  return {
    '': {
      response: {
        routes: [
          { id: 'electricity', name: 'Electricity', description: 'EIA electricity survey data' },
          { id: 'steo', name: 'Short Term Energy Outlook', description: 'STEO' },
        ],
      },
    },
    electricity: {
      response: {
        id: 'electricity',
        name: 'Electricity',
        description: 'EIA electricity survey data',
        routes: [
          {
            id: 'retail-sales',
            name: 'Electricity Sales to Ultimate Customers',
            description: 'Electricity sales by state  \n    Sources: Forms EIA-826',
          },
          { id: 'rto', name: 'Electric Power Operations (Daily and Hourly)', description: 'RTO' },
        ],
      },
    },
    // EIA answers a leaf with its domain category as `id` and no `name`.
    'electricity/retail-sales': {
      response: { ...LEAF_META('electricity', 'stateid'), name: undefined },
    },
    'electricity/retail-sales/facet/stateid': {
      response: { totalFacets: 1, facets: [{ id: 'TX', name: 'Texas' }] },
    },
    'electricity/retail-sales/data': {
      response: {
        total: '1',
        dateFormat: 'YYYY',
        frequency: 'annual',
        data: [{ period: '2024', stateid: 'TX', price: '14.94', 'price-units': 'cents' }],
      },
    },
    'electricity/rto': {
      response: {
        id: 'rto',
        name: 'Electric Power Operations (Daily and Hourly)',
        description: 'RTO',
        routes: [{ id: 'fuel-type-data', name: 'Hourly Generation by Energy Source' }],
      },
    },
    'electricity/rto/fuel-type-data': { response: LEAF_META('electricity', 'fueltype') },
    steo: { response: LEAF_META('steo', 'seriesId') },
    'steo/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
    'seds/facet/seriesId': { response: { totalFacets: 0, facets: [] } },
    'electricity/retail-sales/facet/fueltype': { response: { totalFacets: 0, facets: [] } },
    'electricity/rto/fuel-type-data/facet/fueltype': { response: { totalFacets: 0, facets: [] } },
  };
}

/**
 * Fake EIA by path. A held path stays open — honouring the signal it was
 * fetched under, as real `fetch` does — until the test releases it. Records
 * each fetch with the signal it carried.
 */
function stubEia(bodies: Record<string, unknown>) {
  const fetches: Array<{ path: string; signal: AbortSignal | undefined; url: URL }> = [];
  const holds = new Map<string, Promise<void>>();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/v2\/?/, '').replace(/\/$/, '');
      const signal = init?.signal ?? undefined;
      fetches.push({ path, signal, url });
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
      if (body === undefined)
        return Response.json({ error: 'Not found.', code: 404 }, { status: 404 });
      return typeof body === 'function' ? (body as () => Response)() : Response.json(body);
    }),
  );

  return {
    fetches,
    count: (path: string) => fetches.filter((f) => f.path === path).length,
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

/** Track whether a promise has settled, without awaiting it. */
function tracked<T>(promise: Promise<T>) {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

function resetAll() {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _resetServerConfig();
  _resetRouteCache();
  _resetEiaApiService();
}

beforeEach(() => {
  resetAll();
  vi.useFakeTimers();
  vi.stubEnv('EIA_API_KEY', 'test-key');
  vi.stubEnv('EIA_BASE_URL', 'https://api.eia.gov/v2');
  initEiaApiService();
});

afterEach(resetAll);

// ------------------------------------------------------------------
// #74 — a cold call waits on the shared tree for a bounded time, then answers
// from what it can fetch for its one route.
// ------------------------------------------------------------------

describe('a cold browse, describe, or query answers within a bounded wait (#74)', () => {
  it('bounds the wait below the MCP client request timeout', () => {
    expect(ROUTE_WARM_BUDGET_MS).toBeGreaterThan(0);
    expect(ROUTE_WARM_BUDGET_MS).toBeLessThan(60_000);
  });

  it('browses a path live once the budget runs out, classifying each child', async () => {
    const eia = stubEia(coldBodies());
    eia.hold('');

    const browse = getEiaApiService().browse('/electricity/', createMockContext());
    const state = tracked(browse);
    await vi.advanceTimersByTimeAsync(ROUTE_WARM_BUDGET_MS - 1);
    expect(state.settled).toBe(false);
    expect(eia.count('electricity')).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    const result = await browse;

    expect(result).toEqual({
      path: 'electricity',
      isLeaf: false,
      children: [
        {
          id: 'retail-sales',
          name: 'Electricity Sales to Ultimate Customers',
          description: 'electricity leaf',
          route: 'electricity/retail-sales',
          isLeaf: true,
        },
        {
          id: 'rto',
          name: 'Electric Power Operations (Daily and Hourly)',
          description: 'RTO',
          route: 'electricity/rto',
          isLeaf: false,
        },
      ],
    });
    // The shared build is still waiting on EIA, under a signal the caller never owned.
    const root = eia.fetches.find((f) => f.path === '');
    expect(root?.signal?.aborted).toBe(false);
    expect(isRouteCacheReady()).toBe(false);
  });

  it('browses a nested category live, past the first level', async () => {
    const eia = stubEia(coldBodies());
    eia.hold('');

    const browse = getEiaApiService().browse('electricity/rto', createMockContext());
    await vi.advanceTimersByTimeAsync(ROUTE_WARM_BUDGET_MS);
    const result = await browse;

    expect(result.isLeaf).toBe(false);
    expect(result.children).toEqual([
      {
        id: 'fuel-type-data',
        name: 'Hourly Generation by Energy Source',
        description: 'electricity leaf',
        route: 'electricity/rto/fuel-type-data',
        isLeaf: true,
      },
    ]);
  });

  it('classifies a missing cold-browse metadata envelope as retryable upstream_invalid_response', async () => {
    const eia = stubEia({ ...coldBodies(), electricity: {} });
    eia.hold('');
    const pending = runToolContract(browseRoutesTool, { path: 'electricity' });
    await vi.advanceTimersByTimeAsync(ROUTE_WARM_BUDGET_MS);
    const result = await pending;
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'upstream_invalid_response',
          retryable: true,
          recovery: { hint: 'Retry the call; if it persists, check api.eia.gov availability.' },
        },
      },
    });
    expect(eia.count('electricity')).toBe(1);
    expect(result.content).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining(
          'Retry the call; if it persists, check api.eia.gov availability.',
        ),
      }),
    );
  });

  it('browses a leaf live as a leaf, and the root live as its top-level routes', async () => {
    const eia = stubEia(coldBodies());
    // Block the build below the root, so the caller's own root fetch still answers.
    eia.hold('electricity/rto/fuel-type-data');

    const leaf = getEiaApiService().browse('electricity/retail-sales', createMockContext());
    const root = getEiaApiService().browse(undefined, createMockContext());
    await vi.advanceTimersByTimeAsync(ROUTE_WARM_BUDGET_MS);

    expect(await leaf).toEqual({ path: 'electricity/retail-sales', children: [], isLeaf: true });
    const top = await root;
    expect(top.path).toBe('');
    expect(top.children.map((c) => [c.route, c.isLeaf])).toEqual([
      ['electricity', false],
      ['steo', true],
    ]);
    expect(isRouteCacheReady()).toBe(false);
  });

  it('fails an unknown path live as route_not_found', async () => {
    const eia = stubEia(coldBodies());
    eia.hold('');

    const browse = getEiaApiService().browse('electricity/bogus', createMockContext());
    browse.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(ROUTE_WARM_BUDGET_MS);

    await expect(browse).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'route_not_found' },
    });
  });

  it('answers from the tree, with no live request, when it lands inside the budget', async () => {
    const eia = stubEia(coldBodies());
    const releaseRoot = eia.hold('');

    const browse = getEiaApiService().browse('electricity', createMockContext());
    await vi.advanceTimersByTimeAsync(ROUTE_WARM_BUDGET_MS - 1);
    releaseRoot();
    await vi.advanceTimersByTimeAsync(0);
    const result = await browse;

    expect(result.children.map((c) => c.route)).toEqual([
      'electricity/retail-sales',
      'electricity/rto',
    ]);
    // One fetch of the category, and it was the warm's.
    expect(eia.count('electricity')).toBe(1);
    expect(isRouteCacheReady()).toBe(true);
  });

  it('counts the budget from the start of the warm, not from each call', async () => {
    const eia = stubEia(coldBodies());
    eia.hold('');

    // The first call starts the warm and waits out the whole budget.
    const first = getEiaApiService().browse('electricity', createMockContext());
    await vi.advanceTimersByTimeAsync(ROUTE_WARM_BUDGET_MS / 2);

    // A call arriving halfway waits only for the remainder…
    const midway = getEiaApiService().browse('electricity/rto', createMockContext());
    const midwayState = tracked(midway);
    await vi.advanceTimersByTimeAsync(ROUTE_WARM_BUDGET_MS / 2);
    await first;
    await midway;
    expect(midwayState.settled).toBe(true);

    // …and one arriving after it goes live at once, with no wait of its own.
    const late = getEiaApiService().browse('electricity/rto', createMockContext());
    const lateState = tracked(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateState.settled).toBe(true);
    expect((await late).children[0]?.route).toBe('electricity/rto/fuel-type-data');
    expect(isRouteCacheReady()).toBe(false);
  });

  it('describes live once the budget runs out, keeping its typed failures', async () => {
    const eia = stubEia(coldBodies());
    eia.hold('');

    const ctx = createMockContext();
    const described = getEiaApiService().describe('electricity/retail-sales', ctx);
    const category = getEiaApiService().describe('electricity/rto', ctx);
    const missing = getEiaApiService().describe('electricity/bogus', ctx);
    category.catch(() => undefined);
    missing.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(ROUTE_WARM_BUDGET_MS);

    const meta = await described;
    expect(meta.route).toBe('electricity/retail-sales');
    expect(meta.facets).toEqual([
      {
        id: 'stateid',
        description: 'Facet',
        values: [{ id: 'TX', name: 'Texas' }],
        complete: true,
        fetchedAt: expect.any(Number),
      },
    ]);
    await expect(category).rejects.toMatchObject({ data: { reason: 'route_not_queryable' } });
    await expect(missing).rejects.toMatchObject({ data: { reason: 'route_not_found' } });
  });

  it('queries live once the budget runs out, classifying the route before the data request', async () => {
    const eia = stubEia(coldBodies());
    eia.hold('');

    const ctx = createMockContext();
    const data = getEiaApiService().query('electricity/retail-sales', {}, ctx);
    // EIA answers a category's /data with a bare 404, so without the metadata
    // request this would fail as route_not_found.
    const category = getEiaApiService().query('electricity/rto', { columns: ['price'] }, ctx);
    category.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(ROUTE_WARM_BUDGET_MS);

    const result = await data;
    expect(result.route).toBe('electricity/retail-sales');
    expect(result.data).toEqual([
      { period: '2024', stateid: 'TX', price: '14.94', 'price-units': 'cents' },
    ]);
    const dataRequest = eia.fetches.find((f) => f.path === 'electricity/retail-sales/data');
    expect(dataRequest?.url.searchParams.getAll('data[]')).toEqual(['price']);

    await expect(category).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'route_not_queryable' },
    });
    expect(eia.count('electricity/rto/data')).toBe(0);
  });

  it('ends only the cancelled caller’s wait; the warm completes and a later call sees it', async () => {
    const eia = stubEia(coldBodies());
    const releaseRoot = eia.hold('');
    const cancelling = new AbortController();

    const browse = getEiaApiService().browse(
      'electricity',
      createMockContext({ signal: cancelling.signal }),
    );
    browse.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    cancelling.abort(new Error('client timed out'));

    await expect(browse).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(eia.fetches.find((f) => f.path === '')?.signal?.aborted).toBe(false);

    releaseRoot();
    await vi.advanceTimersByTimeAsync(0);
    const later = await getEiaApiService().browse('electricity/rto', createMockContext());
    expect(later.children[0]?.route).toBe('electricity/rto/fuel-type-data');
    expect(isRouteCacheReady()).toBe(true);
    expect(getIndexStatus().incompleteRoutes).toEqual([]);
  });

  it('ends only the caller’s own live fetch when it cancels after the budget', async () => {
    const eia = stubEia(coldBodies());
    const releaseRoot = eia.hold('');
    const releaseCategory = eia.hold('electricity');
    const cancelling = new AbortController();

    const browse = getEiaApiService().browse(
      'electricity',
      createMockContext({ signal: cancelling.signal }),
    );
    browse.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(ROUTE_WARM_BUDGET_MS);
    expect(eia.count('electricity')).toBe(1);
    cancelling.abort(new Error('client timed out'));
    // The caller's own fetch rejects with its abort, as any mid-request cancel does.
    await expect(browse).rejects.toThrow('client timed out');

    releaseRoot();
    releaseCategory();
    await vi.advanceTimersByTimeAsync(0);
    const later = await getEiaApiService().browse('electricity', createMockContext());
    expect(later.children.map((c) => c.isLeaf)).toEqual([true, false]);
    expect(isRouteCacheReady()).toBe(true);
  });

  it('answers a cold eia_browse_routes call on both surfaces', async () => {
    const eia = stubEia(coldBodies());
    eia.hold('');

    const call = runToolContract(browseRoutesTool, { path: 'electricity' });
    await vi.advanceTimersByTimeAsync(ROUTE_WARM_BUDGET_MS);
    const result = await call;

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      path: 'electricity',
      isLeaf: false,
      children: [
        { route: 'electricity/retail-sales', isLeaf: true },
        { route: 'electricity/rto', isLeaf: false },
      ],
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('[leaf] **electricity/retail-sales** (retail-sales)');
    expect(text).toContain('[cat] **electricity/rto** (rto)');
  });

  it('answers a cold eia_query_route call on both surfaces', async () => {
    const eia = stubEia(coldBodies());
    eia.hold('');

    const call = runToolContract(queryRouteTool, { route: 'electricity/retail-sales' });
    await vi.advanceTimersByTimeAsync(ROUTE_WARM_BUDGET_MS);
    const result = await call;

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      route: 'electricity/retail-sales',
      total: 1,
      returned_count: 1,
      data: [{ period: '2024', price: '14.94' }],
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('| 2024 | TX | 14.94 |');
  });

  it('answers a cold eia_describe_route call on both surfaces', async () => {
    const eia = stubEia(coldBodies());
    eia.hold('');

    const call = runToolContract(describeRouteTool, { route: 'electricity/retail-sales' });
    await vi.advanceTimersByTimeAsync(ROUTE_WARM_BUDGET_MS);
    const result = await call;

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      route: 'electricity/retail-sales',
      facets: [{ id: 'stateid', values: [{ id: 'TX', name: 'Texas' }], value_count: 1 }],
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('**stateid** (1 values): Facet — TX=Texas');
  });
});

// ------------------------------------------------------------------
// #75 — browse and search reach EIA through the cold build, whose fetches can
// fail as rate_limited, so both declare it as describe and query do.
// ------------------------------------------------------------------

describe('rate_limited from the cold build reaches browse and search declared (#75)', () => {
  const overRateLimit = () =>
    Response.json({ error: { code: 'OVER_RATE_LIMIT', message: 'over limit' } }, { status: 429 });

  /** Settle a call while running out the retry backoff on the fake clock. */
  async function settle<T>(call: Promise<T>): Promise<T> {
    call.catch(() => undefined);
    await vi.runAllTimersAsync();
    return call;
  }

  const declared = (definition: { errors?: readonly { reason: string; recovery: string }[] }) =>
    definition.errors?.find((entry) => entry.reason === 'rate_limited');

  it('declares rate_limited on browse and search exactly as describe and query do', () => {
    const reference = declared(describeRouteTool) as Record<string, unknown>;
    expect(declared(queryRouteTool)).toMatchObject({
      code: reference.code,
      retryable: true,
      recovery: reference.recovery,
    });
    for (const definition of [browseRoutesTool, searchRoutesTool]) {
      expect(declared(definition), definition.name).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        retryable: true,
        recovery: reference.recovery,
      });
    }
  });

  for (const [definition, input] of [
    [browseRoutesTool, {}],
    [browseRoutesTool, { path: 'electricity' }],
    [searchRoutesTool, { query: 'retail sales' }],
  ] as const) {
    it(`${definition.name} ${JSON.stringify(input)} carries the declared recovery on both surfaces`, async () => {
      stubEia({ ...coldBodies(), '': overRateLimit });
      const recovery = declared(definition)?.recovery as string;

      const result = await settle(runToolContract(definition, input));

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'rate_limited', recovery: { hint: recovery } },
        },
      });
      expect(result.content).toContainEqual(
        expect.objectContaining({ text: expect.stringContaining(recovery) }),
      );
    });
  }

  it('carries it too when the live fetch after the budget is the one rate-limited', async () => {
    const eia = stubEia({ ...coldBodies(), electricity: overRateLimit });
    eia.hold('');
    const recovery = declared(browseRoutesTool)?.recovery as string;

    const result = await settle(runToolContract(browseRoutesTool, { path: 'electricity' }));

    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'rate_limited', recovery: { hint: recovery } } },
    });
  });
});
