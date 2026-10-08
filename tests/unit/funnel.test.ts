import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approve, canDecide, propose } from "@/lib/approvals/ledger";
import { moduleContext } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { approvalItems, moduleState, notifications } from "@/lib/db/schema";
import type { ModuleContext, Viewer } from "@/lib/modules/contract";
import { permissionsFor } from "@/lib/permissions";
import { matchRoute } from "@/lib/modules/routing";
import { setSetting } from "@/lib/settings";
import { getContact, listStages, saveContact, setDealStage } from "@/modules/customers/data";
import { dealWithContactInput } from "@/modules/customers/schemas";
import { convertLead, CUSTOMERS_OFF, dealInputFor } from "@/modules/funnel/convert";
import { createLead, getLead, logContact, saveSettings, setStatus, waiting, type NewLead } from "@/modules/funnel/data";
import { formHtml, hostedPage, iframeSnippet } from "@/modules/funnel/embed";
import { planLeadImport } from "@/modules/funnel/import";
import { emailFooter, formatMinutes, median, renderTemplate, unknownPlaceholders } from "@/modules/funnel/logic";
import { funnel } from "@/modules/funnel/manifest";
import { formPage, RATE_LIMITS, submitForm, unsubscribe } from "@/modules/funnel/public";
import { funnelReport } from "@/modules/funnel/report";
import { formConfigForm, publicSubmission, sequenceForm } from "@/modules/funnel/schemas";
import { funnelEnrollments, funnelForms, funnelLeads, funnelSends } from "@/modules/funnel/schema";
import { NO_ADDRESS_MESSAGE, proposeEnrollment, saveSequence, sendDueEmails, setSequenceActive, unsubscribeToken, verifyUnsubscribeToken } from "@/modules/funnel/sequences";
import { countRows, makeUser, resetDb } from "./helpers";
import { mailText, startSmtpCatcher } from "./smtp-catcher";

const TABLES =
  "funnel_rate_hits, funnel_sends, funnel_enrollments, funnel_sequence_steps, funnel_sequences, funnel_lead_events, funnel_leads, funnel_forms, funnel_settings, customers_saved_filters, customers_fields, customers_follow_ups, customers_activities, customers_deals, customers_stages, customers_contacts, customers_companies";

let catcher: Awaited<ReturnType<typeof startSmtpCatcher>>;

beforeAll(async () => {
  catcher = await startSmtpCatcher();
});
afterAll(async () => {
  await catcher.close();
});

async function reset() {
  await db().execute(sql.raw(`truncate table ${TABLES} restart identity cascade`));
  await resetDb();
  catcher.messages.length = 0;
  await setSetting("business", { name: "Greenleaf Lawn Care", timezone: "America/Chicago", logoFileId: null }, null);
  await setSetting("smtp", { host: "127.0.0.1", port: catcher.port, secure: false, user: "", password: null, from: "Greenleaf <hello@greenleaf.test>" }, null);
}

const ctxOf = (v: Viewer, id = "funnel"): Promise<ModuleContext> => moduleContext(id, v);

async function makeForm(owner: Viewer, extra: Partial<typeof funnelForms.$inferInsert> = {}) {
  const ctx = await ctxOf(owner);
  const input = formConfigForm.parse({
    name: "Website contact",
    heading: "Ask for a quote",
    field_email: "on",
    field_phone: "on",
    field_message: "on",
    field_service: "on",
    services: "Lawn care\nHedge trimming",
    consentText: "I agree that Greenleaf may contact me about my enquiry.",
    active: "on",
  });
  const { saveForm } = await import("@/modules/funnel/data");
  const form = await saveForm(ctx, input);
  if (Object.keys(extra).length) await db().update(funnelForms).set(extra).where(eq(funnelForms.id, form.id));
  return (await db().select().from(funnelForms).where(eq(funnelForms.id, form.id)))[0];
}

function post(slug: string, fields: Record<string, string>, ip = "203.0.113.7") {
  const body = new URLSearchParams(fields).toString();
  return submitForm(new Request(`https://suite.test/api/m/funnel/f/${slug}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip, "content-length": String(body.length) }, body }), {
    moduleId: "funnel",
    params: { slug },
  });
}

const visitor = { name: "Ana Reyes", email: "ana@example.test", phone: "", message: "Front and back lawn, weekly.", service: "Lawn care", consent: "on", utm_source: "google", utm_medium: "cpc", utm_campaign: "spring", page_url: "https://greenleaf.test/contact" };

const manual = (over: Partial<NewLead> = {}): NewLead => ({ name: "Bo Lee", email: "bo@example.test", phone: "", company: "", message: "", service: "Hedge trimming", contactMethod: "", source: "phone", sourceDetail: "", assigneeId: null, ...over });

describe("pure parts", () => {
  it("renders templates, footers and durations", () => {
    expect(renderTemplate("Hi {first_name}, about {service} — {business_name}", { first_name: "Ana", business_name: "Greenleaf", service: "" })).toBe("Hi Ana, about what you asked about — Greenleaf");
    expect(unknownPlaceholders("Hi {first_name} {firstname}")).toEqual(["firstname"]);
    expect(emailFooter("Greenleaf", "1 Main St, Austin, TX 78701", "https://x/u")).toContain("1 Main St, Austin, TX 78701");
    expect(formatMinutes(0.4)).toBe("under a minute");
    expect(formatMinutes(75)).toBe("1 h 15 min");
    expect(formatMinutes(60 * 26)).toBe("1 d 2 h");
    expect(median([5, 1, 3])).toBe(3);
    expect(median([])).toBeNull();
  });

  it("checks a public submission against what the form shows", () => {
    const schema = publicSubmission({ fields: ["email", "phone", "service"], services: ["Lawn care"] });
    expect(schema.safeParse({ name: "Ana", email: "ana@example.test", consent: "on" }).success).toBe(true);
    expect(schema.safeParse({ name: "Ana", consent: "on" }).success).toBe(false); // neither email nor phone
    expect(schema.safeParse({ name: "Ana", email: "ana@example.test" }).success).toBe(false); // no consent
    expect(schema.safeParse({ name: "Ana", email: "ana@example.test", consent: "on", service: "Roofing" }).success).toBe(false);
    // A field the form does not show is dropped, never stored.
    const r = schema.parse({ name: "Ana", email: "ana@example.test", consent: "on", company: "Sneaky Co" });
    expect(r.company).toBe("");
  });

  it("escapes everything put into the public HTML", () => {
    const html = hostedPage("<b>Biz</b>", { slug: "abcdefgh", heading: "<script>x</script>", fields: ["email"], services: [], consentText: "I \"agree\"" }, { values: { name: '"><img src=x>' } });
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain('"><img src=x>');
    expect(html).toContain("&lt;b&gt;Biz&lt;/b&gt;");
    expect(formHtml({ slug: "abcdefgh", heading: "", fields: ["email"], services: [], consentText: "ok" }, "/x")).toContain('name="website"');
    expect(iframeSnippet("https://suite.test", "abcdefgh")).toContain("https://suite.test/api/m/funnel/f/abcdefgh");
  });

  it("refuses unknown placeholders and days out of order in a sequence", () => {
    const bad = sequenceForm.safeParse({ name: "S", step_1_day: "0", step_1_subject: "Hi {firstname}", step_1_body: "x" });
    expect(bad.success).toBe(false);
    const order = sequenceForm.safeParse({ name: "S", step_1_day: "3", step_1_subject: "a", step_1_body: "a", step_2_day: "1", step_2_subject: "b", step_2_body: "b" });
    expect(order.success).toBe(false);
    const ok = sequenceForm.parse({ name: "S", step_1_day: "0", step_1_subject: "a", step_1_body: "a", step_2_day: "", step_2_subject: "", step_2_body: "" });
    expect(ok.steps).toHaveLength(1);
  });

  it("the public addresses answer GET and POST on one path (the shell matches the path first, then the method)", () => {
    const form = matchRoute(funnel.api!, ["f", "abcdefgh"]);
    expect(form?.route.methods).toEqual(["GET", "POST"]);
    expect(form?.route.auth).toBe("self");
    expect(matchRoute(funnel.api!, ["f", "abcdefgh", "thanks"])?.route.methods).toEqual(["GET"]);
    expect(matchRoute(funnel.api!, ["unsubscribe", "tok"])?.route.methods).toEqual(["GET", "POST"]);
    const csv = matchRoute(funnel.api!, ["report-csv"])?.route;
    expect(csv?.auth === "session" && csv.permission).toBe("funnel.access");
  });

  it("the conversion payload parses against Customers' create_deal schema", () => {
    const lead = { id: "x", name: "Ana Reyes", email: "ana@example.test", phone: "(512) 555-0101", company: "", message: "Weekly", service: "Lawn care", source: "form", sourceDetail: "Website contact", utmSource: "google", utmMedium: "", utmCampaign: "spring", pageUrl: "" };
    const parsed = dealWithContactInput.parse(dealInputFor(lead as never, "owner@example.test"));
    expect(parsed.title).toBe("Lawn care: Ana Reyes");
    expect(parsed.source).toContain("utm_source=google");
  });
});

describe("Leads with a real database", () => {
  beforeEach(reset);

  it("the public form: a valid submission becomes a lead with its source and alerts the right people", async () => {
    const owner = await makeUser("owner", "Olive Owner");
    const member = await makeUser("member", "Mo Member");
    const form = await makeForm(owner);

    const page = await formPage(new Request(`https://suite.test/api/m/funnel/f/${form.slug}?utm_source=google`), { moduleId: "funnel", params: { slug: form.slug } });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("Greenleaf Lawn Care");
    expect(html).toContain('name="utm_source" value="google"');
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors *");

    const res = await post(form.slug, visitor);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/api/m/funnel/f/${form.slug}/thanks`);
    const [lead] = await db().select().from(funnelLeads);
    expect(lead).toMatchObject({ name: "Ana Reyes", source: "form", sourceDetail: "Website contact", utmSource: "google", utmCampaign: "spring", pageUrl: "https://greenleaf.test/contact", status: "new", service: "Lawn care" });
    expect(lead.consentText).toContain("Greenleaf may contact me");
    // Unassigned: everyone holding "new-lead alerts" (owner and admin by default) hears about it, members do not.
    const notes = await db().select().from(notifications).where(eq(notifications.kind, "funnel.new_lead"));
    expect(notes.map((n) => n.userId)).toEqual([owner.id]);
    expect(notes[0].title).toBe("New lead: Ana Reyes");
    // It is in "what needs me" for the owner, not for a member it is not assigned to.
    expect((await funnel.needsMe!(await ctxOf(owner)))[0].title).toBe("New lead: Ana Reyes");
    expect(await funnel.needsMe!(await ctxOf(member))).toEqual([]);
  });

  it("the public form: the honeypot, card numbers, size, a switched-off form and the rate limit", async () => {
    const owner = await makeUser("owner");
    const form = await makeForm(owner);
    await post(form.slug, { ...visitor, name: "Earlier Lead", email: "earlier@example.test" }, "198.51.100.1");

    const bot = await post(form.slug, { ...visitor, website: "http://spam.example" }, "198.51.100.2");
    expect(bot.status).toBe(303);
    const card = await post(form.slug, { ...visitor, message: "Pay with 4111 1111 1111 1111" }, "198.51.100.3");
    expect(card.status).toBe(400);
    const cardHtml = await card.text();
    expect(cardHtml).toContain("This looks like a payment card number");
    expect(cardHtml).not.toContain("Earlier Lead"); // never shows another lead
    const big = await post(form.slug, { ...visitor, message: "x".repeat(20_000) }, "198.51.100.4");
    expect(big.status).toBe(413);
    expect(await countRows("funnel_leads")).toBe(1);

    for (let i = 0; i < RATE_LIMITS.perAddress.max; i++) expect((await post(form.slug, { ...visitor, email: `r${i}@example.test` }, "192.0.2.9")).status).toBe(303);
    // The address has used up its window: refused, and nothing stored.
    const refused = await post(form.slug, { ...visitor, email: "later@example.test" }, "192.0.2.9");
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain("Wait ten minutes");
    expect(await countRows("funnel_leads")).toBe(1 + RATE_LIMITS.perAddress.max);
    expect(await countRows("funnel_rate_hits")).toBeGreaterThan(0);
    const hits = await db().execute<{ bucket: string }>(sql`select bucket from funnel_rate_hits`);
    expect(hits.some((h) => h.bucket.includes("192.0.2.9"))).toBe(false); // addresses are hashed

    await db().update(funnelForms).set({ active: false }).where(eq(funnelForms.id, form.id));
    expect((await post(form.slug, visitor, "192.0.2.50")).status).toBe(404);
  });

  it("speed to lead: logging the first contact, the target, statuses", async () => {
    const owner = await makeUser("owner");
    await saveSettings(await ctxOf(owner), { targetMinutes: 15, postalAddress: "" });
    const lead = await createLead(db(), manual(), owner);
    await db().update(funnelLeads).set({ createdAt: new Date(Date.now() - 22 * 60_000) }).where(eq(funnelLeads.id, lead.id));
    const before = (await getLead(db(), lead.id))!;
    const w = waiting(before, 15);
    expect(w.over).toBe(true);
    expect(Math.round(w.minutes!)).toBe(22);

    const first = await logContact(db(), lead.id, "call", "Left details", owner);
    expect(first.first).toBe(true);
    const after = (await getLead(db(), lead.id))!;
    expect(after.status).toBe("contacted");
    expect(waiting(after, 15)).toMatchObject({ contacted: true, over: true });
    expect((await logContact(db(), lead.id, "email", "", owner)).first).toBe(false);

    await expect(setStatus(db(), lead.id, "disqualified", "", owner)).rejects.toThrow("Say why");
    await setStatus(db(), lead.id, "qualified", "", owner);
    expect((await getLead(db(), lead.id))!.qualifiedAt).not.toBeNull();
    await db().update(funnelLeads).set({ status: "converted" }).where(eq(funnelLeads.id, lead.id));
    await expect(setStatus(db(), lead.id, "new", "", owner)).rejects.toThrow("already converted");
  });

  it("converts through Customers' write action: an existing contact is merged, a deal goes in the first open stage", async () => {
    const owner = await makeUser("owner");
    const member = await makeUser("member", "Mo Member");
    const existing = await saveContact(db(), { name: "Ana R.", email: "ANA@example.test", phone: "", jobTitle: "", companyName: "", address: "", notes: "", tags: [], custom: {}, ownerId: null }, owner, null);
    const lead = await createLead(db(), manual({ name: "Ana Reyes", email: "ana@example.test", phone: "+1 512 555 0101", service: "Lawn care", source: "form", sourceDetail: "Website contact", utmSource: "google" }), null);

    const out = await convertLead(await ctxOf(member), lead.id);
    expect(out.state).toBe("converted");
    const after = (await getLead(db(), lead.id))!;
    expect(after.status).toBe("converted");
    expect(after.customerContactId).toBe(existing.id);
    expect(await countRows("customers_contacts")).toBe(1);
    const merged = await getContact(db(), existing.id);
    expect(merged?.phone).toBe("+1 512 555 0101"); // filled in, nothing overwritten
    const [deal] = await db().execute<{ id: string; title: string; notes: string; stage: string }>(sql`select d.id, d.title, d.notes, s.name as stage from customers_deals d join customers_stages s on s.id = d.stage_id`);
    expect(deal.id).toBe(after.customerDealId);
    expect(deal.title).toBe("Lawn care: Ana Reyes");
    expect(deal.stage).toBe((await listStages(db())).find((s) => s.kind === "open")!.name);
    expect(deal.notes).toContain("utm_source=google");

    // Again: nothing new.
    expect((await convertLead(await ctxOf(member), lead.id)).state).toBe("converted");
    expect(await countRows("customers_deals")).toBe(1);

    // Customers switched off: conversion is unavailable, with the reason.
    const other = await createLead(db(), manual({ name: "Cy", email: "cy@example.test" }), owner);
    await db().insert(moduleState).values({ moduleId: "customers", enabled: false });
    await expect(convertLead(await ctxOf(owner), other.id)).rejects.toThrow(CUSTOMERS_OFF);
  });

  it("sequences: no postal address blocks them; ONE approval; sent once even if approved twice; unsubscribe and replies stop them", async () => {
    const owner = await makeUser("owner", "Olive Owner");
    const admin = await makeUser("admin");
    const ctx = await ctxOf(owner);
    const seq = await saveSequence(
      ctx,
      sequenceForm.parse({
        name: "New enquiry",
        step_1_day: "0",
        step_1_subject: "Thanks, {first_name}",
        step_1_body: "Hi {first_name}, thanks for asking {business_name} about {service}.",
        step_2_day: "3",
        step_2_subject: "Still need {service}?",
        step_2_body: "Hi again {first_name}.",
      }),
    );
    await expect(setSequenceActive(ctx, seq.id, true)).rejects.toThrow(NO_ADDRESS_MESSAGE);
    await saveSettings(ctx, { targetMinutes: 15, postalAddress: "1200 Oak Street, Austin, TX 78701" });
    await setSequenceActive(ctx, seq.id, true);

    const ana = await createLead(db(), manual({ name: "Ana Reyes", email: "ana@example.test", service: "Lawn care" }), null);
    const bo = await createLead(db(), manual({ name: "Bo Lee", email: "bo@example.test" }), null);
    const noEmail = await createLead(db(), manual({ name: "Cy", email: "", phone: "+1 512 555 0199" }), null);
    const proposal = await proposeEnrollment(ctx, seq.id, [ana.id, bo.id, noEmail.id]);
    expect(proposal.accepted).toBe(2);
    expect(proposal.skipped[0]).toContain("no email");
    expect(await countRows("approvals")).toBe(1);
    expect(await countRows("funnel_enrollments")).toBe(0); // nothing until approved

    const [a, b] = await Promise.all([approve(proposal.approvalId!, owner), approve(proposal.approvalId!, admin)]);
    expect(a.appliedNow + b.appliedNow).toBe(2);
    expect((await approve(proposal.approvalId!, owner)).appliedNow).toBe(0);
    expect(await countRows("funnel_enrollments")).toBe(2);
    expect(await countRows("funnel_sends")).toBe(4);
    // Proposing the same again is left out by the ledger.
    await expect(proposeEnrollment(ctx, seq.id, [ana.id])).rejects.toThrow("already enrolled");

    // Two runs at once: each due email goes out once, over real SMTP.
    const [x, y] = await Promise.all([sendDueEmails(), sendDueEmails()]);
    expect(x + y).toBe(2);
    expect(await sendDueEmails()).toBe(0);
    expect(catcher.messages).toHaveLength(2);
    const toAna = catcher.messages.find((m) => m.to.join().includes("ana@example.test"))!;
    const text = mailText(toAna);
    expect(toAna.data).toContain("Subject: Thanks, Ana");
    expect(text).toContain("thanks for asking Greenleaf Lawn Care about Lawn care");
    expect(text).toContain("1200 Oak Street, Austin, TX 78701");
    const link = text.match(/https:\/\/suite\.test\/api\/m\/funnel\/unsubscribe\/(\S+)/);
    expect(link).not.toBeNull();
    expect(verifyUnsubscribeToken(link![1])).toBe(ana.id);
    expect(verifyUnsubscribeToken(`${bo.id}.${link![1].split(".")[1]}`)).toBeNull(); // a signature is per lead

    // Ana unsubscribes through the link; Bo replies. Three days later neither gets email 2.
    const res = await unsubscribe(new Request(`https://suite.test/api/m/funnel/unsubscribe/${link![1]}`, { method: "POST" }), { moduleId: "funnel", params: { token: link![1] } });
    expect(res.status).toBe(200);
    expect((await getLead(db(), ana.id))!.unsubscribedAt).not.toBeNull();
    await logContact(db(), bo.id, "call", "Called back", owner);
    expect(await sendDueEmails({ now: new Date(Date.now() + 4 * 86_400_000) })).toBe(0);
    expect(catcher.messages).toHaveLength(2);
    const enrollments = await db().select().from(funnelEnrollments);
    expect(enrollments.every((e) => e.status === "stopped")).toBe(true);
    const cancelled = await db().select().from(funnelSends).where(eq(funnelSends.status, "cancelled"));
    expect(cancelled).toHaveLength(2);
    // A forged token changes nothing.
    expect(verifyUnsubscribeToken(unsubscribeToken(bo.id).replace(/.$/, "x"))).toBeNull();
  });

  it("a later email goes out on its day; the AI's status change waits for approval", async () => {
    const owner = await makeUser("owner");
    const ctx = await ctxOf(owner);
    await saveSettings(ctx, { targetMinutes: 15, postalAddress: "PO Box 12, Austin, TX 78701" });
    const seq = await saveSequence(ctx, sequenceForm.parse({ name: "Two", step_1_day: "0", step_1_subject: "One", step_1_body: "1", step_2_day: "2", step_2_subject: "Two", step_2_body: "2" }));
    await setSequenceActive(ctx, seq.id, true);
    const lead = await createLead(db(), manual({ name: "Dee Day", email: "dee@example.test" }), null);
    const { approvalId } = await proposeEnrollment(ctx, seq.id, [lead.id]);
    await approve(approvalId!, owner);
    expect(await sendDueEmails()).toBe(1);
    expect(await sendDueEmails({ now: new Date(Date.now() + 1 * 86_400_000) })).toBe(0);
    expect(await sendDueEmails({ now: new Date(Date.now() + 2 * 86_400_000 + 60_000) })).toBe(1);
    expect((await db().select().from(funnelEnrollments))[0].status).toBe("finished");

    const ai = await propose({ action: "funnel.update_lead_status", items: [{ leadId: lead.id, leadName: "Dee Day", status: "disqualified", reason: "Outside our area" }], source: "ai", requestedBy: owner });
    expect((await getLead(db(), lead.id))!.status).toBe("new");
    await approve(ai.approvalId!, owner);
    expect((await getLead(db(), lead.id))!).toMatchObject({ status: "disqualified", disqualifyReason: "Outside our area" });
  });

  it("permissions: members work leads, owners and admins manage, guests get nothing", async () => {
    const [member, guest, admin] = [await permissionsFor("member"), await permissionsFor("guest"), await permissionsFor("admin")];
    expect([...member].filter((p) => p.startsWith("funnel.")).sort()).toEqual(["funnel.access", "funnel.work"]);
    expect([...admin].filter((p) => p.startsWith("funnel.")).sort()).toEqual(["funnel.access", "funnel.alerts", "funnel.import", "funnel.manage", "funnel.work"]);
    expect([...guest].filter((p) => p.startsWith("funnel."))).toEqual([]);
    const g = await makeUser("guest");
    const m = await makeUser("member");
    const lead = await createLead(db(), manual(), null);
    const proposal = await propose({ action: "funnel.update_lead_status", items: [{ leadId: lead.id, status: "contacted" }], source: "ai", requestedBy: g });
    expect(await canDecide(g, { action: "funnel.update_lead_status", requestedBy: g.id })).toBe(false);
    expect(await canDecide(m, { action: "funnel.update_lead_status", requestedBy: m.id })).toBe(true);
    await expect(approve(proposal.approvalId!, g)).rejects.toThrow("cannot decide");
    // A guest's assistant cannot read leads at all.
    const gctx = await ctxOf(g);
    expect(await funnel.knownNames!(gctx)).toEqual([]);
    expect(await funnel.needsMe!(gctx)).toEqual([]);
  });

  it("the funnel report counts each step, won deals from Customers and the median speed", async () => {
    const owner = await makeUser("owner");
    const ctx = await ctxOf(owner);
    const base = Date.now() - 2 * 60 * 60_000;
    const mk = async (over: Partial<NewLead>, minutesToContact: number | null) => {
      const l = await createLead(db(), manual({ source: "form", sourceDetail: "Website contact", ...over }), null);
      await db()
        .update(funnelLeads)
        .set({ createdAt: new Date(base), firstContactAt: minutesToContact === null ? null : new Date(base + minutesToContact * 60_000) })
        .where(eq(funnelLeads.id, l.id));
      return l;
    };
    const a = await mk({ name: "A One", email: "a@example.test", utmSource: "google" }, 10);
    const b = await mk({ name: "B Two", email: "b@example.test", utmSource: "google" }, 30);
    await mk({ name: "C Three", email: "c@example.test" }, null);
    await mk({ name: "D Four", email: "d@example.test", source: "phone", sourceDetail: "" }, 0);
    await setStatus(db(), a.id, "qualified", "", owner);
    await setStatus(db(), b.id, "qualified", "", owner);
    await convertLead(ctx, a.id);
    await convertLead(ctx, b.id);
    const won = (await listStages(db())).find((s) => s.kind === "won")!;
    const dealA = (await getLead(db(), a.id))!.customerDealId!;
    await db().execute(sql`update customers_deals set value_cents = 125000 where id = ${dealA}`);
    await setDealStage(db(), dealA, won.id, owner);

    const r = await funnelReport(ctx, { from: "", to: "", group: "source" });
    expect(r.wonKnown).toBe(true);
    expect(r.total).toMatchObject({ leads: 4, contacted: 3, qualified: 2, converted: 2, won: 1, wonValueCents: 125000 });
    expect(r.total.medianMinutes).toBe(10);
    const web = r.rows.find((x) => x.label === "Web form “Website contact”")!;
    expect(web).toMatchObject({ leads: 3, contacted: 2, converted: 2, won: 1, medianMinutes: 20 });
    const byUtm = await funnelReport(ctx, { from: "", to: "", group: "utm_source" });
    expect(byUtm.rows.find((x) => x.label === "google")).toMatchObject({ leads: 2, won: 1 });
    // A range with nothing in it.
    expect((await funnelReport(ctx, { from: "2020-01-01", to: "2020-01-31", group: "source" })).total.leads).toBe(0);
  });

  it("the AI read tools and the import (one approval, duplicates left out)", async () => {
    const owner = await makeUser("owner");
    const ctx = await ctxOf(owner);
    await createLead(db(), manual({ name: "Old Lead", email: "old@example.test" }), null);
    const tool = funnel.aiTools!.find((t) => t.name === "new_leads")!;
    if (tool.kind !== "read") throw new Error("expected a read tool");
    const out = (await tool.run(ctx, tool.input.parse({}) as never)) as { leads: { name: string }[] };
    expect(out.leads.map((l) => l.name)).toEqual(["Old Lead"]);
    const summary = funnel.aiTools!.find((t) => t.name === "funnel_summary")!;
    if (summary.kind !== "read") throw new Error("expected a read tool");
    expect(((await summary.run(ctx, summary.input.parse({}) as never)) as { total: { leads: number } }).total.leads).toBe(1);
    expect(await funnel.knownNames!(ctx)).toContain("Old Lead");

    const plan = await planLeadImport(db(), "name,email,phone\nNew One,new1@example.test,\nAgain,NEW1@example.test,\nOld,old@example.test,\nNo Contact,,\nCard,card@example.test,4111 1111 1111 1111\n");
    expect(plan.items.map((i) => i.name)).toEqual(["New One"]);
    expect(plan.duplicatesInFile).toBe(1);
    expect(plan.alreadyHere).toBe(1);
    expect(plan.invalid).toHaveLength(2);
    const { approvalId } = await propose({ action: "funnel.import_lead", items: plan.items, source: "import", requestedBy: owner });
    await approve(approvalId!, owner);
    await approve(approvalId!, owner);
    expect(await countRows("funnel_leads")).toBe(2);
    const [item] = await db().select().from(approvalItems).where(eq(approvalItems.approvalId, approvalId!));
    expect(item.status).toBe("applied");
  });
});
