import { useCallback, useState } from "react";
import { tenantBrandKey } from "@/lib/brandCache";
import { clearDraft, draftKey, listDrafts } from "@/pages/admin/lib/draftStore";
import { useDraft, type DraftApi } from "@/pages/admin/lib/useDraft";

export interface SlotDraft<T> extends Pick<DraftApi<unknown>, "dirty" | "restored" | "discard"> {
  /** The record being edited in the open dialog, or null when it is closed. */
  draft: T | null;
  setDraft: (next: T | ((previous: T) => T)) => void;
  /** Id of the stored record being edited ("new" for a record that does not exist yet); null when closed. */
  openId: string | null;
  openNew: () => void;
  openEdit: (id: string, record: T) => void;
  /** Cancel: throws the draft away and closes. After a successful save the pages call this too (the saved record replaces the draft). */
  close: () => void;
  /** Drafts of this editor left from an earlier visit (not the open one). */
  pending: { id: string; savedAt: number }[];
  resume: (id: string) => void;
  dropPending: (id: string) => void;
}

/**
 * Draft support for list-plus-dialog editors (pages, SEO entries, documents, users, FAQs, extraction corrections).
 * The dialog's form lives in a useDraft keyed by editor + record id, so it is mirrored to sessionStorage, restored on the next visit
 * (offered as "resume") and never replaced by a refetch: the baseline is the record as it was when the dialog opened.
 */
export function useSlotDraft<T>(editor: string, find: (id: string) => T | null, blank: () => T): SlotDraft<T> {
  const tenant = tenantBrandKey();
  const [target, setTarget] = useState<{ id: string; server: T } | null>(null);
  const api = useDraft<T | null>(editor, target?.id ?? "__none__", target?.server ?? null, { enabled: target !== null });
  const [pending, setPending] = useState(() => listDrafts(tenant, editor).map((d) => ({ id: d.recordId, savedAt: d.savedAt })));
  const refresh = useCallback((openId: string | null) => setPending(listDrafts(tenant, editor).filter((d) => d.recordId !== openId && d.recordId !== "__none__").map((d) => ({ id: d.recordId, savedAt: d.savedAt }))), [tenant, editor]);

  const open = (id: string, server: T) => {
    if (target && target.id !== id) clearDraft(draftKey(tenant, editor, target.id)); // the previous dialog was replaced (e.g. after an upload created the record)
    setTarget({ id, server });
    refresh(id);
  };
  const close = () => { api.discard(); setTarget(null); refresh(null); };
  const dropPending = (id: string) => { clearDraft(draftKey(tenant, editor, id)); refresh(target?.id ?? null); };
  const resume = (id: string) => {
    const server = id === "new" ? blank() : find(id);
    if (server === null) { dropPending(id); return; }
    open(id, server);
  };

  return {
    draft: api.value,
    setDraft: (next) => api.setValue((previous) => (typeof next === "function" ? (next as (p: T) => T)(previous as T) : next)),
    openId: target?.id ?? null,
    openNew: () => open("new", blank()),
    openEdit: (id, record) => open(id, record),
    close,
    dirty: api.dirty,
    restored: api.restored,
    discard: api.discard,
    pending: pending.filter((p) => p.id !== target?.id),
    resume,
    dropPending,
  };
}
