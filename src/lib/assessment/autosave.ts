/**
 * Autosave with retry (owner 2026-11-26): a change is saved after a short pause; a save that fails (no network, the server
 * refused, a timeout) shows "Not saved, retrying" — never the last "Saved" — and is tried again (2 s, 4 s, 8 s … up to 30 s,
 * at once when the browser is back online) with the newest value until it goes through. Changes made while a save runs are
 * saved right after it, in order. `flush` saves now and says whether everything is saved (submit waits for it).
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "idle" | "saving" | "saved" | "retrying";
export interface SaveStatus { state: SaveState; savedAt: number | null; reason: string; failures: number }

export const retryDelay = (failures: number): number => Math.min(30_000, 2_000 * 2 ** Math.max(0, failures - 1));

export class AutosaveQueue<T> {
  private latest: { v: T } | null = null;
  private chain: Promise<boolean> = Promise.resolve(true);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  status: SaveStatus = { state: "idle", savedAt: null, reason: "", failures: 0 };

  constructor(
    private send: (v: T) => Promise<void>,
    private onStatus: (s: SaveStatus) => void,
    private opts: { debounceMs?: number; retryMs?: (failures: number) => number } = {},
  ) {}

  setSend(send: (v: T) => Promise<void>) { this.send = send; }
  /** A new value to save after the pause (replaces any value not saved yet). */
  queue(v: T) { this.latest = { v }; this.schedule(this.opts.debounceMs ?? 900); }
  /** Saves what is waiting now; true when nothing is left unsaved. */
  flush(): Promise<boolean> { this.clear(); return this.kick(); }
  get pending(): boolean { return this.latest !== null; }
  /** (Re)starts after stop (React mounts an effect twice in development). */
  start() { this.stopped = false; if (this.latest) this.schedule(0); }
  /** Stops the timers; a value still waiting is sent once more (leaving the page), without status. */
  stop() {
    this.stopped = true; this.clear();
    const left = this.latest; this.latest = null;
    if (left) void this.send(left.v).catch(() => undefined);
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
      if (this.latest === item) this.latest = null; // a newer value waits for its own save
      this.set({ state: this.latest ? "saving" : "saved", savedAt: Date.now(), reason: "", failures: 0 });
      return this.latest === null;
    } catch (e) {
      const failures = this.status.failures + 1;
      this.set({ state: "retrying", reason: e instanceof Error ? e.message : String(e), failures });
      this.schedule((this.opts.retryMs ?? retryDelay)(failures));
      return false;
    }
  }

  /** The browser is back online: try a waiting save at once. */
  online() { if (this.latest && this.status.state === "retrying") { this.clear(); void this.kick(); } }
}

export function useAutosave<T>(send: (v: T) => Promise<void>, debounceMs = 900) {
  const [status, setStatus] = useState<SaveStatus>({ state: "idle", savedAt: null, reason: "", failures: 0 });
  const ref = useRef<AutosaveQueue<T> | null>(null);
  if (!ref.current) ref.current = new AutosaveQueue<T>(send, setStatus, { debounceMs });
  ref.current.setSend(send);
  useEffect(() => {
    const q = ref.current!;
    q.start();
    const on = () => q.online();
    window.addEventListener("online", on);
    return () => { window.removeEventListener("online", on); q.stop(); };
  }, []);
  const queue = useCallback((v: T) => ref.current!.queue(v), []);
  const flush = useCallback(() => ref.current!.flush(), []);
  return { status, queue, flush };
}

/** The words of the save indicator (top bar of the wizard, the marking view). */
export function saveLabel(s: SaveStatus, idle: string, now = Date.now()): string {
  if (s.state === "retrying") return "Not saved, retrying…";
  if (s.state === "saving") return "Saving…";
  if (s.state === "saved" && s.savedAt) return now - s.savedAt < 60_000 ? "✓ Saved just now" : `✓ Saved ${new Date(s.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return idle;
}
