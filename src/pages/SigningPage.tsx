import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Field, TextArea, TextInput } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";
import { safeLogo } from "@/lib/brandCache";
import PdfPages from "@/components/signing/PdfPages";
import SignaturePad from "@/components/signing/SignaturePad";
import { pictureToPng } from "@/components/signing/signatureImage";
import LegacySignPage from "@/components/signing/LegacySignPage";
import F04Wizard, { F04Done } from "@/components/signing/F04Wizard";
import SigningDone, { type NextStep } from "@/components/signing/SigningDone";
import { formatSignedAt } from "@/lib/signedTime";
import { fieldGroup, formatMoney, isAutoField, paymentsAction, RECIPIENT_STATE, signingAction, signingDownloadUrl, signWithRetry, type OfferSigningState, type PaymentView, type SigningView } from "@/lib/signingApi";
const AUTO_TITLE = "Filled automatically when you sign";
import { initialsOf } from "../../supabase/functions/_shared/signing";
import { isTokenFieldLabel, tokenFieldName } from "../../supabase/functions/_shared/template-variables";
import { checkApplicationAnswers, F04_TITLES } from "../../supabase/functions/_shared/validation/abr";
import { ruleText } from "@/lib/businessRules";
import SearchableSelect from "@/components/ui/SearchableSelect";

/*
 * The signing page a link holder opens (/sign#t=token): the offer letter a student signs, or any other document sent for signature.
 * OFFER-DEPOSIT (2026-11-16): signing accepts the offer at once. When the letter asks for an initial deposit, the SAME link opened after
 * signing shows only the payment page (institution header, student and application, "Offer accepted", the deposit, Pay by Stripe
 * Checkout, a link to the signed copy); once Stripe has verified the deposit it shows "Payment received, thank you. Your CoE / VoE
 * will be issued soon." with the receipt. Steps: 1 Review & sign, 2 Accepted, 3 Pay deposit (only when the letter asks for one).
 * Every state shown here comes from the server (document-signing `open`, payments `status` / `confirm`); the amount is never taken
 * from the address or the page.
 */

const DEFAULT_INSTITUTION = "Skyline Institute of Technology";
function readToken() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("t");
  // The query string stays: Stripe sends the payer back with ?payment=success or ?payment=cancelled.
  if (token) { sessionStorage.setItem("slit-signing-token", token); history.replaceState(null, "", window.location.pathname + window.location.search); }
  return token ?? sessionStorage.getItem("slit-signing-token") ?? "";
}
/** ?payment=success | cancelled, set by the checkout's return address; removed from the address once handled. */
const readPaymentReturn = () => new URLSearchParams(window.location.search).get("payment");
function clearPaymentReturn() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("payment")) return;
  url.searchParams.delete("payment");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PAYMENT_LABEL: Record<string, string> = { pending: "Not paid yet", open: "Checkout started", processing: "Processing", paid: "Paid", failed: "Payment failed", refunded: "Refunded" };
/** "AUD$1,500.00": the currency code in front of the amount, as the letter prints it. */
function moneyLabel(cents: number, currency: string): string {
  const code = (currency || "AUD").toUpperCase(); const money = formatMoney(cents, currency);
  return money.startsWith("$") ? `${code}${money}` : money;
}
const when = (iso: string) => formatSignedAt(iso);
const ZOOMS = [0.75, 1, 1.25, 1.5];

/** The numbered steps at the top: done, current, still to come. `current` past the last index means every step is done. */
function Steps({ steps, current }: { steps: string[]; current: number }) {
  return <ol className="flex items-start gap-1 sm:gap-2" aria-label="Progress" data-testid="signing-steps">
    {steps.map((label, i) => {
      const done = i < current, active = i === current;
      return <li key={label} aria-current={active ? "step" : undefined} className="flex min-w-0 flex-1 items-center gap-2" data-step-state={done ? "done" : active ? "current" : "todo"}>
        <span aria-hidden="true" className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${done ? "bg-primary-500 text-white" : active ? "border-2 border-primary-500 bg-white text-primary-700" : "border border-background-300 bg-white text-foreground-500"}`}>
          {done ? <i className="ri-check-line text-sm" /> : i + 1}</span>
        <span className={`min-w-0 truncate text-xs sm:text-sm ${active ? "font-semibold text-foreground-900" : done ? "font-medium text-foreground-700" : "text-foreground-500"}`}>{label}</span>
        {i < steps.length - 1 && <span aria-hidden="true" className={`hidden h-px flex-1 sm:block ${done ? "bg-primary-400" : "bg-background-300"}`} />}
      </li>;
    })}
  </ol>;
}

/** The initial deposit (or any payment on the document): amount, where it is up to, Stripe's note and the button that opens Checkout. */
function PaymentCard({ pay, note, busy, showPay, afterSigning, polling, coeLabel, onPay }: {
  pay: PaymentView; note: { tone: "ok" | "warn"; text: string } | null; busy: boolean; showPay: boolean; afterSigning: boolean; polling: boolean; coeLabel: string; onPay: () => void;
}) {
  const p = pay.payment;
  if (!pay.required || !p) return null;
  const paid = p.status === "paid";
  const processing = polling || p.status === "processing";
  const badge = paid ? "bg-emerald-50 text-emerald-800 border-emerald-200" : processing ? "bg-sky-50 text-sky-800 border-sky-200" : p.status === "failed" ? "bg-red-50 text-red-800 border-red-200" : "bg-amber-50 text-amber-900 border-amber-200";
  return <section className={`rounded-xl border p-4 sm:p-5 ${paid ? "border-emerald-200 bg-emerald-50/50" : "border-background-200 bg-white"}`} data-testid="payment-card" data-status={p.status} aria-labelledby="payment-heading">
    <div className="flex flex-wrap items-center gap-2">
      <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${paid ? "bg-emerald-100 text-emerald-700" : "bg-primary-50 text-primary-700"}`} aria-hidden="true"><i className={`${paid ? "ri-checkbox-circle-line" : "ri-bank-card-line"} text-lg`} /></span>
      <div className="min-w-0 flex-1">
        <h2 id="payment-heading" className="font-heading text-base font-semibold text-foreground-900">{p.description} · <span data-testid="payment-amount">{moneyLabel(p.amountCents, p.currency)}</span></h2>
        <p className="text-xs text-foreground-500">{paid && p.paidAt ? `Paid ${when(p.paidAt)}` : afterSigning ? "Due after you sign" : "Due before you sign"}</p>
      </div>
      <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge}`} data-testid="payment-status">{processing && !paid ? "Processing" : PAYMENT_LABEL[p.status] ?? p.status}</span>
      {p.testMode && <span className="rounded border border-amber-400 bg-amber-50 px-1.5 text-2xs font-semibold uppercase text-amber-900" data-testid="payment-test-mode">Test mode</span>}
    </div>
    {paid && <p className="mt-3 text-sm font-medium text-emerald-900" role="status" data-testid="payment-received">Payment received, thank you. Your {coeLabel} will be issued soon.</p>}
    {!paid && p.status === "failed" && p.failureReason && <p className="mt-3 text-sm text-red-700" role="alert">{p.failureReason}</p>}
    {!paid && processing && <p className="mt-3 flex items-center gap-2 text-sm text-foreground-700" role="status" data-testid="payment-processing"><i className="ri-loader-4-line animate-spin text-base text-primary-600" aria-hidden="true" />Confirming your payment with Stripe. This page updates by itself; it can take a moment.</p>}
    {!paid && pay.stripeReady === false && <p className="mt-3 text-sm text-foreground-700">Online payment is not available right now. Please contact us.</p>}
    {note && <p role={note.tone === "warn" ? "alert" : "status"} className={`mt-3 text-sm font-medium ${note.tone === "ok" ? "text-emerald-800" : "text-red-700"}`} data-testid="payment-note">{note.text}</p>}
    {paid && p.receiptUrl && <a className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary-700 underline underline-offset-2" href={p.receiptUrl} target="_blank" rel="noreferrer" data-testid="payment-receipt"><i className="ri-receipt-line" aria-hidden="true" />View your Stripe receipt</a>}
    {showPay && !processing && <div className="mt-4 flex flex-wrap items-center gap-3">
      <Button type="button" disabled={busy} onClick={onPay} data-testid="pay-now"><i className="ri-secure-payment-line" aria-hidden="true" />{busy ? "Please wait…" : p.status === "open" ? "Continue to payment" : `Pay ${moneyLabel(p.amountCents, p.currency)}`}</Button>
      <span className="flex items-center gap-1 text-xs text-foreground-500"><i className="ri-lock-line" aria-hidden="true" />Card payments are taken securely by Stripe. Your card details never reach us.</span>
    </div>}
  </section>;
}
type Method = "typed" | "drawn" | "uploaded";
/** An expired, replaced or unknown link: nothing about the document is shown; the signer can ask admissions for a new one. */
function LinkProblem({ token, message }: { token: string; message: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const invalid = /invalid or expired/i.test(message);
  // A link whose request no longer exists (e.g. the business was deleted before signing, 2026-11-20): a neutral page, nothing to request.
  const gone = /no longer available/i.test(message);
  const request = async () => {
    setState("busy");
    try { await signingAction({ action: "link_request", token }); setState("done"); } catch { setState("error"); }
  };
  if (gone) return <div className="rounded-xl border border-background-200 bg-white p-4 sm:p-5" data-testid="signing-link-gone">
    <div className="flex items-start gap-3">
      <i className="ri-link-unlink-m mt-0.5 text-xl text-foreground-500" aria-hidden="true" />
      <p className="font-semibold text-foreground-900">This link is no longer available</p>
    </div>
  </div>;
  return <div className="space-y-4 rounded-xl border border-background-200 bg-white p-4 sm:p-5" data-testid="signing-link-problem">
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
      ? <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm" data-testid="link-requested">Thank you. If this link was sent by us, our admissions team has been told and will email you a new one.</p>
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
  return <fieldset className="space-y-3 rounded-lg border border-background-200 bg-background-50 p-3" data-testid="code-check">
    <legend className="px-1 text-sm font-semibold">Confirm it is you</legend>
    <p className="text-sm text-foreground-600">Before you sign, we email a one-time code to {to || "your email address"}.</p>
    {!sent ? <Button type="button" variant="outline" disabled={busy} onClick={() => void send()} data-testid="send-code">{busy ? "Sending…" : "Email me a code"}</Button>
      : <div className="flex flex-wrap items-end gap-2">
        <Field label="6-digit code"><TextInput value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
          className="!w-36 !text-base tracking-widest" data-testid="code-input" /></Field>
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
  const [pages, setPages] = useState(0); const [zoom, setZoom] = useState(1);
  const [institution, setInstitution] = useState<{ name: string; logo: string }>({ name: DEFAULT_INSTITUTION, logo: "" });
  const signPanel = useRef<HTMLFormElement>(null);
  /** Stripe: what is owed on this document and the offer's own state (null until known, or when the payments function is unreachable). */
  const [pay, setPay] = useState<PaymentView | null>(null);
  const [payNote, setPayNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [paying, setPaying] = useState(false); const [polling, setPolling] = useState(false);
  const [paymentReturn] = useState(readPaymentReturn);
  const returnHandled = useRef(false);
  const paymentCard = useRef<HTMLDivElement>(null);
  const loadPay = useCallback(async () => {
    try { const next = await paymentsAction<PaymentView>({ action: "status", token }); setPay(next); return next; } catch { return null; /* the document still shows; signing answers if a payment is due */ }
  }, [token]);
  const load = useCallback(async () => {
    setError("");
    try {
      const next = await signingAction<SigningView>({ action: "open", token });
      // The released first-stage function answers without the recipient and fields: its own page handles that version.
      if (!next.recipient) { setLegacy(true); return; }
      setView(next); setName((current) => current || next.recipient.name);
      // A field the sender prefilled (agent onboarding: the signatory's name, the contact details we hold) starts with that text; the signer may change it.
      setValues((current) => { const seeded = { ...current }; for (const f of next.fields) if ((f.type === "text" && f.value || f.type === "checkbox" && f.value === "true") && seeded[f.id] === undefined) seeded[f.id] = f.value!; return seeded; });
      await loadPay();
    } catch (e) { setError(e instanceof Error ? e.message : "The document could not be opened."); }
  }, [token, loadPay]);
  useEffect(() => { void load(); }, [load]);
  // The header: the institution's name and logo from Website settings (readable without signing in); the built-in name until then.
  useEffect(() => {
    let live = true;
    void supabase.from("cms_settings").select("name, logo").order("id", { ascending: true }).limit(1).then(({ data }) => {
      const row = Array.isArray(data) ? data[0] as { name?: string | null; logo?: string | null } | undefined : undefined;
      if (live && row) setInstitution({ name: String(row.name ?? "").trim() || DEFAULT_INSTITUTION, logo: safeLogo(row.logo) });
    }, () => undefined);
    return () => { live = false; };
  }, []);
  // Back from Stripe Checkout: read the session back (a card payment can take a moment to settle), then keep asking until the webhook has
  // confirmed it, and drop ?payment= from the address. The server records the deposit during these calls; nothing is set from here.
  useEffect(() => {
    if (!paymentReturn || !token || returnHandled.current) return;
    returnHandled.current = true;
    if (paymentReturn !== "success") {
      if (paymentReturn === "cancelled") setPayNote({ tone: "warn", text: "Payment cancelled. You can pay when you are ready." });
      clearPaymentReturn();
      return;
    }
    void (async () => {
      setPolling(true); clearPaymentReturn();
      try {
        let result: PaymentView | null = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          result = await paymentsAction<PaymentView>({ action: "confirm", token });
          if (!["open", "processing"].includes(result.payment?.status ?? "")) break;
          if (attempt < 4) await wait(2000);
        }
        // Still settling (a bank redirect, a slow webhook): watch the status for up to two minutes.
        for (let attempt = 0; attempt < 40 && ["open", "processing"].includes(result?.payment?.status ?? ""); attempt++) {
          await wait(3000);
          try { result = await paymentsAction<PaymentView>({ action: "status", token }); } catch { /* keep the last answer */ }
        }
        if (result) setPay(result);
        const status = result?.payment?.status;
        if (status === "paid") setPayNote(null);
        else if (status === "open" || status === "processing") setPayNote({ tone: "warn", text: "Your payment is still being confirmed. Refresh this page in a moment." });
        else setPayNote({ tone: "warn", text: result?.payment?.failureReason || "The payment was not completed. You can try again." });
      } catch (e) { setPayNote({ tone: "warn", text: e instanceof Error ? e.message : "The payment could not be confirmed. Refresh this page in a moment." }); }
      finally { setPolling(false); }
    })();
  }, [paymentReturn, token]);
  const payNow = async () => {
    if (paying) return;
    setPaying(true); setPayNote(null);
    try {
      const back = new URL(window.location.href); back.searchParams.delete("payment");
      const result = await paymentsAction<{ url?: string; alreadyPaid?: boolean }>({ action: "checkout", token, returnUrl: back.href });
      if (result.url) { window.location.assign(result.url); return; }
      await loadPay();
      setPayNote(result.alreadyPaid ? { tone: "ok", text: "This payment has already been received." } : { tone: "warn", text: "The payment page could not be opened. Please try again." });
    } catch (e) { setPayNote({ tone: "warn", text: e instanceof Error ? e.message : "The payment page could not be opened." }); }
    finally { setPaying(false); }
  };

  const mine = view?.recipient.state === "signed";
  const complete = view?.state === "signed";
  const canSign = !!view && !mine && !complete;
  const payFirst = canSign && !!pay?.mustPayBeforeSigning;
  const afterSigning = pay?.payment?.timing === "after_sign";
  const offer = view?.offer ?? null;
  const offerState: OfferSigningState | null = pay?.offer?.offer ? pay.offer : null;
  const coeLabel = offerState?.coeLabel === "VoE" ? "VoE" : "CoE";
  /** A live payment on this document: the initial deposit on an offer letter. */
  const hasPayment = !!pay?.required && !!pay.payment;
  const paid = pay?.payment?.status === "paid" || !!offerState?.depositPaidAt;
  /** The server's word that the offer is accepted (signing accepts it; the deposit never holds it back). */
  const accepted = !!offerState?.acceptedAt || (!!offer && complete && !offerState);
  /** An offer that is signed: only the payment page (or the accepted confirmation) shows, never the letter again. */
  const paymentPage = !!offer && complete;
  // A payment due after signing is offered once this signer has signed; one due before, straight away.
  const showPay = !!pay?.canPay && (!afterSigning || mine || complete);
  // Fields the server fills at signing (offer accepted, payment made, payment date...) are shown greyed and never asked for or sent.
  const auto = (f: { label: string; type: string }) => (f.type === "text" || f.type === "checkbox") && isAutoField(f.label);
  // A question answered by tick boxes ("Involved in litigation: Yes / No") is one answer: ticking a box clears its siblings, any ticked box satisfies the question.
  const groupTicked = (f: { key?: string | null }) => { const g = fieldGroup(f.key); return !!g && !!view && view.fields.some((o) => fieldGroup(o.key)?.key === g.key && values[o.id] === "true"); };
  const setTick = (f: { id: string; key?: string | null }, on: boolean) => setValues((current) => {
    const next = { ...current, [f.id]: on ? "true" : "false" };
    const g = fieldGroup(f.key);
    if (g && on && view) for (const o of view.fields) if (o.id !== f.id && fieldGroup(o.key)?.key === g.key) next[o.id] = "false";
    return next;
  });
  const seenGroups = new Set<string>();
  const missing = canSign ? view.fields.filter((f) => f.required && !auto(f) && ((f.type === "text" && !(values[f.id] ?? "").trim()) || (f.type === "checkbox" && values[f.id] !== "true" && !groupTicked(f))
    || (f.type === "choice" && !values[f.id]))).filter((f) => { const g = fieldGroup(f.key); if (!g) return true; if (seenGroups.has(g.key)) return false; seenGroups.add(g.key); return true; }) : [];
  const sentValues = () => Object.fromEntries(Object.entries(values).filter(([id]) => !view?.fields.some((f) => f.id === id && auto(f))));
  const signatureReady = method === "typed" ? name.trim().length >= 2 : !!picture;
  const choices = canSign ? view.fields.filter((f) => f.type === "choice") : [];
  const setChoice = (id: string, answer: "YES" | "NO") => setValues((current) => ({ ...current, [id]: answer }));
  // Agent Application Form: the title comes from the list; the two referees need different emails (refused); the same contact name is a warning.
  const application = canSign && view.onboarding?.kind === "application" ? checkApplicationAnswers(Object.fromEntries(view.fields.filter((f) => f.type === "text" && f.key).map((f) => [f.key!, values[f.id] ?? ""])),
    { refereeEmailsDistinct: ruleText("agents.referee_emails_must_differ", "Must be different") !== "May be the same" }) : { error: null, warnings: [] };
  const ready = canSign && agreed && name.trim().length >= 2 && signatureReady && !missing.length && !application.error && (!view.requireCode || !!codeSession) && !payFirst;
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
  /** The steps at the top. An offer: Review & sign, Accepted, then Pay deposit when the letter asks for one. Other documents: sign (and pay), then Complete. */
  const steps = useMemo(() => {
    const deposit = !!offer && (hasPayment || !!offerState?.hasPayment);
    if (offer) {
      const list = ["Review & sign", "Accepted", ...(deposit ? ["Pay deposit"] : [])];
      const current = !complete ? 0 : !accepted ? 1 : deposit && !paid ? 2 : list.length;
      return { list, current };
    }
    const payStep = hasPayment;
    const list = payStep && pay?.payment?.timing === "before_sign" ? ["Pay", "Review & sign"] : payStep ? ["Review & sign", "Pay"] : ["Review & sign"];
    list.push("Complete");
    const payDone = paid, signDone = complete || mine;
    const finished = signDone && (!payStep || payDone);
    const current = list[0] === "Pay" ? (!payDone ? 0 : !signDone ? 1 : 2) : (!signDone ? 0 : payStep && !payDone ? 1 : list.length - 1);
    return { list, current: finished ? list.length : current };
  }, [offer, hasPayment, offerState?.hasPayment, complete, accepted, paid, pay?.payment?.timing, mine]);

  const sign = async () => {
    if (!view || busy || !ready) return;
    setBusy(true); setError("");
    try {
      await signWithRetry({ action: "sign", token, name, agreed, signatureKind: method, signatureImage: method === "typed" ? null : picture, values: sentValues(), documentHash: view.documentHash, codeSession });
      setJustSigned(true); await load(); window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Please try again.";
      setError(message);
      // The server asks for the payment first: show the payment card with Pay now (its status may have changed since the page opened).
      if (/payment is required/i.test(message)) { await loadPay(); setPayNote({ tone: "warn", text: message }); paymentCard.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }
    } finally { setBusy(false); }
  };
  const decline = async () => {
    if (!view || busy) return;
    setBusy(true); setError("");
    try { await signingAction({ action: "decline", token, reason }); setDeclined(true); setDeclining(false); sessionStorage.removeItem("slit-signing-token"); }
    catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); }
  };

  if (legacy) return <LegacySignPage />;
  const monogram = institution.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "S";
  const depositLabel = pay?.payment ? moneyLabel(pay.payment.amountCents, pay.payment.currency) : offerState?.paymentAmountCents ? moneyLabel(offerState.paymentAmountCents, offerState.paymentCurrency ?? "aud") : "";
  const card = "rounded-xl border border-background-200 bg-white p-4 sm:p-5";
  const canvasFrame = (lacking: boolean) => `absolute rounded-sm border-2 ${lacking ? "border-red-500 bg-red-50/80" : "border-primary-500 bg-primary-50/80"}`;
  // F04 wizard (2026-11-19): the Agent Application Form is filled step by step; the F05 and the P06 keep this page.
  const f04 = view?.onboarding?.kind === "application";
  const hasBottomBar = !!view && !f04 && !declined && !declining && (canSign || (showPay && !paid) || paymentPage);
  /** A new link to the document on every Download / Open PDF click (the server's links last five minutes). */
  const freshUrl = () => signingDownloadUrl(token);
  const openPdf = async () => {
    // Opened at once (so no pop-up blocker steps in), then pointed at the new link; closed again if no link comes back.
    const tab = window.open("", "_blank"); if (tab) tab.opener = null;
    try { const url = await freshUrl(); if (tab) tab.location.href = url; else window.location.href = url; }
    catch { tab?.close(); setError("The document could not be opened. Please try again."); }
  };
  const kind = view?.onboarding?.kind ?? null;
  // "What happens next" after signing: the offer letter (deposit, then the CoE / VoE) and the referee check; other documents need nothing more.
  const offerSteps: NextStep[] = [["ri-mail-check-line", "Our admissions team has your signed letter"],
    ...(hasPayment ? [[paid ? "ri-checkbox-circle-line" : "ri-bank-card-line", paid ? "Your initial deposit is paid" : `Pay your ${depositLabel} initial deposit below`] as NextStep] : []),
    ["ri-file-shield-2-line", `We issue your ${coeLabel} and email it to you`]];
  const refereeSteps: NextStep[] = [["ri-mail-check-line", "SLIT has your reference"], ["ri-search-eye-line", "SLIT reviews the agent's application"], ["ri-checkbox-circle-line", "Nothing more is needed from you"]];
  return <main className={`min-h-screen bg-background-100 font-body text-foreground-900 ${hasBottomBar ? "pb-28" : "pb-10"} sm:pb-12`}>
    <header className="border-b border-background-200 bg-white">
      <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
        {institution.logo ? <img src={institution.logo} alt="" className="h-9 w-auto max-w-[140px] object-contain" />
          : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-500 font-heading text-sm font-bold text-white" aria-hidden="true">{monogram}</span>}
        <div className="min-w-0">
          <p className="truncate font-heading text-sm font-semibold text-foreground-900" data-testid="institution-name">{institution.name}</p>
          <p className="text-xs text-foreground-500">{offer ? "Letter of Offer" : "Document signing"}</p>
        </div>
        <span className="ml-auto hidden items-center gap-1 text-xs text-foreground-500 sm:flex"><i className="ri-lock-line" aria-hidden="true" />Secure signing</span>
      </div>
    </header>

    <div className="mx-auto max-w-4xl space-y-4 px-4 pt-5 sm:pt-6">
      {!(f04 && !error) && <section className={card}>
        <h1 className="break-words font-heading text-xl font-bold text-foreground-950 sm:text-2xl">{offer ? (paymentPage ? (paid || !hasPayment ? "Your offer is accepted" : "Pay your initial deposit") : "Review and sign your offer") : view?.title ?? "Your document"}</h1>
        {offer ? <dl className="mt-3 grid gap-3 rounded-lg border border-background-200 bg-background-50 p-3 text-sm sm:grid-cols-3" data-testid="offer-summary">
          <div className="min-w-0"><dt className="text-xs font-medium uppercase tracking-wide text-foreground-500">Student</dt><dd className="truncate font-medium text-foreground-900">{offer.studentName}</dd></div>
          <div className="min-w-0"><dt className="text-xs font-medium uppercase tracking-wide text-foreground-500">Application</dt><dd className="truncate font-medium text-foreground-900">{offer.applicationReference}</dd></div>
          <div className="min-w-0"><dt className="text-xs font-medium uppercase tracking-wide text-foreground-500">Document</dt><dd className="truncate text-foreground-800">{view?.title}</dd></div>
        </dl> : view && <p className="mt-1 text-xs text-foreground-500">Reference {view.reference}</p>}
        {view && !error && <div className="mt-4"><Steps steps={steps.list} current={steps.current} /></div>}
      </section>}

      {error && !view && !legacy ? <LinkProblem token={token} message={error} /> : error && <p role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {declined ? <p role="status" className={card}>You declined this request. The sender has been told. Please contact them if you need a new document.</p> : view && f04 ? (canSign
        ? <F04Wizard token={token} view={view} codeCheck={{ needed: !!view.requireCode, session: codeSession, render: () => <CodeCheck token={token} to={view.codeTo} onVerified={setCodeSession} /> }}
          onSigned={async () => { setJustSigned(true); await load(); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
        : <F04Done view={view} justSigned={justSigned} fetchUrl={freshUrl} />) : view ? <>
        {paymentPage ? <>
          {/* OFFER-DEPOSIT: the same link after signing: "Offer accepted", what happens next, the signed copy, then the deposit to pay (or paid). The letter itself is not shown again. */}
          <section className={card} data-accepted="true">
            <SigningDone testId={justSigned ? "offer-signed" : "offer-already-signed"} message={justSigned ? "Thank you. Your offer is accepted." : "Your offer is accepted."}
              note={hasPayment && !paid ? `Your initial deposit of ${depositLabel} is still to be paid; you can pay it below.` : "A copy of your signed letter is emailed to you."}
              signedAt={view.signedAt} steps={offerSteps} fetchUrl={freshUrl} downloadLabel="Download signed copy" />
          </section>
          {pay?.required && pay.payment && <div ref={paymentCard}><PaymentCard pay={pay} note={payNote} busy={paying} showPay={showPay} afterSigning polling={polling} coeLabel={coeLabel} onPay={() => void payNow()} /></div>}
          {offerState?.mismatch && !paid && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">A payment was received that does not match the deposit on your offer. Our admissions team will contact you.</p>}
        </> : <>
          {complete ? <section className={card}>
            <SigningDone testId="signing-complete" signedAt={view.signedAt} fetchUrl={freshUrl} downloadLabel="Download signed copy"
              message={kind === "referee" ? (justSigned ? "Thank you. Your reference has been submitted." : "This reference has been signed and submitted.")
                : justSigned ? "Thank you. The document is signed and complete." : "This document is complete: everyone required has signed."}
              note="A copy is also emailed to every signer." steps={kind === "referee" ? refereeSteps : undefined} />
          </section> : mine ? <section className={card}>
            <SigningDone testId="signing-mine" signedAt={view.recipient.signed_at ?? null} message={justSigned ? "Thank you, your signature is recorded." : "You have signed this document."}
              note="It will be complete when everyone required has signed, and a copy will be emailed to you then." />
          </section>
            : offer ? <p className={`${card} text-sm text-foreground-700`}>Hello {view.recipient.name}. Read every page of your offer letter. Your initials go on every page, your signature and the date in the signature block, and you answer whether you elect to pay more than the required pre-paid fee. Then confirm the code we email you and sign at the bottom.{hasPayment || offerState?.hasPayment ? ` Your offer is accepted as soon as you sign; the ${depositLabel} initial deposit is paid by card on this page afterwards.` : ""}</p>
            : view.onboarding ? <p className={`${card} text-sm text-foreground-700`} data-testid="onboarding-intro">Hello {view.recipient.name}. These are the agent onboarding documents for <strong>{view.onboarding.agencyName}</strong>: the Agent Application Form (pages 1 to {view.onboarding.formPages}) and the Agent Agreement (from page {view.onboarding.formPages + 1}). What we already hold is printed. Fill in the highlighted fields, answer each Yes / No question, give two references, then sign once at the bottom: your signature goes on both documents.</p>
            : <p className={`${card} text-sm text-foreground-700`}>Hello {view.recipient.name}. You are signing as <strong>{view.recipient.role}</strong>. Read the complete document, fill in the highlighted fields, then sign at the bottom.</p>}
          {view.message && !mine && !complete && <p className="whitespace-pre-wrap rounded-xl border border-background-200 bg-white p-3 text-sm"><span className="font-semibold">Message from the sender: </span>{view.message}</p>}
          {view.signers.length > 1 && <ol className="flex flex-wrap gap-2 text-xs" aria-label="Signers">{view.signers.map((s, i) => <li key={i} className={`rounded-full border bg-white px-3 py-1 ${s.me ? "border-primary-500 font-semibold" : "border-background-300"}`}>
            {s.role}: {s.me ? "you" : s.name} · {RECIPIENT_STATE[s.state] ?? s.state}{s.required ? "" : " (optional)"}</li>)}</ol>}
          {/* A payment due before signing sits above the document, where it is needed first; one due after signing (the deposit) comes after the signature. */}
          {pay?.required && pay.payment && !afterSigning && <div ref={paymentCard}><PaymentCard pay={pay} note={payNote} busy={paying} showPay={showPay} afterSigning={false} polling={polling} coeLabel={coeLabel} onPay={() => void payNow()} /></div>}

          {/* The document: full width, page count, zoom, the signer's fields drawn on the pages. */}
          <section className="overflow-hidden rounded-xl border border-background-200 bg-white" aria-label="Document">
            <div className="flex flex-wrap items-center gap-2 border-b border-background-200 px-3 py-2 sm:px-4">
              <i className="ri-file-text-line text-base text-foreground-500" aria-hidden="true" />
              <span className="text-sm font-medium text-foreground-900">{offer ? "Offer letter" : view.onboarding ? "Application form and agreement" : "Document"}</span>
              {pages > 0 && <span className="text-xs text-foreground-500" data-testid="page-count">{pages} page{pages === 1 ? "" : "s"}</span>}
              <div className="ml-auto flex items-center gap-1" role="group" aria-label="Zoom">
                <button type="button" aria-label="Zoom out" disabled={zoom <= ZOOMS[0]} onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)])} className="flex h-8 w-8 items-center justify-center rounded-md border border-background-300 text-foreground-700 hover:bg-background-100 disabled:opacity-40"><i className="ri-zoom-out-line" aria-hidden="true" /></button>
                <span className="w-12 text-center text-xs tabular-nums text-foreground-700" aria-live="polite" data-testid="zoom-level">{Math.round(zoom * 100)}%</span>
                <button type="button" aria-label="Zoom in" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)])} className="flex h-8 w-8 items-center justify-center rounded-md border border-background-300 text-foreground-700 hover:bg-background-100 disabled:opacity-40"><i className="ri-zoom-in-line" aria-hidden="true" /></button>
              </div>
              <button type="button" className="cursor-pointer text-xs font-medium text-primary-700 underline underline-offset-2" onClick={() => void openPdf()} data-testid="open-pdf">Open PDF</button>
            </div>
            <div className="bg-background-100 p-2 sm:p-4">
              <PdfPages source={view.url} zoom={zoom} onLoaded={setPages} overlay={(page) => canSign ? view.fields.filter((f) => f.page === page).map((f) => {
                const style = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
                const lacking = missing.some((m) => m.id === f.id);
                const frame = canvasFrame(lacking);
                if (auto(f)) return <div key={f.id} data-field={f.id} data-auto-field="true" title={AUTO_TITLE} aria-label={`${f.label}: ${AUTO_TITLE}`}
                  className="absolute flex cursor-not-allowed items-center gap-1 overflow-hidden rounded-sm border-2 border-dashed border-background-400 bg-background-200/80 px-1 text-2xs text-foreground-500 sm:text-xs" style={style}>
                  {f.type === "checkbox" ? <input type="checkbox" disabled aria-hidden="true" className="h-3 w-3" /> : null}<span className="truncate">{f.label}</span></div>;
                // The contact's title on the Agent Application Form is chosen from a list (Mr, Mrs, Ms, Miss, Dr, Other).
                if (f.type === "text" && f.key === "contact_title") return <SearchableSelect key={f.id} data-field={f.id} aria-label={f.label || "Title"} value={values[f.id] ?? ""}
                  onChange={(e) => setText(f, e.target.value)} className={`${frame} px-1 text-base leading-none sm:text-sm`} style={style} data-testid="contact-title">
                  <option value="">Title…</option>{F04_TITLES.map((t) => <option key={t} value={t}>{t}</option>)}</SearchableSelect>;
                if (f.type === "text") return <input key={f.id} data-field={f.id} aria-label={f.label || "Text field"} placeholder={f.label || "Type here"} value={values[f.id] ?? ""} maxLength={500}
                  onChange={(e) => setText(f, e.target.value)} className={`${frame} px-1 text-base leading-none sm:text-sm`} style={style} />;
                if (f.type === "checkbox") return <label key={f.id} data-field={f.id} className={`${frame} flex cursor-pointer items-center justify-center`} style={style} title={f.label || "Checkbox"}>
                  <input type="checkbox" aria-label={f.label || "Checkbox"} checked={values[f.id] === "true"} onChange={(e) => setTick(f, e.target.checked)} className="h-full w-full cursor-pointer" /></label>;
                if (f.type === "choice") return <div key={f.id} data-field={f.id} role="radiogroup" aria-label={f.label} title={f.label} className={`${frame} flex items-stretch gap-0.5 p-0.5`} style={style}>
                  {(["YES", "NO"] as const).map((answer) => <button key={answer} type="button" role="radio" aria-checked={values[f.id] === answer} onClick={() => setChoice(f.id, answer)}
                    className={`flex-1 rounded-sm text-2xs font-semibold leading-none sm:text-xs ${values[f.id] === answer ? "bg-primary-600 text-white" : "bg-white/90 text-primary-800"}`}>{answer}</button>)}
                </div>;
                const text = f.type === "signature" ? (method === "typed" ? name || "Sign here" : picture ? "" : "Sign here") : f.type === "initials" ? initialsOf(name) || "Initials" : f.type === "name" ? name || "Your name" : "Date when you sign";
                return <button key={f.id} type="button" data-field={f.id} onClick={() => signPanel.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
                  className={`absolute flex items-center overflow-hidden rounded-sm border-2 border-dashed border-primary-500 bg-primary-50/70 px-1 text-left text-2xs font-semibold text-primary-800 sm:text-xs ${f.type === "signature" || f.type === "initials" ? "italic" : ""}`} style={style}>
                  {f.type === "signature" && method !== "typed" && picture ? <img src={`data:image/png;base64,${picture}`} alt="Your signature" className="max-h-full max-w-full" /> : <span className="truncate">{text}</span>}</button>;
              }) : null} />
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-background-200 px-3 py-2 text-xs sm:px-4">
              <button type="button" className="text-foreground-700 underline underline-offset-2" onClick={() => void load()}>Refresh the document</button>
              {canSign && missing.length > 0 && <span className="text-red-700">{missing.length} required field{missing.length === 1 ? "" : "s"} still need{missing.length === 1 ? "s" : ""} an answer.{" "}
                <button type="button" className="font-semibold underline" onClick={() => goTo(missing[0].id)} data-testid="next-field">Go to the next one</button></span>}
            </div>
          </section>

          {canSign && <form ref={signPanel} className={`${card} space-y-5`} onSubmit={(e) => { e.preventDefault(); void sign(); }} aria-labelledby="sign-heading">
            <h2 id="sign-heading" className="font-heading text-lg font-semibold text-foreground-950">{offer ? "Sign your offer letter" : "Sign this document"}</h2>
            {tokenLabels.length > 0 && <fieldset className="space-y-3 rounded-lg border border-background-200 bg-background-50 p-3" data-testid="signer-details">
              <legend className="px-1 text-sm font-semibold">Details to fill in</legend>
              <p className="text-sm text-foreground-600">These go into the document wherever they appear. Answer each one before you sign.</p>
              {tokenLabels.map((label) => { const name = tokenFieldName(label); const lacking = !answerOf(label).trim(); return <Field key={label} label={name} required>
                <TextInput value={answerOf(label)} maxLength={500} aria-invalid={lacking} data-testid={`detail-${name.replace(/\s+/g, "-").toLowerCase()}`} className="!text-base"
                  onChange={(e) => { const first = view!.fields.find((f) => f.label === label)!; setText(first, e.target.value); }} /></Field>; })}
            </fieldset>}
            {choices.length > 0 && <fieldset className="space-y-2 rounded-lg border border-background-200 bg-background-50 p-3" data-testid="offer-choices">
              <legend className="px-1 text-sm font-semibold">Your answer</legend>
              {choices.map((f) => <div key={f.id} className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-foreground-800">{f.label}<span className="text-red-600"> *</span></span>
                <div role="radiogroup" aria-label={f.label} className="flex gap-2">{(["YES", "NO"] as const).map((answer) =>
                  <label key={answer} className={`flex cursor-pointer items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium ${values[f.id] === answer ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-white"}`}>
                    <input type="radio" name={`choice-${f.id}`} value={answer} checked={values[f.id] === answer} onChange={() => setChoice(f.id, answer)} className="sr-only" data-testid={`choice-${answer.toLowerCase()}`} />{answer}</label>)}</div>
              </div>)}
            </fieldset>}
            {application.error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm" data-testid="application-error">{application.error}</p>}
            {application.warnings.map((w) => <p key={w} role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm" data-testid="application-warning">{w}</p>)}
            {missing.length > 0 && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">{missing.length} required field{missing.length === 1 ? "" : "s"} in the document still need{missing.length === 1 ? "s" : ""} an answer.{" "}
              <button type="button" className="font-semibold underline" onClick={() => goTo(missing[0].id)}>Go to the next one</button></p>}
            <Field label="Your full name" required><TextInput value={name} onChange={(e) => setName(e.target.value)} required maxLength={150} autoComplete="name" className="!text-base" /></Field>
            <div>
              <p className="mb-2 text-label font-medium text-foreground-800">Your signature</p>
              <div role="tablist" className="mb-3 flex flex-wrap gap-2">{([["typed", "Type"], ["drawn", "Draw"], ["uploaded", "Upload a picture"]] as const).map(([id, label]) =>
                <button key={id} type="button" role="tab" aria-selected={method === id} onClick={() => { setMethod(id); setPicture(null); }}
                  className={`rounded-full border px-4 py-2 text-sm font-medium ${method === id ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-white"}`}>{label}</button>)}</div>
              {method === "typed" && <p className="min-h-16 rounded-md border border-background-300 bg-background-50 px-4 py-3 text-2xl italic text-[#0d1a4d]" data-testid="typed-signature">{name || "Your name appears here as your signature"}</p>}
              {method === "drawn" && <SignaturePad onChange={setPicture} />}
              {method === "uploaded" && <div className="space-y-2">
                <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Signature picture" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; void pictureToPng(file).then((png) => { setPicture(png); setError(""); }).catch((err: Error) => { setPicture(null); setError(err.message); }); }} />
                {picture && <img src={`data:image/png;base64,${picture}`} alt="Your signature" className="max-h-24 rounded border border-background-300 bg-white p-1" />}</div>}
            </div>
            <label className="flex items-start gap-3"><input type="checkbox" required checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1 h-5 w-5 shrink-0" data-testid="consent" /><span className="text-sm">{view.consent}</span></label>
            {view.requireCode && (codeSession
              ? <p role="status" className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm" data-testid="code-verified"><i className="ri-shield-check-line text-base text-emerald-700" aria-hidden="true" />Your email is confirmed. You can sign now.</p>
              : <CodeCheck token={token} to={view.codeTo} onVerified={setCodeSession} />)}
            {payFirst && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm" data-testid="pay-first">This document needs the payment of {moneyLabel(pay!.payment!.amountCents, pay!.payment!.currency)} before it can be signed.{" "}
              <button type="button" className="font-semibold underline" onClick={() => paymentCard.current?.scrollIntoView({ behavior: "smooth", block: "center" })}>Go to the payment</button></p>}
            <div className="hidden flex-wrap items-center gap-3 sm:flex">
              <Button type="submit" disabled={busy || !ready} data-testid="sign-submit">{busy ? "Please wait…" : payFirst ? "Pay first to sign" : offer ? "Sign and accept offer" : "Sign document"}</Button>
              {!offer && <Button type="button" variant="outline" disabled={busy} onClick={() => setDeclining(true)}>Decline to sign</Button>}
              {!ready && !busy && <span className="text-xs text-foreground-500" data-testid="sign-reason">{payFirst ? "Pay first." : !agreed ? "Tick the agreement to sign." : missing.length ? "Answer the required fields." : view.requireCode && !codeSession ? "Confirm the emailed code." : !signatureReady ? "Add your signature." : ""}</span>}
            </div>
            {offer && <p className="text-xs text-foreground-500">Questions about your offer, or want to decline it? Reply to the offer email to contact our admissions team.</p>}
          </form>}
          {/* A payment due after signing on an ordinary document: below the signature, once signed. */}
          {!offer && pay?.required && pay.payment && afterSigning && <div ref={paymentCard}><PaymentCard pay={pay} note={payNote} busy={paying} showPay={showPay} afterSigning polling={polling} coeLabel={coeLabel} onPay={() => void payNow()} /></div>}
          {declining && <div className={`${card} space-y-3`} role="dialog" aria-label="Decline to sign">
            <p className="font-semibold">Decline to sign this document?</p>
            <p className="text-sm text-foreground-600">The sender is told and your link stops working. You can say why (optional).</p>
            <TextArea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} aria-label="Reason for declining" className="!text-base" />
            <div className="flex flex-wrap gap-3"><Button type="button" variant="danger" disabled={busy} onClick={() => void decline()}>Yes, decline</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setDeclining(false)}>Go back</Button></div>
          </div>}
        </>}
      </> : !error && <p role="status" className={`${card} flex items-center gap-2 text-sm text-foreground-600`}><i className="ri-loader-4-line animate-spin text-base text-primary-600" aria-hidden="true" />Opening your document…</p>}
    </div>
    {/* Phone: the one next action stays in reach at the bottom of the screen. */}
    {hasBottomBar && <div className="fixed inset-x-0 bottom-0 z-10 flex gap-2 border-t border-background-200 bg-white p-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] sm:hidden" data-testid="bottom-bar">
      {canSign ? (ready ? <Button type="button" className="flex-1" disabled={busy} onClick={() => void sign()}>{busy ? "Please wait…" : offer ? "Sign and accept" : "Sign document"}</Button>
        : payFirst ? <Button type="button" className="flex-1" disabled={paying} onClick={() => showPay ? void payNow() : paymentCard.current?.scrollIntoView({ behavior: "smooth", block: "center" })}>{paying ? "Please wait…" : showPay ? "Pay now to sign" : "Pay first to sign"}</Button>
        : <Button type="button" className="flex-1" onClick={() => missing.length ? goTo(missing[0].id) : signPanel.current?.scrollIntoView({ behavior: "smooth" })}>{missing.length ? `Fill in ${missing.length} field${missing.length === 1 ? "" : "s"}` : "Go to signature"}</Button>)
        : showPay && !paid ? <Button type="button" className="flex-1" disabled={paying || polling} onClick={() => void payNow()}>{paying ? "Please wait…" : polling ? "Confirming payment…" : `Pay ${depositLabel}`}</Button>
        : <a className="inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-primary-500 px-4 py-2 text-sm font-medium text-background-50" href={view!.url} download><i className="ri-download-line" aria-hidden="true" />Download signed copy</a>}
      {canSign && !offer && <Button type="button" variant="outline" disabled={busy} onClick={() => setDeclining(true)}>Decline</Button>}
    </div>}
  </main>;
}
