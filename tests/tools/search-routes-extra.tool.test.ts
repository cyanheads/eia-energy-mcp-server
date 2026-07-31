/**
 * @fileoverview Additional coverage for eia_search_routes — input validation,
 * filter_hint rendering, and weak-match flag in format.
 * @module tests/tools/search-routes-extra.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchRoutesTool } from '@/mcp-server/tools/definitions/search-routes.tool.js';
import * as eiaService from '@/services/eia/eia-service.js';

vi.mock('@/services/eia/eia-service.js', () => ({
  getEiaApiService: vi.fn(),
  initEiaApiService: vi.fn(),
  _resetEiaApiService: vi.fn(),
}));

const mockSearch = vi.fn();

describe('searchRoutesTool — additional coverage', () => {
  beforeEach(() => {
    vi.mocked(eiaService.getEiaApiService).mockReturnValue({
      search: mockSearch,
    } as unknown as ReturnType<typeof eiaService.getEiaApiService>);
    mockSearch.mockReset();
  });

  // ------------------------------------------------------------------
  // Input validation
  // ------------------------------------------------------------------

  describe('input validation', () => {
    it('rejects empty query string (min 1)', () => {
      expect(() => searchRoutesTool.input.parse({ query: '' })).toThrow();
    });

    it('rejects limit = 0 (min 1)', () => {
      expect(() => searchRoutesTool.input.parse({ query: 'energy', limit: 0 })).toThrow();
    });

    it('rejects limit > 30 (max 30)', () => {
      expect(() => searchRoutesTool.input.parse({ query: 'energy', limit: 31 })).toThrow();
    });

    it('accepts limit exactly at max (30)', () => {
      expect(() => searchRoutesTool.input.parse({ query: 'energy', limit: 30 })).not.toThrow();
    });

    it('accepts limit exactly at min (1)', () => {
      expect(() => searchRoutesTool.input.parse({ query: 'energy', limit: 1 })).not.toThrow();
    });
  });

  // ------------------------------------------------------------------
  // filter_hint forwarding
  // ------------------------------------------------------------------

  it('includes filter_hint in result when entry has one', async () => {
    mockSearch.mockResolvedValue({
      results: [
        {
          entry: {
            route: 'steo',
            name: 'Crude Oil Production',
            description: 'STEO series: Crude Oil Production (COPRPUS)',
            isLeaf: true,
            category: 'steo',
            filter_hint: { seriesId: 'COPRPUS' },
          },
          score: 0.05,
        },
      ],
      totalIndexed: 1500,
    });

    const ctx = createMockContext();
    const input = searchRoutesTool.input.parse({ query: 'crude oil production' });
    const result = await searchRoutesTool.handler(input, ctx);

    expect(result.results[0]?.filter_hint).toEqual({ seriesId: 'COPRPUS' });
  });

  it('carries a facet-value hit back with its facet filter', async () => {
    mockSearch.mockResolvedValue({
      results: [
        {
          entry: {
            route: 'electricity/electric-power-operational-data',
            name: 'solar photovoltaic',
            description:
              'Energy Source value of Electric Power Operations (electricity/electric-power-operational-data) — filter with fueltypeid="SPV".',
            isLeaf: true,
            category: 'electricity',
            filter_hint: { fueltypeid: 'SPV' },
          },
          score: 0.76,
        },
      ],
      totalIndexed: 2103,
    });

    const ctx = createMockContext();
    const input = searchRoutesTool.input.parse({ query: 'solar photovoltaic generation' });
    const result = await searchRoutesTool.handler(input, ctx);

    expect(result.results[0]?.route).toBe('electricity/electric-power-operational-data');
    expect(result.results[0]?.filter_hint).toEqual({ fueltypeid: 'SPV' });

    const text = (searchRoutesTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('"fueltypeid": "SPV"');
    expect(text).toContain('eia_query_route');
  });

  it('omits filter_hint when entry does not have one', async () => {
    mockSearch.mockResolvedValue({
      results: [
        {
          entry: {
            route: 'electricity/retail-sales',
            name: 'Retail Sales',
            description: 'Retail sales by state',
            isLeaf: true,
            category: 'electricity',
          },
          score: 0.1,
        },
      ],
      totalIndexed: 150,
    });

    const ctx = createMockContext();
    const input = searchRoutesTool.input.parse({ query: 'retail sales' });
    const result = await searchRoutesTool.handler(input, ctx);

    expect('filter_hint' in (result.results[0] ?? {})).toBe(false);
  });

  // ------------------------------------------------------------------
  // format() — filter_hint and weak-match rendering
  // ------------------------------------------------------------------

  describe('format()', () => {
    it('renders filter_hint as eia_query_route call template', () => {
      const result = {
        results: [
          {
            route: 'steo',
            name: 'Crude Oil Production',
            description: 'STEO crude oil production forecast',
            score: 0.05,
            isLeaf: true,
            filter_hint: { seriesId: 'COPRPUS' },
          },
        ],
      };
      const blocks = searchRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('COPRPUS');
      expect(text).toContain('eia_query_route');
    });

    it('renders weak-match warning above the weak-match threshold', () => {
      const result = {
        results: [
          {
            route: 'coal/shipments',
            name: 'Coal Shipments',
            description: 'Coal shipment data',
            score: 0.95,
            isLeaf: true,
          },
        ],
      };
      const blocks = searchRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('weak match');
    });

    it('does not render weak-match warning at or below the weak-match threshold', () => {
      const result = {
        results: [
          {
            route: 'electricity/retail-sales',
            name: 'Retail Sales',
            description: 'Retail electricity sales',
            score: 0.1,
            isLeaf: true,
          },
        ],
      };
      const blocks = searchRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).not.toContain('weak match');
    });

    it('renders [cat] tag for non-leaf results', () => {
      const result = {
        results: [
          {
            route: 'electricity',
            name: 'Electricity',
            description: 'Electricity category',
            score: 0.2,
            isLeaf: false,
          },
        ],
      };
      const blocks = searchRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('[cat]');
    });
  });

  // ------------------------------------------------------------------
  // Edge case: unicode query
  // ------------------------------------------------------------------

  it('handles unicode query without crashing', async () => {
    mockSearch.mockResolvedValue({ results: [], totalIndexed: 100 });

    const ctx = createMockContext();
    const input = searchRoutesTool.input.parse({ query: 'électricité données' });
    const result = await searchRoutesTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
  });
});
