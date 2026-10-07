import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { messageFor } from "@/lib/errors";

/** What every form action returns to its form (via useActionState). */
export interface FormState {
  ok?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Extra data for the form to show, e.g. a copyable invite link. */
  data?: Record<string, string>;
}

export const EMPTY_FORM: FormState = {};

/** Turns a schema failure into one message per field. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    out[key] ??= issue.message;
  }
  return out;
}

export function formObject(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of formData.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

/**
 * Wraps a form action: validates with the schema, runs the body, and turns any
 * thrown error into a message for the form. Redirects still happen.
 */
export function formAction<S extends z.ZodType>(
  schema: S,
  body: (input: z.output<S>, formData: FormData) => Promise<FormState | void>,
): (prev: FormState, formData: FormData) => Promise<FormState> {
  return async (_prev, formData) => {
    const parsed = schema.safeParse(formObject(formData));
    if (!parsed.success) {
      return { error: "Some fields need attention. Check the messages below and try again.", fieldErrors: fieldErrors(parsed.error) };
    }
    try {
      return (await body(parsed.data, formData)) ?? { ok: "Saved." };
    } catch (error) {
      unstable_rethrow(error);
      console.error("Form action failed:", error);
      return { error: messageFor(error) };
    }
  };
}
