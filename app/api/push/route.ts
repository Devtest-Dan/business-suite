import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getViewer } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { pushSubscriptions } from "@/lib/db/schema";

const subscription = z.object({
  endpoint: z.string().url().max(1000).startsWith("https://"),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(10).max(100) }),
});

/** Saves this browser's push subscription for the signed-in person. */
export async function POST(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return Response.json({ error: "Sign in first." }, { status: 401 });
  const parsed = subscription.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "The browser sent a subscription the server does not understand. Try another browser." }, { status: 400 });
  const { endpoint, keys } = parsed.data;
  await db()
    .insert(pushSubscriptions)
    .values({ userId: viewer.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: viewer.id, p256dh: keys.p256dh, auth: keys.auth } });
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return Response.json({ error: "Sign in first." }, { status: 401 });
  const parsed = z.object({ endpoint: z.string().max(1000) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Missing endpoint." }, { status: 400 });
  await db().delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, parsed.data.endpoint), eq(pushSubscriptions.userId, viewer.id)));
  return Response.json({ ok: true });
}
