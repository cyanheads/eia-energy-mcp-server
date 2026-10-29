/**
 * @fileoverview Tests for the eia_dataframe_query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import * as canvasBridge from '@/services/canvas-bridge/canvas-bridge.js';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  initCanvasBridge: vi.fn(),
  _resetCanvasBridge: vi.fn(),
}));

const mockQuery = vi.fn();

beforeEach(() => {
  vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
    query: mockQuery,
  } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
  mockQuery.mockReset();
});

describe('dataframeQueryTool', () => {
  it('throws canvas_unavailable when bridge is absent', async () => {
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue(undefined);

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_TEST' });

    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_unavailable' },
    });
  });

  it('executes SQL and returns results', async () => {
    mockQuery.mockResolvedValue({
      result: {
        columns: ['period', 'value'],
        rows: [{ period: '2024-01', value: '9.13' }],
        rowCount: 1,
        tableName: undefined,
      },
    });

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT period, value FROM df_TEST' });
    const result = await dataframeQueryTool.handler(input, ctx);

    expect(result.columns).toEqual(['period', 'value']);
    expect(result.rows).toHaveLength(1);
    expect(result.registered_as).toBeUndefined();

    // row_count moved to enrichment
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalRows).toBe(1);
    expect(enrichment.returnedRows).toBe(1);
  });

  it('populates capped notice when rowCount > rows.length', async () => {
    mockQuery.mockResolvedValue({
      result: {
        columns: ['period', 'value'],
        rows: [{ period: '2024-01', value: '9.13' }],
        rowCount: 5000,
      },
    });

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT * FROM df_TEST',
      row_limit: 10000,
      preview: 1,
    });
    await dataframeQueryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalRows).toBe(5000);
    // The count is exact on this path, so the notice may state it as a total.
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.notice).toMatch(/Showing 1 of 5,000 rows/);
    expect(enrichment.notice).toMatch(/preview/);
  });

  it('discloses a row_limit-capped result and names both escapes (#40)', async () => {
    // The provider caps at row_limit: rowCount === rows.length, truncated: true.
    mockQuery.mockResolvedValue({
      result: {
        columns: ['period', 'price'],
        rows: Array.from({ length: 1000 }, (_, i) => ({ period: `2024-${i}`, price: '9.13' })),
        rowCount: 1000,
        truncated: true,
      },
    });

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT period, price FROM df_TEST' });
    await dataframeQueryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    // rowCount === rows.length here — the preview comparison alone cannot disclose this.
    expect(enrichment.totalRows).toBe(enrichment.returnedRows);
    expect(enrichment.notice).toMatch(/row_limit cap of 1,000/);
    expect(enrichment.notice).toMatch(/register_as/);
    // totalRows is the cap, so the notice must not present it as a total.
    expect(enrichment.notice).not.toMatch(/of 1,000 rows/);
  });

  it('gives one non-contradictory disclosure when row_limit and preview both bind (#40)', async () => {
    mockQuery.mockResolvedValue({
      result: {
        columns: ['period'],
        rows: [{ period: '2024-01' }, { period: '2024-02' }],
        rowCount: 3,
        truncated: true,
      },
    });

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT period FROM df_TEST',
      row_limit: 3,
      preview: 2,
    });
    await dataframeQueryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.notice).toMatch(/Showing 2 rows/);
    expect(enrichment.notice).toMatch(/row_limit cap of 3/);
    // "Showing 2 of 3 rows" was the wrong claim — 3 is the cap, not the total.
    expect(enrichment.notice).not.toMatch(/of 3 rows/);
  });

  it('reports truncated false and no notice on a complete result (#40)', async () => {
    mockQuery.mockResolvedValue({
      result: {
        columns: ['period'],
        rows: [{ period: '2024-01' }, { period: '2024-02' }],
        rowCount: 2,
      },
    });

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT period FROM df_TEST' });
    await dataframeQueryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.notice).toBeUndefined();
  });

  it('returns registered_as when register_as is supplied', async () => {
    const now = new Date().toISOString();
    mockQuery.mockResolvedValue({
      result: {
        columns: ['period', 'total'],
        rows: [{ period: '2024', total: '100.5' }],
        rowCount: 1,
        tableName: 'df_RESULT',
      },
      meta: {
        tableName: 'df_RESULT',
        expiresAt: now,
        sourceTool: 'eia_dataframe_query',
        queryParams: { sql: 'SELECT ...' },
        createdAt: now,
        rowCount: 1,
        truncated: false,
        maxRows: undefined,
        columnSchema: [],
      },
    });

    const ctx = createMockContext({ errors: dataframeQueryTool.errors, tenantId: 'test' });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT period, SUM(CAST(value AS DOUBLE)) AS total FROM df_TEST GROUP BY period',
      register_as: 'df_RESULT',
    });
    const result = await dataframeQueryTool.handler(input, ctx);

    expect(result.registered_as).toBe('df_RESULT');
    expect(result.expires_at).toBe(now);
  });

  describe('format()', () => {
    it('renders table markdown', () => {
      const result = {
        columns: ['period', 'value'],
        rows: [
          { period: '2024-01', value: '9.13' },
          { period: '2024-02', value: '8.45' },
        ],
      };
      const blocks = dataframeQueryTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('| period | value |');
      expect(text).toContain('9.13');
      expect(text).toContain('8.45');
    });

    it('renders a no-row result as its header row, then the no-rows note', () => {
      const result = { columns: ['period', 'value'], rows: [] };
      const blocks = dataframeQueryTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toBe('| period | value |\n| --- | --- |\n\n_No rows._');
    });

    it('shows register info when registered_as present', () => {
      const result = {
        columns: ['val'],
        rows: [{ val: '1' }],
        registered_as: 'df_OUT',
        expires_at: '2026-01-01T00:00:00Z',
      };
      const blocks = dataframeQueryTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('df_OUT');
    });
  });
});

// ---------------------------------------------------------------------------
// #96 — preview is the inline page (default 25, at most row_limit), returned
// whole whatever the row width; row_limit (#40) keeps its own disclosure, and
// the SQL and column echoes come back whole.
// ---------------------------------------------------------------------------

describe('dataframeQueryTool — page size (#96)', () => {
  const row = (i: number, note = '') => ({
    id: `r${String(i).padStart(5, '0')}`,
    period: `2024-${String((i % 12) + 1).padStart(2, '0')}`,
    note,
  });
  const wide = (i: number) => row(i, 'w'.repeat(1_000));
  const COLUMNS = ['id', 'period', 'note'];

  const meta = (tableName: string, rowCount: number) => ({
    tableName,
    expiresAt: '2026-10-13T00:00:00.000Z',
    sourceTool: 'eia_dataframe_query',
    queryParams: { sql: 'SELECT ...' },
    createdAt: '2026-10-12T00:00:00.000Z',
    rowCount,
    truncated: false,
    maxRows: undefined,
    columnSchema: [],
  });

  const answer = (
    rows: Array<Record<string, unknown>>,
    extra: { columns?: string[]; rowCount?: number; truncated?: boolean } = {},
    tableMeta?: ReturnType<typeof meta>,
  ) =>
    mockQuery.mockResolvedValue({
      result: {
        columns: extra.columns ?? COLUMNS,
        rows,
        rowCount: extra.rowCount ?? rows.length,
        ...(extra.truncated !== undefined && { truncated: extra.truncated }),
      },
      ...(tableMeta && { meta: tableMeta }),
    });

  /** Both surfaces exactly as the caller receives them. */
  async function call(input: Record<string, unknown>) {
    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT * FROM df_T',
      ...input,
    });
    expect(result.isError).not.toBe(true);
    const sc = result.structuredContent as Record<string, unknown> & {
      columns: string[];
      rows: Array<Record<string, unknown>>;
    };
    const text = (result.content ?? []).map((b) => (b as { text?: string }).text ?? '').join('');
    return { sc, text };
  }

  const textIds = (text: string) => [...text.matchAll(/^\| (r\d{5}) \|/gm)].map((m) => m[1]);

  it('keeps the #40 row_limit and preview notices word for word where one bound binds', async () => {
    answer([row(0), row(1)], { rowCount: 2, truncated: true });
    expect((await call({ row_limit: 2 })).sc.notice).toBe(
      'Showing 2 rows — more rows matched than the row_limit cap of 2 and the remainder was dropped uncounted, so totalRows is that cap and not a total. Raise row_limit, or re-run with register_as to stage the whole result as a new dataframe, which reports an exact row count.',
    );

    answer([row(0)], { rowCount: 5000 });
    expect((await call({ row_limit: 10_000, preview: 1 })).sc.notice).toBe(
      'Showing 1 of 5,000 rows — preview capped the inline slice (it defaults to 25); raise it to see more.',
    );

    answer([row(0)], { rowCount: 5000 }, meta('df_OUT', 5000));
    expect((await call({ register_as: 'df_OUT', preview: 1 })).sc.notice).toBe(
      'Showing 1 of 5,000 rows — preview capped the inline slice (it defaults to 25); raise it to see more, or query df_OUT directly.',
    );
  });

  it('names both bounds, and raising preview, when row_limit and preview both bind', async () => {
    // The canvas hands back only the preview slice of the 3 rows row_limit kept.
    answer([row(0), row(1)], { rowCount: 3, truncated: true });
    const { sc } = await call({ row_limit: 3, preview: 2 });
    expect(sc.notice).toBe(
      'Showing 2 rows — more rows matched than the row_limit cap of 3 and the remainder was dropped uncounted, so totalRows is that cap and not a total, and preview then ended the inline rows at 2 of the 3 materialized. Raise preview to see more of them, or re-run with register_as to stage the whole result as a dataframe with an exact row count, then page it with SELECT * FROM <name> LIMIT 2 OFFSET 2, raising OFFSET by 2 for each further page (no ORDER BY: the table keeps the order the preview showed, and a sort reorders it).',
    );
    expect(sc).toMatchObject({ truncated: true, totalRows: 3, returnedRows: 2 });
  });

  it('never advises raising a bound already clamped to its cap (#85)', async () => {
    answer([row(0), row(1)], { truncated: true });
    expect((await call({ row_limit: 20_000 })).sc.notice).toBe(
      'Requested row_limit 20000 was clamped to 10000. Showing 2 rows — more rows matched than the row_limit cap of 10,000 and the remainder was dropped uncounted, so totalRows is that cap and not a total. Re-run with register_as to stage the whole result as a new dataframe, which reports an exact row count.',
    );

    answer([row(0), row(1)], { rowCount: 20_000 }, meta('df_OUT', 20_000));
    expect((await call({ register_as: 'df_OUT', preview: 20_000 })).sc.notice).toBe(
      'Requested preview 20000 was clamped to 1000. Showing 2 of 20,000 rows — preview capped the inline slice (it defaults to 25). The whole result is staged as df_OUT: page it with SELECT * FROM df_OUT LIMIT 2 OFFSET 2, raising OFFSET by 2 for each further page (no ORDER BY: the table keeps the order the preview showed, and a sort reorders it).',
    );
  });

  it('asks the canvas for 25 preview rows within the default 1,000 row_limit', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => wide(i));
    answer(rows, { rowCount: 1000 });

    const { sc, text } = await call({});

    expect(mockQuery.mock.calls[0]?.[2]).toMatchObject({ rowLimit: 1000, preview: 25 });
    expect(sc.rows).toEqual(rows);
    expect(textIds(text)).toEqual(rows.map((r) => r.id));
    expect(sc).toMatchObject({ truncated: false, totalRows: 1000, returnedRows: 25 });
  });

  it('returns every previewed row whole however wide the rows are', async () => {
    // About 1.1 MB of rows — the size cut used to end this at about 60.
    const rows = Array.from({ length: 1000 }, (_, i) => wide(i));
    answer(rows);

    const { sc, text } = await call({ preview: 1000 });

    expect(mockQuery.mock.calls[0]?.[2]).toMatchObject({ rowLimit: 1000, preview: 1000 });
    expect(sc.rows).toEqual(rows);
    expect(textIds(text)).toEqual(rows.map((r) => r.id));
    expect(sc).toMatchObject({ truncated: false, totalRows: 1000, returnedRows: 1000 });
    expect(sc).not.toHaveProperty('notice');
  });

  it.each([undefined, 'df_OUT'])(
    'lowers preview 2000 to the default row_limit of 1,000 with a notice (register_as %s)',
    async (registerAs) => {
      const rows = Array.from({ length: 1000 }, (_, i) => row(i));
      answer(rows, { rowCount: 1000 }, registerAs ? meta(registerAs, 1000) : undefined);

      const { sc } = await call({ preview: 2000, ...(registerAs && { register_as: registerAs }) });

      expect(mockQuery.mock.calls[0]?.[2]).toMatchObject({ rowLimit: 1000, preview: 1000 });
      expect(sc.rows).toHaveLength(1000);
      expect(sc.notice).toBe('Requested preview 2000 was clamped to 1000.');
    },
  );

  it('lowers the default preview to a smaller row_limit without calling it a clamp', async () => {
    answer([row(0), row(1), row(2)]);

    const { sc } = await call({ row_limit: 3 });

    expect(mockQuery.mock.calls[0]?.[2]).toMatchObject({ rowLimit: 3, preview: 3 });
    expect(sc).not.toHaveProperty('notice');
  });

  it('names row_limit, not the default, when it lowered an omitted preview on register_as', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i));
    answer(rows, { rowCount: 40 }, meta('x', 40));

    const { sc } = await call({ row_limit: 10, register_as: 'x' });

    expect(mockQuery.mock.calls[0]?.[2]).toMatchObject({ rowLimit: 10, preview: 10 });
    expect(sc.notice).toBe(
      'Showing 10 of 40 rows — preview capped the inline slice at 10, its default of 25 lowered to row_limit. The whole result is staged as x: page it with SELECT * FROM x LIMIT 10 OFFSET 10, raising OFFSET by 10 for each further page (no ORDER BY: the table keeps the order the preview showed, and a sort reorders it).',
    );
  });

  it('pages from the first row when preview 0 showed none of a row_limit-cut result', async () => {
    answer([], { rowCount: 3, truncated: true });

    const { sc } = await call({ row_limit: 3, preview: 0 });

    expect(sc.notice).toBe(
      'Showing 0 rows — more rows matched than the row_limit cap of 3 and the remainder was dropped uncounted, so totalRows is that cap and not a total, and preview then ended the inline rows at 0 of the 3 materialized. Raise preview to see more of them, or re-run with register_as to stage the whole result as a dataframe with an exact row count, then page it with SELECT * FROM <name> LIMIT 25 OFFSET 0, raising OFFSET by 25 for each further page (no ORDER BY: the table keeps the order the preview showed, and a sort reorders it).',
    );
  });

  it('lists the columns of a preview 0 result in content[] as in structuredContent', async () => {
    answer([], { columns: ['period', 'value'], rowCount: 40 }, meta('df_OUT', 40));

    const { sc, text } = await call({ preview: 0, register_as: 'df_OUT' });

    expect(sc.columns).toEqual(['period', 'value']);
    expect(sc.rows).toEqual([]);
    expect(text).toContain('| period | value |\n| --- | --- |\n\n_No rows._');
  });

  it('keeps preview 0 valid: no rows inline, no clamp', async () => {
    answer([], { rowCount: 40 }, meta('df_OUT', 40));

    const { sc } = await call({ preview: 0, register_as: 'df_OUT' });

    expect(mockQuery.mock.calls[0]?.[2]).toMatchObject({ preview: 0 });
    expect(sc.rows).toEqual([]);
    expect(sc.notice).not.toMatch(/clamped/);
  });

  it('writes the paging SQL numbers without digit grouping', async () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      id: `r${String(i).padStart(5, '0')}`,
    }));
    answer(rows, { columns: ['id'], rowCount: 20_000 }, meta('df_BIG', 20_000));

    const { sc, text } = await call({ register_as: 'df_BIG', row_limit: 10_000, preview: 10_000 });

    expect(sc.rows).toEqual(rows);
    expect(textIds(text)).toEqual(rows.map((r) => r.id));
    expect(sc.notice).toBe(
      'Showing 10,000 of 20,000 rows — preview capped the inline slice (it defaults to 25). The whole result is staged as df_BIG: page it with SELECT * FROM df_BIG LIMIT 10000 OFFSET 10000, raising OFFSET by 10000 for each further page (no ORDER BY: the table keeps the order the preview showed, and a sort reorders it).',
    );
  });

  it('echoes a 5,000-byte multi-line statement whole, as a fenced block in content[]', async () => {
    const sql = `SELECT *\nFROM df_T -- ${'x'.repeat(5_000)}`;
    answer([row(0)]);

    const { sc, text } = await call({ sql });

    expect(Buffer.byteLength(sql)).toBeGreaterThan(5_000);
    expect(sc.executedSql).toBe(sql);
    expect(text).toContain(`**executedSql:** \n\`\`\`\n${sql}\n\`\`\``);
  });

  it('lists every column of a 6,000-column result with no rows', async () => {
    const columns = Array.from({ length: 6_000 }, (_, i) => `period_${String(i).padStart(5, '0')}`);
    answer([], { columns, rowCount: 0 });

    const { sc } = await call({});

    expect(sc.columns).toEqual(columns);
  });

  it('describes no byte budget in anything it advertises', () => {
    const advertised = JSON.stringify([
      dataframeQueryTool.description,
      z.toJSONSchema(dataframeQueryTool.input, { io: 'input' }),
      z.toJSONSchema(dataframeQueryTool.output.extend(dataframeQueryTool.enrichment ?? {})),
    ]);
    expect(advertised).not.toMatch(/budget|64,000|4,000 bytes|32,000|byte/i);
  });
});
