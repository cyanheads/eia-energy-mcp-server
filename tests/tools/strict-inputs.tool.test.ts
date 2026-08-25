/**
 * @fileoverview Pins the strict tool-input contract every eia_* tool advertises:
 * an undeclared key at the argument root is rejected by name, while nested
 * objects and `z.record()` values keep their pre-existing behavior.
 * @module tests/tools/strict-inputs.tool.test
 */

import { describe, expect, it } from 'vitest';
import { browseRoutesTool } from '@/mcp-server/tools/definitions/browse-routes.tool.js';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { describeRouteTool } from '@/mcp-server/tools/definitions/describe-route.tool.js';
import { queryRouteTool } from '@/mcp-server/tools/definitions/query-route.tool.js';
import { searchRoutesTool } from '@/mcp-server/tools/definitions/search-routes.tool.js';

/** One minimal, valid argument object per tool, so an added key is the only issue raised. */
const MINIMAL_INPUTS = [
  { tool: browseRoutesTool, input: {} },
  { tool: describeRouteTool, input: { route: 'electricity/retail-sales' } },
  { tool: searchRoutesTool, input: { query: 'retail sales' } },
  { tool: queryRouteTool, input: { route: 'electricity/retail-sales' } },
  { tool: dataframeDescribeTool, input: {} },
  { tool: dataframeQueryTool, input: { sql: 'SELECT 1' } },
  { tool: dataframeDropTool, input: { name: 'df_ABC123' } },
] as const;

const unrecognizedKeys = (error: { issues: readonly unknown[] } | undefined): string[] =>
  (error?.issues ?? [])
    .filter((issue): issue is { code: string; keys: string[] } => {
      const candidate = issue as { code?: unknown; keys?: unknown };
      return candidate.code === 'unrecognized_keys' && Array.isArray(candidate.keys);
    })
    .flatMap((issue) => issue.keys);

describe('strict tool inputs', () => {
  for (const { tool, input } of MINIMAL_INPUTS) {
    it(`${tool.name} accepts its declared arguments`, () => {
      expect(tool.input.safeParse(input).success).toBe(true);
    });

    it(`${tool.name} rejects an undeclared root argument by name`, () => {
      const result = tool.input.safeParse({ ...input, not_a_real_parameter: 'x' });

      expect(result.success).toBe(false);
      expect(unrecognizedKeys(result.error)).toEqual(['not_a_real_parameter']);
    });
  }

  it('names every undeclared root argument, not just the first', () => {
    const result = queryRouteTool.input.safeParse({
      route: 'electricity/retail-sales',
      canvas_id: 'df_LEGACY',
      max_rows: 10,
    });

    expect(result.success).toBe(false);
    expect(unrecognizedKeys(result.error).sort()).toEqual(['canvas_id', 'max_rows']);
  });

  it('strips an undeclared key inside a nested object — strictness is root-level only', () => {
    const parsed = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      sort: [{ column: 'period', direction: 'desc', nonsense: true }],
    });

    expect(parsed.sort).toEqual([{ column: 'period', direction: 'desc' }]);
  });

  it('keeps arbitrary facet IDs in the filters record', () => {
    const parsed = queryRouteTool.input.parse({
      route: 'electricity/retail-sales',
      filters: { stateid: 'TX', sectorid: ['RES', 'COM'] },
    });

    expect(parsed.filters).toEqual({ stateid: 'TX', sectorid: ['RES', 'COM'] });
  });
});
