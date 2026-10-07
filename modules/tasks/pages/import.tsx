import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { importAhlAction, importCsvAction } from "../actions";
import { P } from "../constants";
import { activePeople, listProjects } from "../data";
import { CSV_COLUMNS } from "../imports";

const CSV_EXAMPLE = `title,description,status,priority,due,assignees,labels,checklist,key
Order new till rolls,Two boxes from the usual supplier,todo,normal,2026-11-02,,shop,,till-rolls
Fix the back door lock,,doing,high,2026-10-30,Sam Lee,repairs;safety,Call locksmith;Get two keys cut,door-lock`;

export async function ImportPage({ ctx, basePath }: ModulePageProps) {
  const [projects, people] = await Promise.all([listProjects(ctx), activePeople()]);
  const owner = people.find((p) => p.role === "owner");
  const canManage = ctx.can(P.manage);
  return (
    <div className="max-w-3xl space-y-8">
      <header>
        <Link href={basePath} className="link text-sm">
          ← My tasks
        </Link>
        <h1 className="h1">Import tasks</h1>
        <p className="muted">
          Each import is one approval: nothing is added until someone approves it in Approvals, and approving twice never adds a task twice.
        </p>
      </header>

      <section className="space-y-3" aria-labelledby="ahl">
        <h2 id="ahl" className="h2">
          From a Tasks export file (JSON)
        </h2>
        <p className="muted text-sm">
          The file you download from the training platform’s business dashboard (“Tasks” → “Export”), version 1. Each task is matched by its id: importing the
          same file again adds nothing, and a newer export of a changed task updates it instead of making a copy.
        </p>
        <ActionForm action={importAhlAction} submit="Send for approval" className="card space-y-4">
          <label className="block">
            <span className="label">Project</span>
            <select name="projectId" className="input" defaultValue={canManage ? "new" : projects[0]?.id}>
              {canManage ? <option value="new">A new project</option> : null}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {canManage ? (
            <label className="block">
              <span className="label">Name of the new project (optional)</span>
              <input name="newProjectName" maxLength={120} className="input" placeholder="Steps for <business name>" />
            </label>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">Steps for the owner go to</span>
              <select name="ownerId" className="input" defaultValue={owner?.id ?? ""}>
                <option value="">No one yet</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Steps for the intern go to</span>
              <select name="internId" className="input" defaultValue="">
                <option value="">No one yet</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="label">The file</span>
            <input type="file" name="file" accept="application/json,.json" className="block text-sm" />
          </label>
          <label className="block">
            <span className="label">…or paste its contents</span>
            <textarea name="json" rows={6} className="input font-mono text-xs" placeholder='{"format": "business-suite.tasks", "version": 1, "tasks": [...]}' />
          </label>
        </ActionForm>
      </section>

      <section className="space-y-3" aria-labelledby="csv">
        <h2 id="csv" className="h2">
          From a spreadsheet (CSV)
        </h2>
        {projects.length === 0 ? (
          <p className="notice notice-warn">Create a project first; CSV tasks go into an existing project.</p>
        ) : (
          <ActionForm action={importCsvAction} submit="Send for approval" className="card space-y-4">
            <label className="block">
              <span className="label">Project</span>
              <select name="projectId" className="input">
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">CSV (columns: {CSV_COLUMNS.join(", ")}; only title is required)</span>
              <textarea name="csv" required rows={8} className="input font-mono text-xs" placeholder={CSV_EXAMPLE} />
              <span className="hint">
                Status: todo, doing, waiting or done. Priority: low, normal, high or urgent. Due: YYYY-MM-DD. Assignees, labels and checklist: separate several
                with “;”. Assignees by email or full name. A “key” stops the same row coming in again from a later import.
              </span>
            </label>
          </ActionForm>
        )}
      </section>
    </div>
  );
}
