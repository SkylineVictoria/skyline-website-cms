import { useEffect, useState } from "react";
import type { PdfDoc, PdfHandle } from "./pdfDoc";
import type { PdfTemplate, TemplateQuestion } from "@/lib/assessment/pdfTemplate/model";
import { pageInk, questionContent, questionTextRect, type PageInk, type QuestionContent } from "@/lib/assessment/pdfTemplate/questionText";

/** ASM-QUESTION-TEXT: each page of the workbook read once (text with fonts, pictures, rules), then each question from it. */
const inks = new WeakMap<PdfDoc, Map<number, Promise<PageInk>>>();
function inkOf(pdf: PdfHandle, page: number): Promise<PageInk> {
  let m = inks.get(pdf.doc);
  if (!m) { m = new Map(); inks.set(pdf.doc, m); }
  let p = m.get(page);
  if (!p) {
    p = pdf.doc.getPage(page).then((pg) => pageInk({ OPS: pdf.ops ?? {} }, pg as never, page));
    p.catch(() => m!.delete(page));
    m.set(page, p);
  }
  return p;
}

/** The question's content once its page is read (null while reading; scanned when the page could not be read as text). */
export function useQuestionContent(pdf: PdfHandle, template: PdfTemplate, q: TemplateQuestion): QuestionContent | null {
  const [content, setContent] = useState<{ key: string; c: QuestionContent } | null>(null);
  const page = questionTextRect(q).page;
  useEffect(() => {
    let off = false;
    if (!pdf.ops) { setContent({ key: q.key, c: { blocks: [], figures: [], scanned: true, plain: "" } }); return; }
    void inkOf(pdf, page).then((ink) => { if (!off) setContent({ key: q.key, c: questionContent(template, q, ink) }); })
      .catch(() => { if (!off) setContent({ key: q.key, c: { blocks: [], figures: [], scanned: true, plain: "" } }); });
    return () => { off = true; };
  }, [pdf, template, q, page]);
  return content?.key === q.key ? content.c : null;
}
