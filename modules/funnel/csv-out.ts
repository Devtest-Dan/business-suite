/**
 * Writes CSV (RFC 4180). Cells that a spreadsheet would run as a formula
 * (starting with = + - @ or a tab) get a leading apostrophe, so an exported
 * file cannot carry a formula into someone's spreadsheet.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : Array.isArray(value) ? value.join("; ") : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
