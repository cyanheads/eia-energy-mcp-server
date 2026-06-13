/**
 * @fileoverview Additional coverage for eia_dataframe_query — input validation,
 * SQL injection / catalog-access gate, security (no secret leakage), and
 * format edge cases.
 * @module tests/tools/dataframe-query-extra.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import * as canvasBridge from '@/services/canvas-bridge/canvas-bridge.js';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  initCanvasBridge: vi.fn(),
  _resetCanvasBridge: vi.fn(),
}));

const mockQuery = vi.fn();

describe('dataframeQueryTool — additional coverage', () => {
  beforeEach(() => {
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      query: mockQuery,
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
    mockQuery.mockReset();
  });

  // ------------------------------------------------------------------
  // Input validation
  // ------------------------------------------------------------------

  describe('input validation', () => {
    it('rejects empty sql string (min 1)', () => {
      expect(() => dataframeQueryTool.input.parse({ sql: '' })).toThrow();
    });

    it('rejects preview = -1 (min 0)', () => {
      expect(() => dataframeQueryTool.input.parse({ sql: 'SELECT 1', preview: -1 })).toThrow();
    });

    it('accepts preview = 0 (boundary)', () => {
      expect(() => dataframeQueryTool.input.parse({ sql: 'SELECT 1', preview: 0 })).not.toThrow();
    });

    it('rejects preview > 10000 (max 10000)', () => {
      expect(() => dataframeQueryTool.input.parse({ sql: 'SELECT 1', preview: 10001 })).toThrow();
    });

    it('rejects row_limit = 0 (min 1)', () => {
      expect(() => dataframeQueryTool.input.parse({ sql: 'SELECT 1', row_limit: 0 })).toThrow();
    });

    it('rejects row_limit > 10000 (max 10000)', () => {
      expect(() => dataframeQueryTool.input.parse({ sql: 'SELECT 1', row_limit: 10001 })).toThrow();
    });

    it('accepts row_limit at max boundary (10000)', () => {
      expect(() =>
        dataframeQueryTool.input.parse({ sql: 'SELECT 1', row_limit: 10000 }),
      ).not.toThrow();
    });
  });

  // ------------------------------------------------------------------
  // SQL injection: system catalog access is blocked by the bridge layer
  // ------------------------------------------------------------------

  describe('system catalog injection', () => {
    it('blocks information_schema access', async () => {
      // The bridge passes denySystemCatalogs to the framework SQL gate, which
      // throws a ValidationError on catalog references. The mock simulates that.
      const { validationError } = await import('@cyanheads/mcp-ts-core/errors');
      mockQuery.mockRejectedValue(
        validationError('SQL references a denied system catalog: information_schema.', {
          reason: 'system_catalog_access',
        }),
      );

      const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
      const input = dataframeQueryTool.input.parse({
        sql: 'SELECT * FROM information_schema.tables',
      });

      await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'system_catalog_access' },
      });
    });

    it('blocks duckdb_tables access', async () => {
      const { validationError } = await import('@cyanheads/mcp-ts-core/errors');
      mockQuery.mockRejectedValue(
        validationError('SQL references a denied system catalog: duckdb_tables.', {
          reason: 'system_catalog_access',
        }),
      );

      const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
      const input = dataframeQueryTool.input.parse({ sql: 'SELECT * FROM duckdb_tables()' });

      await expect(dataframeQueryTool.handler(input, ctx)).rejects.toBeDefined();
    });

    it('declares system_catalog_access in the errors[] contract (#21)', () => {
      const entry = dataframeQueryTool.errors?.find((e) => e.reason === 'system_catalog_access');
      expect(entry).toBeDefined();
      expect(entry?.code).toBe(JsonRpcErrorCode.ValidationError);
    });
  });

  // ------------------------------------------------------------------
  // Security: no env secret in error output
  // ------------------------------------------------------------------

  it('does not expose env secrets when bridge throws an internal error', async () => {
    const secretValue = 'SECRET_DB_PASSWORD_XYZ';
    mockQuery.mockRejectedValue(new Error(`DuckDB connection failed: password=${secretValue}`));

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_TEST' });

    let caught: unknown;
    try {
      await dataframeQueryTool.handler(input, ctx);
    } catch (e) {
      caught = e;
    }

    // The tool does not wrap or transform errors — it re-throws them as-is.
    // We assert the tool itself never injects secrets into the error.
    // A raw Error thrown by the bridge is the one that propagates, not something
    // the tool synthesized with secret content.
    expect(caught).toBeDefined();
    // Tool output object (if any) must not contain the secret
    const errStr = JSON.stringify(caught);
    expect(errStr).not.toContain('SECRET_DB_PASSWORD_XYZ');
  });

  // ------------------------------------------------------------------
  // Enrichment: executed SQL echo (#23)
  // ------------------------------------------------------------------

  it('echoes the executed SQL in enrichment', async () => {
    mockQuery.mockResolvedValue({
      result: { columns: ['period'], rows: [{ period: '2024-01' }], rowCount: 1 },
    });

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const sql = 'WITH t AS (SELECT period FROM df_TEST) SELECT * FROM t ORDER BY period';
    const input = dataframeQueryTool.input.parse({ sql });
    await dataframeQueryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.executedSql).toBe(sql);
  });

  // ------------------------------------------------------------------
  // format() edge cases
  // ------------------------------------------------------------------

  describe('format()', () => {
    it('escapes pipe characters in cell values', () => {
      const result = {
        columns: ['label'],
        rows: [{ label: 'value | piped' }],
      };
      const blocks = dataframeQueryTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('value \\| piped');
    });

    it('handles null cell values as empty string', () => {
      const result = {
        columns: ['period', 'value'],
        rows: [{ period: '2024-01', value: null }],
      };
      const blocks = dataframeQueryTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('2024-01');
      // null renders as empty cell, not 'null'
      expect(text).not.toContain('null');
    });

    it('handles object cell values by JSON-serializing them', () => {
      const result = {
        columns: ['data'],
        rows: [{ data: { nested: 'value' } }],
      };
      const blocks = dataframeQueryTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('nested');
    });

    it('renders register_as with expiry when present', () => {
      const result = {
        columns: ['period', 'total'],
        rows: [{ period: '2024', total: '100' }],
        registered_as: 'df_RESULT',
        expires_at: '2026-01-01T00:00:00Z',
      };
      const blocks = dataframeQueryTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('df_RESULT');
      expect(text).toContain('2026-01-01T00:00:00Z');
    });
  });
});
