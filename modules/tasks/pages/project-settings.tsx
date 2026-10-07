import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { addMemberAction, archiveProjectAction, deleteProjectAction, removeMemberAction, saveAsTemplateAction, updateProjectAction } from "../actions";
import { P, PROJECT_VISIBILITIES, VISIBILITY_LABEL } from "../constants";
import { activePeople, getProject, listTasks } from "../data";
import { idSchema } from "../schemas";
import { NotFoundCard, ProjectHeader } from "./parts";

export async function ProjectSettingsPage({ ctx, params, basePath }: ModulePageProps) {
  const id = idSchema.safeParse(params.projectId);
  const project = id.success ? await getProject(ctx, id.data) : null;
  if (!project) return <NotFoundCard what="Project" basePath={basePath} />;
  const [people, all] = await Promise.all([activePeople(), listTasks(ctx, { projectId: project.id, includeDone: true, limit: 1000 })]);
  const memberIds = new Set(project.members.map((m) => m.id));
  const candidates = people.filter((p) => !memberIds.has(p.id));
  const kind = project.isTemplate ? "template" : "project";

  return (
    <div className="space-y-6">
      <ProjectHeader basePath={basePath} project={project} active="settings" canManage={ctx.can(P.manage)} />
      <div className="grid max-w-5xl gap-6 lg:grid-cols-2">
        <ActionForm action={updateProjectAction} submit="Save" className="card space-y-4">
          <h2 className="h2">Details</h2>
          <input type="hidden" name="projectId" value={project.id} />
          <label className="block">
            <span className="label">Name</span>
            <input name="name" required maxLength={120} defaultValue={project.name} className="input" />
          </label>
          <label className="block">
            <span className="label">Description</span>
            <textarea name="description" rows={3} maxLength={2000} defaultValue={project.description} className="input" />
          </label>
          <fieldset className="space-y-2">
            <legend className="label">Who can see it</legend>
            {PROJECT_VISIBILITIES.map((v) => (
              <label key={v} className="flex items-center gap-2">
                <input type="radio" name="visibility" value={v} defaultChecked={project.visibility === v} className="size-4" />
                <span>{VISIBILITY_LABEL[v]}</span>
              </label>
            ))}
          </fieldset>
        </ActionForm>

        <section className="card space-y-3" aria-labelledby="members">
          <h2 id="members" className="h2">
            Members
          </h2>
          <p className="muted text-sm">
            Members always see the {kind}, even when it is private; guests see only projects they are a member of. People you assign a task to are added
            automatically.
          </p>
          <ul className="space-y-1" data-testid="project-members">
            {project.members.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {m.name} <span className="text-subtle">{m.email}</span>
                </span>
                <form action={removeMemberAction.bind(null, project.id, m.id)}>
                  <button type="submit" className="link text-xs">
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
          {candidates.length ? (
            <ActionForm action={addMemberAction} submit="Add member" className="flex flex-wrap items-end gap-2" submitClassName="btn">
              <input type="hidden" name="projectId" value={project.id} />
              <label className="block min-w-0 flex-1">
                <span className="label">Person</span>
                <select name="userId" className="input">
                  {candidates.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.role})
                    </option>
                  ))}
                </select>
              </label>
            </ActionForm>
          ) : (
            <p className="hint">Everyone in the suite is already a member.</p>
          )}
        </section>

        {!project.isTemplate ? (
          <ActionForm action={saveAsTemplateAction} submit="Save as a template" className="card space-y-3" submitClassName="btn">
            <h2 className="h2">Save as a template</h2>
            <p className="muted text-sm">
              Copies the {all.length} task{all.length === 1 ? "" : "s"} (with checklists, labels and people) into a template. Due dates become days after
              the earliest due date, so the next project can start on any day.
            </p>
            <input type="hidden" name="projectId" value={project.id} />
            <label className="block">
              <span className="label">Template name</span>
              <input name="name" required maxLength={120} defaultValue={`${project.name} (template)`} className="input" />
            </label>
          </ActionForm>
        ) : null}

        <section className="card space-y-3" aria-labelledby="danger">
          <h2 id="danger" className="h2">
            Archive or delete
          </h2>
          <form action={archiveProjectAction.bind(null, project.id, !project.archived)} className="space-y-2">
            <p className="muted text-sm">
              {project.archived
                ? "Archived: hidden from lists, My tasks and reminders. Bring it back to work on it again."
                : "Archiving hides it from lists, My tasks and reminders, and keeps everything."}
            </p>
            <button type="submit" className="btn">
              {project.archived ? `Bring the ${kind} back` : `Archive the ${kind}`}
            </button>
          </form>
          <ActionForm action={deleteProjectAction} submit={`Delete the ${kind} for good`} className="space-y-2 border-t border-line pt-3" submitClassName="btn btn-danger">
            <input type="hidden" name="projectId" value={project.id} />
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="confirm" className="mt-0.5 size-4" />
              <span>
                I understand this deletes the {kind} and its {all.length} task{all.length === 1 ? "" : "s"}, with their comments and files. It cannot be undone.
              </span>
            </label>
          </ActionForm>
        </section>
      </div>
    </div>
  );
}
