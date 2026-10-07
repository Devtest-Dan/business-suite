"use client";

import { useActionState } from "react";
import type { FormState } from "@/lib/forms";
import { summariseAction } from "../actions";

/** "Catch me up": the suite's AI summarises the conversation (or thread) since a time. */
export function SummariseForm({ channelId, parentId, hasUnread }: { channelId: string; parentId: string | null; hasUnread: boolean }) {
  const [state, action, pending] = useActionState(summariseAction, {} as FormState);
  return (
    <details className="text-sm" data-testid="summarise">
      <summary className="btn cursor-pointer list-none">Catch me up</summary>
      <div className="card mt-2 space-y-3">
        <form action={action} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="channelId" value={channelId} />
          {parentId ? <input type="hidden" name="parentId" value={parentId} /> : null}
          <label className="block">
            <span className="label">Summarise</span>
            <select name="since" className="input" defaultValue={hasUnread && !parentId ? "unread" : "day"}>
              {!parentId ? <option value="unread">Since I last read</option> : null}
              <option value="day">The last 24 hours</option>
              <option value="week">The last 7 days</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? "Summarising…" : "Summarise"}
          </button>
        </form>
        <p className="hint !mt-0">Uses the suite&apos;s AI. Names and contact details are removed first when the owner has redaction on. Nothing is posted.</p>
        {state.error ? (
          <p role="alert" className="notice notice-error">
            {state.error}
          </p>
        ) : null}
        {state.ok ? (
          <div role="status" className="space-y-1">
            <p className="text-xs text-subtle">{state.ok}</p>
            <div className="whitespace-pre-wrap leading-relaxed" data-testid="summary-text">
              {state.data?.summary}
            </div>
          </div>
        ) : null}
      </div>
    </details>
  );
}
