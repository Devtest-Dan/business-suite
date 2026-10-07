/**
 * Who may do what in a space. Pure, so it is easy to test and to read:
 *
 * - People holding "docs.manage" (owners and admins by default) manage every space.
 * - A space's members get what their membership says: viewer (read), editor
 *   (read and write) or manager (also change the space and its members).
 *   Writing also needs the "docs.edit" permission.
 * - "team" spaces: every non-guest who can open Docs may read them, and
 *   write them if they hold "docs.edit".
 * - "private" spaces: members only. Guests only ever see spaces they are a member of.
 */
import type { Role } from "@/lib/db/schema";

export const MODULE_ID = "docs";
export const P = {
  access: "docs.access",
  edit: "docs.edit",
  spaces: "docs.spaces",
  manage: "docs.manage",
  run: "docs.run",
  import: "docs.import",
} as const;

export type SpaceRole = "viewer" | "editor" | "manager";
export type Access = "none" | "read" | "edit" | "manage";
export type Visibility = "team" | "private";

export interface Who {
  viewer: { id: string; role: Role };
  can: (permission: string) => boolean;
}

export function accessFor(who: Who, space: { visibility: Visibility; archivedAt?: Date | null }, memberRole: SpaceRole | null): Access {
  if (!who.can(P.access)) return "none";
  if (who.can(P.manage)) return "manage";
  const writer = who.can(P.edit);
  let access: Access = "none";
  if (memberRole === "manager") access = writer ? "manage" : "read";
  else if (memberRole === "editor") access = writer ? "edit" : "read";
  else if (memberRole === "viewer") access = "read";
  else if (space.visibility === "team" && who.viewer.role !== "guest") access = writer ? "edit" : "read";
  // An archived space can be read by those who could read it, and changed only by its managers.
  if (space.archivedAt && access === "edit") access = "read";
  return access;
}

export const canRead = (a: Access) => a !== "none";
export const canEdit = (a: Access) => a === "edit" || a === "manage";
export const canManage = (a: Access) => a === "manage";

export const ACCESS_LABEL: Record<Access, string> = { none: "No access", read: "Can read", edit: "Can edit", manage: "Manages" };
export const ROLE_LABEL: Record<SpaceRole, string> = { viewer: "Can read", editor: "Can edit", manager: "Manages the space" };
