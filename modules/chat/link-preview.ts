import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Db } from "@/lib/db/client";
import { previewHosts } from "./data";
import type { ChatLinkPreview } from "./schema";

/**
 * Link previews, off by default. The owner lists the sites (host names) whose
 * previews are allowed in Chat → Settings. For a link to one of those, the
 * server fetches the page over HTTPS and keeps only text: the title, the
 * description and the site name. No images, no scripts, nothing from any
 * other site. Addresses inside the server's own network are refused, so a
 * link can never make the server reach a private machine.
 */

const TIMEOUT_MS = 4000;
const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 2;

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((a) => h === a || h === `www.${a}` || `www.${h}` === a);
}

/** Loopback, private, link-local, carrier-grade NAT, multicast, unspecified, and their IPv6 cousins. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff");
  }
  return true;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

function metaContent(html: string, key: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (name !== key) continue;
    const content = tag.match(/\bcontent\s*=\s*"([^"]*)"/i)?.[1] ?? tag.match(/\bcontent\s*=\s*'([^']*)'/i)?.[1];
    if (content) return decode(content);
  }
  return "";
}

/** Reads only text metadata out of a page's HTML. */
export function parseMeta(html: string): { title: string; description: string; siteName: string } {
  const head = html.slice(0, MAX_BYTES);
  const title = metaContent(head, "og:title") || decode(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  return {
    title: title.slice(0, 200),
    description: (metaContent(head, "og:description") || metaContent(head, "description")).slice(0, 300),
    siteName: metaContent(head, "og:site_name").slice(0, 80),
  };
}

async function safeHost(host: string): Promise<boolean> {
  if (isIP(host)) return !isPrivateAddress(host);
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { value, done } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

export async function fetchPreview(rawUrl: string, allowed: string[], fetcher: typeof fetch = fetch): Promise<ChatLinkPreview | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    if (!hostAllowed(url.hostname, allowed) || !(await safeHost(url.hostname))) return null;
    const res = await fetcher(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "text/html", "user-agent": "BusinessSuiteChat/1.0 (link preview)" },
    }).catch(() => null);
    if (!res) return null;
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return null;
      url = new URL(location, url);
      continue;
    }
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/html")) return null;
    const meta = parseMeta(await readCapped(res));
    if (!meta.title) return null;
    return { url: url.toString(), host: url.hostname, ...meta };
  }
  return null;
}

export async function linkPreviewFor(db: Db, rawUrl: string): Promise<ChatLinkPreview | null> {
  const allowed = await previewHosts(db);
  if (allowed.length === 0) return null;
  return fetchPreview(rawUrl, allowed);
}
