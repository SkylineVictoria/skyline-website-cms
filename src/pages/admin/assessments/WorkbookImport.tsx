/**
 * ASM-IMPORT: "Start from a Word or PDF workbook" in the New assessment dialog. The file is read in the browser (Word through
 * mammoth's HTML, PDF through pdf.js text with positions) and mapped by `buildFromLines` to a DRAFT definition + assessor keys;
 * nothing is uploaded and nothing reaches students until the admin reviews the draft in the builder and publishes it.
 */
import { useState } from "react";
import { Badge } from "@/pages/admin/components/ui";
import type { ImportResult } from "@/lib/assessment/workbookImport";
import { readWorkbook } from "@/lib/assessment/workbookFile";

/** What the import found, shown in the dialog before Create. */
export function WorkbookSummary({ result }: { result: ImportResult }) {
  const s = result.stats;
  const type = (id: string, label: string) => (s.byType[id] ? <li key={id}>{s.byType[id]} {label}</li> : null);
  return (
    <div className="space-y-2 rounded-md border border-background-200 bg-background-100 p-3 text-sm" role="status">
      <p className="font-medium text-foreground-900">{result.title}{result.unitCode ? <span className="ml-2 text-xs text-foreground-600">{result.unitCode}</span> : null}{result.assessorVersion ? <span className="ml-2"><Badge tone="accent">Assessor version</Badge></span> : null}</p>
      <p className="text-foreground-700">{s.tasks} task{s.tasks === 1 ? "" : "s"} · {s.sections} section{s.sections === 1 ? "" : "s"} · {s.topLevelQuestions} questions ({s.questions} with their parts)</p>
      <ul className="grid list-disc gap-x-6 pl-5 text-xs text-foreground-700 sm:grid-cols-2">
        {type("long_answer", "long answers")}{type("short_answer", "short answers")}{type("case_study", "questions with several boxes")}{type("table_grid", "tables to fill in")}
        {type("single_choice", "single choice")}{type("multi_choice", "multiple choice")}{type("true_false", "yes / no")}{type("file_upload", "upload-only")}
        {type("observation_checklist", "observation checklists (assessor)")}{type("declaration", "declarations")}{type("instruction", "instruction blocks")}
      </ul>
      <p className="text-xs text-foreground-700">{s.attachments} question{s.attachments === 1 ? "" : "s"} take attachments · {s.keys} model answer{s.keys === 1 ? "" : "s"} / guidance kept for assessors only</p>
      {s.lowConfidence ? <p className="text-xs font-medium text-amber-900"><i className="ri-error-warning-line mr-1" aria-hidden="true" />{s.lowConfidence} item{s.lowConfidence === 1 ? "" : "s"} marked "check this" in the builder.</p> : null}
      {result.warnings.map((w) => <p key={w} className="text-xs text-foreground-700">{w}</p>)}
      <p className="text-xs text-foreground-600">Create opens it as a draft in the builder: check it, then publish. Students see nothing until then.</p>
    </div>
  );
}

/** The file picker; calls back with the parsed workbook. */
export function WorkbookPicker({ onParsed }: { onParsed: (r: ImportResult | null, error?: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  return (
    <label className={`flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-background-300 px-3 py-3 text-sm text-foreground-700 hover:bg-background-100 ${busy ? "pointer-events-none opacity-60" : ""}`}>
      <i className="ri-file-upload-line text-lg" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{busy ? "Reading the workbook…" : name || "Choose the student workbook (.docx or .pdf); an assessor version puts its model answers in the assessor-only keys"}</span>
      <input type="file" className="hidden" accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
        setBusy(true); setName(f.name); onParsed(null);
        try { onParsed(await readWorkbook(f)); }
        catch (err) { onParsed(null, err instanceof Error ? err.message : "The workbook could not be read."); }
        finally { setBusy(false); }
      }} />
    </label>
  );
}
