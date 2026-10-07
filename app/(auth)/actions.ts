"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { acceptInvite, authenticate, consumeReset, createReset, resetLink } from "@/lib/auth/accounts";
import { isLimited, RATE_LIMITS, recordAttempt } from "@/lib/auth/rate-limit";
import { clientIp, endSession, startSession } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { UserError } from "@/lib/errors";
import { formAction } from "@/lib/forms";
import { mailConfigured, sendMail } from "@/lib/mail";
import { acceptInviteSchema, forgotSchema, resetSchema, signInSchema } from "@/lib/schemas";
import { businessProfile } from "@/lib/settings";

export const signIn = formAction(signInSchema, async ({ email, password }, formData) => {
  const viewer = await authenticate(email, password, await clientIp());
  await startSession(viewer.id);
  const next = String(formData.get("next") ?? "");
  // Only same-site paths, never an absolute URL from the query string.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
});

export async function signOut(): Promise<void> {
  await endSession();
  redirect("/sign-in");
}

export const acceptInviteAction = formAction(acceptInviteSchema, async ({ token, name, password }) => {
  const viewer = await acceptInvite(token, name, password);
  await startSession(viewer.id);
  redirect("/");
});

export const resetPasswordAction = formAction(resetSchema, async ({ token, password }) => {
  const viewer = await consumeReset(token, password);
  await startSession(viewer.id);
  redirect("/");
});

const SAME_ANSWER = "If that email has an account here, a reset link is on its way. It works for 24 hours. Check spam if it does not arrive in a few minutes.";

export const forgotPasswordAction = formAction(forgotSchema, async ({ email }) => {
  if (!(await mailConfigured())) {
    throw new UserError("This suite cannot send email yet. Ask the owner or an admin for a reset link: they make one under People.");
  }
  const keys = RATE_LIMITS.resetRequest(email, await clientIp());
  if (await isLimited("reset_request", keys, 60)) return { ok: SAME_ANSWER };
  // Counted as a "failure" so the limit applies to every request, found or not.
  await recordAttempt("reset_request", keys, false);
  const [user] = await db().select().from(users).where(eq(users.email, email));
  if (user && user.status === "active") {
    const token = await createReset(user.id, null);
    const business = await businessProfile();
    await sendMail({
      to: user.email,
      subject: `Reset your password for ${business.name}`,
      text: `Hello ${user.name},\n\nSomeone (hopefully you) asked to reset your password for ${business.name}'s suite. Open this link to choose a new one. It works once, for 24 hours:\n\n${resetLink(token)}\n\nIf you did not ask, you can ignore this email: your password stays as it is.`,
    }).catch((error) => console.error("Reset email failed:", error));
  }
  return { ok: SAME_ANSWER };
});
