import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import PdfPages from "@/components/signing/PdfPages";
import SignatureField, { SignatureImage, type SignatureValue } from "@/components/assessment/SignatureField";
import { asmSign, keepSignature, mySignature } from "@/lib/assessment/api";
import { ACKNOWLEDGEMENT_TEXT } from "@/lib/assessment/studentFlow";
import { buildStampedPdf, downloadOutput, loadPdfAttempt } from "@/lib/assessment/pdfTemplate/api";
import { reviewName } from "@/lib/assessment/pdfTemplate/student";
import type { PdfBundle } from "@/lib/assessment/pdfTemplate/output";

/**
 * ASM-PDF-TEMPLATE phase 3: the student's view of a submitted attempt on a workbook PDF (replaces the old results view for these
 * assessments): its state, once released the marks with the trainer's comments and the overall result, the acknowledgement signed
 * with the summary sheet's own wording, and the workbook with everything printed in place (drawn from the submission snapshot).
 */
const CARD = "rounded-2xl border border-background-200 bg-white p-4 sm:p-5";
const PRIMARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-background-300 bg-white px-4 py-2.5 text-sm font-semibold text-foreground-800 hover:border-primary-300 disabled:opacity-50";

export default function PdfResults({ attemptId, unit, receipt, otherAttempts, nextOpen }: {
  attemptId: string; unit: string; receipt: string | null; otherAttempts: { id: string; attemptNo: number; state: string }[]; nextOpen: boolean;
}) {
  const [bundle, setBundle] = useState<PdfBundle | null>(null);
  const [error, setError] = useState("");
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [drawing, setDrawing] = useState(false);
  const load = async () => { try { setBundle(await loadPdfAttempt(attemptId)); } catch (e) { setError(e instanceof Error ? e.message : "The result did not load."); } };
  useEffect(() => { setBundle(null); setPdf(null); void load(); }, [attemptId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>;
  if (!bundle) return <p role="status" className="p-6 text-sm text-foreground-600">Loading your result…</p>;
  const a = bundle.attempts.find((x) => x.attemptNo === bundle.attemptNo)!;
  const released = a.state === "returned" || a.state === "final";
  const t = bundle.template;
  const competent = a.outcome === "S";
  const show = async () => { setDrawing(true); try { setPdf(await buildStampedPdf(bundle, { trainer: released })); } catch (e) { setError(e instanceof Error ? e.message : "The workbook could not be drawn."); } finally { setDrawing(false); } };
  const download = async () => {
    if (!a.output) return;
    const bytes = await downloadOutput(a.output.path);
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "application/pdf" }));
    const link = document.createElement("a"); link.href = url; link.download = `${unit.replace(/\W+/g, "-")}-attempt-${a.attemptNo}.pdf`; link.click();
  };

  return <div className="mx-auto max-w-4xl space-y-4 pb-16" data-testid="pdf-results">
    <div className={CARD}>
      <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">{unit} · attempt {a.attemptNo}</p>
      {released ? <>
        <p className={`mt-1 font-heading text-2xl font-bold ${competent ? "text-green-700" : "text-amber-800"}`} data-testid="overall-outcome">{competent ? "Competent" : "Not Yet Competent"}</p>
        {a.overallFeedback ? <p className="mt-1 whitespace-pre-wrap text-sm text-foreground-800">{a.overallFeedback}</p> : null}
        {a.signoff ? <p className="mt-2 text-xs text-foreground-500">Signed off by {a.signoff.signerName} on {new Date(a.signoff.signedAt).toLocaleDateString("en-AU")}</p> : null}
        {a.state === "returned" && nextOpen ? <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="resubmit">
          Your trainer has returned this attempt for resubmission. Attempt {a.attemptNo + 1} is open with your answers filled in. <Link to="?" className="font-semibold underline">Open attempt {a.attemptNo + 1}</Link></div> : null}
      </> : <p className="mt-1 text-sm text-foreground-800" data-testid="submitted"><i className="ri-time-line mr-1 text-primary-600" aria-hidden="true" />Submitted{a.submittedAt ? ` on ${new Date(a.submittedAt).toLocaleDateString("en-AU")}` : ""}{receipt ? ` · receipt ${receipt}` : ""}. Your trainer is marking it.</p>}
      {a.snapshot ? <p className="mt-2 font-mono text-2xs text-foreground-400">Submission snapshot SHA-256 {a.snapshot.hash}</p> : null}
    </div>

    {released ? <div className={CARD} data-testid="result-marks">
      {t.tasks.map((tk) => {
        const r = a.taskResults.find((x) => x.taskId === tk.number);
        return <section key={tk.number} className="mb-4 last:mb-0">
          <div className="flex items-start justify-between gap-2"><h2 className="font-heading text-base font-semibold text-foreground-950">Task {tk.number} · {tk.title}</h2>
            {r?.outcome ? <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${r.outcome === "S" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-900"}`}>{r.outcome === "S" ? "Satisfactory" : "Not satisfactory"}</span> : null}</div>
          {r?.feedback ? <p className="mt-1 whitespace-pre-wrap text-sm text-foreground-700">{r.feedback}</p> : null}
          <ul className="mt-2 divide-y divide-background-100">{t.questions.filter((q) => String(q.task) === tk.number).map((q) => { const m = a.results.find((x) => x.questionId === q.key && !x.criterionId); return <li key={q.key} className="flex items-start gap-3 py-2 text-sm">
            <span className="w-28 shrink-0 font-semibold text-foreground-900">{reviewName(t, q)}</span>
            <span className="min-w-0 flex-1 text-foreground-700"><span className="line-clamp-1">{q.label}</span>{m?.feedback ? <span className="mt-0.5 block whitespace-pre-wrap text-foreground-600">{m.feedback}</span> : null}</span>
            {m?.outcome ? <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${m.outcome === "S" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-900"}`}>{m.outcome === "S" ? "Yes" : "No"}</span> : null}
          </li>; })}</ul>
        </section>;
      })}
    </div> : null}

    {released ? <Acknowledge attemptId={a.id} signed={a.acknowledgement} onDone={load} /> : null}

    <div className={`${CARD} space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-heading text-base font-semibold text-foreground-950">Your workbook</h2>
        <div className="flex gap-2">
          {a.output ? <button type="button" className={SECONDARY} onClick={() => void download()} data-testid="download-final">Download the final PDF</button> : null}
          {!pdf ? <button type="button" className={SECONDARY} disabled={drawing} onClick={() => void show()} data-testid="show-workbook">{drawing ? "Drawing…" : "Show my workbook"}</button> : null}
        </div></div>
      <p className="text-xs text-foreground-500">{released ? "Your answers, your trainer's marks and the signatures, printed on the workbook." : "Your answers as you submitted them, printed on the workbook."}{a.output ? ` The final PDF was stored at sign-off (SHA-256 ${a.output.pdfSha256.slice(0, 16)}…).` : ""}</p>
      {pdf ? <div className="rounded-xl bg-background-200 p-2" data-testid="stamped-workbook"><PdfPages source={pdf} maxWidth={820} lazy /></div> : null}
    </div>
    {otherAttempts.length ? <p className="text-sm text-foreground-600">Other attempts: {otherAttempts.map((x) => <Link key={x.id} to={`?results=${x.id}`} className="mr-2 underline">Attempt {x.attemptNo}</Link>)}</p> : null}
  </div>;
}

function Acknowledge({ attemptId, signed, onDone }: { attemptId: string; signed: PdfBundle["attempts"][number]["acknowledgement"]; onDone: () => Promise<void> }) {
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [value, setValue] = useState<SignatureValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { void mySignature().then((s) => setSaved(s.signaturePng)); }, []);
  const sign = async (v: SignatureValue | null) => {
    setBusy(true); setErr("");
    try { await asmSign(attemptId, "student_acknowledgement", v ? v.method : "saved", v?.png ?? null, ACKNOWLEDGEMENT_TEXT); if (v) await keepSignature({ ...v, keep: true }); await onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Not signed."); } finally { setBusy(false); }
  };
  return <div className={`${CARD} space-y-3`} data-testid="acknowledge">
    <h2 className="font-heading text-base font-semibold text-foreground-950">Acknowledge your result</h2>
    <blockquote className="rounded-lg border-l-4 border-primary-300 bg-background-50 px-3 py-2 text-sm text-foreground-800">{ACKNOWLEDGEMENT_TEXT}</blockquote>
    {signed ? <div className="rounded-xl border border-green-200 bg-green-50 p-3" data-testid="acknowledged"><p className="text-sm font-semibold text-green-800">Signed by {signed.signerName} on {new Date(signed.signedAt).toLocaleDateString("en-AU")}</p>
      <SignatureImage png={signed.signaturePng} name={signed.signerName} className="mt-1" /><p className="mt-1 text-xs text-green-800">Printed on the summary sheet for this attempt.</p></div>
      : saved ? <div className="flex flex-wrap items-center gap-3"><SignatureImage png={saved} className="rounded-lg border border-background-200 bg-white px-2" />
          <button type="button" className={PRIMARY} disabled={busy} onClick={() => void sign(null)} data-testid="acknowledge-sign">{busy ? "Signing…" : "Sign"}</button></div>
        : saved === null ? <><SignatureField value={value} onChange={setValue} label="Your signature" allowSave={false} /><button type="button" className={PRIMARY} disabled={!value || busy} onClick={() => void sign(value)} data-testid="acknowledge-sign">Sign</button></> : null}
    {err ? <p role="alert" className="text-sm text-red-700">{err}</p> : null}
  </div>;
}
