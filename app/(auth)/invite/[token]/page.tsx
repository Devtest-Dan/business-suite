import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { openInvite } from "@/lib/auth/accounts";
import { ROLE_LABELS } from "@/lib/permissions";
import { businessProfile } from "@/lib/settings";
import { acceptInviteAction } from "../../actions";

export const metadata: Metadata = { title: "Join" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = token.length >= 20 && token.length <= 100 ? await openInvite(token) : null;
  const business = await businessProfile();
  if (!invite) {
    return (
      <div className="card space-y-3">
        <h1 className="h1">This invite does not work</h1>
        <p className="muted">It has expired, was already used, or was replaced by a newer invite. Ask whoever invited you to send a new one.</p>
        <Link href="/sign-in" className="link text-sm">
          Already have an account? Sign in
        </Link>
      </div>
    );
  }
  return (
    <div className="card space-y-4">
      <div>
        <h1 className="h1">Join {business.name}</h1>
        <p className="muted">
          You were invited as <strong>{ROLE_LABELS[invite.role]}</strong> with <strong>{invite.email}</strong>. Choose your name and a password.
        </p>
      </div>
      <ActionForm action={acceptInviteAction} submit="Create my account" submitClassName="btn btn-primary w-full">
        <input type="hidden" name="token" value={token} />
        <label className="block">
          <span className="label">Your name</span>
          <input name="name" required maxLength={100} autoComplete="name" className="input" />
        </label>
        <label className="block">
          <span className="label">Password</span>
          <input name="password" type="password" required minLength={10} autoComplete="new-password" className="input" />
          <span className="hint">At least 10 characters.</span>
        </label>
        <label className="block">
          <span className="label">Password again</span>
          <input name="confirm" type="password" required minLength={10} autoComplete="new-password" className="input" />
        </label>
      </ActionForm>
    </div>
  );
}
