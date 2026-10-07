import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { can, requireViewer } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { moduleState } from "@/lib/db/schema";
import { Icon } from "@/lib/icons";
import { installedModules } from "@/lib/modules/registry-access";
import { toggleModule } from "../actions";

export const metadata: Metadata = { title: "Apps settings" };

export default async function AppsSettingsPage() {
  const viewer = await requireViewer();
  if (!(await can(viewer, "settings.manage"))) return <p className="muted">Your role does not change settings.</p>;
  const states = new Map((await db().select().from(moduleState)).map((s) => [s.moduleId, s]));
  return (
    <div className="max-w-2xl space-y-4">
      <p className="muted text-sm">
        The apps built into this suite. Switching one off hides it from everyone; its data stays and comes back when it is switched on. New apps are added by
        your developer (docs/ADD_AN_APP.md).
      </p>
      <ul className="space-y-3">
        {installedModules().map((m) => {
          const on = states.get(m.id)?.enabled ?? true;
          return (
            <li key={m.id} className="card flex flex-wrap items-center gap-3">
              <span className="grid size-10 place-items-center rounded-lg bg-accent-soft text-accent">
                <Icon name={m.icon} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {m.name} <span className="text-xs font-normal text-subtle">v{m.version}</span>
                </span>
                <span className="muted block text-sm">{m.description}</span>
                <span className="block text-xs text-subtle">
                  {m.aiTools?.length ?? 0} AI tools · {m.permissions.length} permissions
                </span>
              </span>
              <ActionForm action={toggleModule} submit={on ? "Switch off" : "Switch on"} submitClassName={on ? "btn btn-danger" : "btn btn-primary"}>
                <input type="hidden" name="moduleId" value={m.id} />
                <input type="hidden" name="enabled" value={on ? "no" : "yes"} />
              </ActionForm>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
