/**
 * @fileoverview Adapter between EIA tools and the framework DataCanvas
 * primitive. Mints df_<id> table handles, sanitizes column identifiers to the
 * canvas identifier shape (EIA's {col}-units companion columns carry a hyphen
 * the gate rejects), derives all-nullable column schemas (EIA data values are
 * all strings), and tracks provenance in ctx.state. Expiry is the canvas's:
 * every table is registered with the framework's per-table sliding TTL, which
 * the canvas extends whenever a query references the table and whose sweeper
 * drops it once the window lapses. Every path that reads or writes provenance
 * first reconciles it against the canvas's live table list, so an entry never
 * outlives the table it describes. Errors thrown below `query()` are re-thrown
 * carrying the calling tool's declared recovery hint.
 * Best-effort registration: a failed canvas registration logs a warning and
 * returns undefined so the caller's inline response remains useful.
 * @module services/canvas-bridge/canvas-bridge
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  type CanvasInstance,
  type ColumnSchema,
  type DataCanvas,
  inferSchemaFromRows,
  type QueryResult,
} from '@cyanheads/mcp-ts-core/canvas';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

/**
 * Per-table provenance persisted in ctx.state. Expiry is deliberately absent:
 * the canvas owns the sliding per-table TTL and reports the current value on
 * `describe`, so a stored copy would go stale the moment a query slid it.
 */
export interface DataframeMeta {
  columnSchema: ColumnSchema[];
  createdAt: string;
  maxRows: number | undefined;
  queryParams: Record<string, unknown>;
  rowCount: number;
  sourceTool: string;
  tableName: string;
  truncated: boolean;
}

/** Stored provenance joined with the canvas's live per-table expiry. */
export interface DataframeEntry extends DataframeMeta {
  /**
   * ISO 8601 expiry reported by the canvas for this table's sliding TTL.
   * Undefined when the table carries no independent expiry and follows the
   * canvas lifecycle instead.
   */
  expiresAt: string | undefined;
}

export interface RegisterDataframeResult {
  columnSchema: ColumnSchema[];
  expiresAt: string;
  rowCount: number;
  tableName: string;
}

export interface RegisterDataframeOptions {
  maxRows?: number;
  queryParams: Record<string, unknown>;
  rows: Record<string, unknown>[];
  sourceTool: string;
  truncated?: boolean;
}

export interface BridgeQueryOptions {
  preview?: number;
  queryParams?: Record<string, unknown>;
  registerAs?: string;
  rowLimit?: number;
  sourceTool?: string;
}

const META_PREFIX = 'eia-df-meta/';
const CANVAS_ID_KEY = 'eia-canvas-id';
const TABLE_NAME_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Derive an all-nullable column schema from a row sample. EIA data values are
 * all strings (VARCHAR). Forcing nullable=true prevents DuckDB appender
 * rollbacks when sparse columns carry nulls past the sniff window.
 */
export function deriveAllNullableSchema(rows: Record<string, unknown>[]): ColumnSchema[] {
  return inferSchemaFromRows(rows).map((col) => ({ ...col, nullable: true }));
}

/**
 * Sanitize a column name to the canvas identifier shape
 * (`/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`). EIA emits paired `{col}` / `{col}-units`
 * companion columns; the framework's canvas identifier gate rejects the hyphen
 * (`reason: 'identifier_shape'`). Characters outside `[A-Za-z0-9_]` become
 * underscores, a leading non-letter/underscore gets an underscore prefix, and
 * the result is capped at the 63-char identifier limit.
 */
export function sanitizeColumnName(name: string): string {
  const replaced = name.replace(/[^A-Za-z0-9_]/g, '_');
  const prefixed = /^[A-Za-z_]/.test(replaced) ? replaced : `_${replaced}`;
  return prefixed.slice(0, 63);
}

/**
 * Remap row keys to canvas-safe column identifiers, returning new row objects so
 * the caller's inline preview keeps the original `{col}-units` keys for display.
 * The original→safe map is built once from the union of all row keys, so the
 * DuckDB appender — which reads `row[col.name]` per schema column — finds every
 * value even when a column is sparse; collisions (two source columns sanitizing
 * to the same identifier) are disambiguated with a numeric suffix.
 */
export function sanitizeRowsForCanvas(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const renameMap = new Map<string, string>();
  const used = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (renameMap.has(key)) continue;
      let safe = sanitizeColumnName(key);
      if (used.has(safe)) {
        let suffix = 2;
        while (used.has(`${safe}_${suffix}`)) suffix++;
        safe = `${safe}_${suffix}`;
      }
      used.add(safe);
      renameMap.set(key, safe);
    }
  }

  return rows.map((row) => {
    const remapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      remapped[renameMap.get(key) ?? key] = value;
    }
    return remapped;
  });
}

/**
 * Re-throw a framework canvas error carrying the calling definition's declared
 * recovery hint. The SQL gate and the DuckDB provider throw below the bridge
 * with a stable `data.reason` but either no `data.recovery` at all
 * (`system_catalog_access`, `non_select_statement`, `register_as_clash`) or one
 * naming framework methods an MCP client cannot invoke (`missing_table`). The
 * `Recovery:` line the framework renders into `content[]` is read from
 * `data.recovery.hint` and never from the contract, so a declared `recovery`
 * reaches the caller only if it is put on the wire here. Reasons the calling
 * definition does not declare pass through untouched — `ctx.recoveryFor`
 * returns `{}` for them — so the tool's `errors[]` is the single place the set
 * of remapped reasons is written down.
 */
function withContractRecovery(ctx: Context, error: unknown): unknown {
  if (!(error instanceof McpError)) return error;
  const reason = error.data?.reason;
  if (typeof reason !== 'string') return error;
  const recovery = ctx.recoveryFor(reason);
  if (!('recovery' in recovery)) return error;
  return new McpError(error.code, error.message, { ...error.data, ...recovery }, { cause: error });
}

export class CanvasBridge {
  constructor(private readonly canvas: DataCanvas) {}

  async registerDataframe(
    ctx: Context,
    options: RegisterDataframeOptions,
  ): Promise<RegisterDataframeResult | undefined> {
    if (options.rows.length === 0) {
      ctx.log.debug('Skipping dataframe registration — no rows', {
        sourceTool: options.sourceTool,
      });
      return;
    }

    try {
      const instance = await this.acquireSharedCanvas(ctx);
      await this.reconcile(ctx, instance);
      const tableName = this.mintTableName();
      // EIA's {col}-units companion columns carry a hyphen the canvas identifier
      // gate rejects; sanitize keys before registration. options.rows (the
      // caller's inline preview) keeps the original names.
      const safeRows = sanitizeRowsForCanvas(options.rows);
      const schema = deriveAllNullableSchema(safeRows);

      const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
      const result = await instance.registerTable(tableName, safeRows, { schema, ttlMs });

      const now = Date.now();
      const meta: DataframeMeta = {
        tableName: result.tableName,
        sourceTool: options.sourceTool,
        queryParams: options.queryParams,
        createdAt: new Date(now).toISOString(),
        rowCount: result.rowCount,
        truncated: options.truncated ?? false,
        maxRows: options.maxRows,
        columnSchema: schema,
      };
      await ctx.state.set(`${META_PREFIX}${result.tableName}`, meta);

      ctx.log.info('EIA dataframe registered', {
        tableName: result.tableName,
        rowCount: result.rowCount,
        sourceTool: options.sourceTool,
      });

      return {
        tableName: result.tableName,
        rowCount: result.rowCount,
        // Exact at this instant — the canvas started the sliding window on the
        // registerTable call above. Later queries push it out; describe reports
        // the current value.
        expiresAt: new Date(now + ttlMs).toISOString(),
        columnSchema: schema,
      };
    } catch (error) {
      ctx.log.warning('EIA dataframe registration failed', {
        error: error instanceof Error ? error.message : String(error),
        sourceTool: options.sourceTool,
      });
      return;
    }
  }

  /**
   * Every dataframe staged for this tenant, newest first, each carrying the
   * canvas's current expiry.
   */
  async describe(ctx: Context): Promise<DataframeEntry[]> {
    const instance = await this.acquireSharedCanvas(ctx);
    const entries = await this.reconcile(ctx, instance);
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async query(
    ctx: Context,
    sql: string,
    options: BridgeQueryOptions = {},
  ): Promise<{ result: QueryResult; meta?: DataframeEntry }> {
    const instance = await this.acquireSharedCanvas(ctx);
    const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
    // Only the register_as branch writes provenance; a plain SELECT skips the
    // reconciliation pass so the analytical path stays a single canvas round trip.
    if (options.registerAs !== undefined) await this.reconcile(ctx, instance);

    let result: QueryResult;
    try {
      result = await instance.query(sql, {
        denySystemCatalogs: true,
        ...(options.preview !== undefined && { preview: options.preview }),
        ...(options.rowLimit !== undefined && { rowLimit: options.rowLimit }),
        ...(options.registerAs !== undefined && { registerAs: options.registerAs, ttlMs }),
        signal: ctx.signal,
      });
    } catch (error) {
      throw withContractRecovery(ctx, error);
    }

    const registerAs = options.registerAs;
    if (!registerAs || !result.tableName) return { result };

    const now = Date.now();
    const meta: DataframeMeta = {
      tableName: result.tableName,
      sourceTool: options.sourceTool ?? 'eia_dataframe_query',
      queryParams: options.queryParams ?? { sql },
      createdAt: new Date(now).toISOString(),
      rowCount: result.rowCount,
      truncated: false,
      maxRows: undefined,
      columnSchema: result.columns.map((name) => ({
        name,
        type: 'VARCHAR',
        nullable: true,
      })),
    };
    await ctx.state.set(`${META_PREFIX}${result.tableName}`, meta);

    return { result, meta: { ...meta, expiresAt: new Date(now + ttlMs).toISOString() } };
  }

  /**
   * Drop a table and its provenance. The canvas is authoritative on whether
   * anything was removed; the stored-provenance answer is the fallback only
   * when the canvas itself is unreachable.
   */
  async drop(ctx: Context, tableName: string): Promise<boolean> {
    const metaKey = `${META_PREFIX}${tableName}`;
    const hadMeta = (await ctx.state.get(metaKey)) !== null;
    await ctx.state.delete(metaKey);

    try {
      const instance = await this.acquireSharedCanvas(ctx);
      return await instance.drop(tableName);
    } catch (error) {
      ctx.log.warning('Canvas drop failed', {
        tableName,
        error: error instanceof Error ? error.message : String(error),
      });
      return hadMeta;
    }
  }

  /**
   * Delete provenance for tables the canvas no longer holds — swept at the end
   * of a sliding window, dropped, or lost with a recycled canvas — and return
   * the survivors joined with the canvas's current per-table expiry. Runs on
   * every path that reads or writes provenance, not just the listing path: the
   * canvas sweeper removes tables without telling the bridge, so a caller who
   * only stages and queries would otherwise accumulate provenance for tables
   * that stopped existing hours ago.
   */
  private async reconcile(ctx: Context, instance: CanvasInstance): Promise<DataframeEntry[]> {
    const expiryByTable = new Map(
      (await instance.describe()).map((table) => [table.name, table.expiresAt]),
    );

    const entries: DataframeEntry[] = [];
    for await (const { key, meta } of this.iterateMeta(ctx)) {
      if (!expiryByTable.has(meta.tableName)) {
        await ctx.state.delete(key);
        ctx.log.debug('Dropped provenance for a dataframe the canvas no longer holds', {
          tableName: meta.tableName,
        });
        continue;
      }
      entries.push({ ...meta, expiresAt: expiryByTable.get(meta.tableName) });
    }
    return entries;
  }

  private async *iterateMeta(ctx: Context): AsyncGenerator<{ key: string; meta: DataframeMeta }> {
    let cursor: string | undefined;
    do {
      const page = await ctx.state.list(META_PREFIX, {
        ...(cursor !== undefined && { cursor }),
        limit: 100,
      });
      for (const item of page.items) {
        if (item.value) yield { key: item.key, meta: item.value as DataframeMeta };
      }
      cursor = page.cursor;
    } while (cursor);
  }

  private async acquireSharedCanvas(ctx: Context): Promise<CanvasInstance> {
    const stored = await ctx.state.get<string>(CANVAS_ID_KEY);
    if (stored) {
      try {
        return await this.canvas.acquire(stored, ctx);
      } catch {
        await ctx.state.delete(CANVAS_ID_KEY);
      }
    }
    const instance = await this.canvas.acquire(undefined, ctx);
    await ctx.state.set(CANVAS_ID_KEY, instance.canvasId);
    return instance;
  }

  private mintTableName(): string {
    const left = idGenerator.generateRandomString(5, TABLE_NAME_CHARSET);
    const right = idGenerator.generateRandomString(5, TABLE_NAME_CHARSET);
    return `df_${left}_${right}`;
  }
}

let _bridge: CanvasBridge | undefined;

export function initCanvasBridge(canvas: DataCanvas | undefined): void {
  _bridge = canvas ? new CanvasBridge(canvas) : undefined;
}

export function getCanvasBridge(): CanvasBridge | undefined {
  return _bridge;
}

export function _resetCanvasBridge(): void {
  _bridge = undefined;
}
