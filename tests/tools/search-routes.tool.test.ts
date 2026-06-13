/**
 * @fileoverview Tests for the eia_search_routes tool.
 * @module tests/tools/search-routes.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchRoutesTool } from '@/mcp-server/tools/definitions/search-routes.tool.js';
import * as eiaService from '@/services/eia/eia-service.js';

vi.mock('@/services/eia/eia-service.js', () => ({
  getEiaApiService: vi.fn(),
  initEiaApiService: vi.fn(),
  _resetEiaApiService: vi.fn(),
}));

const mockSearch = vi.fn();

describe('searchRoutesTool', () => {
  beforeEach(() => {
    vi.mocked(eiaService.getEiaApiService).mockReturnValue({
      search: mockSearch,
    } as unknown as ReturnType<typeof eiaService.getEiaApiService>);
    mockSearch.mockReset();
  });

  it('returns ranked results with scores', async () => {
    mockSearch.mockResolvedValue({
      results: [
        {
          entry: {
            route: 'electricity/retail-sales',
            name: 'Retail Sales',
            description: 'Sales by state',
            isLeaf: true,
            category: 'electricity',
          },
          score: 0.05,
        },
        {
          entry: {
            route: 'electricity',
            name: 'Electricity',
            description: 'Electric power',
            isLeaf: false,
            category: undefined,
          },
          score: 0.3,
        },
      ],
      totalIndexed: 150,
    });

    const ctx = createMockContext();
    const input = searchRoutesTool.input.parse({ query: 'retail electricity' });
    const result = await searchRoutesTool.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.route).toBe('electricity/retail-sales');
    expect(result.results[0]?.score).toBe(0.05);
    expect(result.results[0]?.isLeaf).toBe(true);

    // totalIndexed moved to enrichment; truncation fields always populated
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalIndexed).toBe(150);
    expect(enrichment.effectiveQuery).toBe('retail electricity');
    // 2 results under the default cap of 10 — not truncated.
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.shown).toBe(2);
    expect(enrichment.cap).toBe(10);
  });

  it('returns empty results on no match', async () => {
    mockSearch.mockResolvedValue({ results: [], totalIndexed: 150 });

    const ctx = createMockContext();
    const input = searchRoutesTool.input.parse({ query: 'zzznomatch' });
    const result = await searchRoutesTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);

    // totalIndexed and notice in enrichment; required truncation fields still
    // populated so the effective-output parse does not reject the empty result.
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalIndexed).toBe(150);
    expect(enrichment.notice).toMatch(/No routes matched/);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.shown).toBe(0);
    expect(enrichment.cap).toBe(10);
  });

  it('flags truncation when results reach the limit', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      entry: {
        route: `electricity/r${i}`,
        name: `Route ${i}`,
        description: 'desc',
        isLeaf: true,
        category: 'electricity',
      },
      score: 0.1,
    }));
    mockSearch.mockResolvedValue({ results: entries, totalIndexed: 150 });

    const ctx = createMockContext();
    const input = searchRoutesTool.input.parse({ query: 'electricity', limit: 5 });
    await searchRoutesTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(5);
    expect(enrichment.cap).toBe(5);
    expect(enrichment.notice).toMatch(/More matches may exist/);
  });

  it('respects limit parameter', async () => {
    mockSearch.mockResolvedValue({ results: [], totalIndexed: 0 });

    const ctx = createMockContext();
    const input = searchRoutesTool.input.parse({ query: 'energy', limit: 5 });
    await searchRoutesTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledWith('energy', 5, ctx);
  });

  it('uses default limit of 10', async () => {
    mockSearch.mockResolvedValue({ results: [], totalIndexed: 0 });

    const ctx = createMockContext();
    const input = searchRoutesTool.input.parse({ query: 'energy' });
    await searchRoutesTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledWith('energy', 10, ctx);
  });

  describe('format()', () => {
    it('renders results with score and isLeaf tag', () => {
      const result = {
        results: [
          {
            route: 'petroleum/pri/gnd',
            name: 'Gasoline Prices',
            description: 'Weekly prices',
            score: 0.12,
            isLeaf: true,
          },
        ],
      };
      const blocks = searchRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('[leaf]');
      expect(text).toContain('petroleum/pri/gnd');
      expect(text).toContain('0.120');
    });

    it('renders no-results message', () => {
      const result = { results: [] };
      const blocks = searchRoutesTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('No matching routes');
    });
  });
});
