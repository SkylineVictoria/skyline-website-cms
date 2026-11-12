import { useCallback, useEffect, useRef, useState } from "react";

/** One short message at a time (a new one replaces the last), gone after `ms`. Render it with <Toast>. */
export function useToast(ms = 4500) {
  const [message, setMessage] = useState<{ id: number; text: string } | null>(null);
  const timer = useRef<number | null>(null);
  const show = useCallback((text: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    setMessage({ id: Date.now(), text });
    timer.current = window.setTimeout(() => setMessage(null), ms);
  }, [ms]);
  const dismiss = useCallback(() => setMessage(null), []);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  return { message, show, dismiss };
}
