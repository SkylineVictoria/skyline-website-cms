import { useEffect, useState } from "react";
import type { PdfDoc, PdfHandle } from "./pdfDoc";
import type { PdfTemplate, Rect, TemplateQuestion } from "@/lib/assessment/pdfTemplate/model";
import { pageInk, questionContent, questionTextRect, workbookCrop, type PageInk, type QuestionContent } from "@/lib/assessment/pdfTemplate/questionText";

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

/** A question read from its page: its words (Text view) and, ASM-QUESTION-POLISH, its crop as printed (Workbook view). */
export interface ReadQuestion extends QuestionContent { crop: Rect | null }
const SCANNED: Omit<ReadQuestion, "crop"> = { blocks: [], figures: [], scanned: true, plain: "" };

/** The question once its page is read (null while reading; scanned when the page could not be read as text). */
export function useQuestionContent(pdf: PdfHandle, template: PdfTemplate, q: TemplateQuestion): ReadQuestion | null {
  const [content, setContent] = useState<{ key: string; c: ReadQuestion } | null>(null);
  const page = questionTextRect(q).page;
  useEffect(() => {
    let off = false;
    if (!pdf.ops) { setContent({ key: q.key, c: { ...SCANNED, crop: null } }); return; }
    void inkOf(pdf, page).then((ink) => {
      const c = questionContent(template, q, ink);
      if (!off) setContent({ key: q.key, c: { ...c, crop: c.blocks.length ? workbookCrop(q, ink) : null } });
    }).catch(() => { if (!off) setContent({ key: q.key, c: { ...SCANNED, crop: null } }); });
    return () => { off = true; };
  }, [pdf, template, q, page]);
  return content?.key === q.key ? content.c : null;
}
