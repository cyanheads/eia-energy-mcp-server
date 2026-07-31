/**
 * @fileoverview In-process route tree cache and Fuse.js fuzzy search index.
 * The route tree is fetched lazily on first use and held for the process
 * lifetime — EIA's taxonomy is stable between API releases and restarting the
 * server is the appropriate refresh mechanism. The Fuse.js index is built once
 * after the tree is populated, then grown with two further entry classes that
 * both carry a `filter_hint`: STEO series names, and facet values (fuel types,
 * sectors, coal ranks) so natural-language queries naming a value resolve to
 * the route that exposes it.
 *
 * Completeness is tracked, not assumed. A node whose warm-time metadata fetch
 * failed is held as an incomplete stub — never classified as a leaf, listed by
 * `getIndexStatus()`, and replaced in place by `replaceNode()` once it is
 * re-fetched. `getIndexStatus().complete` is what lets a caller tell a ranking
 * computed over the whole corpus from one computed over part of it.
 * @module services/eia/route-cache
 */

import Fuse, { type IFuseOptions } from 'fuse.js';
import type { Facet, RawRouteNode, SearchIndexEntry } from './types.js';

/** An index-widening pass that runs after the route tree is built. */
export type IndexPass = 'facet_values' | 'steo_series';

/** Every pass that must land before the corpus counts as complete. */
const INDEX_PASSES: readonly IndexPass[] = ['facet_values', 'steo_series'];

/** Warm-time completeness of the search corpus. */
export interface IndexStatus {
  /** True when the tree built in full and every index-widening pass landed in full. */
  complete: boolean;
  /** Route paths whose metadata fetch failed — their subtrees are absent from the corpus. */
  incompleteRoutes: string[];
  /** Passes that have not landed in full, either still running or given up on. */
  pendingPasses: IndexPass[];
  /** Entries currently in the index. */
  size: number;
}

/** Holds the in-process route tree state. */
interface CacheState {
  /** Entries appended after the tree — STEO series and facet values. */
  appendedEntries: SearchIndexEntry[];
  /** Fuse.js index built over routes + STEO series + facet values. */
  fuseIndex: Fuse<SearchIndexEntry>;
  /** Route paths whose warm-time metadata fetch failed — subtrees unknown. */
  incompleteRoutes: Set<string>;
  /** Identity of every indexed entry, so repeat appends are no-ops. */
  indexedKeys: Set<string>;
  /** Flat map of route path → raw node (all nodes in the tree). */
  nodeMap: Map<string, RawRouteNode>;
  /** Entries derived from the route tree, rebuilt whenever the tree changes. */
  routeEntries: SearchIndexEntry[];
  /** Index-widening passes that have landed in full. */
  settledPasses: Set<IndexPass>;
}

let _cache: CacheState | undefined;

/**
 * Facet IDs whose values are fetched at warm time and indexed for search.
 * EIA names the same dimension inconsistently across routes (`fueltypeid`,
 * `fuelTypeId`, `fuelType`, `energy_source_code`), so IDs are compared with
 * punctuation and case stripped.
 *
 * The list is deliberately short: it covers the fuel / sector / technology
 * vocabulary callers search with, and excludes the four facets that dominate
 * the taxonomy by volume (`duoarea`, `product`, `process`, `series` appear on
 * 165 leaf routes each). Measured against the live taxonomy, it resolves to 40
 * facet fetches carrying 460 values and 28 KB — against 892 facets in total.
 */
const VOCABULARY_FACET_IDS = new Set([
  'coalrankid',
  'coaltype',
  'energysourcecode',
  'energysourceid',
  'fuel2002',
  'fuelid',
  'fueltype',
  'fueltypeid',
  'primemover',
  'primemovercode',
  'producertypeid',
  'productid',
  'rank',
  'sector',
  'sectorid',
  'technology',
]);

/**
 * Upper bound on the values a single facet contributes to the index. Facets
 * above it are opaque-identifier dimensions (mine IDs, plant codes, `duoarea`
 * area codes) that nobody searches by name, and indexing them would swamp the
 * corpus. STEO's 1,469-value `seriesId` is above the bound and reaches the
 * index through its own dedicated pass instead.
 */
const MAX_INDEXED_FACET_VALUES = 200;

/** Strip case and punctuation so EIA's inconsistent facet IDs compare equal. */
function normalizeFacetId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Identity of an index entry. Entries carrying a `filter_hint` are identified
 * by route + hint, so the same facet value indexed twice (warm-time pass and a
 * later `eia_describe_route`) collapses to one entry.
 */
function entryKey(entry: SearchIndexEntry): string {
  const hint = entry.filter_hint
    ? Object.entries(entry.filter_hint)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&')
    : entry.name;
  return `${entry.route}\u0000${hint}`;
}

/**
 * Normalize a description string from the EIA API. EIA descriptions often
 * contain embedded `\r\n` + leading whitespace (source-level line wrapping).
 * Collapse to a clean single-line string.
 */
export function normalizeDescription(desc: string | undefined): string {
  if (!desc) return '';
  return desc
    .replace(/\r/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Walk the raw route tree and collect all nodes into a flat path→node map. */
export function buildNodeMap(
  nodes: RawRouteNode[],
  parentPath: string,
  map: Map<string, RawRouteNode>,
): void {
  for (const node of nodes) {
    const path = parentPath ? `${parentPath}/${node.id}` : node.id;
    // Normalize description in place so all tools that read from cache get clean strings
    const normalized: RawRouteNode =
      node.description !== undefined
        ? { ...node, description: normalizeDescription(node.description) }
        : node;
    map.set(path, normalized);
    if (normalized.routes?.length) {
      buildNodeMap(normalized.routes, path, map);
    }
  }
}

/**
 * Classify a raw node as a leaf. A node is a leaf when it has `frequency`,
 * `facets`, or `data` fields (queryable data endpoint) rather than a `routes`
 * array. Root-level nodes with no sub-routes and no data fields are treated as
 * leaves (e.g. steo).
 *
 * An incomplete node is never a leaf. It carries none of the leaf markers only
 * because its metadata never arrived, and the bare-stub rule at the bottom of
 * this function would otherwise read that absence as a queryable endpoint.
 */
export function isLeafNode(node: RawRouteNode): boolean {
  if (node.incomplete) return false;
  if (node.frequency !== undefined) return true;
  if (node.facets !== undefined) return true;
  if (node.data !== undefined) return true;
  // A node with no routes array and no data/frequency is still a leaf candidate
  return !node.routes?.length;
}

/** Build search index entries from a flat node map. */
function buildEntries(nodeMap: Map<string, RawRouteNode>): SearchIndexEntry[] {
  const entries: SearchIndexEntry[] = [];
  for (const [route, node] of nodeMap) {
    const parts = route.split('/');
    const category: string | undefined = parts.length > 1 ? parts[0] : undefined;
    entries.push({
      route,
      name: node.name,
      description: node.description ?? '',
      isLeaf: isLeafNode(node),
      category,
    });
  }
  return entries;
}

/**
 * Every entry class — routes, STEO series, facet values — shares these keys.
 * Fuse normalizes key weights against each other, so the weights and the
 * search options are corpus-wide: changing either moves the score of every
 * entry at once and invalidates `WEAK_MATCH_SCORE`. Appending entries under an
 * unchanged config does not — Fuse scores each entry independently of corpus
 * size, which is what lets facet values join the index without recalibration.
 */
const FUSE_OPTIONS: IFuseOptions<SearchIndexEntry> = {
  keys: [
    { name: 'name', weight: 2 },
    { name: 'description', weight: 1.5 },
    { name: 'route', weight: 1 },
    { name: 'category', weight: 0.5 },
  ],
  threshold: 0.4,
  includeScore: true,
  minMatchCharLength: 2,
};

/** Route paths in the map whose metadata fetch failed during the warm. */
function collectIncompleteRoutes(nodeMap: Map<string, RawRouteNode>): Set<string> {
  const paths = new Set<string>();
  for (const [path, node] of nodeMap) {
    if (node.incomplete) paths.add(path);
  }
  return paths;
}

/**
 * Rebuild the Fuse index over the current entry set. Route entries always lead
 * the appended ones, so the class order — and with it Fuse's tie-breaking
 * between an entry class and the next — is the one `initRouteCache` produced.
 * Within the route entries, a subtree `replaceNode` re-inserted sorts last,
 * which moves nothing but the order of an exact score tie.
 */
function reindex(cache: CacheState): void {
  const allEntries = [...cache.routeEntries, ...cache.appendedEntries];
  cache.fuseIndex = new Fuse(allEntries, FUSE_OPTIONS);
  cache.indexedKeys = new Set(allEntries.map(entryKey));
}

/** Initialize the cache with the fetched route tree and optional STEO entries. */
export function initRouteCache(
  topLevelNodes: RawRouteNode[],
  steoSeriesEntries: SearchIndexEntry[],
): void {
  const nodeMap = new Map<string, RawRouteNode>();
  buildNodeMap(topLevelNodes, '', nodeMap);

  const cache: CacheState = {
    appendedEntries: [...steoSeriesEntries],
    fuseIndex: new Fuse<SearchIndexEntry>([], FUSE_OPTIONS),
    incompleteRoutes: collectIncompleteRoutes(nodeMap),
    indexedKeys: new Set(),
    nodeMap,
    routeEntries: buildEntries(nodeMap),
    settledPasses: new Set(),
  };
  reindex(cache);
  _cache = cache;
}

/**
 * Splice a re-fetched node and its subtree into the cached tree, replacing the
 * stub a failed warm-time fetch left behind. Route entries are rebuilt from the
 * updated map so the stub's stale `isLeaf` claim does not survive; the appended
 * STEO and facet entries are untouched.
 */
export function replaceNode(path: string, node: RawRouteNode): void {
  if (!_cache) return;

  const prefix = `${path}/`;
  for (const key of _cache.nodeMap.keys()) {
    if (key === path || key.startsWith(prefix)) _cache.nodeMap.delete(key);
  }
  const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  buildNodeMap([node], parentPath, _cache.nodeMap);

  _cache.routeEntries = buildEntries(_cache.nodeMap);
  _cache.incompleteRoutes = collectIncompleteRoutes(_cache.nodeMap);
  reindex(_cache);
}

/** Record that an index-widening pass landed in full. */
export function markIndexPassSettled(pass: IndexPass): void {
  _cache?.settledPasses.add(pass);
}

/**
 * What the corpus is missing, if anything. `complete` is the single signal a
 * caller needs: false means a route subtree or a whole vocabulary pass is
 * absent, so a result set may be short or ranked against the wrong corpus.
 */
export function getIndexStatus(): IndexStatus {
  const cache = _cache;
  if (!cache) {
    return {
      complete: false,
      incompleteRoutes: [],
      pendingPasses: [...INDEX_PASSES],
      size: 0,
    };
  }
  const incompleteRoutes = [...cache.incompleteRoutes].sort();
  const pendingPasses = INDEX_PASSES.filter((pass) => !cache.settledPasses.has(pass));
  return {
    complete: incompleteRoutes.length === 0 && pendingPasses.length === 0,
    incompleteRoutes,
    pendingPasses,
    size: getIndexSize(),
  };
}

/** Return the cache, throwing if not yet initialized. */
export function getRouteCache(): CacheState {
  if (!_cache) throw new Error('Route cache not initialized');
  return _cache;
}

/** True when the cache has been populated. */
export function isRouteCacheReady(): boolean {
  return _cache !== undefined;
}

/** Reset the cache (used in tests). */
export function _resetRouteCache(): void {
  _cache = undefined;
}

/** Get a node by route path. Returns undefined when not found. */
export function getNode(path: string): RawRouteNode | undefined {
  if (!_cache) return;
  if (!path) {
    // Root — return a synthetic node with top-level children
    return;
  }
  return _cache.nodeMap.get(path);
}

/**
 * Get children of a given path. For root (empty path), returns top-level nodes.
 * Returns empty array when path has no children.
 */
export function getChildren(
  path: string,
): Array<{ id: string; route: string; node: RawRouteNode }> {
  if (!_cache) return [];
  const children: Array<{ id: string; route: string; node: RawRouteNode }> = [];

  if (!path) {
    // Root: find all nodes whose route has no '/' separator
    for (const [route, node] of _cache.nodeMap) {
      if (!route.includes('/')) {
        children.push({ id: node.id, route, node });
      }
    }
  } else {
    // Find all nodes whose route is exactly `${path}/${id}`
    const prefix = `${path}/`;
    for (const [route, node] of _cache.nodeMap) {
      if (route.startsWith(prefix) && !route.slice(prefix.length).includes('/')) {
        const id = route.slice(prefix.length);
        children.push({ id, route, node });
      }
    }
  }

  return children;
}

/** Fuzzy search across the index. Returns ranked matches. */
export function searchRoutes(
  query: string,
  limit: number,
): Array<{ entry: SearchIndexEntry; score: number }> {
  if (!_cache) return [];
  const results = _cache.fuseIndex.search(query, { limit });
  return results.map((r) => ({
    entry: r.item,
    score: r.score ?? 1,
  }));
}

/** Total number of indexed entries. */
export function getIndexSize(): number {
  if (!_cache) return 0;
  return _cache.routeEntries.length + _cache.appendedEntries.length;
}

/**
 * Append entries to an already-initialized cache, skipping any already indexed.
 * Returns how many were added; the Fuse index is rebuilt only when that is
 * non-zero. Used by both post-warm entry classes — STEO series and facet
 * values — which arrive after `initRouteCache` and can overlap each other.
 */
export function addEntriesToIndex(entries: SearchIndexEntry[]): number {
  if (!_cache) return 0;
  const fresh = entries.filter((e) => !_cache?.indexedKeys.has(entryKey(e)));
  if (fresh.length === 0) return 0;
  _cache.appendedEntries.push(...fresh);
  reindex(_cache);
  return fresh.length;
}

/**
 * Leaf routes paired with the vocabulary facet IDs worth fetching at warm time.
 * Read straight from the cached tree, which already carries every leaf's facet
 * IDs — so the selection itself costs nothing.
 */
export function listVocabularyFacets(): Array<{
  route: string;
  facetId: string;
  description: string;
}> {
  if (!_cache) return [];
  const targets: Array<{ route: string; facetId: string; description: string }> = [];
  for (const [route, node] of _cache.nodeMap) {
    for (const facet of node.facets ?? []) {
      if (VOCABULARY_FACET_IDS.has(normalizeFacetId(facet.id))) {
        targets.push({ route, facetId: facet.id, description: facet.description });
      }
    }
  }
  return targets;
}

/**
 * Index a described route's facet values, each pointing back at the route with
 * a ready-to-use `filter_hint`. Facets above `MAX_INDEXED_FACET_VALUES` are
 * skipped. Returns how many entries were added.
 */
export function indexFacetValues(route: string, facets: Facet[]): number {
  if (!_cache) return 0;
  const node = _cache.nodeMap.get(route);
  const routeName = node?.name ?? route;
  const parts = route.split('/');
  const category = parts.length > 1 ? parts[0] : undefined;

  const entries: SearchIndexEntry[] = [];
  for (const facet of facets) {
    if (facet.values.length === 0 || facet.values.length > MAX_INDEXED_FACET_VALUES) continue;
    const dimension = facet.description || facet.id;
    for (const value of facet.values) {
      entries.push({
        route,
        name: value.name,
        description: `${dimension} value of ${routeName} (${route}) — filter with ${facet.id}="${value.id}".`,
        isLeaf: true,
        category,
        filter_hint: { [facet.id]: value.id },
      });
    }
  }
  return addEntriesToIndex(entries);
}
