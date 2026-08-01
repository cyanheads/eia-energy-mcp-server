/**
 * @fileoverview Tests for the route tree cache and Fuse.js fuzzy search index.
 * @module tests/services/route-cache.test
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { WEAK_MATCH_SCORE } from '@/mcp-server/tools/definitions/search-routes.tool.js';
import {
  _resetRouteCache,
  addEntriesToIndex,
  buildNodeMap,
  getChildren,
  getIndexSize,
  getIndexStatus,
  getNode,
  indexFacetValues,
  initRouteCache,
  isLeafNode,
  isRouteCacheReady,
  listVocabularyFacets,
  markIndexPassSettled,
  replaceNode,
  searchRoutes,
} from '@/services/eia/route-cache.js';
import type { Facet, RawRouteNode, SearchIndexEntry } from '@/services/eia/types.js';

const SAMPLE_TREE: RawRouteNode[] = [
  {
    id: 'electricity',
    name: 'Electricity',
    description: 'Electricity data',
    routes: [
      {
        id: 'retail-sales',
        name: 'Retail Sales',
        description: 'Retail electricity sales by state and sector',
        frequency: [{ id: 'monthly', description: 'Monthly', query: 'monthly', format: 'YYYY-MM' }],
        facets: [{ id: 'stateid', description: 'State' }],
        data: { value: { alias: 'Electricity sales', units: 'million kilowatthours' } },
      },
    ],
  },
  {
    id: 'petroleum',
    name: 'Petroleum',
    description: 'Petroleum and other liquids',
    routes: [
      {
        id: 'pri',
        name: 'Prices',
        description: 'Petroleum prices',
        routes: [
          {
            id: 'gnd',
            name: 'Gasoline and Diesel',
            description: 'Weekly retail gasoline and diesel prices',
            frequency: [
              { id: 'weekly', description: 'Weekly', query: 'weekly', format: 'YYYY-MM-DD' },
            ],
            facets: [{ id: 'area-name', description: 'Area' }],
            data: { value: { alias: 'Price', units: 'Dollars per gallon' } },
          },
        ],
      },
    ],
  },
  {
    id: 'steo',
    name: 'Short-Term Energy Outlook',
    description: 'STEO forecasts',
    frequency: [{ id: 'monthly', description: 'Monthly', query: 'monthly', format: 'YYYY-MM' }],
    facets: [{ id: 'seriesId', description: 'Series' }],
    data: { value: { alias: 'Value', units: 'Various' } },
  },
];

describe('route-cache', () => {
  beforeEach(() => {
    _resetRouteCache();
  });

  describe('isLeafNode', () => {
    it('detects leaf by frequency field', () => {
      const node: RawRouteNode = {
        id: 'test',
        name: 'Test',
        frequency: [{ id: 'monthly', description: 'Monthly', query: 'monthly', format: 'YYYY-MM' }],
      };
      expect(isLeafNode(node)).toBe(true);
    });

    it('detects leaf by facets field', () => {
      const node: RawRouteNode = { id: 'test', name: 'Test', facets: [] };
      expect(isLeafNode(node)).toBe(true);
    });

    it('detects leaf by data field', () => {
      const node: RawRouteNode = { id: 'test', name: 'Test', data: {} };
      expect(isLeafNode(node)).toBe(true);
    });

    it('detects category node with routes', () => {
      const node: RawRouteNode = {
        id: 'electricity',
        name: 'Electricity',
        routes: [{ id: 'child', name: 'Child' }],
      };
      expect(isLeafNode(node)).toBe(false);
    });

    it('treats node with no routes and no data fields as leaf', () => {
      const node: RawRouteNode = { id: 'orphan', name: 'Orphan' };
      expect(isLeafNode(node)).toBe(true);
    });

    it('never treats an incomplete node as a leaf', () => {
      // Identical to the orphan above but for the flag — the absence of leaf
      // markers is unfetched metadata, not evidence of a data endpoint.
      const node: RawRouteNode = { id: 'coal', name: 'Coal', incomplete: true };
      expect(isLeafNode(node)).toBe(false);
    });
  });

  describe('buildNodeMap', () => {
    it('builds flat map from nested tree', () => {
      const map = new Map<string, RawRouteNode>();
      buildNodeMap(SAMPLE_TREE, '', map);
      expect(map.has('electricity')).toBe(true);
      expect(map.has('electricity/retail-sales')).toBe(true);
      expect(map.has('petroleum')).toBe(true);
      expect(map.has('petroleum/pri')).toBe(true);
      expect(map.has('petroleum/pri/gnd')).toBe(true);
      expect(map.has('steo')).toBe(true);
    });
  });

  describe('initRouteCache / getNode / getChildren', () => {
    it('initializes cache and allows node lookup', () => {
      initRouteCache(SAMPLE_TREE, []);
      expect(isRouteCacheReady()).toBe(true);

      const elec = getNode('electricity');
      expect(elec).toBeDefined();
      expect(elec?.name).toBe('Electricity');
    });

    it('returns undefined for missing path', () => {
      initRouteCache(SAMPLE_TREE, []);
      expect(getNode('nonexistent')).toBeUndefined();
    });

    it('returns top-level children for empty path', () => {
      initRouteCache(SAMPLE_TREE, []);
      const children = getChildren('');
      const ids = children.map((c) => c.id);
      expect(ids).toContain('electricity');
      expect(ids).toContain('petroleum');
      expect(ids).toContain('steo');
    });

    it('returns sub-children for nested path', () => {
      initRouteCache(SAMPLE_TREE, []);
      const children = getChildren('petroleum');
      expect(children).toHaveLength(1);
      expect(children[0]?.id).toBe('pri');
    });

    it('returns empty array for leaf path with no children', () => {
      initRouteCache(SAMPLE_TREE, []);
      const children = getChildren('electricity/retail-sales');
      expect(children).toHaveLength(0);
    });
  });

  describe('searchRoutes', () => {
    it('returns empty results before init', () => {
      const results = searchRoutes('electricity', 5);
      expect(results).toHaveLength(0);
    });

    it('finds routes by name', () => {
      initRouteCache(SAMPLE_TREE, []);
      const results = searchRoutes('electricity', 5);
      expect(results.length).toBeGreaterThan(0);
      const routes = results.map((r) => r.entry.route);
      expect(routes.some((r) => r.includes('electricity'))).toBe(true);
    });

    it('finds routes by description', () => {
      initRouteCache(SAMPLE_TREE, []);
      const results = searchRoutes('gasoline', 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.entry.route).toContain('gnd');
    });

    it('respects the limit parameter', () => {
      initRouteCache(SAMPLE_TREE, []);
      const results = searchRoutes('energy', 1);
      expect(results.length).toBeLessThanOrEqual(1);
    });
  });

  describe('getIndexSize', () => {
    it('returns 0 before init', () => {
      expect(getIndexSize()).toBe(0);
    });

    it('returns correct count after init', () => {
      initRouteCache(SAMPLE_TREE, []);
      // 6 nodes in the tree (electricity, electricity/retail-sales, petroleum, petroleum/pri, petroleum/pri/gnd, steo)
      expect(getIndexSize()).toBe(6);
    });

    it('increases after STEO series are added', () => {
      initRouteCache(SAMPLE_TREE, [
        {
          route: 'steo',
          name: 'Crude Oil Production',
          description: 'STEO crude',
          isLeaf: true,
          category: 'steo',
        },
      ]);
      expect(getIndexSize()).toBe(7);
    });
  });

  describe('addEntriesToIndex', () => {
    const ENTRY = {
      route: 'steo',
      name: 'Crude Oil Production',
      description: 'STEO crude',
      isLeaf: true,
      category: 'steo',
      filter_hint: { seriesId: 'COPRPUS' },
    };

    it('returns 0 before init', () => {
      expect(addEntriesToIndex([ENTRY])).toBe(0);
    });

    it('appends entries and reports how many landed', () => {
      initRouteCache(SAMPLE_TREE, []);
      expect(addEntriesToIndex([ENTRY])).toBe(1);
      expect(getIndexSize()).toBe(7);
      expect(searchRoutes('crude oil production', 5)[0]?.entry.filter_hint).toEqual({
        seriesId: 'COPRPUS',
      });
    });

    it('skips entries already indexed under the same route and filter hint', () => {
      initRouteCache(SAMPLE_TREE, []);
      addEntriesToIndex([ENTRY]);
      // Same identity, different display text — still a duplicate.
      expect(addEntriesToIndex([{ ...ENTRY, name: 'Crude Oil Production, U.S.' }])).toBe(0);
      expect(getIndexSize()).toBe(7);
    });
  });

  describe('getIndexStatus / markIndexPassSettled', () => {
    it('reports both passes pending before init', () => {
      expect(getIndexStatus()).toEqual({
        complete: false,
        incompleteRoutes: [],
        pendingPasses: ['facet_values', 'steo_series'],
        size: 0,
      });
    });

    it('is complete only once every pass has landed', () => {
      initRouteCache(SAMPLE_TREE, []);
      expect(getIndexStatus().complete).toBe(false);

      markIndexPassSettled('steo_series');
      expect(getIndexStatus().pendingPasses).toEqual(['facet_values']);
      expect(getIndexStatus().complete).toBe(false);

      markIndexPassSettled('facet_values');
      expect(getIndexStatus()).toEqual({
        complete: true,
        incompleteRoutes: [],
        pendingPasses: [],
        size: 6,
      });
    });

    it('stays incomplete while a route subtree is missing, whatever the passes did', () => {
      initRouteCache([{ id: 'coal', name: 'Coal', incomplete: true }], []);
      markIndexPassSettled('steo_series');
      markIndexPassSettled('facet_values');

      const status = getIndexStatus();
      expect(status.incompleteRoutes).toEqual(['coal']);
      expect(status.pendingPasses).toEqual([]);
      expect(status.complete).toBe(false);
    });
  });

  describe('replaceNode', () => {
    const WITH_GAP: RawRouteNode[] = [
      { id: 'coal', name: 'Coal', description: 'Coal data', incomplete: true },
      ...SAMPLE_TREE,
    ];

    const REPAIRED: RawRouteNode = {
      id: 'coal',
      name: 'Coal',
      description: 'Coal data',
      routes: [
        {
          id: 'mine-production',
          name: 'Mine Production',
          description: 'Coal production by mine',
          facets: [],
          frequency: [],
          data: {},
        },
      ],
    };

    it('is a no-op before init', () => {
      expect(() => replaceNode('coal', REPAIRED)).not.toThrow();
    });

    it('splices the subtree in and clears the gap', () => {
      initRouteCache(WITH_GAP, []);
      expect(getIndexStatus().incompleteRoutes).toEqual(['coal']);

      replaceNode('coal', REPAIRED);

      expect(getNode('coal/mine-production')).toBeDefined();
      expect(getChildren('coal').map((c) => c.route)).toEqual(['coal/mine-production']);
      expect(getIndexStatus().incompleteRoutes).toEqual([]);
      expect(searchRoutes('mine production', 5)[0]?.entry.route).toBe('coal/mine-production');
    });

    it('replaces the stub entry rather than leaving its stale leaf claim indexed', () => {
      initRouteCache(WITH_GAP, []);
      replaceNode('coal', REPAIRED);

      const coalEntries = searchRoutes('Coal', 10).filter((r) => r.entry.route === 'coal');
      expect(coalEntries).toHaveLength(1);
      expect(coalEntries[0]?.entry.isLeaf).toBe(false);
    });

    it('leaves appended STEO and facet entries in place', () => {
      initRouteCache(WITH_GAP, []);
      indexFacetValues('electricity/retail-sales', [
        { id: 'fueltypeid', description: 'Fuel Type', values: [{ id: 'WND', name: 'wind' }] },
      ]);

      replaceNode('coal', REPAIRED);

      expect(searchRoutes('wind', 5)[0]?.entry.filter_hint).toEqual({ fueltypeid: 'WND' });
      // 8 route nodes after the repair, plus the one facet value.
      expect(getIndexSize()).toBe(9);
    });

    it('drops the old subtree instead of stacking a second copy on it', () => {
      initRouteCache(WITH_GAP, []);
      replaceNode('coal', REPAIRED);
      replaceNode('coal', REPAIRED);

      expect(getChildren('coal')).toHaveLength(1);
      expect(getIndexSize()).toBe(8);
    });
  });

  describe('listVocabularyFacets', () => {
    const FACETED_TREE: RawRouteNode[] = [
      {
        id: 'electricity',
        name: 'Electricity',
        routes: [
          {
            id: 'electric-power-operational-data',
            name: 'Electric Power Operations',
            facets: [
              { id: 'fueltypeid', description: 'Energy Source' },
              { id: 'sectorid', description: 'Sector' },
              { id: 'location', description: 'State / Census Region' },
            ],
          },
          {
            id: 'operating-generator-capacity',
            name: 'Inventory of Operable Generators',
            // Same dimension, EIA's other spelling — normalization must catch it.
            facets: [{ id: 'energy_source_code', description: 'Primary Energy Source' }],
          },
        ],
      },
      {
        id: 'petroleum',
        name: 'Petroleum',
        routes: [
          {
            id: 'sum',
            name: 'Summary',
            // The four facets that dominate the taxonomy by volume — excluded.
            facets: [
              { id: 'duoarea', description: 'DuoArea' },
              { id: 'product', description: 'Product' },
              { id: 'process', description: 'Process' },
              { id: 'series', description: 'Series' },
            ],
          },
        ],
      },
    ];

    it('returns nothing before init', () => {
      expect(listVocabularyFacets()).toEqual([]);
    });

    it("selects vocabulary facets across EIA's inconsistent ID spellings", () => {
      initRouteCache(FACETED_TREE, []);
      const targets = listVocabularyFacets();
      expect(targets).toEqual(
        expect.arrayContaining([
          {
            route: 'electricity/electric-power-operational-data',
            facetId: 'fueltypeid',
            description: 'Energy Source',
          },
          {
            route: 'electricity/electric-power-operational-data',
            facetId: 'sectorid',
            description: 'Sector',
          },
          {
            route: 'electricity/operating-generator-capacity',
            facetId: 'energy_source_code',
            description: 'Primary Energy Source',
          },
        ]),
      );
      expect(targets).toHaveLength(3);
    });

    it('excludes the high-volume and geography facets', () => {
      initRouteCache(FACETED_TREE, []);
      const ids = listVocabularyFacets().map((t) => t.facetId);
      for (const excluded of ['duoarea', 'product', 'process', 'series', 'location']) {
        expect(ids).not.toContain(excluded);
      }
    });
  });

  describe('indexFacetValues', () => {
    function facet(id: string, count: number, description = 'Fuel Type'): Facet {
      return {
        id,
        description,
        values: Array.from({ length: count }, (_, i) => ({ id: `V${i}`, name: `Value ${i}` })),
      };
    }

    it('returns 0 before init', () => {
      expect(indexFacetValues('electricity/retail-sales', [facet('fueltypeid', 3)])).toBe(0);
    });

    it('adds one entry per value, each carrying a filter hint for its route', () => {
      initRouteCache(SAMPLE_TREE, []);
      const added = indexFacetValues('electricity/retail-sales', [
        {
          id: 'fueltypeid',
          description: 'Fuel Type',
          values: [
            { id: 'WND', name: 'wind' },
            { id: 'SPV', name: 'solar photovoltaic' },
          ],
        },
      ]);

      expect(added).toBe(2);
      const [hit] = searchRoutes('wind', 5);
      expect(hit?.entry.route).toBe('electricity/retail-sales');
      expect(hit?.entry.filter_hint).toEqual({ fueltypeid: 'WND' });
      expect(hit?.entry.isLeaf).toBe(true);
      expect(hit?.entry.category).toBe('electricity');
      // The description names the dimension and the route it filters.
      expect(hit?.entry.description).toContain('Fuel Type');
      expect(hit?.entry.description).toContain('fueltypeid="WND"');
    });

    it('skips a facet whose value set is too large to be search vocabulary', () => {
      initRouteCache(SAMPLE_TREE, []);
      // 200 is the bound; 201 is an opaque-identifier dimension.
      expect(indexFacetValues('electricity/retail-sales', [facet('mineMSHAId', 201)])).toBe(0);
      expect(indexFacetValues('electricity/retail-sales', [facet('coalRankId', 200)])).toBe(200);
    });

    it('skips a facet with no values', () => {
      initRouteCache(SAMPLE_TREE, []);
      expect(indexFacetValues('electricity/retail-sales', [facet('fueltypeid', 0)])).toBe(0);
    });

    it('is idempotent across repeat calls for the same route', () => {
      initRouteCache(SAMPLE_TREE, []);
      const f = facet('fueltypeid', 5);
      expect(indexFacetValues('electricity/retail-sales', [f])).toBe(5);
      expect(indexFacetValues('electricity/retail-sales', [f])).toBe(0);
      expect(getIndexSize()).toBe(11);
    });

    it('keeps the same value on two routes as two separately filterable entries', () => {
      initRouteCache(SAMPLE_TREE, []);
      const f: Facet = {
        id: 'fueltypeid',
        description: 'Fuel Type',
        values: [{ id: 'WND', name: 'wind' }],
      };
      expect(indexFacetValues('electricity/retail-sales', [f])).toBe(1);
      expect(indexFacetValues('petroleum/pri/gnd', [f])).toBe(1);

      const routes = searchRoutes('wind', 5).map((r) => r.entry.route);
      expect(routes).toContain('electricity/retail-sales');
      expect(routes).toContain('petroleum/pri/gnd');
    });
  });
});

/**
 * `eia_search_routes` compares a hit's score against a fixed threshold, and that
 * score comes from two places that move for different reasons: Fuse's own scale,
 * a library implementation detail that shifted wholesale between 7.4.2 and
 * 7.5.0, and the tokenized candidate gate, whose term weights are document
 * frequencies over the whole corpus. Both are pinned here.
 *
 * The fixture carries the verbatim name and description of twenty live EIA
 * routes rather than the two the phrase path alone needed. That size is load
 * bearing: term weights are `log(N / df)`, so a handful of entries makes every
 * term look equally rare and the gate behaves nothing like it does over the real
 * 2,103-entry corpus. At this size it does — `electricity price residential`
 * reproduces the reported bug under the phrase path (no candidate at all) and
 * resolves under the tokenized one, which is the whole change in miniature.
 *
 * Scores are pinned exactly. A fuse.js upgrade, a `FUSE_OPTIONS` edit, or a
 * change to the gate's constants all move them, and all three invalidate
 * `WEAK_MATCH_SCORE` — which is measured against the live corpus by
 * `scripts/eval-search.ts`, not against this fixture. Re-run that script when
 * these numbers move; do not simply re-pin them.
 */
describe('weak-match calibration against the live Fuse scale', () => {
  /** A queryable leaf carrying one live route's real name and description. */
  function leaf(id: string, name: string, description: string): RawRouteNode {
    return { id, name, description, frequency: [], facets: [], data: {} };
  }

  const LIVE_FIXTURE: RawRouteNode[] = [
    {
      id: 'electricity',
      name: 'Electricity',
      description: 'EIA electricity survey data',
      routes: [
        leaf(
          'retail-sales',
          'Electricity Sales to Ultimate Customers',
          'Electricity sales to ultimate customer by state and sector (number of customers, average price, revenue, and megawatthours of sales). Sources: Forms EIA-826, EIA-861, EIA-861M',
        ),
        leaf(
          'electric-power-operational-data',
          'Electric Power Operations (Annual and Monthly)',
          'Monthly and annual electric power operations by state, sector, and energy source. Source: Form EIA-923',
        ),
        leaf(
          'operating-generator-capacity',
          'Inventory of Operable Generators',
          'Inventory of operable generators in the U.S. Source: Forms EIA-860, EIA-860M',
        ),
        leaf(
          'facility-fuel',
          'Electric Power Operations for Individual Power Plants (Annual and Monthly)',
          'Annual and monthly electric power operations for individual power plants, by energy source and prime mover Source: Form EIA-923',
        ),
      ],
    },
    {
      id: 'coal',
      name: 'Coal',
      description: 'EIA coal energy data',
      routes: [
        leaf(
          'reserves-capacity',
          'Reserves Capacity',
          'Coal capacity data, including productive capacity, stocks, and recoverable reserves by state, region and mine type. Source: EIA Form 7A and MSHA Form 7000-2. Interactive browser: https://www.eia.gov/coal/data/browser/',
        ),
        leaf(
          'consumption-and-quality',
          'Consumption and Quality',
          'Coal consumption and quality data by state and sector, including price, reciepts, heat content, sulfur content, ash content, and stocks. Source: EIA Form 7A and MSHA Form 7000-2. Interactive browser: https://www.eia.gov/coal/data/browser/',
        ),
        leaf(
          'mine-production',
          'Mine Production',
          'Coal mine-level data, including production, region, state, county, rank, status, type, name and description. Source: EIA Form 7A and MSHA Form 7000-2. Interactive browser: https://www.eia.gov/coal/data/browser/',
        ),
        leaf(
          'price-by-rank',
          'Price by Rank',
          'Coal prices by rank data for region and state. Source: EIA Form 7A and MSHA Form 7000-2. Interactive browser: https://www.eia.gov/coal/data/browser/',
        ),
      ],
    },
    {
      id: 'petroleum',
      name: 'Petroleum',
      description: 'EIA petroleum gas survey data',
      routes: [
        {
          id: 'pri',
          name: 'Prices',
          description: 'Petroleum, Prices',
          routes: [
            leaf(
              'gnd',
              'Weekly Retail Gasoline and Diesel Prices',
              'EIA petroleum gas survey data',
            ),
            leaf(
              'resid',
              'Residual Fuel Oil Prices by Sales Type',
              'EIA petroleum gas survey data',
            ),
          ],
        },
      ],
    },
    {
      id: 'natural-gas',
      name: 'Natural Gas',
      description: 'EIA natural gas survey data',
      routes: [
        leaf('move', 'Imports and Exports/Pipelines', 'Natural Gas, Imports and Exports/Pipelines'),
        leaf('pri', 'Prices', 'Natural Gas, Prices'),
      ],
    },
    leaf(
      'steo',
      'Short Term Energy Outlook',
      'Monthly short term (18 month) projections using STEO model. Report and interactive projection data browser: STEO (www.eia.gov/steo/)',
    ),
    leaf(
      'total-energy',
      'Total Energy',
      'These data represent the most recent comprehensive energy statistics integrated across all energy sources. The data includes total energy production, consumption, stocks, and trade; energy prices; overviews of petroleum, natural gas, coal, electricity, nuclear energy, renewable energy, and carbon dioxide emissions; and data unit conversions values.',
    ),
    leaf('nuclear-outages', 'Nuclear Outages', 'EIA nuclear outages survey data'),
  ];

  beforeEach(() => {
    _resetRouteCache();
    initRouteCache(LIVE_FIXTURE, []);
  });

  it('indexes the whole fixture — the gate weights terms by corpus frequency', () => {
    expect(getIndexSize()).toBe(20);
  });

  it('scores the description-advertised query below the weak-match threshold', () => {
    const [top] = searchRoutes('electricity retail sales by state', 5);
    expect(top?.entry.route).toBe('electricity/retail-sales');
    expect(top?.score).toBeCloseTo(0.5522, 4);
    expect(top?.score).toBeLessThan(WEAK_MATCH_SCORE);
  });

  it('scores a query this fixture cannot answer above the weak-match threshold', () => {
    // Answerability is a property of the corpus, not of the query. Against the
    // live taxonomy this query is on-target — electricity/operating-generator-capacity
    // carries solar nameplate capacity by state, and `scripts/search-battery.ts`
    // labels it so. This fixture indexes that route's name and description and
    // none of its facet values, so nothing here holds the answer, which is what
    // makes the query a scale probe rather than a relevance one.
    const [top] = searchRoutes('solar capacity by state', 5);
    expect(top?.entry.route).toBe('coal/reserves-capacity');
    expect(top?.score).toBeCloseTo(0.9474, 4);
    expect(top?.score).toBeGreaterThan(WEAK_MATCH_SCORE);
  });

  it('leaves the phrase path scoring exactly where it did', () => {
    // The tokenized gate is additive: it can only better an entry's score, so
    // the phrase path's own numbers are the baseline every change is read
    // against. These are the scores this tool shipped with before the gate.
    expect(searchRoutes('electricity retail sales by state', 5, 'phrase')[0]?.score).toBeCloseTo(
      0.7314,
      4,
    );
    expect(searchRoutes('solar capacity by state', 5, 'phrase')[0]?.score).toBeCloseTo(0.9474, 4);
  });

  describe('with facet values in the index', () => {
    /** The fuel-type and sector vocabularies these two routes expose. */
    const FUEL_TYPES: Facet = {
      id: 'fueltypeid',
      description: 'Energy Source',
      values: [
        { id: 'WND', name: 'wind' },
        { id: 'SPV', name: 'solar photovoltaic' },
        { id: 'STH', name: 'solar thermal' },
        { id: 'BIT', name: 'anthracite coal' },
      ],
    };

    const SECTORS: Facet = {
      id: 'sectorid',
      description: 'Sector',
      values: [
        { id: 'RES', name: 'residential' },
        { id: 'COM', name: 'commercial' },
        { id: 'IND', name: 'industrial' },
        { id: 'ALL', name: 'all sectors' },
      ],
    };

    beforeEach(() => {
      indexFacetValues('electricity/electric-power-operational-data', [FUEL_TYPES]);
      indexFacetValues('electricity/retail-sales', [SECTORS]);
    });

    it('leaves the advertised query below the threshold once facet values join', () => {
      const [top] = searchRoutes('electricity retail sales by state', 5);
      expect(top?.entry.route).toBe('electricity/retail-sales');
      expect(top?.entry.filter_hint).toBeUndefined();
      expect(top?.score).toBeCloseTo(0.598, 4);
      expect(top?.score).toBeLessThan(WEAK_MATCH_SCORE);
    });

    it('still flags a query with no real match as weak', () => {
      const [top] = searchRoutes('solar capacity by state', 5);
      expect(top?.entry.route).toBe('coal/reserves-capacity');
      expect(top?.score).toBeCloseTo(0.9474, 4);
      expect(top?.score).toBeGreaterThan(WEAK_MATCH_SCORE);
    });

    it('resolves a fuel-type term to the owning route well under the threshold', () => {
      const [top] = searchRoutes('wind', 5);
      expect(top?.entry.route).toBe('electricity/electric-power-operational-data');
      expect(top?.entry.filter_hint).toEqual({ fueltypeid: 'WND' });
      expect(top?.score).toBeCloseTo(0, 5);
    });

    it('scores a single-term query exactly as the phrase path does', () => {
      // Nothing to tokenize, so the gate never runs and #36's facet-value
      // resolution is preserved by construction rather than by calibration.
      for (const query of ['wind', 'anthracite coal', 'reserves']) {
        expect(searchRoutes(query, 5)).toEqual(searchRoutes(query, 5, 'phrase'));
      }
    });

    it('reaches the owning route for a commodity + metric + sector query', () => {
      // The reported bug: no entry's text contains "electricity price
      // residential" as a contiguous run, so the phrase path finds nothing at
      // all, however well electricity/retail-sales holds the data.
      expect(searchRoutes('electricity price residential', 5, 'phrase')).toEqual([]);

      const [top] = searchRoutes('electricity price residential', 5);
      expect(top?.entry.route).toBe('electricity/retail-sales');
      expect(top?.entry.filter_hint).toEqual({ sectorid: 'RES' });
      expect(top?.score).toBeCloseTo(0.3804, 4);
      expect(top?.score).toBeLessThan(WEAK_MATCH_SCORE);
    });

    it('keeps the route entry ahead of its own facet values on a route-shaped query', () => {
      const results = searchRoutes('electricity retail sales by state', 10);
      const routeRank = results.findIndex((r) => r.entry.filter_hint === undefined);
      const facetRank = results.findIndex((r) => r.entry.filter_hint !== undefined);
      expect(routeRank).toBe(0);
      if (facetRank >= 0) expect(results[facetRank]!.score).toBeGreaterThan(results[0]!.score);
    });
  });
});

/**
 * The candidate gate's own rules, exercised where the corpus statistics are
 * controlled rather than inherited from a real taxonomy. Each test names one
 * rule and the failure it exists to prevent; the filler entries give the shared
 * vocabulary a realistic document frequency, which is what the weighting reads.
 */
describe('tokenized candidate gate', () => {
  /** `count` entries carrying the shared vocabulary, so common terms weigh little. */
  function filler(count: number): SearchIndexEntry[] {
    return Array.from({ length: count }, (_, i) => ({
      route: `filler/route-${i}`,
      name: `Sector Report ${i}`,
      description: `Energy data by state and sector for region ${i}.`,
      isLeaf: true,
      category: 'filler',
    }));
  }

  function entry(route: string, name: string, description: string): SearchIndexEntry {
    return { route, name, description, isLeaf: true, category: route.split('/')[0] };
  }

  beforeEach(() => {
    _resetRouteCache();
  });

  it('promotes the entry covering both terms over one covering a single term well', () => {
    initRouteCache(
      [],
      [
        entry('partial/route', 'Anthracite', 'Coal rank detail.'),
        entry('both/route', 'Shipment Tonnage', 'Anthracite deliveries by state.'),
        ...filler(60),
      ],
    );
    // "anthracite tonnage" exists in both/route's text, split across two keys —
    // exactly the shape Fuse's contiguous-run matching cannot reward.
    const [top] = searchRoutes('anthracite tonnage', 5);
    expect(top?.entry.route).toBe('both/route');

    const phraseScore = searchRoutes('anthracite tonnage', 5, 'phrase').find(
      (r) => r.entry.route === 'both/route',
    )?.score;
    expect(top?.score).toBeLessThan(phraseScore as number);
  });

  it('drops function words rather than letting them earn coverage', () => {
    initRouteCache(
      [],
      [
        entry('by/route', 'Sales by Region', 'Totals by region and by state.'),
        entry('target/route', 'Anthracite Sales', 'Anthracite sales by region.'),
        ...filler(60),
      ],
    );
    // "by" is rarer in this corpus than "sales", so weighting it by frequency
    // alone would make the preposition the heaviest term in the query.
    const routes = searchRoutes('anthracite sales by region', 5).map((r) => r.entry.route);
    expect(routes[0]).toBe('target/route');
    expect(routes).not.toContain('by/route');
  });

  it("rejects an entry carrying only the query's generic terms", () => {
    initRouteCache([], [entry('generic/route', 'Sector Report', 'Data by state.'), ...filler(60)]);
    // "sector" and "state" are everywhere; "anthracite" is the question.
    expect(searchRoutes('anthracite sector state', 5)).toEqual([]);
  });

  it('rejects a two-term query whose second term the corpus does not contain', () => {
    initRouteCache(
      [],
      [entry('half/route', 'Anthracite Report', 'Anthracite tonnage by state.'), ...filler(60)],
    );
    // "turbines" matches nothing, so it carries the most weight of any term and
    // is always unmatched — the weight bar is what rejects this one. The gate
    // contributes nothing, leaving whatever the phrase path made of it.
    expect(searchRoutes('anthracite turbines', 5)).toEqual(
      searchRoutes('anthracite turbines', 5, 'phrase'),
    );
    expect(searchRoutes('anthracite tonnage', 5)[0]?.entry.route).toBe('half/route');
  });

  it('rejects a two-term query answered by one term, however rare that term is', () => {
    initRouteCache(
      [],
      [entry('half/route', 'Anthracite Report', 'Anthracite deliveries.'), ...filler(60)],
    );
    // "sector" is in every filler entry and so weighs almost nothing, which
    // leaves "anthracite" carrying over 99% of the query — enough to clear the
    // weight bar alone. The matched-term floor is the only rule that asks for
    // both concepts, and this is the case that isolates it.
    expect(searchRoutes('anthracite sector', 5)).toEqual(
      searchRoutes('anthracite sector', 5, 'phrase'),
    );
  });

  it('requires a short term to be carried verbatim, and does not require it of a long one', () => {
    initRouteCache(
      [],
      [entry('wood/route', 'Wood Tonnage', 'Wood waste tonnage by state.'), ...filler(60)],
    );
    // "food" is one edit from "Wood", which is enough for Fuse to match it and
    // enough to satisfy the matched-term floor without carrying the concept.
    expect(searchRoutes('food tonnage', 5)).toEqual(searchRoutes('food tonnage', 5, 'phrase'));
    // A term past the length bound keeps its fuzziness — one edit still matches.
    expect(searchRoutes('wood tonnnage', 5)[0]?.entry.route).toBe('wood/route');
  });

  it('penalizes a missing term more the rarer it is', () => {
    initRouteCache(
      [],
      [
        entry('full/route', 'Anthracite Tonnage', 'Anthracite tonnage by state and sector.'),
        entry('partial/route', 'Anthracite Sector', 'Anthracite by state and sector.'),
        ...filler(60),
      ],
    );
    const [full, partial] = searchRoutes('anthracite tonnage sector', 5);
    expect(full?.entry.route).toBe('full/route');
    expect(partial?.entry.route).toBe('partial/route');
    expect(partial?.score).toBeGreaterThan(full?.score as number);
  });
});
