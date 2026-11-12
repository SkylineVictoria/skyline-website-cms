import { useCallback, useEffect, useRef, useState } from "react";

/** A button in the toast (Undo), for as long as the toast shows. */
export interface ToastAction { label: string; onClick: () => void }
export interface ToastMessage { id: number; text: string; action?: ToastAction }

/** One short message at a time (a new one replaces the last), gone after `ms`. Render it with <Toast>. */
export function useToast(ms = 4500) {
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const timer = useRef<number | null>(null);
  const show = useCallback((text: string, action?: ToastAction, duration = ms) => {
    if (timer.current) window.clearTimeout(timer.current);
    setMessage({ id: Date.now(), text, action });
    timer.current = window.setTimeout(() => setMessage(null), duration);
  }, [ms]);
  const dismiss = useCallback(() => setMessage(null), []);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  return { message, show, dismiss };
}
