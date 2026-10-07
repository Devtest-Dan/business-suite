import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { openReset } from "@/lib/auth/accounts";
import { resetPasswordAction } from "../../actions";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const reset = token.length >= 20 && token.length <= 100 ? await openReset(token) : null;
  if (!reset) {
    return (
      <div className="card space-y-3">
        <h1 className="h1">This reset link does not work</h1>
        <p className="muted">It has expired (links last 24 hours), was already used, or a newer one was made. Ask for a new link.</p>
        <Link href="/forgot" className="link text-sm">
          Get a new link
        </Link>
      </div>
    );
  }
  return (
    <div className="card space-y-4">
      <div>
        <h1 className="h1">Choose a new password</h1>
        <p className="muted">For {reset.email}. Every other device signed in to this account is signed out.</p>
      </div>
      <ActionForm action={resetPasswordAction} submit="Save the new password" submitClassName="btn btn-primary w-full">
        <input type="hidden" name="token" value={token} />
        <label className="block">
          <span className="label">New password</span>
          <input name="password" type="password" required minLength={10} autoComplete="new-password" className="input" />
        </label>
        <label className="block">
          <span className="label">New password again</span>
          <input name="confirm" type="password" required minLength={10} autoComplete="new-password" className="input" />
        </label>
      </ActionForm>
    </div>
  );
}
