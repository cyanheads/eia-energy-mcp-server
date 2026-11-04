/**
 * @fileoverview The ISO/RTO acronyms of the balancing authorities EIA reports
 * on its grid routes, and the facets that carry those authorities' codes.
 * Grid analysts name an ISO or RTO by its acronym (ERCOT, CAISO, SPP); EIA
 * names its balancing authority by a code (`ERCO`, `CISO`, `SWPP`) and a full
 * name ("Electric Reliability Council of Texas, Inc."), and no EIA text carries
 * the acronym, so nothing derived from the data can reach it. Search indexes a
 * balancing-authority value under its code and acronyms, and `values_query`
 * matches a value by its acronyms too.
 * @module services/eia/balancing-authorities
 */

/**
 * ISO/RTO acronyms keyed by EIA balancing-authority code, each code verified
 * against the live facet lists (2026-11-03). SPP reports two balancing
 * authorities, `SWPP` and `SWPW` ("Southwest Power Pool West Balancing
 * Authority Area"); `electricity/operating-generator-capacity` lists CAISO
 * under its legacy code `CA` beside `CISO`. MISO and PJM are their own codes,
 * listed so the table names every ISO and RTO.
 */
const ACRONYMS: ReadonlyMap<string, readonly string[]> = new Map([
  ['ERCO', ['ERCOT']],
  ['CISO', ['CAISO']],
  ['CA', ['CAISO']],
  ['NYIS', ['NYISO']],
  ['SWPP', ['SPP']],
  ['SWPW', ['SPP']],
  ['ISNE', ['ISO-NE']],
  ['MISO', ['MISO']],
  ['PJM', ['PJM']],
]);

/**
 * Facets whose values are balancing-authority codes: `respondent`, `fromba`,
 * `toba`, and `parent` on `electricity/rto/*`, and `balancing_authority_code`
 * on `electricity/operating-generator-capacity`. The table applies only there
 * — `CA` is California on every `stateid` — and only under `electricity/`:
 * the annual `densified-biomass/wood-pellet-plants` also has a `respondent`
 * facet, whose values are plant names.
 */
const BALANCING_AUTHORITY_FACET_IDS = new Set([
  'balancing_authority_code',
  'fromba',
  'parent',
  'respondent',
  'toba',
]);

/**
 * The acronym table, keyed by balancing-authority code, when `facetId` on
 * `route` is a balancing-authority facet; undefined on every other facet. A
 * code the table does not list (`BANC`, a region such as `CAL`) has no acronym.
 */
export function balancingAuthorityAcronyms(
  route: string,
  facetId: string,
): ReadonlyMap<string, readonly string[]> | undefined {
  return route.startsWith('electricity/') && BALANCING_AUTHORITY_FACET_IDS.has(facetId)
    ? ACRONYMS
    : undefined;
}
