/**
 * @fileoverview Tests for the eia_describe_route tool.
 * @module tests/tools/describe-route.tool.test
 */

import { readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetServerConfig } from '@/config/server-config.js';
import { describeRouteTool } from '@/mcp-server/tools/definitions/describe-route.tool.js';
import * as eiaService from '@/services/eia/eia-service.js';

vi.mock('@/services/eia/eia-service.js', async (importOriginal) => ({
  // The table of lists EIA publishes partial is read as written; only the service is faked.
  partialFacetLists: (await importOriginal<typeof import('@/services/eia/eia-service.js')>())
    .partialFacetLists,
  getEiaApiService: vi.fn(),
  initEiaApiService: vi.fn(),
  _resetEiaApiService: vi.fn(),
}));

const mockDescribe = vi.fn();

const FULL_META = {
  route: 'electricity/retail-sales',
  description: 'Retail electricity sales by state and sector',
  facets: [
    {
      id: 'stateid',
      description: 'State',
      values: [
        { id: 'TX', name: 'Texas', alias: '(TX) Texas' },
        { id: 'CA', name: 'California' },
      ],
    },
  ],
  dataColumns: [
    { id: 'sales', alias: 'Electricity sales', units: 'million kilowatthours' },
    { id: 'revenue', alias: 'Revenue', units: 'million dollars' },
  ],
  frequencies: [
    { id: 'monthly', description: 'Monthly', query: 'monthly', format: 'YYYY-MM' },
    { id: 'annual', description: 'Annual', query: 'annual', format: 'YYYY' },
  ],
  dateRange: { start: '2001-01', end: '2024-11' },
  defaultFrequency: 'monthly',
  defaultDateFormat: 'YYYY-MM',
};

/** A facet with `count` values, used to exercise the output cap. */
function wideFacet(id: string, count: number) {
  return {
    id,
    description: 'State',
    values: Array.from({ length: count }, (_, i) => ({ id: `S${i}`, name: `State ${i}` })),
  };
}

describe('describeRouteTool', () => {
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

  it('returns full metadata for a leaf route', async () => {
    mockDescribe.mockResolvedValue(FULL_META);

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await describeRouteTool.handler(input, ctx);

    expect(result.route).toBe('electricity/retail-sales');
    expect(result.facets).toHaveLength(1);
    expect(result.facets[0]?.id).toBe('stateid');
    expect(result.facets[0]?.values).toHaveLength(2);
    expect(result.data_columns).toHaveLength(2);
    expect(result.frequencies).toHaveLength(2);
    expect(result.date_range.start).toBe('2001-01');
    expect(result.default_frequency).toBe('monthly');
  });

  it('preserves date_range and discloses its default-frequency context on both surfaces', async () => {
    mockDescribe.mockResolvedValue({
      ...FULL_META,
      defaultFrequency: 'weekly',
      dateRange: { start: '1986-01-03', end: '2026-10-16' },
      unfetchedFacets: ['sectorid'],
    });
    const result = await runToolContract(describeRouteTool, {
      route: 'petroleum/pri/spt',
      values_offset: 10,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      date_range: { start: '1986-01-03', end: '2026-10-16' },
      default_frequency: 'weekly',
      notice: expect.stringContaining('another frequency may extend outside'),
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('Date range (default frequency weekly)');
    expect(text).toContain('another frequency may extend outside');
    expect(text).toContain('past the last value');
    expect(text).toContain('EIA did not return the values of sectorid');
  });

  it('keeps the alias output field even when format() leaves it off the line', async () => {
    mockDescribe.mockResolvedValue(FULL_META);

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
    const result = await describeRouteTool.handler(input, ctx);

    const txValue = result.facets[0]?.values.find((v) => v.id === 'TX');
    expect(txValue?.alias).toBe('(TX) Texas');

    const caValue = result.facets[0]?.values.find((v) => v.id === 'CA');
    expect(caValue?.alias).toBeUndefined();

    // Suppressing a restating alias is a rendering choice on this one call —
    // the field a structuredContent reader gets is untouched.
    const text = (describeRouteTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('TX=Texas,');
    expect(text).not.toContain('((TX) Texas)');
  });

  it('propagates route_not_found', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockDescribe.mockRejectedValue(notFound('Not found', { reason: 'route_not_found' }));

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'bad/route' });

    await expect(describeRouteTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('propagates route_not_queryable for categories', async () => {
    const { invalidParams } = await import('@cyanheads/mcp-ts-core/errors');
    mockDescribe.mockRejectedValue(invalidParams('Not a leaf', { reason: 'route_not_queryable' }));

    const ctx = createMockContext({ errors: describeRouteTool.errors });
    const input = describeRouteTool.input.parse({ route: 'electricity' });

    await expect(describeRouteTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
  });

  // Agent-facing text describes the facet window by its behavior, not the server's configuration.
  it('names no server setting in its description, schemas, or error contract', () => {
    const texts = [
      describeRouteTool.description,
      JSON.stringify(z.toJSONSchema(describeRouteTool.input)),
      JSON.stringify(z.toJSONSchema(describeRouteTool.output)),
      ...(describeRouteTool.errors ?? []).flatMap((entry) => [entry.when, entry.recovery]),
    ];
    expect(texts.join('\n')).toContain('capped at the window size this server sets');
    for (const text of texts) expect(text).not.toMatch(/\b(?:EIA|CANVAS|MCP)_[A-Z_]+\b/);
  });

  // ------------------------------------------------------------------
  // Facet value cap and offset paging (#29)
  // ------------------------------------------------------------------

  describe('facet value cap', () => {
    it('caps values at EIA_FACET_VALUE_CAP and reports the full count', async () => {
      vi.stubEnv('EIA_FACET_VALUE_CAP', '50');
      _resetServerConfig();
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('stateid', 62)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.facets[0]?.values).toHaveLength(50);
      expect(result.facets[0]?.value_count).toBe(62);
      expect(result.facets[0]?.values_truncated).toBe(true);
      expect(result.values_offset).toBe(0);
      // The uncapped set is never mutated — the cap is a response-shaping step.
      expect(result.facets[0]?.values[0]?.id).toBe('S0');
      expect(result.facets[0]?.values[49]?.id).toBe('S49');
    });

    it('leaves a facet under the cap untruncated', async () => {
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('sectorid', 6)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.facets[0]?.values).toHaveLength(6);
      expect(result.facets[0]?.value_count).toBe(6);
      expect(result.facets[0]?.values_truncated).toBe(false);
    });

    it('honours EIA_FACET_VALUE_CAP', async () => {
      vi.stubEnv('EIA_FACET_VALUE_CAP', '3');
      _resetServerConfig();
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('stateid', 10)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.facets[0]?.values).toHaveLength(3);
      expect(result.facets[0]?.values_truncated).toBe(true);
    });

    it('pages past the cap with values_offset', async () => {
      vi.stubEnv('EIA_FACET_VALUE_CAP', '50');
      _resetServerConfig();
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('stateid', 62)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        facet: 'stateid',
        values_offset: 50,
      });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.values_offset).toBe(50);
      expect(result.facets[0]?.values).toHaveLength(12);
      expect(result.facets[0]?.values[0]?.id).toBe('S50');
      expect(result.facets[0]?.value_count).toBe(62);
      // The window now reaches the end — nothing left to page.
      expect(result.facets[0]?.values_truncated).toBe(false);
    });

    it('returns an empty window when values_offset is past the last value', async () => {
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('stateid', 10)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        facet: 'stateid',
        values_offset: 999,
      });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.facets[0]?.values).toHaveLength(0);
      expect(result.facets[0]?.value_count).toBe(10);
      // The empty window is otherwise indistinguishable from an exhausted one,
      // so the notice has to name the offset, the facet, its count, and an
      // offset that comes back with values.
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('999');
      expect(notice).toContain('stateid (10 values, last valid offset 9)');
      expect(notice).toContain('Reduce values_offset');
    });

    it('merges the notice into the surface both client families read', async () => {
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('stateid', 10)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        values_offset: 999,
      });
      const result = await describeRouteTool.handler(input, ctx);

      // ctx.enrich only reaches structuredContent and the content[] trailer when
      // the definition declares the field — populating the store is not enough.
      const enrichment = describeRouteTool.enrichment;
      expect(enrichment?.notice).toBeDefined();
      const merged = describeRouteTool.output
        .extend(enrichment as NonNullable<typeof enrichment>)
        .parse({ ...result, ...getEnrichment(ctx) });
      expect(merged.notice).toContain('last valid offset 9');
    });

    it('names every facet an offset emptied, not just the requested one', async () => {
      mockDescribe.mockResolvedValue({
        ...FULL_META,
        facets: [wideFacet('stateid', 62), wideFacet('sectorid', 6)],
      });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        values_offset: 50,
      });
      const result = await describeRouteTool.handler(input, ctx);

      // stateid still has a tail at offset 50; sectorid ran out at 6.
      expect(result.facets[0]?.values).toHaveLength(12);
      expect(result.facets[1]?.values).toHaveLength(0);
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('sectorid (6 values, last valid offset 5)');
      expect(notice).not.toContain('stateid');
    });

    it('reports only date context when every facet returned values', async () => {
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('sectorid', 6)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
      await describeRouteTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toBe(
        'date_range reports route metadata for the default frequency (monthly); another frequency may extend outside this range.',
      );
    });

    it('does not report a facet with no upstream values as an overshoot', async () => {
      mockDescribe.mockResolvedValue({
        ...FULL_META,
        facets: [{ id: 'emptyfacet', description: 'Empty', values: [] }],
      });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        values_offset: 5,
      });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.facets[0]?.value_count).toBe(0);
      expect(getEnrichment(ctx).notice).not.toContain('past the last value');
    });

    it('restricts the response to the requested facet', async () => {
      mockDescribe.mockResolvedValue({
        ...FULL_META,
        facets: [wideFacet('stateid', 62), wideFacet('sectorid', 6)],
      });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        facet: 'sectorid',
      });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.facets).toHaveLength(1);
      expect(result.facets[0]?.id).toBe('sectorid');
      // The rest of the metadata still comes back.
      expect(result.data_columns).toHaveLength(2);
      expect(result.frequencies).toHaveLength(2);
    });

    it('fails with facet_not_found for an unknown facet ID', async () => {
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('stateid', 62)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        facet: 'nosuchfacet',
      });

      await expect(describeRouteTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'facet_not_found',
          availableFacets: ['stateid'],
          recovery: { hint: expect.stringContaining('without facet') },
        },
      });
    });

    it('keeps the STEO-scale facet payload bounded', async () => {
      vi.stubEnv('EIA_FACET_VALUE_CAP', '50');
      _resetServerConfig();
      mockDescribe.mockResolvedValue({ ...FULL_META, facets: [wideFacet('seriesId', 1469)] });

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({ route: 'steo' });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.facets[0]?.values).toHaveLength(50);
      expect(result.facets[0]?.value_count).toBe(1469);
      expect(result.facets[0]?.values_truncated).toBe(true);
    });
  });

  // #59 — the service names a value list EIA did not return in unfetchedFacets;
  // the tool must not show it as a facet with value_count 0.
  describe('unavailable facets', () => {
    const PARTIAL_META = {
      ...FULL_META,
      facets: [
        wideFacet('stateid', 3),
        { id: 'sectorid', description: 'Sector', values: [] },
        { id: 'emptyfacet', description: 'Empty', values: [] },
      ],
      unfetchedFacets: ['sectorid'],
    };

    it('leaves an unavailable facet out of facets[] and names it in unavailable_facets', async () => {
      mockDescribe.mockResolvedValue(PARTIAL_META);

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({ route: 'electricity/retail-sales' });
      const result = await describeRouteTool.handler(input, ctx);

      expect(result.facets.map((f) => [f.id, f.value_count])).toEqual([
        ['stateid', 3],
        ['emptyfacet', 0],
      ]);
      expect(result.unavailable_facets).toEqual(['sectorid']);
      expect(describeRouteTool.output.parse(result)).toEqual(result);
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('EIA did not return the values of sectorid');
      expect(notice).toContain('call eia_describe_route again');

      const text = (describeRouteTool.format?.(result) ?? [])
        .map((c) => ('text' in c ? c.text : ''))
        .join('\n');
      expect(text).toContain('**Unavailable facets:** sectorid');
      expect(text).not.toContain('- **sectorid**');
      expect(text).toContain('- **emptyfacet** (0 values)');
    });

    it('carries the offset notice and the unavailable notice together', async () => {
      mockDescribe.mockResolvedValue(PARTIAL_META);

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        values_offset: 5,
      });
      await describeRouteTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('stateid (3 values, last valid offset 2)');
      expect(notice).toContain('EIA did not return the values of sectorid');
    });

    it('names the facet input to the service and reports no other facet when restricted', async () => {
      mockDescribe.mockResolvedValue(PARTIAL_META);

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const input = describeRouteTool.input.parse({
        route: 'electricity/retail-sales',
        facet: 'stateid',
      });
      const result = await describeRouteTool.handler(input, ctx);

      expect(mockDescribe).toHaveBeenCalledWith('electricity/retail-sales', ctx, {
        facet: 'stateid',
      });
      expect(result.facets.map((f) => f.id)).toEqual(['stateid']);
      expect(result).not.toHaveProperty('unavailable_facets');
      expect(getEnrichment(ctx).notice).not.toContain('sectorid');
    });

    it('sends no facet option when the input names none', async () => {
      mockDescribe.mockResolvedValue(FULL_META);

      const ctx = createMockContext({ errors: describeRouteTool.errors });
      const result = await describeRouteTool.handler(
        describeRouteTool.input.parse({ route: 'electricity/retail-sales' }),
        ctx,
      );

      expect(mockDescribe).toHaveBeenCalledWith('electricity/retail-sales', ctx, {});
      expect(result).not.toHaveProperty('unavailable_facets');
    });
  });

  // #91 — a refresh that fails serves what was cached; the service names it in
  // `stale`, and the tool keeps those lists in facets and says when each was fetched.
  describe('lists served as last fetched', () => {
    const META_AT = Date.parse('2026-10-02T09:00:00Z');
    const STALE_META = {
      ...FULL_META,
      fetchedAt: META_AT,
      facets: [
        { ...wideFacet('stateid', 3), fetchedAt: Date.parse('2026-10-01T09:00:00Z') },
        { ...wideFacet('sectorid', 2), fetchedAt: Date.parse('2026-09-30T18:30:00Z') },
        { ...wideFacet('fresh', 1), fetchedAt: META_AT },
      ],
      stale: {
        route: false,
        facets: [
          { id: 'stateid', fetchedAt: Date.parse('2026-10-01T09:00:00Z') },
          { id: 'sectorid', fetchedAt: Date.parse('2026-09-30T18:30:00Z') },
        ],
      },
    };
    const RETRY = 'The next eia_describe_route call retries the refresh.';
    const noticeOf = (r: Awaited<ReturnType<typeof runToolContract>>) =>
      (r.structuredContent as { notice: string }).notice;
    const textOf = (r: Awaited<ReturnType<typeof runToolContract>>) =>
      r.content.map((c) => ('text' in c ? c.text : '')).join('\n');

    it('keeps stale lists in facets and names each with its fetch time, on both surfaces', async () => {
      mockDescribe.mockResolvedValue(STALE_META);

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/retail-sales',
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        facets: [
          { id: 'stateid', value_count: 3 },
          { id: 'sectorid', value_count: 2 },
          { id: 'fresh', value_count: 1 },
        ],
      });
      expect(result.structuredContent).not.toHaveProperty('unavailable_facets');
      const expected = `EIA did not answer the refresh of the value lists of stateid (fetched 2026-10-01T09:00:00Z), sectorid (fetched 2026-09-30T18:30:00Z), so they are served as last fetched and may lack values EIA has added since. ${RETRY}`;
      expect(noticeOf(result).endsWith(` ${expected}`)).toBe(true);
      expect(textOf(result)).toContain(expected);
    });

    it('names only the requested facet when the input restricts to one', async () => {
      mockDescribe.mockResolvedValue(STALE_META);

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/retail-sales',
        facet: 'sectorid',
      });

      const expected = `EIA did not answer the refresh of the value list of sectorid (fetched 2026-09-30T18:30:00Z), so it is served as last fetched and may lack values EIA has added since. ${RETRY}`;
      expect(noticeOf(result).endsWith(` ${expected}`)).toBe(true);
      expect(noticeOf(result)).not.toContain('stateid');
    });

    it('says nothing of staleness when the requested facet is current', async () => {
      mockDescribe.mockResolvedValue(STALE_META);

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/retail-sales',
        facet: 'fresh',
      });

      expect(noticeOf(result)).not.toContain('refresh');
    });

    it('names the whole entry when the route metadata refresh failed, and any older list', async () => {
      mockDescribe.mockResolvedValue({
        ...STALE_META,
        stale: { route: true, facets: [STALE_META.stale.facets[1]] },
      });

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/retail-sales',
      });

      const expected = `EIA did not answer the refresh of this route, so the description cached at 2026-10-02T09:00:00Z is served as it stood; date_range, frequencies, data columns, and facet values may have changed since. EIA did not answer the refresh of the value list of sectorid (fetched 2026-09-30T18:30:00Z), so it is served as last fetched and may lack values EIA has added since. ${RETRY}`;
      expect(noticeOf(result).endsWith(` ${expected}`)).toBe(true);
      expect(textOf(result)).toContain(expected);
    });

    it('adds no staleness notice to a current entry', async () => {
      mockDescribe.mockResolvedValue({ ...FULL_META, fetchedAt: META_AT });

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/retail-sales',
      });

      expect(noticeOf(result)).not.toContain('refresh');
    });
  });

  // #98 — a column whose metadata names no unit points at the row field its
  // unit is in when a row has one. #100 — the lists EIA publishes partial are
  // named as such.
  describe('notices drawn from the route metadata', () => {
    const noticeOf = (r: Awaited<ReturnType<typeof runToolContract>>) =>
      (r.structuredContent as { notice: string }).notice;
    const textOf = (r: Awaited<ReturnType<typeof runToolContract>>) =>
      r.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    const DATE =
      'date_range reports route metadata for the default frequency (monthly); another frequency may extend outside this range.';

    /** `international` as the service returns it: a synthesized value column, six facets. */
    const INTL_META = {
      ...FULL_META,
      route: 'international',
      description: 'Country level production, consumption, imports, exports by energy source',
      facets: [
        {
          id: 'productId',
          description: 'Product',
          values: [
            { id: '5', name: 'Petroleum and other liquids' },
            { id: '57', name: 'Crude oil including lease condensate' },
          ],
        },
        {
          id: 'activityId',
          description: 'Activity',
          values: [
            { id: '1', name: 'Production' },
            { id: '2', name: 'Consumption' },
          ],
        },
        {
          id: 'countryRegionId',
          description: 'Country/Region',
          values: [
            { id: 'USA', name: 'United States' },
            { id: 'CHN', name: 'China' },
            { id: 'FRA', name: 'France' },
          ],
        },
        {
          id: 'dataFlagId',
          description: 'Data flag ID',
          // Whole upstream but for a null ID, so the service marks it incomplete.
          complete: false,
          values: [{ id: '6', name: 'A value exists, but cannot be published' }],
        },
        {
          id: 'unit',
          description: 'Unit',
          values: [
            { id: 'MBBL', name: 'millions barrels' },
            { id: 'TBPD', name: 'thousand barrels per day' },
          ],
        },
      ],
      dataColumns: [{ id: 'value', alias: 'Value', units: '', synthesized: true }],
    };
    const PARTIAL =
      'EIA lists only part of the values of productId, activityId, unit: the lists hold the IDs of the monthly and quarterly series, and rows at other frequencies can carry IDs they omit. An ID missing from them still filters eia_query_route; a query without that filter returns the IDs rows carry, each beside its label in productName, activityName, unitName.';
    const SYNTHESIZED =
      'Data column value has no unit in the route metadata; each eia_query_route row carries the unit, which can differ by row, in a field named units or unit.';

    /** `electricity/facility-fuel`'s seven columns as EIA's metadata gives them. */
    const FF_META = {
      ...FULL_META,
      route: 'electricity/facility-fuel',
      description: 'Facility-level fuel consumption and generation',
      facets: [
        {
          id: 'plantCode',
          description: 'Plant',
          // Whole upstream, but one ID listed twice: incomplete, not partial.
          complete: false,
          values: [
            { id: '3', name: 'Barry' },
            { id: '3', name: 'Barry (former)' },
          ],
        },
      ],
      dataColumns: [
        { id: 'generation', alias: 'Net Generation', units: 'megawatthours' },
        { id: 'gross-generation', alias: 'Gross Generation', units: 'megawatthours' },
        {
          id: 'total-consumption',
          alias:
            'Consumption of Fuels for Electricity Generation and Useful Thermal Output (Physical Units)',
          units: '',
        },
        {
          id: 'total-consumption-btu',
          alias: 'Consumption of Fuels for Electricity Generation and Useful Thermal Output (BTUs)',
          units: 'MMBtu',
        },
        {
          id: 'consumption-for-eg',
          alias: 'Consumption of Fuels for Electricity Generation (Physical Units)',
          units: '',
        },
        {
          id: 'consumption-for-eg-btu',
          alias: 'Consumption of Fuels for Electricity Generation (BTUs)',
          units: 'MMBtu',
        },
        { id: 'average-heat-content', alias: 'Average Heat Content of Consumed Fuels', units: '' },
      ],
    };
    const NAMED =
      'Data columns total-consumption, consumption-for-eg, average-heat-content have no unit in the route metadata. Where an eia_query_route row carries a unit for one of them, it is in total-consumption-units, consumption-for-eg-units, average-heat-content-units, and it can differ by row; a column whose rows carry no such field has no unit.';

    it('names each list EIA publishes partial and the field labelling its IDs, on both surfaces', async () => {
      mockDescribe.mockResolvedValue(INTL_META);

      const result = await runToolContract(describeRouteTool, { route: 'international' });

      expect(result.isError).not.toBe(true);
      expect(noticeOf(result)).toContain(PARTIAL);
      expect(textOf(result)).toContain(PARTIAL);
      // An incomplete list is not a partial one: the disclosure reads the table.
      expect(noticeOf(result)).not.toContain('dataFlagId');
      expect(noticeOf(result)).not.toContain('countryRegionId');
    });

    it('names only the requested facet when the input restricts to one', async () => {
      mockDescribe.mockResolvedValue(INTL_META);

      const unit = await runToolContract(describeRouteTool, {
        route: 'international',
        facet: 'unit',
      });
      expect(noticeOf(unit)).toContain(
        'EIA lists only part of the values of unit: the list holds the IDs of the monthly and quarterly series, and rows at other frequencies can carry IDs it omits. An ID missing from it still filters eia_query_route; a query without that filter returns the IDs rows carry, each beside its label in unitName.',
      );

      const country = await runToolContract(describeRouteTool, {
        route: 'international',
        facet: 'countryRegionId',
      });
      expect(noticeOf(country)).not.toContain('EIA lists only part');
    });

    it('leaves a partial list EIA did not return to the unavailable notice', async () => {
      mockDescribe.mockResolvedValue({ ...INTL_META, unfetchedFacets: ['productId'] });

      const result = await runToolContract(describeRouteTool, { route: 'international' });

      expect(noticeOf(result)).toContain(
        'EIA lists only part of the values of activityId, unit: the lists hold',
      );
      expect(noticeOf(result)).toContain('each beside its label in activityName, unitName.');
      expect(noticeOf(result)).toContain('EIA did not return the values of productId');
    });

    it('keys the partial lists on the route, not on facet IDs another route shares', async () => {
      mockDescribe.mockResolvedValue({ ...INTL_META, route: 'ieo/2023' });

      const result = await runToolContract(describeRouteTool, { route: 'ieo/2023' });

      expect(noticeOf(result)).not.toContain('EIA lists only part');
    });

    it('names the {col}-units field of each column the metadata gives no unit, on both surfaces', async () => {
      mockDescribe.mockResolvedValue(FF_META);

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/facility-fuel',
      });

      expect(noticeOf(result)).toBe(`${DATE} ${NAMED}`);
      expect(textOf(result)).toContain(`> ${DATE} ${NAMED}`);
      // The column lines render as before; the notice carries the pointer.
      expect(textOf(result)).toContain(
        '- **average-heat-content** (Average Heat Content of Consumed Fuels) — \n',
      );
      expect(textOf(result)).toContain('- **generation** (Net Generation) — megawatthours');
    });

    /**
     * `electricity/operating-generator-capacity`'s twelve columns as EIA's
     * metadata gives them. The seven without units are dates, a county, and
     * coordinates: their rows carry no `{col}-units` field (the only one is
     * `nameplate-capacity-mw-units`), so the metadata omitting `units` reads
     * the same as on facility-fuel while the rows do not.
     */
    const OGC_META = {
      ...FULL_META,
      route: 'electricity/operating-generator-capacity',
      description: 'Inventory of operating generators',
      facets: [],
      dataColumns: [
        { id: 'nameplate-capacity-mw', alias: 'Nameplate Capacity', units: 'MW' },
        { id: 'net-summer-capacity-mw', alias: 'Net Summer Capacity', units: 'MW' },
        { id: 'net-winter-capacity-mw', alias: 'Net Winter Capacity', units: 'MW' },
        { id: 'operating-year-month', alias: 'Operating Date (Year and Month)', units: '' },
        {
          id: 'planned-retirement-year-month',
          alias: 'Planned Retirement Date (Year and Month)',
          units: '',
        },
        {
          id: 'planned-derate-year-month',
          alias: 'Planned Derate Date (Year and Month)',
          units: '',
        },
        {
          id: 'planned-derate-summer-cap-mw',
          alias: 'Magnitude of Planned Derate (Summer Capacity)',
          units: 'MW',
        },
        {
          id: 'planned-uprate-year-month',
          alias: 'Planned Uprate Date (Year and Month)',
          units: '',
        },
        {
          id: 'planned-uprate-summer-cap-mw',
          alias: 'Magnitude of Planned Uprate (Summer Capacity)',
          units: 'MW',
        },
        { id: 'county', alias: 'County', units: '' },
        { id: 'longitude', alias: 'Longitude', units: '' },
        { id: 'latitude', alias: 'Latitude', units: '' },
      ],
    };
    const DESCRIPTORS =
      'Data columns operating-year-month, planned-retirement-year-month, planned-derate-year-month, planned-uprate-year-month, county, longitude, latitude have no unit in the route metadata. Where an eia_query_route row carries a unit for one of them, it is in operating-year-month-units, planned-retirement-year-month-units, planned-derate-year-month-units, planned-uprate-year-month-units, county-units, longitude-units, latitude-units, and it can differ by row; a column whose rows carry no such field has no unit.';

    it('does not say rows carry a unit field for descriptor columns with no unit, on both surfaces', async () => {
      mockDescribe.mockResolvedValue(OGC_META);

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/operating-generator-capacity',
      });

      expect(result.isError).not.toBe(true);
      expect(noticeOf(result)).toBe(`${DATE} ${DESCRIPTORS}`);
      expect(textOf(result)).toContain(`> ${DATE} ${DESCRIPTORS}`);
      expect(noticeOf(result)).not.toContain('each eia_query_route row carries the unit');
      expect(textOf(result)).not.toContain('each eia_query_route row carries the unit');
    });

    it('offers units or unit, naming neither, for the column synthesized from { value: [] }', async () => {
      mockDescribe.mockResolvedValue({ ...INTL_META, route: 'steo', facets: [] });

      const result = await runToolContract(describeRouteTool, { route: 'steo' });

      expect(noticeOf(result)).toBe(`${DATE} ${SYNTHESIZED}`);
      expect(textOf(result)).toContain(SYNTHESIZED);
      // The marker stays in the service: data_columns keeps its three fields.
      expect(
        JSON.stringify((result.structuredContent as { data_columns: unknown }).data_columns),
      ).toBe(JSON.stringify([{ id: 'value', alias: 'Value', units: '' }]));
    });

    it('points a named value column with no unit at value-units, not at units or unit', async () => {
      mockDescribe.mockResolvedValue({
        ...FULL_META,
        dataColumns: [{ id: 'value', alias: 'Value', units: '' }],
      });

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/retail-sales',
      });

      expect(noticeOf(result)).toBe(
        `${DATE} Data column value has no unit in the route metadata. Where an eia_query_route row carries a unit for it, it is in value-units, and it can differ by row; a column whose rows carry no such field has no unit.`,
      );
    });

    it.each([
      ['crude-oil-imports', [{ id: 'quantity', alias: 'quantity', units: 'thousand barrels' }]],
      [
        'co2-emissions/co2-emissions-aggregates',
        [{ id: 'value', alias: 'value', units: 'million metric tons of CO2' }],
      ],
    ])(
      'adds no unit notice on %s, whose every column names its unit',
      async (route, dataColumns) => {
        mockDescribe.mockResolvedValue({ ...FULL_META, route, dataColumns });

        const result = await runToolContract(describeRouteTool, { route });

        expect(noticeOf(result)).toBe(DATE);
      },
    );

    it('joins every notice one call raises into one, in the order the response reads', async () => {
      const fetchedAt = Date.parse('2026-10-01T09:00:00Z');
      mockDescribe.mockResolvedValue({
        ...INTL_META,
        stale: { route: false, facets: [{ id: 'countryRegionId', fetchedAt }] },
      });

      const result = await runToolContract(describeRouteTool, {
        route: 'international',
        values_offset: 2,
      });

      const expected = [
        DATE,
        SYNTHESIZED,
        PARTIAL,
        "values_offset 2 is past the last value of productId (2 values, last valid offset 1), activityId (2 values, last valid offset 1), dataFlagId (1 values, last valid offset 0), unit (2 values, last valid offset 1). Reduce values_offset to at most that facet's last valid offset, or pass facet to page one facet at a time so a shared offset stops emptying the narrower ones.",
        'EIA did not answer the refresh of the value list of countryRegionId (fetched 2026-10-01T09:00:00Z), so it is served as last fetched and may lack values EIA has added since. The next eia_describe_route call retries the refresh.',
      ].join(' ');
      expect(noticeOf(result)).toBe(expected);
      expect(result.content.at(-1)).toEqual({ type: 'text', text: `\n\n> ${expected}` });
    });

    it('says in the units description what an empty string means', () => {
      const schema = z.toJSONSchema(describeRouteTool.output, { io: 'output' });
      expect(schema).toMatchObject({
        properties: {
          data_columns: {
            items: {
              properties: {
                units: {
                  description: expect.stringContaining(
                    'An empty string means the route metadata names no unit',
                  ),
                },
              },
            },
          },
        },
      });
      // No field joins the column shape.
      const columns = schema.properties?.data_columns as {
        items: { properties: { units: { description: string } } };
      };
      expect(Object.keys(columns.items.properties)).toEqual(['id', 'alias', 'units']);
      // A descriptor column's rows carry no unit field, so the field is not promised.
      expect(columns.items.properties.units.description).toContain(
        'a column whose rows have no such field has no unit',
      );
      expect(columns.items.properties.units.description).not.toContain(
        'names the field each eia_query_route row carries it in',
      );
    });
  });

  describe('format()', () => {
    it('renders all required fields including query and alias', () => {
      const result = {
        route: 'electricity/retail-sales',
        description: 'Retail electricity sales',
        values_offset: 0,
        facets: [
          {
            id: 'stateid',
            description: 'State',
            values: [{ id: 'TX', name: 'Texas', alias: 'Region: (TX) Texas' }],
            value_count: 1,
            values_truncated: false,
          },
        ],
        data_columns: [{ id: 'sales', alias: 'Sales', units: 'MWh' }],
        frequencies: [
          { id: 'monthly', description: 'Monthly', query: 'monthly', format: 'YYYY-MM' },
        ],
        date_range: { start: '2001-01', end: '2024-11' },
        default_frequency: 'monthly',
        default_date_format: 'YYYY-MM',
      };

      const blocks = describeRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('electricity/retail-sales');
      expect(text).toContain('query: monthly');
      expect(text).toContain('TX=Texas (Region: (TX) Texas)');
      expect(text).toContain('sales');
      expect(text).toContain('MWh');
      expect(text).toContain('1 values');
    });

    it('renders the whole window and names the next call past it', () => {
      const result = {
        route: 'electricity/retail-sales',
        description: 'Retail electricity sales',
        values_offset: 0,
        facets: [
          {
            id: 'stateid',
            description: 'State',
            values: Array.from({ length: 50 }, (_, i) => ({ id: `S${i}`, name: `State ${i}` })),
            value_count: 62,
            values_truncated: true,
          },
        ],
        data_columns: [],
        frequencies: [],
        date_range: { start: '', end: '' },
        default_frequency: '',
        default_date_format: '',
      };

      const blocks = describeRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;

      // Every value the output carries is rendered, so the hint resumes where
      // the structured window stops — one next call, not two.
      expect(text).toContain('S0=State 0');
      expect(text).toContain('S49=State 49');
      expect(text).toContain('+12 more');
      expect(text).toContain('values_offset=50');
      expect(text).not.toContain('values_offset=5)');
      expect(text).toContain('facet="stateid"');
      expect(text).toContain('50 of 62 values from offset 0');
    });

    it('carries the requested offset into the next-call hint', () => {
      const result = {
        route: 'steo',
        description: 'STEO',
        values_offset: 50,
        facets: [
          {
            id: 'seriesId',
            description: 'Series',
            values: Array.from({ length: 50 }, (_, i) => ({ id: `X${i}`, name: `Series ${i}` })),
            value_count: 1469,
            values_truncated: true,
          },
        ],
        data_columns: [],
        frequencies: [],
        date_range: { start: '', end: '' },
        default_frequency: '',
        default_date_format: '',
      };

      const blocks = describeRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('values_offset=100');
      expect(text).toContain('+1369 more');
    });

    it('renders a facet under the cap whole, with nothing left to page', () => {
      const result = {
        route: 'electricity/retail-sales',
        description: 'Retail electricity sales',
        values_offset: 0,
        facets: [
          {
            id: 'sectorid',
            description: 'Sector',
            values: Array.from({ length: 6 }, (_, i) => ({ id: `SEC${i}`, name: `Sector ${i}` })),
            value_count: 6,
            values_truncated: false,
          },
        ],
        data_columns: [],
        frequencies: [],
        date_range: { start: '', end: '' },
        default_frequency: '',
        default_date_format: '',
      };

      const blocks = describeRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('SEC5=Sector 5');
      expect(text).toContain('6 values');
      expect(text).not.toContain('more —');
      expect(text).not.toContain('values_offset=');
    });

    it('renders an emptied facet without a dangling em dash', () => {
      const result = {
        route: 'electricity/retail-sales',
        description: 'Retail electricity sales',
        values_offset: 500,
        facets: [
          {
            id: 'sectorid',
            description: 'Sector',
            values: [],
            value_count: 6,
            values_truncated: false,
          },
        ],
        data_columns: [],
        frequencies: [],
        date_range: { start: '', end: '' },
        default_frequency: '',
        default_date_format: '',
      };

      const blocks = describeRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('- **sectorid** (0 of 6 values from offset 500): Sector');

      const facetLine = text.split('\n').find((l) => l.startsWith('- **sectorid**'));
      expect(facetLine).toBeDefined();
      expect(facetLine).not.toMatch(/—\s*$/);
      expect(facetLine).not.toContain('—');
    });

    it('quotes a blank identifier so the value stays visible and copyable', () => {
      const result = {
        route: 'electricity/facility-fuel',
        description: 'Facility fuel',
        values_offset: 0,
        facets: [
          {
            id: 'primeMover',
            description: 'Prime Mover',
            values: [
              { id: 'FW', name: 'FW' },
              { id: ' ', name: ' ' },
              { id: 'PV', name: 'PV' },
            ],
            value_count: 3,
            values_truncated: false,
          },
        ],
        data_columns: [],
        frequencies: [],
        date_range: { start: '', end: '' },
        default_frequency: '',
        default_date_format: '',
      };

      const blocks = describeRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      const facetLine = text.split('\n').find((l) => l.startsWith('- **primeMover**'));

      // Printed raw, the blank collapses into the comma joiner and the value
      // is indistinguishable from spacing — a content[]-only reader cannot
      // tell it exists or what to filter with.
      expect(facetLine).toContain('" "=" "');
      expect(facetLine).not.toContain('FW,  = , PV');
      // Every other value is non-blank and must print unquoted.
      expect(facetLine).toContain('FW=FW');
      expect(facetLine).toContain('PV=PV');
      expect(facetLine).not.toContain('"FW"');
    });

    it('reports the last page as a window, not as the whole value set', () => {
      const result = {
        route: 'steo',
        description: 'STEO',
        values_offset: 1450,
        facets: [
          {
            id: 'seriesId',
            description: 'Series',
            values: Array.from({ length: 19 }, (_, i) => ({ id: `X${i}`, name: `Series ${i}` })),
            value_count: 1469,
            // The window reaches the end, so nothing is truncated — but it
            // still starts at 1450 and holds 19 of 1469.
            values_truncated: false,
          },
        ],
        data_columns: [],
        frequencies: [],
        date_range: { start: '', end: '' },
        default_frequency: '',
        default_date_format: '',
      };

      const blocks = describeRouteTool.format!(result);
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('19 of 1469 values from offset 1450');
      expect(text).not.toContain('(1469 values)');
    });

    // ----------------------------------------------------------------
    // Alias rendering (#46)
    // ----------------------------------------------------------------

    describe('alias rendering', () => {
      /** Renders one facet holding `values`, and returns just its line. */
      function facetLine(values: Array<{ id: string; name: string; alias?: string }>) {
        const blocks = describeRouteTool.format!({
          route: 'electricity/retail-sales',
          description: 'Retail electricity sales',
          values_offset: 0,
          facets: [
            {
              id: 'stateid',
              description: 'State / Census Region',
              values,
              value_count: values.length,
              values_truncated: false,
            },
          ],
          data_columns: [],
          frequencies: [],
          date_range: { start: '', end: '' },
          default_frequency: '',
          default_date_format: '',
        });
        const text = (blocks[0] as { text: string }).text;
        const line = text.split('\n').find((l) => l.startsWith('- **stateid**'));
        expect(line).toBeDefined();
        return line as string;
      }

      it('drops the `(id) name` alias EIA generates for most facet values', () => {
        expect(
          facetLine([
            { id: 'IN', name: 'Indiana', alias: '(IN) Indiana' },
            { id: 'OTH', name: 'other', alias: '(OTH) other' },
          ]),
        ).toBe('- **stateid** (2 values): State / Census Region — IN=Indiana, OTH=other');
      });

      it('keeps an alias that prefixes a class the pair does not name', () => {
        // Both of these contain the exact `(id) name` string the restating
        // aliases are, so a substring test drops precisely the informative ones.
        expect(
          facetLine([
            { id: 'MAT', name: 'Middle Atlantic', alias: 'Region: (MAT) Middle Atlantic' },
            { id: 'TEX', name: 'Texas', alias: 'PJM: (TEX) Texas' },
          ]),
        ).toBe(
          '- **stateid** (2 values): State / Census Region — MAT=Middle Atlantic (Region: (MAT) Middle Atlantic), TEX=Texas (PJM: (TEX) Texas)',
        );
      });

      it('keeps an alias that qualifies the pair it restates', () => {
        expect(
          facetLine([
            {
              id: 'US',
              name: 'U.S. Total',
              alias: 'Total: (US) United States (not including territory data)',
            },
          ]),
        ).toBe(
          '- **stateid** (1 values): State / Census Region — US=U.S. Total (Total: (US) United States (not including territory data))',
        );
      });

      it('drops an alias equal to the name on its own', () => {
        expect(
          facetLine([
            { id: 'TOT', name: 'All sectors', alias: 'All sectors' },
            { id: 'EU', name: 'Electric Utilities', alias: 'Electric Utilities' },
          ]),
        ).toBe(
          '- **stateid** (2 values): State / Census Region — TOT=All sectors, EU=Electric Utilities',
        );
      });

      it('matches the restatement ignoring case and surrounding whitespace', () => {
        expect(facetLine([{ id: 'IN', name: 'Indiana', alias: '  (in) INDIANA  ' }])).toBe(
          '- **stateid** (1 values): State / Census Region — IN=Indiana',
        );
      });

      it('renders both classes side by side within one facet', () => {
        const line = facetLine([
          { id: 'MAT', name: 'Middle Atlantic', alias: 'Region: (MAT) Middle Atlantic' },
          { id: 'IN', name: 'Indiana', alias: '(IN) Indiana' },
          { id: 'CA', name: 'California' },
        ]);

        expect(line).toContain('MAT=Middle Atlantic (Region: (MAT) Middle Atlantic)');
        expect(line).toContain('IN=Indiana,');
        expect(line).not.toContain('((IN) Indiana)');
        // A value EIA supplies no alias for is unaffected either way.
        expect(line).toMatch(/CA=California$/);
      });
    });
  });

  describe('values_query', () => {
    const META = {
      ...FULL_META,
      description: 'Retail',
      facets: [wideFacet('stateid', 10), wideFacet('sectorid', 2)],
      dataColumns: [],
      frequencies: [],
    };

    it('leaves a call without values_query byte-identical on both surfaces', async () => {
      vi.stubEnv('EIA_FACET_VALUE_CAP', '3');
      _resetServerConfig();
      mockDescribe.mockResolvedValue(META);

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/retail-sales',
        values_offset: 2,
      });

      const notice =
        "date_range reports route metadata for the default frequency (monthly); another frequency may extend outside this range. values_offset 2 is past the last value of sectorid (2 values, last valid offset 1). Reduce values_offset to at most that facet's last valid offset, or pass facet to page one facet at a time so a shared offset stops emptying the narrower ones.";
      // Key order is part of the bytes a client receives, so the comparison is
      // on the serialized object, not a deep-equal that ignores order.
      expect(JSON.stringify(result.structuredContent)).toBe(
        JSON.stringify({
          route: 'electricity/retail-sales',
          description: 'Retail',
          facets: [
            {
              id: 'stateid',
              description: 'State',
              values: [
                { id: 'S2', name: 'State 2' },
                { id: 'S3', name: 'State 3' },
                { id: 'S4', name: 'State 4' },
              ],
              value_count: 10,
              values_truncated: true,
            },
            {
              id: 'sectorid',
              description: 'State',
              values: [],
              value_count: 2,
              values_truncated: false,
            },
          ],
          values_offset: 2,
          data_columns: [],
          frequencies: [],
          date_range: { start: '2001-01', end: '2024-11' },
          default_frequency: 'monthly',
          default_date_format: 'YYYY-MM',
          notice,
        }),
      );
      expect(result.content).toEqual([
        {
          type: 'text',
          text: '## electricity/retail-sales\n\nRetail\n\n**Date range (default frequency monthly):** 2001-01 → 2024-11\n**Default frequency:** monthly (format: YYYY-MM)\n\n### Facets (filter dimensions)\n- **stateid** (3 of 10 values from offset 2): State — S2=State 2, S3=State 3, S4=State 4 (+5 more — eia_describe_route(route="electricity/retail-sales", facet="stateid", values_offset=5))\n- **sectorid** (0 of 2 values from offset 2): State',
        },
        { type: 'text', text: `\n\n> ${notice}` },
      ]);
    });

    /**
     * A plant facet shaped like `electricity/facility-fuel`'s `plantCode`: the
     * two Palo Verde entries sit past the first 50-value window, so a match
     * found here was read from the full cached list, not from a window.
     */
    function plantFacet() {
      const filler = Array.from({ length: 120 }, (_, i) => ({
        id: String(1000 + i),
        name: `Plant ${i}`,
      }));
      return {
        id: 'plantCode',
        description: 'Plant',
        values: [
          ...filler.slice(0, 58),
          { id: '6008', name: 'Palo Verde' },
          ...filler.slice(58, 101),
          { id: '57773', name: 'Palo Verde College' },
          ...filler.slice(101),
        ],
      };
    }

    const textOf = (content: readonly unknown[]): string =>
      content.map((block) => (block as { text?: string }).text ?? '').join('\n');

    it('narrows a facet to the values containing the query, keeping value_count as the facet total', async () => {
      const plants = plantFacet();
      mockDescribe.mockResolvedValue({ ...META, facets: [plants] });

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/facility-fuel',
        facet: 'plantCode',
        values_query: 'palo verde',
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        values_offset: 0,
        values_query: 'palo verde',
        facets: [
          {
            id: 'plantCode',
            values: [
              { id: '6008', name: 'Palo Verde' },
              { id: '57773', name: 'Palo Verde College' },
            ],
            value_count: 122,
            values_matched: 2,
            values_truncated: false,
          },
        ],
      });
      const text = textOf(result.content);
      expect(text).toContain('**Values query:** "palo verde"');
      expect(text).toContain(
        '- **plantCode** (2 of 2 matching values from offset 0; 122 values in all): Plant — 6008=Palo Verde, 57773=Palo Verde College',
      );
      expect(text).not.toContain('more —');
      // The match reads the cached list; it neither asks the service for more
      // nor filters what the cache holds.
      expect(mockDescribe).toHaveBeenCalledTimes(1);
      expect(mockDescribe.mock.calls[0]?.[2]).toEqual({ facet: 'plantCode' });
      expect(plants.values).toHaveLength(122);
    });

    it('echoes the query as trimmed', async () => {
      mockDescribe.mockResolvedValue({ ...META, facets: [plantFacet()] });

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/facility-fuel',
        values_query: '  Palo Verde College ',
      });

      expect(result.structuredContent).toMatchObject({
        values_query: 'Palo Verde College',
        facets: [{ values: [{ id: '57773' }], values_matched: 1 }],
      });
      expect(textOf(result.content)).toContain('**Values query:** "Palo Verde College"');
    });

    it.each([
      ['a name, ignoring case', 'PALO verde', ['6008', '57773']],
      ['an id', '6008', ['6008']],
      ['an alias the id and name do not contain', 'region:', ['MAT']],
    ])('matches %s', async (_label, values_query, ids) => {
      mockDescribe.mockResolvedValue({
        ...META,
        facets: [
          {
            ...plantFacet(),
            values: [
              ...plantFacet().values,
              { id: 'MAT', name: 'Middle Atlantic', alias: 'Region: (MAT) Middle Atlantic' },
            ],
          },
        ],
      });

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/facility-fuel',
        values_query,
      });

      const [facet] = (result.structuredContent as { facets: Array<{ values: { id: string }[] }> })
        .facets;
      expect(facet?.values.map((v) => v.id)).toEqual(ids);
      expect(result.structuredContent).toMatchObject({ facets: [{ values_matched: ids.length }] });
    });

    it('keeps every entry of an ID EIA lists under more than one historical name', async () => {
      mockDescribe.mockResolvedValue({
        ...META,
        facets: [
          {
            id: 'plantCode',
            description: 'Plant',
            values: [
              { id: '6008', name: 'Palo Verde' },
              { id: '7', name: 'Gadsden' },
              { id: '6008', name: 'Arizona Nuclear Power Project' },
            ],
          },
        ],
      });

      const byId = await runToolContract(describeRouteTool, {
        route: 'electricity/facility-fuel',
        values_query: '6008',
      });
      expect(byId.structuredContent).toMatchObject({
        facets: [
          {
            values: [
              { id: '6008', name: 'Palo Verde' },
              { id: '6008', name: 'Arizona Nuclear Power Project' },
            ],
            value_count: 3,
            values_matched: 2,
          },
        ],
      });

      // A former name finds the plant on its own.
      const byFormerName = await runToolContract(describeRouteTool, {
        route: 'electricity/facility-fuel',
        values_query: 'arizona nuclear',
      });
      expect(byFormerName.structuredContent).toMatchObject({
        facets: [{ values: [{ id: '6008', name: 'Arizona Nuclear Power Project' }] }],
      });
    });

    it('indexes values_offset into the matches', async () => {
      mockDescribe.mockResolvedValue({ ...META, facets: [plantFacet()] });

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/facility-fuel',
        facet: 'plantCode',
        values_query: 'palo verde',
        values_offset: 1,
      });

      expect(result.structuredContent).toMatchObject({
        values_offset: 1,
        facets: [
          {
            values: [{ id: '57773', name: 'Palo Verde College' }],
            value_count: 122,
            values_matched: 2,
            values_truncated: false,
          },
        ],
      });
      expect(textOf(result.content)).toContain(
        '(1 of 2 matching values from offset 1; 122 values in all)',
      );
    });

    it('pages more matches than the cap, carrying values_query into each next-call hint', async () => {
      vi.stubEnv('EIA_FACET_VALUE_CAP', '3');
      _resetServerConfig();
      mockDescribe.mockResolvedValue({ ...META, facets: [wideFacetNamed('plantCode', 120)] });

      const page = async (values_offset: number) =>
        runToolContract(describeRouteTool, {
          route: 'electricity/facility-fuel',
          facet: 'plantCode',
          values_query: 'plant 1',
          values_offset,
        });

      const ids = (r: Awaited<ReturnType<typeof page>>) =>
        (
          r.structuredContent as { facets: Array<{ values: { id: string }[] }> }
        ).facets[0]?.values.map((v) => v.id);

      // "Plant 1", "Plant 10"–"Plant 19", "Plant 100"–"Plant 119": 31 matches.
      const first = await page(0);
      expect(ids(first)).toEqual(['P1', 'P10', 'P11']);
      expect(first.structuredContent).toMatchObject({
        facets: [{ value_count: 120, values_matched: 31, values_truncated: true }],
      });
      expect(textOf(first.content)).toContain(
        '(+28 more — eia_describe_route(route="electricity/retail-sales", facet="plantCode", values_query="plant 1", values_offset=3))',
      );

      const second = await page(3);
      expect(ids(second)).toEqual(['P12', 'P13', 'P14']);
      expect(textOf(second.content)).toContain('values_query="plant 1", values_offset=6))');

      const last = await page(30);
      expect(ids(last)).toEqual(['P119']);
      expect(last.structuredContent).toMatchObject({
        facets: [{ values_matched: 31, values_truncated: false }],
      });
      expect(textOf(last.content)).toContain(
        '(1 of 31 matching values from offset 30; 120 values in all)',
      );
      expect(textOf(last.content)).not.toContain('more —');
    });

    it('empties the window past the last match and names values_matched in the notice', async () => {
      mockDescribe.mockResolvedValue({ ...META, facets: [plantFacet()] });

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/facility-fuel',
        facet: 'plantCode',
        values_query: 'palo verde',
        values_offset: 5,
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        facets: [{ values: [], value_count: 122, values_matched: 2, values_truncated: false }],
      });
      const overshoot =
        'values_offset 5 is past the last value matching values_query "palo verde" of plantCode (values_matched 2, last valid offset 1).';
      expect((result.structuredContent as { notice: string }).notice).toContain(overshoot);
      expect(textOf(result.content)).toContain(overshoot);
      expect(textOf(result.content)).toContain(
        '(0 of 2 matching values from offset 5; 122 values in all)',
      );
    });

    it('answers zero matches with a successful empty window and a notice naming the query', async () => {
      mockDescribe.mockResolvedValue({ ...META, facets: [plantFacet()] });

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/facility-fuel',
        facet: 'plantCode',
        values_query: 'no such plant',
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        values_query: 'no such plant',
        facets: [{ values: [], value_count: 122, values_matched: 0, values_truncated: false }],
      });
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain(
        'No value of plantCode has an id, name, or alias containing values_query "no such plant"',
      );
      // A miss is not an overshoot: there is no offset that would bring values back.
      expect(notice).not.toContain('past the last');
      const text = textOf(result.content);
      expect(text).toContain('values_query "no such plant"');
      expect(text).toContain(
        '- **plantCode** (0 of 0 matching values from offset 0; 122 values in all): Plant',
      );
    });

    it('without facet, narrows every facet and counts each one’s matches', async () => {
      mockDescribe.mockResolvedValue({
        ...META,
        facets: [
          plantFacet(),
          {
            id: 'state',
            description: 'State',
            values: [
              { id: 'AZ', name: 'Arizona' },
              { id: 'CA', name: 'California' },
            ],
          },
          {
            id: 'fuel2002',
            description: 'Fuel',
            values: [{ id: 'WND', name: 'Wind' }],
          },
        ],
      });

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/facility-fuel',
        values_query: 'ar',
      });

      const facets = (
        result.structuredContent as {
          facets: Array<{ id: string; values: { id: string }[]; values_matched?: number }>;
        }
      ).facets;
      expect(facets.map((f) => [f.id, f.values_matched, f.values.map((v) => v.id)])).toEqual([
        ['plantCode', 0, []],
        ['state', 1, ['AZ']],
        ['fuel2002', 0, []],
      ]);
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain('No value of plantCode, fuel2002 has');
      const text = textOf(result.content);
      expect(text).toContain('- **state** (1 of 1 matching values from offset 0; 2 values in all)');
      expect(text).toContain(
        '- **fuel2002** (0 of 0 matching values from offset 0; 1 values in all)',
      );
    });

    it('quotes a query holding a double quote so the next call copies intact', async () => {
      vi.stubEnv('EIA_FACET_VALUE_CAP', '1');
      _resetServerConfig();
      mockDescribe.mockResolvedValue({
        ...META,
        facets: [
          {
            id: 'plantCode',
            description: 'Plant',
            values: [
              { id: '1', name: 'The "Big" One' },
              { id: '2', name: 'The "Big" Two' },
            ],
          },
        ],
      });

      const result = await runToolContract(describeRouteTool, {
        route: 'electricity/facility-fuel',
        values_query: '"big"',
      });

      expect(result.structuredContent).toMatchObject({ values_query: '"big"' });
      expect(textOf(result.content)).toContain('values_query="\\"big\\"", values_offset=1))');
    });

    it('adds values_query and values_matched as optional output fields only', () => {
      const schema = z.toJSONSchema(describeRouteTool.output, { io: 'output' });
      expect(schema.properties).toHaveProperty('values_query');
      expect(schema.properties).toHaveProperty('facets.items.properties.values_matched');
      expect(schema.required).not.toContain('values_query');
      expect(schema).toMatchObject({
        properties: {
          facets: {
            items: {
              required: expect.not.arrayContaining(['values_matched']),
            },
          },
        },
      });
      // Every field a pre-existing reader depends on is still required.
      expect(schema).toMatchObject({
        required: expect.arrayContaining(['route', 'facets', 'values_offset']),
        properties: {
          facets: {
            items: {
              required: expect.arrayContaining([
                'id',
                'description',
                'values',
                'value_count',
                'values_truncated',
              ]),
            },
          },
        },
      });
    });
  });

  // ------------------------------------------------------------------
  // values_query by ISO/RTO acronym on balancing-authority facets (#102)
  // ------------------------------------------------------------------

  describe('values_query on balancing-authority facets (#102)', () => {
    /** EIA's own value lists, captured live: seven grid lists, a state list, a plant list. */
    const CAPTURED = JSON.parse(
      readFileSync(new URL('../fixtures/balancing-authority-facets.json', import.meta.url), 'utf8'),
    ) as Array<{
      route: string;
      facet: string;
      description: string;
      values: Array<{ id: string; name: string; alias?: string }>;
    }>;

    function list(route: string, facet: string) {
      const found = CAPTURED.find((l) => l.route === route && l.facet === facet);
      if (!found) throw new Error(`no captured list for ${route} ${facet}`);
      return found;
    }

    /** Describe `route` with one captured list as its only facet. */
    function describeList(l: (typeof CAPTURED)[number], values_query: string) {
      mockDescribe.mockResolvedValue({
        ...FULL_META,
        route: l.route,
        description: 'Captured',
        facets: [{ id: l.facet, description: l.description, values: l.values }],
        dataColumns: [],
        frequencies: [],
      });
      return runToolContract(describeRouteTool, { route: l.route, values_query });
    }

    type Window = { values: Array<{ id: string; name: string }>; values_matched?: number };
    const windowOf = (result: Awaited<ReturnType<typeof describeList>>): Window =>
      (result.structuredContent as { facets: Window[] }).facets[0] as Window;
    const textOf = (result: Awaited<ReturnType<typeof describeList>>): string =>
      result.content.map((block) => ('text' in block ? block.text : '')).join('\n');

    it.each([
      ['ERCOT', 'electricity/rto/region-data', 'respondent', ['ERCO']],
      ['SPP', 'electricity/rto/interchange-data', 'toba', ['SWPW', 'SWPP']],
      [
        'CAISO',
        'electricity/operating-generator-capacity',
        'balancing_authority_code',
        ['CA', 'CISO'],
      ],
      ['nyiso', 'electricity/rto/region-sub-ba-data', 'parent', ['NYIS']],
      ['iso-ne', 'electricity/rto/fuel-type-data', 'respondent', ['ISNE']],
    ])('matches %s on %s %s by acronym, on both surfaces', async (query, route, facet, ids) => {
      const result = await describeList(list(route, facet), query);

      expect(result.isError).not.toBe(true);
      const window = windowOf(result);
      expect(window.values.map((v) => v.id)).toEqual(ids);
      expect(window.values_matched).toBe(ids.length);
      const text = textOf(result);
      for (const value of window.values) expect(text).toContain(`${value.id}=${value.name}`);
      expect(text).toContain(`(${ids.length} of ${ids.length} matching values from offset 0;`);
      expect((result.structuredContent as { notice: string }).notice).not.toContain('No value of');
    });

    it('matches nothing for an acronym on a state facet, though CA is a CAISO code elsewhere', async () => {
      const result = await describeList(list('electricity/retail-sales', 'stateid'), 'CAISO');

      expect(result.isError).not.toBe(true);
      expect(windowOf(result)).toMatchObject({ values: [], values_matched: 0 });
      const miss = 'No value of stateid has an id, name, or alias containing values_query "CAISO"';
      expect((result.structuredContent as { notice: string }).notice).toContain(miss);
      expect(textOf(result)).toContain(miss);
    });

    /**
     * The acronym test is an added disjunct, so a query matches every value it
     * matched by id, name, or alias, and gains only the values whose acronym
     * contains it. Run over every captured list against the acronyms, the codes
     * they map from, fragments of both, and words from the mapped authorities'
     * names — the queries where an acronym match and a text match meet.
     */
    it('keeps every value a query matched before, adding only those an acronym contains', async () => {
      vi.stubEnv('EIA_FACET_VALUE_CAP', '500');
      _resetServerConfig();
      const ACRONYMS: Record<string, string[]> = {
        ERCO: ['ERCOT'],
        CISO: ['CAISO'],
        CA: ['CAISO'],
        NYIS: ['NYISO'],
        SWPP: ['SPP'],
        SWPW: ['SPP'],
        ISNE: ['ISO-NE'],
        MISO: ['MISO'],
        PJM: ['PJM'],
      };
      const GRID_FACETS = ['respondent', 'fromba', 'toba', 'parent', 'balancing_authority_code'];
      const queries = new Set([
        ...Object.values(ACRONYMS).flat(),
        ...Object.keys(ACRONYMS),
        ...['iso', 'ca', 'sw', 'pp', 'ne', 'ny', 'inc.', 'power pool'],
        ...['electric', 'texas', 'california', 'new york', 'southwest', 'independent'],
      ]);

      let gained = 0;
      for (const l of CAPTURED) {
        const grid = l.route.startsWith('electricity/') && GRID_FACETS.includes(l.facet);
        for (const query of queries) {
          const needle = query.toLowerCase();
          const byText = (v: { id: string; name: string; alias?: string }) =>
            [v.id, v.name, v.alias ?? ''].some((s) => s.toLowerCase().includes(needle));
          const byAcronym = (v: { id: string }) =>
            grid && (ACRONYMS[v.id] ?? []).some((a) => a.toLowerCase().includes(needle));
          const label = (v: { id: string; name: string }) => `${v.id}=${v.name}`;

          const got = windowOf(await describeList(l, query)).values.map(label);
          const where = `${l.route} ${l.facet} ${JSON.stringify(query)}`;
          expect(got, where).toEqual(expect.arrayContaining(l.values.filter(byText).map(label)));
          expect(got, where).toEqual(l.values.filter((v) => byText(v) || byAcronym(v)).map(label));
          gained += l.values.filter((v) => !byText(v) && byAcronym(v)).length;
        }
      }
      // The acronyms do add matches; the superset is not vacuous.
      expect(gained).toBeGreaterThan(0);
    });

    it('pages acronym matches: the cap, an offset into them, and one past them, on both surfaces', async () => {
      vi.stubEnv('EIA_FACET_VALUE_CAP', '1');
      _resetServerConfig();
      const toba = list('electricity/rto/interchange-data', 'toba');
      const nameOf = (id: string) => toba.values.find((v) => v.id === id)?.name;
      const page = (values_offset: number) => {
        mockDescribe.mockResolvedValue({
          ...FULL_META,
          route: toba.route,
          description: 'Captured',
          facets: [{ id: toba.facet, description: toba.description, values: toba.values }],
          dataColumns: [],
          frequencies: [],
        });
        return runToolContract(describeRouteTool, {
          route: toba.route,
          values_query: 'SPP',
          values_offset,
        });
      };
      const noticeOf = (result: Awaited<ReturnType<typeof page>>) =>
        (result.structuredContent as { notice: string }).notice;
      const inAll = `${toba.values.length} values in all`;

      // Neither SWPW nor SWPP carries "SPP" in its id, name, or alias: every match is by acronym.
      const first = await page(0);
      expect(windowOf(first)).toMatchObject({
        values: [{ id: 'SWPW' }],
        values_matched: 2,
        values_truncated: true,
      });
      expect(textOf(first)).toContain(`(1 of 2 matching values from offset 0; ${inAll})`);
      expect(textOf(first)).toContain(`SWPW=${nameOf('SWPW')}`);
      expect(textOf(first)).toContain(
        '(+1 more — eia_describe_route(route="electricity/rto/interchange-data", facet="toba", values_query="SPP", values_offset=1))',
      );

      const second = await page(1);
      expect(windowOf(second)).toMatchObject({
        values: [{ id: 'SWPP' }],
        values_matched: 2,
        values_truncated: false,
      });
      expect(textOf(second)).toContain(`(1 of 2 matching values from offset 1; ${inAll})`);
      expect(textOf(second)).toContain(`SWPP=${nameOf('SWPP')}`);
      expect(textOf(second)).not.toContain('more — eia_describe_route');

      const past = await page(2);
      expect(windowOf(past)).toMatchObject({
        values: [],
        values_matched: 2,
        values_truncated: false,
      });
      const overshoot =
        'values_offset 2 is past the last value matching values_query "SPP" of toba (values_matched 2, last valid offset 1).';
      expect(noticeOf(past)).toContain(overshoot);
      expect(textOf(past)).toContain(overshoot);
      expect(noticeOf(past)).not.toContain('No value of');
    });

    /**
     * values_query is caller text of any length, lower-cased once and tested
     * with `includes` against every value's id, name, alias, and — on a
     * balancing-authority facet — acronyms, then echoed in the notice and the
     * text. Thread CPU per batch of calls at doubling sizes: an absolute bound
     * at each size, then the 320k/5k ratio, never a single step.
     */
    describe('work over caller-sized text', () => {
      const region = list('electricity/rto/region-data', 'respondent');
      const states = list('electricity/retail-sales', 'stateid');
      const META = {
        ...FULL_META,
        route: region.route,
        description: 'Captured',
        facets: [
          { id: region.facet, description: region.description, values: region.values },
          { id: states.facet, description: states.description, values: states.values },
        ],
        dataColumns: [],
        frequencies: [],
      };

      /** Thread CPU milliseconds for `reps` parse + handler + format runs, the least of three trials. */
      async function cpuMs(values_query: string, reps: number): Promise<number> {
        const ctx = createMockContext({ errors: describeRouteTool.errors });
        let best = Number.POSITIVE_INFINITY;
        let rendered = 0;
        for (let trial = 0; trial < 3; trial++) {
          const start = process.threadCpuUsage();
          for (let i = 0; i < reps; i++) {
            const input = describeRouteTool.input.parse({ route: region.route, values_query });
            const blocks = describeRouteTool.format?.(await describeRouteTool.handler(input, ctx));
            rendered += blocks?.length ?? 0;
          }
          const used = process.threadCpuUsage(start);
          best = Math.min(best, (used.user + used.system) / 1000);
        }
        // Every run rendered its text, so no call was dead code.
        expect(rendered).toBe(3 * reps);
        return best;
      }

      it.each([
        ['repeated openers with no closer', (n: number) => '('.repeat(n)],
        ['one long line ending in a newline', (n: number) => `${'ERCOT '.repeat(n / 6)}\n`],
        ['line breaks throughout', (n: number) => `x${'  \r\n'.repeat(n / 4)}x`],
        ['a digit run', (n: number) => '1'.repeat(n)],
      ])('stays linear on %s', async (_name, shape) => {
        mockDescribe.mockResolvedValue(META);
        const reps = 5;
        const timings: number[] = [];
        for (let n = 5_000; n <= 320_000; n *= 2) {
          const ms = await cpuMs(shape(n), reps);
          expect(ms, `${reps} calls at ${n} characters`).toBeLessThan(1_000);
          timings.push(ms);
        }
        const first = Math.max(timings[0] ?? 0, 0.05);
        expect((timings.at(-1) ?? 0) / first).toBeLessThan(256);
      });
    });
  });
});

/** A facet whose value at index `i` is `P{i}` named `Plant {i}`, for substring paging. */
function wideFacetNamed(id: string, count: number) {
  return {
    id,
    description: 'Plant',
    values: Array.from({ length: count }, (_, i) => ({ id: `P${i}`, name: `Plant ${i}` })),
  };
}
