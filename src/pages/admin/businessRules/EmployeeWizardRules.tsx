import { useState } from "react";
import type { Definition, Rule, Snapshot } from "./model";

const PAGES = [
  { id: "documents", title: "Documents", icon: "ri-file-upload-line" },
  { id: "prefill", title: "Check extracted details", icon: "ri-file-search-line" },
  { id: "personal", title: "Personal details", icon: "ri-user-line" },
  { id: "review", title: "Review & submit", icon: "ri-checkbox-circle-line" },
] as const;

/** Uses the real staff onboarding steps, not proposed steps which are absent from the live wizard. */
export default function EmployeeWizardRules({ snapshot, publish, busy, showAdvanced }: {
  snapshot: Snapshot;
  publish: (rule: Rule, definition: Definition, reason: string) => Promise<boolean>;
  busy: boolean;
  showAdvanced: () => void;
}) {
  const [selected, setSelected] = useState<string>("personal");
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  const page = PAGES.find(item => item.id === selected) ?? PAGES[2];
  const rule = snapshot.rules.find(item => item.identifier === "hrms.staff_minimum_age");
  const version = rule?.versions.find(item => item.state === "published");
  const age = version?.definition.value;
  const shown = draft || String(typeof age === "number" ? age : "");
  const save = async () => {
    if (!rule || !version || !draft.trim() || !Number.isInteger(Number(draft)) || Number(draft) < 0) {
      setMessage("Enter a valid whole-number age."); return;
    }
    const ok = await publish(rule, { ...version.definition, value: Number(draft) }, "Employee wizard: minimum staff age");
    setMessage(ok ? "Published successfully." : "Could not publish this change.");
    if (ok) setDraft("");
  };
  return <div className="space-y-3">
    <div className="flex items-center justify-between gap-3">
      <div><h2 className="text-lg font-semibold text-foreground-900">Employee wizard rules</h2>
        <p className="text-xs text-foreground-600">The actual staff onboarding pages. Configure published rules without JSON.</p></div>
      <button type="button" onClick={showAdvanced} className="text-sm text-primary-700 hover:underline">Advanced rules</button>
    </div>
    {message && <p role="status" className="text-sm text-foreground-700">{message}</p>}
    <div className="grid grid-cols-1 border-t border-background-200 lg:grid-cols-[minmax(170px,210px)_minmax(0,1fr)] lg:divide-x lg:divide-background-200">
      <nav aria-label="Employee wizard pages" className="p-2 lg:pr-3">
        {PAGES.map(item => <button type="button" key={item.id} onClick={() => { setSelected(item.id); setDraft(""); setMessage(""); }}
          aria-current={selected === item.id ? "step" : undefined}
          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${selected === item.id ? "bg-primary-50 font-semibold text-primary-800" : "text-foreground-700 hover:bg-background-100"}`}>
          <i className={item.icon} aria-hidden="true" />{item.title}</button>)}
      </nav>
      <section aria-label={page.title + " rules"} className="min-w-0 space-y-3 p-3 sm:p-4 lg:pl-5">
        <h3 className="font-semibold text-foreground-900">{page.title}</h3>
        {selected === "personal" ? <>
          <div className="grid gap-2 border-b border-background-200 py-3 xl:grid-cols-[minmax(0,1fr)_minmax(150px,230px)] xl:items-center">
            <label htmlFor="staff-min-age" className="text-sm font-medium">Minimum employee age</label>
            {version ? <input id="staff-min-age" type="number" min="0" step="1" value={shown} disabled={busy}
              onChange={e => setDraft(e.target.value)}
              className="w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm" />
              : <p className="text-xs text-foreground-600">Published age rule unavailable.</p>}
            {draft !== "" && version && <div className="flex justify-end gap-2 xl:col-span-2">
              <button type="button" onClick={() => setDraft("")} className="px-3 py-1.5 text-xs">Cancel</button>
              <button type="button" onClick={() => void save()} disabled={busy} className="rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">Publish change</button>
            </div>}
          </div>
          <p className="text-xs text-foreground-600">Other personal-field checks currently use shared staff validation. They are not editable here until registered and enforced as business rules.</p>
        </> : <p className="text-sm text-foreground-600">This page currently uses existing staff onboarding validation. No separate editable page rules have been verified yet.</p>}
      </section>
    </div>
  </div>;
}
