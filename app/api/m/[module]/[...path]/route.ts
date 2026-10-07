import { getViewer, moduleContext } from "@/lib/auth/session";
import { messageFor } from "@/lib/errors";
import type { ApiMethod } from "@/lib/modules/contract";
import { enabledModules } from "@/lib/modules/registry-access";
import { matchRoute } from "@/lib/modules/routing";

/**
 * Every module endpoint is served from here: /api/m/<module id>/<path>, from
 * the manifest's `api` list (the only catch-all under /api/m: Next.js allows
 * one). A switched-off module answers 404 either way. Then, by `auth`:
 *
 * - "session": sign-in (401), the permission (403), and for writes that the
 *   request comes from this suite's own pages (403), all checked here.
 * - "self": nothing is checked here; the handler authenticates every request
 *   itself (the contract says so).
 */
type Props = { params: Promise<{ module: string; path: string[] }> };

const SAFE: ApiMethod[] = ["GET"];

/** Same check Next.js applies to server actions: a browser's Origin must be this host. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function dispatch(method: ApiMethod, request: Request, { params }: Props): Promise<Response> {
  const { module: id, path } = await params;
  const m = (await enabledModules()).find((x) => x.id === id);
  const match = m?.api ? matchRoute(m.api, path) : null;
  if (!m || !match) return Response.json({ error: "Not found." }, { status: 404 });
  const route = match.route;
  if (!route.methods.includes(method)) {
    return Response.json({ error: `Use ${route.methods.join(" or ")}.` }, { status: 405, headers: { allow: route.methods.join(", ") } });
  }
  try {
    if (route.auth === "self") return await route.handler(request, { moduleId: m.id, params: match.params });

    const viewer = await getViewer();
    if (!viewer) return Response.json({ error: "Sign in first." }, { status: 401 });
    if (!SAFE.includes(method) && !sameOrigin(request)) {
      return Response.json({ error: "This request did not come from this suite's own pages. Open the suite and try again there." }, { status: 403 });
    }
    const ctx = await moduleContext(m.id, viewer);
    if (!ctx.can(route.permission)) {
      return Response.json({ error: `Your role does not include this in ${m.name}. Ask the owner if you need it.` }, { status: 403 });
    }
    return await route.handler(request, { ctx, params: match.params });
  } catch (error) {
    console.error(`API ${method} /api/m/${id}/${path.join("/")} failed:`, error);
    return Response.json({ error: route.auth === "session" ? messageFor(error) : "The server could not finish this request." }, { status: 500 });
  }
}

export const GET = (request: Request, props: Props) => dispatch("GET", request, props);
export const POST = (request: Request, props: Props) => dispatch("POST", request, props);
export const PUT = (request: Request, props: Props) => dispatch("PUT", request, props);
export const PATCH = (request: Request, props: Props) => dispatch("PATCH", request, props);
export const DELETE = (request: Request, props: Props) => dispatch("DELETE", request, props);
export const dynamic = "force-dynamic";
