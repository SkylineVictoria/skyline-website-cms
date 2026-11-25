/**
 * ASM-AI-IMPORT stage 4: "My signature": drawn or uploaded once, applied with one click when signing off results (asm_saved_signatures).
 */
import { useEffect, useState } from "react";
import SignaturePad from "@/components/signing/SignaturePad";
import { pictureToPng } from "@/components/signing/signatureImage";
import { SignatureImage } from "./SignatureField";
import { fmtDate, mySignature, saveMySignature, type SavedSignature } from "@/lib/assessment/api";

export default function SavedSignatureCard() {
  const [saved, setSaved] = useState<SavedSignature | null>(null);
  const [editing, setEditing] = useState(false);
  const [png, setPng] = useState<{ png: string; method: "drawn" | "uploaded" } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void mySignature().then(setSaved); }, []);
  const save = async (value: { png: string; method: "drawn" | "uploaded" } | null) => {
    setBusy(true); setError("");
    try { setSaved(await saveMySignature(value?.png ?? null, value?.method ?? "drawn")); setEditing(false); setPng(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Not saved."); } finally { setBusy(false); }
  };
  return (
    <section className="rounded-2xl border border-background-200 bg-white p-4" data-testid="saved-signature">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="font-heading text-sm font-semibold text-foreground-950">My signature</p><p className="text-xs text-foreground-600">Used with one click when you sign off results.{saved?.updatedAt ? ` Saved ${fmtDate(saved.updatedAt)}.` : ""}</p></div>
        {saved?.signaturePng && !editing ? <SignatureImage png={saved.signaturePng} name={saved.name ?? undefined} /> : null}
        {!editing ? <button type="button" className="cursor-pointer rounded-lg border border-background-300 px-3 py-1.5 text-sm font-semibold text-foreground-800 hover:border-primary-300" onClick={() => setEditing(true)}>{saved?.signaturePng ? "Change" : "Add my signature"}</button> : null}
      </div>
      {editing ? (
        <div className="mt-3 space-y-2">
          <SignaturePad onChange={(p) => setPng(p ? { png: p, method: "drawn" } : null)} />
          <label className="inline-block cursor-pointer text-xs font-semibold text-primary-700 hover:underline">Upload a picture instead
            <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; try { setPng({ png: await pictureToPng(f), method: "uploaded" }); } catch (err) { setError(err instanceof Error ? err.message : "That picture could not be used."); } }} />
          </label>
          {png?.method === "uploaded" ? <SignatureImage png={png.png} className="rounded border border-background-200 p-1" /> : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="cursor-pointer rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={!png || busy} onClick={() => void save(png)}>Save</button>
            <button type="button" className="cursor-pointer rounded-lg border border-background-300 px-4 py-2 text-sm font-semibold" onClick={() => { setEditing(false); setPng(null); }}>Cancel</button>
            {saved?.signaturePng ? <button type="button" className="cursor-pointer px-2 text-sm font-semibold text-red-700" disabled={busy} onClick={() => void save(null)}>Remove</button> : null}
          </div>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-xs text-red-700">{error}</p> : null}
    </section>
  );
}
