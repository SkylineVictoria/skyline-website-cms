import { useCallback, useEffect, useState } from "react";
import { loadBusinessRules } from "@/lib/businessRules";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { AdminLoading, Badge, Button, Card, Field, PageHeader, SectionTabs, TextInput } from "@/pages/admin/components/ui";
import type { AdminMenuItem } from "@/pages/admin/lib/adminMenu";
import ReschedulingRules from "@/pages/admin/lms/timetable/ReschedulingRules";
import RuleEditor from "./RuleEditor";
import SimpleSettings from "./SimpleSettings";
import { appliesTo, awaitingIntegration, definitionSummary, locationLabel, newDefinition, reschedulingEditor, reschedulingRulesRoute, ruleLocations, timetableRulesRoute, timetableRulesScope, valueSummary, type Category, type Definition, type Rule, type RuleLocation, type Snapshot } from "./model";

const tabs = [
  { id: "settings", label: "Settings", icon: "ri-equalizer-line" },
  { id: "rules", label: "Advanced (all rules)", icon: "ri-list-check" },
  { id: "history", label: "Rule History", icon: "ri-history-line" },
  { id: "effective", label: "Effective Changes", icon: "ri-calendar-line" },
  { id: "compliance", label: "Compliance & Notes", icon: "ri-shield-check-line" },
];

const dayInVictoria = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dateTime = (date: string) => new Date(date).toLocaleString("en-AU", { timeZone: "Australia/Melbourne" });
const empty: Snapshot = { rules: [], categories: [], fields: [], history: [] };
// rule-policy: technical table-labels Displays labels for persisted rule metadata.
const ruleColumns = ["Rule", "Category", "Type", "Value", "Status", "Effective date", "Last modified", "Actions"];

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
  const [menuSearch, setMenuSearch] = useState("");
  const [category, setCategory] = useState("");
  const [selected, setSelected] = useState("");
  const [historyId, setHistoryId] = useState("");
  const [reason, setReason] = useState("");
  const [categoryEdit, setCategoryEdit] = useState<Category | null>(null);
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
        if (command === "category") setCategoryEdit(null);
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
  const filtered = scoped.filter(rule => {
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
  const matchingLocations = locations.filter(item => !menuSearch.trim() || locationLabel(locations, item.id).toLowerCase().includes(menuSearch.trim().toLowerCase()));
  const renderLocation = (loc: RuleLocation, depth: number) => {
    const children = matchingLocations.filter(item => item.parent === loc.id);
    const count = snapshot.rules.filter(rule => appliesTo(locations, rule.versions[0].definition.scope, loc.id)).length
      + Number(appliesTo(locations, timetableRulesScope, loc.id));
    return <li key={loc.id}>
      <button type="button" onClick={() => filterMenu(loc.id)} aria-current={scope === loc.id ? "true" : undefined}
        className={`flex w-full items-center justify-between gap-1 rounded px-2 py-1.5 text-left text-xs ${scope === loc.id ? "bg-primary-100 font-semibold" : "hover:bg-background-100"}`}
        style={{ paddingInlineStart: `${depth * 0.75 + 0.5}rem` }}>
        <span>{menuSearch.trim() ? locationLabel(locations, loc.id) : loc.label}</span><span className="rounded-full bg-background-200 px-1.5 text-foreground-600">{count}</span>
      </button>
      {!!children.length && !menuSearch.trim() && <ul>{children.map(child => renderLocation(child, depth + 1))}</ul>}
    </li>;
  };
  const editor = tab === "rules" && selected && (selected === "new" || version);

  return <>
    {/* // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules. */}
    <PageHeader title="Settings & Policies" breadcrumb="Administration" description="How SLIT works: required documents, attendance, deposits, staff and agents." />
    <SectionTabs tabs={tabs} active={tab} onChange={id => { setTab(id); if (id === "history") setHistoryId(""); }} />
    {error && <div role="alert" className="mb-3 rounded border border-red-300 bg-red-50 p-3 text-red-900">{error}{!ready && <Button className="ml-2" size="sm" variant="outline" onClick={() => { setError(""); void reload().catch(() => setError(registrationError)); }}>Retry</Button>}</div>}
    {message && <p role="status" className="mb-3 rounded bg-primary-50 p-3">{message}</p>}
    {!ready && !error && <AdminLoading label="Loading business rules…" />}
    {ready && tab === "settings" && <SimpleSettings snapshot={snapshot} publish={publishSetting} busy={busy} showAdvanced={() => setTab("rules")} />}
    // rule-policy: technical settings-catalogue Plain-language label for an existing rule; its value lives in Business Rules.
    {ready && tab !== "settings" && <div className={`grid items-start gap-3 lg:grid-cols-[13rem_minmax(0,1fr)] ${editor ? "xl:grid-cols-[13rem_minmax(0,1fr)_21rem]" : ""}`}>
      <Card className="p-3">
        <h2 className="mb-2 font-bold">Admin menu</h2>
        <TextInput type="search" className="mb-2" aria-label="Search Admin menus" placeholder="Search menus" value={menuSearch} onChange={e => setMenuSearch(e.target.value)} />
        <div className="max-h-72 overflow-auto">
          <button type="button" onClick={() => filterMenu("")} className={`w-full rounded px-2 py-1.5 text-left ${!scope ? "bg-primary-100 font-semibold" : "hover:bg-background-100"}`}>All Rules</button>
          <ul>{matchingLocations.filter(item => menuSearch.trim() || !item.parent || !locations.some(loc => loc.id === item.parent)).map(item => renderLocation(item, 0))}</ul>
        </div>
        <div className="mb-2 mt-4 flex items-center justify-between border-t border-background-200 pt-3"><h2 className="font-bold">Categories</h2><Button size="sm" variant="ghost" aria-label="Add category" onClick={() => setCategoryEdit({ id: "", name: "" })}>+</Button></div>
        <button type="button" onClick={() => setCategory("")} className={`block w-full rounded px-2 py-1 text-left ${!category ? "bg-primary-100" : ""}`}>All categories</button>
        {snapshot.categories.map(c => <div key={c.id} className={`flex items-center rounded ${category === c.id ? "bg-primary-100" : ""}`}>
          <button type="button" onClick={() => setCategory(c.id)} className="flex-1 px-2 py-1 text-left text-xs">{c.name}</button>
          <button type="button" onClick={() => setCategoryEdit(c)} aria-label={`Rename ${c.name}`} className="p-1 text-foreground-500"><i className="ri-pencil-line" aria-hidden="true" /></button>
        </div>)}
        {categoryEdit && <form className="mt-3 space-y-2" onSubmit={e => { e.preventDefault(); void submit("category", categoryEdit); }}>
          <Field label="Category name"><TextInput value={categoryEdit.name} required onChange={e => setCategoryEdit({ ...categoryEdit, name: e.target.value })} /></Field>
          <Button size="sm" type="submit" disabled={busy}>Save</Button> <Button size="sm" variant="ghost" onClick={() => setCategoryEdit(null)}>Cancel</Button>
        </form>}
      </Card>
      <Card className="min-w-0 p-4">
        {tab === "rules" && <>
          <div className="mb-3 flex flex-wrap items-center gap-2"><h2 className="mr-auto font-bold">{scope ? locationLabel(locations, scope) : "All Rules"} ({filtered.length + Number(showRescheduling)})</h2>
            <TextInput className="!w-44" type="search" aria-label="Search rules" placeholder="Search rules" value={search} onChange={e => setSearch(e.target.value)} /><Button size="sm" icon="ri-add-line" onClick={add}>Add Rule</Button></div>
          <div className="overflow-x-auto"><table className="w-full text-left text-xs">
            <thead className="bg-background-100"><tr>{ruleColumns.map(label => <th key={label} scope="col" className="p-2">{label}</th>)}</tr></thead>
            <tbody>
              {showRescheduling && <tr className="border-b border-background-200 align-top">
                <th scope="row" className="p-2 font-medium">
                  <Link to={reschedulingRulesRoute} className="text-primary-700 hover:underline">{reschedulingTitle}</Link>
                  <div className="mt-1 text-foreground-500">{locationLabel(locations, timetableRulesScope)}</div>
                </th>
                <td className="p-2">Timetable</td>
                <td className="p-2">Rule set</td>
                <td className="p-2">All courses and per-course overrides</td>
                <td className="p-2">Existing settings</td>
                <td className="p-2">—</td>
                <td className="p-2">—</td>
                <td className="p-2"><Link to={reschedulingRulesRoute} className="text-primary-700 hover:underline">Edit</Link></td>
              </tr>}
              {filtered.map(rule => {
              const latest = rule.versions[0], live = effective(rule), next = published(rule).find(v => v.definition.starts_on > today);
              const active = live?.definition.enabled;
              const awaiting = awaitingIntegration(rule);
              // rule-policy: technical status-labels Describes each stored version and registration state.
              const label = awaiting ? "Reference" : active ? "Active" : live ? "Inactive" : next ? "Scheduled" : latest.state === "draft" ? "Draft" : "Expired";
              return <tr key={rule.id} className="border-b border-background-200 align-top">
                <th scope="row" className="p-2 font-medium"><button type="button" onClick={() => open(rule.id)} className="text-left text-primary-700">{latest.definition.name}</button><div className="mt-1 text-foreground-500">{locationLabel(locations, latest.definition.scope)}</div></th>
                <td className="p-2">{snapshot.categories.find(c => c.id === latest.definition.category_id)?.name}</td><td className="p-2">{latest.definition.value_type}</td>
                <td className="max-w-40 break-words p-2"><span className="line-clamp-2">{definitionSummary((live ?? next ?? latest).definition)}</span></td>
                <td className="p-2"><Badge tone={active ? "success" : "muted"}>{label}</Badge>{latest.state === "draft" && active && <div className="mt-1">Draft pending</div>}</td>
                <td className="p-2">{awaiting ? "—" : (live ?? next ?? latest).definition.starts_on}</td><td className="p-2">{dateTime(latest.created_at)}</td>
                <td className="space-y-1 p-2"><button type="button" className="block text-primary-700" onClick={() => open(rule.id)}>{awaiting ? "View" : "Edit"}</button><button type="button" className="block text-primary-700" onClick={() => showHistory(rule.id)}>History</button></td>
              </tr>;
            })}</tbody>
          </table>{!filtered.length && !showRescheduling && <p className="p-4 text-foreground-500">No rules match this view. <button type="button" className="font-medium text-primary-700 hover:underline" onClick={() => { setSearch(""); filterMenu(""); }}>Show all rules</button></p>}</div>
        </>}
        {tab === "history" && <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold">{historyRule?.versions[0].definition.name ?? "Rule history"}</h2>{historyId && <Button size="sm" variant="outline" onClick={() => showHistory("")}>All history</Button>}</div>
          {historyRule && <><Field label="Reason for rollback"><TextInput value={reason} onChange={e => setReason(e.target.value)} /></Field>
            {historyRule.versions.map(v => <div key={v.id} className="flex items-center justify-between gap-2 border-b border-background-200 pb-2"><span>Version {v.version} · {v.state} · {valueSummary(v.definition.value)}</span>
              {v.published_at && <Button size="sm" variant="outline" disabled={busy || !reason.trim()} onClick={() => void submit("rollback", { rule_id: historyId, expected_version: historyRule.versions[0].id, target_version: v.id, reason })}>Restore as draft</Button>}</div>)}</>}
          {!history.length && <p>No recorded changes.</p>}
          {history.map(event => <details key={event.id} className="rounded border border-background-200 p-2"><summary className="cursor-pointer">{event.after_data?.name ?? event.before_data?.name} · {event.action} · {dateTime(event.created_at)}</summary>
            <p className="py-2">{event.reason}</p><p className="text-xs">Changed by {event.actor || "Migration"}</p><pre className="mt-2 overflow-x-auto text-xs">{JSON.stringify({ previous: event.before_data, updated: event.after_data }, null, 2)}</pre></details>)}
        </div>}
        {tab === "effective" && <div className="space-y-2"><h2 className="font-bold">Published changes</h2>
          {scoped.flatMap(rule => published(rule).map(v => <div key={v.id} className="border-b border-background-200 py-2">
            <button type="button" className="text-primary-700" onClick={() => open(rule.id)}>{v.definition.name}</button>
            <p>{v.definition.starts_on}{v.definition.ends_on ? ` to ${v.definition.ends_on}` : ""} · {v.definition.starts_on > today ? "Scheduled" : v.definition.ends_on && v.definition.ends_on < today ? "Ended" : "Effective"} · {v.definition.enabled ? "Active" : "Inactive"}</p>
          </div>))}{!scoped.some(rule => published(rule).length > 0) && <p>No published changes.</p>}
        </div>}
        {tab === "compliance" && <div className="space-y-3"><h2 className="font-bold">Compliance & Notes</h2><p>Authentication, data access, infrastructure limits and mandatory controls are enforced independently. Record authoritative sources and review notes on each version.</p>
          {scoped.filter(rule => rule.versions[0].definition.notes || rule.versions[0].definition.source_url).map(rule => {
            const d = rule.versions[0].definition;
            return <div key={rule.id} className="border-b border-background-200 py-2"><button type="button" className="text-primary-700" onClick={() => open(rule.id)}>{d.name}</button><p>{d.notes}</p>
              {d.source_url && <a className="text-primary-700" href={d.source_url} target="_blank" rel="noreferrer">Open source</a>}</div>;
          })}
        </div>}
      </Card>
      {editor && current && version && awaitingIntegration(current) ? <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2"><h2 className="font-bold">{version.definition.name}</h2><Button size="sm" variant="ghost" onClick={() => setSelected("")}>Close</Button></div>
        <Badge tone="muted">Reference</Badge>
        {typeof version.definition.value === "object"
          ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-background-100 p-2 text-xs">{JSON.stringify(version.definition.value, null, 2)}</pre>
          : <p className="text-lg font-semibold">{definitionSummary(version.definition)}</p>}
        <p>{version.definition.description}</p>
        <p className="text-foreground-600">{referenceCaption}</p>
        {version.definition.source_url && <a className="font-medium text-primary-700 hover:underline" href={version.definition.source_url} target="_blank" rel="noreferrer">View source</a>}
      </Card> : editor && <RuleEditor key={version?.id ?? "new"} initial={version?.definition ?? { ...newDefinition(scope, category), starts_on: today }}
        rule={current} version={version} existingApprovalRequired={!!current && !!effective(current)?.definition.approval_required} categories={snapshot.categories} locations={locations} fields={snapshot.fields} busy={busy} close={() => setSelected("")} submit={submit} />}
    </div>}
  </>;
}
