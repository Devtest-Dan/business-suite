"use client";

import { useActionState } from "react";
import { CopyField } from "@/components/copy-field";
import type { FormState } from "@/lib/forms";
import { setupLines } from "../setup-lines";

/** Creates an MCP access token and shows it once, with the address and each agent's setup lines. */
export function AgentTokenForm({ action }: { action: (prev: FormState, formData: FormData) => Promise<FormState> }) {
  const [state, formAction, pending] = useActionState(action, {} as FormState);
  const token = state.data?.token;
  const url = state.data?.url;
  return (
    <div className="space-y-4">
      <form action={formAction} className="card space-y-3">
        <h2 className="h2">Give a coding agent access</h2>
        {state.error ? (
          <div role="alert" className="notice notice-error">
            <p>{state.error}</p>
            {state.fieldErrors ? (
              <ul className="mt-1 list-disc pl-5">
                {Object.entries(state.fieldErrors).map(([f, m]) => (
                  <li key={f}>{m}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <label className="block">
          <span className="label">Name this access</span>
          <input name="label" required maxLength={80} className="input" placeholder="e.g. Claude Code on Sam's laptop" />
          <span className="hint">So you can tell it apart later and revoke the right one.</span>
        </label>
        <label className="block max-w-xs">
          <span className="label">Expires after</span>
          <select name="days" defaultValue="30" className="input">
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
          </select>
        </label>
        <p className="hint">
          The agent can recall facts and add notes. It cannot delete anything, and it cannot change or replace the business&apos;s facts (only notes it wrote itself).
        </p>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Creating…" : "Create an access token"}
        </button>
      </form>
      {token && url ? (
        <section className="card space-y-3" role="status" data-testid="new-token">
          <p className="notice notice-ok">{state.ok}</p>
          <CopyField value={token} label="Token (shown once)" />
          <CopyField value={url} label="Brain address (MCP)" />
          <h3 className="font-semibold">Setup lines</h3>
          <p className="hint">Run the line for the intern&apos;s agent on their machine. If a line does not work with their version, put the address and token above into the agent&apos;s MCP settings.</p>
          {setupLines(url, token).map((l) => (
            <div key={l.agent} className="space-y-1">
              <p className="text-sm font-medium">
                {l.agent} <span className="text-xs font-normal text-subtle">(line tested with {l.testedWith})</span>
              </p>
              <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs">{l.lines}</pre>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
