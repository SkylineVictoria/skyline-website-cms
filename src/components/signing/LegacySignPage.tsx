import { useCallback, useEffect, useState } from "react";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";
import { signingAction, type LegacySigningView as SigningView } from "@/lib/signingApi";

function readToken() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("t");
  if (token) { sessionStorage.setItem("slit-signing-token", token); history.replaceState(null, "", window.location.pathname); }
  return token ?? sessionStorage.getItem("slit-signing-token") ?? "";
}
/** The released first-stage signing page, shown when the hosted function answers in that version's shape. */
export default function LegacySignPage() {
  const [token] = useState(readToken);
  const [view, setView] = useState<SigningView | null>(null);
  const [name, setName] = useState(""); const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [declined, setDeclined] = useState(false);
  const load = useCallback(async () => {
    setError("");
    try { setView(await signingAction<SigningView>({ action: "open", token })); }
    catch (e) { setError(e instanceof Error ? e.message : "The document could not be opened."); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  const act = async (action: "sign" | "decline") => {
    if (!view || busy) return;
    if (action === "decline" && !window.confirm("Decline this signing request? This will close the link.")) return;
    setBusy(true); setError("");
    try {
      await signingAction({ action, token, name, agreed, documentHash: view.documentHash });
      if (action === "decline") { setDeclined(true); sessionStorage.removeItem("slit-signing-token"); }
      else await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); }
  };
  return <main className="min-h-screen bg-background-100 px-4 py-10"><div className="mx-auto max-w-4xl space-y-5 rounded-xl bg-white p-5 md:p-8">
    <p className="text-sm font-semibold text-foreground-600">Skyline Institute of Technology · Document signing</p>
    <h1 className="text-2xl font-bold">{view?.title ?? "Your document"}</h1>
    {error && <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p>}
    {declined ? <p role="status">You declined this request. Please contact the sender if you need a new document.</p> : view ? <>
      <p>{view.state === "signed" ? `Signed on ${new Date(view.signedAt!).toLocaleString()}. Download your copy below.` : `Hello ${view.recipientName}. Read the complete document before signing.`}</p>
      <a className="inline-block font-semibold text-primary-700 underline" href={view.url} target="_blank" rel="noreferrer">{view.state === "signed" ? "Open / download signed PDF" : "Open document PDF"}</a>
      <iframe className="h-[65vh] w-full border" src={view.url} title="Document to sign" referrerPolicy="no-referrer" />
      <Button variant="outline" disabled={busy} onClick={() => void load()}>Refresh document link</Button>
      {view.state !== "signed" && <form className="space-y-4 border-t pt-5" onSubmit={(e) => { e.preventDefault(); void act("sign"); }}>
        <Field label="Your full name" required><TextInput value={name} onChange={(e) => setName(e.target.value)} required maxLength={150} autoComplete="name" /></Field>
        <label className="flex items-start gap-3"><input type="checkbox" required checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1" /><span>{view.consent}</span></label>
        <div className="flex flex-wrap gap-3"><Button type="submit" disabled={busy || !agreed || !name.trim()}>{busy ? "Please wait…" : "Sign document"}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void act("decline")}>Decline</Button></div>
      </form>}
    </> : !error && <p role="status">Opening your document…</p>}
  </div></main>;
}
