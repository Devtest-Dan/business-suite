"use client";

export default function ShellError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card max-w-xl space-y-3">
      <h1 className="h1">This page could not load</h1>
      <p className="muted">
        Something failed on the server. Try again; if it keeps happening, the owner can read the server log (docs/DEPLOY.md, “Reading the logs”).
      </p>
      <button type="button" className="btn btn-primary" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
