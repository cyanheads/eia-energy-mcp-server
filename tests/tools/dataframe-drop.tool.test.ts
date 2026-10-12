/**
 * @fileoverview Tests for the eia_dataframe_drop tool.
 * @module tests/tools/dataframe-drop.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import * as canvasBridge from '@/services/canvas-bridge/canvas-bridge.js';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  initCanvasBridge: vi.fn(),
  _resetCanvasBridge: vi.fn(),
}));

const mockDrop = vi.fn();

describe('dataframeDropTool', () => {
  beforeEach(() => {
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue({
      drop: mockDrop,
    } as unknown as ReturnType<typeof canvasBridge.getCanvasBridge>);
    mockDrop.mockReset();
  });

  it('throws canvas_unavailable when bridge is absent', async () => {
    vi.mocked(canvasBridge.getCanvasBridge).mockReturnValue(undefined);

    const ctx = createMockContext({ errors: dataframeDropTool.errors, tenantId: 'test' });
    const input = dataframeDropTool.input.parse({ name: 'df_TEST' });

    await expect(dataframeDropTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_unavailable' },
    });
  });

  it('returns dropped=true when the dataframe existed', async () => {
    mockDrop.mockResolvedValue({ status: 'dropped' });

    const ctx = createMockContext({ errors: dataframeDropTool.errors, tenantId: 'test' });
    const input = dataframeDropTool.input.parse({ name: 'df_TEST' });
    const result = await dataframeDropTool.handler(input, ctx);

    expect(result.name).toBe('df_TEST');
    expect(result.dropped).toBe(true);
    expect(mockDrop).toHaveBeenCalledWith(ctx, 'df_TEST');
  });

  it('returns dropped=false when the dataframe did not exist (idempotent)', async () => {
    mockDrop.mockResolvedValue({ status: 'absent' });

    const ctx = createMockContext({ errors: dataframeDropTool.errors, tenantId: 'test' });
    const input = dataframeDropTool.input.parse({ name: 'df_MISSING' });
    const result = await dataframeDropTool.handler(input, ctx);

    expect(result.name).toBe('df_MISSING');
    expect(result.dropped).toBe(false);
  });

  // #60 — a drop the canvas could not perform is a retryable failure, never a
  // dropped flag, and reaches both surfaces with its recovery.
  it('fails with canvas_drop_failed when the canvas could not drop', async () => {
    mockDrop.mockResolvedValue({ status: 'failed', message: 'canvas gone' });

    const result = await runToolContract(dataframeDropTool, { name: 'df_TEST' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringContaining('canvas gone'),
        data: {
          reason: 'canvas_drop_failed',
          retryable: true,
          name: 'df_TEST',
          recovery: { hint: expect.stringContaining('eia_dataframe_describe') },
        },
      },
    });
    const text = (result.content ?? []).map((b) => (b as { text?: string }).text ?? '').join('');
    expect(text).toContain('Retry eia_dataframe_drop');
    expect(text).toContain('reason canvas_drop_failed · retryable');
  });

  describe('format()', () => {
    it('renders drop confirmation when dropped=true', () => {
      const blocks = dataframeDropTool.format!({ name: 'df_TEST', dropped: true });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('df_TEST');
      expect(text).toContain('Dropped');
    });

    it('renders not-found message when dropped=false', () => {
      const blocks = dataframeDropTool.format!({ name: 'df_MISSING', dropped: false });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('df_MISSING');
      expect(text).toContain('not found');
    });
  });
});
