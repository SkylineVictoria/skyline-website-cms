import type { PdfTemplate, TemplateField } from "@/lib/assessment/pdfTemplate/model";
import { fieldValue, questionInputs, type PdfAnswers } from "@/lib/assessment/pdfTemplate/student";

/**
 * ASM-QUESTION-TEXT: a question's submitted answer, read-only (the trainer's marking view): text answers as written, tables as tables,
 * single fields and choices with their labels. Only the student's own fields of the question.
 */
export default function AnswerReadOnly({ template, questionKey, answers }: { template: PdfTemplate; questionKey: string; answers: PdfAnswers }) {
  const q = template.questions.find((x) => x.key === questionKey);
  const inputs = questionInputs(template, questionKey).filter((x) => x.kind === "table" || x.field.role === "student");
  const texts = inputs.filter((x) => x.kind === "text").length;
  const shownGroups = new Set<string>();
  if (!inputs.length) return <p className="text-base text-foreground-600">Nothing for the student to fill in here.</p>;
  return <div className="space-y-4" data-testid="student-answer">
    {inputs.map((inp) => {
      if (inp.kind === "table") return <div key={inp.table.id} className="overflow-x-auto" data-testid="answer-table-readonly">
        <table className="w-full min-w-[480px] border-collapse text-sm">
          <thead><tr>{inp.table.labelColumn ? <th className="border border-background-200 bg-background-100 px-2.5 py-2 text-left font-semibold text-foreground-800" scope="col"><span className="sr-only">Row</span></th> : null}
            {inp.table.columns.map((c, i) => <th key={i} scope="col" className="border border-background-200 bg-background-100 px-2.5 py-2 text-left font-semibold text-foreground-800">{c.label}</th>)}</tr></thead>
          <tbody>{inp.table.rows.map((r) => <tr key={r.id}>
            {inp.table.labelColumn ? <th scope="row" className="border border-background-200 bg-background-50 px-2.5 py-2 text-left align-top font-medium text-foreground-900">{r.label}</th> : null}
            {r.cells.map((c, i) => { const v = c ? fieldValue(answers, c) : ""; return <td key={i} className="whitespace-pre-wrap border border-background-200 px-2.5 py-2 align-top text-foreground-900">{v || <span className="text-foreground-400">—</span>}</td>; })}
          </tr>)}</tbody>
        </table>
      </div>;
      const f: TemplateField = inp.field;
      if ((f.kind === "yes_no" || f.kind === "rating") && f.group) {
        if (shownGroups.has(f.group)) return null;
        shownGroups.add(f.group);
        return <Row key={f.group} label={f.label} value={answers.pdfChoice?.[f.group] ?? ""} />;
      }
      if (f.kind === "checkbox") return <Row key={f.id} label={f.label} value={fieldValue(answers, f) === "true" ? "Ticked" : "Not ticked"} />;
      const label = inp.kind === "text" ? (f.label !== "Answer" ? f.label : texts > 1 && q && f.page !== q.header.page ? `Answer (page ${f.page})` : "") : f.label;
      const v = fieldValue(answers, f);
      return <div key={f.id}>
        {label ? <p className="mb-1 text-sm font-semibold text-foreground-800">{label}</p> : null}
        <div className="max-w-[70ch] whitespace-pre-wrap rounded-lg border border-background-200 bg-background-50 px-3.5 py-3 text-base leading-7 text-foreground-900">{v || <span className="italic text-foreground-500">Not answered</span>}</div>
      </div>;
    })}
  </div>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <p className="text-base text-foreground-900"><span className="font-semibold">{label}: </span>{value || <span className="italic text-foreground-500">Not answered</span>}</p>;
}
