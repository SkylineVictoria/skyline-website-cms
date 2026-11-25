/**
 * ASM-AI-IMPORT worker (JWT-verified, service callers only; dispatched by public.asm_import_dispatch via pg_net, then by itself).
 *
 * Each call claims one import job (public.asm_import_claim: lease, one worker per job) and does ONE step:
 *   outline -> one task chunk at a time -> assemble.
 * After a step it hands the next one to a fresh call (its own URL, the same service credential), so no call runs long and the
 * browser sees live progress (asm_import_status). A job that stops (worker killed) is picked up again by the every-minute cron.
 *
 * Only the uploaded workbook / answer guide (its page text, and images of pages with no text layer) is sent to the AI; never
 * student data. The API key is OPENAI_API_KEY (server side only, never logged or returned). The AI does not mark.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { isServiceCaller } from "../_shared/service-role.ts";
import { AiError, costUsd, createProvider, type AiUsage, type StructuredProvider } from "../_shared/asm-import/provider.ts";
import { assemble, checkChunk, cleanOutline, mockAnswer, outlineRequest, planChunks, READER_VERSION, summarize, taskRequest, type Chunk, type PageText } from "../_shared/asm-import/pipeline.ts";
import type { AiOutline, AiTaskPart, CheckedSection } from "../_shared/asm-import/schema.ts";
import { MAPPABLE_KINDS, mappingRequest, mockMappingAnswer, resolveSuggestions, type MappingCriterion, type MappingQuestion } from "../_shared/asm-import/mapping.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BUCKET = "asm-imports";
const MAX_ATTEMPTS = 3;
const price = (name: string) => { const v = Number(Deno.env.get(name)); return Number.isFinite(v) && v >= 0 && Deno.env.get(name) ? v : undefined; };

function provider(): StructuredProvider {
  return createProvider({
    provider: Deno.env.get("EF_ASM_IMPORT_PROVIDER") ?? "openai",
    model: Deno.env.get("EF_ASM_IMPORT_MODEL") || Deno.env.get("OPENAI_DOCUMENT_MODEL") || "",
    apiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
    baseUrl: Deno.env.get("OPENAI_BASE_URL") ?? undefined,
    mock: (r) => (r.name === "asm_mapping" ? mockMappingAnswer(r) : mockAnswer(r)),
  });
}

interface Job {
  id: string; kind: "workbook" | "guide"; sha256: string; bytes: number; lease: string;
  outline: AiOutline | null; plan: Chunk[] | null; chunk_results: (CheckedSection[] | null)[] | null; next_chunk: number; chunk_attempts: number;
  scanned_pages: number[]; usage: { input_tokens?: number; output_tokens?: number; calls?: number; cost_usd?: number | null } | null;
  provider: string | null; model: string | null;
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (bytes: Uint8Array) => { let out = ""; for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(out); };

async function pagesOf(db: SupabaseClient, job: Job): Promise<PageText[]> {
  const got = await db.storage.from(BUCKET).download(`${job.id}/pages.json`);
  if (got.error || !got.data) throw new AiError("The page text of the upload could not be read.", "config", false);
  const raw = JSON.parse(await got.data.text()) as { page: number; text: string; scanned?: boolean; pictures?: number }[];
  if (!Array.isArray(raw) || !raw.length) throw new AiError("The upload has no pages.", "config", false);
  return raw.map((p) => ({ page: Number(p.page), text: String(p.text ?? "").slice(0, 40_000), scanned: Boolean(p.scanned), pictures: Math.max(0, Math.min(20, Math.floor(Number(p.pictures) || 0))) }))
    .filter((p) => Number.isInteger(p.page) && p.page > 0);
}

async function imagesOf(db: SupabaseClient, job: Job, pages: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const p of pages.slice(0, 12)) {
    const got = await db.storage.from(BUCKET).download(`${job.id}/page-${p}.jpg`);
    if (!got.error && got.data) out.set(p, `data:image/jpeg;base64,${b64(new Uint8Array(await got.data.arrayBuffer()))}`);
  }
  return out;
}

function addUsage(job: Job, u: AiUsage | undefined) {
  const usage = { input_tokens: (job.usage?.input_tokens ?? 0) + (u?.inputTokens ?? 0), output_tokens: (job.usage?.output_tokens ?? 0) + (u?.outputTokens ?? 0), calls: (job.usage?.calls ?? 0) + (u ? 1 : 0) };
  const cost = costUsd({ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }, price("EF_ASM_IMPORT_INPUT_USD_PER_MILLION"), price("EF_ASM_IMPORT_OUTPUT_USD_PER_MILLION"));
  job.usage = { ...usage, cost_usd: cost };
  return job.usage;
}

const progressOf = (job: Job, label: string) => {
  const total = (job.plan?.length ?? 0) + 2;
  const done = job.outline ? 1 + job.next_chunk : 0;
  return { label, done, total };
};

/** One step of one job. Returns true when more work is left. */
async function step(db: SupabaseClient, job: Job): Promise<boolean> {
  const save = async (patch: Record<string, unknown>) => {
    const { error, data } = await db.from("asm_import_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", job.id).eq("lease", job.lease).select("id");
    if (error) throw new AiError("The import progress could not be saved.", "config", true);
    if (!data?.length) throw new AiError("Another worker took over this import.", "config", false);
  };
  let ai: StructuredProvider;
  try { ai = provider(); } catch (e) {
    await save({ state: "failed", error: e instanceof Error ? e.message : "The AI reader is not configured.", lease: null, lease_until: null, finished_at: new Date().toISOString() });
    return false;
  }
  try {
    if (!job.outline) {
      // the upload is what was hashed in the browser (the cache relies on it)
      const src = await db.storage.from(BUCKET).download(`${job.id}/source.pdf`);
      if (src.error || !src.data) throw new AiError("The uploaded file could not be read.", "config", false);
      const bytes = await src.data.arrayBuffer();
      if (bytes.byteLength !== job.bytes || hex(await crypto.subtle.digest("SHA-256", bytes)) !== job.sha256) throw new AiError("The uploaded file does not match its fingerprint.", "config", false);
      const pages = await pagesOf(db, job);
      const req = outlineRequest(job.kind, pages);
      const scanned = pages.filter((p) => p.scanned).map((p) => p.page);
      if (scanned.length && scanned.length === pages.length) {
        const imgs = await imagesOf(db, job, scanned.slice(0, 6));
        for (const [p, img] of imgs) req.input.push({ kind: "text", text: `Image of page ${p}:` }, { kind: "image", dataUrl: img });
      }
      const out = await ai.generate(req);
      const outline = cleanOutline(out.data as AiOutline, pages);
      const plan = planChunks(outline);
      job.outline = outline; job.plan = plan; job.next_chunk = 0;
      await save({ outline, plan, chunk_results: plan.map(() => null), next_chunk: 0, chunk_attempts: 0, provider: ai.id, model: ai.model, scanned_pages: scanned,
        usage: addUsage(job, out.usage), progress: progressOf(job, plan.length ? `Reading task 1 of ${outline.tasks.length}` : "Finishing"),
        summary: { ...summarize([], scanned.length), tasks: outline.tasks.length, unit: outline.unit_code, version: outline.version } });
      return true;
    }
    const plan = job.plan ?? [];
    const results = job.chunk_results ?? plan.map(() => null);
    if (job.next_chunk < plan.length) {
      const chunk = plan[job.next_chunk];
      const pages = await pagesOf(db, job);
      const scannedHere = pages.filter((p) => p.scanned && p.page >= chunk.from && p.page <= chunk.to).map((p) => p.page);
      const out = await ai.generate(taskRequest(job.kind, job.outline, chunk, pages, await imagesOf(db, job, scannedHere)));
      results[job.next_chunk] = checkChunk(out.data as AiTaskPart, chunk, pages);
      job.next_chunk += 1;
      const partial = assemble(job.kind, job.outline, plan, results, { provider: ai.id, model: ai.model, scannedPages: job.scanned_pages?.length ?? 0 });
      const nextTask = plan[job.next_chunk]?.task;
      await save({ chunk_results: results, next_chunk: job.next_chunk, chunk_attempts: 0, usage: addUsage(job, out.usage),
        progress: progressOf(job, nextTask === undefined ? "Finishing" : `Reading task ${nextTask + 1} of ${job.outline.tasks.length}`),
        summary: { ...partial.summary, unit: job.outline.unit_code, version: job.outline.version } });
      return true;
    }
    const doc = assemble(job.kind, job.outline, plan, results, { provider: job.provider ?? ai.id, model: job.model ?? ai.model, scannedPages: job.scanned_pages?.length ?? 0 });
    // the reader version that produced this result: the cache answers it only to a browser asking for the same version
    await save({ state: "done", reader_version: READER_VERSION, result: doc, summary: { ...doc.summary, unit: doc.unit?.code ?? null, version: doc.version }, progress: { label: "Done", done: plan.length + 2, total: plan.length + 2 },
      lease: null, lease_until: null, finished_at: new Date().toISOString(), error: null });
    return false;
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError("The AI reader failed.", "provider", true);
    const usage = (e as { usage?: AiUsage }).usage;
    if (usage) addUsage(job, usage);
    // a part too long for one answer: split it and go on
    if (err.code === "incomplete" && job.outline && job.plan && job.next_chunk < job.plan.length) {
      const c = job.plan[job.next_chunk];
      if (c.to > c.from) {
        const mid = Math.floor((c.from + c.to) / 2);
        const plan = [...job.plan.slice(0, job.next_chunk), { ...c, to: mid }, { ...c, from: mid + 1 }, ...job.plan.slice(job.next_chunk + 1)];
        const results = [...(job.chunk_results ?? []).slice(0, job.next_chunk), null, null, ...(job.chunk_results ?? []).slice(job.next_chunk + 1)];
        await save({ plan, chunk_results: results, usage: job.usage, lease: null, lease_until: null });
        return true;
      }
    }
    const attempts = job.chunk_attempts + 1;
    if (err.retry && attempts < MAX_ATTEMPTS) {
      await save({ chunk_attempts: attempts, usage: job.usage, lease: null, lease_until: new Date(Date.now() + 20_000 * attempts).toISOString(), error: err.message });
      return true;
    }
    await save({ state: "failed", error: err.message, usage: job.usage, lease: null, lease_until: null, finished_at: new Date().toISOString() });
    return false;
  }
}

/* ------------------------------------------------------------------ ASM-BUILDER: AI-suggested unit mapping (an admin's call) */
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tenant-domain", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const NOT_QUESTIONS = new Set(["instruction", "content", "declaration", "adjustment_record"]);
interface DefQ { id: string; type: string; label?: string; markingMode?: string; importMeta?: { number?: string | null } }

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
  const { data: versions } = await db.from("asm_versions").select("id,status,definition,version_no").eq("assessment_id", assessmentId).order("version_no", { ascending: false });
  const version = (versions ?? []).find((v) => v.status === "draft") ?? (versions ?? []).find((v) => v.id === as.current_version_id) ?? versions?.[0];
  if (!version) return reply({ error: "The assessment has no version yet." }, 400);
  const [{ data: unit }, { data: elements }, { data: keys }] = await Promise.all([
    db.from("cms_course_units").select("code,name").eq("id", as.unit_id).maybeSingle(),
    db.from("asm_unit_elements").select("id,kind,code,text,parent_id,sort").eq("unit_id", as.unit_id).eq("is_active", true).in("kind", MAPPABLE_KINDS).order("kind").order("sort"),
    db.from("asm_question_keys").select("question_id,model_answer,assessor_guidance").eq("version_id", version.id),
  ]);
  const keyOf = new Map((keys ?? []).map((k) => [k.question_id as string, [k.model_answer, k.assessor_guidance].filter(Boolean).join(" ") || null]));
  const questions: MappingQuestion[] = [];
  const def = version.definition as { tasks?: { sections?: { questions?: DefQ[] }[] }[] };
  (def.tasks ?? []).forEach((t, ti) => {
    let n = 0;
    for (const q of (t.sections ?? []).flatMap((x) => x.questions ?? [])) {
      if (NOT_QUESTIONS.has(q.type) || q.markingMode === "none") continue;
      n += 1;
      questions.push({ id: q.id, number: q.importMeta?.number ?? `${ti + 1}.${n}`, text: String(q.label ?? "").slice(0, 1200), answer: keyOf.get(q.id) ?? null });
    }
  });
  const criteria: MappingCriterion[] = (elements ?? []).map((e) => ({ id: e.id as string, kind: e.kind as string, code: (e.code as string) ?? "", text: e.text as string, parent: (e.parent_id as string | null) ?? null }));
  if (!questions.length || !criteria.length) return reply({ suggestions: [], note: !criteria.length ? "Load the unit's criteria first." : "The assessment has no questions to map." });
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
  const ask = await request.clone().json().catch(() => null) as { action?: unknown; assessmentId?: unknown } | null;
  if (ask?.action === "suggest_mapping") return await suggestMapping(request, ask.assessmentId);
  const authorization = request.headers.get("Authorization");
  if (!isServiceCaller(authorization, serviceKey, url)) return new Response(null, { status: 403 });
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const claim = await db.rpc("asm_import_claim");
  if (claim.error) return new Response(null, { status: 500 });
  const job = claim.data as Job | null;
  if (!job?.id) return new Response(null, { status: 204 });
  const work = (async () => {
    let more = false;
    try { more = await step(db, job); } catch { more = true; }
    // release a lease this step did not release (the next call claims the job again)
    await db.from("asm_import_jobs").update({ lease: null, lease_until: null }).eq("id", job.id).eq("lease", job.lease);
    if (more) {
      await fetch(`${url}/functions/v1/asm-import`, { method: "POST", headers: { Authorization: authorization ?? "", "Content-Type": "application/json" }, body: "{}" })
        .then((r) => r.body?.cancel()).catch(() => undefined);
    }
  })();
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime) { runtime.waitUntil(work); return new Response(null, { status: 202 }); }
  await work;
  return new Response(null, { status: 202 });
});

