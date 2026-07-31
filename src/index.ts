#!/usr/bin/env node
/**
 * @fileoverview eia-energy-mcp-server MCP server entry point.
 * @module index
 */

import { createApp, disabledTool } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
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

const dropTool = serverConfig.dataframeDropEnabled
  ? dataframeDropTool
  : disabledTool(dataframeDropTool, {
      reason: 'Dataframe drop is disabled in this deployment.',
      hint: 'EIA_DATAFRAME_DROP_ENABLED=true',
    });

await createApp({
  name: 'eia-energy-mcp-server',
  title: 'eia-energy-mcp-server',
  instructions:
    'Use the `eia_*` tools for U.S. Energy Information Administration (EIA) API v2 energy data. Requires an `EIA_API_KEY`. Routes use path identifiers (e.g. `electricity`, `petroleum/pri`). Workflow: `eia_search_routes` or `eia_browse_routes` to find a leaf route → `eia_describe_route` for its facets and columns → `eia_query_route` with facet-ID filters. Facet values come only from describe, not route metadata, so describe before querying. Values arrive as strings; large results spill to a DataCanvas table named by the `dataset` field, queried via SQL with `eia_dataframe_query`. Every dataset a tenant stages shares one canvas, so tables from different routes cross-join by name.',
  tools: [
    browseRoutesTool,
    describeRouteTool,
    searchRoutesTool,
    queryRouteTool,
    dataframeDescribeTool,
    dataframeQueryTool,
    dropTool,
  ],
  landing: { requireAuth: false },
  setup(core) {
    initEiaApiService();
    initCanvasBridge(core.canvas);
  },
});
