import "server-only";
import { and, eq, ilike, or } from "drizzle-orm";
import { moduleContext } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import type { SearchHit, Viewer } from "@/lib/modules/contract";
import { enabledModules } from "@/lib/modules/registry-access";
import { permissionsFor } from "@/lib/permissions";

export interface SearchGroup {
  label: string;
  hits: SearchHit[];
  error?: string;
}

const PER_GROUP = 8;

/**
 * Global search: the people directory plus every switched-on module's
 * search provider (each runs Postgres full-text search over its own tables).
 * Groups are ordered by their best hit.
 */
export async function searchEverything(viewer: Viewer, query: string): Promise<SearchGroup[]> {
  const q = query.trim().slice(0, 200);
  if (q.length < 2) return [];
  const held = await permissionsFor(viewer.role);
  const groups: SearchGroup[] = [];

  if (viewer.role !== "guest") {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const people = await db()
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(and(eq(users.status, "active"), or(ilike(users.name, like), ilike(users.email, like))))
      .limit(PER_GROUP);
    if (people.length) {
      groups.push({
        label: "People",
        hits: people.map((p) => ({ title: p.name, snippet: `${p.email} · ${p.role}`, url: `/people#${p.id}`, rank: 1 })),
      });
    }
  }

  const modules = (await enabledModules()).filter((m) => m.search && (!m.search.permission || held.has(m.search.permission)));
  const results = await Promise.all(
    modules.map(async (m): Promise<SearchGroup> => {
      try {
        const hits = await m.search!.search(await moduleContext(m.id, viewer), q, PER_GROUP);
        return { label: m.search!.label, hits };
      } catch (error) {
        console.error(`Search in ${m.id} failed:`, error);
        return { label: m.search!.label, hits: [], error: `Search in ${m.name} failed; the other results are still complete.` };
      }
    }),
  );
  groups.push(...results.filter((g) => g.hits.length || g.error));
  return groups.sort((a, b) => Math.max(0, ...b.hits.map((h) => h.rank)) - Math.max(0, ...a.hits.map((h) => h.rank)));
}
