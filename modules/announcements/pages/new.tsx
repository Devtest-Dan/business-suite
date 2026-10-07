import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { postAnnouncement } from "../actions";
import { P } from "../data";

export function NewPage({ ctx, basePath }: ModulePageProps) {
  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <Link href={basePath} className="link text-sm">
          ← Announcements
        </Link>
        <h1 className="h1">New announcement</h1>
        <p className="muted">Everyone who can see announcements is notified when you post.</p>
      </header>
      <ActionForm action={postAnnouncement} submit="Post announcement" className="card space-y-4">
        <label className="block">
          <span className="label">Title</span>
          <input name="title" required maxLength={160} className="input" />
        </label>
        <label className="block">
          <span className="label">Announcement</span>
          <textarea name="body" required rows={8} maxLength={10000} className="input" />
        </label>
        {ctx.can(P.pin) ? (
          <label className="flex items-center gap-2">
            <input type="checkbox" name="pinned" className="size-4" />
            <span>Pin to the top</span>
          </label>
        ) : null}
      </ActionForm>
    </div>
  );
}
