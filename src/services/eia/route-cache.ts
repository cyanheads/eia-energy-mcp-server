/**
 * @fileoverview In-process route tree cache and Fuse.js fuzzy search index.
 * The route tree is fetched lazily on first use and held for the process
 * lifetime — EIA's taxonomy is stable between API releases and restarting the
 * server is the appropriate refresh mechanism. The Fuse.js index is built once
 * after the tree is populated, then grown with two further entry classes that
 * both carry a `filter_hint`: STEO series names, and facet values (fuel types,
 * sectors, coal ranks) so natural-language queries naming a value resolve to
 * the route that exposes it.
 * @module services/eia/route-cache
 */

import Fuse, { type IFuseOptions } from 'fuse.js';
import type { Facet, RawRouteNode, SearchIndexEntry } from './types.js';

/** Holds the in-process route tree state. */
interface CacheState {
  /** All index entries, in insertion order, for the total_indexed count. */
  entries: SearchIndexEntry[];
  /** Fuse.js index built over routes + STEO series + facet values. */
  fuseIndex: Fuse<SearchIndexEntry>;
  /** Identity of every indexed entry, so repeat appends are no-ops. */
  indexedKeys: Set<string>;
  /** Flat map of route path → raw node (all nodes in the tree). */
  nodeMap: Map<string, RawRouteNode>;
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
 */
export function isLeafNode(node: RawRouteNode): boolean {
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

/** Initialize the cache with the fetched route tree and optional STEO entries. */
export function initRouteCache(
  topLevelNodes: RawRouteNode[],
  steoSeriesEntries: SearchIndexEntry[],
): void {
  const nodeMap = new Map<string, RawRouteNode>();
  buildNodeMap(topLevelNodes, '', nodeMap);

  const routeEntries = buildEntries(nodeMap);
  const allEntries = [...routeEntries, ...steoSeriesEntries];

  _cache = {
    nodeMap,
    fuseIndex: new Fuse(allEntries, FUSE_OPTIONS),
    entries: allEntries,
    indexedKeys: new Set(allEntries.map(entryKey)),
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
  return _cache?.entries.length ?? 0;
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
  for (const entry of fresh) _cache.indexedKeys.add(entryKey(entry));
  _cache.entries.push(...fresh);
  _cache.fuseIndex = new Fuse(_cache.entries, FUSE_OPTIONS);
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
