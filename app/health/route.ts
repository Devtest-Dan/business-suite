import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/** For Docker's health check, update.sh and uptime monitors: 200 when the app and database answer. */
export async function GET() {
  const started = Date.now();
  try {
    const [row] = await db().execute<{ n: number }>(sql`select count(*)::int as n from suite_migrations`);
    return Response.json(
      { ok: true, version: env().version, database: "ok", migrations: row?.n ?? 0, ms: Date.now() - started },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ ok: false, version: env().version, database: "unreachable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
