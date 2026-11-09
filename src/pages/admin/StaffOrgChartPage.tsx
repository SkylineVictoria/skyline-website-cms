import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, EmptyState, Field, Modal, PageHeader, Select, TextInput } from "@/pages/admin/components/ui";
import { AddStaffDialog, EmployeeViewTabs } from "@/pages/admin/StaffPage";
import { adminOrgChart, adminSaveEmployment, adminSetManager } from "@/lib/staffApi";
import { buildOrgTree, managerChain, nodesWithTeams, orgMatches, placeProblem, teamOf, type OrgNode, type OrgPerson } from "@/lib/staffOrg";
import { staffEmployeePath } from "@/pages/admin/lib/staffRoutes";
import { STAFF_STATUS_LABEL, STAFF_STATUS_TONE } from "@/lib/staffStatus";

type View = "tree" | "chart";
const VIEW_KEY = "skyline.orgChart.view";
const personName = (p: OrgPerson) => p.name || p.email;
const initials = (p: OrgPerson) => (p.name || p.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
function savedView(): View { try { return localStorage.getItem(VIEW_KEY) === "chart" ? "chart" : "tree"; } catch { return "tree"; } }

/**
 * Staff > Employees > Org chart: who reports to whom (hr.employment manager, job title, department). Add someone under any active
 * person, change a person's job title, department or manager (Edit, or drag them onto their new manager). Admins only.
 */
export default function StaffOrgChartPage() {
  const [people, setPeople] = useState<OrgPerson[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>(savedView);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<{ manager?: { id: string; name: string } } | null>(null);
  const [editing, setEditing] = useState<OrgPerson | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  // The dragged person, readable before React re-renders (dragover fires straight after dragstart).
  const dragging = useRef<string | null>(null);
  const [dropId, setDropId] = useState<string | null | undefined>(undefined);

  const load = useCallback(async () => {
    setError("");
    try { setPeople(await adminOrgChart()); }
    catch (e) { setError(e instanceof Error ? e.message : "The org chart could not be loaded."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, view); } catch { /* per-viewer convenience only */ } }, [view]);

  const tree = useMemo(() => buildOrgTree(people ?? []), [people]);
  const searching = search.trim().length > 0;
  const shown = searching ? tree.filter((n) => orgMatches(n, search)) : tree;
  const topLevel = tree.length;

  const move = async (person: OrgPerson, managerId: string | null) => {
    if (!people || person.managerId === managerId) return;
    const problem = placeProblem(people, person.id, managerId);
    if (problem) { setError(problem); setNotice(""); return; }
    setError(""); setNotice("");
    try {
      await adminSetManager(person.id, managerId);
      const manager = people.find((p) => p.id === managerId);
      setNotice(manager ? `${personName(person)} now reports to ${personName(manager)}.` : `${personName(person)} is now at the top of the org chart.`);
      if (managerId) setCollapsed((c) => { const n = new Set(c); n.delete(managerId); return n; });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "The change could not be saved."); }
  };

  const drag = {
    start: (p: OrgPerson) => (e: DragEvent) => { dragging.current = p.id; setDragId(p.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", p.id); },
    end: () => { dragging.current = null; setDragId(null); setDropId(undefined); },
    over: (target: string | null) => (e: DragEvent) => {
      const id = dragging.current;
      if (!id || !people || (target !== null && placeProblem(people, id, target))) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropId(target);
    },
    drop: (target: string | null) => (e: DragEvent) => {
      e.preventDefault();
      const person = people?.find((p) => p.id === (dragging.current ?? e.dataTransfer.getData("text/plain")));
      dragging.current = null; setDragId(null); setDropId(undefined);
      if (person) void move(person, target);
    },
  };

  const toggle = (id: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const isOpen = (id: string) => searching || !collapsed.has(id);

  const card = (node: OrgNode) => {
    const p = node.person;
    return (
      <div draggable onDragStart={drag.start(p)} onDragEnd={drag.end} onDragOver={drag.over(p.id)} onDragLeave={() => setDropId(undefined)} onDrop={drag.drop(p.id)}
        className={`group relative flex min-w-[220px] max-w-[280px] items-start gap-3 rounded-card border bg-background-50 p-3 text-left shadow-sm transition ${dropId === p.id ? "border-primary-500 ring-2 ring-primary-200" : "border-background-200"} ${dragId === p.id ? "opacity-50" : ""}`}
        data-testid={`org-node-${p.id}`}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-100 text-xs font-bold text-primary-800" aria-hidden="true">{initials(p)}</span>
        <span className="min-w-0 flex-1">
          <Link to={staffEmployeePath(p.id)} className="block truncate text-sm font-semibold text-foreground-950 hover:text-primary-700 hover:underline">{personName(p)}</Link>
          <span className="block truncate text-xs text-foreground-600" title={[p.jobTitle, p.department].filter(Boolean).join(" · ") || undefined}>{p.jobTitle || <em className="text-foreground-400">No job title</em>}{p.department ? <span className="text-foreground-500"> · {p.department}</span> : null}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            {p.status !== "active" ? <Badge tone={STAFF_STATUS_TONE[p.status]}>{STAFF_STATUS_LABEL[p.status]}</Badge> : null}
            {node.teamSize ? <span className="text-[11px] text-foreground-500">{node.children.length} direct · {node.teamSize} in team</span> : null}
          </span>
        </span>
        <span className="flex shrink-0 flex-col gap-1">
          {p.status === "active" ? <button type="button" title={`Add someone who reports to ${personName(p)}`} aria-label={`Add someone who reports to ${personName(p)}`} onClick={() => setAdding({ manager: { id: p.id, name: personName(p) } })}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-foreground-600 hover:bg-primary-50 hover:text-primary-700" data-testid={`org-add-under-${p.id}`}><i className="ri-user-add-line" aria-hidden="true" /></button> : null}
          <button type="button" title="Change job title, department or manager" aria-label={`Change ${personName(p)}'s job title, department or manager`} onClick={() => setEditing(p)}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-foreground-600 hover:bg-background-100 hover:text-foreground-900" data-testid={`org-edit-${p.id}`}><i className="ri-pencil-line" aria-hidden="true" /></button>
        </span>
      </div>
    );
  };

  const toggleButton = (node: OrgNode) => node.children.length && !searching ? (
    <button type="button" onClick={() => toggle(node.person.id)} aria-expanded={isOpen(node.person.id)} aria-label={`${isOpen(node.person.id) ? "Hide" : "Show"} ${personName(node.person)}'s team`}
      className="flex h-6 cursor-pointer items-center gap-1 rounded-full border border-background-300 bg-background-50 px-2 text-[11px] font-medium text-foreground-700 hover:bg-background-100">
      <i className={isOpen(node.person.id) ? "ri-subtract-line" : "ri-add-line"} aria-hidden="true" />{node.children.length}
    </button>
  ) : null;

  // The indented tree: works at any width.
  const treeNode = (node: OrgNode) => (
    <li key={node.person.id} className="org-tree-item">
      <div className="flex items-center gap-2">{card(node)}{toggleButton(node)}</div>
      {node.children.length && isOpen(node.person.id) ? (
        <ul className="org-tree">{node.children.filter((c) => !searching || orgMatches(c, search)).map(treeNode)}</ul>
      ) : null}
    </li>
  );

  // The top-down chart: scrolls sideways when the chart is wider than the screen.
  const chartNode = (node: OrgNode) => (
    <li key={node.person.id}>
      <div className="inline-flex flex-col items-center gap-1">{card(node)}{toggleButton(node)}</div>
      {node.children.length && isOpen(node.person.id) ? (
        <ul>{node.children.filter((c) => !searching || orgMatches(c, search)).map(chartNode)}</ul>
      ) : null}
    </li>
  );

  return (
    <div>
      <style>{ORG_CSS}</style>
      <PageHeader breadcrumb="Staff" title="Employees" description="Who reports to whom. Active staff are shown, plus anyone being onboarded who already has a manager. Use + on a person to add someone to their team, the pencil to change a job title, department or manager, or drag a person onto their new manager."
        actions={<>
          <Button onClick={() => setAdding({})} data-testid="org-add"><i className="ri-user-add-line" aria-hidden="true" /> Add staff member</Button>
        </>} />
      <EmployeeViewTabs active="org-chart" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-full sm:w-64"><TextInput type="search" placeholder="Search name, email, title or department" aria-label="Search the org chart" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="inline-flex rounded-md border border-background-300 p-0.5" role="group" aria-label="View">
          {(["tree", "chart"] as View[]).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} data-testid={`org-view-${v}`}
              className={`cursor-pointer rounded px-3 py-1.5 text-sm ${view === v ? "bg-primary-500 font-semibold text-background-50" : "text-foreground-700 hover:bg-background-100"}`}>
              <i className={v === "tree" ? "ri-node-tree" : "ri-organization-chart"} aria-hidden="true" /> {v === "tree" ? "Tree" : "Chart"}
            </button>
          ))}
        </div>
        {!searching && people?.length ? <>
          <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}>Expand all</Button>
          <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set(nodesWithTeams(tree)))}>Collapse all</Button>
        </> : null}
        {people ? <p className="text-xs text-foreground-500" role="status">{people.length} {people.length === 1 ? "person" : "people"} · {topLevel} at the top</p> : null}
      </div>

      {notice ? <p role="status" className="mb-4 rounded-md border border-secondary-300 bg-secondary-50 px-3 py-2 text-sm text-foreground-900">{notice}</p> : null}
      {error ? <p role="alert" className="mb-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}

      {people && people.length === 0 ? <EmptyState icon="ri-organization-chart" title="No staff on the org chart yet" description="Active staff appear here. Activate someone under Employees, then add the people who report to them with the + on their card." /> : null}
      {people && people.length > 0 && shown.length === 0 ? <EmptyState icon="ri-search-line" title="Nobody matches" description="Try another name, email, job title or department." /> : null}

      {people && shown.length ? (
        <Card className="overflow-x-auto p-4">
          <div onDragOver={drag.over(null)} onDragLeave={() => setDropId(undefined)} onDrop={drag.drop(null)} data-testid="org-drop-top"
            className={`mb-4 rounded-md border-2 border-dashed px-4 py-2 text-center text-xs ${dropId === null ? "border-primary-500 bg-primary-50 text-primary-800" : dragId ? "border-primary-300 text-foreground-700" : "border-background-200 text-foreground-500"}`}>
            {dragId ? "Drop here to put them at the top of the org chart (reporting to nobody)" : "Tip: drag a person onto their new manager to move them and their team; drop here for the top of the chart."}
          </div>
          {view === "tree"
            ? <ul className="org-tree org-tree-root" data-testid="org-tree">{shown.map(treeNode)}</ul>
            : <div className="org-chart" data-testid="org-chart"><ul>{shown.map(chartNode)}</ul></div>}
        </Card>
      ) : null}

      {adding ? <AddStaffDialog manager={adding.manager} onClose={() => setAdding(null)} /> : null}
      {editing && people ? <EditPositionDialog person={editing} people={people}
        onClose={() => setEditing(null)} onSaved={(message) => { setEditing(null); setNotice(message); setError(""); void load(); }} /> : null}
    </div>
  );
}

/** Job title, department and manager; the employment type and work location are kept as they are (hr_admin_staff_employment_save). */
function EditPositionDialog({ person, people, onClose, onSaved }: {
  person: OrgPerson; people: OrgPerson[]; onClose: () => void; onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState({ jobTitle: person.jobTitle, department: person.department, managerId: person.managerId ?? "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const team = useMemo(() => teamOf(people, person.id), [people, person.id]);
  const managers = people.filter((p) => p.status === "active" && !team.has(p.id));
  const chain = form.managerId ? [...managerChain(people, form.managerId), people.find((p) => p.id === form.managerId)].filter((p): p is OrgPerson => Boolean(p)) : [];
  const save = async () => {
    const managerId = form.managerId || null;
    const problem = placeProblem(people, person.id, managerId);
    if (problem) { setError(problem); return; }
    setBusy(true); setError("");
    try {
      // The manager first: it also creates a missing employment record for an active manager, which the full save requires.
      if (managerId !== person.managerId) await adminSetManager(person.id, managerId);
      await adminSaveEmployment(person.id, { jobTitle: form.jobTitle.trim(), department: form.department.trim(), employmentType: person.employmentType ?? "", managerId: managerId ?? "", workLocation: person.workLocation });
      onSaved(`${personName(person)}'s details were saved.`);
    } catch (e) { setError(e instanceof Error ? e.message : "The change could not be saved."); }
    finally { setBusy(false); }
  };
  return (
    <Modal open title={personName(person)} onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} disabled={busy} data-testid="org-save">{busy ? "Saving…" : "Save"}</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Job title" hint="e.g. Trainer, Head of Department"><TextInput value={form.jobTitle} onChange={(e) => setForm((f) => ({ ...f, jobTitle: e.target.value }))} maxLength={150} data-testid="org-job-title" /></Field>
          <Field label="Department"><TextInput value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} maxLength={120} data-testid="org-department" /></Field>
        </div>
        <Field label="Reports to" hint="An active employee. Leave empty for the top of the org chart.">
          <Select value={form.managerId} onChange={(e) => setForm((f) => ({ ...f, managerId: e.target.value }))} data-testid="org-manager">
            <option value="">Nobody (top of the org chart)</option>
            {managers.map((p) => <option key={p.id} value={p.id}>{personName(p)}{p.jobTitle ? ` — ${p.jobTitle}` : ""}</option>)}
          </Select>
        </Field>
        {chain.length ? <p className="text-xs text-foreground-500">Reporting line: {chain.map(personName).join(" › ")} › <strong>{personName(person)}</strong></p> : null}
        {team.size > 1 ? <p className="text-xs text-foreground-500">Their team ({team.size - 1} {team.size === 2 ? "person" : "people"}) moves with them.</p> : null}
        {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
      </div>
    </Modal>
  );
}

/* Connector lines for both views. Colours come from the theme tokens, so light and dark both work. */
const ORG_CSS = `
.org-tree{list-style:none;margin:0;padding-left:1.75rem;position:relative}
.org-tree-root{padding-left:0}
.org-tree .org-tree-item{position:relative;padding-top:.5rem}
.org-tree:not(.org-tree-root)>.org-tree-item::before{content:"";position:absolute;left:-1rem;top:0;bottom:0;border-left:2px solid oklch(var(--background-300))}
.org-tree:not(.org-tree-root)>.org-tree-item:last-child::before{bottom:auto;height:2.4rem}
.org-tree:not(.org-tree-root)>.org-tree-item::after{content:"";position:absolute;left:-1rem;top:2.4rem;width:1rem;border-top:2px solid oklch(var(--background-300))}
.org-chart{display:inline-block;min-width:100%;text-align:center}
.org-chart ul{display:flex;justify-content:safe center;width:max-content;min-width:100%;padding-top:1.25rem;position:relative;list-style:none;margin:0}
.org-chart>ul{padding-top:0}
.org-chart li{position:relative;padding:1.25rem .5rem 0;display:flex;flex-direction:column;align-items:safe center;flex-shrink:0}
.org-chart>ul>li{padding-top:0}
.org-chart>ul>li::before,.org-chart>ul>li::after{display:none}
.org-chart li::before,.org-chart li::after{content:"";position:absolute;top:0;right:50%;width:50%;height:1.25rem;border-top:2px solid oklch(var(--background-300))}
.org-chart li::after{right:auto;left:50%;border-left:2px solid oklch(var(--background-300))}
.org-chart li:only-child::before,.org-chart li:only-child::after{display:none}
.org-chart li:only-child{padding-top:1.25rem}
.org-chart>ul>li:only-child{padding-top:0}
.org-chart li:first-child::before,.org-chart li:last-child::after{border:0 none}
.org-chart li:last-child::before{border-right:2px solid oklch(var(--background-300))}
.org-chart ul ul::before{content:"";position:absolute;top:0;left:50%;height:1.25rem;border-left:2px solid oklch(var(--background-300))}
.org-chart ul ul>li:only-child::before{display:block;border:0;border-left:2px solid oklch(var(--background-300));width:0;left:50%;right:auto;height:1.25rem}
.org-chart ul ul{padding-top:1.25rem}
`;
