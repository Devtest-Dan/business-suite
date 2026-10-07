import type { Metadata } from "next";
import Link from "next/link";
import { requireViewer } from "@/lib/auth/session";
import { searchSchema } from "@/lib/schemas";
import { searchEverything } from "@/lib/search";

export const metadata: Metadata = { title: "Search" };

/** Renders ts_headline output: «» marks a match; everything else is plain text. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/«|»/);
  return (
    <span className="muted text-sm">
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="rounded bg-accent-soft px-0.5 text-fg">{p}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const viewer = await requireViewer();
  const { q } = searchSchema.parse(await searchParams);
  const groups = q ? await searchEverything(viewer, q) : [];
  return (
    <div className="space-y-6">
      <h1 className="h1">Search</h1>
      <form role="search" className="flex gap-2">
        <input name="q" defaultValue={q} placeholder="Search every app" aria-label="Search" className="input" autoFocus />
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>
      {q && q.length < 2 ? <p className="muted">Type at least two letters.</p> : null}
      {q.length >= 2 && groups.length === 0 ? <p className="muted">Nothing matches “{q}”. Try fewer or different words.</p> : null}
      <div className="space-y-6" data-testid="search-results">
        {groups.map((g) => (
          <section key={g.label} className="space-y-2">
            <h2 className="h2">{g.label}</h2>
            {g.error ? <p className="notice notice-error">{g.error}</p> : null}
            <ul className="space-y-2">
              {g.hits.map((h) => (
                <li key={h.url}>
                  <Link href={h.url} className="card card-link block">
                    <span className="block font-medium">{h.title}</span>
                    <Snippet text={h.snippet} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
