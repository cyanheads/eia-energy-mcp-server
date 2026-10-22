/**
 * @fileoverview Tool definition for eia_browse_routes. Lists child routes under
 * a given path in the EIA dataset taxonomy. Start at root (omit path) to see
 * the 14 top-level categories, then drill into subcategories until reaching
 * leaf routes that can be queried with eia_query_route.
 * @module mcp-server/tools/definitions/browse-routes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEiaApiService } from '@/services/eia/eia-service.js';

export const browseRoutesTool = tool('eia_browse_routes', {
  title: 'Browse EIA Routes',
  description:
    'Lists child routes under a given path in the EIA dataset taxonomy. Start with no path to get the 14 top-level categories (electricity, petroleum, natural-gas, steo, aeo, ieo, seds, etc.), then drill into subcategories. Each result includes an isLeaf flag — leaf routes are queryable endpoints; non-leaf routes have children to browse. When isLeaf is true on the browsed path itself, switch to eia_describe_route. The first call after server start waits up to 20s for the route tree to warm, then answers from EIA directly.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputAliases: { route: 'path' },

  input: z.object({
    path: z
      .string()
      .optional()
      .describe(
        'Route path to browse (e.g. "electricity", "petroleum/pri"). Omit for root. Whitespace and slashes are normalized, then one complete leading v2 segment is removed: "/v2/electricity/retail-sales/" resolves to "electricity/retail-sales", and "/v2/" to root. Full URLs and /data suffixes are not normalized.',
      ),
  }),

  output: z.object({
    path: z.string().describe('The path that was browsed (empty string for root).'),
    children: z
      .array(
        z
          .object({
            id: z.string().describe('Route segment ID.'),
            name: z.string().describe('Human-readable name.'),
            description: z.string().describe('Route description.'),
            route: z
              .string()
              .describe('Full route path usable in eia_describe_route or eia_query_route.'),
            isLeaf: z
              .boolean()
              .describe('True when this child is a queryable leaf route with data.'),
          })
          .describe('A child route entry.'),
      )
      .describe('Child entries under the browsed path.'),
    isLeaf: z
      .boolean()
      .describe(
        'True when the browsed path itself is a leaf route — no children to drill into; use eia_describe_route instead.',
      ),
  }),

  errors: [
    {
      reason: 'upstream_invalid_response',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'EIA returned an unusable response body or a missing route or data envelope.',
      recovery: 'Retry after a short wait; if it persists, check api.eia.gov availability.',
    },
    {
      reason: 'upstream_unavailable',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'EIA answered with a retryable HTTP service failure.',
      recovery: 'Retry after a short wait; if it persists, check api.eia.gov availability.',
    },
    {
      reason: 'route_not_found',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'Path does not exist in the EIA taxonomy.',
      recovery: 'Call eia_browse_routes without a path to see valid top-level categories.',
    },
    {
      reason: 'rate_limited',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'EIA rate limit hit (OVER_RATE_LIMIT) while building the route tree on the first call after server start, or on the live fetch of the browsed path a cold call falls back to.',
      recovery: 'Back off and retry; use a production EIA API key for higher rate limits.',
    },
    {
      reason: 'upstream_unreachable',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'EIA could not be reached (connection refused or reset, DNS failure) while building the route tree on the first call after server start, or on the live fetch of the browsed path a cold call falls back to.',
      recovery:
        'Retry after a short wait — EIA could not be reached; if it keeps failing, check api.eia.gov availability.',
    },
  ],

  handler(input, ctx) {
    ctx.log.info('Executing eia_browse_routes', { path: input.path });
    return getEiaApiService().browse(input.path, ctx);
  },

  format: (result) => {
    const lines: string[] = [];

    if (result.isLeaf && result.children.length === 0) {
      lines.push(
        `**${result.path}** is a leaf route — use eia_describe_route to inspect its facets and columns.`,
      );
    }

    const label = result.path ? `**${result.path}**` : 'root';
    if (result.children.length > 0) {
      lines.push(`Children of ${label} (${result.children.length}):\n`);
    }

    for (const c of result.children) {
      const tag = c.isLeaf ? '[leaf]' : '[cat]';
      lines.push(`${tag} **${c.route}** (${c.id}) — ${c.name}`);
      if (c.description) lines.push(`  ${c.description}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
