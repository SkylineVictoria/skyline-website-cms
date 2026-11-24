import { useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { VIEW_LABELS, clearViewAs, readViewAs, returnToAdmin, switchView, type ViewAsState, type ViewKind } from "@/lib/viewAs";
import SearchableSelect from "@/components/ui/SearchableSelect";

/** Shown on every page while an administrator is looking at a workspace as its test account: says so, and offers the way back. */
export default function ViewAsBanner() {
  const [state, setState] = useState<ViewAsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const check = async () => {
      const v = readViewAs();
      if (!v || !v.testUserId) { if (active) setState(null); return; }
      const { data: { session } } = await supabase.auth.getSession();
      // Signed out, or signed in as anyone but the test account: the kept admin session must not stay around.
      if (!session || session.user.id !== v.testUserId) { clearViewAs(); if (active) setState(null); return; }
      if (active) setState(v);
    };
    void check();
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") { clearViewAs(); setState(null); } else void check();
    });
    const onStorage = () => void check();
    window.addEventListener("storage", onStorage);
    return () => { active = false; sub.subscription.unsubscribe(); window.removeEventListener("storage", onStorage); };
  }, []);

  if (!state) return null;
  const run = (job: () => Promise<void>) => { setBusy(true); setError(""); void job().catch((e) => { setError(e instanceof Error ? e.message : "That did not work. Try again."); setBusy(false); }); };
  return (
    <div role="status" data-testid="view-as-banner" className="fixed inset-x-0 bottom-3 z-[1000] mx-auto flex w-fit max-w-[95vw] flex-wrap items-center gap-2 rounded-full border border-primary-300 bg-foreground-950 px-4 py-2 text-sm text-background-50 shadow-lg">
      <i className="ri-eye-line" aria-hidden="true" />
      <span>{state.personName ? <>Signed in as <b>{state.personName}</b> ({VIEW_LABELS[state.kind].toLowerCase()})</> : <>Viewing as <b>Test {VIEW_LABELS[state.kind]}</b></>}</span>
      <label className="sr-only" htmlFor="view-as-switch">Switch view</label>
      <SearchableSelect id="view-as-switch" disabled={busy} value={state.personName ? "" : state.kind} onChange={(e) => run(() => switchView(e.target.value as ViewKind))}
        className="rounded-md border border-background-50/30 bg-foreground-900 px-2 py-1 text-sm text-background-50">
        {state.personName ? <option value="" disabled>Switch to a test account…</option> : null}
        {(Object.keys(VIEW_LABELS) as ViewKind[]).map((k) => <option key={k} value={k}>Test {VIEW_LABELS[k].toLowerCase()}</option>)}
      </SearchableSelect>
      <button type="button" disabled={busy} onClick={() => run(returnToAdmin)} className="rounded-md bg-primary-500 px-3 py-1 font-semibold text-background-50 hover:bg-primary-600 disabled:opacity-60">
        {busy ? "Switching…" : "Back to admin"}
      </button>
      {error ? <span className="basis-full text-center text-xs text-primary-200">{error}</span> : null}
    </div>
  );
}
