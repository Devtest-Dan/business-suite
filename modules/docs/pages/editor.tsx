"use client";

import { useMemo, useRef, useState } from "react";
import { attachFileAction } from "../actions";
import { Markdown } from "../markdown";
import type { ProcedureStep } from "../schema";
import { WEEKDAYS } from "../text";

type Kind = "page" | "procedure";
type Schedule = "none" | "daily" | "weekdays" | "weekly";

export interface EditorInitial {
  title: string;
  body: string;
  kind: Kind;
  steps: ProcedureStep[];
  schedule: Schedule;
  scheduleDay: number | null;
}

/**
 * The page editor: Markdown with a preview, the page's type, and for a
 * procedure its numbered steps (each with an optional check) and schedule.
 * The steps travel to the server as JSON in a hidden field.
 */
export function PageEditor({
  initial,
  directory,
  basePath,
  spaceId,
  pageId,
  canUpload,
}: {
  initial: EditorInitial;
  directory: { id: string; title: string }[];
  basePath: string;
  spaceId: string;
  pageId?: string;
  canUpload: boolean;
}) {
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [kind, setKind] = useState<Kind>(initial.kind);
  const [steps, setSteps] = useState<ProcedureStep[]>(initial.steps.length ? initial.steps : []);
  const [schedule, setSchedule] = useState<Schedule>(initial.schedule);
  const [upload, setUpload] = useState<{ busy: boolean; message?: string; error?: string }>({ busy: false });
  const area = useRef<HTMLTextAreaElement>(null);
  const titles = useMemo(() => new Map(directory.map((d) => [d.title.toLowerCase(), d.id])), [directory]);
  const resolve = (title: string) => {
    const id = titles.get(title.toLowerCase());
    return id ? { href: `${basePath}/p/${id}`, exists: true } : { href: `${basePath}/s/${spaceId}/new?title=${encodeURIComponent(title)}`, exists: false };
  };

  function insert(text: string) {
    const el = area.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const before = body.slice(0, start);
    const glue = before && !before.endsWith("\n") ? "\n" : "";
    setBody(`${before}${glue}${text}\n${body.slice(end)}`);
  }

  async function onFile(file: File | undefined) {
    if (!file || !pageId) return;
    setUpload({ busy: true, message: `Uploading ${file.name}…` });
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("module", "docs");
      const res = await fetch("/api/files", { method: "POST", body: form });
      const json = (await res.json().catch(() => ({}))) as { file?: { id: string }; error?: string };
      if (!res.ok || !json.file) throw new Error(json.error ?? "The upload failed. Try again.");
      const result = await attachFileAction(pageId, json.file.id);
      if (result.error) throw new Error(result.error);
      if (result.data?.markdown) insert(result.data.markdown);
      setUpload({ busy: false, message: `${result.ok ?? "Attached."} A link to it was added where your cursor was.` });
    } catch (error) {
      setUpload({ busy: false, error: error instanceof Error ? error.message : "The upload failed. Try again." });
    }
  }

  const setStep = (i: number, patch: Partial<ProcedureStep>) => setSteps((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const move = (i: number, by: -1 | 1) =>
    setSteps((s) => {
      const j = i + by;
      if (j < 0 || j >= s.length) return s;
      const next = [...s];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="label">Title</span>
        <input name="title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} className="input" />
      </label>
      <fieldset className="flex flex-wrap gap-4">
        <legend className="label">Type</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="kind" value="page" checked={kind === "page"} onChange={() => setKind("page")} className="size-4" />
          Page
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="kind"
            value="procedure"
            checked={kind === "procedure"}
            onChange={() => {
              setKind("procedure");
              if (steps.length === 0) setSteps([{ text: "", note: "", check: "none", checkLabel: "" }]);
            }}
            className="size-4"
          />
          Procedure (numbered steps people run as a checklist)
        </label>
      </fieldset>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="tablist" aria-label="Text" className="flex gap-1">
            <button type="button" role="tab" aria-selected={tab === "write"} className={`btn ${tab === "write" ? "btn-primary" : ""}`} onClick={() => setTab("write")}>
              Write
            </button>
            <button type="button" role="tab" aria-selected={tab === "preview"} className={`btn ${tab === "preview" ? "btn-primary" : ""}`} onClick={() => setTab("preview")}>
              Preview
            </button>
          </div>
          {pageId && canUpload ? (
            <label className={`btn ${upload.busy ? "opacity-60" : ""}`}>
              Attach a file
              <input type="file" className="sr-only" disabled={upload.busy} onChange={(e) => void onFile(e.target.files?.[0])} />
            </label>
          ) : null}
        </div>
        {upload.message ? (
          <p role="status" className="text-sm text-subtle">
            {upload.message}
          </p>
        ) : null}
        {upload.error ? (
          <p role="alert" className="notice notice-error">
            {upload.error}
          </p>
        ) : null}
        <label className={tab === "write" ? "block" : "sr-only"}>
          <span className="label">{kind === "procedure" ? "Introduction (Markdown)" : "Text (Markdown)"}</span>
          <textarea
            ref={area}
            name="body"
            rows={kind === "procedure" ? 6 : 18}
            maxLength={100_000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="input font-mono text-sm"
            placeholder={"## A heading\n\nPlain text. **Bold**, *italic*, a [link](https://example.com), a list:\n\n- one\n- two\n\nLink to another page: [[Its title]]"}
          />
        </label>
        {tab === "preview" ? (
          <div className="min-h-32 rounded-lg border border-line bg-surface p-4" data-testid="preview">
            {body.trim() ? <Markdown text={body} resolve={resolve} /> : <p className="muted">Nothing to preview yet.</p>}
          </div>
        ) : (
          <p className="hint text-xs text-subtle">
            Markdown: # heading, **bold**, *italic*, - list, 1. numbered, &gt; quote, ``` code ```, | tables |. Link a page with [[Its title]].
          </p>
        )}
      </div>

      <input type="hidden" name="steps" value={JSON.stringify(kind === "procedure" ? steps : [])} />

      {kind === "procedure" ? (
        <section className="space-y-3 rounded-lg border border-line p-3" aria-labelledby="steps-h">
          <h2 id="steps-h" className="font-semibold">
            Steps
          </h2>
          <ol className="space-y-3" data-testid="steps-editor">
            {steps.map((s, i) => (
              <li key={i} className="space-y-2 rounded-lg bg-surface-2 p-3">
                <div className="flex items-start gap-2">
                  <span className="mt-2 w-6 shrink-0 text-right font-semibold">{i + 1}.</span>
                  <label className="block min-w-0 flex-1">
                    <span className="sr-only">Step {i + 1}</span>
                    <input value={s.text} onChange={(e) => setStep(i, { text: e.target.value })} maxLength={500} className="input" placeholder="What to do" aria-label={`Step ${i + 1}`} />
                  </label>
                </div>
                <div className="grid gap-2 pl-8 sm:grid-cols-2">
                  <label className="block">
                    <span className="label text-xs">Note (optional)</span>
                    <input value={s.note} onChange={(e) => setStep(i, { note: e.target.value })} maxLength={2000} className="input" aria-label={`Step ${i + 1} note`} />
                  </label>
                  <div className="flex gap-2">
                    <label className="block">
                      <span className="label text-xs">Check</span>
                      <select value={s.check} onChange={(e) => setStep(i, { check: e.target.value as ProcedureStep["check"] })} className="input" aria-label={`Step ${i + 1} check`}>
                        <option value="none">None</option>
                        <option value="yesno">Yes / no question</option>
                        <option value="value">Record a value</option>
                      </select>
                    </label>
                    {s.check !== "none" ? (
                      <label className="block min-w-0 flex-1">
                        <span className="label text-xs">{s.check === "yesno" ? "Question" : "What to record"}</span>
                        <input
                          value={s.checkLabel}
                          onChange={(e) => setStep(i, { checkLabel: e.target.value })}
                          maxLength={120}
                          className="input"
                          aria-label={`Step ${i + 1} ${s.check === "yesno" ? "question" : "value to record"}`}
                          placeholder={s.check === "yesno" ? "Is the fridge at 5 °C or lower?" : "Temperature (°C)"}
                        />
                      </label>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pl-8 text-sm">
                  <button type="button" className="btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} up`}>
                    ↑
                  </button>
                  <button type="button" className="btn" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label={`Move step ${i + 1} down`}>
                    ↓
                  </button>
                  <button type="button" className="btn btn-danger" onClick={() => setSteps((x) => x.filter((_, k) => k !== i))}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <button type="button" className="btn" onClick={() => setSteps((s) => [...s, { text: "", note: "", check: "none", checkLabel: "" }])}>
            Add a step
          </button>
          <div className="flex flex-wrap gap-3 border-t border-line pt-3">
            <label className="block">
              <span className="label">When it should be run</span>
              <select name="schedule" value={schedule} onChange={(e) => setSchedule(e.target.value as Schedule)} className="input">
                <option value="none">When someone starts it</option>
                <option value="daily">Every day</option>
                <option value="weekdays">Every weekday (Monday to Friday)</option>
                <option value="weekly">Once a week</option>
              </select>
            </label>
            {schedule === "weekly" ? (
              <label className="block">
                <span className="label">On</span>
                <select name="scheduleDay" defaultValue={String(initial.scheduleDay ?? 1)} className="input">
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <p className="hint text-xs text-subtle">Scheduled procedures show on the home page and in “what needs me” on the days they are due.</p>
        </section>
      ) : (
        <input type="hidden" name="schedule" value="none" />
      )}
    </div>
  );
}
