import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration } from "../_shared/config.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "",
  serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  openAiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
const configuredOpenAiBaseUrl = (Deno.env.get("OPENAI_BASE_URL") ?? "").replace(
  /\/$/,
  "",
);
// A provider override is intentionally available only to the disposable local
// test key and a local Docker/loopback endpoint. Real keys always use OpenAI.
const openAiBaseUrl = openAiKey === "local-test-openai-key" &&
    /^http:\/\/(127\.0\.0\.1|localhost|host\.docker\.internal)(:\d+)?\/v1$/
      .test(configuredOpenAiBaseUrl)
  ? configuredOpenAiBaseUrl
  : "https://api.openai.com/v1";
/**
 * Do not concatenate a URL that could have been copied from rendered text.
 * Production always uses the literal OpenAI API origin; the local-test
 * override above remains deliberately limited to loopback.
 */
function openAiEndpoint(resource: "embeddings" | "responses"): string {
  const endpoint = new URL(resource, `${openAiBaseUrl}/`);
  const isLocalTest = openAiKey === "local-test-openai-key";
  if (
    endpoint.pathname !== `/v1/${resource}` ||
    (!isLocalTest && endpoint.origin !== "https://api.openai.com")
  ) {
    throw new Error("invalid_openai_endpoint");
  }
  return endpoint.toString();
}
const embeddingModel = Deno.env.get("PUBLIC_ASSISTANT_EMBEDDING_MODEL") ??
    "text-embedding-3-small",
  generationModel = Deno.env.get("PUBLIC_ASSISTANT_GENERATION_MODEL") ??
    "gpt-4.1-mini",
  allowGeneration =
    Deno.env.get("PUBLIC_ASSISTANT_ENABLE_GENERATION") === "true";
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // supabase-js invokes Functions with its client-identification header as
  // well as JSON/auth headers. A missing item here makes browsers stop at
  // preflight, so the POST never reaches this handler.
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  // Cache a successful preflight briefly; this is not polling and does not
  // invoke retrieval or indexing while the widget is idle.
  "Access-Control-Max-Age": "600",
  "Access-Control-Expose-Headers": "Retry-After",
  "Content-Type": "application/json",
};
const reply = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, ...extraHeaders } });
const normalise = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ")
    .trim();
const hash = async (value: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ].map((x) => x.toString(16).padStart(2, "0")).join("");
type Source = { title: string; url: string };
type Course = {
  name: string;
  code: string;
  cricos: string;
  duration: string;
  mode: string;
  fees: string;
  slug: string;
};
const courseSource = (course: Course): Source => ({
  title: course.name,
  url: `/courses/${course.slug}`,
});
function courseAnswer(
  courses: Course[],
  question: string,
): { answer: string; sources: Source[]; mode: "course" } | null {
  const q = normalise(question);
  const matched = courses.filter((c) =>
    [c.name, c.code, c.cricos, c.slug].filter(Boolean).some((v) =>
      q.includes(normalise(v))
    )
  );
  if (matched.length > 1) {
    return {
      answer:
        "I found more than one matching course. Please include the course code or full course name.",
      sources: matched.slice(0, 4).map(courseSource),
      mode: "course",
    };
  }
  if (matched.length === 1) {
    const c = matched[0];
    if (/\b(fee|fees|cost|tuition)\b/.test(q) && c.fees) {
      return {
        answer: `Published fees for ${c.name}: ${c.fees}`,
        sources: [courseSource(c)],
        mode: "course",
      };
    }
    if (/\b(duration|long|weeks?|months?)\b/.test(q) && c.duration) {
      return {
        answer: `${c.name} has a published duration of ${c.duration}.`,
        sources: [courseSource(c)],
        mode: "course",
      };
    }
    if (/\b(mode|delivery|online|campus|location)\b/.test(q) && c.mode) {
      return {
        answer: `${c.name} is published with delivery mode: ${c.mode}.`,
        sources: [courseSource(c)],
        mode: "course",
      };
    }
    return {
      answer: `${c.name}${c.code ? ` (${c.code})` : ""}${
        c.cricos ? ` — CRICOS ${c.cricos}` : ""
      }. View the published course page for requirements, units and current details.`,
      sources: [courseSource(c)],
        mode: "course",
    };
  }
  if (/\b(course|courses|study|program)\b/.test(q)) {
    return {
      answer: "Here are the currently published SLIT courses.",
      sources: courses.slice(0, 6).map(courseSource),
      mode: "course",
    };
  }
  if (/\b(apply|application|enrol)\b/.test(q)) {
    return {
      answer:
        "You can begin a public application from the published enrolment page.",
      sources: [{ title: "Apply to SLIT", url: "/enroll-now" }],
      mode: "course",
    };
  }
  if (/\b(contact|phone|email|address)\b/.test(q)) {
    return {
      answer:
        "Please use the published contact page for current SLIT contact details.",
      sources: [{ title: "Contact SLIT", url: "/contact" }],
      mode: "course",
    };
  }
  return null;
}
async function embed(question: string) {
  const r = await fetch(openAiEndpoint("embeddings"), {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${openAiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: question,
      dimensions: 1536,
    }),
  });
  if (!r.ok) throw new Error("embedding unavailable");
  const p = await r.json();
  return {
    vector: p?.data?.[0]?.embedding,
    tokens: Number(p?.usage?.total_tokens ?? 0),
  };
}
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  const configuration = backendConfiguration(url, serviceKey);
  if (configuration) return reply(configuration, 503);
  if (request.method !== "POST") {
    return reply({ error: "Method not allowed." }, 405);
  }
  const body = await request.json().catch(() => ({}));
  const question = typeof body.question === "string"
    ? body.question.trim().slice(0, 500)
    : "";
  if (!question) return reply({ error: "Please enter a question." }, 400);
  // Partition the existing single-institution public cache by requesting origin.
  // This is cache hygiene, not tenant authorization; tenant routing remains gated.
  let cacheScope: string;
  try {
    const origin = new URL(request.headers.get("Origin") ?? request.url);
    if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password) throw new Error("invalid origin");
    cacheScope = origin.origin;
  } catch {
    return reply({ error: "Invalid request origin." }, 400);
  }
  const cacheKey = await hash(`${cacheScope}\n${normalise(question)}`);
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
  const clientKey = await hash(
    request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-forwarded-for") ?? "anonymous",
  );
  const { data: allowed } = await admin.rpc(
    "public_assistant_take_rate_limit",
    { p_bucket: `request:${clientKey}`, p_limit: 20, p_window_seconds: 60 },
  );
  if (!allowed) {
    await admin.from("public_assistant_usage_events").insert({
      kind: "rate_limited",
      request_key: clientKey,
    });
    return reply({
      error: "Please wait a moment before asking another question.",
    }, 429, { "Retry-After": "60" });
  }
  const [
    { data: version },
    { data: cached },
    { data: faqs },
    { data: courses },
  ] = await Promise.all([
    admin.rpc("public_assistant_content_version"),
    admin.from("public_assistant_answer_cache").select("answer").eq(
      "cache_key",
      cacheKey,
    ).is("tenant_id", null).gt("expires_at", new Date().toISOString()).maybeSingle(),
    admin.from("public_assistant_faqs").select(
      "question,normalized_question,aliases,answer,source_url",
    ).eq("status", "published").is("tenant_id", null),
    admin.from("cms_courses").select("name,code,cricos,duration,mode,fees,slug")
      .eq("status", "Published").is("tenant_id", null).order("display_order"),
  ]);
  if (cached?.answer && cached.answer.source_version === version && cached.answer.cache_scope === cacheScope) {
    return reply(cached.answer);
  }
  const faq = (faqs ?? []).find((f: any) =>
    [f.normalized_question, ...(f.aliases ?? []).map(normalise)].includes(
      normalise(question),
    )
  );
  let answer = faq
    ? {
      answer: faq.answer,
      sources: [{ title: faq.question, url: faq.source_url }],
      mode: "faq",
    }
    : courseAnswer((courses ?? []) as Course[], question);
  if (!answer && openAiKey) {
    try {
      const e = await embed(question);
      const { data: chunks } = await admin.rpc(
        "public_assistant_search_chunks",
        {
          p_query: e.vector,
          p_query_text: question,
          p_course_code: null,
          p_limit: 6,
        },
      );
      if (chunks?.length) {
        const sources = [
          ...new Map(
            chunks.map((
              c: any,
            ) => [c.canonical_url, { title: c.title, url: c.canonical_url }]),
          ).values(),
        ] as Source[];
        if (allowGeneration) {
          const { data: slot } = await admin.rpc(
            "public_assistant_take_generation_slot",
            { p_daily_limit: 200 },
          );
          if (slot) {
            try {
              const context = chunks.map((c: any) =>
                `[${c.title}] ${c.content}`
              ).join("\n\n").slice(0, 12000);
              const g = await fetch(openAiEndpoint("responses"), {
                method: "POST",
                signal: AbortSignal.timeout(25000),
                headers: {
                  Authorization: `Bearer ${openAiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: generationModel,
                  max_output_tokens: 350,
                  input:
                    `Answer only from this published SLIT context. If unsupported, say so. Context:\n${context}\n\nQuestion: ${question}`,
                }),
              });
              const p = await g.json();
              const text = p.output_text?.trim();
              if (g.ok && text) {
                answer = { answer: text, sources, mode: "grounded" };
              }
            } finally {
              await admin.rpc("public_assistant_release_generation_slot", {
                p_lease: slot,
                p_input_tokens: e.tokens,
                p_output_tokens: 0,
              });
            }
          }
        }
        if (!answer) {
          answer = {
            answer: chunks.map((c: any) => c.content).join(" ").slice(0, 900),
            sources,
            mode: "retrieval",
          };
        }
      }
    } catch {
      /* deterministic fallback below */
    }
  }
  if (!answer) {
    answer = {
      answer:
        "I could not find a published answer for that. Please try a course code or use the contact page.",
      sources: [{ title: "Contact SLIT", url: "/contact" }],
      mode: "fallback",
    };
  }
  const payload = { ...answer, source_version: version, cache_scope: cacheScope };
  await admin.from("public_assistant_answer_cache").upsert({
    cache_key: cacheKey,
    source_version: version,
    answer: payload,
    expires_at: new Date(Date.now() + 300000).toISOString(),
  });
  await admin.from("public_assistant_usage_events").insert({
    kind: "retrieval",
    request_key: cacheKey,
    model: answer.mode,
  });
  return reply(payload);
});
