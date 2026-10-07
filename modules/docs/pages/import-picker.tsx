"use client";

import { useState } from "react";

/** Picks Markdown files, or a whole folder (its sub-folders become parent pages). Sends each file's path alongside it. */
export function ImportPicker() {
  const [folder, setFolder] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  return (
    <div className="space-y-3">
      <fieldset className="flex flex-wrap gap-4">
        <legend className="label">Choose</legend>
        <label className="flex items-center gap-2">
          <input type="radio" checked={!folder} onChange={() => setFolder(false)} className="size-4" /> Files
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={folder} onChange={() => setFolder(true)} className="size-4" /> A folder (keeps its sub-folders)
        </label>
      </fieldset>
      <label className="block">
        <span className="label">{folder ? "Folder" : "Markdown files (.md)"}</span>
        <input
          key={folder ? "folder" : "files"}
          type="file"
          name="files"
          multiple
          required
          accept={folder ? undefined : ".md,.markdown,.txt,text/markdown,text/plain"}
          className="input"
          {...(folder ? { webkitdirectory: "", directory: "" } : {})}
          onChange={(e) => setPaths(Array.from(e.target.files ?? []).map((f) => f.webkitRelativePath || f.name))}
        />
      </label>
      {paths.map((p, i) => (
        <input key={i} type="hidden" name="paths" value={p} />
      ))}
      {paths.length ? (
        <p className="text-sm text-subtle">
          {paths.length} file{paths.length === 1 ? "" : "s"} chosen{paths.length > 5 ? "" : `: ${paths.join(", ")}`}.
        </p>
      ) : null}
    </div>
  );
}
