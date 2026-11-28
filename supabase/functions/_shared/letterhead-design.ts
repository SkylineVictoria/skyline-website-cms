// LETTERHEAD-DESIGNER (owner 2026-11-28): five letterhead designs (Classic, Modern, Minimal, Bold, Formal) proposed from the brand
// (logo colours, the website's colours and fonts, the organisation's details), checked by code against fixed rules, previewed on three
// samples, and applied where the admin chooses. One spec format for the AI designer (Edge Function letterhead-designer) and the built-in
// engine; the renderer and the rule checks below are the only way a design becomes HTML, so every design passes the same rules.
// Runtime-neutral (browser, Edge Function, Node tests).

export type LetterheadStyle = "classic" | "modern" | "minimal" | "bold" | "formal";
export const LETTERHEAD_STYLES: ReadonlyArray<{ style: LetterheadStyle; label: string; brief: string }> = [
  { style: "classic", label: "Classic", brief: "Centred logo, a thin rule under it, details centred in small type." },
  { style: "modern", label: "Modern", brief: "Logo left, details right, a colour band under the header." },
  { style: "minimal", label: "Minimal", brief: "A small logo, lots of white space, hairline details." },
  { style: "bold", label: "Bold", brief: "A coloured header block with the details in light type on it." },
  { style: "formal", label: "Formal", brief: "Government / academic: serif type, a ruled header, a full-width footer bar." },
];
export type FontChoice = "sans" | "serif";
/** The embeddable faces: Arimo (sans, Arial-metric) and Tinos (serif, Times-metric). At most these two in one design. */
export const FONT_FACES: Record<FontChoice, string> = { sans: "Arimo", serif: "Tinos" };

export interface LetterheadSpec {
  style: LetterheadStyle;
  /** A short name for the admin, e.g. "Classic, navy rule". */
  name: string;
  palette: {
    /** The brand colour: rules, bands, accents. */ primary: string;
    /** A second colour (from the logo or the website). */ accent: string;
    /** Body text and the organisation name. */ ink: string;
    /** Details text (address, contacts). */ muted: string;
    /** Bold style: the header block colour, and the text on it. */ band: string; bandText: string;
  };
  fonts: { heading: FontChoice; body: FontChoice };
  /** Logo height in points on page 1 and on later pages (the width follows the picture: never stretched). */
  logoHeight: number; logoHeightLater: number;
  /** Rule / bar thickness in points (0: none). */
  ruleWeight: number;
  /** Show the organisation name beside the logo (when the logo has no name in it). */
  showName: boolean;
  /** A short line under the name, e.g. "Registered Training Organisation" (optional). */
  tagline?: string;
}

export interface Brand {
  name: string; legalName: string; address: string; phone: string; email: string; website: string; rto: string; cricos: string; abn: string;
  /** The logo as a picture the PDF can embed (https template asset or a PNG / JPEG data URL), and its size in pixels. */
  logoSrc: string | null; logoPx: { w: number; h: number } | null;
  /** Colours taken from the logo (most used first) and from the website theme. */
  logoColors: string[]; siteColors: string[]; siteFonts: string[];
}

/* ------------------------------------------------------------------ colour */
const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (c: unknown): c is string => typeof c === "string" && HEX.test(c);
const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const luminance = (hex: string) => { const [r, g, b] = rgbOf(hex).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** WCAG contrast ratio (luminance-based, so it also holds in black-and-white print). */
export const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const toHex = (rgb: number[]) => "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
/** The colour made darker (f < 1) or lighter towards white (f > 1). */
export const shade = (hex: string, f: number) => toHex(rgbOf(hex).map((v) => (f <= 1 ? v * f : v + (1 - v) * (f - 1))));
/** The colour darkened step by step until it reaches `ratio` against `on` (black at worst). */
export function readable(hex: string, on = "#ffffff", ratio = 4.5): string {
  let c = hex;
  for (let i = 0; i < 30 && contrast(c, on) < ratio; i++) c = shade(c, 0.9);
  return contrast(c, on) >= ratio ? c : "#111111";
}

/* ------------------------------------------------------------------ rendering */
export interface RenderOptions {
  /** tokens: {{institute.*}} placeholders filled when a document is made (Application form, Letter of Offer); literal: the brand's values
   *  written in (document template presets, which have no institute variables). */
  mode: "tokens" | "literal";
  /** The document's own line in the footer (title, reference, version...), already in the target's syntax. */
  documentLine?: string;
  /** Page numbers in the target's syntax. */
  pageToken?: { number: string; total: string };
}
const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fam = (f: FontChoice) => (f === "serif" ? "font-family:Tinos,serif;" : "");
const p = (text: string, o: { size: number; color: string; align?: "left" | "center" | "right"; bold?: boolean; font?: FontChoice; after?: number }) =>
  `<p style="${o.align && o.align !== "left" ? `text-align:${o.align};` : ""}margin-bottom:${o.after ?? 0}pt"><span style="${fam(o.font ?? "sans")}font-size:${o.size}pt"><span style="color:${o.color}">${o.bold ? `<strong>${text}</strong>` : text}</span></span></p>`;

/** The values the renderer prints, by placeholder (tokens mode) or the brand's own (literal mode). */
function fields(brand: Brand, mode: RenderOptions["mode"]) {
  const site = brand.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (mode === "tokens") return {
    name: "{{institute.name}}", legal: "{{institute.legal_name}}", address: "{{institute.address}}", phone: "{{institute.phone}}", email: "{{institute.email}}",
    website: "{{institute.website}}", rto: "{{institute.rto}}", cricos: "{{institute.cricos}}", abn: "{{institute.abn}}",
    logo: (h: number) => `{{institute.logo|h${Math.round(h)}}}`,
  };
  return {
    name: esc(brand.name), legal: esc(brand.legalName || brand.name), address: esc(brand.address), phone: esc(brand.phone), email: esc(brand.email), website: esc(site),
    rto: esc(brand.rto), cricos: esc(brand.cricos), abn: esc(brand.abn),
    logo: (h: number) => (brand.logoSrc ? `<img src="${esc(brand.logoSrc)}" height="${Math.round(h)}">` : ""),
  };
}

/** The header (page 1), the header of later pages and the footer of a design, as rich HTML for the PDF builder. */
export function renderLetterhead(spec: LetterheadSpec, brand: Brand, opt: RenderOptions): { header: string; headerLater: string; footer: string } {
  const f = fields(brand, opt.mode);
  const c = spec.palette, hf = spec.fonts.heading, bf = spec.fonts.body;
  const contacts = [f.phone, f.email, f.website].join("  |  ");
  const reg = `RTO ${f.rto}  |  CRICOS ${f.cricos}`;
  const logo = (h: number) => (brand.logoSrc || opt.mode === "tokens" ? f.logo(h) : "");
  // No logo at all: the organisation's name stands in for it (whatever the design says).
  const showName = spec.showName || (!brand.logoSrc && !brand.logoPx);
  const nameBlock = (size: number, align: "left" | "center" | "right" = "left", color = c.ink) =>
    showName ? p(f.name, { size, color, align, bold: true, font: hf }) + (spec.tagline ? p(esc(spec.tagline), { size: Math.max(7, size - 5), color: c.muted === color ? c.muted : color, align, font: hf }) : "") : "";
  const rule = (color: string, w = spec.ruleWeight) => (w > 0 ? `<tr><td colspan="2" style="border-bottom:${w}pt solid ${color};padding:0pt 0pt">${p("&nbsp;", { size: 2, color })}</td></tr>` : "");
  const page = opt.pageToken ?? { number: "{{page.number}}", total: "{{page.total}}" };
  const docLine = opt.documentLine ? `${opt.documentLine}  |  ` : "";
  const footerCore = (color: string, sub: string) =>
    p(`${docLine}Page ${page.number} of ${page.total}`, { size: 7.5, color, align: "center", font: bf })
    + p(`${f.legal}  |  ABN ${f.abn}  |  ${reg}`, { size: 6.5, color: sub, align: "center", font: bf });
  let header = "", later = "", footer = "";
  switch (spec.style) {
    case "classic": {
      header = `<table style="border:none;width:100%"><tr><td colspan="2" style="text-align:center;padding:0pt 0pt">${logo(spec.logoHeight) ? `<p style="text-align:center;margin-bottom:2pt">${logo(spec.logoHeight)}</p>` : ""}${nameBlock(13, "center")}`
        + p(`${f.address}  |  ${contacts}`, { size: 7.5, color: c.muted, align: "center", font: bf }) + `</td></tr>${rule(c.primary, Math.max(0.5, Math.min(spec.ruleWeight, 1)))}</table>`;
      later = `<table style="border:none;width:100%"><tr><td colspan="2" style="text-align:center;padding:0pt 0pt">${logo(spec.logoHeightLater) ? `<p style="text-align:center;margin-bottom:0pt">${logo(spec.logoHeightLater)}</p>` : p(f.name, { size: 9, color: c.ink, align: "center", bold: true, font: hf })}</td></tr>${rule(c.primary, 0.5)}</table>`;
      footer = `<table style="border:none;width:100%"><tr><td style="border-top:0.5pt solid ${c.primary};padding:4pt 0pt 0pt 0pt">${footerCore(c.muted, c.muted)}</td></tr></table>`;
      break;
    }
    case "modern": {
      header = `<table style="border:none;width:100%"><tr><td style="width:50%;vertical-align:middle;padding:0pt 0pt">${logo(spec.logoHeight)}${nameBlock(12)}</td>`
        + `<td style="width:50%;vertical-align:middle;text-align:right;padding:0pt 0pt">${p(f.address, { size: 7.5, color: c.muted, align: "right", font: bf })}${p(contacts, { size: 7.5, color: c.muted, align: "right", font: bf })}${p(reg, { size: 7.5, color: c.muted, align: "right", font: bf })}</td></tr>`
        + `<tr><td colspan="2" style="padding:2pt 0pt 0pt 0pt">${p("&nbsp;", { size: 2, color: c.ink })}</td></tr>`
        + `<tr><td style="background-color:${c.primary};padding:0pt 0pt">${p("&nbsp;", { size: Math.max(2, spec.ruleWeight * 1.5), color: c.primary })}</td><td style="background-color:${c.accent};padding:0pt 0pt">${p("&nbsp;", { size: Math.max(2, spec.ruleWeight * 1.5), color: c.accent })}</td></tr></table>`;
      later = `<table style="border:none;width:100%"><tr><td style="width:50%;vertical-align:middle;padding:0pt 0pt">${logo(spec.logoHeightLater) || p(f.name, { size: 9, color: c.ink, bold: true, font: hf })}</td>`
        + `<td style="width:50%;vertical-align:middle;text-align:right;padding:0pt 0pt">${p(reg, { size: 7, color: c.muted, align: "right", font: bf })}</td></tr>${rule(c.primary, Math.max(1, spec.ruleWeight))}</table>`;
      footer = `<table style="border:none;width:100%"><tr><td style="border-top:0.5pt solid #d1d5db;padding:4pt 0pt 0pt 0pt">${footerCore(c.muted, c.muted)}</td></tr></table>`;
      break;
    }
    case "minimal": {
      header = `<table style="border:none;width:100%"><tr><td style="width:60%;vertical-align:bottom;padding:0pt 0pt">${logo(spec.logoHeight)}${nameBlock(10)}</td>`
        + `<td style="width:40%;vertical-align:bottom;text-align:right;padding:0pt 0pt">${p(contacts, { size: 7, color: c.muted, align: "right", font: bf })}</td></tr>`
        + `<tr><td colspan="2" style="border-bottom:0.5pt solid ${c.muted};padding:6pt 0pt 0pt 0pt">${p("&nbsp;", { size: 2, color: c.muted })}</td></tr></table>`;
      later = `<table style="border:none;width:100%"><tr><td style="vertical-align:bottom;padding:0pt 0pt">${logo(spec.logoHeightLater) || p(f.name, { size: 8, color: c.ink, font: hf })}</td></tr></table>`;
      footer = `<table style="border:none;width:100%"><tr><td style="padding:4pt 0pt 0pt 0pt">${p(`${f.address}`, { size: 6.5, color: c.muted, align: "center", font: bf })}${footerCore(c.muted, c.muted)}</td></tr></table>`;
      break;
    }
    case "bold": {
      // The logo stays on white (a logo's own colours can vanish on a coloured block); the block below carries the details.
      header = `<table style="border:none;width:100%"><tr><td colspan="2" style="vertical-align:middle;padding:0pt 0pt 4pt 0pt">${logo(spec.logoHeight)}${nameBlock(13)}</td></tr>`
        + `<tr><td style="background-color:${c.band};width:55%;vertical-align:middle;padding:5pt 10pt">${p(`${f.address}`, { size: 7.5, color: c.bandText, font: bf })}${p(contacts, { size: 7.5, color: c.bandText, font: bf })}</td>`
        + `<td style="background-color:${c.band};vertical-align:middle;text-align:right;padding:5pt 10pt">${p(reg, { size: 8.5, color: c.bandText, align: "right", bold: true, font: bf })}</td></tr>`
        + `<tr><td colspan="2" style="background-color:${c.accent};padding:0pt 0pt">${p("&nbsp;", { size: 2.5, color: c.accent })}</td></tr></table>`;
      later = `<table style="border:none;width:100%"><tr><td style="vertical-align:middle;padding:0pt 0pt 3pt 0pt">${logo(spec.logoHeightLater) || p(f.name, { size: 9, color: c.ink, bold: true, font: hf })}</td>`
        + `<td style="vertical-align:middle;text-align:right;padding:0pt 0pt 3pt 0pt">${p(reg, { size: 7, color: c.muted, align: "right", font: bf })}</td></tr>`
        + `<tr><td colspan="2" style="background-color:${c.band};padding:0pt 0pt">${p("&nbsp;", { size: 3, color: c.band })}</td></tr></table>`;
      footer = `<table style="border:none;width:100%"><tr><td style="border-top:1.5pt solid ${c.band};padding:4pt 0pt 0pt 0pt">${footerCore(c.ink, c.muted)}</td></tr></table>`;
      break;
    }
    case "formal": {
      header = `<table style="border:none;width:100%"><tr><td style="width:22%;vertical-align:middle;padding:0pt 0pt">${logo(spec.logoHeight)}</td>`
        + `<td style="vertical-align:middle;padding:0pt 0pt 0pt 8pt">${p(f.name, { size: 14, color: c.ink, bold: true, font: hf })}${spec.tagline ? p(esc(spec.tagline), { size: 8.5, color: c.muted, font: hf }) : ""}${p(`${f.address}  |  ${contacts}`, { size: 7.5, color: c.muted, font: bf })}</td></tr>`
        + `<tr><td colspan="2" style="border-bottom:${Math.max(1, spec.ruleWeight)}pt solid ${c.primary};padding:4pt 0pt 0pt 0pt">${p("&nbsp;", { size: 2, color: c.primary })}</td></tr>`
        + `<tr><td colspan="2" style="border-bottom:0.5pt solid ${c.primary};padding:1.5pt 0pt 0pt 0pt">${p("&nbsp;", { size: 1, color: c.primary })}</td></tr></table>`;
      later = `<table style="border:none;width:100%"><tr><td style="vertical-align:middle;padding:0pt 0pt">${p(f.name, { size: 9.5, color: c.ink, bold: true, font: hf })}</td>`
        + `<td style="vertical-align:middle;text-align:right;padding:0pt 0pt">${p(reg, { size: 7, color: c.muted, align: "right", font: bf })}</td></tr>${rule(c.primary, 0.75)}</table>`;
      footer = `<table style="border:none;width:100%"><tr><td style="background-color:${c.band};padding:4pt 8pt">${footerCore(c.bandText, c.bandText)}</td></tr></table>`;
      break;
    }
  }
  return { header, headerLater: later, footer };
}

/* ------------------------------------------------------------------ rules */
export const PAGE_H = 841.89;
export const MAX_HEADER_FIRST = 0.15 * PAGE_H;
export const MAX_HEADER_LATER = 0.08 * PAGE_H;
export const MAX_FOOTER = 0.08 * PAGE_H;
/** Print resolution the logo must reach at its printed size. */
export const LOGO_MIN_DPI = 150;
export interface RuleResult { ok: boolean; problems: string[]; measures: { headerFirst: number; headerLater: number; footer: number; minContrast: number } }

/** The colour / font / logo rules (no rendering needed). */
export function staticProblems(spec: LetterheadSpec, brand: Brand): { problems: string[]; minContrast: number } {
  const problems: string[] = [];
  const c = spec.palette;
  for (const [k, v] of Object.entries(c)) if (!isHex(v)) problems.push(`Colour ${k} is not a #rrggbb colour.`);
  if (!LETTERHEAD_STYLES.some((s) => s.style === spec.style)) problems.push("Unknown style.");
  if (![spec.fonts.heading, spec.fonts.body].every((f) => f === "sans" || f === "serif")) problems.push("Fonts must be Arimo (sans) or Tinos (serif): at most two, both embeddable.");
  let minContrast = 21;
  if (!problems.length) {
    const pairs: Array<[string, string, string]> = [["Name / body text", c.ink, "#ffffff"], ["Details text", c.muted, "#ffffff"]];
    if (spec.style === "bold" || spec.style === "formal") pairs.push(["Text on the coloured block", c.bandText, c.band]);
    for (const [label, fg, bg] of pairs) { const r = contrast(fg, bg); minContrast = Math.min(minContrast, r); if (r < 4.5) problems.push(`${label}: contrast ${r.toFixed(2)}:1 is below 4.5:1 (WCAG AA).`); }
    // Rules and bands must still show in black-and-white print.
    if (spec.ruleWeight > 0 && contrast(c.primary, "#ffffff") < 1.6) problems.push("The rule colour is too light to show in black-and-white print.");
  }
  if (!(spec.logoHeight >= 18 && spec.logoHeight <= 90 && spec.logoHeightLater >= 12 && spec.logoHeightLater <= spec.logoHeight)) problems.push("Logo sizes must be 18 to 90 pt on page 1 and no larger on later pages.");
  if (brand.logoPx && brand.logoPx.h < spec.logoHeight * (LOGO_MIN_DPI / 72)) problems.push(`The logo (${brand.logoPx.h} px tall) is too small to print sharply at ${spec.logoHeight} pt; use at most ${Math.floor(brand.logoPx.h / (LOGO_MIN_DPI / 72))} pt or upload a larger logo.`);
  if (!brand.rto || !brand.cricos) problems.push("The RTO and CRICOS codes are missing from Website Settings; they must show on every page.");
  return { problems, minContrast };
}

/** The longest real values, so a design is measured at its fullest (no overflow, no overlap). */
export const longestBrand = (brand: Brand): Brand => ({ ...brand, name: brand.name || "Organisation name", legalName: brand.legalName || brand.name });

/** Every rule, the measurable ones on the real PDF: the sample is laid out with the longest values and the bands measured. */
export async function checkLetterhead(spec: LetterheadSpec, brand: Brand, logoBytes?: Record<string, Uint8Array>): Promise<RuleResult> {
  const { problems, minContrast } = staticProblems(spec, brand);
  const parts = renderLetterhead(spec, longestBrand(brand), { mode: "literal", documentLine: "APPLICATION FOR ENROLMENT  |  SLIT-2026-99999  |  Version 1.0  |  Student Initial ______________", pageToken: { number: "{{page.number}}", total: "{{page.total}}" } });
  // RTO / CRICOS on every page: the footer prints on every page and must carry both.
  if (!/RTO /.test(parts.footer) || !/CRICOS /.test(parts.footer)) problems.push("The footer must show the RTO and CRICOS codes on every page.");
  const { buildDocumentPdf } = await import("./document-pdf.ts");
  let measures = { headerFirst: 0, headerLater: 0, footer: 0, minContrast };
  try {
    const r = await buildDocumentPdf({ title: "Letterhead check", header: parts.header, headerLater: parts.headerLater, footer: parts.footer, body: "<p>Sample</p>".repeat(90), values: {}, brackets: false, images: logoBytes ?? {},
      curly: (key) => (key === "page.number" ? { kind: "page" } : key === "page.total" ? { kind: "total" } : { kind: "value", text: "" }) });
    measures = { headerFirst: r.bands.header, headerLater: r.bands.headerLater, footer: r.bands.footer, minContrast };
    if (r.bands.header > MAX_HEADER_FIRST) problems.push(`The page 1 header is ${Math.round(r.bands.header)} pt tall; at most ${Math.round(MAX_HEADER_FIRST)} pt (15% of the page).`);
    if (r.bands.headerLater > MAX_HEADER_LATER) problems.push(`The later-page header is ${Math.round(r.bands.headerLater)} pt tall; at most ${Math.round(MAX_HEADER_LATER)} pt (8% of the page).`);
    if (r.bands.footer > MAX_FOOTER) problems.push(`The footer is ${Math.round(r.bands.footer)} pt tall; at most ${Math.round(MAX_FOOTER)} pt.`);
    if (r.unsupported) problems.push(`Characters the fonts cannot print: ${r.unsupported}`);
  } catch (e) {
    problems.push(`The design could not be laid out: ${e instanceof Error ? e.message : "error"}`);
  }
  return { ok: problems.length === 0, problems, measures };
}

/** A spec as the AI might return it, made safe: unknown fields dropped, sizes clamped, colours checked (null when it is not usable). */
export function normaliseSpec(raw: unknown, style: LetterheadStyle): LetterheadSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pal = (r.palette && typeof r.palette === "object" ? r.palette : {}) as Record<string, unknown>;
  const fonts = (r.fonts && typeof r.fonts === "object" ? r.fonts : {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const colour = (v: unknown, d: string) => (isHex(v) ? String(v).toLowerCase() : d);
  const font = (v: unknown, d: FontChoice): FontChoice => (v === "serif" || v === "sans" ? v : d);
  const spec: LetterheadSpec = {
    style, name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 60) : LETTERHEAD_STYLES.find((s) => s.style === style)!.label,
    palette: { primary: colour(pal.primary, "#1f2937"), accent: colour(pal.accent, "#ea6619"), ink: colour(pal.ink, "#111827"), muted: colour(pal.muted, "#4b5563"), band: colour(pal.band, "#1f2937"), bandText: colour(pal.bandText, "#ffffff") },
    fonts: { heading: font(fonts.heading, style === "classic" || style === "formal" ? "serif" : "sans"), body: font(fonts.body, "sans") },
    logoHeight: num(r.logoHeight, 18, 90, 44), logoHeightLater: num(r.logoHeightLater, 12, 60, 24), ruleWeight: num(r.ruleWeight, 0, 4, 1.5),
    showName: r.showName === true, tagline: typeof r.tagline === "string" && r.tagline.trim() ? r.tagline.trim().slice(0, 60) : undefined,
  };
  if (spec.logoHeightLater > spec.logoHeight) spec.logoHeightLater = spec.logoHeight;
  return spec;
}

const A4 = { w: 595.28, h: 841.89 };
/**
 * An uploaded PDF put on the letterhead (owner choice: shrink to fit): every page becomes an A4 page with the letterhead header (the
 * smaller one from page 2) and footer (page X of Y), the original page scaled down, never up, and centred between them, so nothing
 * is covered. Fields are placed afterwards on this copy.
 */
export async function placeOnLetterhead(source: Uint8Array, spec: LetterheadSpec, brand: Brand): Promise<Uint8Array> {
  const { buildDocumentPdf } = await import("./document-pdf.ts");
  const { PDFDocument } = await import("pdf-lib");
  const src = await PDFDocument.load(source);
  const out = await PDFDocument.create();
  const total = src.getPageCount();
  if (total > 200) throw new Error("The PDF has more than 200 pages.");
  const gap = 8, side = 36;
  for (let i = 0; i < total; i++) {
    const parts = renderLetterhead(spec, brand, { mode: "literal", pageToken: { number: String(i + 1), total: String(total) } });
    const lh = await buildDocumentPdf({ title: "", header: i === 0 ? parts.header : (parts.headerLater || parts.header), footer: parts.footer, body: "<p><span style=\"color:#ffffff\">.</span></p>", values: {}, brackets: false, images: {} });
    const top = (i === 0 ? lh.bands.header : (lh.bands.header || lh.bands.headerLater)) + gap;
    const bottom = lh.bands.footer + gap;
    const [paper] = await out.embedPdf(lh.bytes, [0]);
    const page = out.addPage([A4.w, A4.h]);
    page.drawPage(paper, { x: 0, y: 0, width: A4.w, height: A4.h });
    const srcPage = src.getPage(i);
    const { width: w, height: h } = srcPage.getSize();
    const embedded = await out.embedPdf(src, [i]).then(([e]) => e).catch(() => null); // a blank page has nothing to draw
    if (!embedded) continue;
    const scale = Math.min(1, (A4.w - 2 * side) / w, (A4.h - top - bottom) / h);
    const dw = w * scale, dh = h * scale;
    page.drawPage(embedded, { x: (A4.w - dw) / 2, y: bottom + (A4.h - top - bottom - dh) / 2, width: dw, height: dh });
  }
  return out.save();
}
