import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Field, TextArea, TextInput } from "@/pages/admin/components/ui";
import PdfPages from "@/components/signing/PdfPages";
import LegacySignPage from "@/components/signing/LegacySignPage";
import { RECIPIENT_STATE, signingAction, signWithRetry, type SigningView } from "@/lib/signingApi";
import { initialsOf } from "../../supabase/functions/_shared/signing";
import { isTokenFieldLabel, tokenFieldName } from "../../supabase/functions/_shared/template-variables";

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

/** An expired, replaced or unknown link: nothing about the document is shown; the signer can ask admissions for a new one. */
function LinkProblem({ token, message }: { token: string; message: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const invalid = /invalid or expired/i.test(message);
  const request = async () => {
    setState("busy");
    try { await signingAction({ action: "link_request", token }); setState("done"); } catch { setState("error"); }
  };
  return <div className="space-y-4 rounded-lg border border-background-300 bg-background-50 p-4 sm:p-5" data-testid="signing-link-problem">
    <div className="flex items-start gap-3">
      <i className="ri-link-unlink-m mt-0.5 text-xl text-foreground-500" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-semibold text-foreground-900">{invalid ? "This link no longer works" : "The document could not be opened"}</p>
        <p className="text-sm text-foreground-700">{invalid
          ? "Signing links are personal and stop working when they expire or when a newer email is sent. Use the link in your most recent email, or ask for a new one."
          : message}</p>
      </div>
    </div>
    {invalid && (state === "done"
      ? <p role="status" className="rounded-md border border-green-300 bg-green-50 p-3 text-sm" data-testid="link-requested">Thank you. If this link was sent by us, our admissions team has been told and will email you a new one.</p>
      : <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={() => void request()} disabled={state === "busy" || !token} data-testid="request-new-link">{state === "busy" ? "Please wait…" : "Request a new link"}</Button>
        {state === "error" && <span className="text-sm text-red-700" role="alert">That did not work. Please try again in a few minutes.</span>}
      </div>)}
  </div>;
}

/** Offer letters: a 6-digit code emailed to the student confirms it is them; signing needs the session it gives. */
function CodeCheck({ token, to, onVerified }: { token: string; to: string | null | undefined; onVerified: (session: string) => void }) {
  const [sent, setSent] = useState(false); const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false); const [note, setNote] = useState(""); const [problem, setProblem] = useState("");
  const send = async () => {
    setBusy(true); setProblem(""); setNote("");
    try { const r = await signingAction<{ to: string; minutes: number }>({ action: "code_send", token }); setSent(true); setNote(`We emailed a 6-digit code to ${r.to}. It works for ${r.minutes} minutes.`); }
    catch (e) { setProblem(e instanceof Error ? e.message : "The code could not be sent."); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setProblem("");
    try {
      const r = await signingAction<{ ok: boolean; session: string | null; reason: string | null; remaining: number | null }>({ action: "code_verify", token, code });
      if (r.ok && r.session) { onVerified(r.session); return; }
      setCode("");
      setProblem(r.reason === "wrong" ? `That code is not right. ${r.remaining} attempt${r.remaining === 1 ? "" : "s"} left.`
        : r.reason === "locked" ? "Too many wrong codes. Ask for a new code." : "That code has expired. Ask for a new code.");
      if (r.reason !== "wrong") setSent(false);
    } catch (e) { setProblem(e instanceof Error ? e.message : "The code could not be checked."); } finally { setBusy(false); }
  };
  return <fieldset className="space-y-3 rounded-md border border-background-300 p-3" data-testid="code-check">
    <legend className="px-1 text-sm font-semibold">Confirm it is you</legend>
    <p className="text-sm text-foreground-600">Before you sign, we email a one-time code to {to || "your email address"}.</p>
    {!sent ? <Button type="button" variant="outline" disabled={busy} onClick={() => void send()} data-testid="send-code">{busy ? "Sending…" : "Email me a code"}</Button>
      : <div className="flex flex-wrap items-end gap-2">
        <Field label="6-digit code"><TextInput value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
          className="!w-36 !text-[16px] tracking-widest" data-testid="code-input" /></Field>
        <Button type="button" disabled={busy || code.length !== 6} onClick={() => void verify()} data-testid="verify-code">{busy ? "Checking…" : "Confirm"}</Button>
        <button type="button" className="mb-2 text-sm underline" disabled={busy} onClick={() => void send()}>Send a new code</button>
      </div>}
    {note && <p role="status" className="text-sm text-foreground-700">{note}</p>}
    {problem && <p role="alert" className="text-sm text-red-700">{problem}</p>}
  </fieldset>;
}

export default function SigningPage() {
  const [token] = useState(readToken);
  const [codeSession, setCodeSession] = useState<string | null>(null);
  const [view, setView] = useState<SigningView | null>(null);
  const [name, setName] = useState(""); const [agreed, setAgreed] = useState(false);
  const [method, setMethod] = useState<Method>("typed"); const [picture, setPicture] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false); const [declining, setDeclining] = useState(false); const [reason, setReason] = useState("");
  const [justSigned, setJustSigned] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const signPanel = useRef<HTMLFormElement>(null);
  const load = useCallback(async () => {
    setError("");
    try {
      const next = await signingAction<SigningView>({ action: "open", token });
      // The released first-stage function answers without the recipient and fields: its own page handles that version.
      if (!next.recipient) { setLegacy(true); return; }
      setView(next); setName((current) => current || next.recipient.name);
    } catch (e) { setError(e instanceof Error ? e.message : "The document could not be opened."); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const mine = view?.recipient.state === "signed";
  const complete = view?.state === "signed";
  const canSign = !!view && !mine && !complete;
  const missing = canSign ? view.fields.filter((f) => f.required && ((f.type === "text" && !(values[f.id] ?? "").trim()) || (f.type === "checkbox" && values[f.id] !== "true")
    || (f.type === "choice" && !values[f.id]))) : [];
  const signatureReady = method === "typed" ? name.trim().length >= 2 : !!picture;
  const offer = view?.offer ?? null;
  const choices = canSign ? view.fields.filter((f) => f.type === "choice") : [];
  const setChoice = (id: string, answer: "YES" | "NO") => setValues((current) => ({ ...current, [id]: answer }));
  const ready = canSign && agreed && name.trim().length >= 2 && signatureReady && !missing.length && (!view.requireCode || !!codeSession);
  const goTo = (id: string) => document.querySelector(`[data-field="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  // TPL-02: a [token] of the template is one question, however often it appears; its answer fills every copy of it.
  const tokenLabels = canSign ? [...new Set(view.fields.filter((f) => f.type === "text" && isTokenFieldLabel(f.label)).map((f) => f.label))] : [];
  const setText = (field: { id: string; label: string }, text: string) => setValues((current) => {
    if (!view || !isTokenFieldLabel(field.label)) return { ...current, [field.id]: text };
    const next = { ...current };
    for (const f of view.fields) if (f.type === "text" && f.label === field.label) next[f.id] = text;
    return next;
  });
  const answerOf = (label: string) => { const first = view?.fields.find((f) => f.label === label); return first ? values[first.id] ?? "" : ""; };

  const sign = async () => {
    if (!view || busy || !ready) return;
    setBusy(true); setError("");
    try {
      await signWithRetry({ action: "sign", token, name, agreed, signatureKind: method, signatureImage: method === "typed" ? null : picture, values, documentHash: view.documentHash, codeSession });
      setJustSigned(true); await load(); window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); }
  };
  const decline = async () => {
    if (!view || busy) return;
    setBusy(true); setError("");
    try { await signingAction({ action: "decline", token, reason }); setDeclined(true); setDeclining(false); sessionStorage.removeItem("slit-signing-token"); }
    catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); }
  };

  if (legacy) return <LegacySignPage />;
  return <main className="min-h-screen bg-background-100 px-3 pb-28 pt-6 sm:px-4 sm:py-10">
    <div className="mx-auto max-w-4xl space-y-5 rounded-xl bg-white p-4 sm:p-6 md:p-8">
      <p className="text-sm font-semibold text-foreground-600">Skyline Institute of Technology · {offer ? "Letter of Offer" : "Document signing"}</p>
      <h1 className="break-words text-xl font-bold sm:text-2xl">{offer ? "Review and sign your offer" : view?.title ?? "Your document"}</h1>
      {offer ? <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="offer-summary">
        <div className="flex gap-1"><dt className="text-foreground-500">Student</dt><dd className="font-medium text-foreground-900">{offer.studentName}</dd></div>
        <div className="flex gap-1"><dt className="text-foreground-500">Application</dt><dd className="font-medium text-foreground-900">{offer.applicationReference}</dd></div>
        <div className="flex gap-1"><dt className="text-foreground-500">Document</dt><dd className="text-foreground-800">{view?.title}</dd></div>
      </dl> : view && <p className="text-xs text-foreground-500">Reference {view.reference}</p>}
      {error && !view && !legacy ? <LinkProblem token={token} message={error} /> : error && <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p>}
      {declined ? <p role="status" className="rounded border border-background-300 p-4">You declined this request. The sender has been told. Please contact them if you need a new document.</p> : view ? <>
        {complete ? <div role="status" className="space-y-3 rounded-md border border-green-300 bg-green-50 p-4" data-testid={offer ? (justSigned ? "offer-signed" : "offer-already-signed") : "signing-complete"}>
          <p className="font-semibold">{offer ? (justSigned ? "Thank you. Your offer is accepted: your signed letter has been sent to our admissions team." : "Already signed: this offer letter was signed and accepted.")
            : "This document is complete: everyone required has signed."}</p>
          <div className="flex flex-wrap gap-3">
            <a className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-4 py-2 text-sm font-medium text-background-50" href={view.url} download data-testid="download-signed"><i className="ri-download-line" aria-hidden="true" />{offer ? "Download signed copy" : "Download the signed document"}</a>
            {view.certificateUrl && <a className="inline-flex items-center gap-2 rounded-md border border-background-300 px-4 py-2 text-sm font-medium" href={view.certificateUrl} download><i className="ri-shield-check-line" aria-hidden="true" />Download the completion certificate</a>}
          </div>
          <p className="text-sm text-foreground-600">A copy is also emailed to every signer. Download links work for a few minutes; reload this page for new ones.</p>
        </div> : mine ? <p role="status" className="rounded-md border border-green-300 bg-green-50 p-4">{justSigned ? "Thank you, your signature is recorded. " : "You have signed this document. "}
          It will be complete when everyone required has signed, and a copy will be emailed to you then.</p>
          : offer ? <p className="text-sm">Hello {view.recipient.name}. Read every page of your offer letter. Your initials go on every page, your signature and the date in the signature block, and you answer whether you elect to pay more than the required pre-paid fee. Then confirm the code we email you and sign at the bottom.</p>
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
              onChange={(e) => setText(f, e.target.value)} className={`${frame} px-1 text-[16px] leading-none sm:text-sm`} style={style} />;
            if (f.type === "checkbox") return <label key={f.id} data-field={f.id} className={`${frame} flex cursor-pointer items-center justify-center`} style={style} title={f.label || "Checkbox"}>
              <input type="checkbox" aria-label={f.label || "Checkbox"} checked={values[f.id] === "true"} onChange={(e) => setValues({ ...values, [f.id]: e.target.checked ? "true" : "false" })} className="h-full w-full cursor-pointer" /></label>;
            if (f.type === "choice") return <div key={f.id} data-field={f.id} role="radiogroup" aria-label={f.label} title={f.label} className={`${frame} flex items-stretch gap-0.5 p-0.5`} style={style}>
              {(["YES", "NO"] as const).map((answer) => <button key={answer} type="button" role="radio" aria-checked={values[f.id] === answer} onClick={() => setChoice(f.id, answer)}
                className={`flex-1 rounded-sm text-[10px] font-semibold leading-none sm:text-xs ${values[f.id] === answer ? "bg-primary-600 text-white" : "bg-white/90 text-primary-800"}`}>{answer}</button>)}
            </div>;
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
          {tokenLabels.length > 0 && <fieldset className="space-y-3 rounded-md border border-background-300 p-3" data-testid="signer-details">
            <legend className="px-1 text-sm font-semibold">Details to fill in</legend>
            <p className="text-sm text-foreground-600">These go into the document wherever they appear. Answer each one before you sign.</p>
            {tokenLabels.map((label) => { const name = tokenFieldName(label); const lacking = !answerOf(label).trim(); return <Field key={label} label={name} required>
              <TextInput value={answerOf(label)} maxLength={500} aria-invalid={lacking} data-testid={`detail-${name.replace(/\s+/g, "-").toLowerCase()}`} className="!text-[16px]"
                onChange={(e) => { const first = view!.fields.find((f) => f.label === label)!; setText(first, e.target.value); }} /></Field>; })}
          </fieldset>}
          {choices.length > 0 && <fieldset className="space-y-2 rounded-md border border-background-300 p-3" data-testid="offer-choices">
            <legend className="px-1 text-sm font-semibold">Your answer</legend>
            {choices.map((f) => <div key={f.id} className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-foreground-800">{f.label}<span className="text-red-600"> *</span></span>
              <div role="radiogroup" aria-label={f.label} className="flex gap-2">{(["YES", "NO"] as const).map((answer) =>
                <label key={answer} className={`flex cursor-pointer items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium ${values[f.id] === answer ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-background-50"}`}>
                  <input type="radio" name={`choice-${f.id}`} value={answer} checked={values[f.id] === answer} onChange={() => setChoice(f.id, answer)} className="sr-only" data-testid={`choice-${answer.toLowerCase()}`} />{answer}</label>)}</div>
            </div>)}
          </fieldset>}
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
          <label className="flex items-start gap-3"><input type="checkbox" required checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1 h-5 w-5 shrink-0" data-testid="consent" /><span className="text-sm">{view.consent}</span></label>
          {view.requireCode && (codeSession
            ? <p role="status" className="flex items-center gap-2 rounded-md border border-green-300 bg-green-50 p-3 text-sm" data-testid="code-verified"><i className="ri-shield-check-line text-base text-green-700" aria-hidden="true" />Your email is confirmed. You can sign now.</p>
            : <CodeCheck token={token} to={view.codeTo} onVerified={setCodeSession} />)}
          <div className="hidden flex-wrap gap-3 sm:flex">
            <Button type="submit" disabled={busy || !ready} data-testid="sign-submit">{busy ? "Please wait…" : offer ? "Sign and accept offer" : "Sign document"}</Button>
            {!offer && <Button type="button" variant="outline" disabled={busy} onClick={() => setDeclining(true)}>Decline to sign</Button>}
          </div>
          {offer && <p className="text-xs text-foreground-500">Questions about your offer, or want to decline it? Reply to the offer email to contact our admissions team.</p>}
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
      {ready ? <Button type="button" className="flex-1" disabled={busy} onClick={() => void sign()}>{busy ? "Please wait…" : offer ? "Sign and accept" : "Sign document"}</Button>
        : <Button type="button" className="flex-1" onClick={() => missing.length ? goTo(missing[0].id) : signPanel.current?.scrollIntoView({ behavior: "smooth" })}>{missing.length ? `Fill in ${missing.length} field${missing.length === 1 ? "" : "s"}` : "Go to signature"}</Button>}
      {!offer && <Button type="button" variant="outline" disabled={busy} onClick={() => setDeclining(true)}>Decline</Button>}
    </div>}
  </main>;
}
