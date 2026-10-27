import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration, requiredConfiguration } from "../_shared/config.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const createAdminClient = () => createClient(url, serviceKey, { auth: { persistSession: false } });
type AdminClient = ReturnType<typeof createAdminClient>;
const openAiKey = Deno.env.get("OPENAI_API_KEY") ?? ""; // shared backend secret; never returned
const configuredOpenAiBaseUrl = (Deno.env.get("OPENAI_BASE_URL") ?? "").replace(/\/$/, "");
// A provider override is intentionally available only to the disposable local
// test key and a local Docker/loopback endpoint. Real keys always use OpenAI.
const openAiBaseUrl = openAiKey === "local-test-openai-key" && /^http:\/\/(127\.0\.0\.1|localhost|host\.docker\.internal)(:\d+)?\/v1$/.test(configuredOpenAiBaseUrl)
  ? configuredOpenAiBaseUrl
  : "https://api.openai.com/v1";
/** See public-assistant: parsed endpoints prevent formatted URL text from
 * becoming a provider endpoint. Production is constrained to api.openai.com. */
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
const model = Deno.env.get("PUBLIC_ASSISTANT_EMBEDDING_MODEL") ?? "text-embedding-3-small";
const dimensions = Number(Deno.env.get("PUBLIC_ASSISTANT_EMBEDDING_DIMENSIONS") ?? "1536");
const workerSecret = Deno.env.get("PUBLIC_ASSISTANT_WORKER_SECRET") ?? "";
const reply = (body: unknown, status = 200) => Response.json(body, { status });
const strip = (html: string) => html.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const safeUrl = (value: string) => value.startsWith("/") || /^https:\/\//i.test(value) ? value : "";

type Page = { number: number; original: string; cleaned: string; status: "digital" | "ocr" | "empty" | "partial" | "failed"; warnings: string[] };
type Source = { type: "course" | "page" | "document"; key: string; version: string; title: string; canonicalUrl: string; content: string; courseCode?: string; pages?: Page[]; fileHash?: string; extractionMethod?: string; extractionStatus?: "complete" | "partial"; document?: { original: string; cleaned: string; method: string; warnings: string[]; pages: Page[]; corrections: unknown[] } };
function limit(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(Deno.env.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`invalid_index_configuration:${name}`);
  return value;
}
const maxDocumentBytes = limit("PUBLIC_ASSISTANT_DOCUMENT_MAX_BYTES", 20 * 1024 * 1024, 1, 20 * 1024 * 1024);
const maxDocumentPages = limit("PUBLIC_ASSISTANT_DOCUMENT_MAX_PAGES", 120, 1, 120);
const maxContentChars = limit("PUBLIC_ASSISTANT_MAX_CONTENT_CHARS", 500000, 1, 2000000);
const maxChunks = limit("PUBLIC_ASSISTANT_MAX_CHUNKS", 512, 1, 512);
const chunkSize = limit("PUBLIC_ASSISTANT_CHUNK_TOKENS", 420, 1, 2048);
const chunkOverlap = limit("PUBLIC_ASSISTANT_CHUNK_OVERLAP", 60, 0, 2047);
if (chunkOverlap >= chunkSize) throw new Error("invalid_index_configuration:chunk_overlap");
const extractionModel = Deno.env.get("PUBLIC_ASSISTANT_DOCUMENT_EXTRACTION_MODEL") ?? "gpt-4.1-mini";

function chunks(content: string, pages?: Page[]): Array<{ heading: string; content: string; pageReference?: string }> {
  if (content.length > maxContentChars) throw new Error("content_limit_exceeded");
  const words = content.split(/\s+/).filter(Boolean); const size = chunkSize; const overlap = chunkOverlap;
  const output: Array<{ heading: string; content: string; pageReference?: string }> = [];
  for (let start = 0; start < words.length; start += size - overlap) {
    if (output.length >= maxChunks) throw new Error("chunk_limit_exceeded");
    const part = words.slice(start, start + size).join(" ");
    const pageNumbers = pages?.filter((page) => part.includes(page.cleaned.slice(0, 48))).map((page) => page.number) ?? [];
    if (part) output.push({ heading: pageNumbers.length ? `Document page ${pageNumbers[0]}` : "Published information", content: part, pageReference: pageNumbers.length ? `pp. ${pageNumbers[0]}${pageNumbers.length > 1 ? `–${pageNumbers.at(-1)}` : ""}` : undefined });
    if (start + size >= words.length) break;
  }
  return output;
}

const digest = async (value: Uint8Array | string) => { const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value; const result = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)); return [...new Uint8Array(result)].map((x) => x.toString(16).padStart(2, "0")).join(""); };
async function digitalPdfPages(bytes: Uint8Array): Promise<Page[]> { const pdfjs = await import("https://esm.sh/pdfjs-dist@4.10.38/legacy/build/pdf.mjs"); const pdf = await pdfjs.getDocument({ data: bytes }).promise; if (pdf.numPages > maxDocumentPages) throw new Error(`page_limit_exceeded:${pdf.numPages}`); const pages: Page[] = []; for (let number = 1; number <= pdf.numPages; number++) { const text = (await (await pdf.getPage(number)).getTextContent()).items.map((item: any) => String(item.str ?? "")).join(" ").replace(/\s+/g, " ").trim(); pages.push({ number, original: text, cleaned: text, status: text.length >= 40 ? "digital" : "empty", warnings: text.length >= 40 ? [] : ["No usable embedded text; OCR is required for this page."] }); } return pages; }
const base64 = (bytes: Uint8Array) => { let value = ""; for (let i = 0; i < bytes.length; i += 0x8000) value += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(value); };
async function ocrPdf(bytes: Uint8Array, filename: string): Promise<Page[]> { if (!openAiKey) throw new Error("ocr_fallback_unconfigured"); const b64 = base64(bytes); const response = await fetch(openAiEndpoint("responses"), { method: "POST", signal: AbortSignal.timeout(60_000), headers: { Authorization: `Bearer ${openAiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: extractionModel, max_output_tokens: 12000, input: [{ role: "user", content: [{ type: "input_text", text: "Extract this public PDF verbatim by page. Preserve headings, paragraphs, lists, tables with headers, and policy exceptions. Return JSON only: {pages:[{page:number,text:string,warnings:string[]}]}. Mark unreadable pages with an explicit warning; never invent text." }, { type: "input_file", filename, file_data: `data:application/pdf;base64,${b64}` }] }] }) }); if (!response.ok) throw new Error(`ocr_provider_${response.status}`); const envelope = await response.text(); if (envelope.length > maxContentChars * 2 + 100000) throw new Error("content_limit_exceeded"); const payload = JSON.parse(envelope); const raw = String(payload.output_text ?? "").replace(/^```json\s*|```$/g, ""); const parsed = JSON.parse(raw); if (!Array.isArray(parsed.pages) || !parsed.pages.length) throw new Error("ocr_invalid_page_output"); if (parsed.pages.length > maxDocumentPages) throw new Error("page_limit_exceeded"); const seen = new Set<number>(); let chars = 0; for (const page of parsed.pages) { if (!Number.isInteger(page.page) || page.page < 1 || page.page > maxDocumentPages || seen.has(page.page)) throw new Error("invalid_page_number"); seen.add(page.page); chars += String(page.text ?? "").length; if (chars > maxContentChars) throw new Error("content_limit_exceeded"); } return parsed.pages.map((p: any) => ({ number: Number(p.page), original: String(p.text ?? ""), cleaned: String(p.text ?? "").replace(/\s+/g, " ").trim(), status: String(p.text ?? "").trim() ? "ocr" : "failed", warnings: Array.isArray(p.warnings) ? p.warnings.map(String) : [] })); }
async function extractDocument(admin: AdminClient, doc: any, version: string): Promise<Source> { const bucket = String(doc.bucket_name ?? ""), path = String(doc.storage_path ?? ""), mime = String(doc.mime_type ?? "").toLowerCase(); if (bucket !== "cms-media" || !path.startsWith("forms/") && !path.startsWith("policies/")) throw new Error("untrusted_document_location"); if (mime !== "application/pdf") throw new Error("unsupported_document_type"); if (!doc.file_size || Number(doc.file_size) > maxDocumentBytes) throw new Error("document_size_limit"); const { data: blob, error } = await admin.storage.from(bucket).download(path); if (error || !blob) throw new Error("document_download_failed"); const bytes = new Uint8Array(await blob.arrayBuffer()); if (!bytes.length || bytes.length > maxDocumentBytes || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") throw new Error("invalid_pdf_signature"); let pages: Page[]; let method = "pdfjs-digital-v1"; try { pages = await digitalPdfPages(bytes); if (pages.some((page) => page.status === "empty")) { const ocr = await ocrPdf(bytes, String(doc.original_file_name ?? doc.file_name ?? "document.pdf")); pages = pages.map((page) => ocr.find((candidate) => candidate.number === page.number) ?? { ...page, status: "failed", warnings: [...page.warnings, "OCR did not return this page."] }); method = "pdfjs+openai-page-ocr-v1"; } } catch (error) { if (error instanceof Error && /^(page_limit|content_limit|invalid_page)/.test(error.message)) throw error; pages = await ocrPdf(bytes, String(doc.original_file_name ?? doc.file_name ?? "document.pdf")); method = "openai-page-ocr-v1"; } const bad = pages.filter((page) => page.status === "failed" || !page.cleaned).length; if (bad) throw new Error(`document_partial_or_unreadable:${bad}`); const original = pages.map((page) => `\n\n[Page ${page.number}]\n${page.original}`).join(""); const cleaned = pages.map((page) => `\n\n[Page ${page.number}]\n${page.cleaned}`).join(""); if (original.length > maxContentChars || cleaned.length > maxContentChars) throw new Error("content_limit_exceeded"); const fileHash = await digest(bytes);
  // Read approved corrections without writing public_assistant_document_pages
  // or text. Artifacts are committed only after this attempt's lease is checked.
  const { data: existing } = await admin.from("public_assistant_document_text").select("id")
    .eq("document_id",doc.id).eq("source_version",version).eq("file_hash",fileHash).maybeSingle();
  const { data: rows } = existing ? await admin.from("public_assistant_document_corrections")
    .select("id,page_number,replacement_text").eq("document_text_id",existing.id).not("approved_at","is",null).order("id") : { data: [] };
  const corrections = rows ?? [];
  pages = pages.map(page => { const correction=corrections.find(item=>item.page_number===page.number);
    return correction ? {...page,cleaned:String(correction.replacement_text),warnings:[...page.warnings,"Approved CMS correction applied to indexing text."]} : page; });
  const indexedText=pages.map(page=>`\n\n[Page ${page.number}]\n${page.cleaned}`).join("");
  if (indexedText.length > maxContentChars) throw new Error("content_limit_exceeded");
  return {type:"document",key:doc.id,version,title:String(doc.name),canonicalUrl:safeUrl(String(doc.url)),content:indexedText,pages,fileHash,extractionMethod:method,extractionStatus:"complete",
    document:{original,cleaned:indexedText,method,warnings:pages.flatMap(page=>page.warnings),pages,corrections}};
}

async function loadSource(admin: AdminClient, job: { source_type: Source["type"]; source_key: string; source_version: string }): Promise<Source | null> {
  if (job.source_type === "course") {
    const { data: course } = await admin.from("cms_courses").select("id,slug,code,name,cricos,duration,mode,fees,full_description,entry_requirements,status").eq("id", job.source_key).eq("status", "Published").maybeSingle();
    if (!course) return null;
    const { data: sections } = await admin.from("cms_course_sections").select("title,body").eq("course_id", course.id).order("sort");
    const content = [course.name, course.code, course.cricos, course.duration, course.mode, course.fees, course.full_description, course.entry_requirements, ...(sections ?? []).flatMap((row) => [row.title, row.body])].map((value) => strip(String(value ?? ""))).filter(Boolean).join("\n");
    return { type: "course", key: course.id, version: job.source_version, title: String(course.name), canonicalUrl: `/courses/${course.slug}`, content, courseCode: String(course.code ?? "") };
  }
  if (job.source_type === "page") {
    const { data } = await admin.from("cms_pages").select("id,slug,title,body,status").eq("id", job.source_key).eq("status", "Published").maybeSingle();
    return data ? { type: "page", key: data.id, version: job.source_version, title: data.title, canonicalUrl: safeUrl(`/${String(data.slug).replace(/^\//, "")}`), content: strip(`${data.title}\n${data.body}`) } : null;
  }
  const { data } = await admin.from("cms_documents").select("id,name,description,url,status,assistant_publication_approved,bucket_name,storage_path,mime_type,file_size,file_name,original_file_name").eq("id", job.source_key).eq("status", "Published").eq("assistant_publication_approved", true).maybeSingle();
  return data && safeUrl(String(data.url)) ? extractDocument(admin, data, job.source_version) : null;
}

async function embed(input: string): Promise<{ vector: number[]; tokens: number }> {
  if (!openAiKey) throw new Error("OPENAI_API_KEY is not configured for server-side assistant indexing.");
  const response = await fetch(openAiEndpoint("embeddings"), { method: "POST", signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${openAiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, input, dimensions, encoding_format: "float" }) });
  if (!response.ok) throw new Error(`embedding_provider_${response.status}`);
  const payload = await response.json(); const vector = payload?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== dimensions) throw new Error(`embedding_dimension_mismatch:${Array.isArray(vector) ? vector.length : 0}:${dimensions}`);
  return { vector, tokens: Number(payload?.usage?.total_tokens ?? 0) };
}

async function processOne() {
  const configuration = requiredConfiguration({ PUBLIC_ASSISTANT_WORKER_SECRET: workerSecret, OPENAI_API_KEY: openAiKey, PUBLIC_ASSISTANT_EMBEDDING_MODEL: model });
  if (configuration) return reply(configuration, 503);
  if (!Number.isSafeInteger(dimensions) || dimensions !== 1536) return reply({ error: "Edge Function configuration is unavailable.", code: "configuration_invalid", variables: ["PUBLIC_ASSISTANT_EMBEDDING_DIMENSIONS"] }, 503);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: claimed, error } = await admin.rpc("public_assistant_claim_index_job");
  if (error) return reply({ error: "Unable to claim indexing work." }, 500);
  const job = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!job) return reply({ processed: false });
  const fail = async (message: string) => {
    // Every terminal transition is conditioned on the lease minted at claim
    // time. A reclaimed/stale worker therefore cannot overwrite fresh work.
    const { data: accepted } = await admin.rpc("public_assistant_fail_index_job", { p_job: job.id, p_lease: job.lease_token, p_error: message });
    if (!accepted) return reply({ processed: false, stale: true });
    const retry = Number(job.attempt_count) < 3;
    await admin.from("public_assistant_usage_events").insert({ kind: "index_failure", model, request_key: job.id });
    return reply({ processed: true, retry }, retry ? 202 : 422);
  };
  try {
    const source = await loadSource(admin, job);
    if (!source) {
      await admin.rpc("public_assistant_cancel_index_job", { p_job: job.id, p_lease: job.lease_token });
      return reply({ processed: true, cancelled: true });
    }
    const contentHash = source.fileHash ?? await digest(source.content);
    // Embeddings are prepared in memory. public_assistant_finish_index_job is
    // now an internal DB helper called by this single fenced commit operation.
    const prepared = [];
    let tokens = 0;
    for (const [ordinal, chunk] of chunks(source.content, source.pages).entries()) {
      const result = await embed(chunk.content); tokens += result.tokens;
      prepared.push({ordinal,heading:chunk.heading,content:chunk.content,page_reference:chunk.pageReference ?? null,embedding:result.vector});
    }
    const { data: committed, error: commitError } = await admin.rpc("public_assistant_commit_index", {
      p_job:job.id,p_lease:job.lease_token,
      p_source:{type:source.type,key:source.key,version:source.version,url:source.canonicalUrl,title:source.title,hash:contentHash,course_code:source.courseCode ?? null,model,tokens},
      p_chunks:prepared,p_document:source.document ?? null,
    });
    if (commitError) throw new Error("index_commit_failed");
    if (!committed) return reply({processed:false,stale:true});
    return reply({ processed: true });
  } catch (error) { return await fail(error instanceof Error ? error.message : "indexing failed"); }
}

Deno.serve((request) => {
  const configuration = backendConfiguration(url, serviceKey);
  if (configuration) return reply(configuration, 503);
  return request.method === "POST" && Boolean(workerSecret.trim()) && request.headers.get("x-worker-secret") === workerSecret ? processOne() : reply({ error: "Not authorised." }, 401);
});
