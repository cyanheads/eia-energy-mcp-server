/**
 * @fileoverview The cap shared by the count inputs — eia_query_route `length`,
 * eia_dataframe_query `row_limit` and `preview`, eia_search_routes `limit`: the
 * input schema, which advertises no maximum while EIA_CLAMP_LIMITS is on (the
 * default) and advertises and enforces the cap when it is off, and the clamp
 * that lowers an over-cap request with a notice, an info log line, and a
 * counter.
 * @module mcp-server/tools/count-limit
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getClampLimits } from '@/config/server-config.js';

const clamps = createCounter(
  'eia.input.count_clamped',
  'Count inputs lowered to their cap',
  '{clamp}',
);

/** The tools whose count inputs clamp. */
type CountTool = 'eia_dataframe_query' | 'eia_query_route' | 'eia_search_routes';

/**
 * A whole-number count field of at least `min`. With clamping on it advertises
 * no maximum — `multipleOf(1)`, since zod's `.int()` advertises 2^53 − 1 as one
 * — and accepts any larger value for the handler to clamp; with
 * `EIA_CLAMP_LIMITS=false` it advertises and enforces `strictMax`.
 *
 * The mode is read on first use (building tools/list or the first parse),
 * never at import: `createApp()` loads `.env` after the definition modules are
 * imported, and `z.lazy` keeps whichever schema it resolved first.
 */
export function countSchema(field: string, min: number, strictMax: number) {
  return z.lazy(() =>
    getClampLimits()
      ? z.number().multipleOf(1, `Send ${field} as a whole number, not a fractional one.`).min(min)
      : z.number().int().min(min).max(strictMax),
  );
}

/**
 * `.meta()` for a count field whose description follows the mode: `clamped`
 * while clamping is on, `strict` when it is off. A getter, so it is read when
 * the description is, not when the field is built.
 */
export function modeDescription(clamped: string, strict: string) {
  return {
    get description() {
      return getClampLimits() ? clamped : strict;
    },
  };
}

/**
 * `requested` lowered to `cap`. A clamp writes one info log line (tool, field,
 * requested, applied), adds one to `eia.input.count_clamped`, and returns the
 * notice naming both values; a request within the cap does none of that.
 */
export function clampCount(
  ctx: Context,
  tool: CountTool,
  field: string,
  requested: number,
  cap: number,
): { applied: number; notice?: string } {
  if (requested <= cap) return { applied: requested };
  ctx.log.info('Clamped count input', { tool, field, requested, applied: cap });
  clamps.add(1, { [ATTR_MCP_TOOL_NAME]: tool, 'eia.input.field': field });
  return { applied: cap, notice: `Requested ${field} ${requested} was clamped to ${cap}.` };
}
