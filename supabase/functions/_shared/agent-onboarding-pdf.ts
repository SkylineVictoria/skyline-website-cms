// The two agent onboarding blanks as PDFs (2026-11-17): reading their AcroForm fields into placed signing fields, flattening them into
// plain pages (the Sign module prints and overlays its own fields), joining them into the one document the agent signs, and splitting
// the signed document back into the two files kept on the agency. Runtime-neutral (Deno function and the offline tests); pdf-lib comes
// from the function's import map or node_modules. Loaded lazily by the function (the PDF engine never loads at boot).
import { PDFDocument, PDFRadioGroup, PDFRef } from "pdf-lib";
import { AGENT_ONBOARDING_DOCS, placeTemplateFields, type OnboardingDoc, type PlacedField, type WidgetBox } from "./agent-onboarding.ts";

export interface BlankTemplate { fields: PlacedField[]; flattened: Uint8Array; pages: number }

/**
 * A blank: every form field's widget (its page and rectangle) becomes a placed signing field through the registry, then the form is
 * flattened so the stored template has no interactive fields left (the page content keeps the printed boxes and lines).
 */
export async function readBlankTemplate(doc: OnboardingDoc, bytes: Uint8Array): Promise<BlankTemplate> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = pdf.getPages();
  if (pages.length !== AGENT_ONBOARDING_DOCS[doc].pages) throw new Error(`The ${AGENT_ONBOARDING_DOCS[doc].name} blank has ${AGENT_ONBOARDING_DOCS[doc].pages} pages; this file has ${pages.length}.`);
  // Each widget annotation is listed in its page's Annots: the page of a widget is the page whose Annots holds its reference.
  const pageOfRef = new Map<string, number>();
  pages.forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let k = 0; k < annots.size(); k++) { const ref = annots.get(k); if (ref instanceof PDFRef) pageOfRef.set(ref.toString(), index); }
  });
  const refOf = (dict: unknown) => { for (const [ref, object] of pdf.context.enumerateIndirectObjects()) if (object === dict) return ref.toString(); return null; };
  const form = pdf.getForm();
  const widgets: WidgetBox[] = [];
  for (const field of form.getFields()) {
    const name = field.getName();
    const radio = field instanceof PDFRadioGroup;
    for (const widget of field.acroField.getWidgets()) {
      const rect = widget.getRectangle();
      const ref = refOf(widget.dict);
      const index = ref ? pageOfRef.get(ref) : undefined;
      if (index === undefined) throw new Error(`The field ${name} is not on any page of the ${AGENT_ONBOARDING_DOCS[doc].name} blank.`);
      const page = pages[index];
      const option = radio ? widget.getOnValue()?.decodeText() ?? null : null;
      widgets.push({ name, option, page: index + 1, x: rect.x, y: rect.y, width: rect.width, height: rect.height, pageWidth: page.getWidth(), pageHeight: page.getHeight() });
    }
  }
  const fields = placeTemplateFields(doc, widgets);
  form.flatten();
  return { fields, flattened: await pdf.save(), pages: pages.length };
}

/** One document from several: the pages of each, in order. */
export async function mergePdfs(parts: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const bytes of parts) {
    const source = await PDFDocument.load(bytes, { updateMetadata: false });
    for (const page of await out.copyPages(source, source.getPageIndices())) out.addPage(page);
  }
  return await out.save();
}

/** The first `firstPages` pages and the rest, as two documents (the signed application form and the signed agreement). */
export async function splitPdf(bytes: Uint8Array, firstPages: number): Promise<[Uint8Array, Uint8Array]> {
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  const total = source.getPageCount();
  const cut = Math.min(Math.max(1, Math.floor(firstPages)), total - 1);
  const part = async (from: number, to: number) => {
    const out = await PDFDocument.create();
    const indices = []; for (let i = from; i < to; i++) indices.push(i);
    for (const page of await out.copyPages(source, indices)) out.addPage(page);
    out.setSubject(source.getSubject() ?? "");
    return await out.save();
  };
  return [await part(0, cut), await part(cut, total)];
}
