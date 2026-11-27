/**
 * ASM unit-mapping suggestions (JWT on; an Admin or RTO Manager's call). Since ASM-PDF-TEMPLATE phase 4 (2026-11-26) this is all
 * the function does: the workbook import pipeline (jobs, queue, cron, the asm-imports bucket) was removed, assessments are the
 * uploaded workbook PDF with its fields (the PDF template).
 *
 * suggest_mapping: the template's questions (printed numbers, the question text) and the unit's criteria from training.gov.au are
 * sent to the AI, which suggests which question covers which criterion; suggestions are kept in asm_mapping_suggestions for the
 * admin to tick (confirmed / dismissed decisions are kept). Only workbook text is sent, never student data. The API key is
 * OPENAI_API_KEY (server side only, never logged or returned). The AI does not mark.
 *
 * classify_fields (ASM-ANY-LAYOUT, 2026-11-27): one page of a blank workbook (its image with the numbered candidate areas, and the
 * numbered list) for the areas the browser's rules could not settle; the AI says what each one is (student answer / trainer field /
 * record field / not a field, the printed question number, the kind). Only real candidate numbers are kept. Cheapest good model by
 * default (EF_ASM_CLASSIFY_MODEL, gpt-4.1-mini); every call is logged in asm_ai_usage with its tokens and cost, and a workbook stops
 * before it would pass US$2 (EF_ASM_CLASSIFY_LIMIT_USD). Never used while answering, marking or making the PDF.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { AiError, createProvider, type StructuredProvider } from "../_shared/asm-import/provider.ts";
import { MAPPABLE_KINDS, mappingRequest, mockMappingAnswer, resolveSuggestions, type MappingCriterion, type MappingQuestion } from "../_shared/asm-import/mapping.ts";
import { classifyRequest, estimateInputTokens, mockClassification, validateClassification, type ClassifyPage } from "../_shared/asm-import/classify.ts";
import { costUsd } from "../_shared/asm-import/provider.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function provider(): StructuredProvider {
  return createProvider({
    provider: Deno.env.get("EF_ASM_IMPORT_PROVIDER") ?? "openai",
    model: Deno.env.get("EF_ASM_IMPORT_MODEL") || Deno.env.get("OPENAI_DOCUMENT_MODEL") || "",
    apiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
    baseUrl: Deno.env.get("OPENAI_BASE_URL") ?? undefined,
    mock: (r) => mockMappingAnswer(r),
  });
}

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tenant-domain", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
/** A question of the workbook PDF template: its key (task.number), the number as printed and the question text. */
interface TemplateQ { key: string; seq?: string; display?: string; label?: string; prompt?: unknown }

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
function classifier(): StructuredProvider {
  return createProvider({
    provider: Deno.env.get("EF_ASM_CLASSIFY_PROVIDER") ?? Deno.env.get("EF_ASM_IMPORT_PROVIDER") ?? "openai",
    model: Deno.env.get("EF_ASM_CLASSIFY_MODEL") || "gpt-4.1-mini",
    apiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
    baseUrl: Deno.env.get("OPENAI_BASE_URL") ?? undefined,
    mock: (r) => mockClassification(r),
  });
}

async function classifyFields(request: Request, body: { assessmentId?: unknown; pdfSha256?: unknown; page?: unknown }): Promise<Response> {
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const authorization = request.headers.get("Authorization") ?? "";
  if (!anon || !authorization.startsWith("Bearer ")) return reply({ error: "Sign in first." }, 401);
  const auth = { persistSession: false, autoRefreshToken: false };
  const caller = createClient(url, anon, { auth, global: { headers: { Authorization: authorization } } });
  const { data: { user } } = await caller.auth.getUser(authorization.slice(7));
  if (!user) return reply({ error: "Your session has expired. Sign in again." }, 401);
  const { data: allowed } = await caller.rpc("asm_is_admin");
  if (allowed !== true) return reply({ error: "Admin or RTO Manager access is required." }, 403);
  const assessmentId = body.assessmentId; const sha = body.pdfSha256; const page = body.page as ClassifyPage | null;
  if (typeof assessmentId !== "string" || !/^[0-9a-f-]{36}$/i.test(assessmentId)) return reply({ error: "Choose an assessment." }, 400);
  if (typeof sha !== "string" || !/^[a-f0-9]{64}$/.test(sha)) return reply({ error: "The workbook is not identified." }, 400);
  if (!page || !Number.isInteger(page.page) || page.page < 1 || page.page > 600 || !Array.isArray(page.candidates) || !page.candidates.length || page.candidates.length > 400) return reply({ error: "Send one page with its candidate areas." }, 400);
  if (typeof page.imageDataUrl !== "string" || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(page.imageDataUrl) || page.imageDataUrl.length > 4_000_000) return reply({ error: "The page image is missing or too large." }, 400);
  if (!(page.imageWidth > 0 && page.imageWidth <= 4000 && page.imageHeight > 0 && page.imageHeight <= 6000)) return reply({ error: "The page image size is not valid." }, 400);
  const ns = page.candidates.map((c) => Number(c?.n));
  if (ns.some((n) => !Number.isInteger(n) || n < 1) || new Set(ns).size !== ns.length) return reply({ error: "Candidate numbers must be distinct whole numbers." }, 400);
  // the assessment must be the caller's (their institution)
  const { data: mine } = await caller.from("asm_assessments").select("id,tenant_id").eq("id", assessmentId).maybeSingle();
  if (!mine) return reply({ error: "Assessment not found." }, 404);
  const db = createClient(url, serviceKey, { auth });
  let ai: StructuredProvider;
  try { ai = classifier(); } catch (e) { return reply({ error: e instanceof Error ? e.message : "The AI classifier is not configured." }, 503); }
  const inPrice = num(Deno.env.get("EF_ASM_CLASSIFY_INPUT_USD_PER_MILLION"), 0.4); const outPrice = num(Deno.env.get("EF_ASM_CLASSIFY_OUTPUT_USD_PER_MILLION"), 1.6);
  const limit = num(Deno.env.get("EF_ASM_CLASSIFY_LIMIT_USD"), 2);
  // the workbook's spend so far; the page's upper bound is checked before the call
  const { data: spentRows } = await db.from("asm_ai_usage").select("cost_usd").eq("pdf_sha256", sha);
  const spent = (spentRows ?? []).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
  const req = classifyRequest(page, "high");
  const estimate = (estimateInputTokens(page) * inPrice + req.maxOutputTokens * outPrice) / 1e6;
  if (spent + estimate > limit) {
    return reply({ error: `This workbook has used US$${spent.toFixed(2)} of its US$${limit.toFixed(2)} AI limit and page ${page.page} could pass it. The remaining areas are left for you to set by hand.`, code: "budget", spentUsd: spent, limitUsd: limit }, 402);
  }
  try {
    const out = await ai.generate(req);
    const checked = validateClassification(out.data, ns);
    const cost = costUsd(out.usage, inPrice, outPrice) ?? 0;
    await db.from("asm_ai_usage").insert({ tenant_id: mine.tenant_id ?? null, assessment_id: assessmentId, pdf_sha256: sha, action: "classify_fields", model: ai.model, page: page.page,
      candidates: ns.length, input_tokens: out.usage.inputTokens, output_tokens: out.usage.outputTokens, cost_usd: cost, refused: checked.refused, created_by: user.id });
    return reply({ page: page.page, fields: checked.fields, refused: checked.refused, usage: out.usage, costUsd: cost, spentUsd: spent + cost, limitUsd: limit, model: ai.model, provider: ai.id });
  } catch (e) {
    return reply({ error: e instanceof AiError ? e.message : "The AI classifier could not read this page." }, 502);
  }
}

async function suggestMapping(request: Request, assessmentId: unknown): Promise<Response> {
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const authorization = request.headers.get("Authorization") ?? "";
  if (!anon || !authorization.startsWith("Bearer ")) return reply({ error: "Sign in first." }, 401);
  const auth = { persistSession: false, autoRefreshToken: false };
  const caller = createClient(url, anon, { auth, global: { headers: { Authorization: authorization } } });
  const { data: { user } } = await caller.auth.getUser(authorization.slice(7));
  if (!user) return reply({ error: "Your session has expired. Sign in again." }, 401);
  const { data: allowed } = await caller.rpc("asm_is_admin");
  if (allowed !== true) return reply({ error: "Admin or RTO Manager access is required." }, 403);
  if (typeof assessmentId !== "string" || !/^[0-9a-f-]{36}$/i.test(assessmentId)) return reply({ error: "Choose an assessment." }, 400);
  const db = createClient(url, serviceKey, { auth });
  const { data: as } = await db.from("asm_assessments").select("id,unit_id,current_version_id,title").eq("id", assessmentId).maybeSingle();
  if (!as?.unit_id) return reply({ error: "Choose the unit of competency on the assessment first." }, 400);
  const { data: versions } = await db.from("asm_versions").select("id,status,template,version_no").eq("assessment_id", assessmentId).order("version_no", { ascending: false });
  const version = (versions ?? []).find((v) => v.status === "draft") ?? (versions ?? []).find((v) => v.id === as.current_version_id) ?? versions?.[0];
  if (!version) return reply({ error: "The assessment has no version yet." }, 400);
  const [{ data: unit }, { data: elements }] = await Promise.all([
    db.from("cms_course_units").select("code,name").eq("id", as.unit_id).maybeSingle(),
    db.from("asm_unit_elements").select("id,kind,code,text,parent_id,sort").eq("unit_id", as.unit_id).eq("is_active", true).in("kind", MAPPABLE_KINDS).order("kind").order("sort"),
  ]);
  // the printed question numbers of the workbook PDF template are the mapping's keys
  const tq = ((version.template as { questions?: TemplateQ[] } | null)?.questions ?? []);
  const questions: MappingQuestion[] = tq.map((q) => ({ id: q.key, number: q.display || q.seq || q.key, text: String(q.label ?? "").slice(0, 1200), answer: null }));
  const criteria: MappingCriterion[] = (elements ?? []).map((e) => ({ id: e.id as string, kind: e.kind as string, code: (e.code as string) ?? "", text: e.text as string, parent: (e.parent_id as string | null) ?? null }));
  if (!questions.length || !criteria.length) return reply({ suggestions: [], note: !criteria.length ? "Load the unit's criteria first." : "Upload the workbook PDF first: it has no questions to map yet." });
  let ai: StructuredProvider;
  try { ai = provider(); } catch (e) { return reply({ error: e instanceof Error ? e.message : "The AI reader is not configured." }, 503); }
  try {
    const out = await ai.generate(mappingRequest({ code: unit?.code ?? "", name: unit?.name ?? "" }, questions.slice(0, 200), criteria.slice(0, 300)));
    const found = resolveSuggestions(out.data, questions, criteria);
    // fresh suggestions replace the open ones; confirmed / dismissed decisions are kept
    await db.from("asm_mapping_suggestions").delete().eq("assessment_id", assessmentId).eq("state", "suggested");
    if (found.length) {
      await db.from("asm_mapping_suggestions").upsert(found.map((s) => ({ assessment_id: assessmentId, question_id: s.questionId, element_id: s.elementId, confidence: s.confidence, reason: s.reason, model: ai.model })),
        { onConflict: "assessment_id,question_id,element_id", ignoreDuplicates: true });
    }
    const { data: list } = await caller.rpc("asm_mapping_suggestions_list", { p_assessment: assessmentId });
    return reply({ suggestions: list ?? [], usage: out.usage, model: ai.model, provider: ai.id });
  } catch (e) {
    return reply({ error: e instanceof AiError ? e.message : "The AI reader could not suggest a mapping." }, 502);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!url || !serviceKey) return new Response(null, { status: 503 });
  const ask = await request.clone().json().catch(() => null) as { action?: unknown; assessmentId?: unknown; pdfSha256?: unknown; page?: unknown } | null;
  if (ask?.action === "suggest_mapping") return await suggestMapping(request, ask.assessmentId);
  if (ask?.action === "classify_fields") return await classifyFields(request, ask);
  return reply({ error: "Unknown action." }, 400);
});
