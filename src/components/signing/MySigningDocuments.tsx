import { useEffect, useState } from "react";
import { signingMine, signingStatus, type MySigningDocument } from "@/lib/signingApi";

/**
 * For a signed-in student, staff member or agent: the documents sent to their own email address for signature. Opening one makes a fresh
 * personal link and uses the same signing page as the emailed link. Shows nothing when there is nothing to sign and nothing signed.
 */
export default function MySigningDocuments({ className = "" }: { className?: string }) {
  const [documents, setDocuments] = useState<MySigningDocument[]>([]);
  const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  useEffect(() => { void signingMine<MySigningDocument[]>("list").then(setDocuments).catch(() => setDocuments([])); }, []);
  if (!documents.length) return null;
  const open = async (document: MySigningDocument) => {
    setBusy(document.recipient_id); setError("");
    try { const { token } = await signingMine<{ token: string }>("token", document.recipient_id); window.location.assign(`/sign#t=${token}`); }
    catch (e) { setError(e instanceof Error ? e.message : "The document could not be opened."); setBusy(""); }
  };
  return <section className={`rounded-xl border border-background-300 bg-white p-5 ${className}`} data-testid="my-signing-documents">
    <h2 className="text-base font-semibold">Documents to sign</h2>
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    <ul className="mt-2 divide-y divide-background-200 text-sm">{documents.map((d) => { const waiting = d.my_state !== "signed" && d.status !== "signed";
      return <li key={d.recipient_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <span><span className="font-medium">{d.title}</span><span className="block text-xs text-foreground-500">{d.reference} · {d.status === "signed" ? "Completed" : d.my_state === "signed" ? "You signed; waiting for others" : `Waiting for your signature${d.expires_at ? ` until ${new Date(d.expires_at).toLocaleDateString()}` : ""}`}</span></span>
        <button type="button" disabled={busy === d.recipient_id} onClick={() => void open(d)} className={`rounded-md px-3 py-1.5 text-sm font-medium ${waiting ? "bg-primary-500 text-background-50" : "border border-background-300"}`}>
          {busy === d.recipient_id ? "Opening…" : waiting ? "Review and sign" : d.status === "signed" ? "Open signed copy" : signingStatus(d.status).label}</button></li>; })}</ul>
  </section>;
}
