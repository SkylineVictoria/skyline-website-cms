/**
 * Autosave with retry (owner 2026-11-26). A change is saved after a short pause. A save that does not go through never shows
 * "Saved":
 *  - offline (no network): "Offline, will save when reconnected"; saved at once when the browser is back online (and tried
 *    again now and then in case the online signal is missed);
 *  - the sign-in expired: "Session expired, sign in again"; saved again as soon as the person is signed in again;
 *  - anything else (the server refused, a timeout): "Not saved, retrying…"; tried again after 2 s, 4 s, 8 s … up to 30 s.
 * Every value waiting to be saved is kept in the browser (localStorage, per attempt) until the server has it, so nothing typed is
 * lost by going offline, a sign-in that expired, a reload or a closed tab; the page restores it and saves it when it opens again.
 * Changes made while a save runs are saved right after it, in order. `flush` saves now and says whether everything is saved
 * (submit waits for it).
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "idle" | "saving" | "saved" | "retrying" | "offline" | "expired";
export interface SaveStatus { state: SaveState; savedAt: number | null; reason: string; failures: number }
export type SaveFailure = "offline" | "auth" | "error";

export const retryDelay = (failures: number): number => Math.min(30_000, 2_000 * 2 ** Math.max(0, failures - 1));

/** Why a save failed: no network, the sign-in expired (401, an expired token, not allowed while signed out), or anything else. */
export function classifySaveError(e: unknown, online = typeof navigator === "undefined" || navigator.onLine !== false): SaveFailure {
  const err = (e ?? {}) as { message?: string; status?: number; code?: string };
  const msg = String(err.message ?? e ?? "");
  if (err.status === 401 || err.code === "PGRST301" || err.code === "PGRST302" || /jwt|token (is )?expired|not signed in|sign in again|session (has )?expired|refresh token/i.test(msg)) return "auth";
  if (!online || /failed to fetch|networkerror|network request failed|load failed|err_internet_disconnected|fetch failed/i.test(msg)) return "offline";
  return "error";
}

/** Where a value waiting to be saved is kept in the browser (never throws: storage may be off or full). */
export interface DraftStore<T> { save(v: T): void; clear(): void }
export function localDraftStore<T>(key: string): DraftStore<T> & { read(): { v: T; at: number } | null } {
  return {
    save(v) { try { localStorage.setItem(key, JSON.stringify({ v, at: Date.now() })); } catch { /* storage off or full: the value stays in memory */ } },
    clear() { try { localStorage.removeItem(key); } catch { /* ignore */ } },
    read() { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) as { v: T; at: number } : null; } catch { return null; } },
  };
}

/**
 * Unsaved answers kept in the browser belong to the signed-in person and one attempt: asm-draft:<user id>:<attempt id>. Another
 * person on the same browser never reads them (the page reads only its own user's key). They are deleted when the server confirms
 * the save, or when the person chooses to discard them on signing out (the sign-out asks first while any are left).
 */
export const DRAFT_PREFIX = "asm-draft:";
export const draftKey = (userId: string, attemptId: string): string => `${DRAFT_PREFIX}${userId}:${attemptId}`;
/** The keys of this person's answers not yet on the server. */
export function unsavedDraftKeys(userId: string): string[] {
  if (!userId) return [];
  try { return Object.keys(localStorage).filter((k) => k.startsWith(`${DRAFT_PREFIX}${userId}:`)); } catch { return []; }
}
/** Deletes this person's unsaved answers (only when they chose to discard them). */
export function discardDrafts(userId: string): void {
  for (const k of unsavedDraftKeys(userId)) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
}

/** Leftover answers (a sign-in that expired, a closed tab) are kept at most 7 days from their last change, then deleted. */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Deletes every kept copy (any person) older than 7 days, or unreadable; run when the app opens. Returns how many were deleted. */
export function expireDrafts(now = Date.now(), store: Pick<Storage, "getItem" | "removeItem"> & { keys(): string[] } | null = null): number {
  let removed = 0;
  try {
    const st = store ?? { getItem: (k: string) => localStorage.getItem(k), removeItem: (k: string) => localStorage.removeItem(k), keys: () => Object.keys(localStorage) };
    for (const k of st.keys().filter((x) => x.startsWith(DRAFT_PREFIX))) {
      let at = 0;
      try { at = Number((JSON.parse(st.getItem(k) ?? "null") as { at?: number } | null)?.at ?? 0); } catch { at = 0; }
      if (!at || now - at > DRAFT_MAX_AGE_MS) { st.removeItem(k); removed++; }
    }
  } catch { /* storage off */ }
  return removed;
}

export class AutosaveQueue<T> {
  private latest: { v: T } | null = null;
  private chain: Promise<boolean> = Promise.resolve(true);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  status: SaveStatus = { state: "idle", savedAt: null, reason: "", failures: 0 };

  private send: (v: T) => Promise<void>;
  private onStatus: (s: SaveStatus) => void;
  private opts: { debounceMs?: number; retryMs?: (failures: number) => number; classify?: (e: unknown) => SaveFailure; store?: DraftStore<T> | null };

  constructor(send: (v: T) => Promise<void>, onStatus: (s: SaveStatus) => void,
    opts: { debounceMs?: number; retryMs?: (failures: number) => number; classify?: (e: unknown) => SaveFailure; store?: DraftStore<T> | null } = {}) {
    this.send = send; this.onStatus = onStatus; this.opts = opts;
  }

  setSend(send: (v: T) => Promise<void>) { this.send = send; }
  /** A new value to save after the pause (replaces any value not saved yet); kept in the browser until saved. */
  queue(v: T) {
    this.latest = { v }; this.opts.store?.save(v);
    // offline or signed out: no point waiting on a timer, the value waits for the network / the sign-in
    if (this.status.state === "offline" || this.status.state === "expired") this.set({});
    else { if (this.status.state !== "retrying") this.set({ state: "saving" }); this.schedule(this.opts.debounceMs ?? 900); }
  }
  /** Saves what is waiting now; true when nothing is left unsaved. */
  flush(): Promise<boolean> { this.clear(); return this.kick(); }
  /** Back online, signed in again, the tab came back: try a waiting save at once. */
  resume() { if (this.latest && !this.stopped && this.status.state !== "saving") { this.clear(); void this.kick(); } }
  get pending(): boolean { return this.latest !== null; }
  /** (Re)starts after stop (React mounts an effect twice in development). */
  start() { this.stopped = false; if (this.latest) this.schedule(0); }
  /** Stops the timers; a value still waiting is sent once more (leaving the page), and stays in the browser unless it went through. */
  stop() {
    this.stopped = true; this.clear();
    const left = this.latest; this.latest = null;
    if (left) void this.send(left.v).then(() => this.opts.store?.clear(), () => undefined);
  }

  private set(s: Partial<SaveStatus>) { this.status = { ...this.status, ...s }; if (!this.stopped) this.onStatus(this.status); }
  private clear() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private schedule(ms: number) { this.clear(); if (!this.stopped) this.timer = setTimeout(() => { this.timer = null; void this.kick(); }, ms); }
  private kick(): Promise<boolean> { this.chain = this.chain.then(() => this.attempt()); return this.chain; }

  private async attempt(): Promise<boolean> {
    const item = this.latest;
    if (!item || this.stopped) return !item;
    this.set({ state: "saving" });
    try {
      await this.send(item.v);
      if (this.latest === item) { this.latest = null; this.opts.store?.clear(); } // a newer value waits for its own save
      this.set({ state: this.latest ? "saving" : "saved", savedAt: Date.now(), reason: "", failures: 0 });
      if (this.latest) this.schedule(0);
      return this.latest === null;
    } catch (e) {
      const failures = this.status.failures + 1;
      const kind = (this.opts.classify ?? classifySaveError)(e);
      const reason = e instanceof Error ? e.message : String(e);
      if (kind === "auth") { this.set({ state: "expired", reason, failures }); this.clear(); return false; }
      this.set({ state: kind === "offline" ? "offline" : "retrying", reason, failures });
      this.schedule((this.opts.retryMs ?? retryDelay)(failures));
      return false;
    }
  }
}

/**
 * The hook: `queue` a value, `flush` before submitting, `pending` while something is not saved (the page warns before leaving),
 * `status` for the indicator. `resumeOn` subscribes to "signed in again" (the page passes the auth listener).
 */
export function useAutosave<T>(send: (v: T) => Promise<void>, opts: { debounceMs?: number; store?: DraftStore<T> | null; resumeOn?: (resume: () => void) => () => void } = {}) {
  const [status, setStatus] = useState<SaveStatus>({ state: "idle", savedAt: null, reason: "", failures: 0 });
  const ref = useRef<AutosaveQueue<T> | null>(null);
  if (!ref.current) ref.current = new AutosaveQueue<T>(send, setStatus, { debounceMs: opts.debounceMs, store: opts.store });
  ref.current.setSend(send);
  const resumeOn = useRef(opts.resumeOn); resumeOn.current = opts.resumeOn;
  useEffect(() => {
    const q = ref.current!;
    q.start();
    const resume = () => q.resume();
    const visible = () => { if (document.visibilityState === "visible") resume(); };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", visible);
    const off = resumeOn.current?.(resume);
    return () => { window.removeEventListener("online", resume); document.removeEventListener("visibilitychange", visible); off?.(); q.stop(); };
  }, []);
  const queue = useCallback((v: T) => ref.current!.queue(v), []);
  const flush = useCallback(() => ref.current!.flush(), []);
  const current = useCallback(() => ref.current!.status, []);
  // anything typed and not yet on the server (waiting for the pause, being saved, offline, signed out, retrying)
  const pending = status.state !== "saved" && status.state !== "idle";
  return { status, queue, flush, pending, current };
}

/** The words of the save indicator (top bar of the wizard, the marking view). */
export function saveLabel(s: SaveStatus, idle: string, now = Date.now()): string {
  if (s.state === "offline") return "Offline, will save when reconnected";
  if (s.state === "expired") return "Session expired, sign in again";
  if (s.state === "retrying") return "Not saved, retrying…";
  if (s.state === "saving") return "Saving…";
  if (s.state === "saved" && s.savedAt) return now - s.savedAt < 60_000 ? "✓ Saved just now" : `✓ Saved ${new Date(s.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return idle;
}

/** The indicator's colour: green when saved, grey while saving, amber / red when not saved. */
export function saveTone(s: SaveStatus): string {
  if (s.state === "expired" || s.state === "retrying") return "text-red-700";
  if (s.state === "offline") return "text-amber-700";
  if (s.state === "saving" || s.state === "idle") return "text-foreground-500";
  return "text-green-700";
}
