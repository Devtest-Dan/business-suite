import Link from "next/link";
import type { ReactNode } from "react";
import { requireViewer } from "@/lib/auth/session";
import { permissionsFor } from "@/lib/permissions";

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  const held = await permissionsFor(viewer.role);
  const tabs = [
    held.has("settings.manage") && { href: "/settings", label: "Business" },
    held.has("settings.ai") && { href: "/settings/ai", label: "AI" },
    held.has("settings.manage") && { href: "/settings/email", label: "Email" },
    held.has("settings.manage") && { href: "/settings/apps", label: "Apps" },
    viewer.role === "owner" && { href: "/settings/permissions", label: "Permissions" },
  ].filter((t): t is { href: string; label: string } => Boolean(t));
  if (tabs.length === 0) {
    return (
      <div className="card max-w-xl">
        <h1 className="h1">Settings</h1>
        <p className="muted">Your role does not change settings. Ask the owner.</p>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <h1 className="h1">Settings</h1>
      <nav aria-label="Settings" className="flex flex-wrap gap-2 border-b border-line pb-3">
        {tabs.map((t) => (
          <Link key={t.href} href={t.href} className="btn">
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
