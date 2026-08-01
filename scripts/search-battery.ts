/**
 * @fileoverview Labelled query battery for `eia_search_routes`. Each on-target
 * query names the route that should surface for it; each off-target query names
 * nothing, because no route in the EIA taxonomy holds what it asks for.
 *
 * The battery exists because the search mechanism's two failure modes pull
 * against each other: a candidate gate loose enough to reach the route behind a
 * multi-term question also lets an unrelated query find a coincidental word
 * match, and the second failure is worse than the first — a caller can recover
 * from ten flagged wrong answers and cannot recover from one confident one.
 * Measuring both halves at once is the only way to tell a real improvement from
 * a trade. `scripts/eval-search.ts` runs it and reports the separation gap.
 *
 * A query is on-target when a route genuinely carries the data it asks for,
 * verified against the live taxonomy — not when it merely sounds plausible. An
 * expectation is a route path; a result satisfies it when its `route` matches,
 * whether the hit is the route entry itself or one of the facet values that
 * points back at it with a `filter_hint`.
 *
 * @module scripts/search-battery
 */

/** A query paired with what the corpus should — or should not — answer with. */
export interface BatteryQuery {
  /** Why this query is in the battery. */
  note: string;
  query: string;
  /** Route path a result must carry to count as a hit. Absent on off-target queries. */
  route?: string;
}

/**
 * Queries a route genuinely answers. The first two are the cases issue #37
 * measured directly; the middle group is multi-term questions against routes
 * that expose the matching facets; the last group is the single-concept
 * behavior #36 and the tool's own description promise, which a candidate-gate
 * change must leave standing.
 */
export const ON_TARGET: readonly BatteryQuery[] = [
  {
    query: 'electricity price residential',
    route: 'electricity/retail-sales',
    note: 'Primary repro — commodity + metric + sector against the route holding residential prices.',
  },
  {
    query: 'electricity generation by fuel type',
    route: 'electricity/electric-power-operational-data',
    note: 'On-target but scored 0.9718 and mislabelled weak by the phrase-only gate.',
  },
  {
    query: 'coal generation industrial sector',
    route: 'coal/consumption-and-quality',
    note: 'Multi-term commodity + sector against the route holding coal use by consuming sector.',
  },
  {
    query: 'natural gas emissions commercial sector',
    route: 'co2-emissions/co2-emissions-aggregates',
    note: 'Multi-term across fuel, metric, and sector on a route exposing all three.',
  },
  {
    query: 'solar capacity by state',
    route: 'electricity/operating-generator-capacity',
    note: 'Reads like nonsense against the route titles but the generator-capacity route answers it.',
  },
  {
    query: 'gasoline retail prices',
    route: 'petroleum/pri/gnd',
    note: "The tool description's own example — the phrase gate already reaches it.",
  },
  {
    query: 'electricity retail sales by state',
    route: 'electricity/retail-sales',
    note: "The tool description's own example, and the route-entry half of the calibration.",
  },
  {
    query: 'natural gas imports',
    route: 'natural-gas/move',
    note: "The tool description's own example — two terms, one of them generic.",
  },
  {
    query: 'wind',
    route: 'electricity/electric-power-operational-data',
    note: 'Single-concept facet value from #36 — resolves through a filter_hint, must not regress.',
  },
  {
    query: 'anthracite coal',
    route: 'coal/shipments/mine-aggregates',
    note: 'Single-concept coal rank from the tool description — must not regress.',
  },
  {
    query: 'crude oil production forecast',
    route: 'steo',
    note: 'A STEO series name — the entry class that crowds out everything else on short queries.',
  },
  {
    query: 'recoverable reserves',
    route: 'coal/reserves-capacity',
    note: "Verbatim phrase from the route's own description, buried deep enough in it to score badly.",
  },
];

/**
 * Queries no route answers. Longer ones are where the phrase gate is already
 * safe — nothing in the corpus reads like them, so they return nothing at all
 * and score 1.0000. The short ones at the end are where the weak-match label
 * actually earns its keep, and where a loosened candidate gate does its damage:
 * two or three words are enough for one coincidental term match to look like an
 * answer. A battery of long nonsense alone would flatter any mechanism.
 */
export const OFF_TARGET: readonly BatteryQuery[] = [
  {
    query: 'airline ticket prices',
    note: 'Near-miss — "prices" is everywhere in the corpus, the subject is not in it at all.',
  },
  {
    query: 'employee stock options vesting',
    note: 'Near-miss — "employment" and "stocks" are both EIA vocabulary in another sense.',
  },
  {
    query: 'how many cats live in seattle',
    note: 'Nonsense carried almost entirely by connector words.',
  },
  {
    query: 'solar eclipse viewing times',
    note: 'Near-miss — "solar" is an indexed facet value, the question is not about energy.',
  },
  {
    query: 'oil painting restoration techniques',
    note: 'Near-miss — "oil" leads half the petroleum taxonomy.',
  },
  {
    query: 'quarterly earnings per share guidance',
    note: 'Finance vocabulary that overlaps EIA reporting periods without naming any data.',
  },
  {
    query: 'hotel occupancy rates by city',
    note: 'Shares the "X rates by geography" shape of many real routes with none of the subject.',
  },
  {
    query: 'favorite pizza toppings ranked',
    note: 'Nonsense with no corpus vocabulary at all — the floor case.',
  },
  {
    query: 'cat food',
    note: 'Two short terms whose one-edit neighbourhoods both reach the corpus (`cat` near `capability`, `food` near `Wood`) — the verbatim rule for short terms exists for this.',
  },
  {
    query: 'freight rail',
    note: 'Two terms both present in the corpus, on entries that answer neither.',
  },
  {
    query: 'stock options',
    note: 'Two finance terms with EIA homographs ("stocks" as inventory).',
  },
  {
    query: 'movie tickets',
    note: 'Two terms, neither in the corpus, both short enough to fuzzy-match fragments.',
  },
  {
    query: 'ticket prices',
    note: 'One absent term beside one of the most common words in the corpus.',
  },
];
