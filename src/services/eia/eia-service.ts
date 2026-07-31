/**
 * @fileoverview EIA API v2 service. Wraps api.eia.gov/v2 with retry/timeout,
 * route tree caching, per-route facet metadata caching, and Fuse.js fuzzy
 * search. Exposes browse, describe, query, and search methods consumed by MCP
 * tool handlers. `query()` also walks `offset` pages past the inline preview
 * when the caller wants a canvas-bound row set, bounded by EIA_CANVAS_MAX_ROWS.
 * Rate-limit detection: EIA returns `OVER_RATE_LIMIT` in the response body —
 * classified as ServiceUnavailable (retryable).
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
  addSteoSeriesToIndex,
  getChildren,
  getIndexSize,
  getNode,
  initRouteCache,
  isLeafNode,
  isRouteCacheReady,
  normalizeDescription,
  searchRoutes,
} from './route-cache.js';
import type {
  AccumulatedRows,
  DataResponse,
  DataRow,
  EiaWarning,
  Facet,
  RawFacetResponse,
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
 * EIA 400 bodies name the rejected dimension verbatim ("Invalid data 'bogus'
 * provided.", "Invalid frequency 'hourly' provided."). Map each to the reason
 * and recovery that points at the right part of eia_describe_route's output;
 * anything unmatched falls back to invalid_facet.
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

/** Pending initialization promise (prevents duplicate warm-up). */
let _initPromise: Promise<void> | undefined;

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
        signal: ctx.signal,
      },
    );
  }

  /**
   * Warm the route tree cache. Called lazily on first browse/search.
   * Fetches top-level routes, recursively discovers children via the cache
   * structure from GET /v2/ and per-node GETs, then builds the Fuse.js index.
   * STEO series are fetched in parallel and appended to the index.
   */
  async ensureCacheWarmed(ctx: Context): Promise<void> {
    if (isRouteCacheReady()) return;

    if (_initPromise) {
      await _initPromise;
      return;
    }

    _initPromise = this.warmCache(ctx);
    try {
      await _initPromise;
    } finally {
      _initPromise = undefined;
    }
  }

  private async warmCache(ctx: Context): Promise<void> {
    ctx.log.info('Warming EIA route tree cache');

    // Fetch root to get top-level route IDs
    const rootResponse = await this.fetchJson<{ response: { routes: RawRouteNode[] } }>(
      '',
      {},
      ctx,
    );
    const topLevelNodes = rootResponse?.response?.routes ?? [];

    if (topLevelNodes.length === 0) {
      throw serviceUnavailable('EIA root endpoint returned no routes.');
    }

    // For each top-level node, fetch its metadata to discover sub-routes and
    // leaf status. We do this recursively until we hit leaf nodes.
    // Strategy: fetch each top-level node and recurse into non-leaf children.
    const fullTree = await this.buildRouteTree(topLevelNodes, ctx);

    // Build route map and index (without STEO series initially)
    initRouteCache(fullTree, []);

    // Fetch STEO series in the background to populate the index
    this.fetchSteoSeries(ctx).catch((err) => {
      ctx.log.warning('Failed to index STEO series', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    ctx.log.info('EIA route tree cache warmed', { indexSize: getIndexSize() });
  }

  private async buildRouteTree(
    nodes: RawRouteNode[],
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
            const children = await this.buildRouteTree(node.routes, ctx, depth + 1, nodePath);
            return { ...node, routes: children };
          }
          return node;
        }

        // Otherwise fetch the node's metadata using its full path.
        // Preserve node.id — EIA leaf responses return the domain category in
        // their top-level `id` field (e.g. "petroleum"), not the route segment
        // (e.g. "gnd"). Without this guard the merge would overwrite the
        // segment ID and corrupt the path when buildNodeMap runs later.
        try {
          const resp = await this.fetchJson<{ response: RawRouteNode }>(nodePath, {}, ctx);
          const fetched = resp?.response;
          if (!fetched) return node;

          // Preserve id and name from the stub — EIA leaf responses use the
          // domain category as `id` (not the route segment) and often omit `name`.
          const merged = { ...fetched, id: node.id, name: node.name ?? fetched.id };
          if (merged.routes?.length) {
            const children = await this.buildRouteTree(merged.routes, ctx, depth + 1, nodePath);
            return { ...merged, routes: children };
          }
          return merged;
        } catch {
          return node;
        }
      }),
    );

    return enriched;
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

    addSteoSeriesToIndex(entries);
    ctx.log.info('STEO series indexed', { count: entries.length });
  }

  /**
   * Browse child routes at a given path. Returns list of children with leaf
   * classification.
   */
  async browse(
    path: string | undefined,
    ctx: Context,
  ): Promise<{
    path: string;
    children: RouteEntry[];
    isLeaf: boolean;
  }> {
    await this.ensureCacheWarmed(ctx);

    const normalizedPath = path?.trim() ?? '';

    // Check if the path itself is a leaf
    if (normalizedPath) {
      const node = getNode(normalizedPath);
      if (!node) {
        throw notFound(`Route "${normalizedPath}" not found in the EIA taxonomy.`, {
          reason: 'route_not_found',
          recovery: {
            hint: 'Call eia_browse_routes without a path to see valid top-level categories.',
          },
        });
      }

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
   * Results are cached per-route to avoid repeat fan-out.
   */
  async describe(route: string, ctx: Context): Promise<RouteMetadata> {
    const cached = _routeMetaCache.get(route);
    if (cached) return cached;

    await this.ensureCacheWarmed(ctx);

    const node = route ? getNode(route) : undefined;
    if (!node && route) {
      // Try fetching directly from EIA in case route tree walk missed it
      await this.fetchAndCacheMetadata(route, ctx);
      const meta = _routeMetaCache.get(route);
      if (!meta) {
        throw notFound(`Route "${route}" not found in the EIA taxonomy.`, {
          reason: 'route_not_found',
          recovery: {
            hint: 'Use eia_browse_routes or eia_search_routes to discover valid route paths.',
          },
        });
      }
      return meta;
    }

    if (node && !isLeafNode(node)) {
      throw validationError(
        `Route "${route}" is a category, not a leaf — it has no data to query.`,
        {
          reason: 'route_not_queryable',
          recovery: {
            hint: 'Use eia_browse_routes to drill into sub-routes, or eia_search_routes to find leaf routes.',
          },
        },
      );
    }

    await this.fetchAndCacheMetadata(route, ctx);
    const meta = _routeMetaCache.get(route);
    if (!meta) {
      throw notFound(`Could not retrieve metadata for route "${route}".`, {
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
          const resp = await this.fetchJson<{ response: RawFacetResponse }>(
            `${route}/facet/${f.id}`,
            {},
            ctx,
          );
          const values = resp?.response?.facets ?? [];
          return {
            id: f.id,
            description: f.description,
            // Filter null id/name entries — EIA returns null for some facet
            // values (e.g. international route), which carry no usable filter value.
            values: values
              .filter((v) => v.id != null && v.name != null)
              .map((v) => ({
                id: v.id,
                name: v.name,
                ...(v.alias !== undefined && { alias: v.alias }),
              })),
          };
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

    const frequencies: RawFrequency[] = rawNode.frequency ?? [];

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
  }

  /**
   * Fetch data from a leaf route. Returns the inline preview rows (all string
   * values per EIA API), total count, and any top-level EIA warnings.
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
    // Pre-flight: if the route is in the cache as a category node, fail early
    // with a typed error rather than letting the EIA API return a generic 404.
    await this.ensureCacheWarmed(ctx);
    const cachedNode = getNode(route);
    if (cachedNode && !isLeafNode(cachedNode)) {
      throw validationError(
        `Route "${route}" is a category, not a leaf — it has no data to query.`,
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
      let cached = _routeMetaCache.get(route);
      if (!cached) {
        await this.fetchAndCacheMetadata(route, ctx);
        cached = _routeMetaCache.get(route);
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

    const first = await this.fetchDataPage(route, params, offset, length, ctx);
    const total = parseInt(first.response.total ?? '0', 10);
    const data: DataRow[] = first.response.data ?? [];

    const result: DataResponse = {
      total,
      dateFormat: first.response.dateFormat ?? '',
      frequency: first.response.frequency ?? opts.frequency ?? '',
      data,
      warnings: first.warnings?.length ? first.warnings : undefined,
    };

    if (opts.accumulate && data.length > 0 && offset + data.length < total) {
      result.accumulated = await this.accumulatePages(
        route,
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
   * bad facet key from a bad column or frequency.
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
          error: err instanceof Error ? err.message : String(err),
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

  /** Fuzzy search across the route index. */
  async search(
    query: string,
    limit: number,
    ctx: Context,
  ): Promise<{ results: Array<{ entry: SearchIndexEntry; score: number }>; totalIndexed: number }> {
    await this.ensureCacheWarmed(ctx);
    const results = searchRoutes(query, limit);
    return { results, totalIndexed: getIndexSize() };
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
  _initPromise = undefined;
}
