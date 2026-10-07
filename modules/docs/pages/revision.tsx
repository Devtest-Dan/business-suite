import Link from "next/link";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import { formatDateTime } from "@/lib/format";
import type { ModulePageProps } from "@/lib/modules/contract";
import { canEdit, P } from "../access";
import { restoreRevisionAction } from "../actions";
import { getPage, revisionOf } from "../data";
import { stepsAsText } from "../diff";
import { Markdown } from "../markdown";
import { DiffView } from "./diff-view";
import { Crumbs, NotHere } from "./shared";

export async function RevisionPage({ ctx, params, basePath }: ModulePageProps) {
  const id = z.string().uuid().safeParse(params.pageId);
  const rev = z.coerce.number().int().min(1).safeParse(params.rev);
  const page = id.success ? await getPage(ctx.db, ctx, id.data) : null;
  if (!page || !rev.success) return <NotHere basePath={basePath} />;
  const [version, previous] = await Promise.all([revisionOf(ctx.db, page.id, rev.data), rev.data > 1 ? revisionOf(ctx.db, page.id, rev.data - 1) : Promise.resolve(null)]);
  if (!version) return <NotHere basePath={basePath} what="version" />;
  const tz = ctx.business.timezone;
  const restorable = canEdit(page.space.access) && ctx.can(P.edit) && !page.archivedAt && version.revision !== page.revision;

  return (
    <div className="max-w-4xl space-y-6">
      <header className="space-y-1">
        <Crumbs
          items={[
            { label: "Docs", href: basePath },
            { label: page.space.name, href: `${basePath}/s/${page.spaceId}` },
            { label: page.title, href: `${basePath}/p/${page.id}` },
            { label: "History", href: `${basePath}/p/${page.id}/history` },
            { label: `Version ${version.revision}` },
          ]}
        />
        <h1 className="h1">
          Version {version.revision} of “{version.title}”
        </h1>
        <p className="text-sm text-subtle">
          {version.editedByName}, {formatDateTime(version.createdAt, tz)}
          {version.note ? ` · ${version.note}` : ""}
          {version.revision === page.revision ? " · this is the current version" : ` · the current version is ${page.revision}`}
        </p>
      </header>

      {restorable ? (
        <ActionForm action={restoreRevisionAction} submit={`Bring back version ${version.revision}`} submitClassName="btn" className="card flex flex-wrap items-center justify-between gap-3">
          <input type="hidden" name="pageId" value={page.id} />
          <input type="hidden" name="revision" value={version.revision} />
          <p className="muted text-sm">This saves version {version.revision}&apos;s text as a new version. The versions in between stay in the history.</p>
        </ActionForm>
      ) : null}

      <section className="card space-y-3" aria-labelledby="changes">
        <h2 id="changes" className="h2">
          {previous ? `What changed from version ${previous.revision}` : "The first version"}
        </h2>
        {previous && previous.title !== version.title ? <DiffView before={previous.title} after={version.title} label="Title" /> : null}
        <DiffView before={previous?.body ?? ""} after={version.body} label="Text" />
        {version.kind === "procedure" || previous?.kind === "procedure" ? (
          <DiffView before={previous ? stepsAsText(previous.steps) : ""} after={stepsAsText(version.steps)} label="Steps" />
        ) : null}
      </section>

      <section className="card space-y-2" aria-labelledby="as-it-was">
        <h2 id="as-it-was" className="h2">
          As it was
        </h2>
        {version.body.trim() ? <Markdown text={version.body} /> : <p className="muted">No text.</p>}
        {version.kind === "procedure" ? (
          <ol className="list-decimal space-y-1 pl-6">
            {version.steps.map((s, i) => (
              <li key={i}>{s.text}</li>
            ))}
          </ol>
        ) : null}
      </section>
      <Link href={`${basePath}/p/${page.id}/history`} className="link text-sm">
        ← All versions
      </Link>
    </div>
  );
}
