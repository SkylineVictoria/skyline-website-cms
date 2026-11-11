import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, EmptyState, Field, PageHeader, SectionTabs, Select, TextInput } from "./components/ui";
import ComposeRequest from "./components/signing/ComposeRequest";
import RequestDetail from "./components/signing/RequestDetail";
import TemplateEditor from "./components/signing/TemplateEditor";
import LegacySigningPage from "./components/signing/LegacySigningPage";
import { signedCount, signingAction, signingAdmin, signingStatus, signingUpgraded, SIGNING_STATUS, type SigningContext, type SigningRequest, type SigningTemplate } from "@/lib/signingApi";
import { SIGN_CATEGORIES } from "../../../supabase/functions/_shared/signing";

const SUBJECT = { student: "Student", employee: "Employee", agent: "Agent" } as const;
const AUDIENCE = { any: "Anyone", student: "Students", employee: "Employees", agent: "Agents" } as const;

/** Documents & Signatures. Shows the released first-stage page until the hosted database has the second-stage actions. */
export default function SigningPage() {
  const [upgraded, setUpgraded] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void signingUpgraded().then(setUpgraded).catch((e: Error) => setError(e.message)); }, []);
  if (error) return <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p>;
  if (upgraded === null) return <p role="status">Loading…</p>;
  return upgraded ? <EnvelopeSigningPage /> : <LegacySigningPage />;
}

/** Documents & Signatures: every request by status with search and filters, and the templates they are made from. */
function EnvelopeSigningPage() {
  const [context, setContext] = useState<SigningContext>({ templates: [], requests: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(() => (new URLSearchParams(window.location.search).get("view") ?? window.location.pathname.split("/").at(-1)) === "templates" ? "templates" : "requests"); const [status, setStatus] = useState(() => { const v = (new URLSearchParams(window.location.search).get("view") ?? window.location.pathname.split("/").at(-1)); return v && Object.prototype.hasOwnProperty.call(SIGNING_STATUS, v) ? v : "all"; });
  useEffect(() => { const sync = () => { const v = (new URLSearchParams(window.location.search).get("view") ?? window.location.pathname.split("/").at(-1)); setTab(v === "templates" ? "templates" : "requests"); setStatus(v && Object.prototype.hasOwnProperty.call(SIGNING_STATUS, v) ? v : "all"); }; window.addEventListener("popstate", sync); return () => window.removeEventListener("popstate", sync); }, []);
  const [search, setSearch] = useState(""); const [category, setCategory] = useState(""); const [subject, setSubject] = useState("");
  const [compose, setCompose] = useState(false); const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<SigningTemplate | "new" | null>(null);
  const load = useCallback(async () => { setContext(await signingAdmin<SigningContext>("list")); setLoaded(true); }, []);
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); }, [load]);
  const act = async (work: () => Promise<unknown>, message = "") => {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try { await work(); await load(); setNotice(message); } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); }
  };
  const counts = useMemo(() => { const c: Record<string, number> = { all: context.requests.length }; for (const r of context.requests) c[r.status] = (c[r.status] ?? 0) + 1; return c; }, [context.requests]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return context.requests.filter((r) => (status === "all" || r.status === status) && (!category || r.category === category) && (!subject || r.subject_type === subject)
      && (!q || `${r.title} ${r.reference} ${r.recipients.map((p) => `${p.name} ${p.email}`).join(" ")}`.toLowerCase().includes(q)));
  }, [context.requests, status, category, subject, search]);

  return <div className="space-y-6">
    <PageHeader title="Documents & Signatures" description="Prepare a document from a template or a PDF, send it to one or more signers, follow its progress and keep the signed copy with its certificate." />
    {error && <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p>}
    {notice && <p role="status" className="rounded border border-green-300 p-3">{notice}</p>}
    <div className="flex flex-wrap gap-3">
      <Button icon="ri-add-line" onClick={() => setCompose(true)} data-testid="new-request">New signing request</Button>
      <Button variant="outline" icon="ri-file-add-line" onClick={() => { setTab("templates"); setEditing("new"); }} data-testid="new-template">New template</Button>
      <Button variant="outline" disabled={busy} onClick={() => void act(load)}>Refresh</Button>
      <Button variant="outline" disabled={busy} onClick={() => void act(async () => { const r = await signingAction<{ expired: number; reminders: number }>({ action: "tick" }); setNotice(`${r.reminders} reminder${r.reminders === 1 ? "" : "s"} sent, ${r.expired} request${r.expired === 1 ? "" : "s"} expired.`); })}>Send due reminders now</Button>
    </div>
    <SectionTabs tabs={[{ id: "requests", label: `Requests (${context.requests.length})`, icon: "ri-quill-pen-line" }, { id: "templates", label: `Templates (${context.templates.length})`, icon: "ri-file-copy-2-line" }]} active={tab} onChange={setTab} />

    {tab === "requests" && <>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Status">{["all", ...Object.keys(SIGNING_STATUS)].map((key) => <button key={key} type="button" role="tab" aria-selected={status === key} data-testid={`status-${key}`} onClick={() => setStatus(key)}
        className={`rounded-full border px-3 py-1.5 text-[13px] font-medium ${status === key ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-background-50 text-foreground-700 hover:bg-background-100"}`}>
        {key === "all" ? "All" : SIGNING_STATUS[key].label} ({counts[key] ?? 0})</button>)}</div>
      <div className="grid gap-3 md:grid-cols-[1fr_220px_180px]">
        <Field label="Search"><TextInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Document, reference, recipient name or email" data-testid="request-search" /></Field>
        <Field label="Document type"><Select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All types</option>{Object.entries(SIGN_CATEGORIES).map(([key, c]) => <option key={key} value={key}>{c.label}</option>)}</Select></Field>
        <Field label="For"><Select value={subject} onChange={(e) => setSubject(e.target.value)}><option value="">Everyone</option><option value="student">Students</option><option value="employee">Employees</option><option value="agent">Agents</option></Select></Field>
      </div>
      {!loaded ? <p role="status">Loading…</p> : !shown.length ? <EmptyState icon="ri-quill-pen-line" title={context.requests.length ? "No request matches these filters" : "No signing requests yet"} description={context.requests.length ? undefined : "Create a template or upload a PDF to send your first document."} />
        : <div className="overflow-x-auto rounded-md border border-background-300"><table className="w-full min-w-[720px] text-left text-sm" data-testid="request-table">
          <thead className="bg-background-100 text-xs text-foreground-600"><tr><th className="px-3 py-2">Document</th><th className="px-3">Recipients</th><th className="px-3">Status</th><th className="px-3">Progress</th><th className="px-3">Created</th><th className="px-3">Expires</th></tr></thead>
          <tbody>{shown.map((r: SigningRequest) => { const s = signingStatus(r.status); return <tr key={r.id} className="cursor-pointer border-t border-background-200 hover:bg-background-100" onClick={() => setOpenId(r.id)}>
            <td className="px-3 py-2"><button type="button" className="text-left font-medium text-primary-700 underline-offset-2 hover:underline">{r.title}</button><p className="text-xs text-foreground-500">{r.reference} · {SIGN_CATEGORIES[r.category]?.label ?? r.category}{r.subject_type ? ` · ${SUBJECT[r.subject_type]}` : ""}</p></td>
            <td className="px-3">{r.recipients.map((p) => p.name).join(", ")}</td><td className="px-3"><Badge tone={s.tone}>{s.label}</Badge></td><td className="px-3">{r.state === "draft" ? "Not sent" : signedCount(r)}</td>
            <td className="px-3">{new Date(r.created_at).toLocaleDateString()}</td><td className="px-3">{r.expires_at ? new Date(r.expires_at).toLocaleDateString() : ""}</td></tr>; })}</tbody></table></div>}
    </>}

    {tab === "templates" && (!context.templates.length ? <EmptyState icon="ri-file-copy-2-line" title="No templates yet" description="A template holds the text or PDF, its variables, who signs and where." />
      : <div className="overflow-x-auto rounded-md border border-background-300"><table className="w-full min-w-[720px] text-left text-sm" data-testid="template-table">
        <thead className="bg-background-100 text-xs text-foreground-600"><tr><th className="px-3 py-2">Template</th><th className="px-3">Type</th><th className="px-3">For</th><th className="px-3">Signers</th><th className="px-3">Version</th><th className="px-3" /></tr></thead>
        <tbody>{context.templates.map((t) => <tr key={t.id} className="border-t border-background-200">
          <td className="px-3 py-2"><p className="font-medium">{t.name}</p><p className="text-xs text-foreground-500">{t.kind === "pdf" ? `PDF, ${t.source_pages ?? "?"} pages` : "Text"} · {t.fields.length} field{t.fields.length === 1 ? "" : "s"}{t.status === "archived" ? " · archived" : ""}</p></td>
          <td className="px-3">{SIGN_CATEGORIES[t.category]?.label ?? t.category}</td><td className="px-3">{AUDIENCE[t.audience]}</td><td className="px-3">{t.roles.map((r) => r.label).join(" → ")}</td><td className="px-3">{t.version}</td>
          <td className="px-3 py-2"><div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(t)}>Edit</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => signingAction({ action: "template_duplicate", id: t.id }), "Template duplicated.")}>Duplicate</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => signingAdmin("template_archive", t.id), t.status === "active" ? "Template archived." : "Template restored.")}>{t.status === "active" ? "Archive" : "Unarchive"}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm(`Delete the template “${t.name}”? Requests already made from it keep their own copy.`)) void act(() => signingAdmin("template_delete", t.id), "Template deleted."); }}>Delete</Button>
          </div></td></tr>)}</tbody></table></div>)}

    {compose && <ComposeRequest templates={context.templates} onClose={() => setCompose(false)} onCreated={(r) => { setCompose(false); setNotice("Draft saved. Place the fields, review the document, then send it for signature."); void load(); setOpenId(r.id); }} />}
    {editing && <TemplateEditor template={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(message) => { setEditing(null); setNotice(message); void load(); }} />}
    {openId && <RequestDetail id={openId} onClose={() => setOpenId(null)} onChanged={() => void load()} />}
  </div>;
}
