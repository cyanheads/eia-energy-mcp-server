#!/usr/bin/env bun
/**
 * @fileoverview Runs the `scripts/search-battery.ts` query battery against a
 * live, fully warmed EIA search corpus and reports what `eia_search_routes`
 * would answer with. Needs `EIA_API_KEY`; the warm costs 24–30 s and ~300
 * upstream requests, so this is a deliberate measurement, not a devcheck step.
 *
 * It reports both search modes side by side — `phrase` is Fuse scoring the whole
 * query as one approximate run, `combined` adds the tokenized candidate gate —
 * so a change to the gate can be read as a delta rather than an absolute.
 *
 * What the summary reports:
 *
 *   • **recall** — on-target queries whose expected route appears in the top
 *     `--limit` results.
 *   • **worst on-target** — the highest (worst) score among on-target queries
 *     that did surface their route. Read it within a mode, not across two: a
 *     mode that surfaces fewer routes is scored over fewer queries, so a lower
 *     recall can flatter this column and the gap built on it.
 *   • **best off-target** — the lowest (best) top score any query with no answer
 *     achieved. This is the confident-wrong-answer risk.
 *   • **gap** — `best off-target − worst on-target`. Positive means every
 *     genuine match outscores every piece of noise, which is the basis for a
 *     single weak-match threshold meaning anything.
 *   • **false weak / false confident** — what `WEAK_MATCH_SCORE` misclassifies
 *     in each direction. These are what a threshold should be chosen against;
 *     the gap alone flips sign on a single outlier.
 *
 * Usage:
 *   bun run eval:search
 *   bun run eval:search -- --limit 20 --verbose
 *   bun run eval:search -- --snapshot corpus.json     # save the warmed corpus
 *   bun run eval:search -- --corpus corpus.json       # replay it, no API calls
 *
 * @module scripts/eval-search
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { WEAK_MATCH_SCORE } from '../src/mcp-server/tools/definitions/search-routes.tool.js';
import { getEiaApiService, initEiaApiService } from '../src/services/eia/eia-service.js';
import {
  getIndexEntries,
  getIndexStatus,
  initRouteCache,
  searchRoutes,
} from '../src/services/eia/route-cache.js';
import type { SearchIndexEntry } from '../src/services/eia/types.js';
import { type BatteryQuery, OFF_TARGET, ON_TARGET } from './search-battery.js';

const MODES = ['phrase', 'combined'] as const;
type Mode = (typeof MODES)[number];

/** What one query produced under one mode. */
interface Outcome {
  /** Rank of the expected route, or -1 when it never appeared. */
  hitRank: number;
  /** Score of the expected route's best result, or undefined when absent. */
  hitScore: number | undefined;
  topRoute: string;
  topScore: number;
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function parseArgs(argv: string[]): {
  corpus: string | undefined;
  limit: number;
  snapshot: string | undefined;
  verbose: boolean;
} {
  return {
    corpus: flag(argv, '--corpus'),
    limit: Number(flag(argv, '--limit') ?? 10),
    snapshot: flag(argv, '--snapshot'),
    verbose: argv.includes('--verbose'),
  };
}

/**
 * Populate the index, either from the live API or from a snapshot of an earlier
 * warm. A replayed corpus carries every entry the warm produced; only the split
 * between route entries and appended ones is lost, which moves nothing but the
 * order of an exact score tie.
 */
async function loadCorpus(corpus: string | undefined, snapshot: string | undefined): Promise<void> {
  if (corpus) {
    const entries = JSON.parse(readFileSync(corpus, 'utf8')) as SearchIndexEntry[];
    initRouteCache([], entries);
    console.log(`Replaying corpus snapshot ${corpus} — ${entries.length} entries`);
    return;
  }

  initEiaApiService();
  console.log('Warming the EIA search corpus — 24–30 s on a healthy upstream…');
  const startedAt = Date.now();
  await getEiaApiService().search('warm', 1, createMockContext());
  const status = getIndexStatus();
  console.log(
    `Corpus warmed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${status.size} entries, complete: ${status.complete}`,
  );
  if (!status.complete) {
    console.log(`  gaps: ${[...status.incompleteRoutes, ...status.pendingPasses].join(', ')}`);
    console.log(
      '  Scores below are ranked against a partial corpus — re-run before trusting them.',
    );
  }
  if (snapshot) {
    writeFileSync(snapshot, JSON.stringify(getIndexEntries()));
    console.log(`Snapshot written to ${snapshot} — replay it with --corpus ${snapshot}`);
  }
}

function run(entry: BatteryQuery, mode: Mode, limit: number): Outcome {
  const results = searchRoutes(entry.query, limit, mode);
  const hitRank = entry.route ? results.findIndex((r) => r.entry.route === entry.route) : -1;
  return {
    hitRank,
    hitScore: hitRank === -1 ? undefined : results[hitRank]?.score,
    topRoute: results[0]?.entry.route ?? '—',
    topScore: results[0]?.score ?? 1,
  };
}

function fmt(score: number | undefined): string {
  return score === undefined ? '—' : score.toFixed(4);
}

/** One padded table row. */
function row(cells: string[], widths: number[]): string {
  return cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ');
}

/** Prints a header row and its rule. */
function header(cells: string[], widths: number[]): void {
  console.log(row(cells, widths));
  console.log(
    row(
      widths.map((w) => '-'.repeat(w)),
      widths,
    ),
  );
}

function reportSection(
  title: string,
  entries: readonly BatteryQuery[],
  outcomes: Record<Mode, Outcome[]>,
  verbose: boolean,
): void {
  const widths = [42, 8, 8, 40];
  console.log(`\n## ${title}\n`);
  header(['query', 'phrase', 'combined', 'combined top hit'], widths);

  for (const [i, entry] of entries.entries()) {
    const phrase = outcomes.phrase[i] as Outcome;
    const combined = outcomes.combined[i] as Outcome;

    // On-target reads the expected route's own score; off-target has no expected
    // route, so the top hit's score is the number that matters.
    const rank = entry.route && combined.hitRank >= 0 ? ` #${combined.hitRank + 1}` : '';
    console.log(
      row(
        [
          entry.query,
          fmt(entry.route ? phrase.hitScore : phrase.topScore),
          fmt(entry.route ? combined.hitScore : combined.topScore),
          `${combined.topRoute}${rank}`,
        ],
        widths,
      ),
    );
    if (verbose) console.log(`    ${entry.note}`);
  }
}

/**
 * Recall and the two ends of the separation, plus what `WEAK_MATCH_SCORE`
 * misclassifies at those numbers. The gap alone hides the shape: a single
 * outlier on either side flips its sign while the bulk of the distribution is
 * cleanly separated, so the misclassification counts are what a threshold
 * should actually be chosen against. `worstOn` ranges only over the queries a
 * mode surfaced, which is why the gap is not comparable between modes of
 * different recall.
 */
function summarize(onTarget: Outcome[], offTarget: Outcome[]) {
  const hits = onTarget.flatMap((o) => (o.hitScore === undefined ? [] : [o.hitScore]));
  const noise = offTarget.map((o) => o.topScore);
  const worstOn = Math.max(...hits);
  const bestOff = Math.min(...noise);
  return {
    found: hits.length,
    worstOn,
    bestOff,
    gap: bestOff - worstOn,
    /** Genuine matches the threshold labels weak. */
    falseWeak: hits.filter((s) => s > WEAK_MATCH_SCORE).length,
    /** Unanswerable queries the threshold leaves unflagged. */
    falseConfident: noise.filter((s) => s <= WEAK_MATCH_SCORE).length,
  };
}

/** Score every battery query under every mode. */
function scoreAll(entries: readonly BatteryQuery[], limit: number): Record<Mode, Outcome[]> {
  return {
    phrase: entries.map((entry) => run(entry, 'phrase', limit)),
    combined: entries.map((entry) => run(entry, 'combined', limit)),
  };
}

const { corpus, limit, snapshot, verbose } = parseArgs(process.argv.slice(2));
await loadCorpus(corpus, snapshot);

const onTarget = scoreAll(ON_TARGET, limit);
const offTarget = scoreAll(OFF_TARGET, limit);

reportSection('On-target (score of the expected route)', ON_TARGET, onTarget, verbose);
reportSection('Off-target (score of the top hit)', OFF_TARGET, offTarget, verbose);

console.log('\n## Summary\n');
const summaryWidths = [10, 8, 16, 16, 10, 12, 16];
header(
  ['mode', 'recall', 'worst on-target', 'best off-target', 'gap', 'false weak', 'false confident'],
  summaryWidths,
);
for (const mode of MODES) {
  const s = summarize(onTarget[mode], offTarget[mode]);
  console.log(
    row(
      [
        mode,
        `${s.found}/${ON_TARGET.length}`,
        s.worstOn.toFixed(4),
        s.bestOff.toFixed(4),
        `${s.gap >= 0 ? '+' : ''}${s.gap.toFixed(4)}`,
        `${s.falseWeak}/${s.found}`,
        `${s.falseConfident}/${OFF_TARGET.length}`,
      ],
      summaryWidths,
    ),
  );
}
console.log(
  `\nWEAK_MATCH_SCORE = ${WEAK_MATCH_SCORE} — "false weak" counts genuine matches above it,` +
    ' "false confident" counts unanswerable queries at or below it.',
);
