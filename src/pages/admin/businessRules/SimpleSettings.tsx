import { useMemo, useRef, useState } from "react";
import { Button, Card, Select, TextInput, Toggle } from "@/pages/admin/components/ui";
import type { Definition, Rule, Snapshot } from "./model";

/*
 * Settings (owner, 2026-11-22): the everyday choices from Business Rules in plain words, grouped by area. Each one is an existing
 * rule; saving publishes a new version of that rule from today, exactly as the Advanced tab would. Every other rule keeps its value
 * and stays on the Advanced tab.
 */

// rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const STAFF_DOCS = ["Passport", "Visa", "Driving Licence", "Void Cheque", "Academic"];
const STAFF_DOC_LABEL: Record<string, string> = { Passport: "Passport", Visa: "Visa (non-citizens only)", "Driving Licence": "Driving licence", "Void Cheque": "Void cheque", Academic: "Academic results" };

type Kind =
  | { type: "number"; unit: string; min?: number; max?: number; step?: number }
  | { type: "yesno"; on: string; off: string }
  | { type: "choice" }
  | { type: "checklist"; options: string[]; labels?: Record<string, string> }
  | { type: "staffDocs" };
type Setting = { id: string; question: string; help?: string; kind: Kind };
type Section = { title: string; icon: string; settings: Setting[] };

// rule-policy: technical settings-catalogue Plain-language labels for existing rules; the values themselves live in Business Rules.
const SECTIONS: Section[] = [
  { title: "Students & admissions", icon: "ri-graduation-cap-line", settings: [
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "admissions.application_required_documents", question: "Documents a student must upload before submitting", help: "Unticked documents can still be uploaded, but are optional.", kind: { type: "checklist", options: ["Passport", "Visa", "English test", "Academic results"] } },
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "admissions.usi_required", question: "Is the USI needed on the application?", kind: { type: "choice" } },
    { id: "admissions.offer_letter_recipient", question: "Who receives the offer letter?", kind: { type: "choice" } },
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "admissions.offer_unanswered_days", question: "Show an offer as unanswered after", help: "It appears on the dashboard under Needs action today.", kind: { type: "number", unit: "days", min: 1, max: 60 } },
    { id: "admissions.english_result_valid_years", question: "An English test result is valid for", kind: { type: "number", unit: "years", min: 1, max: 10 } },
    { id: "admissions.document_expiry_warning_months", question: "Warn when a passport or visa expires within", kind: { type: "number", unit: "months", min: 1, max: 24 } },
  ] },
  // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
  { title: "Deposits & fees", icon: "ri-money-dollar-circle-line", settings: [
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "finance.deposit_reminder_default_enabled", question: "Send deposit reminders automatically", help: "For new offer letters. Each letter can still be switched on or off.", kind: { type: "yesno", on: "On", off: "Off" } },
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "finance.deposit_automatic_reminder_interval", question: "Time between deposit reminders", kind: { type: "number", unit: "days", min: 1, max: 30 } },
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "finance.deposit_automatic_reminder_cap", question: "Most deposit reminders sent", kind: { type: "number", unit: "reminders", min: 1, max: 10 } },
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "finance.course_fee_deposit_cap", question: "Largest initial deposit on a course", kind: { type: "number", unit: "AUD", min: 0, max: 100000, step: 50 } },
  ] },
  // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
  { title: "Classes & attendance", icon: "ri-calendar-check-line", settings: [
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "lms.attendance_alert_threshold", question: "Flag a student when attendance falls below", kind: { type: "number", unit: "%", min: 1, max: 100 } },
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "lms.attendance_alert_min_marks", question: "Only after this many classes have been marked", kind: { type: "number", unit: "classes", min: 1, max: 50 } },
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "lms.coe_weekly_study_hours", question: "Study hours a week for CoE students", kind: { type: "number", unit: "hours", min: 1, max: 60 } },
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "lms.course_working_days", question: "Teaching days", help: "Unit and intake dates count only these days.", kind: { type: "checklist", options: WEEKDAYS } },
    { id: "lms.join_dates", question: "Start dates a student may choose", kind: { type: "choice" } },
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "lms.optional_holidays_stop_classes", question: "No classes on optional public holidays", kind: { type: "yesno", on: "Yes", off: "No" } },
  ] },
  { title: "Staff", icon: "ri-team-line", settings: [
    { id: "hrms.applicant_document_checklist", question: "Documents new staff must upload", help: "The others are still asked for, but can be skipped.", kind: { type: "staffDocs" } },
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "hrms.staff_document_link_days", question: "A staff document link works for", kind: { type: "number", unit: "days", min: 1, max: 60 } },
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "hrms.document_expiring_soon_days", question: "Warn when a staff document expires within", kind: { type: "number", unit: "days", min: 1, max: 365 } },
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "hrms.default_ordinary_hours", question: "Usual working hours a week", kind: { type: "number", unit: "hours", min: 1, max: 60 } },
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "hrms.usual_workdays", question: "Usual working days", kind: { type: "checklist", options: WEEKDAYS } },
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "hrms.breaks_paid_default", question: "Breaks are paid", kind: { type: "yesno", on: "Yes", off: "No" } },
  ] },
  { title: "Agents", icon: "ri-briefcase-line", settings: [
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "agents.commission_suggested", question: "Suggested agent commission", kind: { type: "number", unit: "%", min: 0, max: 100 } },
    { id: "agents.agreement_term_years", question: "Length of an agent agreement", help: "The agreement PDF's own wording (Item 5) is not changed by this.", kind: { type: "number", unit: "years", min: 1, max: 10 } },
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    { id: "agents.business_approval_waits_for_referees", question: "Approving a business before its referees reply", kind: { type: "choice" } },
  ] },
];

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function liveDefinition(rule: Rule): Definition | undefined {
  const day = today();
  return rule.versions.filter(v => v.state === "published" && v.definition.starts_on <= day && (!v.definition.ends_on || v.definition.ends_on >= day))
    .sort((a, b) => b.definition.starts_on.localeCompare(a.definition.starts_on) || b.version - a.version)[0]?.definition;
}

function staffDocsValue(value: unknown): string[] {
  const v = (value ?? {}) as { citizen?: string[]; other?: string[] };
  return [...new Set([...(v.other ?? []), ...(v.citizen ?? [])])];
}

export default function SimpleSettings({ snapshot, publish, busy, showAdvanced }: {
  snapshot: Snapshot;
  /** Saves the new value as a draft of the rule and publishes it from today. */
  publish: (rule: Rule, definition: Definition, reason: string) => Promise<boolean>;
  busy: boolean;
  showAdvanced: () => void;
}) {
  const byId = useMemo(() => new Map(snapshot.rules.map(r => [r.identifier, r])), [snapshot.rules]);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState<string>("");

  // Owner (2026-11-22): edit in place, no Edit / Save buttons. Toggles, choices and chips save at once; numbers save when you leave the box or press Enter.
  const pending = useRef(new Set<string>());
  const save = async (s: Setting, rule: Rule, live: Definition, raw: unknown) => {
    // Enter then leaving the box would otherwise save the same change twice.
    if (pending.current.has(s.id)) return;
    pending.current.add(s.id);
    let value = raw;
    if (s.kind.type === "staffDocs") {
      const picked = raw as string[];
      value = { citizen: picked.filter(d => d !== "Visa"), other: picked };
    }
    const ok = await publish(rule, { ...live, value, starts_on: today(), ends_on: "" }, `Changed on the Settings page: ${s.question}`);
    pending.current.delete(s.id);
    setEdits(old => { const next = { ...old }; delete next[s.id]; return next; });
    if (ok) setSaved(s.id);
  };

  const [area, setArea] = useState(SECTIONS[0].title);
  const section = SECTIONS.find(x => x.title === area) ?? SECTIONS[0];

  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Area">
      {SECTIONS.map(x => <button key={x.title} type="button" role="tab" aria-selected={x.title === area} onClick={() => { setArea(x.title); setSaved(""); setEdits({}); }}
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm ${x.title === area ? "border-primary-500 bg-primary-50 font-semibold text-primary-800" : "border-background-300 text-foreground-700 hover:bg-background-100"}`}>
        <i className={x.icon} aria-hidden="true" />{x.title}
      </button>)}
    </div>
    <Card className="overflow-hidden p-0">
      <ul className="divide-y divide-background-100">{section.settings.map(s => {
        const rule = byId.get(s.id);
        const live = rule ? liveDefinition(rule) : undefined;
        // rule-policy: technical missing-rule A setting whose rule is not installed is simply not shown.
        if (!rule || !live) return null;
        const stored = s.kind.type === "staffDocs" ? staffDocsValue(live.value) : live.value;
        const value = s.id in edits ? edits[s.id] : stored;
        const typed = s.kind.type === "number";
        const commit = (v: unknown) => {
          // rule-policy: technical settings-catalogue Saves only a real change; an empty or unchanged number box is put back.
          if (v == null || sameValue(v, stored)) { setEdits(old => { const next = { ...old }; delete next[s.id]; return next; }); return; }
          void save(s, rule, live, v);
        };
        const onChange = (v: unknown) => { setSaved(""); if (typed) setEdits(old => ({ ...old, [s.id]: v })); else commit(v); };
        return <li key={s.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid={`setting-${s.id}`}
          onBlur={typed ? e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) commit(value); } : undefined}
          onKeyDown={typed ? e => { if (e.key === "Enter") commit(value); if (e.key === "Escape") setEdits(old => { const next = { ...old }; delete next[s.id]; return next; }); } : undefined}>
          <span className="min-w-0 text-sm text-foreground-900" title={s.help}>{s.question}</span>
          <span className="flex shrink-0 items-center gap-2">
            {/* // rule-policy: technical settings-catalogue Shows a saved tick after an existing rule changes. */}
            {saved === s.id ? <span className="text-xs font-medium text-green-700" role="status"><i className="ri-check-line" aria-hidden="true" /> Saved</span> : null}
            <Control setting={s} value={value} options={live.options} onChange={onChange} disabled={busy} />
          </span>
        </li>;
      })}</ul>
    </Card>
    <p className="text-xs text-foreground-500">Changes save by themselves and apply from today. <button type="button" className="font-medium text-primary-700 hover:underline" onClick={showAdvanced}>All rules (for developers)</button></p>
  </div>;
}

function Control({ setting, value, options, onChange, disabled }: { setting: Setting; value: unknown; options: string[]; onChange: (v: unknown) => void; disabled: boolean }) {
  const k = setting.kind;
  if (k.type === "number") return <label className="flex items-center gap-2 text-sm">
    <TextInput type="number" className="!w-24" min={k.min} max={k.max} step={k.step ?? 1} disabled={disabled} aria-label={setting.question}
      value={typeof value === "number" ? value : ""} onChange={e => onChange(e.target.value === "" ? null : e.target.valueAsNumber)} />
    <span className="text-foreground-600">{k.unit}</span>
  </label>;
  if (k.type === "yesno") return <Toggle checked={value === true} disabled={disabled} label={value === true ? k.on : k.off} onChange={onChange} />;
  if (k.type === "choice") return <Select className="!w-auto max-w-xs" disabled={disabled} aria-label={setting.question} value={String(value ?? "")} onChange={e => onChange(e.target.value)}>
    {options.map(o => <option key={o}>{o}</option>)}
  </Select>;
  const list = Array.isArray(value) ? (value as string[]) : [];
  const opts = k.type === "staffDocs" ? STAFF_DOCS : k.options;
  const labels = k.type === "staffDocs" ? STAFF_DOC_LABEL : k.labels ?? {};
  return <div className="flex flex-wrap gap-1.5" role="group" aria-label={setting.question}>
    {opts.map(o => {
      const on = list.includes(o);
      return <button key={o} type="button" disabled={disabled} aria-pressed={on}
        onClick={() => onChange(on ? list.filter(x => x !== o) : opts.filter(x => x === o || list.includes(x)))}
        className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-primary-400 bg-primary-50 font-medium text-primary-800" : "border-background-300 text-foreground-600 hover:bg-background-100"}`}>
        {on ? "✓ " : ""}{labels[o] ?? o}
      </button>;
    })}
  </div>;
}
