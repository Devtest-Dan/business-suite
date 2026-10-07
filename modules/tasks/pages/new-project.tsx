import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { createProjectAction } from "../actions";
import { PROJECT_VISIBILITIES, VISIBILITY_LABEL } from "../constants";

export function NewProjectPage({ basePath, searchParams }: ModulePageProps) {
  const template = searchParams.template === "1";
  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <Link href={template ? `${basePath}/templates` : `${basePath}/projects`} className="link text-sm">
          ← {template ? "Templates" : "Projects"}
        </Link>
        <h1 className="h1">{template ? "New template" : "New project"}</h1>
        <p className="muted">
          {template
            ? "A template is a list of steps you repeat (a new starter, a job, a month-end). Give each step a number of days after the start; then start a project from it whenever you need it."
            : "You become its first member. Add tasks next, then the people who work on it."}
        </p>
      </header>
      <ActionForm action={createProjectAction} submit={template ? "Create template" : "Create project"} className="card space-y-4">
        <input type="hidden" name="template" value={template ? "1" : ""} />
        <label className="block">
          <span className="label">Name</span>
          <input name="name" required maxLength={120} className="input" />
        </label>
        <label className="block">
          <span className="label">Description (optional)</span>
          <textarea name="description" rows={3} maxLength={2000} className="input" />
        </label>
        <fieldset className="space-y-2">
          <legend className="label">Who can see it</legend>
          {PROJECT_VISIBILITIES.map((v) => (
            <label key={v} className="flex items-center gap-2">
              <input type="radio" name="visibility" value={v} defaultChecked={v === "team"} className="size-4" />
              <span>{VISIBILITY_LABEL[v]}</span>
            </label>
          ))}
        </fieldset>
      </ActionForm>
    </div>
  );
}
