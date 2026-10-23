/**
 * @fileoverview In-process route tree cache and Fuse.js fuzzy search index.
 * The route tree is fetched lazily on first use and held for the process
 * lifetime — EIA's taxonomy is stable between API releases and restarting the
 * server is the appropriate refresh mechanism. The Fuse.js index is built once
 * after the tree is populated, then grown with two further entry classes that
 * both carry a `filter_hint`: named series (`NAMED_SERIES_FACETS` — STEO and
 * SEDS series names), and facet values (fuel types, sectors, coal ranks, RTO
 * respondents, and the `series` and `product` values of the daily and weekly
 * petroleum and natural-gas routes) so natural-language queries naming a value
 * — "wind", "Henry Hub", "Electric Reliability Council of Texas" — resolve to
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
 * whichever gate scored it better. `scripts/eval-search.ts` measures both. A
 * query that spells the end of a route's path (`retail sales` for
 * `electricity/retail-sales`) is an exact match for that route entry, since the
 * slug can carry words its name and description do not.
 * @module services/eia/route-cache
 */

import Fuse, { type IFuseOptions } from 'fuse.js';
import type { Facet, RawFrequency, RawRouteNode, SearchIndexEntry } from './types.js';

/**
 * Facets whose values are named series — descriptive phrases a caller searches
 * by ("Motor gasoline total consumption"), not opaque codes — and are indexed
 * whole although they run past `MAX_INDEXED_FACET_VALUES`. Each is fetched with
 * one `/facet/{facetId}` request by an index pass of its own, keyed here by that
 * pass's name, so a vocabulary that failed to land is named on its own in
 * `getIndexStatus().pendingPasses`.
 */
export const NAMED_SERIES_FACETS = {
  steo_series: { route: 'steo', facetId: 'seriesId', label: 'STEO' },
  seds_series: { route: 'seds', facetId: 'seriesId', label: 'SEDS' },
} as const;

/** An index pass that fetches one named-series facet. */
export type NamedSeriesPass = keyof typeof NAMED_SERIES_FACETS;

/** An index-widening pass that runs after the route tree is built. */
export type IndexPass = 'facet_values' | NamedSeriesPass;

/** Every pass that must land before the corpus counts as complete. */
const INDEX_PASSES: readonly IndexPass[] = [
  'facet_values',
  ...(Object.keys(NAMED_SERIES_FACETS) as NamedSeriesPass[]),
];

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
  /** Entries appended after the tree — named series and facet values. */
  appendedEntries: SearchIndexEntry[];
  /** The exact array `fuseIndex` was built over — a Fuse `refIndex` indexes it. */
  entries: SearchIndexEntry[];
  /** Fuse.js index built over routes + named series + facet values. */
  fuseIndex: Fuse<SearchIndexEntry>;
  /** Route paths whose warm-time metadata fetch failed — subtrees unknown. */
  incompleteRoutes: Set<string>;
  /** Identity of every indexed entry, so repeat appends are no-ops. */
  indexedKeys: Set<string>;
  /** Flat map of route path → raw node (all nodes in the tree). */
  nodeMap: Map<string, RawRouteNode>;
  /**
   * Rankings `searchRoutes` computed against the current `fuseIndex`, keyed by
   * mode, limit, and query, least recently used first; emptied by every
   * `reindex`. Each packs its results as `[refIndex, score, …]`.
   */
  resultMemo: Map<string, Float64Array>;
  /** What `resultMemo` retains, as `memoBytes` charges it. */
  resultMemoBytes: number;
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
 * vocabulary callers search with. It excludes the four facets that dominate the
 * taxonomy by volume (`duoarea`, `product`, `process`, `series` appear on 165
 * leaf routes each); `SUB_MONTHLY_FACET_IDS` takes `series` and `product` back,
 * with `respondent`, on the few routes that publish sub-monthly data. Measured
 * against the live taxonomy, this list resolves to 40 facet fetches — against
 * 892 facets in total.
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
 * Facets fetched at warm time only on leaves whose metadata lists one of
 * `SUB_MONTHLY_FREQUENCIES` — the market and grid-operations routes, where these
 * facets name what callers ask for first. On the 16 daily and weekly petroleum
 * and natural-gas leaves (of the 165 carrying `series` and `product`), `series`
 * names the benchmark ("Cushing, OK WTI Spot Price FOB") and `product` the
 * commodity ("WTI Crude Oil"); on the four hourly and daily `electricity/rto`
 * leaves, `respondent` names the balancing authority ("Electric Reliability
 * Council of Texas"). On monthly and annual survey routes the same facets list
 * thousands of series, or reporting plants: the one other leaf carrying
 * `respondent`, the annual `densified-biomass/wood-pellet-plants`, lists 161
 * plant names that only add off-target matches ("cat food" reaching "Vulcan
 * Wood Products"). Measured live, the selection is 36 requests for 1,753
 * `series`, 209 `product`, and 332 `respondent` values; `series` and `product`
 * on all 165 leaves would cost 330 requests, nearly doubling the warm.
 */
const SUB_MONTHLY_FACET_IDS = new Set(['product', 'respondent', 'series']);

/** Frequency IDs that mark a leaf as publishing sub-monthly data. */
const SUB_MONTHLY_FREQUENCIES = new Set(['daily', 'hourly', 'local-hourly', 'weekly']);

/**
 * Warm-time facets indexed whole past `MAX_INDEXED_FACET_VALUES`. A `series`
 * value is a descriptive name, like the `NAMED_SERIES_FACETS` values, and three
 * benchmark leaves run past the bound: `petroleum/sum/sndw` (608 values),
 * `petroleum/pri/gnd` (311), and `petroleum/stoc/wstk` (205, where the Cushing
 * stocks series lives). Describe-time indexing keeps the bound, since a
 * described monthly route's `series` facet can run to thousands of values
 * (`petroleum/move/impcus`: 5,124).
 */
const WHOLE_WARM_FACET_IDS = new Set(['series']);

/**
 * Upper bound on the values a single facet contributes to the index. Facets
 * above it are opaque-identifier dimensions (mine IDs, plant codes, `duoarea`
 * area codes) that nobody searches by name, and indexing them would swamp the
 * corpus. Two exceptions reach the index whole: the `NAMED_SERIES_FACETS`
 * allowlist (STEO's and SEDS's `seriesId`, each through its own pass), and the
 * warm-time `series` targets in `WHOLE_WARM_FACET_IDS`.
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

/**
 * A node's frequencies as a list. EIA returns `frequency` as an array on every
 * route in the standard taxonomy, but the field is not contractually an array:
 * an object map is flattened to its values, and anything else reads as none.
 */
export function frequenciesOf(node: RawRouteNode): RawFrequency[] {
  const raw = node.frequency;
  if (Array.isArray(raw)) return raw;
  return raw && typeof raw === 'object' ? Object.values(raw) : [];
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
 * Every entry class — routes, named series, facet values — shares these keys.
 * Fuse normalizes key weights against each other, so the weights and the
 * search options are corpus-wide: changing either moves the score of every
 * entry at once and invalidates `WEAK_MATCH_SCORE`. Appending entries under an
 * unchanged config does not — Fuse scores each entry independently of corpus
 * size, which is what lets facet values join the index without recalibration.
 * `includeMatches` moves no score: it reports which keys a match landed in,
 * which `tokenizedScores` reads to count a term a facet value inherits from its
 * route once per route.
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
  includeMatches: true,
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
 * Rebuild the Fuse index over the current entry set, route entries first. No
 * ranking reads this order — `searchRoutes` breaks score ties on entry identity
 * (`compareRanked`) — so a subtree `replaceNode` re-inserted last, or facet
 * values appended in whatever order their fetches landed, move nothing.
 */
function reindex(cache: CacheState): void {
  const allEntries = [...cache.routeEntries, ...cache.appendedEntries];
  cache.entries = allEntries;
  cache.fuseIndex = new Fuse(allEntries, FUSE_OPTIONS);
  cache.indexedKeys = new Set(allEntries.map(entryKey));
  cache.resultMemo = new Map();
  cache.resultMemoBytes = 0;
}

/**
 * Initialize the cache with the fetched route tree and entries to append after
 * it — `scripts/eval-search.ts` replays a snapshot corpus through the second.
 */
export function initRouteCache(
  topLevelNodes: RawRouteNode[],
  appendedEntries: SearchIndexEntry[],
): void {
  const nodeMap = new Map<string, RawRouteNode>();
  buildNodeMap(topLevelNodes, '', nodeMap);

  const cache: CacheState = {
    appendedEntries: [...appendedEntries],
    entries: [],
    fuseIndex: new Fuse<SearchIndexEntry>([], FUSE_OPTIONS),
    incompleteRoutes: collectIncompleteRoutes(nodeMap),
    indexedKeys: new Set(),
    nodeMap,
    resultMemo: new Map(),
    resultMemoBytes: 0,
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
 * named-series and facet entries are untouched.
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

/** True when the cache has been populated. */
export function isRouteCacheReady(): boolean {
  return _cache !== undefined;
}

/** Reset the cache (used in tests). */
export function _resetRouteCache(): void {
  _cache = undefined;
}

/**
 * Get a node by route path. Returns undefined when not found, and for the root
 * (empty path), which is no node — `getChildren('')` lists its top level.
 */
export function getNode(path: string): RawRouteNode | undefined {
  if (!_cache || !path) return;
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
 * class of generic term document frequency cannot recognize: measured over the
 * 5,459-entry corpus, `by` is found in 326 documents and so reads as *rarer*
 * than `electricity` (689) — inverse document frequency would make the
 * preposition the heaviest term in "electricity generation by fuel type". Frequency is the
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
 * Measured against the 3,165-entry corpus the warm built before benchmark
 * vocabulary was indexed, the widest share any off-target query in
 * `scripts/search-battery.ts` reached past the matched-term floor was
 * 0.403 — the curve clears that at every length. The bar is not the only guard:
 * on the 5,459-entry corpus, with weekly petroleum series names indexed,
 * `airline ticket prices` fuzzy-matches every term of a propane price series
 * (`ticket` inside `Connecticut`), clears the bar at full share, and is flagged
 * by its score instead (0.858, above `WEAK_MATCH_SCORE`).
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
 * one-edit neighbourhood: measured over the live 5,459-entry corpus, `cat`
 * fuzzy-matches 1,834 entries against the 49 that carry it, and `food` reaches
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
 *   A document is an entry, except where a `filter_hint` entry matches only
 *   outside its own name: its description, route, and category carry text every
 *   entry on its route shares (the route's title and path, or a series label),
 *   so all such matches on one route count as one document. Counted per entry, the series and products of the routes titled
 *   "Weekly …" made `weekly` look nearly as common as `oil` (1,924 entries
 *   against 2,858; 37 documents), and "weekly crude oil stocks" dropped the
 *   route titled "Weekly Stocks" below the bar.
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
    const documents = new Set<string>();
    for (const result of cache.fuseIndex.search(term)) {
      const entry = cache.entries[result.refIndex] as SearchIndexEntry;
      if (requireVerbatim && !carriesTerm(entry, term)) continue;
      hits.set(result.refIndex, result.score ?? 1);
      const inherited =
        entry.filter_hint !== undefined && !result.matches?.some((m) => m.key === 'name');
      documents.add(inherited ? `route\u0000${entry.route}` : `entry\u0000${result.refIndex}`);
    }
    return { hits, weight: Math.log((corpusSize + 1) / (documents.size + 1)) };
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
 * Route entries whose path ends in the run of segments the query spells — the
 * words of `retail-sales` for `electricity/retail-sales`, or of
 * `state-electricity-profiles/source-disposition` for the leaf below it.
 *
 * A path segment is the route's identifier, and on some routes it is the only
 * text carrying the words a caller searches by: `electricity/retail-sales` is
 * named "Electricity Sales to Ultimate Customers". Fuse sees the slug only as
 * part of one long `route` string, so a STEO series named "Retail Sales of
 * Electricity in …" reads more like "retail sales" than the route the query
 * spells. A query that names a route by its path is an exact match for it.
 *
 * The match is whole-word and in order, and the run must end the path, so a
 * query spelling a parent's path names the parent, not each route beneath it.
 * One-word queries are left to Fuse, which already matches a one-word segment
 * against a name carrying the same word, and facet-value and named-series
 * entries are never lifted — they point at a route without being it.
 */
function routePathMatches(cache: CacheState, query: string): number[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length < 2) return [];
  const spelled = words.join('-');

  const refs: number[] = [];
  for (const [ref, entry] of cache.entries.entries()) {
    if (entry.filter_hint !== undefined) continue;
    const segments = entry.route.toLowerCase().split('/');
    if (segments.some((_, i) => segments.slice(i).join('-') === spelled)) refs.push(ref);
  }
  return refs;
}

/**
 * Most characters of a query `searchRoutes` reads, which bounds what one search
 * costs. The longest name in the warm corpus is 174 characters, so a query
 * naming any indexed entry is searched whole.
 */
export const MAX_SEARCHED_QUERY_LENGTH = 256;

/**
 * Fuzzy search across the index. Returns ranked matches, best first, in the
 * total order `compareRanked` defines.
 *
 * A multi-term query is scored twice — once as a phrase by Fuse, once term by
 * term through the gate above — and each entry keeps its better score. The two
 * paths admit different candidates and neither can cost the other anything: the
 * phrase path answers "this entry reads like your query", the term path answers
 * "this entry covers your query's concepts", and a query only needs one to be
 * true. A single-term query has nothing to tokenize, so it takes the phrase path
 * alone and scores exactly as Fuse scores it. A query that spells the end of a
 * route's path scores that route entry 0 (`routePathMatches`).
 *
 * `mode` is what `scripts/eval-search.ts` measures the gate's contribution
 * against: `'phrase'` is the un-tokenized behavior on its own.
 *
 * Only the first `MAX_SEARCHED_QUERY_LENGTH` characters of the query are read,
 * by every pass. A ranking depends only on those, `limit`, `mode`, and the
 * index, so a repeat is answered from `resultMemo` until the index next
 * changes. Every call returns fresh result objects and entry copies: a caller
 * that edits what it received changes neither the index nor a later answer.
 */
export function searchRoutes(
  query: string,
  limit: number,
  mode: 'combined' | 'phrase' = 'combined',
): Array<{ entry: SearchIndexEntry; score: number }> {
  const cache = _cache;
  if (!cache) return [];

  const searched = query.slice(0, MAX_SEARCHED_QUERY_LENGTH);
  const key = `${mode}\u0000${limit}\u0000${searched}`;
  let ranking = cache.resultMemo.get(key);
  if (ranking) {
    // Re-inserting moves the key to the most recently used end.
    cache.resultMemo.delete(key);
    cache.resultMemo.set(key, ranking);
  } else {
    ranking = rankQuery(cache, searched, limit, mode);
    rememberRanking(cache, key, ranking);
  }

  const results: Array<{ entry: SearchIndexEntry; score: number }> = [];
  for (let i = 0; i < ranking.length; i += 2) {
    const entry = cache.entries[ranking[i] as number] as SearchIndexEntry;
    results.push({
      entry: { ...entry, ...(entry.filter_hint && { filter_hint: { ...entry.filter_hint } }) },
      score: ranking[i + 1] as number,
    });
  }
  return results;
}

/**
 * Most bytes `resultMemo` retains per index build, as `memoBytes` charges them;
 * the least recently used rankings are evicted to stay under it.
 */
const RESULT_MEMO_BUDGET_BYTES = 1024 * 1024;

/**
 * What a kept ranking retains beyond its key's characters and its packed
 * results: the Map slot, the key string's header, and the typed array with its
 * backing store. Set from the heap a kept ranking was measured to hold under
 * Node 26 and Bun 1.4, so `memoBytes` charges each ranking at least that.
 */
const MEMO_ENTRY_OVERHEAD_BYTES = 320;

/**
 * Bytes `resultMemo` charges a ranking — key characters at two bytes each,
 * whatever their encoding, so the charge never undercounts.
 */
function memoBytes(key: string, ranking: Float64Array): number {
  return MEMO_ENTRY_OVERHEAD_BYTES + key.length * 2 + ranking.byteLength;
}

/** Keep a ranking, evicting the least recently used until the budget holds it. */
function rememberRanking(cache: CacheState, key: string, ranking: Float64Array): void {
  const bytes = memoBytes(key, ranking);
  if (bytes > RESULT_MEMO_BUDGET_BYTES) return;
  for (const [oldKey, oldRanking] of cache.resultMemo) {
    if (cache.resultMemoBytes + bytes <= RESULT_MEMO_BUDGET_BYTES) break;
    cache.resultMemo.delete(oldKey);
    cache.resultMemoBytes -= memoBytes(oldKey, oldRanking);
  }
  cache.resultMemo.set(key, ranking);
  cache.resultMemoBytes += bytes;
}

/** Score the query against the index and pack the best `limit` as `[refIndex, score, …]`. */
function rankQuery(
  cache: CacheState,
  query: string,
  limit: number,
  mode: 'combined' | 'phrase',
): Float64Array {
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
    for (const ref of routePathMatches(cache, query)) scores.set(ref, 0);
  }

  const best = [...scores]
    .map(([ref, score]) => {
      const entry = cache.entries[ref] as SearchIndexEntry;
      return { ref, entry, score, key: entryKey(entry) };
    })
    .sort(compareRanked)
    .slice(0, limit);
  return Float64Array.from(best.flatMap(({ ref, score }) => [ref, score]));
}

/**
 * The total order results are returned in: score, then route entries ahead of
 * the named-series and facet-value entries that carry a `filter_hint`, then
 * `entryKey` (route path, then filter) by code point. Index position never
 * decides a tie — the warm appends facet values as each fetch lands, so that
 * position differs from one warm to the next, and with it which of eight
 * equally scored Wind values answered "wind" first.
 */
function compareRanked(
  a: { entry: SearchIndexEntry; score: number; key: string },
  b: { entry: SearchIndexEntry; score: number; key: string },
): number {
  return (
    a.score - b.score ||
    Number(a.entry.filter_hint !== undefined) - Number(b.entry.filter_hint !== undefined) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
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
 * non-zero. Used by both post-warm entry classes — named series and facet
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
 * Leaf routes paired with the facet IDs worth fetching at warm time: the
 * `VOCABULARY_FACET_IDS` facets wherever they appear, and the
 * `SUB_MONTHLY_FACET_IDS` facets on leaves listing a `SUB_MONTHLY_FREQUENCIES`
 * frequency. Read straight from the cached tree, which already carries every
 * leaf's facet IDs and frequencies — so the selection itself costs nothing.
 */
export function listVocabularyFacets(): Array<{
  route: string;
  facetId: string;
  description: string;
}> {
  if (!_cache) return [];
  const targets: Array<{ route: string; facetId: string; description: string }> = [];
  for (const [route, node] of _cache.nodeMap) {
    const subMonthly = frequenciesOf(node).some((f) => SUB_MONTHLY_FREQUENCIES.has(f.id));
    for (const facet of node.facets ?? []) {
      const id = normalizeFacetId(facet.id);
      if (VOCABULARY_FACET_IDS.has(id) || (subMonthly && SUB_MONTHLY_FACET_IDS.has(id))) {
        targets.push({ route, facetId: facet.id, description: facet.description });
      }
    }
  }
  return targets;
}

/** One entry per value of `facet`, each pointing back at `route` with a ready-to-use `filter_hint`. */
function facetValueEntries(cache: CacheState, route: string, facet: Facet): SearchIndexEntry[] {
  const routeName = cache.nodeMap.get(route)?.name ?? route;
  const parts = route.split('/');
  const category = parts.length > 1 ? parts[0] : undefined;
  const dimension = facet.description || facet.id;
  return facet.values.map((value) => ({
    route,
    name: value.name,
    description: `${dimension} value of ${routeName} (${route}) — filter with ${facet.id}="${value.id}".`,
    isLeaf: true,
    category,
    filter_hint: { [facet.id]: value.id },
  }));
}

/**
 * Index a described route's facet values, each pointing back at the route with
 * a ready-to-use `filter_hint`. Facets above `MAX_INDEXED_FACET_VALUES` are
 * skipped, `series` included. Returns how many entries were added.
 */
export function indexFacetValues(route: string, facets: Facet[]): number {
  const cache = _cache;
  if (!cache) return 0;
  return addEntriesToIndex(
    facets
      .filter((facet) => facet.values.length <= MAX_INDEXED_FACET_VALUES)
      .flatMap((facet) => facetValueEntries(cache, route, facet)),
  );
}

/**
 * Index one facet the warm-time pass fetched (`listVocabularyFacets`). The same
 * entries `indexFacetValues` builds, under the same bound, except that a
 * `WHOLE_WARM_FACET_IDS` facet is indexed whatever its size. Returns how many
 * entries were added.
 */
export function indexVocabularyFacet(route: string, facet: Facet): number {
  if (WHOLE_WARM_FACET_IDS.has(normalizeFacetId(facet.id))) {
    return _cache ? addEntriesToIndex(facetValueEntries(_cache, route, facet)) : 0;
  }
  return indexFacetValues(route, [facet]);
}

/**
 * Index the values of one `NAMED_SERIES_FACETS` facet, whatever their count.
 * Each value becomes an entry named for the series, pointing at the facet's
 * route with a `filter_hint` on its id. The id also leads the description, which
 * is what tells apart the SEDS pairs that share a name and differ only in unit
 * (`PACCB` in Billion Btu, `PACCP` in thousand barrels) — entries dedupe on route
 * + hint, so both stay. Returns how many entries were added.
 */
export function indexNamedSeries(pass: NamedSeriesPass, values: Facet['values']): number {
  const { route, facetId, label } = NAMED_SERIES_FACETS[pass];
  return addEntriesToIndex(
    values.map((value) => ({
      route,
      name: value.name,
      description: `${label} series: ${value.name} (${value.id})${
        value.alias && value.alias !== value.name ? ` — ${value.alias}` : ''
      }`,
      isLeaf: true,
      category: route,
      filter_hint: { [facetId]: value.id },
    })),
  );
}
