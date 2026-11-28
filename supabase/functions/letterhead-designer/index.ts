// LETTERHEAD-DESIGNER (owner 2026-11-28: "add AI to use the data and create the 5 letterheads"). An administrator's brand inputs (the
// details, the logo's and the website's colours and fonts; never the logo picture itself) go to the AI model, which proposes one design
// per style as a structured spec (no free HTML). Every proposal is normalised and checked by the same code as the built-in designer
// (_shared/letterhead-design.ts: header height on the real PDF, contrast, logo resolution, RTO / CRICOS on every page, two embeddable
// fonts, no overflow); a design that fails goes back to the model with the reasons, up to three tries, so the admin only sees designs
// that pass. Admin JWT only (verify_jwt on, then cms_is_admin with the caller's token). Env: OPENAI_API_KEY (already set for the
// assistant) and EF_LETTERHEAD_MODEL (the model name; default below).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { LETTERHEAD_STYLES, checkLetterhead, normaliseSpec, type Brand, type LetterheadSpec, type LetterheadStyle } from "../_shared/letterhead-design.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = (Deno.env.get("EF_LETTERHEAD_MODEL") ?? "").trim() || "gpt-4.1-mini";
const OPENAI_URL = "https://api.openai.com/v1/responses";
const headers = { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

const SPEC_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["name", "palette", "fonts", "logoHeight", "logoHeightLater", "ruleWeight", "showName", "tagline"],
  properties: {
    name: { type: "string", description: "A short elegant name for the design, e.g. 'Formal, navy double rule'." },
    palette: { type: "object", additionalProperties: false, required: ["primary", "accent", "ink", "muted", "band", "bandText"],
      properties: Object.fromEntries(["primary", "accent", "ink", "muted", "band", "bandText"].map((k) => [k, { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }])) },
    fonts: { type: "object", additionalProperties: false, required: ["heading", "body"], properties: { heading: { type: "string", enum: ["sans", "serif"] }, body: { type: "string", enum: ["sans", "serif"] } } },
    logoHeight: { type: "number" }, logoHeightLater: { type: "number" }, ruleWeight: { type: "number" }, showName: { type: "boolean" },
    tagline: { type: ["string", "null"] },
  },
};

/** What the model is told: the style's brief, the brand, the rules, and (on a retry) why the last proposal failed. */
export function designPrompt(brand: Omit<Brand, "logoSrc">, style: LetterheadStyle, seed: number, problems: string[]): string {
  const brief = LETTERHEAD_STYLES.find((s) => s.style === style)!;
  const maxLogo = brand.logoPx ? Math.floor(brand.logoPx.h / (150 / 72)) : 90;
  return [
    `You are a senior brand designer. Design an elegant, professional A4 letterhead in the "${brief.label}" style: ${brief.brief}`,
    `It is for ${brand.name} (${brand.legalName}), an Australian registered training organisation (RTO ${brand.rto}, CRICOS ${brand.cricos}).`,
    `Brand colours from the logo: ${brand.logoColors.join(", ") || "none"}. Website colours: ${brand.siteColors.join(", ") || "none"}. Website fonts: ${brand.siteFonts.join(", ") || "not set"}.`,
    `Use the brand colours (adjust lightness for readability); keep it restrained and print-friendly. Variation seed: ${seed} (make this design distinct from earlier ones).`,
    "Rules your design must pass (they are checked by code):",
    "- text colours (ink, muted) must have at least 4.5:1 contrast on white; bandText at least 4.5:1 on band; the design must read well printed in black and white;",
    `- logoHeight is in points, 18 to ${Math.max(18, Math.min(90, maxLogo))} (the logo must print at 150 dpi or better and is never stretched); logoHeightLater 12 to 30 and not above logoHeight;`,
    "- the page-1 header must stay under 15% of the page and later pages under 8%, so keep the logo modest and the tagline short or null;",
    "- fonts: only 'sans' (Arimo) or 'serif' (Tinos), at most these two; ruleWeight 0 to 4 points;",
    "- showName true only if the logo does not already show the organisation name (it does when the logo is a wordmark; assume it does).",
    ...(problems.length ? ["Your previous proposal failed these checks; fix them:", ...problems.map((p) => `- ${p}`)] : []),
    "Return only the JSON object.",
  ].join("\n");
}

async function propose(brand: Omit<Brand, "logoSrc">, style: LetterheadStyle, seed: number, problems: string[]): Promise<LetterheadSpec | null> {
  const res = await fetch(OPENAI_URL, {
    method: "POST", headers: { authorization: `Bearer ${OPENAI_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: designPrompt(brand, style, seed, problems),
      text: { format: { type: "json_schema", name: "letterhead", strict: true, schema: SPEC_SCHEMA } } }),
  });
  if (!res.ok) throw new Error(`model ${res.status}`);
  const body = await res.json() as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  const text = body.output_text ?? body.output?.flatMap((o) => o.content ?? []).find((c) => c.type === "output_text")?.text ?? "";
  try { return normaliseSpec(JSON.parse(text), style); } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const auth = req.headers.get("authorization") ?? "";
  const caller = createClient(SUPABASE_URL, ANON, { global: { headers: { authorization: auth } }, auth: { persistSession: false } });
  const { data: isAdmin } = await caller.rpc("cms_is_admin");
  if (isAdmin !== true) return reply({ error: "Only administrators can design letterheads." }, 403);
  if (!OPENAI_KEY) return reply({ error: "The AI designer is not configured." }, 503);
  let input: { action?: string; seed?: number; brand?: Omit<Brand, "logoSrc"> & { hasLogo?: boolean } };
  try { input = await req.json(); } catch { return reply({ error: "Bad request" }, 400); }
  const brand = input.brand;
  if (input.action !== "design" || !brand || typeof brand.name !== "string") return reply({ error: "Bad request" }, 400);
  const seed = Number.isFinite(input.seed) ? Number(input.seed) : 1;
  // The rules are checked without the logo picture (its size comes with the brand): the header is measured with a logo-sized gap.
  const checkBrand: Brand = { ...brand, logoSrc: null, logoColors: brand.logoColors ?? [], siteColors: brand.siteColors ?? [], siteFonts: brand.siteFonts ?? [] };
  const designs: Array<{ style: LetterheadStyle; spec: LetterheadSpec; tries: number }> = [];
  await Promise.all(LETTERHEAD_STYLES.map(async ({ style }) => {
    let problems: string[] = [];
    for (let tries = 1; tries <= 3; tries++) {
      const spec = await propose(brand, style, seed, problems).catch(() => null);
      if (!spec) { problems = ["The answer was not a valid design object."]; continue; }
      const check = await checkLetterhead(spec, checkBrand);
      if (check.ok) { designs.push({ style, spec, tries }); return; }
      problems = check.problems;
    }
  }));
  designs.sort((a, b) => LETTERHEAD_STYLES.findIndex((s) => s.style === a.style) - LETTERHEAD_STYLES.findIndex((s) => s.style === b.style));
  return reply({ designs, model: MODEL });
});
