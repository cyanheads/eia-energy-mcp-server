/**
 * @fileoverview Tests for the route tree cache and Fuse.js fuzzy search index.
 * @module tests/services/route-cache.test
 */

import Fuse from 'fuse.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEAK_MATCH_SCORE } from '@/mcp-server/tools/definitions/search-routes.tool.js';
import {
  _resetRouteCache,
  addEntriesToIndex,
  buildNodeMap,
  getChildren,
  getIndexEntries,
  getIndexSize,
  getIndexStatus,
  getNode,
  indexFacetValues,
  indexNamedSeries,
  indexVocabularyFacet,
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

    describe('ranking memo', () => {
      const SPOT_ENTRY: SearchIndexEntry = {
        route: 'petroleum/pri/spt',
        name: 'Gasoline Spot Prices',
        description: 'Daily spot prices for gasoline',
        isLeaf: true,
        category: 'petroleum',
        filter_hint: { series: 'EER_EPMRU_PF4_Y35NY_DPG' },
      };

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('answers a repeated query without searching the index again', () => {
        initRouteCache(SAMPLE_TREE, []);
        const search = vi.spyOn(Fuse.prototype, 'search');
        const first = searchRoutes('gasoline prices', 5);
        const searched = search.mock.calls.length;
        expect(searched).toBeGreaterThan(0);

        expect(searchRoutes('gasoline prices', 5)).toEqual(first);
        expect(search.mock.calls.length).toBe(searched);
      });

      it('searches again once an append or a replaced node changes the index', () => {
        initRouteCache(SAMPLE_TREE, []);
        const before = searchRoutes('gasoline', 5).map((r) => r.entry.route);
        expect(before).not.toContain('petroleum/pri/spt');

        addEntriesToIndex([SPOT_ENTRY]);
        expect(searchRoutes('gasoline', 5).map((r) => r.entry.route)).toContain(
          'petroleum/pri/spt',
        );

        // Renaming the leaf through replaceNode must reach the next ranking too.
        replaceNode('petroleum/pri/gnd', {
          id: 'gnd',
          name: 'Diesel Only',
          description: 'Weekly retail diesel prices',
          frequency: [
            { id: 'weekly', description: 'Weekly', query: 'weekly', format: 'YYYY-MM-DD' },
          ],
        });
        expect(searchRoutes('gasoline', 5).map((r) => r.entry.route)).not.toContain(
          'petroleum/pri/gnd',
        );
      });

      it('keeps separate rankings per limit and per mode', () => {
        initRouteCache(SAMPLE_TREE, []);
        expect(searchRoutes('electricity', 1)).toHaveLength(1);
        expect(searchRoutes('electricity', 5)).toHaveLength(2);

        // No entry reads like the whole phrase, so the phrase pass scores the
        // gasoline leaf worse than the term pass the combined mode adds.
        const phrase = searchRoutes('gasoline prices', 5, 'phrase');
        const combined = searchRoutes('gasoline prices', 5);
        expect(phrase[0]?.entry.route).toBe('petroleum/pri/gnd');
        expect(combined[0]?.entry.route).toBe('petroleum/pri/gnd');
        expect(phrase[0]?.score).toBeGreaterThan(combined[0]?.score as number);
      });

      it('returns results a caller can edit without changing a later answer or the index', () => {
        initRouteCache(SAMPLE_TREE, [SPOT_ENTRY]);
        const pristine = structuredClone(searchRoutes('gasoline', 5));
        const indexBefore = structuredClone(getIndexEntries());
        const spot = pristine.findIndex((r) => r.entry.filter_hint !== undefined);
        expect(spot).toBeGreaterThanOrEqual(0);

        const received = searchRoutes('gasoline', 5);
        const target = received[spot] as (typeof received)[number];
        (target.entry.filter_hint as Record<string, string>).series = 'EDITED';
        target.entry.name = 'Edited';
        target.score = 99;
        received.reverse();
        received.push({ entry: target.entry, score: -1 });

        expect(searchRoutes('gasoline', 5)).toEqual(pristine);
        expect(getIndexEntries()).toEqual(indexBefore);
      });

      // The two eviction tests count index searches; matching nothing keeps the
      // thousands of searches they run cheap, and every ranking empty.
      it('bounds the memo by the bytes it retains, not by a count of rankings', () => {
        initRouteCache(SAMPLE_TREE, []);
        const search = vi.spyOn(Fuse.prototype, 'search').mockReturnValue([]);
        const reSearches = (query: string): boolean => {
          const calls = search.mock.calls.length;
          searchRoutes(query, 5);
          return search.mock.calls.length > calls;
        };

        // 2,000 short keys fit the byte budget: the first is still held.
        for (let i = 0; i < 2000; i++) searchRoutes(`zq${i}`, 5);
        expect(reSearches('zq0')).toBe(false);

        // 2,000 keys of 120 characters do not: the oldest are evicted first,
        // while the newest stays held.
        initRouteCache(SAMPLE_TREE, []);
        const wide = (i: number) => `zq${i}`.padEnd(120, 'x');
        for (let i = 0; i < 2000; i++) searchRoutes(wide(i), 5);
        expect(reSearches(wide(1999))).toBe(false);
        expect(reSearches(wide(0))).toBe(true);
      });

      it('evicts the least recently used ranking, not the oldest one stored', () => {
        initRouteCache(SAMPLE_TREE, []);
        const search = vi.spyOn(Fuse.prototype, 'search').mockReturnValue([]);
        const wide = (i: number) => `zq${i}`.padEnd(120, 'x');
        const keptSearches = () => search.mock.calls.filter(([pattern]) => pattern === 'kept');
        searchRoutes('kept', 5);
        for (let i = 0; i < 2000; i++) {
          searchRoutes(wide(i), 5);
          // Reading it again marks it recently used.
          if (i % 100 === 0) searchRoutes('kept', 5);
        }
        searchRoutes('kept', 5);
        // Evicted once and searched again, it would also look held at the end.
        expect(keptSearches()).toHaveLength(1);
        // The budget did evict: the first wide key stored is gone.
        const calls = search.mock.calls.length;
        searchRoutes(wide(0), 5);
        expect(search.mock.calls.length).toBe(calls + 1);
      });
    });

    describe('search cost bound', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('reads only the first 256 characters of a query, in every pass', () => {
        initRouteCache(SAMPLE_TREE, []);
        const search = vi.spyOn(Fuse.prototype, 'search');
        const head = 'gasoline prices weekly retail diesel '.repeat(7).slice(0, 256);
        const query = `${head}electricity sales state sector`;

        const ranked = searchRoutes(query, 5);
        const patterns = search.mock.calls.map(([pattern]) => pattern as string);
        expect(patterns.length).toBeGreaterThan(0);
        expect(Math.max(...patterns.map((p) => p.length))).toBeLessThanOrEqual(256);
        expect(patterns.some((p) => p.includes('electricity'))).toBe(false);

        initRouteCache(SAMPLE_TREE, []);
        expect(searchRoutes(head, 5)).toEqual(ranked);
      });

      it('answers a query of 256 characters or fewer as written', () => {
        initRouteCache(SAMPLE_TREE, []);
        const search = vi.spyOn(Fuse.prototype, 'search');
        const query = 'gasoline '.repeat(29).slice(0, 255);
        searchRoutes(query, 5);
        expect(search.mock.calls[0]?.[0]).toBe(query);
      });

      const cpuMs = (fn: () => void): number => {
        const start = process.threadCpuUsage();
        fn();
        const used = process.threadCpuUsage(start);
        return (used.user + used.system) / 1000;
      };

      it.each([
        ['first input', (chars: number) => `${'§1 x'.repeat(chars / 4)}\ny`],
        ['second input', (chars: number) => '  \r\n'.repeat(chars / 4)],
      ])('keeps one search within its thread-CPU bound at every query length (%s)', (_, shape) => {
        const costs: number[] = [];
        for (let chars = 5_000; chars <= 320_000; chars *= 2) {
          // A fresh index for each size, so no remembered ranking answers it.
          initRouteCache(SAMPLE_TREE, []);
          const query = shape(chars);
          const cost = cpuMs(() => searchRoutes(query, 10));
          expect(cost, `${chars} characters`).toBeLessThan(25);
          costs.push(cost);
        }
        const [first, last] = [costs[0] as number, costs.at(-1) as number];
        expect(last / Math.max(first, 0.05)).toBeLessThan(256);
      });
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
    it('reports every pass pending before init', () => {
      expect(getIndexStatus()).toEqual({
        complete: false,
        incompleteRoutes: [],
        pendingPasses: ['facet_values', 'steo_series', 'seds_series'],
        size: 0,
      });
    });

    it('is complete only once every pass has landed', () => {
      initRouteCache(SAMPLE_TREE, []);
      expect(getIndexStatus().complete).toBe(false);

      markIndexPassSettled('steo_series');
      expect(getIndexStatus().pendingPasses).toEqual(['facet_values', 'seds_series']);
      expect(getIndexStatus().complete).toBe(false);

      markIndexPassSettled('facet_values');
      // Each named-series facet settles on its own: STEO landing says nothing about SEDS.
      expect(getIndexStatus().pendingPasses).toEqual(['seds_series']);
      expect(getIndexStatus().complete).toBe(false);

      markIndexPassSettled('seds_series');
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
      markIndexPassSettled('seds_series');
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

    describe('benchmark series, products, and respondents (#78)', () => {
      const freq = (id: string) => ({ id, description: id, query: id, format: 'YYYY-MM-DD' });
      const volumeFacets = [
        { id: 'duoarea', description: 'DuoArea' },
        { id: 'product', description: 'Product' },
        { id: 'process', description: 'Process' },
        { id: 'series', description: 'Series' },
      ];
      const leaf = (id: string, frequency?: RawRouteNode['frequency']): RawRouteNode => ({
        id,
        name: id,
        ...(frequency !== undefined && { frequency }),
        facets: volumeFacets,
        data: {},
      });
      const BENCHMARK_TREE: RawRouteNode[] = [
        {
          id: 'petroleum',
          name: 'Petroleum',
          routes: [
            leaf('spt', [freq('monthly'), freq('weekly'), freq('daily')]),
            leaf('wstk', { weekly: freq('weekly') }),
            leaf('sndw', [freq('four-week-average'), freq('weekly')]),
            leaf('dfp1', [freq('monthly'), freq('annual')]),
            leaf('fut', { daily: freq('daily'), monthly: freq('monthly') }),
            leaf('bare'),
          ],
        },
        {
          id: 'electricity',
          name: 'Electricity',
          routes: [
            {
              id: 'region-data',
              name: 'Hourly Demand By Region',
              frequency: [freq('hourly')],
              facets: [
                { id: 'respondent', description: 'Balancing Authority / Region' },
                { id: 'type', description: 'Type of Data' },
              ],
              data: {},
            },
            {
              id: 'daily-region-data',
              name: 'Daily Demand By Region',
              frequency: [freq('daily')],
              facets: [
                { id: 'respondent', description: 'Balancing Authority / Region' },
                { id: 'timezone', description: 'Timezone' },
              ],
              data: {},
            },
          ],
        },
        {
          id: 'densified-biomass',
          name: 'Densified Biomass',
          routes: [
            {
              // An annual survey route: its respondents are reporting plants.
              id: 'wood-pellet-plants',
              name: 'Wood Pellet Plant Capacity',
              frequency: [freq('annual')],
              facets: [
                { id: 'region', description: 'Region' },
                { id: 'respondent', description: 'Respondent' },
              ],
              data: {},
            },
          ],
        },
      ];

      it('selects series and product on every leaf listing a daily or weekly frequency, in either shape', () => {
        initRouteCache(BENCHMARK_TREE, []);
        const targets = listVocabularyFacets()
          .filter((t) => t.route.startsWith('petroleum/'))
          .map((t) => `${t.route} ${t.facetId}`)
          .sort();
        expect(targets).toEqual(
          [
            'petroleum/fut product',
            'petroleum/fut series',
            'petroleum/sndw product',
            'petroleum/sndw series',
            'petroleum/spt product',
            'petroleum/spt series',
            'petroleum/wstk product',
            'petroleum/wstk series',
          ].sort(),
        );
      });

      it('selects respondent on hourly and daily leaves, never on an annual one', () => {
        initRouteCache(BENCHMARK_TREE, []);
        const respondents = listVocabularyFacets()
          .filter((t) => t.facetId === 'respondent')
          .map((t) => t.route)
          .sort();
        expect(respondents).toEqual(['electricity/daily-region-data', 'electricity/region-data']);
      });

      it('never selects duoarea or process, on a daily or weekly leaf or any other', () => {
        initRouteCache(BENCHMARK_TREE, []);
        const ids = new Set(listVocabularyFacets().map((t) => t.facetId));
        expect(ids.has('duoarea')).toBe(false);
        expect(ids.has('process')).toBe(false);
        expect(ids.has('type')).toBe(false);
        expect(ids.has('timezone')).toBe(false);
        expect(ids.has('region')).toBe(false);
      });
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

    it('holds a described series facet to the bound too — only the warm pass indexes series whole', () => {
      initRouteCache(SAMPLE_TREE, []);
      expect(indexFacetValues('petroleum/pri/gnd', [facet('series', 201, 'Series')])).toBe(0);
      expect(indexFacetValues('petroleum/pri/gnd', [facet('series', 200, 'Series')])).toBe(200);
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

  describe('indexVocabularyFacet (#78)', () => {
    function facet(id: string, count: number, description = 'Series'): Facet {
      return {
        id,
        description,
        values: Array.from({ length: count }, (_, i) => ({ id: `V${i}`, name: `Value ${i}` })),
      };
    }

    it('returns 0 before init', () => {
      expect(indexVocabularyFacet('petroleum/pri/gnd', facet('series', 3))).toBe(0);
    });

    it('indexes a series facet whole past the bound', () => {
      initRouteCache(SAMPLE_TREE, []);
      expect(indexVocabularyFacet('petroleum/pri/gnd', facet('series', 205))).toBe(205);
      expect(getIndexSize()).toBe(6 + 205);
    });

    it('holds product, respondent, and every other facet to the bound', () => {
      initRouteCache(SAMPLE_TREE, []);
      for (const id of ['product', 'respondent', 'fueltypeid']) {
        expect(indexVocabularyFacet('petroleum/pri/gnd', facet(id, 201, id))).toBe(0);
        expect(indexVocabularyFacet('petroleum/pri/gnd', facet(id, 200, id))).toBe(200);
      }
    });

    it('builds the entry describe-time indexing builds, so a later describe adds nothing', () => {
      initRouteCache(SAMPLE_TREE, []);
      const series: Facet = {
        id: 'series',
        description: 'Series',
        values: [{ id: 'EMM_EPMR_PTE_NUS_DPG', name: 'U.S. Regular Gasoline Retail Price' }],
      };
      expect(indexVocabularyFacet('petroleum/pri/gnd', series)).toBe(1);
      expect(indexFacetValues('petroleum/pri/gnd', [series])).toBe(0);

      const [hit] = searchRoutes('Regular Gasoline Retail Price', 5).filter(
        (r) => r.entry.filter_hint,
      );
      expect(hit?.entry).toEqual({
        route: 'petroleum/pri/gnd',
        name: 'U.S. Regular Gasoline Retail Price',
        description:
          'Series value of Gasoline and Diesel (petroleum/pri/gnd) — filter with series="EMM_EPMR_PTE_NUS_DPG".',
        isLeaf: true,
        category: 'petroleum',
        filter_hint: { series: 'EMM_EPMR_PTE_NUS_DPG' },
      });
    });

    it('adds nothing for an empty facet', () => {
      initRouteCache(SAMPLE_TREE, []);
      expect(indexVocabularyFacet('petroleum/pri/gnd', facet('series', 0))).toBe(0);
      expect(indexVocabularyFacet('petroleum/pri/gnd', facet('product', 0))).toBe(0);
    });
  });

  describe('indexNamedSeries', () => {
    /** `count` distinct SEDS-shaped series values. */
    function series(count: number): Facet['values'] {
      return Array.from({ length: count }, (_, i) => ({ id: `S${i}B`, name: `Series ${i}` }));
    }

    it('returns 0 before init', () => {
      expect(indexNamedSeries('seds_series', series(3))).toBe(0);
    });

    it('indexes a SEDS series on the seds route with a seriesId filter hint', () => {
      initRouteCache(SAMPLE_TREE, []);
      expect(
        indexNamedSeries('seds_series', [
          { id: 'MGTCB', name: 'Motor gasoline total consumption' },
          { id: 'ESTXV', name: 'Electricity total end-use expenditures' },
        ]),
      ).toBe(2);

      const [hit] = searchRoutes('motor gasoline total consumption', 5);
      expect(hit?.entry).toEqual({
        route: 'seds',
        name: 'Motor gasoline total consumption',
        description: 'SEDS series: Motor gasoline total consumption (MGTCB)',
        isLeaf: true,
        category: 'seds',
        filter_hint: { seriesId: 'MGTCB' },
      });
    });

    it('keeps a same-name pair as two entries told apart by id', () => {
      initRouteCache(SAMPLE_TREE, []);
      const name = 'All petroleum products consumed by the commercial sector';
      expect(
        indexNamedSeries('seds_series', [
          { id: 'PACCB', name },
          { id: 'PACCP', name },
        ]),
      ).toBe(2);

      const hits = searchRoutes(name, 5).filter((r) => r.entry.route === 'seds');
      expect(hits.map((r) => r.entry.filter_hint)).toEqual([
        { seriesId: 'PACCB' },
        { seriesId: 'PACCP' },
      ]);
      expect(hits.map((r) => r.entry.description)).toEqual([
        `SEDS series: ${name} (PACCB)`,
        `SEDS series: ${name} (PACCP)`,
      ]);
    });

    it('indexes a facet whole past the bound that keeps every other facet out', () => {
      initRouteCache(SAMPLE_TREE, []);
      const values = series(968);
      // The same 968 values on a facet that is not allowlisted stay out...
      expect(indexFacetValues('seds', [{ id: 'seriesId', description: 'Series', values }])).toBe(0);
      // ...and the allowlisted pass takes every one of them.
      expect(indexNamedSeries('seds_series', values)).toBe(968);
      expect(getIndexSize()).toBe(6 + 968);
    });

    it('adds nothing for an empty facet, and nothing on a repeat of the same values', () => {
      initRouteCache(SAMPLE_TREE, []);
      expect(indexNamedSeries('seds_series', [])).toBe(0);
      expect(indexNamedSeries('seds_series', series(3))).toBe(3);
      expect(indexNamedSeries('seds_series', series(3))).toBe(0);
      expect(getIndexSize()).toBe(9);
    });

    it('labels STEO series as STEO, keeping an alias only when it adds to the name', () => {
      initRouteCache(SAMPLE_TREE, []);
      indexNamedSeries('steo_series', [
        { id: 'COPRPUS', name: 'Crude oil production', alias: 'U.S. crude oil production' },
        { id: 'BREPUUS', name: 'Brent crude oil spot price', alias: 'Brent crude oil spot price' },
      ]);

      const byId = new Map(
        searchRoutes('crude oil', 10).map((r) => [r.entry.filter_hint?.seriesId, r.entry]),
      );
      expect(byId.get('COPRPUS')).toMatchObject({
        route: 'steo',
        category: 'steo',
        description: 'STEO series: Crude oil production (COPRPUS) — U.S. crude oil production',
      });
      expect(byId.get('BREPUUS')?.description).toBe(
        'STEO series: Brent crude oil spot price (BREPUUS)',
      );
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
 * 5,459-entry corpus. At this size it does — `electricity price residential`
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
      // The four sector values inherit "Electricity Sales to Ultimate Customers"
      // from their route; that text weighs as one document for all four.
      expect(top?.score).toBeCloseTo(0.5621, 4);
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
      expect(top?.score).toBeCloseTo(0.3476, 4);
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

  describe('with benchmark series, products, and respondents in the index (#78)', () => {
    /** Verbatim live values from the warm-time benchmark targets. */
    beforeEach(() => {
      indexVocabularyFacet('natural-gas/pri/fut', {
        id: 'series',
        description: 'Series',
        values: [
          { id: 'RNGWHHD', name: 'Henry Hub Natural Gas Spot Price (Dollars per Million Btu)' },
          { id: 'RNGC1', name: 'Natural Gas Futures Contract 1 (Dollars per Million Btu)' },
        ],
      });
      indexVocabularyFacet('petroleum/pri/spt', {
        id: 'series',
        description: 'Series',
        values: [
          { id: 'RWTC', name: 'Cushing, OK WTI Spot Price FOB (Dollars per Barrel)' },
          { id: 'RBRTE', name: 'Europe Brent Spot Price FOB (Dollars per Barrel)' },
        ],
      });
      indexVocabularyFacet('petroleum/pri/spt', {
        id: 'product',
        description: 'Product',
        values: [
          { id: 'EPCWTI', name: 'WTI Crude Oil' },
          { id: 'EPCBRENT', name: 'UK Brent Crude Oil' },
        ],
      });
      indexVocabularyFacet('electricity/rto/region-data', {
        id: 'respondent',
        description: 'Balancing Authority / Region',
        values: [
          { id: 'ERCO', name: 'Electric Reliability Council of Texas, Inc.' },
          { id: 'CISO', name: 'California Independent System Operator' },
        ],
      });
    });

    it.each([
      ['Henry Hub', 'natural-gas/pri/fut', { series: 'RNGWHHD' }, 0.4176],
      ['WTI crude spot price', 'petroleum/pri/spt', { product: 'EPCWTI' }, 0.5621],
      ['Cushing', 'petroleum/pri/spt', { series: 'RWTC' }, 0.3985],
      [
        'Electric Reliability Council of Texas',
        'electricity/rto/region-data',
        { respondent: 'ERCO' },
        0.3239,
      ],
    ])('ranks %s on its benchmark entry below the threshold', (query, route, hint, score) => {
      const [top] = searchRoutes(query, 5);
      expect(top?.entry.route).toBe(route);
      expect(top?.entry.filter_hint).toEqual(hint);
      expect(top?.score).toBeCloseTo(score, 4);
      expect(top?.score).toBeLessThan(WEAK_MATCH_SCORE);
    });

    it('leaves the route-shaped and unanswerable probes on their side of the threshold', () => {
      const [advertised] = searchRoutes('electricity retail sales by state', 5);
      expect(advertised?.entry.route).toBe('electricity/retail-sales');
      expect(advertised?.score).toBeCloseTo(0.5617, 4);
      const [unanswerable] = searchRoutes('solar capacity by state', 5);
      expect(unanswerable?.score).toBeCloseTo(0.9474, 4);
      expect(unanswerable?.score).toBeGreaterThan(WEAK_MATCH_SCORE);
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

  /**
   * A facet-value entry's description repeats its route's title, so a weekly
   * route's 300 series made `weekly` look as common as `oil` — and "weekly crude
   * oil stocks" dropped the route titled "Weekly Stocks" below the coverage bar
   * (live: from #1 at 0.506 to outside the top 30). Text a hint entry inherits
   * from its route counts once per route; its own name still counts per entry.
   */
  it('weighs a title word that facet values inherit from their route as one document', () => {
    const survey = 'EIA petroleum gas survey data';
    const supply = 'Weekly Supply Estimates';
    initRouteCache(
      [],
      [
        entry('petroleum/stoc/wstk', 'Weekly Stocks', survey),
        entry('petroleum/stoc/cu', 'Crude Oil Stocks at Tank Farms & Pipelines', survey),
        entry('petroleum/sum/sndw', supply, survey),
        ...Array.from({ length: 300 }, (_, i) => ({
          ...entry('petroleum/sum/sndw', `Distillate Fuel Oil Supply ${i}`, ''),
          description: `Series value of ${supply} (petroleum/sum/sndw) — filter with series="S${i}".`,
          filter_hint: { series: `S${i}` },
        })),
        ...filler(60),
      ],
    );
    const results = searchRoutes('weekly crude oil stocks', 5);
    expect(results[0]?.entry).toMatchObject({
      route: 'petroleum/stoc/wstk',
      name: 'Weekly Stocks',
    });
    expect(results[0]?.entry.filter_hint).toBeUndefined();
    expect(results[0]?.score).toBeLessThan(WEAK_MATCH_SCORE);
    expect(results[1]?.entry.route).toBe('petroleum/stoc/cu');
  });
});

/**
 * #73 — a route's path segments are its identifier, and on some routes they
 * carry words its name and description do not: electricity/retail-sales is
 * named "Electricity Sales to Ultimate Customers". The STEO series named
 * "Retail Sales of Electricity in …" read like the query from their first
 * character and outranked the route the query spells.
 */
describe('a query spelling a route path (#73)', () => {
  function leaf(id: string, name: string, description: string): RawRouteNode {
    return { id, name, description, frequency: [], facets: [], data: {} };
  }

  const TREE: RawRouteNode[] = [
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
        {
          id: 'state-electricity-profiles',
          name: 'State Specific Data',
          description: 'State Specific Data',
          routes: [
            leaf(
              'source-disposition',
              'Supply and Use by State',
              'Annual supply and use by state.',
            ),
          ],
        },
      ],
    },
    leaf(
      'steo',
      'Short Term Energy Outlook',
      'Monthly short term (18 month) projections using STEO model.',
    ),
  ];

  /** STEO series that read like the slug queries from their first word. */
  const STEO_SERIES: Facet['values'] = [
    ...['Residential', 'Commercial', 'Industrial', 'Transportation', 'All Sectors'].flatMap(
      (sector) =>
        ['Mountain', 'Pacific', 'New England'].map((region, i) => ({
          id: `EL${sector.slice(0, 2).toUpperCase()}CP_${i}`,
          name: `Retail Sales of Electricity in ${sector} Sector, ${region}`,
        })),
    ),
    { id: 'SDBAL_PAC', name: 'Source Disposition Balance, Pacific' },
    { id: 'SPEPROF_US', name: 'State Electricity Profiles Summary, U.S.' },
  ];

  const SECTORS: Facet = {
    id: 'sectorid',
    description: 'Sector',
    values: [
      { id: 'RES', name: 'residential' },
      { id: 'COM', name: 'commercial' },
    ],
  };

  const RETAIL = 'electricity/retail-sales';
  const PROFILES = 'electricity/state-electricity-profiles';
  const DISPOSITION = `${PROFILES}/source-disposition`;

  /** The route entry itself — not one of the facet values pointing back at it. */
  const routeEntryRank = (query: string, route: string) =>
    searchRoutes(query, 100).findIndex(
      (r) => r.entry.route === route && r.entry.filter_hint === undefined,
    );

  beforeEach(() => {
    _resetRouteCache();
    initRouteCache(TREE, []);
    indexNamedSeries('steo_series', STEO_SERIES);
    indexFacetValues(RETAIL, [SECTORS]);
  });

  it('ranks the route first, as an exact match, for the words of its last segment', () => {
    const [top, next] = searchRoutes('retail sales', 10);

    expect(top?.entry.route).toBe(RETAIL);
    expect(top?.entry.filter_hint).toBeUndefined();
    expect(top?.score).toBe(0);
    expect(top?.score).toBeLessThan(WEAK_MATCH_SCORE);
    // The series stay in the results, ranked behind the route.
    expect(next?.entry.route).toBe('steo');
    expect(next?.score).toBeGreaterThan(0);
  });

  it('reads the slug however the query separates or cases its words', () => {
    for (const query of ['Retail Sales', 'retail   sales', 'retail-sales', ' retail_sales ']) {
      expect(searchRoutes(query, 5)[0]?.entry.route, query).toBe(RETAIL);
    }
  });

  it('matches any run of segments that ends the path, at every depth', () => {
    for (const query of [
      'source disposition',
      'state electricity profiles source disposition',
      'electricity state electricity profiles source disposition',
    ]) {
      const [top] = searchRoutes(query, 5);
      expect(top?.entry.route, query).toBe(DISPOSITION);
      expect(top?.score, query).toBe(0);
    }

    // The category the query names ranks first, ahead of the leaf below it.
    const [category] = searchRoutes('state electricity profiles', 5);
    expect(category?.entry.route).toBe(PROFILES);
    expect(category?.entry.isLeaf).toBe(false);
    expect(category?.score).toBe(0);
  });

  it('leaves a run that does not end the path, or splits a segment, to the other gates', () => {
    for (const [query, route] of [
      ['electricity retail', RETAIL],
      ['sales retail', RETAIL],
      ['electricity profiles', PROFILES],
      ['state electricity', PROFILES],
    ] as const) {
      const hit = searchRoutes(query, 100).find(
        (r) => r.entry.route === route && r.entry.filter_hint === undefined,
      );
      // Still found by the gates that read names and descriptions — just not lifted.
      expect(hit?.score, query).toBeGreaterThan(0);
    }
  });

  it('scores a one-word query exactly as the phrase path does, segment or not', () => {
    for (const query of ['steo', 'sales', 'electricity']) {
      expect(searchRoutes(query, 10)).toEqual(searchRoutes(query, 10, 'phrase'));
    }
  });

  it('lifts only the route entry, never the facet values or series beside it', () => {
    const results = searchRoutes('retail sales', 100);
    const exact = results.filter((r) => r.score === 0);

    expect(exact.map((r) => r.entry.route)).toEqual([RETAIL]);
    expect(results.filter((r) => r.entry.filter_hint !== undefined).length).toBeGreaterThan(0);
  });

  it('leaves the phrase path where it was — the lift is the combined mode alone', () => {
    expect(searchRoutes('retail sales', 5, 'phrase')[0]?.entry.route).toBe('steo');
    expect(routeEntryRank('retail sales', RETAIL)).toBe(0);
  });
});

/**
 * The warm appends facet values as each `/facet` fetch completes, so the order
 * entries reach the index varies from one warm to the next. Results that tie on
 * score — "wind" matches a Wind value on eight live routes at the same score —
 * must not inherit that order.
 */
describe('equal-score ordering', () => {
  function windValue(route: string, facetId: string): SearchIndexEntry {
    return {
      route,
      name: 'Wind',
      description: `Energy Source value of ${route} — filter with ${facetId}="WND".`,
      isLeaf: true,
      category: 'electricity',
      filter_hint: { [facetId]: 'WND' },
    };
  }

  const WIND_VALUES = [
    windValue('electricity/rto/fuel-type-data', 'fueltype'),
    windValue('electricity/facility-fuel', 'fuelType'),
    windValue('electricity/facility-fuel', 'fuel2002'),
    windValue('electricity/electric-power-operational-data', 'fueltypeid'),
    windValue('electricity/rto/daily-fuel-type-data', 'fueltype'),
  ];

  const ROUTES: SearchIndexEntry[] = [
    {
      route: 'electricity',
      name: 'Electricity',
      description: 'EIA electricity survey data',
      isLeaf: false,
      category: undefined,
    },
    {
      route: 'coal/shipments',
      name: 'Shipments',
      description: 'Coal shipments by mine and plant.',
      isLeaf: true,
      category: 'coal',
    },
  ];

  /** Fisher–Yates over a fixed seed, so the permutation is the same every run. */
  function permuted<T>(items: readonly T[], seed: number): T[] {
    const out = [...items];
    let state = seed;
    for (let i = out.length - 1; i > 0; i--) {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      const j = state % (i + 1);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  beforeEach(() => {
    _resetRouteCache();
  });

  it('ranks tied results identically whichever order their entries arrived in', () => {
    initRouteCache([], [...ROUTES, ...WIND_VALUES]);
    const forward = searchRoutes('wind', 10);

    initRouteCache([], [...ROUTES, ...[...WIND_VALUES].reverse()]);
    const reversed = searchRoutes('wind', 10);

    // Appended one at a time, as the warm's facet fetches land.
    initRouteCache([], ROUTES);
    for (const value of permuted(WIND_VALUES, 7)) addEntriesToIndex([value]);
    const trickled = searchRoutes('wind', 10);

    expect(new Set(forward.map((r) => r.score)).size).toBe(1);
    expect(reversed).toEqual(forward);
    expect(trickled).toEqual(forward);
    // The tie breaks on route path, then on the filter.
    expect(
      forward.map((r) => `${r.entry.route} ${Object.keys(r.entry.filter_hint ?? {})}`),
    ).toEqual([
      'electricity/electric-power-operational-data fueltypeid',
      'electricity/facility-fuel fuel2002',
      'electricity/facility-fuel fuelType',
      'electricity/rto/daily-fuel-type-data fueltype',
      'electricity/rto/fuel-type-data fueltype',
    ]);
  });

  it('ranks a route entry ahead of a filter-hinted entry at the same score', () => {
    const route: SearchIndexEntry = {
      route: 'renewable/wind',
      name: 'Wind',
      description: 'Wind generation.',
      isLeaf: true,
      category: 'renewable',
    };
    // Identical searchable text, so Fuse and the term gate score the two alike.
    const value: SearchIndexEntry = { ...route, filter_hint: { fueltype: 'WND' } };

    for (const order of [
      [value, route],
      [route, value],
    ]) {
      initRouteCache([], [...ROUTES, ...order]);
      const [first, second] = searchRoutes('wind generation', 5);
      expect(first?.score).toBe(second?.score);
      expect(first?.entry.filter_hint).toBeUndefined();
      expect(second?.entry.filter_hint).toEqual({ fueltype: 'WND' });
    }
  });
});
