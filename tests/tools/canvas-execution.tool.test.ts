/**
 * @fileoverview Real DuckDB execution failures and recovery through the EIA tool.
 * @module tests/tools/canvas-execution.tool.test
 */
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect, it } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { _resetCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

it('preserves an execution-time conversion error and succeeds after TRY_CAST', async () => {
  const provider = new DuckdbProvider({
    defaultRowLimit: 10000,
    exportRootPath: '/tmp/eia-canvas-tests',
    memoryLimitMb: 128,
    schemaSniffRows: 100,
  });
  const canvas = new DataCanvas(
    provider,
    new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
  );
  initCanvasBridge(canvas);
  const ctx = createMockContext();
  try {
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
  } finally {
    _resetCanvasBridge();
    await canvas.shutdown(ctx);
  }
});
