import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { importContactsAction } from "../actions";
import { listFields } from "../data";
import { MAX_IMPORT_ROWS } from "../import";
import { Back } from "./parts";

const EXAMPLE = `name,email,phone,company,job_title,tags,notes
Jo Rivera,jo@example.com,555 0142,Northside Bakery,Owner,"wholesale, vip",Met at the trade fair
Sam Lee,sam@example.com,,Hilltop Builders,Site manager,,`;

export async function ImportPage({ ctx, basePath }: ModulePageProps) {
  const fields = await listFields(ctx.db, "contact");
  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <Back href={basePath} label="Contacts" />
        <h1 className="h1">Import contacts</h1>
        <p className="muted">
          Choose a CSV file (or paste its text). The whole file becomes <strong>one approval</strong>: nothing is added until someone approves it, and
          approving twice never adds a row twice.
        </p>
      </header>
      <section className="card space-y-2 text-sm">
        <h2 className="h2">Duplicates</h2>
        <p>
          Each row is checked against your contacts: the same email, then the same phone number, then the same name (when no email or phone says
          otherwise). A match is proposed as a <strong>merge</strong>: it fills empty fields, adds tags and adds to the notes, and never overwrites what
          is already there. Rows that repeat a person inside the file are combined. The approval lists every row with what will happen to it, and after
          approving, each row&apos;s result.
        </p>
      </section>
      <section className="card space-y-2 text-sm">
        <h2 className="h2">Columns</h2>
        <p>
          The first row names the columns. Recognised: <code>name</code> (or <code>first_name</code> and <code>last_name</code>), <code>email</code>,{" "}
          <code>phone</code>, <code>company</code>, <code>job_title</code>, <code>address</code>, <code>tags</code> (separated by commas or semicolons),{" "}
          <code>notes</code>, <code>owner_email</code>
          {fields.length ? (
            <>
              , and your custom fields: {fields.map((f, i) => (
                <span key={f.key}>
                  {i ? ", " : ""}
                  <code>{f.key}</code>
                </span>
              ))}
            </>
          ) : null}
          . Other columns are ignored (the approval lists them). At most {MAX_IMPORT_ROWS.toLocaleString("en")} rows per file.
        </p>
        <p className="text-subtle">Rows holding anything that looks like a payment card number are refused and listed.</p>
      </section>
      <ActionForm action={importContactsAction} submit="Check and send for approval" className="card space-y-4">
        <label className="block">
          <span className="label">CSV file</span>
          <input type="file" name="file" accept=".csv,text/csv" className="input" />
        </label>
        <label className="block">
          <span className="label">Or paste the CSV text</span>
          <textarea name="csv" rows={10} className="input font-mono text-sm" placeholder={EXAMPLE} />
        </label>
      </ActionForm>
    </div>
  );
}
