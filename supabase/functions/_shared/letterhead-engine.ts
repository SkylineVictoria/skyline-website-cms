// LETTERHEAD-DESIGNER: the built-in designer. From the brand (logo colours, website colours, details) it proposes one design per style;
// `seed` varies colours, sizes and type pairing so "Generate 5 more" gives new ones. Each design is checked by checkLetterhead and, when a
// rule fails, adjusted (smaller logo, darker colours) and checked again before anyone sees it. The AI designer returns the same spec
// format and goes through the same checks (letterhead-designer Edge Function).
import { LETTERHEAD_STYLES, checkLetterhead, contrast, luminance, readable, shade, type Brand, type LetterheadSpec, type LetterheadStyle, type RuleResult } from "./letterhead-design.ts";

/** A small deterministic random generator, so one seed always gives the same five designs. */
function rng(seed: number) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 10000) / 10000; }; }

const saturation = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };

/** The brand's colours: the strongest logo / website colour, a second one, and a deep neutral for text. */
export function brandPalette(brand: Brand): { primary: string; accent: string; deep: string } {
  const all = [...brand.siteColors, ...brand.logoColors].filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  const vivid = all.filter((c) => saturation(c) > 0.35 && luminance(c) > 0.04 && luminance(c) < 0.8);
  const primary = vivid[0] ?? "#ea6619";
  const accent = vivid.find((c) => contrast(c, primary) > 1.6) ?? shade(primary, 0.6);
  const dark = all.filter((c) => luminance(c) < 0.05).sort((a, b) => luminance(a) - luminance(b))[0];
  const deep = dark ?? "#1f2937";
  return { primary, accent, deep };
}

/** One design of a style, before checking. */
function propose(style: LetterheadStyle, brand: Brand, r: () => number): LetterheadSpec {
  const { primary, accent, deep } = brandPalette(brand);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const ink = readable(pick([deep, "#111827", "#1f2937", shade(deep, 0.8)]));
  const muted = readable(pick(["#4b5563", "#525a66", shade(deep, 1.35)]));
  const label = LETTERHEAD_STYLES.find((s) => s.style === style)!.label;
  const colourName = (hex: string) => { const [r_, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return r_ > g && r_ > b ? (g > 120 ? "amber" : "red-orange") : g > r_ && g > b ? "green" : b > 120 && r_ < 100 ? "blue" : "slate"; };
  switch (style) {
    case "classic": return { style, name: `${label}, ${colourName(primary)} rule`, palette: { primary, accent, ink, muted, band: deep, bandText: "#ffffff" },
      fonts: { heading: pick(["serif", "serif", "sans"]), body: "sans" }, logoHeight: pick([40, 44, 48]), logoHeightLater: pick([22, 24]), ruleWeight: pick([0.5, 0.75, 1]), showName: false };
    case "modern": return { style, name: `${label}, ${colourName(primary)} band`, palette: { primary, accent: pick([accent, deep]), ink, muted, band: deep, bandText: "#ffffff" },
      fonts: { heading: "sans", body: "sans" }, logoHeight: pick([42, 46, 50]), logoHeightLater: pick([24, 26]), ruleWeight: pick([2, 2.5, 3]), showName: false };
    case "minimal": return { style, name: `${label}, hairline`, palette: { primary: readable(primary, "#ffffff", 1.8), accent, ink, muted, band: deep, bandText: "#ffffff" },
      fonts: { heading: pick(["sans", "serif"]), body: "sans" }, logoHeight: pick([28, 32, 34]), logoHeightLater: pick([18, 20]), ruleWeight: 0.5, showName: false };
    case "bold": {
      const band = pick([readable(primary, "#ffffff", 4.6), deep, readable(shade(primary, 0.7), "#ffffff", 4.6)]);
      return { style, name: `${label}, ${band === deep ? "deep" : colourName(primary)} block`, palette: { primary: band, accent: band === deep ? primary : pick([accent, deep]), ink, muted, band, bandText: "#ffffff" },
        fonts: { heading: "sans", body: "sans" }, logoHeight: pick([38, 42]), logoHeightLater: 20, ruleWeight: 2, showName: false };
    }
    case "formal": {
      const band = pick([deep, "#1f2a44", readable(shade(primary, 0.55), "#ffffff", 7)]);
      return { style, name: `${label}, serif with footer bar`, palette: { primary: band, accent: primary, ink, muted, band, bandText: "#ffffff" },
        fonts: { heading: "serif", body: pick(["serif", "sans"]) }, logoHeight: pick([46, 50, 54]), logoHeightLater: 20, ruleWeight: pick([1.5, 2]), showName: false,
        tagline: pick(["Registered Training Organisation", "Registered Training Organisation and CRICOS provider", undefined]) };
    }
  }
}

/** Makes a design pass the rules: smaller logo while the header is too tall or the logo too small to print sharply, darker text colours. */
async function settle(spec: LetterheadSpec, brand: Brand, logoBytes?: Record<string, Uint8Array>): Promise<{ spec: LetterheadSpec; check: RuleResult; tries: number }> {
  let s = spec, check = await checkLetterhead(s, brand, logoBytes), tries = 1;
  while (!check.ok && tries < 6) {
    const pal = { ...s.palette, ink: readable(s.palette.ink), muted: readable(s.palette.muted), bandText: contrast(s.palette.bandText, s.palette.band) < 4.5 ? (luminance(s.palette.band) > 0.3 ? "#111111" : "#ffffff") : s.palette.bandText };
    const maxLogo = brand.logoPx ? Math.floor(brand.logoPx.h / (150 / 72)) : 90;
    const tooTall = check.problems.some((p) => /header is|footer is/.test(p));
    const logo = Math.max(18, Math.min(maxLogo, tooTall ? Math.round(s.logoHeight * 0.85) : s.logoHeight));
    s = { ...s, palette: pal, logoHeight: logo, logoHeightLater: Math.min(s.logoHeightLater, logo, tooTall ? Math.round(s.logoHeightLater * 0.85) : s.logoHeightLater), tagline: tooTall ? undefined : s.tagline };
    check = await checkLetterhead(s, brand, logoBytes); tries++;
  }
  return { spec: s, check, tries };
}

export interface GeneratedDesign { spec: LetterheadSpec; check: RuleResult; designer: "built-in" | "ai" }
/** Five designs, one per style, each passing every rule (a style that cannot pass after the adjustments is left out). */
export async function generateDesigns(brand: Brand, seed: number, logoBytes?: Record<string, Uint8Array>): Promise<GeneratedDesign[]> {
  const r = rng(seed * 7919 + 17);
  const out: GeneratedDesign[] = [];
  for (const { style } of LETTERHEAD_STYLES) {
    const { spec, check } = await settle(propose(style, brand, r), brand, logoBytes);
    if (check.ok) out.push({ spec, check, designer: "built-in" });
  }
  return out;
}
export { settle as settleDesign };
