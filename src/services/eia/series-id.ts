/**
 * @fileoverview Legacy APIv1 series IDs (`PET.RWTC.W`, `ELEC.PRICE.TX-RES.M`)
 * and their resolution through EIA's `GET /v2/seriesid/{id}`. EIA's website,
 * Excel add-in, and older scripts still name data this way; the v2 endpoint
 * answers each ID with the route, facet filters, data columns, and frequency
 * `eia_query_route` takes. `parseSeriesId` decides whether a search query is
 * shaped like one, and `seriesIdEntry` turns EIA's answer into a search result.
 * @module services/eia/series-id
 */

import { z } from '@cyanheads/mcp-ts-core';
import { normalizeDescription } from './route-cache.js';
import type { SearchResultEntry } from './types.js';

/**
 * The v1 frequency codes an ID ends in, all probed live: annual, quarterly,
 * monthly, weekly, daily, hourly (UTC), `HL` local hourly, and `4` the
 * four-week average.
 */
const FREQUENCY_CODES = new Set(['A', 'Q', 'M', 'W', 'D', 'H', 'HL', '4']);

/** One dot-separated segment: letters, digits, hyphen, underscore — never empty. */
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * The query as the series ID EIA would look up — uppercased, since EIA answers
 * `pet.rwtc.w` with 404 — or undefined when it is not shaped like one: three or
 * more dot-separated segments of letters, digits, `-`, or `_`, no whitespace,
 * the last a v1 frequency code (ignoring case). A non-ID can fit (`U.S.A`); the
 * lookup is what tells them apart.
 */
export function parseSeriesId(query: string): string | undefined {
  const segments = query.split('.');
  if (segments.length < 3) return;
  if (!FREQUENCY_CODES.has((segments.at(-1) ?? '').toUpperCase())) return;
  if (!segments.every((segment) => SEGMENT.test(segment))) return;
  return query.toUpperCase();
}

/**
 * What a search's series-ID lookup came to. `unrecognized` is EIA refusing the
 * ID (404, or 400/414 for one it cannot read); `failed` is any other classified
 * failure or an unusable answer, `reason` naming its classified reason when it
 * has one and `retryable` saying whether a later call can succeed. `empty`
 * marks an ID EIA maps to a query its own lookup answered with no rows.
 */
export type SeriesIdLookup =
  | { outcome: 'resolved'; seriesId: string; entry: SearchResultEntry; empty?: true }
  | { outcome: 'unrecognized'; seriesId: string }
  | { outcome: 'failed'; seriesId: string; retryable: boolean; reason?: string };

/**
 * The part of a `/v2/seriesid/{id}` answer the result is built from. `request`
 * echoes the v2 query the ID stands for; each facet carries exactly one value,
 * which EIA sends as a string or a number (`sectorid: [99]`). `response.total`
 * counts the rows that query matches.
 */
export const SeriesIdResponseSchema = z.object({
  request: z.object({
    route: z.string().min(1),
    params: z.object({
      frequency: z.string().min(1),
      data: z.array(z.string()),
      facets: z.record(z.string(), z.tuple([z.union([z.string(), z.number()])])),
    }),
  }),
  response: z
    .object({
      description: z.string().optional(),
      total: z.union([z.number(), z.string()]).optional(),
    })
    .optional(),
});

/**
 * The search result a resolved ID answers with: the route EIA mapped it to,
 * every facet as a string filter (values as EIA sends them, case included),
 * and the frequency and data columns of the series. Named by the ID itself;
 * the description is EIA's own for the dataset the lookup answered from.
 */
export function seriesIdEntry(
  seriesId: string,
  answer: z.infer<typeof SeriesIdResponseSchema>,
): SearchResultEntry {
  const { route, params } = answer.request;
  const filters = Object.entries(params.facets).map(([id, [value]]) => [id, String(value)]);
  return {
    route,
    name: seriesId,
    description: normalizeDescription(answer.response?.description),
    category: undefined,
    isLeaf: true,
    ...(filters.length > 0 && { filter_hint: Object.fromEntries(filters) }),
    frequency: params.frequency,
    ...(params.data.length > 0 && { columns: params.data }),
  };
}
