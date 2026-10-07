"use client";

import { useState } from "react";
import { attachFileAction } from "../actions";
import { CopyField } from "@/components/copy-field";

/** Uploads a file to the suite's storage, attaches it to the page, and shows the Markdown that links it. */
export function AttachButton({ pageId }: { pageId: string }) {
  const [state, setState] = useState<{ busy: boolean; ok?: string; error?: string; markdown?: string }>({ busy: false });

  async function onFile(file: File | undefined) {
    if (!file) return;
    setState({ busy: true });
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("module", "docs");
      const res = await fetch("/api/files", { method: "POST", body: form });
      const json = (await res.json().catch(() => ({}))) as { file?: { id: string }; error?: string };
      if (!res.ok || !json.file) throw new Error(json.error ?? "The upload failed. Try again.");
      const result = await attachFileAction(pageId, json.file.id);
      if (result.error) throw new Error(result.error);
      setState({ busy: false, ok: result.ok, markdown: result.data?.markdown });
    } catch (error) {
      setState({ busy: false, error: error instanceof Error ? error.message : "The upload failed. Try again." });
    }
  }

  return (
    <div className="space-y-2">
      <label className={`btn ${state.busy ? "opacity-60" : ""}`}>
        {state.busy ? "Uploading…" : "Attach a file"}
        <input type="file" className="sr-only" disabled={state.busy} onChange={(e) => void onFile(e.target.files?.[0])} data-testid="attach-input" />
      </label>
      {state.error ? (
        <p role="alert" className="notice notice-error">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <div role="status" className="notice notice-ok space-y-1">
          <p>{state.ok} To show it in the text, paste this where it belongs when you edit the page:</p>
          {state.markdown ? <CopyField value={state.markdown} label="Markdown" /> : null}
        </div>
      ) : null}
    </div>
  );
}
