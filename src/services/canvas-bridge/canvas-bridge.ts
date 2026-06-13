/**
 * @fileoverview Adapter between EIA tools and the framework DataCanvas
 * primitive. Mints df_<id> table handles, sanitizes column identifiers to the
 * canvas identifier shape (EIA's {col}-units companion columns carry a hyphen
 * the gate rejects), derives all-nullable column schemas (EIA data values are
 * all strings), tracks per-table TTL and provenance in ctx.state, and
 * lazy-sweeps expired tables on every public operation.
 * Best-effort: failed canvas operations log a warning and return undefined so
 * the caller's inline response remains useful.
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
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

/** Per-table provenance + TTL metadata persisted in ctx.state. */
export interface DataframeMeta {
  columnSchema: ColumnSchema[];
  createdAt: string;
  expiresAt: string;
  maxRows: number | undefined;
  queryParams: Record<string, unknown>;
  rowCount: number;
  sourceTool: string;
  tableName: string;
  truncated: boolean;
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
      await this.sweepExpired(ctx);
      const instance = await this.acquireSharedCanvas(ctx);
      const tableName = this.mintTableName();
      // EIA's {col}-units companion columns carry a hyphen the canvas identifier
      // gate rejects; sanitize keys before registration. options.rows (the
      // caller's inline preview) keeps the original names.
      const safeRows = sanitizeRowsForCanvas(options.rows);
      const schema = deriveAllNullableSchema(safeRows);

      const result = await instance.registerTable(tableName, safeRows, { schema });

      const now = Date.now();
      const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
      const meta: DataframeMeta = {
        tableName: result.tableName,
        sourceTool: options.sourceTool,
        queryParams: options.queryParams,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
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
        expiresAt: meta.expiresAt,
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

  async describe(ctx: Context, tableName?: string): Promise<DataframeMeta[]> {
    await this.sweepExpired(ctx);
    if (tableName) {
      const meta = await ctx.state.get<DataframeMeta>(`${META_PREFIX}${tableName}`);
      return meta ? [meta] : [];
    }
    const entries: DataframeMeta[] = [];
    for await (const { meta } of this.iterateMeta(ctx)) entries.push(meta);
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async query(
    ctx: Context,
    sql: string,
    options: BridgeQueryOptions = {},
  ): Promise<{ result: QueryResult; meta?: DataframeMeta }> {
    await this.sweepExpired(ctx);
    const instance = await this.acquireSharedCanvas(ctx);

    const result = await instance.query(sql, {
      denySystemCatalogs: true,
      ...(options.preview !== undefined && { preview: options.preview }),
      ...(options.rowLimit !== undefined && { rowLimit: options.rowLimit }),
      ...(options.registerAs !== undefined && { registerAs: options.registerAs }),
      signal: ctx.signal,
    });

    const registerAs = options.registerAs;
    let meta: DataframeMeta | undefined;
    if (registerAs && result.tableName) {
      const now = Date.now();
      const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
      meta = {
        tableName: result.tableName,
        sourceTool: options.sourceTool ?? 'eia_dataframe_query',
        queryParams: options.queryParams ?? { sql },
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
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
    }

    return meta ? { result, meta } : { result };
  }

  async drop(ctx: Context, tableName: string): Promise<boolean> {
    await this.sweepExpired(ctx);
    const metaKey = `${META_PREFIX}${tableName}`;
    const hadMeta = (await ctx.state.get(metaKey)) !== null;
    await ctx.state.delete(metaKey);

    try {
      const instance = await this.acquireSharedCanvas(ctx);
      const dropped = await instance.drop(tableName);
      return dropped || hadMeta;
    } catch (error) {
      ctx.log.warning('Canvas drop failed', {
        tableName,
        error: error instanceof Error ? error.message : String(error),
      });
      return hadMeta;
    }
  }

  private async sweepExpired(ctx: Context): Promise<void> {
    const nowIso = new Date().toISOString();
    let instance: CanvasInstance | undefined;
    for await (const { key, meta } of this.iterateMeta(ctx)) {
      if (meta.expiresAt > nowIso) continue;
      instance ??= await this.acquireSharedCanvas(ctx).catch(() => undefined);
      if (instance) {
        try {
          await instance.drop(meta.tableName);
        } catch (error) {
          ctx.log.warning('TTL sweep drop failed', {
            tableName: meta.tableName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await ctx.state.delete(key);
      ctx.log.debug('Expired EIA dataframe swept', { tableName: meta.tableName });
    }
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
