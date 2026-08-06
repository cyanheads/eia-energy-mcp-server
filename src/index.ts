#!/usr/bin/env node
/**
 * @fileoverview eia-energy-mcp-server MCP server entry point.
 * @module index
 */

import { createApp, disabledTool } from '@cyanheads/mcp-ts-core';
import { getServerConfig, isCanvasEnabled } from './config/server-config.js';
import { browseRoutesTool } from './mcp-server/tools/definitions/browse-routes.tool.js';
import { dataframeDescribeTool } from './mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from './mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from './mcp-server/tools/definitions/dataframe-query.tool.js';
import { describeRouteTool } from './mcp-server/tools/definitions/describe-route.tool.js';
import { queryRouteTool } from './mcp-server/tools/definitions/query-route.tool.js';
import { searchRoutesTool } from './mcp-server/tools/definitions/search-routes.tool.js';
import { initCanvasBridge } from './services/canvas-bridge/canvas-bridge.js';
import { initEiaApiService } from './services/eia/eia-service.js';

const serverConfig = getServerConfig();

/**
 * The three dataframe tools are canvas-only — every one of their handlers fails
 * on the first line without a canvas — so a deployment with none advertises
 * four working tools rather than six of which two fail on call.
 * `canvas_unavailable` stays on each contract as the backstop for a canvas that
 * fails at runtime.
 * The drop tool answers to two gates, and the landing card names whichever one
 * is actually unmet.
 */
const canvasEnabled = isCanvasEnabled();

const canvasDisabled = {
  reason: 'DataCanvas is not configured in this deployment.',
  hint: 'CANVAS_PROVIDER_TYPE=duckdb',
};

const describeDataframesTool = canvasEnabled
  ? dataframeDescribeTool
  : disabledTool(dataframeDescribeTool, canvasDisabled);

const queryDataframesTool = canvasEnabled
  ? dataframeQueryTool
  : disabledTool(dataframeQueryTool, canvasDisabled);

const dropTool = !canvasEnabled
  ? disabledTool(dataframeDropTool, canvasDisabled)
  : serverConfig.dataframeDropEnabled
    ? dataframeDropTool
    : disabledTool(dataframeDropTool, {
        reason: 'Dataframe drop is disabled in this deployment.',
        hint: 'EIA_DATAFRAME_DROP_ENABLED=true',
      });

await createApp({
  name: 'eia-energy-mcp-server',
  title: 'eia-energy-mcp-server',
  instructions:
    'Use the `eia_*` tools for U.S. Energy Information Administration (EIA) API v2 energy data. Requires an `EIA_API_KEY`. Routes use path identifiers (e.g. `electricity`, `petroleum/pri`); leading, trailing, and doubled slashes are stripped, so an EIA-doc spelling resolves the same way. Workflow: `eia_search_routes` or `eia_browse_routes` to find a leaf route → `eia_describe_route` for its facets and columns → `eia_query_route` with facet-ID filters. Facet values come only from describe, not route metadata, so describe before querying. Values arrive as strings. `eia_query_route` returns a preview and stages nothing by default; pass `stage: true` to also stage the matching rows as a DataCanvas table named by the `dataset` field, queried via SQL with `eia_dataframe_query`. Every dataset a tenant stages shares one canvas, so tables from different routes cross-join by name. The dataframe tools are listed only where a canvas is configured.',
  tools: [
    browseRoutesTool,
    describeRouteTool,
    searchRoutesTool,
    queryRouteTool,
    describeDataframesTool,
    queryDataframesTool,
    dropTool,
  ],
  landing: { requireAuth: false },
  setup(core) {
    initEiaApiService();
    initCanvasBridge(core.canvas);
  },
});
