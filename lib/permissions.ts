import "server-only";
import { cache } from "react";
import { db } from "@/lib/db/client";
import { rolePermissions, type Role } from "@/lib/db/schema";
import type { PermissionDef } from "@/lib/modules/contract";
import { installedModules } from "@/lib/modules/registry-access";

export const ROLES: readonly Role[] = ["owner", "admin", "member", "guest"];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

/** The shell's own permissions. Module permissions come from each manifest. */
export const CORE_PERMISSIONS: PermissionDef[] = [
  { key: "people.manage", label: "Manage people", description: "Invite people, change roles, switch accounts off, make reset links.", defaultRoles: ["owner", "admin"] },
  { key: "settings.manage", label: "Change settings", description: "Business name, logo, timezone, email and apps.", defaultRoles: ["owner", "admin"] },
  { key: "settings.ai", label: "Change the AI provider", description: "Choose the AI provider and enter its key.", defaultRoles: ["owner"] },
  { key: "approvals.decide", label: "Decide any approval", description: "Approve or decline any write the AI or an import proposed.", defaultRoles: ["owner", "admin"] },
  { key: "activity.view", label: "See the full activity log", description: "Read every entry in the audit log.", defaultRoles: ["owner", "admin"] },
  { key: "files.upload", label: "Upload files", description: "Add files to the suite's storage.", defaultRoles: ["owner", "admin", "member"] },
  { key: "assistant.use", label: "Use the AI assistant", description: "Ask the assistant questions and let it propose changes.", defaultRoles: ["owner", "admin", "member"] },
];

export function allPermissions(): PermissionDef[] {
  return [...CORE_PERMISSIONS, ...installedModules().flatMap((m) => m.permissions)];
}

/** Pure: the defaults plus the owner's overrides. Owners always hold everything. */
export function resolvePermissions(
  role: Role,
  defs: PermissionDef[],
  overrides: { role: Role; permission: string; allowed: boolean }[],
): Set<string> {
  if (role === "owner") return new Set(defs.map((d) => d.key));
  const held = new Set(defs.filter((d) => d.defaultRoles.includes(role)).map((d) => d.key));
  for (const o of overrides) {
    if (o.role !== role) continue;
    if (o.allowed) held.add(o.permission);
    else held.delete(o.permission);
  }
  return held;
}

const loadOverrides = cache(async () => db().select().from(rolePermissions));

export const permissionsFor = cache(async (role: Role): Promise<Set<string>> => {
  return resolvePermissions(role, allPermissions(), await loadOverrides());
});
