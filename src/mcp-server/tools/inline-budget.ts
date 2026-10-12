/**
 * @fileoverview The inline response budget shared by the row-returning tools
 * (eia_query_route, eia_dataframe_query): the byte ceiling each response
 * surface — serialized structuredContent and the full content[] text — is held
 * to, the search for the longest row prefix whose response fits it, and the
 * bound on echoed caller input that keeps the rest of a response from
 * outgrowing it.
 * @module mcp-server/tools/inline-budget
 */

/**
 * UTF-8 bytes each response surface may carry, charged separately to the
 * serialized structuredContent and to the content[] text (every block,
 * enrichment trailer included). A code constant, not an env var: a
 * deploy-tunable threshold would let one tool's output shape drift between
 * deployments. Sized to keep a default 100-row page whole on the narrow routes
 * (the widest measured, `international`, is ~37 KB) while ending it early on
 * wide ones (`electricity/operating-generator-capacity` is ~108 KB).
 */
export const INLINE_BUDGET_BYTES = 64_000;

/**
 * UTF-8 bytes one echoed caller input may cost on either surface — the SQL
 * eia_dataframe_query ran, the filters eia_query_route applied. No input schema
 * bounds those (narrowing one would reject calls that work today), so an echo
 * past this is cut with a marker saying so. It keeps the echo whole for any
 * hand-written statement or filter set — EIA itself refuses a request URI past
 * about 8 KB — while leaving most of the budget to rows.
 */
export const ECHO_BUDGET_BYTES = 4_000;

/** Byte length of `text` once UTF-8 encoded — what a surface costs on the wire. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * The largest `m` in `[0, count]` for which `fits(m)` holds, where `fits` is
 * monotone — once a prefix of `m` items overflows, every longer one does. A
 * binary search, so a long input costs a logarithmic number of measurements.
 */
export function longestFittingPrefix(count: number, fits: (m: number) => boolean): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * `text` as echoed back to the caller: whole when its JSON string form fits
 * `ECHO_BUDGET_BYTES`, otherwise its longest prefix that still fits once
 * `marker(fullBytes)` is appended. The JSON form is the larger of the two
 * surfaces (quotes and escapes), so the bound holds on content[] too. JSON
 * escapes a lone surrogate to six bytes, more than its whole pair costs, so the
 * longest fitting prefix never ends inside a pair.
 */
export function boundedEcho(text: string, marker: (fullBytes: number) => string): string {
  const cost = (s: string) => utf8Bytes(JSON.stringify(s));
  if (cost(text) <= ECHO_BUDGET_BYTES) return text;
  const tail = marker(utf8Bytes(text));
  const keep = longestFittingPrefix(
    Math.min(text.length, ECHO_BUDGET_BYTES),
    (m) => cost(text.slice(0, m) + tail) <= ECHO_BUDGET_BYTES,
  );
  return text.slice(0, keep) + tail;
}

/** Bytes on each response surface. */
export interface SurfaceBytes {
  structured: number;
  text: number;
}

/** A tool's own trailer renderer for one enrichment field. */
interface TrailerRenderer {
  render(value: unknown): string;
}

/**
 * True when `text`'s last line leaves a block quote or list item open, so the
 * framework separates the next trailer field with a blank line.
 */
function opensLazyContainer(text: string): boolean {
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  return /^ {0,3}(?:>|(?:[-+*]|\d{1,9}[.)])(?: |$))/.test(lastLine);
}

/**
 * Bytes the framework's enrichment trailer adds to content[] for `values`, in
 * the order they were enriched: a field with a tool renderer renders through
 * it, a `noticeKeys` field as a block quote, any other as `**key:** value`.
 * Mirrors the framework's trailer so the text surface is measured as the caller
 * receives it; the boundary tests run through the framework's own composition
 * and fail if the two drift apart.
 */
export function trailerBytes(
  values: Record<string, unknown>,
  renderers: Partial<Record<string, TrailerRenderer>> = {},
  noticeKeys: readonly string[] = [],
): number {
  let text = '';
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const field =
      renderers[key]?.render(value) ??
      (noticeKeys.includes(key)
        ? `> ${String(value)}`
        : `**${key}:** ${value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
    if (text.length > 0) text += opensLazyContainer(text) ? '\n\n' : '\n';
    text += field;
  }
  return text.length > 0 ? utf8Bytes(`\n\n${text}`) : 0;
}

const fits = (size: SurfaceBytes) =>
  size.structured <= INLINE_BUDGET_BYTES && size.text <= INLINE_BUDGET_BYTES;

/**
 * The longest prefix of `count` rows whose response fits the budget on both
 * surfaces. `measure(k)` gives the exact bytes of both surfaces as the caller
 * receives them carrying the first `k` rows; `rowBytes(i)` estimates what row
 * `i` adds to each. The estimate grows the prefix from a one-row response one
 * row at a time, so the work tracks the budget rather than the fetch — a
 * 5,000-row fetch serializes only the rows that can fit — and `measure` then
 * settles the exact answer in a few calls on budget-sized output. Rows are
 * whole: a first row that alone overflows yields 0.
 */
export function fitRows(
  count: number,
  measure: (k: number) => SurfaceBytes,
  rowBytes: (index: number) => SurfaceBytes,
): number {
  if (count === 0) return 0;

  /**
   * A one-row response less that row's own cost: the envelope as it stands
   * once rows are present (table header included).
   */
  const first = rowBytes(0);
  const one = measure(1);
  let structured = one.structured - first.structured;
  let text = one.text - first.text;
  let k = 0;
  while (k < count) {
    const row = rowBytes(k);
    if (structured + row.structured > INLINE_BUDGET_BYTES || text + row.text > INLINE_BUDGET_BYTES)
      break;
    structured += row.structured;
    text += row.text;
    k++;
  }

  /**
   * Shed rows from the end until the measured response fits, then take rows
   * back while the next one still does.
   */
  let size = measure(k);
  while (k > 0 && !fits(size)) {
    let overStructured = size.structured - INLINE_BUDGET_BYTES;
    let overText = size.text - INLINE_BUDGET_BYTES;
    do {
      k--;
      const row = rowBytes(k);
      overStructured -= row.structured;
      overText -= row.text;
    } while (k > 0 && (overStructured > 0 || overText > 0));
    size = measure(k);
  }
  while (k < count && fits(measure(k + 1))) k++;
  return k;
}
