import "server-only";
import type { ModuleContext } from "@/lib/modules/contract";
import { addActivity, insertFollowUp, listStages, saveContact, saveDeal, todayIn } from "./data";

/**
 * Demo data, clearly invented: every name says "(example)" and carries the
 * tag "example", and every email uses example.com (a domain reserved for
 * examples). The owner deletes them, or filters by the tag, when real
 * customers arrive.
 */
export async function seedExamples(ctx: ModuleContext): Promise<void> {
  const by = ctx.viewer;
  const stages = await listStages(ctx.db);
  const stage = (i: number) => stages[Math.min(i, stages.length - 1)].id;
  const base = { address: "", tags: ["example"], custom: {}, ownerId: by.id };

  const ana = await saveContact(ctx.db, { ...base, name: "Ana Example", email: "ana@example.com", phone: "555 0100", jobTitle: "Office manager", companyName: "Riverside Cafe (example)", notes: "Invented contact to show how Customers works. Delete it when you add real customers." }, by, null);
  const ben = await saveContact(ctx.db, { ...base, name: "Ben Example", email: "ben@example.com", phone: "555 0101", jobTitle: "Owner", companyName: "Hilltop Builders (example)", notes: "" }, by, null);
  const cara = await saveContact(ctx.db, { ...base, name: "Cara Example", email: "cara@example.com", phone: "", jobTitle: "Buyer", companyName: "Riverside Cafe (example)", notes: "" }, by, null);
  await saveContact(ctx.db, { ...base, name: "Dev Example", email: "dev@example.com", phone: "555 0103", jobTitle: "", companyName: "", notes: "A contact without a company." }, by, null);

  const catering = await saveDeal(ctx.db, { title: "Weekly catering order (example)", stageId: stage(2), contactId: ana.id, companyId: null, valueCents: 120_000, expectedClose: null, notes: "", custom: {}, ownerId: by.id }, by, null);
  await saveDeal(ctx.db, { title: "Office fit-out (example)", stageId: stage(1), contactId: ben.id, companyId: null, valueCents: 450_000, expectedClose: null, notes: "", custom: {}, ownerId: by.id }, by, null);
  await saveDeal(ctx.db, { title: "Coffee machine service (example)", stageId: stage(0), contactId: cara.id, companyId: null, valueCents: null, expectedClose: null, notes: "", custom: {}, ownerId: by.id }, by, null);

  await addActivity(ctx.db, { kind: "call", body: "Called about the weekly order. They want a quote for Mondays and Thursdays. (example)", contactId: ana.id, companyId: null, dealId: null }, by);
  await addActivity(ctx.db, { kind: "email", body: "Sent the quote by email. (example)", contactId: null, companyId: null, dealId: catering.id }, by);
  await addActivity(ctx.db, { kind: "meeting", body: "Site visit to measure the office. (example)", contactId: ben.id, companyId: null, dealId: null }, by);

  const inThreeDays = todayIn(ctx.business.timezone, new Date(Date.now() + 3 * 86_400_000));
  await insertFollowUp(ctx.db, { title: "Ask Ana if the quote works (example)", notes: "", dueOn: inThreeDays, contactId: ana.id, companyId: null, dealId: null, assigneeId: by.id }, by);
}
