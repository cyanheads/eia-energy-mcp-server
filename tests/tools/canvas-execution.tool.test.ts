/**
 * @fileoverview Real DuckDB execution failures, gate refusals, and recovery through the EIA tools —
 * including staging and drop failures injected into the canvas instance the bridge acquires.
 * @module tests/tools/canvas-execution.tool.test
 */
import {
  type CanvasInstance,
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
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

function newCanvas(): DataCanvas {
  const provider = new DuckdbProvider({
    defaultRowLimit: 10000,
    exportRootPath: '/tmp/eia-canvas-tests',
    memoryLimitMb: 128,
    schemaSniffRows: 100,
  });
  return new DataCanvas(
    provider,
    new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
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

/** Run `body` against a real DuckDB canvas wired into the bridge, then tear it down. */
async function withCanvas(body: (harness: CanvasHarness) => Promise<void>): Promise<void> {
  const canvas = newCanvas();
  const faults: Faults = {};
  const realAcquire = canvas.acquire.bind(canvas);
  canvas.acquire = async (...args: Parameters<DataCanvas['acquire']>) => {
    if (faults.acquire) throw new Error('Injected: canvas acquire failed');
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

it(
  'declares SQL gate reasons and applies their recoveries to real staged-table failures',
  DUCKDB_TIMEOUT,
  () =>
    withCanvas(async () => {
      const ctx = createMockContext({ errors: dataframeQueryTool.errors });
      await dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({ sql: 'SELECT 1 AS value', register_as: 'df_GATE' }),
        ctx,
      );
      for (const [sql, reason, recovery] of [
        [
          "SELECT current_setting('threads') FROM df_GATE",
          'denied_function',
          'Select from staged dataframes using ordinary SQL expressions; eia_dataframe_describe lists their columns.',
        ],
        [
          'SELECT * FROM df_GATE; SELECT 1',
          'multi_statement',
          'Send one SELECT per eia_dataframe_query call; use register_as to chain results.',
        ],
        [
          "COPY df_GATE TO '/tmp/never-written.csv'",
          'sql_read_only',
          'Query staged dataframes with a read-only SELECT; use register_as to persist results.',
        ],
      ] as const) {
        const declared = dataframeQueryTool.errors?.find((entry) => entry.reason === reason);
        expect(declared).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          thrownBy: 'service',
          recovery,
        });
        await expect(
          dataframeQueryTool.handler(dataframeQueryTool.input.parse({ sql }), ctx),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason, recovery: { hint: recovery } },
        });
      }
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

describe('staging and drop failures against a real canvas (#60)', DUCKDB_TIMEOUT, () => {
  beforeEach(() => {
    vi.stubEnv('EIA_API_KEY', 'test-key');
    initEiaApiService();
    // A 40-row match whose first 3 rows are the inline page; accumulation
    // already walked the rest, so no upstream traffic is spent.
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
  });

  afterEach(() => {
    _resetEiaApiService();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const STAGE_INPUT = { route: 'electricity/retail-sales', length: 3, stage: true } as const;

  /**
   * One context across several tools' handlers — provenance and the tenant's
   * canvas id live in its `ctx.state` — wired with every contract it serves.
   */
  const sharedCtx = (options: { signal?: AbortSignal } = {}) =>
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

  async function countRows(ctx: SharedCtx, table: string) {
    const counted = await dataframeQueryTool.handler(
      dataframeQueryTool.input.parse({ sql: `SELECT COUNT(*) AS n FROM ${table}` }),
      ctx,
    );
    return Number(counted.rows[0]?.n);
  }

  async function activeNames(ctx: SharedCtx) {
    const described = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({}),
      ctx,
    );
    return described.active_names;
  }

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
// #58 — the inline byte budget against real DuckDB results.
// ---------------------------------------------------------------------------

describe('inline byte budget against a real canvas (#58)', DUCKDB_TIMEOUT, () => {
  const BUDGET = 64_000;
  const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
  const surfaces = (result: { structuredContent?: unknown; content?: unknown }) => ({
    sc: result.structuredContent as Record<string, unknown> & {
      rows: Array<Record<string, unknown>>;
      data: Array<Record<string, unknown>>;
    },
    scBytes: bytes(JSON.stringify(result.structuredContent)),
    textBytes: bytes(
      ((result.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? '').join(''),
    ),
  });

  /** A ten-row digit table to cross-join into larger results (range() is gated off). */
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

  it('stages every accumulated row while the inline page ends at the budget', () =>
    withCanvas(async ({ faults }) => {
      vi.stubEnv('EIA_API_KEY', 'test-key');
      initEiaApiService();
      vi.spyOn(getEiaApiService(), 'query').mockResolvedValue({
        route: 'electricity/operating-generator-capacity',
        total: 26_000,
        dateFormat: 'YYYY-MM',
        frequency: 'monthly',
        data: Array.from({ length: 100 }, (_, i) => plantRow(i)),
        warnings: undefined,
        accumulated: {
          cap: 600,
          capped: true,
          rows: Array.from({ length: 600 }, (_, i) => plantRow(i)),
        },
      });
      const staged: number[] = [];
      faults.registerTable = (real, name, rows, options) => {
        staged.push((rows as unknown[]).length);
        return real(name, rows, options);
      };

      const result = await runToolContract(queryRouteTool, {
        route: 'electricity/operating-generator-capacity',
        stage: true,
      });
      const { sc, scBytes, textBytes } = surfaces(result);

      expect(staged).toEqual([600]);
      expect(sc.dataset).toMatch(/^df_/);
      expect(sc.data.length).toBeLessThan(100);
      expect(sc.next_offset).toBe(sc.data.length);
      expect(scBytes).toBeLessThanOrEqual(BUDGET);
      expect(textBytes).toBeLessThanOrEqual(BUDGET);
    }));

  it('holds a row_limit-capped cross-join result to the budget and names both caps', () =>
    withCanvas(async () => {
      const result = await runToolContract(dataframeQueryTool, {
        sql: `${DIGITS} SELECT a.x * 10000 + b.x * 1000 + c.x * 100 + e.x * 10 + f.x AS i, repeat('w', 500) AS note FROM d a, d b, d c, d e, d f`,
        row_limit: 10_000,
      });
      const { sc, scBytes, textBytes } = surfaces(result);

      expect(sc.truncated).toBe(true);
      expect(sc.totalRows).toBe(10_000);
      expect(sc.returnedRows).toBe(sc.rows.length);
      expect(sc.rows.length).toBeLessThan(10_000);
      expect(sc.notice).toContain('row_limit cap of 10,000');
      expect(sc.notice).toContain('64,000-byte response budget then ended the inline rows');
      expect(scBytes).toBeLessThanOrEqual(BUDGET);
      expect(textBytes).toBeLessThanOrEqual(BUDGET);
    }));

  it('reports an exact count past the budget on register_as, and its paging SQL continues the page', () =>
    withCanvas(async () => {
      const sql = `${DIGITS}, n AS (SELECT a.x * 1000 + b.x * 100 + c.x * 10 + e.x AS i FROM d a, d b, d c, d e) SELECT i, repeat('w', 500) AS note FROM n WHERE i < 1500`;
      const result = await runToolContract(dataframeQueryTool, { sql, register_as: 'wide_rows' });
      const { sc, scBytes, textBytes } = surfaces(result);
      const shown = sc.rows.length;

      expect(sc).toMatchObject({ truncated: false, totalRows: 1500, returnedRows: shown });
      expect(shown).toBeLessThan(1500);
      expect(sc.notice).toContain(
        `The whole result is staged as wide_rows: page it with SELECT * FROM wide_rows ORDER BY <columns> LIMIT ${shown} OFFSET ${shown}.`,
      );
      expect(scBytes).toBeLessThanOrEqual(BUDGET);
      expect(textBytes).toBeLessThanOrEqual(BUDGET);

      // The notice's paging SQL, run on one tenant's canvas, picks up where the
      // inline rows ended.
      const ctx = createMockContext({ errors: dataframeQueryTool.errors });
      await dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({ sql, register_as: 'wide_rows', preview: 0 }),
        ctx,
      );
      const next = await dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({
          sql: `SELECT * FROM wide_rows ORDER BY i LIMIT ${shown} OFFSET ${shown}`,
        }),
        ctx,
      );
      expect(next.rows.map((r) => Number(r.i))).toEqual(
        Array.from({ length: shown }, (_, n) => shown + n),
      );
    }));

  it('bounds the echo of a statement far larger than the budget', () =>
    withCanvas(async () => {
      const sql = `SELECT 1 AS one /* ${'x'.repeat(200_000)} */`;
      const result = await runToolContract(dataframeQueryTool, { sql });
      const { sc, scBytes, textBytes } = surfaces(result);

      expect(result.isError).not.toBe(true);
      expect(sc.rows).toEqual([{ one: 1 }]);
      expect(sc.executedSql).toMatch(
        new RegExp(
          ` … \\[echo cut here — the full ${bytes(sql).toLocaleString()}-byte statement ran\\]$`,
        ),
      );
      expect(scBytes).toBeLessThanOrEqual(BUDGET);
      expect(textBytes).toBeLessThanOrEqual(BUDGET);
    }));
});
