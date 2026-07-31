<div align="center">
  <h1>@cyanheads/eia-energy-mcp-server</h1>
  <p><b>Browse and query the U.S. Energy Information Administration API v2 — electricity, petroleum, natural gas, coal, forecasts, and more via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/eia-energy-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/eia-energy-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/eia-energy-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/eia-energy-mcp-server/releases/latest/download/eia-energy-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=eia-energy-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZWlhLWVuZXJneS1tY3Atc2VydmVyIl0sImVudiI6eyJFSUFfQVBJX0tFWSI6InlvdXItYXBpLWtleSJ9fQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22eia-energy-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/eia-energy-mcp-server%22%5D%2C%22env%22%3A%7B%22EIA_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://eia-energy.caseyjhand.com/mcp](https://eia-energy.caseyjhand.com/mcp)

</div>

---

## Tools

Seven tools covering the two-phase EIA workflow — find the right dataset route, pull the data, and query spilled results via SQL:

| Tool | Description |
|:-----|:------------|
| `eia_browse_routes` | Lists child routes under a given path in the EIA dataset taxonomy. Start at root to see top-level categories, then drill into subcategories and leaf routes. |
| `eia_describe_route` | Returns full metadata for a leaf route: available facets with valid values, data column names, frequency options, units, and date range. Call before `eia_query_route` to understand filter options. |
| `eia_search_routes` | Fuzzy text search across route names, descriptions, and category labels. Resolves natural-language queries like "electricity retail sales by state" or "natural gas imports" to matching route paths. |
| `eia_query_route` | Fetches data from a leaf route with optional facet filters, date range, frequency, and column selection. Pages past the inline preview to stage large result sets as a DataCanvas table for SQL analysis. |
| `eia_dataframe_describe` | Lists active DataCanvas dataframes created by prior `eia_query_route` calls. Shows table name, column names and types, row count, TTL, and the query that produced it. |
| `eia_dataframe_query` | Runs a read-only SQL SELECT across DataCanvas dataframes, referenced by their `df_<id>` table names. |
| `eia_dataframe_drop` | Drops a DataCanvas dataframe, freeing its memory. Only exposed when `EIA_DATAFRAME_DROP_ENABLED=true`. |

### `eia_browse_routes`

Walk the EIA dataset taxonomy from root to leaf.

- Root call returns 14 top-level categories: electricity, petroleum, natural-gas, coal, international, total-energy, steo, aeo, ieo, seds, crude-oil-imports, nuclear-outages, densified-biomass, co2-emissions
- Intermediate paths return subcategories; leaf routes are flagged so callers know when to switch to `eia_describe_route`
- `STEO` (Short-Term Energy Outlook) is a flat leaf with 1,469 named series — no sub-routes

---

### `eia_describe_route`

Full schema for a leaf route. Required before constructing facet filters.

- Returns facets with valid values (fetched via per-facet API calls and cached in-process)
- Returns data column names, units, frequency options, and date range
- `eia_search_routes` and `eia_browse_routes` resolve the route path; this tool provides the filter vocabulary

---

### `eia_search_routes`

Fuzzy search across the in-memory route index.

- Indexes route names, descriptions, and category labels — plus STEO's 1,469 series names
- Resolves natural language ("natural gas spot prices", "ethanol net imports") to queryable route paths
- Route tree is cached in-process at first call; subsequent searches hit the Fuse.js index with no upstream cost

---

### `eia_query_route`

Pull data from a leaf route.

- Facet filters keyed by facet ID (e.g. `{ "stateid": "TX", "sectorid": ["RES", "COM"] }`)
- Date range and frequency selection; valid values discoverable via `eia_describe_route`
- Pagination via `offset`/`length` (max 5,000 rows per page); total row count in response
- All numeric values arrive as strings from the EIA API — units appear as inline `{col}-units` fields per row
- DataCanvas spillover when the result set exceeds `length`: further pages are fetched and the accumulated rows are staged as a `dataset` (`df_<id>`) for SQL, bounded by `EIA_CANVAS_MAX_ROWS`. The response note names how many rows actually reached the table.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

EIA-specific:

- Full coverage of EIA API v2 — all 14 top-level dataset categories
- In-process route tree cache with Fuse.js fuzzy index — built once at startup, no repeated upstream calls
- Per-route facet cache via `Promise.all` fan-out — valid filter values available without re-fetching
- STEO series names (1,469 entries) indexed for natural-language discovery
- DataCanvas (DuckDB) opt-in for tabular spillover — graceful degradation when unavailable

## Getting started

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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `EIA_DATASET_TTL_SECONDS` | Per-table TTL for DataCanvas dataframes in seconds. | `86400` (24 h) |
| `EIA_DATAFRAME_DROP_ENABLED` | Set to `true` to expose `eia_dataframe_drop`. Off by default to avoid accidental canvas cleanup. | `false` |
| `EIA_CANVAS_MAX_ROWS` | Cumulative row ceiling for `eia_query_route` canvas staging — five requests at EIA's 5,000-row-per-request ceiling, adding ~8.5 s to a call when it binds. Lower it for snappier exploration, raise it for wider staged analyses. | `25000` |
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas spillover for large result sets (Node only). | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments. | — |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation. | `false` |

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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
