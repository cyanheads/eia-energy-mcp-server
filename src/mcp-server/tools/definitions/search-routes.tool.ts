/**
 * @fileoverview Tool definition for eia_search_routes. Fuzzy text search across
 * route names, descriptions, and category labels using an in-memory Fuse.js
 * index. Resolves natural-language queries to route paths. STEO series names
 * (1,469 entries) are included in the index for series discovery.
 * @module mcp-server/tools/definitions/search-routes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getEiaApiService } from '@/services/eia/eia-service.js';

export const searchRoutesTool = tool('eia_search_routes', {
  title: 'Search EIA Routes',
  description:
    'Fuzzy text search across route names, descriptions, and category labels. Resolves natural-language queries like "electricity retail sales by state" or "natural gas imports" to matching route paths. STEO series names are indexed so queries like "ethanol net imports" or "crude oil production forecast" also resolve. Results include isLeaf so you know whether to browse further or query directly. Results with score > 0.5 are weak matches — try a more specific query or use eia_browse_routes to explore the taxonomy.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe('Free-text search terms to match against route names and descriptions.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(10)
      .describe('Maximum results to return (default 10, max 30).'),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            route: z
              .string()
              .describe('Route path — usable directly in eia_describe_route or eia_query_route.'),
            name: z.string().describe('Human-readable route name.'),
            description: z.string().describe('Route description.'),
            score: z
              .number()
              .describe('Fuzzy match score: 0 = exact, 1 = no match. Lower is better.'),
            isLeaf: z
              .boolean()
              .describe(
                'True when the route is a queryable leaf; false when it has sub-routes to browse.',
              ),
            filter_hint: z
              .record(z.string(), z.string())
              .optional()
              .describe(
                'Pre-built filter for eia_query_route when a specific facet value is required. Present on STEO series results — pass directly as filters (e.g. eia_query_route(route="steo", filters=filter_hint)).',
              ),
          })
          .describe('A search result entry.'),
      )
      .describe('Ranked matches, best first.'),
  }),

  enrichment: {
    effectiveQuery: z.string().describe('Query as submitted to the Fuse.js index.'),
    totalIndexed: z
      .number()
      .describe('Total entries in the search index (routes + STEO series names).'),
    truncated: z.boolean().describe('True when matches were capped at limit; more may exist.'),
    shown: z.number().describe('Number of results returned.'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no routes matched — suggests alternative queries or using eia_browse_routes.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Executing eia_search_routes', { query: input.query, limit: input.limit });
    const service = getEiaApiService();
    const { results, totalIndexed } = await service.search(input.query, input.limit, ctx);

    ctx.enrich.echo(input.query);
    ctx.enrich({ totalIndexed, shown: results.length, cap: input.limit, truncated: false });
    if (results.length === 0) {
      ctx.enrich.notice(
        `No routes matched "${input.query}". Try different search terms or use eia_browse_routes to explore the taxonomy.`,
      );
    } else if (results.length >= input.limit) {
      ctx.enrich.truncated({
        shown: results.length,
        cap: input.limit,
        guidance: 'More matches may exist — narrow the query or raise limit (max 30).',
      });
    }

    return {
      results: results.map(({ entry, score }) => ({
        route: entry.route,
        name: entry.name,
        description: entry.description,
        score,
        isLeaf: entry.isLeaf,
        ...(entry.filter_hint !== undefined && { filter_hint: entry.filter_hint }),
      })),
    };
  },

  format: (result) => {
    const lines: string[] = [];

    if (result.results.length === 0) {
      lines.push(
        'No matching routes found. Try different search terms or browse with eia_browse_routes.',
      );
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push(`**${result.results.length} result(s)**\n`);
    for (const r of result.results) {
      const tag = r.isLeaf ? '[leaf]' : '[cat]';
      const weakMatch = r.score > 0.5 ? ' ⚠ weak match' : '';
      lines.push(`${tag} **${r.route}** (score: ${r.score.toFixed(3)}${weakMatch})`);
      lines.push(`  ${r.name}`);
      if (r.description) lines.push(`  ${r.description}`);
      if (r.filter_hint) {
        const hint = Object.entries(r.filter_hint)
          .map(([k, v]) => `"${k}": "${v}"`)
          .join(', ');
        lines.push(`  Query with: \`eia_query_route(route="${r.route}", filters={${hint}})\``);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
