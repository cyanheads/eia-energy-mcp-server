/**
 * @fileoverview EIA API v2 service. Wraps api.eia.gov/v2 with retry/timeout,
 * route tree caching, per-route facet metadata caching, and Fuse.js fuzzy
 * search. Exposes browse, describe, query, and search methods consumed by MCP
 * tool handlers. All three route-taking methods normalize the path first, so
 * one route resolves the same way however it is spelled and the node map and
 * per-route metadata cache hold a single entry for it. `query()` also walks
 * `offset` pages past the inline preview when the caller asks for a
 * canvas-bound row set, bounded by EIA_CANVAS_MAX_ROWS.
 * Facet values reach the search index from three directions: a bounded pass
 * over the vocabulary facets named in the route tree (fuel and sector facets
 * everywhere, plus `series`, `product`, and `respondent` on the routes that
 * publish sub-monthly data — the daily and weekly petroleum and natural-gas
 * routes and the hourly and daily RTO routes), one whole-facet pass per
 * `NAMED_SERIES_FACETS` entry (STEO and SEDS series), and every route the
 * caller describes. Only describe writes facet values to the per-route
 * metadata cache, which holds the full uncapped value set — the cap in
 * eia_describe_route shapes its own response only. An entry expires
 * `ROUTE_METADATA_TTL_MS` after its route metadata was fetched; the next
 * describe refreshes it, and a list whose refresh fails is served as last
 * fetched, marked stale, rather than dropped. Rate-limit detection: EIA
 * returns `OVER_RATE_LIMIT` in the response body — classified as
 * ServiceUnavailable (retryable). A 414 (request URI over EIA's ~8 KB limit) is
 * a caller-input failure, `uri_too_long`, never retried. A fetch that throws
 * before EIA answers — connection refused or reset, DNS failure — is
 * `upstream_unreachable` (ServiceUnavailable, retryable); a caller's abort
 * still propagates as cancellation. Every request is bounded in time: each
 * attempt by `ATTEMPT_TIMEOUT_MS`, and every attempt, backoff, and chained
 * request of a tool call by one `CALL_DEADLINE_MS` deadline set when browse,
 * describe, or query is entered; EIA not answering in time is
 * `upstream_timeout` (Timeout, retryable). A bound EIA answers with HTTP 500 —
 * a `local-hourly` bound without its UTC offset, or one in the frequency's own
 * period shape naming a month, day, or hour that does not exist — is refused
 * as `invalid_period` before the request.
 *
 * The warm has two milestones. `ensureTreeWarmed` resolves once the route tree
 * is built — all browse, describe, and query need — or once
 * `ROUTE_WARM_BUDGET_MS` passes, after which those three answer from a live
 * fetch of their own route while the warm continues. `ensureIndexWarmed` also
 * awaits the index-widening passes — facet vocabulary and one per named-series
 * facet, run concurrently — so `search` never ranks against a
 * half-filled corpus; that wait is bounded by `SEARCH_WARM_BUDGET_MS` so a
 * degraded upstream cannot hold a call past the client's own request timeout.
 * Fetches that fail past their retry budget are recorded rather than swallowed:
 * the node is kept as an incomplete stub, named in `getIndexStatus()`, and
 * re-fetched by `repairNode` on the next browse that needs it; an index pass
 * that did not land is re-run, for its missing work only, by the next search.
 *
 * The warm is shared by every caller, so it belongs to the service, not to the
 * request that happened to start it: its fetches, retries, and pacer slots run
 * under a service-owned signal that only `shutdownEiaApiService()` aborts, and
 * its log records go to the global logger. A caller awaiting it races the
 * shared promise against its own signal, so a cancellation — or stateless
 * HTTP closing the transport once the response is sent — ends only that
 * caller's wait.
 *
 * A search query shaped like a legacy APIv1 series ID is looked up through
 * `/v2/seriesid/{id}` before the search waits on the warm, under
 * `SERIES_ID_LOOKUP_BUDGET_MS`: a hit answers without the index, so a cold
 * server resolves it without warming. A 404 is the miss, never retried; any
 * other classified failure degrades to the text search, disclosed.
 * @module services/eia/eia-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  requestCancelled,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  defaultIsTransient,
  httpErrorFromResponse,
  logger,
  type Pacer,
  type RequestContext,
  requestContextService,
  withExtra,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { impossiblePeriod, lacksUtcOffset } from './period-bounds.js';
import {
  frequenciesOf,
  getChildren,
  getIndexSize,
  getIndexStatus,
  getNode,
  type IndexPass,
  type IndexStatus,
  indexFacetValues,
  indexNamedSeries,
  indexVocabularyFacet,
  initRouteCache,
  isLeafNode,
  isRouteCacheReady,
  listVocabularyFacets,
  markIndexPassSettled,
  NAMED_SERIES_FACETS,
  type NamedSeriesPass,
  normalizeDescription,
  replaceNode,
  searchRoutes,
} from './route-cache.js';
import {
  parseSeriesId,
  type SeriesIdLookup,
  SeriesIdResponseSchema,
  seriesIdEntry,
} from './series-id.js';
import type {
  AccumulatedRows,
  DataColumn,
  DataResponse,
  DataRow,
  EiaWarning,
  Facet,
  RawFacetMeta,
  RawFacetResponse,
  RawFacetValue,
  RawRouteNode,
  RouteEntry,
  RouteMetadata,
  SearchResultEntry,
} from './types.js';

/**
 * EIA's hard per-request row ceiling. Requesting more is not an error — the API
 * returns the first 5,000 rows plus a `parameter out of range: length` warning.
 */
const EIA_MAX_ROWS_PER_REQUEST = 5000;

/**
 * Parallel `/facet/{id}` fetches allowed during the vocabulary pass. EIA
 * answers `OVER_RATE_LIMIT` to an unbounded burst, so the pass is deliberately
 * paced rather than fanned out with a single `Promise.all`. At this pace the
 * pass (76 fetches against the live taxonomy) drew 4 rate-limit answers on one
 * measured cold warm, all cleared by retry, against the tree build's 41 at
 * `TREE_BUILD_CONCURRENCY`.
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
 * 24–30 s measured over seven cold runs against the live API. Growing the facet
 * pass from 40 fetches to 76 adds a few seconds: one cold run on each side
 * landed in 33 s before and 20 s after, the pass spending 8 s and 6 s of it,
 * and the slower run's per-request latency puts the widened pass near 15 s.
 * This never fires on a healthy run. It bounds the degraded one: the serial sweep spends
 * up to four attempts and ~7 s of backoff on each node it still cannot reach,
 * so the warm that loses nodes is also the warm that takes longest, and a call
 * held past the client's request timeout (60 s in the MCP SDK) fails as a
 * transport error carrying none of the recovery hint the tool would otherwise
 * return. On expiry the search answers from what is indexed so far, reported as
 * usual by `indexComplete`.
 */
const SEARCH_WARM_BUDGET_MS = 45_000;

/**
 * Ceiling on a search's series-ID lookup, every attempt and backoff included,
 * counted from search entry. Healthy `/v2/seriesid` answers took 0.09–1.2 s
 * over 15 live probes, so this cuts only a stalled lookup, while leaving room
 * for all three of `withRetry`'s retries of a rate-limited or 5xx one (about
 * 7 s of backoff). The warm wait that follows a miss is counted from the same
 * entry against `SEARCH_WARM_BUDGET_MS`, so a lookup that spends all of this
 * still leaves the fallback search 35 s and the whole call inside the same
 * 45 s ceiling.
 */
const SERIES_ID_LOOKUP_BUDGET_MS = 10_000;

/**
 * Ceiling on how long browse, describe, and query wait for the route tree,
 * counted from the start of the build, before answering from a live fetch of
 * the one route they need. Unlike search, each has that fallback, and it is
 * cheap: describe fetches the route metadata either way, query adds one
 * metadata request, and browse fetches the path plus each child it has to
 * classify. The wait is held well inside the MCP SDK's
 * 60 s client request timeout so the fallback has room to answer on a degraded
 * upstream. A healthy warm (20–40 s measured) can outlast it; the caller then
 * pays those few requests instead of the rest of the warm, which keeps running
 * for every later call.
 */
export const ROUTE_WARM_BUDGET_MS = 20_000;

/**
 * Ceiling on one request attempt, headers and body together. Healthy EIA
 * answers on a cold (uncached) 5,000-row data page took 5–9 s measured, but a
 * deep offset is slow at any length: `electricity/rto/fuel-type-data` at offset
 * 6,000,000 answered 200 in 35.5 s and `electricity/facility-fuel` at 8,000,000
 * in 34.5 s, while EIA's own gateway gave up on others with HTTP 503 after
 * 33–41 s. The cut sits past that gateway, so an attempt is cut only when EIA
 * would not have answered at all, and the 503 path still leaves a retry room
 * to land within the deadline. A timed-out attempt is transient and retried
 * within the deadline.
 */
const ATTEMPT_TIMEOUT_MS = 45_000;

/**
 * One deadline across every attempt, backoff, and chained request of a tool
 * call — the route-tree wait, a metadata request, the data page, staging pages,
 * describe's facet fetches — counted from the moment the service method is
 * entered. Held 4 s inside the MCP SDK's 60 s client request timeout, so the
 * caller gets the server's classified `upstream_timeout` and its recovery hint
 * rather than a transport error. The margin covers response shaping and canvas
 * registration, measured under 1 s for a 25,000-row stage, and no more: a
 * healthy wide-route stage runs close to the client timeout
 * (`electricity/operating-generator-capacity` stages 25,000 rows in six 8–10 s
 * requests, about 54 s), and every second of margin cuts one. Each warm
 * request, which belongs to no call, gets a deadline of the same length of its own.
 */
const CALL_DEADLINE_MS = 56_000;

/**
 * How long a cached route entry — route metadata and facet value lists — is
 * served before the next describe refreshes it. EIA's releases move
 * `endPeriod` and add and drop facet values (a monthly EIA-923 release adds
 * new plants to `electricity/facility-fuel`'s `plantCode`), and a hosted
 * process runs for weeks between redeploys, so an entry kept for the process
 * lifetime goes on answering from the first fetch. A day keeps a route
 * described many times an hour to one refresh a day.
 */
export const ROUTE_METADATA_TTL_MS = 24 * 60 * 60 * 1000;

/** The error a caller's wait on the shared warm rejects with when its own signal aborts. */
function cancelledWait(signal: AbortSignal): McpError {
  return requestCancelled('Cancelled while waiting for the EIA route index to warm.', undefined, {
    cause: signal.reason,
  });
}

/**
 * Await shared work on behalf of one caller. Resolves true when `promise`
 * settles first and false when `deadline` (epoch ms) passes first; rejects with
 * the promise's own rejection, or as cancelled when the caller's `signal` fires
 * first. Neither the deadline nor the signal touches the work itself — the warm
 * it stands for keeps running for every other caller and for the next one.
 */
function awaitShared(
  promise: Promise<void>,
  signal: AbortSignal,
  deadline = Number.POSITIVE_INFINITY,
): Promise<boolean> {
  if (signal.aborted) return Promise.reject(cancelledWait(signal));
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(false);

  return new Promise<boolean>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      finish();
    };
    const onAbort = () => settle(() => reject(cancelledWait(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    // An unbounded wait arms no timer — setTimeout clamps Infinity to 1 ms.
    if (Number.isFinite(remaining))
      timer = setTimeout(() => settle(() => resolve(false)), remaining);
    promise.then(
      () => settle(() => resolve(true)),
      (err: unknown) => settle(() => reject(err)),
    );
  });
}

/**
 * Canonical spelling of a route path: trim whitespace, normalize slashes, then
 * remove exactly one complete leading v2 segment. EIA's docs write routes as
 * `/v2/electricity/retail-sales/`, so those spellings reach the tools verbatim,
 * while the node map and the per-route metadata cache are keyed on the bare
 * form. Normalizing at the service boundary is what makes every spelling resolve
 * against the cached tree — and what keeps one route from occupying three cache
 * entries and costing three facet fan-outs.
 */
function normalizeRoutePath(path: string): string {
  const normalized = path
    .trim()
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
  return normalized === 'v2' ? '' : normalized.startsWith('v2/') ? normalized.slice(3) : normalized;
}

/** The `route_not_found` failure for a route absent from the EIA taxonomy. */
function routeNotFound(
  route: string,
  hint = 'Call eia_browse_routes without a path to see valid top-level categories.',
): McpError {
  return notFound(`Route "${route}" not found in the EIA taxonomy.`, {
    reason: 'route_not_found',
    recovery: { hint },
  });
}

/** The `route_not_queryable` failure for a category node, which has no data to query. */
function routeNotQueryable(message: string): McpError {
  return validationError(message, {
    reason: 'route_not_queryable',
    recovery: {
      hint: 'Use eia_browse_routes to drill into sub-routes, or eia_search_routes to find leaf routes.',
    },
  });
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

/**
 * Per-route merged metadata cache. `eia_describe_route` writes it with every
 * facet's values; `eia_query_route` writes it from the route metadata alone,
 * with each facet listed in `unfetchedFacets` for the next describe to fetch.
 * An entry expires `ROUTE_METADATA_TTL_MS` after its route metadata was
 * fetched, and the next describe replaces it with a refreshed one; only leaf
 * routes enter it, so it needs no size bound. Query reads an expired entry's
 * column IDs as before and never refreshes it.
 */
const _routeMetaCache = new Map<string, RouteMetadata>();

/** True once a list or entry fetched at `fetchedAt` is due for a refresh at `now`. */
function isExpired(fetchedAt: number, now: number): boolean {
  return now - fetchedAt >= ROUTE_METADATA_TTL_MS;
}

/**
 * True for a facet value list served from an earlier fetch than its entry's
 * route metadata — one whose refresh EIA did not answer. Such a list keeps its
 * values and is retried by the next describe.
 */
function isStaleList(facet: Facet, meta: RouteMetadata): boolean {
  return facet.fetchedAt !== undefined && facet.fetchedAt < meta.fetchedAt;
}

/**
 * IDs of the value lists a describe of an unexpired entry still fetches —
 * never fetched, or stale — or undefined when there are none.
 */
function dueLists(meta: RouteMetadata): Set<string> | undefined {
  let due: Set<string> | undefined;
  for (const facet of meta.facets) {
    if (facet.fetchedAt !== undefined && !isStaleList(facet, meta)) continue;
    due ??= new Set();
    due.add(facet.id);
  }
  return due;
}

/**
 * `meta` as describe returns it: annotated with what it serves as last fetched
 * — the whole entry when `route` is true, and each stale value list — or
 * `meta` itself when everything in it is current.
 */
function withStale(meta: RouteMetadata, route: boolean): RouteMetadata {
  const facets = meta.facets.flatMap((f) =>
    f.fetchedAt !== undefined && isStaleList(f, meta) ? [{ id: f.id, fetchedAt: f.fetchedAt }] : [],
  );
  return route || facets.length > 0 ? { ...meta, stale: { route, facets } } : meta;
}

/**
 * Cache `meta` unless an entry from newer route metadata landed while this
 * describe was in flight — a concurrent refresh, which a slow call that began
 * from the expired entry must not overwrite with an older one.
 */
function storeRouteMetadata(meta: RouteMetadata): void {
  const landed = _routeMetaCache.get(meta.route);
  if (landed && landed.fetchedAt > meta.fetchedAt) return;
  _routeMetaCache.set(meta.route, meta);
}

/**
 * Data columns a leaf's metadata advertises, in EIA's order. EIA uses two
 * `data` shapes: `{ colId: { alias, units } }`, and `{ value: [] }` on
 * time-series routes whose single column is always `value` — synthesized here
 * so a query without `columns` still requests the measurement.
 */
function dataColumnsOf(raw: RawRouteNode): DataColumn[] {
  const dataObj = raw.data ?? {};
  const columns = Object.entries(dataObj)
    .filter(([, meta]) => meta !== null && typeof meta === 'object' && !Array.isArray(meta))
    .map(([id, meta]) => {
      const col = meta as { alias?: string; units?: string };
      // alias and units may be undefined for some EIA routes (e.g. crude-oil-imports)
      return { id, alias: col.alias ?? id, units: col.units ?? '' };
    });
  if (columns.length === 0 && Array.isArray(dataObj.value)) {
    columns.push({ id: 'value', alias: 'Value', units: '' });
  }
  return columns;
}

/** The IDs a query needs from a route's metadata — none of its facet values. */
interface RouteColumnIds {
  dataColumnIds: string[];
  facetIds: string[];
}

/** Column and facet IDs of cached route metadata. */
function columnIdsOf(meta: RouteMetadata): RouteColumnIds {
  return {
    dataColumnIds: meta.dataColumns.map((c) => c.id),
    facetIds: meta.facets.map((f) => f.id),
  };
}

/**
 * Normalize a leaf's raw metadata into the cached shape. `facets` is every
 * facet the metadata lists, in its order; `unfetchedFacets` names the ones
 * whose value lists are not in hand.
 */
function routeMetadataOf(
  route: string,
  raw: RawRouteNode,
  facets: Facet[],
  unfetchedFacets: string[] = [],
): RouteMetadata {
  const frequencies = frequenciesOf(raw);

  return {
    route,
    fetchedAt: Date.now(),
    description: normalizeDescription(raw.description),
    facets,
    dataColumns: dataColumnsOf(raw),
    frequencies,
    dateRange: {
      start: raw.startPeriod ?? '',
      end: raw.endPeriod ?? '',
    },
    defaultFrequency: raw.defaultFrequency ?? frequencies[0]?.id ?? '',
    defaultDateFormat: raw.defaultDateFormat ?? '',
    ...(unfetchedFacets.length > 0 && { unfetchedFacets }),
  };
}

/**
 * The failure for a describe whose `facet` input names a facet whose value
 * list EIA did not return: there is no window to page, and an empty one would
 * read as an empty facet. Retryable either way — a rate-limited leg keeps
 * `rate_limited` so the caller backs off rather than retrying at once.
 */
function facetUnavailable(route: string, facetId: string, cause: unknown): McpError {
  const rateLimited = cause instanceof McpError && cause.data?.reason === 'rate_limited';
  return serviceUnavailable(
    `EIA did not return the values of facet "${facetId}" on route "${route}"${rateLimited ? ' — rate limit exceeded' : ''}.`,
    {
      reason: rateLimited ? 'rate_limited' : 'facet_unavailable',
      retryable: true,
      route,
      facet: facetId,
    },
    { cause },
  );
}

/**
 * The transport code of a failed fetch — `ECONNREFUSED`, `ENOTFOUND` — read
 * from the error itself (Bun) or its causes (undici). Only an identifier-shaped
 * code is kept: undici's messages name the host, and Bun's error carries the
 * full request URL, API key included, in its `path`.
 */
function transportCode(err: unknown): string | undefined {
  for (let node = err, depth = 0; node instanceof Error && depth < 4; depth++) {
    const code = (node as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z][\w-]*$/.test(code)) return code;
    node = node.cause;
  }
  return;
}

/**
 * The failure for a fetch that threw before EIA answered — connection
 * refused or reset, DNS failure. Transient, so `withRetry` spends its budget
 * on it, and retryable to the caller once that runs out.
 */
function unreachable(cause: unknown): McpError {
  const code = transportCode(cause);
  return serviceUnavailable(
    `Could not reach the EIA API${code ? ` (${code})` : ''} — the request failed before EIA answered.`,
    { reason: 'upstream_unreachable', retryable: true },
    { cause },
  );
}

/**
 * The failure for EIA not answering in the time a request is allowed: one
 * attempt past `ATTEMPT_TIMEOUT_MS`, or a call past its deadline. Transient, so
 * `withRetry` retries an attempt timeout while the deadline lasts, and
 * retryable to the caller once it runs out.
 */
function upstreamTimeout(message: string, cause?: unknown): McpError {
  return timeout(
    message,
    { reason: 'upstream_timeout', retryable: true },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Refuse a query whose start or end EIA answers with HTTP 500 — never with
 * rows — at `frequency`: a `local-hourly` bound without its UTC offset, or a
 * bound in the frequency's own period shape naming a month, day, or hour that
 * does not exist (see `impossiblePeriod`). Sent, either would read as an outage
 * and be retried, so it fails as `invalid_period` before the request.
 */
function assertPeriodBounds(
  frequency: string | undefined,
  bounds: { start?: string | undefined; end?: string | undefined },
): void {
  if (frequency === undefined) return;
  for (const side of ['start', 'end'] as const) {
    const value = bounds[side];
    if (value === undefined) continue;
    if (frequency === 'local-hourly' && lacksUtcOffset(value)) {
      throw validationError(
        `At local-hourly frequency EIA needs each bound as YYYY-MM-DDTHH±HH; ${side} ${JSON.stringify(value)} has no UTC offset.`,
        {
          reason: 'invalid_period',
          recovery: {
            hint: 'Write each local-hourly bound with its hour and UTC offset — "2024-02-01T02-06" is 02:00 at UTC−6, "2024-02-01T08+00" is 08:00 UTC — or query frequency "hourly", whose bounds are UTC hours such as "2024-02-01T08".',
          },
        },
      );
    }
    const problem = impossiblePeriod(value, frequency);
    if (problem === undefined) continue;
    throw validationError(
      `At ${frequency} frequency EIA cannot read ${side} ${JSON.stringify(value)}: it has ${problem}.`,
      {
        reason: 'invalid_period',
        recovery: {
          hint: 'Write each bound as a period that exists — a month 01–12, a day the month has (February 29 only in leap years), and an hour of two digits, 00–23 — e.g. "2024-02-29" or "2024-02-01T23".',
        },
      },
    );
  }
}

/**
 * What an upstream call needs from whoever made it: the signal that cancels
 * it, a log sink, and the bindings its retry records carry. A handler's
 * `Context` is one. The shared warm runs under its own (`EiaApiService.warmScope`),
 * so no request's signal or log reaches work other callers are waiting on.
 */
type CallScope = RequestContext & {
  readonly log: Pick<Context['log'], 'info' | 'warning'>;
  readonly signal: AbortSignal;
};

/** A vocabulary facet the index pass fetches — one `/facet/{id}` endpoint. */
type VocabularyFacetTarget = ReturnType<typeof listVocabularyFacets>[number];

/** The single warm, shared by every caller. */
interface WarmState {
  /**
   * Vocabulary facets the facet pass still owes the index: every target before
   * the first run, then only the ones that failed. Undefined until it first runs.
   */
  facetTargets?: VocabularyFacetTarget[];
  /** The index-pass run in flight, if any — one run serves every caller waiting on it. */
  indexRun?: Promise<void> | undefined;
  /** When the tree build started (epoch ms) — the anchor of `ROUTE_WARM_BUDGET_MS`. */
  startedAt: number;
  /** Resolves once the route tree is built; rejects when the build fails. */
  tree: Promise<void>;
}

class EiaApiService {
  /** Aborted only at shutdown — the lifetime of the shared warm. */
  private readonly lifetime = new AbortController();

  /**
   * The scope every warm fetch runs under. Built when the service is
   * constructed in `setup()`, outside any request, so its request ID and trace
   * bindings belong to no caller.
   */
  private readonly warmScope: CallScope = (() => {
    const context = requestContextService.createRequestContext({
      operation: 'EiaApiService.warm',
    });
    const bind = (data?: Record<string, unknown>) => (data ? withExtra(context, data) : context);
    return {
      ...context,
      log: {
        info: (msg, data) => logger.info(msg, bind(data)),
        warning: (msg, data) => logger.warning(msg, bind(data)),
      },
      signal: this.lifetime.signal,
    };
  })();

  /** The one warm in flight or already done (prevents duplicate warm-up). */
  private warmState: WarmState | undefined;

  /** Abort the shared warm. Its in-flight fetches reject and nothing re-runs it. */
  shutdown(): void {
    this.lifetime.abort(new Error('EIA service shut down'));
  }

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

  /**
   * GET one EIA endpoint and parse it, retried on transient failures. Each
   * attempt — headers and body — is cut at `ATTEMPT_TIMEOUT_MS`, and every
   * attempt and backoff shares the deadline `deadlineAt` (epoch ms): a tool
   * call passes the one it set on entry, so its chained requests share it, and
   * a warm request gets `CALL_DEADLINE_MS` of its own. Throws `upstream_timeout`
   * when EIA does not answer in time; a caller's abort stays a cancellation.
   */
  private async fetchJson<T>(
    path: string,
    params: Record<string, string | string[]>,
    scope: CallScope,
    deadlineAt = Date.now() + CALL_DEADLINE_MS,
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    const budgetMs = deadlineAt - Date.now();
    if (budgetMs <= 0) {
      throw upstreamTimeout(
        `EIA did not answer in time — this call's ${CALL_DEADLINE_MS / 1000} s deadline passed before this request could start.`,
      );
    }
    try {
      return await withRetry(
        ({ signal, remainingMs }) => this.attemptJson<T>(url, signal, remainingMs),
        {
          operation: 'EiaApiService.fetchJson',
          baseDelayMs: 1000,
          context: scope,
          signal: scope.signal,
          deadlineMs: budgetMs,
        },
      );
    } catch (err) {
      // The deadline expiring mid-attempt or mid-backoff is EIA not answering in
      // time, carried under the reason the tools declare.
      if (
        !scope.signal.aborted &&
        err instanceof McpError &&
        err.data?.reason === 'retry_deadline_exceeded'
      ) {
        const attempts = Number(err.data.retryAttempts);
        throw upstreamTimeout(
          `EIA did not answer in time — the ${CALL_DEADLINE_MS / 1000} s deadline ran out during this request, after ${attempts} attempt${attempts === 1 ? '' : 's'}.`,
          err,
        );
      }
      throw err;
    }
  }

  /**
   * One attempt of `fetchJson`: fetch, read, classify, parse. `retrySignal`
   * carries the caller's signal and the retry deadline; the attempt adds its
   * own `ATTEMPT_TIMEOUT_MS` cut, held to what the deadline has left.
   */
  private async attemptJson<T>(
    url: string,
    retrySignal: AbortSignal,
    remainingMs: number,
  ): Promise<T> {
    const attemptMs = Math.min(ATTEMPT_TIMEOUT_MS, remainingMs);
    const attempt = new AbortController();
    const timer = setTimeout(() => attempt.abort(), attemptMs);
    let response: Response;
    let text: string;
    try {
      const signal = AbortSignal.any([retrySignal, attempt.signal]);
      response = await fetch(url, { signal });
      text = await response.text();
    } catch (err) {
      // A caller's abort stays a cancellation, and an expired deadline is
      // classified by withRetry; the attempt's own cut is a timeout, and
      // anything else thrown before EIA answered is a transport failure, each
      // retried like any outage.
      if (retrySignal.aborted) throw err;
      if (attempt.signal.aborted) {
        throw upstreamTimeout(`EIA did not answer within ${Math.round(attemptMs / 1000)} s.`, err);
      }
      throw unreachable(err);
    } finally {
      clearTimeout(timer);
    }

    // EIA refuses a request line past about 8 KB with an HTML 414 page. The
    // same URI fails the same way on every attempt, so it is never retried.
    // Status decides every non-OK answer; only a 200 body that fails to
    // parse as JSON is classified from its contents.
    if (response.status === 414) {
      throw validationError(
        `EIA rejected the request as too long (HTTP 414): its URI ran to ${url.length.toLocaleString('en-US')} characters, past EIA's limit of about 8 KB.`,
        { reason: 'uri_too_long', retryable: false },
      );
    }

    if (!response.ok) {
      if (response.status === 429 || text.includes('OVER_RATE_LIMIT')) {
        throw serviceUnavailable('EIA rate limit exceeded.', {
          reason: 'rate_limited',
          retryable: true,
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

      const error = await httpErrorFromResponse(response, {
        service: 'EIA',
        captureBody: false,
        codeOverride: (status) => (status === 400 ? JsonRpcErrorCode.ValidationError : undefined),
      });
      error.message = detail;
      if (error.code === JsonRpcErrorCode.ServiceUnavailable && response.status !== 501) {
        throw serviceUnavailable(
          detail,
          { ...error.data, reason: 'upstream_unavailable', retryable: true },
          { cause: error },
        );
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw serviceUnavailable('EIA API returned non-JSON response.', {
        reason: 'upstream_invalid_response',
        retryable: true,
      });
    }

    const parsedResponse =
      typeof parsed === 'object' && parsed !== null && 'response' in parsed
        ? (parsed as { response: unknown }).response
        : undefined;
    if (typeof parsedResponse === 'string' && parsedResponse.includes('OVER_RATE_LIMIT')) {
      throw serviceUnavailable('EIA rate limit exceeded (OVER_RATE_LIMIT).', {
        reason: 'rate_limited',
        retryable: true,
      });
    }

    return parsed as T;
  }

  /**
   * Await the route tree — everything browse, describe, and query need — until
   * `ROUTE_WARM_BUDGET_MS` after the build started. Resolves true once the tree
   * is in hand and false when the budget ran out first; the caller then answers
   * from a live fetch while the warm keeps running for everyone else. The
   * budget is the warm's, not each caller's: a call arriving once a slow build
   * has outlasted it goes live at once instead of paying the wait again. A
   * build failure still rejects. The index-widening passes may still be
   * running when this resolves.
   */
  async ensureTreeWarmed(ctx: Context): Promise<boolean> {
    if (isRouteCacheReady()) return true;
    const warm = this.warm();
    const ready = await awaitShared(warm.tree, ctx.signal, warm.startedAt + ROUTE_WARM_BUDGET_MS);
    if (!ready) {
      ctx.log.warning('Answering from a live fetch before the EIA route tree finished warming', {
        budgetMs: ROUTE_WARM_BUDGET_MS,
      });
    }
    return ready;
  }

  /**
   * Await the fully warmed corpus — the tree plus every index-widening pass.
   * Search takes this path so a caller is never handed a ranking computed over
   * a half-filled index, which reads exactly like a ranking over the whole one.
   * The wait is paid once per process; every later search is served from memory,
   * unless a pass fell short, in which case the search re-runs its missing work.
   *
   * `budgetMs` caps the wait, so an upstream slow enough to outlast the client's
   * own request timeout degrades to a partial answer the caller can recognize
   * rather than to a transport error. A build failure still rejects.
   */
  async ensureIndexWarmed(ctx: Context, budgetMs: number): Promise<void> {
    const warm = this.warm();
    const deadline = Date.now() + budgetMs;

    if (!(await awaitShared(warm.tree, ctx.signal, deadline))) {
      ctx.log.warning('Answering before the EIA route tree finished warming', { budgetMs });
      return;
    }
    if (!(await awaitShared(this.indexPasses(warm), ctx.signal, deadline))) {
      ctx.log.warning('Answering before the EIA search index finished warming', { budgetMs });
    }
  }

  /**
   * The single warm, started on demand by whichever call needs it first and
   * owned by the service from then on. The index passes start as soon as the
   * tree lands, whether or not that caller waits for them. A tree failure
   * clears the warm so the next call builds again, and is left to the callers
   * awaiting `tree` to observe.
   */
  private warm(): WarmState {
    if (this.warmState) return this.warmState;

    const tree = (async () => {
      if (isRouteCacheReady()) return;
      try {
        await this.buildTree(this.warmScope);
      } catch (err) {
        // Let the next call retry the warm rather than caching the failure.
        this.warmState = undefined;
        throw err;
      }
    })();

    const warm: WarmState = { startedAt: Date.now(), tree };
    this.warmState = warm;
    tree.then(
      () => this.indexPasses(warm),
      () => undefined,
    );
    return warm;
  }

  /**
   * The index passes the corpus still owes, run once for every caller waiting
   * on them: an in-flight run is shared, and a settled warm with passes pending
   * starts a run of just those. Resolves at once when nothing is pending, and
   * never rejects — a pass that fails is reported by `getIndexStatus()`.
   */
  private indexPasses(warm: WarmState): Promise<void> {
    if (warm.indexRun) return warm.indexRun;
    const pending = getIndexStatus().pendingPasses;
    if (pending.length === 0 || this.lifetime.signal.aborted) return Promise.resolve();

    const run = this.runIndexPasses(warm, pending).finally(() => {
      warm.indexRun = undefined;
    });
    warm.indexRun = run;
    return run;
  }

  /**
   * Fetch top-level routes, recursively discover children via per-node GETs,
   * and build the node map plus the Fuse.js index over it.
   */
  private async buildTree(scope: CallScope): Promise<void> {
    scope.log.info('Warming EIA route tree cache');

    const rootResponse = await this.fetchJson<{ response: { routes: RawRouteNode[] } }>(
      '',
      {},
      scope,
    );
    const topLevelNodes = rootResponse?.response?.routes ?? [];

    if (topLevelNodes.length === 0) {
      throw serviceUnavailable('EIA root endpoint returned no routes.', {
        reason: 'upstream_invalid_response',
        retryable: true,
      });
    }

    using gate = createPacer({ name: 'eia-tree', maxConcurrent: TREE_BUILD_CONCURRENCY });
    let tree = await this.buildRouteTree(topLevelNodes, gate, scope);

    // What the pass above misses is EIA rate-limiting the burst it is itself
    // making, so retrying inside it only adds to the pressure. Sweep once the
    // burst is over, one request at a time — the second pass re-fetches only
    // the nodes still missing metadata and leaves the rest untouched.
    const missed = incompletePaths(tree);
    if (missed.length > 0) {
      scope.log.info('Re-fetching route metadata the tree build could not reach', {
        routes: missed,
      });
      using repairGate = createPacer({ name: 'eia-tree-repair', maxConcurrent: 1 });
      tree = await this.buildRouteTree(tree, repairGate, scope);
    }

    initRouteCache(tree, []);

    const { incompleteRoutes } = getIndexStatus();
    scope.log.info('EIA route tree built', { indexSize: getIndexSize(), incompleteRoutes });
  }

  /**
   * Run the given index-widening passes and record which of them landed in
   * full. A pass that fails leaves the corpus short, which `getIndexStatus()`
   * then reports and the next search retries — it never takes the tree down
   * with it. Each runner resolves true when its pass landed in full; the
   * `Record` keeps a new `IndexPass` from compiling without one.
   */
  private async runIndexPasses(warm: WarmState, passes: readonly IndexPass[]): Promise<void> {
    const scope = this.warmScope;
    const namedSeries = (pass: NamedSeriesPass) => async () => {
      await this.fetchNamedSeries(pass, scope);
      return true;
    };
    const runners: Record<IndexPass, () => Promise<boolean>> = {
      steo_series: namedSeries('steo_series'),
      seds_series: namedSeries('seds_series'),
      facet_values: async () => {
        warm.facetTargets = await this.indexVocabularyFacets(
          warm.facetTargets ?? listVocabularyFacets(),
          scope,
        );
        return warm.facetTargets.length === 0;
      },
    };

    await Promise.all(
      passes.map((pass) =>
        runners[pass]().then(
          (landed) => {
            if (landed) markIndexPassSettled(pass);
          },
          (err: unknown) => {
            scope.log.warning('EIA index pass failed', { pass, error: errorMessage(err) });
          },
        ),
      ),
    );

    scope.log.info('EIA search corpus warmed', { passes, ...getIndexStatus() });
  }

  /**
   * Resolve `nodes` and their descendants. `deadlineAt` is the deadline of the
   * tool call repairing a node; the warm passes none, so each of its requests
   * gets one of its own.
   */
  private buildRouteTree(
    nodes: RawRouteNode[],
    gate: Pacer,
    scope: CallScope,
    depth = 0,
    parentPath = '',
    deadlineAt?: number,
  ): Promise<RawRouteNode[]> {
    // Limit recursion depth to avoid excessive API calls
    if (depth > 5) return Promise.resolve(nodes);

    return Promise.all(
      nodes.map(async (node): Promise<RawRouteNode> => {
        const nodePath = parentPath ? `${parentPath}/${node.id}` : node.id;
        const resolved = await this.resolveNode(node, nodePath, gate, scope, deadlineAt);
        if (!resolved.routes?.length) return resolved;
        const children = await this.buildRouteTree(
          resolved.routes,
          gate,
          scope,
          depth + 1,
          nodePath,
          deadlineAt,
        );
        return { ...resolved, routes: children };
      }),
    );
  }

  /**
   * One node with enough metadata to classify it, its children left as EIA
   * listed them. A node that already carries sub-routes or a leaf marker is
   * returned as-is; a bare stub costs one paced metadata request.
   */
  private async resolveNode(
    node: RawRouteNode,
    nodePath: string,
    gate: Pacer,
    scope: CallScope,
    deadlineAt?: number,
  ): Promise<RawRouteNode> {
    if (node.routes?.length || node.frequency || node.facets || node.data) return node;

    // A failure here has already exhausted fetchJson's retry budget, so the
    // node is marked incomplete rather than kept as a bare stub — a stub
    // carries none of routes/facets/data and would read as a queryable leaf,
    // hiding both the real children and the fact that anything went wrong.
    try {
      return await this.fetchNode(node, nodePath, gate, scope, deadlineAt);
    } catch (err) {
      // A caller's abort is a cancellation, never a node EIA failed to answer.
      if (scope.signal.aborted) throw err;
      scope.log.warning('EIA route metadata fetch failed — subtree unknown', {
        route: nodePath,
        error: errorMessage(err),
      });
      return { ...node, incomplete: true };
    }
  }

  /**
   * One paced metadata request for a bare stub, merged with it. Throws the
   * request's own classified failure, and `upstream_invalid_response` when EIA
   * answers without a route envelope.
   */
  private async fetchNode(
    node: RawRouteNode,
    nodePath: string,
    gate: Pacer,
    scope: CallScope,
    deadlineAt?: number,
  ): Promise<RawRouteNode> {
    const resp = await gate.run(
      () => this.fetchJson<{ response?: RawRouteNode }>(nodePath, {}, scope, deadlineAt),
      { signal: scope.signal },
    );
    const fetched = resp?.response;
    if (!fetched) {
      throw serviceUnavailable(`EIA did not return metadata for route "${nodePath}".`, {
        reason: 'upstream_invalid_response',
        retryable: true,
        route: nodePath,
        recovery: { hint: 'Retry the call; if it persists, check api.eia.gov availability.' },
      });
    }

    // Preserve id and name from the stub — EIA leaf responses use the domain
    // category as `id` (e.g. "petroleum") rather than the route segment (e.g.
    // "gnd"), and often omit `name`. Without this guard the merge would corrupt
    // the path when buildNodeMap runs later.
    return { ...fetched, id: node.id, name: node.name ?? fetched.id };
  }

  /**
   * Re-fetch a node whose warm-time metadata fetch failed and splice the result
   * into the cached tree. The miss is not held for the process lifetime — the
   * first call that needs the node pays one request to repair it. When the
   * re-fetch fails too, its own failure is thrown rather than answering from
   * the stub — `rate_limited`, `upstream_unreachable`, `upstream_unavailable`,
   * `upstream_timeout`, or `upstream_invalid_response` for an answer that is
   * not route metadata — and a 404 is `route_not_found`. The node's children
   * resolve as the warm resolves them: one that fails is kept incomplete.
   */
  private async repairNode(path: string, ctx: Context, deadlineAt: number): Promise<RawRouteNode> {
    const stub = getNode(path);
    if (!stub) throw routeNotFound(path);

    ctx.log.info('Re-fetching a route left incomplete by the warm', { route: path });
    using gate = createPacer({ name: 'eia-node-repair', maxConcurrent: TREE_BUILD_CONCURRENCY });
    let node: RawRouteNode;
    try {
      node = await this.fetchNode(stub, path, gate, ctx, deadlineAt);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw routeNotFound(path);
      }
      throw err;
    }
    const repaired: RawRouteNode = node.routes?.length
      ? {
          ...node,
          routes: await this.buildRouteTree(
            node.routes,
            gate,
            ctx,
            path.split('/').length,
            path,
            deadlineAt,
          ),
        }
      : node;

    replaceNode(path, repaired);
    return repaired;
  }

  /**
   * Fetch one `NAMED_SERIES_FACETS` facet whole — a single `/facet/{id}`
   * request, however many values it carries — and index every series in it.
   * Throws when the fetch fails, which leaves the pass pending for the next
   * search to retry.
   */
  private async fetchNamedSeries(pass: NamedSeriesPass, scope: CallScope): Promise<void> {
    const { route, facetId } = NAMED_SERIES_FACETS[pass];
    const facet = await this.fetchFacet(route, { id: facetId, description: '' }, scope);
    scope.log.info('Named series indexed', {
      pass,
      values: facet.values.length,
      added: indexNamedSeries(pass, facet.values),
    });
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
  private async fetchFacet(
    route: string,
    meta: RawFacetMeta,
    scope: CallScope,
    deadlineAt?: number,
  ): Promise<Facet> {
    const resp = await this.fetchJson<{ response: RawFacetResponse }>(
      `${route}/facet/${meta.id}`,
      {},
      scope,
      deadlineAt,
    );
    return {
      id: meta.id,
      description: meta.description,
      complete:
        Number.isInteger(resp?.response?.totalFacets) &&
        resp.response.totalFacets >= 0 &&
        resp.response.facets?.length === resp.response.totalFacets &&
        new Set(resp.response.facets.filter((v) => v.id != null).map((v) => v.id)).size ===
          resp.response.totalFacets,
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
   * tree — fuel types, sectors, coal ranks, and the `series`, `product`, and
   * `respondent` values of the routes publishing sub-monthly data (daily and
   * weekly petroleum and natural gas, hourly and daily RTO) — so a query naming
   * one resolves to the route that exposes it.
   * Bounded on both sides: `listVocabularyFacets()` selects a fraction of the
   * taxonomy's facets, and each fetch is paced by `FACET_INDEX_CONCURRENCY`.
   * `indexVocabularyFacet` holds each to the 200-value bound but `series`,
   * which is indexed whole. A facet that fails is skipped, as `describe()`
   * records a failed facet leg rather than failing the route — and it
   * is returned, because a skipped facet leaves vocabulary out of the corpus:
   * the caller is entitled to know the pass fell short, and a retry re-fetches
   * only the targets that are still missing.
   */
  private async indexVocabularyFacets(
    targets: VocabularyFacetTarget[],
    scope: CallScope,
  ): Promise<VocabularyFacetTarget[]> {
    if (targets.length === 0) return [];

    using gate = createPacer({ name: 'eia-facet-index', maxConcurrent: FACET_INDEX_CONCURRENCY });
    let indexed = 0;
    const failed: VocabularyFacetTarget[] = [];
    await Promise.all(
      targets.map(async (target) => {
        const { route, facetId, description } = target;
        try {
          const facet = await gate.run(
            () => this.fetchFacet(route, { id: facetId, description }, scope),
            { signal: scope.signal },
          );
          indexed += indexVocabularyFacet(route, facet);
        } catch (err) {
          failed.push(target);
          scope.log.warning('EIA facet fetch failed — vocabulary missing from the index', {
            route,
            facetId,
            error: errorMessage(err),
          });
        }
      }),
    );

    scope.log.info('Facet values indexed', {
      facets: targets.length,
      failed: failed.length,
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
    const deadlineAt = Date.now() + CALL_DEADLINE_MS;
    const normalizedPath = normalizeRoutePath(path ?? '');
    if (!(await this.ensureTreeWarmed(ctx))) {
      return this.browseLive(normalizedPath, ctx, deadlineAt);
    }

    // Check if the path itself is a leaf
    if (normalizedPath) {
      let node = getNode(normalizedPath);
      if (!node) throw routeNotFound(normalizedPath);
      if (node.incomplete) node = await this.repairNode(normalizedPath, ctx, deadlineAt);
      if (isLeafNode(node)) return { path: normalizedPath, children: [], isLeaf: true };
    }

    const children: RouteEntry[] = getChildren(normalizedPath).map(({ id, route, node }) => ({
      id,
      name: node.name,
      description: node.description ?? '',
      route,
      isLeaf: isLeafNode(node),
    }));
    return { path: normalizedPath, children, isLeaf: false };
  }

  /**
   * Browse one path straight from EIA — the answer when the route tree has not
   * landed within `ROUTE_WARM_BUDGET_MS`. Costs the path's own metadata request
   * plus one per child whose stub does not say whether it is a leaf: the same
   * requests the warm makes for that level, merged and classified the same way,
   * under the caller's signal rather than the warm's.
   */
  private async browseLive(
    path: string,
    ctx: Context,
    deadlineAt: number,
  ): Promise<{ path: string; children: RouteEntry[]; isLeaf: boolean }> {
    let node: RawRouteNode | undefined;
    try {
      node = (await this.fetchJson<{ response?: RawRouteNode }>(path, {}, ctx, deadlineAt))
        ?.response;
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw routeNotFound(path);
      }
      throw err;
    }
    if (!node) {
      throw serviceUnavailable(`EIA returned no metadata for route "${path || '(root)'}".`, {
        reason: 'upstream_invalid_response',
        retryable: true,
        route: path,
        recovery: { hint: 'Retry the call; if it persists, check api.eia.gov availability.' },
      });
    }
    if (path && isLeafNode(node)) return { path, children: [], isLeaf: true };

    using gate = createPacer({ name: 'eia-browse-live', maxConcurrent: TREE_BUILD_CONCURRENCY });
    const children = await Promise.all(
      (node.routes ?? []).map(async (stub): Promise<RouteEntry> => {
        const route = path ? `${path}/${stub.id}` : stub.id;
        const child = await this.resolveNode(stub, route, gate, ctx, deadlineAt);
        return {
          id: stub.id,
          name: child.name,
          description: normalizeDescription(child.description),
          route,
          isLeaf: isLeafNode(child),
        };
      }),
    );
    return { path, children, isLeaf: false };
  }

  /**
   * Describe a leaf route — returns full metadata including facets with values.
   * The route is normalized first, so every spelling of one path shares a
   * single metadata cache entry and a single facet fan-out; `meta.route` is
   * therefore the canonical form, which is what the tool echoes back.
   *
   * Facet value lists are fetched for every facet the entry names in
   * `unfetchedFacets`: all of them on a first describe, and afterwards only the
   * ones a query never fetched or an earlier describe could not, without
   * requesting the metadata again. A list that fails past its retries
   * leaves the describe successful and stays named, unless `opts.facet` asks
   * for exactly that facet: there is no window to page, so the call fails
   * retryably with the leg's own cause.
   *
   * An entry expires `ROUTE_METADATA_TTL_MS` after its route metadata was
   * fetched, and the next describe refreshes it as a first describe would:
   * the route metadata, then every facet list. A list whose refresh fails
   * keeps serving its previous values — it is stale, not unavailable — and the
   * next describe retries it alone; a route metadata refresh that fails serves
   * the whole previous entry. Either way the result names what it serves as
   * last fetched in `stale`. A refresh answered 404 (or naming a category) is
   * EIA's answer, not a failure: the entry is dropped and the call fails as a
   * cold describe would. A caller's cancellation propagates and leaves the
   * previous entry for the next caller. Concurrent describes of an expired
   * entry each refresh under their own signal, as cold describes do.
   */
  async describe(
    route: string,
    ctx: Context,
    opts: { facet?: string } = {},
  ): Promise<RouteMetadata> {
    const deadlineAt = Date.now() + CALL_DEADLINE_MS;
    const normalizedRoute = normalizeRoutePath(route);

    const cached = _routeMetaCache.get(normalizedRoute);
    if (cached && !isExpired(cached.fetchedAt, Date.now())) {
      // The common case — every list current — allocates nothing.
      const due = dueLists(cached);
      if (due === undefined) return cached;
      return this.finishDescribe(cached, due, ctx, deadlineAt, opts.facet);
    }

    if (!cached) {
      await this.ensureTreeWarmed(ctx);
      // An incomplete node was never classified, and a missing one may be a
      // route the tree walk missed — or the tree has not landed within its
      // budget — so none of them pre-empts the live fetch below, which fails a
      // category or an unknown route with the same reasons.
      const node = normalizedRoute ? getNode(normalizedRoute) : undefined;
      if (node && !node.incomplete && !isLeafNode(node)) {
        throw routeNotQueryable(
          `Route "${normalizedRoute}" is a category, not a leaf — it has no data to query.`,
        );
      }
    }

    let fresh: RouteMetadata;
    try {
      fresh = await this.fetchRouteMetadata(normalizedRoute, ctx, deadlineAt);
    } catch (err) {
      if (!cached || ctx.signal.aborted) throw err;
      const reason = err instanceof McpError ? err.data?.reason : undefined;
      if (reason === 'route_not_found' || reason === 'route_not_queryable') {
        _routeMetaCache.delete(normalizedRoute);
        throw err;
      }
      ctx.log.warning(
        'EIA route metadata refresh failed — serving the cached entry as last fetched',
        {
          route: normalizedRoute,
          fetchedAt: new Date(cached.fetchedAt).toISOString(),
          error: errorMessage(err),
        },
      );
      if (opts.facet !== undefined && cached.unfetchedFacets?.includes(opts.facet)) {
        throw facetUnavailable(normalizedRoute, opts.facet, err);
      }
      return withStale(cached, true);
    }

    // Each list the expired entry held rides into the refreshed one, so a
    // refresh of it that fails still has its previous values to serve.
    const previous = new Map(cached?.facets.map((f) => [f.id, f]));
    const facets = fresh.facets.map((f): Facet => {
      const prior = previous.get(f.id);
      return prior?.fetchedAt === undefined ? f : { ...prior, description: f.description };
    });
    return this.finishDescribe(
      { ...fresh, facets },
      new Set(facets.map((f) => f.id)),
      ctx,
      deadlineAt,
      opts.facet,
    );
  }

  /**
   * Fetch the `pending` value lists of `meta`, cache the result, and return it
   * as describe does — failing the call only when `facet` names a list that
   * failed and has no previous values to serve.
   */
  private async finishDescribe(
    meta: RouteMetadata,
    pending: ReadonlySet<string>,
    ctx: Context,
    deadlineAt: number,
    facet: string | undefined,
  ): Promise<RouteMetadata> {
    const { meta: updated, failures } = await this.fetchFacetValues(meta, pending, ctx, deadlineAt);
    if (facet !== undefined && failures.has(facet) && updated.unfetchedFacets?.includes(facet)) {
      throw facetUnavailable(updated.route, facet, failures.get(facet));
    }
    return withStale(updated, false);
  }

  /**
   * Fetch a leaf's route metadata — `GET /v2/{route}`, which lists its facets
   * and data columns but none of the facet values — normalized with every
   * facet named in `unfetchedFacets`. A 404 becomes `route_not_found` and a
   * category `route_not_queryable`. Nothing is cached here.
   */
  private async fetchRouteMetadata(
    route: string,
    ctx: Context,
    deadlineAt: number,
  ): Promise<RouteMetadata> {
    let metaRespRaw: { response: RawRouteNode } | undefined;
    try {
      metaRespRaw = await this.fetchJson<{ response: RawRouteNode }>(route, {}, ctx, deadlineAt);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw routeNotFound(
          route,
          'Use eia_browse_routes or eia_search_routes to discover valid route paths.',
        );
      }
      throw err;
    }
    const rawNode = metaRespRaw?.response;
    if (!rawNode) {
      throw serviceUnavailable(`EIA returned no metadata for route "${route}".`, {
        reason: 'upstream_invalid_response',
        retryable: true,
      });
    }

    if (!isLeafNode(rawNode)) {
      throw routeNotQueryable(`Route "${route}" is a category, not a leaf.`);
    }

    const facets = (rawNode.facets ?? []).map(
      (f): Facet => ({ id: f.id, description: f.description, values: [] }),
    );
    return routeMetadataOf(
      route,
      rawNode,
      facets,
      facets.map((f) => f.id),
    );
  }

  /**
   * Cache a leaf's route metadata with no facet values — the query path's
   * fallback when neither the warmed node nor a prior describe holds the
   * route's data columns. Every facet stays in `unfetchedFacets`, so the entry
   * never reads as a described route and the next describe fetches the lists.
   * Like a describe's, the entry expires `ROUTE_METADATA_TTL_MS` after its
   * fetch, and the first describe past that refreshes its metadata too.
   */
  private async cacheRouteMetadata(
    route: string,
    ctx: Context,
    deadlineAt: number,
  ): Promise<RouteMetadata> {
    const meta = await this.fetchRouteMetadata(route, ctx, deadlineAt);
    // A describe that landed while this request was in flight holds more — keep it.
    const landed = _routeMetaCache.get(route);
    if (landed) return landed;
    _routeMetaCache.set(route, meta);
    return meta;
  }

  /**
   * Fetch, in parallel, the `pending` value lists of `meta`, and cache and
   * index the merged result. A list that fails past its retries is not cached
   * as an empty facet: one never fetched stays in `unfetchedFacets`, one with
   * previous values keeps them as a stale list, and either is re-fetched by the
   * next describe; its error is returned under its facet ID. A caller's
   * cancellation propagates instead of reading as a failed list, and caches
   * nothing.
   */
  private async fetchFacetValues(
    meta: RouteMetadata,
    pending: ReadonlySet<string>,
    ctx: Context,
    deadlineAt: number,
  ): Promise<{ meta: RouteMetadata; failures: Map<string, unknown> }> {
    const failures = new Map<string, unknown>();
    const facets = await Promise.all(
      meta.facets.map(async (facet): Promise<Facet> => {
        if (!pending.has(facet.id)) return facet;
        try {
          const fetched = await this.fetchFacet(meta.route, facet, ctx, deadlineAt);
          // Stamped no earlier than the entry's own metadata, even across a
          // wall-clock step back, so a list fetched now never reads as stale.
          return { ...fetched, fetchedAt: Math.max(Date.now(), meta.fetchedAt) };
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          failures.set(facet.id, err);
          ctx.log.warning(
            facet.fetchedAt === undefined
              ? 'EIA facet fetch failed — left for the next describe to retry'
              : 'EIA facet refresh failed — serving its last fetched values until the next describe retries it',
            { route: meta.route, facetId: facet.id, error: errorMessage(err) },
          );
          return facet;
        }
      }),
    );

    const { unfetchedFacets: _fetchedNow, ...rest } = meta;
    const unfetchedFacets = facets.filter((f) => f.fetchedAt === undefined).map((f) => f.id);
    const updated: RouteMetadata = {
      ...rest,
      facets,
      ...(unfetchedFacets.length > 0 && { unfetchedFacets }),
    };
    storeRouteMetadata(updated);

    // The facet values are already in hand, so folding them into the search
    // index costs nothing upstream. This is what makes a described route's
    // vocabulary searchable even when its facets are outside the warm-time set.
    const fetched = facets.filter((f) => pending.has(f.id) && !failures.has(f.id));
    const added = indexFacetValues(meta.route, fetched);
    if (added > 0) {
      ctx.log.debug('Facet values indexed from describe', { route: meta.route, values: added });
    }
    return { meta: updated, failures };
  }

  /**
   * The data column and facet IDs of a route, from what this process already
   * holds: the warmed tree node when its metadata arrived, else the metadata
   * cache. Undefined when neither has them — the node is incomplete or absent
   * and the route was never described or queried.
   */
  private knownColumnIds(
    route: string,
    node: RawRouteNode | undefined,
  ): RouteColumnIds | undefined {
    if (node && !node.incomplete && node.data !== undefined) {
      return {
        dataColumnIds: dataColumnsOf(node).map((c) => c.id),
        facetIds: (node.facets ?? []).map((f) => f.id),
      };
    }
    const meta = _routeMetaCache.get(route);
    return meta && columnIdsOf(meta);
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
   * and by EIA's 5,000-row-per-request ceiling. `data` is never widened: it is
   * the one page of `length` rows, which the tool returns inline whole.
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
    const deadlineAt = Date.now() + CALL_DEADLINE_MS;
    const normalizedRoute = normalizeRoutePath(route);
    // An explicit frequency is checked before any request, the warm included.
    assertPeriodBounds(opts.frequency, opts);

    // Pre-flight: if the route is in the cache as a category node, fail early
    // with a typed error rather than letting the EIA API return a generic 404.
    // An incomplete node is skipped — it was never classified either way.
    const treeReady = await this.ensureTreeWarmed(ctx);
    const cachedNode = getNode(normalizedRoute);
    if (cachedNode && !cachedNode.incomplete && !isLeafNode(cachedNode)) {
      throw routeNotQueryable(
        `Route "${normalizedRoute}" is a category, not a leaf — it has no data to query.`,
      );
    }

    const params: Record<string, string | string[]> = {};

    if (opts.frequency) params.frequency = opts.frequency;
    if (opts.start) params.start = opts.start;
    if (opts.end) params.end = opts.end;

    // Every row carries `period` and each facet ID whatever `data[]` says, and
    // `data[]` accepts only data columns — so a caller naming one of those in
    // `columns` is asking for a field it gets anyway. Those names are dropped
    // unless a data column shares them. When this process holds neither the
    // node's metadata nor a describe of the route, `columns` goes out as given
    // rather than spending a request to clean it — unless the tree has not
    // landed, when nothing has classified the route either: EIA answers a
    // category's /data with a bare 404, so the route metadata is fetched first,
    // failing a category as route_not_queryable and supplying the columns.
    const known =
      this.knownColumnIds(normalizedRoute, cachedNode) ??
      (treeReady
        ? undefined
        : columnIdsOf(await this.cacheRouteMetadata(normalizedRoute, ctx, deadlineAt)));
    const projection =
      known && opts.columns
        ? opts.columns.filter(
            (c) =>
              known.dataColumnIds.includes(c) || (c !== 'period' && !known.facetIds.includes(c)),
          )
        : opts.columns;
    const appliedColumns = projection?.length ? projection : undefined;

    // EIA only returns value fields when data[] params are explicitly set, so a
    // query that names no data column sends every one the route has. Those IDs
    // come from the warmed node or the metadata cache, and failing both from
    // the route metadata alone — never from the facet value lists, which a
    // query does not use and which cost one request per facet.
    const columnsToRequest =
      appliedColumns ??
      (known ?? columnIdsOf(await this.cacheRouteMetadata(normalizedRoute, ctx, deadlineAt)))
        .dataColumnIds;
    if (columnsToRequest.length) {
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
    const length = opts.length ?? 25;

    // An omitted frequency is the route's default, read from what this process
    // already holds; with neither the node nor its metadata, EIA judges the bounds.
    if (opts.frequency === undefined) {
      assertPeriodBounds(
        cachedNode?.defaultFrequency ?? _routeMetaCache.get(normalizedRoute)?.defaultFrequency,
        opts,
      );
    }

    const firstStartedAt = Date.now();
    const first = await this.fetchDataPage(
      normalizedRoute,
      params,
      offset,
      length,
      ctx,
      deadlineAt,
    );
    const firstPageMs = Date.now() - firstStartedAt;
    const total = parseInt(first.response.total ?? '0', 10);
    const data: DataRow[] = first.response.data ?? [];

    const result: DataResponse = {
      route: normalizedRoute,
      total,
      dateFormat: first.response.dateFormat ?? '',
      frequency: first.response.frequency ?? opts.frequency ?? '',
      data,
      warnings: first.warnings?.length ? first.warnings : undefined,
      ...(appliedColumns && { appliedColumns }),
    };

    // A list never fetched, or one past its refresh time, is not evidence that
    // a value is missing — EIA may have added it since — and a query never
    // refreshes a list, so such a list is skipped.
    const notices: string[] = [];
    const now = Date.now();
    for (const facet of _routeMetaCache.get(normalizedRoute)?.facets ?? []) {
      const submitted = opts.filters?.[facet.id];
      if (
        !facet.complete ||
        facet.fetchedAt === undefined ||
        isExpired(facet.fetchedAt, now) ||
        submitted === undefined
      )
        continue;
      const ids = new Set(facet.values.map((v) => v.id));
      const unmatched = [...new Set(Array.isArray(submitted) ? submitted : [submitted])].filter(
        (value) => !ids.has(value),
      );
      if (unmatched.length === 0) continue;
      const folded = new Map<string, string[]>();
      for (const id of ids) {
        const key = id.toLowerCase();
        const matches = folded.get(key) ?? [];
        matches.push(id);
        folded.set(key, matches);
      }
      const suggestions = unmatched.flatMap((value) => {
        const matches = folded.get(value.toLowerCase());
        return matches
          ? [
              `For ${JSON.stringify(value)}, did you mean ${matches.map((id) => JSON.stringify(id)).join(' or ')}?`,
            ]
          : [];
      });
      notices.push(
        `Filter ${facet.id} ${unmatched.length === 1 ? 'value' : 'values'} ${unmatched.map((value) => JSON.stringify(value)).join(', ')} ${unmatched.length === 1 ? 'is' : 'are'} not in the complete cached vocabulary.${suggestions.length > 0 ? ` Facet values are case-sensitive; ${suggestions.join(' ')}` : ''} The submitted filter was preserved.`,
      );
    }
    if (notices.length > 0) result.notices = notices;

    if (opts.accumulate && data.length > 0 && offset + data.length < total) {
      result.accumulated = await this.accumulatePages(
        normalizedRoute,
        params,
        { offset, total, first: data, firstPageMs },
        ctx,
        deadlineAt,
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
    deadlineAt: number,
  ): Promise<DataPage> {
    const pageParams = { ...params, offset: String(offset), length: String(length) };
    let resp: Partial<DataPage>;
    try {
      resp = await this.fetchJson<Partial<DataPage>>(`${route}/data/`, pageParams, ctx, deadlineAt);
    } catch (err) {
      if (err instanceof McpError) {
        if (err.code === JsonRpcErrorCode.NotFound) {
          throw routeNotFound(
            route,
            'Use eia_browse_routes or eia_search_routes to find a valid leaf route path.',
          );
        }
        // Only EIA's own 400s arrive here without a reason; a failure fetchJson
        // already classified (uri_too_long) passes through unchanged.
        if (err.code === JsonRpcErrorCode.ValidationError && err.data?.reason === undefined) {
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

    // A successful HTTP status does not establish a usable data envelope.
    if (!resp?.response) {
      throw serviceUnavailable(`EIA returned no data envelope for route "${route}".`, {
        reason: 'upstream_invalid_response',
        retryable: true,
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
   * count and the offset to resume from. The pages share the call's deadline,
   * and a page is never started when less of it remains than the slowest page
   * this call has fetched (the preview included) took, so staging stops with
   * the rows in hand instead of spending the rest of the call on a page the
   * deadline would abort. That stop, and a page that stalls past the deadline
   * anyway, set `timedOut`. A caller-side abort still propagates.
   */
  private async accumulatePages(
    route: string,
    params: Record<string, string | string[]>,
    seed: { offset: number; total: number; first: DataRow[]; firstPageMs: number },
    ctx: Context,
    deadlineAt: number,
  ): Promise<AccumulatedRows> {
    const cap = getServerConfig().canvasMaxRows;
    const rows = [...seed.first];
    let nextOffset = seed.offset + seed.first.length;
    let capped = false;
    let timedOut = false;
    let slowestPageMs = seed.firstPageMs;

    while (nextOffset < seed.total) {
      if (rows.length >= cap) {
        capped = true;
        break;
      }
      const startedAt = Date.now();
      if (deadlineAt - startedAt < slowestPageMs) {
        timedOut = true;
        ctx.log.warning('EIA canvas accumulation stopped before the call deadline', {
          route,
          nextOffset,
          staged: rows.length,
          remainingMs: deadlineAt - startedAt,
          slowestPageMs,
        });
        break;
      }
      const pageSize = Math.min(EIA_MAX_ROWS_PER_REQUEST, cap - rows.length);
      let pageRows: DataRow[];
      try {
        const page = await this.fetchDataPage(route, params, nextOffset, pageSize, ctx, deadlineAt);
        pageRows = page.response.data ?? [];
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        timedOut = err instanceof McpError && err.data?.reason === 'upstream_timeout';
        ctx.log.warning('EIA canvas accumulation stopped early', {
          route,
          nextOffset,
          staged: rows.length,
          error: errorMessage(err),
        });
        break;
      }
      slowestPageMs = Math.max(slowestPageMs, Date.now() - startedAt);
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
      timedOut,
    });

    return { cap, capped, rows, ...(timedOut && { timedOut: true as const }) };
  }

  /**
   * Resolve a legacy APIv1 series ID through `/v2/seriesid/{id}`, every
   * attempt held to `deadlineAt`. A 404 — or a 400 or 414, EIA refusing the ID
   * as written — is the miss, and `withRetry` never retries those. Any other
   * classified failure — a timeout, 5xx, rate limit, or unreachable host once
   * the retries are spent, or an answer missing the fields the result is built
   * from — is reported as failed, so the search falls back to text. A caller's
   * abort and an unclassified throw propagate.
   */
  private async lookupSeriesId(
    seriesId: string,
    ctx: Context,
    deadlineAt: number,
  ): Promise<SeriesIdLookup> {
    let raw: unknown;
    try {
      raw = await this.fetchJson<unknown>(`seriesid/${seriesId}`, { length: '1' }, ctx, deadlineAt);
    } catch (err) {
      if (ctx.signal.aborted || !(err instanceof McpError)) throw err;
      if (err.code === JsonRpcErrorCode.NotFound || err.code === JsonRpcErrorCode.ValidationError)
        return { outcome: 'unrecognized', seriesId };
      const reason = typeof err.data?.reason === 'string' ? err.data.reason : undefined;
      const retryable = defaultIsTransient(err);
      ctx.log.warning('EIA series ID lookup failed; answering from the text search', {
        seriesId,
        code: err.code,
        retryable,
        ...(reason && { reason }),
      });
      return { outcome: 'failed', seriesId, retryable, ...(reason && { reason }) };
    }

    const answer = SeriesIdResponseSchema.safeParse(raw);
    if (!answer.success) {
      ctx.log.warning('EIA series ID answer lacked its route, facets, or columns', {
        seriesId,
        issues: answer.error.issues.map((issue) => issue.path.join('.')),
      });
      return {
        outcome: 'failed',
        seriesId,
        retryable: true,
        reason: 'upstream_invalid_response',
      };
    }
    // EIA maps some IDs (AEO among them) to a query that matches no rows; the
    // lookup's own total says so before the caller spends a query on it.
    const total = answer.data.response?.total;
    const empty = total === 0 || total === '0';
    return {
      outcome: 'resolved',
      seriesId,
      entry: seriesIdEntry(seriesId, answer.data),
      ...(empty && { empty: true as const }),
    };
  }

  /**
   * Fuzzy search across the route index, answered once the corpus is as
   * complete as this process can make it within `SEARCH_WARM_BUDGET_MS`.
   * `status` travels with the results so a short or oddly-ranked answer is
   * never mistaken for a settled one, and `hasMore` says whether the results
   * are every match or the first `limit` of them.
   *
   * A query shaped like an APIv1 series ID is looked up first, under
   * `SERIES_ID_LOOKUP_BUDGET_MS`; a hit is the one result, at score 0, and
   * waits on no warm. Otherwise the warm wait gets what is left of
   * `SEARCH_WARM_BUDGET_MS` counted from entry, and `seriesId` reports why the
   * lookup did not answer.
   */
  async search(
    query: string,
    limit: number,
    ctx: Context,
  ): Promise<{
    /** True when at least one match ranks past `limit` — the results are a prefix. */
    hasMore: boolean;
    results: Array<{ entry: SearchResultEntry; score: number }>;
    /** Present when the query is shaped like a series ID: what its lookup came to. */
    seriesId?: SeriesIdLookup;
    status: IndexStatus;
  }> {
    const startedAt = Date.now();
    const id = parseSeriesId(query);
    const lookup =
      id === undefined
        ? undefined
        : await this.lookupSeriesId(id, ctx, startedAt + SERIES_ID_LOOKUP_BUDGET_MS);
    if (lookup?.outcome === 'resolved') {
      return {
        hasMore: false,
        results: [{ entry: lookup.entry, score: 0 }],
        seriesId: lookup,
        status: getIndexStatus(),
      };
    }

    await this.ensureIndexWarmed(ctx, SEARCH_WARM_BUDGET_MS - (Date.now() - startedAt));
    // One match of lookahead: `searchRoutes` scores and sorts every candidate
    // before it slices, so asking for one more costs nothing and is the only
    // way to tell a search that ended at `limit` from one that was cut there.
    const ranked = searchRoutes(query, limit + 1);
    return {
      hasMore: ranked.length > limit,
      results: ranked.slice(0, limit),
      ...(lookup && { seriesId: lookup }),
      status: getIndexStatus(),
    };
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

/** Abort the shared warm. Wired to `createApp`'s `teardown`, the one place it should stop. */
export function shutdownEiaApiService(): void {
  _service?.shutdown();
}

/** Reset for tests — aborts the outgoing service's warm so none outlives its test. */
export function _resetEiaApiService(): void {
  _service?.shutdown();
  _service = undefined;
  _routeMetaCache.clear();
}
