/**
 * @fileoverview Route argument aliases through the production contract parser (#63).
 * @module tests/tools/route-aliases.tool.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetServerConfig } from '@/config/server-config.js';
import { browseRoutesTool } from '@/mcp-server/tools/definitions/browse-routes.tool.js';
import { describeRouteTool } from '@/mcp-server/tools/definitions/describe-route.tool.js';
import { queryRouteTool } from '@/mcp-server/tools/definitions/query-route.tool.js';
import { _resetEiaApiService, initEiaApiService } from '@/services/eia/eia-service.js';
import { _resetRouteCache, initRouteCache } from '@/services/eia/route-cache.js';

const route = 'electricity/retail-sales';
const definitions = [browseRoutesTool, describeRouteTool, queryRouteTool] as const;

describe('route aliases', () => {
  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    _resetServerConfig();
    _resetEiaApiService();
    _resetRouteCache();
    initEiaApiService();
    initRouteCache(
      [
        {
          id: 'electricity',
          name: 'Electricity',
          routes: [{ id: 'retail-sales', name: 'Sales', frequency: [], facets: [], data: {} }],
        },
      ],
      [],
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) =>
        Response.json({
          response: String(input).includes('/data/')
            ? { total: '1', data: [{ value: '12' }], frequency: 'annual', dateFormat: 'YYYY' }
            : {
                id: 'retail-sales',
                name: 'Sales',
                data: { value: { alias: 'Value', units: '' } },
                facets: [],
                frequency: [],
                startPeriod: '2024',
                endPeriod: '2024',
              },
        }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    _resetServerConfig();
    _resetEiaApiService();
    _resetRouteCache();
  });

  for (const definition of definitions) {
    const canonical = definition.name === 'eia_browse_routes' ? 'path' : 'route';
    const alias = canonical === 'path' ? 'route' : 'path';
    it(`${definition.name} accepts the alias without changing its schema`, async () => {
      const expected = await runToolContract(definition, { [canonical]: route });
      const actual = await runToolContract(definition, { [alias]: route });
      expect(expected.isError).not.toBe(true);
      expect(actual).toEqual(expected);
      expect(definition.input.shape).toHaveProperty(canonical);
      expect(definition.input.shape).not.toHaveProperty(alias);
    });
    it(`${definition.name} rejects both spellings before upstream I/O`, async () => {
      const result = await runToolContract(definition, { path: route, route: 'steo' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32602,
          data: { reason: 'invalid_arguments', recovery: { hint: expect.any(String) } },
        },
      });
      expect(fetch).not.toHaveBeenCalled();
    });
    it(`${definition.name} rejects a malformed alias with a recovery hint`, async () => {
      const result = await runToolContract(definition, { [alias]: 42 });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32602, data: { recovery: { hint: expect.any(String) } } },
      });
      expect(result.content).toContainEqual(
        expect.objectContaining({ text: expect.stringContaining('string') }),
      );
      expect(fetch).not.toHaveBeenCalled();
    });
  }
});
