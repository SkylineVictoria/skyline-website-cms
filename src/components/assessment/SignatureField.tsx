/**
 * ASM-AI-IMPORT: one signature control for the assessment screens (student declaration, assessor sign-off, student acknowledgement).
 * The person's saved signature is applied with one click; otherwise they draw it (the signing page's pad) or upload a picture, and
 * may keep it as their saved signature. The PNG is the signing page's format (600 x 200, base64 without the data: prefix).
 */
import { useEffect, useState } from "react";
import SignaturePad from "@/components/signing/SignaturePad";
import { pictureToPng } from "@/components/signing/signatureImage";
import { mySignature, type SignatureValue } from "@/lib/assessment/api";
export type { SignatureValue };

export function SignatureImage({ png, name, className = "" }: { png: string | null; name?: string; className?: string }) {
  if (!png) return <p className={`font-[cursive] text-2xl text-[#0d1a4d] ${className}`}>{name}</p>;
  return <img src={`data:image/png;base64,${png}`} alt={name ? `Signature of ${name}` : "Signature"} className={`h-14 w-auto max-w-full object-contain ${className}`} />;
}

export default function SignatureField({ value, onChange, label = "Your signature", allowSave = true }: {
  value: SignatureValue | null;
  onChange: (v: SignatureValue | null) => void;
  label?: string;
  allowSave?: boolean;
}) {
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [mode, setMode] = useState<"saved" | "draw">("draw");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void mySignature().then((s) => { if (!live) return; setSaved(s.signaturePng); if (s.signaturePng) { setMode("saved"); onChange({ method: "saved", png: s.signaturePng }); } });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const keep = Boolean(value?.keep);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    try { const png = await pictureToPng(file); onChange({ method: "uploaded", png, keep }); }
    catch (e) { setError(e instanceof Error ? e.message : "That picture could not be used."); }
  };

  return (
    <div className="space-y-2" data-testid="signature-field">
      <p className="text-xs font-semibold text-foreground-600">{label}</p>
      {mode === "saved" && saved ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-background-300 bg-white px-4 py-3">
          <div><p className="text-2xs text-foreground-500">Your saved signature</p><SignatureImage png={saved} /></div>
          <button type="button" className="cursor-pointer text-xs font-semibold text-primary-700 hover:underline" onClick={() => { setMode("draw"); onChange(null); }}>Sign differently</button>
        </div>
      ) : (
        <div className="space-y-2">
          <SignaturePad onChange={(png) => onChange(png ? { method: "drawn", png, keep } : null)} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <label className="cursor-pointer font-semibold text-primary-700 hover:underline">Upload a picture instead
              <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            {allowSave ? <label className="inline-flex cursor-pointer items-center gap-1.5 text-foreground-600"><input type="checkbox" checked={keep} onChange={(e) => onChange(value ? { ...value, keep: e.target.checked } : null)} disabled={!value} />Save as my signature</label> : null}
            {saved ? <button type="button" className="cursor-pointer font-semibold text-primary-700 hover:underline" onClick={() => { setMode("saved"); onChange({ method: "saved", png: saved }); }}>Use my saved signature</button> : null}
          </div>
          {value?.method === "uploaded" && value.png ? <SignatureImage png={value.png} className="rounded border border-background-200 bg-white p-1" /> : null}
        </div>
      )}
      {error ? <p role="alert" className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
