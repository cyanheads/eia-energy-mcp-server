/**
 * @fileoverview Additional coverage for eia_describe_route — input validation,
 * rate_limited error path, sparse upstream payload, and format edge cases.
 * @module tests/tools/describe-route-extra.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetServerConfig } from '@/config/server-config.js';
import { describeRouteTool } from '@/mcp-server/tools/definitions/describe-route.tool.js';
import { searchRoutesTool } from '@/mcp-server/tools/definitions/search-routes.tool.js';
import * as eiaService from '@/services/eia/eia-service.js';

vi.mock('@/services/eia/eia-service.js', () => ({
  getEiaApiService: vi.fn(),
  initEiaApiService: vi.fn(),
  _resetEiaApiService: vi.fn(),
}));

const mockDescribe = vi.fn();

const textOf = (content: readonly unknown[]): string =>
  content.map((block) => (block as { text?: string }).text ?? '').join('\n');

describe('describeRouteTool — additional coverage', () => {
  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    _resetServerConfig();
    vi.mocked(eiaService.getEiaApiService).mockReturnValue({
      describe: mockDescribe,
    } as unknown as ReturnType<typeof eiaService.getEiaApiService>);
    mockDescribe.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetServerConfig();
  });

  // ------------------------------------------------------------------
  // Input validation
  // ------------------------------------------------------------------

  describe('input validation', () => {
    it('rejects empty route string (min 1)', () => {
      expect(() => describeRouteTool.input.parse({ route: '' })).toThrow();
    });

    it('accepts a valid route string', () => {
      expect(() =>
        describeRouteTool.input.parse({ route: 'electricity/retail-sales' }),
      ).not.toThrow();
    });

    it('rejects an empty facet string (min 1)', () => {
      expect(() => describeRouteTool.input.parse({ route: 'steo', facet: '' })).toThrow();
    });

    it('rejects a negative values_offset', () => {
      expect(() => describeRouteTool.input.parse({ route: 'steo', values_offset: -1 })).toThrow();
    });

    it('rejects a fractional values_offset', () => {
      expect(() => describeRouteTool.input.parse({ route: 'steo', values_offset: 1.5 })).toThrow();
    });

    it('defaults values_offset to 0', () => {
      expect(describeRouteTool.input.parse({ route: 'steo' }).values_offset).toBe(0);
    });

    it('rejects a values_query of whitespace alone, as eia_search_routes rejects a blank query', () => {
      const message = 'values_query must contain at least one non-whitespace character';
      for (const values_query of ['', '   ', '\t\n']) {
        expect(() => describeRouteTool.input.parse({ route: 'steo', values_query })).toThrow(
          message,
        );
      }
    });

    it('trims a values_query and keeps its inner whitespace', () => {
      expect(
        describeRouteTool.input.parse({ route: 'steo', values_query: '  palo   verde ' })
          .values_query,
      ).toBe('palo   verde');
    });

    it('leaves values_query unset when omitted', () => {
      expect(describeRouteTool.input.parse({ route: 'steo' }).values_query).toBeUndefined();
    });

    it('advertises values_query with the same JSON Schema shape as the search query', () => {
      const advertised = (schema: z.ZodType, key: string) => {
        const json = z.toJSONSchema(schema, { io: 'input' }) as {
          properties: Record<string, { type?: string; minLength?: number }>;
          required?: string[];
        };
        return { ...json.properties[key], required: json.required?.includes(key) ?? false };
      };
      const valuesQuery = advertised(describeRouteTool.input, 'values_query');
      const searchQuery = advertised(searchRoutesTool.input, 'query');
      expect(valuesQuery).toMatchObject({ type: 'string', minLength: 1, required: false });
      expect({ type: valuesQuery.type, minLength: valuesQuery.minLength }).toEqual({
        type: searchQuery.type,
        minLength: searchQuery.minLength,
      });
    });

    it('rejects a whitespace values_query before asking the service for anything', async () => {
      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/facility-fuel',
        values_query: '   ',
      });

      expect(result.isError).toBe(true);
      // The schema's own message, not the strict-input rejection of an unknown key.
      expect(textOf(result.content)).toContain(
        'values_query must contain at least one non-whitespace character',
      );
      expect(mockDescribe).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // rate_limited error path
  // ------------------------------------------------------------------

  it('propagates rate_limited from service during facet fan-out', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    mockDescribe.mockRejectedValue(
      serviceUnavailable('EIA rate limit exceeded', { reason: 'rate_limited' }),
    );

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });

    await expect(describeRouteTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  // ------------------------------------------------------------------
  // Sparse upstream payload — empty facets/columns/frequencies
  // ------------------------------------------------------------------

  it('handles sparse metadata with empty facets array', async () => {
    mockDescribe.mockResolvedValue({
      route: 'steo',
      description: 'Short-Term Energy Outlook',
      facets: [],
      dataColumns: [{ id: 'value', alias: 'Value', units: '' }],
      frequencies: [{ id: 'monthly', description: 'Monthly', query: 'monthly', format: 'YYYY-MM' }],
      dateRange: { start: '2000-01', end: '2024-12' },
      defaultFrequency: 'monthly',
      defaultDateFormat: 'YYYY-MM',
    });

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'steo' });
    const result = await describeRouteTool.handler(input, ctx);

    expect(result.facets).toHaveLength(0);
    expect(result.data_columns).toHaveLength(1);
  });

  it('handles sparse metadata with empty dataColumns array', async () => {
    mockDescribe.mockResolvedValue({
      route: 'test/route',
      description: 'Test route',
      facets: [{ id: 'facetA', description: 'Facet A', values: [] }],
      dataColumns: [],
      frequencies: [],
      dateRange: { start: '', end: '' },
      defaultFrequency: '',
      defaultDateFormat: '',
    });

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'test/route' });
    const result = await describeRouteTool.handler(input, ctx);

    expect(result.data_columns).toHaveLength(0);
    expect(result.facets).toHaveLength(1);
    // Output still validates — no invented values
    expect(result.facets[0]?.values).toHaveLength(0);
  });

  it('handles route with empty dateRange strings', async () => {
    mockDescribe.mockResolvedValue({
      route: 'steo',
      description: 'STEO',
      facets: [],
      dataColumns: [],
      frequencies: [],
      dateRange: { start: '', end: '' },
      defaultFrequency: '',
      defaultDateFormat: '',
    });

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'steo' });
    const result = await describeRouteTool.handler(input, ctx);

    // Empty strings preserved — no fabrication
    expect(result.date_range.start).toBe('');
    expect(result.date_range.end).toBe('');
  });

  // ------------------------------------------------------------------
  // Facet value window rendering
  // ------------------------------------------------------------------

  it('format renders every value the output carries', () => {
    const values = Array.from({ length: 10 }, (_, i) => ({
      id: `ST${i}`,
      name: `State ${i}`,
    }));
    const result = {
      route: 'electricity/retail-sales',
      description: 'Retail sales',
      values_offset: 0,
      facets: [
        {
          id: 'stateid',
          description: 'State',
          values,
          value_count: 10,
          values_truncated: false,
        },
      ],
      data_columns: [],
      frequencies: [],
      date_range: { start: '2001-01', end: '2024-11' },
      default_frequency: 'monthly',
      default_date_format: 'YYYY-MM',
    };

    const blocks = describeRouteTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    // The window holds all 10, so nothing is stranded and nothing to page to.
    for (const v of values) expect(text).toContain(`${v.id}=${v.name}`);
    expect(text).not.toContain('more —');
  });

  it('format pages from the end of the rendered window', () => {
    const result = {
      route: 'electricity/retail-sales',
      description: 'Retail sales',
      values_offset: 0,
      facets: [
        {
          id: 'stateid',
          description: 'State',
          values: Array.from({ length: 5 }, (_, i) => ({ id: `ST${i}`, name: `State ${i}` })),
          value_count: 10,
          values_truncated: true,
        },
      ],
      data_columns: [],
      frequencies: [],
      date_range: { start: '2001-01', end: '2024-11' },
      default_frequency: 'monthly',
      default_date_format: 'YYYY-MM',
    };

    const blocks = describeRouteTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('ST4=State 4');
    expect(text).toContain('+5 more');
    expect(text).toContain('values_offset=5');
  });

  it('format renders empty facets section gracefully', () => {
    const result = {
      route: 'steo',
      description: 'STEO',
      values_offset: 0,
      facets: [],
      data_columns: [{ id: 'value', alias: 'Value', units: 'Various' }],
      frequencies: [{ id: 'monthly', description: 'Monthly', query: 'monthly', format: 'YYYY-MM' }],
      date_range: { start: '2000-01', end: '2024-12' },
      default_frequency: 'monthly',
      default_date_format: 'YYYY-MM',
    };

    const blocks = describeRouteTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('steo');
    // No facet section heading should appear when there are none
    expect(text).not.toContain('Facets (filter dimensions)');
  });

  // ------------------------------------------------------------------
  // Security: path-like injection in route param
  // ------------------------------------------------------------------

  it('passes route through to service unmodified (injection attempt still rejected by service)', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockDescribe.mockRejectedValue(notFound('Not found', { reason: 'route_not_found' }));

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    // The Zod schema only validates min(1); path-like content is forwarded to
    // the service which resolves against its route tree (no match → NotFound).
    const input = describeRouteTool.input.parse({ route: '../../etc/passwd' });

    await expect(describeRouteTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });
});
