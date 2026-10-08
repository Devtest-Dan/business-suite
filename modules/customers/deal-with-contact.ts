import "server-only";
import { UserError } from "@/lib/errors";
import type { ApplyContext, ApplyResult } from "@/lib/modules/contract";
import { contactValues, getContact, listStages, possibleMatches, saveContact, saveDeal, userIdByEmail } from "./data";
import { describeMerge, emailKey, findMatch, mergeContact, nameKey, phoneKey, planMerge } from "./dedupe";
import type { DealWithContactInput } from "./schemas";

/**
 * The approved "add a deal with its contact" (customers.create_deal), used by
 * other apps such as Leads. The contact goes through the same duplicate
 * detection as an import (same email, then phone, then name): a match is
 * merged (blanks filled, nothing overwritten), otherwise a contact is added.
 * The deal goes into the first open stage, with the source in its notes.
 */
export async function applyDealWithContact(ctx: ApplyContext, input: DealWithContactInput): Promise<ApplyResult> {
  const by = ctx.requestedBy ?? ctx.approver;
  const sourceKey = `${ctx.approvalId}:${ctx.dedupeKey}`;
  const ownerId = (await userIdByEmail(ctx.tx, input.ownerEmail)) ?? by.id;
  const stage = (await listStages(ctx.tx)).find((s) => s.kind === "open");
  if (!stage) throw new UserError("The pipeline has no open stage to put the deal in. Add one in Customers → Pipeline and fields.");

  const { ownerEmail: _contactOwner, ...incoming } = input.contact;
  void _contactOwner;
  const match = findMatch(
    incoming,
    await possibleMatches(ctx.tx, {
      emails: [emailKey(incoming.email)].filter(Boolean),
      phones: [phoneKey(incoming.phone)].filter(Boolean),
      names: [nameKey(incoming.name)].filter(Boolean),
    }),
  );

  let contactId: string;
  let who: string;
  const current = match ? await getContact(ctx.tx, match.contact.id) : null;
  if (match && current) {
    const before = contactValues(current);
    const plan = planMerge(before, incoming);
    if (plan.filled.length || plan.tagsAdded.length || plan.notesAppended) await saveContact(ctx.tx, mergeContact(before, incoming), by, current.id);
    contactId = current.id;
    who = `the existing contact ${current.name} (same ${match.by}; ${describeMerge(plan)})`;
  } else {
    const made = await saveContact(ctx.tx, { ...incoming, ownerId }, by, null, { sourceKey, via: ctx.calledBy ?? ctx.source });
    contactId = made.id;
    who = `the new contact ${made.name}`;
  }

  const notes = [input.notes.trim(), input.source.trim() ? `Source: ${input.source.trim()}` : ""].filter(Boolean).join("\n\n");
  const deal = await saveDeal(
    ctx.tx,
    { title: input.title, stageId: stage.id, contactId, companyId: null, valueCents: input.valueCents, expectedClose: null, notes, custom: {}, ownerId },
    by,
    null,
    { sourceKey },
  );
  return { targetId: deal.id, summary: `Added the deal “${deal.title}” in ${stage.name} for ${who}` };
}
