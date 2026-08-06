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
    'Lists child routes under a given path in the EIA dataset taxonomy. Start with no path to get the 14 top-level categories (electricity, petroleum, natural-gas, steo, aeo, ieo, seds, etc.), then drill into subcategories. Each result includes an isLeaf flag — leaf routes are queryable endpoints; non-leaf routes have children to browse. When isLeaf is true on the browsed path itself, switch to eia_describe_route.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    path: z
      .string()
      .optional()
      .describe(
        'Route path to browse (e.g. "electricity", "petroleum/pri"). Omit for root. Leading, trailing, and doubled slashes are stripped, so an EIA-doc spelling like "/electricity/retail-sales/" resolves to the same route.',
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
      reason: 'route_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Path does not exist in the EIA taxonomy.',
      recovery: 'Call eia_browse_routes without a path to see valid top-level categories.',
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
