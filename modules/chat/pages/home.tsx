import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { createChannelAction } from "../actions";
import { ensureDefaultMemberships } from "../channels";
import { P, sidebar } from "../data";
import { ChatFrame } from "./frame";

export async function HomePage({ ctx, basePath }: ModulePageProps) {
  await ensureDefaultMemberships(ctx);
  const data = await sidebar(ctx.db, ctx.viewer);
  const waiting = [...data.channels, ...data.direct].filter((c) => c.unread || c.mentions);
  return (
    <ChatFrame ctx={ctx} basePath={basePath} listOnPhone>
      <div className="space-y-6">
        <header>
          <h1 className="h1">Chat</h1>
          <p className="muted">Channels for the team, direct messages for one or a few people. Pick a conversation on the left.</p>
        </header>
        {waiting.length ? (
          <section className="card space-y-2">
            <h2 className="h2">Waiting for you</h2>
            <ul className="space-y-1 text-sm">
              {waiting.map((c) => (
                <li key={c.id}>
                  <Link className="link" href={`${basePath}/${c.id}`}>
                    {c.kind === "public" || c.kind === "private" ? `#${c.label}` : c.label}
                  </Link>{" "}
                  <span className="text-subtle">
                    {c.mentions ? `${c.mentions} for you` : `${c.unread} unread`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <p className="card muted">You are all caught up.</p>
        )}
        {data.channels.length === 0 && ctx.can(P.create) && ctx.viewer.role !== "guest" ? (
          <section className="card space-y-3">
            <h2 className="h2">Make the first channel</h2>
            <ActionForm action={createChannelAction} submit="Create channel">
              <label className="block">
                <span className="label">Name</span>
                <input name="name" required maxLength={60} className="input" placeholder="general" />
              </label>
            </ActionForm>
          </section>
        ) : null}
      </div>
    </ChatFrame>
  );
}
