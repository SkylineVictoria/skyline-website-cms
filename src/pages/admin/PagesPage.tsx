import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, Modal, PageHeader, Select, StatusBadge, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import type { AdminPage } from "@/pages/admin/lib/types";
import { HistoryButton } from "@/pages/admin/components/workflow";
import RichTextEditor from "@/pages/admin/components/RichTextEditor";
import TableEditor from "@/pages/admin/components/TableEditor";
import { isReservedCmsPath, normalizeCmsPath } from "@/lib/cmsPath";
import { syncPageNavigation } from "@/lib/pageNav";
import DraftStatus from "@/pages/admin/components/DraftStatus";
import DraftResume from "@/pages/admin/components/DraftResume";
import { useSlotDraft } from "@/pages/admin/lib/useSlotDraft";

/** The Registered Agents page is edited with the dedicated table editor. */
const AGENTS_SLUG = "/agents";

const emptyDraft = (): AdminPage => ({
  id: "",
  name: "",
  slug: "/",
  title: "",
  body: "",
  inNav: false,
  seoTitle: "",
  seoDescription: "",
  status: "Draft",
  updatedAt: "2026-10-12 09:14",
  updatedBy: "IT Administrator",
});

/** Normalises a page URL to a single leading slash with no spaces. */
const normalizeSlug = (value: string): string => {
  return normalizeCmsPath(value.trim().replace(/\s+/g, "-")) ?? "";
};

export default function PagesPage() {
  const { data, update, saveNow, logActivity, recordRevision } = useAdminData();
  const { push } = useToast();

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const [editing, setEditing] = useState<AdminPage | null>(null);
  const slot = useSlotDraft<AdminPage>("page", (id) => data.pages.find((p) => p.id === id) ?? null, emptyDraft);
  const draft = slot.draft;
  const setDraft = slot.setDraft;
  const [pendingDelete, setPendingDelete] = useState<AdminPage | null>(null);
  const [saving, setSaving] = useState(false);
  const [tableDirty, setTableDirty] = useState(false);
  const [closeGuard, setCloseGuard] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.pages.filter((p) => {
      const matchesQ = !q || p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q);
      const matchesS = status === "All" || p.status === status;
      return matchesQ && matchesS;
    });
  }, [data.pages, query, status]);

  const openNew = () => {
    setEditing(null);
    setTableDirty(false);
    slot.openNew();
  };
  const openEdit = (p: AdminPage) => {
    setEditing(p);
    setTableDirty(false);
    slot.openEdit(p.id, { ...p });
  };
  const close = () => {
    setTableDirty(false);
    setCloseGuard(false);
    slot.close();
    setEditing(null);
  };
  // Guard user-initiated closes so unsaved table edits are never silently lost.
  const resumeDraft = (id: string) => { setEditing(id === "new" ? null : data.pages.find((p) => p.id === id) ?? null); slot.resume(id); };
  const requestClose = () => {
    if (tableDirty) {
      setCloseGuard(true);
      return;
    }
    close();
  };

  const save = async (): Promise<boolean> => {
    if (!draft || saving) return false;
    const name = draft.name.trim();
    const slug = normalizeSlug(draft.slug);
    if (!name || !slug) {
      push("A page name and valid local URL path are required", "error");
      return false;
    }
    if (isReservedCmsPath(slug) || slug === "/") {
      push("This URL is reserved for an application route. Choose a different path.", "error");
      return false;
    }
    const clash = data.pages.find(
      (p) => p.id !== draft.id && normalizeSlug(p.slug).toLowerCase() === slug.toLowerCase(),
    );
    if (clash) {
      push(`The URL ${slug} is already used by "${clash.name}". Choose a different path.`, "error");
      return false;
    }
    const normalized: AdminPage = { ...draft, name, slug };
    setSaving(true);
    try {
      if (editing) {
        const next = { ...normalized, updatedAt: "2026-10-12 09:14" };
        await saveNow((d) => ({ ...d, pages: d.pages.map((p) => (p.id === next.id ? next : p)), navigation: syncPageNavigation(d.navigation, next, editing.slug) }));
        recordRevision({ entity: "page", entityId: next.id, title: next.name, action: next.status === "Published" ? "Published" : "Saved draft", status: next.status, snapshot: next });
        logActivity("Updated", next.name, "Pages");
        push("Page updated");
      } else {
        const id = `page-${Date.now()}`;
        const next = { ...normalized, id, updatedAt: "2026-10-12 09:14" };
        await saveNow((d) => ({ ...d, pages: [...d.pages, next], navigation: syncPageNavigation(d.navigation, next) }));
        recordRevision({ entity: "page", entityId: next.id, title: next.name, action: "Created", status: next.status, snapshot: next });
        logActivity("Created", next.name, "Pages");
        push(next.status === "Published" ? `Page created — live at ${next.slug}` : "Page created as a draft (not public yet)");
      }
      close();
      return true;
    } catch (e) {
      // Keep the editor (and the unsaved table) open so nothing is lost.
      const message = e instanceof Error ? e.message : "Could not save the page.";
      push(`Save failed — your changes were kept. ${message}`, "error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    update((d) => ({ ...d, pages: d.pages.filter((p) => p.id !== pendingDelete.id), navigation: syncPageNavigation(d.navigation, { ...pendingDelete, inNav: false }) }));
    logActivity("Deleted", pendingDelete.name, "Pages");
    push("Page deleted", "info");
    setPendingDelete(null);
  };

  return (
    <div>
      <PageHeader
        title="Pages"
        description="Manage the informational pages of the website and their content."
        breadcrumb="Content"
        actions={
          <Button icon="ri-add-line" onClick={openNew}>
            Create Page
          </Button>
        }
      />
      <DraftResume items={slot.pending.map((d) => ({ id: d.id, label: d.id === "new" ? "New page (not created yet)" : `Page: ${data.pages.find((p) => p.id === d.id)?.name ?? d.id}` }))} onResume={resumeDraft} onDiscard={slot.dropPending} />

      <Card className="mb-5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <i className="ri-search-line absolute left-3 top-1/2 -translate-y-1/2 text-foreground-400" aria-hidden="true" />
            <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search pages…" className="pl-9" />
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-40">
            <option value="All">All status</option>
            <option value="Published">Published</option>
            <option value="Draft">Draft</option>
          </Select>
        </div>
      </Card>

      <Card>
        {filtered.length === 0 ? (
          <EmptyState title="No pages found" description="Try a different search or create a new page." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-background-200 text-xs uppercase tracking-wide text-foreground-500">
                  <th className="px-4 py-3 font-medium">Page</th>
                  <th className="px-4 py-3 font-medium">URL</th>
                  <th className="px-4 py-3 font-medium">In menu</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Updated</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-background-200">
                {filtered.map((p) => (
                  <tr key={p.id} className="hover:bg-background-50">
                    <td className="px-4 py-3 font-medium text-foreground-900">{p.name}</td>
                    <td className="px-4 py-3 text-foreground-600">{p.slug}</td>
                    <td className="px-4 py-3">
                      {p.inNav ? <Badge tone="secondary">Yes</Badge> : <span className="text-foreground-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-foreground-500">
                      {p.updatedBy}
                      <br />
                      {p.updatedAt}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {p.status === "Published" ? (
                          <Link
                            to={p.slug}
                            target="_blank"
                            rel="noreferrer"
                            aria-label="View on website"
                            title={`Live at ${p.slug}`}
                            className="flex h-8 w-8 items-center justify-center rounded-md text-foreground-500 hover:bg-background-100"
                          >
                            <i className="ri-external-link-line" aria-hidden="true" />
                          </Link>
                        ) : (
                          <span
                            title="Draft — not visible on the website"
                            className="flex h-8 w-8 items-center justify-center rounded-md text-foreground-300"
                          >
                            <i className="ri-eye-off-line" aria-hidden="true" />
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => openEdit(p)}
                          aria-label="Edit"
                          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-500 hover:bg-background-100"
                        >
                          <i className="ri-pencil-line" aria-hidden="true" />
                        </button>
                        <HistoryButton entity="page" entityId={p.id} title={p.name} />
                        <button
                          type="button"
                          onClick={() => setPendingDelete(p)}
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
        )}
      </Card>

      <Modal
        open={!!draft}
        title={editing ? `Edit: ${editing.name}` : "Create page"}
        onClose={requestClose}
        width="max-w-3xl"
        footer={
          <>
            <Button variant="outline" onClick={requestClose}>
              Cancel
            </Button>
            <Button icon="ri-check-line" onClick={save} disabled={saving}>
              {saving ? "Saving…" : editing ? "Save changes" : "Create page"}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="space-y-4">
            <DraftStatus draft={slot} />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Page name" required>
                <TextInput value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value, title: draft.title || e.target.value })} />
              </Field>
              <Field label="URL path" required hint="e.g. /about-us">
                <TextInput value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} />
              </Field>
            </div>
            <p className="rounded-md border border-background-200 bg-background-100 px-3 py-2 text-xs text-foreground-600">
              {draft.status === "Published" ? (
                <>
                  <i className="ri-external-link-line mr-1 text-primary-600" aria-hidden="true" />
                  Public URL: <strong className="font-semibold text-foreground-900">{normalizeSlug(draft.slug) || "/"}</strong>
                </>
              ) : (
                <>
                  <i className="ri-eye-off-line mr-1 text-foreground-500" aria-hidden="true" />
                  This page is a draft and is <strong className="font-semibold text-foreground-900">not visible</strong> on the website until you publish it.
                </>
              )}
            </p>
            {normalizeSlug(draft.slug) === AGENTS_SLUG ? (
              /*
               * NOTE: this must NOT be wrapped in <Field> (a <label>).
               * A <label> with no `for` binds to the first labelable descendant —
               * which is the editor toolbar's "Undo" button. Clicking any
               * non-interactive area (table borders, toolbar text, gutter) would
               * then forward a synthetic click to Undo and silently revert a
               * freshly added row. A plain group keeps every editor action explicit.
               */
              <div className="block" role="group" aria-label="Registered agents table">
                <span className="mb-1.5 block text-[13px] font-medium text-foreground-800">
                  Registered agents table
                </span>
                <TableEditor
                  value={draft.body}
                  recordKey={draft.id || "new"}
                  onChange={(html) => setDraft((d) => (d ? { ...d, body: html } : d))}
                  onSave={save}
                  saving={saving}
                  onDirtyChange={setTableDirty}
                  title="Registered Agents table"
                  hint="All edits stay in a local draft until you click “Save changes”. Use the ⋮ menu on a row or column header to insert, move, swap, rename or delete."
                />
                <span className="mt-1 block text-xs text-foreground-500">
                  Add, move, swap and delete rows and columns. Saving the page persists the exact table structure —
                  no republish needed.
                </span>
              </div>
            ) : (
              <Field label="Content" hint="Use the toolbar for headings, bold, lists, links, images and font styling.">
                <RichTextEditor value={draft.body} onChange={(html) => setDraft({ ...draft, body: html })} minHeight={200} />
              </Field>
            )}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="SEO title" hint={`${draft.seoTitle.length} characters`}>
                <TextInput value={draft.seoTitle} onChange={(e) => setDraft({ ...draft, seoTitle: e.target.value })} />
              </Field>
              <Field label="SEO description" hint={`${draft.seoDescription.length}/160 characters`}>
                <TextInput value={draft.seoDescription} onChange={(e) => setDraft({ ...draft, seoDescription: e.target.value })} />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-6">
              <Toggle checked={draft.inNav} onChange={(v) => setDraft({ ...draft, inNav: v })} label="Show in main menu" />
              <p className="mt-1 text-xs text-foreground-500">Adds the page to the header menu when it is published (the menu holds at most 7 top-level items). Arrange it under Header &amp; Navigation.</p>
              <Field label="Status">
                <Select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as AdminPage["status"] })}>
                  <option value="Published">Published</option>
                  <option value="Draft">Draft</option>
                </Select>
              </Field>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={closeGuard}
        title="Unsaved table changes"
        onClose={() => setCloseGuard(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setCloseGuard(false)}>
              Continue editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setCloseGuard(false);
                setTableDirty(false);
                close();
              }}
            >
              Discard &amp; close
            </Button>
            <Button
              icon="ri-save-3-line"
              onClick={async () => {
                setCloseGuard(false);
                await save();
              }}
            >
              Save &amp; close
            </Button>
          </>
        }
      >
        <p className="text-sm text-foreground-700">
          This page has unsaved table changes. Save them, discard them, or keep editing.
        </p>
      </Modal>

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete page"
        message={`Delete "${pendingDelete?.name}"? This cannot be undone.`}
        confirmLabel="Delete page"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
