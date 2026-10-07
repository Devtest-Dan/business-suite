"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { sidebarAction } from "../actions";
import type { Sidebar, SidebarItem } from "../data";
import { useLive, useLiveStatus } from "./live";

function Row({ item, active, base }: { item: SidebarItem; active: boolean; base: string }) {
  const bold = item.unread > 0 || item.mentions > 0;
  const prefix = item.kind === "public" ? "#" : item.kind === "private" ? "🔒" : item.kind === "group" ? "👥" : "@";
  return (
    <li>
      <Link
        href={`${base}/${item.id}`}
        aria-current={active ? "page" : undefined}
        className={`flex min-h-9 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${active ? "bg-accent-soft font-medium text-accent" : "hover:bg-surface-2"} ${bold && !active ? "font-semibold" : ""}`}
        data-testid={`chat-nav-${item.label}`}
      >
        <span aria-hidden className="w-4 shrink-0 text-center text-subtle">
          {prefix}
        </span>
        <span className={`flex-1 truncate ${item.notify === "none" ? "text-subtle" : ""}`}>{item.label}</span>
        {item.mentions > 0 ? (
          <span className="badge badge-danger" aria-label={`${item.mentions} for you`}>
            {item.mentions > 99 ? "99+" : item.mentions}
          </span>
        ) : item.unread > 0 ? (
          <span className="badge badge-accent" aria-label={`${item.unread} unread`}>
            {item.unread > 99 ? "99+" : item.unread}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

export function SidebarList({ initial, currentId, base, canCreate, canBrowse, canImport, canManage }: { initial: Sidebar; currentId: string | null; base: string; canCreate: boolean; canBrowse: boolean; canImport: boolean; canManage: boolean }) {
  const [data, setData] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const status = useLiveStatus();

  const reload = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const r = await sidebarAction();
      if (r.ok) setData(r.sidebar);
    }, 300);
  }, []);

  useLive(reload);

  return (
    <nav aria-label="Conversations" className="space-y-5 text-sm" data-testid="chat-sidebar">
      <div className="flex flex-wrap gap-2">
        <Link href={`${base}/search`} className="btn flex-1">
          Search
        </Link>
        <Link href={`${base}/dm`} className="btn flex-1">
          New message
        </Link>
      </div>
      <section>
        <div className="mb-1 flex items-center justify-between px-2.5">
          <h2 className="text-xs font-medium uppercase tracking-wide text-subtle">Channels</h2>
          <div className="flex gap-2 text-xs">
            {canBrowse ? (
              <Link href={`${base}/browse`} className="link">
                Browse
              </Link>
            ) : null}
            {canCreate ? (
              <Link href={`${base}/new`} className="link">
                New
              </Link>
            ) : null}
          </div>
        </div>
        {data.channels.length ? (
          <ul className="space-y-0.5">
            {data.channels.map((c) => (
              <Row key={c.id} item={c} active={c.id === currentId} base={base} />
            ))}
          </ul>
        ) : (
          <p className="muted px-2.5">You are not in any channel yet.{canBrowse ? " Browse to join one." : " Ask an admin to add you."}</p>
        )}
      </section>
      <section>
        <h2 className="mb-1 px-2.5 text-xs font-medium uppercase tracking-wide text-subtle">Direct messages</h2>
        {data.direct.length ? (
          <ul className="space-y-0.5">
            {data.direct.map((c) => (
              <Row key={c.id} item={c} active={c.id === currentId} base={base} />
            ))}
          </ul>
        ) : (
          <p className="muted px-2.5">
            No direct messages yet.{" "}
            <Link className="link" href={`${base}/dm`}>
              Start one
            </Link>
            .
          </p>
        )}
      </section>
      {canImport || canManage ? (
        <div className="flex gap-3 px-2.5 text-xs">
          {canImport ? (
            <Link href={`${base}/import`} className="link">
              Import from Slack
            </Link>
          ) : null}
          {canManage ? (
            <Link href={`${base}/settings`} className="link">
              Chat settings
            </Link>
          ) : null}
        </div>
      ) : null}
      {status === "offline" ? <p className="notice notice-warn">Live updates are paused. New messages appear when you reload.</p> : null}
    </nav>
  );
}
