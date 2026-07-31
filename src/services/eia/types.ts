/**
 * @fileoverview EIA API v2 domain types — raw API shapes and normalized domain
 * objects used across the service layer and tool definitions.
 * @module services/eia/types
 */

/** A single entry in the EIA route tree (not yet classified as leaf/category). */
export interface RouteEntry {
  description: string;
  id: string;
  /** True when this route is a leaf (queryable data endpoint). */
  isLeaf: boolean;
  name: string;
  route: string;
}

/** Full route tree node as returned by the EIA v2 API browse endpoint. */
export interface RawRouteNode {
  /**
   * Present on leaf nodes. Two shapes exist in the wild:
   *   Standard: `{ colId: { alias: string, units: string }, ... }`
   *   Value-array: `{ value: [] }` — time-series routes with a single unnamed column
   */
  data?: Record<string, { alias: string; units: string } | unknown[]>;
  defaultDateFormat?: string;
  defaultFrequency?: string;
  description?: string;
  endPeriod?: string;
  /** Present on leaf nodes */
  facets?: RawFacetMeta[];
  /**
   * Present on leaf nodes. Two shapes exist in the wild, mirroring `data`:
   *   Standard: `[{ id, description, query, format }, ...]`
   *   Object-map: `{ monthly: { id: 'monthly', ... }, ... }` — keyed by frequency id
   * Normalized to an array at the service boundary before it reaches
   * `RouteMetadata.frequencies`.
   */
  frequency?: RawFrequency[] | Record<string, RawFrequency>;
  id: string;
  /**
   * Set when the node's own metadata fetch failed during the warm. The node is
   * the stub its parent advertised — its children and leaf status are unknown,
   * so it is neither a leaf nor a category until it is re-fetched.
   */
  incomplete?: boolean;
  name: string;
  routes?: RawRouteNode[];
  startPeriod?: string;
}

export interface RawFrequency {
  description: string;
  format: string;
  id: string;
  query: string;
}

/** Facet metadata from the route metadata endpoint (no values). */
export interface RawFacetMeta {
  description: string;
  id: string;
}

/** Individual facet value from /v2/{route}/facet/{facetId}. */
export interface RawFacetValue {
  alias?: string;
  id: string;
  name: string;
}

/** Response from /v2/{route}/facet/{facetId}. */
export interface RawFacetResponse {
  facets: RawFacetValue[];
  totalFacets: number;
}

/** Normalized facet with all values populated. */
export interface Facet {
  description: string;
  id: string;
  values: Array<{ id: string; name: string; alias?: string }>;
}

/** Normalized data column. */
export interface DataColumn {
  alias: string;
  id: string;
  units: string;
}

/** Full normalized route metadata (leaf only). */
export interface RouteMetadata {
  dataColumns: DataColumn[];
  dateRange: { start: string; end: string };
  defaultDateFormat: string;
  defaultFrequency: string;
  description: string;
  facets: Facet[];
  frequencies: RawFrequency[];
  route: string;
}

/** A data row from /v2/{route}/data/. All values are strings per EIA API. */
export type DataRow = Record<string, string | null>;

/**
 * A single EIA advisory. Returned at the TOP LEVEL of the data payload (sibling
 * to `response`), not inside it — `response.warnings` is always null.
 */
export interface EiaWarning {
  description: string;
  warning: string;
}

/**
 * Rows accumulated across offset pages for canvas registration, kept separate
 * from the inline preview so the response payload stays bounded by the caller's
 * `length` while the canvas receives the wider set.
 */
export interface AccumulatedRows {
  /** The cumulative row ceiling that applied (EIA_CANVAS_MAX_ROWS). */
  cap: number;
  /** True when `cap` stopped accumulation short of `total`. */
  capped: boolean;
  rows: DataRow[];
}

/** Response from /v2/{route}/data/. */
export interface DataResponse {
  /**
   * Present only when accumulation was requested and more rows existed past the
   * inline preview. `rows` starts with the preview rows and extends forward.
   */
  accumulated?: AccumulatedRows;
  data: DataRow[];
  dateFormat: string;
  frequency: string;
  total: number;
  warnings: EiaWarning[] | undefined;
}

/** Entry in the Fuse.js search index. */
export interface SearchIndexEntry {
  category: string | undefined;
  description: string;
  /**
   * Pre-built filter hint for routes that require a specific facet value to
   * query. Present on STEO series entries (`{ seriesId }`) and facet-value
   * entries (`{ <facetId>: <valueId> }`) so callers can pass it straight to
   * eia_query_route without parsing the description string.
   */
  filter_hint?: Record<string, string>;
  isLeaf: boolean;
  name: string;
  route: string;
}
