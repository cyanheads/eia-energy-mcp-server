/**
 * @fileoverview EIA server-specific environment configuration. Parsed lazily on
 * first call; validated via Zod so errors name the actual env var at fault.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Each numeric variable is bounded above as well as below, so a value no
 * consumer can use stops startup naming the variable instead of failing calls
 * later:
 * - `EIA_DATASET_TTL_SECONDS` ≤ 31,536,000 (365 days). It becomes an expiry
 *   timestamp, which `Date` cannot represent past about 8.64e15 ms; a year is
 *   far beyond any useful dataframe lifetime and well inside that.
 * - `EIA_CANVAS_MAX_ROWS` ≤ 250,000 (50 EIA pages). Staging runs inside one
 *   call's 56 s deadline, which cannot fetch many more 5,000-row pages than
 *   that, and the accumulated rows sit in memory until registered.
 * - `EIA_FACET_VALUE_CAP` ≤ 1,000. It sizes every facet's window in one
 *   eia_describe_route response; past that a route with several large facets
 *   answers in megabytes, and values_offset and values_query page or narrow a
 *   facet instead.
 */
const ServerConfigSchema = z.object({
  apiKey: z.string().describe('EIA API key'),
  baseUrl: z.string().url().default('https://api.eia.gov/v2').describe('EIA API base URL'),
  datasetTtlSeconds: z.coerce
    .number()
    .int()
    .positive()
    .max(31_536_000)
    .default(86400)
    .describe(
      'Sliding per-dataframe TTL in seconds, extended by every query that references the dataframe (default 24 h, at most 365 days)',
    ),
  canvasMaxRows: z.coerce
    .number()
    .int()
    .positive()
    .max(250_000)
    .default(25000)
    .describe(
      'Cumulative row ceiling for eia_query_route canvas accumulation (default 25000 = 5 EIA requests, at most 250000)',
    ),
  facetValueCap: z.coerce
    .number()
    .int()
    .positive()
    .max(1000)
    .default(50)
    .describe(
      'Facet values eia_describe_route returns per facet before truncating (default 50, at most 1000)',
    ),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe('Expose eia_dataframe_drop when true'),
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Lower an over-cap count input (eia_query_route length, eia_dataframe_query row_limit and preview, eia_search_routes limit) to its cap with a notice; false advertises and enforces each cap as a schema maximum instead',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;
let _clampLimits: boolean | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'EIA_API_KEY',
    baseUrl: 'EIA_BASE_URL',
    datasetTtlSeconds: 'EIA_DATASET_TTL_SECONDS',
    canvasMaxRows: 'EIA_CANVAS_MAX_ROWS',
    facetValueCap: 'EIA_FACET_VALUE_CAP',
    dataframeDropEnabled: 'EIA_DATAFRAME_DROP_ENABLED',
    clampLimits: 'EIA_CLAMP_LIMITS',
  });
  return _config;
}

/**
 * `EIA_CLAMP_LIMITS` alone, parsed by the same field definition. The count
 * inputs' schemas read it while tools/list is built and while arguments are
 * validated — paths that also run in definition linting and tests — so it must
 * not hinge on `EIA_API_KEY`, which `getServerConfig()` requires. Startup still
 * validates it through `getServerConfig()`.
 */
export function getClampLimits(): boolean {
  _clampLimits ??= parseEnvConfig(ServerConfigSchema.pick({ clampLimits: true }), {
    clampLimits: 'EIA_CLAMP_LIMITS',
  }).clampLimits;
  return _clampLimits;
}

/**
 * Whether this deployment has a DataCanvas, read at tool-registration time.
 *
 * Deliberately outside `ServerConfigSchema` and read straight from the
 * environment: `CANVAS_PROVIDER_TYPE` belongs to the framework's core config,
 * which never merges with a server's own, and `createApp()` builds its `tools[]`
 * before `setup(core)` runs, so `core.canvas` is not in hand when the canvas-only
 * tools have to be gated. `duckdb` is the only enabling value — the framework
 * parses the variable as `z.enum(['none', 'duckdb'])`, so a malformed value
 * fails its own validation at startup rather than needing handling here.
 */
export function isCanvasEnabled(): boolean {
  return process.env.CANVAS_PROVIDER_TYPE === 'duckdb';
}

/** Reset for tests that need to change config. */
export function _resetServerConfig(): void {
  _config = undefined;
  _clampLimits = undefined;
}
