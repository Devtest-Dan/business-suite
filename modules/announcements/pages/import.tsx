import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { importAnnouncements } from "../actions";

const EXAMPLE = `title,body,pinned,key
Office closed Friday,The office is closed this Friday for the holiday.,yes,closure-friday
New parking rules,Please park in the back lot from Monday.,no,parking-rules`;

export function ImportPage({ basePath }: ModulePageProps) {
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <Link href={basePath} className="link text-sm">
          ← Announcements
        </Link>
        <h1 className="h1">Import announcements</h1>
        <p className="muted">
          Paste CSV text. Every row becomes part of one approval: nothing is posted until someone approves it, and a row is never posted twice,
          even if the batch is approved again. Give each row a <code>key</code> to stop the same row coming in from a later import.
        </p>
      </header>
      <ActionForm action={importAnnouncements} submit="Send for approval" className="card space-y-4">
        <label className="block">
          <span className="label">CSV (columns: title, body, and optionally pinned, key)</span>
          <textarea name="csv" required rows={12} className="input font-mono text-sm" placeholder={EXAMPLE} />
        </label>
      </ActionForm>
    </div>
  );
}
