import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/lib/icons";
import type { ModulePageProps } from "@/lib/modules/contract";
import { fromTemplateAction } from "../actions";
import { listProjects } from "../data";
import { todayIn } from "../logic";

/** Templates: lists of steps you repeat. Start a project from one with a start date. */
export async function TemplatesPage({ ctx, basePath }: ModulePageProps) {
  const templates = await listProjects(ctx, { templates: true });
  const today = todayIn(ctx.business.timezone);
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h1">Templates</h1>
          <p className="muted max-w-2xl">
            Steps you repeat, such as a new person starting, a typical job or the month-end. Each step has a number of days after the start; a project made
            from a template gets real due dates from the start date you choose.
          </p>
        </div>
        <Link href={`${basePath}/projects/new?template=1`} className="btn btn-primary">
          <Icon name="plus" className="size-4" /> New template
        </Link>
      </header>
      {templates.length === 0 ? (
        <div className="card text-center">
          <p className="font-medium">No templates yet.</p>
          <p className="muted">Make one with “New template”, or open a project’s settings and choose “Save as a template”.</p>
        </div>
      ) : (
        <ul className="space-y-3" data-testid="template-list">
          {templates.map((t) => (
            <li key={t.id} className="card space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <Link href={`${basePath}/p/${t.id}`} className="font-semibold hover:underline">
                    {t.name}
                  </Link>
                  <p className="text-sm text-subtle">
                    {t.open + t.done} step{t.open + t.done === 1 ? "" : "s"}
                  </p>
                </div>
                <Link href={`${basePath}/p/${t.id}`} className="link text-sm">
                  Edit the steps
                </Link>
              </div>
              {t.description ? <p className="muted text-sm">{t.description}</p> : null}
              <ActionForm action={fromTemplateAction} submit="Start a project" className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end" submitClassName="btn">
                <input type="hidden" name="templateId" value={t.id} />
                <label className="block">
                  <span className="label">New project’s name</span>
                  <input name="name" required maxLength={120} className="input" defaultValue={t.name.replace(/^Example template: /, "")} />
                </label>
                <label className="block">
                  <span className="label">Start date</span>
                  <input type="date" name="startOn" required className="input" defaultValue={today} />
                </label>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
