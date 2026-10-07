"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { complete, resolveAi } from "@/lib/ai/client";
import { audit, userActor } from "@/lib/audit";
import { seedModules } from "@/lib/auth/accounts";
import { requirePermission } from "@/lib/auth/session";
import { seal } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { moduleState, rolePermissions, type Role } from "@/lib/db/schema";
import { UserError } from "@/lib/errors";
import { isTimezone } from "@/lib/format";
import { formAction } from "@/lib/forms";
import { sendMail } from "@/lib/mail";
import { findModule } from "@/lib/modules/registry-access";
import { allPermissions } from "@/lib/permissions";
import { aiSchema, businessSchema, smtpSchema, testEmailSchema } from "@/lib/schemas";
import { getSetting, setSetting } from "@/lib/settings";
import { deleteStoredFile, saveFile } from "@/lib/storage";

const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

export const saveBusiness = formAction(businessSchema, async ({ name, timezone }, formData) => {
  const viewer = await requirePermission("settings.manage");
  if (!isTimezone(timezone)) throw new UserError("Choose a timezone from the list.");
  const current = await getSetting("business");
  let logoFileId = current.logoFileId;
  const logo = formData.get("logo");
  if (logo instanceof File && logo.size > 0) {
    if (!LOGO_TYPES.includes(logo.type)) throw new UserError("The logo must be a PNG, JPEG, WebP or SVG image.");
    if (logo.size > 2 * 1024 * 1024) throw new UserError("The logo must be smaller than 2 MB.");
    const saved = await saveFile({ name: logo.name, mime: logo.type, bytes: new Uint8Array(await logo.arrayBuffer()), isPublic: true }, viewer.id);
    if (current.logoFileId) await deleteStoredFile(current.logoFileId).catch(() => {});
    logoFileId = saved.id;
  }
  if (formData.get("removeLogo") === "on" && current.logoFileId) {
    await deleteStoredFile(current.logoFileId).catch(() => {});
    logoFileId = null;
  }
  await setSetting("business", { name, timezone, logoFileId }, viewer.id);
  await audit({ actor: userActor(viewer), action: "settings.business", summary: `${viewer.name} updated the business details.` });
  refresh();
  return { ok: "Saved." };
});

export const saveAi = formAction(aiSchema, async (input) => {
  const viewer = await requirePermission("settings.ai");
  const current = await getSetting("ai");
  const apiKey = input.clearKey === "on" ? null : input.apiKey ? seal(input.apiKey) : current.apiKey;
  await setSetting(
    "ai",
    { provider: input.provider, baseUrl: input.baseUrl, model: input.model, apiKey, redact: input.redact === "on", maxTokens: input.maxTokens },
    viewer.id,
  );
  await audit({
    actor: userActor(viewer),
    action: "settings.ai",
    summary: `${viewer.name} set the AI provider to ${input.provider === "none" ? "none" : `${input.provider} (${new URL(input.baseUrl).host}, ${input.model})`}${input.apiKey ? " with a new key" : ""}.`,
  });
  refresh();
  return { ok: "Saved." };
});

/** One real call to the configured model, so the owner knows the key and model work. */
export const testAi = formAction(z.object({}), async () => {
  await requirePermission("settings.ai");
  const ai = await resolveAi();
  if (!ai) throw new UserError("Choose a provider and save first.");
  const started = Date.now();
  const reply = await complete(ai, { system: "Reply with one short sentence.", messages: [{ role: "user", content: [{ type: "text", text: "Say hello to the team in five words or fewer." }] }], maxTokens: 60 });
  const text = reply.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ").trim();
  return { ok: `The model answered in ${((Date.now() - started) / 1000).toFixed(1)} s: “${text.slice(0, 200)}”` };
});

export const saveSmtp = formAction(smtpSchema, async (input) => {
  const viewer = await requirePermission("settings.manage");
  if (!input.host) {
    await setSetting("smtp", null, viewer.id);
    await audit({ actor: userActor(viewer), action: "settings.email", summary: `${viewer.name} turned email sending off.` });
    refresh();
    return { ok: "Email sending is off. Invites and reset links are shown to copy instead." };
  }
  if (!input.from) throw new UserError("Enter the “From” address, e.g. Team <team@yourbusiness.com>.");
  const current = await getSetting("smtp");
  const password = input.password ? seal(input.password) : (current?.password ?? null);
  await setSetting("smtp", { host: input.host, port: input.port, secure: input.secure === "on", user: input.user, password, from: input.from }, viewer.id);
  await audit({ actor: userActor(viewer), action: "settings.email", summary: `${viewer.name} set the email server to ${input.host}:${input.port}.` });
  refresh();
  return { ok: "Saved. Send a test email to check it." };
});

export const sendTestEmail = formAction(testEmailSchema, async ({ to }) => {
  await requirePermission("settings.manage");
  await sendMail({ to, subject: "Test email from your business suite", text: "If you can read this, the suite can send email: invites and reset links will now be emailed." }).catch((error) => {
    throw new UserError(`The email server refused: ${error instanceof Error ? error.message : "unknown error"}. Check the host, port, user and password.`);
  });
  return { ok: `Sent to ${to}. Check that inbox (and spam).` };
});

export const savePermissions = formAction(z.record(z.string(), z.string()), async (_input, formData) => {
  const viewer = await requirePermission("settings.manage");
  if (viewer.role !== "owner") throw new UserError("Only the owner can change what each role may do.");
  const roles: Role[] = ["admin", "member", "guest"];
  const rows: { role: Role; permission: string; allowed: boolean }[] = [];
  for (const def of allPermissions()) {
    for (const role of roles) {
      const allowed = formData.get(`${role}:${def.key}`) === "on";
      const byDefault = def.defaultRoles.includes(role);
      if (allowed !== byDefault) rows.push({ role, permission: def.key, allowed });
    }
  }
  await db().transaction(async (tx) => {
    await tx.delete(rolePermissions);
    if (rows.length) await tx.insert(rolePermissions).values(rows);
  });
  await audit({ actor: userActor(viewer), action: "settings.permissions", summary: `${viewer.name} changed role permissions (${rows.length} difference${rows.length === 1 ? "" : "s"} from the defaults).` });
  refresh();
  return { ok: "Saved. The change applies on everyone's next page load." };
});

export const toggleModule = formAction(z.object({ moduleId: z.string(), enabled: z.enum(["yes", "no"]) }), async ({ moduleId, enabled }) => {
  const viewer = await requirePermission("settings.manage");
  const m = findModule(moduleId);
  if (!m) throw new UserError("That app is not installed.");
  const on = enabled === "yes";
  await db().insert(moduleState).values({ moduleId, enabled: on }).onConflictDoUpdate({ target: moduleState.moduleId, set: { enabled: on } });
  if (on) await seedModules(viewer);
  await audit({ actor: userActor(viewer), action: on ? "settings.app_on" : "settings.app_off", module: moduleId, summary: `${viewer.name} switched ${m.name} ${on ? "on" : "off"}.` });
  refresh();
  return { ok: `${m.name} is ${on ? "on" : "off"}. Its data is kept either way.` };
});
