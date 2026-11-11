import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Field, TextArea, TextInput } from "@/pages/admin/components/ui";
import PdfPages from "@/components/signing/PdfPages";
import { RECIPIENT_STATE, signingAction, type SigningView } from "@/lib/signingApi";
import { initialsOf } from "../../supabase/functions/_shared/signing";

function readToken() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("t");
  if (token) { sessionStorage.setItem("slit-signing-token", token); history.replaceState(null, "", window.location.pathname); }
  return token ?? sessionStorage.getItem("slit-signing-token") ?? "";
}
type Method = "typed" | "drawn" | "uploaded";
const SIGNATURE_W = 600, SIGNATURE_H = 200;
/** Any picture, scaled into a 600 x 200 PNG (base64 without the data: prefix): the one format the server accepts. */
async function pictureToPng(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) throw new Error("Choose a PNG or JPEG picture of your signature, 5 MB or smaller.");
  const image = await createImageBitmap(file);
  const scale = Math.min(SIGNATURE_W / image.width, SIGNATURE_H / image.height, 1);
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png").split(",")[1];
}

/** A pad to draw a signature with a finger, a pen or the mouse. Reports the PNG after every stroke, or null when it is empty. */
function SignaturePad({ onChange }: { onChange: (png: string | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - box.left) * SIGNATURE_W / box.width, y: (event.clientY - box.top) * SIGNATURE_H / box.height };
  };
  const context = () => { const c = canvas.current!.getContext("2d")!; c.lineWidth = 3; c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = "#0d1a4d"; return c; };
  return <div>
    <canvas ref={canvas} width={SIGNATURE_W} height={SIGNATURE_H} data-testid="signature-pad" aria-label="Draw your signature here" className="w-full max-w-xl touch-none rounded-md border-2 border-dashed border-background-400 bg-white" style={{ aspectRatio: "3 / 1" }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true; const p = point(e); const c = context(); c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x + 0.1, p.y + 0.1); c.stroke(); }}
      onPointerMove={(e) => { if (!drawing.current) return; const p = point(e); const c = context(); c.lineTo(p.x, p.y); c.stroke(); }}
      onPointerUp={() => { if (!drawing.current) return; drawing.current = false; onChange(canvas.current!.toDataURL("image/png").split(",")[1]); }}
      onPointerCancel={() => { drawing.current = false; }} />
    <button type="button" className="mt-2 text-sm font-medium text-primary-700 underline" onClick={() => { const c = canvas.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); onChange(null); }}>Clear and draw again</button>
  </div>;
}

export default function SigningPage() {
  const [token] = useState(readToken);
  const [view, setView] = useState<SigningView | null>(null);
  const [name, setName] = useState(""); const [agreed, setAgreed] = useState(false);
  const [method, setMethod] = useState<Method>("typed"); const [picture, setPicture] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false); const [declining, setDeclining] = useState(false); const [reason, setReason] = useState("");
  const [justSigned, setJustSigned] = useState(false);
  const signPanel = useRef<HTMLFormElement>(null);
  const load = useCallback(async () => {
    setError("");
    try {
      const next = await signingAction<SigningView>({ action: "open", token });
      setView(next); setName((current) => current || next.recipient.name);
    } catch (e) { setError(e instanceof Error ? e.message : "The document could not be opened."); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const mine = view?.recipient.state === "signed";
  const complete = view?.state === "signed";
  const canSign = !!view && !mine && !complete;
  const missing = canSign ? view.fields.filter((f) => f.required && ((f.type === "text" && !(values[f.id] ?? "").trim()) || (f.type === "checkbox" && values[f.id] !== "true"))) : [];
  const signatureReady = method === "typed" ? name.trim().length >= 2 : !!picture;
  const ready = canSign && agreed && name.trim().length >= 2 && signatureReady && !missing.length;
  const goTo = (id: string) => document.querySelector(`[data-field="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });

  const sign = async () => {
    if (!view || busy || !ready) return;
    setBusy(true); setError("");
    try {
      await signingAction({ action: "sign", token, name, agreed, signatureKind: method, signatureImage: method === "typed" ? null : picture, values, documentHash: view.documentHash });
      setJustSigned(true); await load(); window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); }
  };
  const decline = async () => {
    if (!view || busy) return;
    setBusy(true); setError("");
    try { await signingAction({ action: "decline", token, reason }); setDeclined(true); setDeclining(false); sessionStorage.removeItem("slit-signing-token"); }
    catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); }
  };

  return <main className="min-h-screen bg-background-100 px-3 pb-28 pt-6 sm:px-4 sm:py-10">
    <div className="mx-auto max-w-4xl space-y-5 rounded-xl bg-white p-4 sm:p-6 md:p-8">
      <p className="text-sm font-semibold text-foreground-600">Skyline Institute of Technology · Document signing</p>
      <h1 className="break-words text-xl font-bold sm:text-2xl">{view?.title ?? "Your document"}</h1>
      {view && <p className="text-xs text-foreground-500">Reference {view.reference}</p>}
      {error && <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p>}
      {declined ? <p role="status" className="rounded border border-background-300 p-4">You declined this request. The sender has been told. Please contact them if you need a new document.</p> : view ? <>
        {complete ? <div role="status" className="space-y-3 rounded-md border border-green-300 bg-green-50 p-4">
          <p className="font-semibold">This document is complete: everyone required has signed.</p>
          <div className="flex flex-wrap gap-3">
            <a className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-4 py-2 text-sm font-medium text-background-50" href={view.url} download data-testid="download-signed"><i className="ri-download-line" aria-hidden="true" />Download the signed document</a>
            {view.certificateUrl && <a className="inline-flex items-center gap-2 rounded-md border border-background-300 px-4 py-2 text-sm font-medium" href={view.certificateUrl} download><i className="ri-shield-check-line" aria-hidden="true" />Download the completion certificate</a>}
          </div>
          <p className="text-sm text-foreground-600">A copy is also emailed to every signer. Download links work for a few minutes; reload this page for new ones.</p>
        </div> : mine ? <p role="status" className="rounded-md border border-green-300 bg-green-50 p-4">{justSigned ? "Thank you, your signature is recorded. " : "You have signed this document. "}
          It will be complete when everyone required has signed, and a copy will be emailed to you then.</p>
          : <p>Hello {view.recipient.name}. You are signing as <strong>{view.recipient.role}</strong>. Read the complete document, fill in the highlighted fields, then sign at the bottom.</p>}
        {view.message && !mine && !complete && <p className="whitespace-pre-wrap rounded-md border border-background-300 bg-background-50 p-3 text-sm"><span className="font-semibold">Message from the sender: </span>{view.message}</p>}
        {view.signers.length > 1 && <ol className="flex flex-wrap gap-2 text-xs" aria-label="Signers">{view.signers.map((s, i) => <li key={i} className={`rounded-full border px-3 py-1 ${s.me ? "border-primary-500 font-semibold" : "border-background-300"}`}>
          {s.role}: {s.me ? "you" : s.name} · {RECIPIENT_STATE[s.state] ?? s.state}{s.required ? "" : " (optional)"}</li>)}</ol>}

        <div className="rounded-md bg-background-200 p-2 sm:p-3">
          <PdfPages source={view.url} overlay={(page) => canSign ? view.fields.filter((f) => f.page === page).map((f) => {
            const style = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
            const lacking = missing.some((m) => m.id === f.id);
            const frame = `absolute rounded-sm border-2 ${lacking ? "border-red-500 bg-red-50/80" : "border-primary-500 bg-primary-50/80"}`;
            if (f.type === "text") return <input key={f.id} data-field={f.id} aria-label={f.label || "Text field"} placeholder={f.label || "Type here"} value={values[f.id] ?? ""} maxLength={500}
              onChange={(e) => setValues({ ...values, [f.id]: e.target.value })} className={`${frame} px-1 text-[16px] leading-none sm:text-sm`} style={style} />;
            if (f.type === "checkbox") return <label key={f.id} data-field={f.id} className={`${frame} flex cursor-pointer items-center justify-center`} style={style} title={f.label || "Checkbox"}>
              <input type="checkbox" aria-label={f.label || "Checkbox"} checked={values[f.id] === "true"} onChange={(e) => setValues({ ...values, [f.id]: e.target.checked ? "true" : "false" })} className="h-full w-full cursor-pointer" /></label>;
            const text = f.type === "signature" ? (method === "typed" ? name || "Sign here" : picture ? "" : "Sign here") : f.type === "initials" ? initialsOf(name) || "Initials" : f.type === "name" ? name || "Your name" : "Date when you sign";
            return <button key={f.id} type="button" data-field={f.id} onClick={() => signPanel.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
              className={`absolute flex items-center overflow-hidden rounded-sm border-2 border-dashed border-primary-500 bg-primary-50/70 px-1 text-left text-[11px] font-semibold text-primary-800 sm:text-xs ${f.type === "signature" || f.type === "initials" ? "italic" : ""}`} style={style}>
              {f.type === "signature" && method !== "typed" && picture ? <img src={`data:image/png;base64,${picture}`} alt="Your signature" className="max-h-full max-w-full" /> : <span className="truncate">{text}</span>}</button>;
          }) : null} />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <a className="font-semibold text-primary-700 underline" href={view.url} target="_blank" rel="noreferrer">Open the PDF in a new tab</a>
          <button type="button" className="underline" onClick={() => void load()}>Refresh the document</button>
        </div>

        {canSign && <form ref={signPanel} className="space-y-5 border-t pt-5" onSubmit={(e) => { e.preventDefault(); void sign(); }}>
          <h2 className="text-lg font-semibold">Sign this document</h2>
          {missing.length > 0 && <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm">{missing.length} required field{missing.length === 1 ? "" : "s"} in the document still need{missing.length === 1 ? "s" : ""} an answer.{" "}
            <button type="button" className="font-semibold underline" onClick={() => goTo(missing[0].id)} data-testid="next-field">Go to the next one</button></p>}
          <Field label="Your full name" required><TextInput value={name} onChange={(e) => setName(e.target.value)} required maxLength={150} autoComplete="name" className="!text-[16px]" /></Field>
          <div>
            <p className="mb-2 text-[13px] font-medium text-foreground-800">Your signature</p>
            <div role="tablist" className="mb-3 flex flex-wrap gap-2">{([["typed", "Type"], ["drawn", "Draw"], ["uploaded", "Upload a picture"]] as const).map(([id, label]) =>
              <button key={id} type="button" role="tab" aria-selected={method === id} onClick={() => { setMethod(id); setPicture(null); }}
                className={`rounded-full border px-4 py-2 text-sm font-medium ${method === id ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-background-50"}`}>{label}</button>)}</div>
            {method === "typed" && <p className="min-h-16 rounded-md border border-background-300 bg-background-50 px-4 py-3 text-2xl italic text-[#0d1a4d]" data-testid="typed-signature">{name || "Your name appears here as your signature"}</p>}
            {method === "drawn" && <SignaturePad onChange={setPicture} />}
            {method === "uploaded" && <div className="space-y-2">
              <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Signature picture" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; void pictureToPng(file).then((png) => { setPicture(png); setError(""); }).catch((err: Error) => { setPicture(null); setError(err.message); }); }} />
              {picture && <img src={`data:image/png;base64,${picture}`} alt="Your signature" className="max-h-24 rounded border border-background-300 bg-white p-1" />}</div>}
          </div>
          <label className="flex items-start gap-3"><input type="checkbox" required checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1 h-5 w-5 shrink-0" /><span className="text-sm">{view.consent}</span></label>
          <div className="hidden flex-wrap gap-3 sm:flex">
            <Button type="submit" disabled={busy || !ready}>{busy ? "Please wait…" : "Sign document"}</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setDeclining(true)}>Decline to sign</Button>
          </div>
        </form>}
        {declining && <div className="space-y-3 rounded-md border border-background-300 p-4" role="dialog" aria-label="Decline to sign">
          <p className="font-semibold">Decline to sign this document?</p>
          <p className="text-sm text-foreground-600">The sender is told and your link stops working. You can say why (optional).</p>
          <TextArea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} aria-label="Reason for declining" className="!text-[16px]" />
          <div className="flex flex-wrap gap-3"><Button type="button" variant="danger" disabled={busy} onClick={() => void decline()}>Yes, decline</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setDeclining(false)}>Go back</Button></div>
        </div>}
      </> : !error && <p role="status">Opening your document…</p>}
    </div>
    {/* Phone: the two actions stay in reach at the bottom of the screen. */}
    {canSign && !declined && !declining && <div className="fixed inset-x-0 bottom-0 z-10 flex gap-2 border-t border-background-300 bg-white p-3 sm:hidden">
      {ready ? <Button type="button" className="flex-1" disabled={busy} onClick={() => void sign()}>{busy ? "Please wait…" : "Sign document"}</Button>
        : <Button type="button" className="flex-1" onClick={() => missing.length ? goTo(missing[0].id) : signPanel.current?.scrollIntoView({ behavior: "smooth" })}>{missing.length ? `Fill in ${missing.length} field${missing.length === 1 ? "" : "s"}` : "Go to signature"}</Button>}
      <Button type="button" variant="outline" disabled={busy} onClick={() => setDeclining(true)}>Decline</Button>
    </div>}
  </main>;
}
