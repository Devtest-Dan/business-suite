import { describe, expect, it } from "vitest";
import { isRedactionPlaceholder, redactForMemory, redactIdentifiersOnly, redactPii, redactPiiBatch } from "@/lib/redact";
import golden from "./fixtures/otto-redaction-golden.json";

/**
 * Otto's own cases. The fixture was recorded by running Otto's Python
 * (control-plane/ingest_cp.py, regex floor only: OTTO_PII_REDACTION=1,
 * OTTO_NER_REDACTION=0) over:
 *  - every labelled case in test_redaction_eval.py CASES (the eight that need
 *    the NER model are listed as skipped: there is no model here), and
 *  - every redact call test_intake_redaction.py makes.
 * The port must give the same output byte for byte, and every labelled
 * case's must_absent / must_present expectations are checked as Otto wrote
 * them. No expectation was changed; the one output difference is the phone
 * fix described at ottoWithPhoneFix.
 */
type EvalCase =
  | { name: string; skipped: string }
  | { name: string; text: string; must_absent: string[]; must_present: string[]; output: string };

const evalCases = golden.evalCases as EvalCase[];

/**
 * The one deliberate change from Otto (see PHONE_RE in lib/redact.ts): an
 * international number no longer swallows the space or full stop after it.
 * Otto's output for these inputs is "[PHONE]anytime" / "[PHONE] I want";
 * ours keeps the separator. Same things redacted either way.
 */
function ottoWithPhoneFix(output: string): string {
  return output
    .replace("[PHONE]anytime.", "[PHONE] anytime.")
    .replace("or [PHONE] I want help", "or [PHONE]. I want help");
}
const floorCalls = golden.floorCalls as Array<{ source: string; input: string; output: string }>;

describe("Otto test_redaction_eval CASES (regex floor)", () => {
  const runnable = evalCases.filter((c): c is Extract<EvalCase, { text: string }> => "text" in c);

  it("ports every case that does not need the NER model", () => {
    expect(runnable.length).toBeGreaterThanOrEqual(80);
    expect(evalCases.filter((c) => "skipped" in c).map((c) => c.name)).toEqual([
      "ner-only-single-name",
      "brand-bigram-survives",
      "ampersand-business-with-proprietor",
      "person-context-beats-ner",
      "contact-label-beats-ner",
      "self-contradiction-dropped",
      "newline-person-context",
      "single-token-business-no-shield",
    ]);
  });

  it.each(runnable.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const got = redactPii(c.text);
    for (const raw of c.must_absent) expect(got, `must_absent ${raw}`).not.toContain(raw);
    for (const biz of c.must_present) expect(got, `must_present ${biz}`).toContain(biz);
    expect(got).toBe(ottoWithPhoneFix(c.output));
  });
});

describe("Otto floor outputs, byte for byte", () => {
  it.each(floorCalls.map((c, i) => [`${c.source} #${i}`, c] as const))("%s", (_label, c) => {
    expect(redactPii(c.input)).toBe(ottoWithPhoneFix(c.output));
  });
});

describe("Otto test_intake_redaction expectations", () => {
  it("strips email, phone and the person but keeps the business name", () => {
    const sent = redactPii(
      "Hi, I run Bloom Beauty Studio, a hair salon in Bandra, Mumbai. " +
        "I'm Priya Sharma — reach me at priya.sharma@example.com or +91 98765 43210. " +
        "I want help getting more bookings.",
    );
    expect(sent).not.toContain("priya.sharma@example.com");
    expect(sent).not.toContain("98765 43210");
    expect(sent).not.toContain("Priya Sharma");
    expect(sent).toContain("Bloom Beauty Studio");
  });

  it("keeps a name introduced by 'called' and by 'business is called'", () => {
    const naming = redactPii("I run a small home-based cupcake bakery called Sugar Loop, and I need help with marketing.");
    expect(naming).toContain("Sugar Loop");
    expect(naming).not.toContain("[NAME]");
    expect(redactPii("my business is called Sugar Loop")).toContain("Sugar Loop");
  });

  it("turns PAN, SSN and a spaced card into tokens", () => {
    expect(redactPii("His PAN is ABCPS1234K for verification.")).toBe("His PAN is [ID] for verification.");
    expect(redactPii("SSN on file: 123-45-6789.")).toBe("SSN on file: [ID].");
    expect(redactPii("Card on file: 4111 1111 1111 1111.")).toBe("Card on file: [CARD].");
  });

  it("propagates a redacted first name to a later lone mention", () => {
    const out = redactPii("Priya Sharma runs the front desk. Ask Priya about refunds.");
    expect(out).not.toContain("Priya");
  });
});

describe("our cases", () => {
  it("redacts US and India phone formats", () => {
    expect(redactPii("Call (415) 555-2671 or 415.555.2671")).toBe("Call [PHONE] or [PHONE]");
    expect(redactPii("WhatsApp +91 98765 43210 or 022-2604-1234")).toBe("WhatsApp [PHONE] or [PHONE]");
  });

  it("leaves dates, money and short counts alone", () => {
    const text = "On 2026-10-07 we sold 45 cakes for $1,250.";
    expect(redactPii(text)).toBe(text);
  });

  it("keeps UUIDs intact", () => {
    const id = "f4356025-7021-46a0-9c1d-1234567890ab";
    expect(redactPii(`fact ${id} saved`)).toBe(`fact ${id} saved`);
  });

  it("redacts Aadhaar-shaped ids and street addresses", () => {
    expect(redactIdentifiersOnly("Aadhaar 1234 5678 9012")).toBe("Aadhaar [ID]");
    expect(redactPii("Deliveries go to 17 Hill Street on Tuesday.")).toBe("Deliveries go to [ADDRESS] on Tuesday.");
  });

  it("protects the business's own name even without a business word", () => {
    expect(redactPii("Maruti Suzuki opens at nine.")).toBe("[NAME] opens at nine.");
    expect(redactPii("Maruti Suzuki opens at nine.", { protectedNames: ["Maruti Suzuki"] })).toBe(
      "Maruti Suzuki opens at nine.",
    );
  });

  it("an explicit person signal still beats a protected name", () => {
    expect(redactPii("My name is Maruti Suzuki", { protectedNames: ["Maruti Suzuki"] })).toBe("My name is [NAME]");
  });

  it("batch form runs the same floor per item", () => {
    expect(redactPiiBatch(["a@b.co", "Dana Whitfield"])).toEqual(["[EMAIL]", "[NAME]"]);
  });

  it("knows an exact placeholder from a sentence that contains one", () => {
    expect(isRedactionPlaceholder(" [NAME] ")).toBe(true);
    expect(isRedactionPlaceholder("Call [NAME] today")).toBe(false);
    expect(isRedactionPlaceholder(null)).toBe(false);
  });
});

describe("redactForMemory", () => {
  it("uses plain placeholders and counts what it removed", () => {
    const r = redactForMemory("Email Dana Whitfield at dana@shop.com or call 415-555-2671.");
    expect(r.text).toBe("Email [person] at [email] or call [phone].");
    expect(r.counts).toEqual({ person: 1, email: 1, phone: 1 });
    expect(r.total).toBe(3);
  });

  it("removes secrets before the digit rules can see them", () => {
    const r = redactForMemory("The key is sk-live_abcdefghijklmnop1234567890 for the store.");
    expect(r.text).not.toContain("abcdefghijklmnop");
    expect(r.text).toContain("[secret]");
    expect(r.counts.secret).toBe(1);
  });

  it("leaves ordinary business facts unchanged", () => {
    const text = "Orders over $200 ship free. The shop closes at 6 pm on Sundays.";
    const r = redactForMemory(text);
    expect(r.text).toBe(text);
    expect(r.total).toBe(0);
  });

  it("is idempotent on its own output", () => {
    const once = redactForMemory("Card 4111 1111 1111 1111, owner Priya Sharma").text;
    expect(redactForMemory(once).text).toBe(once);
  });

  it("card numbers and India ids get their own placeholders", () => {
    const r = redactForMemory("PAN ABCPS1234K, card 4111111111111111");
    expect(r.text).toBe("PAN [id number], card [card number]");
  });
});
