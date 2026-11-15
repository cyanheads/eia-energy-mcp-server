/**
 * @fileoverview Tests for the canvas-bridge service — deriveAllNullableSchema
 * and CanvasBridge register/describe/query/drop behaviour.
 * @module tests/services/canvas-bridge.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import {
  CanvasBridge,
  type DataframeMeta,
  deriveAllNullableSchema,
  sanitizeColumnName,
} from '@/services/canvas-bridge/canvas-bridge.js';

// ---------------------------------------------------------------------------
// deriveAllNullableSchema — pure logic
// ---------------------------------------------------------------------------

describe('deriveAllNullableSchema', () => {
  it('marks all columns nullable=true', () => {
    const rows = [
      { period: '2024-01', value: '9.13', stateid: 'TX' },
      { period: '2024-02', value: '8.45', stateid: 'CA' },
    ];
    const schema = deriveAllNullableSchema(rows);
    expect(schema.length).toBeGreaterThan(0);
    for (const col of schema) {
      expect(col.nullable).toBe(true);
    }
  });

  it('returns schema with expected column names from sample rows', () => {
    const rows = [{ period: '2024-01', value: '100' }];
    const schema = deriveAllNullableSchema(rows);
    const names = schema.map((c) => c.name);
    expect(names).toContain('period');
    expect(names).toContain('value');
  });

  it('throws on empty rows array (framework requirement)', () => {
    // inferSchemaFromRows requires at least one row — empty input is a caller error.
    expect(() => deriveAllNullableSchema([])).toThrow();
  });

  it('handles rows with null values (sparse EIA columns)', () => {
    const rows = [
      { period: '2024-01', value: null, 'value-units': null },
      { period: '2024-02', value: '8.0', 'value-units': 'MMBtu' },
    ];
    const schema = deriveAllNullableSchema(rows as unknown as Record<string, unknown>[]);
    expect(schema.length).toBeGreaterThan(0);
    for (const col of schema) {
      expect(col.nullable).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// sanitizeColumnName — canvas identifier normalization (#25)
// ---------------------------------------------------------------------------

describe('sanitizeColumnName', () => {
  it('replaces the hyphen in {col}-units companion columns with an underscore', () => {
    expect(sanitizeColumnName('revenue-units')).toBe('revenue_units');
    expect(sanitizeColumnName('value-units')).toBe('value_units');
  });

  it('leaves already-valid identifiers unchanged', () => {
    expect(sanitizeColumnName('period')).toBe('period');
    expect(sanitizeColumnName('value_2')).toBe('value_2');
    expect(sanitizeColumnName('_hidden')).toBe('_hidden');
  });

  it('prefixes an underscore when the name starts with a digit', () => {
    expect(sanitizeColumnName('2024total')).toBe('_2024total');
  });

  it('replaces every character outside [A-Za-z0-9_]', () => {
    expect(sanitizeColumnName('a.b c-d')).toBe('a_b_c_d');
  });

  it('caps the result at the 63-char identifier limit', () => {
    expect(sanitizeColumnName('x'.repeat(100))).toHaveLength(63);
  });
});

// ---------------------------------------------------------------------------
// CanvasBridge — behavior tests using a mock DataCanvas
// ---------------------------------------------------------------------------

function makeMockCanvas() {
  const mockInstance = {
    canvasId: 'canvas-001',
    registerTable: vi.fn(),
    query: vi.fn(),
    drop: vi.fn(),
    describe: vi.fn().mockResolvedValue([]),
  };
  const mockCanvas = {
    acquireShared: vi.fn().mockResolvedValue(mockInstance),
  };
  return { mockCanvas, mockInstance };
}

/** Stored provenance for `tableName`; expiry is the canvas's, never persisted. */
function storedMeta(tableName: string, createdAt = new Date().toISOString()): DataframeMeta {
  return {
    tableName,
    sourceTool: 'eia_query_route',
    queryParams: { route: 'steo' },
    createdAt,
    rowCount: 5,
    truncated: false,
    maxRows: undefined,
    columnSchema: [{ name: 'value', type: 'VARCHAR', nullable: true }],
  };
}

describe('CanvasBridge', () => {
  describe('registerDataframe', () => {
    it('reports skipped, touching no canvas, when rows are empty', async () => {
      const { mockCanvas } = makeMockCanvas();
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.registerDataframe(ctx, {
        rows: [],
        sourceTool: 'eia_query_route',
        queryParams: { route: 'steo' },
      });

      expect(result).toEqual({ status: 'skipped' });
      expect(mockCanvas.acquireShared).not.toHaveBeenCalled();
    });

    it('registers a table and returns metadata with correct shape', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.registerTable.mockResolvedValue({
        tableName: 'df_ABCDE_FGHIJ',
        rowCount: 2,
      });
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.registerDataframe(ctx, {
        rows: [
          { period: '2024-01', value: '9.13' },
          { period: '2024-02', value: '8.45' },
        ],
        sourceTool: 'eia_query_route',
        queryParams: { route: 'electricity/retail-sales' },
        truncated: false,
      });

      expect(result).toMatchObject({
        status: 'registered',
        tableName: 'df_ABCDE_FGHIJ',
        rowCount: 2,
        columnSchema: [
          { name: 'period', type: 'VARCHAR', nullable: true },
          { name: 'value', type: 'VARCHAR', nullable: true },
        ],
        renamedColumns: [],
      });
    });

    // Regression for #30: the sliding window is the framework's, opted into via
    // ttlMs. Without it the table follows the canvas lifecycle and the bridge is
    // back to advertising a slide nothing performs.
    it('opts the table into the framework sliding TTL and stores no expiry of its own', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-12T00:00:00.000Z') });
      try {
        const { mockCanvas, mockInstance } = makeMockCanvas();
        mockInstance.registerTable.mockResolvedValue({ tableName: 'df_TTL', rowCount: 1 });
        const bridge = new CanvasBridge(mockCanvas as never);
        const ctx = createMockContext({ tenantId: 'test' });

        const result = await bridge.registerDataframe(ctx, {
          rows: [{ period: '2024-01', value: '9.13' }],
          sourceTool: 'eia_query_route',
          queryParams: { route: 'steo' },
        });

        const [, , opts] = mockInstance.registerTable.mock.calls[0] as [
          string,
          Record<string, unknown>[],
          { ttlMs?: number },
        ];
        expect(opts.ttlMs).toBe(86_400_000);
        // The window the canvas just started, one default TTL past registration.
        expect(result).toMatchObject({
          status: 'registered',
          expiresAt: '2026-10-13T00:00:00.000Z',
        });
        expect(await ctx.state.get('eia-df-meta/df_TTL')).toMatchObject({
          createdAt: '2026-10-12T00:00:00.000Z',
        });
        expect(await ctx.state.get('eia-df-meta/df_TTL')).not.toHaveProperty('expiresAt');
      } finally {
        vi.useRealTimers();
      }
    });

    // Regression for #30: the canvas sweeper removes tables without telling the
    // bridge, and the local sweep that used to run on every operation is gone.
    // Reconciling on the write path is what keeps provenance from accumulating
    // for a caller that stages and queries but never lists.
    it('reconciles stale provenance before staging a new dataframe', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.registerTable.mockResolvedValue({ tableName: 'df_NEW', rowCount: 1 });
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });
      await ctx.state.set('eia-df-meta/df_SWEPT', storedMeta('df_SWEPT'));

      await bridge.registerDataframe(ctx, {
        rows: [{ period: '2024-01', value: '9.13' }],
        sourceTool: 'eia_query_route',
        queryParams: { route: 'steo' },
      });

      expect(await ctx.state.get('eia-df-meta/df_SWEPT')).toBeNull();
      expect(await ctx.state.get('eia-df-meta/df_NEW')).not.toBeNull();
    });

    // #60 — a canvas failure is an outcome distinct from the empty-rows no-op,
    // carrying the failure, and leaves neither provenance nor a partial table.
    it('reports failed with the canvas message when registration throws', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.registerTable.mockRejectedValue(new Error('DuckDB error'));
      mockInstance.drop.mockResolvedValue(true);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.registerDataframe(ctx, {
        rows: [{ period: '2024-01', value: '9.13' }],
        sourceTool: 'eia_query_route',
        queryParams: { route: 'steo' },
      });

      expect(result).toEqual({ status: 'failed', message: 'DuckDB error' });
      const [attempted] = mockInstance.registerTable.mock.calls[0] as [string];
      expect(mockInstance.drop).toHaveBeenCalledWith(attempted);
      expect((await ctx.state.list('eia-df-meta/')).items).toEqual([]);
    });

    it('reports failed when the canvas cannot be acquired', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockCanvas.acquireShared.mockRejectedValue(new Error('capacity exhausted'));
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.registerDataframe(ctx, {
        rows: [{ period: '2024-01', value: '9.13' }],
        sourceTool: 'eia_query_route',
        queryParams: { route: 'steo' },
      });

      expect(result).toEqual({ status: 'failed', message: 'capacity exhausted' });
      // No table was attempted, so there is nothing to clean up.
      expect(mockInstance.drop).not.toHaveBeenCalled();
    });

    it('rethrows a failure that follows a caller abort instead of reporting it', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      const controller = new AbortController();
      mockInstance.registerTable.mockImplementation(() => {
        controller.abort();
        return Promise.reject(controller.signal.reason);
      });
      mockInstance.drop.mockResolvedValue(true);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test', signal: controller.signal });

      await expect(
        bridge.registerDataframe(ctx, {
          rows: [{ period: '2024-01', value: '9.13' }],
          sourceTool: 'eia_query_route',
          queryParams: { route: 'steo' },
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      // The signal also reaches the canvas, so the append itself stops early.
      const [, , opts] = mockInstance.registerTable.mock.calls[0] as [
        string,
        unknown,
        { signal?: AbortSignal },
      ];
      expect(opts.signal).toBe(controller.signal);
    });

    // Regression for #25: EIA's {col}-units companion columns carry a hyphen the
    // canvas identifier gate rejects, which previously made registration silently
    // return undefined (canvas_id: null) for nearly every data query.
    it('sanitizes hyphenated {col}-units columns before registration', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.registerTable.mockResolvedValue({ tableName: 'df_AB_CD', rowCount: 2 });
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.registerDataframe(ctx, {
        rows: [
          { period: '2024-01', revenue: '9.13', 'revenue-units': 'million dollars' },
          { period: '2024-02', revenue: '8.45', 'revenue-units': 'million dollars' },
        ],
        sourceTool: 'eia_query_route',
        queryParams: { route: 'electricity/retail-sales' },
      });

      expect(result.status).toBe('registered');
      expect(mockInstance.registerTable).toHaveBeenCalledTimes(1);
      const [, rows, opts] = mockInstance.registerTable.mock.calls[0] as [
        string,
        Record<string, unknown>[],
        { schema: { name: string }[] },
      ];
      const schemaNames = opts.schema.map((c) => c.name);
      expect(schemaNames).toContain('revenue_units');
      expect(schemaNames).not.toContain('revenue-units');
      // The appender reads row[col.name], so the row keys must match the schema.
      expect(Object.keys(rows[0] ?? {})).toContain('revenue_units');
      expect(rows[0]?.revenue_units).toBe('million dollars');
      // Stored metadata advertises the sanitized names via eia_dataframe_describe.
      expect(result.status === 'registered' && result.columnSchema.map((c) => c.name)).toContain(
        'revenue_units',
      );
      // #62 — the renames travel back so the tool can quote one to the caller.
      expect(result).toMatchObject({
        renamedColumns: [{ from: 'revenue-units', to: 'revenue_units' }],
      });
    });

    it('reports every renamed column in column order, collisions included', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.registerTable.mockResolvedValue({ tableName: 'df_RENAMES', rowCount: 1 });
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.registerDataframe(ctx, {
        rows: [{ period: '2024', 'respondent-name': 'x', respondent_name: 'y', '2024total': '1' }],
        sourceTool: 'eia_query_route',
        queryParams: {},
      });

      expect(result).toMatchObject({
        renamedColumns: [
          { from: 'respondent-name', to: 'respondent_name' },
          { from: 'respondent_name', to: 'respondent_name_2' },
          { from: '2024total', to: '_2024total' },
        ],
      });
    });

    it('does not mutate the caller rows (inline preview keeps {col}-units keys)', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.registerTable.mockResolvedValue({ tableName: 'df_X', rowCount: 1 });
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const original = [{ period: '2024-01', 'value-units': 'MMBtu' }];
      await bridge.registerDataframe(ctx, {
        rows: original,
        sourceTool: 'eia_query_route',
        queryParams: {},
      });

      expect(Object.keys(original[0] ?? {})).toContain('value-units');
    });
  });

  describe('describe', () => {
    it('returns empty array when no dataframes are registered', async () => {
      const { mockCanvas } = makeMockCanvas();
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.describe(ctx);
      expect(result).toEqual([]);
    });

    // Regression for #30: expiry is the canvas's live per-table value, not a
    // copy frozen into ctx.state at registration. A query slides the canvas
    // value; a stored copy would report the creation-time expiry forever.
    it('reports the expiry the canvas currently holds, not a stored one', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      const slidExpiry = new Date(Date.now() + 86_400_000).toISOString();
      mockInstance.describe.mockResolvedValue([
        { name: 'df_TEST', kind: 'table', rowCount: 5, columns: [], expiresAt: slidExpiry },
      ]);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });
      await ctx.state.set('eia-df-meta/df_TEST', storedMeta('df_TEST'));

      const result = await bridge.describe(ctx);
      expect(result).toHaveLength(1);
      expect(result[0]?.tableName).toBe('df_TEST');
      expect(result[0]?.expiresAt).toBe(slidExpiry);
    });

    // Regression for #30: sweepExpired() is gone — the canvas's own sweeper
    // drops lapsed tables, so describe reconciles provenance against the live
    // table list instead of running a second clock.
    it('deletes provenance for a table the canvas no longer holds', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.describe.mockResolvedValue([
        { name: 'df_LIVE', kind: 'table', rowCount: 5, columns: [], expiresAt: 'later' },
      ]);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });
      await ctx.state.set('eia-df-meta/df_LIVE', storedMeta('df_LIVE'));
      await ctx.state.set('eia-df-meta/df_SWEPT', storedMeta('df_SWEPT'));

      const result = await bridge.describe(ctx);
      expect(result.map((e) => e.tableName)).toEqual(['df_LIVE']);
      expect(await ctx.state.get('eia-df-meta/df_SWEPT')).toBeNull();
    });

    // A table that commits after the canvas's listing has begun, and whose
    // provenance lands before the bridge reads provenance, is not in that
    // listing. Reading provenance first leaves its entry for the next pass.
    it('keeps provenance for a table registered while the canvas listing is in flight', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });
      const meta = storedMeta('df_NEW');
      mockInstance.describe.mockImplementation(async () => {
        await ctx.state.set('eia-df-meta/df_NEW', meta);
        return [];
      });

      expect(await bridge.describe(ctx)).toEqual([]);
      expect(await ctx.state.get('eia-df-meta/df_NEW')).toEqual(meta);

      // The next pass sees the table and lists it.
      mockInstance.describe.mockResolvedValue([
        { name: 'df_NEW', kind: 'table', rowCount: 5, columns: [], expiresAt: 'later' },
      ]);
      expect((await bridge.describe(ctx)).map((e) => e.tableName)).toEqual(['df_NEW']);
    });

    it('orders entries newest first', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.describe.mockResolvedValue([
        { name: 'df_OLD', kind: 'table', rowCount: 1, columns: [], expiresAt: 'later' },
        { name: 'df_NEW', kind: 'table', rowCount: 1, columns: [], expiresAt: 'later' },
      ]);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });
      await ctx.state.set('eia-df-meta/df_OLD', storedMeta('df_OLD', '2026-01-01T00:00:00.000Z'));
      await ctx.state.set('eia-df-meta/df_NEW', storedMeta('df_NEW', '2026-02-01T00:00:00.000Z'));

      const result = await bridge.describe(ctx);
      expect(result.map((e) => e.tableName)).toEqual(['df_NEW', 'df_OLD']);
    });
  });

  describe('query', () => {
    // Regression for #30: register_as chains must carry the sliding TTL too,
    // or a chained dataframe reverts to the canvas lifecycle.
    it('passes ttlMs alongside registerAs so the chained table slides', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.query.mockResolvedValue({
        columns: ['x'],
        rows: [{ x: 1 }],
        rowCount: 1,
        tableName: 'df_CHAIN',
      });
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const { meta } = await bridge.query(ctx, 'SELECT 1 AS x', { registerAs: 'df_CHAIN' });

      const [, opts] = mockInstance.query.mock.calls[0] as [string, { ttlMs?: number }];
      expect(opts.ttlMs).toBe(86_400_000);
      expect(meta?.expiresAt).toBeDefined();
      // Expiry is never persisted — the canvas owns it from here.
      expect(await ctx.state.get('eia-df-meta/df_CHAIN')).not.toHaveProperty('expiresAt');
    });

    it('omits ttlMs when no registerAs is supplied', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.query.mockResolvedValue({ columns: ['x'], rows: [], rowCount: 0 });
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      await bridge.query(ctx, 'SELECT 1 AS x');

      const [, opts] = mockInstance.query.mock.calls[0] as [string, { ttlMs?: number }];
      expect(opts.ttlMs).toBeUndefined();
    });

    // A register_as chain writes provenance, so it reconciles first for the same
    // reason registerDataframe does. A plain SELECT writes none and skips the
    // extra canvas round trip.
    it('reconciles before a register_as chain but not on a plain select', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.query.mockResolvedValue({ columns: ['x'], rows: [], rowCount: 0 });
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });
      await ctx.state.set('eia-df-meta/df_SWEPT', storedMeta('df_SWEPT'));

      await bridge.query(ctx, 'SELECT 1 AS x');
      expect(mockInstance.describe).not.toHaveBeenCalled();
      expect(await ctx.state.get('eia-df-meta/df_SWEPT')).not.toBeNull();

      mockInstance.query.mockResolvedValue({
        columns: ['x'],
        rows: [],
        rowCount: 0,
        tableName: 'df_CHAIN',
      });
      await bridge.query(ctx, 'SELECT 1 AS x', { registerAs: 'df_CHAIN' });
      expect(mockInstance.describe).toHaveBeenCalled();
      expect(await ctx.state.get('eia-df-meta/df_SWEPT')).toBeNull();
    });

    /**
     * The SQL gate refuses a system catalog's name as a whole word in any case,
     * so a table registered under one could never be selected from. The name is
     * refused before any canvas work; a name that only contains one is not.
     */
    describe('register_as spelled like a system catalog', () => {
      it.each([
        ['pg_tables', 'pg_tables'],
        ['PG_Tables', 'pg_tables'],
        ['duckdb_tables', 'duckdb_tables'],
        ['sqlite_master', 'sqlite_master'],
        ['pragma_database_list', 'pragma_database_list'],
        ['information_schema', 'information_schema'],
        ['pg_catalog', 'pg_catalog'],
      ])(
        'refuses %s as system_catalog_access before touching the canvas',
        async (name, catalog) => {
          const { mockCanvas, mockInstance } = makeMockCanvas();
          const bridge = new CanvasBridge(mockCanvas as never);
          const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
          const declared = dataframeQueryTool.errors?.find(
            (e) => e.reason === 'system_catalog_access',
          );

          await expect(
            bridge.query(ctx, 'SELECT 1 AS v', { registerAs: name }),
          ).rejects.toMatchObject({
            code: JsonRpcErrorCode.ValidationError,
            message: expect.stringContaining(`Cannot register a dataframe as ${name}`),
            data: {
              reason: 'system_catalog_access',
              catalog,
              recovery: { hint: declared?.recovery },
            },
          });
          expect(mockCanvas.acquireShared).not.toHaveBeenCalled();
          expect(mockInstance.query).not.toHaveBeenCalled();
          expect((await ctx.state.list('eia-df-meta/')).items).toEqual([]);
        },
      );

      it.each([
        'pg_tables_2024',
        'my_duckdb_tables',
        'duckdb_x',
        // Not an identifier: the canvas's identifier gate names that fault.
        'pg_tables-x',
      ])('passes %s through to the canvas', async (name) => {
        const { mockCanvas, mockInstance } = makeMockCanvas();
        mockInstance.query.mockResolvedValue({ columns: ['v'], rows: [], rowCount: 1 });
        const bridge = new CanvasBridge(mockCanvas as never);
        const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });

        await bridge.query(ctx, 'SELECT 1 AS v', { registerAs: name });

        expect(mockInstance.query).toHaveBeenCalledWith(
          'SELECT 1 AS v',
          expect.objectContaining({ registerAs: name }),
        );
      });
    });

    // Regression for #34: the framework throws below the bridge with a reason
    // but no usable data.recovery, and the framework renders content[]'s
    // `Recovery:` line from data.recovery.hint alone — so the contract's hint
    // reaches the caller only if the bridge puts it on the wire.
    describe.each([
      ['missing_table', JsonRpcErrorCode.NotFound],
      ['non_select_statement', JsonRpcErrorCode.ValidationError],
      ['invalid_sql', JsonRpcErrorCode.ValidationError],
      ['register_as_clash', JsonRpcErrorCode.ValidationError],
      ['system_catalog_access', JsonRpcErrorCode.ValidationError],
      ['denied_function', JsonRpcErrorCode.ValidationError],
      ['multi_statement', JsonRpcErrorCode.ValidationError],
      ['sql_read_only', JsonRpcErrorCode.ValidationError],
    ] as const)('reason %s', (reason, code) => {
      it('is re-thrown with the calling contract recovery, code and message intact', async () => {
        const { mockCanvas, mockInstance } = makeMockCanvas();
        mockInstance.query.mockRejectedValue(
          new McpError(code, `upstream message for ${reason}`, { reason, extra: 'kept' }),
        );
        const bridge = new CanvasBridge(mockCanvas as never);
        const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });

        const declared = dataframeQueryTool.errors?.find((e) => e.reason === reason);
        expect(declared).toBeDefined();

        await expect(bridge.query(ctx, 'SELECT 1')).rejects.toMatchObject({
          code,
          message: `upstream message for ${reason}`,
          data: {
            reason,
            extra: 'kept',
            recovery: { hint: declared?.recovery },
          },
        });
      });
    });

    /**
     * Every reason the bridge rewrites, beside each hint mcp-ts-core 0.13.22
     * puts on it (register_as_clash carries none). Several are derived from the
     * engine's error class, so the framework's hint leads and the declared
     * recovery follows it with what only this server knows.
     */
    it.each([
      [
        'missing_table',
        JsonRpcErrorCode.NotFound,
        "Re-run the tool that produced this table to stage it again, or list the currently staged tables with this server's dataframe-describe tool.",
      ],
      [
        'non_select_statement',
        JsonRpcErrorCode.ValidationError,
        'Rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.',
      ],
      [
        'non_select_statement',
        JsonRpcErrorCode.ValidationError,
        'A PIVOT runs as one SELECT only when it lists its values, as ON column IN (value, ...): list them, or rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.',
      ],
      [
        'invalid_sql',
        JsonRpcErrorCode.ValidationError,
        "Correct the column or function the message names; list the staged columns with this server's dataframe-describe tool.",
      ],
      [
        'invalid_sql',
        JsonRpcErrorCode.ValidationError,
        'Fix the SQL syntax the message names and send a single read-only SELECT. Put AS before an alias that is a SQL keyword, or double-quote it.',
      ],
      [
        'invalid_sql',
        JsonRpcErrorCode.ValidationError,
        "Correct the function, type, collation, or schema name the message reports missing — list the staged tables with this server's dataframe-describe tool.",
      ],
      [
        'invalid_sql',
        JsonRpcErrorCode.ValidationError,
        'Correct the argument value the message names — a pattern, format string, or other constant the function cannot accept.',
      ],
      [
        'invalid_sql',
        JsonRpcErrorCode.ValidationError,
        "Send a read-only SELECT over the staged tables — list them with this server's dataframe-describe tool. This surface reads no files and cannot create, alter, or drop anything.",
      ],
      [
        'system_catalog_access',
        JsonRpcErrorCode.ValidationError,
        "Query only the staged dataframe tables; use this server's dataframe-describe tool to list them.",
      ],
      [
        'denied_function',
        JsonRpcErrorCode.ValidationError,
        'Remove the function the message names — only the staged tables are queryable.',
      ],
      [
        'denied_function',
        JsonRpcErrorCode.ValidationError,
        'Qualify a column named current_schema with its table (<table>.current_schema), or remove the reference — the current_schema() function is not available.',
      ],
      [
        'multi_statement',
        JsonRpcErrorCode.ValidationError,
        'Send exactly one SELECT statement; split multi-statement SQL into separate calls.',
      ],
      [
        'sql_read_only',
        JsonRpcErrorCode.ValidationError,
        "Send a read-only SELECT over the staged tables — list them with this server's dataframe-describe tool. This surface reads no files and cannot create, alter, or drop anything.",
      ],
    ] as const)(
      'keeps the framework %s hint and follows it with the declared recovery: %#',
      async (reason, code, frameworkHint) => {
        const { mockCanvas, mockInstance } = makeMockCanvas();
        mockInstance.query.mockRejectedValue(
          new McpError(code, `upstream message for ${reason}`, {
            reason,
            extra: 'kept',
            recovery: { hint: frameworkHint },
          }),
        );
        const bridge = new CanvasBridge(mockCanvas as never);
        const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
        const declared = dataframeQueryTool.errors?.find((e) => e.reason === reason);
        expect(declared).toBeDefined();

        await expect(bridge.query(ctx, 'SELECT 1')).rejects.toMatchObject({
          code,
          message: `upstream message for ${reason}`,
          data: {
            reason,
            extra: 'kept',
            recovery: { hint: `${frameworkHint} ${declared?.recovery}` },
          },
        });
      },
    );

    it('passes through an undeclared reason untouched', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      const thrown = new McpError(JsonRpcErrorCode.ValidationError, 'Bad identifier.', {
        reason: 'identifier_shape',
      });
      mockInstance.query.mockRejectedValue(thrown);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });

      await expect(bridge.query(ctx, 'SELECT 1')).rejects.toBe(thrown);
    });

    it('passes through a non-McpError untouched', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      const thrown = new Error('DuckDB exploded');
      mockInstance.query.mockRejectedValue(thrown);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });

      await expect(bridge.query(ctx, 'SELECT 1')).rejects.toBe(thrown);
    });
  });

  describe('drop', () => {
    it('reports dropped and removes provenance when the canvas drops the table', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.drop.mockResolvedValue(true);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });
      await ctx.state.set('eia-df-meta/df_ABCDE_FGHIJ', storedMeta('df_ABCDE_FGHIJ'));

      expect(await bridge.drop(ctx, 'df_ABCDE_FGHIJ')).toEqual({ status: 'dropped' });
      expect(await ctx.state.get('eia-df-meta/df_ABCDE_FGHIJ')).toBeNull();
    });

    it('reports absent when the canvas drops nothing and no state meta exists', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.drop.mockResolvedValue(false);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      expect(await bridge.drop(ctx, 'df_MISSING')).toEqual({ status: 'absent' });
    });

    // The canvas is authoritative on existence now that it owns expiry: stale
    // provenance for a table its sweeper already removed must not report a drop.
    it('reports absent and clears provenance the canvas no longer backs', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.drop.mockResolvedValue(false);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });
      await ctx.state.set('eia-df-meta/df_HAS_META', storedMeta('df_HAS_META'));

      expect(await bridge.drop(ctx, 'df_HAS_META')).toEqual({ status: 'absent' });
      expect(await ctx.state.get('eia-df-meta/df_HAS_META')).toBeNull();
    });

    // #60 — provenance is deleted only after the canvas answers, so a drop the
    // canvas could not perform leaves the table listed and retryable.
    it('reports failed and keeps provenance when the canvas drop throws', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.drop.mockRejectedValue(new Error('canvas gone'));
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });
      const meta = storedMeta('df_HAS_META');
      await ctx.state.set('eia-df-meta/df_HAS_META', meta);

      expect(await bridge.drop(ctx, 'df_HAS_META')).toEqual({
        status: 'failed',
        message: 'canvas gone',
      });
      expect(await ctx.state.get('eia-df-meta/df_HAS_META')).toEqual(meta);
    });

    it('reports failed and keeps provenance when no canvas can be acquired', async () => {
      const { mockCanvas } = makeMockCanvas();
      mockCanvas.acquireShared.mockRejectedValue(new Error('capacity exhausted'));
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });
      const meta = storedMeta('df_HAS_META');
      await ctx.state.set('eia-df-meta/df_HAS_META', meta);

      expect(await bridge.drop(ctx, 'df_HAS_META')).toEqual({
        status: 'failed',
        message: 'capacity exhausted',
      });
      expect(await ctx.state.get('eia-df-meta/df_HAS_META')).toEqual(meta);
    });
  });

  /**
   * #109 — the tenant's canvas is the framework's shared acquire under the
   * bridge's own key; replacing a dead id and serializing the mint are the
   * framework's (real-canvas coverage in canvas-execution.tool.test.ts).
   */
  describe('shared canvas', () => {
    it('acquires through acquireShared under eia-canvas-id on every path', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.registerTable.mockResolvedValue({ tableName: 'df_ONE', rowCount: 1 });
      mockInstance.query.mockResolvedValue({ columns: ['x'], rows: [], rowCount: 0 });
      mockInstance.drop.mockResolvedValue(false);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      await bridge.registerDataframe(ctx, {
        rows: [{ period: '2024-01', value: '9.13' }],
        sourceTool: 'eia_query_route',
        queryParams: {},
      });
      await bridge.describe(ctx);
      await bridge.query(ctx, 'SELECT 1 AS x');
      await bridge.drop(ctx, 'df_ONE');

      expect(mockCanvas.acquireShared.mock.calls).toEqual(
        Array.from({ length: 4 }, () => [ctx, { stateKey: 'eia-canvas-id' }]),
      );
    });

    // #60 — the bridge keeps no canvas id of its own to forget, so an acquire
    // failure reaches the caller and nothing is written.
    it('propagates an acquire failure from describe and query, writing nothing', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      const thrown = new Error('registry shutting down');
      mockCanvas.acquireShared.mockRejectedValue(thrown);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
      const meta = storedMeta('df_KEPT');
      await ctx.state.set('eia-df-meta/df_KEPT', meta);

      await expect(bridge.describe(ctx)).rejects.toBe(thrown);
      await expect(bridge.query(ctx, 'SELECT 1', { registerAs: 'df_NEW' })).rejects.toBe(thrown);
      expect(mockInstance.query).not.toHaveBeenCalled();
      expect((await ctx.state.list('eia-df-meta/')).items).toEqual([
        { key: 'eia-df-meta/df_KEPT', value: meta },
      ]);
    });

    // A call cancelled while queued for the canvas is a cancellation, never a
    // failed outcome, on the two paths that otherwise report one.
    it('rethrows an acquire cancelled by the caller from register and drop', async () => {
      const { mockCanvas } = makeMockCanvas();
      const controller = new AbortController();
      controller.abort();
      mockCanvas.acquireShared.mockRejectedValue(controller.signal.reason);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test', signal: controller.signal });

      await expect(
        bridge.registerDataframe(ctx, {
          rows: [{ period: '2024-01', value: '9.13' }],
          sourceTool: 'eia_query_route',
          queryParams: {},
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await expect(bridge.drop(ctx, 'df_ANY')).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});
