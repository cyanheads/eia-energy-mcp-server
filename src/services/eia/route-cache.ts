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
 *
 * Search runs two candidate gates over that one index. Fuse matches a query as a
 * single approximate contiguous run, which answers "does this entry read like
 * the query" and nothing else — a question no entry can answer for
 * "electricity price residential", because no route's text contains that run
 * however well it holds the data. `tokenizedScores` asks the other question,
 * scoring each query term against the corpus and combining, and an entry keeps
 * whichever gate scored it better. `scripts/eval-search.ts` measures both.
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
  /** The exact array `fuseIndex` was built over — a Fuse `refIndex` indexes it. */
  entries: SearchIndexEntry[];
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
  cache.entries = allEntries;
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
    entries: [],
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

/**
 * Terms below this length are dropped: `FUSE_OPTIONS.minMatchCharLength` already
 * refuses to match them, so scoring them only adds an always-unmatched term.
 */
const MIN_TERM_LENGTH = 2;

/** Ceiling on terms scored per query — each costs one full pass over the corpus. */
const MAX_QUERY_TERMS = 8;

/**
 * English function words, dropped before a query is weighted. They are the one
 * class of generic term document frequency cannot recognize: measured over this
 * corpus, `by` matches 151 of 2,103 entries and so reads as *rarer* than
 * `electricity` (812) — inverse document frequency would make the preposition
 * the heaviest term in "electricity generation by fuel type". Frequency is the
 * wrong question for a word that never carried topic in the first place.
 *
 * The list is grammatical, not domain vocabulary: generic *content* words
 * (`price`, `sector`, `type`, `data`) stay in and are down-weighted by the
 * corpus itself, which is what keeps the mechanism honest for terms nobody
 * anticipated. Nothing here is EIA-specific, and nothing here should be — a
 * domain word on this list would be a thumb on the scale.
 */
const FUNCTION_WORDS = new Set(
  `a an and are as at be by can do does for from has have how i in into is it its
   me my of on or per that the their them there these they this to was we were
   what when where which who why will with would you your`.split(/\s+/),
);

/**
 * Match quality credited to a query term no entry matched. It is the one free
 * parameter of the combine, and it is anchored rather than tuned: an entry that
 * matches half the query's weight perfectly and misses the other half scores
 * `1 - 1^0.5 · q^0.5`, so fixing that case at the midpoint of the scale (0.5)
 * fixes `q` at 0.25. Half the query answered lands at half the scale.
 */
const UNMATCHED_TERM_QUALITY = 0.25;

/**
 * Split a query into the terms scored independently. Repeats collapse so a word
 * said twice cannot buy twice its weight, and function words are dropped so they
 * can neither earn coverage nor cost it.
 */
function tokenizeQuery(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= MIN_TERM_LENGTH && !FUNCTION_WORDS.has(term));
  return [...new Set(terms)].slice(0, MAX_QUERY_TERMS);
}

/**
 * Share of a query's term weight an entry must match to be admitted.
 *
 * Two anchors fix the curve. At two terms each term is half the question, so an
 * entry carrying one and not the other has answered half — the bar sits midway
 * between one concept and both, at 0.75. As the query lengthens the allowance
 * relaxes toward, but never reaches, half the weight: past two terms a query
 * accumulates phrasing and near-synonyms the corpus has no reason to contain,
 * while an entry answering less of the query than it leaves open is not a
 * candidate at any length.
 *
 * Measured against the live 2,103-entry corpus, the widest share any off-target
 * query in `scripts/search-battery.ts` reached was 0.423 — the curve clears that
 * at every length.
 */
function coverageBar(termCount: number): number {
  return 0.5 + 0.25 / (termCount - 1);
}

/**
 * Terms an entry must match outright, whatever their weight: half the query, and
 * never fewer than two. A weight bar alone cannot express "both concepts are
 * present", because one rare word routinely carries four fifths of a two-term
 * query's weight — matching it and nothing else clears any bar below ~0.85. A
 * multi-term query asks after a conjunction of concepts, and an entry carrying
 * one of them has answered a different, simpler question. On a long query the
 * weight bar is the binding constraint and this floor costs nothing.
 */
function minMatchedTerms(termCount: number): number {
  return Math.max(2, Math.ceil(termCount / 2));
}

/**
 * Length at or below which a query term must appear verbatim before the term
 * path counts an entry as matching it. `FUSE_OPTIONS.threshold` admits a
 * one-edit match on any pattern this short, and a token this short has a large
 * one-edit neighbourhood: measured over the live 2,103-entry corpus, `cat`
 * fuzzy-matches 856 entries against the 17 that carry it, and `food` reaches
 * `Wood`. Such a match satisfies the matched-term floor while carrying none of
 * the concept, which is how an unanswerable two-term query reaches a confident
 * score.
 *
 * Longer terms keep their fuzziness, because there it earns its keep — it is
 * what lets a plural query reach a singular description. Requiring every term
 * verbatim scores better on the battery and is the wrong trade: it drops
 * `electricity prices residential` from 0.10 on `electricity/retail-sales` to
 * 0.88 on an unrelated STEO series.
 */
const VERBATIM_TERM_LENGTH = 4;

/** True when an entry's searchable text carries the term as written. */
function carriesTerm(entry: SearchIndexEntry, term: string): boolean {
  return (
    entry.name.toLowerCase().includes(term) ||
    entry.description.toLowerCase().includes(term) ||
    entry.route.toLowerCase().includes(term) ||
    (entry.category?.toLowerCase().includes(term) ?? false)
  );
}

/**
 * Score every entry that matched at least one query term, by term rather than
 * by phrase. Fuse matches a query as one approximate contiguous run, so a route
 * holding the answer to a commodity + metric + sector question is never a
 * candidate for the whole string — the run does not exist in its text. Scoring
 * each term separately and combining is what lets "matches most of your terms"
 * outrank "happens to contain one of your words".
 *
 * Four things make the combine hold its ground:
 *
 * - **Term weight is inverse document frequency, over function-word-free terms.**
 *   A content word matching a large slice of the corpus (`sector`, `state`,
 *   `prices` in an energy taxonomy) carries almost no weight; one matching a
 *   handful carries a lot. Nothing domain-specific is hand-listed — the corpus
 *   decides which words are generic, so the mechanism travels to vocabulary
 *   nobody anticipated. A term matching *nothing* carries the most weight of all
 *   and is always unmatched, which is what makes a query naming something absent
 *   fail the bar rather than score on the words it shares with the corpus.
 * - **Admission is on matched weight, floored by matched term count.** Matching
 *   `sector` and `state` while missing `residential` buys almost no coverage,
 *   and the floor stops one heavy term from carrying a short query alone.
 * - **The combine is a weighted geometric mean.** Each missing term multiplies
 *   the result down by its own share of the weight, so misses compound rather
 *   than averaging out against the terms that did match.
 * - **A short term must be carried verbatim.** Fuzzy matching on a token of
 *   `VERBATIM_TERM_LENGTH` or fewer characters reaches a large slice of the
 *   corpus on one edit, which clears both admission rules without carrying the
 *   concept.
 */
function tokenizedScores(cache: CacheState, terms: string[]): Map<number, number> {
  const corpusSize = cache.entries.length;
  const perTerm = terms.map((term) => {
    const requireVerbatim = term.length <= VERBATIM_TERM_LENGTH;
    const hits = new Map<number, number>();
    for (const result of cache.fuseIndex.search(term)) {
      if (requireVerbatim && !carriesTerm(cache.entries[result.refIndex] as SearchIndexEntry, term))
        continue;
      hits.set(result.refIndex, result.score ?? 1);
    }
    return { hits, weight: Math.log((corpusSize + 1) / (hits.size + 1)) };
  });

  const totalWeight = perTerm.reduce((sum, term) => sum + term.weight, 0);
  // Every term matched every entry — the query carries no discriminating signal.
  if (totalWeight === 0) return new Map();

  const bar = coverageBar(terms.length);
  const minMatched = minMatchedTerms(terms.length);
  const scores = new Map<number, number>();
  const candidates = new Set<number>();
  for (const { hits } of perTerm) {
    for (const ref of hits.keys()) candidates.add(ref);
  }

  for (const ref of candidates) {
    let matched = 0;
    let matchedWeight = 0;
    let quality = 1;
    for (const { hits, weight } of perTerm) {
      const termScore = hits.get(ref);
      const share = weight / totalWeight;
      if (termScore === undefined) {
        quality *= UNMATCHED_TERM_QUALITY ** share;
      } else {
        matched++;
        matchedWeight += weight;
        quality *= (1 - termScore) ** share;
      }
    }
    if (matched >= minMatched && matchedWeight / totalWeight >= bar) {
      scores.set(ref, 1 - quality);
    }
  }
  return scores;
}

/**
 * Fuzzy search across the index. Returns ranked matches, best first.
 *
 * A multi-term query is scored twice — once as a phrase by Fuse, once term by
 * term through the gate above — and each entry keeps its better score. The two
 * paths admit different candidates and neither can cost the other anything: the
 * phrase path answers "this entry reads like your query", the term path answers
 * "this entry covers your query's concepts", and a query only needs one to be
 * true. A single-term query has nothing to tokenize, so it takes the phrase path
 * alone and scores exactly as Fuse scores it.
 *
 * `mode` is what `scripts/eval-search.ts` measures the gate's contribution
 * against: `'phrase'` is the un-tokenized behavior on its own.
 */
export function searchRoutes(
  query: string,
  limit: number,
  mode: 'combined' | 'phrase' = 'combined',
): Array<{ entry: SearchIndexEntry; score: number }> {
  const cache = _cache;
  if (!cache) return [];

  const scores = new Map<number, number>();
  for (const result of cache.fuseIndex.search(query)) {
    scores.set(result.refIndex, result.score ?? 1);
  }

  if (mode === 'combined') {
    const terms = tokenizeQuery(query);
    if (terms.length > 1) {
      for (const [ref, score] of tokenizedScores(cache, terms)) {
        if (score < (scores.get(ref) ?? Number.POSITIVE_INFINITY)) scores.set(ref, score);
      }
    }
  }

  // Ties break on index position, which keeps route entries ahead of the STEO
  // and facet-value entries appended after them — the order `reindex` produced.
  return [...scores]
    .sort(([refA, scoreA], [refB, scoreB]) => scoreA - scoreB || refA - refB)
    .slice(0, limit)
    .map(([ref, score]) => ({ entry: cache.entries[ref] as SearchIndexEntry, score }));
}

/** Total number of indexed entries. */
export function getIndexSize(): number {
  return _cache?.entries.length ?? 0;
}

/**
 * The indexed corpus itself, in `refIndex` order. `scripts/eval-search.ts`
 * snapshots it so a scoring change can be measured twice against one corpus
 * rather than against two warms of a taxonomy that moved in between.
 */
export function getIndexEntries(): readonly SearchIndexEntry[] {
  return _cache?.entries ?? [];
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
