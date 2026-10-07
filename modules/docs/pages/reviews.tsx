import "server-only";
import type { ReviewContext } from "@/lib/modules/contract";
import { getPage, getSpace, defaultSpace, pageByImportPath, revisionOf, whoFor } from "../data";
import { stepsAsText } from "../diff";
import type { CreatePageInput, EditPageInput, ImportPageInput } from "../schemas";
import { DiffView } from "./diff-view";

/**
 * What the approver sees under each record on the approval page: where the
 * page goes and a diff. Shown only to people who can read the space.
 */

function Where({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-subtle">{children}</p>;
}

export async function reviewCreate(ctx: ReviewContext, input: CreatePageInput) {
  const who = await whoFor(ctx.viewer);
  const spaceId = input.spaceId ?? (await defaultSpace(ctx.db))?.id;
  const space = spaceId ? await getSpace(ctx.db, who, spaceId) : null;
  if (!space) return <Where>You cannot open the space this page would go into, so its text is not shown here. A manager of that space can review it.</Where>;
  return (
    <div className="space-y-2">
      <Where>
        New {input.kind} in <strong>{space.name}</strong>
        {input.spaceId ? "" : " (the default space)"}.
      </Where>
      <DiffView before="" after={input.body} label="Text" />
      {input.kind === "procedure" ? <DiffView before="" after={stepsAsText(input.steps)} label="Steps" /> : null}
    </div>
  );
}

export async function reviewEdit(ctx: ReviewContext, input: EditPageInput) {
  const who = await whoFor(ctx.viewer);
  const page = await getPage(ctx.db, who, input.pageId);
  if (!page) return <Where>This page no longer exists, or you cannot open its space. A manager of that space can review it.</Where>;
  const base = (await revisionOf(ctx.db, page.id, input.baseRevision)) ?? page;
  const stale = page.revision !== input.baseRevision;
  return (
    <div className="space-y-2">
      <Where>
        Change to <a className="link" href={`/m/docs/p/${page.id}`}>{page.title}</a> in {page.space.name}, drafted from version {input.baseRevision}
        {input.note ? `: ${input.note}` : "."}
      </Where>
      {stale ? (
        <p className="notice notice-warn text-xs">
          The page has changed since this was drafted (it is now version {page.revision}). Approving will fail for this record; ask for a fresh draft instead.
        </p>
      ) : null}
      {input.title !== undefined && input.title !== base.title ? <DiffView before={base.title} after={input.title} label="Title" /> : null}
      {input.body !== undefined ? <DiffView before={base.body} after={input.body} label="Text" /> : null}
      {input.steps !== undefined ? <DiffView before={stepsAsText(base.steps)} after={stepsAsText(input.steps)} label="Steps" /> : null}
    </div>
  );
}

export async function reviewImport(ctx: ReviewContext, input: ImportPageInput) {
  const who = await whoFor(ctx.viewer);
  const space = await getSpace(ctx.db, who, input.spaceId);
  if (!space) return <Where>You cannot open the space these files go into. A manager of that space can review them.</Where>;
  const existing = await pageByImportPath(ctx.db, space.id, input.path.toLowerCase());
  return (
    <div className="space-y-2">
      <Where>
        {existing ? (
          <>
            Updates <a className="link" href={`/m/docs/p/${existing.id}`}>{existing.title}</a>, made by an earlier import of this file.
          </>
        ) : (
          <>
            New {input.kind} in <strong>{space.name}</strong>
            {input.folders.length ? ` under ${input.folders.join(" › ")}` : ""}.
          </>
        )}
      </Where>
      <DiffView before={existing?.body ?? ""} after={input.body} label="Text" />
      {input.kind === "procedure" ? <DiffView before={existing ? stepsAsText(existing.steps) : ""} after={stepsAsText(input.steps)} label="Steps" /> : null}
    </div>
  );
}
