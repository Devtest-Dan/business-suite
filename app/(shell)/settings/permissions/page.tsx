import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { requireViewer } from "@/lib/auth/session";
import type { Role } from "@/lib/db/schema";
import { installedModules } from "@/lib/modules/registry-access";
import { CORE_PERMISSIONS, permissionsFor, ROLE_LABELS } from "@/lib/permissions";
import { savePermissions } from "../actions";

export const metadata: Metadata = { title: "Permissions" };

const EDITABLE: Role[] = ["admin", "member", "guest"];

export default async function PermissionsPage() {
  const viewer = await requireViewer();
  if (viewer.role !== "owner") return <p className="muted">Only the owner changes what each role may do.</p>;
  const held = Object.fromEntries(await Promise.all(EDITABLE.map(async (r) => [r, await permissionsFor(r)] as const))) as Record<Role, Set<string>>;
  const groups = [{ name: "The suite", defs: CORE_PERMISSIONS }, ...installedModules().map((m) => ({ name: m.name, defs: m.permissions }))];
  return (
    <ActionForm action={savePermissions} submit="Save permissions" className="space-y-5">
      <p className="muted text-sm">The owner always holds every permission. Ticks show what each other role may do.</p>
      {groups.map((g) => (
        <section key={g.name} className="card overflow-x-auto p-0 sm:p-0">
          <table className="table">
            <thead>
              <tr>
                <th>{g.name}</th>
                {EDITABLE.map((r) => (
                  <th key={r} className="w-20 text-center">
                    {ROLE_LABELS[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {g.defs.map((d) => (
                <tr key={d.key}>
                  <td>
                    <span className="block font-medium">{d.label}</span>
                    <span className="block text-xs text-subtle">{d.description}</span>
                  </td>
                  {EDITABLE.map((r) => (
                    <td key={r} className="text-center">
                      <input type="checkbox" name={`${r}:${d.key}`} defaultChecked={held[r].has(d.key)} aria-label={`${ROLE_LABELS[r]}: ${d.label}`} className="size-4" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </ActionForm>
  );
}
