/**
 * @fileoverview Literal table rendering on both query response surfaces (#61).
 * @module tests/tools/literal-tables.tool.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { queryRouteTool } from '@/mcp-server/tools/definitions/query-route.tool.js';
import * as canvasBridge from '@/services/canvas-bridge/canvas-bridge.js';
import * as eiaService from '@/services/eia/eia-service.js';

vi.mock('@/services/eia/eia-service.js', () => ({ getEiaApiService: vi.fn() }));
vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({ getCanvasBridge: vi.fn() }));

const values = [
  ['ordinary 12.5', 'ordinary 12.5'],
  [null, ''],
  [false, 'false'],
  [0, '0'],
  ['<b>unsafe</b> | *em* [link](x)', '&lt;b&gt;unsafe&lt;/b&gt; \\| \\*em\\* \\[link\\]\\(x\\)'],
  ['x\\|y a\\*b `code` _em_ ~strike~', 'x\\\\\\|y a\\\\\\*b \\`code\\` \\_em\\_ \\~strike\\~'],
  ['&lt;tag&gt;\nnext\r\nlast\rend', '&amp;lt;tag&amp;gt;<br>next<br>last<br>end'],
  [{ nested: { text: '<b>*x*</b>' } }, '\\{"nested":\\{"text":"&lt;b&gt;\\*x\\*&lt;/b&gt;"\\}\\}'],
] as const;

describe('literal query tables', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(values)(
    'preserves %j in structured rows and renders a literal cell',
    async (value, literal) => {
      const rows = [{ label: value }];
      vi.mocked(eiaService.getEiaApiService).mockReturnValue({
        query: vi.fn().mockResolvedValue({
          route: 'steo',
          data: rows,
          total: 1,
          frequency: 'monthly',
          dateFormat: 'YYYY-MM',
        }),
      } as unknown as ReturnType<typeof eiaService.getEiaApiService>);
      vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue(undefined);
      const route = await runToolContract(queryRouteTool, { route: 'steo' });
      expect(route.isError).not.toBe(true);
      expect(route.structuredContent).toMatchObject({ data: rows });
      expect(route.content).toContainEqual(
        expect.objectContaining({ text: expect.stringContaining(`| ${literal} |`) }),
      );

      vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
        query: vi.fn().mockResolvedValue({ result: { columns: ['label'], rows, rowCount: 1 } }),
      } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
      const dataframe = await runToolContract(dataframeQueryTool, {
        sql: 'SELECT label FROM df_TEST',
      });
      expect(dataframe.isError).not.toBe(true);
      expect(dataframe.structuredContent).toMatchObject({ rows });
      expect(dataframe.content).toContainEqual(
        expect.objectContaining({ text: expect.stringContaining(`| ${literal} |`) }),
      );
    },
  );

  it('escapes column names and absorbed unit headers', () => {
    const result = {
      route: 'steo',
      data: [{ '<b>value</b>': '1', '<b>value</b>-units': '*units*' }],
      total: 1,
      returned_count: 1,
      frequency: 'monthly',
      date_format: 'YYYY-MM',
    };
    expect(queryRouteTool.format!(result)).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining('| &lt;b&gt;value&lt;/b&gt; (\\*units\\*) |'),
      }),
    );
    expect(
      dataframeQueryTool.format!({ columns: ['<b>value</b>'], rows: [{ '<b>value</b>': '1' }] }),
    ).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining('| &lt;b&gt;value&lt;/b&gt; |') }),
    );
  });
});
