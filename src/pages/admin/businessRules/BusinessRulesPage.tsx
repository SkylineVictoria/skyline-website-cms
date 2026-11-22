import { useCallback, useEffect, useState } from "react";
import { loadBusinessRules } from "@/lib/businessRules";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { AdminLoading, Badge, Button, Card, Field, Modal, PageHeader, Select, TextInput } from "@/pages/admin/components/ui";
import type { AdminMenuItem } from "@/pages/admin/lib/adminMenu";
import ReschedulingRules from "@/pages/admin/lms/timetable/ReschedulingRules";
import RuleEditor from "./RuleEditor";
import SimpleSettings from "./SimpleSettings";
import StudentWizardRules from "./StudentWizardRules";
import EmployeeWizardRules from "./EmployeeWizardRules";
import { appliesTo, awaitingIntegration, definitionSummary, locationLabel, newDefinition, reschedulingEditor, reschedulingRulesRoute, ruleLocations, timetableRulesRoute, timetableRulesScope, valueSummary, type Definition, type Rule, type Snapshot, isSystemRule } from "./model";

const dayInVictoria = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dateTime = (date: string) => new Date(date).toLocaleString("en-AU", { timeZone: "Australia/Melbourne" });
const empty: Snapshot = { rules: [], categories: [], fields: [], history: [] };
// rule-policy: technical table-labels Displays labels for persisted rule metadata.
const AREAS: Record<string, string> = {
  admissions: "Students & admissions", students: "Students & admissions", lms: "Classes & courses", assessment: "Assessments",
  hrms: "Staff", agents: "Agents", finance: "Fees & payments", booking: "Bookings", support: "Support tickets", auth: "Sign-in",
  comms: "Messages", office365: "Email accounts", signing: "Document signing", cms: "Website", website: "Website", admin: "Website",
};

// rule-policy: technical reference-caption Explains that source records do not configure workflow behavior.
const referenceCaption = "This reference records a setting, default, or template term found in the source. Existing workflows continue to use their current implementation or saved settings.";

const reschedulingTitle = "Class rescheduling rules";
const registrationError = "The Business Rules service is unavailable. Retry or contact your administrator.";

export default function BusinessRulesPage() {
  const [params] = useSearchParams();
  // rule-policy: technical editor-navigation This branch selects the existing editor in the Administration layout.
  if (params.get("editor") === reschedulingEditor) return <>
    <PageHeader title="Business Rules & Policies" breadcrumb="Administration / Learning Management / Timetable"
      actions={<Link to={timetableRulesRoute} className="text-sm font-medium text-primary-700 hover:underline">Back to timetable rules</Link>} />
    <ReschedulingRules />
  </>;
  return <RuleWorkspace />;
}

function RuleWorkspace() {
  const [params, setParams] = useSearchParams();
  const scope = params.get("menu") ?? "";
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [menu, setMenu] = useState<AdminMenuItem[]>([]);
  // Owner (2026-11-22): the plain-language Settings tab opens first; a menu filter (from a page's Manage rules link) opens Advanced.
  const [tab, setTab] = useState(scope ? "rules" : "settings");
  const [search, setSearch] = useState("");
  // Owner (2026-11-22): system rules (sizes, formats, workflow steps, wording) are hidden until asked for.
  const [showSystem, setShowSystem] = useState(false);
  const [area, setArea] = useState("");
  const [category, setCategory] = useState("");
  const [selected, setSelected] = useState("");
  const [historyId, setHistoryId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [state, navigation] = await Promise.all([
      supabase.rpc("business_rules_admin", { p_command: "list" }),
      supabase.from("admin_menu_items").select("id,parent_id,label,route,icon_key,sort_order,is_enabled,open_in_new_tab").order("sort_order"),
    ]);
    if (state.error || navigation.error) throw new Error(registrationError);
    setSnapshot(state.data as Snapshot);
    setMenu(navigation.data ?? []);
    setReady(true);
  }, []);

  useEffect(() => { void reload().catch(() => setError(registrationError)); }, [reload]);

  const submit = async (command: string, payload: object) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const { data, error } = await supabase.rpc("business_rules_admin", { p_command: command, p_payload: payload });
      if (error) throw new Error(["22023", "42501", "23505", "40001"].includes(error.code) ? error.message : registrationError);
      if (command !== "preview") {
        await reload();
        if (command === "publish") void loadBusinessRules(true);
        if (command === "save") setSelected(data.rule_id);
        setMessage(command === "rollback" ? "Rollback draft created. Publish it to apply the change." : "Change saved.");
      }
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : registrationError);
      return undefined;
    } finally { setBusy(false); }
  };

  /** Settings tab: save the new value as a draft of the rule, then publish that exact draft from today. */
  const publishSetting = async (rule: Rule, definition: Definition, why: string): Promise<boolean> => {
    setBusy(true); setError(""); setMessage("");
    try {
      const first = await supabase.rpc("business_rules_admin", { p_command: "save", p_payload: { rule_id: rule.id, expected_version: rule.versions[0].id, reason: why, definition } });
      if (first.error) throw first.error;
      const list = await supabase.rpc("business_rules_admin", { p_command: "list" });
      if (list.error) throw list.error;
      const draft = (list.data as Snapshot).rules.find(r => r.id === rule.id)?.versions[0];
      if (!draft || draft.state !== "draft") throw new Error(registrationError);
      const second = await supabase.rpc("business_rules_admin", { p_command: "publish", p_payload: { rule_id: rule.id, expected_version: draft.id, reason: why, definition: draft.definition } });
      if (second.error) throw second.error;
      await reload();
      void loadBusinessRules(true);
      return true;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      // rule-policy: technical error-text Shows the database's own message for expected refusals.
      setError(err.code && ["22023", "42501", "23505", "40001"].includes(err.code) ? err.message ?? registrationError : registrationError);
      await reload().catch(() => undefined);
      return false;
    } finally { setBusy(false); }
  };

  const locations = ruleLocations(menu);
  const current = snapshot.rules.find(r => r.id === selected);
  const version = current?.versions[0];
  const today = dayInVictoria();
  const published = (rule: Rule) => rule.versions.filter(v => v.state === "published").sort((a, b) =>
    b.definition.starts_on.localeCompare(a.definition.starts_on) || b.definition.priority - a.definition.priority || b.version - a.version);
  const effective = (rule: Rule) => published(rule).find(v => v.definition.starts_on <= today && (!v.definition.ends_on || v.definition.ends_on >= today));
  const scoped = snapshot.rules.filter(rule => !scope || appliesTo(locations, rule.versions[0].definition.scope, scope));
  const systemCount = scoped.filter(isSystemRule).length;
  const filtered = scoped.filter(rule => showSystem || !isSystemRule(rule)).filter(rule => {
    const d = rule.versions[0].definition;
    const categoryName = snapshot.categories.find(item => item.id === d.category_id)?.name ?? "";
    return (!category || d.category_id === category) && `${d.name} ${d.identifier} ${d.description} ${categoryName}`.toLowerCase().includes(search.trim().toLowerCase());
  });
  const showRescheduling = (!scope || appliesTo(locations, timetableRulesScope, scope)) && !category
    && `${reschedulingTitle} timetable`.toLowerCase().includes(search.trim().toLowerCase());
  const history = snapshot.history.filter(event => historyId ? event.rule_id === historyId : scoped.some(rule => rule.id === event.rule_id));
  const historyRule = snapshot.rules.find(rule => rule.id === historyId);
  const showHistory = (id: string) => { setHistoryId(id); setReason(""); setTab("history"); };
  const open = (id: string) => { setSelected(id); setTab("rules"); };
  const filterMenu = (id: string) => { setParams(id ? { menu: id } : {}); setSelected(""); setHistoryId(""); setCategory(""); };
  const add = () => open("new");
  // Owner (2026-11-22): no side menus. One search box and an area filter; rules grouped by area; editing opens in a window.
  const areaOf = (rule: Rule) => AREAS[rule.identifier.split(".")[0]] ?? "Other";
  const visible = filtered.filter(rule => !area || areaOf(rule) === area);
  const groups = [...new Set(Object.values(AREAS).concat("Other"))]
    .map(name => ({ name, rules: visible.filter(rule => areaOf(rule) === name) }))
    .filter(g => g.rules.length || (g.name === "Classes & courses" && showRescheduling && (!area || area === g.name)));
  const areaNames = [...new Set(scoped.filter(rule => showSystem || !isSystemRule(rule)).map(areaOf))].sort();
  const editor = selected && (selected === "new" || version);
  const closeEditor = () => setSelected("");

  return <>
    <PageHeader title="Settings & Policies" breadcrumb="Administration" description="How SLIT works: required documents, attendance, deposits, staff and agents." />
    {error && <div role="alert" className="mb-3 rounded border border-red-300 bg-red-50 p-3 text-red-900">{error}{!ready && <Button className="ml-2" size="sm" variant="outline" onClick={() => { setError(""); void reload().catch(() => setError(registrationError)); }}>Retry</Button>}</div>}
    {message && <p role="status" className="mb-3 rounded bg-primary-50 p-3">{message}</p>}
    {/* // rule-policy: technical page-copy Loading text for the settings page; no rule value. */}
    {!ready && !error && <AdminLoading label="Loading settings…" />}
    {ready && <div className="mb-4 flex flex-wrap gap-2" role="navigation" aria-label="Settings sections">
      <button type="button" aria-current={tab === "settings" ? "page" : undefined} onClick={() => setTab("settings")} className={`rounded-lg px-3 py-2 text-sm font-medium ${tab === "settings" ? "bg-primary-50 text-primary-800" : "border border-background-300 text-foreground-700"}`}>General settings</button>
      <button type="button" aria-current={tab === "wizard" ? "page" : undefined} onClick={() => setTab("wizard")} className={`rounded-lg px-3 py-2 text-sm font-medium ${tab === "wizard" ? "bg-primary-50 text-primary-800" : "border border-background-300 text-foreground-700"}`}>Student wizard validation</button>
      <button type="button" aria-current={tab === "employee-wizard" ? "page" : undefined} onClick={() => setTab("employee-wizard")} className={`rounded-lg px-3 py-2 text-sm font-medium ${tab === "employee-wizard" ? "bg-primary-50 text-primary-800" : "border border-background-300 text-foreground-700"}`}>Employee wizard validation</button>
      {tab === "rules" && <span className="rounded-lg bg-primary-50 px-3 py-2 text-sm font-medium text-primary-800">Advanced rules</span>}
    </div>}
    {ready && tab === "settings" && <SimpleSettings snapshot={snapshot} publish={publishSetting} busy={busy} showAdvanced={() => setTab("rules")} />}
    {ready && tab === "wizard" && <StudentWizardRules snapshot={snapshot} publish={publishSetting} busy={busy} showAdvanced={() => setTab("rules")} />}
    {ready && tab === "employee-wizard" && <EmployeeWizardRules snapshot={snapshot} publish={publishSetting} busy={busy} showAdvanced={() => setTab("rules")} />}
    {ready && tab !== "settings" && tab !== "wizard" && tab !== "employee-wizard" && <div className="space-y-4">
      <button type="button" className="text-sm font-medium text-primary-700 hover:underline" onClick={() => { setTab("settings"); filterMenu(""); }}><i className="ri-arrow-left-line" aria-hidden="true" /> Back to settings</button>
      <div className="flex flex-wrap items-center gap-2">
        <TextInput type="search" className="min-w-0 flex-1 sm:!w-72 sm:flex-none" aria-label="Search rules" placeholder="Search rules" value={search} onChange={e => setSearch(e.target.value)} />
        <Select className="!w-auto" aria-label="Area" value={area} onChange={e => setArea(e.target.value)}>
          <option value="">All areas</option>{areaNames.map(n => <option key={n}>{n}</option>)}
        </Select>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" icon="ri-history-line" onClick={() => showHistory("")}>Change history</Button>
          {showSystem && <Button size="sm" variant="outline" icon="ri-add-line" onClick={add}>Add rule</Button>}
        </div>
      </div>
      {scope && <p className="text-sm text-foreground-600">Showing rules for <b>{locationLabel(locations, scope)}</b>. <button type="button" className="font-medium text-primary-700 hover:underline" onClick={() => filterMenu("")}>Show all</button></p>}
      {groups.map(g => <Card key={g.name} className="p-0">
        <h2 className="border-b border-background-200 px-4 py-2.5 font-heading text-sm font-semibold text-foreground-900">{g.name}</h2>
        <ul className="divide-y divide-background-100">
          {g.name === "Classes & courses" && showRescheduling && <li className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0"><p className="text-sm font-medium text-foreground-900">{reschedulingTitle}</p><p className="truncate text-xs text-foreground-500">What happens when a class can't run. Has its own page.</p></div>
            <Link to={reschedulingRulesRoute} className="shrink-0 text-sm font-medium text-primary-700 hover:underline">Open</Link>
          </li>}
          {g.rules.map(rule => {
            const latest = rule.versions[0], live = effective(rule), next = published(rule).find(v => v.definition.starts_on > today);
            const shown = (live ?? next ?? latest).definition;
            return <li key={rule.id}>
              <button type="button" onClick={() => open(rule.id)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-background-50" data-testid={`rule-row-${rule.identifier}`}>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground-900">{shown.name}{latest.state === "draft" ? <span className="ml-2"><Badge tone="primary">Unpublished change</Badge></span> : null}{live && !live.definition.enabled ? <span className="ml-2"><Badge tone="muted">Off</Badge></span> : null}</p>
                  {shown.description ? <p className="truncate text-xs text-foreground-500">{shown.description}</p> : null}
                </div>
                <span className="max-w-[45%] shrink-0 truncate rounded-md bg-background-100 px-2 py-1 text-xs font-medium text-foreground-800">{definitionSummary(shown)}</span>
              </button>
            </li>;
          })}
        </ul>
      </Card>)}
      {!groups.length && <Card className="p-6 text-center text-sm text-foreground-500">No rules match. <button type="button" className="font-medium text-primary-700 hover:underline" onClick={() => { setSearch(""); setArea(""); filterMenu(""); }}>Clear search</button></Card>}
      <p className="text-xs text-foreground-500">
        {showSystem ? "Developer mode: system rules and Add rule are shown." : `${systemCount} system rules (file sizes, formats, workflow steps, letter wording) are hidden and keep working as they are.`}{" "}
        <button type="button" className="font-medium text-primary-700 hover:underline" onClick={() => setShowSystem(v => !v)} data-testid="toggle-system-rules">{showSystem ? "Hide them" : "Show them (developers)"}</button>
      </p>
    </div>}

    {ready && editor && <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-foreground-950/40 p-4" onClick={closeEditor}>
      <div className="my-6 w-full max-w-xl" onClick={e => e.stopPropagation()}>
        {current && version && awaitingIntegration(current) ? <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-2"><h2 className="font-bold">{version.definition.name}</h2><Button size="sm" variant="ghost" onClick={closeEditor}>Close</Button></div>
          <p className="text-lg font-semibold">{definitionSummary(version.definition)}</p>
          <p>{version.definition.description}</p>
          <p className="text-foreground-600">{referenceCaption}</p>
        </Card> : <>
          <RuleEditor key={version?.id ?? "new"} initial={version?.definition ?? { ...newDefinition(scope, category), starts_on: today }}
            rule={current} version={version} existingApprovalRequired={!!current && !!effective(current)?.definition.approval_required} categories={snapshot.categories} locations={locations} fields={snapshot.fields} busy={busy} close={closeEditor} submit={submit} />
          {current && <div className="mt-2 text-right"><button type="button" className="text-sm font-medium text-background-50 hover:underline" onClick={() => { closeEditor(); showHistory(current.id); }}>Change history for this rule</button></div>}
        </>}
      </div>
    </div>}

    <Modal open={ready && tab === "history"} title={historyRule ? `Change history: ${historyRule.versions[0].definition.name}` : "Change history"} onClose={() => setTab("rules")} width="max-w-2xl">
      <div className="space-y-3 text-sm">
        {historyRule && <><Field label="Reason for going back to an earlier version"><TextInput value={reason} onChange={e => setReason(e.target.value)} /></Field>
          {historyRule.versions.map(v => <div key={v.id} className="flex items-center justify-between gap-2 border-b border-background-200 pb-2"><span>Version {v.version} · {v.state} · {valueSummary(v.definition.value)}</span>
            {v.published_at && <Button size="sm" variant="outline" disabled={busy || !reason.trim()} onClick={() => void submit("rollback", { rule_id: historyId, expected_version: historyRule.versions[0].id, target_version: v.id, reason })}>Use this version</Button>}</div>)}</>}
        {!history.length && <p className="text-foreground-500">No recorded changes.</p>}
        {history.map(event => <details key={event.id} className="rounded border border-background-200 p-2"><summary className="cursor-pointer">{event.after_data?.name ?? event.before_data?.name} · {event.action} · {dateTime(event.created_at)}</summary>
          <p className="py-2">{event.reason}</p><p className="text-xs text-foreground-500">Changed by {event.actor || "System"}</p></details>)}
      </div>
    </Modal>
  </>;
}
