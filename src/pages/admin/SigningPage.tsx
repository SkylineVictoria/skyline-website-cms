import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { Badge, Button, EmptyState, Field, PageHeader, SectionTabs, Select, TextInput } from "./components/ui";
import ComposeRequest from "./components/signing/ComposeRequest";
import RequestDetail from "./components/signing/RequestDetail";
import TemplateEditor from "./components/signing/TemplateEditor";
import LegacySigningPage from "./components/signing/LegacySigningPage";
import { signedCount, signingAction, signingAdmin, signingStatus, signingUpgraded, SIGNING_STATUS, type SigningContext, type SigningRequest, type SigningTemplate } from "@/lib/signingApi";
import { SIGN_CATEGORIES } from "../../../supabase/functions/_shared/signing";
import { LETTER_CATEGORY, setLetterTemplateActive } from "@/lib/offerLetters";
import { Modal } from "./components/ui";

const SUBJECT = { student: "Student", employee: "Employee", agent: "Agent" } as const;
const AUDIENCE = { any: "Anyone", student: "Students / Applications", employee: "Employees", agent: "Agents" } as const;
type Audience = keyof typeof AUDIENCE;

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
  // React Router changes client-side routes without a popstate event. Read the
  // current route directly so sidebar links always select the right view.
  const location = useLocation();
  const routeView = new URLSearchParams(location.search).get("view") ?? location.pathname.split("/").at(-1) ?? "";
  const routeTab = routeView === "templates" ? "templates" : "requests";
  const routeStatus = routeView === "pending" ? "sent" : routeView === "completed" ? "signed" : Object.prototype.hasOwnProperty.call(SIGNING_STATUS, routeView) ? routeView : "all";
  const [tab, setTab] = useState(routeTab);
  const [status, setStatus] = useState(routeStatus);
  useEffect(() => { setTab(routeTab); setStatus(routeStatus); }, [routeTab, routeStatus]);
  const [search, setSearch] = useState(""); const [category, setCategory] = useState(""); const [subject, setSubject] = useState("");
  const [compose, setCompose] = useState(false); const [openId, setOpenId] = useState<string | null>(null); const [placeAfterCreateId, setPlaceAfterCreateId] = useState<string | null>(null);
  const [editing, setEditing] = useState<SigningTemplate | { audience: Audience; category: string } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [forFilter, setForFilter] = useState<"" | "employee" | "student">("");
  // ?new=student_offer_letter (the offer letter drawer's "Create template"): the editor opens preset to Students › Letter of Offer.
  useEffect(() => {
    const preset = new URLSearchParams(location.search).get("new");
    if (preset && SIGN_CATEGORIES[preset]) { setTab("templates"); setEditing({ audience: SIGN_CATEGORIES[preset].audience as Audience, category: preset }); }
  }, [location.search]);
  const templates = useMemo(() => context.templates.filter((t) => !forFilter || t.audience === forFilter), [context.templates, forFilter]);
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
      <Button variant="outline" icon="ri-file-add-line" onClick={() => { setTab("templates"); setChoosing(true); }} data-testid="new-template">New template</Button>
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

    {tab === "templates" && <div className="flex flex-wrap items-end gap-3">
      <Field label="For"><Select value={forFilter} onChange={(e) => setForFilter(e.target.value as typeof forFilter)} data-testid="template-for-filter" className="w-56">
        <option value="">All</option><option value="employee">Employees</option><option value="student">Students / Applications</option></Select></Field>
    </div>}
    {tab === "templates" && (!templates.length ? <EmptyState icon="ri-file-copy-2-line" title="No templates yet" description="A template holds the text or PDF, its variables, who signs and where." />
      : <div className="overflow-x-auto rounded-md border border-background-300"><table className="w-full min-w-[720px] text-left text-sm" data-testid="template-table">
        <thead className="bg-background-100 text-xs text-foreground-600"><tr><th className="px-3 py-2">Template</th><th className="px-3">Type</th><th className="px-3">For</th><th className="px-3">Signers</th><th className="px-3">Version</th><th className="px-3" /></tr></thead>
        <tbody>{templates.map((t) => <tr key={t.id} className="border-t border-background-200" data-testid="sign-template-row" data-category={t.category} data-audience={t.audience}>
          <td className="px-3 py-2"><p className="font-medium">{t.name}{t.is_default ? <Badge tone="success">Default</Badge> : null}</p><p className="text-xs text-foreground-500">{t.kind === "pdf" ? `PDF, ${t.source_pages ?? "?"} pages` : t.kind === "email" ? "Email (not signed)" : "Text"} · {t.category === LETTER_CATEGORY ? "Header, body, footer · sent from an application" : <>{t.fields.length} field{t.fields.length === 1 ? "" : "s"}</>}{t.status === "archived" ? (t.category === LETTER_CATEGORY ? " · inactive" : " · archived") : t.category === LETTER_CATEGORY ? " · active" : ""}</p></td>
          <td className="px-3">{SIGN_CATEGORIES[t.category]?.label ?? t.category}</td><td className="px-3">{AUDIENCE[t.audience]}</td><td className="px-3">{t.category === LETTER_CATEGORY ? "Accepted in the portal" : t.roles.map((r) => r.label).join(" → ")}</td><td className="px-3">{t.version}</td>
          <td className="px-3 py-2"><div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(t)}>Edit</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => signingAction({ action: "template_duplicate", id: t.id }), "Template duplicated.")}>Duplicate</Button>
            {t.category === LETTER_CATEGORY
              ? <Button size="sm" variant="outline" disabled={busy} data-testid="letter-template-toggle" onClick={() => void act(() => setLetterTemplateActive(t.id, t.status !== "active"), t.status === "active" ? "The letter is inactive." : "The letter is active.")}>{t.status === "active" ? "Make inactive" : "Make active"}</Button>
              : <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => signingAdmin("template_archive", t.id), t.status === "active" ? "Template archived." : "Template restored.")}>{t.status === "active" ? "Archive" : "Unarchive"}</Button>}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm(`Delete the template “${t.name}”? Requests already made from it keep their own copy.`)) void act(() => signingAdmin("template_delete", t.id), "Template deleted."); }}>Delete</Button>
          </div></td></tr>)}</tbody></table></div>)}

    {compose && <ComposeRequest templates={context.templates} onClose={() => setCompose(false)} onCreated={(r) => { setCompose(false); setNotice("Draft saved. Place the fields, then review and send it for signature."); void load(); setPlaceAfterCreateId(r.id); setOpenId(r.id); }} />}
    {choosing && <Modal open title="New template: who is it for?" onClose={() => setChoosing(false)}>
      <div className="grid gap-3 sm:grid-cols-2" data-testid="template-audience-choice">
        {([["employee", "Employees", "Contracts, declarations and other staff documents (employee variables).", "employment_contract", "ri-user-star-line"],
          ["student", "Students / Applications", "The Letter of Offer sent from an application, and student documents (student, course, fee and institute variables).", LETTER_CATEGORY, "ri-graduation-cap-line"]] as const)
          .map(([audience, label, hint, category, icon]) => (
            <button key={audience} type="button" data-testid={`template-audience-${audience}`} onClick={() => { setChoosing(false); setEditing({ audience, category }); }}
              className="flex cursor-pointer flex-col items-start gap-1 rounded-lg border border-background-300 p-4 text-left hover:border-primary-400 hover:bg-primary-50">
              <i className={`${icon} text-xl text-primary-600`} aria-hidden="true" /><span className="font-semibold text-foreground-950">{label}</span><span className="text-xs text-foreground-600">{hint}</span>
            </button>))}
      </div>
    </Modal>}
    {editing && <TemplateEditor template={"id" in editing ? editing : null} audience={"id" in editing ? undefined : editing.audience} newCategory={"id" in editing ? undefined : editing.category}
      onClose={() => setEditing(null)} onSaved={(message) => { setEditing(null); setNotice(message); void load(); }} />}
    {openId && <RequestDetail id={openId} startPlacing={placeAfterCreateId === openId} onClose={() => { setOpenId(null); setPlaceAfterCreateId(null); }} onChanged={() => void load()} />}
  </div>;
}
