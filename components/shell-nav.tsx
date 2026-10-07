"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/lib/icons";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  badge?: number;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ sections, onNavigate }: { sections: NavSection[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  // Only the most specific match is highlighted: an app's "/m/tasks/calendar" entry, not also its "/m/tasks" home.
  const current = sections
    .flatMap((s) => s.items.map((i) => i.href))
    .filter((href) => isActive(pathname, href))
    .sort((a, b) => b.length - a.length)[0];
  return (
    <nav aria-label="Main" className="space-y-5">
      {sections.map((section, i) => (
        <div key={section.title ?? i}>
          {section.title ? <p className="mb-1 px-3 text-xs font-medium uppercase tracking-wide text-subtle">{section.title}</p> : null}
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = item.href === current;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`flex min-h-10 items-center gap-2.5 rounded-lg px-3 py-2 text-sm ${active ? "bg-accent-soft font-medium text-accent" : "text-fg hover:bg-surface-2"}`}
                  >
                    <Icon name={item.icon} className="size-[18px] shrink-0" />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.badge ? (
                      <span className="badge badge-accent" aria-label={`${item.badge} waiting`}>
                        {item.badge > 99 ? "99+" : item.badge}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The sidebar on wide screens; a top bar with a slide-out menu on phones. */
export function Shell({ brand, sections, footer, children }: { brand: ReactNode; sections: NavSection[]; footer: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-dvh lg:flex">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="px-4 py-4">{brand}</div>
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          <NavList sections={sections} />
        </div>
        <div className="border-t border-line p-3">{footer}</div>
      </aside>

      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 lg:hidden">
        <button type="button" className="btn px-2.5" aria-label="Open the menu" aria-expanded={open} onClick={() => setOpen(true)}>
          <Icon name="menu" />
        </button>
        <div className="min-w-0 flex-1">{brand}</div>
      </header>

      {open ? (
        <div className="fixed inset-0 z-30 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" className="absolute inset-0 bg-black/40" aria-label="Close the menu" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-surface shadow-xl">
            <div className="flex items-center justify-between px-4 py-3">
              {brand}
              <button type="button" className="btn px-2.5" aria-label="Close the menu" onClick={() => setOpen(false)}>
                <Icon name="x" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-4">
              <NavList sections={sections} onNavigate={() => setOpen(false)} />
            </div>
            <div className="border-t border-line p-3">{footer}</div>
          </div>
        </div>
      ) : null}

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
