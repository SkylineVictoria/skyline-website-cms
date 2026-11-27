/**
 * Preview as learner (owner 2026-11-26): the admin walks through the student wizard of the draft (else the published version) on its
 * workbook PDF, exactly as a student sees it. Nothing is saved: answers and signatures stay in this dialog, Submit only says what
 * would happen, and closing it forgets everything.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import PdfWizard from "@/pages/agency/assessments/detail/PdfWizard";
import { mySignature } from "@/lib/assessment/api";
import { downloadWorkbook, loadTemplate, type PdfSignature } from "@/lib/assessment/pdfTemplate/api";
import type { PdfTemplate } from "@/lib/assessment/pdfTemplate/model";
import type { Responses } from "@/lib/assessment/types";

export default function LearnerPreview({ assessmentId, title, unit, onClose }: { assessmentId: string; title: string; unit: { code: string; name: string } | null; onClose: () => void }) {
  const [, setParams] = useSearchParams();
  const [tpl, setTpl] = useState<{ template: PdfTemplate; bytes: Uint8Array | null; versionNo: number | null; status: string | null } | null>(null);
  const [error, setError] = useState("");
  const [responses, setResponses] = useState<Responses>({});
  const [signatures, setSignatures] = useState<PdfSignature[]>([]);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let off = false;
    void loadTemplate(assessmentId).then(async (s) => {
      if (!s.template) { if (!off) setError("Upload the workbook PDF first: there is nothing to preview yet."); return; }
      if (!off) setTpl({ template: s.template, bytes: null, versionNo: s.versionNo, status: s.status });
      const bytes = await downloadWorkbook(s.template.pdf.path);
      if (!off) setTpl((cur) => (cur ? { ...cur, bytes } : cur));
    }).catch((e) => { if (!off) setError(e instanceof Error ? e.message : "The workbook could not be opened."); });
    return () => { off = true; };
  }, [assessmentId]);
  const close = () => { setParams((p) => { const n = new URLSearchParams(p); n.delete("step"); return n; }, { replace: true }); onClose(); };
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") close(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); });

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-background-100" role="dialog" aria-modal="true" aria-label={`Preview as learner · ${title}`} data-testid="learner-preview">
      <div className="flex items-center justify-between gap-3 border-b border-background-200 bg-white px-5 py-3">
        <div className="min-w-0">
          <p className="font-heading text-lg font-semibold text-foreground-950">Preview as learner</p>
          <p className="text-xs text-foreground-600">{tpl ? `${tpl.status === "draft" ? "Draft" : "Version"} v${tpl.versionNo ?? 1} · ` : ""}What a student sees</p>
        </div>
        <button type="button" onClick={close} className="min-h-[44px] rounded-md px-3 text-sm font-semibold text-foreground-700 hover:bg-background-200" data-testid="preview-close">Close preview</button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {error ? <p role="alert" className="text-sm text-primary-700">{error}</p> : null}
        {submitted ? <p role="status" className="mx-auto mb-3 max-w-6xl rounded-xl border border-green-300 bg-green-50 px-4 py-2 text-sm text-green-900" data-testid="preview-submitted">Preview only: a student would submit here. Nothing was saved or submitted.</p> : null}
        {tpl ? <PdfWizard template={tpl.template} pdfBytes={tpl.bytes} responses={responses} onChange={setResponses}
          savedLabel="Preview: nothing is saved" saveClass="text-foreground-500" dueLabel="Preview" busy={false} serverErrors={[]}
          signatures={signatures}
          onSign={async (slot, v, statement) => {
            const png = v?.png ?? (await mySignature().catch(() => ({ signaturePng: null }))).signaturePng ?? null;
            setSignatures((s) => [...s.filter((x) => x.slot !== slot), { slot, signerName: "Sample Student", method: v?.method ?? "saved", signaturePng: png, statement, signedAt: new Date().toISOString() }]);
          }}
          onSubmit={async () => { setSubmitted(true); window.scrollTo({ top: 0 }); }}
          record={{ studentName: "Sample Student", studentRef: "S0000000", studentEmail: "student@example.com", trainer: "Your trainer", unitCode: unit?.code ?? "", unitName: unit?.name ?? title, qualificationCode: "", qualificationName: "" }} />
          : !error ? <p role="status" className="text-sm text-foreground-600">Loading the workbook…</p> : null}
      </div>
    </div>
  );
}
