import { useEffect, useRef } from "react";

/**
 * Autosave: `save` runs once the value has been changed, is valid and has rested for `delay` ms; a change still waiting when the
 * step closes is saved then. Returns a ref the component compares props against: refresh from the server only when nothing was
 * typed since the value was sent (so a save never wipes what someone is typing).
 */
export function useAutosave<T>(value: T, { enabled, dirty, valid, save, delay = 1200 }: { enabled: boolean; dirty: boolean; valid: boolean; save: (v: T) => unknown; delay?: number }) {
  const sent = useRef<string | null>(null);
  const pending = useRef<T | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!enabled || !dirty || !valid) { pending.current = null; return; }
    pending.current = value;
    const timer = window.setTimeout(() => { pending.current = null; sent.current = JSON.stringify(value); saveRef.current(value); }, delay);
    return () => window.clearTimeout(timer);
  }, [enabled, dirty, valid, value, delay]);
  useEffect(() => () => { if (pending.current !== null) { sent.current = JSON.stringify(pending.current); saveRef.current(pending.current); } }, []);
  return sent;
}
/** Whether props from the server may replace the local value: nothing was sent, or nothing changed since it was sent. */
export const mayRefresh = (sent: { current: string | null }, local: unknown) => sent.current === null || sent.current === JSON.stringify(local);
