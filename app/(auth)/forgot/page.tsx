import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { mailConfigured } from "@/lib/mail";
import { forgotPasswordAction } from "../actions";

export const metadata: Metadata = { title: "Forgot password" };

export default async function ForgotPage() {
  const canEmail = await mailConfigured();
  return (
    <div className="card space-y-4">
      <h1 className="h1">Forgot your password?</h1>
      {canEmail ? (
        <ActionForm action={forgotPasswordAction} submit="Email me a reset link" submitClassName="btn btn-primary w-full">
          <label className="block">
            <span className="label">Your email</span>
            <input name="email" type="email" required autoComplete="email" className="input" />
          </label>
        </ActionForm>
      ) : (
        <p className="muted">This suite cannot send email yet. Ask the owner or an admin for a reset link: they can make one for you under People.</p>
      )}
      <p className="text-sm">
        <Link href="/sign-in" className="link">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
