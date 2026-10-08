import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { importLeadsAction, saveSettingsAction } from "../actions";
import { getSettings } from "../data";
import { MAX_IMPORT_ROWS } from "../import";
import { Back, SubNav } from "./parts";

export async function SettingsPage({ ctx, basePath }: ModulePageProps) {
  const settings = await getSettings(ctx.db);
  return (
    <div className="max-w-3xl space-y-5">
      <header>
        <h1 className="h1">Leads settings</h1>
      </header>
      <SubNav basePath={basePath} current="settings" canManage />
      <ActionForm action={saveSettingsAction} submit="Save" className="card space-y-4">
        <label className="block">
          <span className="label">Speed-to-lead target (minutes)</span>
          <input name="targetMinutes" type="number" min={1} max={2880} required defaultValue={settings.targetMinutes} className="input max-w-40" />
          <span className="hint">A new lead not contacted within this time is shown in red, on the home page and in the list.</span>
        </label>
        <label className="block">
          <span className="label">Postal address of {ctx.business.name}</span>
          <textarea name="postalAddress" rows={3} maxLength={500} defaultValue={settings.postalAddress} className="input" placeholder={"Street and number\nCity, State ZIP"} />
          <span className="hint">Printed at the foot of every sequence email, as US law (CAN-SPAM) requires. A post office box you have registered is fine. Without it, sequences cannot be switched on. The business name comes from Settings → Business.</span>
        </label>
      </ActionForm>
      <p className="hint">Who gets new-lead alerts when a form sends nobody in particular: everyone holding “Get new-lead alerts” in Settings → Permissions (owners and admins until you change it).</p>
    </div>
  );
}

export async function ImportPage({ basePath }: ModulePageProps) {
  return (
    <div className="max-w-3xl space-y-5">
      <header>
        <Back href={basePath} label="Leads" />
        <h1 className="h1">Import leads</h1>
        <p className="muted">
          A CSV file whose first row names the columns: <code>name</code> (or <code>first_name</code> and <code>last_name</code>), <code>email</code>, <code>phone</code>, <code>company</code>, <code>message</code>, <code>service</code>, <code>source</code>. Up to {MAX_IMPORT_ROWS.toLocaleString("en")} rows.
        </p>
      </header>
      <ActionForm action={importLeadsAction} submit="Check and send for approval" className="card space-y-4">
        <label className="block">
          <span className="label">CSV file</span>
          <input type="file" name="file" accept=".csv,text/csv" className="input" />
        </label>
        <label className="block">
          <span className="label">Or paste the CSV</span>
          <textarea name="csv" rows={6} className="input font-mono text-xs" />
        </label>
        <p className="hint">The whole file becomes one approval. Rows that repeat an email or phone number, in the file or already in Leads, are left out and counted. Imported leads get no alerts and no speed-to-lead clock.</p>
      </ActionForm>
    </div>
  );
}
