import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { createSpaceAction } from "../actions";
import { Crumbs } from "./shared";

export function SpaceFields({ name = "", description = "", visibility = "team" }: { name?: string; description?: string; visibility?: "team" | "private" }) {
  return (
    <>
      <label className="block">
        <span className="label">Name</span>
        <input name="name" required maxLength={80} defaultValue={name} className="input" placeholder="For example: Kitchen, Front of house, Management" />
      </label>
      <label className="block">
        <span className="label">What it is for (optional)</span>
        <textarea name="description" rows={2} maxLength={500} defaultValue={description} className="input" />
      </label>
      <fieldset className="space-y-2">
        <legend className="label">Who can see it</legend>
        <label className="flex items-start gap-2">
          <input type="radio" name="visibility" value="team" defaultChecked={visibility === "team"} className="mt-1 size-4" />
          <span>
            <span className="font-medium">The whole team.</span> <span className="muted">Everyone except guests can read it; people who may write pages can edit it. Add guests one by one.</span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="visibility" value="private" defaultChecked={visibility === "private"} className="mt-1 size-4" />
          <span>
            <span className="font-medium">Only its members.</span> <span className="muted">You choose who is in it, and what each person may do. Admins can always open it.</span>
          </span>
        </label>
      </fieldset>
    </>
  );
}

export function NewSpacePage({ basePath }: ModulePageProps) {
  return (
    <div className="max-w-2xl space-y-6">
      <header className="space-y-1">
        <Crumbs items={[{ label: "Docs", href: basePath }, { label: "New space" }]} />
        <h1 className="h1">New space</h1>
        <p className="muted">A space is a shelf of pages with its own people. You will manage the space you make.</p>
      </header>
      <ActionForm action={createSpaceAction} submit="Make the space" className="card space-y-4">
        <SpaceFields />
      </ActionForm>
    </div>
  );
}
