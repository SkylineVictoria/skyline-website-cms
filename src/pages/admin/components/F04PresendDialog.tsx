import { useCallback, useEffect, useMemo, useState } from "react";
import F04Wizard from "@/components/signing/F04Wizard";
import { answersOf, type F04Draft } from "@/components/signing/f04WizardLogic";
import { openPresend, savePresend, sendPresend, warmPresend, type PresendData, type PresendOpen, type SigningView } from "@/lib/signingApi";
import { useToast } from "@/pages/admin/components/toastContext";

/*
 * Prepare application (owner brief 2026-11-20): after Add business nothing is emailed. Staff open the Agent Application Form (F04) here in
 * the same wizard the agency admin uses (admin-prefill mode): every detail can be filled or edited (title, position, website, the rest),
 * every Yes / No question starts at No, the references stay empty. The last step takes the agreement's terms (commencement, territory,
 * commission) and optionally the SLIT witness (typed name + DRAWN signature, printed on the SLIT witness line; the agency admin gives their own witness on the form). Save draft keeps it; Send to point of contact emails ONE
 * request: the F04 followed by the P06, signed once by the agency admin.
 */
const REFERENCE = /^ref[12]_/;
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

export default function F04PresendDialog({ agencyId, agencyName, onClose, onSent }: {
  agencyId: string; agencyName: string; onClose: () => void;
  /** Sent: the business page reloads with the toast. */
  onSent: (message: string) => Promise<void> | void;
}) {
  const { push } = useToast();
  const [opened, setOpened] = useState<PresendOpen | null>(null);
  const [error, setError] = useState("");
  const [terms, setTerms] = useState({ commencementDate: "", territory: "", commissionPercent: "" });
  const [witness, setWitness] = useState<{ name: string; png: string | null }>({ name: "", png: null });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "send">("");
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const o = await openPresend(agencyId);
      // The merged application form + agreement blank is made ready in its own call, so Send only stamps it (CPU budget, 2026-11-20).
      void warmPresend().catch(() => undefined);
      setOpened(o); setTerms(o.terms); setWitness(o.witness); setMessage(o.message);
      setSavedNote(o.savedAt ? `Draft saved ${new Date(o.savedAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}${o.savedBy ? ` by ${o.savedBy}` : ""}` : null);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "The application could not be prepared."); }
  }, [agencyId]);
  useEffect(() => { void load(); }, [load]);

  const view = useMemo(() => {
    if (!opened) return null;
    return {
      id: opened.onboardingId ?? "", reference: "", title: `Agent application: ${agencyName}`, state: "draft", message: null, expiresAt: null, signedAt: null, consent: "", documentHash: "", url: "",
      recipient: { id: opened.contact?.id ?? "", name: opened.contact?.name ?? "", email: opened.contact?.email ?? "", role: "Business contact", state: "draft", signed_at: null },
      fields: opened.fields.map((f) => ({ ...f, x: 0, y: 0, w: 0, h: 0 })), signers: [], onboarding: { id: opened.onboardingId ?? "", kind: "application", agencyName, agencyId, formPages: 2 },
      application: { draft: null, facts: opened.facts, savedAt: null, prefill: { agent_acn: opened.acn, agent_marn: opened.marn }, filled: [], attachments: {}, correction: null },
    } as unknown as SigningView;
  }, [opened, agencyName, agencyId]);

  const dataOf = (state: F04Draft): PresendData => {
    const answers = Object.fromEntries(Object.entries(answersOf(view!.fields, state)).filter(([key, value]) => !REFERENCE.test(key) && key !== "agent_acn" && key !== "agent_marn" && String(value ?? "").trim()));
    return { answers, acn: state.acn, marn: state.marn.replace(/\s/g, ""), message: message.trim(), commencementDate: terms.commencementDate, territory: terms.territory.trim(),
      commissionPercent: terms.commissionPercent.trim(), witnessName: witness.name.trim(), witnessPng: witness.png };
  };
  // The SLIT witness is both a typed name and a drawn signature, or nothing (the approver can then add it).
  const witnessProblem = () => (witness.name.trim() && !witness.png) ? "The SLIT witness must draw their signature (it cannot be typed), or clear the SLIT witness."
    : (!witness.name.trim() && witness.png) ? "Type the SLIT witness's full name, or clear the SLIT witness." : null;
  const saveDraft = async (state: F04Draft) => {
    if (busy) return;
    const problem = witnessProblem();
    if (problem) { push(problem, "error"); return; }
    setBusy("save");
    try {
      const r = await savePresend(agencyId, dataOf(state));
      setSavedNote(`Draft saved ${new Date(r.savedAt).toLocaleTimeString("en-AU", { timeStyle: "short" })}`);
      push("Draft saved. Nothing has been emailed yet.");
    } catch (e) { push(e instanceof Error ? e.message : "The draft could not be saved.", "error"); }
    finally { setBusy(""); }
  };
  const send = async (state: F04Draft) => {
    if (busy) return;
    const problem = !isDate(terms.commencementDate) ? "Enter the agreement's commencement date (Item 5)." : !terms.territory.trim() ? "Enter the territory (Item 3)."
      : !/^\d{1,3}(\.\d{1,2})?$/.test(terms.commissionPercent.trim()) || Number(terms.commissionPercent) > 100 ? "Enter the commission as a percentage, for example 25." : witnessProblem();
    if (problem) { push(problem, "error"); return; }
    setBusy("send");
    try {
      const r = await sendPresend(agencyId, dataOf(state));
      await onSent(r.sent ? `Application form and agreement sent to ${r.agent?.email ?? opened?.contact?.email ?? "the point of contact"} (${r.reference}) to sign once.${r.slitWitness ? " The SLIT witness is printed on the agreement." : ""}`
        : r.warning ?? "The request was created but not emailed.");
    } catch (e) { push(e instanceof Error ? e.message : "The application could not be sent.", "error"); }
    finally { setBusy(""); }
  };

  if (error) return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-foreground-950/55 p-4" role="dialog" aria-modal="true">
    <div className="max-w-md rounded-xl bg-background-50 p-5 text-sm"><p role="alert" className="text-red-700" data-testid="presend-error">{error}</p>
      <button type="button" className="mt-3 rounded-md border border-background-300 px-3 py-1.5" onClick={onClose}>Close</button></div></div>;
  if (!opened || !view) return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-foreground-950/55" role="status"><span className="rounded-md bg-background-50 px-4 py-2 text-sm">Preparing the application…</span></div>;
  return <F04Wizard token="" view={view} mode="admin-prefill" codeCheck={{ needed: false, session: null, render: () => null }} onSigned={() => undefined}
    prefill={{ terms, onTerms: setTerms, witness, onWitness: setWitness, message, onMessage: setMessage, busy, contact: opened.contact, savedNote,
      onSaveDraft: (s) => void saveDraft(s), onSend: (s) => void send(s), onClose }} />;
}
