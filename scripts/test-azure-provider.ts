// P05-02 Azure adapter contract, P05-03 leased-job orchestration (REG-DOC / REG-JOBS) and P07-02 notification delivery (REG-NOTIFY). Deterministic mocks only:
// the global fetch is replaced so any accidental network use fails, and the
// adapter receives an injected fake Azure plus a fake clock/sleep.
import assert from "node:assert/strict";
import test from "node:test";
import { buildExtractionEnvelope, type ExtractionCategory, type ExtractionRequest, type ExtractionSuccess } from "../supabase/functions/_shared/document-extraction/contract.ts";
import { createAzureProvider } from "../supabase/functions/_shared/document-extraction/azure.ts";
import { createDocumentExtractionProvider } from "../supabase/functions/_shared/document-extraction/select.ts";
import { MAX_ATTEMPTS, runLeasedExtraction, settleFailure, type JobPort } from "../supabase/functions/_shared/document-extraction/run.ts";
import type { DocumentExtractionProvider } from "../supabase/functions/_shared/document-extraction/contract.ts";
import { authorizeWorker, createMockEmailProvider, createPostmarkProvider, dispatchBatch, formatFrom, parseWebhook, selectEmailProvider, verifyBasicAuth, type ClaimedDelivery, type DeliveryPort, type EmailMessage, type SendOutcome, type WebhookEvent } from "../supabase/functions/_shared/notification/delivery.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("Network is forbidden in Azure adapter tests"); }) as typeof fetch;
test.after(() => { globalThis.fetch = realFetch; });

const ENDPOINT = "https://skyline-test.cognitiveservices.azure.com";
const KEY = "synthetic-azure-key-0001";
const RESULT = "11111111-2222-3333-4444-555555555555";
const pdf = new TextEncoder().encode("%PDF-1.4\nsynthetic\n%%EOF");
const req = (category: ExtractionCategory, extra: Partial<ExtractionRequest> = {}): ExtractionRequest => ({
  bytes: pdf, mimeType: "application/pdf", filename: "synthetic.pdf", category, jobId: "job-1", attempt: 1, signal: new AbortController().signal, ...extra,
});

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };
type Step = Response | ((call: Call) => Response | Promise<Response> | Error);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const accepted = (retryAfter?: string, model = "prebuilt-idDocument") => new Response(null, { status: 202, headers: { "Operation-Location": `${ENDPOINT}/documentintelligence/documentModels/${model}/analyzeResults/${RESULT}?api-version=2024-11-30`, ...(retryAfter ? { "Retry-After": retryAfter } : {}) } });
const running = (retryAfter?: string) => json({ status: "running" }, 200, retryAfter ? { "Retry-After": retryAfter } : {});
const field = (value: Record<string, unknown>, page = 1, confidence?: number) => ({ content: "printed", ...value, ...(confidence === undefined ? {} : { confidence }), boundingRegions: [{ pageNumber: page, polygon: [] }] });
const passportDoc = (docType = "idDocument.passport") => ({
  docType, fields: {
    FirstName: field({ type: "string", valueString: "Asha" }, 1, 0.98), LastName: field({ type: "string", valueString: "Testperson" }, 1, 0.97),
    DateOfBirth: field({ type: "date", valueDate: "1999-04-05" }), Sex: field({ type: "string", valueString: "F" }),
    DocumentNumber: field({ type: "string", valueString: "X1234567" }, 1, 0.91), DateOfExpiration: field({ type: "date", valueDate: "2031-08-09" }),
    Nationality: field({ type: "countryRegion", valueCountryRegion: "IND" }), CountryRegion: field({ type: "countryRegion", valueCountryRegion: "IND" }),
  },
});
const succeeded = (documents: unknown[], modelId = "prebuilt-idDocument") => json({ status: "succeeded", analyzeResult: { apiVersion: "2024-11-30", modelId, pages: [{ pageNumber: 1 }], documents } });

function harness(steps: Step[], extra: { modelMap?: Record<string, string>; maxPolls?: number; totalTimeoutMs?: number } = {}) {
  const calls: Call[] = []; const sleeps: number[] = []; let clock = 1_000_000; let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), method: init?.method ?? "GET", headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: typeof init?.body === "string" ? init.body : null };
    calls.push(call);
    const step = steps[Math.min(i++, steps.length - 1)];
    const result = typeof step === "function" ? await step(call) : step.clone();
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
  const provider = createAzureProvider({
    endpoint: ENDPOINT, apiKey: KEY, modelMap: { Passport: "prebuilt-idDocument", "Driving Licence": "prebuilt-idDocument", ...(extra.modelMap ?? {}) },
    fetch: fetchImpl, now: () => clock, sleep: async (ms: number, signal: AbortSignal) => { if (signal.aborted) return; sleeps.push(ms); clock += ms; },
    ...(extra.maxPolls ? { maxPolls: extra.maxPolls } : {}), ...(extra.totalTimeoutMs ? { totalTimeoutMs: extra.totalTimeoutMs } : {}),
  });
  return { provider, calls, sleeps };
}
const ok = (outcome: Awaited<ReturnType<ReturnType<typeof harness>["provider"]["extract"]>>) => { assert.equal(outcome.ok, true, JSON.stringify(outcome)); return outcome as ExtractionSuccess; };
const bad = (outcome: Awaited<ReturnType<ReturnType<typeof harness>["provider"]["extract"]>>) => { assert.equal(outcome.ok, false, JSON.stringify(outcome)); return outcome as Extract<typeof outcome, { ok: false }>; };

test("endpoint must be https on an Azure Cognitive Services host with no credentials, path or query", () => {
  const make = (endpoint: string) => () => createAzureProvider({ endpoint, apiKey: KEY, modelMap: {} });
  for (const endpoint of ["http://skyline-test.cognitiveservices.azure.com", "https://example.com", "https://evil.com/.cognitiveservices.azure.com", "https://user:pw@skyline-test.cognitiveservices.azure.com", "https://skyline-test.cognitiveservices.azure.com/path", "https://skyline-test.cognitiveservices.azure.com/?x=1", "not a url", "https://cognitiveservices.azure.com.evil.com"]) {
    assert.throws(make(endpoint), /EF_AZURE_DOCUMENT_ENDPOINT/, endpoint);
  }
  assert.doesNotThrow(make(ENDPOINT));
  assert.doesNotThrow(make(`${ENDPOINT}/`));
});

test("accepted, polled, succeeded: exact request, mapped candidates, evidence, receipt and no credentials in output", async () => {
  const { provider, calls, sleeps } = harness([accepted(), running(), running(), () => succeeded([passportDoc()])]);
  const outcome = ok(await provider.extract(req("Passport")));
  const post = calls[0];
  assert.equal(post.method, "POST");
  assert.equal(post.url, `${ENDPOINT}/documentintelligence/documentModels/prebuilt-idDocument:analyze?_overload=analyzeDocument&api-version=2024-11-30`);
  assert.equal(post.headers["Ocp-Apim-Subscription-Key"], KEY);
  assert.equal(post.headers["Content-Type"], "application/json");
  assert.deepEqual(Object.keys(JSON.parse(post.body!)), ["base64Source"]);
  assert.equal(JSON.parse(post.body!).base64Source, btoa(String.fromCharCode(...pdf)));
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(1).map((c) => c.url), Array(3).fill(`${ENDPOINT}/documentintelligence/documentModels/prebuilt-idDocument/analyzeResults/${RESULT}?api-version=2024-11-30`));
  assert.ok(calls.slice(1).every((c) => c.method === "GET" && c.body === null && c.headers["Ocp-Apim-Subscription-Key"] === KEY));
  assert.deepEqual(sleeps, [2000, 5000, 13000]);
  assert.equal(outcome.operationId, RESULT);
  assert.equal(outcome.categoryMismatch, false);
  assert.deepEqual(outcome.fields, { first_name: "Asha", last_name: "Testperson", dob: "1999-04-05", gender: "Female", passport_number: "X1234567", passport_expiry: "2031-08-09" });
  assert.deepEqual(outcome.confidence, { first_name: 0.98, last_name: 0.97, passport_number: 0.91 });
  assert.ok(outcome.evidence.some((e) => e.field === "passport_number" && e.page === 1 && e.source === "Azure DocumentNumber"));
  assert.ok(outcome.warnings.some((w) => /country/i.test(w)), "unconverted country codes must be disclosed, not guessed");
  assert.equal(outcome.usage.model, "prebuilt-idDocument");
  assert.equal(outcome.usage.apiVersion, "2024-11-30");
  assert.ok(!JSON.stringify(outcome).includes(KEY));
  const envelope = buildExtractionEnvelope(provider, outcome, "t");
  assert.equal(envelope.source.engine, "azure-document-intelligence");
  assert.equal(envelope.status, "unreviewed");
});

test("the accepted operation id is reported before polling so a retry can reuse it", async () => {
  const order: string[] = [];
  const { provider } = harness([accepted(), (c) => { order.push(`poll:${c.method}`); return succeeded([passportDoc()]); }]);
  ok(await provider.extract(req("Passport", { onOperationAccepted: async (id) => { order.push(`accepted:${id}`); } })));
  assert.deepEqual(order, [`accepted:${RESULT}`, "poll:GET"]);
});

test("a failing receipt hook never loses the analysis", async () => {
  const { provider } = harness([accepted(), succeeded([passportDoc()])]);
  ok(await provider.extract(req("Passport", { onOperationAccepted: async () => { throw new Error("db down"); } })));
});

test("a retry with a stored operation id polls it and never submits the document again", async () => {
  const { provider, calls } = harness([() => succeeded([passportDoc()])]);
  const outcome = ok(await provider.extract(req("Passport", { resumeOperationId: RESULT })));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(outcome.operationId, RESULT);
});

test("a stored operation that Azure no longer has falls back to exactly one fresh submission", async () => {
  const { provider, calls } = harness([() => json({ error: { code: "NotFound", message: "x" } }, 404), accepted(), succeeded([passportDoc()])]);
  ok(await provider.extract(req("Passport", { resumeOperationId: RESULT })));
  assert.deepEqual(calls.map((c) => c.method), ["GET", "POST", "GET"]);
});

test("a malformed stored operation id is ignored rather than interpolated into a URL", async () => {
  const { provider, calls } = harness([accepted(), succeeded([passportDoc()])]);
  ok(await provider.extract(req("Passport", { resumeOperationId: "../../other?x=1" })));
  assert.equal(calls[0].method, "POST");
  assert.ok(calls.every((c) => !c.url.includes("other")));
});

test("Retry-After is honoured within bounds and polling never runs faster than every two seconds", async () => {
  const { provider, sleeps } = harness([accepted("7"), running("1"), running("999"), succeeded([passportDoc()])]);
  ok(await provider.extract(req("Passport")));
  assert.deepEqual(sleeps, [7000, 2000, 34000]);
  assert.ok(sleeps.every((ms) => ms >= 2000));
});

test("polling is bounded by a total deadline and a poll cap", async () => {
  const deadline = harness([accepted(), running()], { totalTimeoutMs: 30_000 });
  const timeout = bad(await deadline.provider.extract(req("Passport")));
  assert.deepEqual([timeout.code, timeout.retryable], ["timeout", true]);
  assert.ok(deadline.sleeps.reduce((a, b) => a + b, 0) <= 30_000);
  const capped = harness([accepted(), running()], { maxPolls: 3, totalTimeoutMs: 10 * 60_000 });
  const cap = bad(await capped.provider.extract(req("Passport")));
  assert.deepEqual([cap.code, cap.retryable], ["timeout", true]);
  assert.equal(capped.calls.filter((c) => c.method === "GET").length, 3);
});

test("HTTP failures map to typed codes and never echo credentials, endpoint or provider text", async () => {
  const cases: [number, string, boolean][] = [[429, "rate_limit", true], [500, "provider", true], [503, "provider", true], [400, "validation", false], [413, "validation", false], [415, "validation", false], [401, "provider", false], [403, "provider", false]];
  for (const [status, code, retryable] of cases) {
    const { provider } = harness([() => json({ error: { code: "X", message: "SECRET DOCUMENT TEXT Asha Testperson" } }, status)]);
    const outcome = bad(await provider.extract(req("Passport")));
    assert.deepEqual([outcome.code, outcome.retryable], [code, retryable], String(status));
    const text = JSON.stringify(outcome);
    assert.ok(!text.includes(KEY) && !text.includes("cognitiveservices") && !text.includes("Testperson"), text);
  }
});

test("transient poll errors are retried a bounded number of times then reported retryable", async () => {
  const flaky = harness([accepted(), () => json({}, 503), () => json({}, 429), succeeded([passportDoc()])]);
  ok(await flaky.provider.extract(req("Passport")));
  const dead = harness([accepted(), () => json({}, 503)]);
  const outcome = bad(await dead.provider.extract(req("Passport")));
  assert.deepEqual([outcome.code, outcome.retryable], ["provider", true]);
  assert.ok(dead.calls.length <= 5);
});

test("network errors and abort are distinguished", async () => {
  const net = harness([() => new Error("socket hang up secret-host")]);
  const outcome = bad(await net.provider.extract(req("Passport")));
  assert.deepEqual([outcome.code, outcome.retryable], ["network", true]);
  assert.ok(!outcome.message.includes("secret-host"));
  const timeoutError = Object.assign(new Error("t"), { name: "TimeoutError" });
  const slow = bad(await harness([() => timeoutError]).provider.extract(req("Passport")));
  assert.deepEqual([slow.code, slow.retryable], ["timeout", true]);
});

test("malformed and unexpected responses are retryable schema errors", async () => {
  const notJson = bad(await harness([accepted(), () => new Response("<html>", { status: 200 })]).provider.extract(req("Passport")));
  assert.deepEqual([notJson.code, notJson.retryable], ["schema", true]);
  const weird = bad(await harness([accepted(), () => json({ status: "mystery" })]).provider.extract(req("Passport")));
  assert.equal(weird.code, "schema");
  const noOp = bad(await harness([() => new Response(null, { status: 202 })]).provider.extract(req("Passport")));
  assert.equal(noOp.code, "schema");
  const ok200 = bad(await harness([() => json({ status: "succeeded" }, 200)]).provider.extract(req("Passport")));
  assert.equal(ok200.code, "schema");
  const noFields = bad(await harness([accepted(), () => json({ status: "succeeded", analyzeResult: { modelId: "prebuilt-idDocument" } })]).provider.extract(req("Passport")));
  assert.equal(noFields.code, "schema");
});

test("a failed analysis is permanent for invalid content and retryable otherwise", async () => {
  const invalid = bad(await harness([accepted(), () => json({ status: "failed", error: { code: "InvalidContent", message: "bad pdf" } })]).provider.extract(req("Passport")));
  assert.deepEqual([invalid.code, invalid.retryable], ["validation", false]);
  const other = bad(await harness([accepted(), () => json({ status: "failed", error: { code: "InternalServerError", message: "oops" } })]).provider.extract(req("Passport")));
  assert.deepEqual([other.code, other.retryable], ["provider", true]);
});

test("an Operation-Location on another host is refused and the key is never sent there", async () => {
  const evil = () => new Response(null, { status: 202, headers: { "Operation-Location": `https://evil.example/documentintelligence/documentModels/prebuilt-idDocument/analyzeResults/${RESULT}?api-version=2024-11-30` } });
  const { provider, calls } = harness([evil, succeeded([passportDoc()])]);
  const outcome = bad(await provider.extract(req("Passport")));
  assert.equal(outcome.retryable, false);
  assert.equal(calls.length, 1);
  assert.ok(calls.every((c) => c.url.startsWith(ENDPOINT)));
  const traversal = () => new Response(null, { status: 202, headers: { "Operation-Location": `${ENDPOINT}/documentintelligence/documentModels/prebuilt-idDocument/analyzeResults/..%2F..%2Fadmin` } });
  assert.equal(bad(await harness([traversal]).provider.extract(req("Passport"))).retryable, false);
});

test("model and category mismatch: wrong document type supplies no fields; wrong model is rejected; unmapped category never calls Azure", async () => {
  const licence = ok(await harness([accepted(), succeeded([passportDoc("idDocument.driverLicense")])]).provider.extract(req("Passport")));
  assert.equal(licence.categoryMismatch, true);
  assert.deepEqual(buildExtractionEnvelope(createAzureProvider({ endpoint: ENDPOINT, apiKey: KEY, modelMap: {} }), licence, "t").extracted, {});
  const unknown = ok(await harness([accepted(), succeeded([passportDoc("idDocument.nationalIdentityCard")])]).provider.extract(req("Passport")));
  assert.equal(unknown.categoryMismatch, true);
  const wrongModel = bad(await harness([accepted(), succeeded([passportDoc()], "some-other-model")]).provider.extract(req("Passport")));
  assert.deepEqual([wrongModel.code, wrongModel.retryable], ["schema", false]);
  const none = harness([accepted()]);
  const unmapped = bad(await none.provider.extract(req("Visa")));
  assert.deepEqual([unmapped.code, unmapped.retryable], ["validation", false]);
  assert.equal(none.calls.length, 0);
});

test("empty analysis is a successful no_fields outcome", async () => {
  const outcome = ok(await harness([accepted(), succeeded([])]).provider.extract(req("Passport")));
  assert.deepEqual(outcome.fields, {});
  assert.ok(outcome.warnings.length > 0);
  assert.equal(buildExtractionEnvelope(createAzureProvider({ endpoint: ENDPOINT, apiKey: KEY, modelMap: {} }), outcome, "t").status, "no_fields");
});

test("driving licence maps a structured Australian address and keeps unstructured text out", async () => {
  const doc = { docType: "idDocument.driverLicense", fields: {
    FirstName: field({ type: "string", valueString: "Asha" }), LastName: field({ type: "string", valueString: "Testperson" }), DateOfBirth: field({ type: "date", valueDate: "1999-04-05" }),
    Address: field({ type: "address", valueAddress: { streetAddress: "1 Example Street", city: "Sydney", state: "NSW", postalCode: "2000", countryRegion: "AUS" } }),
  } };
  const outcome = ok(await harness([accepted(), succeeded([doc])]).provider.extract(req("Driving Licence")));
  assert.deepEqual(outcome.fields, { first_name: "Asha", last_name: "Testperson", dob: "1999-04-05", address_type: "Australian Address", au_street: "1 Example Street", au_suburb: "Sydney", au_state: "NSW", au_zip: "2000" });
  const plain = { docType: "idDocument.driverLicense", fields: { Address: field({ type: "string", valueString: "1 Example St Sydney NSW" }) } };
  const text = ok(await harness([accepted(), succeeded([plain])]).provider.extract(req("Driving Licence")));
  assert.deepEqual(text.fields, {});
  assert.ok(text.warnings.some((w) => /address/i.test(w)));
});

test("custom models map only fields named with the application's identifiers", async () => {
  const doc = { docType: "english-test-v1", fields: {
    english_type: field({ type: "string", valueString: "IELTS Academic" }, 1, 0.9), english_score: field({ type: "string", valueString: "7.0" }), english_date: field({ type: "date", valueDate: "2026-02-03" }),
    secret_notes: field({ type: "string", valueString: "ignore me" }), first_name: field({ type: "string", valueString: "Asha" }, 2),
  } };
  const outcome = ok(await harness([accepted(undefined, "english-test-v1"), succeeded([doc], "english-test-v1")], { modelMap: { "English Test": "english-test-v1" } }).provider.extract(req("English Test")));
  assert.deepEqual(outcome.fields, { english_type: "IELTS Academic", english_score: "7.0", english_date: "2026-02-03", first_name: "Asha" });
  assert.equal(outcome.evidence.find((e) => e.field === "first_name")?.page, 2);
  assert.ok(!("secret_notes" in outcome.fields));
});

test("out-of-range confidence is dropped, never manufactured or clamped", async () => {
  const doc = passportDoc(); (doc.fields.FirstName as Record<string, unknown>).confidence = 1.7;
  const outcome = ok(await harness([accepted(), succeeded([doc])]).provider.extract(req("Passport")));
  assert.equal(outcome.confidence, undefined);
});

test("cancellation before and during work returns a non-retryable cancelled outcome", async () => {
  const controller = new AbortController(); controller.abort();
  const before = harness([accepted()]);
  const first = bad(await before.provider.extract(req("Passport", { signal: controller.signal })));
  assert.deepEqual([first.code, first.retryable], ["cancelled", false]);
  assert.equal(before.calls.length, 0);
  const live = new AbortController();
  const during = harness([accepted(), () => { live.abort(); return running(); }, succeeded([passportDoc()])]);
  const second = bad(await during.provider.extract(req("Passport", { signal: live.signal })));
  assert.deepEqual([second.code, second.retryable], ["cancelled", false]);
});

test("provider selection: default stays OpenAI, Azure needs its own complete valid configuration, the mock is unreachable", () => {
  const openAi = createDocumentExtractionProvider({ OPENAI_API_KEY: "k", OPENAI_DOCUMENT_MODEL: "m" });
  assert.equal(openAi.provider?.id, "openai-responses");
  assert.equal(createDocumentExtractionProvider({ OPENAI_API_KEY: "k", OPENAI_DOCUMENT_MODEL: "m", EF_DOCUMENT_EXTRACTION_PROVIDER: "openai" }).provider?.id, "openai-responses");
  const missing = createDocumentExtractionProvider({ EF_DOCUMENT_EXTRACTION_PROVIDER: "azure", OPENAI_API_KEY: "k", OPENAI_DOCUMENT_MODEL: "m" });
  assert.equal(missing.provider, null);
  assert.deepEqual(missing.unavailable?.variables, ["EF_AZURE_DOCUMENT_ENDPOINT", "EF_AZURE_DOCUMENT_API_KEY", "EF_AZURE_DOCUMENT_MODEL"]);
  assert.equal(missing.unavailable?.code, "configuration_unavailable");
  const full = { EF_DOCUMENT_EXTRACTION_PROVIDER: "azure", EF_AZURE_DOCUMENT_ENDPOINT: ENDPOINT, EF_AZURE_DOCUMENT_API_KEY: KEY, EF_AZURE_DOCUMENT_MODEL: "prebuilt-idDocument" };
  const azure = createDocumentExtractionProvider(full);
  assert.equal(azure.provider?.id, "azure-document-intelligence");
  assert.match(azure.provider!.model, /2024-11-30/);
  const badEndpoint = createDocumentExtractionProvider({ ...full, EF_AZURE_DOCUMENT_ENDPOINT: "https://example.com" });
  assert.deepEqual([badEndpoint.provider, badEndpoint.unavailable?.code, badEndpoint.unavailable?.variables], [null, "configuration_invalid", ["EF_AZURE_DOCUMENT_ENDPOINT"]]);
  const badMap = createDocumentExtractionProvider({ ...full, EF_AZURE_DOCUMENT_MODEL_MAP: "{nope" });
  assert.deepEqual([badMap.unavailable?.code, badMap.unavailable?.variables], ["configuration_invalid", ["EF_AZURE_DOCUMENT_MODEL_MAP"]]);
  const badCategory = createDocumentExtractionProvider({ ...full, EF_AZURE_DOCUMENT_MODEL_MAP: JSON.stringify({ Hologram: "m1" }) });
  assert.equal(badCategory.unavailable?.code, "configuration_invalid");
  const badVersion = createDocumentExtractionProvider({ ...full, EF_AZURE_DOCUMENT_API_VERSION: "latest" });
  assert.deepEqual(badVersion.unavailable?.variables, ["EF_AZURE_DOCUMENT_API_VERSION"]);
  const mapped = createDocumentExtractionProvider({ ...full, EF_AZURE_DOCUMENT_MODEL_MAP: JSON.stringify({ "English Test": "english-test-v1" }) });
  assert.equal(mapped.provider?.id, "azure-document-intelligence");
  for (const value of ["mock", "MOCK", "azure ", "unknown"]) {
    const result = createDocumentExtractionProvider({ ...full, EF_DOCUMENT_EXTRACTION_PROVIDER: value });
    assert.equal(result.provider, null, value);
    assert.deepEqual(result.unavailable?.variables, ["EF_DOCUMENT_EXTRACTION_PROVIDER"], value);
  }
  assert.ok(!JSON.stringify(badEndpoint).includes("example.com") && !JSON.stringify(missing).includes(KEY));
});

// ---- P05-03: leased-job orchestration against an in-memory queue that mirrors the SQL fences ----
// Mirrors portal_claim/finish/fail/record: state + lease fencing, candidates fill only empty fields,
// the operation receipt is dropped on every terminal state and kept across a retryable requeue.
class FakeQueue {
  state = "queued"; attempts = 0; lease: string | null = null; leaseLive = false;
  operation: { engine: string; operationId: string } | null = null;
  values: Record<string, string> = {};
  activations = 0; lastError: string | null = null; responseId: string | null = null; envelopes: unknown[] = []; attemptsLog: string[] = [];
  failReceipts = false;
  claim() {
    if (this.state === "processing" && this.leaseLive) return null;
    if (this.state !== "queued" && this.state !== "processing") return null;
    this.state = "processing"; this.attempts += 1; this.lease = `lease-${this.attempts}`; this.leaseLive = true;
    return { lease: this.lease, attempt: this.attempts };
  }
  expireLease() { this.leaseLive = false; }
  cancel() { this.state = "cancelled"; this.leaseLive = false; this.operation = null; }
  private held(lease: string) { return this.state === "processing" && this.leaseLive && this.lease === lease; }
  port(lease: string): JobPort {
    return {
      loadOperation: async () => this.operation,
      recordOperation: async (engine, operationId) => {
        if (this.failReceipts) throw new Error("db down");
        if (!this.held(lease)) return false;
        this.operation = operationId ? { engine, operationId } : null; return true;
      },
      finish: async (extraction, responseId) => {
        if (!this.held(lease)) return false;
        const env = extraction as { extracted: Record<string, string> };
        for (const [key, value] of Object.entries(env.extracted)) if (!(key in this.values)) this.values[key] = value;
        this.activations += 1; this.state = "succeeded"; this.operation = null; this.responseId = responseId; this.envelopes.push(extraction); this.attemptsLog.push("succeeded");
        return true;
      },
      fail: async (code, _message, retry) => {
        if (!this.held(lease)) return false;
        this.lastError = code; this.attemptsLog.push("failed:" + code);
        this.state = retry && this.attempts < MAX_ATTEMPTS ? "queued" : "failed";
        this.leaseLive = false; if (this.state === "failed") this.operation = null;
        return true;
      },
    };
  }
}
// One worker pass, exactly as the Edge function drives it.
async function work(queue: FakeQueue, provider: DocumentExtractionProvider, category: ExtractionCategory = "Passport") {
  const claimed = queue.claim(); if (!claimed) return null;
  const port = queue.port(claimed.lease);
  const result = await runLeasedExtraction(provider, req(category, { attempt: claimed.attempt }), port);
  if (result.kind === "failure") await settleFailure(port, claimed.attempt, result.code, result.message, result.retryable);
  return result;
}
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST").length;
const failedOp = (code = "InternalServerError") => json({ status: "failed", error: { code, message: "x" } });

test("jobs: 429 on submission requeues with no receipt; the next attempt succeeds and activates once", async () => {
  const q = new FakeQueue();
  const { provider, calls } = harness([json({}, 429), accepted(), () => succeeded([passportDoc()])]);
  assert.equal((await work(q, provider))?.kind, "failure");
  assert.deepEqual([q.state, q.lastError, q.operation], ["queued", "rate_limit", null]);
  assert.equal((await work(q, provider))?.kind, "processed");
  assert.deepEqual([q.state, q.activations, posts(calls), q.operation, q.responseId], ["succeeded", 1, 2, null, RESULT]);
});

test("jobs: a timeout while polling keeps the receipt and the retry polls it without resubmitting", async () => {
  const q = new FakeQueue();
  const first = harness([accepted(), running()], { maxPolls: 1 });
  assert.equal((await work(q, first.provider))?.kind, "failure");
  assert.deepEqual([q.state, q.lastError, q.operation], ["queued", "timeout", { engine: "azure-document-intelligence", operationId: RESULT }]);
  const second = harness([() => succeeded([passportDoc()])]);
  assert.equal((await work(q, second.provider))?.kind, "processed");
  assert.deepEqual(second.calls.map((c) => c.method), ["GET"]);
  assert.deepEqual([q.state, q.activations, q.operation], ["succeeded", 1, null]);
});

test("jobs: invalid JSON from the provider clears the receipt, retries and resubmits once", async () => {
  const q = new FakeQueue();
  const first = harness([accepted(), new Response("not json", { status: 200 })]);
  assert.equal((await work(q, first.provider))?.kind, "failure");
  assert.deepEqual([q.state, q.lastError, q.operation], ["queued", "schema", null]);
  const second = harness([accepted(), () => succeeded([passportDoc()])]);
  assert.equal((await work(q, second.provider))?.kind, "processed");
  assert.equal(posts(second.calls), 1);
});

test("jobs: a failed provider operation is not polled again; a permanent rejection dead-letters at once", async () => {
  const q = new FakeQueue();
  assert.equal((await work(q, harness([accepted(), failedOp()]).provider))?.kind, "failure");
  assert.deepEqual([q.state, q.operation], ["queued", null]);
  const retry = harness([accepted(), () => succeeded([passportDoc()])]);
  assert.equal((await work(q, retry.provider))?.kind, "processed");
  assert.equal(posts(retry.calls), 1);
  const permanent = new FakeQueue();
  assert.equal((await work(permanent, harness([accepted(), failedOp("InvalidContent")]).provider))?.kind, "failure");
  assert.deepEqual([permanent.state, permanent.lastError, permanent.operation, permanent.activations], ["failed", "validation", null, 0]);
});

test("jobs: category mismatch is recorded but never populates a value or overwrites a manual one", async () => {
  const q = new FakeQueue(); q.values = { first_name: "Manual" };
  const { provider } = harness([accepted(), () => succeeded([passportDoc("idDocument.driverLicense")])]);
  assert.equal((await work(q, provider, "Passport"))?.kind, "processed");
  const envelope = q.envelopes[0] as { extracted: object; source: { categoryMismatch: boolean } };
  assert.deepEqual([envelope.source.categoryMismatch, envelope.extracted, q.values], [true, {}, { first_name: "Manual" }]);
});

test("jobs: missing Azure configuration claims nothing and leaves the job queued for manual entry", () => {
  const q = new FakeQueue();
  const selection = createDocumentExtractionProvider({ EF_DOCUMENT_EXTRACTION_PROVIDER: "azure" });
  assert.equal(selection.provider, null);
  assert.deepEqual([selection.unavailable?.code, selection.unavailable?.variables], ["configuration_unavailable", ["EF_AZURE_DOCUMENT_ENDPOINT", "EF_AZURE_DOCUMENT_API_KEY", "EF_AZURE_DOCUMENT_MODEL"]]);
  assert.deepEqual([q.state, q.attempts, q.activations], ["queued", 0, 0]);
});

test("jobs: dead-letter after the retry limit, with no receipt and no activation", async () => {
  const q = new FakeQueue();
  const { provider } = harness([json({}, 429)]);
  for (let i = 0; i < MAX_ATTEMPTS; i++) assert.equal((await work(q, provider))?.kind, "failure");
  assert.deepEqual([q.state, q.attempts, q.lastError, q.operation, q.activations], ["failed", MAX_ATTEMPTS, "rate_limit", null, 0]);
  assert.equal(await work(q, provider), null, "a dead-lettered job is never claimed again");
});

test("jobs: duplicate delivery and lease takeover activate exactly once; the stale worker is fenced out", async () => {
  const q = new FakeQueue();
  const stale = q.claim()!;
  assert.equal(q.claim(), null, "a live lease blocks a duplicate delivery");
  q.expireLease();
  const fresh = q.claim()!;
  const { provider } = harness([accepted(), () => succeeded([passportDoc()])]);
  assert.equal((await runLeasedExtraction(provider, req("Passport"), q.port(stale.lease))).kind, "stale");
  assert.deepEqual([q.activations, q.state, q.operation], [0, "processing", null], "the stale worker must not record a receipt either");
  assert.equal((await runLeasedExtraction(harness([accepted(), () => succeeded([passportDoc()])]).provider, req("Passport"), q.port(fresh.lease))).kind, "processed");
  assert.equal(q.activations, 1);
});

test("jobs: a job cancelled mid-flight writes nothing and keeps no receipt", async () => {
  const q = new FakeQueue();
  const claimed = q.claim()!;
  const { provider } = harness([accepted(), () => { q.cancel(); return running(); }, () => succeeded([passportDoc()])]);
  const result = await runLeasedExtraction(provider, req("Passport"), q.port(claimed.lease));
  assert.equal(result.kind, "stale");
  assert.deepEqual([q.state, q.activations, q.operation, q.values], ["cancelled", 0, null, {}]);
});

test("jobs: a crash after acceptance but before the receipt persisted costs one repeat submission, never a duplicate activation", async () => {
  const q = new FakeQueue(); q.failReceipts = true;
  const first = harness([accepted(), running()], { maxPolls: 1 });
  assert.equal((await work(q, first.provider))?.kind, "failure");
  assert.equal(q.operation, null);
  q.failReceipts = false;
  const second = harness([accepted(), () => succeeded([passportDoc()])]);
  assert.equal((await work(q, second.provider))?.kind, "processed");
  assert.deepEqual([posts(first.calls) + posts(second.calls), q.activations, q.state], [2, 1, "succeeded"]);
});

test("jobs: a provider switch ignores the other provider's receipt in both directions and never overwrites a manual value", async () => {
  const q = new FakeQueue(); q.values = { first_name: "Manual" }; q.operation = { engine: "openai", operationId: "resp_foreign" };
  const azure = harness([accepted(), () => succeeded([passportDoc()])]);
  assert.equal((await work(q, azure.provider))?.kind, "processed");
  assert.equal(posts(azure.calls), 1, "an OpenAI receipt is never polled on Azure");
  assert.ok(azure.calls.every((c) => !c.url.includes("resp_foreign")));
  assert.deepEqual([q.values.first_name, q.values.last_name, q.activations], ["Manual", "Testperson", 1]);

  const back = new FakeQueue(); back.operation = { engine: "azure-document-intelligence", operationId: RESULT };
  let seen: ExtractionRequest | null = null;
  const other: DocumentExtractionProvider = { id: "openai", model: "m", extract: async (request) => { seen = request; return { ok: false, code: "provider", message: "x", retryable: true }; } };
  await work(back, other);
  assert.equal((seen as ExtractionRequest | null)?.resumeOperationId, undefined);
  assert.equal(back.operation, null, "a failure on the new provider drops the receipt rather than leaving it dangling");
});

test("jobs: Azure outcomes persist the same envelope shape, response id and history as the OpenAI path", async () => {
  const q = new FakeQueue();
  assert.equal((await work(q, harness([accepted(), () => succeeded([passportDoc()])]).provider))?.kind, "processed");
  const env = q.envelopes[0] as { extracted: object; confirmed: object; status: string; source: Record<string, unknown> };
  assert.deepEqual(Object.keys(env).sort(), ["confirmed", "extracted", "source", "status"]);
  for (const key of ["engine", "parser", "model", "extractedAt", "documentType", "categoryMismatch", "rawFields", "evidence"]) assert.ok(key in env.source, key);
  assert.deepEqual([env.confirmed, env.status, q.responseId, q.attemptsLog], [{}, "unreviewed", RESULT, ["succeeded"]]);
});

// ---- P07-02: notification delivery (mock-only; the Postmark adapter receives an injected fake fetch) ----
const PM_TOKEN = "synthetic-postmark-token-0001";
const pmMessage: EmailMessage = { deliveryId: "d-1", from: { name: 'Skyline "Admissions"', email: "admissions@example.test" }, to: "agent@example.test", subject: "Application 42000000 is now under review", textBody: "Plain text only." };
type PmCall = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> };
function pmHarness(respond: (call: PmCall) => Response | Error) {
  const calls: PmCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: PmCall = { url: String(url), method: init?.method ?? "GET", headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: JSON.parse(String(init?.body ?? "{}")) };
    calls.push(call);
    const result = respond(call);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
  return { provider: createPostmarkProvider({ serverToken: PM_TOKEN, fetch: fetchImpl }), calls };
}
const pmOk = () => new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "0a129aee-e1cd-480d-b08d-4f48548ff48d", To: "agent@example.test" }), { status: 200 });

test("notify: Postmark request is a plain-text transactional send with the server token and no tracking", async () => {
  const { provider, calls } = pmHarness(pmOk);
  const outcome = await provider.send(pmMessage);
  assert.deepEqual(outcome, { kind: "accepted", messageId: "0a129aee-e1cd-480d-b08d-4f48548ff48d" });
  const call = calls[0];
  assert.equal(call.url, "https://api.postmarkapp.com/email");
  assert.equal(call.method, "POST");
  assert.equal(call.headers["X-Postmark-Server-Token"], PM_TOKEN);
  assert.equal(call.headers["Content-Type"], "application/json");
  assert.equal(call.body.From, '"Skyline \\"Admissions\\"" <admissions@example.test>', "quotes in the display name are escaped, not interpreted");
  assert.deepEqual([call.body.To, call.body.TextBody, call.body.HtmlBody, call.body.MessageStream, call.body.TrackOpens, call.body.TrackLinks], ["agent@example.test", "Plain text only.", undefined, "outbound", false, "None"]);
  assert.deepEqual(call.body.Metadata, { deliveryId: "d-1" });
});

test("notify: only a definitive refusal is retryable; an ambiguous outcome is never retried", async () => {
  const expectOutcome = async (respond: (call: PmCall) => Response | Error, expected: SendOutcome) => assert.deepEqual(await pmHarness(respond).provider.send(pmMessage), expected);
  await expectOutcome(() => new Response("{}", { status: 429 }), { kind: "retry", code: "rate_limit" });
  await expectOutcome(() => new Response("{}", { status: 503 }), { kind: "retry", code: "provider" });
  await expectOutcome(() => Object.assign(new Error("slow"), { name: "TimeoutError" }), { kind: "unknown", code: "timeout" });
  await expectOutcome(() => new Error("socket closed"), { kind: "unknown", code: "network" });
  await expectOutcome(() => new Response("not json", { status: 200 }), { kind: "unknown", code: "schema" });
  await expectOutcome(() => new Response(JSON.stringify({ ErrorCode: 0 }), { status: 200 }), { kind: "unknown", code: "schema" });
  await expectOutcome(() => new Response(JSON.stringify({ ErrorCode: 406, Message: "inactive" }), { status: 422 }), { kind: "failed", code: "inactive_recipient" });
  await expectOutcome(() => new Response(JSON.stringify({ ErrorCode: 300 }), { status: 422 }), { kind: "failed", code: "invalid_recipient" });
  await expectOutcome(() => new Response(JSON.stringify({ ErrorCode: 10 }), { status: 401 }), { kind: "failed", code: "unauthorized" });
  await expectOutcome(() => new Response(JSON.stringify({ ErrorCode: 701 }), { status: 422 }), { kind: "failed", code: "rejected" });
});

test("notify: outcomes never carry the token, the address or provider text", async () => {
  for (const respond of [() => new Response(JSON.stringify({ ErrorCode: 406, Message: "agent@example.test is inactive" }), { status: 422 }), () => new Error(`failed for ${PM_TOKEN}`)]) {
    const text = JSON.stringify(await pmHarness(respond).provider.send(pmMessage));
    assert.ok(!text.includes(PM_TOKEN) && !text.includes("agent@example.test") && !text.includes("is inactive"), text);
  }
});

test("notify: sending is off unless explicitly enabled and fully configured", () => {
  assert.deepEqual(selectEmailProvider({}).unavailable?.variables, ["EF_NOTIFICATION_EMAIL_ENABLED", "EF_POSTMARK_SERVER_TOKEN"]);
  for (const value of ["", "TRUE", "1", "yes", "true "]) {
    const result = selectEmailProvider({ EF_NOTIFICATION_EMAIL_ENABLED: value, EF_POSTMARK_SERVER_TOKEN: PM_TOKEN });
    assert.equal(result.provider === null, value.trim() !== "true", JSON.stringify(value));
  }
  assert.deepEqual(selectEmailProvider({ EF_NOTIFICATION_EMAIL_ENABLED: "true" }).unavailable?.variables, ["EF_POSTMARK_SERVER_TOKEN"]);
  assert.equal(selectEmailProvider({ EF_NOTIFICATION_EMAIL_ENABLED: "true", EF_POSTMARK_SERVER_TOKEN: PM_TOKEN }).provider?.id, "postmark");
  assert.ok(!JSON.stringify(selectEmailProvider({ EF_POSTMARK_SERVER_TOKEN: PM_TOKEN })).includes(PM_TOKEN));
});

function fakePort(deliveries: ClaimedDelivery[]) {
  const queue = [...deliveries]; const recorded: { id: string; outcome: string; messageId: string | null; code: string | null; retry: boolean; delay: number }[] = [];
  let staleIds = new Set<string>();
  const port: DeliveryPort = {
    claim: async () => queue.shift() ?? null,
    record: async (d, outcome, messageId, code, retry, delay) => { if (staleIds.has(d.id)) return false; recorded.push({ id: d.id, outcome, messageId, code, retry, delay }); return true; },
  };
  return { port, recorded, stale: (id: string) => { staleIds = new Set([...staleIds, id]); } };
}
const claimed = (id: string, attempt = 1, sender: ClaimedDelivery["sender"] = { name: "Skyline", email: "admissions@example.test" }): ClaimedDelivery => ({ id, leaseToken: `lease-${id}`, recipientEmail: "agent@example.test", subject: "s", body: "b", sender, attempt });

test("notify: the dispatcher records each outcome kind exactly as the lifecycle expects", async () => {
  const { port, recorded } = fakePort([claimed("a"), claimed("b"), claimed("c", 3), claimed("d"), claimed("e")]);
  const provider = createMockEmailProvider([{ kind: "accepted", messageId: "pm-1234567" }, { kind: "retry", code: "rate_limit" }, { kind: "retry", code: "rate_limit" }, { kind: "unknown", code: "timeout" }, { kind: "failed", code: "inactive_recipient" }]);
  const summary = await dispatchBatch(port, provider, 10);
  assert.deepEqual(summary, { accepted: 1, retried: 1, failed: 2, unknown: 1, stale: 0 });
  assert.deepEqual(recorded.map((r) => `${r.id}:${r.outcome}:${r.retry}`), ["a:accepted:false", "b:failed:true", "c:failed:true", "d:unknown:false", "e:failed:false"]);
  assert.equal(recorded[1].delay, 60);
  assert.equal(recorded[3].code, "timeout");
});

test("notify: the dispatcher is bounded, sends only with the database-resolved sender and never falls back to a platform sender", async () => {
  const bounded = fakePort([claimed("a"), claimed("b"), claimed("c")]);
  const mock = createMockEmailProvider([{ kind: "accepted", messageId: "pm-1234567" }]);
  assert.equal((await dispatchBatch(bounded.port, mock, 2)).accepted, 2);
  const own = fakePort([claimed("f", 1, { name: "Org A", email: "it@a.example.test", replyTo: "help@a.example.test" })]);
  const used = createMockEmailProvider([{ kind: "accepted", messageId: "pm-7654321" }]);
  await dispatchBatch(own.port, used, 5);
  assert.deepEqual([used.sent[0].from.email, used.sent[0].replyTo], ["it@a.example.test", "help@a.example.test"]);
  const none = fakePort([claimed("g", 1, null)]);
  const unused = createMockEmailProvider([{ kind: "accepted", messageId: "pm-0000000" }]);
  const summary = await dispatchBatch(none.port, unused, 5);
  assert.deepEqual([unused.sent.length, summary.failed, none.recorded[0].code], [0, 1, "sender_unconfigured"]);
});

test("notify: a delivery whose lease was lost is counted stale and not reported as sent", async () => {
  const { port, stale } = fakePort([claimed("a")]); stale("a");
  const summary = await dispatchBatch(port, createMockEmailProvider([{ kind: "accepted", messageId: "pm-1234567" }]), 5);
  assert.deepEqual([summary.accepted, summary.stale], [0, 1]);
});

const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;

test("notify: webhook callers must present the configured Basic credentials", async () => {
  assert.equal(await verifyBasicAuth(basic("hook", "s3cret-pass"), "hook", "s3cret-pass"), true);
  for (const header of [null, "", "Basic", "Bearer abc", basic("hook", "wrong"), basic("other", "s3cret-pass"), basic("hook", "s3cret-pass-"), "Basic !!!notbase64", `Basic ${btoa("hook:s3cret-pass")} extra`]) {
    assert.equal(await verifyBasicAuth(header, "hook", "s3cret-pass"), false, String(header));
  }
  assert.equal(await verifyBasicAuth(basic("", ""), "", ""), false, "unset credentials never authenticate");
  assert.equal(await verifyBasicAuth(basic("hook", "pässword"), "hook", "pässword"), false, "non-Latin-1 input is rejected rather than crashing the check");
});

test("notify: webhook payloads are validated, deduplicated by a stable key and stripped of recipient data", () => {
  const delivery = parseWebhook({ RecordType: "Delivery", MessageID: "0a129aee-e1cd-480d-b08d-4f48548ff48d", Recipient: "agent@example.test", DeliveredAt: "2026-10-26T01:00:00Z" });
  assert.deepEqual(delivery, { recordType: "Delivery", messageId: "0a129aee-e1cd-480d-b08d-4f48548ff48d", eventKey: "Delivery:0a129aee-e1cd-480d-b08d-4f48548ff48d:", detail: {} });
  const bounce = parseWebhook({ RecordType: "Bounce", ID: 692560173, Type: "HardBounce", MessageID: "0a129aee-e1cd-480d-b08d-4f48548ff48d", Email: "agent@example.test", Description: "x".repeat(900) });
  assert.ok(bounce && bounce !== "ignored");
  assert.equal(bounce.eventKey, "Bounce:0a129aee-e1cd-480d-b08d-4f48548ff48d:692560173");
  assert.equal(bounce.detail.type, "HardBounce");
  assert.equal(bounce.detail.description?.length, 300);
  assert.ok(!JSON.stringify(bounce).includes("agent@example.test"));
  assert.equal((parseWebhook({ RecordType: "SpamComplaint", ID: 1, MessageID: "0a129aee-e1cd-480d-b08d-4f48548ff48d" }) as WebhookEvent).recordType, "SpamComplaint");
  assert.equal(parseWebhook({ RecordType: "Open", MessageID: "0a129aee-e1cd-480d-b08d-4f48548ff48d" }), "ignored");
  for (const bad of [null, [], "x", {}, { RecordType: 5 }, { RecordType: "Delivery" }, { RecordType: "Delivery", MessageID: "short" }, { RecordType: "Delivery", MessageID: "bad id with spaces ../" }]) assert.equal(parseWebhook(bad), null, JSON.stringify(bad));
  const replay = parseWebhook({ RecordType: "Delivery", MessageID: "0a129aee-e1cd-480d-b08d-4f48548ff48d" }) as WebhookEvent;
  assert.equal(replay.eventKey, delivery && delivery !== "ignored" ? delivery.eventKey : "", "a replay produces the same key");
});

test("notify: the display From is built as \"Name\" <address> with quotes, backslashes, brackets and control characters neutralised", () => {
  assert.equal(formatFrom("Skyline Institute of Technology", "it@slit.edu.au"), '"Skyline Institute of Technology" <it@slit.edu.au>');
  assert.equal(formatFrom('Acme "Best" <Uni>\\', "a@b.test"), '"Acme \\"Best\\" Uni\\\\" <a@b.test>');
  assert.equal(formatFrom("Line\r\nBreak", "a@b.test"), '"Line Break" <a@b.test>');
});

test("notify: Postmark sender rejection is a definitive, non-retried failure and the From/Reply-To are sent as built", async () => {
  const bodies: Record<string, unknown>[] = [];
  const reject = (code: number) => (init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ ErrorCode: code, Message: "x" }), { status: 422 }); };
  for (const code of [400, 401]) {
    const outcome = await createPostmarkProvider({ serverToken: PM_TOKEN, fetch: (async (_u: string, init: RequestInit) => reject(code)(init)) as unknown as typeof fetch }).send({ ...pmMessage, replyTo: "help@a.example.test" });
    assert.deepEqual(outcome, { kind: "failed", code: "sender_rejected" });
  }
  assert.equal(bodies[0].ReplyTo, "help@a.example.test");
  assert.match(String(bodies[0].From), /^".*" <.+>$/);
});

test("notify: the worker accepts only the service-role key (401 without a token, 403 for anon and user tokens)", async () => {
  const service = "service.role.key-value";
  assert.equal(await authorizeWorker(`Bearer ${service}`, service), 200);
  assert.equal(await authorizeWorker(null, service), 401);
  assert.equal(await authorizeWorker("", service), 401);
  assert.equal(await authorizeWorker("Basic abc", service), 401);
  for (const token of ["anon.key.value", "user.jwt.value", service + "x", service.slice(1)]) assert.equal(await authorizeWorker(`Bearer ${token}`, service), 403, token);
  assert.equal(await authorizeWorker(`Bearer ${service}`, ""), 403, "an unconfigured service key never authorizes");
});

// ---- P08-06: submission PDF attached to the application_submitted email ----
import { composeBody, type SubmissionInfo } from "../supabase/functions/_shared/notification/delivery.ts";
import { MAX_ATTACHMENT_BYTES, MAX_PDF_PAGES, attachmentFileName, buildPdf, buildSubmissionPdf, submissionPdfLines } from "../supabase/functions/_shared/notification/submission-pdf.ts";

const pdfText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const snapshotOf = (extra: Record<string, unknown> = {}) => ({
  values: { first_name: "Ada", family_name: "Lovelace", passport_copy: "files/a.pdf", english_upload: "x", nationality: "Australia", interests: ["Maths", "Code"] },
  courses: [{ title: "Certificate IV in Cyber Security", code: "22334VIC" }],
  wizard: { confirmed: ["first_name"] }, provenance: { first_name: "manual" },
  submission: { actor: "8f2c1d3e-0000-4000-8000-000000000001", consent: { method: "electronic", declarationVersion: "1.0", signedDocumentRef: "private/path.pdf" } },
  ...extra,
});
const info = (patch: Partial<SubmissionInfo> = {}): SubmissionInfo => ({ mode: "attach", link: "https://slit.edu.au/agency/applications/app-1", reference: "SK-2026-0001", version: 1, institution: "Skyline Institute", submittedAt: "2026-10-27T01:02:03Z", snapshot: snapshotOf(), ...patch });
const submitted = (id = "s1"): ClaimedDelivery => ({ ...claimed(id), event: "application_submitted", body: "Application SK-2026-0001 has been submitted." });

test("pdf: the file is structurally valid (header, xref offsets, trailer, page count) and text is escaped and ASCII-safe", () => {
  const bytes = buildPdf([{ text: "Smith (Jr) \\ back", style: "title" }, { text: "Zoë 山 café" }], "Tëst");
  const text = pdfText(bytes);
  assert.ok(text.startsWith("%PDF-1.4\n") && text.endsWith("%%EOF\n"));
  const xrefAt = Number(/startxref\n(\d+)\n/.exec(text)?.[1]);
  assert.ok(text.slice(xrefAt).startsWith("xref\n0 "));
  const offsets = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offsets.forEach((offset, i) => assert.ok(text.slice(offset).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
  assert.equal(Number(/\/Count (\d+)/.exec(text)?.[1]), 1);
  assert.ok(text.includes("Smith \\(Jr\\) \\\\ back"));
  assert.ok(text.includes("Zoe ? cafe"));
  assert.ok(/^[\n\x20-\x7e]*$/.test(text), "pure ASCII output");
});

test("pdf: long content paginates, is capped, stays under the attachment limit and says it was truncated", () => {
  const lines = Array.from({ length: 8000 }, (_, i) => ({ text: `Line ${i} ${"word ".repeat(30)}` }));
  const bytes = buildPdf(lines, "Long");
  const text = pdfText(bytes);
  const pages = Number(/\/Count (\d+)/.exec(text)?.[1]);
  assert.ok(pages > 1 && pages <= MAX_PDF_PAGES, String(pages));
  assert.ok(text.includes("Truncated: open the application in the portal"));
  assert.ok(bytes.length < MAX_ATTACHMENT_BYTES);
});

test("pdf: only entered values are printed; uploads, wizard / provenance internals, actor ids and storage paths are left out", () => {
  const text = pdfText(buildSubmissionPdf({ reference: "SK-2026-0001", institution: "Skyline Institute", version: 2, submittedAt: "2026-10-27T01:02:03Z", snapshot: snapshotOf() }));
  for (const wanted of ["Application SK-2026-0001", "version 2, 2026-10-27", "First name: Ada", "Family name: Lovelace", "Interests: Maths, Code", "Certificate IV in Cyber Security \\(22334VIC\\)", "electronic"]) assert.ok(text.includes(wanted), wanted);
  for (const unwanted of ["files/a.pdf", "Passport copy", "English upload", "manual", "8f2c1d3e", "private/path.pdf", "Wizard", "Provenance"]) assert.ok(!text.includes(unwanted), unwanted);
  assert.ok(submissionPdfLines({ reference: "R", institution: "I", version: 1, submittedAt: null, snapshot: null }).some((l) => /No form values/.test(l.text)));
  assert.equal(attachmentFileName("SK 2026/0001 «"), "application-SK20260001.pdf");
  assert.equal(attachmentFileName(""), "application-submitted.pdf");
});

test("pdf: attach mode adds one PDF and says so; link mode sends only the sign-in link; other events are untouched", async () => {
  const attach = await composeBody({ ...fakePort([]).port, submission: async () => info() }, submitted());
  assert.equal(attach.attachments?.length, 1);
  assert.equal(attach.attachments?.[0].name, "application-SK-2026-0001.pdf");
  assert.equal(attach.attachments?.[0].contentType, "application/pdf");
  assert.ok(atob(attach.attachments![0].contentBase64).startsWith("%PDF-1.4"));
  assert.match(attach.textBody, /attached as a PDF/);
  assert.ok(!attach.textBody.includes("Ada"));
  const link = await composeBody({ ...fakePort([]).port, submission: async () => info({ mode: "link", snapshot: null }) }, submitted());
  assert.equal(link.attachments, undefined);
  assert.match(link.textBody, /sign-in required\): https:\/\/slit\.edu\.au\/agency\/applications\/app-1$/);
  let asked = 0;
  const other = await composeBody({ ...fakePort([]).port, submission: async () => { asked++; return info(); } }, { ...submitted(), event: "offer_accepted" });
  assert.deepEqual([other.attachments, other.textBody, asked], [undefined, "Application SK-2026-0001 has been submitted.", 0]);
});

test("pdf: a failing lookup or a PDF that cannot be built never blocks the email and falls back to the link or the plain body", async () => {
  const lookupFails = await composeBody({ ...fakePort([]).port, submission: async () => { throw new Error("rpc"); } }, submitted());
  assert.deepEqual([lookupFails.attachments, lookupFails.textBody], [undefined, "Application SK-2026-0001 has been submitted."]);
  const none = await composeBody({ ...fakePort([]).port, submission: async () => null }, submitted());
  assert.equal(none.attachments, undefined);
  const broken = { get values(): never { throw new Error("cannot render"); } };
  const fallback = await composeBody({ ...fakePort([]).port, submission: async () => info({ snapshot: broken }) }, submitted());
  assert.equal(fallback.attachments, undefined);
  assert.match(fallback.textBody, /sign-in required\): https:\/\//);
  const missing = await composeBody({ ...fakePort([]).port, submission: async () => info({ snapshot: null }) }, submitted());
  assert.equal(missing.attachments, undefined);
});

test("pdf: the dispatcher sends the attachment, and what it records never contains form content", async () => {
  const { port, recorded } = fakePort([submitted("s1")]);
  const provider = createMockEmailProvider([{ kind: "accepted", messageId: "pm-1234567" }]);
  const summary = await dispatchBatch({ ...port, submission: async () => info() }, provider, 5);
  assert.equal(summary.accepted, 1);
  assert.equal(provider.sent[0].attachments?.length, 1);
  assert.ok(!JSON.stringify(recorded).includes("Ada") && !JSON.stringify(recorded).includes("%PDF"));
});

test("pdf: the Postmark adapter sends Attachments only when there are some", async () => {
  const withFile = pmHarness(() => new Response(JSON.stringify({ ErrorCode: 0, MessageID: "11111111-2222-3333-4444-555555555555" }), { status: 200 }));
  await withFile.provider.send({ ...pmMessage, attachments: [{ name: "application-SK-1.pdf", contentType: "application/pdf", contentBase64: btoa("%PDF-1.4") }] });
  assert.deepEqual(withFile.calls[0].body.Attachments, [{ Name: "application-SK-1.pdf", Content: btoa("%PDF-1.4"), ContentType: "application/pdf" }]);
  const without = pmHarness(() => new Response(JSON.stringify({ ErrorCode: 0, MessageID: "11111111-2222-3333-4444-555555555555" }), { status: 200 }));
  await without.provider.send(pmMessage);
  assert.ok(!("Attachments" in without.calls[0].body));
});

// ---- P08-07: the issued CoE / VoE travels with the coe_voe_issued email ----
import { AttachmentUnavailableError, type CoeDocumentInfo } from "../supabase/functions/_shared/notification/delivery.ts";

const coeDoc = (patch: Partial<CoeDocumentInfo> = {}): CoeDocumentInfo => ({ kind: "coe", sizeBytes: 15, contentBase64: btoa("%PDF-1.4\n%%EOF\n"), reference: "SK-2026-0001", ...patch });
const issuedDelivery = (id = "c1"): ClaimedDelivery => ({ ...claimed(id), event: "coe_voe_issued", body: "The CoE / VoE for application SK-2026-0001 has been issued." });

test("coe/voe email: the issued PDF is attached, named by type and reference, and the body says so", async () => {
  const composed = await composeBody({ ...fakePort([]).port, coeDocument: async () => coeDoc() }, issuedDelivery());
  assert.equal(composed.attachments?.length, 1);
  assert.deepEqual([composed.attachments?.[0].name, composed.attachments?.[0].contentType], ["CoE-SK-2026-0001.pdf", "application/pdf"]);
  assert.match(composed.textBody, /The CoE is attached as a PDF\./);
  const voe = await composeBody({ ...fakePort([]).port, coeDocument: async () => coeDoc({ kind: "voe" }) }, issuedDelivery());
  assert.equal(voe.attachments?.[0].name, "VoE-SK-2026-0001.pdf");
});

test("coe/voe email: a plain status change (no document issued) sends the plain notice; other events never ask for a document", async () => {
  const none = await composeBody({ ...fakePort([]).port, coeDocument: async () => null }, issuedDelivery());
  assert.deepEqual([none.attachments, none.textBody], [undefined, "The CoE / VoE for application SK-2026-0001 has been issued."]);
  let asked = 0;
  await composeBody({ ...fakePort([]).port, coeDocument: async () => { asked++; return coeDoc(); } }, { ...issuedDelivery(), event: "offer_accepted" });
  assert.equal(asked, 0);
});

test("coe/voe email: if the document cannot be read the delivery is retried later and nothing is sent without it", async () => {
  await assert.rejects(composeBody({ ...fakePort([]).port, coeDocument: async () => { throw new Error("rpc"); } }, issuedDelivery()), AttachmentUnavailableError);
  await assert.rejects(composeBody({ ...fakePort([]).port, coeDocument: async () => coeDoc({ sizeBytes: 0 }) }, issuedDelivery()), AttachmentUnavailableError);
  const { port, recorded } = fakePort([issuedDelivery("c1"), issuedDelivery("c2")]);
  const provider = createMockEmailProvider([{ kind: "accepted", messageId: "pm-1234567" }]);
  const summary = await dispatchBatch({ ...port, coeDocument: async (d) => { if (d.id === "c1") throw new Error("down"); return coeDoc(); } }, provider, 5);
  assert.deepEqual([summary.retried, summary.accepted, provider.sent.length], [1, 1, 1]);
  assert.deepEqual(recorded.map((r) => `${r.id}:${r.code}:${r.retry}`), ["c1:attachment_unavailable:true", "c2:null:false"]);
  assert.equal(provider.sent[0].attachments?.length, 1);
});
