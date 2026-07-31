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
  getNode,
  indexFacetValues,
  initRouteCache,
  isLeafNode,
  isRouteCacheReady,
  listVocabularyFacets,
  searchRoutes,
} from '@/services/eia/route-cache.js';
import type { Facet, RawRouteNode } from '@/services/eia/types.js';

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
 * The weak-match label in `eia_search_routes` compares Fuse's score against a
 * fixed threshold, and Fuse's score scale is a library implementation detail —
 * it shifted wholesale between 7.4.2 and 7.5.0. These fixtures carry the real
 * name/description of two live EIA routes, so a fuse.js upgrade that moves the
 * scale trips the assertions instead of silently labelling good hits weak.
 *
 * The threshold survives the addition of facet-value entries because Fuse scores
 * each entry against the pattern independently of the corpus: appending entries
 * under an unchanged key/weight config leaves every existing score untouched.
 * Editing `FUSE_OPTIONS` is what moves the scale, and the block below pins both
 * halves — the same scores with facet values present, and the separation between
 * a real match and noise once facet values can be matched.
 */
describe('weak-match calibration against the live Fuse scale', () => {
  const LIVE_FIXTURE: RawRouteNode[] = [
    {
      id: 'electricity',
      name: 'Electricity',
      description: 'EIA electricity survey data',
      routes: [
        {
          id: 'retail-sales',
          name: 'Electricity Sales to Ultimate Customers',
          description:
            'Electricity sales to ultimate customer by state and sector (number of customers, average price, revenue, and megawatthours of sales). Sources: Forms EIA-826, EIA-861, EIA-861M',
          frequency: [],
          facets: [],
          data: {},
        },
      ],
    },
    {
      id: 'coal',
      name: 'Coal',
      description: 'EIA coal energy data',
      routes: [
        {
          id: 'reserves-capacity',
          name: 'Reserves Capacity',
          description:
            'Coal capacity data, including productive capacity, stocks, and recoverable reserves by state, region and mine type. Source: EIA Form 7A and MSHA Form 7000-2. Interactive browser: https://www.eia.gov/coal/data/browser/',
          frequency: [],
          facets: [],
          data: {},
        },
      ],
    },
  ];

  beforeEach(() => {
    _resetRouteCache();
    initRouteCache(LIVE_FIXTURE, []);
  });

  it('scores the description-advertised query below the weak-match threshold', () => {
    const [top] = searchRoutes('electricity retail sales by state', 5);
    expect(top?.entry.route).toBe('electricity/retail-sales');
    expect(top?.score).toBeLessThan(WEAK_MATCH_SCORE);
  });

  it('scores a query with no real match above the weak-match threshold', () => {
    const [top] = searchRoutes('solar capacity by state', 5);
    expect(top?.entry.route).toBe('coal/reserves-capacity');
    expect(top?.score).toBeGreaterThan(WEAK_MATCH_SCORE);
  });

  describe('with facet values in the index', () => {
    /** The fuel-type vocabulary `electricity/electric-power-operational-data` exposes. */
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

    beforeEach(() => {
      indexFacetValues('electricity/retail-sales', [FUEL_TYPES]);
    });

    it('leaves the advertised query scoring exactly where it did', () => {
      const [top] = searchRoutes('electricity retail sales by state', 5);
      expect(top?.entry.route).toBe('electricity/retail-sales');
      expect(top?.entry.filter_hint).toBeUndefined();
      expect(top?.score).toBeLessThan(WEAK_MATCH_SCORE);
    });

    it('still flags a query with no real match as weak', () => {
      const [top] = searchRoutes('solar capacity by state', 5);
      expect(top?.entry.route).toBe('coal/reserves-capacity');
      expect(top?.score).toBeGreaterThan(WEAK_MATCH_SCORE);
    });

    it('resolves a fuel-type term to the owning route well under the threshold', () => {
      const [top] = searchRoutes('wind', 5);
      expect(top?.entry.route).toBe('electricity/retail-sales');
      expect(top?.entry.filter_hint).toEqual({ fueltypeid: 'WND' });
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
