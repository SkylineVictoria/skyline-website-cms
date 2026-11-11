import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Modal, PageHeader } from "@/pages/admin/components/ui";
import PdfPages from "@/components/signing/PdfPages";
import TemplateEditor from "@/pages/admin/components/signing/TemplateEditor";
import TemplatePreviewDialog from "@/pages/admin/components/signing/TemplatePreviewDialog";
import { pdfBytes, signingAction, signingAdmin, type SigningContext, type SigningTemplate } from "@/lib/signingApi";
import { SIGN_CATEGORIES } from "../../../supabase/functions/_shared/signing";
import { TEMPLATE_TYPES, isTemplateType, textToHtml, type TemplateType } from "../../../supabase/functions/_shared/hr-template";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";
const AUDIENCE = { any: "Anyone", student: "Students", employee: "Employees", agent: "Agents" } as const;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

/**
 * HRMS > Templates (Admin only): every template of the one table: offer letters and the onboarding emails (placeholders such as
 * {{first_name}} filled in for each person), and the documents sent for signature. Create, edit (every save is a new version),
 * duplicate, make default (one per kind), archive, delete and preview. A letter already made for someone keeps its own copy.
 */
export default function TemplatesPage() {
  const [templates, setTemplates] = useState<SigningTemplate[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<{ template: SigningTemplate | null; kind?: "text" | "email" | "pdf"; category?: string } | null>(null);
  const [previewing, setPreviewing] = useState<SigningTemplate | null>(null);
  const [pdfPreview, setPdfPreview] = useState<Uint8Array | null>(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try { setTemplates((await signingAdmin<SigningContext>("list")).templates); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "The templates could not be loaded."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (key: string, work: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(key); setError(""); setNotice("");
    try { await work(); await load(); setNotice(done); }
    catch (e) { setError(e instanceof Error ? e.message : "That could not be done."); }
    finally { setBusy(""); }
  };
  const preview = (t: SigningTemplate) => {
    if (isTemplateType(t.category) && t.kind !== "pdf") { setPreviewing(t); return; }
    void act(`preview-${t.id}`, async () => setPdfPreview(pdfBytes((await signingAction<{ pdfBase64: string }>({ action: "template_preview", id: t.id })).pdfBase64)), "");
  };

  const row = (t: SigningTemplate, hrms: boolean) => (
    <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5" data-testid="template-row" data-template-id={t.id}>
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-sm font-semibold text-foreground-950">{t.name}
          {t.is_default ? <span className="ml-2 align-middle"><Badge tone="success">Default</Badge></span> : null}
          {t.status === "archived" ? <span className="ml-2 align-middle"><Badge tone="muted">Archived</Badge></span> : null}</p>
        <p className="truncate text-xs text-foreground-600">
          {hrms ? `${t.kind === "email" ? "Subject" : "Title"}: ${t.subject ?? t.title}` : `${t.kind === "pdf" ? `PDF, ${t.source_pages ?? "?"} pages` : "Text"} · ${AUDIENCE[t.audience]} · ${t.roles.map((r) => r.label).join(" → ")} · ${t.fields.length} field${t.fields.length === 1 ? "" : "s"}`}
          {` · version ${t.version} · updated ${day(t.updated_at)}`}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" disabled={busy === `preview-${t.id}`} onClick={() => preview(t)} data-testid="template-preview">Preview</Button>
        {t.status === "archived" ? (
          <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void act(`restore-${t.id}`, () => signingAdmin("template_archive", t.id), "The template was restored.")} data-testid="template-restore">Restore</Button>
        ) : <>
          <Button size="sm" variant="outline" onClick={() => setEditing({ template: t })} data-testid="template-edit">Edit</Button>
          <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void act(`copy-${t.id}`, () => signingAction({ action: "template_duplicate", id: t.id }), "A copy was made.")} data-testid="template-duplicate">Duplicate</Button>
          {t.is_default ? null : <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void act(`default-${t.id}`, () => signingAdmin("template_default", t.id), `“${t.name}” is now the default.`)} data-testid="template-make-default">Make default</Button>}
          {t.is_default ? null : <Button size="sm" variant="ghost" disabled={Boolean(busy)}
            onClick={() => { if (window.confirm(`Archive “${t.name}”? It stays on file and can be restored, but is not offered when sending.`)) void act(`archive-${t.id}`, () => signingAdmin("template_archive", t.id), "The template was archived."); }} data-testid="template-archive">Archive</Button>}
        </>}
        {t.is_default ? null : <Button size="sm" variant="ghost" disabled={Boolean(busy)}
          onClick={() => { if (window.confirm(`Delete “${t.name}”? Letters and requests already made from it keep their own copy.`)) void act(`delete-${t.id}`, () => signingAdmin("template_delete", t.id), "The template was deleted."); }} data-testid="template-delete">Delete</Button>}
      </div>
    </li>
  );
  const visible = (list: SigningTemplate[]) => list.filter((t) => showArchived || t.status !== "archived");
  const documents = templates ? visible(templates.filter((t) => !isTemplateType(t.category))) : [];

  return (
    <div>
      <PageHeader breadcrumb="HRMS" title="Templates" description="Offer letters, the emails sent during onboarding, and the documents sent for signature: one list, one editor. Placeholders such as {{first_name}} are filled in for each person; every save keeps the earlier version."
        actions={<label className="flex cursor-pointer items-center gap-2 text-sm text-foreground-700"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} data-testid="templates-show-archived" /> Show archived</label>} />
      {error ? <p role="alert" className={`mb-4 ${ALERT}`} data-testid="templates-error">{error}</p> : null}
      {notice ? <p role="status" className={`mb-4 ${NOTICE}`} data-testid="templates-notice">{notice}</p> : null}
      {!templates && !error ? <p className="text-sm text-foreground-600" role="status">Loading…</p> : null}

      {templates ? (
        <div className="space-y-5">
          {TEMPLATE_TYPES.map((spec) => {
            const mine = visible(templates.filter((t) => t.category === spec.type));
            return (
              <Card key={spec.type} className="p-5"><section data-testid={`templates-${spec.type}`}>
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-heading text-base font-bold text-foreground-950">{spec.label}</h2>
                    <p className="text-sm text-foreground-600">{spec.description}</p>
                  </div>
                  <Button size="sm" variant="outline" icon="ri-add-line" data-testid={`template-new-${spec.type}`}
                    onClick={() => setEditing({ template: null, kind: spec.kind === "email" ? "email" : "text", category: spec.type })}>New {spec.label.toLowerCase()}</Button>
                </div>
                {mine.length ? <ul className="divide-y divide-background-200 rounded-md border border-background-200">{mine.map((t) => row(t, true))}</ul>
                  : <p className="text-sm text-foreground-500">No {spec.label.toLowerCase()} yet{spec.kind === "email" ? ": the built-in email is used until you add one" : ""}.</p>}
              </section></Card>
            );
          })}
          <Card className="p-5"><section data-testid="templates-signing">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-heading text-base font-bold text-foreground-950">Documents to sign</h2>
                <p className="text-sm text-foreground-600">Enrolment agreements, employment contracts, declarations and other documents sent through Documents & Signatures: text with variables or a ready-made PDF, with the signers and their fields.</p>
              </div>
              <span className="flex gap-1.5">
                <Button size="sm" variant="outline" icon="ri-add-line" onClick={() => setEditing({ template: null, kind: "text", category: "other" })} data-testid="template-new-document">New document</Button>
                <Button size="sm" variant="outline" icon="ri-file-pdf-2-line" onClick={() => setEditing({ template: null, kind: "pdf", category: "other" })} data-testid="template-new-pdf">New from a PDF</Button>
              </span>
            </div>
            {documents.length ? (
              <ul className="divide-y divide-background-200 rounded-md border border-background-200">
                {documents.map((t) => <li key={t.id} className="contents">{row({ ...t, name: t.name }, false)}</li>)}
              </ul>
            ) : <p className="text-sm text-foreground-500">No document templates yet. {Object.values(SIGN_CATEGORIES).map((c) => c.label).slice(0, 3).join(", ")} and more can be made here.</p>}
          </section></Card>
        </div>
      ) : null}

      {editing ? <TemplateEditor template={editing.template} newKind={editing.kind} newCategory={editing.category} onClose={() => setEditing(null)}
        onSaved={(message) => { setEditing(null); setNotice(message); setError(""); void load(); }} /> : null}
      {previewing ? <TemplatePreviewDialog template={{ id: previewing.id, type: previewing.category as TemplateType, name: previewing.name, subject: previewing.subject ?? previewing.title, bodyHtml: previewing.body_html?.trim() ? previewing.body_html : textToHtml(previewing.body ?? "") }} onClose={() => setPreviewing(null)} /> : null}
      {pdfPreview ? <Modal open title="Template preview (PDF)" width="max-w-4xl" onClose={() => setPdfPreview(null)}><PdfPages source={pdfPreview} /></Modal> : null}
    </div>
  );
}
