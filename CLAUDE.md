# Agent Protocol

**Server:** @cyanheads/eia-energy-mcp-server
**Version:** 0.3.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.11.0`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getEiaApiService } from '@/services/eia/eia-service.js';

export const browseRoutes = tool('eia_browse_routes', {
  description: 'Lists child routes under a given path in the EIA dataset taxonomy.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    path: z.string().optional().describe('Route path to browse (e.g. "electricity"). Omit for root.'),
  }),

  output: z.object({
    path: z.string().describe('The path browsed'),
    children: z.array(z.object({
      id: z.string().describe('Route segment ID'),
      name: z.string().describe('Human-readable name'),
      description: z.string().describe('Route description'),
      route: z.string().describe('Full route path'),
      isLeaf: z.boolean().describe('True when this child is a queryable leaf route'),
    })).describe('Child entries'),
    isLeaf: z.boolean().describe('True when the browsed path itself is a leaf route'),
  }),

  errors: [
    { reason: 'route_not_found', code: JsonRpcErrorCode.NotFound,
      when: 'Path does not exist in the EIA taxonomy',
      recovery: 'Call eia_browse_routes without a path to see valid top-level categories.' },
  ],

  async handler(input, ctx) {
    ctx.log.info('Executing eia_browse_routes', { path: input.path });
    const result = await getEiaApiService().browse(input.path);
    return result;
  },

  format: (result) => [{
    type: 'text',
    text: result.children.map(c => `${c.isLeaf ? '[leaf]' : '[cat]'} ${c.route} — ${c.name}`).join('\n'),
  }],
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z.string().describe('EIA API key'),
  baseUrl: z.string().url().default('https://api.eia.gov/v2').describe('EIA API base URL'),
  datasetTtlSeconds: z.coerce.number().int().positive().default(86400)
    .describe('Per-table TTL for canvas dataframes in seconds (default 24 h)'),
  dataframeDropEnabled: z.preprocess((v) => v === 'true' || v === true, z.boolean())
    .default(false).describe('Expose eia_dataframe_drop when true'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'EIA_API_KEY',
    baseUrl: 'EIA_BASE_URL',
    datasetTtlSeconds: 'EIA_DATASET_TTL_SECONDS',
    dataframeDropEnabled: 'EIA_DATAFRAME_DROP_ENABLED',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so validation errors name the actual variable (`EIA_API_KEY` is required) rather than the internal path.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.getMany(keys)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.recoveryFor(reason)` | Typed lookup of the contract `recovery` for a declared reason. Spread into `ctx.fail` data to mirror the contract hint into `content[]`. |
| `ctx.elicit` | Ask user for structured input — form call `(message, schema)` or `.url(message, url)` for an external link. **Check for presence first:** `if (ctx.elicit) { ... }` |
| `ctx.enrich` | Success-path agent context (empty-result notices, query echo, pagination totals) — `ctx.enrich(...)` or `.notice()` / `.total()` / `.echo()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block (no-op otherwise). |
| `ctx.content` | Non-text content blocks — `.image(data, mimeType)`, `.audio(data, mimeType)`, or `ctx.content(block)` for a raw block. Prepended to `content[]` after `format()`; never enters `structuredContent`. |
| `ctx.progress` | Task progress (present when `task: true`) — `.setTotal(n)`, `.increment()`, `.update(message)`. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT, `'default'` for stdio or HTTP+`MCP_AUTH_MODE=none`. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. Pass `ctx.recoveryFor('reason')` as the throw's data to put it on the wire (`data.recovery.hint`, mirrored into `content[]` text); override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
errors: [
  { reason: 'route_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'Route does not exist in the EIA taxonomy',
    recovery: 'Call eia_browse_routes without a path to see top-level categories.' },
  { reason: 'rate_limited', code: JsonRpcErrorCode.ServiceUnavailable,
    retryable: true,
    when: 'EIA rate limit exceeded',
    recovery: 'Back off and retry; use a production API key for higher limits.' },
],
async handler(input, ctx) {
  const result = await getEiaApiService().query(input.route, input.filters);
  if (!result) throw ctx.fail('route_not_found', `Route ${input.route} not found`);
  return result;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Route not found', { route });
throw serviceUnavailable('EIA rate limit hit', { route }, { cause: err });
```

For HTTP responses, use `httpErrorFromResponse(response, { service, data })` from `/utils` — covers the full 4xx/5xx → `JsonRpcErrorCode` table.

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # EIA-specific env vars (Zod schema)
  services/
    eia/
      eia-service.ts                    # EIA API v2 service (init/accessor + HTTP client)
      route-cache.ts                    # In-process route tree cache + Fuse.js index
      types.ts                          # EIA domain types
    canvas-bridge/
      canvas-bridge.ts                  # DataCanvas bridge (register/describe/query/drop)
  mcp-server/
    tools/definitions/
      browse-routes.tool.ts             # eia_browse_routes
      describe-route.tool.ts            # eia_describe_route
      search-routes.tool.ts             # eia_search_routes
      query-route.tool.ts               # eia_query_route
      dataframe-describe.tool.ts        # eia_dataframe_describe
      dataframe-query.tool.ts           # eia_dataframe_query
      dataframe-drop.tool.ts            # eia_dataframe_drop (opt-in)
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `browse-routes.tool.ts` |
| Tool/resource/prompt names | snake_case | `eia_browse_routes` |
| Directories | kebab-case | `src/services/eia/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Browse the EIA dataset taxonomy.'` |

---

## EIA-Specific Conventions

**Two-phase workflow:** Discovery (`eia_browse_routes` / `eia_search_routes` → `eia_describe_route`) must precede data retrieval (`eia_query_route`). Facet IDs and valid values are not embedded in route metadata — they require separate `GET /v2/{route}/facet/{facetId}` calls. Always describe the route before querying it.

**In-process caches:**
- Route tree: fetched lazily on first `eia_browse_routes` / `eia_search_routes` call; cached for server lifetime. STEO's 1,469 `seriesId` values are included in the Fuse.js index.
- Facet metadata: per-route cache keyed by route path; populated by `eia_describe_route` via fan-out (`Promise.all` over all facets). Reused by subsequent describe and query calls.

**STEO:** `steo` is a flat leaf (no sub-routes) with one facet: `seriesId` covering 1,469 named series. Query it via `eia_query_route` with `seriesId` filter. Discovery via `eia_search_routes` (series names are indexed).

**Data values are strings:** All numeric data from `/v2/{route}/data/` arrives as strings (e.g. `"9.13"`). Per-column units appear as `{col}-units` fields inline in each row. Surfaces in output schema — do not coerce silently.

**Retry / rate limits:** Wrap fetch + parse in `withRetry`. DEMO_KEY hits limits quickly; production keys have higher caps. Detect EIA's `OVER_RATE_LIMIT` response and classify as `ServiceUnavailable` (retryable).

**DataCanvas:** Opt-in via `CANVAS_PROVIDER_TYPE=duckdb`. Check `ctx.core.canvas?` at runtime; degrade gracefully to preview-only when absent. When total > length, `EiaApiService.query()` walks `offset` pages past the inline preview — each capped at EIA's 5,000-row-per-request ceiling, the cumulative set capped at `EIA_CANVAS_MAX_ROWS` (default 25,000) — and the accumulated rows register as a `df_<id>` table returned in `dataset`. The inline preview stays at the caller's `length`. There is no `canvas_id`: `acquireSharedCanvas` routes every registration to one canvas per tenant, so tables cross-join by name with nothing to thread. Column names are sanitized to the canvas identifier shape before registration — EIA's hyphenated `{col}-units` companions become `{col}_units` in the staged table (the inline preview keeps the hyphenated names); query the sanitized names, which `eia_dataframe_describe` reports.

**EIA warnings:** returned at the TOP level of the data payload, a sibling of `response` — `response.warnings` is always null. Each entry is `{ warning, description }`, not a string.

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |
| `api-mirror` | MirrorService: persistent, self-refreshing local mirror of bulk upstream datasets via embedded SQLite + FTS5 |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-05-21`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, re-audit. Use when `devcheck` flags a transitive advisory — stale lockfile can mask already-patched deps. If advisory survives, it's real. |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run lint:mcp` | Validate MCP definitions against spec |
| `bun run lint:packaging` | Validate env var alignment between `manifest.json` and `server.json` |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from per-version files |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run list-skills` | List available local skills (useful for sub-agents) |
| `bun run release:github` | Create (or repair) a GitHub Release on the current annotated tag |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. This server uses DataCanvas, so that second class matters — `@duckdb/node-api` is an optional peer loaded lazily, and the bundle ships portable without the DuckDB native: canvas tools report an actionable install hint and every other tool works normally. MCPB is stdio-only — HTTP deployments are unaffected. Delete `manifest.json` and `.mcpbignore` if not needed; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (`environmentVariables[]`) and `manifest.json` (`mcp_config.env`). `lint:packaging` (run by `devcheck`) verifies the names match.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getEiaApiService } from '@/services/eia/eia-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] EIA wrapping: raw/domain/output schemas reviewed against real upstream sparsity/nullability; data values are strings — do not coerce silently
- [ ] EIA wrapping: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] EIA wrapping: tests include at least one sparse payload case with omitted upstream fields
- [ ] Route tree and facet caches populated before use; retry/rate-limit contract declared on each tool
- [ ] DataCanvas spillover via `getCanvas()` accessor — graceful degradation when absent
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` and `getEnrichment(ctx)` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
