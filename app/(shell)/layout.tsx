import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Shell, type NavItem, type NavSection } from "@/components/shell-nav";
import { requireViewer } from "@/lib/auth/session";
import { decidableApprovals, unreadNotificationCount } from "@/lib/inbox";
import { enabledModules } from "@/lib/modules/registry-access";
import { permissionsFor, ROLE_LABELS } from "@/lib/permissions";
import { businessProfile, isSetupDone } from "@/lib/settings";
import { signOut } from "../(auth)/actions";

export default async function ShellLayout({ children }: { children: ReactNode }) {
  if (!(await isSetupDone())) redirect("/setup");
  const viewer = await requireViewer();
  const [held, business, modules, waiting, unread] = await Promise.all([
    permissionsFor(viewer.role),
    businessProfile(),
    enabledModules(),
    decidableApprovals(viewer),
    unreadNotificationCount(viewer),
  ]);

  const core: NavItem[] = [
    { href: "/", label: "Home", icon: "home" },
    { href: "/search", label: "Search", icon: "search" },
    { href: "/notifications", label: "Notifications", icon: "bell", badge: unread },
    { href: "/approvals", label: "Approvals", icon: "inbox", badge: waiting.length },
  ];
  if (held.has("assistant.use")) core.push({ href: "/assistant", label: "Assistant", icon: "sparkles" });

  const apps: NavItem[] = [];
  for (const m of modules) {
    for (const n of m.nav) {
      if (n.permission && !held.has(n.permission)) continue;
      const home = m.routes.find((r) => r.path === n.path);
      if (home?.permission && !held.has(home.permission)) continue;
      apps.push({ href: `/m/${m.id}${n.path ? `/${n.path}` : ""}`, label: n.label, icon: n.icon ?? m.icon });
    }
  }
  apps.push({ href: "/apps", label: "All apps", icon: "grid" });

  const admin: NavItem[] = [];
  if (held.has("people.manage") || viewer.role !== "guest") admin.push({ href: "/people", label: "People", icon: "users" });
  if (held.has("activity.view")) admin.push({ href: "/activity", label: "Activity", icon: "activity" });
  if (held.has("settings.manage") || held.has("settings.ai")) admin.push({ href: "/settings", label: "Settings", icon: "settings" });

  const sections: NavSection[] = [{ items: core }, { title: "Apps", items: apps }];
  if (admin.length) sections.push({ title: "Business", items: admin });

  const brand = (
    <Link href="/" className="flex min-w-0 items-center gap-2.5">
      {business.logoFileId ? (
        // eslint-disable-next-line @next/next/no-img-element -- the logo is served by the suite itself
        <img src="/logo" alt="" className="size-8 shrink-0 rounded-md object-contain" />
      ) : (
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent text-sm font-semibold text-white">{business.name.slice(0, 1).toUpperCase()}</span>
      )}
      <span className="truncate font-semibold">{business.name}</span>
    </Link>
  );

  const footer = (
    <div className="flex items-center justify-between gap-2">
      <Link href="/account" className="min-w-0 rounded-lg px-2 py-1 hover:bg-surface-2">
        <span className="block truncate text-sm font-medium">{viewer.name}</span>
        <span className="block text-xs text-subtle">{ROLE_LABELS[viewer.role]}</span>
      </Link>
      <form action={signOut}>
        <button type="submit" className="btn px-2.5" aria-label="Sign out" title="Sign out">
          Sign out
        </button>
      </form>
    </div>
  );

  return (
    <Shell brand={brand} sections={sections} footer={footer}>
      {children}
    </Shell>
  );
}
