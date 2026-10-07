import Link from "next/link";
import { Icon } from "@/lib/icons";
import type { ModulePageProps } from "@/lib/modules/contract";
import { P } from "../constants";
import { listProjects } from "../data";

export async function ProjectsPage({ ctx, basePath, searchParams }: ModulePageProps) {
  const showArchived = searchParams.archived === "1";
  const projects = await listProjects(ctx, { includeArchived: showArchived });
  const canManage = ctx.can(P.manage);
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h1">Projects</h1>
          <p className="muted">{canManage ? "Every project in the business." : "The projects you can see: the team's, and private ones you are a member of."}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage ? (
            <>
              <Link href={`${basePath}/templates`} className="btn">
                From a template
              </Link>
              <Link href={`${basePath}/projects/new`} className="btn btn-primary">
                <Icon name="plus" className="size-4" /> New project
              </Link>
            </>
          ) : null}
        </div>
      </header>

      {projects.length === 0 ? (
        <div className="card text-center">
          <p className="font-medium">No projects yet.</p>
          <p className="muted">{canManage ? "Start one with “New project”, or from a template." : "When someone adds you to a project, it shows up here."}</p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <Link href={`${basePath}/p/${p.id}`} className="card card-link block h-full space-y-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h2 className="font-semibold">{p.name}</h2>
                  {p.archived ? <span className="badge badge-warn">Archived</span> : null}
                  {p.visibility === "private" ? <span className="badge">Private</span> : null}
                </div>
                {p.description ? <p className="muted line-clamp-2 text-sm">{p.description}</p> : null}
                <p className="text-sm">
                  {p.open} open
                  {p.overdue ? <span className="text-danger"> · {p.overdue} overdue</span> : null}
                  <span className="text-subtle"> · {p.done} done</span>
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link href={showArchived ? `${basePath}/projects` : `${basePath}/projects?archived=1`} className="link text-sm">
        {showArchived ? "Hide archived projects" : "Show archived projects"}
      </Link>
    </div>
  );
}
