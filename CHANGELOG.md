# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.6](changelog/0.2.x/0.2.6.md) — 2026-06-12

Adopt @cyanheads/mcp-ts-core ^0.10.6; server-level instructions; eia_search_routes truncation fields; canvas-bridge uses the framework system-catalog gate

## [0.2.5](changelog/0.2.x/0.2.5.md) — 2026-06-04

eia_query_route: zero-row results return structured data instead of throwing; total and returned_count added to output

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-06-02

@cyanheads/mcp-ts-core ^0.9.16 → ^0.9.21: per-request log context fix, secret-stripped error messages, fail-fast retry on non-retryable errors

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-05-30

Enrichment adoption — search/query/dataframe tools surface query echoes, result totals, and empty-result guidance in a typed enrichment block reaching both structuredContent and content[]

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-05-28 · 🛡️ Security

@cyanheads/mcp-ts-core ^0.9.6 → ^0.9.13: HTTP transport hardening, session-init gate, quieter error logs, GET /mcp keywords; dep refresh

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-05-25

fix: auto-fetch route metadata on cold cache in eia_query_route

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-05-24 · ⚠️ Breaking

Repo and package renamed from eia-mcp-server to eia-energy-mcp-server; tool names (eia_*) unchanged.

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-05-23

Add @duckdb/node-api ^1.5.3-r.1 — enables DuckDB canvas provider for dataframe tools.

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-23

Field-test bug fixes: error contracts, schema handling, and UX across eia_describe_route, eia_query_route, and eia_search_routes.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-23

Pre-launch polish: code simplification, docs/metadata sync, bunfig.toml, Dockerfile labels, server.json env var coverage.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-23

Field-test bug fixes: route tree misclassification, ZodError on value-array columns, 4xx error codes, auto-populate data[] columns, STEO filter_hint, description normalization.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-23

mcp-ts-core ^0.9.5 → ^0.9.6, LICENSE file, lint-packaging updates.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-23

mcp-ts-core ^0.9.5, error code semantics for domain validation, MCPB bundle support.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-21

Full tool surface implementation: EIA API service layer, four domain tools, three DataCanvas dataframe tools, and a complete test suite.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-21

Initial scaffold from @cyanheads/mcp-ts-core with tool-surface design for the EIA API v2.
