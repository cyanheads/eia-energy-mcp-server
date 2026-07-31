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
    acquire: vi.fn().mockResolvedValue(mockInstance),
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
    it('returns undefined and skips when rows are empty', async () => {
      const { mockCanvas } = makeMockCanvas();
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.registerDataframe(ctx, {
        rows: [],
        sourceTool: 'eia_query_route',
        queryParams: { route: 'steo' },
      });

      expect(result).toBeUndefined();
      expect(mockCanvas.acquire).not.toHaveBeenCalled();
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

      expect(result).toBeDefined();
      expect(result?.tableName).toBe('df_ABCDE_FGHIJ');
      expect(result?.rowCount).toBe(2);
      expect(result?.expiresAt).toBeDefined();
      expect(result?.columnSchema).toBeDefined();
    });

    // Regression for #30: the sliding window is the framework's, opted into via
    // ttlMs. Without it the table follows the canvas lifecycle and the bridge is
    // back to advertising a slide nothing performs.
    it('opts the table into the framework sliding TTL and stores no expiry of its own', async () => {
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
      expect(result?.expiresAt).toBeDefined();
      expect(await ctx.state.get('eia-df-meta/df_TTL')).not.toHaveProperty('expiresAt');
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

    it('returns undefined when canvas throws (best-effort)', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.registerTable.mockRejectedValue(new Error('DuckDB error'));
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.registerDataframe(ctx, {
        rows: [{ period: '2024-01', value: '9.13' }],
        sourceTool: 'eia_query_route',
        queryParams: { route: 'steo' },
      });

      expect(result).toBeUndefined();
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

      expect(result).toBeDefined();
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
      expect(result?.columnSchema.map((c) => c.name)).toContain('revenue_units');
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

    it('overrides the framework hint that names methods no client can call', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.query.mockRejectedValue(
        new McpError(JsonRpcErrorCode.NotFound, 'Canvas table does not exist.', {
          reason: 'missing_table',
          recovery: { hint: 'Re-stage the table via registerTable() or call describe().' },
        }),
      );
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });

      await expect(bridge.query(ctx, 'SELECT * FROM df_GONE')).rejects.toMatchObject({
        data: { recovery: { hint: expect.stringContaining('eia_dataframe_describe') } },
      });
    });

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
    it('returns true when canvas drop succeeds', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.drop.mockResolvedValue(true);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.drop(ctx, 'df_ABCDE_FGHIJ');
      expect(result).toBe(true);
    });

    it('returns false when canvas drop returns false and no state meta exists', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.drop.mockResolvedValue(false);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });

      const result = await bridge.drop(ctx, 'df_MISSING');
      expect(result).toBe(false);
    });

    // The canvas is authoritative on existence now that it owns expiry: stale
    // provenance for a table its sweeper already removed must not report a drop.
    it('returns false when the canvas no longer holds a table state still tracks', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.drop.mockResolvedValue(false);
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });
      await ctx.state.set('eia-df-meta/df_HAS_META', storedMeta('df_HAS_META'));

      expect(await bridge.drop(ctx, 'df_HAS_META')).toBe(false);
      expect(await ctx.state.get('eia-df-meta/df_HAS_META')).toBeNull();
    });

    it('falls back to stored provenance when the canvas itself is unreachable', async () => {
      const { mockCanvas, mockInstance } = makeMockCanvas();
      mockInstance.drop.mockRejectedValue(new Error('canvas gone'));
      const bridge = new CanvasBridge(mockCanvas as never);
      const ctx = createMockContext({ tenantId: 'test' });
      await ctx.state.set('eia-df-meta/df_HAS_META', storedMeta('df_HAS_META'));

      expect(await bridge.drop(ctx, 'df_HAS_META')).toBe(true);
    });
  });
});
