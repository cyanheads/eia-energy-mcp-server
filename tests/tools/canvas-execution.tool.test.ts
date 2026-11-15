/**
 * @fileoverview Real DuckDB execution failures, gate refusals, and recovery through the EIA tools —
 * including staging and drop failures injected into the canvas instance the bridge acquires.
 * @module tests/tools/canvas-execution.tool.test
 */
import {
  type CanvasInstance,
  CanvasRegistry,
  type CanvasRegistryOptions,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { queryRouteTool } from '@/mcp-server/tools/definitions/query-route.tool.js';
import { _resetCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import {
  _resetEiaApiService,
  getEiaApiService,
  initEiaApiService,
} from '@/services/eia/eia-service.js';

/**
 * Failure switches consulted by the canvas instance the bridge acquires. Each
 * one replaces a single real method, so everything else — the bridge, the
 * tools, DuckDB — runs as shipped.
 */
interface Faults {
  /** Throw from `canvas.acquire` itself. */
  acquire?: boolean;
  /** Throw from `instance.drop`. */
  drop?: boolean;
  /** Awaited before `canvas.acquire` mints a canvas (an acquire without an id). */
  mint?: () => Promise<void>;
  /** Replace `instance.registerTable`; receives the real method to delegate to. */
  registerTable?: (
    real: CanvasInstance['registerTable'],
    ...args: Parameters<CanvasInstance['registerTable']>
  ) => ReturnType<CanvasInstance['registerTable']>;
}

interface CanvasHarness {
  canvas: DataCanvas;
  faults: Faults;
}

/**
 * Every test here opens a real DuckDB database and runs real queries, which
 * take tens of milliseconds idle and several seconds on a loaded machine —
 * past Vitest's 5 s default. The budget is sized to that work rather than
 * to the idle case.
 */
const DUCKDB_TIMEOUT = { timeout: 30_000 };

interface CanvasOptions {
  /**
   * DuckDB's thread count follows it (one thread per 64 MB, at most the
   * cores): 128 MB runs 2 threads; the 1,024 MB deployment default runs one
   * per core up to 16.
   */
  memoryLimitMb?: number;
  /** Registry lifecycle overrides, such as a short idle TTL or absolute cap. */
  registry?: Partial<CanvasRegistryOptions>;
}

/**
 * The registry reads the clock through `Date.now()` at call time, so a test
 * that fakes `Date` moves canvas expiry and `ctx.state` TTLs together.
 */
function newCanvas({ memoryLimitMb = 128, registry }: CanvasOptions = {}): DataCanvas {
  const provider = new DuckdbProvider({
    defaultRowLimit: 10000,
    exportRootPath: '/tmp/eia-canvas-tests',
    memoryLimitMb,
    schemaSniffRows: 100,
  });
  return new DataCanvas(
    provider,
    new CanvasRegistry(
      provider,
      { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0, ...registry },
      () => Date.now(),
    ),
  );
}

/**
 * Load the DuckDB native binding once, before any test is timed. The first
 * canvas in a worker pays for loading it — about a second idle — and that
 * cost belongs to no single test.
 */
beforeAll(async () => {
  const canvas = newCanvas();
  const ctx = createMockContext();
  try {
    await (await canvas.acquire(undefined, ctx)).query('SELECT 1');
  } finally {
    await canvas.shutdown(ctx);
  }
}, 60_000);

/**
 * Run `body` against a real DuckDB canvas wired into the bridge, then tear it
 * down. The faults wrap `canvas.acquire`, which `acquireShared` calls for both
 * the stored-id lookup and the mint.
 */
async function withCanvas(
  body: (harness: CanvasHarness) => Promise<void>,
  options?: CanvasOptions,
): Promise<void> {
  const canvas = newCanvas(options);
  const faults: Faults = {};
  const realAcquire = canvas.acquire.bind(canvas);
  canvas.acquire = async (...args: Parameters<DataCanvas['acquire']>) => {
    if (faults.acquire) throw new Error('Injected: canvas acquire failed');
    if (args[0] === undefined) await faults.mint?.();
    const instance = await realAcquire(...args);
    const realRegister = instance.registerTable.bind(instance);
    const realDrop = instance.drop.bind(instance);
    instance.registerTable = (...a: Parameters<CanvasInstance['registerTable']>) =>
      faults.registerTable ? faults.registerTable(realRegister, ...a) : realRegister(...a);
    instance.drop = (name: string) =>
      faults.drop ? Promise.reject(new Error('Injected: canvas drop failed')) : realDrop(name);
    return instance;
  };
  initCanvasBridge(canvas);
  try {
    await body({ canvas, faults });
  } finally {
    _resetCanvasBridge();
    await canvas.shutdown(createMockContext());
  }
}

it('preserves an execution-time conversion error and succeeds after TRY_CAST', DUCKDB_TIMEOUT, () =>
  withCanvas(async () => {
    const failure = await runToolContract(dataframeQueryTool, {
      sql: "SELECT CAST(value AS DOUBLE) FROM (VALUES ('not-numeric')) t(value)",
    });
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent).toMatchObject({
      error: {
        code: -32007,
        data: {
          reason: 'sql_execution_error',
          recovery: { hint: expect.stringContaining('TRY_CAST') },
        },
      },
    });
    expect(failure.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining('TRY_CAST') }),
    );
    const success = await runToolContract(dataframeQueryTool, {
      sql: "SELECT TRY_CAST(value AS DOUBLE) AS value FROM (VALUES ('not-numeric')) t(value)",
    });
    expect(success.isError).not.toBe(true);
    expect(success.structuredContent).toMatchObject({ rows: [{ value: null }] });
  }),
);

/** The declared recovery of `reason` on eia_dataframe_query. */
function declaredRecovery(reason: string): string {
  const declared = dataframeQueryTool.errors?.find((entry) => entry.reason === reason);
  expect(declared).toMatchObject({ code: JsonRpcErrorCode.ValidationError, thrownBy: 'service' });
  return declared?.recovery ?? '';
}

/** A wire hint that opens with a hint of the framework's own and closes with `declared`. */
const afterFrameworkHint = (declared: string) =>
  expect.stringMatching(
    new RegExp(`^[A-Z].*[.)] ${declared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  );

it(
  'puts the declared recovery after the framework hint on real gate refusals, and alone where the framework gives none',
  DUCKDB_TIMEOUT,
  () =>
    withCanvas(async () => {
      const ctx = createMockContext({ errors: dataframeQueryTool.errors });
      const run = (input: Record<string, unknown>) =>
        dataframeQueryTool.handler(dataframeQueryTool.input.parse(input), ctx);
      await run({ sql: 'SELECT 1 AS value', register_as: 'df_GATE' });
      for (const [sql, reason] of [
        ["SELECT current_setting('threads') FROM df_GATE", 'denied_function'],
        ['SELECT * FROM df_GATE; SELECT 1', 'multi_statement'],
        ["SELECT * FROM '/tmp/never-written.csv'", 'sql_read_only'],
        // A statement that parses but is not a SELECT is refused before it prepares, COPY included.
        ["COPY df_GATE TO '/tmp/never-written.csv'", 'non_select_statement'],
        ['SELECT nope FROM df_GATE', 'invalid_sql'],
      ] as const) {
        await expect(run({ sql })).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason, recovery: { hint: afterFrameworkHint(declaredRecovery(reason)) } },
        });
      }

      // The framework puts no hint on a register_as clash, so the declared one stands alone.
      await expect(run({ sql: 'SELECT 2 AS value', register_as: 'df_GATE' })).rejects.toMatchObject(
        {
          data: {
            reason: 'register_as_clash',
            recovery: { hint: declaredRecovery('register_as_clash') },
          },
        },
      );
    }),
);

it(
  'names the describe tool once in a recovery composed with the framework hint',
  DUCKDB_TIMEOUT,
  () =>
    withCanvas(async () => {
      const ctx = createMockContext({ errors: dataframeQueryTool.errors });
      const run = (input: Record<string, unknown>) =>
        dataframeQueryTool.handler(dataframeQueryTool.input.parse(input), ctx);
      await run({ sql: 'SELECT 1 AS value', register_as: 'df_GATE' });
      for (const [sql, reason] of [
        ["SELECT * FROM '/tmp/never-written.csv'", 'sql_read_only'],
        ['SELECT * FROM df_NEVER_STAGED', 'missing_table'],
        ['SELECT nope FROM df_GATE', 'invalid_sql'],
        ['SELECT * FROM information_schema.tables', 'system_catalog_access'],
      ] as const) {
        const err = await Promise.resolve()
          .then(() => run({ sql }))
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(err).toMatchObject({ data: { reason } });
        const { hint } = (err as { data: { recovery: { hint: string } } }).data.recovery;
        expect(hint.match(/dataframe-describe tool|eia_dataframe_describe/g)).toHaveLength(1);
      }
    }),
);

it(
  'carries the framework hint and the VARCHAR cast note on both surfaces of an invalid_sql refusal',
  DUCKDB_TIMEOUT,
  () =>
    withCanvas(async () => {
      const result = await runToolContract(dataframeQueryTool, {
        sql: "SELECT SUM(value) AS total FROM (VALUES ('9.13'), ('8.45')) t(value)",
      });
      const hint =
        "Correct the column or function the message names; list the staged columns with this server's dataframe-describe tool. A hyphen in a preview column name is an underscore in the staged table (price-units is price_units, respondent-name is respondent_name), and EIA values are VARCHAR: CAST(col AS DOUBLE) before arithmetic or aggregation.";

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32007,
          message: expect.stringContaining('sum(VARCHAR)'),
          data: { reason: 'invalid_sql', recovery: { hint } },
        },
      });
      expect(JSON.stringify(result.content)).toContain(hint);
    }),
);

it(
  'refuses a metadata-view name anywhere in a statement, and as a register_as name before anything stages',
  DUCKDB_TIMEOUT,
  () =>
    withCanvas(async () => {
      const ctx = createMockContext({ errors: dataframeQueryTool.errors });
      const run = (input: Record<string, unknown>) =>
        dataframeQueryTool.handler(dataframeQueryTool.input.parse(input), ctx);
      const declared =
        'If the name the message reports is a column alias, CTE, or register_as name of yours, rename it: a name spelled like a system catalog is refused wherever it appears.';
      // The gate's own hint leads a statement's refusal; a register_as name's has only the tool's.
      const hint = `Query only the staged dataframe tables; use this server's dataframe-describe tool to list them. ${declared}`;
      const refusal = (catalog: string, expected = hint) => ({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'system_catalog_access', catalog, recovery: { hint: expected } },
      });

      const aliased = await runToolContract(dataframeQueryTool, { sql: 'SELECT 1 AS pg_class' });
      expect(aliased.isError).toBe(true);
      expect(aliased.structuredContent).toMatchObject({
        error: {
          code: -32007,
          data: { reason: 'system_catalog_access', catalog: 'pg_class', recovery: { hint } },
        },
      });
      expect(JSON.stringify(aliased.content)).toContain(hint);
      await expect(run({ sql: 'SELECT 1 AS pg_class' })).rejects.toMatchObject(refusal('pg_class'));
      await expect(
        run({ sql: 'WITH pg_views AS (SELECT 1 AS v) SELECT * FROM pg_views' }),
      ).rejects.toMatchObject(refusal('pg_views'));
      await expect(run({ sql: 'SELECT 1 AS information_schema' })).rejects.toMatchObject(
        refusal('information_schema'),
      );
      // A duckdb_ prefix is refused only as a call; a longer name is a different word.
      expect((await run({ sql: 'SELECT 1 AS duckdb_x, 2 AS pg_tables_2024' })).rows).toEqual([
        { duckdb_x: 1, pg_tables_2024: 2 },
      ]);

      // A register_as name so spelled, in any case, is refused on both surfaces…
      const named = await runToolContract(dataframeQueryTool, {
        sql: 'SELECT 1 AS v',
        register_as: 'pg_tables',
      });
      expect(named.isError).toBe(true);
      expect(named.structuredContent).toMatchObject({
        error: {
          code: -32007,
          message: expect.stringContaining('Cannot register a dataframe as pg_tables'),
          data: {
            reason: 'system_catalog_access',
            catalog: 'pg_tables',
            recovery: { hint: declared },
          },
        },
      });
      expect(JSON.stringify(named.content)).toContain('Cannot register a dataframe as pg_tables');
      expect(JSON.stringify(named.content)).toContain(declared);
      await expect(run({ sql: 'SELECT 1 AS v', register_as: 'PG_Tables' })).rejects.toMatchObject(
        refusal('pg_tables', declared),
      );
      // …and nothing staged under it.
      const described = await dataframeDescribeTool.handler(
        dataframeDescribeTool.input.parse({}),
        ctx,
      );
      expect(described.active_names).toEqual([]);
      const nearMiss = await run({ sql: 'SELECT 2 AS v', register_as: 'pg_tables_2024' });
      expect(nearMiss.registered_as).toBe('pg_tables_2024');
      expect((await run({ sql: 'SELECT v FROM pg_tables_2024' })).rows).toEqual([{ v: 2 }]);
    }),
);

it(
  'admits range() and generate_series() with constant arguments and refuses a lateral one',
  DUCKDB_TIMEOUT,
  () =>
    withCanvas(async () => {
      const crossJoin = await runToolContract(dataframeQueryTool, {
        sql: 'SELECT count(*) AS n FROM range(100) a, range(100) b',
      });
      expect(crossJoin.isError).not.toBe(true);
      expect(crossJoin.structuredContent).toMatchObject({ rows: [{ n: '10000' }] });
      const series = await runToolContract(dataframeQueryTool, {
        sql: 'SELECT generate_series AS i FROM generate_series(1, 3)',
      });
      // BIGINT values reach JSON as strings.
      expect(series.structuredContent).toMatchObject({
        rows: [{ i: '1' }, { i: '2' }, { i: '3' }],
      });
      expect(JSON.stringify(series.content)).toContain('| i |\\n| --- |\\n| 1 |\\n| 2 |\\n| 3 |');

      const lateral = await runToolContract(dataframeQueryTool, {
        sql: 'SELECT * FROM (SELECT 3 AS n) t, range(t.n)',
      });
      expect(lateral.isError).toBe(true);
      expect(lateral.structuredContent).toMatchObject({
        error: { code: -32007, data: { reason: 'plan_operator_not_allowed' } },
      });
    }),
);

it(
  'refuses a PIVOT without an IN list as non_select_statement and runs one with it',
  DUCKDB_TIMEOUT,
  () =>
    withCanvas(async () => {
      const ctx = createMockContext({ errors: dataframeQueryTool.errors });
      const run = (input: Record<string, unknown>) =>
        dataframeQueryTool.handler(dataframeQueryTool.input.parse(input), ctx);
      await run({
        sql: "SELECT * FROM (VALUES ('WA', 'RES', '1'), ('WA', 'COM', '2')) t(stateid, sectorid, price)",
        register_as: 'df_PIVOT',
      });

      await expect(
        run({ sql: 'PIVOT df_PIVOT ON sectorid USING first(price)' }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'non_select_statement',
          // The framework's PIVOT hint, then the tool's own.
          recovery: {
            hint: 'A PIVOT runs as one SELECT only when it lists its values, as ON column IN (value, ...): list them, or rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables. To persist a result, pass register_as instead of writing to the canvas.',
          },
        },
      });
      const listed = await run({
        sql: "PIVOT df_PIVOT ON sectorid IN ('RES', 'COM') USING first(price)",
      });
      expect(listed.rows).toEqual([{ stateid: 'WA', RES: '1', COM: '2' }]);
    }),
);

it('keeps register_as materialize-all and preview zero after clamping', DUCKDB_TIMEOUT, () =>
  withCanvas(async () => {
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const staged = await dataframeQueryTool.handler(
      dataframeQueryTool.input.parse({
        sql: 'WITH d(x) AS (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)) SELECT a.x FROM d a, d b, d c, d e, d f LIMIT 10001',
        register_as: 'df_WHOLE',
        row_limit: 10001,
        preview: 0,
      }),
      ctx,
    );
    expect(staged.rows).toEqual([]);
    expect(staged.registered_as).toBe('df_WHOLE');
    const counted = await dataframeQueryTool.handler(
      dataframeQueryTool.input.parse({ sql: 'SELECT COUNT(*) AS n FROM df_WHOLE' }),
      ctx,
    );
    expect(Number(counted.rows[0]?.n)).toBe(10001);
  }),
);

it(
  'refuses the engine-setting, string-built, and file-reading SQL its description names',
  DUCKDB_TIMEOUT,
  () =>
    withCanvas(async () => {
      for (const [sql, reason] of [
        ["SELECT current_setting('threads')", 'denied_function'],
        ["SELECT * FROM query('SELECT ' || '1')", 'denied_function'],
        ["SELECT * FROM read_csv('eia.csv')", 'denied_function'],
        ["SELECT * FROM 'eia.csv'", 'sql_read_only'],
      ] as const) {
        const refused = await runToolContract(dataframeQueryTool, { sql });
        expect(refused.isError).toBe(true);
        expect(refused.structuredContent).toMatchObject({
          error: { code: -32007, data: { reason } },
        });
      }
    }),
);

// ---------------------------------------------------------------------------
// #60 — a staging or drop failure is reported as one, never as success.
// ---------------------------------------------------------------------------

/** A live electricity/retail-sales WA row shape, `price-units` hyphen included. */
const retailRow = (i: number) => ({
  period: `20${String(10 + Math.floor(i / 12)).padStart(2, '0')}-${String((i % 12) + 1).padStart(2, '0')}`,
  stateid: 'WA',
  stateDescription: 'Washington',
  sectorid: 'RES',
  sectorName: 'residential',
  price: '10.5',
  'price-units': 'cents per kilowatt-hour',
});

const INCOMPLETE_RETURN = {
  warning: 'incomplete return',
  description:
    'The API can only return 5000 rows in JSON format.  Please consider constraining your query with facet, start, or end, or using offset to paginate results.',
};

/**
 * Stand the EIA service up with its `query` answering a 40-row match whose
 * first 3 rows are the inline page; accumulation already walked the rest, so
 * no upstream traffic is spent.
 */
function stubRetailSalesQuery(): void {
  vi.stubEnv('EIA_API_KEY', 'test-key');
  initEiaApiService();
  vi.spyOn(getEiaApiService(), 'query').mockResolvedValue({
    route: 'electricity/retail-sales',
    total: 40,
    dateFormat: 'YYYY-MM',
    frequency: 'monthly',
    data: [retailRow(0), retailRow(1), retailRow(2)],
    warnings: [INCOMPLETE_RETURN],
    accumulated: {
      cap: 25000,
      capped: false,
      rows: Array.from({ length: 40 }, (_, i) => retailRow(i)),
    },
  });
}

function restoreEiaService(): void {
  _resetEiaApiService();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
}

const STAGE_INPUT = { route: 'electricity/retail-sales', length: 3, stage: true } as const;

/**
 * One context across several tools' handlers — provenance and the tenant's
 * canvas id live in its `ctx.state` — wired with every contract it serves.
 */
const sharedCtx = (options: { signal?: AbortSignal; tenantId?: string } = {}) =>
  createMockContext({
    ...options,
    errors: [
      ...(queryRouteTool.errors ?? []),
      ...(dataframeDropTool.errors ?? []),
      ...(dataframeQueryTool.errors ?? []),
      ...(dataframeDescribeTool.errors ?? []),
    ] as const,
  });
type SharedCtx = ReturnType<typeof sharedCtx>;

/** Stage the 40-row match on `ctx` and return the dataset handle. */
async function stage(ctx: SharedCtx): Promise<string> {
  const staged = await queryRouteTool.handler(queryRouteTool.input.parse(STAGE_INPUT), ctx);
  expect(staged.dataset).toMatch(/^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/);
  return staged.dataset as string;
}

/** Stage `SELECT <value> AS v` as `name` through `eia_dataframe_query`'s register_as. */
async function stageAs(ctx: SharedCtx, name: string, value: number): Promise<void> {
  const staged = await dataframeQueryTool.handler(
    dataframeQueryTool.input.parse({ sql: `SELECT ${value} AS v`, register_as: name, preview: 0 }),
    ctx,
  );
  expect(staged.registered_as).toBe(name);
}

async function countRows(ctx: SharedCtx, table: string) {
  const counted = await dataframeQueryTool.handler(
    dataframeQueryTool.input.parse({ sql: `SELECT COUNT(*) AS n FROM ${table}` }),
    ctx,
  );
  return Number(counted.rows[0]?.n);
}

async function activeNames(ctx: SharedCtx) {
  const described = await dataframeDescribeTool.handler(dataframeDescribeTool.input.parse({}), ctx);
  return described.active_names;
}

describe('staging and drop failures against a real canvas (#60)', DUCKDB_TIMEOUT, () => {
  beforeEach(stubRetailSalesQuery);
  afterEach(restoreEiaService);

  it('stages every accumulated row under a df_<id> handle', () =>
    withCanvas(async () => {
      const ctx = sharedCtx();
      const table = await stage(ctx);

      expect(await countRows(ctx, table)).toBe(40);
      expect(await activeNames(ctx)).toEqual([table]);
    }));

  // #62 — the rename the note quotes is one the staged table actually carries.
  it('quotes a rename that eia_dataframe_describe reports for the staged table', () =>
    withCanvas(async () => {
      const ctx = sharedCtx();
      const staged = await queryRouteTool.handler(queryRouteTool.input.parse(STAGE_INPUT), ctx);

      expect(staged.canvas_preview_note).toMatch(
        /^40 rows staged as df_\w+ — call eia_dataframe_describe for its column names \(hyphens become underscores: price-units → price_units\), then eia_dataframe_query to run SQL over it\./,
      );
      const described = await dataframeDescribeTool.handler(
        dataframeDescribeTool.input.parse({ name: staged.dataset }),
        ctx,
      );
      const columns = described.dataframes[0]?.column_schema.map((c) => c.name);
      expect(columns).toContain('price_units');
      expect(columns).not.toContain('price-units');
    }));

  it('reports a failed registration in-band and keeps the inline page', () =>
    withCanvas(async ({ faults }) => {
      faults.registerTable = () => Promise.reject(new Error('Injected: DuckDB appender failed'));

      const result = await runToolContract(queryRouteTool, STAGE_INPUT);
      const sc = result.structuredContent as Record<string, unknown>;
      const text = (result.content ?? []).map((b) => (b as { text?: string }).text ?? '').join('');

      // The inline rows are valid and the upstream request is spent — a
      // success call, with the missing dataframe stated rather than implied.
      expect(result.isError).not.toBe(true);
      expect(sc.data).toHaveLength(3);
      expect(sc.returned_count).toBe(3);
      expect(sc.total).toBe(40);
      expect(sc).not.toHaveProperty('dataset');
      const note = sc.canvas_preview_note as string;
      expect(note).toMatch(/^Staging failed, so no dataframe was created/);
      expect(note).toContain('stage: true');
      expect(note).toContain('offset');
      expect(text).toContain(note);
      // The note places the page against total, so EIA's per-page advisory adds nothing.
      expect(sc).not.toHaveProperty('truncation_warning');
      expect(text).not.toContain('5000 rows in JSON format');
    }));

  it('logs the failed registration at warning', () =>
    withCanvas(async ({ faults }) => {
      faults.registerTable = () => Promise.reject(new Error('Injected: DuckDB appender failed'));
      const ctx = sharedCtx();

      await queryRouteTool.handler(queryRouteTool.input.parse(STAGE_INPUT), ctx);

      const warning = (ctx.log as MockContextLogger).calls.find((c) => c.level === 'warning');
      expect(warning?.data).toMatchObject({ error: 'Injected: DuckDB appender failed' });
    }));

  it('leaves no partial table behind when registration fails midway', () =>
    withCanvas(async ({ canvas, faults }) => {
      const attempted: string[] = [];
      faults.registerTable = async (real, name, rows, options) => {
        attempted.push(name);
        await real(name, (rows as Record<string, unknown>[]).slice(0, 1), options);
        throw new Error('Injected: appender failed after the first row');
      };
      const ctx = sharedCtx();

      const result = await queryRouteTool.handler(queryRouteTool.input.parse(STAGE_INPUT), ctx);

      expect(result.dataset).toBeUndefined();
      expect(attempted).toHaveLength(1);
      const canvasId = await ctx.state.get<string>('eia-canvas-id');
      const instance = await canvas.acquire(canvasId ?? undefined, ctx);
      expect((await instance.describe()).map((t) => t.name)).not.toContain(attempted[0]);
    }));

  it('propagates a caller abort during registration as cancellation', () =>
    withCanvas(async ({ faults }) => {
      const controller = new AbortController();
      faults.registerTable = () => {
        controller.abort();
        return Promise.reject(controller.signal.reason);
      };

      const result = await runToolContract(queryRouteTool, STAGE_INPUT, {
        context: { signal: controller.signal },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled },
      });
    }));

  it('fails a drop the canvas could not perform, keeping the table and its provenance', () =>
    withCanvas(async ({ faults }) => {
      const ctx = sharedCtx();
      const table = await stage(ctx);

      faults.drop = true;
      await expect(
        dataframeDropTool.handler(dataframeDropTool.input.parse({ name: table }), ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'canvas_drop_failed', retryable: true },
      });
      faults.drop = false;

      expect(await activeNames(ctx)).toEqual([table]);
      expect(await countRows(ctx, table)).toBe(40);

      // Once the canvas answers, the retry drops the table it actually holds.
      const retry = await dataframeDropTool.handler(
        dataframeDropTool.input.parse({ name: table }),
        ctx,
      );
      expect(retry).toEqual({ name: table, dropped: true });
      expect(await activeNames(ctx)).toEqual([]);
    }));

  it('fails a drop when the canvas cannot be acquired, keeping provenance', () =>
    withCanvas(async ({ faults }) => {
      const ctx = sharedCtx();
      const table = await stage(ctx);

      faults.acquire = true;
      await expect(
        dataframeDropTool.handler(dataframeDropTool.input.parse({ name: table }), ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'canvas_drop_failed', retryable: true },
      });
      faults.acquire = false;

      expect(await activeNames(ctx)).toEqual([table]);
    }));
});

// ---------------------------------------------------------------------------
// #109 — concurrent calls on a tenant converge on its one canvas.
// ---------------------------------------------------------------------------

describe('one canvas per tenant under concurrent calls (#109)', DUCKDB_TIMEOUT, () => {
  beforeEach(stubRetailSalesQuery);
  afterEach(() => {
    vi.useRealTimers();
    restoreEiaService();
  });

  const drop = (ctx: SharedCtx, name: string) =>
    dataframeDropTool.handler(dataframeDropTool.input.parse({ name }), ctx);

  it('five concurrent stagings on a cold tenant share one canvas, every table listed and queryable', () =>
    withCanvas(async ({ canvas }) => {
      const ctx = sharedCtx();
      const names = ['race_1', 'race_2', 'race_3', 'race_4', 'race_5'];

      await Promise.all(names.map((name, i) => stageAs(ctx, name, i + 1)));

      expect(canvas.countForTenant(ctx)).toBe(1);
      expect((await activeNames(ctx)).toSorted()).toEqual(names);
      for (const [i, name] of names.entries()) {
        const read = await dataframeQueryTool.handler(
          dataframeQueryTool.input.parse({ sql: `SELECT v FROM ${name}` }),
          ctx,
        );
        expect(read.rows).toEqual([{ v: i + 1 }]);
      }
    }));

  it('one staging beside four describes on a cold tenant keeps the staged table', () =>
    withCanvas(async ({ canvas }) => {
      const ctx = sharedCtx();

      const [table, ...listings] = await Promise.all([
        stage(ctx),
        activeNames(ctx),
        activeNames(ctx),
        activeNames(ctx),
        activeNames(ctx),
      ]);

      expect(canvas.countForTenant(ctx)).toBe(1);
      // A describe that listed before the staging landed shows nothing yet.
      for (const listed of listings) expect([[], [table]]).toContainEqual(listed);
      expect(await activeNames(ctx)).toEqual([table]);
      expect(await countRows(ctx, table)).toBe(40);
    }));

  it('one staging beside four drops on a cold tenant keeps the staged table', () =>
    withCanvas(async ({ canvas }) => {
      const ctx = sharedCtx();

      const [, ...drops] = await Promise.all([
        stageAs(ctx, 'df_KEPT', 1),
        drop(ctx, 'df_GONE_1'),
        drop(ctx, 'df_GONE_2'),
        drop(ctx, 'df_GONE_3'),
        drop(ctx, 'df_GONE_4'),
      ]);

      expect(drops.map((d) => d.dropped)).toEqual([false, false, false, false]);
      expect(canvas.countForTenant(ctx)).toBe(1);
      expect(await activeNames(ctx)).toEqual(['df_KEPT']);
      expect(await countRows(ctx, 'df_KEPT')).toBe(1);
    }));

  it('after the idle TTL lapses the next call mints a new canvas and lists nothing from the dead one', () =>
    withCanvas(
      async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const ctx = sharedCtx();
        await stageAs(ctx, 'df_IDLE', 1);
        const first = await ctx.state.get<string>('eia-canvas-id');

        vi.setSystemTime(Date.now() + 61_000);

        expect(await activeNames(ctx)).toEqual([]);
        const second = await ctx.state.get<string>('eia-canvas-id');
        expect(second).toEqual(expect.any(String));
        expect(second).not.toBe(first);
        expect((await ctx.state.list('eia-df-meta/')).items).toEqual([]);
        await expect(countRows(ctx, 'df_IDLE')).rejects.toMatchObject({
          data: { reason: 'missing_table' },
        });
      },
      { registry: { ttlMs: 60_000 } },
    ));

  it('at the absolute cap the stored id expires with the canvas, and the next call lists nothing stale', () =>
    withCanvas(
      async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const ctx = sharedCtx();
        await stageAs(ctx, 'df_CAPPED', 1);
        const first = await ctx.state.get<string>('eia-canvas-id');
        expect(first).toEqual(expect.any(String));

        vi.setSystemTime(Date.now() + 121_000);

        expect(await ctx.state.get('eia-canvas-id')).toBeNull();
        expect(await activeNames(ctx)).toEqual([]);
        const second = await ctx.state.get<string>('eia-canvas-id');
        expect(second).toEqual(expect.any(String));
        expect(second).not.toBe(first);
        expect((await ctx.state.list('eia-df-meta/')).items).toEqual([]);
      },
      { registry: { absoluteCapMs: 120_000 } },
    ));

  it('fails each call whose acquire fails for another reason, keeping eia-canvas-id', () =>
    withCanvas(async ({ faults }) => {
      const ctx = sharedCtx();
      const table = await stage(ctx);
      const stored = await ctx.state.get<string>('eia-canvas-id');

      faults.acquire = true;
      await expect(activeNames(ctx)).rejects.toThrow('Injected: canvas acquire failed');
      await expect(countRows(ctx, table)).rejects.toThrow('Injected: canvas acquire failed');
      await expect(drop(ctx, table)).rejects.toMatchObject({
        data: { reason: 'canvas_drop_failed' },
      });
      const restaged = await queryRouteTool.handler(queryRouteTool.input.parse(STAGE_INPUT), ctx);
      expect(restaged.dataset).toBeUndefined();
      expect(restaged.canvas_preview_note).toMatch(/^Staging failed/);
      faults.acquire = false;

      expect(await ctx.state.get('eia-canvas-id')).toBe(stored);
      expect(await activeNames(ctx)).toEqual([table]);
      expect(await countRows(ctx, table)).toBe(40);
    }));

  it('cancels a call queued behind a mint, and the other calls converge on one canvas', () =>
    withCanvas(async ({ canvas, faults }) => {
      const minting = Promise.withResolvers<void>();
      const mintStarted = Promise.withResolvers<void>();
      faults.mint = () => {
        mintStarted.resolve();
        return minting.promise;
      };
      const ctx = sharedCtx();
      const first = stageAs(ctx, 'df_FIRST', 1);
      await mintStarted.promise;
      delete faults.mint;

      const controller = new AbortController();
      const cancelled = runToolContract(
        dataframeQueryTool,
        { sql: 'SELECT 2 AS v', register_as: 'df_CANCELLED' },
        { context: { signal: controller.signal } },
      );
      const second = stage(ctx);
      // Every step before the queue is a microtask, so one macrotask turn queues both calls.
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      minting.resolve();

      const [, table, refused] = await Promise.all([first, second, cancelled]);
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled },
      });
      expect(canvas.countForTenant(ctx)).toBe(1);
      expect((await activeNames(ctx)).toSorted()).toEqual(['df_FIRST', table].toSorted());
    }));

  it('reuses the stored canvas on a live tenant without minting', () =>
    withCanvas(async ({ canvas }) => {
      const ctx = sharedCtx();
      await stageAs(ctx, 'df_ONE', 1);
      const stored = await ctx.state.get<string>('eia-canvas-id');

      await stageAs(ctx, 'df_TWO', 2);

      expect(await ctx.state.get('eia-canvas-id')).toBe(stored);
      expect(canvas.countForTenant(ctx)).toBe(1);
      expect((await activeNames(ctx)).toSorted()).toEqual(['df_ONE', 'df_TWO']);
    }));

  it("gives two tenants staging concurrently one canvas each, neither reaching the other's tables", () =>
    withCanvas(async ({ canvas }) => {
      const a = sharedCtx({ tenantId: 'tenant-a' });
      const b = sharedCtx({ tenantId: 'tenant-b' });

      await Promise.all([
        stageAs(a, 'df_A1', 1),
        stageAs(b, 'df_B1', 2),
        stageAs(a, 'df_A2', 3),
        stageAs(b, 'df_B2', 4),
      ]);

      expect(canvas.countForTenant(a)).toBe(1);
      expect(canvas.countForTenant(b)).toBe(1);
      expect((await activeNames(a)).toSorted()).toEqual(['df_A1', 'df_A2']);
      expect((await activeNames(b)).toSorted()).toEqual(['df_B1', 'df_B2']);
      await expect(countRows(b, 'df_A1')).rejects.toMatchObject({
        data: { reason: 'missing_table' },
      });
      await expect(countRows(a, 'df_B1')).rejects.toMatchObject({
        data: { reason: 'missing_table' },
      });
    }));
});

// ---------------------------------------------------------------------------
// #96 — length and preview are the inline page, against real DuckDB results.
// ---------------------------------------------------------------------------

describe('page size against a real canvas (#96)', DUCKDB_TIMEOUT, () => {
  const surfaces = (result: { structuredContent?: unknown; content?: unknown }) => ({
    sc: result.structuredContent as Record<string, unknown> & {
      rows: Array<Record<string, unknown>>;
      data: Array<Record<string, unknown>>;
    },
    text: ((result.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? '').join(''),
  });

  /** A ten-row digit table to cross-join into larger results. */
  const DIGITS = 'WITH d(x) AS (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9))';

  /** About the width of an electricity/operating-generator-capacity row. */
  const plantRow = (i: number) => ({
    period: '2024-06',
    stateid: 'TX',
    plantid: String(50_000 + i),
    plantName: `Plant ${i}`,
    'nameplate-capacity-mw': '250.5',
    'nameplate-capacity-mw-units': 'MW',
    statusDescription: `Operating ${'w'.repeat(1_000)}`,
  });

  afterEach(() => {
    _resetEiaApiService();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('stages every accumulated row and returns the whole default 25-row page', () =>
    withCanvas(async ({ faults }) => {
      vi.stubEnv('EIA_API_KEY', 'test-key');
      initEiaApiService();
      const query = vi
        .spyOn(getEiaApiService(), 'query')
        .mockImplementation(async (_route, opts) => ({
          route: 'electricity/operating-generator-capacity',
          total: 26_000,
          dateFormat: 'YYYY-MM',
          frequency: 'monthly',
          data: Array.from({ length: opts.length ?? 0 }, (_, i) => plantRow(i)),
          warnings: undefined,
          accumulated: {
            cap: 600,
            capped: true,
            rows: Array.from({ length: 600 }, (_, i) => plantRow(i)),
          },
        }));
      const staged: number[] = [];
      faults.registerTable = (real, name, rows, options) => {
        staged.push((rows as unknown[]).length);
        return real(name, rows, options);
      };

      const result = await runToolContract(queryRouteTool, {
        route: 'electricity/operating-generator-capacity',
        stage: true,
      });
      const { sc } = surfaces(result);

      expect(query.mock.calls[0]?.[1]).toMatchObject({ length: 25, accumulate: true });
      expect(staged).toEqual([600]);
      expect(sc.dataset).toMatch(/^df_/);
      expect(sc.data).toEqual(Array.from({ length: 25 }, (_, i) => plantRow(i)));
      expect(sc.next_offset).toBe(25);
    }));

  it('shows 25 rows of a row_limit-capped cross join and names both bounds', () =>
    withCanvas(async () => {
      const result = await runToolContract(dataframeQueryTool, {
        sql: `${DIGITS} SELECT a.x * 10000 + b.x * 1000 + c.x * 100 + e.x * 10 + f.x AS i, repeat('w', 500) AS note FROM d a, d b, d c, d e, d f`,
        row_limit: 10_000,
      });
      const { sc } = surfaces(result);

      expect(sc).toMatchObject({ truncated: true, totalRows: 10_000, returnedRows: 25 });
      expect(sc.rows).toHaveLength(25);
      expect(sc.notice).toContain('row_limit cap of 10,000');
      expect(sc.notice).toContain(
        'preview then ended the inline rows at 25 of the 10,000 materialized',
      );
    }));

  /** The paging statement a notice prints, exactly as printed. */
  const printedPage = (notice: unknown) =>
    String(notice).match(/SELECT \* FROM \w+ LIMIT (\d+) OFFSET (\d+)/);

  it('returns every preview row whole on register_as, and its printed paging SQL continues the page', () =>
    withCanvas(async () => {
      const sql = `${DIGITS}, n AS (SELECT a.x * 1000 + b.x * 100 + c.x * 10 + e.x AS i FROM d a, d b, d c, d e) SELECT i, repeat('w', 500) AS note FROM n WHERE i < 1500 ORDER BY i`;
      const result = await runToolContract(dataframeQueryTool, {
        sql,
        register_as: 'wide_rows',
        preview: 1000,
      });
      const { sc } = surfaces(result);

      // About 520 KB of rows, every one inline.
      expect(sc).toMatchObject({ truncated: false, totalRows: 1500, returnedRows: 1000 });
      expect(sc.rows.map((r) => Number(r.i))).toEqual(Array.from({ length: 1000 }, (_, n) => n));
      expect(sc.notice).toBe(
        'Showing 1,000 of 1,500 rows — preview capped the inline slice (it defaults to 25). The whole result is staged as wide_rows: page it with SELECT * FROM wide_rows LIMIT 1000 OFFSET 1000, raising OFFSET by 1000 for each further page (no ORDER BY: the table keeps the order the preview showed, and a sort reorders it).',
      );

      // The notice's paging SQL, run verbatim on one tenant's canvas, picks up
      // where the inline rows ended.
      const ctx = createMockContext({ errors: dataframeQueryTool.errors });
      await dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({ sql, register_as: 'wide_rows', preview: 0 }),
        ctx,
      );
      const next = await dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({ sql: printedPage(sc.notice)?.[0], preview: 1000 }),
        ctx,
      );
      expect(next.rows.map((r) => Number(r.i))).toEqual(
        Array.from({ length: 500 }, (_, n) => 1000 + n),
      );
    }));

  /**
   * The canvas previews a register_as table with `SELECT * FROM <name> LIMIT n`,
   * so the printed paging SQL is right only if LIMIT/OFFSET over the stored
   * table walks the same order the preview did, every call. 250,000 rows span
   * three DuckDB row groups (122,880 rows each), which parallel scans split
   * across threads; GROUP BY's hash aggregate stores them in no order of `id`,
   * so a re-sort cannot pass for the stored order. `rowid` is that order.
   */
  it.each([128, 1024])(
    'walks a 250,000-row register_as table by the printed paging SQL, no row repeated or skipped (%i MB canvas)',
    (memoryLimitMb) =>
      withCanvas(
        async () => {
          const ctx = createMockContext({ errors: dataframeQueryTool.errors });
          const run = (input: Record<string, unknown>) =>
            dataframeQueryTool.handler(dataframeQueryTool.input.parse(input), ctx);
          const ids = (result: { rows: Array<Record<string, unknown>> }) =>
            result.rows.map((r) => String(r.id));
          const storedOrder = async (limit: number, offset: number) =>
            ids(
              await run({
                sql: `SELECT id FROM big ORDER BY rowid LIMIT ${limit} OFFSET ${offset}`,
                row_limit: limit,
                preview: limit,
              }),
            );

          const first = await run({
            sql: `${DIGITS}, n AS (SELECT a.x * 100000 + b.x * 10000 + c.x * 1000 + e.x * 100 + f.x * 10 + g.x AS i FROM d a, d b, d c, d e, d f, d g) SELECT 'r' || i AS id FROM n WHERE i < 250000 GROUP BY id`,
            register_as: 'big',
            preview: 1000,
          });
          expect(getEnrichment(ctx)).toMatchObject({ totalRows: 250_000, truncated: false });
          const page1 = ids(first);
          expect(page1).toHaveLength(1000);
          expect(page1).not.toEqual(page1.toSorted());

          const printed = printedPage(getEnrichment(ctx).notice);
          expect(printed?.slice(1)).toEqual(['1000', '1000']);
          const page2 = ids(await run({ sql: printed?.[0], preview: 1000 }));
          // "raising OFFSET by 1000 for each further page"
          const pageAt = async (offset: number) =>
            ids(await run({ sql: `SELECT * FROM big LIMIT 1000 OFFSET ${offset}`, preview: 1000 }));
          const page3 = await pageAt(2000);

          const walked = [...page1, ...page2, ...page3];
          expect(new Set(walked).size).toBe(3000);
          expect(walked).toEqual(await storedOrder(3000, 0));
          for (let repeat = 0; repeat < 3; repeat++) expect(await pageAt(1000)).toEqual(page2);
          // Two pages straddling the first row-group boundary at 122,880.
          expect([...(await pageAt(121_880)), ...(await pageAt(122_880))]).toEqual(
            await storedOrder(2000, 121_880),
          );
        },
        { memoryLimitMb },
      ),
  );

  it('echoes a statement far larger than 64 KB whole', () =>
    withCanvas(async () => {
      const sql = `SELECT 1 AS one /* ${'x'.repeat(200_000)} */`;
      const result = await runToolContract(dataframeQueryTool, { sql });
      const { sc, text } = surfaces(result);

      expect(result.isError).not.toBe(true);
      expect(sc.rows).toEqual([{ one: 1 }]);
      expect(sc.executedSql).toBe(sql);
      expect(text).toContain(`**executedSql:** \`${sql}\``);
    }));
});
