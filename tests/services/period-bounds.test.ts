/**
 * @fileoverview How a start/end bound reads at an EIA frequency — the inverted
 * range diagnosis and the UTC-offset test local-hourly bounds need. Expected
 * periods are the ones live EIA selected for the same bounds.
 * @module tests/services/period-bounds.test
 */

import { describe, expect, it } from 'vitest';
import { impossiblePeriod, invertedRange, lacksUtcOffset } from '@/services/eia/period-bounds.js';

describe('invertedRange', () => {
  it.each([
    // EIA answered each of these with rows.
    ['monthly', '2023-01', '2023'],
    ['monthly', '2023-Q1', '2023-02'],
    ['quarterly', '2023-Q4', '2023-12'],
    ['annual', '2023-06', '2023-05'],
    ['daily', '2024-02-01', '2024-02'],
    ['weekly', '2024-02-07', '2024-02-12'],
    ['hourly', '2024-02-01T05', '2024-02-01'],
    ['hourly', '2024-02-01T05', '2024-02'],
    ['hourly', '2024-02-01T02-06', '2024-02-01T04-06'],
    ['local-hourly', '2024-02-01T08-00', '2024-02-01T03-06'],
    ['local-hourly', '2024-02-01T14+06', '2024-02-01T10-00'],
  ])('reads %s %s / %s as ordered', (frequency, start, end) => {
    expect(invertedRange(start, end, frequency)).toBeUndefined();
  });

  it.each([
    ['monthly', '2023-Q4', '2023-Q3', 'selects 2023-10', 'which selects 2023-07', 'Swap'],
    [
      'monthly',
      '2023-08',
      '2023-Q3',
      'selects 2023-08',
      'which selects 2023-07',
      'pass end "2023-09"',
    ],
    [
      'quarterly',
      '2024-Q2',
      '2024',
      'selects 2024-Q2',
      'which selects 2024-Q1',
      'pass end "2024-Q4"',
    ],
    ['annual', '2024-01', '2023-12', 'selects 2024', 'which selects 2023', 'Swap'],
    [
      'daily',
      '2024-05-03',
      '2024-Q2',
      'selects 2024-05-03',
      'which selects 2024-04-01',
      'pass end "2024-06-30"',
    ],
    [
      'weekly',
      '2024-02-04',
      '2024-02',
      'selects 2024-02-04',
      'which selects 2024-02-01',
      'pass end "2024-02-29"',
    ],
    [
      'hourly',
      '2024-03-02T05',
      '2024',
      'selects 2024-03-02T05 UTC',
      'which selects 2024-01-01T23 UTC',
      'pass end "2024-12-31"',
    ],
    [
      'hourly',
      '2024-02-02T00-06',
      '2024-02-01T22-06',
      'selects 2024-02-02T00 UTC',
      'which selects 2024-02-01T23 UTC',
      'Swap',
    ],
    [
      'local-hourly',
      '2024-02-01T14+06',
      '2024-02-01T07-00',
      'selects 2024-02-01T08 UTC',
      'which selects 2024-02-01T07 UTC',
      'Swap',
    ],
  ])(
    'names the periods %s %s / %s select',
    (frequency, start, end, startSelects, endSelects, fix) => {
      const message = invertedRange(start, end, frequency);
      expect(message).toContain(`effective ${frequency} frequency`);
      expect(message).toContain(startSelects);
      expect(message).toContain(endSelects);
      expect(message).toContain(fix);
    },
  );

  it.each([
    ['a month past 12', 'monthly', '2024-13', '2024-01'],
    // A day or hour that rolls over is never read as the period it rolls into.
    ['a day its month lacks', 'monthly', '2024-02-30', '2024-01'],
    ['a zero month', 'monthly', '2024-00', '2023-01'],
    ['a day past 31', 'daily', '2024-01-32', '2024-01-01'],
    ['an hour past 23', 'hourly', '2024-01-02T24', '2024-01-01T00'],
    ['a fifth quarter', 'quarterly', '2024-Q5', '2024-Q1'],
    ['a trailing character', 'monthly', '2024-06 ', '2024-01'],
    [
      'a value one character past the longest shape',
      'local-hourly',
      '2024-02-01T09-060',
      '2024-02-01T07-06',
    ],
    ['a local-hourly pair without offsets', 'local-hourly', '2024-02-01T09', '2024-02-01T07'],
    ['one offset-bearing bound', 'local-hourly', '2024-02-01T09-06', '2024-02-01T07'],
    ['an unmodeled frequency', 'four-week', '2024-06', '2024-01'],
  ])('reads nothing into %s', (_case, frequency, start, end) => {
    expect(invertedRange(start, end, frequency)).toBeUndefined();
  });
});

describe('lacksUtcOffset', () => {
  // Each shape EIA answered with HTTP 500 at local-hourly.
  it.each(['2024-02-01T02', '2024-02-01', '2024-02', '2024-Q1', '2024'])('flags %s', (value) => {
    expect(lacksUtcOffset(value)).toBe(true);
  });

  // The shape is what lacks the offset, whatever its components: EIA answers an
  // impossible hour or day at local-hourly with HTTP 500 too.
  it.each(['2024-02-01T25', '2024-02-01T24', '2024-02-30T05', '2024-02-01T5'])(
    'flags %s, whose components are out of range as well',
    (value) => {
      expect(lacksUtcOffset(value)).toBe(true);
    },
  );

  it.each([
    '2024-02-01T02-06',
    '2024-02-01T08+00',
    '2024-02-01T02-00',
    // Outside the period shapes: left for EIA to judge.
    '2024-02-01T02-6',
    '2024-02-01T02:00-06:00',
    '2024-02-01T0005',
    'yesterday',
  ])('leaves %s alone', (value) => {
    expect(lacksUtcOffset(value)).toBe(false);
  });
});

describe('impossiblePeriod', () => {
  // Each drew HTTP 500 ("Something unexpected happened.") from live EIA at that frequency.
  it.each([
    ['daily', '2024-02-30', 'day 30, but 2024-02 has 29 days'],
    ['daily', '2023-02-29', 'day 29, but 2023-02 has 28 days'],
    ['daily', '2024-04-31', 'day 31, but 2024-04 has 30 days'],
    ['daily', '2024-02-00', 'day 00, but days start at 01'],
    ['daily', '2024-02-32', 'day 32, but 2024-02 has 29 days'],
    ['daily', '2024-00-10', 'month 00, but months run 01–12'],
    ['daily', '2024-13-01', 'month 13, but months run 01–12'],
    ['weekly', '2024-02-30', 'day 30, but 2024-02 has 29 days'],
    ['weekly', '2024-13-01', 'month 13'],
    ['weekly', '2024-02-00', 'day 00'],
    ['hourly', '2024-02-01T24', 'hour 24, but the hour is two digits, 00–23'],
    ['hourly', '2024-02-01T25', 'hour 25'],
    ['hourly', '2024-02-01T99', 'hour 99'],
    ['hourly', '2024-02-01T5', 'hour 5, but the hour is two digits'],
    ['hourly', '2024-02-01T005', 'hour 005'],
    ['hourly', '2024-02-30T05', 'day 30'],
    ['hourly', '2024-02-00T05', 'day 00'],
    ['hourly', '2023-02-29T05', 'day 29, but 2023-02 has 28 days'],
    ['hourly', '2024-00-01T05', 'month 00'],
    ['hourly', '2024-13-01T00', 'month 13'],
    ['local-hourly', '2024-02-01T24-06', 'hour 24'],
    ['local-hourly', '2024-02-01T5-06', 'hour 5'],
    ['local-hourly', '2024-02-30T05-06', 'day 30'],
    ['local-hourly', '2024-02-00T05-06', 'day 00'],
    ['local-hourly', '2023-02-29T05-06', 'day 29'],
    ['local-hourly', '2024-00-01T05-06', 'month 00'],
    ['local-hourly', '2024-13-01T05-06', 'month 13'],
  ])('refuses %s %s', (frequency, value, problem) => {
    expect(impossiblePeriod(value, frequency)).toContain(problem);
  });

  // four-week-average parses `YYYY-MM-DD` strictly too: start 2024-02-30 drew HTTP 500.
  it.each([
    ['four-week-average', '2024-02-30', 'day 30, but 2024-02 has 29 days'],
    ['four-week-average', '2024-03-00', 'day 00, but days start at 01'],
  ])('refuses %s %s, which EIA answers with HTTP 500', (frequency, value, problem) => {
    expect(impossiblePeriod(value, frequency)).toContain(problem);
  });

  /**
   * A weekly period is a week-ending date, so an hour 24–99 that rolls a real
   * day forward selects the period the named day selects unless a period date
   * falls in between — which depends on the route's weekly calendar. Live EIA
   * (`petroleum/sum/sndw`, Friday periods) answered start 2024-02-01T24 exactly
   * as start 2024-02-01 (from 2024-02-02, 143 rows) and end 2024-02-05T24
   * exactly as end 2024-02-05 (through 2024-02-02, 2,141 rows).
   */
  it.each([
    ['weekly', '2024-02-01T24'],
    ['weekly', '2024-02-05T24'],
    ['weekly', '2024-02-05T99'],
    ['four-week-average', '2024-02-01T24'],
  ])('sends %s %s, whose rolled hour may select the named day’s week', (frequency, value) => {
    expect(impossiblePeriod(value, frequency)).toBeUndefined();
  });

  /**
   * Shapes EIA does not parse strictly. Live EIA answered each with rows from
   * another period than the bound names, or with HTTP 500 for an hour that is
   * not two digits.
   */
  it.each([
    ['daily', '2024-13', 'month 13, but months run 01–12'],
    ['daily', '2024-00', 'month 00, but months run 01–12'],
    ['daily', '2024-02-01T24', 'hour 24, but the hour is two digits, 00–23'],
    ['daily', '2024-02-30T05', 'day 30, but 2024-02 has 29 days'],
    ['daily', '2024-02-01T99', 'hour 99'],
    ['weekly', '2024-13', 'month 13'],
    ['weekly', '2024-02-30T05', 'day 30'],
    ['weekly', '2024-03-00T05', 'day 00'],
    ['four-week-average', '2024-02-30T05', 'day 30'],
    ['hourly', '2024-02-30', 'day 30, but 2024-02 has 29 days'],
    ['hourly', '2024-00-01', 'month 00'],
    ['hourly', '2024-13', 'month 13'],
    ['hourly', '2024-02-01T24+00', 'hour 24'],
    ['hourly', '2024-02-30T05+00', 'day 30'],
    ['monthly', '2024-00', 'month 00'],
    ['monthly', '2024-13', 'month 13'],
    ['monthly', '2024-02-30', 'day 30, but 2024-02 has 29 days'],
    ['monthly', '2024-02-00', 'day 00, but days start at 01'],
    ['monthly', '2024-01-32', 'day 32, but 2024-01 has 31 days'],
    ['monthly', '2023-02-29', 'day 29, but 2023-02 has 28 days'],
    ['quarterly', '2024-13', 'month 13'],
    ['annual', '2024-13', 'month 13'],
  ])('refuses %s %s, read leniently as another period', (frequency, value, problem) => {
    expect(impossiblePeriod(value, frequency)).toContain(problem);
  });

  /**
   * Where a day or hour rolls over (`Date.UTC`'s reading, and EIA's) decides
   * whether the bound still selects the period it names: across the boundary
   * of the frequency's period it is refused, within it it goes through. Live
   * EIA selected 2023-03 for monthly 2023-02-28T24, 2023-Q4 for quarterly
   * 2024-01-00, 2024-Q3 for quarterly 2024-06-31, and 2025 for annual
   * 2024-12-31T24; and the named period for monthly 2024-02-28T24 and
   * 2024-01-01T24 and quarterly 2024-02-00.
   */
  it.each([
    ['monthly', '2024-01-31T24', 'hour 24'],
    ['monthly', '2024-01-31T99', 'hour 99'],
    ['monthly', '2023-02-28T24', 'hour 24'],
    ['quarterly', '2024-03-31T24', 'hour 24'],
    ['quarterly', '2024-01-00', 'day 00'],
    ['quarterly', '2024-06-31', 'day 31, but 2024-06 has 30 days'],
    ['annual', '2024-12-31T24', 'hour 24'],
    ['annual', '2024-01-00', 'day 00'],
    // An hour that is not two digits draws HTTP 500 wherever its day rolls.
    ['quarterly', '2024-02-30T5', 'hour 5, but the hour is two digits'],
  ])('refuses %s %s, which rolls out of its period', (frequency, value, problem) => {
    expect(impossiblePeriod(value, frequency)).toContain(problem);
  });

  it.each([
    ['monthly', '2024-01-30T47'],
    ['quarterly', '2024-02-00'],
    ['quarterly', '2024-02-31T24'],
    ['annual', '2024-12-30T47'],
    ['annual', '2024-02-99'],
    ['monthly', '2024-02-28T24'],
    ['quarterly', '1900-02-29'],
  ])('sends %s %s, which rolls within its period', (frequency, value) => {
    expect(impossiblePeriod(value, frequency)).toBeUndefined();
  });

  // Each of these drew rows (or an empty 200) from live EIA, or EIA's own 400.
  it.each([
    // Every component real.
    ['daily', '2024-02-29'],
    ['weekly', '2024-06-01'],
    ['hourly', '2024-02-01T23'],
    ['local-hourly', '2024-02-01T05-06'],
    // Out-of-range offsets read leniently.
    ['local-hourly', '2024-02-01T05-99'],
    ['local-hourly', '2024-02-01T05+15'],
    ['local-hourly', '2024-02-01T05-13'],
    ['hourly', '2024-02-01T05-99'],
    // A day or hour that rolls over within the period the bound names.
    ['monthly', '2024-01-01T24'],
    ['quarterly', '2024-02-30'],
    ['annual', '2024-02-30'],
    // EIA rejects these itself with a 400, already invalid_period.
    ['quarterly', '2024-Q5'],
    ['monthly', '2024-Q0'],
    ['hourly', '2024-2-01T05'],
    // A single-digit day passes at daily.
    ['daily', '2024-02-1'],
    // A frequency this module does not model leaves a rolled day to EIA.
    ['four-week', '2024-02-30'],
  ])('leaves %s %s for EIA', (frequency, value) => {
    expect(impossiblePeriod(value, frequency)).toBeUndefined();
  });

  // A month or hour EIA never reads as written is refused at any frequency.
  it.each([
    ['four-week', '2024-13', 'month 13'],
    ['four-week', '2024-02-01T5', 'hour 5'],
  ])('refuses %s %s at a frequency it does not model', (frequency, value, problem) => {
    expect(impossiblePeriod(value, frequency)).toContain(problem);
  });

  // With no frequency known, only what no frequency reads is refused.
  it.each([
    ['2024-13', 'month 13, but months run 01–12'],
    ['2024-00-15', 'month 00'],
    ['2024-01-31T5', 'hour 5, but the hour is two digits'],
    ['2024-02-30T005', 'hour 005'],
    ['2024-02-31', undefined],
    ['2024-01-31T24', undefined],
    ['2024-02-30T05+00', undefined],
    ['2024-02-29', undefined],
  ])('judges %s with no frequency known', (value, problem) => {
    const verdict = impossiblePeriod(value, undefined);
    if (problem === undefined) expect(verdict).toBeUndefined();
    else expect(verdict).toContain(problem);
  });

  /**
   * The validator's measured narrowing table for #101: one bound per probe,
   * the v0.5.0 answer (EIA's own reading — v0.5.0 forwarded these unchanged)
   * beside the verdict. Refused bounds selected another period than they name,
   * named none, or drew HTTP 500; kept bounds selected the period they name,
   * or drew EIA's own 400 (`invalid_period` already).
   */
  it.each<[string, string, string, string, string | undefined]>([
    ['1-3', 'monthly', '2024-13', 'start from 2025-01, end through 2024-12', 'month 13'],
    ['4-5', 'monthly', '2024-00', 'start from 2024-01, end through 2023-12', 'month 00'],
    ['6-7', 'monthly', '2024-02-31', 'from / through 2024-03', 'day 31, but 2024-02 has 29 days'],
    ['8', 'monthly', '2024-02-00', 'from 2024-01', 'day 00, but days start at 01'],
    ['9', 'monthly', '2023-02-29', 'from 2023-03', 'day 29, but 2023-02 has 28 days'],
    ['10', 'monthly', '2024-02-29', 'from 2024-02', undefined],
    ['11', 'monthly', '2024-04-31', 'from 2024-05', 'day 31, but 2024-04 has 30 days'],
    ['12', 'monthly', '2024-01-31T24', 'from 2024-02', 'hour 24'],
    ['13', 'monthly', '2024-01-15T99', 'from 2024-01', undefined],
    ['14', 'monthly', '2024-01-31T5', 'HTTP 500', 'hour 5, but the hour is two digits, 00–23'],
    ['15', 'monthly', '2024-01-31T005', 'HTTP 500', 'hour 005'],
    ['16', 'monthly', '2024-01-31T05', 'from 2024-01', undefined],
    ['17', 'quarterly', '2024-13', 'from 2025-Q1', 'month 13'],
    ['18', 'quarterly', '2024-02-30', 'from 2024-Q1', undefined],
    ['19', 'quarterly', '2024-03-32', 'from 2024-Q2', 'day 32, but 2024-03 has 31 days'],
    ['20', 'quarterly', '2024-Q5', "EIA's 400", undefined],
    ['20', 'quarterly', '2024-Q0', "EIA's 400", undefined],
    ['21', 'quarterly', '2024-01-31T5', 'HTTP 500', 'hour 5'],
    ['22-23', 'annual', '2024-13', 'start from 2025, end through 2025', 'month 13'],
    ['24', 'annual', '2024-00', 'from 2023', 'month 00'],
    ['25', 'annual', '2024-02-30', 'from 2024', undefined],
    ['26', 'annual', '2024-12-32', 'from 2025', 'day 32, but 2024-12 has 31 days'],
    ['27', 'annual', '2024-01-31T5', 'HTTP 500', 'hour 5'],
    ['28', 'daily', '2024-13', 'from 2025-01-01', 'month 13'],
    ['29', 'daily', '2024-02-01T24', 'from 2024-02-02', 'hour 24'],
    ['30', 'daily', '2024-02-30T05', 'from 2024-03-01', 'day 30, but 2024-02 has 29 days'],
    ['31', 'daily', '2024-02-01T5', 'HTTP 500', 'hour 5'],
    ['32', 'weekly', '2024-13', 'from 2025-01-03', 'month 13'],
    ['33', 'weekly', '2024-02-01T5', 'HTTP 500', 'hour 5'],
    ['34', 'hourly', '2024-02-30', 'from 2024-03-01T00', 'day 30, but 2024-02 has 29 days'],
    ['35', 'hourly', '2024-13', 'from 2025-01-01T00', 'month 13'],
    ['36', 'hourly', '2024-02-01T24+00', 'from 2024-02-02T00', 'hour 24'],
    ['37', 'hourly', '2024-02-01T5+00', 'HTTP 500', 'hour 5'],
  ])('row %s: %s %s (v0.5.0: %s)', (_row, frequency, value, _reading, problem) => {
    const verdict = impossiblePeriod(value, frequency);
    if (problem === undefined) expect(verdict).toBeUndefined();
    else expect(verdict).toContain(problem);
  });

  it('knows century leap years', () => {
    expect(impossiblePeriod('2000-02-29', 'daily')).toBeUndefined();
    expect(impossiblePeriod('1900-02-29', 'daily')).toContain('1900-02 has 28 days');
  });

  /**
   * A bound is caller text of any length, and with no frequency known it now
   * reaches `impossiblePeriod` as well. Thread CPU per batch of calls at
   * doubling sizes: an absolute bound at each size, then the span ratio, never
   * a single step. The shapes a pattern could stall on stop below 80k
   * characters; the digit run carries the full 5k–320k span.
   */
  describe('work over caller-sized text', () => {
    /** Thread CPU milliseconds for `reps` runs of `fn`, the least of three trials. */
    function cpuMs(fn: () => void, reps: number): number {
      let best = Number.POSITIVE_INFINITY;
      for (let trial = 0; trial < 3; trial++) {
        const start = process.threadCpuUsage();
        for (let i = 0; i < reps; i++) fn();
        const used = process.threadCpuUsage(start);
        best = Math.min(best, (used.user + used.system) / 1000);
      }
      return best;
    }

    it.each([
      ['repeated openers with no closer', 80_000, (n: number) => '2024-02-01T'.repeat(n / 11)],
      ['one long line ending in a newline', 80_000, (n: number) => `${'2024-13 '.repeat(n / 8)}\n`],
      ['line breaks throughout', 80_000, (n: number) => '  \r\n'.repeat(n / 4)],
      ['a digit run', 320_000, (n: number) => '1'.repeat(n)],
    ])('stays linear on %s', (_name, maxChars, shape) => {
      const reps = 200;
      const timings: number[] = [];
      // Every verdict is kept, so no call is dead code; none of these is a period shape.
      const verdicts = new Set<string | undefined>();
      for (let n = 5_000; n <= maxChars; n *= 2) {
        const text = shape(n);
        const ms = cpuMs(() => {
          verdicts.add(impossiblePeriod(text, undefined));
          verdicts.add(impossiblePeriod(text, 'monthly'));
        }, reps);
        expect(ms, `${reps} checks at ${n} characters`).toBeLessThan(2_000);
        timings.push(ms);
      }
      expect([...verdicts]).toEqual([undefined]);
      // Linear growth over the span is the span itself; allow four times it (256 over 5k–320k).
      const first = Math.max(timings[0] ?? 0, 0.05);
      expect((timings.at(-1) ?? 0) / first).toBeLessThan((4 * maxChars) / 5_000);
    });
  });
});
