import "server-only";
import { cache } from "react";
import { db } from "@/lib/db/client";
import { moduleState } from "@/lib/db/schema";
import type { ModuleManifest } from "@/lib/modules/contract";
import { modules } from "@/modules/registry";

/** Every module compiled into this build, in registry order. */
export function installedModules(): ModuleManifest[] {
  return modules;
}

export function findModule(id: string): ModuleManifest | undefined {
  return modules.find((m) => m.id === id);
}

/** Installed modules the owner has not switched off. */
export const enabledModules = cache(async (): Promise<ModuleManifest[]> => {
  const rows = await db().select().from(moduleState);
  const off = new Set(rows.filter((r) => !r.enabled).map((r) => r.moduleId));
  return modules.filter((m) => !off.has(m.id));
});
