import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { getViewer } from "@/lib/auth/session";
import { isSetupDone } from "@/lib/settings";
import { signIn } from "../actions";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!(await isSetupDone())) redirect("/setup");
  if (await getViewer()) redirect("/");
  const { next } = await searchParams;
  return (
    <div className="card space-y-4">
      <h1 className="h1">Sign in</h1>
      <ActionForm action={signIn} submit="Sign in" submitClassName="btn btn-primary w-full">
        <input type="hidden" name="next" value={next ?? ""} />
        <label className="block">
          <span className="label">Email</span>
          <input name="email" type="email" required autoComplete="email" className="input" />
        </label>
        <label className="block">
          <span className="label">Password</span>
          <input name="password" type="password" required autoComplete="current-password" className="input" />
        </label>
      </ActionForm>
      <p className="text-sm">
        <Link href="/forgot" className="link">
          Forgot your password?
        </Link>
      </p>
    </div>
  );
}
