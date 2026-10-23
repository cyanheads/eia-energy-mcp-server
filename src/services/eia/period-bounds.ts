/**
 * @fileoverview How EIA reads a `start`/`end` bound at a given frequency. EIA
 * takes each bound as the period of the effective frequency that contains the
 * bound's first day (`2023` is 2023-01 at monthly, `2023-Q4` is 2023-10,
 * `2023-04-15` is 2023-04), so bounds of mixed granularity cannot be ordered
 * as strings. At `hourly` a bound without an hour — or with a UTC offset — is
 * read as its first day, which as an end covers the whole day; at
 * `local-hourly` every bound carries an offset and two bounds compare as
 * instants. `weekly` periods are dates, compared as days. Each frequency also
 * parses one bound shape strictly, and in that shape a month, day, or hour
 * that does not exist draws HTTP 500 from EIA (`impossiblePeriod`).
 * @module services/eia/period-bounds
 */

/** Granularity of a bound as written, coarsest first. */
type Precision = 'year' | 'quarter' | 'month' | 'day' | 'hour';

/** A bound in one of the period shapes EIA accepts. */
interface PeriodBound {
  /** Day of month of the bound's first day (1 for a year, quarter, or month bound). */
  day: number;
  /** Hour of day, present on hour-precision bounds. */
  hour?: number;
  /** First month of the bound (1–12): a quarter bound starts at its quarter's first month. */
  month: number;
  /** UTC offset in hours, present when the bound carries `±HH`. */
  offsetHours?: number;
  precision: Precision;
  year: number;
}

/** Longest bound the lexer reads, `YYYY-MM-DDTHHH±HH`; anything longer is not a period. */
const MAX_BOUND_LENGTH = 17;

/**
 * The shapes EIA's own format check lets through, components unchecked: a
 * quarter digit, two-digit month and day, and a one-to-three-digit hour (EIA
 * passes `2024-02-01T5` and `2024-02-01T005` to its parser, which then fails).
 */
const BOUND_PATTERN = /^(\d{4})(?:-Q(\d)|-(\d{2})(?:-(\d{2})(?:T(\d{1,3})([+-]\d{2})?)?)?)?$/;

/** A bound's components as written, before any range check. */
interface LexedBound {
  day?: string;
  hour?: string;
  month?: string;
  offset?: string;
  quarter?: string;
  year: string;
}

function lexBound(value: string): LexedBound | undefined {
  if (value.length > MAX_BOUND_LENGTH) return;
  const match = BOUND_PATTERN.exec(value);
  if (!match) return;
  const [, year = '', quarter, month, day, hour, offset] = match;
  return {
    year,
    ...(quarter !== undefined && { quarter }),
    ...(month !== undefined && { month }),
    ...(day !== undefined && { day }),
    ...(hour !== undefined && { hour }),
    ...(offset !== undefined && { offset }),
  };
}

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Days in `month` (1–12) of `year`, leap years included. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * What is wrong with the date and hour of a lexed bound — a month outside
 * 01–12, a day the month does not have, an hour that is not two digits 00–23 —
 * or undefined when every component it carries exists.
 */
function impossibleComponent(bound: LexedBound): string | undefined {
  const year = Number(bound.year);
  if (bound.month !== undefined) {
    const month = Number(bound.month);
    if (month < 1 || month > 12) return `month ${bound.month}, but months run 01–12`;
    if (bound.day !== undefined) {
      const day = Number(bound.day);
      const last = daysInMonth(year, month);
      if (day < 1) return `day ${bound.day}, but days start at 01`;
      if (day > last) return `day ${bound.day}, but ${bound.year}-${bound.month} has ${last} days`;
    }
  }
  if (bound.hour !== undefined && (bound.hour.length !== 2 || Number(bound.hour) > 23)) {
    return `hour ${bound.hour}, but the hour is two digits, 00–23`;
  }
  return;
}

/**
 * Parse `YYYY`, `YYYY-Qn`, `YYYY-MM`, `YYYY-MM-DD`, or `YYYY-MM-DDTHH[±HH]`;
 * undefined for anything else, including a quarter outside 1–4 and a month,
 * day, or hour that does not exist.
 */
function parseBound(value: string): PeriodBound | undefined {
  const lexed = lexBound(value);
  if (!lexed || impossibleComponent(lexed) !== undefined) return;
  const bound: PeriodBound = { year: Number(lexed.year), month: 1, day: 1, precision: 'year' };
  if (lexed.quarter !== undefined) {
    const quarter = Number(lexed.quarter);
    if (quarter < 1 || quarter > 4) return;
    bound.month = quarter * 3 - 2;
    bound.precision = 'quarter';
    return bound;
  }
  if (lexed.month === undefined) return bound;
  bound.month = Number(lexed.month);
  bound.precision = 'month';
  if (lexed.day === undefined) return bound;
  bound.day = Number(lexed.day);
  bound.precision = 'day';
  if (lexed.hour === undefined) return bound;
  bound.hour = Number(lexed.hour);
  bound.precision = 'hour';
  if (lexed.offset !== undefined) bound.offsetHours = Number(lexed.offset);
  return bound;
}

/**
 * True when `value` is written in one of the period shapes without a UTC
 * offset (`2024-02-01T02`, `2024-02-01`, `2024`) — the bounds EIA answers with
 * HTTP 500 at `local-hourly`, whatever their components. A shape outside them
 * is false: EIA is left to judge it.
 */
export function lacksUtcOffset(value: string): boolean {
  const bound = lexBound(value);
  return bound !== undefined && bound.offset === undefined;
}

/**
 * Why EIA cannot read `value` at `frequency`, or undefined when it can. Each
 * frequency parses one shape strictly and every other leniently, so only that
 * shape is checked, measured against live EIA: `daily` and `weekly` parse
 * `YYYY-MM-DD`, `hourly` parses `YYYY-MM-DDTHH`, and `local-hourly` parses
 * `YYYY-MM-DDTHH±HH` (the offset itself is lenient). In that shape a month
 * outside 01–12, a day the month lacks — February 29 outside a leap year
 * included — or an hour that is not two digits 00–23 draws HTTP 500 and never
 * rows. Every other shape and frequency rolls over or reads leniently
 * (`2024-13` is 2025-01 at monthly, `2024-02-30` at hourly reads as a day), and
 * an out-of-range quarter draws EIA's own 400.
 */
export function impossiblePeriod(value: string, frequency: string): string | undefined {
  const bound = lexBound(value);
  if (!bound || bound.day === undefined) return;
  const strict =
    frequency === 'daily' || frequency === 'weekly'
      ? bound.hour === undefined
      : frequency === 'hourly'
        ? bound.hour !== undefined && bound.offset === undefined
        : frequency === 'local-hourly'
          ? bound.hour !== undefined && bound.offset !== undefined
          : false;
  return strict ? impossibleComponent(bound) : undefined;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A position on the frequency's own axis plus the period label it renders as. */
interface SelectedPeriod {
  key: number;
  label: string;
}

function dayPeriod(year: number, month: number, day: number): SelectedPeriod {
  return {
    key: Date.UTC(year, month - 1, day) / DAY_MS,
    label: `${year}-${pad(month)}-${pad(day)}`,
  };
}

function hourPeriod(epochMs: number): SelectedPeriod {
  const d = new Date(epochMs);
  return {
    key: epochMs / HOUR_MS,
    label: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())} UTC`,
  };
}

/**
 * The period `bound` selects as `side` at `frequency`, or undefined when the
 * frequency is one this module does not model or the bound cannot be read at
 * it (a `local-hourly` bound without an offset).
 */
function selectedPeriod(
  bound: PeriodBound,
  side: 'start' | 'end',
  frequency: string,
): SelectedPeriod | undefined {
  const { year, month, day } = bound;
  switch (frequency) {
    case 'annual':
      return { key: year, label: String(year) };
    case 'quarterly': {
      const quarter = Math.ceil(month / 3);
      return { key: year * 4 + quarter - 1, label: `${year}-Q${quarter}` };
    }
    case 'monthly':
      return { key: year * 12 + month - 1, label: `${year}-${pad(month)}` };
    case 'weekly':
    case 'daily':
      return dayPeriod(year, month, day);
    case 'hourly': {
      // An hour without an offset is a UTC hour; anything else is read as its day.
      const hour =
        bound.hour !== undefined && bound.offsetHours === undefined
          ? bound.hour
          : side === 'start'
            ? 0
            : 23;
      return hourPeriod(Date.UTC(year, month - 1, day, hour));
    }
    case 'local-hourly':
      if (bound.hour === undefined || bound.offsetHours === undefined) return;
      return hourPeriod(Date.UTC(year, month - 1, day, bound.hour) - bound.offsetHours * HOUR_MS);
    default:
      return;
  }
}

/** The finest bound granularity each modeled frequency resolves; a coarser end selects only its first period. */
const RESOLUTION: Record<string, Precision> = {
  annual: 'year',
  quarterly: 'quarter',
  monthly: 'month',
  weekly: 'day',
  daily: 'day',
  hourly: 'day',
};
const PRECISION_ORDER: readonly Precision[] = ['year', 'quarter', 'month', 'day', 'hour'];

/**
 * The bound naming the last period of a coarse end's span at `frequency`
 * (`2023` → `2023-12` at monthly, `2024-02` → `2024-02-29` at daily) — the end
 * a caller who meant the whole span would pass — or undefined when `end` is
 * not coarser than the frequency resolves.
 */
function spanEnd(end: PeriodBound, frequency: string): string | undefined {
  const resolution = RESOLUTION[frequency];
  if (!resolution) return;
  if (PRECISION_ORDER.indexOf(end.precision) >= PRECISION_ORDER.indexOf(resolution)) return;
  const lastMonth =
    end.precision === 'year' ? 12 : end.precision === 'quarter' ? end.month + 2 : end.month;
  if (frequency === 'quarterly') return `${end.year}-Q4`;
  if (frequency === 'monthly') return `${end.year}-${pad(lastMonth)}`;
  const lastDay = new Date(Date.UTC(end.year, lastMonth, 0)).getUTCDate();
  return `${end.year}-${pad(lastMonth)}-${pad(lastDay)}`;
}

/**
 * The explanation for a range whose `start` selects a later period than its
 * `end` at `frequency` — the frequency EIA reports for the response — naming
 * the period each bound selected and the end that fixes it. Undefined when the
 * range is ordered, when either bound is not one of the accepted period
 * shapes, when only one bound carries a UTC offset, or when the frequency is
 * not one whose bound reading has been measured against EIA (annual,
 * quarterly, monthly, weekly, daily, hourly, local-hourly).
 */
export function invertedRange(start: string, end: string, frequency: string): string | undefined {
  const startBound = parseBound(start);
  const endBound = parseBound(end);
  if (!startBound || !endBound) return;
  if ((startBound.offsetHours === undefined) !== (endBound.offsetHours === undefined)) return;
  const from = selectedPeriod(startBound, 'start', frequency);
  const to = selectedPeriod(endBound, 'end', frequency);
  if (!from || !to || from.key <= to.key) return;

  const widened = spanEnd(endBound, frequency);
  const widenedBound = widened === undefined ? undefined : parseBound(widened);
  const widenedPeriod = widenedBound && selectedPeriod(widenedBound, 'end', frequency);
  const fix =
    widened !== undefined && widenedPeriod && from.key <= widenedPeriod.key
      ? `A coarse end selects only its first period — pass end ${JSON.stringify(widened)} to cover all of ${end}.`
      : 'Swap start and end.';
  return `Date range is inverted at the effective ${frequency} frequency: start ${JSON.stringify(start)} selects ${from.label}, after end ${JSON.stringify(end)}, which selects ${to.label}. ${fix}`;
}
