import { useState } from "react";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";
import type { KeyPerson } from "@/pages/admin/lib/offices";

const EMPTY: KeyPerson = { fullName: "", role: "", email: "", phone: "", marn: "" };

/**
 * People added by hand (owner 2026-11-24): the CEO, directors or staff the register search did not find. One line each; Add person opens
 * a small form. They are offered in the Full name search for the business admin agent.
 */
export default function KeyPeopleList({ people, onChange, disabled }: { people: KeyPerson[]; onChange: (p: KeyPerson[]) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState<KeyPerson | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [problem, setProblem] = useState("");
  const set = (key: keyof KeyPerson, value: string) => setDraft(d => (d ? { ...d, [key]: value } : d));
  const save = () => {
    if (!draft) return;
    const p = { ...draft, fullName: draft.fullName.trim(), role: draft.role?.trim(), email: draft.email?.trim().toLowerCase(), phone: draft.phone?.trim(), marn: draft.marn?.replace(/\D/g, "") };
    if (p.fullName.split(/\s+/).length < 2) { setProblem("Enter their first and last name."); return; }
    if (p.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) { setProblem("Check the email address."); return; }
    onChange(editing === null ? [...people, p] : people.map((x, i) => (i === editing ? p : x)));
    setDraft(null); setEditing(null); setProblem("");
  };
  return (
    <section className="mt-2 rounded-lg border border-background-200 px-3 py-2" aria-label="People" data-testid="key-people">
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-foreground-900"><i className="ri-team-line text-sky-700" aria-hidden="true" />People {people.length ? `(${people.length})` : ""}
        <span className="text-xs font-normal text-foreground-500">CEO, directors, staff; add anyone the search did not find</span></p>
      {people.length ? <ul className="mb-2 divide-y divide-background-200 rounded-lg border border-background-200 bg-white">
        {people.map((p, i) => <li key={`${p.fullName}${i}`} className="flex items-center gap-3 px-3 py-2 text-sm">
          <p className="min-w-0 flex-1 truncate"><span className="font-semibold text-foreground-900">{p.fullName}</span>
            <span className="text-foreground-600">{[p.role, p.email, p.phone, p.marn ? `MARN ${p.marn}` : ""].filter(Boolean).map(x => ` · ${x}`).join("")}</span></p>
          <button type="button" disabled={disabled} className="shrink-0 text-xs font-semibold text-primary-700 hover:underline" onClick={() => { setDraft({ ...EMPTY, ...p }); setEditing(i); setProblem(""); }}>Edit</button>
          <button type="button" disabled={disabled} className="shrink-0 text-xs font-semibold text-red-700 hover:underline" onClick={() => onChange(people.filter((_, j) => j !== i))}>Remove</button>
        </li>)}
      </ul> : null}
      {draft ? <div className="rounded-lg border border-sky-200 bg-white p-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Full name" required><TextInput autoFocus disabled={disabled} maxLength={120} value={draft.fullName} onChange={e => set("fullName", e.target.value)} /></Field>
          <Field label="Role"><TextInput disabled={disabled} maxLength={80} placeholder="e.g. CEO, Director" value={draft.role ?? ""} onChange={e => set("role", e.target.value)} /></Field>
          <Field label="Email"><TextInput disabled={disabled} type="email" maxLength={200} value={draft.email ?? ""} onChange={e => set("email", e.target.value)} /></Field>
          <Field label="Mobile"><TextInput disabled={disabled} inputMode="tel" maxLength={40} placeholder="0412 345 678" value={draft.phone ?? ""} onChange={e => set("phone", e.target.value)} /></Field>
          <Field label="MARN (if a registered migration agent)"><TextInput disabled={disabled} inputMode="numeric" maxLength={10} value={draft.marn ?? ""} onChange={e => set("marn", e.target.value.replace(/\D/g, ""))} /></Field>
        </div>
        {problem ? <p role="alert" className="mt-2 text-xs font-medium text-red-700">{problem}</p> : null}
        <div className="mt-3 flex gap-2">
          <Button type="button" icon="ri-check-line" disabled={disabled} onClick={save}>{editing === null ? "Add person" : "Save"}</Button>
          <Button type="button" variant="secondary" disabled={disabled} onClick={() => { setDraft(null); setEditing(null); setProblem(""); }}>Cancel</Button>
        </div>
      </div> : <Button type="button" variant="secondary" icon="ri-user-add-line" disabled={disabled || people.length >= 50} onClick={() => { setDraft({ ...EMPTY }); setEditing(null); }} data-testid="key-people-add">Add person by hand</Button>}
    </section>
  );
}
