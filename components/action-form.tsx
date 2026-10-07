"use client";

import { useActionState, type ReactNode } from "react";
import type { FormState } from "@/lib/forms";
import { CopyField } from "./copy-field";

/**
 * A form wired to a server action with useActionState: shows the action's
 * error (and each field's), its success message, and any copyable link it
 * returns (`data.link`). Modules use it for every form.
 */
export function ActionForm({
  action,
  submit,
  children,
  className = "space-y-4",
  submitClassName = "btn btn-primary",
  resetOnSuccess = false,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  submit: string;
  children: ReactNode;
  className?: string;
  submitClassName?: string;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {} as FormState);
  return (
    <form action={formAction} className={className} key={resetOnSuccess && state.ok ? JSON.stringify(state) : undefined}>
      {state.error ? (
        <div role="alert" className="notice notice-error">
          <p>{state.error}</p>
          {state.fieldErrors ? (
            <ul className="mt-1 list-disc pl-5">
              {Object.entries(state.fieldErrors).map(([field, message]) => (
                <li key={field}>
                  <span className="font-medium capitalize">{field.replace(/([A-Z])/g, " $1").toLowerCase()}</span>: {message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {state.ok ? (
        <div role="status" className="notice notice-ok">
          <p>{state.ok}</p>
          {state.data?.link ? <CopyField value={state.data.link} label={state.data.linkLabel ?? "Link"} /> : null}
        </div>
      ) : null}
      {children}
      <button type="submit" className={submitClassName} disabled={pending}>
        {pending ? "Working…" : submit}
      </button>
    </form>
  );
}
