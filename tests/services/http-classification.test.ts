/**
 * @fileoverview HTTP and network-failure classification through the real EIA
 * service and tool boundary.
 * @module tests/services/http-classification.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetServerConfig } from '@/config/server-config.js';
import { browseRoutesTool } from '@/mcp-server/tools/definitions/browse-routes.tool.js';
import { describeRouteTool } from '@/mcp-server/tools/definitions/describe-route.tool.js';
import { queryRouteTool } from '@/mcp-server/tools/definitions/query-route.tool.js';
import { searchRoutesTool } from '@/mcp-server/tools/definitions/search-routes.tool.js';
import { _resetEiaApiService, initEiaApiService } from '@/services/eia/eia-service.js';
import { _resetRouteCache, getNode, initRouteCache } from '@/services/eia/route-cache.js';

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

  const HTML_503 =
    '<!DOCTYPE html>\n<html><head><title>503 Service Unavailable</title></head><body>down</body></html>';

  it.each([
    ['a 429', () => Response.json({ error: 'slow down' }, { status: 429 })],
    [
      'an OVER_RATE_LIMIT body on a non-429 refusal',
      () => Response.json({ error: { code: 'OVER_RATE_LIMIT' } }, { status: 403 }),
    ],
    [
      'an OVER_RATE_LIMIT response envelope on a 200',
      () => Response.json({ response: 'OVER_RATE_LIMIT: API rate limit exceeded' }),
    ],
  ])('classifies %s as rate_limited and spends the retry budget on it', async (_, answer) => {
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetchMock);
    const pending = runToolContract(queryRouteTool, { route: 'steo', columns: ['value'] });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'rate_limited',
          retryable: true,
          recovery: { hint: expect.stringContaining('Back off') },
        },
      },
    });
    // withRetry's default budget: the first attempt plus three retries.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    [500, 'outage', 'upstream_unavailable', JsonRpcErrorCode.ServiceUnavailable],
    [502, HTML_503, 'upstream_unavailable', JsonRpcErrorCode.ServiceUnavailable],
    [503, HTML_503, 'upstream_unavailable', JsonRpcErrorCode.ServiceUnavailable],
    [200, HTML_503, 'upstream_invalid_response', JsonRpcErrorCode.ServiceUnavailable],
    [200, 'not JSON', 'upstream_invalid_response', JsonRpcErrorCode.ServiceUnavailable],
    [504, HTML_503, undefined, JsonRpcErrorCode.Timeout],
  ] as const)(
    'classifies HTTP %i body without inventing rate limiting',
    async (status, body, reason, code) => {
      const fetchMock = vi.fn(async () => new Response(body, { status }));
      vi.stubGlobal('fetch', fetchMock);
      const pending = runToolContract(queryRouteTool, { route: 'steo', columns: ['value'] });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(result.structuredContent).toMatchObject({ error: { code } });
      if (reason) {
        expect(result.structuredContent).toMatchObject({
          error: {
            data: {
              reason,
              retryable: true,
              recovery: { hint: expect.stringContaining('availability') },
            },
          },
        });
        expect(JSON.stringify(result.content)).toContain('Recovery:');
      }
      expect(JSON.stringify(result)).not.toContain('rate_limited');
    },
  );

  it.each([
    [describeRouteTool, { route: 'steo' }],
    [queryRouteTool, { route: 'steo', columns: ['value'] }],
  ] as const)('classifies missing warm envelopes', async (definition, input) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({})),
    );
    const result = await runToolContract(definition, input);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'upstream_invalid_response', retryable: true } },
    });
    expect(JSON.stringify(result.content)).toContain('availability');
  });

  it('classifies a repair that still lacks metadata without replacing the cached stub', async () => {
    initRouteCache([{ id: 'steo', name: 'STEO', incomplete: true }], []);
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetchMock);
    const result = await runToolContract(browseRoutesTool, { path: 'steo' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getNode('steo')?.incomplete).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'upstream_invalid_response',
          retryable: true,
          recovery: { hint: 'Retry the call; if it persists, check api.eia.gov availability.' },
        },
      },
    });
    expect(result.content).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining(
          'Retry the call; if it persists, check api.eia.gov availability.',
        ),
      }),
    );
  });

  it.each([
    [browseRoutesTool, {}],
    [searchRoutesTool, { query: 'coal' }],
    [describeRouteTool, { route: 'steo' }],
    [queryRouteTool, { route: 'steo', columns: ['value'] }],
  ] as const)(
    'declares malformed root envelopes across route tools (%#)',
    async (definition, input) => {
      _resetRouteCache();
      const fetchMock = vi.fn(async () => Response.json({ response: {} }));
      vi.stubGlobal('fetch', fetchMock);
      const pending = runToolContract(definition, input);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: {
            reason: 'upstream_invalid_response',
            retryable: true,
            recovery: { hint: expect.stringContaining('availability') },
          },
        },
      });
      expect(JSON.stringify(result.content)).toContain('Recovery:');
    },
  );

  describe('a request URI too long for EIA (#71)', () => {
    /** The page nginx serves in front of api.eia.gov for an over-long request line. */
    const HTML_414 =
      '<html>\r\n<head><title>414 Request-URI Too Large</title></head>\r\n<body>\r\n<center><h1>414 Request-URI Too Large</h1></center>\r\n</body>\r\n</html>\r\n';
    const stateIds = Array.from({ length: 700 }, (_, i) => `S${String(i).padStart(3, '0')}`);

    it.each([
      ['an HTML body', () => new Response(HTML_414, { status: 414 })],
      ['a non-HTML body', () => new Response('URI Too Long', { status: 414 })],
    ])('fails once, unretried, as uri_too_long on %s', async (_, answer) => {
      const urls: string[] = [];
      const fetchMock = vi.fn(async (input: string | URL) => {
        urls.push(String(input));
        return answer();
      });
      vi.stubGlobal('fetch', fetchMock);
      const pending = runToolContract(queryRouteTool, {
        route: 'steo',
        columns: ['value'],
        filters: { stateid: stateIds },
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(urls[0]?.length).toBeGreaterThan(8192);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'uri_too_long',
            retryable: false,
            recovery: { hint: expect.stringMatching(/split[^.]*filter values/i) },
          },
        },
      });
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text).toContain('414');
      expect(text).toMatch(/Recovery: .*split/i);
      expect(text).toContain('reason uri_too_long · not retryable');
      expect(JSON.stringify(result)).not.toContain('private-api-key');
    });
  });

  describe('a network failure reaching EIA (#72)', () => {
    /** What undici's fetch rejects with when the connection is refused. */
    const connectionRefused = () =>
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), {
          code: 'ECONNREFUSED',
        }),
      });

    const textOf = (result: { content: Array<{ type: string }> }) =>
      result.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n');

    it('spends the retry budget on a thrown fetch and answers once a retry reaches EIA', async () => {
      let attempts = 0;
      const fetchMock = vi.fn(async () => {
        attempts++;
        if (attempts < 3) throw connectionRefused();
        return Response.json({
          response: { total: '1', dateFormat: 'YYYY', frequency: 'annual', data: [{ value: '1' }] },
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      const pending = runToolContract(queryRouteTool, { route: 'steo', columns: ['value'] });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ total: 1, data: [{ value: '1' }] });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('propagates a caller abort during the fetch as cancellation, without retrying', async () => {
      const controller = new AbortController();
      const fetchMock = vi.fn(async () => {
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      });
      vi.stubGlobal('fetch', fetchMock);
      const pending = runToolContract(
        queryRouteTool,
        { route: 'steo', columns: ['value'] },
        { context: { signal: controller.signal } },
      );
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled },
      });
      // The framework relabels anything thrown after the abort as cancelled, so
      // the message is what shows the abort was not read as an outage.
      const wire = JSON.stringify(result);
      expect(wire).not.toContain('upstream_unreachable');
      expect(wire).not.toContain('Could not reach');
    });

    /**
     * Each tool reaches `fetchJson()` through the route-tree warm on a cold
     * process; describe and query also reach it directly once the tree is in
     * hand — the route metadata request and the data request.
     */
    const browse = () => runToolContract(browseRoutesTool, {});
    const search = () => runToolContract(searchRoutesTool, { query: 'coal' });
    const describeSteo = () => runToolContract(describeRouteTool, { route: 'steo' });
    const querySteo = () => runToolContract(queryRouteTool, { route: 'steo', columns: ['value'] });

    it.each([
      ['eia_browse_routes', 'cold', browseRoutesTool.errors, browse],
      ['eia_search_routes', 'cold', searchRoutesTool.errors, search],
      ['eia_describe_route', 'cold', describeRouteTool.errors, describeSteo],
      ['eia_query_route', 'cold', queryRouteTool.errors, querySteo],
      ['eia_describe_route', 'warm', describeRouteTool.errors, describeSteo],
      ['eia_query_route', 'warm', queryRouteTool.errors, querySteo],
    ] as const)(
      '%s on a %s tree fails as retryable upstream_unreachable after the retry budget',
      async (_, tree, errors, call) => {
        if (tree === 'cold') _resetRouteCache();
        const contract = errors?.find((e) => e.reason === 'upstream_unreachable');
        expect(contract).toMatchObject({ retryable: true, thrownBy: 'service' });
        const fetchMock = vi.fn(async () => {
          throw connectionRefused();
        });
        vi.stubGlobal('fetch', fetchMock);
        const pending = call();
        await vi.runAllTimersAsync();
        const result = await pending;

        // withRetry's default budget: the first attempt plus three retries.
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ServiceUnavailable,
            message: expect.stringMatching(/^Could not reach the EIA API \(ECONNREFUSED\)/),
            data: {
              reason: 'upstream_unreachable',
              retryable: true,
              recovery: { hint: contract?.recovery },
            },
          },
        });
        const text = textOf(result);
        expect(text).toContain('Could not reach the EIA API (ECONNREFUSED)');
        expect(text).toContain(`Recovery: ${contract?.recovery}`);
        expect(text).toContain('reason upstream_unreachable · retryable');
        const wire = JSON.stringify(result);
        expect(wire).not.toContain('private-api-key');
        expect(wire).not.toContain('api_key');
        expect(wire).not.toContain('127.0.0.1');
        expect(wire).not.toMatch(/https?:\/\//);
        expect(wire).not.toContain('/v2');
      },
    );

    it.each([
      [
        "Bun's error, whose path carries the full URL",
        () =>
          Object.assign(
            new TypeError(
              'ECONNREFUSED: Unable to connect. Is the computer able to access the url?',
            ),
            {
              code: 'ECONNREFUSED',
              errno: 0,
              path: 'http://127.0.0.1:9/v2/steo/data/?api_key=private-api-key',
            },
          ),
        'Could not reach the EIA API (ECONNREFUSED) —',
      ],
      [
        "undici's DNS failure, coded on its cause",
        () =>
          new TypeError('fetch failed', {
            cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example.invalid'), {
              code: 'ENOTFOUND',
            }),
          }),
        'Could not reach the EIA API (ENOTFOUND) —',
      ],
      [
        'a throw with no transport code',
        () => new TypeError('fetch failed'),
        'Could not reach the EIA API — the request failed before EIA answered.',
      ],
    ])('names the transport code of %s and nothing else from it', async (_, thrown, prefix) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw thrown();
        }),
      );
      const pending = runToolContract(queryRouteTool, { route: 'steo', columns: ['value'] });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: expect.stringContaining(prefix),
          data: { reason: 'upstream_unreachable', retryable: true },
        },
      });
      const wire = JSON.stringify(result);
      expect(wire).not.toContain('private-api-key');
      expect(wire).not.toContain('api.example.invalid');
      expect(wire).not.toContain('Unable to connect');
    });
  });
});
