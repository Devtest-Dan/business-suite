"use client";

import { useActionState } from "react";
import type { FormState } from "@/lib/forms";
import { completeStepAction } from "../actions";

/** Ticks one step of a run: a Done button, Yes/No buttons, or a value to record first. */
export function StepForm({ runId, position, check, checkLabel }: { runId: string; position: number; check: "none" | "yesno" | "value"; checkLabel: string }) {
  const [state, action, pending] = useActionState(completeStepAction, {} as FormState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="position" value={position} />
      {state.error ? (
        <p role="alert" className="notice notice-error text-sm">
          {state.error}
        </p>
      ) : null}
      {check === "yesno" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{checkLabel}</span>
          <button type="submit" name="answer" value="yes" className="btn btn-primary" disabled={pending} aria-label={`Step ${position + 1}: Yes`}>
            Yes
          </button>
          <button type="submit" name="answer" value="no" className="btn btn-danger" disabled={pending} aria-label={`Step ${position + 1}: No`}>
            No
          </button>
        </div>
      ) : check === "value" ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="label text-xs">{checkLabel}</span>
            <input name="answer" required maxLength={500} className="input" aria-label={`Step ${position + 1}: ${checkLabel}`} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={pending} aria-label={`Step ${position + 1}: Done`}>
            Done
          </button>
        </div>
      ) : (
        <button type="submit" className="btn btn-primary" disabled={pending} aria-label={`Step ${position + 1}: Done`}>
          {pending ? "Saving…" : "Done"}
        </button>
      )}
    </form>
  );
}
