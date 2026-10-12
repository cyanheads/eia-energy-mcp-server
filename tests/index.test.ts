/**
 * @fileoverview Tests for the tool surface createApp() is handed — the
 * canvas-only tools are gated at registration, so a deployment without a
 * DataCanvas advertises the four route tools rather than seven with three that
 * fail on call. `createApp` is stubbed so importing the entry point composes the
 * tool list without starting a server.
 * @module tests/index.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetServerConfig } from '@/config/server-config.js';

/**
 * The marker `disabledTool()` attaches. The framework reads it in the registry
 * and the manifest renderer but exports no reader, so the tests read the field
 * the same way those do.
 */
interface DisabledMetadata {
  hint?: string;
  reason: string;
}

function disabledMeta(def: unknown): DisabledMetadata | undefined {
  return (def as Record<string, unknown>).__mcpDisabled as DisabledMetadata | undefined;
}

/**
 * Every test re-imports the entry point after `vi.resetModules()`, so each one
 * loads the server's whole module graph — the first in a worker also
 * transforms it. That is well under a second idle and several seconds on a
 * loaded machine, past Vitest's 5 s default.
 */
const IMPORT_TIMEOUT = { timeout: 30_000 };

/** The slice of `createApp`'s options these tests read. */
interface CapturedOptions {
  sessionMode?: string;
  teardown?: () => void | Promise<void>;
  tools: Array<{ name: string }>;
}

/** Import the entry point with `createApp` stubbed and return the options it was handed. */
async function composedOptions(): Promise<CapturedOptions> {
  const captured: CapturedOptions[] = [];

  vi.doMock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
    createApp: vi.fn((options: CapturedOptions) => {
      captured.push(options);
      return Promise.resolve(undefined);
    }),
  }));

  await import('@/index.js');

  const options = captured[0];
  if (!options) throw new Error('createApp was not called');
  return options;
}

/** The tool list `createApp` was handed, keyed by tool name. */
async function registeredTools(): Promise<Map<string, unknown>> {
  const options = await composedOptions();
  expect(options.sessionMode).toBe('stateless');
  return new Map(options.tools.map((t) => [t.name, t]));
}

describe('tool registration', IMPORT_TIMEOUT, () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('EIA_API_KEY', 'test-key');
    _resetServerConfig();
  });

  afterEach(() => {
    vi.doUnmock('@cyanheads/mcp-ts-core');
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
  });

  it('gates every canvas-only tool when no canvas is configured', async () => {
    vi.stubEnv('CANVAS_PROVIDER_TYPE', '');

    const tools = await registeredTools();

    // The surface is still declared — the landing page names the gate — but
    // nothing canvas-only is registered for a client to call.
    for (const name of ['eia_dataframe_describe', 'eia_dataframe_query', 'eia_dataframe_drop']) {
      expect(disabledMeta(tools.get(name))?.hint).toBe('CANVAS_PROVIDER_TYPE=duckdb');
    }
    for (const name of [
      'eia_browse_routes',
      'eia_describe_route',
      'eia_search_routes',
      'eia_query_route',
    ]) {
      expect(disabledMeta(tools.get(name))).toBeUndefined();
    }
  });

  it('registers describe and query when a canvas is configured', async () => {
    vi.stubEnv('CANVAS_PROVIDER_TYPE', 'duckdb');

    const tools = await registeredTools();

    expect(disabledMeta(tools.get('eia_dataframe_describe'))).toBeUndefined();
    expect(disabledMeta(tools.get('eia_dataframe_query'))).toBeUndefined();
  });

  it('names the drop flag, not the canvas, once a canvas is configured', async () => {
    vi.stubEnv('CANVAS_PROVIDER_TYPE', 'duckdb');

    const tools = await registeredTools();

    // Two gates gate this tool; the card has to name the one that is unmet, or
    // the operator changes the wrong variable.
    expect(disabledMeta(tools.get('eia_dataframe_drop'))?.hint).toBe(
      'EIA_DATAFRAME_DROP_ENABLED=true',
    );
  });

  it('registers the drop tool when both its gates are met', async () => {
    vi.stubEnv('CANVAS_PROVIDER_TYPE', 'duckdb');
    vi.stubEnv('EIA_DATAFRAME_DROP_ENABLED', 'true');

    const tools = await registeredTools();

    expect(disabledMeta(tools.get('eia_dataframe_drop'))).toBeUndefined();
  });

  it('keeps the drop tool gated on the canvas even when its own flag is set', async () => {
    vi.stubEnv('CANVAS_PROVIDER_TYPE', '');
    vi.stubEnv('EIA_DATAFRAME_DROP_ENABLED', 'true');

    const tools = await registeredTools();

    expect(disabledMeta(tools.get('eia_dataframe_drop'))?.hint).toBe('CANVAS_PROVIDER_TYPE=duckdb');
  });

  it('treats a provider type other than duckdb as no canvas', async () => {
    vi.stubEnv('CANVAS_PROVIDER_TYPE', 'none');

    const tools = await registeredTools();

    expect(disabledMeta(tools.get('eia_dataframe_query'))?.hint).toBe(
      'CANVAS_PROVIDER_TYPE=duckdb',
    );
  });
});

describe('shutdown', IMPORT_TIMEOUT, () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('EIA_API_KEY', 'test-key');
    _resetServerConfig();
  });

  afterEach(() => {
    vi.doUnmock('@cyanheads/mcp-ts-core');
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetServerConfig();
  });

  // The warm no request owns has exactly one way to stop: the teardown hook.
  it('aborts the route-index warm from the teardown hook', async () => {
    const options = await composedOptions();
    // Same module registry as the entry point just imported, so the same service.
    const { initEiaApiService, getEiaApiService } = await import('@/services/eia/eia-service.js');
    initEiaApiService();
    const fetched = Promise.withResolvers<AbortSignal | undefined>();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal ?? undefined;
            signal?.addEventListener('abort', () => reject(signal.reason));
            fetched.resolve(signal);
          }),
      ),
    );

    const browse = getEiaApiService().browse(undefined, createMockContext());
    const warmSignal = await fetched.promise;
    expect(warmSignal?.aborted).toBe(false);
    await options.teardown?.();

    expect(warmSignal?.aborted).toBe(true);
    await expect(browse).rejects.toThrow('EIA service shut down');
  });
});
