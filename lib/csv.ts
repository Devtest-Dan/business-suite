/**
 * A small CSV reader (RFC 4180: quoted fields, doubled quotes, newlines inside
 * quotes). The first row is the header; names are trimmed and lower-cased.
 */
export function parseCsv(text: string): { header: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }
  const nonEmpty = records.filter((r) => r.some((f) => f.trim() !== ""));
  const [head, ...body] = nonEmpty;
  if (!head) return { header: [], rows: [] };
  const header = head.map((h) => h.trim().toLowerCase());
  return {
    header,
    rows: body.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()]))),
  };
}
