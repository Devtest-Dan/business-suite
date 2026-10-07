import "server-only";
import { getViewer, moduleContext, PermissionError } from "@/lib/auth/session";
import { UserError } from "@/lib/errors";
import type { ModuleContext } from "@/lib/modules/contract";
import { enabledModules } from "@/lib/modules/registry-access";

/**
 * For a module's server actions: the signed-in person's context, after
 * checking the module is switched on and the person holds `permission`.
 * Every module action starts with this (the UI hiding a button is not a check).
 */
export async function requireModule(moduleId: string, permission: string): Promise<ModuleContext> {
  const viewer = await getViewer();
  if (!viewer) throw new PermissionError("signed in");
  if (!(await enabledModules()).some((m) => m.id === moduleId)) {
    throw new UserError("This app is switched off. The owner can switch it on in Settings → Apps.");
  }
  const ctx = await moduleContext(moduleId, viewer);
  if (!ctx.can(permission)) throw new PermissionError(permission);
  return ctx;
}
