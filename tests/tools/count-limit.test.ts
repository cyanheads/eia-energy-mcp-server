/**
 * @fileoverview The count inputs' shared cap: the schema and description per
 * EIA_CLAMP_LIMITS mode, the clamp table with its notice, log line, and
 * counter, and what tools/list advertises for the four inputs that use it —
 * eia_query_route `length`, eia_dataframe_query `row_limit` and `preview`,
 * eia_search_routes `limit`. Per-tool tests prove only the wiring.
 * @module tests/tools/count-limit.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { ATTR_MCP_TOOL_NAME } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const counter = vi.hoisted(() => ({ add: vi.fn() }));
const counterNames = vi.hoisted(() => [] as string[]);
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: (name: string) => {
    counterNames.push(name);
    return counter;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('EIA_CLAMP_LIMITS', undefined);
  counter.add.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

/** Fresh module instances, so the config and each lazy schema resolve under the current env. */
const loadModule = () => import('@/mcp-server/tools/count-limit.js');

/**
 * Every module-graph reload pays the framework import, which runs past
 * Vitest's 5 s default on a loaded machine.
 */
const RELOAD_TIMEOUT = { timeout: 30_000 };

type Emitted = Record<string, unknown> & { properties: Record<string, Record<string, unknown>> };
const emit = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input' }) as Emitted;

describe('countSchema', RELOAD_TIMEOUT, () => {
  it.each(['', 'true'])(
    'with EIA_CLAMP_LIMITS=%j accepts an over-cap whole number and advertises no maximum',
    async (value) => {
      vi.stubEnv('EIA_CLAMP_LIMITS', value);
      const { countSchema } = await loadModule();
      const schema = countSchema('length', 1, 5000);
      expect(schema.parse(5001)).toBe(5001);
      expect(schema.parse(9_000_000)).toBe(9_000_000);
      const emitted = emit(schema);
      expect(emitted).toMatchObject({ type: 'number', minimum: 1, multipleOf: 1 });
      expect(emitted).not.toHaveProperty('maximum');
    },
  );

  it.each([
    [1, 0],
    [1, 2.5],
    [0, -1],
    [0, Number.NaN],
    [0, Number.POSITIVE_INFINITY],
  ])('with min %i rejects %d', async (min, value) => {
    const { countSchema } = await loadModule();
    expect(countSchema('preview', min, 10_000).safeParse(value).success).toBe(false);
  });

  it('names the field and asks for a whole number when a fraction is sent', async () => {
    const { countSchema } = await loadModule();
    const result = countSchema('row_limit', 1, 10_000).safeParse(2.5);
    expect(result.error?.issues[0]?.message).toBe(
      'Send row_limit as a whole number, not a fractional one.',
    );
  });

  it('with EIA_CLAMP_LIMITS=false advertises and enforces the cap', async () => {
    vi.stubEnv('EIA_CLAMP_LIMITS', 'false');
    const { countSchema } = await loadModule();
    const schema = countSchema('length', 1, 5000);
    expect(schema.parse(5000)).toBe(5000);
    expect(schema.safeParse(5001).success).toBe(false);
    expect(emit(schema)).toMatchObject({ type: 'integer', minimum: 1, maximum: 5000 });
  });

  it('resolves the mode on first use, not when the field is built', async () => {
    const { countSchema } = await loadModule();
    const schema = countSchema('length', 1, 5000);
    // Definition modules are imported before createApp() loads .env, so building
    // the field must not read the config.
    vi.stubEnv('EIA_CLAMP_LIMITS', 'false');
    expect(schema.safeParse(5001).success).toBe(false);
  });
});

describe('modeDescription', RELOAD_TIMEOUT, () => {
  it.each([
    [undefined, 'Clamped wording.'],
    ['false', 'Strict wording.'],
  ])('with EIA_CLAMP_LIMITS=%j reads %j', async (value, expected) => {
    vi.stubEnv('EIA_CLAMP_LIMITS', value);
    const { countSchema, modeDescription } = await loadModule();
    const schema = countSchema('limit', 1, 30)
      .default(10)
      .meta(modeDescription('Clamped wording.', 'Strict wording.'));
    expect(schema.description).toBe(expected);
    expect(emit(schema).description).toBe(expected);
  });
});

describe('clampCount', RELOAD_TIMEOUT, () => {
  it.each([1, 24, 25])(
    'passes %i through at a cap of 25 with no notice, log, or count',
    async (n) => {
      const { clampCount } = await loadModule();
      const ctx = createMockContext();
      const info = vi.spyOn(ctx.log, 'info');
      const result = clampCount(ctx, 'eia_query_route', 'length', n, 25);
      expect(result).toEqual({ applied: n });
      expect(info).not.toHaveBeenCalled();
      expect(counter.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['eia_query_route', 'length', 5001, 5000],
    ['eia_dataframe_query', 'preview', 2000, 1000],
    ['eia_search_routes', 'limit', 31, 30],
  ] as const)(
    '%s %s %i lowers to %i with one notice, one log line, and one count',
    async (tool, field, requested, cap) => {
      const { clampCount } = await loadModule();
      const ctx = createMockContext();
      const info = vi.spyOn(ctx.log, 'info');
      expect(clampCount(ctx, tool, field, requested, cap)).toEqual({
        applied: cap,
        notice: `Requested ${field} ${requested} was clamped to ${cap}.`,
      });
      expect(info).toHaveBeenCalledExactlyOnceWith('Clamped count input', {
        tool,
        field,
        requested,
        applied: cap,
      });
      expect(counter.add).toHaveBeenCalledExactlyOnceWith(1, {
        [ATTR_MCP_TOOL_NAME]: tool,
        'eia.input.field': field,
      });
      expect(counterNames).toContain('eia.input.count_clamped');
    },
  );
});

/** The four count inputs as tools/list advertises them, from freshly loaded definitions. */
async function advertisedCounts() {
  const [query, dataframe, search] = await Promise.all([
    import('@/mcp-server/tools/definitions/query-route.tool.js'),
    import('@/mcp-server/tools/definitions/dataframe-query.tool.js'),
    import('@/mcp-server/tools/definitions/search-routes.tool.js'),
  ]);
  const queryProps = emit(query.queryRouteTool.input).properties;
  const dataframeProps = emit(dataframe.dataframeQueryTool.input).properties;
  const searchProps = emit(search.searchRoutesTool.input).properties;
  return {
    tools: {
      query: query.queryRouteTool,
      dataframe: dataframe.dataframeQueryTool,
      search: search.searchRoutesTool,
    },
    inputs: {
      'eia_query_route.length': queryProps.length,
      'eia_dataframe_query.row_limit': dataframeProps.row_limit,
      'eia_dataframe_query.preview': dataframeProps.preview,
      'eia_search_routes.limit': searchProps.limit,
    } as Record<string, Record<string, unknown> | undefined>,
  };
}

describe('tools/list — the four count inputs', RELOAD_TIMEOUT, () => {
  it('advertise no maximum with clamping on, and state default and cap once', async () => {
    const { inputs } = await advertisedCounts();
    expect(Object.keys(inputs)).toHaveLength(4);
    for (const [name, property] of Object.entries(inputs)) {
      expect(property, name).toBeDefined();
      expect(property, name).not.toHaveProperty('maximum');
      expect(property, name).toMatchObject({ multipleOf: 1 });
    }
    expect(inputs['eia_query_route.length']).toMatchObject({
      default: 25,
      minimum: 1,
      description: expect.stringContaining(
        'Default 25; a larger value returns at most 5,000 and says so.',
      ),
    });
    expect(inputs['eia_dataframe_query.row_limit']).toMatchObject({
      default: 1000,
      minimum: 1,
      description: expect.stringContaining(
        'Default 1,000; a larger value returns at most 10,000 and says so.',
      ),
    });
    expect(inputs['eia_dataframe_query.preview']).toMatchObject({
      minimum: 0,
      description: expect.stringContaining(
        'Default 25; a larger value returns at most row_limit and says so.',
      ),
    });
    expect(inputs['eia_search_routes.limit']).toMatchObject({
      default: 10,
      minimum: 1,
      description: expect.stringContaining(
        'Default 10; a larger value returns at most 30 and says so.',
      ),
    });
  });

  it('advertise and enforce each cap with EIA_CLAMP_LIMITS=false', async () => {
    vi.stubEnv('EIA_CLAMP_LIMITS', 'false');
    const { tools, inputs } = await advertisedCounts();
    expect(inputs['eia_query_route.length']).toMatchObject({
      type: 'integer',
      maximum: 5000,
      description: expect.stringContaining('Default 25; at most 5,000.'),
    });
    expect(inputs['eia_dataframe_query.row_limit']).toMatchObject({
      type: 'integer',
      maximum: 10_000,
      description: expect.stringContaining('Default 1,000; at most 10,000.'),
    });
    expect(inputs['eia_dataframe_query.preview']).toMatchObject({
      type: 'integer',
      maximum: 10_000,
      description: expect.stringContaining(
        'Default 25; at most 10,000, and a value above row_limit returns at most row_limit and says so.',
      ),
    });
    expect(inputs['eia_search_routes.limit']).toMatchObject({
      type: 'integer',
      maximum: 30,
      description: expect.stringContaining('Default 10; at most 30.'),
    });

    const rejected = await runToolContract(tools.query, { route: 'steo', length: 5001 });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(JSON.stringify(rejected.content)).toContain('length');
    expect(tools.dataframe.input.safeParse({ sql: 'SELECT 1', row_limit: 10_001 }).success).toBe(
      false,
    );
    expect(tools.dataframe.input.safeParse({ sql: 'SELECT 1', preview: 10_001 }).success).toBe(
      false,
    );
    expect(tools.search.input.safeParse({ query: 'coal', limit: 31 }).success).toBe(false);
  });

  it('answer a fractional count with the whole-number hint on both surfaces', async () => {
    const { tools } = await advertisedCounts();
    const result = await runToolContract(tools.query, { route: 'steo', length: 2.5 });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(JSON.stringify(result.structuredContent)).toContain(
      'Send length as a whole number, not a fractional one.',
    );
    expect(JSON.stringify(result.content)).toContain(
      'Send length as a whole number, not a fractional one.',
    );
  });
});
