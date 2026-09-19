<div align="center">
  <h1>@cyanheads/eia-energy-mcp-server</h1>
  <p><b>Browse and query the U.S. Energy Information Administration API v2 — electricity, petroleum, natural gas, coal, forecasts, and more via MCP. STDIO or Streamable HTTP.</b>
  <div>4 core tools + 3 DataCanvas tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/eia-energy-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/eia-energy-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/eia-energy-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/eia-energy-mcp-server/releases/latest/download/eia-energy-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=eia-energy-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZWlhLWVuZXJneS1tY3Atc2VydmVyIl0sImVudiI6eyJFSUFfQVBJX0tFWSI6InlvdXItYXBpLWtleSJ9fQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22eia-energy-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/eia-energy-mcp-server%22%5D%2C%22env%22%3A%7B%22EIA_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://eia-energy.caseyjhand.com/mcp](https://eia-energy.caseyjhand.com/mcp)

</div>

---

## Overview

Energy data from the U.S. Energy Information Administration (EIA) API v2 — electricity, petroleum, natural gas, coal, and forecasts. Browse the dataset taxonomy, search it by natural language, and query time-series data with facet filters, then stage large result sets as a SQL-queryable DataCanvas table. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `eia_browse_routes` | Lists child routes under a path in the EIA dataset taxonomy; omit `path` for the 14 top-level categories. |
| `eia_describe_route` | Returns a leaf route's facets, valid values, data columns, frequencies, and date range. |
| `eia_search_routes` | Fuzzy text search across route names, descriptions, STEO series names, and facet values. |
| `eia_query_route` | Fetches data from a leaf route with facet filters, date range, and column selection; optionally stages results for SQL. |
| `eia_dataframe_describe` | Lists active DataCanvas dataframes staged by `eia_query_route`, with schema and provenance. |
| `eia_dataframe_query` | Runs a read-only SQL SELECT against staged DataCanvas dataframes. |
| `eia_dataframe_drop` | Drops a DataCanvas dataframe, freeing its memory. |

The three `eia_dataframe_*` tools are registered only when `CANVAS_PROVIDER_TYPE=duckdb` is set; `eia_dataframe_drop` additionally requires `EIA_DATAFRAME_DROP_ENABLED=true`. A default deployment lists the first four tools.

## Capability reference

### `eia_browse_routes` <sub>tool</sub>

- Omit `path` for the 14 top-level categories (electricity, petroleum, natural-gas, coal, international, total-energy, steo, aeo, ieo, seds, crude-oil-imports, nuclear-outages, densified-biomass, co2-emissions); pass a path to drill into subcategories
- Each child carries `isLeaf` — leaf routes are queryable via `eia_describe_route` / `eia_query_route`; non-leaf routes have further children to browse
- `steo` is a flat leaf with 1,469 named series and no sub-routes
- Accepts `route` as an alias for `path`; supplying both is rejected. Leading, trailing, and doubled slashes are stripped before resolving
- `route_not_found` when the path does not exist in the taxonomy

---

### `eia_describe_route` <sub>tool</sub>

- Returns facets (with valid values), data column names/units, frequency options, and date range for a leaf `route`; accepts `path` as an alias, but not alongside `route`
- Each facet is capped at `EIA_FACET_VALUE_CAP` values (default 50), with `value_count` and `values_truncated`; page one facet with `facet` + `values_offset`
- A `values_offset` past a facet's last value returns an empty window plus a `notice` naming the facet and its `value_count`, rather than reading as an exhausted enumeration
- Errors: `route_not_found`, `route_not_queryable` (category node, not a leaf), `facet_not_found`, `rate_limited` (retryable)

---

### `eia_search_routes` <sub>tool</sub>

- Fuzzy match over route names/descriptions, STEO's 1,469 series names, and facet values; `limit` caps results (default 10, max 30)
- `score` runs 0 (exact) to 1 (no match); above 0.72 is a weak match — narrow the query or use `eia_browse_routes`
- Matching facet-value or STEO results carry `filter_hint`, a ready-to-use filter object for `eia_query_route`
- The first call after server start waits 24–30 s (never more than 45 s) for the index to warm; every later call is served from the in-process index in milliseconds
- `indexComplete` / `indexGaps` report whether the corpus was complete when scored — check before trusting a short result set

---

### `eia_query_route` <sub>tool</sub>

- Takes `route` (or alias `path`, never both), facet filters keyed by facet ID (from `eia_describe_route`), plus optional `columns`, `frequency`, `start`/`end`, and `sort`
- `offset`/`length` page the inline preview (`length` default 100, max 5000 per EIA's per-request ceiling); `total` reports the full match count
- Data values arrive as strings; per-column units appear as inline `{col}-units` fields
- `stage: true` pages past the preview and stages the accumulated rows as a DataCanvas `df_<id>` table (bounded by `EIA_CANVAS_MAX_ROWS`, default 25000) for `eia_dataframe_query`; omitted, the call costs one upstream request regardless of `total`
- Errors: `route_not_found`, `route_not_queryable`, `invalid_facet` / `invalid_column` / `invalid_frequency` / `invalid_sort` / `invalid_period`, `no_data` (inverted date range), `rate_limited` (retryable)

---

### `eia_dataframe_describe` <sub>tool</sub>

- Lists DataCanvas dataframes staged by prior `eia_query_route` calls with `stage: true`; only registered when `CANVAS_PROVIDER_TYPE=duckdb`
- Omit `name` to list every active dataframe for the tenant; pass `name` to check one — a miss comes back as `found: false` alongside `active_names`, never as an empty list
- Each entry reports `source_tool`, `query_params`, `created_at`, `expires_at`, `row_count`, `truncated` / `max_rows`, and `column_schema`
- Listing does not extend a dataframe's expiry — only an `eia_dataframe_query` statement referencing it does
- `canvas_unavailable` when no canvas is configured

---

### `eia_dataframe_query` <sub>tool</sub>

- Runs one read-only SQL SELECT against `df_<id>` tables; writes, DDL, `DROP`, `COPY`, `PRAGMA`, `ATTACH`, and system catalogs (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*`) are rejected
- `row_limit` (default 1000, max 10000) hard-caps materialized rows — rows past it are dropped uncounted, so `totalRows` becomes the cap, not a true total; `preview` separately narrows the inline slice without affecting the count
- `register_as` persists the result as a new dataframe with a fresh expiry; the name must be unused
- EIA data columns are VARCHAR — cast with `CAST(col AS DOUBLE)` for arithmetic
- Errors: `canvas_unavailable`, `system_catalog_access`, `missing_table`, `non_select_statement`, `invalid_sql`, `register_as_clash`

---

### `eia_dataframe_drop` <sub>tool</sub>

- Drops a dataframe by `name`; idempotent — returns `dropped: false` when nothing matched
- Only registered when `EIA_DATAFRAME_DROP_ENABLED=true` and `CANVAS_PROVIDER_TYPE=duckdb`
- Manual cleanup only — the per-dataframe expiry (default 24 h, extended by every referencing query) handles cleanup in normal operation
- `canvas_unavailable` when no canvas is configured

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

EIA-specific:

- Full coverage of EIA API v2's 14 top-level dataset categories, via an in-process route tree cache built once on first use
- Fuzzy search index (Fuse.js) covers route names/descriptions, all 1,469 STEO series names, and facet values for natural-language discovery
- Per-route facet metadata is fetched by fan-out (`Promise.all`) and cached, so `eia_query_route` filters are validated without re-fetching
- A route whose metadata could not be fetched is held as an incomplete stub — reported through `eia_search_routes` rather than silently dropped — and re-fetched on the next `eia_browse_routes` call that reaches it
- DataCanvas (DuckDB) staging is opt-in per call; the three dataframe tools are gated at registration so a canvas-less deployment lists no tool it cannot serve

Agent-friendly output:

- Provenance — `eia_query_route` echoes the canonical, slash-normalized route rather than the caller's spelling, and every staged dataframe records its `source_tool` and `query_params`
- Capped-window disclosure — every truncatable response (facet values, row previews, SQL row limits) reports the count against its cap and a `notice` naming the exact next call to page past it
- Discriminated failure — typed error `reason` values (e.g. `route_not_queryable`, `invalid_facet`, `missing_table`) each carry a `recovery` hint naming the next tool call

## Getting started

### Public Hosted Instance

A public instance is available at `https://eia-energy.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "eia-energy-mcp-server": {
      "type": "streamable-http",
      "url": "https://eia-energy.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Get a free API key at [api.eia.gov](https://www.eia.gov/opendata/), then add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "eia-energy-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/eia-energy-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "EIA_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "eia-energy-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/eia-energy-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "EIA_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "eia-energy-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "EIA_API_KEY=your-api-key",
        "ghcr.io/cyanheads/eia-energy-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 EIA_API_KEY=your-key bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- A free EIA API key from [api.eia.gov](https://www.eia.gov/opendata/). The `DEMO_KEY` hits rate limits quickly; a real key is required for sustained use.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/eia-energy-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd eia-energy-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set required vars (at minimum, EIA_API_KEY)
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---------|:------------|:--------|
| `EIA_API_KEY` | **Required.** Free API key from api.eia.gov — appended as `api_key` on every request. | — |
| `EIA_BASE_URL` | EIA API base URL. | `https://api.eia.gov/v2` |
| `EIA_DATASET_TTL_SECONDS` | Sliding per-dataframe TTL in seconds. The window is extended every time an `eia_dataframe_query` statement references the dataframe, so a dataframe stays alive through a long analysis and lapses only once it goes unused for the full interval. Listing it with `eia_dataframe_describe` is not use and does not extend it. | `86400` (24 h) |
| `EIA_DATAFRAME_DROP_ENABLED` | Set to `true` to expose `eia_dataframe_drop`, which also requires `CANVAS_PROVIDER_TYPE=duckdb`. Off by default to avoid accidental canvas cleanup. | `false` |
| `EIA_CANVAS_MAX_ROWS` | Cumulative row ceiling for `eia_query_route` canvas staging — five requests at EIA's 5,000-row-per-request ceiling, adding ~8.5 s to a call when it binds. Lower it for snappier exploration, raise it for wider staged analyses. | `25000` |
| `EIA_FACET_VALUE_CAP` | Facet values `eia_describe_route` returns per facet before truncating. Bounds the response on high-cardinality facets — STEO's `seriesId` alone has 1,469 values. Page past it with the tool's `facet` and `values_offset` inputs. | `50` |
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas (Node only). Adds the three `eia_dataframe_*` tools to the surface and lets `eia_query_route` stage rows when called with `stage: true`. | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
| `MCP_SESSION_MODE` | HTTP sessions: `stateless`, `stateful`, or `auto` (framework schema default, resolves to `stateful`). This server defaults to `stateless`; an explicit environment value overrides it. | `stateless` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments. | — |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t eia-energy-mcp-server .
docker run --rm -e EIA_API_KEY=your-key -p 3010:3010 eia-energy-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/eia-energy-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — browse, describe, search, query, and three DataCanvas dataframe tools. |
| `src/services/eia` | EIA API v2 service — route tree cache, Fuse.js index, facet fan-out, HTTP client. |
| `src/services/canvas-bridge` | DataCanvas bridge — registers EIA query results as DuckDB dataframes, routes SQL queries. |
| `tests/` | Unit and integration tests mirroring `src/`. |
| `docs/` | Design documents (`design.md`, `idea.md`). |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Always call `eia_describe_route` before `eia_query_route` — facet values require a separate API fan-out and are not embedded in route metadata
- Wrap EIA responses: validate raw → normalize to domain type → return output schema; data values are strings — never coerce silently

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
