import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { addFieldAction, deleteFieldAction, deleteStageAction, moveStageAction, saveStageAction } from "../actions";
import { dealsByStage, listFields } from "../data";
import { MAX_FIELDS_PER_ENTITY } from "../schemas";
import { Back } from "./parts";

const KIND_LABEL = { open: "Open", won: "Won (closes the deal)", lost: "Lost (closes the deal)" } as const;
const ENTITY_LABEL = { contact: "Contacts", company: "Companies", deal: "Deals" } as const;

/** The owner's pipeline stages and custom fields. */
export async function SettingsPage({ ctx, basePath }: ModulePageProps) {
  const [stages, contactFields, companyFields, dealFields] = await Promise.all([dealsByStage(ctx.db), listFields(ctx.db, "contact"), listFields(ctx.db, "company"), listFields(ctx.db, "deal")]);
  const fieldsBy = { contact: contactFields, company: companyFields, deal: dealFields };
  return (
    <div className="max-w-3xl space-y-8">
      <header>
        <Back href={basePath} label="Contacts" />
        <h1 className="h1">Pipeline and fields</h1>
        <p className="muted">The stages a deal goes through, and a few fields of your own for contacts, companies and deals.</p>
      </header>

      <section className="space-y-3" aria-labelledby="stages">
        <h2 id="stages" className="h2">
          Pipeline stages
        </h2>
        <ol className="space-y-2" data-testid="stage-list">
          {stages.map((s, i) => (
            <li key={s.id} className="card space-y-2 p-3 sm:p-3">
              <ActionForm action={saveStageAction} submit="Save" submitClassName="btn" className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="id" value={s.id} />
                <label className="block min-w-40 flex-1">
                  <span className="label">Stage {i + 1}</span>
                  <input name="name" required maxLength={60} defaultValue={s.name} className="input" />
                </label>
                <label className="block">
                  <span className="label">Kind</span>
                  <select name="kind" defaultValue={s.kind} className="input">
                    {Object.entries(KIND_LABEL).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </ActionForm>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-subtle">{s.deals} deal{s.deals === 1 ? "" : "s"}</span>
                <form action={moveStageAction.bind(null, s.id, "up")}>
                  <button type="submit" className="btn" disabled={i === 0} aria-label={`Move ${s.name} up`}>
                    ↑
                  </button>
                </form>
                <form action={moveStageAction.bind(null, s.id, "down")}>
                  <button type="submit" className="btn" disabled={i === stages.length - 1} aria-label={`Move ${s.name} down`}>
                    ↓
                  </button>
                </form>
                <ActionForm action={deleteStageAction} submit="Remove" submitClassName="btn btn-danger" className="flex items-center gap-2">
                  <input type="hidden" name="stageId" value={s.id} />
                </ActionForm>
              </div>
            </li>
          ))}
        </ol>
        <ActionForm action={saveStageAction} submit="Add stage" className="card flex flex-wrap items-end gap-2" resetOnSuccess>
          <label className="block min-w-40 flex-1">
            <span className="label">New stage</span>
            <input name="name" required maxLength={60} className="input" />
          </label>
          <label className="block">
            <span className="label">Kind</span>
            <select name="kind" defaultValue="open" className="input">
              {Object.entries(KIND_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </ActionForm>
        <p className="hint">The deal counts include closed deals of the last 30 days. A stage with deals cannot be removed: move its deals first.</p>
      </section>

      <section className="space-y-3" aria-labelledby="fields">
        <h2 id="fields" className="h2">
          Custom fields
        </h2>
        <p className="muted text-sm">Up to {MAX_FIELDS_PER_ENTITY} for each kind of record. They show on the record&apos;s form and page, in exports, and as import columns.</p>
        {(Object.keys(fieldsBy) as (keyof typeof fieldsBy)[]).map((entity) => (
          <div key={entity} className="card space-y-2">
            <h3 className="font-semibold">{ENTITY_LABEL[entity]}</h3>
            {fieldsBy[entity].length === 0 ? (
              <p className="muted text-sm">None yet.</p>
            ) : (
              <ul className="divide-y divide-line text-sm" data-testid={`fields-${entity}`}>
                {fieldsBy[entity].map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span>
                      {f.label} <span className="text-subtle">({f.type}{f.options.length ? `: ${f.options.join(", ")}` : ""}) · column <code>{f.key}</code></span>
                    </span>
                    <form action={deleteFieldAction.bind(null, f.id)}>
                      <button type="submit" className="btn btn-danger">
                        Remove
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <ActionForm action={addFieldAction} submit="Add field" className="card grid gap-3 sm:grid-cols-2" resetOnSuccess>
          <label className="block">
            <span className="label">For</span>
            <select name="entity" className="input">
              <option value="contact">Contacts</option>
              <option value="company">Companies</option>
              <option value="deal">Deals</option>
            </select>
          </label>
          <label className="block">
            <span className="label">Label</span>
            <input name="label" required maxLength={60} className="input" placeholder="e.g. Birthday" />
          </label>
          <label className="block">
            <span className="label">Type</span>
            <select name="type" className="input">
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="date">Date</option>
              <option value="choice">Choice</option>
            </select>
          </label>
          <label className="block">
            <span className="label">Choices (for a choice field)</span>
            <input name="options" maxLength={1000} className="input" placeholder="e.g. Email, Phone, Text message" />
          </label>
        </ActionForm>
      </section>
    </div>
  );
}
