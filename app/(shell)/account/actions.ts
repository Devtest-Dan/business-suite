"use server";

import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { z } from "zod";
import { changePassword } from "@/lib/auth/accounts";
import { requireViewer } from "@/lib/auth/session";
import { formAction } from "@/lib/forms";
import { changePasswordSchema } from "@/lib/schemas";

export const changePasswordAction = formAction(changePasswordSchema, async ({ current, password }) => {
  const viewer = await requireViewer();
  await changePassword(viewer, current, password);
  return { ok: "Password changed." };
});

export async function setTheme(theme: string): Promise<void> {
  const value = z.enum(["light", "dark", "system"]).parse(theme);
  const jar = await cookies();
  if (value === "system") jar.delete("suite_theme");
  else jar.set("suite_theme", value, { path: "/", maxAge: 400 * 86_400, sameSite: "lax", httpOnly: false });
  refresh();
}
