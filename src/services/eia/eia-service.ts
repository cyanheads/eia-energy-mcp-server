/**
 * @fileoverview EIA API v2 service. Wraps api.eia.gov/v2 with retry/timeout,
 * route tree caching, per-route facet metadata caching, and Fuse.js fuzzy
 * search. Exposes browse, describe, query, and search methods consumed by MCP
 * tool handlers. All three route-taking methods normalize the path first, so
 * one route resolves the same way however it is spelled and the node map and
 * per-route metadata cache hold a single entry for it. `query()` also walks
 * `offset` pages past the inline preview when the caller asks for a
 * canvas-bound row set, bounded by EIA_CANVAS_MAX_ROWS.
 * Facet values reach the search index from two directions: a bounded pass over
 * the vocabulary facets named in the route tree, and every route the caller
 * describes. Both feed the per-route metadata cache, which always holds the
 * full uncapped value set — the cap in eia_describe_route shapes its own
 * response only. Rate-limit detection: EIA returns `OVER_RATE_LIMIT` in the
 * response body — classified as ServiceUnavailable (retryable).
 *
 * The warm has two milestones. `ensureTreeWarmed` resolves once the route tree
 * is built — all browse, describe, and query need. `ensureIndexWarmed` also
 * awaits the two index-widening passes, so `search` never ranks against a
 * half-filled corpus; that wait is bounded by `SEARCH_WARM_BUDGET_MS` so a
 * degraded upstream cannot hold a call past the client's own request timeout.
 * Fetches that fail past their retry budget are recorded rather than swallowed:
 * the node is kept as an incomplete stub, named in `getIndexStatus()`, and
 * re-fetched by `repairNode` on the next browse that needs it.
 * @module services/eia/eia-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  addEntriesToIndex,
  getChildren,
  getIndexSize,
  getIndexStatus,
  getNode,
  type IndexStatus,
  indexFacetValues,
  initRouteCache,
  isLeafNode,
  isRouteCacheReady,
  listVocabularyFacets,
  markIndexPassSettled,
  normalizeDescription,
  replaceNode,
  searchRoutes,
} from './route-cache.js';
import type {
  AccumulatedRows,
  DataResponse,
  DataRow,
  EiaWarning,
  Facet,
  RawFacetMeta,
  RawFacetResponse,
  RawFacetValue,
  RawFrequency,
  RawRouteNode,
  RouteEntry,
  RouteMetadata,
  SearchIndexEntry,
} from './types.js';

/**
 * EIA's hard per-request row ceiling. Requesting more is not an error — the API
 * returns the first 5,000 rows plus a `parameter out of range: length` warning.
 */
const EIA_MAX_ROWS_PER_REQUEST = 5000;

/**
 * Parallel `/facet/{id}` fetches allowed during the vocabulary pass. EIA
 * answers `OVER_RATE_LIMIT` to an unbounded burst, so the pass is deliberately
 * paced rather than fanned out with a single `Promise.all`.
 */
const FACET_INDEX_CONCURRENCY = 4;

/**
 * Parallel metadata fetches allowed during the route-tree build. The build
 * costs ~270 requests, and fanning them out with an unbounded `Promise.all` is
 * what drew the `OVER_RATE_LIMIT` rejections that used to leave whole subtrees
 * missing from the corpus. Measured against the live taxonomy: unbounded loses
 * up to 3 nodes on 1 cold start in 5, 8 loses none. Halving it to 4 costs ~9 s
 * of warm and clears no additional misses — the residual ones are cleared by
 * the serial sweep in `buildTree` instead.
 */
export const TREE_BUILD_CONCURRENCY = 8;

/**
 * Ceiling on how long `search` waits for the corpus. The whole warm lands in
 * 24–30 s measured over seven cold runs against the live API, so this never
 * fires on a healthy run. It bounds the degraded one: the serial sweep spends
 * up to four attempts and ~7 s of backoff on each node it still cannot reach,
 * so the warm that loses nodes is also the warm that takes longest, and a call
 * held past the client's request timeout (60 s in the MCP SDK) fails as a
 * transport error carrying none of the recovery hint the tool would otherwise
 * return. On expiry the search answers from what is indexed so far, reported as
 * usual by `indexComplete`.
 */
const SEARCH_WARM_BUDGET_MS = 45_000;

/**
 * Await `promise`, giving up at `deadline`. Resolves true when the promise won
 * and false when the deadline did; a rejection still propagates. A promise the
 * deadline beat is left running — the warm it stands for keeps filling the
 * index for the next caller.
 */
function raceDeadline(promise: Promise<void>, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), remaining);
    promise.then(() => resolve(true), reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Caps how many fetches run at once across a whole recursive tree build. A
 * shared gate rather than a per-level `Promise.all` bound, because a node's
 * children are fetched from inside its own task — the recursion would otherwise
 * multiply each level's width.
 *
 * That same shape is why a slot must cover the fetch and nothing more. Hold one
 * across the recursion and the build wedges as soon as every slot belongs to a
 * parent waiting on a child that can never acquire one; `tests/services/
 * eia-service.test.ts` builds a tree wide enough to prove it does not.
 */
class ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/**
 * Canonical spelling of a route path: no leading or trailing slash, no repeated
 * internal ones. EIA's own docs and data browser write routes as
 * `/v2/electricity/retail-sales/`, so those spellings reach the tools verbatim,
 * while the node map and the per-route metadata cache are keyed on the bare
 * form. Normalizing at the service boundary is what makes every spelling resolve
 * against the cached tree — and what keeps one route from occupying three cache
 * entries and costing three facet fan-outs.
 */
function normalizeRoutePath(path: string): string {
  return path
    .trim()
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/** Message text for a caught value of unknown type. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Route paths in a built tree whose metadata fetch failed. */
function incompletePaths(nodes: RawRouteNode[], parentPath = ''): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    const path = parentPath ? `${parentPath}/${node.id}` : node.id;
    if (node.incomplete) paths.push(path);
    if (node.routes?.length) paths.push(...incompletePaths(node.routes, path));
  }
  return paths;
}

/**
 * EIA 400 bodies name the rejected dimension verbatim ("Invalid data 'bogus'
 * provided.", "Invalid frequency 'hourly' provided.", "Invalid sort 'bogus'
 * provided.", "Invalid date format 'not-a-date' provided."). Map each to the
 * reason and recovery that points at the right part of eia_describe_route's
 * output; anything unmatched falls back to invalid_facet.
 */
const INVALID_PARAM_REASONS = [
  {
    hint: 'Call eia_describe_route and pick a column from data_columns[].id.',
    pattern: /invalid data\b/i,
    reason: 'invalid_column',
  },
  {
    hint: 'Call eia_describe_route and pick a frequency from frequencies[].id.',
    pattern: /invalid frequency\b/i,
    reason: 'invalid_frequency',
  },
  {
    hint: 'Call eia_describe_route and sort by a column ID from data_columns[].id or a facet ID from facets[].id.',
    pattern: /invalid sort\b/i,
    reason: 'invalid_sort',
  },
  {
    hint: 'Call eia_describe_route and use the period format frequencies[].format gives for the chosen frequency.',
    pattern: /invalid date format\b/i,
    reason: 'invalid_period',
  },
] as const;

/**
 * One page of /v2/{route}/data/, past the `response` presence check.
 * `warnings` is a top-level sibling of `response`, not a member of it.
 */
interface DataPage {
  response: {
    data?: DataRow[];
    dateFormat?: string;
    frequency?: string;
    total?: string;
  };
  warnings?: EiaWarning[];
}

/** Per-route merged metadata cache (populated by describe). */
const _routeMetaCache = new Map<string, RouteMetadata>();

/** The two milestones of a single in-flight warm, shared by every caller. */
interface WarmHandles {
  /** Resolves once both index-widening passes have settled — and through a failed tree build. */
  index: Promise<void>;
  /** Resolves once the route tree is built; rejects when the build fails. */
  tree: Promise<void>;
}

/** The one warm in flight or already done (prevents duplicate warm-up). */
let _warm: WarmHandles | undefined;

class EiaApiService {
  private get baseUrl(): string {
    return getServerConfig().baseUrl;
  }

  private get apiKey(): string {
    return getServerConfig().apiKey;
  }

  private buildUrl(path: string, params: Record<string, string | string[]> = {}): string {
    const url = new URL(`${this.baseUrl}/${path}`);
    url.searchParams.set('api_key', this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, v);
      } else {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  private fetchJson<T>(
    path: string,
    params: Record<string, string | string[]> = {},
    ctx: Context,
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    return withRetry(
      async () => {
        const response = await fetch(url, { signal: ctx.signal });
        const text = await response.text();

        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('EIA API returned HTML — likely rate-limited or unavailable.', {
            reason: 'rate_limited',
          });
        }

        if (!response.ok) {
          if (response.status === 429 || text.includes('OVER_RATE_LIMIT')) {
            throw serviceUnavailable('EIA rate limit exceeded.', {
              reason: 'rate_limited',
            });
          }

          // Parse EIA's error body — it often includes an actionable message.
          // Shape: { error: string, code: number } or plain text.
          let upstreamMessage: string | undefined;
          try {
            const errBody = JSON.parse(text) as Record<string, unknown>;
            if (typeof errBody.error === 'string') upstreamMessage = errBody.error;
          } catch {
            // non-JSON body — ignore
          }

          const detail = upstreamMessage
            ? `EIA API error: ${upstreamMessage}`
            : `EIA API returned HTTP ${response.status}.`;

          if (response.status === 404) {
            // 404s are definitive — NotFound code is not transient, withRetry won't retry
            throw notFound(detail, { status: response.status });
          }

          if (response.status === 400) {
            // 400s are definitive — ValidationError code is not transient, withRetry won't retry
            throw validationError(detail, { status: response.status });
          }

          // 5xx and other status codes — transient, eligible for retry
          throw serviceUnavailable(detail, { status: response.status });
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw serviceUnavailable('EIA API returned non-JSON response.', {
            reason: 'rate_limited',
          });
        }

        const parsedResponse =
          typeof parsed === 'object' && parsed !== null && 'response' in parsed
            ? (parsed as { response: unknown }).response
            : undefined;
        if (typeof parsedResponse === 'string' && parsedResponse.includes('OVER_RATE_LIMIT')) {
          throw serviceUnavailable('EIA rate limit exceeded (OVER_RATE_LIMIT).', {
            reason: 'rate_limited',
          });
        }

        return parsed as T;
      },
      {
        operation: 'EiaApiService.fetchJson',
        baseDelayMs: 1000,
        context: ctx,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Await the route tree — everything browse, describe, and query need. The
   * index-widening passes may still be running when this resolves.
   */
  async ensureTreeWarmed(ctx: Context): Promise<void> {
    if (isRouteCacheReady()) return;
    await this.warm(ctx).tree;
  }

  /**
   * Await the fully warmed corpus — the tree plus both index-widening passes.
   * Search takes this path so a caller is never handed a ranking computed over
   * a half-filled index, which reads exactly like a ranking over the whole one.
   * The wait is paid once per process; every later search is served from memory.
   *
   * `budgetMs` caps the wait, so an upstream slow enough to outlast the client's
   * own request timeout degrades to a partial answer the caller can recognize
   * rather than to a transport error. A build failure still rejects.
   */
  async ensureIndexWarmed(ctx: Context, budgetMs: number): Promise<void> {
    const warm = this.warm(ctx);
    const deadline = Date.now() + budgetMs;

    if (!(await raceDeadline(warm.tree, deadline))) {
      ctx.log.warning('Answering before the EIA route tree finished warming', { budgetMs });
      return;
    }
    if (!(await raceDeadline(warm.index, deadline))) {
      ctx.log.warning('Answering before the EIA search index finished warming', { budgetMs });
    }
  }

  /**
   * The single warm, started on demand. `index` resolves through a build
   * failure rather than rejecting, so a caller awaiting only the tree still
   * sees the error and nothing rejects unobserved.
   */
  private warm(ctx: Context): WarmHandles {
    if (_warm) return _warm;

    const tree = (async () => {
      if (isRouteCacheReady()) return;
      try {
        await this.buildTree(ctx);
      } catch (err) {
        // Let the next call retry the warm rather than caching the failure.
        _warm = undefined;
        throw err;
      }
    })();

    _warm = {
      tree,
      index: tree.then(
        () => this.runIndexPasses(ctx),
        () => undefined,
      ),
    };
    return _warm;
  }

  /**
   * Fetch top-level routes, recursively discover children via per-node GETs,
   * and build the node map plus the Fuse.js index over it.
   */
  private async buildTree(ctx: Context): Promise<void> {
    ctx.log.info('Warming EIA route tree cache');

    const rootResponse = await this.fetchJson<{ response: { routes: RawRouteNode[] } }>(
      '',
      {},
      ctx,
    );
    const topLevelNodes = rootResponse?.response?.routes ?? [];

    if (topLevelNodes.length === 0) {
      throw serviceUnavailable('EIA root endpoint returned no routes.');
    }

    let tree = await this.buildRouteTree(
      topLevelNodes,
      new ConcurrencyGate(TREE_BUILD_CONCURRENCY),
      ctx,
    );

    // What the pass above misses is EIA rate-limiting the burst it is itself
    // making, so retrying inside it only adds to the pressure. Sweep once the
    // burst is over, one request at a time — the second pass re-fetches only
    // the nodes still missing metadata and leaves the rest untouched.
    const missed = incompletePaths(tree);
    if (missed.length > 0) {
      ctx.log.info('Re-fetching route metadata the tree build could not reach', { routes: missed });
      tree = await this.buildRouteTree(tree, new ConcurrencyGate(1), ctx);
    }

    initRouteCache(tree, []);

    const { incompleteRoutes } = getIndexStatus();
    ctx.log.info('EIA route tree built', { indexSize: getIndexSize(), incompleteRoutes });
  }

  /**
   * Run both index-widening passes and record which of them landed in full.
   * A pass that fails leaves the corpus short, which `getIndexStatus()` then
   * reports — it never takes the tree down with it.
   */
  private async runIndexPasses(ctx: Context): Promise<void> {
    await Promise.all([
      this.fetchSteoSeries(ctx).then(
        () => markIndexPassSettled('steo_series'),
        (err: unknown) => {
          ctx.log.warning('Failed to index STEO series', { error: errorMessage(err) });
        },
      ),
      this.indexVocabularyFacets(ctx).then(
        (failed) => {
          if (failed === 0) markIndexPassSettled('facet_values');
        },
        (err: unknown) => {
          ctx.log.warning('Failed to index facet values', { error: errorMessage(err) });
        },
      ),
    ]);

    ctx.log.info('EIA search corpus warmed', { ...getIndexStatus() });
  }

  private async buildRouteTree(
    nodes: RawRouteNode[],
    gate: ConcurrencyGate,
    ctx: Context,
    depth = 0,
    parentPath = '',
  ): Promise<RawRouteNode[]> {
    // Limit recursion depth to avoid excessive API calls
    if (depth > 5) return nodes;

    const enriched = await Promise.all(
      nodes.map(async (node): Promise<RawRouteNode> => {
        const nodePath = parentPath ? `${parentPath}/${node.id}` : node.id;

        // If the node already has sub-routes or leaf indicators, use as-is
        if (node.routes?.length || node.frequency || node.facets || node.data) {
          if (node.routes?.length) {
            const children = await this.buildRouteTree(node.routes, gate, ctx, depth + 1, nodePath);
            return { ...node, routes: children };
          }
          return node;
        }

        // Otherwise fetch the node's metadata using its full path. A failure
        // here has already exhausted fetchJson's retry budget, so the node is
        // marked incomplete rather than kept as a bare stub — a stub carries
        // none of routes/facets/data and would read as a queryable leaf, hiding
        // both the real children and the fact that anything went wrong.
        let fetched: RawRouteNode | undefined;
        try {
          const resp = await gate.run(() =>
            this.fetchJson<{ response: RawRouteNode }>(nodePath, {}, ctx),
          );
          fetched = resp?.response;
        } catch (err) {
          ctx.log.warning('EIA route metadata fetch failed — subtree unknown', {
            route: nodePath,
            error: errorMessage(err),
          });
          return { ...node, incomplete: true };
        }
        if (!fetched) {
          ctx.log.warning('EIA route metadata was empty — subtree unknown', { route: nodePath });
          return { ...node, incomplete: true };
        }

        // Preserve id and name from the stub — EIA leaf responses use the
        // domain category as `id` (e.g. "petroleum") rather than the route
        // segment (e.g. "gnd"), and often omit `name`. Without this guard the
        // merge would corrupt the path when buildNodeMap runs later.
        const merged = { ...fetched, id: node.id, name: node.name ?? fetched.id };
        if (merged.routes?.length) {
          const children = await this.buildRouteTree(merged.routes, gate, ctx, depth + 1, nodePath);
          return { ...merged, routes: children };
        }
        return merged;
      }),
    );

    return enriched;
  }

  /**
   * Re-fetch a node whose warm-time metadata fetch failed and splice the result
   * into the cached tree. The miss is not held for the process lifetime — the
   * first call that needs the node pays one request to repair it. Throws when
   * the re-fetch fails too, rather than answering from the stub.
   */
  private async repairNode(path: string, ctx: Context): Promise<RawRouteNode> {
    const stub = getNode(path);
    if (!stub) {
      throw notFound(`Route "${path}" not found in the EIA taxonomy.`, {
        reason: 'route_not_found',
        recovery: {
          hint: 'Call eia_browse_routes without a path to see valid top-level categories.',
        },
      });
    }

    ctx.log.info('Re-fetching a route left incomplete by the warm', { route: path });
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const [repaired] = await this.buildRouteTree(
      [stub],
      new ConcurrencyGate(TREE_BUILD_CONCURRENCY),
      ctx,
      path.split('/').length - 1,
      parentPath,
    );

    if (!repaired || repaired.incomplete) {
      throw serviceUnavailable(`EIA did not return metadata for route "${path}".`, {
        route: path,
        recovery: { hint: 'Retry the call; if it persists, check api.eia.gov availability.' },
      });
    }

    replaceNode(path, repaired);
    return repaired;
  }

  private async fetchSteoSeries(ctx: Context): Promise<void> {
    // Fetch STEO series via facet endpoint
    const resp = await this.fetchJson<{
      response: {
        totalFacets: number;
        facets: Array<{ id: string; name: string; alias?: string }>;
      };
    }>('steo/facet/seriesId', {}, ctx);
    const facets = resp?.response?.facets ?? [];
    if (facets.length === 0) return;

    const entries: SearchIndexEntry[] = facets.map((f) => ({
      route: 'steo',
      name: f.name,
      description: `STEO series: ${f.name} (${f.id})${f.alias ? ` — ${f.alias}` : ''}`,
      isLeaf: true,
      category: 'steo',
      filter_hint: { seriesId: f.id },
    }));

    ctx.log.info('STEO series indexed', { count: addEntriesToIndex(entries) });
  }

  /**
   * Fetch one `/facet/{id}` endpoint and normalize it to a `Facet`. Throws on
   * transport failure — each caller decides what a single failing facet
   * endpoint means for it.
   *
   * EIA answers with a null `id` on some values and a null-or-absent `name` on
   * others, and the two mean different things. The `id` is the filter value, so
   * a value without one is unusable and is dropped. A missing `name` costs
   * nothing that way — the `id` still filters — and EIA carries the label in
   * `alias` on exactly those values, so `name` falls back to the alias and then
   * to the `id`. Dropping on either field instead hid whole facets: every value
   * of `electricity/state-electricity-profiles/meters`'s `technology` facet
   * omits `name`, so the facet read as having none. The fallback is also what
   * keeps the non-null `id`/`name` contract the describe output schema declares.
   */
  private async fetchFacet(route: string, meta: RawFacetMeta, ctx: Context): Promise<Facet> {
    const resp = await this.fetchJson<{ response: RawFacetResponse }>(
      `${route}/facet/${meta.id}`,
      {},
      ctx,
    );
    return {
      id: meta.id,
      description: meta.description,
      values: (resp?.response?.facets ?? [])
        .filter((v): v is RawFacetValue & { id: string } => v.id != null)
        .map((v) => ({
          id: v.id,
          name: v.name ?? v.alias ?? v.id,
          ...(v.alias !== undefined && { alias: v.alias }),
        })),
    };
  }

  /**
   * Fetch and index the values of the vocabulary facets named in the route
   * tree — fuel types, sectors, coal ranks — so a query naming one resolves to
   * the route that exposes it. Bounded on both sides: `listVocabularyFacets()`
   * selects a fraction of the taxonomy's facets, and each fetch is paced by
   * `FACET_INDEX_CONCURRENCY`. A facet that fails is skipped, matching how
   * `fetchAndCacheMetadata` tolerates a single failing facet endpoint — but it
   * is counted and returned, because a skipped facet leaves vocabulary out of
   * the corpus and the caller is entitled to know the pass fell short.
   */
  private async indexVocabularyFacets(ctx: Context): Promise<number> {
    const targets = listVocabularyFacets();
    if (targets.length === 0) return 0;

    const gate = new ConcurrencyGate(FACET_INDEX_CONCURRENCY);
    let indexed = 0;
    let failed = 0;
    await Promise.all(
      targets.map(({ route, facetId, description }) =>
        gate.run(async () => {
          try {
            const facet = await this.fetchFacet(route, { id: facetId, description }, ctx);
            indexed += indexFacetValues(route, [facet]);
          } catch (err) {
            failed++;
            ctx.log.warning('EIA facet fetch failed — vocabulary missing from the index', {
              route,
              facetId,
              error: errorMessage(err),
            });
          }
        }),
      ),
    );

    ctx.log.info('Facet values indexed', {
      facets: targets.length,
      failed,
      values: indexed,
      indexSize: getIndexSize(),
    });
    return failed;
  }

  /**
   * Browse child routes at a given path. Returns list of children with leaf
   * classification. The path is normalized first, so a leading, trailing, or
   * doubled slash resolves against the node map instead of missing it. A path
   * the warm left incomplete is re-fetched here rather than answered from its
   * stub, which would report no children and a leaf classification the server
   * never established.
   */
  async browse(
    path: string | undefined,
    ctx: Context,
  ): Promise<{
    path: string;
    children: RouteEntry[];
    isLeaf: boolean;
  }> {
    await this.ensureTreeWarmed(ctx);

    const normalizedPath = normalizeRoutePath(path ?? '');

    // Check if the path itself is a leaf
    if (normalizedPath) {
      let node = getNode(normalizedPath);
      if (!node) {
        throw notFound(`Route "${normalizedPath}" not found in the EIA taxonomy.`, {
          reason: 'route_not_found',
          recovery: {
            hint: 'Call eia_browse_routes without a path to see valid top-level categories.',
          },
        });
      }
      if (node.incomplete) node = await this.repairNode(normalizedPath, ctx);

      const selfIsLeaf = isLeafNode(node);
      if (selfIsLeaf) {
        return { path: normalizedPath, children: [], isLeaf: true };
      }

      const childEntries = getChildren(normalizedPath);
      const children: RouteEntry[] = childEntries.map(({ id, route, node: childNode }) => ({
        id,
        name: childNode.name,
        description: childNode.description ?? '',
        route,
        isLeaf: isLeafNode(childNode),
      }));

      return { path: normalizedPath, children, isLeaf: false };
    }

    // Root browse
    const rootChildren = getChildren('');
    const children: RouteEntry[] = rootChildren.map(({ id, route, node }) => ({
      id,
      name: node.name,
      description: node.description ?? '',
      route,
      isLeaf: isLeafNode(node),
    }));

    return { path: '', children, isLeaf: false };
  }

  /**
   * Describe a leaf route — returns full metadata including facets with values.
   * The route is normalized first, so every spelling of one path shares a
   * single metadata cache entry and a single facet fan-out; `meta.route` is
   * therefore the canonical form, which is what the tool echoes back.
   */
  async describe(route: string, ctx: Context): Promise<RouteMetadata> {
    const normalizedRoute = normalizeRoutePath(route);

    const cached = _routeMetaCache.get(normalizedRoute);
    if (cached) return cached;

    await this.ensureTreeWarmed(ctx);

    const node = normalizedRoute ? getNode(normalizedRoute) : undefined;
    if (!node && normalizedRoute) {
      // Try fetching directly from EIA in case route tree walk missed it
      await this.fetchAndCacheMetadata(normalizedRoute, ctx);
      const meta = _routeMetaCache.get(normalizedRoute);
      if (!meta) {
        throw notFound(`Route "${normalizedRoute}" not found in the EIA taxonomy.`, {
          reason: 'route_not_found',
          recovery: {
            hint: 'Use eia_browse_routes or eia_search_routes to discover valid route paths.',
          },
        });
      }
      return meta;
    }

    // An incomplete node was never classified, so the cached pre-flight has
    // nothing to say about it — the live fetch below decides instead.
    if (node && !node.incomplete && !isLeafNode(node)) {
      throw validationError(
        `Route "${normalizedRoute}" is a category, not a leaf — it has no data to query.`,
        {
          reason: 'route_not_queryable',
          recovery: {
            hint: 'Use eia_browse_routes to drill into sub-routes, or eia_search_routes to find leaf routes.',
          },
        },
      );
    }

    await this.fetchAndCacheMetadata(normalizedRoute, ctx);
    const meta = _routeMetaCache.get(normalizedRoute);
    if (!meta) {
      throw notFound(`Could not retrieve metadata for route "${normalizedRoute}".`, {
        reason: 'route_not_found',
      });
    }
    return meta;
  }

  private async fetchAndCacheMetadata(route: string, ctx: Context): Promise<void> {
    // Fetch route metadata — remap 404 to a typed route_not_found error
    let metaRespRaw: { response: RawRouteNode } | undefined;
    try {
      metaRespRaw = await this.fetchJson<{ response: RawRouteNode }>(`${route}`, {}, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === -32001 /* NotFound */) {
        throw notFound(`Route "${route}" not found in the EIA taxonomy.`, {
          reason: 'route_not_found',
          recovery: {
            hint: 'Use eia_browse_routes or eia_search_routes to discover valid route paths.',
          },
        });
      }
      throw err;
    }
    const rawNode = metaRespRaw?.response;
    if (!rawNode) {
      throw notFound(`Route "${route}" returned empty metadata.`, { reason: 'route_not_found' });
    }

    if (!isLeafNode(rawNode)) {
      throw validationError(`Route "${route}" is a category, not a leaf.`, {
        reason: 'route_not_queryable',
        recovery: {
          hint: 'Use eia_browse_routes to drill into sub-routes, or eia_search_routes to find leaf routes.',
        },
      });
    }

    // Fan out facet value fetches
    const facetMetas = rawNode.facets ?? [];
    const facetResults = await Promise.all(
      facetMetas.map(async (f): Promise<Facet> => {
        try {
          return await this.fetchFacet(route, f, ctx);
        } catch {
          // If a single facet fetch fails, return with empty values
          return { id: f.id, description: f.description, values: [] };
        }
      }),
    );

    // Normalize data columns. EIA uses two data field shapes:
    //   Standard: { colId: { alias: string, units: string }, ... }
    //   Value-array: { value: [] } — time-series routes where the single data
    //     column is always named "value". Synthesize a minimal DataColumn entry
    //     so query() can auto-populate data[]=value and return actual measurements.
    const dataObj = rawNode.data ?? {};
    const dataColumns = Object.entries(dataObj)
      .filter(([, meta]) => meta !== null && typeof meta === 'object' && !Array.isArray(meta))
      .map(([id, meta]) => {
        const col = meta as { alias?: string; units?: string };
        // alias and units may be undefined for some EIA routes (e.g. crude-oil-imports)
        return { id, alias: col.alias ?? id, units: col.units ?? '' };
      });

    // Handle the value-array variant: { value: [] }
    if (dataColumns.length === 0 && 'value' in dataObj && Array.isArray(dataObj.value)) {
      dataColumns.push({ id: 'value', alias: 'Value', units: '' });
    }

    // EIA returns `frequency` as an array on every route in the standard
    // taxonomy, but the field is not contractually an array — the same
    // shape-variance the `data` handling above absorbs. An object map is
    // flattened to its values; anything else degrades to an empty list rather
    // than reaching `frequencies.map` downstream as a non-array.
    const rawFrequency = rawNode.frequency;
    const frequencies: RawFrequency[] = Array.isArray(rawFrequency)
      ? rawFrequency
      : rawFrequency && typeof rawFrequency === 'object'
        ? Object.values(rawFrequency)
        : [];

    const meta: RouteMetadata = {
      route,
      description: normalizeDescription(rawNode.description),
      facets: facetResults,
      dataColumns,
      frequencies,
      dateRange: {
        start: rawNode.startPeriod ?? '',
        end: rawNode.endPeriod ?? '',
      },
      defaultFrequency: rawNode.defaultFrequency ?? frequencies[0]?.id ?? '',
      defaultDateFormat: rawNode.defaultDateFormat ?? '',
    };

    _routeMetaCache.set(route, meta);

    // The facet values are already in hand, so folding them into the search
    // index costs nothing upstream. This is what makes a described route's
    // vocabulary searchable even when its facets are outside the warm-time set.
    const added = indexFacetValues(route, facetResults);
    if (added > 0) ctx.log.debug('Facet values indexed from describe', { route, values: added });
  }

  /**
   * Fetch data from a leaf route. Returns the inline preview rows (all string
   * values per EIA API), total count, the canonical `route` the query resolved
   * to, and any top-level EIA warnings. The route is normalized first, so the
   * cached leaf/category pre-flight and the metadata cache apply to every
   * spelling rather than only the bare one.
   *
   * With `accumulate`, additional offset pages are fetched and returned under
   * `accumulated` for canvas registration — bounded by `EIA_CANVAS_MAX_ROWS`
   * and by EIA's 5,000-row-per-request ceiling. The inline `data` array is never
   * widened; it stays at the caller's requested `length`.
   */
  async query(
    route: string,
    opts: {
      accumulate?: boolean;
      filters?: Record<string, string | string[]>;
      columns?: string[];
      frequency?: string;
      start?: string;
      end?: string;
      sort?: Array<{ column: string; direction: 'asc' | 'desc' }>;
      offset?: number;
      length?: number;
    },
    ctx: Context,
  ): Promise<DataResponse> {
    const normalizedRoute = normalizeRoutePath(route);

    // Pre-flight: if the route is in the cache as a category node, fail early
    // with a typed error rather than letting the EIA API return a generic 404.
    // An incomplete node is skipped — it was never classified either way.
    await this.ensureTreeWarmed(ctx);
    const cachedNode = getNode(normalizedRoute);
    if (cachedNode && !cachedNode.incomplete && !isLeafNode(cachedNode)) {
      throw validationError(
        `Route "${normalizedRoute}" is a category, not a leaf — it has no data to query.`,
        {
          reason: 'route_not_queryable',
          recovery: {
            hint: 'Use eia_browse_routes to drill into sub-routes, or eia_search_routes to find leaf routes.',
          },
        },
      );
    }

    const params: Record<string, string | string[]> = {};

    if (opts.frequency) params.frequency = opts.frequency;
    if (opts.start) params.start = opts.start;
    if (opts.end) params.end = opts.end;

    // EIA only returns value fields when data[] params are explicitly set.
    // When the caller omits columns, auto-populate from route metadata so
    // all available data columns are included by default. Fetch metadata
    // on-demand when the cache is cold (no prior eia_describe_route call).
    let columnsToRequest = opts.columns;
    if (!columnsToRequest?.length) {
      let cached = _routeMetaCache.get(normalizedRoute);
      if (!cached) {
        await this.fetchAndCacheMetadata(normalizedRoute, ctx);
        cached = _routeMetaCache.get(normalizedRoute);
      }
      if (cached?.dataColumns.length) {
        columnsToRequest = cached.dataColumns.map((c) => c.id);
      }
    }
    if (columnsToRequest?.length) {
      params['data[]'] = columnsToRequest;
    }

    if (opts.filters) {
      for (const [facetId, values] of Object.entries(opts.filters)) {
        const arr = Array.isArray(values) ? values : [values];
        params[`facets[${facetId}][]`] = arr;
      }
    }

    for (const [i, s] of (opts.sort ?? []).entries()) {
      params[`sort[${i}][column]`] = s.column;
      params[`sort[${i}][direction]`] = s.direction;
    }

    const offset = opts.offset ?? 0;
    const length = opts.length ?? 100;

    const first = await this.fetchDataPage(normalizedRoute, params, offset, length, ctx);
    const total = parseInt(first.response.total ?? '0', 10);
    const data: DataRow[] = first.response.data ?? [];

    const result: DataResponse = {
      route: normalizedRoute,
      total,
      dateFormat: first.response.dateFormat ?? '',
      frequency: first.response.frequency ?? opts.frequency ?? '',
      data,
      warnings: first.warnings?.length ? first.warnings : undefined,
    };

    if (opts.accumulate && data.length > 0 && offset + data.length < total) {
      result.accumulated = await this.accumulatePages(
        normalizedRoute,
        params,
        { offset, total, first: data },
        ctx,
      );
    }

    return result;
  }

  /**
   * Fetch one page of /v2/{route}/data/, remapping EIA's 404 and 400 responses
   * to typed reasons. The 400 remap reads the upstream message to distinguish a
   * bad facet key from a bad column, frequency, sort column, or period format
   * (see `INVALID_PARAM_REASONS`).
   */
  private async fetchDataPage(
    route: string,
    params: Record<string, string | string[]>,
    offset: number,
    length: number,
    ctx: Context,
  ): Promise<DataPage> {
    const pageParams = { ...params, offset: String(offset), length: String(length) };
    let resp: Partial<DataPage>;
    try {
      resp = await this.fetchJson<Partial<DataPage>>(`${route}/data/`, pageParams, ctx);
    } catch (err) {
      if (err instanceof McpError) {
        if (err.code === -32001 /* NotFound */) {
          throw notFound(`Route "${route}" not found in the EIA taxonomy.`, {
            reason: 'route_not_found',
            recovery: {
              hint: 'Use eia_browse_routes or eia_search_routes to find a valid leaf route path.',
            },
          });
        }
        if (err.code === -32007 /* ValidationError */) {
          const match = INVALID_PARAM_REASONS.find((entry) => entry.pattern.test(err.message));
          throw validationError(err.message, {
            reason: match?.reason ?? 'invalid_facet',
            recovery: {
              hint: match?.hint ?? 'Call eia_describe_route and pick a facet key from facets[].id.',
            },
          });
        }
      }
      throw err;
    }

    // A 200 with no `response` envelope is an upstream shape failure, not a
    // caller error — it carries no declared reason, so it bubbles as a baseline
    // ServiceUnavailable rather than borrowing a contract reason it doesn't fit.
    if (!resp?.response) {
      throw serviceUnavailable(`EIA returned no data envelope for route "${route}".`, {
        route,
        recovery: { hint: 'Retry the query; if it persists, check api.eia.gov availability.' },
      });
    }

    return { response: resp.response, ...(resp.warnings && { warnings: resp.warnings }) };
  }

  /**
   * Walk offset pages forward from the preview until the result set is
   * exhausted or the cumulative cap is reached. Each page rides the same
   * `fetchJson` retry/rate-limit path; a short page means end of data.
   *
   * Accumulation only widens what reaches the canvas, so a page that fails
   * after retries keeps the rows already gathered rather than discarding a
   * preview the caller has in hand — the tool's note reports the real staged
   * count and the offset to resume from. A caller-side abort still propagates.
   */
  private async accumulatePages(
    route: string,
    params: Record<string, string | string[]>,
    seed: { offset: number; total: number; first: DataRow[] },
    ctx: Context,
  ): Promise<AccumulatedRows> {
    const cap = getServerConfig().canvasMaxRows;
    const rows = [...seed.first];
    let nextOffset = seed.offset + seed.first.length;
    let capped = false;

    while (nextOffset < seed.total) {
      if (rows.length >= cap) {
        capped = true;
        break;
      }
      const pageSize = Math.min(EIA_MAX_ROWS_PER_REQUEST, cap - rows.length);
      let pageRows: DataRow[];
      try {
        const page = await this.fetchDataPage(route, params, nextOffset, pageSize, ctx);
        pageRows = page.response.data ?? [];
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log.warning('EIA canvas accumulation stopped early', {
          route,
          nextOffset,
          staged: rows.length,
          error: errorMessage(err),
        });
        break;
      }
      rows.push(...pageRows);
      nextOffset += pageRows.length;
      // A short page — including an empty one — means the data ran out.
      if (pageRows.length < pageSize) break;
    }

    ctx.log.debug('EIA canvas accumulation complete', {
      route,
      staged: rows.length,
      total: seed.total,
      capped,
    });

    return { cap, capped, rows };
  }

  /**
   * Fuzzy search across the route index, answered once the corpus is as
   * complete as this process can make it within `SEARCH_WARM_BUDGET_MS`.
   * `status` travels with the results so a short or oddly-ranked answer is
   * never mistaken for a settled one.
   */
  async search(
    query: string,
    limit: number,
    ctx: Context,
  ): Promise<{
    results: Array<{ entry: SearchIndexEntry; score: number }>;
    status: IndexStatus;
  }> {
    await this.ensureIndexWarmed(ctx, SEARCH_WARM_BUDGET_MS);
    return { results: searchRoutes(query, limit), status: getIndexStatus() };
  }
}

let _service: EiaApiService | undefined;

export function initEiaApiService(): void {
  _service = new EiaApiService();
}

export function getEiaApiService(): EiaApiService {
  if (!_service)
    throw new Error('EiaApiService not initialized — call initEiaApiService() in setup()');
  return _service;
}

/** Reset for tests. */
export function _resetEiaApiService(): void {
  _service = undefined;
  _routeMetaCache.clear();
  _warm = undefined;
}
