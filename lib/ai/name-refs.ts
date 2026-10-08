import "server-only";
import { createHmac, randomBytes } from "node:crypto";

/**
 * Names the suite already knows (team members, customers' contacts and
 * companies) leave the server as references such as [name:kqxzbtpa], not as
 * the name and not as the plain [person] placeholder. The model can then ask
 * a tool about "[name:kqxzbtpa]", and the suite puts the real name back into
 * the tool's input before it runs, so a lookup by a person's name works
 * while redaction is on and the name itself never reaches the provider.
 *
 * A reference is an HMAC of the folded name under a key made when the
 * process starts: the same name gives the same reference for the whole
 * conversation, and a provider cannot test guesses against it. The stored
 * history keeps real names, so nothing depends on references surviving a
 * restart.
 */

const KEY = randomBytes(32);
const REF_RE = /\[name:([a-z]{8})\]/g;
const MIN_NAME_CHARS = 3;
const MAX_NAMES = 20_000;

export interface NameRefs {
  /** How many distinct names it knows. */
  readonly size: number;
  /** Replaces every known name in the text with its reference. */
  toRefs(text: string): string;
  /** Puts the names back in place of references; unknown references stay as they are. */
  fromRefs(text: string): string;
}

function fold(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function refFor(folded: string, salt: number): string {
  const digest = createHmac("sha256", KEY).update(`${salt}:${folded}`).digest();
  let out = "";
  for (let i = 0; i < 8; i++) out += String.fromCharCode(97 + (digest[i]! % 26));
  return `[name:${out}]`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds the reference table. Names shorter than three letters, or without a letter, are left to redaction. */
export function buildNameRefs(names: Iterable<string>): NameRefs {
  const byFolded = new Map<string, string>();
  const byRef = new Map<string, string>();
  for (const raw of names) {
    if (byFolded.size >= MAX_NAMES) break;
    const name = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
    const folded = fold(name);
    if (folded.length < MIN_NAME_CHARS || !/\p{L}/u.test(folded) || folded.startsWith("[") || byFolded.has(folded)) continue;
    let ref = refFor(folded, 0);
    for (let salt = 1; byRef.has(ref); salt++) ref = refFor(folded, salt);
    byFolded.set(folded, ref);
    byRef.set(ref, name);
  }
  // Longest first, so "Ana Reyes" wins over a contact called "Ana".
  const alternation = [...byFolded.keys()]
    .sort((a, b) => b.length - a.length)
    .map((n) => escapeRe(n).replace(/ /g, "\\s+"))
    .join("|");
  const nameRe = alternation ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, "giu") : null;

  return {
    size: byFolded.size,
    toRefs(text) {
      if (!nameRe || !text) return text;
      return text.replace(nameRe, (m) => byFolded.get(fold(m)) ?? m);
    },
    fromRefs(text) {
      if (!text || byRef.size === 0) return text;
      return text.replace(REF_RE, (m) => byRef.get(m) ?? m);
    },
  };
}

/** Applies `fn` to every string inside a JSON value (tool inputs), keeping its shape. */
export function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}
