import { z } from "zod";

/** GBrain's kinds of fact. */
export const FACT_KINDS = ["fact", "preference", "commitment", "event", "belief"] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export const FACT_KIND_LABELS: Record<FactKind, string> = {
  fact: "Fact",
  preference: "Preference",
  commitment: "Commitment",
  event: "Event",
  belief: "Belief",
};

const factText = z.string().trim().min(1, "Write the fact itself.").max(2000, "Keep one fact under 2,000 characters. Split longer notes into several facts.");
const kind = z.enum(FACT_KINDS, { message: "Pick a kind from the list." }).default("fact");
/** A path inside the suite ("/m/announcements/…"), never another site. */
const suitePath = z
  .string()
  .trim()
  .max(500)
  .regex(/^\/(?!\/)[^\s]*$/, "The link must be a page inside the suite.")
  .optional();

/** One fact, as "Remember this", the AI tool and the remember action send it. */
export const rememberInput = z.object({
  text: factText,
  kind,
  /** Where it came from, in words: "Announcements: Closed Friday". */
  from: z.string().trim().max(300, "Keep “from” under 300 characters.").default(""),
  url: suitePath,
});
export type RememberInput = z.output<typeof rememberInput>;

export const rememberForm = z.object({
  text: factText,
  kind,
  from: z.string().trim().max(300).default(""),
  url: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v && /^\/(?!\/)[^\s]*$/.test(v) ? v : undefined)),
});

export const factIdSchema = z.string().uuid("That fact id is not valid. Reload the page.");

export const correctForm = z.object({
  factId: factIdSchema,
  text: factText,
});

export const withdrawForm = z.object({
  factId: factIdSchema,
  reason: z.string().trim().max(300, "Keep the reason under 300 characters.").default(""),
});

export const chatForm = z.object({
  conversationId: z.union([z.literal(""), z.string().uuid()]).default(""),
  message: z.string().trim().min(1, "Write a question or a request.").max(4000, "Keep a message under 4,000 characters."),
});

/** "" → null; otherwise a non-negative number. */
const optionalNumber = (label: string, max: number) =>
  z
    .string()
    .trim()
    .default("")
    .transform((v, c) => {
      if (v === "") return null;
      const n = Number(v.replace(/,/g, ""));
      if (!Number.isFinite(n) || n < 0 || n > max) {
        c.addIssue({ code: "custom", message: `${label} must be a number from 0 to ${max.toLocaleString("en")}, or empty for none.` });
        return z.NEVER;
      }
      return n;
    });

export const limitsForm = z
  .object({
    monthlyTokenCap: optionalNumber("The token limit", 100_000_000_000),
    monthlySpendCap: optionalNumber("The spend limit", 1_000_000),
    pricePerMillionIn: optionalNumber("The input price", 10_000),
    pricePerMillionOut: optionalNumber("The output price", 10_000),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, "Use a three-letter currency code, e.g. USD or INR."),
    redactFacts: z
      .string()
      .optional()
      .transform((v) => v === "on"),
  })
  .superRefine((v, c) => {
    if (v.monthlySpendCap !== null && (v.pricePerMillionIn === null || v.pricePerMillionOut === null)) {
      c.addIssue({ code: "custom", path: ["monthlySpendCap"], message: "A spend limit needs both prices (from your AI provider's price page), or leave it empty." });
    }
  });

export const AGENT_DAY_CHOICES = ["7", "30", "90"] as const;

export const agentForm = z.object({
  label: z.string().trim().min(1, "Name this access so you can tell it apart later, e.g. “Claude Code on Sam's laptop”.").max(80, "Keep the name under 80 characters."),
  days: z.enum(AGENT_DAY_CHOICES, { message: "Pick 7, 30 or 90 days." }),
});

export const revokeForm = z.object({
  clientId: z.string().trim().min(1).max(200),
});

export const importForm = z.object({
  /** Pasted text; when empty, the action reads the uploaded file instead. */
  json: z.string().trim().max(5_000_000, "That export is larger than 5 MB. Ask for it in parts.").default(""),
});

// ── The AHL business-memory export, format v1 (docs/apps/assistant.md) ───────

export const AHL_EXPORT_FORMAT = "ahl-business-memory";

const historyEntry = z.object({
  text: z.string().max(4000),
  at: z.string().max(40),
  by: z.string().max(200).default(""),
});

export const ahlMemoryExport = z.object({
  format: z.literal(AHL_EXPORT_FORMAT, { message: `This is not a business-memory export: "format" must be "${AHL_EXPORT_FORMAT}".` }),
  version: z.literal(1, { message: "This export is a version this suite does not read. It reads version 1." }),
  exportedAt: z.string().max(40),
  business: z.object({ name: z.string().max(200) }).optional(),
  facts: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        text: z.string().min(1).max(4000),
        kind: z.string().max(40).default("fact"),
        source: z.string().max(40).default("owner"),
        sourceRef: z.string().max(300).optional(),
        status: z.enum(["active", "corrected", "withdrawn"]).default("active"),
        updatedAt: z.string().max(40),
        history: z.array(historyEntry).max(50).default([]),
      }),
    )
    .max(5000, "An export can hold at most 5,000 facts. Ask for it in parts."),
});
export type AhlMemoryExport = z.output<typeof ahlMemoryExport>;

/** One imported fact: the record the import's batch approval holds. */
export const importFactInput = z.object({
  externalId: z.string().min(1).max(100),
  text: z.string().trim().min(1).max(4000),
  kind: z.enum(FACT_KINDS).default("fact"),
  /** The AHL source label: interview, brief, checkin, gateway, owner, intern. */
  originalSource: z.string().max(40).default(""),
  updatedAt: z.string().max(40),
  history: z.array(historyEntry).max(50).default([]),
});
export type ImportFactInput = z.output<typeof importFactInput>;

/** The AHL source labels, as the owner reads them there. */
export const AHL_SOURCE_LABELS: Record<string, string> = {
  interview: "AHL interview",
  brief: "AHL project brief",
  checkin: "AHL weekly check-in",
  gateway: "AHL gateway read",
  owner: "Added by the owner on AHL",
  intern: "Added by the intern's agent on AHL",
};
