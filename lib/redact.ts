import { scanSecrets } from "@/lib/secret-scan";

/**
 * The redaction pattern stage (pure, deterministic). Copied unchanged from the
 * AI Harness Labs app's lib/redact.ts (our own code). In the suite it runs
 * before any text is sent to the AI provider (lib/ai/client.ts), when
 * Settings → AI → "Redact personal details" is on, so emails, phone numbers,
 * card numbers, government ids, street addresses and person names never leave
 * the server.
 *
 * A port of the regex floor of Otto's control-plane/ingest_cp.py
 * (`_redact_regex_floor`, `redact_pii`, `redact_pii_batch` and their helpers),
 * the founder's own code. Ported: every pattern, the order they run in, the
 * UUID shield and the business-name protection (business words, naming
 * phrases, self-declarations, localities, kept-name spans during
 * propagation). Not ported: the local NER model call (there is no model
 * server here yet) and Otto's on/off master switch (redaction is always on).
 * Otto's `ner_protected` list is kept as `protectedNames`: the app passes the
 * business's own name, which it knows for certain, so the owner's brand is
 * never turned into a placeholder.
 *
 * Two layers: `redactPii()` returns Otto's own tokens ([NAME], [EMAIL], ...)
 * so the ported tests keep Otto's expectations byte for byte;
 * `redactForMemory()` adds the secret scan, turns the tokens into the plain
 * placeholders the owner sees ([person], [email], ...) and counts them.
 */

// ── Small regex helpers (Python `re` semantics in JS) ────────────────────────

/** re.sub with a callback that sees the ORIGINAL string, like Python's m.string. */
function sub(re: RegExp, text: string, fn: (m: RegExpExecArray) => string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += text.slice(last, m.index) + fn(m as RegExpExecArray);
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

/** Python's pattern.match(s, pos): anchored at pos. `re` must carry the sticky flag. */
function matchAt(re: RegExp, s: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(s);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive spelling of a lowercase word, for one alternation inside a case-sensitive pattern. */
function ci(word: string): string {
  return word.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
}

function capitalize(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

function byLengthDesc(words: Iterable<string>): string[] {
  return [...words].sort((a, b) => b.length - a.length);
}

// ── Tokens ───────────────────────────────────────────────────────────────────

/** Every bracket token the floor emits (Otto's PII_REDACTION_TOKENS). */
export const PII_REDACTION_TOKENS = ["NAME", "PHONE", "EMAIL", "CARD", "ADDRESS", "ID", "LONGNUM"] as const;
export type PiiToken = (typeof PII_REDACTION_TOKENS)[number];
const PII_REDACTION_TOKEN_RE = new RegExp(`^\\[(${PII_REDACTION_TOKENS.join("|")})\\]$`);

/** True when the value is exactly one placeholder token and nothing else (Otto's is_redaction_placeholder). */
export function isRedactionPlaceholder(value: string | null | undefined): boolean {
  if (!value) return false;
  return PII_REDACTION_TOKEN_RE.test(value.trim());
}

// ── Identifiers ──────────────────────────────────────────────────────────────

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// International (+CC-NNN-NNN), US (NNN-NNN-NNNN) and parenthesized area code.
// One change from Otto: the optional last group needs at least one digit
// (Otto's \d{0,5} let it swallow the space after a number: "[PHONE]or").
const PHONE_RE = new RegExp(
  "(?:" +
    "\\+\\d{1,3}[\\s\\-.]?\\d{3,5}[\\s\\-.]?\\d{3,5}(?:[\\s\\-.]?\\d{1,5})?" +
    "|\\b\\d{3}[\\s.\\-]\\d{3}[\\s.\\-]\\d{4}\\b" +
    "|(?<!\\d)(?:\\+\\d{1,3}[\\s\\-.]?)?\\(\\d{3}\\)[\\s\\-.]?\\d{3}[\\s\\-.]?\\d{4}(?!\\d)" +
    ")",
  "g",
);

// Anchored on the value's own character class so a glued label ("panFGHIJ5678K") cannot hide it.
const PAN_RE = /(?<![A-Z0-9])[A-Z]{5}[0-9]{4}[A-Z](?![A-Z0-9])/g; // Indian PAN
const AADHAAR_RE = /(?<!\d)\d{4}[ -]\d{4}[ -]\d{4}(?!\d)/g; // Indian Aadhaar
const SSN_RE = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g; // US SSN

const CARD_CANDIDATE_RE = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;

/** Exactly 16 contiguous digits, or 13–19 digits with at least one space/dash between groups. */
export function redactCardNumbers(text: string): string {
  return sub(CARD_CANDIDATE_RE, text, (m) => {
    const span = m[0];
    const hasSep = span.includes(" ") || span.includes("-");
    const digits = span.replace(/[ -]/g, "");
    if (digits.length === 16 && !hasSep) return "[CARD]";
    if (hasSep && digits.length >= 13 && digits.length <= 19) return "[CARD]";
    return span;
  });
}

const DIGIT_RUN_CANDIDATE_RE = /(?<!\d)\(?\d+\)?(?:[ \-.]\(?\d+\)?)*(?!\d)/g;

/** Any digit-group run with 9–15 digits in total is phone-shaped; dates (8) and long references (16+) are left alone. */
function redactDigitRunPhones(text: string): string {
  return sub(DIGIT_RUN_CANDIDATE_RE, text, (m) => {
    const digits = m[0].replace(/\D/g, "");
    return digits.length >= 9 && digits.length <= 15 ? "[PHONE]" : m[0];
  });
}

// Uppercase only, so "invoice", "order" and "account" stay words.
const INVOICE_ID_RE = /\b(?:INV|ORD|REF|TXN|ACC)[\s-]?[A-Z0-9]{2,}\b/g;
const LONGNUM_RE = /\b\d{7,}\b/g;

// ── Addresses ────────────────────────────────────────────────────────────────

const ADDRESS_LABEL_RE = /\b(Address|Addr|Located at|Location)\s*[:-]\s*(.*)$/gm;
// Words that start ordinary prose: the address tail never steps over one (Otto #274).
const ADDR_PROSE_STOP = [
  "on", "for", "and", "so", "but", "or", "then", "because", "if",
  "before", "after", "until", "till", "when", "while", "who", "which", "whose", "that",
  "today", "tomorrow", "yesterday", "tonight", "asap",
  "please", "thanks", "thank", "instead",
];
const ADDRESS_STREET_RE = new RegExp(
  "\\d{1,4}[\\w/-]*(?:\\s+(?:[A-Z][\\w.]*\\s+){0,3}|\\s*,\\s+(?:[A-Z][\\w.]*\\s+){1,3})" +
    "(?:Road|Rd|Street|St|Lane|Ln|Avenue|Ave|Marg|Nagar|Colony|Sector|Block|Highway|Cross|Main)\\b" +
    `(?:(?!\\s+(?:${ADDR_PROSE_STOP.map(ci).join("|")})\\b)[^,\\n]){0,40}`,
  "g",
);
const PIN_RE = /\b\d{6}\b/g;
const INDIAN_CITY_WORDS = new Set([
  "mumbai", "delhi", "bangalore", "bengaluru", "chennai", "kolkata",
  "hyderabad", "pune", "ahmedabad", "jaipur", "lucknow", "surat",
  "andheri", "bandra", "gurgaon", "gurugram", "noida", "thane",
]);
const CITY_WORD_RE = new RegExp(`\\b(?:${byLengthDesc(INDIAN_CITY_WORDS).join("|")})\\b`, "i");

/** Label lines, freestanding street patterns, and a 6-digit PIN fold only on lines that already carry address context. */
function redactAddresses(text: string): string {
  text = sub(ADDRESS_LABEL_RE, text, (m) => `${m[1]}: [ADDRESS]`);
  text = text.replace(ADDRESS_STREET_RE, "[ADDRESS]");
  return text
    .split("\n")
    .map((line) => (!line.includes("[ADDRESS]") && !CITY_WORD_RE.test(line) ? line : line.replace(PIN_RE, "[ADDRESS]")))
    .join("\n");
}

// ── Person names ─────────────────────────────────────────────────────────────

const NAME_RE = /\b([A-Z][a-z]{1,20})\s+([A-Z][a-z]{1,20})\b/g;

// Sentence-initial business verbs that are never plausible first names ("Invoice Dana Whitfield").
const SAFE_LEAD_VERBS = [
  "invoice", "email", "call", "text", "remind", "charge", "refund", "schedule", "notify",
  "tell", "ask", "send", "book", "message", "contact", "pay", "invite",
  "reply", "write", "ping", "forward", "confirm", "cancel", "quote",
];
const SENTENCE_START = "(?:^|(?<=[.!?]\\s)|(?<=\\n))";
const SAFE_LEAD_VERB_RE = new RegExp(`${SENTENCE_START}(${byLengthDesc(SAFE_LEAD_VERBS).map(capitalize).join("|")})\\b`, "g");
const SAFE_LEAD_VERB_LONE_NAME_RE = new RegExp(
  `${SENTENCE_START}(?:${byLengthDesc(SAFE_LEAD_VERBS).join("|")})\\s+([A-Z][a-z]{1,20})\\b(?!\\s+[A-Z])`,
  "g",
);
const RESTORE_LEAD_VERB_RE = new RegExp(`${SENTENCE_START}(${byLengthDesc(SAFE_LEAD_VERBS).join("|")})\\b`, "g");

const DANGLING_NAME_RE = /\[NAME\][ \t]+([A-Z][a-z]{1,20})\b/g;
const NAME_LIST_RE = /\[NAME\]([ \t]*,[ \t]*(?:and[ \t]+)?|[ \t]+and[ \t]+)([A-Z][a-z]{1,20})\b/g;

// Business, venue and legal words: a bigram ending in, or followed by, one of these is a business name.
const BIZ_WORDS = new Set([
  "studio", "studios", "salon", "spa", "clinic", "dental", "garage", "motor", "motors",
  "bakery", "cafe", "café", "bistro", "restaurant", "kitchen", "bar", "pub",
  "store", "stores", "shop", "boutique", "mart", "market", "company", "group",
  "holdings", "enterprises", "enterprise", "industries", "industry", "solutions",
  "service", "services", "systems",
  "technologies", "labs", "academy", "school", "institute", "agency", "consulting",
  "partners", "associates", "ventures", "food", "foods", "tailors", "trader", "traders", "trading",
  "wellness", "fitness", "gym", "nails", "beauty", "hair", "decor",
  "produce", "farm", "farms", "dairy", "marts", "suppliers", "supply", "supplies", "wholesale",
  "grocer", "grocers", "markets", "good", "goods", "hardware", "textile", "textiles", "logistic", "logistics",
  "distributor", "distributors", "export", "exports", "import", "imports",
  "grocery", "groceries", "salons", "clinics", "garages", "bakeries",
  "cafes", "restaurants",
  "church", "churches", "ministry", "ministries", "congregation", "congregations",
  "parish", "parishes", "chapel", "chapels", "fellowship", "temple", "temples",
  "synagogue", "synagogues", "mosque", "mosques", "cathedral", "cathedrals",
]);
const BIZ_ALT_CAPITALIZED = byLengthDesc(BIZ_WORDS).map(capitalize).join("|");
const BIZ_FOLLOW_RE = new RegExp(`\\s+(?:${BIZ_ALT_CAPITALIZED})\\b`, "y");

// "called"/"named" count only after a business noun; person roles are deliberately absent.
const BIZ_CONTEXT_WORDS = [
  "business", "company", "shop", "store", "brand", "startup", "venture",
  "label", "product", "app", "bakery", "salon", "studio", "clinic",
  "garage", "cafe", "café", "restaurant", "boutique", "agency", "firm",
  "practice", "stall", "outlet", "grocery", "mart",
];
const BIZ_INTRO_RE = new RegExp(
  "(?:" +
    `\\b(?:${byLengthDesc(BIZ_CONTEXT_WORDS).join("|")})\\b` +
    "\\s*(?:is\\s+)?(?:called|named)" +
    "|\\bbusiness\\s+name\\s+is" +
    "|\\bshop\\s+is" +
    "|\\bbrand\\b" +
    ")" +
    "\\s*['\"“‘]?\\s*$",
  "i",
);

const LOCALITY_DIRECTIONS = new Set(["east", "west", "north", "south"]);

// "I run Priya Stitches", "my business is Sugar Loop" (never "we are", which takes a person).
const BIZ_SELF_DECLARE_RE = /(?:\b(?:I|we)\s+(?:run|own)|\b(?:my|our)\s+business\s+is)\s*['"“‘]?\s*$/i;
const BIZ_SELF_DECLARE_AND_PERSON_RE = /\s+and\s+[A-Z]/y;
const BIZ_SELF_DECLARE_COMMA_RE = /\s*,\s*/y;

/** False when what follows a self-declared bigram introduces a person ("and Rahul", ", our newest hire"). */
function forwardDeclareFollowsOk(s: string, end: number): boolean {
  if (matchAt(BIZ_SELF_DECLARE_AND_PERSON_RE, s, end)) return false;
  const comma = matchAt(BIZ_SELF_DECLARE_COMMA_RE, s, end);
  if (comma) {
    const after = comma.index + comma[0].length;
    const clause = s.slice(after, after + 80).split(/[.,]|\band\b/)[0];
    const tokens = clause.split(/\s+/).filter(Boolean);
    if (!tokens.some((tok) => BIZ_WORDS.has(tok.replace(/^[.,!?"']+|[.,!?"']+$/g, "").toLowerCase()))) return false;
  }
  return true;
}

// "Sugar Loop is our bakery": the business word must end the noun phrase.
const BIZ_SELF_DECLARE_FOLLOW_RE = new RegExp(
  `\\s+is\\s+(?:my|our)\\s+(?:\\w+\\s+){0,2}(?:${byLengthDesc(BIZ_WORDS).join("|")})\\b(?=[,.]|\\s+and\\b|\\s*$)`,
  "iy",
);

// An explicit person signal in the text outweighs a protected-name hit.
const PERSON_CONTEXT_PRECEDING_RE =
  /(?:I'm|I am|my name is|name's|Mr\.?|Mrs\.?|Ms\.?|Dr\.?|contact(?:\s+person)?\s*(?:is|[:-])|reach\s+(?:me|out\s+to)|call\s+me)\s*$/i;
const PERSON_CONTEXT_POSSESSIVE_RE = /^['’]s\b/;

function hasPersonContext(text: string, start: number, end: number): boolean {
  const preceding = text.slice(Math.max(0, start - 25), start).replace(/\n/g, " ");
  if (PERSON_CONTEXT_PRECEDING_RE.test(preceding)) return true;
  return PERSON_CONTEXT_POSSESSIVE_RE.test(text.slice(end, end + 3));
}

const LEGAL_SUFFIX_RE = /\b(?:Inc|Ltd|LLC|Pvt|Co)\.?\b/;

/** A labelled value counts as a business only with its own signal: a business word, an ampersand or a legal suffix. */
function hasBusinessCorroboration(value: string): boolean {
  const tokens = value.match(/[A-Za-z]+/g) ?? [];
  if (tokens.some((tok) => BIZ_WORDS.has(tok.toLowerCase()))) return true;
  if (value.includes("&")) return true;
  return LEGAL_SUFFIX_RE.test(value);
}

function spansOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** All case-insensitive occurrences of `needle` (no word boundary; ≥3 chars). */
function substringSpansCi(text: string, needle: string): Array<[number, number]> {
  if (!needle || needle.length < 3) return [];
  const textL = text.toLowerCase();
  const needleL = needle.toLowerCase();
  const spans: Array<[number, number]> = [];
  let start = 0;
  for (;;) {
    const idx = textL.indexOf(needleL, start);
    if (idx === -1) break;
    spans.push([idx, idx + needle.length]);
    start = idx + 1;
  }
  return spans;
}

function isKeepWord(tok: string): boolean {
  const t = tok.toLowerCase();
  return BIZ_WORDS.has(t) || LOCALITY_DIRECTIONS.has(t) || INDIAN_CITY_WORDS.has(t);
}

/**
 * Capitalized-bigram person names, keeping business and brand names; then
 * propagation of a redacted name's tokens to later lone mentions, never
 * inside a name this pass kept or a protected name.
 */
function redactPersonNames(text: string, protectedNames: readonly string[] = []): string {
  const redactedTokens = new Set<string>();
  const keptBusinessSpans: string[] = [];

  text = sub(SAFE_LEAD_VERB_RE, text, (m) => m[1].charAt(0).toLowerCase() + m[1].slice(1));

  // Only a multi-word protected name can shield a whole bigram.
  const bigramProtected = protectedNames.filter((b) => b.split(/\s+/).filter(Boolean).length >= 2);
  const protectedSpansPre: Array<[number, number]> = [];
  for (const biz of bigramProtected) protectedSpansPre.push(...substringSpansCi(text, biz));

  text = sub(SAFE_LEAD_VERB_LONE_NAME_RE, text, (m) => {
    const tok = m[1];
    if (isKeepWord(tok)) {
      keptBusinessSpans.push(m[0]);
      return m[0];
    }
    if (tok.length >= 3) redactedTokens.add(tok);
    return m[0].slice(0, m[0].length - tok.length) + "[NAME]";
  });

  text = sub(NAME_RE, text, (m) => {
    const s = m.input;
    const start = m.index;
    const end = start + m[0].length;
    const [, first, second] = m;
    const protectedHit = protectedSpansPre.some(([ps, pe]) => spansOverlap(start, end, ps, pe));
    if (protectedHit && !hasPersonContext(s, start, end)) return m[0];
    if (
      (LOCALITY_DIRECTIONS.has(second.toLowerCase()) ||
        INDIAN_CITY_WORDS.has(first.toLowerCase()) ||
        INDIAN_CITY_WORDS.has(second.toLowerCase())) &&
      !hasPersonContext(s, start, end)
    ) {
      return m[0];
    }
    if (BIZ_WORDS.has(second.toLowerCase())) {
      keptBusinessSpans.push(m[0]);
      return m[0];
    }
    const follow = matchAt(BIZ_FOLLOW_RE, s, end);
    if (follow) {
      keptBusinessSpans.push(s.slice(start, follow.index + follow[0].length));
      return m[0];
    }
    const before = s.slice(0, start);
    if (BIZ_INTRO_RE.test(before)) {
      keptBusinessSpans.push(m[0]);
      return m[0];
    }
    if (BIZ_SELF_DECLARE_RE.test(before) && forwardDeclareFollowsOk(s, end)) {
      keptBusinessSpans.push(m[0]);
      return m[0];
    }
    if (matchAt(BIZ_SELF_DECLARE_FOLLOW_RE, s, end)) {
      keptBusinessSpans.push(m[0]);
      return m[0];
    }
    for (const tok of [first, second]) {
      if (tok.length >= 3 && !isKeepWord(tok)) redactedTokens.add(tok);
    }
    return "[NAME]";
  });

  // A 3+ word run ("Dana Marie Whitfield") leaves its tail dangling after [NAME].
  for (;;) {
    const next = sub(DANGLING_NAME_RE, text, (m) => {
      const tok = m[1];
      if (isKeepWord(tok)) return m[0];
      if (tok.length >= 3) redactedTokens.add(tok);
      return "[NAME]";
    });
    if (next === text) break;
    text = next;
  }

  // Name lists: "[NAME] and Priya", "[NAME], Priya, and Sam".
  for (;;) {
    const next = sub(NAME_LIST_RE, text, (m) => {
      const [, connector, tok] = m;
      if (isKeepWord(tok) || matchAt(BIZ_FOLLOW_RE, m.input, m.index + m[0].length)) return m[0];
      if (tok.length >= 3) redactedTokens.add(tok);
      return "[NAME]" + connector + "[NAME]";
    });
    if (next === text) break;
    text = next;
  }

  if (redactedTokens.size > 0) {
    const protectedSpans: Array<[number, number]> = [];
    for (const biz of keptBusinessSpans) {
      let start = 0;
      for (;;) {
        const idx = text.indexOf(biz, start);
        if (idx === -1) break;
        protectedSpans.push([idx, idx + biz.length]);
        start = idx + 1;
      }
    }
    for (const biz of bigramProtected) protectedSpans.push(...substringSpansCi(text, biz));
    const propagate = new RegExp(`\\b(?:${byLengthDesc(redactedTokens).map(escapeRe).join("|")})\\b`, "g");
    text = sub(propagate, text, (m) => {
      const start = m.index;
      const end = start + m[0].length;
      return protectedSpans.some(([ps, pe]) => start < pe && ps < end) ? m[0] : "[NAME]";
    });
  }

  return sub(RESTORE_LEAD_VERB_RE, text, (m) => capitalize(m[1]));
}

// "Manager: Rajesh", "Contact person: Anita Desai": the single-token case the bigram cannot form.
const LABELED_NAME_RE =
  /\b(Manager|Owner|Proprietor|Founder|Director|Contact person|Contact|Attn|Attention|Name)\s*[:-]\s*([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)/g;

function redactLabeledNames(text: string, protectedNames: readonly string[] = []): string {
  const protectedSpans: Array<[number, number]> = [];
  for (const biz of protectedNames) protectedSpans.push(...substringSpansCi(text, biz));
  return sub(LABELED_NAME_RE, text, (m) => {
    const valueEnd = m.index + m[0].length;
    const valueStart = valueEnd - m[2].length;
    const protectedHit = protectedSpans.some(([ps, pe]) => spansOverlap(valueStart, valueEnd, ps, pe));
    if (protectedHit && hasBusinessCorroboration(m[2])) return m[0];
    const lastToken = m[2].split(" ").at(-1)!.toLowerCase();
    if (BIZ_WORDS.has(lastToken)) return m[0];
    if (matchAt(BIZ_FOLLOW_RE, m.input, valueEnd)) return m[0];
    return `${m[1]}: [NAME]`;
  });
}

// ── The floor ────────────────────────────────────────────────────────────────

/** Emails, government/financial ids, cards, phones, invoice ids, long numbers and addresses; no name passes. */
export function redactIdentifiersOnly(text: string): string {
  text = text.replace(EMAIL_RE, "[EMAIL]");
  text = text.replace(PAN_RE, "[ID]");
  text = text.replace(SSN_RE, "[ID]");
  // Card before Aadhaar: a 4-4-4-4 card must not lose 12 digits to the Aadhaar shape.
  text = redactCardNumbers(text);
  text = text.replace(AADHAAR_RE, "[ID]");
  text = text.replace(PHONE_RE, "[PHONE]");
  text = redactDigitRunPhones(text);
  text = text.replace(INVOICE_ID_RE, "[ID]");
  text = text.replace(LONGNUM_RE, "[LONGNUM]");
  return redactAddresses(text);
}

// A UUID is an internal reference, not personal data; three digit rules would mangle it.
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

function lettersIndex(i: number): string {
  return String(i)
    .split("")
    .map((d) => String.fromCharCode(65 + Number(d)))
    .join("");
}

/** The deterministic floor: identifiers, then bigram names, then labelled names, with UUIDs shielded throughout. */
export function redactPii(text: string, options: { protectedNames?: readonly string[] } = {}): string {
  const protectedNames = options.protectedNames ?? [];
  const uuids: string[] = [];
  text = text.replace(UUID_RE, (u) => {
    uuids.push(u);
    return `ZUUIDZ${lettersIndex(uuids.length - 1)}ZENDZ`;
  });
  text = redactIdentifiersOnly(text);
  text = redactPersonNames(text, protectedNames);
  text = redactLabeledNames(text, protectedNames);
  uuids.forEach((u, i) => {
    text = text.split(`ZUUIDZ${lettersIndex(i)}ZENDZ`).join(u);
  });
  return text;
}

/** Batch form (Otto's redact_pii_batch): the same floor per item. */
export function redactPiiBatch(items: readonly string[], options: { protectedNames?: readonly string[] } = {}): string[] {
  return items.map((item) => redactPii(item, options));
}

// ── The memory stage ─────────────────────────────────────────────────────────

/** Otto's tokens → the placeholders an owner reads in "What your agent knows". */
const FRIENDLY: Record<PiiToken, string> = {
  NAME: "[person]",
  EMAIL: "[email]",
  PHONE: "[phone]",
  CARD: "[card number]",
  ID: "[id number]",
  LONGNUM: "[number]",
  ADDRESS: "[address]",
};
export type RedactionKind = "person" | "email" | "phone" | "card" | "id" | "number" | "address" | "secret";
const KIND_OF: Record<PiiToken, RedactionKind> = {
  NAME: "person",
  EMAIL: "email",
  PHONE: "phone",
  CARD: "card",
  ID: "id",
  LONGNUM: "number",
  ADDRESS: "address",
};
export type RedactionCounts = Partial<Record<RedactionKind, number>>;

const TOKEN_RE = new RegExp(`\\[(${PII_REDACTION_TOKENS.join("|")})\\]`, "g");

function countTokens(text: string): Map<PiiToken, number> {
  const counts = new Map<PiiToken, number>();
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[1] as PiiToken;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

/**
 * The stage every business-memory write goes through: secrets first (so a
 * key's digits never look like a phone), then the Otto floor, then the plain
 * placeholders. Counts say what was removed, never what it was.
 * `protectedNames` should hold the business's own name.
 */
export function redactForMemory(
  text: string,
  options: { protectedNames?: readonly string[] } = {},
): { text: string; counts: RedactionCounts; total: number } {
  const { redacted, findings } = scanSecrets("memory", text);
  let secrets = 0;
  let out = redacted.replace(/\[REDACTED [^\]]+\]/g, () => {
    secrets += 1;
    return "[secret]";
  });
  const before = countTokens(out);
  out = redactPii(out, options);
  const after = countTokens(out);
  const counts: RedactionCounts = {};
  let total = 0;
  for (const [token, n] of after) {
    const added = n - (before.get(token) ?? 0);
    if (added > 0) {
      const kind = KIND_OF[token];
      counts[kind] = (counts[kind] ?? 0) + added;
      total += added;
    }
  }
  if (secrets > 0 || findings.length > 0) {
    counts.secret = Math.max(secrets, findings.length);
    total += counts.secret;
  }
  out = out.replace(TOKEN_RE, (_m, t: PiiToken) => FRIENDLY[t]);
  return { text: out, counts, total };
}
