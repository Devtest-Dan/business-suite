import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/lib/icons";
import type { TreeNode } from "../data";
import type { WikiResolver } from "../markdown";

/** Shown when a space or page does not exist or the person may not open it (the same message for both, so nothing leaks). */
export function NotHere({ basePath, what = "page" }: { basePath: string; what?: string }) {
  return (
    <div className="card max-w-xl space-y-2">
      <h1 className="h1">This {what} is not available</h1>
      <p className="muted">It does not exist, it was removed, or it is in a space you are not a member of. Ask a manager of the space if you need it.</p>
      <Link href={basePath} className="link">
        ← Back to Docs
      </Link>
    </div>
  );
}

export function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-subtle">
      {items.map((it, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 ? <span aria-hidden="true">›</span> : null}
          {it.href ? (
            <Link href={it.href} className="link truncate">
              {it.label}
            </Link>
          ) : (
            <span className="truncate">{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** [[Title]] → the page, or (when missing) the "new page" form with the title filled in. */
export function wikiResolver(found: Map<string, string>, basePath: string, spaceId: string): WikiResolver {
  return (title) => {
    const id = found.get(title.toLowerCase());
    return id ? { href: `${basePath}/p/${id}`, exists: true } : { href: `${basePath}/s/${spaceId}/new?title=${encodeURIComponent(title)}`, exists: false };
  };
}

export function KindBadge({ kind, isTemplate }: { kind: "page" | "procedure"; isTemplate?: boolean }) {
  if (isTemplate) return <span className="badge">Template</span>;
  return kind === "procedure" ? <span className="badge badge-accent">Procedure</span> : null;
}

export function Tree({ nodes, basePath, currentId }: { nodes: TreeNode[]; basePath: string; currentId?: string }): ReactNode {
  if (nodes.length === 0) return null;
  return (
    <ul className="space-y-1 border-l border-line pl-3 first:border-0 first:pl-0">
      {nodes.map((n) => (
        <li key={n.page.id}>
          <Link
            href={`${basePath}/p/${n.page.id}`}
            className={`flex items-center gap-2 rounded px-1 py-0.5 hover:bg-surface-2 ${n.page.id === currentId ? "bg-accent-soft font-medium" : ""}`}
            aria-current={n.page.id === currentId ? "page" : undefined}
          >
            <Icon name={n.page.kind === "procedure" ? "list" : "file"} className="size-4 shrink-0 text-subtle" />
            <span className="min-w-0 flex-1 truncate">{n.page.title}</span>
          </Link>
          {n.children.length ? (
            <div className="ml-2 mt-1">
              <Tree nodes={n.children} basePath={basePath} currentId={currentId} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** "Put it under" choices: every page of the space, indented by depth, leaving out `exclude` and its sub-pages. */
export function parentOptions(nodes: TreeNode[], exclude?: string, depth = 0): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const n of nodes) {
    if (n.page.id === exclude) continue;
    out.push({ id: n.page.id, label: `${"— ".repeat(depth)}${n.page.title}` });
    out.push(...parentOptions(n.children, exclude, depth + 1));
  }
  return out;
}

export function SearchBox({ basePath, q = "" }: { basePath: string; q?: string }) {
  return (
    <form action={`${basePath}/search`} method="get" role="search" className="flex gap-2">
      <label className="sr-only" htmlFor="docs-q">
        Search docs
      </label>
      <input id="docs-q" name="q" defaultValue={q} placeholder="Search pages and procedures" className="input" maxLength={200} />
      <button className="btn" type="submit">
        <Icon name="search" className="size-4" /> Search
      </button>
    </form>
  );
}
