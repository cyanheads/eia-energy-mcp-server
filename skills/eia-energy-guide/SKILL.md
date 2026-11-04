---
name: eia-energy-guide
description: Gates for answering U.S. energy questions with the eia_* tools (EIA API v2) — per-route geography codes, total rows that sit beside their components, unit columns whose names vary by route, nulls and zeros, projections mixed with history, and SQL over staged tables. Use before ranking, summing, comparing, or joining EIA data across states, sectors, fuels, or routes.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

EIA publishes U.S. energy statistics: electricity, petroleum, natural gas, coal, nuclear outages, densified biomass, crude-oil imports, the integrated monthly totals (`total-energy`), state estimates (`seds`), and projections (`steo`, `aeo`, `ieo`). The `international` route holds country-level production, consumption, and trade. `co2-emissions` is deprecated upstream and no longer updated; state CO2 lives in `seds`. EIA carries no NYMEX futures prices after April 5, 2024: on `natural-gas/pri/fut` the futures series (`RNGC1`–`RNGC4`) end there, and only the Henry Hub spot series (`RNGWHHD`) keeps updating.

Some routes to know by name, since search does not reach every phrasing (e.g. "net generation by plant" misses the plant route; "individual power plants" finds it):

| Question | Route |
|:--|:--|
| Retail electricity price, sales, customers by state and sector | `electricity/retail-sales` |
| Plant-level generation and fuel use | `electricity/facility-fuel` |
| Natural gas consumption by state and end use | `natural-gas/cons/sum` |
| Natural gas prices by state and sector | `natural-gas/pri/sum` |
| WTI, Brent, and product spot prices | `petroleum/pri/spt` |
| State estimates for every energy source and sector | `seds` |
| National monthly totals — primary energy consumption, production, trade, prices (the Monthly Energy Review) | `total-energy`, one series per `msn` (`TETCBUS`); search finds a series by name or by its `msn` |
| 18-month forecasts | `steo` |

## Identifiers

- **Facet keys, facet value IDs, data column IDs, and frequency IDs** come from `eia_describe_route`. Keys and column IDs are case-sensitive. A frequency is the `frequencies[].id` (`monthly`), never the letter in `query` (`M`). An unknown key, column, or frequency fails with a hint; an unknown facet value does not fail.
- **Filter by value ID, never by name.** `stateid: "Texas"` returns zero rows; `stateid: "TX"` returns Texas. Use `values_query` on `eia_describe_route` to turn a name into its ID.
- **The same place has a different code on each route.** Look it up per route rather than reusing one:

| Route | Facet | A state | U.S. total |
|:--|:--|:--|:--|
| `electricity/retail-sales` | `stateid` | `TX` | `US` |
| `electricity/facility-fuel` | `state` | `AZ` | — |
| `natural-gas/cons/sum`, `natural-gas/pri/sum` | `duoarea` | `STX` | `NUS` |
| `seds` | `stateId` | `TX` | `US` |

  Petroleum `duoarea` codes name hubs and regions instead (`YCUOK` is Cushing, OK). `eia_describe_route` names most of them `NA`, so `values_query` finds them by code, not place; read the place from a row's `series-description`. To join natural-gas rows to electricity rows on state, match `duoarea = 'S' || stateid`.
- **Balancing authorities filter by EIA code, not ISO/RTO acronym.** ERCOT is `respondent: "ERCO"`, CAISO is `CISO` (and the legacy `CA` on `electricity/operating-generator-capacity`'s `balancing_authority_code`), NYISO `NYIS`, ISO-NE `ISNE`, SPP both `SWPP` and `SWPW`; MISO and PJM are their own codes. `eia_search_routes` and `values_query` on the `respondent`, `fromba`, `toba`, `parent`, and `balancing_authority_code` facets take the acronym and return the code. The `electricity/rto` respondent list also carries regions that are not balancing authorities (`CAL`, `NY`, `TEX`, `US48`; alias `Region: …`).
- **Sector is a facet on some routes and part of the process or series on others.** Residential is `sectorid: "RES"` on `electricity/retail-sales`, `process: "VRS"` on `natural-gas/cons/sum`, and a distinct `seriesId` on `steo` and `seds`.
- **`seriesId` names one series; its description may not.** In `seds`, two IDs can share a description and differ only in unit (`PACCB` in Billion Btu, `PACCP` in thousand barrels, both "All petroleum products consumed by the commercial sector"). Pick by ID and check the unit column. The same holds for `msn` on `total-energy`, where `BMACBUS` and `REACBUS` share one name.

## Gates

- **Exclude total rows before you rank or sum.** Totals sit in the same result as their parts:
  - `stateid` on `electricity/retail-sales` carries `US` and the Census regions (`NEW`, `MAT`, `SAT`, `WSC`, `PACC`, …) beside the states; their `alias` begins `Total:` or `Region:`. A residential-sales ranking sorted descending puts `US`, `SAT`, `WSC`, and `ENC` ahead of Texas.
  - `sectorid: "ALL"` ("all sectors") sits beside `RES`, `COM`, `IND`, `TRA`, and `OTH`.
  - `electricity/facility-fuel` returns each plant's total (`fuel2002: "ALL"`, `primeMover: "ALL"`) beside a row per fuel and per prime mover, so an unfiltered ranking lists Palo Verde three times. Filter `fuel2002: "ALL"` and `primeMover: "ALL"` for plant totals; filter a fuel instead for one fuel's share.
  - `natural-gas/cons/sum` lists `process: "VC0"` (Total Consumption) and `VGT` (Delivered to Consumers) beside the end-use processes (`VRS` residential, `VCS` commercial, `VIN` industrial, …), and `duoarea: "NUS"` (U.S.) beside the states; a state ranking on `VC0` puts `NUS` first.
- **Read the unit from the row, not from describe.** Each row carries its unit, and it can differ from row to row. The field depends on the route: `{column}-units` for each column describe lists by name (`price-units` on `electricity/retail-sales`, `quantity-units` on `crude-oil-imports`, `value-units` on `co2-emissions/co2-emissions-aggregates`); on routes whose only column is `value`, `units` on petroleum and natural-gas routes (`petroleum/pri/spt`, `natural-gas/pri/sum`) and `unit` on `steo`, `seds`, `total-energy`, `international`, `aeo`, and `ieo`. When `eia_describe_route` reports `units: ""` for a column, its notice names the field a row carries its unit in; a column whose rows have no such field has no unit, like the dates, `county`, `latitude`, and `longitude` on `electricity/operating-generator-capacity`. The exception runs the other way on `densified-biomass/inventories-by-region`: its rows carry no `inventory-units`, and describe's `units` (`tons`) is the only statement of the unit. A column's alias can contradict its unit: `electricity/retail-sales` `sales` is aliased "Megawatt-hours Sold" but its rows say `million kilowatt hours`.
- **One route can mix units.** `natural-gas/pri/sum` holds prices (`$/MCF`) and percent-of-deliveries shares (`%`) under different `process` values. Filter to one process, or group by the unit column, before averaging.
- **When `process-name` and `series-description` disagree, the series wins.** On `natural-gas/pri/sum`, process `VFC` is labelled "Percent Sold to The Residential Consumers" on a row whose series `N3020TX4` is the commercial share.
- **Null is missing, and zero can mean no activity.** A withheld or unavailable value arrives as `null` (the 2023 Texas wellhead price on `natural-gas/pri/sum`); never report it as 0, and say how many rows were null when a comparison skips them. The transportation sector on `electricity/retail-sales` reports `"0"` for price, sales, revenue, and customers where a state has none (Alaska, 2023), so exclude zero-sales rows before averaging a price.
- **Projections share a series with history.** `steo` series run months past the current one with no column marking where the forecast begins; split on `period` against the latest observed month. `aeo` and `ieo` are projection routes throughout. Say "forecast" or "projection" when reporting them.
- **Sorting is numeric.** EIA's `sort` orders value columns as numbers despite the string values, so a descending sort with a small `length` answers a top-N question without staging, once the total rows above are filtered out.

## Workflows

**Time series for one place and sector.** `eia_describe_route` → note the facet value IDs, the frequency ID, and its period format → `eia_query_route` with those filters, `frequency`, `start`/`end` in that format, and `columns` naming only what you need. Page with `offset` / `next_offset` while `next_offset` is present.

**Legacy series ID** (`PET.RWTC.W`, `ELEC.PRICE.TX-RES.M`). `eia_search_routes` returns its route, `filter_hint`, `frequency`, and `columns`; pass all four to `eia_query_route`, which needs no describe for that series.

**Top N across states or plants.** Describe → filter out total rows (Gates) → `eia_query_route` with `sort` descending on the measure and `length` set to N.

**Comparison or arithmetic across many rows or routes.** Stage the rows: `eia_query_route` with `stage: true` returns a `dataset` name (`df_<id>`). Call `eia_dataframe_describe` with that name for the staged table's columns — hyphens become underscores (`area-name` → `area_name`, `price-units` → `price_units`) — then `eia_dataframe_query` with a read-only SELECT. Values are VARCHAR: `CAST(value AS DOUBLE)` for math and `ORDER BY CAST(...)`. Before trusting a sum or ranking, check that the table's `row_count` from `eia_dataframe_describe` equals the query's `total` (for a stage that started at offset 0); if it is smaller, staging stopped early, and `canvas_preview_note` names the staged row range and the offset to resume from. Tables staged from different routes join by name in one statement (natural-gas `duoarea` to electricity `stateid` as in Identifiers). Staged tables expire; a query that names a table extends it.
