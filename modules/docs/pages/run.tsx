import Link from "next/link";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import { formatDateTime } from "@/lib/format";
import { Icon } from "@/lib/icons";
import type { ModulePageProps } from "@/lib/modules/contract";
import { canManage, P } from "../access";
import { cancelRunAction, finishRunAction, undoStepAction } from "../actions";
import { InlineMarkdown } from "../markdown";
import { getRun, runSteps } from "../runs";
import { NotHere } from "./shared";
import { StepForm } from "./step-form";

export async function RunPage({ ctx, params, basePath }: ModulePageProps) {
  const id = z.string().uuid().safeParse(params.runId);
  const run = id.success ? await getRun(ctx.db, ctx, id.data) : null;
  if (!run) return <NotHere basePath={basePath} what="run" />;
  const done = await runSteps(ctx.db, run.id);
  const tz = ctx.business.timezone;
  const open = run.status === "open";
  const canWork = open && ctx.can(P.run);
  const allDone = run.steps.every((_, i) => done.some((d) => d.position === i));

  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <Link href={`${basePath}/p/${run.pageId}`} className="link text-sm">
          ← {run.title}
        </Link>
        <h1 className="h1 flex flex-wrap items-center gap-2">
          {run.title}: {run.dueOn}
          <span className={`badge ${run.status === "completed" ? "badge-ok" : run.status === "open" ? "badge-accent" : ""}`} data-testid="run-status">
            {run.status === "completed" ? "Done" : run.status === "open" ? "In progress" : "Cancelled"}
          </span>
          {run.flagged ? <span className="badge badge-danger">A check was answered No</span> : null}
        </h1>
        <p className="text-sm text-subtle">
          Started by {run.startedByName}, {formatDateTime(run.startedAt, tz)}
          {run.assigneeName ? ` · for ${run.assigneeName} to complete` : ""}
          {run.completedAt ? ` · finished by ${run.completedByName}, ${formatDateTime(run.completedAt, tz)}` : ""} · {done.length} of {run.steps.length} steps done
        </p>
      </header>

      {run.status === "completed" ? (
        <p role="status" className={`notice ${run.flagged ? "notice-warn" : "notice-ok"}`} data-testid="run-finished">
          Finished by {run.completedByName}, {formatDateTime(run.completedAt, tz)}. This record of who did each step and when is kept with the procedure.
          {run.flagged ? " A check was answered No: see the step marked in red." : ""}
        </p>
      ) : null}

      <ol className="space-y-3" data-testid="run-steps">
        {run.steps.map((step, i) => {
          const d = done.find((x) => x.position === i);
          return (
            <li key={i} className={`card space-y-2 ${d ? "border-ok/40" : ""}`} data-done={d ? "yes" : "no"}>
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${d ? "bg-ok/15 text-ok" : "bg-surface-2"}`}>
                  {d ? <Icon name="check" className="size-4" label="Done" /> : i + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium">
                    <InlineMarkdown text={step.text} />
                  </p>
                  {step.note ? <p className="muted whitespace-pre-line text-sm">{step.note}</p> : null}
                  {d ? (
                    <p className="text-sm" data-testid={`step-${i + 1}-done`}>
                      {step.check === "yesno" ? (
                        <span className={d.answer === "no" ? "font-medium text-danger" : "font-medium text-ok"}>
                          {step.checkLabel} {d.answer === "no" ? "No" : "Yes"}.{" "}
                        </span>
                      ) : step.check === "value" ? (
                        <span className="font-medium">
                          {step.checkLabel}: {d.answer}.{" "}
                        </span>
                      ) : null}
                      <span className="text-subtle">
                        Done by {d.doneByName}, {formatDateTime(d.doneAt, tz)}
                      </span>
                    </p>
                  ) : null}
                </div>
              </div>
              {canWork && !d ? (
                <div className="pl-9">
                  <StepForm runId={run.id} position={i} check={step.check} checkLabel={step.checkLabel} />
                </div>
              ) : null}
              {open && d && (d.doneBy === ctx.viewer.id || canManage(run.access)) ? (
                <form action={undoStepAction.bind(null, run.id, i)} className="pl-9">
                  <button type="submit" className="link text-sm">
                    Untick
                  </button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ol>

      {canWork ? (
        <div className="card flex flex-wrap items-center justify-between gap-3">
          <ActionForm action={finishRunAction} submit="Finish the run" className="space-y-2">
            <input type="hidden" name="runId" value={run.id} />
            <p className="muted text-sm">{allDone ? "Every step is ticked." : "Tick every step first. The run then records who finished it and when."}</p>
          </ActionForm>
          {run.startedBy === ctx.viewer.id || canManage(run.access) ? (
            <form action={cancelRunAction.bind(null, run.id)}>
              <button type="submit" className="btn btn-danger">
                Cancel this run
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
