import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tenantBrandKey } from "@/lib/brandCache";
import { clearDraft, draftKey, readDraft, writeDraft } from "@/pages/admin/lib/draftStore";
import { useDraftRegistry } from "@/pages/admin/lib/draftContext";

export interface DraftApi<T> {
  value: T;
  setValue: (next: T | ((previous: T) => T)) => void;
  /** The form differs from what the database last returned. */
  dirty: boolean;
  /** The form was filled from a locally saved draft when it opened. */
  restored: boolean;
  /** Throw the draft away and show the saved version again. */
  discard: () => void;
  /** Call after the database accepted the save; pass the saved value when it differs from the form (for example a normalised copy). */
  markSaved: (saved?: T) => void;
}

/**
 * One draft per editor and record. The form value lives here instead of in the page's own state so that:
 *  - edits are mirrored to sessionStorage (small debounce) and restored when the editor is opened again;
 *  - a refetch or store update NEVER overwrites a dirty form (it only replaces a clean one);
 *  - the admin layout can warn before leaving while any editor is dirty.
 * `server` is the saved value from the CMS store; `recordId` distinguishes records of one editor (e.g. a course slug).
 */
export function useDraft<T>(editor: string, recordId: string, server: T, options: { enabled?: boolean } = {}): DraftApi<T> {
  const enabled = options.enabled ?? true;
  const registry = useDraftRegistry();
  const key = draftKey(tenantBrandKey(), editor, recordId);
  const serverJson = useMemo(() => JSON.stringify(server), [server]);

  const start = (): { value: T; restored: boolean } => {
    const saved = enabled ? readDraft<T>(key) : null;
    return saved && JSON.stringify(saved.value) !== serverJson ? { value: saved.value, restored: true } : { value: server, restored: false };
  };
  const [state, setState] = useState(start);
  const [value, setValueState] = useState<T>(state.value);
  const [restored, setRestored] = useState(state.restored);
  const [base, setBase] = useState(serverJson);
  const currentKey = useRef(key);

  // Opening a different record in the same mounted editor (route param change) starts from that record's draft or saved value.
  useEffect(() => {
    if (currentKey.current === key) return;
    currentKey.current = key;
    const next = start();
    setValueState(next.value); setRestored(next.restored); setBase(serverJson);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a record change re-initialises
  }, [key]);

  const dirty = useMemo(() => enabled && JSON.stringify(value) !== base, [enabled, value, base]);

  // A newer saved version replaces the form only while it is clean.
  useEffect(() => {
    if (serverJson === base || dirty) return;
    setValueState(server);
    setBase(serverJson);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to saved-data changes only
  }, [serverJson]);

  const latest = useRef({ key, value, dirty, enabled });
  latest.current = { key, value, dirty, enabled };

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setTimeout(() => { if (dirty) writeDraft(key, value); else clearDraft(key); }, 350);
    return () => window.clearTimeout(timer);
  }, [enabled, dirty, value, key]);

  useEffect(() => { registry?.setDirty(key, enabled && dirty); }, [registry, key, dirty, enabled]);
  useEffect(() => () => {
    // Leaving the editor: keep the draft (flush the debounce) and stop counting it as an open, dirty form.
    if (latest.current.enabled && latest.current.dirty) writeDraft(latest.current.key, latest.current.value);
    registry?.clear(latest.current.key);
  }, [registry]);

  const setValue = useCallback((next: T | ((previous: T) => T)) => setValueState((previous) => (typeof next === "function" ? (next as (p: T) => T)(previous) : next)), []);
  const markSaved = useCallback((saved?: T) => {
    clearDraft(latest.current.key);
    if (saved !== undefined) setValueState(saved);
    setBase(JSON.stringify(saved !== undefined ? saved : latest.current.value));
    setRestored(false);
  }, []);
  const discard = useCallback(() => { clearDraft(latest.current.key); setValueState(server); setBase(serverJson); setRestored(false); }, [server, serverJson]);

  return { value, setValue, dirty, restored, discard, markSaved };
}
