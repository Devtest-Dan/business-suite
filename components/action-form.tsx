"use client";

import { startTransition, useActionState, useEffect, useRef, type FormEvent, type ReactNode } from "react";
import type { FormState } from "@/lib/forms";
import { CopyField } from "./copy-field";

/**
 * A form wired to a server action with useActionState: shows the action's
 * error (and each field's), its success message, and any copyable link it
 * returns (`data.link`). Modules use it for every form.
 *
 * A refused save keeps what the person typed: the form is submitted from
 * onSubmit inside a transition, which React does not follow with its automatic
 * form reset. A successful save still resets the fields, as before. Without
 * JavaScript the plain `action` still works.
 */
export function ActionForm({
  action,
  submit,
  children,
  className = "space-y-4",
  submitClassName = "btn btn-primary",
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  submit: string;
  children: ReactNode;
  className?: string;
  submitClassName?: string;
  /** Kept for existing callers: every successful save now clears the form. */
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {} as FormState);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const data = new FormData(event.currentTarget, submitter instanceof HTMLElement ? submitter : null);
    startTransition(() => formAction(data));
  }
  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} className={className}>
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
