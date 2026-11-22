import { useState } from "react";
import type { Definition, Rule, Snapshot } from "./model";

/** Student-facing validation settings backed by the existing published Business Rules. */
const STEPS = [
  { id: "passport", title: "Passport", icon: "ri-passport-line", docs: ["Passport"], rules: ["admissions.application_required_documents", "admissions.document_expiry_warning_months", "admissions.passport_reject_expired", "admissions.passport_auto_delete_expired", "admissions.passport_require_expiry_date"] },
  { id: "english", title: "English evidence", icon: "ri-translate-2", docs: ["English test"], rules: ["admissions.application_required_documents", "admissions.english_minimum_scores", "admissions.english_result_valid_years", "admissions.english_test_alternatives"] },
  { id: "academic", title: "Academic results", icon: "ri-graduation-cap-line", docs: ["Academic results"], rules: ["admissions.application_required_documents", "admissions.academic_minimum_documents", "admissions.academic_reject_mismatched", "admissions.academic_passport_name_review"] },
  { id: "visa", title: "Visa", icon: "ri-id-card-line", docs: ["Visa"], rules: ["admissions.application_required_documents", "admissions.document_expiry_warning_months", "admissions.visa_passport_name_review", "admissions.visa_require_expiry_date", "admissions.visa_reject_expired", "admissions.visa_require_subclass", "admissions.visa_vevo_review"] },
  { id: "licence", title: "Driving licence", icon: "ri-profile-line", docs: ["Driving licence"], rules: ["admissions.application_required_documents"] },
  { id: "language", title: "Language spoken at home", icon: "ri-chat-3-line", docs: [], rules: [] },
  { id: "usi", title: "USI", icon: "ri-fingerprint-line", docs: [], rules: ["admissions.usi_required"] },
  { id: "emergency", title: "Emergency contact", icon: "ri-phone-line", docs: [], rules: ["admissions.emergency_contact_required_details"] },
  { id: "course", title: "Course & intake", icon: "ri-book-open-line", docs: [], rules: [] },
] as const;

const NAMES: Record<string, string> = {
  "admissions.application_required_documents": "Document required before Next",
  "admissions.passport_reject_expired": "Reject expired passport",
  "admissions.passport_auto_delete_expired": "Automatically delete expired passport",
  "admissions.passport_require_expiry_date": "Require extracted expiry date",
  "admissions.document_expiry_warning_months": "Document expiry warning period",
  "admissions.academic_minimum_documents": "Minimum academic files required",
  "admissions.academic_passport_name_review": "Review academic name against passport",
  "admissions.academic_reject_mismatched": "Reject files identified as non-academic",
  "admissions.visa_passport_name_review": "Review visa name against passport",
  "admissions.visa_require_expiry_date": "Require visa expiry date",
  "admissions.visa_reject_expired": "Reject expired visa evidence",
  "admissions.visa_require_subclass": "Require visa subclass",
  "admissions.visa_vevo_review": "Remind staff to verify with VEVO",
  "admissions.english_minimum_scores": "Minimum English scores",
  "admissions.english_result_valid_years": "English test validity",
  "admissions.english_test_alternatives": "Accepted English alternatives",
  "admissions.usi_required": "USI requirement",
  "admissions.emergency_contact_required_details": "Required emergency contact details",
};

export default function StudentWizardRules({ snapshot, publish, busy, showAdvanced }: {
  snapshot: Snapshot;
  publish: (rule: Rule, definition: Definition, reason: string) => Promise<boolean>;
  busy: boolean;
  showAdvanced: () => void;
}) {
  const [selected, setSelected] = useState<string>("passport");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const step = STEPS.find(item => item.id === selected) ?? STEPS[0];
  const find = (id: string) => snapshot.rules.find(rule => rule.identifier === id);
  const active = (rule: Rule) => rule.versions.find(v => v.state === "published") ?? rule.versions[0];
  const changeRequired = async (doc: string, checked: boolean) => {
    const rule = find("admissions.application_required_documents");
    const version = rule && active(rule);
    if (!rule || !version) return;
    const current = Array.isArray(version.definition.value) ? version.definition.value.filter((x): x is string => typeof x === "string") : [];
    const next = checked ? [...new Set([...current, doc])] : current.filter(x => x !== doc);
    setMessage("");
    const ok = await publish(rule, { ...version.definition, value: next }, `Student wizard: ${doc} ${checked ? "required" : "optional"}`);
    setMessage(ok ? "Published successfully." : "Could not publish. Review the error above.");
  };
  const saveRule = async (id: string) => {
    const rule = find(id);
    const version = rule && active(rule);
    if (!rule || !version) return;
    const raw = edits[id];
    if (raw === undefined) return;
    let value: unknown;
    try {
      if (version.definition.value_type === "boolean") {
        if (raw !== "true" && raw !== "false") throw new Error("Choose Yes or No");
        value = raw === "true";
      } else if (["number", "percentage", "days", "hours", "weeks", "currency"].includes(version.definition.value_type)) {
        if (!raw.trim() || !Number.isFinite(Number(raw))) throw new Error("Enter a valid number");
        value = Number(raw);
      } else if (version.definition.value_type === "text" || version.definition.value_type === "dropdown") {
        value = raw;
      } else {
        value = JSON.parse(raw);
        if (Array.isArray(version.definition.value) && !Array.isArray(value)) throw new Error("Enter a JSON array");
        if (version.definition.value && typeof version.definition.value === "object" && !Array.isArray(version.definition.value) && (value === null || Array.isArray(value) || typeof value !== "object")) throw new Error("Enter a JSON object");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Invalid value");
      return;
    }
    const ok = await publish(rule, { ...version.definition, value }, "Student wizard validation: " + id);
    setMessage(ok ? "Rule published." : "Could not publish. Review the error above.");
    if (ok) setEdits(old => { const next = { ...old }; delete next[id]; return next; });
  };
  const requiredRule = find("admissions.application_required_documents");
  const requiredValue = requiredRule && active(requiredRule)?.definition.value;
  const required = Array.isArray(requiredValue) ? requiredValue : ["Passport", "English test", "Academic results", "Visa"];
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3">
      <div><h2 className="text-lg font-semibold text-foreground-900">Wizard rules</h2><p className="text-xs text-foreground-600">Select a page, then edit its settings.</p></div>
      <button type="button" onClick={showAdvanced} className="shrink-0 text-sm font-medium text-primary-700 hover:underline">Advanced rules</button>
    </div>
    {message && <p role="status" className="text-sm text-foreground-700">{message}</p>}
    <div className="grid grid-cols-1 gap-0 border-t border-background-200 lg:grid-cols-[minmax(170px,210px)_minmax(0,1fr)] lg:divide-x lg:divide-background-200">
      <nav className="p-2 lg:pr-3" aria-label="Student wizard steps">
        <input aria-label="Find wizard step" placeholder="Search steps" value={search} onChange={e => setSearch(e.target.value)}
          className="mb-2 w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm" />
        {STEPS.filter(item => item.title.toLowerCase().includes(search.toLowerCase())).map(item =>
          <button type="button" key={item.id} onClick={() => { setSelected(item.id); setMessage(""); }}
            aria-current={selected === item.id ? "step" : undefined}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${selected === item.id ? "bg-primary-50 font-semibold text-primary-800" : "text-foreground-700 hover:bg-background-100"}`}>
            <i className={item.icon} aria-hidden="true" />{item.title}</button>)}
      </nav>
      <section className="min-w-0 space-y-3 p-3 sm:p-4 lg:pl-5" aria-label={step.title + " rules"}>
        <div><h3 className="font-semibold text-foreground-900">{step.title}</h3>
          <p className="text-xs text-foreground-600">Settings are saved and published through SLIT's existing rule service.</p></div>
        {step.docs.map(doc => <label key={doc} className="flex items-center justify-between gap-3 border-b border-background-200 py-3">
          <span><span className="block text-sm font-medium">Require {doc}</span>
            </span>
          <input type="checkbox" checked={required.includes(doc)} disabled={busy || !requiredRule}
            onChange={e => void changeRequired(doc, e.target.checked)} className="h-4 w-4 accent-primary-600" />
        </label>)}
        {step.rules.filter(id => id !== "admissions.application_required_documents").map(id => {
          const rule = find(id);
          const version = rule && active(rule);
          const value = version?.definition.value;
          const type = version?.definition.value_type ?? "";
          const editable = Boolean(version && version.state === "published");
          const shown = edits[id] ?? (typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2));
          return <div key={id} className="grid gap-2 border-b border-background-200 py-3 xl:grid-cols-[minmax(0,1fr)_minmax(150px,230px)] xl:items-center">
            <label htmlFor={id} className="text-sm font-medium">{NAMES[id]}</label>
            {!rule || !version ? <p className="text-xs text-foreground-600">Rule not registered. Existing checks stay in force.</p> :
              <>
                {id === "admissions.english_minimum_scores" && value && typeof value === "object" && !Array.isArray(value) ?
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {Object.entries(value as Record<string, unknown>).map(([test, original]) => {
                      const draft = edits[id] === undefined ? value as Record<string, unknown> : (() => { try { return JSON.parse(edits[id]) as Record<string, unknown>; } catch { return value as Record<string, unknown>; } })();
                      return <label key={test} className="block text-sm font-medium">{test} minimum score
                        <input type="number" min="0" step="any" disabled={busy || !editable}
                          value={String(draft[test] ?? original ?? "")}
                          onChange={e => setEdits(old => ({ ...old, [id]: JSON.stringify({ ...draft, [test]: e.target.value === "" ? null : Number(e.target.value) }) }))}
                          className="mt-1 w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm" />
                      </label>;
                    })}
                  </div> :
                  id === "admissions.english_test_alternatives" && Array.isArray(value) ?
                  <div className="space-y-2">
                    <p className="text-xs text-foreground-600">Tick the alternatives SLIT accepts instead of an English test result.</p>
                    {Array.from(new Set([...(value as string[]), "At least 2 years of study in Australia", "Cambridge English course with Skyline"])).map(option => {
                      const chosen: string[] = edits[id] === undefined ? value as string[] : (() => { try { return JSON.parse(edits[id]) as string[]; } catch { return value as string[]; } })();
                      return <label key={option} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={chosen.includes(option)} disabled={busy || !editable}
                          onChange={e => setEdits(old => ({ ...old, [id]: JSON.stringify(e.target.checked ? [...chosen, option] : chosen.filter(x => x !== option)) }))}
                          className="h-4 w-4 accent-primary-600" />{option}
                      </label>;
                    })}
                  </div> :
                  type === "boolean" ?
                  <select id={id} disabled={busy || !editable} value={shown} onChange={e => setEdits(old => ({ ...old, [id]: e.target.value }))} className="w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm">
                    <option value="true">Yes</option><option value="false">No</option>
                  </select> :
                  ["number", "percentage", "days", "hours", "weeks", "currency"].includes(type) ?
                  <input id={id} type="number" disabled={busy || !editable} value={shown} onChange={e => setEdits(old => ({ ...old, [id]: e.target.value }))} className="w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm" /> :
                  type === "dropdown" && version.definition.options.length ?
                  <select id={id} disabled={busy || !editable} value={shown} onChange={e => setEdits(old => ({ ...old, [id]: e.target.value }))} className="w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm">
                    {version.definition.options.map(option => <option key={option} value={option}>{option}</option>)}
                  </select> :
                  <textarea id={id} rows={typeof value === "object" ? 5 : 2} disabled={busy || !editable} value={shown} onChange={e => setEdits(old => ({ ...old, [id]: e.target.value }))} className="w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 font-mono text-xs" />}
                {edits[id] !== undefined && <div className="flex justify-end gap-2 sm:col-span-2"><button type="button" onClick={() => setEdits(old => { const next = { ...old }; delete next[id]; return next; })} className="px-3 py-1.5 text-xs text-foreground-600">Cancel</button><button type="button" disabled={busy || !editable} onClick={() => void saveRule(id)} className="rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">Publish change</button></div>}
              </>}
          </div>;
        })}
        {!step.rules.length && <p className="text-sm text-foreground-600">No independently configurable validation rule is registered for this step yet. Existing application checks remain active.</p>}
        <div className="pt-1"><button type="button" onClick={() => setShowHelp(!showHelp)} className="text-xs text-primary-700 hover:underline">{showHelp ? "Hide guidance" : "How these rules work"}</button>{showHelp && <p className="mt-2 text-xs text-foreground-600">Required documents block wizard progression. Other checks depend on their connected validation logic. Publishing saves the selected setting.</p>}</div>
      </section>
    </div>
  </div>;
}
