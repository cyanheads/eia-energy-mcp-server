/**
 * @fileoverview HTTP classification through the real EIA query and tool boundary.
 * @module tests/services/http-classification.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetServerConfig } from '@/config/server-config.js';
import { queryRouteTool } from '@/mcp-server/tools/definitions/query-route.tool.js';
import { _resetEiaApiService, initEiaApiService } from '@/services/eia/eia-service.js';
import { _resetRouteCache, initRouteCache } from '@/services/eia/route-cache.js';

describe('EIA HTTP classification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('EIA_API_KEY', 'private-api-key');
    _resetServerConfig();
    _resetEiaApiService();
    _resetRouteCache();
    initEiaApiService();
    initRouteCache([{ id: 'steo', name: 'STEO', data: {}, facets: [], frequency: [] }], []);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    _resetServerConfig();
    _resetEiaApiService();
    _resetRouteCache();
  });

  it.each([
    [400, JsonRpcErrorCode.ValidationError, 'invalid_column'],
    [404, JsonRpcErrorCode.NotFound, 'route_not_found'],
    [401, JsonRpcErrorCode.Unauthorized, undefined],
    [403, JsonRpcErrorCode.Forbidden, undefined],
    [501, JsonRpcErrorCode.ServiceUnavailable, undefined],
  ] as const)(
    'classifies HTTP %i without retrying a definitive refusal',
    async (status, code, reason) => {
      const fetchMock = vi.fn(async () =>
        Response.json({ error: "Invalid data 'bogus' provided." }, { status }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const pending = runToolContract(queryRouteTool, { route: 'steo', columns: ['bogus'] });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain('private-api-key');
      if (reason) {
        expect(result.structuredContent).toMatchObject({
          error: { data: { reason, recovery: { hint: expect.any(String) } } },
        });
        expect(result.content).toContainEqual(
          expect.objectContaining({ text: expect.stringContaining('Recovery:') }),
        );
      }
      if (status === 400)
        expect(JSON.stringify(result)).toContain("Invalid data 'bogus' provided.");
      if (status === 501)
        expect(result.structuredContent).toMatchObject({ error: { data: { retryable: false } } });
    },
  );
});
