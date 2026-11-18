import { refuseHosted } from "./lab/hosted-guard.mjs";
refuseHosted("test-public-assistant-local-acceptance"); // local stack only; --allow-hosted to override (scripts/lab/hosted-guard.mjs)
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { createClient } from "@supabase/supabase-js";

const execFileAsync = promisify(execFile);
const localUrl = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const functionUrl = process.env.LOCAL_FUNCTION_URL ?? "http://127.0.0.1:54325";
const envFile = "supabase/.temp/start-secrets/supabase_edge_runtime_Skyline-Website/env/docker.env";
const testWorkerSecret = "local-public-assistant-worker-test-secret-20261015";
const fixtureId = `acceptance-pdf-${Date.now()}`;
const fixturePath = `policies/${fixtureId}.pdf`;
const fixtureQuestion = "Under the Nereid Corridor evacuation protocol, where must visitors assemble after the north stairwell alarm?";

function localEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([^=]+)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

function syntheticPdf(text) {
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${text.replace(/[()\\]/g, "\\$&")}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

function startMockProvider() {
  let embeddingCalls = 0;
  const vector = [1, ...Array(1535).fill(0)];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.method === "POST" && request.url === "/v1/embeddings") {
      embeddingCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ embedding: vector }], usage: { total_tokens: 7 } }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/responses") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output_text: JSON.stringify({ pages: [{ page: 1, text: "Nereid Corridor evacuation protocol. When the north stairwell alarm sounds, visitors must assemble at the east lawn beacon beside the blue emergency gate. Do not use the south courtyard.", warnings: [] }] }) }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "mock endpoint not implemented" }));
  });
  return new Promise((resolve) => server.listen(8787, "127.0.0.1", () => resolve({ server, calls: () => embeddingCalls })));
}

async function psql(sql) {
  const { stdout } = await execFileAsync("docker", ["exec", "supabase_db_Skyline-Website", "psql", "-q", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { windowsHide: true });
  return stdout.trim();
}

async function restJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${init?.method ?? "GET"} ${url} failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

async function main() {
  const env = localEnv(await readFile(envFile, "utf8"));
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  assert.ok(serviceKey, "local service-role key is required");
  const admin = createClient(localUrl, serviceKey, { auth: { persistSession: false } });
  const mock = await startMockProvider();
  try {
    const pdfText = "Nereid Corridor evacuation protocol. When the north stairwell alarm sounds, visitors must assemble at the east lawn beacon beside the blue emergency gate. Do not use the south courtyard.";
    const pdf = syntheticPdf(pdfText);
    const { error: uploadError } = await admin.storage.from("cms-media").upload(fixturePath, pdf, { contentType: "application/pdf", upsert: false });
    assert.equal(uploadError, null, `Storage upload failed: ${uploadError?.message}`);

    const document = { id: fixtureId, name: "Nereid Corridor Protocol", category: "Policy", description: "Synthetic local acceptance fixture", file_name: `${fixtureId}.pdf`, url: `/storage/v1/object/public/cms-media/${fixturePath}`, size_label: "1 KB", docs_count: 1, status: "Published", display_order: 9999, original_file_name: `${fixtureId}.pdf`, storage_file_name: `${fixtureId}.pdf`, bucket_name: "cms-media", storage_path: fixturePath, mime_type: "application/pdf", file_size: pdf.length, assistant_publication_approved: true };
    const { error: documentError } = await admin.from("cms_documents").insert(document);
    assert.equal(documentError, null, `CMS document insert failed: ${documentError?.message}`);

    let worker;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      worker = await restJson(`${functionUrl}/public-assistant-index`, { method: "POST", headers: { "x-worker-secret": testWorkerSecret } });
      const { data: candidate } = await admin.from("public_assistant_sources").select("id").eq("source_type", "document").eq("source_key", fixtureId).maybeSingle();
      if (candidate) break;
    }
    assert.equal(worker?.processed, true, "worker did not process the CMS document");

    const { data: source, error: sourceError } = await admin.from("public_assistant_sources").select("id,publication_status,source_version").eq("source_type", "document").eq("source_key", fixtureId).single();
    assert.equal(sourceError, null); assert.equal(source.publication_status, "published");
    const { data: textRows } = await admin.from("public_assistant_document_text").select("id,original_text,cleaned_text,processing_status").eq("document_id", fixtureId);
    assert.equal(textRows?.length, 1); assert.equal(textRows[0].processing_status, "complete"); assert.match(textRows[0].cleaned_text, /east lawn beacon/);
    const { data: pages } = await admin.from("public_assistant_document_pages").select("page_number,status,cleaned_text").eq("document_text_id", textRows[0].id);
    assert.equal(pages?.length, 1); assert.equal(pages[0].page_number, 1); assert.ok(["digital", "ocr"].includes(pages[0].status));
    const { data: chunks } = await admin.from("public_assistant_chunks").select("page_reference,embedding,embedding_dimensions").eq("source_id", source.id);
    assert.ok(chunks?.length); assert.match(chunks[0].page_reference, /1/); assert.equal(chunks[0].embedding_dimensions, 1536); assert.match(String(chunks[0].embedding), /^\[1,0,/);

    const answer = await restJson(`${functionUrl}/public-assistant`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.55" }, body: JSON.stringify({ question: fixtureQuestion }) });
    assert.match(answer.answer, /east lawn beacon/i); assert.ok(answer.sources.some((item) => item.url === document.url), "assistant answer did not cite the PDF");
    assert.ok(mock.calls() >= 2, "worker and assistant did not use the local OpenAI mock");

    const { error: unpublishError } = await admin.from("cms_documents").update({ status: "Draft", assistant_publication_approved: false }).eq("id", fixtureId);
    assert.equal(unpublishError, null);
    const { data: hiddenSource } = await admin.from("public_assistant_sources").select("publication_status").eq("id", source.id).single();
    assert.equal(hiddenSource.publication_status, "unpublished");
    const afterRemoval = await restJson(`${functionUrl}/public-assistant`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.56" }, body: JSON.stringify({ question: fixtureQuestion }) });
    assert.ok(!afterRemoval.sources.some((item) => item.url === document.url), "cached/retrieved answer still cites unpublished document");
    assert.doesNotMatch(afterRemoval.answer, /east lawn beacon/i);

    // Stage a genuine worker result, invalidate its CMS source, then prove its
    // activation is rejected and that staged content never becomes retrievable.
    const staleId = `${fixtureId}-stale`;
    await psql(`insert into public.cms_documents(id,name,category,description,file_name,url,size_label,status,assistant_publication_approved) values (${sqlLiteral(staleId)},'Stale fixture','Policy','stale','stale.pdf','/stale','1 KB','Published',true);`);
    const job = (await psql(`select id || '|' || lease_token || '|' || source_version from public.public_assistant_claim_index_job() where source_key=${sqlLiteral(staleId)};`)).split("|");
    assert.equal(job.length, 3, "stale-worker job was not claimed");
    const stagedId = await psql(`insert into public.public_assistant_sources(source_type,source_key,canonical_url,title,publication_status,source_version,content_hash) values ('document',${sqlLiteral(staleId)},'/stale','Stale fixture','staged',${sqlLiteral(job[2])},'stale-hash') returning id;`);
    await psql(`insert into public.public_assistant_chunks(source_id,ordinal,content,content_hash,embedding,embedding_dimensions) values (${sqlLiteral(stagedId)},0,'staged secret must remain unavailable','stale-hash',array[1${",0".repeat(1535)}]::extensions.vector,1536); update public.cms_documents set status='Draft',assistant_publication_approved=false where id=${sqlLiteral(staleId)};`);
    assert.equal(await psql(`select public.public_assistant_finish_index_job(${sqlLiteral(job[0])}::uuid,${sqlLiteral(job[1])}::uuid,${sqlLiteral(stagedId)}::uuid);`), "f");
    assert.equal(await psql(`select count(*) from public.public_assistant_sources where id=${sqlLiteral(stagedId)}::uuid and publication_status='published';`), "0");

    // Expired leases cannot activate staged work.
    const expiredId = `${fixtureId}-expired`;
    await psql(`insert into public.cms_documents(id,name,category,description,file_name,url,size_label,status,assistant_publication_approved) values (${sqlLiteral(expiredId)},'Expired fixture','Policy','expired','expired.pdf','/expired','1 KB','Published',true);`);
    const expiredJob = (await psql(`select id || '|' || lease_token || '|' || source_version from public.public_assistant_claim_index_job() where source_key=${sqlLiteral(expiredId)};`)).split("|");
    const expiredSource = await psql(`insert into public.public_assistant_sources(source_type,source_key,canonical_url,title,publication_status,source_version,content_hash) values ('document',${sqlLiteral(expiredId)},'/expired','Expired fixture','staged',${sqlLiteral(expiredJob[2])},'expired-hash') returning id;`);
    await psql(`update public.public_assistant_index_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${sqlLiteral(expiredJob[0])}::uuid;`);
    assert.equal(await psql(`select public.public_assistant_finish_index_job(${sqlLiteral(expiredJob[0])}::uuid,${sqlLiteral(expiredJob[1])}::uuid,${sqlLiteral(expiredSource)}::uuid);`), "f");

    // Two separate psql processes exercise SKIP LOCKED while the first holds
    // its claim transaction open; the second sees no claimable duplicate job.
    const concurrentId = `${fixtureId}-concurrent`;
    await psql(`insert into public.cms_documents(id,name,category,description,file_name,url,size_label,status,assistant_publication_approved) values (${sqlLiteral(concurrentId)},'Concurrent fixture','Policy','concurrency','c.pdf','/concurrent','1 KB','Published',true);`);
    await psql(`update public.public_assistant_index_jobs set next_attempt_at='epoch'::timestamptz where source_key=${sqlLiteral(concurrentId)};`);
    const holdSql = `begin; select id from public.public_assistant_claim_index_job() where source_key=${sqlLiteral(concurrentId)}; select pg_sleep(2); commit;`;
    const first = execFileAsync("docker", ["exec", "supabase_db_Skyline-Website", "psql", "-q", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", holdSql], { windowsHide: true });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await psql(`select state from public.public_assistant_index_jobs where source_key=${sqlLiteral(concurrentId)};`) === "processing") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(await psql(`select state from public.public_assistant_index_jobs where source_key=${sqlLiteral(concurrentId)};`), "processing", "first database session did not acquire the target job");
    const second = await psql(`select count(*) from public.public_assistant_claim_index_job() where source_key=${sqlLiteral(concurrentId)};`);
    await first;
    assert.equal(second, "0", "second database session claimed a locked job");

    console.log("local public-assistant acceptance: passed (PDF pipeline, retrieval/cache invalidation, stale/expired activation, and separate-session claim concurrency)");
  } finally {
    mock.server.close();
    await psql(`delete from public.cms_documents where id like ${sqlLiteral(`${fixtureId}%`)};`).catch(() => {});
    await psql(`delete from public.public_assistant_sources where source_key like ${sqlLiteral(`${fixtureId}%`)}; delete from public.public_assistant_index_jobs where source_key like ${sqlLiteral(`${fixtureId}%`)}; delete from public.public_assistant_document_text where document_id like ${sqlLiteral(`${fixtureId}%`)};`).catch(() => {});
    await admin.storage.from("cms-media").remove([fixturePath]).catch(() => {});
  }
}

await main();
