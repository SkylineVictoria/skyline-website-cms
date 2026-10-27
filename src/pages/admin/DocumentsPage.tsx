import { useMemo, useRef, useState } from "react";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, Modal, PageHeader, Select, StatusBadge, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import type { DocItem } from "@/pages/admin/lib/types";
import { HistoryButton } from "@/pages/admin/components/workflow";
import { removeCmsObject, uploadCmsDocument } from "@/pages/admin/lib/storage";
import DraftStatus from "@/pages/admin/components/DraftStatus";
import DraftResume from "@/pages/admin/components/DraftResume";
import { useSlotDraft } from "@/pages/admin/lib/useSlotDraft";

/* The public Forms & Policies page is split into exactly two sections,
   in this order. New documents must belong to one of them. */
const CATEGORIES = ["Forms", "Policies"];

const emptyDoc = (order: number): DocItem => ({
  id: "",
  name: "",
  category: CATEGORIES[0],
  description: "",
  fileName: "",
  url: "",
  sizeLabel: "PDF",
  docsCount: 1,
  status: "Published",
  displayOrder: order,
});

export default function DocumentsPage() {
  const { data, update, saveNow, logActivity, recordRevision } = useAdminData();
  const { push } = useToast();
  const [category, setCategory] = useState("All");
  const [editing, setEditing] = useState<DocItem | null>(null);
  const blankDoc = () => emptyDoc(data.documents.filter((d) => d.category === CATEGORIES[0]).length + 1);
  const slot = useSlotDraft<DocItem>("document", (id) => data.documents.find((d) => d.id === id) ?? null, blankDoc);
  const draft = slot.draft;
  const setDraft = slot.setDraft;
  const [pendingDelete, setPendingDelete] = useState<DocItem | null>(null);
  const documentInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const filtered = useMemo(
    () => data.documents.filter((d) => category === "All" || d.category === category),
    [data.documents, category],
  );

  /* Group by section (Forms first, then Policies) and order within each. */
  const grouped = useMemo(() => {
    const sections = ["Forms", "Policies"].filter((s) => category === "All" || s === category);
    return sections
      .map((name) => ({
        name,
        items: filtered
          .filter((d) => d.category === name)
          .sort((a, b) => a.displayOrder - b.displayOrder),
      }))
      .filter((g) => g.items.length > 0);
  }, [filtered, category]);

  const openNew = () => {
    setEditing(null);
    slot.openNew();
  };
  const openEdit = (d: DocItem) => {
    setEditing(d);
    slot.openEdit(d.id, { ...d });
  };
  const close = () => {
    slot.close();
    setEditing(null);
  };
  const resumeDraft = (id: string) => { setEditing(id === "new" ? null : data.documents.find((d) => d.id === id) ?? null); slot.resume(id); };

  const save = () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      push("Document name is required", "error");
      return;
    }
    if (editing) {
      update((d) => ({ ...d, documents: d.documents.map((x) => (x.id === draft.id ? draft : x)) }));
      recordRevision({ entity: "document", entityId: draft.id, title: draft.name, action: draft.status === "Published" ? "Published" : "Saved draft", status: draft.status, snapshot: draft });
      logActivity("Updated", draft.name, "Documents");
      push("Document updated");
    } else {
      const next = { ...draft, id: crypto.randomUUID() };
      update((d) => ({ ...d, documents: [...d.documents, next] }));
      recordRevision({ entity: "document", entityId: next.id, title: next.name, action: "Created", status: next.status, snapshot: next });
      logActivity("Created", next.name, "Documents");
      push("Document added");
    }
    close();
  };

  const toggleStatus = (doc: DocItem) => {
    const next = doc.status === "Published" ? "Draft" : "Published";
    const updated = { ...doc, status: next } as DocItem;
    update((d) => ({ ...d, documents: d.documents.map((x) => (x.id === doc.id ? updated : x)) }));
    recordRevision({ entity: "document", entityId: doc.id, title: doc.name, action: next === "Published" ? "Published" : "Unpublished", status: next, snapshot: updated });
    logActivity(next === "Published" ? "Published" : "Unpublished", doc.name, "Documents");
    push(`Document ${next.toLowerCase()}`);
  };

  /* Reorder within a section (Forms or Policies). Order persists to Supabase
     via display_order and drives the public Forms & Policies page. */
  const moveDoc = (doc: DocItem, dir: -1 | 1) => {
    const list = data.documents
      .filter((d) => d.category === doc.category)
      .sort((a, b) => a.displayOrder - b.displayOrder);
    const index = list.findIndex((d) => d.id === doc.id);
    const target = index + dir;
    if (index === -1 || target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    const reordered = list.map((d, i) => ({ ...d, displayOrder: i + 1 }));
    const map = new Map(reordered.map((d) => [d.id, d]));
    update((prev) => ({ ...prev, documents: prev.documents.map((d) => map.get(d.id) ?? d) }));
    logActivity("Reordered", doc.name, "Documents");
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await saveNow((d) => ({ ...d, documents: d.documents.filter((x) => x.id !== pendingDelete.id) }));
      try { await removeCmsObject(pendingDelete.bucketName, pendingDelete.storagePath); }
      catch (error) {
        await saveNow((d) => ({ ...d, documents: [...d.documents, pendingDelete].sort((a, b) => a.displayOrder - b.displayOrder) }));
        throw error;
      }
      logActivity("Deleted", pendingDelete.name, "Documents");
      push("Document removed from Storage and the CMS.", "info");
      setPendingDelete(null);
    } catch (error) { push(error instanceof Error ? error.message : "Could not remove document.", "error"); }
  };

  const uploadDocument = async (file?: File) => {
    if (!file || !draft || !editing) return;
    setUploading(true);
    let stored: Awaited<ReturnType<typeof uploadCmsDocument>> | undefined;
    try {
      stored = await uploadCmsDocument(file, draft.category === "Policies" ? "policies" : "forms", draft.id, draft.id);
      const oldBucket = draft.bucketName;
      const oldPath = draft.storagePath;
      const next = { ...draft, name: draft.name || stored.originalFileName, fileName: stored.originalFileName, url: stored.url, sizeLabel: stored.mimeType || "Document", originalFileName: stored.originalFileName, storageFileName: stored.storageFileName, bucketName: stored.bucketName, storagePath: stored.storagePath, mimeType: stored.mimeType, fileSize: stored.fileSize };
      await saveNow((state) => ({ ...state, documents: state.documents.map((document) => document.id === next.id ? next : document) }));
      try { if (oldPath) await removeCmsObject(oldBucket, oldPath); }
      catch (error) {
        await saveNow((state) => ({ ...state, documents: state.documents.map((document) => document.id === draft.id ? draft : document) }));
        await removeCmsObject(stored.bucketName, stored.storagePath).catch(() => undefined);
        throw error;
      }
      setEditing(next); slot.openEdit(next.id, next); push("File uploaded and document record verified.");
    } catch (error) {
      if (stored) await removeCmsObject(stored.bucketName, stored.storagePath).catch(() => undefined);
      push(error instanceof Error ? error.message : "Upload failed.", "error");
    }
    finally { setUploading(false); if (documentInput.current) documentInput.current.value = ""; }
  };

  return (
    <div>
      <PageHeader
        title="Documents & Policies"
        description="Forms and policy documents published to the Forms & Policies page, in the same two sections shown on the website."
        breadcrumb="Assets"
        actions={
          <Button icon="ri-add-line" onClick={openNew}>
            Add document
          </Button>
        }
      />
      <DraftResume items={slot.pending.map((d) => ({ id: d.id, label: d.id === "new" ? "New document (not saved yet)" : `Document: ${data.documents.find((x) => x.id === d.id)?.name ?? d.id}` }))} onResume={resumeDraft} onDiscard={slot.dropPending} />

      <Card className="mb-5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="sm:w-64">
            <option value="All">All sections</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <p className="text-xs text-foreground-500">
            Order matches the website: <strong className="font-semibold text-foreground-700">Forms</strong>, then{" "}
            <strong className="font-semibold text-foreground-700">Policies</strong>.
          </p>
        </div>
      </Card>

      {grouped.length === 0 ? (
        <Card>
          <EmptyState icon="ri-file-pdf-2-line" title="No documents here" description="Add a document or choose another section." />
        </Card>
      ) : (
        <div className="space-y-6">
          {grouped.map((section) => (
            <Card key={section.name}>
              <div className="flex items-center justify-between gap-4 border-b border-background-200 px-5 py-4">
                <h2 className="font-heading text-base font-bold text-foreground-950">{section.name}</h2>
                <Badge tone="secondary">{section.items.length} documents</Badge>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-background-200 text-xs uppercase tracking-wide text-foreground-500">
                      <th className="px-4 py-3 font-medium">#</th>
                      <th className="px-4 py-3 font-medium">Document</th>
                      <th className="px-4 py-3 font-medium">Link / file</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-background-200">
                    {section.items.map((doc) => (
                      <tr key={doc.id} className="hover:bg-background-50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <span className="w-4 text-center text-xs font-semibold text-foreground-700">
                              {doc.displayOrder}
                            </span>
                            <div className="flex flex-col">
                              <button
                                type="button"
                                onClick={() => moveDoc(doc, -1)}
                                aria-label="Move up"
                                className="flex h-4 w-4 cursor-pointer items-center justify-center text-foreground-400 hover:text-primary-600"
                              >
                                <i className="ri-arrow-up-s-fill text-sm" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => moveDoc(doc, 1)}
                                aria-label="Move down"
                                className="flex h-4 w-4 cursor-pointer items-center justify-center text-foreground-400 hover:text-primary-600"
                              >
                                <i className="ri-arrow-down-s-fill text-sm" aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-start gap-2.5">
                            <i className="ri-file-pdf-2-line mt-0.5 text-lg text-primary-600" aria-hidden="true" />
                            <div>
                              <p className="font-medium text-foreground-900">{doc.name}</p>
                              {doc.description ? <p className="text-xs text-foreground-500">{doc.description}</p> : null}
                            </div>
                          </div>
                        </td>
                        <td className="max-w-[260px] px-4 py-3 text-xs text-foreground-600">
                          {doc.url ? (
                            <a
                              href={doc.url}
                              target="_blank"
                              rel="noreferrer"
                              className="line-clamp-1 text-primary-600 hover:underline"
                            >
                              {doc.fileName || doc.url}
                            </a>
                          ) : (
                            doc.fileName || "—"
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <button type="button" onClick={() => toggleStatus(doc)} className="cursor-pointer">
                            <StatusBadge status={doc.status} />
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => openEdit(doc)}
                              aria-label="Edit"
                              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-500 hover:bg-background-100"
                            >
                              <i className="ri-pencil-line" aria-hidden="true" />
                            </button>
                            <HistoryButton entity="document" entityId={doc.id} title={doc.name} />
                            <button
                              type="button"
                              onClick={() => setPendingDelete(doc)}
                              aria-label="Delete"
                              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-500 hover:bg-background-100"
                            >
                              <i className="ri-delete-bin-line" aria-hidden="true" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={!!draft}
        title={editing ? `Edit: ${editing.name}` : "Add document"}
        onClose={close}
        width="max-w-2xl"
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button icon="ri-check-line" onClick={save}>
              {editing ? "Save changes" : "Add document"}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="space-y-4">
            <DraftStatus draft={slot} />
            <Field label="Document name" required>
              <TextInput value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Section">
                <Select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="File name"><TextInput value={draft.originalFileName || draft.fileName} readOnly placeholder="No file uploaded" /></Field>
            </div>
            <p className="rounded-md border border-background-300 p-3 text-sm">Website uploads are public. Draft or unpublished status hides the listing, but anyone with the file URL can still open it. Upload only approved public material here. Private student and agency documents belong in the private portal workflow.</p>
            <Field label="Document file" hint={editing ? "Each upload receives a unique Storage path; upload again to replace." : "Save the record first, then upload its file."}>
              <div className="flex gap-2"><TextInput value={draft.storagePath || draft.url} readOnly placeholder="No file uploaded" /><input ref={documentInput} className="hidden" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.rtf,.csv" onChange={(event) => void uploadDocument(event.target.files?.[0])} /><Button variant="outline" disabled={!editing || uploading} onClick={() => documentInput.current?.click()}>{uploading ? "Uploading…" : "Upload / replace"}</Button></div>
            </Field>
            <Field label="Description">
              <TextArea rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="File type label">
                <TextInput value={draft.sizeLabel} onChange={(e) => setDraft({ ...draft, sizeLabel: e.target.value })} placeholder="e.g. PDF" />
              </Field>
              <Field label="Display order">
                <TextInput type="number" min={1} value={draft.displayOrder} onChange={(e) => setDraft({ ...draft, displayOrder: Number(e.target.value) })} />
              </Field>
              <div className="flex items-end pb-2">
                <Toggle checked={draft.status === "Published"} onChange={(v) => setDraft({ ...draft, status: v ? "Published" : "Draft" })} label="Published" />
              </div>
            </div>
            <div className="rounded-md border border-background-200 bg-background-100 p-3">
              <Toggle checked={Boolean(draft.assistantPublicationApproved)} onChange={(v) => setDraft({ ...draft, assistantPublicationApproved: v })} label="Approved for public assistant indexing" />
              <p className="mt-1 text-xs text-foreground-500">Only published PDFs stored in the approved CMS media locations can be indexed. This never includes student or agency uploads.</p>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete document"
        message={`Delete "${pendingDelete?.name}"? It will be removed from the Forms & Policies page.`}
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
