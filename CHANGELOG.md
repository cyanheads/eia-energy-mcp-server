# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.3.7](changelog/0.3.x/0.3.7.md) — 2026-08-05

eia_describe_route keeps facet values EIA sends without a name and quotes a blank identifier in format()

## [0.3.6](changelog/0.3.x/0.3.6.md) — 2026-08-05

eia_dataframe_query surfaces row_limit truncation; eia_describe_route handles offset overshoot, unifies content[]/structuredContent facet windows, and drops restating aliases from format()

## [0.3.5](changelog/0.3.x/0.3.5.md) — 2026-08-05

eia_query_route: incomplete-return advisory suppressed when already accounted for, sort now reaches dataframe provenance, canvas_preview_note reports the staged range for offset-bound stages

## [0.3.4](changelog/0.3.x/0.3.4.md) — 2026-07-31

eia_search_routes now reaches the route behind a multi-term query via a tokenized candidate gate; WEAK_MATCH_SCORE re-derived from 0.9 to 0.72

## [0.3.3](changelog/0.3.x/0.3.3.md) — 2026-07-31

eia_search_routes now waits for a complete index and reports indexComplete/indexGaps; buildRouteTree no longer silently drops a subtree on a failed metadata fetch

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-07-31

Dataframe TTL now genuinely slides on query access, eia_dataframe_describe distinguishes a lookup miss from an empty canvas, and eia_dataframe_query declares the error reasons callers actually hit

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-07-31

Cap eia_describe_route facet values with offset paging, index facet values for eia_search_routes, fix a crash on non-array upstream frequency

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-07-31 · ⚠️ Breaking

Fix eia_query_route canvas spillover to stage the full accumulated result set, forward EIA's top-level warnings, and correct error reasons; drop the inert canvas_id parameter; adopt mcp-ts-core ^0.11.0

## [0.2.8](changelog/0.2.x/0.2.8.md) — 2026-06-20

Adopt mcp-ts-core ^0.10.9 (canvas describe/SQL-gate fixes, ctx.content collector); add check-dependency-specifiers + plugin-manifest devcheck guards; refresh dependencies

## [0.2.7](changelog/0.2.x/0.2.7.md) — 2026-06-13

Fix DataCanvas spillover for EIA's {col}-units columns; echo applied query inputs in eia_query_route and the executed SQL in eia_dataframe_query; declare system_catalog_access in the error contract

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
