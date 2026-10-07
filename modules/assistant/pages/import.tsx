import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { importMemory } from "../actions";

export function ImportPage({ basePath }: ModulePageProps) {
  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <Link href={`${basePath}/facts`} className="link text-sm">
          ← What the assistant knows
        </Link>
        <h1 className="h1">Bring your business memory home</h1>
        <p className="muted">
          If your business used business memory on the AHL platform, its owner page can export it as a file (“Export my memory”). Import that file here: every current fact
          becomes part of one approval, so nothing is added until someone approves it, and a fact is never added twice, even if you import the same file again. Withdrawn
          facts are left out; earlier wordings come along as each fact&apos;s history.
        </p>
      </header>
      <ActionForm action={importMemory} submit="Send for approval" className="card space-y-4">
        <label className="block">
          <span className="label">The export file (.json)</span>
          <input type="file" name="file" accept="application/json,.json" className="input" />
        </label>
        <label className="block">
          <span className="label">Or paste its contents</span>
          <textarea name="json" rows={8} className="input font-mono text-xs" placeholder='{"format": "ahl-business-memory", "version": 1, ...}' />
        </label>
        <p className="hint">The format is described in docs/apps/assistant.md (“The memory export format”).</p>
      </ActionForm>
    </div>
  );
}
