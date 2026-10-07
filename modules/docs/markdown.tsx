/**
 * A small, safe Markdown renderer for Docs, shared by the page view (server)
 * and the editor's preview (browser). It builds React elements directly, so
 * no HTML from a page is ever injected: raw HTML in the text shows as text.
 *
 * Supported: headings, paragraphs (a single line break is kept), bold,
 * italic, strikethrough, inline code, fenced code blocks, links, images,
 * bare https links, bullet / numbered / task lists (nested by indenting),
 * block quotes, tables, horizontal rules, and internal links [[Page title]]
 * or [[Page title|shown text]].
 */
import type { ReactNode } from "react";

/** Turns an internal link's title into an address. `exists: false` shows it as a link to create the page. */
export type WikiResolver = (title: string) => { href: string; exists: boolean } | null;

export interface RenderOptions {
  resolve?: WikiResolver;
}

const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i;
const SAFE_IMG = /^(https:\/\/|\/api\/files\/[0-9a-f-]{36}$)/i;

export function safeHref(url: string): string | null {
  const u = url.trim();
  return SAFE_HREF.test(u) ? u : null;
}

// ── Blocks ───────────────────────────────────────────────────────────────────

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; blocks: Block[] }
  | { t: "hr" }
  | { t: "list"; ordered: boolean; start: number; items: { task: null | boolean; text: string; children: Block[] }[] }
  | { t: "table"; align: ("left" | "center" | "right" | null)[]; head: string[]; rows: string[][] };

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line)![0];
  return m.replace(/\t/g, "  ").length;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line) || (line.includes("|") && next !== undefined && TABLE_SEP.test(next));
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  return parseLines(lines);
}

function parseLines(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++; // the closing fence (or the end)
      out.push({ t: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push({ t: "h", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) inner.push(lines[i++].replace(QUOTE, ""));
      out.push({ t: "quote", blocks: parseLines(inner) });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      out.push({ t: "table", align, head, rows });
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      const parsed = parseList(lines, i, indentOf(line), /\d/.test(li[2]));
      out.push(parsed.block);
      i = parsed.next;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++].trim());
    out.push({ t: "p", text: para.join("\n") });
  }
  return out;
}

function parseList(lines: string[], start: number, base: number, ordered: boolean): { block: Block; next: number } {
  const items: { task: null | boolean; text: string; children: Block[] }[] = [];
  let i = start;
  let first = 1;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || indentOf(lines[i]) !== base || /\d/.test(m[2]) !== ordered) break;
    if (items.length === 0 && ordered) first = parseInt(m[2], 10);
    let text = m[3];
    let task: null | boolean = null;
    const t = /^\[([ xX])\]\s+(.*)$/.exec(text);
    if (t) {
      task = t[1] !== " ";
      text = t[2];
    }
    i++;
    const textLines = [text];
    const child: string[] = [];
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        // A blank line ends the item unless the list (or the item) carries on after it.
        const nextIdx = lines.findIndex((l, k) => k > i && l.trim() !== "");
        if (nextIdx === -1 || indentOf(lines[nextIdx]) <= base) break;
        child.push("");
        i++;
        continue;
      }
      if (indentOf(line) > base) {
        if (child.length === 0 && !LIST.test(line)) textLines.push(line.trim());
        else child.push(line);
        i++;
        continue;
      }
      if (!startsBlock(line, lines[i + 1]) && child.length === 0) {
        textLines.push(line.trim()); // a lazy continuation line
        i++;
        continue;
      }
      break;
    }
    const minIndent = Math.min(...child.filter((l) => l.trim()).map(indentOf), Infinity);
    items.push({ task, text: textLines.join("\n"), children: child.length ? parseLines(child.map((l) => l.slice(Math.min(minIndent, indentOf(l))))) : [] });
    while (i < lines.length && !lines[i].trim()) {
      const nextIdx = lines.findIndex((l, k) => k > i && l.trim() !== "");
      if (nextIdx === -1) {
        i = lines.length;
        break;
      }
      const m2 = LIST.exec(lines[nextIdx]);
      if (m2 && indentOf(lines[nextIdx]) === base && /\d/.test(m2[2]) === ordered) i = nextIdx;
      else break;
    }
  }
  return { block: { t: "list", ordered, start: first, items }, next: i };
}

// ── Inline ───────────────────────────────────────────────────────────────────

const INLINE = [
  { name: "escape", re: /\\([\\`*_{}[\]()#+\-.!|~>])/y },
  { name: "code", re: /(`+)([\s\S]+?)\1/y },
  { name: "image", re: /!\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/y },
  { name: "wiki", re: /\[\[([^\]|\n]{1,200})(?:\|([^\]\n]{1,200}))?\]\]/y },
  { name: "link", re: /\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/y },
  { name: "strong", re: /(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/y },
  { name: "strike", re: /~~(?=\S)([\s\S]+?)(?<=\S)~~/y },
  { name: "em", re: /(\*|_)(?=\S)([\s\S]+?)(?<=\S)\1(?![\w*])/y },
  { name: "url", re: /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/y },
  { name: "br", re: /\n/y },
] as const;

class Keys {
  n = 0;
  next(): string {
    this.n += 1;
    return `k${this.n}`;
  }
}

function inline(text: string, opts: RenderOptions, keys: Keys): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };
  outer: while (i < text.length) {
    const ch = text[i];
    if ("\\`![*_~h\n".includes(ch)) {
      // "_" only opens emphasis at the start of a word, so snake_case stays as it is.
      if (ch === "_" && i > 0 && /\w/.test(text[i - 1])) {
        buf += ch;
        i++;
        continue;
      }
      for (const { name, re } of INLINE) {
        re.lastIndex = i;
        const m = re.exec(text);
        if (!m) continue;
        // Read the end now: the regexes are shared, and rendering a link's or
        // emphasis's text below calls inline() again, which moves lastIndex.
        const end = re.lastIndex;
        const k = keys.next();
        let node: ReactNode = null;
        switch (name) {
          case "escape":
            buf += m[1];
            i = end;
            continue outer;
          case "code":
            node = (
              <code key={k} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em]">
                {m[2].trim()}
              </code>
            );
            break;
          case "image": {
            const src = m[2].trim();
            node = SAFE_IMG.test(src) ? (
              // eslint-disable-next-line @next/next/no-img-element -- page images are user files of unknown size
              <img key={k} src={src} alt={m[1]} title={m[3]} loading="lazy" className="my-2 inline-block max-h-[32rem] max-w-full rounded border border-line" />
            ) : (
              <span key={k} className="text-subtle">
                [image: {m[1] || src}]
              </span>
            );
            break;
          }
          case "wiki": {
            const target = m[1].trim();
            const shown = (m[2] ?? m[1]).trim();
            const r = opts.resolve?.(target) ?? null;
            node = r ? (
              <a key={k} href={r.href} className={r.exists ? "link" : "link text-danger"} title={r.exists ? undefined : `No page called “${target}” yet: open to create it`} data-wiki={r.exists ? "found" : "missing"}>
                {shown}
              </a>
            ) : (
              <span key={k} className="link">
                {shown}
              </span>
            );
            break;
          }
          case "link": {
            const href = safeHref(m[2]);
            const external = href ? /^https?:/i.test(href) : false;
            node = href ? (
              <a key={k} href={href} title={m[3]} className="link" {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}>
                {inline(m[1], opts, keys)}
              </a>
            ) : (
              <span key={k}>{inline(m[1], opts, keys)}</span>
            );
            break;
          }
          case "strong":
            node = <strong key={k}>{inline(m[2], opts, keys)}</strong>;
            break;
          case "strike":
            node = <del key={k}>{inline(m[1], opts, keys)}</del>;
            break;
          case "em":
            node = <em key={k}>{inline(m[2], opts, keys)}</em>;
            break;
          case "url":
            if (i > 0 && /[\w/]/.test(text[i - 1])) continue;
            node = (
              <a key={k} href={m[0]} className="link break-all" target="_blank" rel="noopener noreferrer nofollow">
                {m[0]}
              </a>
            );
            break;
          case "br":
            node = <br key={k} />;
            break;
        }
        flush();
        out.push(node);
        i = end;
        continue outer;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

// ── Render ───────────────────────────────────────────────────────────────────

const HEADING_CLASS = ["", "text-2xl font-semibold mt-6 mb-3", "text-xl font-semibold mt-6 mb-2", "text-lg font-semibold mt-5 mb-2", "font-semibold mt-4 mb-1", "font-semibold mt-3 mb-1", "font-semibold text-muted mt-3 mb-1"];

function renderBlocks(blocks: Block[], opts: RenderOptions, keys: Keys): ReactNode[] {
  return blocks.map((b) => {
    const k = keys.next();
    switch (b.t) {
      case "h": {
        const Tag = `h${Math.min(b.level + 1, 6)}` as "h2";
        return (
          <Tag key={k} className={HEADING_CLASS[b.level]}>
            {inline(b.text, opts, keys)}
          </Tag>
        );
      }
      case "p":
        return (
          <p key={k} className="my-3 leading-relaxed">
            {inline(b.text, opts, keys)}
          </p>
        );
      case "code":
        return (
          <pre key={k} className="my-3 overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-sm leading-snug" data-lang={b.lang || undefined}>
            <code>{b.text}</code>
          </pre>
        );
      case "quote":
        return (
          <blockquote key={k} className="my-3 border-l-4 border-line pl-4 text-muted">
            {renderBlocks(b.blocks, opts, keys)}
          </blockquote>
        );
      case "hr":
        return <hr key={k} className="my-6 border-line" />;
      case "table":
        return (
          <div key={k} className="my-3 overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  {b.head.map((c, ci) => (
                    <th key={ci} style={b.align[ci] ? { textAlign: b.align[ci]! } : undefined}>
                      {inline(c, opts, keys)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {b.head.map((_, ci) => (
                      <td key={ci} style={b.align[ci] ? { textAlign: b.align[ci]! } : undefined}>
                        {inline(r[ci] ?? "", opts, keys)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "list": {
        const items = b.items.map((it, ii) => (
          <li key={ii} className={it.task !== null ? "list-none" : undefined}>
            {it.task !== null ? <input type="checkbox" checked={it.task} disabled readOnly className="mr-2 size-4 align-[-2px]" aria-label={it.task ? "Done" : "Not done"} /> : null}
            {inline(it.text, opts, keys)}
            {it.children.length ? renderBlocks(it.children, opts, keys) : null}
          </li>
        ));
        return b.ordered ? (
          <ol key={k} start={b.start !== 1 ? b.start : undefined} className="my-3 list-decimal space-y-1 pl-6">
            {items}
          </ol>
        ) : (
          <ul key={k} className="my-3 list-disc space-y-1 pl-6">
            {items}
          </ul>
        );
      }
    }
  });
}

export function Markdown({ text, resolve, className }: { text: string; resolve?: WikiResolver; className?: string }) {
  const nodes = renderBlocks(parseBlocks(text), { resolve }, new Keys());
  return <div className={`break-words ${className ?? ""}`}>{nodes}</div>;
}

/** Renders one line of inline Markdown (used for procedure steps). */
export function InlineMarkdown({ text, resolve }: { text: string; resolve?: WikiResolver }) {
  return <>{inline(text, { resolve }, new Keys())}</>;
}

// ── Links between pages ──────────────────────────────────────────────────────

const WIKI_ALL = /\[\[([^\]|\n]{1,200})(?:\|[^\]\n]{1,200})?\]\]/g;
const PAGE_URL = /\/m\/docs\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** The internal links in a page's text: [[titles]] and direct page addresses. Code blocks are ignored. */
export function extractLinks(text: string): { titles: string[]; ids: string[] } {
  const withoutCode = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, "");
  const titles = new Set<string>();
  const ids = new Set<string>();
  for (const m of withoutCode.matchAll(WIKI_ALL)) titles.add(m[1].trim());
  for (const m of withoutCode.matchAll(PAGE_URL)) ids.add(m[1].toLowerCase());
  return { titles: [...titles], ids: [...ids] };
}

/** Plain text of a page's Markdown, for snippets and the AI (markers removed, links kept as their text). */
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, s) => s ?? t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[*_~`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
