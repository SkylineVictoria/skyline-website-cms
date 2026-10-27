import { useState } from "react";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { Button, Card, Field, Modal, PageHeader, TextArea, TextInput } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import type { SeoEntry } from "@/pages/admin/lib/types";
import { HistoryButton } from "@/pages/admin/components/workflow";
import DraftStatus from "@/pages/admin/components/DraftStatus";
import DraftResume from "@/pages/admin/components/DraftResume";
import { useSlotDraft } from "@/pages/admin/lib/useSlotDraft";

const blankSeo = (): SeoEntry => ({ id: crypto.randomUUID(), page: "", path: "/", title: "", description: "", keywords: "" });

export default function SeoPage() {
  const { data, saveNow, logActivity, recordRevision } = useAdminData();
  const { push } = useToast();
  const [editing, setEditing] = useState<SeoEntry | null>(null);
  const slot = useSlotDraft<SeoEntry>("seo", (id) => data.seo.find((e) => e.id === id) ?? null, blankSeo);
  const draft = slot.draft;
  const setDraft = slot.setDraft;

  const openEdit = (e: SeoEntry) => {
    setEditing(e);
    slot.openEdit(e.id, { ...e });
  };
  const close = () => {
    slot.close();
    setEditing(null);
  };
  const resumeDraft = (id: string) => { setEditing(id === "new" ? null : data.seo.find((e) => e.id === id) ?? null); slot.resume(id); };

  const save = async () => {
    if (!draft) return;
    if (!/^\/(?!\/)/.test(draft.path)) { push("Enter a website path beginning with /", "error"); return; }
    try {
    await saveNow((d) => ({ ...d, seo: editing ? d.seo.map((s) => (s.id === draft.id ? draft : s)) : [...d.seo, draft] }));
    recordRevision({ entity: "seo", entityId: draft.id, title: `${draft.page} SEO`, action: "Updated", status: "Draft", snapshot: draft });
    logActivity("Updated", `${draft.page} SEO`, "SEO");
    push("SEO settings saved");
    close();
    } catch (e) { push(e instanceof Error ? e.message : "SEO save failed", "error"); }
  };

  const charGood = (v: number, max: number) => v > 0 && v <= max;

  return (
    <div>
      <PageHeader
        title="SEO / Page Settings"
        description="Search titles, descriptions and keywords for every public page."
        breadcrumb="Governance"
        actions={<Button onClick={() => { setEditing(null); slot.openNew(); }}>Add page SEO</Button>}
      />
      <DraftResume items={slot.pending.map((d) => ({ id: d.id, label: d.id === "new" ? "New SEO entry (not saved yet)" : `SEO: ${data.seo.find((e) => e.id === d.id)?.page ?? d.id}` }))} onResume={resumeDraft} onDiscard={slot.dropPending} />

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="border-b border-background-200 text-xs uppercase tracking-wide text-foreground-500">
                <th className="px-4 py-3 font-medium">Page</th>
                <th className="px-4 py-3 font-medium">Path</th>
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">Description</th>
                <th className="px-4 py-3 text-right font-medium">Edit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-background-200">
              {data.seo.map((s) => (
                <tr key={s.id} className="hover:bg-background-50">
                  <td className="px-4 py-3 font-medium text-foreground-900">{s.page}</td>
                  <td className="px-4 py-3 text-foreground-600">{s.path}</td>
                  <td className="max-w-[220px] px-4 py-3">
                    <span className="line-clamp-1 text-foreground-700">{s.title}</span>
                    <span className={`text-xs ${charGood(s.title.length, 60) ? "text-primary-600" : "text-foreground-400"}`}>
                      {s.title.length} chars
                    </span>
                  </td>
                  <td className="max-w-[260px] px-4 py-3">
                    <span className="line-clamp-1 text-foreground-700">{s.description}</span>
                    <span className={`text-xs ${charGood(s.description.length, 160) ? "text-primary-600" : "text-foreground-400"}`}>
                      {s.description.length}/160
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => openEdit(s)}
                        aria-label="Edit SEO"
                        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-500 hover:bg-background-100"
                      >
                        <i className="ri-pencil-line" aria-hidden="true" />
                      </button>
                      <HistoryButton entity="seo" entityId={s.id} title={`${s.page} SEO`} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal
        open={!!draft}
        title={editing ? `SEO — ${editing.page}` : "SEO"}
        onClose={close}
        width="max-w-2xl"
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button icon="ri-check-line" onClick={save}>
              Save
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="space-y-4">
            <DraftStatus draft={slot} />
            <Field label="Page name">
              <TextInput value={draft.page} onChange={(e) => setDraft({ ...draft, page: e.target.value })} />
            </Field>
            <Field label="URL path">
              <TextInput value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} />
            </Field>
            <Field label="Meta title" hint={`${draft.title.length}/60 characters recommended`}>
              <TextInput value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </Field>
            <Field label="Meta description" hint={`${draft.description.length}/160 characters recommended`}>
              <TextArea rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
            <Field label="Keywords" hint="Comma separated">
              <TextInput value={draft.keywords} onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} />
            </Field>

            <div className="rounded-md border border-background-200 bg-background-100 p-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-foreground-500">Search preview</p>
              <p className="text-[15px] font-medium text-primary-700">{draft.title || "Page title"}</p>
              <p className="text-xs text-foreground-500">slit.edu.au{draft.path}</p>
              <p className="mt-0.5 text-[13px] text-foreground-700">{draft.description || "Meta description preview."}</p>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
