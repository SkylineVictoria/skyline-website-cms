import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { generatePractice, sourceInput, type PracticeRequest } from "./generate.ts";
import { tutorAnswer, tutorInput } from "./tutor.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const key = Deno.env.get("OPENAI_API_KEY") ?? "";
const model = Deno.env.get("EF_STUDENT_PRACTICE_MODEL") || Deno.env.get("OPENAI_DOCUMENT_MODEL") || "";
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tenant-domain",
  "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store" };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers });

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return json({ message: "Method not allowed." }, 405);
  const token = request.headers.get("Authorization");
  if (!token?.startsWith("Bearer ")) return json({ message: "Sign in as a student to practise." }, 401);
  if (!url || !anon || !service) return json({ message: "Practice is unavailable." }, 503);
  const tenant = request.headers.get("x-tenant-domain");
  const caller = createClient(url, anon, { global: { headers: { Authorization: token, ...(tenant ? { "x-tenant-domain": tenant } : {}) } },
    auth: { persistSession: false } });
  const input = await request.json().catch(() => null);
  // Learning with AI (mode "tutor", 20261123181517): a question about a unit, answered from its learner material.
  if (input && input.mode === "tutor") {
    const ask = tutorInput(input);
    if (!ask) return json({ message: "Write a question about one of your units (up to 1000 characters)." }, 400);
    const started = await caller.rpc("student_tutor_start", { p_unit: ask.unitId });
    if (started.error) return started.error.code === "42501" || started.error.code === "22023"
      ? json({ message: started.error.message }, started.error.code === "42501" ? 403 : 400)
      : json({ message: "Learning with AI is temporarily unavailable." }, 503);
    if (!key || !model) return json({ message: "Learning with AI has not been configured." }, 503);
    try {
      const result = await tutorAnswer(started.data.unitTitle, started.data.sources, ask.question, ask.history, async (bucket, path) => {
        const fetched = await caller.storage.from(bucket).download(path);
        if (fetched.error || !fetched.data) throw new Error("This learning material is no longer available.");
        return fetched.data;
      }, key, model);
      return json(result);
    } catch (e) {
      return json({ message: e instanceof Error ? e.message : "The AI could not answer. Please try again." }, 503);
    }
  }
  if (!input || !["easy", "medium", "advanced"].includes(input.difficulty)
    || !["unitId", "assignmentId", "focus"].every(field => input[field] == null || typeof input[field] === "string" && input[field].length <= 120)) {
    return json({ message: "Choose a unit and practice difficulty." }, 400);
  }
  const data = { unitId: input.unitId, assignmentId: input.assignmentId, focus: input.focus, difficulty: input.difficulty };
  const next = await caller.rpc("student_practice", { p_action: "next", p_data: data });
  if (next.error) return next.error.code === "42501" || next.error.code === "22023"
    ? json({ message: next.error.message }, next.error.code === "42501" ? 403 : 400)
    : json({ message: "Practice is temporarily unavailable." }, 503);
  if (next.data?.state !== "generate") return json(next.data);
  if (!key || !model) return json({ message: "AI question generation has not been configured." }, 503);

  const prepared = await caller.rpc("student_practice", { p_action: "prepare", p_data: data });
  if (prepared.error) return json({ message: "Question generation could not start." }, 503);
  if (prepared.data?.state !== "reserved") return json(prepared.data);
  const job = prepared.data as PracticeRequest;
  const worker = createClient(url, service, { auth: { persistSession: false } });
  const finish = (questions: unknown[]) => worker.rpc("lms_practice_finish", { p_request: job.requestId, p_questions: questions });
  try {
    const material = await sourceInput(job.source, async (bucket, path) => {
      const fetched = await caller.storage.from(bucket).download(path);
      if (fetched.error || !fetched.data) throw new Error("This learning material is no longer available.");
      return fetched.data;
    });
    const questions = await generatePractice(job, input.difficulty, material, key, model);
    const saved = await finish(questions);
    if (saved.error) throw new Error("The new questions could not be saved.");
    if (!saved.data) return json({ state: "no_questions" });
    const served = await caller.rpc("student_practice", { p_action: "next", p_data: data });
    return served.error ? json({ message: "The new questions could not be opened." }, 503) : json(served.data);
  } catch {
    await finish([]);
    return json({ message: "Questions could not be generated from the learning material. Please try again." }, 503);
  }
});
