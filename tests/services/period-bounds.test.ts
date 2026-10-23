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
    // EIA rolls it into March at monthly, which this module does not model.
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

  // Each of these drew rows (or an empty 200) from live EIA, or EIA's own 400.
  it.each([
    // The frequency's own shape, every component real.
    ['daily', '2024-02-29'],
    ['weekly', '2024-06-01'],
    ['hourly', '2024-02-01T23'],
    ['local-hourly', '2024-02-01T05-06'],
    // Out-of-range offsets read leniently.
    ['local-hourly', '2024-02-01T05-99'],
    ['local-hourly', '2024-02-01T05+15'],
    ['local-hourly', '2024-02-01T05-13'],
    // Another shape than the frequency parses strictly rolls over or reads leniently.
    ['daily', '2024-13'],
    ['daily', '2024-00'],
    ['daily', '2024-02-01T24'],
    ['daily', '2024-02-30T05'],
    ['daily', '2024-02-01T99'],
    ['weekly', '2024-13'],
    ['weekly', '2024-02-30T05'],
    ['weekly', '2024-02-01T24'],
    ['hourly', '2024-02-30'],
    ['hourly', '2024-00-01'],
    ['hourly', '2024-13'],
    ['hourly', '2024-02-01T24+00'],
    ['hourly', '2024-02-30T05+00'],
    ['hourly', '2024-02-01T05-99'],
    // Frequencies whose bounds all read leniently.
    ['monthly', '2024-00'],
    ['monthly', '2024-13'],
    ['monthly', '2024-02-30'],
    ['monthly', '2024-02-00'],
    ['monthly', '2024-01-32'],
    ['monthly', '2023-02-29'],
    ['monthly', '2024-01-01T24'],
    ['quarterly', '2024-13'],
    ['quarterly', '2024-02-30'],
    ['annual', '2024-13'],
    ['annual', '2024-02-30'],
    // EIA rejects these itself with a 400, already invalid_period.
    ['quarterly', '2024-Q5'],
    ['monthly', '2024-Q0'],
    ['hourly', '2024-2-01T05'],
    // A single-digit day passes at daily.
    ['daily', '2024-02-1'],
    // A frequency this module does not model.
    ['four-week', '2024-02-30'],
  ])('leaves %s %s for EIA', (frequency, value) => {
    expect(impossiblePeriod(value, frequency)).toBeUndefined();
  });

  it('knows century leap years', () => {
    expect(impossiblePeriod('2000-02-29', 'daily')).toBeUndefined();
    expect(impossiblePeriod('1900-02-29', 'daily')).toContain('1900-02 has 28 days');
  });
});
