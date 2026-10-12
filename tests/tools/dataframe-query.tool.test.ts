/**
 * @fileoverview Tests for the eia_dataframe_query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { ECHO_BUDGET_BYTES, INLINE_BUDGET_BYTES } from '@/mcp-server/tools/inline-budget.js';
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

    it('renders no-rows state', () => {
      const result = { columns: ['period'], rows: [] };
      const blocks = dataframeQueryTool.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('_No rows._');
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
// #58 — each response surface holds to a fixed byte budget, cut between whole
// rows; row_limit (#40) keeps its own disclosure.
// ---------------------------------------------------------------------------

describe('dataframeQueryTool — inline byte budget (#58)', () => {
  const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
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
    return { sc, text, scBytes: bytes(JSON.stringify(sc)), textBytes: bytes(text) };
  }

  const textIds = (text: string) => [...text.matchAll(/^\| (r\d{5}) \|/gm)].map((m) => m[1]);

  it('keeps the #40 row_limit and preview notices word for word when the budget does not bind', async () => {
    answer([row(0), row(1)], { rowCount: 3, truncated: true });
    expect((await call({ row_limit: 3, preview: 2 })).sc.notice).toBe(
      'Showing 2 rows — more rows matched than the row_limit cap of 3 and the remainder was dropped uncounted, so totalRows is that cap and not a total. Raise row_limit, or re-run with register_as to stage the whole result as a new dataframe, which reports an exact row count.',
    );

    answer([row(0)], { rowCount: 5000 });
    expect((await call({ row_limit: 10_000, preview: 1 })).sc.notice).toBe(
      'Showing 1 of 5,000 rows — preview capped the inline slice (it defaults to row_limit); raise it to see more.',
    );

    answer([row(0)], { rowCount: 5000 }, meta('df_OUT', 5000));
    expect((await call({ register_as: 'df_OUT', preview: 1 })).sc.notice).toBe(
      'Showing 1 of 5,000 rows — preview capped the inline slice (it defaults to row_limit); raise it to see more, or query df_OUT directly.',
    );
  });

  it('ends the inline rows at the budget alone with an exact count and register_as paging', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => wide(i));
    answer(rows);

    const { sc, text, scBytes, textBytes } = await call({});
    const shown = sc.rows.length;

    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(1000);
    expect(sc.rows).toEqual(rows.slice(0, shown));
    expect(textIds(text)).toEqual(rows.slice(0, shown).map((r) => r.id));
    expect(sc).toMatchObject({ truncated: false, totalRows: 1000, returnedRows: shown });
    expect(sc.notice).toBe(
      `Showing ${shown} of 1,000 rows — the 64,000-byte response budget ended the inline rows. Re-run with register_as to stage the whole result as a dataframe, then page it with SELECT * FROM <name> ORDER BY <columns> LIMIT ${shown} OFFSET ${shown}.`,
    );
    expect(text).toContain(`> ${sc.notice}`);
    expect(scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
  });

  it('writes the paging SQL numbers without digit grouping, however many rows fit', async () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      id: `r${String(i).padStart(5, '0')}`,
    }));
    answer(rows, { columns: ['id'] });

    const { sc } = await call({ row_limit: 10_000 });
    const shown = sc.rows.length;

    expect(shown).toBeGreaterThan(1_000);
    expect(sc.notice).toContain(`Showing ${shown.toLocaleString()} of 10,000 rows`);
    expect(sc.notice).toContain(`LIMIT ${shown} OFFSET ${shown}.`);
  });

  it('names both caps when row_limit and the budget both bind', async () => {
    answer(
      Array.from({ length: 10_000 }, (_, i) => wide(i)),
      { rowCount: 10_000, truncated: true },
    );

    const { sc, scBytes, textBytes } = await call({ row_limit: 10_000 });
    const shown = sc.rows.length;

    expect(sc.truncated).toBe(true);
    expect(sc.totalRows).toBe(10_000);
    expect(sc.notice).toBe(
      `Showing ${shown} rows — more rows matched than the row_limit cap of 10,000 and the remainder was dropped uncounted, so totalRows is that cap and not a total, and the 64,000-byte response budget then ended the inline rows at ${shown} of the 10,000 materialized. Re-run with register_as to stage the whole result as a dataframe with an exact row count, then page it with SELECT * FROM <name> ORDER BY <columns> LIMIT ${shown} OFFSET ${shown}.`,
    );
    expect(scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
  });

  it('counts the rows preview kept, not row_limit, when preview cut them before the budget', async () => {
    // The canvas hands back only the preview slice of the 10,000 row_limit kept.
    answer(
      Array.from({ length: 2_000 }, (_, i) => wide(i)),
      { rowCount: 10_000, truncated: true },
    );

    const { sc, text, scBytes, textBytes } = await call({ row_limit: 10_000, preview: 2_000 });
    const shown = sc.rows.length;

    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(2_000);
    expect(sc).toMatchObject({ truncated: true, totalRows: 10_000, returnedRows: shown });
    expect(sc.notice).toBe(
      `Showing ${shown} rows — more rows matched than the row_limit cap of 10,000 and the remainder was dropped uncounted, so totalRows is that cap and not a total, and the 64,000-byte response budget then ended the inline rows at ${shown} of the 2,000 previewed. Re-run with register_as to stage the whole result as a dataframe with an exact row count, then page it with SELECT * FROM <name> ORDER BY <columns> LIMIT ${shown} OFFSET ${shown}.`,
    );
    expect(text).toContain(`> ${sc.notice}`);
    expect(scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
  });

  it('pages the table register_as already created when the budget ends the rows', async () => {
    answer(
      Array.from({ length: 1000 }, (_, i) => wide(i)),
      { rowCount: 4000 },
      meta('df_PAGED', 4000),
    );

    const { sc, text } = await call({ register_as: 'df_PAGED' });
    const shown = sc.rows.length;

    expect(sc.truncated).toBe(false);
    expect(sc.notice).toBe(
      `Showing ${shown} of 4,000 rows — the 64,000-byte response budget ended the inline rows. The whole result is staged as df_PAGED: page it with SELECT * FROM df_PAGED ORDER BY <columns> LIMIT ${shown} OFFSET ${shown}.`,
    );
    expect(text).toContain('Registered as df_PAGED');
  });

  it('withholds a first row larger than the budget and says so', async () => {
    answer([row(0, 'x'.repeat(70_000)), row(1)]);

    const { sc, text, scBytes, textBytes } = await call({});

    expect(sc.rows).toEqual([]);
    expect(sc.returnedRows).toBe(0);
    expect(sc.totalRows).toBe(2);
    expect(sc.notice).toBe(
      'The first row alone exceeds the 64,000-byte response budget, so no rows are shown inline — select fewer or narrower columns; left(col, n) shortens long text.',
    );
    expect(text).toContain('_No rows._');
    expect(scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
  });

  it('holds both surfaces to the budget at the maximum row_limit and preview', async () => {
    answer(
      Array.from({ length: 10_000 }, (_, i) =>
        row(i, `é|<${'ü'.repeat(300)}>\n${'`'.repeat(200)}`),
      ),
      { rowCount: 10_000 },
    );

    const { sc, text, scBytes, textBytes } = await call({ row_limit: 10_000, preview: 10_000 });

    expect(scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(sc.rows.length).toBeGreaterThan(0);
    expect(textIds(text)).toEqual(sc.rows.map((r) => r.id));
  });

  async function tuneLastRow(
    rows: (pad: number) => Array<Record<string, unknown>>,
    surface: 'scBytes' | 'textBytes',
  ) {
    answer(rows(0));
    const base = await call({});
    expect(base.sc.rows).toHaveLength(rows(0).length);
    const pad = INLINE_BUDGET_BYTES - base[surface];
    expect(pad).toBeGreaterThan(0);
    answer(rows(pad));
    const exact = await call({});
    answer(rows(pad + 1));
    const over = await call({});
    return { exact, over, count: rows(0).length };
  }

  it('fills structuredContent to exactly 64,000 bytes and drops a row one byte past it', async () => {
    const { exact, over, count } = await tuneLastRow(
      (pad) => [...Array.from({ length: 50 }, (_, i) => wide(i)), row(50, 'p'.repeat(pad))],
      'scBytes',
    );

    expect(exact.scBytes).toBe(INLINE_BUDGET_BYTES);
    expect(exact.textBytes).toBeLessThan(INLINE_BUDGET_BYTES);
    expect(exact.sc.rows).toHaveLength(count);
    expect(exact.sc).not.toHaveProperty('notice');
    expect(over.sc.rows).toHaveLength(count - 1);
    expect(over.scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
  });

  it('fills content[] to exactly 64,000 bytes when escaped text binds', async () => {
    const { exact, over, count } = await tuneLastRow(
      (pad) => [
        ...Array.from({ length: 36 }, (_, i) => row(i, '<'.repeat(380))),
        row(36, 'p'.repeat(pad)),
      ],
      'textBytes',
    );

    expect(exact.textBytes).toBe(INLINE_BUDGET_BYTES);
    expect(exact.scBytes).toBeLessThan(INLINE_BUDGET_BYTES);
    expect(exact.sc.rows).toHaveLength(count);
    expect(over.sc.rows).toHaveLength(count - 1);
    // The budget notice now rides in the trailer, and still fits.
    expect(over.text).toContain(`> ${over.sc.notice}`);
    expect(over.textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
  });

  it('bounds a huge SQL echo with a marker naming the full statement size', async () => {
    const sql = `SELECT * FROM df_T -- ${'"\\\n\u0001'.repeat(20_000)}${'😀'.repeat(20_000)}`;
    answer(
      Array.from({ length: 100 }, (_, i) => wide(i)),
      { rowCount: 100 },
    );

    const { sc, text, scBytes, textBytes } = await call({ sql });
    const echo = sc.executedSql as string;

    expect(bytes(JSON.stringify(echo))).toBeLessThanOrEqual(ECHO_BUDGET_BYTES);
    const marker = ` … [echo cut here — the full ${bytes(sql).toLocaleString()}-byte statement ran]`;
    expect(echo.endsWith(marker)).toBe(true);
    expect(sql.startsWith(echo.slice(0, -marker.length))).toBe(true);
    expect(scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(text).toContain(`**executedSql:** ${echo}`);
    expect(sc.rows.length).toBeGreaterThan(0);
  });

  it('never splits a surrogate pair where the SQL echo is cut', async () => {
    for (const lead of ['', 'x', 'xy', 'xyz']) {
      const sql = `${lead}${'😀'.repeat(5_000)}`;
      answer([row(0)]);
      const echo = (await call({ sql })).sc.executedSql as string;
      expect(echo).toMatch(/^[xyz]{0,3}(?:😀)+ … \[echo cut here/u);
      expect(Buffer.from(echo, 'utf8').toString('utf8')).toBe(echo);
    }
  });

  it('cuts a column list wider than half the budget when no row is inline', async () => {
    const columns = Array.from({ length: 6_000 }, (_, i) => `period_${String(i).padStart(5, '0')}`);
    answer([], { columns, rowCount: 0 });

    const { sc, scBytes, textBytes } = await call({});
    const kept = sc.columns.slice(0, -1);

    expect(sc.columns.at(-1)).toBe(`… ${(6_000 - kept.length).toLocaleString()} more columns`);
    expect(kept).toEqual(columns.slice(0, kept.length));
    expect(bytes(JSON.stringify(sc.columns))).toBeLessThanOrEqual(INLINE_BUDGET_BYTES / 2);
    expect(scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
  });

  it('withholds a row too wide for the budget beside a cut column list', async () => {
    const columns = Array.from({ length: 6_000 }, (_, i) => `period_${String(i).padStart(5, '0')}`);
    const pivoted = Object.fromEntries(columns.map((c) => [c, '1.5']));
    answer([pivoted], { columns });

    const { sc, scBytes, textBytes } = await call({});

    expect(sc.rows).toEqual([]);
    expect(sc.notice).toMatch(/^The first row alone exceeds the 64,000-byte response budget/);
    expect(sc.columns.at(-1)).toMatch(/^… [\d,]+ more columns$/);
    expect(scBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
    expect(textBytes).toBeLessThanOrEqual(INLINE_BUDGET_BYTES);
  });

  it('keeps a column list under half the budget whole', async () => {
    answer([], { columns: COLUMNS, rowCount: 0 });
    expect((await call({})).sc.columns).toEqual(COLUMNS);
  });
});
