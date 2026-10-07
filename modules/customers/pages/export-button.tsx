"use client";

import { useState, useTransition } from "react";
import { exportCsvAction } from "../actions";

/** Downloads the list as it is filtered now, as CSV. */
export function ExportButton({ entity, query }: { entity: "contacts" | "companies" | "deals"; query: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        className="btn"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError("");
            try {
              const { filename, csv } = await exportCsvAction(entity, query);
              const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
              const a = document.createElement("a");
              a.href = url;
              a.download = filename;
              a.click();
              URL.revokeObjectURL(url);
            } catch {
              setError("The export did not work. Reload the page and try again.");
            }
          })
        }
      >
        {pending ? "Exporting…" : "Export CSV"}
      </button>
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
