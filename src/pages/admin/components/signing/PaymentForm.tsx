import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Field, Select, TextInput } from "../ui";
import PaymentBadge from "./PaymentBadge";
import { formatMoney, paymentDraft, paymentEditable, paymentOfRecord, paymentSet, signingAdmin, validatePayment, PAYMENT_TIMING, type PaymentDraft, type PaymentInput, type PaymentTiming, type SigningPayment } from "@/lib/signingApi";

/**
 * The one payment form of Documents & Signatures: the template editor, the compose dialog, the request detail and the Place fields
 * sidebar all edit the same four values (amount in dollars, currency, description, due before or after signing) and send them to
 * signing_admin `payment_set` (requests) or inside `template_save` (templates). The value helpers live in src/lib/signingApi.ts.
 */
const TIMINGS = Object.keys(PAYMENT_TIMING) as PaymentTiming[];

/** The four inputs. `compact` stacks them (the Place fields sidebar); otherwise they sit in one row on wide screens. */
export function PaymentFields({ value, onChange, disabled = false, compact = false, testId = "payment" }: {
  value: PaymentDraft; onChange: (next: PaymentDraft) => void; disabled?: boolean; compact?: boolean; testId?: string;
}) {
  const set = (patch: Partial<PaymentDraft>) => onChange({ ...value, ...patch });
  return <div className={compact ? "grid gap-3" : "grid gap-3 md:grid-cols-4"} data-testid={`${testId}-fields`}>
    <Field label="Amount" required hint="In dollars, at least 0.50"><TextInput type="number" min={0.5} max={999999.99} step={0.01} inputMode="decimal" value={value.amount} disabled={disabled} onChange={(e) => set({ amount: e.target.value })} data-testid={`${testId}-amount`} /></Field>
    <Field label="Currency" hint="3-letter code"><TextInput value={value.currency} maxLength={3} disabled={disabled} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} data-testid={`${testId}-currency`} /></Field>
    <Field label="Due"><Select value={value.timing} disabled={disabled} onChange={(e) => set({ timing: e.target.value === "after_sign" ? "after_sign" : "before_sign" })} data-testid={`${testId}-timing`}>
      {TIMINGS.map((timing) => <option key={timing} value={timing}>{PAYMENT_TIMING[timing]}</option>)}</Select></Field>
    <Field label="Description" hint="Shown at checkout; the document title if empty."><TextInput value={value.description} maxLength={250} disabled={disabled} onChange={(e) => set({ description: e.target.value })} data-testid={`${testId}-description`} /></Field>
  </div>;
}

/**
 * The payment of one request (or of the request being composed): what it is, with Add / Edit / Remove and a Save / Cancel form.
 * `onSave` receives the checked values, or null to remove; it may throw, and the message is shown.
 */
export function PaymentPanel({ current, status, title, editable, busy = false, compact = false, children, testId = "payment-panel", onSave }: {
  current: PaymentInput | null; status?: SigningPayment | null; title: string; editable: boolean; busy?: boolean; compact?: boolean; children?: ReactNode; testId?: string;
  onSave: (next: PaymentInput | null) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PaymentDraft>(() => paymentDraft(current, title));
  const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const blocked = busy || saving;
  const run = async (next: PaymentInput | null) => {
    if (blocked) return;
    setSaving(true); setError("");
    try { await onSave(next); setEditing(false); } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setSaving(false); }
  };
  const save = () => { let next: PaymentInput; try { next = validatePayment(draft); } catch (e) { setError(e instanceof Error ? e.message : "Check the payment."); return; } void run(next); };
  const begin = () => { setDraft(paymentDraft(current, title)); setError(""); setEditing(true); };
  const heading = <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">Payment</h3>{status && <PaymentBadge payment={status} />}</div>;
  return <section className={`space-y-3 rounded-md border border-background-300 p-3 text-sm ${compact ? "" : ""}`} data-testid={testId} data-editing={editing || undefined}>
    {heading}
    {editing ? <>
      <PaymentFields value={draft} onChange={setDraft} disabled={blocked} compact={compact} testId={testId} />
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={blocked} onClick={save} data-testid={`${testId}-save`}>{saving ? "Saving…" : "Save"}</Button>
        <Button size="sm" variant="outline" disabled={blocked} onClick={() => { setEditing(false); setError(""); }} data-testid={`${testId}-cancel`}>Cancel</Button>
      </div>
    </> : <>
      {current
        ? <p data-testid={`${testId}-summary`}><span className="font-semibold">{formatMoney(Math.round(current.amount * 100), current.currency)}</span> · {PAYMENT_TIMING[current.timing]}{current.description.trim() ? ` · ${current.description.trim()}` : ""}</p>
        : <p className="text-foreground-600" data-testid={`${testId}-none`}>No payment is asked for this document.</p>}
      {children}
      {error && <p role="alert" className="text-red-700">{error}</p>}
      {editable && <div className="flex flex-wrap gap-2">
        {current ? <>
          <Button size="sm" variant="outline" disabled={blocked} onClick={begin} data-testid={`${testId}-edit`}>Edit</Button>
          <Button size="sm" variant="ghost" disabled={blocked} onClick={() => void run(null)} data-testid={`${testId}-remove`}>{saving ? "Removing…" : "Remove"}</Button>
        </> : <Button size="sm" variant="outline" icon="ri-bank-card-line" disabled={blocked} onClick={begin} data-testid={`${testId}-add`}>Add payment</Button>}
      </div>}
    </>}
  </section>;
}

/** The Place fields sidebar: reads the request's payment with `payment_get` when it opens and saves with `payment_set`; it never touches the fields or the PDF. */
export function RequestPaymentPanel({ requestId, title, requestStatus, compact = false, onChanged }: { requestId: string; title: string; requestStatus: string; compact?: boolean; onChanged?: () => void }) {
  const [payment, setPayment] = useState<SigningPayment | null | undefined>(undefined);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setPayment((await signingAdmin<{ payment: SigningPayment | null }>("payment_get", requestId)).payment ?? null); setError(""); }
    catch (e) { setPayment(null); setError(e instanceof Error ? e.message : "The payment could not be loaded."); }
  }, [requestId]);
  useEffect(() => { void load(); }, [load]);
  if (payment === undefined) return <section className="rounded-md border border-background-300 p-3 text-sm" data-testid="request-payment-panel"><h3 className="font-semibold">Payment</h3><p role="status" className="text-foreground-600">Loading…</p></section>;
  return <PaymentPanel compact={compact} testId="request-payment-panel" current={paymentOfRecord(payment)} status={payment} title={title} editable={paymentEditable(requestStatus, payment)}
    onSave={async (next) => { const result = await paymentSet(requestId, next); setPayment(result?.payment ?? null); onChanged?.(); }}>
    {error && <p role="alert" className="text-red-700">{error}</p>}
  </PaymentPanel>;
}
