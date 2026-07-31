/**
 * @fileoverview Additional coverage for eia_describe_route — input validation,
 * rate_limited error path, sparse upstream payload, and format edge cases.
 * @module tests/tools/describe-route-extra.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetServerConfig } from '@/config/server-config.js';
import { describeRouteTool } from '@/mcp-server/tools/definitions/describe-route.tool.js';
import * as eiaService from '@/services/eia/eia-service.js';

vi.mock('@/services/eia/eia-service.js', () => ({
  getEiaApiService: vi.fn(),
  initEiaApiService: vi.fn(),
  _resetEiaApiService: vi.fn(),
}));

const mockDescribe = vi.fn();

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
  // Facet values with more than 5 entries (format preview truncation)
  // ------------------------------------------------------------------

  it('format shows +N more for facets with many values', () => {
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
    // Under the structured cap but over the prose preview — content[] still
    // needs a retrieval path for the tail it did not print.
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
