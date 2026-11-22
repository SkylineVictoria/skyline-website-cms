import { useState } from "react";
import type { Definition, Rule, Snapshot } from "./model";

/** Student-facing validation settings backed by the existing published Business Rules. */
const STEPS = [
  { id: "passport", title: "Passport", icon: "ri-passport-line", docs: ["Passport"], rules: ["admissions.application_required_documents", "admissions.document_expiry_warning_months"] },
  { id: "english", title: "English evidence", icon: "ri-translate-2", docs: ["English test"], rules: ["admissions.application_required_documents", "admissions.english_minimum_scores", "admissions.english_result_valid_years", "admissions.english_test_alternatives"] },
  { id: "academic", title: "Academic results", icon: "ri-graduation-cap-line", docs: ["Academic results"], rules: ["admissions.application_required_documents"] },
  { id: "visa", title: "Visa", icon: "ri-id-card-line", docs: ["Visa"], rules: ["admissions.application_required_documents", "admissions.document_expiry_warning_months"] },
  { id: "usi", title: "USI", icon: "ri-fingerprint-line", docs: [], rules: ["admissions.usi_required"] },
  { id: "emergency", title: "Emergency contact", icon: "ri-phone-line", docs: [], rules: ["admissions.emergency_contact_required_details"] },
  { id: "course", title: "Course & intake", icon: "ri-book-open-line", docs: [], rules: [] },
] as const;

const NAMES: Record<string, string> = {
  "admissions.application_required_documents": "Document required before submission",
  "admissions.document_expiry_warning_months": "Document expiry warning period",
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
  const requiredRule = find("admissions.application_required_documents");
  const requiredValue = requiredRule && active(requiredRule)?.definition.value;
  const required = Array.isArray(requiredValue) ? requiredValue : ["Passport", "English test", "Academic results", "Visa"];
  return <div className="space-y-4">
    <div className="flex items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold text-foreground-900">Student wizard validation</h2>
        <p className="text-sm text-foreground-600">Choose a step to manage its existing published rules. This screen does not create duplicate rules.</p></div>
      <button type="button" onClick={showAdvanced} className="shrink-0 text-sm font-medium text-primary-700 hover:underline">Advanced rules</button>
    </div>
    {message && <p role="status" className="text-sm text-foreground-700">{message}</p>}
    <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(180px,240px)_minmax(0,1fr)]">
      <nav className="rounded-xl border border-background-300 bg-background-50 p-2" aria-label="Student wizard steps">
        <input aria-label="Find wizard step" placeholder="Search steps" value={search} onChange={e => setSearch(e.target.value)}
          className="mb-2 w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm" />
        {STEPS.filter(item => item.title.toLowerCase().includes(search.toLowerCase())).map(item =>
          <button type="button" key={item.id} onClick={() => { setSelected(item.id); setMessage(""); }}
            aria-current={selected === item.id ? "step" : undefined}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm ${selected === item.id ? "bg-primary-50 font-semibold text-primary-800" : "text-foreground-700 hover:bg-background-100"}`}>
            <i className={item.icon} aria-hidden="true" />{item.title}</button>)}
      </nav>
      <section className="space-y-4 rounded-xl border border-background-300 bg-background-50 p-4" aria-label={step.title + " rules"}>
        <div><h3 className="font-semibold text-foreground-900">{step.title}</h3>
          <p className="text-xs text-foreground-600">Settings are saved and published through SLIT's existing rule service.</p></div>
        {step.docs.map(doc => <label key={doc} className="flex items-center justify-between gap-3 rounded-lg border border-background-200 p-3">
          <span><span className="block text-sm font-medium">Require {doc}</span>
            <span className="block text-xs text-foreground-600">Required for application submission; page progression may have additional checks.</span></span>
          <input type="checkbox" checked={required.includes(doc)} disabled={busy || !requiredRule}
            onChange={e => void changeRequired(doc, e.target.checked)} className="h-4 w-4 accent-primary-600" />
        </label>)}
        {step.rules.filter(id => id !== "admissions.application_required_documents").map(id => {
          const rule = find(id);
          const value = rule && active(rule)?.definition.value;
          return <div key={id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-background-200 p-3">
            <div><p className="text-sm font-medium">{NAMES[id]}</p><p className="text-xs text-foreground-600">{rule ? "Published value: " + JSON.stringify(value ?? "Not set") : "Rule not registered"}</p></div>
            <button type="button" onClick={showAdvanced} className="text-sm font-medium text-primary-700 hover:underline">Edit rule</button>
          </div>;
        })}
        {!step.rules.length && <p className="text-sm text-foreground-600">No independently configurable validation rule is registered for this step yet. Existing application checks remain active.</p>}
        <div className="rounded-lg bg-background-100 p-3 text-xs text-foreground-600">
          <strong>Progression safety:</strong> A required-document setting controls submission requirements. It does not bypass document authenticity, authorization, or existing wizard navigation checks. Additional Next-button conditions must be registered and enforced in both the UI and backend before becoming editable.
        </div>
      </section>
    </div>
  </div>;
}
