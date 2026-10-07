import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { canManage, ROLE_LABEL } from "../access";
import { archiveSpaceAction, removeMemberAction, setMemberAction, updateSpaceAction } from "../actions";
import { activePeople, getSpace, spaceMembers } from "../data";
import { SpaceFields } from "./new-space";
import { Crumbs, NotHere } from "./shared";

export async function SpaceSettingsPage({ ctx, params, basePath }: ModulePageProps) {
  const id = z.string().uuid().safeParse(params.spaceId);
  const space = id.success ? await getSpace(ctx.db, ctx, id.data) : null;
  if (!space) return <NotHere basePath={basePath} what="space" />;
  const manage = canManage(space.access);
  const [members, people] = await Promise.all([spaceMembers(ctx.db, space.id), manage ? activePeople(ctx.db) : Promise.resolve([])]);
  const outside = people.filter((p) => !members.some((m) => m.userId === p.id));

  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <Crumbs items={[{ label: "Docs", href: basePath }, { label: space.name, href: `${basePath}/s/${space.id}` }, { label: "Settings and people" }]} />
        <h1 className="h1">{space.name}: settings and people</h1>
        <p className="muted">
          {space.visibility === "team"
            ? "A team space: everyone except guests can read it, and people who may write pages can edit it. Members listed below get exactly the role shown."
            : "A private space: only the members below (and admins) can open it."}
        </p>
      </header>

      {manage ? (
        <ActionForm action={updateSpaceAction} submit="Save" className="card space-y-4">
          <input type="hidden" name="spaceId" value={space.id} />
          <SpaceFields name={space.name} description={space.description} visibility={space.visibility} />
        </ActionForm>
      ) : null}

      <section className="card space-y-4" aria-labelledby="members">
        <h2 id="members" className="h2">
          Members
        </h2>
        {members.length === 0 ? (
          <p className="muted text-sm">No one is listed yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table" data-testid="space-members">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>In this space</th>
                  {manage ? <th className="w-24"><span className="sr-only">Remove</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId}>
                    <td>
                      {m.name}
                      {m.userRole === "guest" ? <span className="badge ml-2">Guest</span> : null}
                    </td>
                    <td>{ROLE_LABEL[m.role]}</td>
                    {manage ? (
                      <td>
                        <form action={removeMemberAction.bind(null, space.id, m.userId)}>
                          <button className="btn btn-danger" type="submit">
                            Remove
                          </button>
                        </form>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {manage ? (
          <ActionForm action={setMemberAction} submit="Add or change" submitClassName="btn" className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
            <input type="hidden" name="spaceId" value={space.id} />
            <label className="block min-w-48 flex-1">
              <span className="label">Person</span>
              <select name="userId" className="input" required defaultValue="">
                <option value="" disabled>
                  Choose someone
                </option>
                {[...outside, ...people.filter((p) => !outside.includes(p))].map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.role === "guest" ? " (guest)" : ""}
                    {outside.includes(p) ? "" : " (already a member)"}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Role here</span>
              <select name="role" className="input" defaultValue="editor">
                <option value="viewer">{ROLE_LABEL.viewer}</option>
                <option value="editor">{ROLE_LABEL.editor}</option>
                <option value="manager">{ROLE_LABEL.manager}</option>
              </select>
            </label>
          </ActionForm>
        ) : null}
      </section>

      {manage ? (
        <section className="card space-y-2">
          <h2 className="h2">{space.archivedAt ? "Archived" : "Archive the space"}</h2>
          <p className="muted text-sm">
            {space.archivedAt
              ? "This space is archived: it is hidden from the list and nobody can change its pages. Bring it back to use it again."
              : "Archiving hides the space and stops changes. Nothing is deleted, and you can bring it back."}
          </p>
          <form action={archiveSpaceAction.bind(null, space.id, !space.archivedAt)}>
            <button className={space.archivedAt ? "btn" : "btn btn-danger"} type="submit">
              {space.archivedAt ? "Bring the space back" : "Archive the space"}
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
