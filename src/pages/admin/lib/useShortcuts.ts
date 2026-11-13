import { useEffect, useRef } from "react";
import { typingIn } from "@/pages/admin/lib/rto";

/** Dialogs on screen: a drawer, a sheet or a confirm box (shortcuts stay quiet while one is open). */
const MODALS = '[role="dialog"], .z-\\[80\\]';

/** Single-key shortcuts (N, /) while nobody is typing and no dialog is open. */
export function useShortcuts(map: Record<string, () => void>, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const key = (e: KeyboardEvent) => {
      if (typingIn(e) || document.querySelector(MODALS)) return;
      const run = ref.current[e.key.toLowerCase()];
      if (run) { e.preventDefault(); run(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [enabled]);
}
