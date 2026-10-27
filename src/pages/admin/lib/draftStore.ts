// Local mirror of unsaved CMS edits (sessionStorage, per tab). Pure functions with an injectable storage so they can be tested.

export interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

const MAX_DRAFT_BYTES = 1_500_000;

export const draftKey = (tenant: string, editor: string, recordId: string) => `cmsDraft:${tenant}:${editor}:${recordId}`;

function browserStorage(): DraftStorage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

export function readDraft<T>(key: string, storage: DraftStorage | null = browserStorage()): { value: T; savedAt: number } | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value?: T; savedAt?: number } | null;
    return parsed && "value" in parsed ? { value: parsed.value as T, savedAt: Number(parsed.savedAt) || 0 } : null;
  } catch {
    return null;
  }
}

export function writeDraft<T>(key: string, value: T, storage: DraftStorage | null = browserStorage()): boolean {
  try {
    const raw = JSON.stringify({ value, savedAt: Date.now() });
    if (!storage || raw.length > MAX_DRAFT_BYTES) return false;
    storage.setItem(key, raw);
    return true;
  } catch {
    return false; // storage full or unavailable: the form still works, it just cannot be restored
  }
}

export function clearDraft(key: string, storage: DraftStorage | null = browserStorage()): void {
  try { storage?.removeItem(key); } catch { /* nothing to clear */ }
}

/** Drafts of one editor that are still stored (for the "resume unsaved draft" list). Newest first. */
export function listDrafts(tenant: string, editor: string, storage: (DraftStorage & { length: number; key(index: number): string | null }) | null = browserList()): { recordId: string; savedAt: number }[] {
  const prefix = `cmsDraft:${tenant}:${editor}:`;
  const found: { recordId: string; savedAt: number }[] = [];
  try {
    for (let i = 0; storage && i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(prefix)) {
        const saved = readDraft(key, storage);
        if (saved) found.push({ recordId: key.slice(prefix.length), savedAt: saved.savedAt });
      }
    }
  } catch { /* storage unavailable: nothing to resume */ }
  return found.sort((a, b) => b.savedAt - a.savedAt);
}

function browserList(): (DraftStorage & { length: number; key(index: number): string | null }) | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}
