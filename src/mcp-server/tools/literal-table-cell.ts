/**
 * @fileoverview Literal Markdown table cells for EIA and SQL query results.
 * @module mcp-server/tools/literal-table-cell
 */

/** Preserve values as text, escaping source markup before inserting line breaks. */
export function literalTableCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()|~]/g, '\\$&')
    .replace(/\r\n|\r|\n/g, '<br>');
}
