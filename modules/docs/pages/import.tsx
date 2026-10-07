import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { canEdit } from "../access";
import { importMarkdownAction } from "../actions";
import { getSpace } from "../data";
import { ImportPicker } from "./import-picker";
import { Crumbs, NotHere } from "./shared";

const EXAMPLE = `---
kind: procedure
schedule: daily
---
# Opening checklist

What the first person in does.

1. Turn off the alarm
2. Check the fridge [check: yes/no: Is it at 5 °C or lower?]
3. Count the float [check: record Amount]`;

export async function ImportPage({ ctx, params, basePath }: ModulePageProps) {
  const id = z.string().uuid().safeParse(params.spaceId);
  const space = id.success ? await getSpace(ctx.db, ctx, id.data) : null;
  if (!space) return <NotHere basePath={basePath} what="space" />;
  if (!canEdit(space.access)) {
    return (
      <div className="card max-w-xl space-y-2">
        <h1 className="h1">You can read this space but not write in it</h1>
        <p className="muted">Ask one of its managers to make you an editor, then import.</p>
      </div>
    );
  }
  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <Crumbs items={[{ label: "Docs", href: basePath }, { label: space.name, href: `${basePath}/s/${space.id}` }, { label: "Import Markdown" }]} />
        <h1 className="h1">Import Markdown into {space.name}</h1>
        <p className="muted">
          Each file becomes a page. All of them go into one approval: nothing is written until someone approves it, and the same file with the same text is never
          imported twice. Importing a changed file again updates the page it made the first time (as a new version).
        </p>
      </header>
      <ActionForm action={importMarkdownAction} submit="Send for approval" className="card space-y-4">
        <input type="hidden" name="spaceId" value={space.id} />
        <ImportPicker />
        <p className="hint text-xs text-subtle">Up to 200 files, each up to 200 KB. Images and other files are not imported; attach them to the pages afterwards.</p>
      </ActionForm>
      <section className="card space-y-2">
        <h2 className="h2">How files are read</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>The title is the file&apos;s first “# heading” (or <code>title:</code> in front matter, or else the file name).</li>
          <li>
            <code>kind: procedure</code> in front matter turns the first numbered list into steps. A step can end with <code>[check: yes/no: question]</code> or{" "}
            <code>[check: record what]</code>. <code>schedule: daily</code>, <code>weekdays</code> or <code>weekly</code> sets when it is due.
          </li>
          <li>When you import a folder, its sub-folders become parent pages.</li>
        </ul>
        <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">{EXAMPLE}</pre>
      </section>
    </div>
  );
}
