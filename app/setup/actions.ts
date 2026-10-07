"use server";

import { redirect } from "next/navigation";
import { createOwner, seedModules } from "@/lib/auth/accounts";
import { clientIp, startSession } from "@/lib/auth/session";
import { seal } from "@/lib/crypto";
import { UserError } from "@/lib/errors";
import { isTimezone } from "@/lib/format";
import { formAction } from "@/lib/forms";
import { setupSchema } from "@/lib/schemas";
import { AI_DEFAULTS, getSetting, isSetupDone, setSetting } from "@/lib/settings";

export const completeSetup = formAction(setupSchema, async (input) => {
  if (await isSetupDone()) throw new UserError("This suite is already set up. Sign in instead.");
  if (!isTimezone(input.timezone)) throw new UserError("Choose a timezone from the list.");
  const owner = await createOwner(
    { name: input.name, email: input.email, password: input.password, businessName: input.businessName, timezone: input.timezone, setupCode: input.setupCode },
    await clientIp(),
  );
  if (input.aiKey) {
    const ai = await getSetting("ai");
    await setSetting("ai", { ...ai, provider: "anthropic", baseUrl: AI_DEFAULTS.anthropic.baseUrl, model: AI_DEFAULTS.anthropic.model, apiKey: seal(input.aiKey) }, owner.id);
  }
  await seedModules(owner);
  await startSession(owner.id);
  redirect("/");
});
