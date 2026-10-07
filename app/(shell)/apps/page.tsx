import type { Metadata } from "next";
import Link from "next/link";
import { requireViewer } from "@/lib/auth/session";
import { Icon } from "@/lib/icons";
import { enabledModules } from "@/lib/modules/registry-access";
import { permissionsFor } from "@/lib/permissions";

export const metadata: Metadata = { title: "Apps" };

/** The app launcher: every switched-on module this person can open. */
export default async function AppsPage() {
  const viewer = await requireViewer();
  const held = await permissionsFor(viewer.role);
  const modules = (await enabledModules()).filter((m) => {
    const home = m.routes.find((r) => r.path === "");
    return !home?.permission || held.has(home.permission);
  });
  return (
    <div className="space-y-6">
      <header>
        <h1 className="h1">Apps</h1>
        <p className="muted">Your business&apos;s own apps. New ones are added by your developer (see docs/ADD_AN_APP.md in the suite).</p>
      </header>
      {modules.length === 0 ? (
        <p className="card muted">There are no apps you can open yet.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="app-launcher">
          {modules.map((m) => (
            <li key={m.id}>
              <Link href={`/m/${m.id}`} className="card card-link flex h-full flex-col items-start gap-3">
                <span className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent">
                  <Icon name={m.icon} className="size-6" />
                </span>
                <span>
                  <span className="block font-semibold">{m.name}</span>
                  <span className="muted block text-sm">{m.description}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
