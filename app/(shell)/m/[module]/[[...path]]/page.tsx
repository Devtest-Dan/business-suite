import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { moduleContext, requireViewer } from "@/lib/auth/session";
import { enabledModules } from "@/lib/modules/registry-access";
import { matchRoute } from "@/lib/modules/routing";

/**
 * Every module page is served from here: /m/<module id>/<route path>. The
 * route comes from the module's manifest; the permission check happens here,
 * before the module's page runs.
 */
type Props = {
  params: Promise<{ module: string; path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function resolve(params: Props["params"]) {
  const { module: id, path = [] } = await params;
  const m = (await enabledModules()).find((x) => x.id === id);
  if (!m) return null;
  const match = matchRoute(m.routes, path);
  return match ? { m, ...match } : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await resolve(params);
  return { title: found ? `${found.route.title} · ${found.m.name}` : "Not found" };
}

export default async function ModulePage({ params, searchParams }: Props) {
  const viewer = await requireViewer();
  const found = await resolve(params);
  if (!found) notFound();
  const ctx = await moduleContext(found.m.id, viewer);
  if (found.route.permission && !ctx.can(found.route.permission)) {
    return (
      <div className="card max-w-xl space-y-2">
        <h1 className="h1">You cannot open this page</h1>
        <p className="muted">Your role does not include “{found.route.title}” in {found.m.name}. Ask the owner if you need it.</p>
      </div>
    );
  }
  const Page = found.route.page;
  return <Page ctx={ctx} params={found.params} searchParams={await searchParams} basePath={`/m/${found.m.id}`} />;
}
