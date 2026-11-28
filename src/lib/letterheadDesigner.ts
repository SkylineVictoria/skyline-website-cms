import { supabase } from "@/pages/admin/lib/supabase";
import { rasteriseLogo } from "@/pages/agency/lib/applicationPdf";
import { checkLetterhead, normaliseSpec, placeOnLetterhead, renderLetterhead, type Brand, type LetterheadSpec, type LetterheadStyle } from "../../supabase/functions/_shared/letterhead-design";
import { generateDesigns, type GeneratedDesign } from "../../supabase/functions/_shared/letterhead-engine";
import { isSerifFamily } from "../../supabase/functions/_shared/rich-html";

/**
 * LETTERHEAD-DESIGNER (owner 2026-11-28): the brand inputs (logo and its colours, the website's colours and fonts, the details), five
 * designs (the AI designer when it is live, otherwise the built-in one; both checked by the same rules), previews on three samples,
 * and applying the chosen one where the admin says.
 */
export type LetterheadTarget = "application_form" | "letter_of_offer" | "document_templates" | "workbooks";
export const LETTERHEAD_TARGETS: ReadonlyArray<{ id: LetterheadTarget; label: string; hint: string }> = [
  { id: "application_form", label: "Application form", hint: "Every newly signed application (the default Application form, as a new version)." },
  { id: "letter_of_offer", label: "Letter of Offer", hint: "The active Letter of Offer template (new version) and every new one." },
  { id: "document_templates", label: "Document templates", hint: "The house header and footer presets. Templates ticked \u201cPut on letterhead\u201d and uploads follow the letterhead in any case." },
  { id: "workbooks", label: "Workbook added pages", hint: "The continued and answer pages added to assessment workbooks (the trainer's own pages are not changed)." },
];

const toDataUrl = (bytes: Uint8Array, type: "png" | "jpeg") => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/${type};base64,${btoa(binary)}`;
};
const hex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

/** The logo's main colours (most used first): pixels bucketed by colour, white / transparent ones left out. */
async function logoColours(blob: Blob): Promise<{ colours: string[]; w: number; h: number }> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 160 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 128 || (r > 235 && g > 235 && b > 235)) continue;
    const key = `${r >> 5}-${g >> 5}-${b >> 5}`;
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b; buckets.set(key, e);
  }
  const colours = [...buckets.values()].sort((x, y) => y.n - x.n).slice(0, 6).map((e) => hex(Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)));
  return { colours, w: bitmap.width, h: bitmap.height };
}

/** The brand inputs from Website Settings and the logo. */
export async function loadBrand(): Promise<Brand & { warnings: string[] }> {
  const { data, error } = await supabase.from("cms_settings")
    .select("name, legal_name, address, phone, email, website, rto, cricos, abn, logo, primary_color, accent_color, heading_font, body_font").order("id", { ascending: true }).limit(1);
  if (error) throw new Error(error.message);
  const s = (Array.isArray(data) && data[0] ? data[0] : {}) as Record<string, string | null>;
  const warnings: string[] = [];
  let logoSrc: string | null = null, logoPx: Brand["logoPx"] = null, logoColors: string[] = [];
  if (s.logo) {
    try {
      const res = await fetch(s.logo);
      const blob = await res.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const kind = bytes[0] === 0x89 && bytes[1] === 0x50 ? "png" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpeg" : null;
      if (kind) logoSrc = toDataUrl(bytes, kind);
      else {
        const format = /svg/i.test(blob.type) ? "svg" : /webp/i.test(blob.type) ? "webp" : "gif";
        const png = await rasteriseLogo(bytes, format as "svg" | "webp" | "gif");
        if (png) logoSrc = toDataUrl(png.bytes, "png");
      }
      const found = await logoColours(blob);
      logoColors = found.colours; logoPx = { w: found.w, h: found.h };
      if (found.h < 150) warnings.push(`The logo is ${found.w} × ${found.h} px: the designs keep it small enough to print sharply. A larger logo (at least 300 px tall) allows bigger letterheads.`);
    } catch { warnings.push("The logo could not be read; the designs print the name instead."); }
  } else warnings.push("No logo in Website Settings; the designs print the name instead.");
  if (!s.rto || !s.cricos) warnings.push("RTO and CRICOS codes are missing from Website Settings: add them before applying (they must show on every page).");
  return {
    name: s.name ?? "", legalName: s.legal_name ?? s.name ?? "", address: s.address ?? "", phone: s.phone ?? "", email: s.email ?? "", website: s.website ?? "",
    rto: s.rto ?? "", cricos: s.cricos ?? "", abn: s.abn ?? "", logoSrc, logoPx, logoColors,
    siteColors: [s.primary_color, s.accent_color].filter((c): c is string => !!c && /^#[0-9a-f]{6}$/i.test(c)),
    siteFonts: [s.heading_font, s.body_font].filter((f): f is string => !!f), warnings,
  };
}

export interface DesignBatch { designs: GeneratedDesign[]; source: "ai" | "built-in"; note: string }
/**
 * Five designs: the AI designer (Edge Function letterhead-designer) when it answers, each design checked again here; otherwise the
 * built-in designer. A design that fails a rule never reaches the page.
 */
export async function designLetterheads(brand: Brand, seed: number): Promise<DesignBatch> {
  const { logoSrc: _logo, ...brandForAi } = brand;
  try {
    const { data, error } = await supabase.functions.invoke("letterhead-designer", { body: { action: "design", seed, brand: { ...brandForAi, hasLogo: !!brand.logoSrc, serifSite: brand.siteFonts.some((f) => isSerifFamily(f)) } } });
    if (!error && data && Array.isArray((data as { designs?: unknown[] }).designs)) {
      const out: GeneratedDesign[] = [];
      for (const raw of (data as { designs: Array<{ style: LetterheadStyle; spec: unknown }> }).designs) {
        const spec = normaliseSpec(raw.spec, raw.style);
        if (!spec) continue;
        const check = await checkLetterhead(spec, brand);
        if (check.ok) out.push({ spec, check, designer: "ai" });
      }
      if (out.length) return { designs: out, source: "ai", note: "Designed by AI from your brand, then checked against every rule." };
    }
  } catch { /* the AI designer is not live yet: the built-in one below */ }
  return { designs: await generateDesigns(brand, seed), source: "built-in", note: "Designed by the built-in designer from your brand (the AI designer takes over once its service is deployed). Every design passed every rule." };
}

const SAMPLES: Record<"letter" | "offer" | "workbook", { line: string; body: string }> = {
  letter: { line: "Letter", body: "<p>28 November 2026</p><p>Asha Patel<br>12 Example Street<br>Carlton VIC 3053</p><p><strong>Re: Your enrolment</strong></p><p>Dear Asha,</p>"
    + "<p>Thank you for choosing to study with us. This letter confirms the next steps of your enrolment and what we need from you before your course starts.</p>".repeat(3)
    + "<p>Kind regards,</p><p><strong>Admissions Team</strong></p>" },
  offer: { line: "LETTER OF OFFER AND WRITTEN AGREEMENT  |  Version 1.0  |  Student Initial ______________", body: "<h2>Letter of Offer and Written Agreement</h2><p>Dear Asha Patel,</p><p>We are pleased to offer you a place in the course below.</p>"
    + `<table style="width:100%"><tr><td style="background-color:#f3f4f6;padding:4pt 6pt"><strong>Course</strong></td><td style="padding:4pt 6pt">CHC33021 Certificate III in Individual Support</td></tr><tr><td style="background-color:#f3f4f6;padding:4pt 6pt"><strong>Start date</strong></td><td style="padding:4pt 6pt">9 February 2027</td></tr><tr><td style="background-color:#f3f4f6;padding:4pt 6pt"><strong>Tuition fee</strong></td><td style="padding:4pt 6pt">AUD 12,000.00</td></tr><tr><td style="background-color:#f3f4f6;padding:4pt 6pt"><strong>Initial deposit</strong></td><td style="padding:4pt 6pt">AUD 2,500.00</td></tr></table>`
    + "<p>Please read the terms below, initial each page and sign the acceptance.</p>".repeat(6) },
  workbook: { line: "CHCCCS031 Provide individualised support  |  Student Assessment Workbook", body: "<h3>Task 1: Knowledge questions</h3>"
    + [1, 2, 3].map((n) => `<p><strong>Question ${n}.</strong> Describe how you would support a person's choices while meeting their care plan.</p><table style="width:100%"><tr><td style="padding:30pt 6pt"><p>&nbsp;</p></td></tr></table>`).join("") },
};

/** A design printed on the three samples (one PDF, a page each: letter, offer letter, workbook page). */
export async function renderSamples(spec: LetterheadSpec, brand: Brand): Promise<Uint8Array> {
  const { buildDocumentPdf } = await import("../../supabase/functions/_shared/document-pdf");
  const { PDFDocument } = await import("pdf-lib");
  const out = await PDFDocument.create();
  for (const key of ["letter", "offer", "workbook"] as const) {
    const parts = renderLetterhead(spec, brand, { mode: "literal", documentLine: SAMPLES[key].line });
    const r = await buildDocumentPdf({ title: spec.name, header: parts.header, headerLater: parts.headerLater, footer: parts.footer, body: SAMPLES[key].body, values: {}, brackets: false, images: {},
      curly: (k) => (k === "page.number" ? { kind: "page" } : k === "page.total" ? { kind: "total" } : { kind: "value", text: "" }) });
    const doc = await PDFDocument.load(r.bytes);
    const [page] = await out.copyPages(doc, [0]);
    out.addPage(page);
  }
  return out.save();
}

/** The HTML for each place the letterhead goes (each in that place's own placeholder syntax), then the one apply command. */
export async function applyLetterhead(design: GeneratedDesign, brand: Brand, targets: LetterheadTarget[]) {
  const app = renderLetterhead(design.spec, brand, { mode: "tokens", documentLine: "Application for Enrolment  |  {{application.reference}}" });
  const loo = renderLetterhead(design.spec, brand, { mode: "tokens", documentLine: "{{document.title}}  |  {{document.version}}  |  Student Initial ______________" });
  const preset = renderLetterhead(design.spec, brand, { mode: "literal", pageToken: { number: "[Page Number]", total: "[Total Pages]" } });
  const html: Record<string, string> = {};
  if (targets.includes("application_form")) Object.assign(html, { app_header: app.header, app_header_later: app.headerLater, app_footer: app.footer });
  if (targets.includes("letter_of_offer")) Object.assign(html, { loo_header: loo.header, loo_header_later: loo.headerLater, loo_footer: loo.footer });
  // The document letterhead is always part of a design: every template ticked "Put on letterhead" follows it.
  Object.assign(html, { preset_header: preset.header, preset_header_later: preset.headerLater, preset_footer: preset.footer });
  if (targets.includes("workbooks")) Object.assign(html, { workbook_header: preset.headerLater });
  const { data, error } = await supabase.rpc("letterhead_apply", { p_design: { name: design.spec.name, style: design.spec.style, designer: design.designer, spec: design.spec, html }, p_targets: targets });
  if (error) throw new Error(error.message);
  return data as { id: string; applied: Record<string, unknown> };
}

export const activeLetterhead = async () => {
  const { data, error } = await supabase.rpc("brand_letterhead_active");
  if (error) return null;
  return data as { name: string; style: string; designer: string; spec: unknown; targets: string[]; appliedAt: string } | null;
};

/**
 * LETTERHEAD-ON-DOCUMENTS (owner 2026-11-28): the letterhead is drawn from the chosen design and the CURRENT Website Settings (logo,
 * RTO, CRICOS, contact details) each time, so a change there shows on the next document. Without a chosen design: the first built-in
 * design for the brand.
 */
export async function currentLetterhead(): Promise<{ spec: LetterheadSpec; brand: Brand; chosen: boolean }> {
  const brand = await loadBrand();
  const active = await activeLetterhead();
  const spec = active ? normaliseSpec(active.spec, active.style as LetterheadStyle) : null;
  if (spec) return { spec, brand, chosen: true };
  const [first] = await generateDesigns(brand, 1);
  if (!first) throw new Error("Add the organisation name, RTO and CRICOS codes in Website Settings first: the letterhead needs them.");
  return { spec: first.spec, brand, chosen: false };
}

/** The letterhead a template on the letterhead shows in the editor and its preview (values filled in; the database stores the same
 *  design in that template's own placeholder form on save). */
export async function letterheadParts(category: string): Promise<{ header: string; headerLater: string; footer: string; chosen: boolean }> {
  const { spec, brand, chosen } = await currentLetterhead();
  const documentLine = category === "application_form" ? "Application for Enrolment" : category === "student_offer_letter" ? "LETTER OF OFFER AND WRITTEN AGREEMENT  |  Student Initial ______________" : undefined;
  return { ...renderLetterhead(spec, brand, { mode: "literal", documentLine, pageToken: documentLine ? { number: "{{page.number}}", total: "{{page.total}}" } : { number: "[Page Number]", total: "[Total Pages]" } }), chosen };
}

/** An uploaded PDF put on the current letterhead (owner choice: shrink to fit; see placeOnLetterhead). */
export async function putPdfOnLetterhead(source: Uint8Array): Promise<Uint8Array> {
  const { spec, brand } = await currentLetterhead();
  return placeOnLetterhead(source, spec, brand);
}
