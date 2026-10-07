import { redirect } from "next/navigation";
import type { ModulePageProps } from "@/lib/modules/contract";
import { P, STATUS_LABEL, TASK_STATUSES } from "../constants";
import { getProject, listTasks } from "../data";
import { describeDue, dueState, todayIn } from "../logic";
import { idSchema } from "../schemas";
import { BoardColumns, type BoardCard } from "./board-client";
import { NotFoundCard, ProjectHeader } from "./parts";

/** The kanban board: one column per status; drag a card, or use its "Move to" menu. */
export async function BoardPage({ ctx, params, basePath }: ModulePageProps) {
  const id = idSchema.safeParse(params.projectId);
  const project = id.success ? await getProject(ctx, id.data) : null;
  if (!project) return <NotFoundCard what="Project" basePath={basePath} />;
  if (project.isTemplate) redirect(`${basePath}/p/${project.id}`);
  const today = todayIn(ctx.business.timezone);
  // Done shows the most recent 50; open columns show everything.
  const [open, done] = await Promise.all([
    listTasks(ctx, { projectId: project.id, sort: "board" }),
    listTasks(ctx, { projectId: project.id, statuses: ["done"], sort: "board", limit: 500 }),
  ]);
  const doneShown = done.slice(-50);
  const cards: BoardCard[] = [...open, ...doneShown].map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    due: t.dueOn ? (t.status === "done" ? `Due ${t.dueOn}` : describeDue(t.dueOn, today)) : null,
    dueState: dueState(t.dueOn, today, t.status === "done"),
    assignees: t.assignees.map((a) => a.name),
    labels: t.labels,
    checklist: t.checklistTotal ? `${t.checklistDone}/${t.checklistTotal}` : null,
  }));
  return (
    <div className="space-y-6">
      <ProjectHeader basePath={basePath} project={project} active="board" canManage={ctx.can(P.manage)} />
      <BoardColumns
        key={cards.map((c) => `${c.id}:${c.status}`).join(",")}
        columns={TASK_STATUSES.map((s) => ({ status: s, label: STATUS_LABEL[s] }))}
        cards={cards}
        basePath={basePath}
        canEdit={ctx.can(P.edit) && !project.archived}
        hiddenDone={done.length - doneShown.length}
      />
    </div>
  );
}
