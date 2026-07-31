/**
 * @fileoverview EIA server-specific environment configuration. Parsed lazily on
 * first call; validated via Zod so errors name the actual env var at fault.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z.string().describe('EIA API key'),
  baseUrl: z.string().url().default('https://api.eia.gov/v2').describe('EIA API base URL'),
  datasetTtlSeconds: z.coerce
    .number()
    .int()
    .positive()
    .default(86400)
    .describe(
      'Sliding per-dataframe TTL in seconds, extended by every query that references the dataframe (default 24 h)',
    ),
  canvasMaxRows: z.coerce
    .number()
    .int()
    .positive()
    .default(25000)
    .describe(
      'Cumulative row ceiling for eia_query_route canvas accumulation (default 25000 = 5 EIA requests)',
    ),
  facetValueCap: z.coerce
    .number()
    .int()
    .positive()
    .default(50)
    .describe('Facet values eia_describe_route returns per facet before truncating (default 50)'),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe('Expose eia_dataframe_drop when true'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'EIA_API_KEY',
    baseUrl: 'EIA_BASE_URL',
    datasetTtlSeconds: 'EIA_DATASET_TTL_SECONDS',
    canvasMaxRows: 'EIA_CANVAS_MAX_ROWS',
    facetValueCap: 'EIA_FACET_VALUE_CAP',
    dataframeDropEnabled: 'EIA_DATAFRAME_DROP_ENABLED',
  });
  return _config;
}

/** Reset for tests that need to change config. */
export function _resetServerConfig(): void {
  _config = undefined;
}
