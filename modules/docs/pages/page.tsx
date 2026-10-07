import Link from "next/link";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import { formatDateTime } from "@/lib/format";
import { Icon } from "@/lib/icons";
import type { ModulePageProps } from "@/lib/modules/contract";
import { canEdit, P } from "../access";
import { archivePageAction, removeAttachmentAction, startRunAction } from "../actions";
import { ancestors, attachments, backlinks, childPages, getPage, resolveTitles } from "../data";
import { extractLinks, InlineMarkdown, Markdown } from "../markdown";
import { assignablePeople, listRuns } from "../runs";
import { dayIn, scheduleLabel } from "../text";
import { AttachButton } from "./attach-button";
import { Crumbs, KindBadge, NotHere, wikiResolver } from "./shared";

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function PageView({ ctx, params, basePath }: ModulePageProps) {
  const id = z.string().uuid().safeParse(params.pageId);
  const page = id.success ? await getPage(ctx.db, ctx, id.data) : null;
  if (!page) return <NotHere basePath={basePath} />;
  const tz = ctx.business.timezone;
  const isProcedure = page.kind === "procedure";
  const editable = canEdit(page.space.access) && ctx.can(P.edit) && !page.archivedAt;
  const linkText = `${page.body}\n${page.steps.map((s) => `${s.text} ${s.note}`).join("\n")}`;
  const [trail, children, links, files, found, runs, people] = await Promise.all([
    ancestors(ctx.db, page),
    childPages(ctx.db, page.id),
    backlinks(ctx.db, ctx, page.id),
    attachments(ctx.db, page.id),
    resolveTitles(ctx.db, ctx, page.spaceId, extractLinks(linkText).titles),
    isProcedure ? listRuns(ctx.db, ctx, { pageId: page.id, limit: 5 }) : Promise.resolve([]),
    isProcedure && ctx.can(P.run) ? assignablePeople(ctx.db, page) : Promise.resolve([]),
  ]);
  const resolve = wikiResolver(found, basePath, page.spaceId);

  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <Crumbs items={[{ label: "Docs", href: basePath }, { label: page.space.name, href: `${basePath}/s/${page.spaceId}` }, ...trail.map((t) => ({ label: t.title, href: `${basePath}/p/${t.id}` }))]} />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="h1 flex flex-wrap items-center gap-2" data-testid="page-title">
              {page.title} <KindBadge kind={page.kind} isTemplate={page.isTemplate} />
              {page.archivedAt ? <span className="badge badge-warn">Archived</span> : null}
            </h1>
            <p className="text-sm text-subtle">
              Version {page.revision} · {page.updatedByName}, {formatDateTime(page.updatedAt, tz)}
              {isProcedure ? ` · ${scheduleLabel(page.schedule, page.scheduleDay)}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {editable ? (
              <Link href={`${basePath}/p/${page.id}/edit`} className="btn btn-primary">
                Edit
              </Link>
            ) : null}
            <Link href={`${basePath}/p/${page.id}/history`} className="btn">
              History
            </Link>
            {editable ? (
              <Link href={`${basePath}/s/${page.spaceId}/new?parent=${page.id}`} className="btn">
                <Icon name="plus" className="size-4" /> Sub-page
              </Link>
            ) : null}
            {page.isTemplate && editable ? (
              <Link href={`${basePath}/s/${page.spaceId}/new?template=${page.id}`} className="btn">
                Use this template
              </Link>
            ) : null}
          </div>
        </div>
      </header>

      {page.archivedAt ? (
        <div className="notice notice-warn flex flex-wrap items-center justify-between gap-3">
          <p>This page is archived ({formatDateTime(page.archivedAt, tz)}). It is hidden from the space and from search.</p>
          {canEdit(page.space.access) ? (
            <form action={archivePageAction.bind(null, page.id, false)}>
              <button className="btn" type="submit">
                Bring it back
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {page.body.trim() ? (
        <div className="card" data-testid="page-body">
          <Markdown text={page.body} resolve={resolve} />
        </div>
      ) : !isProcedure ? (
        <div className="card muted">{editable ? "This page is empty. Press Edit to write it." : "This page is empty."}</div>
      ) : null}

      {isProcedure ? (
        <section className="card space-y-4" aria-labelledby="steps">
          <h2 id="steps" className="h2">
            Steps
          </h2>
          <ol className="list-decimal space-y-2 pl-6" data-testid="procedure-steps">
            {page.steps.map((s, i) => (
              <li key={i}>
                <InlineMarkdown text={s.text} resolve={resolve} />
                {s.check !== "none" ? <span className="badge ml-2">{s.check === "yesno" ? `Asks: ${s.checkLabel}` : `Records: ${s.checkLabel}`}</span> : null}
                {s.note ? <p className="muted whitespace-pre-line text-sm">{s.note}</p> : null}
              </li>
            ))}
          </ol>
          {ctx.can(P.run) && !page.archivedAt && page.steps.length ? (
            <ActionForm action={startRunAction} submit="Run this procedure" className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
              <input type="hidden" name="pageId" value={page.id} />
              <label className="block">
                <span className="label">Who completes it</span>
                <select name="assignedTo" defaultValue="" className="input">
                  <option value="">Me</option>
                  {people
                    .filter((p) => p.id !== ctx.viewer.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="block">
                <span className="label">For the day</span>
                <input type="date" name="dueOn" defaultValue={dayIn(tz)} className="input" />
              </label>
            </ActionForm>
          ) : null}
          {runs.length ? (
            <div className="space-y-2 border-t border-line pt-4">
              <h3 className="font-semibold">Recent runs</h3>
              <ul className="space-y-1 text-sm" data-testid="recent-runs">
                {runs.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2">
                    <Link href={`${basePath}/runs/${r.id}`} className="link">
                      {r.dueOn}
                    </Link>
                    <span className={`badge ${r.status === "completed" ? "badge-ok" : r.status === "open" ? "badge-accent" : ""}`}>{r.status === "completed" ? "done" : r.status}</span>
                    {r.flagged ? <span className="badge badge-danger">a check said No</span> : null}
                    <span className="text-subtle">
                      {r.status === "completed" ? `by ${r.completedByName}, ${formatDateTime(r.completedAt, tz)}` : `${r.doneCount}/${r.stepCount} steps`}
                    </span>
                  </li>
                ))}
              </ul>
              <Link href={`${basePath}/runs?page=${page.id}`} className="link text-sm">
                Every run of this procedure
              </Link>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        {children.length ? (
          <section className="card space-y-2" aria-labelledby="children">
            <h2 id="children" className="h2">
              Pages under this one
            </h2>
            <ul className="space-y-1 text-sm">
              {children.map((c) => (
                <li key={c.id} className="flex items-center gap-2">
                  <Icon name={c.kind === "procedure" ? "list" : "file"} className="size-4 text-subtle" />
                  <Link href={`${basePath}/p/${c.id}`} className="link">
                    {c.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="card space-y-2" aria-labelledby="backlinks">
          <h2 id="backlinks" className="h2">
            Linked from
          </h2>
          {links.length === 0 ? (
            <p className="muted text-sm">No other page links here yet. Link to it with [[{page.title}]].</p>
          ) : (
            <ul className="space-y-1 text-sm" data-testid="backlinks">
              {links.map((l) => (
                <li key={l.id}>
                  <Link href={`${basePath}/p/${l.id}`} className="link">
                    {l.title}
                  </Link>{" "}
                  <span className="text-xs text-subtle">{l.spaceName}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card space-y-3" aria-labelledby="files">
          <h2 id="files" className="h2">
            Attachments
          </h2>
          {files.length === 0 ? <p className="muted text-sm">No files attached.</p> : null}
          {files.length ? (
            <ul className="space-y-1 text-sm" data-testid="attachments">
              {files.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center justify-between gap-2">
                  <a href={`/api/files/${f.fileId}`} className="link min-w-0 truncate">
                    {f.name}
                  </a>
                  <span className="flex items-center gap-2 text-xs text-subtle">
                    {size(f.size)}
                    {editable ? (
                      <form action={removeAttachmentAction.bind(null, page.id, f.id)}>
                        <button type="submit" className="link text-danger">
                          Remove
                        </button>
                      </form>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {editable && ctx.can("files.upload") ? <AttachButton pageId={page.id} /> : null}
        </section>
      </div>

      {editable ? (
        <form action={archivePageAction.bind(null, page.id, true)} className="border-t border-line pt-4">
          <button type="submit" className="btn btn-danger">
            Archive this page{children.length ? " and the pages under it" : ""}
          </button>
          <span className="ml-3 text-xs text-subtle">Nothing is deleted; it can be brought back from Archived pages.</span>
        </form>
      ) : null}
    </article>
  );
}
