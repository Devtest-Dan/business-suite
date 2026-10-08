import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { TimezoneSelect } from "@/components/timezone-select";
import { env } from "@/lib/env";
import { timezones } from "@/lib/format";
import { isSetupDone } from "@/lib/settings";
import { completeSetup } from "./actions";

export const metadata: Metadata = { title: "Set up" };

export default async function SetupPage() {
  if (await isSetupDone()) redirect("/sign-in");
  const needsCode = Boolean(env().setupCode);
  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <h1 className="h1">Set up your business suite</h1>
      <p className="muted mt-1">
        This creates the owner account. The owner can do everything, including invite the rest of the team. You can change all of this later in Settings.
      </p>
      <ActionForm action={completeSetup} submit="Create the owner account" className="card mt-6 space-y-5">
        {needsCode ? (
          <label className="block">
            <span className="label">Setup code</span>
            <input name="setupCode" required autoComplete="off" className="input font-mono" />
            <span className="hint">Printed at the end of the install (on the server: /var/log/business-suite-install.log), or the SETUP_CODE you wrote in the cloud-init text. It stops a stranger who finds this page first from taking it.</span>
          </label>
        ) : null}
        <fieldset className="space-y-4">
          <legend className="h2">Your business</legend>
          <label className="block">
            <span className="label">Business name</span>
            <input name="businessName" required maxLength={120} className="input" />
          </label>
          <label className="block">
            <span className="label">Timezone</span>
            <TimezoneSelect name="timezone" zones={timezones()} />
          </label>
        </fieldset>
        <fieldset className="space-y-4">
          <legend className="h2">You, the owner</legend>
          <label className="block">
            <span className="label">Your name</span>
            <input name="name" required maxLength={100} autoComplete="name" className="input" />
          </label>
          <label className="block">
            <span className="label">Email</span>
            <input name="email" type="email" required autoComplete="email" className="input" />
          </label>
          <label className="block">
            <span className="label">Password</span>
            <input name="password" type="password" required minLength={10} autoComplete="new-password" className="input" />
            <span className="hint">At least 10 characters. A few words in a row works well.</span>
          </label>
          <label className="block">
            <span className="label">Password again</span>
            <input name="confirm" type="password" required minLength={10} autoComplete="new-password" className="input" />
          </label>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="h2">AI (optional)</legend>
          <label className="block">
            <span className="label">DeepSeek API key</span>
            <input name="aiKey" type="password" autoComplete="off" className="input font-mono" />
            <span className="hint">Leave empty to set up AI later (Settings → AI), or to use a different provider or a model on this server.</span>
          </label>
        </fieldset>
      </ActionForm>
    </main>
  );
}
