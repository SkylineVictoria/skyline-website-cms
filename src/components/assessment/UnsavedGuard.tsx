/**
 * Warns before leaving while answers are not saved yet (owner 2026-11-26): a link, Back / Forward or navigate() inside the app
 * opens this dialog (Stay on this page / Leave anyway); closing or reloading the tab asks the browser's own question. The answers
 * stay in the browser either way (autosave keeps them until the server has them).
 */
import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";

export default function UnsavedGuard({ when, message }: { when: boolean; message: string }) {
  const on = useRef(when); on.current = when;
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (!on.current) return; event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  // another page only: moving between the steps of the same assessment (?step=) keeps the page and its saving
  const blocker = useBlocker(({ currentLocation, nextLocation }) => on.current && currentLocation.pathname !== nextLocation.pathname);
  // saved in the meantime: let the navigation go on
  useEffect(() => { if (blocker.state === "blocked" && !when) blocker.proceed(); }, [blocker, when]);
  if (blocker.state !== "blocked") return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="unsaved-title" data-testid="unsaved-dialog">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h2 id="unsaved-title" className="text-base font-semibold text-foreground-900">Your latest answers are not saved yet</h2>
        <p className="mt-2 text-sm text-foreground-700">{message}</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" className="min-h-[44px] rounded-lg border border-background-300 px-4 text-sm font-semibold" onClick={() => blocker.proceed?.()} data-testid="unsaved-leave">Leave anyway</button>
          <button type="button" className="min-h-[44px] rounded-lg bg-primary-600 px-4 text-sm font-semibold text-white" onClick={() => blocker.reset?.()} data-testid="unsaved-stay" autoFocus>Stay on this page</button>
        </div>
      </div>
    </div>
  );
}
