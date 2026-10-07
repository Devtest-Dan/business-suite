import { and, asc, desc, gt, isNull } from "drizzle-orm";
import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { can, requireViewer } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { invites, users } from "@/lib/db/schema";
import { formatDate, formatDateTime } from "@/lib/format";
import { mailConfigured } from "@/lib/mail";
import { ROLE_LABELS } from "@/lib/permissions";
import { businessProfile } from "@/lib/settings";
import { changeRoleAction, inviteAction, resetLinkAction, revokeInvite, setActiveAction } from "./actions";

export const metadata: Metadata = { title: "People" };

export default async function PeoplePage() {
  const viewer = await requireViewer();
  const manage = await can(viewer, "people.manage");
  const business = await businessProfile();
  if (viewer.role === "guest" && !manage) {
    return (
      <div className="card max-w-xl space-y-2">
        <h1 className="h1">People</h1>
        <p className="muted">Guests do not see the list of people. Ask the owner if you need it.</p>
      </div>
    );
  }
  const people = await db().select().from(users).orderBy(asc(users.name));
  const open = manage
    ? await db()
        .select()
        .from(invites)
        .where(and(isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date())))
        .orderBy(desc(invites.createdAt))
    : [];
  const canEmail = await mailConfigured();
  const grantable = viewer.role === "owner" ? (["admin", "member", "guest"] as const) : (["member", "guest"] as const);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="h1">People</h1>
        <p className="muted">Everyone with an account in {business.name}&apos;s suite.</p>
      </header>

      {manage ? (
        <section className="card space-y-3" aria-labelledby="invite">
          <h2 id="invite" className="h2">
            Invite someone
          </h2>
          <p className="muted text-sm">
            {canEmail ? "They get an email with a link to choose their name and password." : "Email is not set up, so you get a link to copy and send yourself (Settings → Email turns on sending)."}
          </p>
          <ActionForm action={inviteAction} submit="Make invite" className="flex flex-wrap items-end gap-3" resetOnSuccess={false}>
            <label className="block min-w-60 flex-1">
              <span className="label">Email</span>
              <input name="email" type="email" required className="input" />
            </label>
            <label className="block">
              <span className="label">Role</span>
              <select name="role" className="input" defaultValue="member">
                {grantable.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
          </ActionForm>
          <p className="text-xs text-subtle">
            Admins manage people and settings. Members use the apps. Guests only see what their role allows (Settings → Permissions).
          </p>
        </section>
      ) : null}

      {open.length ? (
        <section className="space-y-3" aria-labelledby="open-invites">
          <h2 id="open-invites" className="h2">
            Open invites
          </h2>
          <ul className="card divide-y divide-line p-0 sm:p-0">
            {open.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  {i.email} <span className="badge">{ROLE_LABELS[i.role]}</span>
                  <span className="block text-xs text-subtle">
                    {i.emailed ? "Emailed" : "Link copied by hand"} · works until {formatDate(i.expiresAt, business.timezone)}
                  </span>
                </span>
                <form action={revokeInvite.bind(null, i.id)}>
                  <button className="btn btn-danger" type="submit">
                    Cancel invite
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-3" aria-labelledby="everyone">
        <h2 id="everyone" className="h2">
          Everyone
        </h2>
        <ul className="space-y-3" data-testid="people-list">
          {people.map((p) => {
            const editable = manage && p.role !== "owner" && p.id !== viewer.id && (p.role !== "admin" || viewer.role === "owner");
            return (
              <li key={p.id} id={p.id} className="card space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  <span className="badge">{ROLE_LABELS[p.role]}</span>
                  {p.status === "disabled" ? <span className="badge badge-danger">Switched off</span> : null}
                  {p.id === viewer.id ? <span className="badge badge-accent">You</span> : null}
                </div>
                <p className="muted text-sm">
                  {p.email}
                  {manage ? ` · last signed in ${p.lastSignInAt ? formatDateTime(p.lastSignInAt, business.timezone) : "never"}` : ""}
                </p>
                {editable ? (
                  <div className="flex flex-wrap items-end gap-3">
                    <ActionForm action={changeRoleAction} submit="Change role" submitClassName="btn" className="flex items-end gap-2">
                      <input type="hidden" name="userId" value={p.id} />
                      <select name="role" defaultValue={p.role} className="input" aria-label={`Role for ${p.name}`}>
                        {grantable.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    </ActionForm>
                    <ActionForm action={setActiveAction} submit={p.status === "active" ? "Switch off" : "Switch on"} submitClassName={p.status === "active" ? "btn btn-danger" : "btn"}>
                      <input type="hidden" name="userId" value={p.id} />
                      <input type="hidden" name="active" value={p.status === "active" ? "no" : "yes"} />
                    </ActionForm>
                    <ActionForm action={resetLinkAction} submit="Make a reset link" submitClassName="btn">
                      <input type="hidden" name="userId" value={p.id} />
                    </ActionForm>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
