/**
 * The trainer's marking of one attempt (/staff/assessments/attempts/:id). Since ASM-PDF-TEMPLATE phase 4 every assessment is its
 * workbook PDF: the attempt is marked on the workbook (PdfMarking).
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { loadPdfAttempt } from "@/lib/assessment/pdfTemplate/api";
import type { PdfBundle } from "@/lib/assessment/pdfTemplate/output";
import PdfMarking from "./PdfMarking";

export default function MarkingPage() {
  const { id = "" } = useParams();
  const [state, setState] = useState<{ bundle: PdfBundle | null; error: string } | null>(null);
  useEffect(() => {
    let off = false; setState(null);
    void loadPdfAttempt(id).then((bundle) => { if (!off) setState({ bundle, error: bundle ? "" : "This attempt has no workbook PDF." }); })
      .catch((e) => { if (!off) setState({ bundle: null, error: e instanceof Error ? e.message : "The attempt did not load." }); });
    return () => { off = true; };
  }, [id]);
  if (!state) return <div className="min-h-screen bg-background-100 p-6 text-sm text-foreground-600">Loading the attempt…</div>;
  if (!state.bundle) return <div className="min-h-screen bg-background-100 p-6 text-sm"><p role="alert" className="text-red-800">{state.error}</p><Link to="/staff/assessments" className="mt-3 inline-block underline">Back to assessments</Link></div>;
  return <PdfMarking attemptId={id} initial={state.bundle} />;
}
