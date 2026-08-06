# EIA MCP Server — Design

## MCP Surface

### Tools

4 tools + 3 dataframe tools (+1 opt-in dataframe drop)

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `eia_browse_routes` | Lists child routes under a given path in the EIA dataset taxonomy. Start with no path to get top-level categories (electricity, petroleum, natural-gas, steo, aeo, ieo, seds, etc.), then drill into subcategories and leaf routes. | `path?` (route prefix, defaults to root) | `readOnlyHint`, `openWorldHint: false` |
| `eia_describe_route` | Returns full metadata for a leaf route: available facets with their valid values, data column names, frequency options, units, and date range. Call before `eia_query_route` to understand filter options. | `route` (e.g. `electricity/retail-sales`) | `readOnlyHint`, `openWorldHint: false` |
| `eia_search_routes` | Fuzzy text search across route names, descriptions, and category labels. Resolves natural-language queries like "electricity retail sales by state" or "natural gas imports" to matching route paths. | `query`, `limit?` | `readOnlyHint`, `openWorldHint: false` |
| `eia_query_route` | Fetches data from a leaf route with optional facet filters, date range, frequency, and column selection. Returns a preview inline; spills large result sets to a DataCanvas table for SQL analysis by paging past the preview up to `EIA_CANVAS_MAX_ROWS`. Returns `dataset` (`df_<id>`) when spillover occurs. | `route`, `filters?` (facet key-value pairs), `start?`, `end?`, `frequency?`, `columns?`, `sort?`, `offset?`, `length?` | `readOnlyHint`, `openWorldHint: false` |
| `eia_dataframe_describe` | List canvas dataframes materialized by `eia_query_route`, with provenance, expiry, row count, and column schema. A `name` that is not staged returns `found: false` alongside the handles that are. Listing does not extend a dataframe's expiry. | `name?` (single `df_<id>` or omit for all) | `readOnlyHint`, `idempotentHint`, `openWorldHint: false` |
| `eia_dataframe_query` | Run a single-statement SELECT across canvas dataframes. Supports `register_as` to persist results as new dataframes. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected by the framework SQL gate. System catalogs are denied at the bridge layer. | `sql`, `register_as?`, `preview?`, `row_limit?` | `readOnlyHint`, `idempotentHint`, `openWorldHint: false` |
| `eia_dataframe_drop` | Drop a canvas dataframe by name. **Opt-in** via `EIA_DATAFRAME_DROP_ENABLED=true` — off by default since the sliding expiry handles cleanup. Idempotent: returns `dropped=false` when nothing matched. | `name` | `readOnlyHint: false`, `idempotentHint`, `destructiveHint: true` |

### Resources

None. The route tree is dynamic and too large for stable URIs; tool access covers all workflows.

### Prompts

None. Purely data-access server.

---

## Overview

Exposes the U.S. Energy Information Administration's API v2 as a navigable, queryable MCP surface. Wraps a hierarchical dataset taxonomy with 14 top-level categories: electricity, petroleum, natural-gas, coal, international, total-energy, steo (Short-Term Energy Outlook — a single flat leaf with 1,469 named series accessed via `seriesId` facet), aeo (Annual Energy Outlook), ieo (International Energy Outlook), seds, crude-oil-imports, nuclear-outages, densified-biomass, and co2-emissions (deprecated). The core problem is discovery: hundreds of leaf routes each with their own facets and units. Four tools map to the two-phase workflow every query requires — first find the right route, then pull the data.

## Requirements

- Read-only access to EIA API v2 (`https://api.eia.gov/v2`)
- Free API key required (`EIA_API_KEY` env var); no write or admin operations
- Rate limits apply — DEMO_KEY hits limits quickly; production keys are more generous but EIA does enforce per-minute caps. Cache the route tree and facet values in-process to minimize upstream calls.
- Response format: JSON throughout; pagination via `offset`/`length` params and `total` in the response
- DataCanvas (DuckDB) for tabular spillover — opt-in, Node only; tools degrade gracefully when unavailable (`ctx.core.canvas` is undefined in Workers)
- No mutations, no account-scoped data — pure public dataset access

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `EiaApiService` | EIA API v2 (`api.eia.gov/v2`) | All four data tools |
| `CanvasBridgeService` | Framework `DataCanvas` (`ctx.core.canvas`) | `eia_query_route` (register), `eia_dataframe_describe`, `eia_dataframe_query`, `eia_dataframe_drop` |

**`CanvasBridgeService`** adapts the generic `DataCanvas` primitive for EIA-specific workflows:
- Mints `df_<id>` handles for each registered table (deterministic, collision-resistant; bridged to the canvas table name).
- Derives an all-nullable column schema from the first 100 rows of an EIA result set. All EIA data values arrive as strings; the bridge maps them to `VARCHAR` by default and records this in provenance so SQL consumers know to `CAST` when doing arithmetic.
- Tracks per-table provenance: source tool, original input parameters, creation timestamp, row count, and truncation flag. Expiry is deliberately not among them — the canvas owns it and reports the current value.
- Registers every table with the framework canvas primitive's sliding per-table TTL (default 24 h, override with `EIA_DATASET_TTL_SECONDS`), distinct from the canvas-level TTL. The canvas extends a dataframe's window whenever an `eia_dataframe_query` statement references it by name and its sweeper drops the table once the window lapses; the bridge keeps no expiry clock of its own. Every path that reads or writes provenance first reconciles it against the canvas's live table list, so an entry never outlives the table it describes — including for a caller that stages and queries but never lists.
- Bridge-layer deny of DuckDB system catalogs (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*`) so callers cannot enumerate `df_<id>` handles they don't already hold. Callers discover handles via `eia_query_route` output or `eia_dataframe_describe`.

**Resilience:**
- Retry boundary: full fetch + parse pipeline in each service method, via `withRetry`
- Backoff: 1s base (EIA is generally stable; retry mainly for transient 5xx/timeouts)
- Parse failure: detect HTML error pages and classify as transient `ServiceUnavailable`, not `SerializationError`
- Field selection: pass EIA's `data[]` param to request only needed columns

**Route search strategy:** Fetch the full route tree lazily and cache in-process at startup (warm on first `eia_browse_routes` or `eia_search_routes` call). The route tree is stable between EIA releases. In-memory Fuse.js fuzzy index built once; no build-time pre-indexing needed. Two further entry classes join the index after the tree, each carrying a `filter_hint` so a hit is directly queryable: STEO's 1,469 `seriesId` values (fetched once via `/v2/steo/facet/seriesId`) so queries like "ethanol net imports" resolve to the right series ID, and facet values so a fuel-type or sector term resolves to the route that exposes it.

**Warm milestones and completeness.** The warm resolves in two stages. `ensureTreeWarmed()` resolves once the tree is built — everything browse, describe, and query need. `ensureIndexWarmed()` also awaits the STEO and vocabulary passes, and `search()` takes that path: a ranking over a half-filled index is shaped exactly like a ranking over the full one, so a caller has no way to tell that the entry belonging in the top slot was simply absent. `getIndexStatus()` reports the outcome — `complete`, the route paths whose metadata never arrived, and the passes that fell short — which `eia_search_routes` surfaces as `indexComplete` / `indexGaps`.

That wait carries a ceiling, `SEARCH_WARM_BUDGET_MS` (45 s). Measured cold against the live API over seven runs the whole warm lands in 24.3–29.4 s, so the ceiling never fires on a healthy run. It bounds the degraded one, where the serial sweep spends up to four attempts and ~7 s of backoff on every node it still cannot reach: with a single route and a single facet endpoint answering 503, the same cold search measured 37 s. Past the ceiling `search()` answers from what is indexed, and the same `indexComplete` / `indexGaps` fields report the shortfall — what the ceiling exists to avoid is a call held past the client's own request timeout (60 s in the MCP SDK), which reaches the caller as a transport error carrying none of the tool's recovery hint. `ensureTreeWarmed()` has no such ceiling: browse, describe, and query have nothing to answer with until the tree exists.

**Tree-build pacing and incomplete nodes.** The build is paced by a shared `ConcurrencyGate` at `TREE_BUILD_CONCURRENCY` (8) rather than an unbounded `Promise.all`: the ~270 requests it issues were drawing `OVER_RATE_LIMIT` from EIA, and a rejected node used to fall back to its parent's stub — which carries no `routes`/`facets`/`data` and so read as a queryable leaf, silently removing a whole subtree for the process lifetime. Nodes that still miss are retried by a serial second pass once the burst is over; `buildRouteTree` skips any node that already has metadata, so the sweep touches only the gaps. What survives both passes is marked `incomplete`: never classified as a leaf, named in `getIndexStatus()`, skipped by the cached leaf/category pre-flight in `describe()` and `query()` so the live fetch decides instead, and re-fetched by `repairNode()` on the next `eia_browse_routes` call that reaches it. A browse whose re-fetch also fails errors rather than answering from the stub.

`FUSE_OPTIONS` — keys, weights, threshold — is corpus-wide, because Fuse normalizes key weights against each other. Editing it moves every entry's score at once and invalidates `WEAK_MATCH_SCORE`. Appending entries does not move the **phrase** path, since Fuse scores each entry against the pattern on its own — that property is what let STEO series and facet values join the index without recalibration. It does move the **tokenized** path, whose term weights are document frequencies over the whole corpus, so a new entry class shifts every multi-term score by some amount. `tests/services/route-cache.test.ts` pins both paths.

**Tokenized candidate gate.** Fuse matches a query as one approximate contiguous run, which answers "does this entry read like the query" and nothing else. No route's text contains "electricity price residential" as such a run, however well `electricity/retail-sales` holds the data, so the phrase path never makes that route a candidate to rank. A multi-term query is therefore scored a second way — each term searched separately, the per-term results combined — and each entry keeps whichever of the two scored it better. A single-term query has nothing to tokenize and takes the phrase path alone, which preserves facet-value resolution by construction rather than by calibration.

Four rules keep the second path from buying recall with precision, which is the trade that sank every direction measured before it:

1. **Term weight is inverse document frequency.** A content word matching a large slice of the corpus earns almost nothing; nothing domain-specific is hand-listed, so the mechanism travels to vocabulary nobody anticipated. Function words are dropped outright — frequency is the wrong question for them, and `by` matches fewer entries than `electricity`, so IDF alone would read the preposition as the rarer term.
2. **Admission is on matched weight, floored by matched term count.** The floor is what asks a two-term query for both concepts; one rare word routinely carries over 99% of a two-term query's weight, enough to clear any weight bar alone.
3. **The combine is a weighted geometric mean.** Each missing term multiplies the result down by its share of the weight, so misses compound instead of averaging out against the terms that matched.
4. **A term of `VERBATIM_TERM_LENGTH` characters or fewer must appear verbatim.** Fuse's threshold admits a one-edit match on any short pattern, and a short token's one-edit neighbourhood reaches a large slice of the corpus — `cat` fuzzy-matches 856 of 2,103 entries against the 17 that carry it, and `food` reaches `Wood`. Such a match clears both admission rules while carrying none of the concept, and it is the only way an unanswerable query reached a confident score. Longer terms keep their fuzziness, which is what lets a plural query reach a singular description; requiring *every* term verbatim scores better on the battery and is the wrong trade, dropping `electricity prices residential` from 0.10 on the right route to 0.88 on an unrelated STEO series.

`scripts/search-battery.ts` is the labelled query set and `bun run eval:search` scores both paths against one warmed corpus, so a change to the gate reads as a delta rather than an absolute.

**Facet value indexing:** Facet values reach the index from two directions, both bounded:

1. **Vocabulary pass at warm time.** The cached tree already names every leaf's facet IDs, so selecting targets costs nothing upstream. `VOCABULARY_FACET_IDS` in `route-cache.ts` allowlists the fuel / sector / technology / coal-rank dimensions, comparing IDs with case and punctuation stripped — EIA names the same dimension `fueltypeid`, `fuelTypeId`, `fuelType`, and `energy_source_code` across different routes. Fetches run through a `ConcurrencyGate` at `FACET_INDEX_CONCURRENCY` once the tree is ready. A facet that fails is skipped rather than failing the pass, but it is counted — a skipped facet leaves vocabulary out of the corpus, so the pass reports itself short and `indexComplete` goes false.
2. **Opportunistically, per described route.** `fetchAndCacheMetadata()` already holds the values, so folding them into the index costs nothing upstream. This is what makes a route's vocabulary searchable when its facets sit outside the allowlist.

Both paths skip facets above `MAX_INDEXED_FACET_VALUES` (200) — those are opaque-identifier dimensions (mine IDs, plant codes, `duoarea` area codes) that nobody searches by name, and indexing them would swamp the corpus. Entries dedupe on route + `filter_hint`, so the two paths overlapping is a no-op.

**Facet value fetch cost.** Measured against the live taxonomy: 232 leaf routes carry 892 facets in aggregate, across 82 distinct facet IDs. Four of them — `duoarea`, `product`, `process`, `series` — appear on 165 routes each and account for most of the volume. A single `/facet/{id}` fetch runs 0.12–3.5 s and 0.3–283 KB. Fetching all 892 would more than quadruple the ~270 requests the tree warm already costs, and EIA answers `OVER_RATE_LIMIT` to an unbounded burst on top of that warm — which is why the pass runs through a `ConcurrencyGate` rather than one `Promise.all`. The allowlist resolves to 40 fetches carrying 460 values and 28 KB, about 7 s of wall-clock at concurrency 4.

**Facet value cache:** `eia_describe_route` fans out `Promise.all` calls to `/v2/{route}/facet/{facetId}` (one per facet). Results are merged into the route metadata and cached per-route — key `{route}` → merged metadata object — to avoid repeat fan-out on subsequent describe or query calls. Retry boundary wraps the full fan-out, not individual facet calls, so a single facet 5xx doesn't partially poison the merged result. The cache always holds the **full, uncapped** value set: `EIA_FACET_VALUE_CAP` shapes `eia_describe_route`'s response only, and both its offset paging and the search index read from the uncapped cache.

**Upstream shape variance:** EIA does not honor a single shape for every metadata field. `data` arrives either keyed by column ID or as `{ value: [] }`, and `frequency` is an array on every route in the standard taxonomy but is not contractually one. Both are normalized in `fetchAndCacheMetadata()` before they reach `RouteMetadata`, so a describe call degrades to empty rather than throwing a `TypeError` downstream.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `EIA_API_KEY` | Yes | Free key from api.eia.gov — appended as `api_key` query param on every request |
| `EIA_BASE_URL` | No | Defaults to `https://api.eia.gov/v2`; overridable for testing |
| `CANVAS_PROVIDER_TYPE` | No | Set to `duckdb` to enable DataCanvas spillover and dataframe tools (Node only; Workers fail closed) |
| `EIA_DATASET_TTL_SECONDS` | No | Sliding per-dataframe TTL, passed to the canvas as `ttlMs`. Default `86400` (24 h). The window is extended whenever an `eia_dataframe_query` statement names the dataframe, so a dataframe survives a long analysis and lapses only after going unused for the full interval; listing it with `eia_dataframe_describe` is not use and does not extend it. Independent from the canvas-level TTL. |
| `EIA_DATAFRAME_DROP_ENABLED` | No | Set to `true` to expose `eia_dataframe_drop`. Default `false`; TTL handles cleanup in normal operation. |
| `EIA_CANVAS_MAX_ROWS` | No | Cumulative row ceiling for `eia_query_route` canvas accumulation. Default `25000` — five requests at EIA's 5,000-row-per-request ceiling, ~4 MB of upstream JSON and ~8.5 s of tool latency when it binds. Lower it to keep exploratory calls snappy, raise it for wider staged analyses. |
| `EIA_FACET_VALUE_CAP` | No | Facet values `eia_describe_route` returns per facet before truncating. Default `50` — STEO's `seriesId` alone has 1,469 values, ~130 KB of JSON in one describe call. Paged past with the tool's `facet` and `values_offset` inputs; the per-route cache is unaffected. |

## Implementation Order

1. Config (`src/config/server-config.ts`) — Zod schema for the env vars above, including `EIA_DATASET_TTL_SECONDS` and `EIA_DATAFRAME_DROP_ENABLED`
2. `EiaApiService` — browse, describe, and query methods with retry/timeout; route-tree cache + Fuse.js index
3. `eia_browse_routes` — thin wrapper over service browse method
4. `eia_describe_route` — thin wrapper; error contract for unknown routes
5. `eia_search_routes` — fuzzy search against the in-memory index
6. `eia_query_route` — filters, pagination, DataCanvas spillover (`ctx.core.canvas?`); emit `dataset` (`df_<id>`) on spillover
7. `CanvasBridgeService` (`src/services/canvas-bridge/`) — `df_<id>` minting, provenance tracking, per-table sliding TTL delegated to the canvas, system-catalog deny, contract-recovery remap on query errors
8. `eia_dataframe_describe` / `eia_dataframe_query` — layered on the bridge; describe reconciles provenance against the canvas's live tables
9. `eia_dataframe_drop` — conditional registration in `createApp()` guarded by `EIA_DATAFRAME_DROP_ENABLED`

Each step is independently testable. Tools 3–5 can be built and exercised before DataCanvas integration in step 6. The bridge (step 7) can be tested in isolation before the dataframe tools depend on it.

---

## Tool Detail

### `eia_browse_routes`

Lists child routes at a given path. Root call returns 14 top-level categories. Intermediate paths return subcategories. Leaf routes are flagged so callers know when to switch to `eia_describe_route`. A node is a leaf when its metadata response contains `frequency`/`facets`/`data` fields instead of a `routes` array.

**Input schema:**
- `path?: string` — Route path to browse (e.g. `"electricity"`, `"petroleum/pri"`). Omit for root.

**Output:**
- `path: string` — the path browsed
- `children: Array<{ id, name, description, route, isLeaf }>` — child entries from the API's `routes[]`; `isLeaf` is determined by probing each child: a child is a leaf if its metadata response contains `frequency`/`facets`/`data` fields rather than a nested `routes[]`. Note: this requires one probe call per child to determine leaf status — limit child probing to shallow depth or defer isLeaf detection to `eia_describe_route`.
- `isLeaf: boolean` — true when the path itself is a leaf (nothing to drill into; use `eia_describe_route`)

**Errors:**
- `route_not_found` (`NotFound`) — path doesn't exist in the taxonomy

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `eia_describe_route`

Full schema for a leaf route. Required reading before constructing facet filters.

**Input schema:**
- `route: string` — Leaf route path (e.g. `"electricity/retail-sales"`)
- `facet?: string` — Restrict the response to one facet by ID; pair with `values_offset` to page it
- `values_offset?: number` — Index of the first facet value to return, applied to every facet in the response (default `0`)

**Implementation note:** The EIA v2 API does NOT embed facet values in the route metadata response — they are fetched via separate calls to `/v2/{route}/facet/{facetId}` (one per facet). The service method must fan out these calls in parallel (`Promise.all`) and merge results. Cache the merged metadata per-route in-process to avoid repeat fan-out.

**Output:**
- `route: string`
- `description: string`
- `values_offset: number` — echoes the requested offset, so a reader knows where the returned window starts
- `facets: Array<{ id, description, values: Array<{ id, name, alias }>, value_count, values_truncated }>` — filterable dimensions with a window of their valid values (merged from per-facet calls). `values` is sliced `[values_offset, values_offset + EIA_FACET_VALUE_CAP)`; `value_count` is the untruncated total and `values_truncated` says whether more remain. Restricted to one entry when `facet` is set.
- `data_columns: Array<{ id, alias, units }>` — numeric columns available for the `data[]` param; sourced from the metadata `data` object (keyed by column id, each entry has `alias` and `units`)
- `frequencies: Array<{ id, description, query, format }>` — valid frequency options with their API query codes and period format strings
- `date_range: { start: string, end: string }` — from `startPeriod`/`endPeriod` in the API response
- `default_frequency: string` — the route's default frequency (from `defaultFrequency`)
- `default_date_format: string` — period format for the default frequency (e.g. `"YYYY-MM"`)
- `notice?: string` — an enrichment field (`ctx.enrich.notice`), so it merges into `structuredContent` and renders as a blockquote in the `content[]` trailer. Present when `values_offset` lands past the last value of one or more facets, naming each emptied facet, its `value_count`, and its last valid offset, plus the `facet` input as the escape when one shared offset overshoots a narrow facet while paging a wide one

**One window, both surfaces:** `format()` renders exactly the values the output carries, so a facet's truncation hint names one next call rather than two. `EIA_FACET_VALUE_CAP` is the only bound.

**Alias suppression in `format()` only:** a value renders as `id=name (alias)`, minus the alias when it only restates the pair — EIA's generated `(id) name` form, or `name` on its own. An alias that prefixes a class the pair does not name (`Region: (MAT) Middle Atlantic`) still prints. The `alias` output field carries every alias EIA supplies, unchanged, on both surfaces.

**Overshooting offsets:** `values_offset` applies to every facet in the response, so an offset large enough to page a wide facet empties every narrower one beside it — and an emptied window is shaped exactly like an exhausted enumeration (`values: []`, `values_truncated: false`, a `value_count` that contradicts both). The response carries a `notice` naming each emptied facet and its count instead, matching the notice `eia_query_route` returns for a row offset past `total`.

**Errors:**
- `route_not_found` (`NotFound`) — not a known leaf route; suggest `eia_browse_routes` or `eia_search_routes`
- `route_not_queryable` (`InvalidParams`) — path exists but is a category, not a leaf
- `facet_not_found` (`NotFound`) — the `facet` input names an ID the route does not expose; the error data lists the route's facet IDs
- `rate_limited` (`ServiceUnavailable`, retryable) — EIA rate limit hit during facet fan-out; back off and retry

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `eia_search_routes`

Fuzzy search across the in-memory route index. Useful when the caller doesn't know the route tree structure and wants to resolve natural language ("natural gas spot prices") to a route path.

**Input schema:**
- `query: string` — Free-text search terms
- `limit?: number` — Max results to return (default 10, max 30)

**Output:**
- `results: Array<{ route, name, description, score }>` — ranked matches; `route` is directly usable in `eia_describe_route` or `eia_query_route` if `isLeaf`
- `isLeaf` field per result — callers know whether to browse further or query directly
- `filter_hint` per result, when the entry is a STEO series or a facet value — the filter to pass straight to `eia_query_route`
- `totalIndexed: number` — size of the search index (orientation signal)
- `indexComplete: boolean` and, when false, `indexGaps: string[]` — whether the answer was ranked against the whole corpus, and what is missing when it was not

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `eia_query_route`

Pulls data from a leaf route. Core data retrieval tool — use `eia_describe_route` first to discover valid facets and columns.

**Implementation note:** Data is fetched from `/v2/{route}/data/` (note the `/data/` suffix — the metadata and data endpoints are distinct paths). Query params: `frequency`, `data[]` (columns), `facets[facetId][]`, `start`, `end`, `sort[]`, `offset`, `length` (max 5000 per page). Data values are returned as **strings** (e.g. `"9.13"`, not `9.13`); units for each column appear as inline `{col}-units` fields in each row (e.g. `"price-units": "cents per kilowatt-hour"`).

**Warnings envelope:** EIA returns `warnings` at the **top level** of the payload, a sibling of `response` — `response.warnings` is always `null`. Each entry is `{ warning, description }`, not a string (e.g. `{ "warning": "incomplete return", "description": "The API can only return 5000 rows in JSON format. …" }`). The service reads the top-level array and the tool flattens each surviving entry to `warning: description`.

The `incomplete return` entry is the one EIA sends on every page narrower than `total`, and its 5,000-row text is fixed boilerplate rather than a real ceiling report — it fires at 500 rows of 1,830 as readily as at 25,000 of 113,460. The tool drops it, and only it, on a response that already states where the caller stands: a `notice` explaining a row-less page, or a staged table running from the caller's `offset` to the last row. Any other advisory, and this one whenever staging stopped short, still reaches `truncation_warning` — matching is on the `warning` label, so an entry EIA adds later forwards by default.

**Canvas accumulation:** When a canvas bridge is present and more rows match than the preview holds, the service walks `offset` pages forward from the preview — each page bounded by EIA's 5,000-row-per-request ceiling — and returns the accumulated set separately from the inline preview. The inline `data` array always stays at the caller's `length`; accumulation only widens what reaches the canvas. `EIA_CANVAS_MAX_ROWS` (default 25,000) bounds the cumulative total; when it binds, `canvas_preview_note` names the real staged row count, the cap, and the offset to resume from. Accumulation is best-effort, matching the canvas bridge it feeds: a follow-up page that fails after retries stops staging and keeps the rows already gathered rather than discarding a preview the caller has in hand, and `canvas_preview_note` reports the shortfall and the resume offset without blaming the cap. A caller-side abort still propagates. Requesting a page size above 5,000 is not an upstream error — EIA returns the first 5,000 rows plus a `parameter out of range: length` warning — so the input schema's `.max(5000)` owns that bound and the service carries no redundant guard.

**Input schema:**
- `route: string` — Leaf route path (e.g. `"electricity/retail-sales"`)
- `filters?: Record<string, string | string[]>` — Facet filters keyed by facet ID (e.g. `{ "stateid": "TX", "sectorid": ["RES", "COM"] }`). Facet IDs and valid values discoverable via `eia_describe_route`.
- `columns?: string[]` — Data column IDs to return (reduces payload; defaults to all). Column IDs discoverable via `eia_describe_route`.
- `frequency?: string` — Aggregation frequency ID (e.g. `"monthly"`, `"annual"`, `"quarterly"`). Defaults to route's `defaultFrequency`. Valid IDs returned by `eia_describe_route`.
- `start?: string` — Period start in the route's date format (e.g. `"2020-01"` for monthly, `"2020"` for annual). Format discoverable via `eia_describe_route`.
- `end?: string` — Period end (same format as `start`)
- `sort?: Array<{ column: string; direction: "asc" | "desc" }>` — Result ordering
- `offset?: number` — Row offset into the matching set (default 0); an offset at or beyond `total` returns zero rows
- `length?: number` — Rows in the inline preview (default 100, max 5000). Canvas staging pages past this on its own.

**Output:**
- `route: string`
- `data: Array<Record<string, string | null>>` — preview rows; all numeric values are strings per EIA API (cast in SQL when arithmetic is needed: `CAST(value AS DOUBLE)`)
- `total: number` — total matching rows (parsed from API's string `total` field)
- `returned_count: number` — rows in this response (useful for chaining: when `returned_count < total`, use `offset`/canvas for the rest)
- `frequency: string` — frequency of the returned data
- `date_format: string` — period format for the returned data (e.g. `"YYYY-MM"`)
- `notice?: string` — present when the response carries no rows. Distinguishes the two causes: zero rows matched the filters (broaden the query), or `offset` paged past the last row (reduce `offset` below `total`).
- `dataset?: string` — present when a table was registered. The `df_<id>` handle — pass directly to `eia_dataframe_query` SQL (`SELECT ... FROM df_<id>`). Every dataset a tenant stages lives in one shared canvas, so handles from different routes join by name.
- `canvas_preview_note?: string` — present when `total` exceeds the inline preview. Names how many rows actually reached the canvas table, and where in the matching set they sit whenever the stage starts past row 1 — a staged count alone does not separate a tail from a prefix of the same query. When staging also stopped short of `total` — the `EIA_CANVAS_MAX_ROWS` cap, or an upstream page that didn't return — it says so and gives the offset to resume from.
- `truncation_warning?: string` — forwarded from EIA's top-level `warnings[]`, each surviving entry flattened to `warning: description` and joined with `; `. Absent when the only advisory was the `incomplete return` entry on a response that already accounts for the gap it names (see **Warnings envelope** above).

**Type inference note:** DuckDB infers column types from the first ~100 rows of each registered result. Because all EIA values arrive as strings, the bridge sets the schema explicitly as `VARCHAR` for data columns. SQL consumers that need numeric results must cast: `CAST(value AS DOUBLE)`, `CAST(value AS INTEGER)`. Aggregates (`SUM`, `AVG`) also require an explicit cast since DuckDB will not coerce `VARCHAR` to numeric implicitly.

**Errors:**
- `route_not_found` (`NotFound`) — route doesn't exist in the EIA taxonomy
- `route_not_queryable` (`ValidationError`) — route is a category node with sub-routes, not a queryable leaf. Matches `eia_describe_route`'s reason for the same condition.
- `invalid_facet` (`ValidationError`) — unknown facet key; recovery points at `facets[].id`. Also the fallback when an EIA 400 message doesn't match a known shape.
- `invalid_column` (`ValidationError`) — unknown data column ID; recovery points at `data_columns[].id`
- `invalid_frequency` (`ValidationError`) — unknown frequency code; recovery points at `frequencies[].id`
- `no_data` (`ValidationError`) — inverted date range (`start` after `end`)
- `rate_limited` (`ServiceUnavailable`, retryable) — EIA rate limit hit (OVER_RATE_LIMIT in API response); back off and retry

The three `invalid_*` reasons are split from a single EIA 400 by reading the upstream message, which names the rejected dimension verbatim (`Invalid facet '…'`, `Invalid data '…'`, `Invalid frequency '…'`). A zero-row result is a success with a `notice`, not an error. A `length` above 5,000 is rejected by the input schema as `-32602 InvalidParams` before the handler runs, so it carries no `data.reason`. A 200 response carrying no `response` envelope is an upstream shape failure rather than a caller error, so it bubbles as a bare `ServiceUnavailable` with no `data.reason` instead of borrowing a declared reason whose code and `when` don't fit it.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `eia_dataframe_describe`

Lists canvas dataframes materialized by `eia_query_route` — provenance, expiry, row count, and column schema. Reads the canvas's live table list first and deletes provenance for anything it no longer holds, so the response is always current. Listing is not use: only an `eia_dataframe_query` statement naming a dataframe extends its window, so polling this tool will not keep a dataframe alive.

The handler always lists unscoped and narrows locally, because the full set is what separates the two ways a scoped call can come back empty: `name` names a dataframe that is not staged, versus nothing is staged at all. A miss returns `found: false` alongside `active_names`, mirroring `eia_dataframe_drop`'s `dropped: false`.

**Input schema:**
- `name?: string` — `df_<id>` handle to describe a single dataframe. Omit to list all active dataframes for this tenant.

**Output:**
- `requested_name?: string` — echo of `name`; absent on an unscoped list
- `found?: boolean` — whether `requested_name` is staged; absent on an unscoped list
- `active_names: string[]` — every staged `df_<id>` for this tenant, whatever the requested scope. On a miss these are the handles still usable.
- `dataframes: Array<{ name, source_tool, query_params, created_at, expires_at?, row_count, truncated, max_rows?, column_schema }>` — entries matching the requested scope, newest first. `expires_at` is the canvas's current sliding-TTL value, not a copy taken at creation. `query_params` records every input the source tool was called with, `sort` among them — it decides which rows a stage that stopped short of `total` holds, so two opposite orderings of one query are told apart by it. A parameter the caller omitted is absent rather than present-and-empty, on the rendered params line as well as the structured surface.

**Errors:**
- `canvas_unavailable` (`ServiceUnavailable`) — canvas not configured; set `CANVAS_PROVIDER_TYPE=duckdb`

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`

---

### `eia_dataframe_query`

Single-statement SELECT across canvas dataframes. Standard DuckDB SQL — joins, aggregates, window functions, CTEs all supported. Reference dataframes by the `df_<id>` handles returned by `eia_query_route` or listed by `eia_dataframe_describe`.

**Input schema:**
- `sql: string` — Single-statement SELECT. Data columns from EIA are `VARCHAR` — use `CAST(col AS DOUBLE)` when arithmetic or aggregation is needed.
- `register_as?: string` — Persist the query result as a new `df_<id>` with a fresh expiry. Use to chain analyses without re-running the upstream tool calls. The name must be unused: reusing a staged name fails as `register_as_clash` (`ValidationError`), and the fix is a different name — dropping the existing dataframe is not required and `eia_dataframe_drop` is off by default.
- `preview?: number` — Rows to include in the immediate response (0–10 000). Defaults to `row_limit`. Set lower when chaining via `register_as` and only a sample is needed inline.
- `row_limit?: number` — Hard cap on rows materialized in the response (default 1000, max 10 000). When `register_as` is set, the full result lives on-canvas; raise this only for inline inspection.

**Output:**
- `columns: string[]` — Column names in projection order
- `rows: Array<Record<string, unknown>>` — Materialized rows, bounded by `preview`/`row_limit`
- `registered_as?: string` — New dataframe name when `register_as` was supplied
- `expires_at?: string` — ISO 8601 expiry for the newly registered dataframe

**Enrichment:** `totalRows`, `returnedRows`, `truncated`, `executedSql`, and a `notice` when either cap bound the response.

**Two caps, two disclosures:** `row_limit` and `preview` bound different things, and only one of them leaves rows uncounted. The canvas reads `row_limit + 1` rows; when the extra row exists it returns the first `row_limit` with `truncated: true` and `rowCount = row_limit`, and the remainder is dropped without ever being counted — so `totalRows` is then the cap, a floor on the match count rather than a total. `preview` only slices what is already in hand, leaving `rowCount` exact. `truncated` is therefore read first, and the `rowCount > rows.length` comparison serves the `preview` case alone: under `row_limit` the two are equal, and when both caps apply their difference is the distance from the preview to the cap, not to any total. `register_as` is the retrieval path out of a `row_limit` cap — the result is materialized uncapped and counted with a real `COUNT(*)`, so the follow-up reports `truncated: false` and an exact `totalRows`.

**Read-only enforcement (four layers):**
1. Text-level deny-list — file/HTTP-reading table functions (`read_csv*`, `read_json*`, `read_parquet*`, etc.)
2. Statement count — must be exactly 1
3. Statement type — must be `SELECT`
4. EXPLAIN-plan walk — allowlisted physical operators; denied-function rescan over plan metadata

Bridge-layer additionally denies system catalogs (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*`) — callers cannot enumerate `df_<id>` tables they don't already hold a handle for.

**Errors:**
- `canvas_unavailable` (`ServiceUnavailable`) — canvas not configured; set `CANVAS_PROVIDER_TYPE=duckdb`
- `system_catalog_access` (`ValidationError`) — SQL names a denied catalog; query only `df_<id>` tables
- `missing_table` (`NotFound`) — SQL names a `df_<id>` that is not staged (mistyped, dropped, or past its expiry); list handles with `eia_dataframe_describe` or re-stage with `eia_query_route`
- `non_select_statement` (`ValidationError`) — not a single read-only SELECT; rewrite as one SELECT, or use `register_as` to persist a result
- `invalid_sql` (`ValidationError`) — DuckDB could not parse or bind the statement; correct it against the column names `eia_dataframe_describe` reports, which carry the sanitized `{col}_units` form the inline preview shows hyphenated
- `register_as_clash` (`ValidationError`) — `register_as` names a staged dataframe; pass a different name

Only `canvas_unavailable` is raised in the handler. The other five are thrown by the framework SQL gate and DuckDB provider below `CanvasBridge.query()`, which re-throws them carrying the contract's `recovery` hint — the framework renders a `Recovery:` line into `content[]` from `data.recovery.hint` alone, so a declared recovery reaches the caller only if it is put on the wire there. The upstream throw's code, message, and `data.reason` are preserved.

Reason selection is the gate's, not the tool's, and does not always follow the surface shape of the statement: a `DROP TABLE` naming a table that does not exist fails as `missing_table` at prepare time, before the statement-type check that would have made it `non_select_statement`. Gate reasons left undeclared — `multi_statement`, `denied_function`, `identifier_shape`, `identifier_reserved` — carry the remedy in the framework's own message text.

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`

---

### `eia_dataframe_drop`

Drop a canvas dataframe by name. **Opt-in** — only registered in `createApp()` when `EIA_DATAFRAME_DROP_ENABLED=true`. Idempotent: returns `dropped=false` when nothing matched — including for a dataframe whose window already lapsed, since the canvas is authoritative on existence. Use to free canvas resources ahead of the sliding expiry when an analysis is complete; in normal operation, expiry cleanup is sufficient and this tool is unnecessary.

**Input schema:**
- `name: string` — `df_<id>` handle to drop

**Output:**
- `name: string` — The name that was requested
- `dropped: boolean` — `true` when the dataframe existed and was removed; `false` when nothing matched

**Errors:**
- `canvas_unavailable` (`ServiceUnavailable`) — canvas not configured; set `CANVAS_PROVIDER_TYPE=duckdb`

**Annotations:** `readOnlyHint: false`, `idempotentHint: true`, `destructiveHint: true`, `openWorldHint: false`

---

## Workflow Analysis

### Discovery → Query

| # | Action | Tool |
|:--|:-------|:-----|
| 1 | Identify domain | `eia_browse_routes` (root) |
| 2 | Drill to leaf | `eia_browse_routes` (category path) |
| 3 | Inspect facets | `eia_describe_route` |
| 4 | Pull data | `eia_query_route` (with filters from step 3) |
| 5 | Analyze the staged set | SQL on `dataset` if spillover occurred |

### Fuzzy Discovery → Query

| # | Action | Tool |
|:--|:-------|:-----|
| 1 | Resolve natural language to route | `eia_search_routes` |
| 2 | Confirm facets | `eia_describe_route` |
| 3 | Pull data | `eia_query_route` |

### Multi-Route Canvas Analysis

Addresses the prior "no bulk multi-route queries" limitation. Every dataset a tenant stages lands in the same canvas, so tables from different routes are already cross-joinable by their `df_<id>` names — nothing threads between calls. Pull each route, then use `eia_dataframe_query` to join or compare the handles in a single SQL statement.

| # | Action | Tool | Notes |
|:--|:-------|:-----|:------|
| 1 | Pull electricity retail sales | `eia_query_route` | Returns `dataset` (`df_abc`) |
| 2 | Pull natural gas spot prices | `eia_query_route` | Returns a second `dataset` (`df_xyz`) in the same canvas |
| 3 | Pull petroleum consumption by sector | `eia_query_route` | Returns a third `dataset` (`df_def`) |
| 4 | GROUP BY state / sector / fuel; SUM production by period | `eia_dataframe_query` | `SELECT period, SUM(CAST(value AS DOUBLE)) ... FROM df_abc GROUP BY period ORDER BY period` |
| 5 | JOIN two route results by period | `eia_dataframe_query` | `SELECT a.period, CAST(a.value AS DOUBLE), CAST(b.value AS DOUBLE) FROM df_abc a JOIN df_xyz b ON a.period = b.period` |
| 6 | Persist join result for follow-up | `eia_dataframe_query` | `register_as: "df_joined_energy"` — fresh expiry; chain further aggregates without re-running source queries |
| 7 | Inspect active dataframes | `eia_dataframe_describe` | Verify handles, row counts, expiry |

**Key cast pattern:** EIA data values are `VARCHAR` in the canvas. Any arithmetic or aggregation (`SUM`, `AVG`, arithmetic operators) requires an explicit cast: `CAST(value AS DOUBLE)`. String comparisons and period filtering work on the raw `VARCHAR` columns without casting.

---

## Known Limitations

- **STEO is a single flat leaf, not a subtree**: `steo` is a top-level leaf route with a single `seriesId` facet covering 1,469 named series (e.g. `PATCPUS` for petroleum prices). There are no sub-routes under `steo/`. Discovery works via `eia_describe_route` on `steo` to list the full `seriesId` facet catalog, then filter by `seriesId` in `eia_query_route`. `eia_search_routes` should index these series names for fuzzy matching.
- **Facet value fetch cost**: `eia_describe_route` fans out one HTTP call per facet to `/facet/{id}` — a route with 5 facets costs 6 total requests (1 metadata + 5 facet). Cache merged metadata per-route in-process. STEO's 1,469-value seriesId facet is an especially large payload; consider whether to include all values or paginate the facet list.
- **Data values are strings**: All numeric data from the `/data/` endpoint arrives as strings (e.g. `"9.13"`). Consumers doing arithmetic need to parse. Surfaced in output schema.
- **Route tree currency**: In-process cache is valid for server lifetime. EIA occasionally adds leaf routes between releases; a server restart picks them up.
- **International data granularity**: `international/` routes have coarser facets than domestic routes (country, not state). Fully accessible but sub-national breakdowns aren't available for most countries.
- **No bulk multi-route queries in a single call**: Each `eia_query_route` call targets one leaf route. Cross-route comparisons require multiple tool calls. Every call's result lands in the same per-tenant canvas, though, so `eia_dataframe_query` can JOIN the resulting `df_<id>` handles in a single SQL statement — see "Multi-Route Canvas Analysis" workflow above.
- **Canvas staging is capped**: `eia_query_route` pages up to `EIA_CANVAS_MAX_ROWS` (default 25,000) per call. A route matching more than that stages a bounded prefix, and `canvas_preview_note` names the staged count plus the offset to resume from — narrow the query with facets, `start`, or `end` to fit an analysis inside one staged table.
- **Dataframe tools require `CANVAS_PROVIDER_TYPE=duckdb`**: Node.js only. DuckDB has no V8-isolate build; setting `CANVAS_PROVIDER_TYPE=duckdb` on a Cloudflare Workers deployment fails closed with a `ConfigurationError` at init time. When canvas is absent, `eia_query_route` degrades to preview-only and the three dataframe tools are not available (or return `canvas_unavailable`).
- **Deprecated routes**: `co2-emissions` is deprecated (API response carries a deprecation notice pointing to `seds`). `eia_browse_routes` should surface this notice; `eia_search_routes` may want to down-rank or annotate deprecated routes.

---

## Decisions Log

### Answered questions

- **Pre-index vs. live discovery for search** → In-process cache + Fuse.js warm on first call. Avoids build-time complexity; EIA's discovery endpoints are fast and the tree is small enough (~hundreds of routes) to hold in memory. No file system dependency, no stale index artifact.
- **STEO forecasts: separate tool or fold into `query_route`?** → Fold into `query_route`. STEO is a single flat leaf route (not a subtree) accessed by filtering `seriesId` facet. A dedicated tool would duplicate the query interface with no additional capability. Discovery relies on `eia_describe_route` on `steo` and `eia_search_routes` indexing the 1,469 series names.
- **Facet validation: enumerate at describe time or let EIA reject?** → Enumerate at describe time via `eia_describe_route`. Surfacing valid values in the MCP layer means better error messages and faster iteration — the caller knows what's valid before sending a query, rather than interpreting an opaque EIA 400.
- **DataCanvas spillover: opt-in or always-on?** → Opt-in via `CANVAS_PROVIDER_TYPE=duckdb`. DuckDB has no V8-isolate build, so Workers deployments would break if it were always attempted. Canvas presence checked via `ctx.core.canvas?` at runtime; tool degrades gracefully to preview-only when absent.
- **Resources?** → None. The route tree is dynamic (hundreds of entries, arbitrary depth) — stable URIs don't fit. All data access via tools; tool-only agents are fully served.
- **Why expose dataframe tools at all?** → EIA datasets are multi-dimensional: a single route might return data across states, sectors, fuel types, and periods simultaneously. Inline preview rows (bounded to avoid context overflow) are sufficient for narrow queries but blind for analysis across facet combinations. Canvas SQL lets the agent GROUP, SUM, and JOIN on the full result set without re-fetching upstream data. The three dataframe tools are the analytical complement to `eia_query_route`, not a separate workflow.
- **Why opt-in drop (`EIA_DATAFRAME_DROP_ENABLED`)?** → The sliding per-dataframe TTL (default 24 h, extended by every query that references the dataframe) already handles cleanup for normal usage patterns. An always-on drop tool adds a destructive surface with no benefit in the common case. Opt-in makes the risk explicit — operators who need manual cleanup in long-running sessions enable it deliberately.
- **Why expose `register_as` chaining in `eia_dataframe_query`?** → Derived aggregates (e.g., a JOIN of electricity prices and gas prices, grouped by region and period) are expensive to reconstruct from raw route results. Persisting them as a named dataframe with a fresh expiry lets the agent build incrementally — query once, reuse across follow-up questions in the same session — without re-running N `eia_query_route` calls.
- **How do dataframe tools address the prior "no bulk multi-route queries" limitation?** → They don't remove it at the single-call level (each `eia_query_route` still targets one leaf route), but they provide the join layer that was missing. Call `eia_query_route` N times to stage N result sets — all in the same per-tenant canvas — then use `eia_dataframe_query` to JOIN the `df_<id>` handles.
- **Should callers thread a `canvas_id` between `eia_query_route` calls?** → No, and the parameter was removed. `CanvasBridge.acquireSharedCanvas` routes every registration to one canvas per tenant with no scoping argument, so accumulation was already automatic; the input was echoed back and otherwise ignored, and the output field carried the table name rather than a canvas ID. `dataset` is the genuine join handle and is now the only one documented. Per-call canvas isolation would be the alternative, but nothing in the workflow wants it — cross-route joins are the point.
- **Why cap canvas accumulation at 25,000 rows?** → Registering only the previewed page made the "query canvas for the full dataset" note false, so the service now pages forward. The bound is a latency and memory trade, sized from measurement: EIA caps a request at 5,000 rows, and a 5,000-row page of `electricity/retail-sales` measures ~830 KB and ~1 s round trip. A full 25,000-row accumulation on that route is five requests, ~4 MB of upstream JSON, and ~8.5 s of end-to-end tool latency (upstream fetch plus JSON parse plus DuckDB append). Unbounded accumulation would put a six-figure-row route — retail sales monthly is ~113,000 — well past any reasonable tool latency. `EIA_CANVAS_MAX_ROWS` moves the bound either way: lower it to keep exploratory calls snappy, raise it for wider staged analyses.

- **Sliding dataframe TTL: hand-rolled or the framework primitive?** → The framework's. `RegisterTableOptions.ttlMs` / `QueryOptions.ttlMs` register a per-table window that `CanvasRegistry.touchWithSqlTables` extends for every table name appearing in a query's SQL, and the registry sweeper drops the table when it lapses. The bridge previously stamped its own `expiresAt` into `ctx.state` at registration and never moved it, which made the advertised sliding behavior false: a dataframe queried steadily for hours still died 24 h after creation. Passing `ttlMs` and deleting the parallel bookkeeping (`DataframeMeta.expiresAt`, `sweepExpired()`) makes the documented behavior the real one and removes a clock the server had no reason to own. The one semantic the framework does not offer is a slide on `describe` — `CanvasInstance.describe()` touches the canvas, not the table — so listing a dataframe is documented as not extending it.
- **Where does `describe` get `expires_at` once the canvas owns expiry?** → From `CanvasInstance.describe()`, which annotates each `TableInfo` with the table's current per-table expiry. Caching it back into `ctx.state` was declined: the value moves on every query, so a stored copy is stale by construction — the same defect the sliding-TTL fix removed. The same call doubles as the reconciliation pass that deletes provenance for tables the canvas no longer holds, which is what replaced `sweepExpired()`.
- **Fixing the dead-letter recovery hints: upstream or server-side?** → Server-side, at `CanvasBridge.query()`. The framework's SQL gate and DuckDB provider throw with a stable `data.reason` but render a `Recovery:` line only from `data.recovery.hint`, so a tool's declared `recovery` never reaches the caller on its own. The bridge re-throws with the calling definition's hint merged in, keyed off `ctx.recoveryFor(reason)` — which returns `{}` for undeclared reasons, so the tool's `errors[]` is the only place the remapped set is written down. Waiting on the upstream wording fix was declined: it covers the gate's throw sites and two `missing_table` hints, not `register_as_clash`, so it would not close the gap even once released.

- **Why cap facet values in `eia_describe_route` at 50?** → The uncapped response returned every value of every facet: `eia_describe_route("steo")` alone shipped all 1,469 `seriesId` values, ~130 KB of JSON, on every call. The cap is a response-shaping step at the tool boundary, not a cache change — the per-route metadata cache still holds the full set, which is what `values_offset` pages through and what the search index reads. 50 clears most ordinary dimensions in one call — sectors run to 15, fuel types to 45 — while bounding the pathological ones; a 62-value `stateid` costs one extra page.
- **Should `content[]` render fewer facet values than `structuredContent` carries?** → No, and the five-value prose preview that did was removed. A second, tighter bound on one surface split the two readers without bounding anything the cap had not: enumerating `international`'s 268-value `countryRegionId` took 6 calls through `structuredContent` and 54 through `content[]`, and each surface named a different offset to resume from. `format()` now renders the window the output carries. Fifty `id=name` pairs is a long line, which is the cost accepted for one bound and one next call.
- **Which facet-value aliases are worth rendering?** → Only the ones that are not the `id=name` pair over again. Surveyed across all 892 facets in the taxonomy, every alias EIA supplies is one of three shapes: the generated `(id) name` string (244 distinct triples), `name` on its own (3), or that same pair behind a class prefix the pair does not name — `Region:`, `Total:`, and the balancing-authority codes (122). The first two are dropped from the rendered line; the third prints, because the prefix is the only thing the alias adds and losing it would merge a census region into the state codes beside it. The match is therefore whole-string against the reconstructed pair: every informative alias *contains* the restating one, so a substring test would drop precisely the aliases worth keeping. Measured on live routes, dropping the restatements takes `electricity/retail-sales`'s 50-value `stateid` line from 1,971 to 1,325 characters and `electricity/rto/region-data`'s `respondent` from 4,026 to 2,184, with all 30 informative aliases in that sample preserved verbatim. `alias` stays on the output field either way — this is a rendering rule, not a filter.
- **Empty facet window past the end: error or notice?** → Notice, matching `eia_query_route`'s answer for a row offset past `total`. Failing with a `facet_not_found`-style error was the alternative and was declined: the facet exists and the offset is well-formed, so the call is a success that returned nothing, and a shared `values_offset` legitimately overshoots a narrow facet while paging a wide one in the same response — that is a partial result, not a bad request.
- **How do facet values get into the search index without an eager fan-out?** → An allowlisted vocabulary pass at warm time plus opportunistic indexing of every described route. Fetching all 892 facets in the taxonomy was measured and ruled out: it would more than quadruple the ~270 requests the tree warm already costs and draws `OVER_RATE_LIMIT` when burst. The allowlist covers the fuel / sector / technology / coal-rank dimensions callers actually search with and resolves to 40 fetches, 460 values, 28 KB.
- **Should a search served mid-warm say so, or wait?** → Wait, and report the outcome either way. Flagging a partial answer was the cheaper option and was declined: the failure mode is not the empty result set but the plausible one, where a facet entry that would have scored ~0.0 and taken the top slot is simply not in the index yet, and a mediocre hit fills the slot instead. Nothing in that response looks wrong, so a flag the caller has to act on is a flag the caller will not act on. `search()` therefore awaits both index passes, and `indexComplete` / `indexGaps` report whether the corpus was whole when the answer was computed — which now also covers a route the tree build could not fetch. The cost is real and is the reason the decision is close: measured cold against the live API over seven runs, the first search takes 24.3–29.4 s instead of returning a wrong answer at ~10 s. Every subsequent search is 20–50 ms. Most of that wait is the tree, not the passes it added — 18.4–23.8 s to build the tree at `TREE_BUILD_CONCURRENCY`, then 4.9–10.9 s for STEO and vocabulary — so bounding the wait short enough to matter would mean answering before the tree exists, over an empty index. The wait is capped instead at a ceiling that only a degraded upstream reaches; see the warm-milestones section above.
- **Why not warm eagerly at startup instead, so nobody waits?** → It would fire ~310 requests on every server start whether or not anyone uses the search tools, and stdio servers are spawned per session — several starting at once is exactly the burst pattern EIA rate-limits. The wait stays on the caller who asked for a search.
- **Why is a failed node's stub not just treated as a leaf?** → Because it is indistinguishable from one. The stub the parent advertised carries only `id` and `name` — no `routes`, `facets`, or `data` — which is the same shape a genuine flat leaf like `steo` has, so `isLeafNode` said "leaf" and the node's real children were never discovered. Measured across five cold warms of the live taxonomy, that silently cost up to 3 of 258 route nodes on one run in five, with nothing logged. An explicit `incomplete` flag separates "we know this is a leaf" from "we never found out", which is what lets the leaf/category pre-flight step aside and the repair path exist.
- **Should a `row_limit`-capped dataframe query report a true total?** → It reports the cap and says so, rather than spending a second round trip to count. The canvas stops reading at `row_limit + 1`, so the true match count is not knowable from the capped result at any price short of a `COUNT(*)` the caller did not ask for — and a total that costs a second full scan on every capped query is the wrong default when the caller may only have wanted the first page. What the response owes is the fact of the cap and a way past it: `truncated` states that rows were dropped, `totalRows` is documented as the cap it is, and `register_as` materializes the whole result uncapped with an exact count. The alternative — inferring truncation from `rowCount > rows.length` — cannot see this cap at all, because the provider sets `rowCount` to the cap.
- **Did adding facet values to the index require re-calibrating `WEAK_MATCH_SCORE`?** → No, and this is a property of Fuse rather than luck: it scores each entry against the pattern independently, so appending entries under an unchanged key/weight config leaves every existing score byte-identical. Measured across 31 on- and off-target queries, drift was exactly zero, and separation held — worst on-target top score 0.875, best off-target top score 0.947, with the 0.9 threshold between them. What *would* move the scale is editing `FUSE_OPTIONS`; see the option declined below.

### Options declined

- **Build-time pre-indexed search file** → Adds a build artifact, requires regeneration on EIA updates, and complicates deployment. In-memory lazy cache is simpler and adequate for the dataset size.
- **Dedicated `eia_forecast` or `eia_steo` tool** → Redundant with `eia_query_route` targeting the `steo` leaf route via `seriesId` facet. Adds surface complexity for no capability gain.
- **App tools / resources for route browsing** → Route tree is dynamic and session-state-free; a resource URI can't capture arbitrary browse position. Standard tools handle the workflow cleanly.
- **Per-route facet cache with invalidation logic** → The facet cache is write-once per process lifetime (no TTL, no ETag-based invalidation). EIA facet catalogs are stable and not versioned in API responses; a server restart is the appropriate refresh mechanism. Adding cache invalidation would add complexity with no practical benefit.
- **`eia_compare_routes` multi-route query tool** → Agents can call `eia_query_route` N times. A cross-route join tool adds significant complexity (schema reconciliation, unit mismatch handling) for a workflow the agent can orchestrate itself via canvas SQL.
- **A separate `FUSE_OPTIONS` weight tier for facet-value entries** → Measured as unnecessary and actively harmful. Route entries already outrank their own facet values on route-shaped queries ("electricity retail sales by state" → the route at 0.731, its `sectorid` values at 0.800), so the tier has nothing to fix; and because Fuse normalizes key weights against each other, adding a key shifts every entry's score at once and invalidates the weak-match threshold. Same reason `ignoreLocation: true` was declined: it improves multi-term matching against long descriptions, but it drops the top no-match score from 0.947 to 0.883 — under the threshold — so genuine noise stops being flagged weak. It is also not the fix for `electricity price residential`: with the option on, `electricity/retail-sales` still never enters the candidate set (130 candidates instead of 38, STEO-only at the top), so all the option moves is the score of series that were already leading.
- **Halving `TREE_BUILD_CONCURRENCY` to 4 to clear the remaining rate-limit misses** → Measured and rejected. At 8 the tree lands all 258 nodes on every cold start; at 4 it also lands 258, but the warm takes ~33–39 s instead of ~24–29 s, and the residual `aeo/*` / `ieo/*` metadata misses persisted at both settings. Those come from EIA's short-window burst limit, which more in-flight requests aggravate and fewer do not fix — the serial second pass clears them for the cost of one request each, and only when there are any.
- **Truncation hints as a per-facet `structuredContent` field** → A call string on the facet object would be a second copy of what the response already determines. `format()` must render every output field (the `format-parity` linter rule), so the string would print beside the hint `format()` composes from the window it just rendered — one call named in two places, and two places to keep in sync. `structuredContent` carries `value_count`, `values_truncated`, and `values_offset` instead, from which the next call follows directly.

### Verified against live API (2026-05-21)

- **Route tree structure:** `GET /v2/` returns `routes[]` with `{id, name, description}` — 14 top-level entries (coal, crude-oil-imports, electricity, international, natural-gas, nuclear-outages, petroleum, seds, steo, densified-biomass, total-energy, aeo, ieo, co2-emissions). Browsing is a live tree-walk — there is no single "get all routes" batch endpoint; the implementation must walk the tree recursively.
- **Leaf detection:** A node is a leaf when its metadata response contains `frequency`/`facets`/`data` fields rather than a `routes[]` array.
- **Facet values require separate calls:** Route metadata (`GET /v2/{route}/`) returns facets as `[{id, description}]` only — no values. Valid facet values require `GET /v2/{route}/facet/{facetId}`, which returns `{totalFacets, facets: [{id, name, alias}]}`. The design's prior claim that values were embedded in route metadata was incorrect.
- **Data columns format:** Route metadata `data` field is an object keyed by column ID: `{colId: {alias, units}}` — not an array. Design output schema updated accordingly.
- **Date range fields:** `startPeriod`/`endPeriod` (not `start`/`end`). Also includes `defaultDateFormat` and `defaultFrequency`.
- **Data endpoint:** `/v2/{route}/data/` (separate from the metadata path). Accepts `frequency`, `data[]`, `facets[facetId][]`, `start`, `end`, `sort[]`, `offset`, `length`. Max `length` = 5000. Response includes `total` (string) and a `warnings[]` array when results are truncated server-side.
- **Data values are strings:** All numeric values in `data[]` rows are strings (e.g. `"9.13"`). Per-column units appear as `{col}-units` fields inline in each row.
- **STEO structure:** `steo` is a top-level leaf (not a subtree). Has one facet: `seriesId` with 1,469 values. Queried directly with `seriesId` filters; no sub-routes exist.
- **Rate limits are real:** DEMO_KEY hits rate limits after a few calls. Production keys are more generous but limits apply — in-process caching of route tree and facet values is essential, not optional.
