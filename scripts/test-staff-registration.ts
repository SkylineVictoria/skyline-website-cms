import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createJiti } from "jiti";
import * as PdfLib from "pdf-lib";

// Offline unit tests for staff self-registration: phone normalisation (three twins kept in step), status transitions (kept in step with
// the database), duplicate-check messages, submit rules, login routing and document reading with the deterministic mock provider.
const load = createJiti(import.meta.url, { alias: { "@": path.resolve("src") } });
const phone = await load.import<typeof import("../src/lib/staffPhone.ts")>("../src/lib/staffPhone.ts");
const edgePhone = await load.import<typeof import("../supabase/functions/_shared/staff-phone.ts")>("../supabase/functions/_shared/staff-phone.ts");
const status = await load.import<typeof import("../src/lib/staffStatus.ts")>("../src/lib/staffStatus.ts");
const staffStatusLib = status;
const checklistLib = await load.import<typeof import("../src/lib/documentChecklist.ts")>("../src/lib/documentChecklist.ts");
const routing = await load.import<typeof import("../src/lib/loginRouting.ts")>("../src/lib/loginRouting.ts");
const core = await load.import<typeof import("../supabase/functions/staff-onboarding/reader.ts")>("../supabase/functions/staff-onboarding/reader.ts");
const mock = await load.import<typeof import("../supabase/functions/_shared/document-extraction/mock.ts")>("../supabase/functions/_shared/document-extraction/mock.ts");
const apply = await load.import<typeof import("../supabase/functions/staff-register/core.ts")>("../supabase/functions/staff-register/core.ts");
const captchaLib = await load.import<typeof import("../supabase/functions/_shared/captcha.ts")>("../supabase/functions/_shared/captcha.ts");
const onboard = await load.import<typeof import("../supabase/functions/staff-onboarding/core.ts")>("../supabase/functions/staff-onboarding/core.ts");
const hrMail = await load.import<typeof import("../supabase/functions/_shared/hr-mail.ts")>("../supabase/functions/_shared/hr-mail.ts");
const mailLib = await load.import<typeof import("../supabase/functions/_shared/notification/delivery.ts")>("../supabase/functions/_shared/notification/delivery.ts");
const offerPdf = await load.import<typeof import("../supabase/functions/_shared/offer-pdf.ts")>("../supabase/functions/_shared/offer-pdf.ts");
const drainLib = await load.import<typeof import("../supabase/functions/_shared/hr-mail-drain.ts")>("../supabase/functions/_shared/hr-mail-drain.ts");
const staffAdmin = await load.import<typeof import("../supabase/functions/staff-admin/core.ts")>("../supabase/functions/staff-admin/core.ts");

const read = (file: string) => readFileSync(path.resolve(file), "utf8");

/* ------------------------------------------------------------------ phone normalisation */

const VECTORS: Array<[string, string | null]> = [
  ["+61 412 345 678", "+61412345678"], ["0412 345 678", "+61412345678"], ["+61 (0)412 345 678", "+61412345678"], ["0061412345678", "+61412345678"],
  ["(02) 9876 5432", "+61298765432"], ["+44 7700 900123", "+447700900123"], ["9876543210", null], ["+0123", null], ["", null], ["abc", null],
  ["+61-412-345-678", "+61412345678"], ["  +61412345678  ", "+61412345678"], ["04123456", null],
];

test("phone numbers in different formats normalise to the same E.164 value", () => {
  for (const [input, expected] of VECTORS) {
    assert.equal(phone.toE164(input), expected, `browser twin: ${input}`);
    assert.equal(edgePhone.toE164(input), expected, `edge function twin: ${input}`);
  }
  const forms = ["0412 345 678", "+61 412 345 678", "+61 (0)412-345-678", "0061 412 345 678", "(+61) 412 345 678"];
  assert.equal(new Set(forms.map((f) => phone.toE164(f))).size, 1, "every format of one number is one value");
});

test("the browser, the edge function and the database normalise the same vectors", () => {
  const sql = read("supabase/tests/hr_staff_registration.sql");
  const pairs = [...sql.matchAll(/select is\(hr\.phone_e164\('([^']*)'\), (null|'([^']*)'),/g)].map((m) => [m[1], m[3] ?? null] as const);
  assert.ok(pairs.length >= 8, "the SQL test lists the shared vectors");
  for (const [input, expected] of pairs) assert.equal(phone.toE164(input), expected, `SQL vector ${input}`);
});

/* ------------------------------------------------------------------ status transitions */

test("status transitions allow exactly the agreed moves", () => {
  const allowed: Array<[string, string]> = [["applied", "invited"], ["applied", "rejected"], ["invited", "documents_submitted"], ["invited", "rejected"],
    ["documents_submitted", "invited"], ["documents_submitted", "offer_sent"], ["documents_submitted", "rejected"],
    ["offer_sent", "offer_signed"], ["offer_sent", "documents_submitted"], ["offer_sent", "rejected"], ["offer_signed", "active"], ["offer_signed", "rejected"],
    ["active", "inactive"], ["inactive", "active"], ["rejected", "applied"], ["inactive", "applied"]];
  for (const from of status.STAFF_STATUSES) for (const to of status.STAFF_STATUSES) {
    assert.equal(status.canTransition(from, to), allowed.some(([a, b]) => a === from && b === to), `${from} -> ${to}`);
  }
  assert.equal(status.canTransition("applied", "active"), false, "nobody skips review");
  assert.equal(status.canTransition("invited", "offer_sent"), false, "no offer before the documents are submitted");
});

test("the TypeScript transition table matches the database function and the status list", () => {
  const sql = read("supabase/migrations/20261110090000_hr_staff_enrolment_v2.sql");
  const body = sql.slice(sql.indexOf("function hr.staff_transition_allowed"), sql.indexOf("function hr.staff_status_guard"));
  const pairs = [...body.matchAll(/\('([a-z_]+)','([a-z_]+)'\)/g)].map((m) => [m[1], m[2]]);
  assert.equal(pairs.length, 16);
  for (const from of status.STAFF_STATUSES) for (const to of status.STAFF_STATUSES) {
    assert.equal(status.canTransition(from, to), pairs.some(([a, b]) => a === from && b === to), `database ${from} -> ${to}`);
  }
  const check = sql.slice(sql.indexOf("add constraint staff_profiles_status_check"));
  const list = check.match(/status in \(([^)]*)\)/)?.[1].replace(/'/g, "").split(",").map((s) => s.trim());
  assert.deepEqual(list, [...status.STAFF_STATUSES]);
});

test("Employees actions follow the status and what exists; each one is a legal move with a confirmation", () => {
  const base = { liveDocumentLink: false, rejectedDocuments: 0, allApproved: false, offer: null, activationInvited: false };
  const acts = (status: string, extra: Record<string, unknown> = {}) => status && staffStatusLib.employeeActions({ ...base, ...extra, status } as never);
  assert.deepEqual(acts("applied"), ["send_documents_link", "reject"]);
  assert.deepEqual(acts("invited"), ["resend_documents_link", "reject"], "no live link: nothing to revoke");
  assert.deepEqual(acts("invited", { liveDocumentLink: true }), ["resend_documents_link", "revoke_link", "reject"]);
  assert.deepEqual(acts("documents_submitted"), ["reject"], "nothing to offer before every document is approved");
  assert.deepEqual(acts("documents_submitted", { rejectedDocuments: 1 }), ["send_reupload_link", "reject"]);
  assert.deepEqual(acts("documents_submitted", { allApproved: true }), ["upload_offer", "reject"]);
  assert.deepEqual(acts("documents_submitted", { allApproved: true, offer: { sent: false } }), ["upload_offer", "send_offer", "reject"]);
  assert.deepEqual(acts("offer_sent"), ["resend_offer", "withdraw_offer", "reject"]);
  assert.deepEqual(acts("offer_signed"), ["activate", "reject"]);
  assert.deepEqual(acts("offer_signed", { activationInvited: true }), ["resend_activation", "reject"]);
  assert.deepEqual(acts("active"), ["deactivate"]);
  assert.deepEqual(acts("inactive"), ["reactivate"]);
  assert.deepEqual(acts("rejected"), ["reopen"]);
  for (const st of status.STAFF_STATUSES) {
    for (const extra of [{}, { liveDocumentLink: true, rejectedDocuments: 2, allApproved: true, offer: { sent: false }, activationInvited: true }]) {
      for (const action of staffStatusLib.employeeActions({ ...base, ...extra, status: st } as never)) {
        const to = staffStatusLib.EMPLOYEE_ACTION_TARGET[action];
        assert.ok(to === null || status.canTransition(st, to), `${action} from ${st} is a legal move`);
        const spec = staffStatusLib.EMPLOYEE_ACTION[action];
        assert.ok(spec.label && spec.confirm && spec.explain, `${action} has a confirmation dialog`);
      }
    }
  }
  for (const action of ["reject", "withdraw_offer", "reopen"] as const) assert.equal(staffStatusLib.EMPLOYEE_ACTION[action].note, "required", `${action} needs a note`);
  for (const kind of ["application_received", "already_applied", "admin_new_application", "document_invite", "reupload_invite", "admin_documents_submitted", "offer", "signed_offer", "admin_offer_signed", "rejected", "access_ready"]) {
    assert.ok(staffStatusLib.EMAIL_KIND_LABEL[kind], `email kind ${kind} has a label for the admin`);
  }
  // Staff > Employees is the simple Active / Inactive page since 20261110170000 (see "simple employees" below).
  const sql = read("supabase/migrations/20261110090000_hr_staff_enrolment_v2.sql");
  const fn = sql.slice(sql.indexOf("function public.hr_admin_staff_activate_account"));
  assert.ok(/hr\.require_admin\(\)/.test(fn.slice(0, 400)), "activation checks for an administrator first");
  assert.ok(fn.includes("p.status <> 'offer_signed'") && fn.includes("u.id <> p_auth_user_id") && fn.includes("where lower(btrim(coalesce(email, ''))) = p.email"), "only a signed offer, only the person's own login");
  const send = sql.slice(sql.indexOf("function public.hr_admin_staff_offer_send"));
  assert.ok(send.indexOf("hr.staff_documents_problem(p.id)") > 0 && send.indexOf("hr.staff_documents_problem(p.id)") < send.indexOf("hr.invite_create("), "every required document is approved before an offer goes out");
});

/* ------------------------------------------------------------------ duplicate checks */

test("a conflict is one neutral message that never names the kind of account", () => {
  const email = status.conflictMessage({ ok: false, emailConflict: true });
  const number = status.conflictMessage({ ok: false, phoneConflict: true });
  assert.deepEqual(email, { field: "email", message: "This email can't be used. Sign in or contact the administrator." });
  assert.deepEqual(number, { field: "phone", message: "This number can't be used. Sign in or contact the administrator." });
  for (const word of ["student", "agent", "admin user", "staff member", "already registered"]) assert.ok(!`${email!.message} ${number!.message}`.toLowerCase().includes(word), word);
  assert.equal(status.conflictMessage({ ok: true }), null);
  assert.equal(status.conflictMessage({ ok: false, reason: "invalid_phone" })?.field, "phone");
});

/* ------------------------------------------------------------------ public apply (staff-register, HR-02b) */

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF");
const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode("....[Content_Types].xml....word/document.xml....")]);
function applyForm(overrides: Record<string, string | File | null> = {}): FormData {
  const values: Record<string, string | File | null> = {
    firstName: "Ann", lastName: "Applicant", email: "Ann@Example.test", phone: "0412 345 678", agreed: "true", captchaToken: captchaLib.LOCAL_MOCK_TOKEN,
    website: "", resume: new File([PDF_BYTES], "cv.pdf", { type: "application/pdf" }), ...overrides,
  };
  const form = new FormData();
  for (const [k, v] of Object.entries(values)) if (v !== null) form.set(k, v);
  return form;
}
function applyDeps(options: { limit?: (bucket: string) => boolean; apply?: unknown; applyError?: boolean; uploadError?: string; resumeError?: boolean; captcha?: "mock" | "unavailable" } = {}) {
  const calls: Array<[string, unknown]> = [];
  const deps = {
    captcha: options.captcha === "unavailable" ? captchaLib.selectCaptchaVerifier({}) : captchaLib.createMockCaptchaVerifier(),
    takeRateLimit: async (bucket: string) => { calls.push(["limit", bucket]); return options.limit ? options.limit(bucket) : true; },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      if (name === "hr_svc_apply") return options.applyError ? { data: null, error: { message: "down" } } : { data: options.apply ?? { ok: true, profileId: "p-1" }, error: null };
      return options.resumeError ? { data: null, error: { message: "bad" } } : { data: { ok: true }, error: null };
    },
    upload: async (p: string, bytes: Uint8Array, type: string) => { calls.push(["upload", { p, size: bytes.length, type }]); return { error: options.uploadError ?? null }; },
    remove: async (p: string) => { calls.push(["remove", p]); },
    hash: async (v: string) => `h(${v})`,
    newId: () => "rnd",
  };
  return { deps, calls, names: () => calls.map(([n]) => n) };
}

test("apply: a complete application stores the resume in the person's own folder and records it", async () => {
  const { deps, calls, names } = applyDeps();
  const result = await apply.handleApply(applyForm(), { ip: "203.0.113.9" }, deps);
  assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.deepEqual(names(), ["limit", "limit", "hr_svc_apply", "upload", "hr_svc_apply_resume"], "IP limit, email limit, apply, upload, record");
  assert.deepEqual(calls[0][1], "staff-register:caller:apply:h(203.0.113.9)");
  assert.deepEqual(calls[1][1], "staff-register:email:apply:h(ann@example.test)", "the email limit uses the normalised address");
  assert.deepEqual(calls[2][1], { p_first_name: "Ann", p_last_name: "Applicant", p_email: "ann@example.test", p_phone: "+61412345678", p_job: null, p_cover_letter: null });
  assert.deepEqual(calls[3][1], { p: "p-1/resume/rnd.pdf", size: PDF_BYTES.length, type: "application/pdf" });
  assert.deepEqual(calls[4][1], { p_profile: "p-1", p_path: "p-1/resume/rnd.pdf", p_filename: "cv.pdf", p_mime: "application/pdf", p_size: PDF_BYTES.length });
});

test("apply: a Word .docx resume is accepted by its content", async () => {
  const { deps, calls } = applyDeps();
  const result = await apply.handleApply(applyForm({ resume: new File([DOCX_BYTES], "My CV.docx") }), { ip: null }, deps);
  assert.equal(result.status, 200);
  assert.equal((calls.find(([n]) => n === "upload")![1] as { type: string }).type, apply.RESUME_TYPES.docx);
});

test("apply: the resume must really be a PDF or DOCX, named so, and at most 5 MB", async () => {
  const bad: Array<[string, File]> = [
    ["renamed exe", new File([new Uint8Array([0x4d, 0x5a, 1, 2])], "cv.pdf")],
    ["pdf bytes named .docx", new File([PDF_BYTES], "cv.docx")],
    ["a zip that is not Word", new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], "cv.docx")],
    ["old .doc", new File([PDF_BYTES], "cv.doc")],
    ["empty", new File([], "cv.pdf")],
    ["too big", new File([PDF_BYTES, new Uint8Array(apply.MAX_RESUME_BYTES)], "cv.pdf")],
  ];
  for (const [label, file] of bad) {
    const { deps, names } = applyDeps();
    const result = await apply.handleApply(applyForm({ resume: file }), { ip: null }, deps);
    assert.equal(result.status, 400, label);
    assert.equal(result.body.field, "resume", label);
    assert.ok(!names().includes("hr_svc_apply") && !names().includes("upload"), `${label}: nothing is stored`);
  }
  const { deps } = applyDeps();
  assert.equal((await apply.handleApply(applyForm({ resume: null }), { ip: null }, deps)).body.field, "resume", "a resume is required");
  assert.equal(apply.safeFilename("C:\\fake\\path\\cv\u0007.pdf", "pdf"), "cv.pdf", "no path or control characters in the stored name");
});

test("apply: the CAPTCHA is checked before anything is stored, and an outage fails closed", async () => {
  let run = applyDeps();
  let result = await apply.handleApply(applyForm({ captchaToken: "forged" }), { ip: null }, run.deps);
  assert.deepEqual([result.status, result.body.field], [400, "captcha"]);
  assert.ok(!run.names().includes("hr_svc_apply"));
  run = applyDeps({ captcha: "unavailable" });
  result = await apply.handleApply(applyForm(), { ip: null }, run.deps);
  assert.equal(result.status, 503, "no CAPTCHA configuration: refused");
  assert.ok(!run.names().includes("hr_svc_apply"));
});

test("apply: rate limits per caller and per email fail closed", async () => {
  let run = applyDeps({ limit: (b) => !b.startsWith("staff-register:caller:") });
  let result = await apply.handleApply(applyForm(), { ip: "1.2.3.4" }, run.deps);
  assert.deepEqual([result.status, result.headers?.["Retry-After"]], [429, "600"]);
  run = applyDeps({ limit: (b) => !b.startsWith("staff-register:email:") });
  result = await apply.handleApply(applyForm(), { ip: "1.2.3.4" }, run.deps);
  assert.deepEqual([result.status, result.headers?.["Retry-After"]], [429, "3600"]);
  assert.ok(!run.names().includes("hr_svc_apply"));
});

test("apply: the honeypot and an existing application get the same thank-you and store nothing", async () => {
  let run = applyDeps();
  assert.deepEqual(await apply.handleApply(applyForm({ website: "spam.example" }), { ip: null }, run.deps), { status: 200, body: { ok: true } });
  assert.deepEqual(run.names(), ["limit"]);
  run = applyDeps({ apply: { ok: false, reason: "exists" } });
  assert.deepEqual(await apply.handleApply(applyForm(), { ip: null }, run.deps), { status: 200, body: { ok: true } }, "never reveals who has applied");
  assert.ok(!run.names().includes("upload") && !run.names().includes("hr_svc_apply_resume"));
});

test("apply: field checks, and a failed record removes the stored file", async () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ firstName: "" }, "firstName"], [{ lastName: "<script>" }, "lastName"], [{ email: "nope" }, "email"], [{ phone: "12345" }, "phone"], [{ agreed: "false" }, "agreed"],
  ];
  for (const [over, field] of cases) assert.equal((await apply.handleApply(applyForm(over), { ip: null }, applyDeps().deps)).body.field, field, field);
  let run = applyDeps({ uploadError: "storage down" });
  assert.equal((await apply.handleApply(applyForm(), { ip: null }, run.deps)).status, 503);
  assert.ok(!run.names().includes("hr_svc_apply_resume"));
  run = applyDeps({ resumeError: true });
  assert.equal((await apply.handleApply(applyForm(), { ip: null }, run.deps)).status, 503);
  assert.deepEqual(run.calls.at(-1), ["remove", "p-1/resume/rnd.pdf"], "an unrecorded file is deleted");
  run = applyDeps({ applyError: true });
  assert.equal((await apply.handleApply(applyForm(), { ip: null }, run.deps)).status, 503);
});

test("CAPTCHA: the mock only works against a local Supabase URL; Turnstile is verified server-side", async () => {
  assert.equal(captchaLib.selectCaptchaVerifier({ EF_CAPTCHA_SECRET_KEY: "local-mock", SUPABASE_URL: "http://127.0.0.1:54321" }).id, "mock");
  assert.equal(captchaLib.selectCaptchaVerifier({ EF_CAPTCHA_SECRET_KEY: "local-mock", SUPABASE_URL: "http://kong:8000" }).id, "mock");
  assert.equal(captchaLib.selectCaptchaVerifier({ EF_CAPTCHA_SECRET_KEY: "local-mock", SUPABASE_URL: "https://xcpydisstlvtvcsqnjob.supabase.co" }).id, "unconfigured", "never the mock on hosted");
  assert.equal(captchaLib.selectCaptchaVerifier({ EF_CAPTCHA_SECRET_KEY: "", SUPABASE_URL: "http://127.0.0.1:54321" }).id, "unconfigured");
  const sent: Array<{ url: string; body: string }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: String(init.body) });
    return new Response(JSON.stringify({ success: String(init.body).includes("response=good") }), { status: 200 });
  }) as unknown as typeof fetch;
  const turnstile = captchaLib.selectCaptchaVerifier({ EF_CAPTCHA_SECRET_KEY: "secret-1", SUPABASE_URL: "https://x.supabase.co" }, { fetch: fakeFetch });
  assert.deepEqual(await turnstile.verify("good", "203.0.113.9"), { ok: true });
  assert.deepEqual(await turnstile.verify("bad"), { ok: false, reason: "rejected" });
  assert.deepEqual(await turnstile.verify(""), { ok: false, reason: "missing" });
  assert.equal(sent[0].url, captchaLib.TURNSTILE_VERIFY_URL);
  assert.ok(sent[0].body.includes("secret=secret-1") && sent[0].body.includes("remoteip=203.0.113.9"));
  const down = captchaLib.createTurnstileVerifier({ secret: "s", fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
  assert.deepEqual(await down.verify("x"), { ok: false, reason: "unavailable" });
});

/* ------------------------------------------------------------------ onboarding by link (staff-onboarding, HR-02c) */

const LINK = "A".repeat(43);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
function linkDeps(options: { limit?: (b: string) => boolean; db?: Record<string, { data?: unknown; error?: { code?: string; message?: string } }>; uploadError?: string; original?: Uint8Array | null; stampFails?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  const scheduled: string[] = [];
  const bad = new Map<string, number>();
  const deps = {
    takeRateLimit: async (b: string) => { calls.push(["limit", b]); if (b.startsWith("staff-onboarding:bad:")) bad.set(b, (bad.get(b) ?? 0) + 1); return options.limit ? options.limit(b) : true; },
    rateCount: async (b: string) => bad.get(b) ?? 0,
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      const answer = options.db?.[name];
      if (answer) return { data: answer.data ?? null, error: answer.error ?? null };
      if (name === "hr_svc_upload_target") return { data: { profileId: "p-1", folder: String(args.p_category).toLowerCase().replace(/ /g, "-") }, error: null };
      if (name === "hr_svc_document_add") return { data: { id: "d-1", replacedPaths: ["p-1/passport/old.pdf"], view: { ok: 1 } }, error: null };
      if (name === "hr_svc_document_path") return { data: "p-1/passport/x.pdf", error: null };
      if (name === "hr_svc_document_remove") return { data: { removedPath: "p-1/academic/a.pdf", view: { ok: 2 } }, error: null };
      return { data: { view: name }, error: null };
    },
    upload: async (p: string, bytes: Uint8Array, type: string) => { calls.push(["upload", { p, type, size: bytes.length }]); return { error: options.uploadError ?? null }; },
    remove: async (paths: string[]) => { calls.push(["remove", paths]); },
    signedUrl: async (p: string, seconds: number) => `signed:${p}:${seconds}`,
    scheduleExtraction: (doc: { category: string }) => { scheduled.push(doc.category); },
    hash: async (v: string) => `h(${v})`,
    newId: () => "rnd",
    download: async (p: string) => { calls.push(["download", p]); return options.original === undefined ? new Uint8Array([1, 2, 3]) : options.original; },
    sha256: async (bytes: Uint8Array) => `sha(${bytes.length})`,
    stampOffer: async (original: Uint8Array, sig: Record<string, unknown>) => { calls.push(["stamp", sig]); if (options.stampFails) throw new Error("x"); return new Uint8Array(original.length + 5); },
    now: () => new Date("2026-11-09T10:00:00Z"),
  };
  return { deps, calls, scheduled, names: () => calls.map(([n]) => n) };
}
const linkRequest = (action: string, fields: Record<string, unknown> = {}, file: File | null = null, token: unknown = LINK) => ({ action, token, ip: "203.0.113.5", fields, file });

test("onboarding: only the hash of the link reaches the database, and every bad link gets one neutral answer", async () => {
  let run = linkDeps();
  const ok = await onboard.handleOnboarding(linkRequest("open"), run.deps);
  assert.equal(ok.status, 200);
  const args = run.calls.find(([n]) => n === "hr_svc_onboarding_open")![1] as Record<string, unknown>;
  assert.deepEqual(args, { p_token_hash: `h(${LINK})` });
  assert.ok(!JSON.stringify(run.calls.filter(([n]) => n !== "limit")).includes(`"${LINK}"`), "the raw token is never sent to the database");
  for (const token of ["", "short", "x".repeat(200), "has spaces in it and is long enough to pass the length check", null]) {
    run = linkDeps();
    const r = await onboard.handleOnboarding(linkRequest("open", {}, null, token), run.deps);
    assert.deepEqual([r.status, r.body.code, r.body.error], [403, "link_invalid", onboard.LINK_INVALID], String(token));
    assert.ok(!run.names().some((n) => n.startsWith("hr_svc")), "no database call for a malformed link");
  }
  run = linkDeps({ db: { hr_svc_onboarding_open: { error: { code: "28000", message: "anything" } } } });
  const expired = await onboard.handleOnboarding(linkRequest("open"), run.deps);
  assert.deepEqual([expired.status, expired.body.error], [403, onboard.LINK_INVALID], "the database's refusal maps to the same text");
  run = linkDeps({ db: { hr_svc_onboarding_save: { error: { code: "23514", message: "This has already been sent and can no longer be changed." } } } });
  const used = await onboard.handleOnboarding(linkRequest("save", { patch: { first_name: "X" } }), run.deps);
  assert.deepEqual([used.status, used.body.error], [400, "This has already been sent and can no longer be changed."]);
  run = linkDeps({ db: { hr_svc_onboarding_open: { error: { code: "XX000", message: "internal detail" } } } });
  const crash = await onboard.handleOnboarding(linkRequest("open"), run.deps);
  assert.ok(crash.status === 500 && !String(crash.body.error).includes("internal detail"), "internal errors are not shown");
  assert.equal((await onboard.handleOnboarding(linkRequest("drop_table"), linkDeps().deps)).status, 400);
});

test("onboarding: an IP that guesses links is locked out after 20 invalid answers in 10 minutes", async () => {
  const run = linkDeps();
  for (let i = 0; i < onboard.BAD_LINK_LIMIT; i++) assert.equal((await onboard.handleOnboarding(linkRequest("open", {}, null, `guess.${i}`), run.deps)).status, 403);
  const locked = await onboard.handleOnboarding(linkRequest("open"), run.deps);
  assert.deepEqual([locked.status, locked.headers?.["Retry-After"]], [429, "600"], "even a valid link is refused from that IP for now");
  const other = await onboard.handleOnboarding({ ...linkRequest("open"), ip: "198.51.100.200" }, run.deps);
  assert.equal(other.status, 200, "other callers are not affected");
  assert.equal(onboard.BAD_LINK_WINDOW, 600);
});

test("onboarding: rate limits per caller and per link fail closed", async () => {
  let run = linkDeps({ limit: (b) => !b.startsWith("staff-onboarding:ip:") });
  assert.equal((await onboard.handleOnboarding(linkRequest("open"), run.deps)).status, 429);
  run = linkDeps({ limit: (b) => !b.startsWith("staff-onboarding:link:upload:") });
  const r = await onboard.handleOnboarding(linkRequest("upload", { category: "Passport" }, new File([PDF_BYTES], "p.pdf")), run.deps);
  assert.equal(r.status, 429);
  assert.ok(!run.names().includes("upload"));
});

test("onboarding: a file is checked by content, the database approves the type BEFORE it is stored, and leftovers are removed", async () => {
  let run = linkDeps();
  const r = await onboard.handleOnboarding(linkRequest("upload", { category: "Passport", expiryDate: "2031-01-01", replaces: "" }, new File([PDF_BYTES], "C:\\docs\\passport.pdf")), run.deps);
  assert.equal(r.status, 200);
  assert.deepEqual(run.names().filter((n) => n !== "limit"), ["hr_svc_upload_target", "upload", "hr_svc_document_add", "remove"]);
  assert.deepEqual(run.calls.find(([n]) => n === "upload")![1], { p: "p-1/passport/rnd.pdf", type: "application/pdf", size: PDF_BYTES.length });
  const added = run.calls.find(([n]) => n === "hr_svc_document_add")![1] as Record<string, unknown>;
  assert.deepEqual([added.p_path, added.p_filename, added.p_mime, added.p_expiry], ["p-1/passport/rnd.pdf", "passport.pdf", "application/pdf", "2031-01-01"]);
  assert.deepEqual(run.calls.at(-1), ["remove", ["p-1/passport/old.pdf"]], "the replaced file is deleted");
  assert.deepEqual(run.scheduled, ["Passport"], "a passport is read");

  run = linkDeps();
  await onboard.handleOnboarding(linkRequest("upload", { category: "Academic" }, new File([PNG_BYTES], "results.png")), run.deps);
  assert.deepEqual(run.scheduled, [], "academic results are not read automatically");

  for (const [label, file] of [["exe renamed", new File([new Uint8Array([0x4d, 0x5a, 1, 2])], "p.pdf")], ["png named pdf", new File([PNG_BYTES], "p.pdf")], ["gif", new File([new TextEncoder().encode("GIF89a....")], "p.gif")], ["empty", new File([], "p.pdf")], ["too big", new File([PDF_BYTES, new Uint8Array(onboard.MAX_DOCUMENT_BYTES)], "p.pdf")]] as const) {
    run = linkDeps();
    const bad = await onboard.handleOnboarding(linkRequest("upload", { category: "Passport" }, file), run.deps);
    assert.equal(bad.status, 400, label);
    assert.ok(!run.names().includes("hr_svc_upload_target") && !run.names().includes("upload"), `${label}: nothing stored`);
  }

  run = linkDeps({ db: { hr_svc_upload_target: { error: { code: "23514", message: "Only a rejected document can be replaced." } } } });
  const refused = await onboard.handleOnboarding(linkRequest("upload", { category: "Visa" }, new File([PDF_BYTES], "v.pdf")), run.deps);
  assert.deepEqual([refused.status, refused.body.error], [400, "Only a rejected document can be replaced."]);
  assert.ok(!run.names().includes("upload"), "a refused type is never stored");

  run = linkDeps({ db: { hr_svc_document_add: { error: { code: "22023", message: "Enter the expiry date of your passport." } } } });
  const noExpiry = await onboard.handleOnboarding(linkRequest("upload", { category: "Passport" }, new File([PDF_BYTES], "p.pdf")), run.deps);
  assert.equal(noExpiry.status, 400);
  assert.deepEqual(run.calls.at(-1), ["remove", ["p-1/passport/rnd.pdf"]], "an unrecorded file is deleted");

  run = linkDeps();
  assert.equal((await onboard.handleOnboarding(linkRequest("upload", { category: "Passport", expiryDate: "next year" }, new File([PDF_BYTES], "p.pdf")), run.deps)).body.field, "expiryDate");
});

test("onboarding: open a file, remove, expiry, re-read and submit go through the link", async () => {
  const id = "0b7b1c1e-0000-4000-8000-000000000001";
  let run = linkDeps();
  assert.deepEqual((await onboard.handleOnboarding(linkRequest("view_url", { id }), run.deps)).body, { url: "signed:p-1/passport/x.pdf:300" }, "a 5-minute signed link");
  run = linkDeps();
  await onboard.handleOnboarding(linkRequest("remove", { id }), run.deps);
  assert.deepEqual(run.calls.at(-1), ["remove", ["p-1/academic/a.pdf"]]);
  run = linkDeps();
  assert.equal((await onboard.handleOnboarding(linkRequest("remove", { id: "not-a-uuid" }), run.deps)).status, 400);
  run = linkDeps();
  assert.equal((await onboard.handleOnboarding(linkRequest("expiry", { id, expiryDate: "2030-02-30x" }), run.deps)).body.field, "expiryDate");
  run = linkDeps({ db: { hr_svc_document_for_extraction: { data: { id, category: "Visa", filename: "v.pdf", mimeType: "application/pdf", storagePath: "p-1/visa/v.pdf" } } } });
  await onboard.handleOnboarding(linkRequest("extract", { id }), run.deps);
  assert.deepEqual(run.scheduled, ["Visa"]);
  run = linkDeps();
  assert.deepEqual((await onboard.handleOnboarding(linkRequest("submit"), run.deps)).body, { view: { view: "hr_svc_onboarding_submit" } });
  const edge = read("supabase/functions/staff-onboarding/index.ts");
  assert.ok(edge.includes('"Referrer-Policy": "no-referrer"') && edge.includes('"Cache-Control": "no-store"'));
  assert.ok(read("supabase/config.toml").includes("[functions.staff-onboarding]\n# Staff onboarding by emailed link") || read("supabase/config.toml").replace(/\r\n/g, "\n").includes("[functions.staff-onboarding]\n# Staff onboarding by emailed link"), "registered in config.toml");
  const browser = read("src/lib/staffOnboardingApi.ts");
  assert.ok(browser.includes('window.location.hash') && browser.includes("history.replaceState"), "the token is read from the fragment and cleared from the address bar");
  assert.ok(read("src/pages/staff/StaffOnboardingPage.tsx").includes('meta.content = "no-referrer"'));
});

/* ------------------------------------------------------------------ HR email (HR-02d) */

const MAIL_ENV = { EF_HR_EMAIL_FROM: "Skyline HR <HR@Example.test>", EF_HR_ADMIN_NOTIFY_TO: "a@example.test, B@example.test,a@example.test", EF_HR_PUBLIC_SITE_URL: "https://skyline-website-cms.vercel.app/" };

test("HR mail configuration: sender, comma-separated admins, public site; problems are named", () => {
  const ok = hrMail.readHrMailConfig(MAIL_ENV);
  assert.deepEqual(ok.from, { name: "Skyline HR", email: "hr@example.test" });
  assert.deepEqual(ok.adminTo, ["a@example.test", "b@example.test"], "trimmed, lower-cased, de-duplicated");
  assert.equal(ok.siteUrl, "https://skyline-website-cms.vercel.app");
  assert.deepEqual(ok.problems, []);
  const bad = hrMail.readHrMailConfig({ EF_HR_EMAIL_FROM: "nope", EF_HR_ADMIN_NOTIFY_TO: "a@example.test, not-an-address", EF_HR_PUBLIC_SITE_URL: "http://evil.example/" });
  assert.deepEqual(bad.problems, ["EF_HR_EMAIL_FROM", "EF_HR_ADMIN_NOTIFY_TO", "EF_HR_PUBLIC_SITE_URL"]);
  assert.equal(hrMail.readHrMailConfig({ ...MAIL_ENV, EF_HR_PUBLIC_SITE_URL: "http://127.0.0.1:57330" }).siteUrl, "http://127.0.0.1:57330", "plain http only for a local site");
  assert.equal(hrMail.linkUrl("https://x.example", "documents", "tok_en-1"), "https://x.example/staff/onboard#t=tok_en-1", "the token travels in the fragment");
});

test("HR mail: the local Postmark mock is only reachable against a local Supabase", async () => {
  const seen: string[] = [];
  const fakeFetch = (async (url: string) => { seen.push(String(url)); return new Response(JSON.stringify({ ErrorCode: 0, MessageID: "abcdef12-3456" }), { status: 200 }); }) as unknown as typeof fetch;
  const on = { EF_NOTIFICATION_EMAIL_ENABLED: "true", EF_POSTMARK_SERVER_TOKEN: "t", EF_POSTMARK_API_URL: "http://host.docker.internal:57390" };
  const message = { deliveryId: "d", from: { name: "n", email: "f@example.test" }, to: "x@example.test", subject: "s", textBody: "b" };
  await hrMail.selectHrMailProvider({ ...on, SUPABASE_URL: "http://kong:8000" }, { fetch: fakeFetch })!.send(message);
  await hrMail.selectHrMailProvider({ ...on, SUPABASE_URL: "https://xcpydisstlvtvcsqnjob.supabase.co" }, { fetch: fakeFetch })!.send(message);
  assert.deepEqual(seen, ["http://host.docker.internal:57390/email", "https://api.postmarkapp.com/email"], "hosted always talks to Postmark itself");
  assert.equal(hrMail.selectHrMailProvider({ SUPABASE_URL: "http://kong:8000" }), null, "sending off without the switches");
});

test("HR mail templates: applicant mail without a link has no URL; links and names are one line; no token in admin mail", () => {
  for (const kind of ["application_received", "already_applied", "rejected"] as const) {
    const m = hrMail.renderHrEmail(kind, { name: "Ann" }, { siteUrl: "https://x.example", profileId: "p-1" })!;
    assert.ok(!/https?:\/\//.test(m.text), `${kind} has no link`);
  }
  const admin = hrMail.renderHrEmail("admin_documents_submitted", { name: "Ann\nBcc: evil@example.test", email: "ann@example.test", reupload: true }, { siteUrl: "https://x.example", profileId: "p-1" })!;
  assert.ok(!admin.subject.includes("\n") && admin.subject.endsWith("has uploaded documents again"));
  assert.ok(admin.text.includes("https://x.example/admin/staff/employees/p-1"));
  const invite = hrMail.renderHrEmail("reupload_invite", { name: "Ann" }, { siteUrl: "https://x.example", link: "https://x.example/staff/onboard#t=abc", expiresAt: "2026-11-23T00:00:00Z", rejected: [{ category: "Passport", note: "Blurry" }] })!;
  assert.ok(invite.text.includes("https://x.example/staff/onboard#t=abc") && invite.text.includes("- Passport: Blurry") && invite.text.includes("do not forward"));
  assert.equal(hrMail.renderHrEmail("document_invite", {}, { siteUrl: null }), null, "a link email needs its link");
});

function outboxPort(rows: Array<Record<string, unknown>>) {
  const results: Array<[number, string, string | undefined, string | undefined]> = [];
  let claimedKinds: readonly string[] = [];
  return {
    results, kinds: () => claimedKinds,
    port: {
      claim: async (kinds: readonly string[]) => { claimedKinds = kinds; return rows as never; },
      result: async (id: number, state: string, messageId?: string, error?: string) => { results.push([id, state, messageId, error]); },
    },
  };
}

test("HR outbox drain: sends, requeues provider hiccups, fails visibly, never resends an unknown outcome, stays queued when off", async () => {
  const config = hrMail.readHrMailConfig(MAIL_ENV);
  const rows = [
    { id: 1, profileId: "p", kind: "application_received", audience: "applicant", to: "ann@example.test", payload: { name: "Ann" }, attempts: 1 },
    { id: 2, profileId: "p", kind: "admin_new_application", audience: "admin", to: null, payload: { name: "Ann", email: "ann@example.test" }, attempts: 1 },
    { id: 3, profileId: "p", kind: "rejected", audience: "applicant", to: "ann@example.test", payload: {}, attempts: 1 },
    { id: 4, profileId: "p", kind: "already_applied", audience: "applicant", to: "ann@example.test", payload: {}, attempts: 1 },
    { id: 5, profileId: "p", kind: "rejected", audience: "applicant", to: "bob@example.test", payload: {}, attempts: 1 },
  ];
  const provider = mailLib.createMockEmailProvider([
    { kind: "accepted", messageId: "msg-00000001" }, { kind: "accepted", messageId: "msg-00000002" }, { kind: "retry", code: "rate_limit" },
    { kind: "failed", code: "inactive_recipient" }, { kind: "unknown", code: "timeout" },
  ]);
  const out = outboxPort(rows);
  const totals = await hrMail.drainHrEmails(out.port, provider, config);
  assert.deepEqual(totals, { sent: 2, failed: 2, requeued: 1 });
  assert.deepEqual(out.kinds(), [...hrMail.DRAINABLE_KINDS], "only kinds with templates are claimed");
  assert.deepEqual(out.results.map(([id, state]) => `${id}:${state}`), ["1:sent", "2:sent", "3:queued", "4:failed", "5:failed"]);
  assert.match(out.results[4][3] ?? "", /may have been delivered/, "an unknown outcome is failed (admin decides), never resent automatically");
  assert.equal(provider.sent[1].to, "a@example.test, b@example.test", "admin mail goes to every EF_HR_ADMIN_NOTIFY_TO address");
  assert.equal(provider.sent[0].from.email, "hr@example.test");
  const off = outboxPort(rows);
  assert.deepEqual(await hrMail.drainHrEmails(off.port, null, config), { sent: 0, failed: 0, requeued: 0 });
  assert.deepEqual(off.kinds(), [], "switched off: nothing is claimed, the rows stay queued");
  const noAdmins = outboxPort([rows[1]]);
  await hrMail.drainHrEmails(noAdmins.port, provider, hrMail.readHrMailConfig({ ...MAIL_ENV, EF_HR_ADMIN_NOTIFY_TO: "" }));
  assert.deepEqual(noAdmins.results[0].slice(1, 2).concat(noAdmins.results[0][3]!), ["failed", "EF_HR_ADMIN_NOTIFY_TO is not set"], "a missing admin list is a visible failure");
});

function adminDeps(options: { send?: "sent" | "failed" | "skipped"; db?: Record<string, { data?: unknown; error?: { code?: string; message?: string } }>; siteUrl?: string | null; file?: { name: string; bytes: Uint8Array } | null; inspect?: { ok: boolean; pages?: number; error?: string }; login?: { id: string; confirmed: boolean; invited: boolean; signedIn: boolean } | null; inviteError?: string } = {}) {
  const calls: Array<[string, unknown]> = [];
  const mails: Array<Record<string, unknown>> = [];
  let drains = 0;
  const deps = {
    adminRpc: async (name: string, args: Record<string, unknown>) => {
      calls.push([`admin:${name}`, args]);
      const a = options.db?.[name];
      if (a) return { data: a.data ?? null, error: a.error ?? null };
      if (name === "hr_admin_staff_invite") return { data: { invite: { id: "inv-1", expiresAt: "2026-11-23T00:00:00Z" }, email: "ann@example.test", name: "Ann", rejected: [] }, error: null };
      return { data: { detail: name }, error: null };
    },
    serviceRpc: async (name: string, args: Record<string, unknown>) => { calls.push([`svc:${name}`, args]); return { data: 1, error: null }; },
    newLink: async () => ({ token: "T".repeat(43), hash: "h".repeat(64) }),
    config: { ...hrMail.readHrMailConfig(MAIL_ENV), siteUrl: options.siteUrl === undefined ? "https://x.example" : options.siteUrl },
    sendLink: async (mail: Record<string, unknown>) => { mails.push(mail); return options.send === "failed" ? { state: "failed" as const, error: "inactive_recipient" } : options.send === "skipped" ? { state: "skipped" as const, error: "off" } : { state: "sent" as const, messageId: "m-1" }; },
    linkUrl: (purpose: "documents" | "reupload" | "offer", token: string) => hrMail.linkUrl("https://x.example", purpose, token),
    drain: async () => { drains++; return { sent: 0, failed: 0, requeued: 0 }; },
    file: options.file ?? null,
    inspectOffer: async (bytes: Uint8Array) => (options.inspect ?? { ok: true as const, pages: 2 }) as { ok: true; pages: number } | { ok: false; error: string },
    upload: async (p: string, bytes: Uint8Array) => { calls.push(["upload", { p, size: bytes.length }]); return { error: null }; },
    remove: async (paths: string[]) => { calls.push(["remove", paths]); },
    sha256: async (bytes: Uint8Array) => "f".repeat(64),
    newId: () => "rnd",
    findLogin: async (email: string) => { calls.push(["findLogin", email]); return { login: options.login ?? null, error: null }; },
    inviteLogin: async (email: string, name: string, redirectTo: string) => { calls.push(["invite", { email, name, redirectTo }]); return options.inviteError ? { userId: null, error: options.inviteError } : { userId: "new-login", error: null }; },
  };
  return { deps, calls, mails, drains: () => drains, names: () => calls.map(([n]) => n) };
}
const PROFILE = "0b7b1c1e-0000-4000-8000-0000000000aa";

test("staff-admin invite: only the hash goes to the database, the link only into the email, the log has neither", async () => {
  const run = adminDeps();
  const r = await staffAdmin.handleAdmin({ action: "send_invite", profileId: PROFILE, purpose: "documents" }, run.deps);
  assert.deepEqual(r, { status: 200, body: { emailSent: true, expiresAt: "2026-11-23T00:00:00Z", profileId: PROFILE } });
  assert.deepEqual(run.names(), ["admin:hr_admin_staff_invite", "svc:hr_svc_email_log"]);
  assert.equal((run.calls[0][1] as Record<string, unknown>).p_token_hash, "h".repeat(64));
  assert.equal(run.mails[0].link, `https://x.example/staff/onboard#t=${"T".repeat(43)}`);
  const logged = JSON.stringify(run.calls[1][1]);
  assert.ok(!logged.includes("T".repeat(43)) && !logged.includes("#t="), "the log never holds the token or the link");
  assert.ok(!JSON.stringify(r.body).includes("T".repeat(43)), "nor does the answer when the email was sent");
});

test("staff-admin invite: a failed send cancels that link (no valid link nobody received) and tells the admin", async () => {
  const run = adminDeps({ send: "failed" });
  const r = await staffAdmin.handleAdmin({ action: "send_invite", profileId: PROFILE, purpose: "reupload" }, run.deps);
  assert.equal(r.status, 502);
  assert.equal(r.body.emailSent, false);
  assert.match(String(r.body.error), /could not be sent \(inactive_recipient\).*cancelled.*Send again/);
  assert.deepEqual(run.names(), ["admin:hr_admin_staff_invite", "svc:hr_svc_email_log", "admin:hr_admin_staff_invite_cancel"]);
  assert.deepEqual(run.calls[2][1], { p_id: PROFILE, p_invite: "inv-1" }, "exactly the link that was just made");
  assert.equal((run.calls[1][1] as Record<string, unknown>).p_state, "failed", "the failure is logged for the admin");
});

test("staff-admin invite: sending off hands the link to the admin once; missing site URL and non-admins are refused", async () => {
  let run = adminDeps({ send: "skipped" });
  const r = await staffAdmin.handleAdmin({ action: "send_invite", profileId: PROFILE, purpose: "documents" }, run.deps);
  assert.deepEqual([r.status, r.body.emailSent, r.body.link], [200, false, `https://x.example/staff/onboard#t=${"T".repeat(43)}`]);
  assert.ok(!run.names().includes("admin:hr_admin_staff_invite_cancel"), "the link stays valid: the admin passes it on");
  // Shown once, never stored or logged: the token reaches no database call (only its hash does), the email log row says
  // "skipped" without the link, and neither staff-admin nor the mail module writes to the console.
  const token = "T".repeat(43);
  assert.ok(run.calls.every(([, args]) => !JSON.stringify(args).includes(token) && !JSON.stringify(args).includes("#t=")), "no database call carries the token or link");
  assert.deepEqual(run.calls.find(([n]) => n === "admin:hr_admin_staff_invite")?.[1], { p_id: PROFILE, p_purpose: "documents", p_token_hash: "h".repeat(64) });
  assert.equal((run.calls.find(([n]) => n === "svc:hr_svc_email_log")?.[1] as Record<string, unknown>).p_state, "skipped");
  for (const file of ["supabase/functions/staff-admin/core.ts", "supabase/functions/staff-admin/index.ts", "supabase/functions/_shared/hr-mail.ts", "supabase/functions/_shared/hr-mail-drain.ts"]) {
    assert.ok(!/console\.|localStorage|sessionStorage/.test(read(file)), `${file} never logs or keeps the link`);
  }
  assert.match(read("supabase/functions/staff-admin/index.ts"), /"Cache-Control": "no-store"/, "the answer holding the link is never cached");
  // Asking again makes a NEW link and replaces the shown one (the database supersedes it): it is never shown a second time.
  const again = await staffAdmin.handleAdmin({ action: "send_invite", profileId: PROFILE, purpose: "documents" }, run.deps);
  assert.equal(again.status, 200);
  assert.equal(run.names().filter((n) => n === "admin:hr_admin_staff_invite").length, 2, "each display is its own new link");
  run = adminDeps({ siteUrl: null });
  assert.equal((await staffAdmin.handleAdmin({ action: "send_invite", profileId: PROFILE, purpose: "documents" }, run.deps)).status, 503);
  assert.deepEqual(run.names(), [], "no link is made when it could not be addressed");
  run = adminDeps({ db: { hr_admin_staff_invite: { error: { code: "42501", message: "Only an administrator can do this." } } } });
  const denied = await staffAdmin.handleAdmin({ action: "send_invite", profileId: PROFILE, purpose: "documents" }, run.deps);
  assert.deepEqual([denied.status, run.mails.length], [403, 0]);
  for (const body of [{ action: "send_invite", profileId: "x", purpose: "documents" }, { action: "send_invite", profileId: PROFILE, purpose: "offer" }, { action: "nuke" }]) {
    assert.equal((await staffAdmin.handleAdmin(body, adminDeps().deps)).status, 400, JSON.stringify(body));
  }
});

test("staff-admin: reject (email by default), retry a failed email, drain; each sends queued mail", async () => {
  let run = adminDeps();
  await staffAdmin.handleAdmin({ action: "reject", profileId: PROFILE, note: "Not suitable" }, run.deps);
  assert.deepEqual(run.calls[0], ["admin:hr_admin_staff_reject", { p_id: PROFILE, p_note: "Not suitable", p_notify: true }]);
  assert.equal(run.drains(), 1);
  run = adminDeps();
  await staffAdmin.handleAdmin({ action: "reject", profileId: PROFILE, note: "Not suitable", notify: false }, run.deps);
  assert.equal((run.calls[0][1] as Record<string, unknown>).p_notify, false, "the checkbox can be unticked");
  assert.equal((await staffAdmin.handleAdmin({ action: "reject", profileId: PROFILE, note: " " }, adminDeps().deps)).status, 400);
  run = adminDeps();
  await staffAdmin.handleAdmin({ action: "retry_email", emailId: 42 }, run.deps);
  assert.deepEqual([run.calls[0], run.drains()], [["admin:hr_admin_staff_email_retry", { p_email: 42 }], 1]);
  run = adminDeps({ db: { hr_admin_staff_list: { error: { code: "42501", message: "Only an administrator can do this." } } } });
  assert.deepEqual([(await staffAdmin.handleAdmin({ action: "drain" }, run.deps)).status, run.drains()], [403, 0], "only an admin can trigger a drain");
});

test("staff-register creates no login and keeps no password code", () => {
  const edge = read("supabase/functions/staff-register/index.ts") + read("supabase/functions/staff-register/core.ts");
  for (const gone of ["auth.signUp(", "signInWithOtp", "passwordProblem", "hr_staff_precheck", "account_type", "sign_up"]) assert.ok(!edge.includes(gone), `${gone} is gone`);
  assert.ok(edge.includes('"Referrer-Policy": "no-referrer"') && edge.includes('"Cache-Control": "no-store"'));
  const browser = read("src/lib/staffApi.ts") + read("src/pages/login/EnrolWizard.tsx");
  for (const gone of ["signUpStaff", "resendStaffConfirmation", "setStaffPassword", "staff-signup-password"]) assert.ok(!browser.includes(gone), `${gone} is gone from the browser`);
  assert.ok(read("src/router/config.tsx").includes('{ path: "/staff/apply", element: <Navigate to="/login?mode=enroll&as=staff" replace /> }'), "old confirmation links land on Enroll now > Staff");
});

/* ------------------------------------------------------------------ documents and submit rules */

const docs = (today: string) => [
  { category: "Passport", expiryDate: "2031-01-01" }, { category: "Visa", expiryDate: "2030-01-01" }, { category: "English", expiryDate: null },
  { category: "Academic", expiryDate: null }, { category: "Academic", expiryDate: null }, { category: "Health Insurance", expiryDate: today },
];
const complete = { firstName: "Tara", lastName: "Trainer", dateOfBirth: "1990-05-06", addressStreet: "1 Example St", addressCountry: "Australia", emergencyName: "Em", emergencyRelationship: "Sibling", emergencyPhone: "+61422333444", isAustralianCitizen: false as boolean | null, documents: docs("2026-11-09") };

test("submit needs citizenship, every required document and current expiry dates", () => {
  const today = "2026-11-09";
  const without = (category: string) => complete.documents.filter((d) => d.category !== category);
  assert.deepEqual(status.submitProblems(complete, today), []);
  assert.deepEqual(status.submitProblems({ ...complete, documents: without("Passport") }, today), ["Upload your passport."]);
  assert.deepEqual(status.submitProblems({ ...complete, documents: without("Visa") }, today), ["Upload your visa."]);
  assert.deepEqual(status.submitProblems({ ...complete, documents: without("English") }, today), ["Upload your English test result."]);
  assert.deepEqual(status.submitProblems({ ...complete, isAustralianCitizen: true, documents: without("Visa").filter((d) => d.category !== "English") }, today), [], "a citizen needs no visa and no English result");
  assert.deepEqual(status.submitProblems({ ...complete, documents: without("Academic") }, today), ["Upload your academic results."]);
  assert.deepEqual(status.submitProblems({ ...complete, documents: without("Health Insurance") }, today), ["Upload your health insurance."]);
  assert.deepEqual(status.submitProblems({ ...complete, documents: docs("2026-11-08") }, today), ["Enter a current expiry date for your health insurance."]);
  assert.deepEqual(status.submitProblems({ ...complete, documents: [...without("English"), { category: "English", expiryDate: "2026-01-01" }] }, today), ["Enter a current expiry date for your English test result."], "an English date is optional, but a past one blocks");
  assert.deepEqual(status.submitProblems({ ...complete, documents: [...complete.documents, { category: "Driving Licence", expiryDate: "2020-01-01" }] }, today), [], "the optional licence never blocks submit");
  assert.ok(status.submitProblems({ ...complete, isAustralianCitizen: null }, today).includes("Tell us whether you are an Australian citizen."));
  assert.ok(!status.submitProblems({ ...complete }, today).some((p) => /role/i.test(p)), "no role is asked of an applicant");
  assert.ok(status.submitProblems({ firstName: "", lastName: "", dateOfBirth: null, addressStreet: "", addressCountry: "", emergencyName: "", emergencyRelationship: "", emergencyPhone: null, isAustralianCitizen: null, documents: [] }, today).length >= 9);
});

test("the document rules match the database", () => {
  const sql = read("supabase/migrations/20261110090000_hr_staff_enrolment_v2.sql");
  assert.deepEqual(status.requiredStaffCategories(true), ["Passport", "Academic", "Health Insurance"], "x/3 for citizens");
  assert.deepEqual(status.requiredStaffCategories(false), ["Passport", "Visa", "English", "Academic", "Health Insurance"], "x/5 for non-citizens");
  assert.deepEqual(status.requiredStaffCategories(null), status.requiredStaffCategories(false), "unanswered counts as a non-citizen");
  assert.ok(sql.includes("array['Passport','Academic','Health Insurance'] else array['Passport','Visa','English','Academic','Health Insurance']"), "the SQL lists the same required types");
  assert.ok(!status.requiredStaffCategories(false).includes("Driving Licence" as never), "the licence is never required");
  assert.ok(sql.includes("check (category in ('Passport','Visa','English','Academic','Driving Licence','Health Insurance'))"), "the allowed list has the six types and no legacy PTE / English Certificate");
  assert.deepEqual([...status.STAFF_DOC_CATEGORIES].sort(), ["Academic", "Driving Licence", "English", "Health Insurance", "Passport", "Visa"]);
  assert.ok(sql.includes("p_category in ('Passport','Visa','Driving Licence','Health Insurance'); $fn$;"), "the SQL requires the same expiry dates");
  assert.ok(sql.includes("p_category in ('Passport','Visa','English','Driving Licence','Health Insurance'); $fn$;"), "the SQL accepts the same expiry dates");
  for (const c of status.STAFF_DOC_CATEGORIES) {
    assert.equal(status.staffDocNeedsExpiry(c), ["Passport", "Visa", "Driving Licence", "Health Insurance"].includes(c), `needs expiry: ${c}`);
    assert.equal(status.staffDocTakesExpiry(c), c !== "Academic", `takes expiry: ${c}`);
  }
  assert.equal(status.staffDocSlug("Health Insurance"), "health-insurance");
  assert.equal(status.staffDocSlug("Driving Licence"), "driving-licence");
  assert.ok(sql.includes("lower(replace(btrim(coalesce(p_category, '')), ' ', '-'))"), "the SQL builds the same folder slug");
  assert.ok(sql.includes("where is_current and category <> 'Academic'"), "only academic results keep several current files");
  assert.ok(sql.includes(`current_date + ${status.EXPIRING_SOON_DAYS}`), "the same expiring-soon window");
  // Every staff type has a wizard screen.
  const config = read("src/pages/agency/lib/wizardConfig.ts");
  const steps = config.slice(config.indexOf("export const STAFF_WIZARD_STEPS"), config.indexOf("export const wizardStepsFor"));
  assert.deepEqual([...steps.matchAll(/category: "([^"]+)"/g)].map((m) => m[1]), [...status.STAFF_DOC_CATEGORIES], "wizard screens in the same order");
});

test("expiry states, the shown document kinds and the checklist", () => {
  const today = "2026-11-09";
  assert.equal(status.expiryState(null, today), "none");
  assert.equal(status.expiryState("2026-11-08", today), "expired");
  assert.equal(status.expiryState("2026-11-09", today), "soon");
  assert.equal(status.expiryState("2026-12-09", today), "soon");
  assert.equal(status.expiryState("2026-12-10", today), "ok");
  // Citizens see passport, academic, the optional licence and health insurance; a visa they uploaded anyway is shown as optional.
  assert.deepEqual(status.staffDocKinds(true).map((k) => `${k.category}:${k.required}`), ["Passport:true", "Academic:true", "Driving Licence:false", "Health Insurance:true"]);
  assert.deepEqual(status.staffDocKinds(true, [{ category: "Visa" }]).map((k) => `${k.category}:${k.required}`), ["Passport:true", "Visa:false", "Academic:true", "Driving Licence:false", "Health Insurance:true"]);
  assert.deepEqual(status.staffDocKinds(false).map((k) => `${k.category}:${k.required}:${k.expiry}`),
    ["Passport:true:required", "Visa:true:required", "English:true:optional", "Academic:true:none", "Driving Licence:false:required", "Health Insurance:true:required"]);
  const list = status.staffChecklist([
    { category: "Passport", status: "approved", expiryDate: "2026-11-20" },
    { category: "Academic", status: "approved", expiryDate: null }, { category: "Academic", status: "rejected", expiryDate: null, reviewNote: "Unreadable" },
    { category: "Driving Licence", status: "pending", expiryDate: "2027-01-01" },
    { category: "Health Insurance", status: "pending", expiryDate: "2027-06-01" },
  ], true, today);
  assert.deepEqual(list.map((i) => [i.kind.category, i.state, i.files, i.expiry]), [["Passport", "approved", 1, "soon"], ["Academic", "rejected", 2, "none"], ["Driving Licence", "pending", 1, "ok"], ["Health Insurance", "pending", 1, "ok"]]);
  assert.deepEqual(list[1].notes, ["Unreadable"]);
  assert.deepEqual(checklistLib.approvedCount(list), { approved: 1, required: 3 }, "x/N counts required types only (the licence is not counted)");
  assert.deepEqual(status.staffChecklist([], false, today).map((i) => i.state).join(","), "missing,missing,missing,missing,missing,missing");
  assert.deepEqual(checklistLib.approvedCount(status.staffChecklist([], false, today)), { approved: 0, required: 5 });
});

test("an applicant can never write review fields or grant themselves access", () => {
  const sql = read("supabase/migrations/20261110090000_hr_staff_enrolment_v2.sql");
  assert.ok(/create policy staff_documents_admin_review on hr\.staff_documents for update to authenticated\s+using \(public\.cms_is_admin\(\) and not exists \(select 1 from hr\.staff_profiles p where p\.id = profile_id and p\.auth_user_id = auth\.uid\(\)\)\)/.test(sql), "only admins pass the review-field policy, never on their own documents");
  const review = sql.slice(sql.indexOf("function public.hr_admin_staff_document_review"));
  assert.ok(/v_admin uuid := hr\.require_admin\(\)/.test(review.slice(0, 300)), "document review checks for an administrator");
  assert.ok(review.includes("'You cannot review your own documents.'"));
  for (const policy of ["staff_documents_owner_insert", "staff_documents_owner_delete", "staff_documents_owner_reupload"]) {
    assert.ok(sql.includes(`drop policy if exists ${policy} on storage.objects;`) && !sql.includes(`create policy ${policy}`), `${policy} is dropped: applicants never write storage directly`);
  }
  const add = sql.slice(sql.indexOf("function public.hr_svc_document_add"));
  assert.ok(add.indexOf("hr.invite_for_write(p_token_hash") > 0 && add.indexOf("hr.invite_for_write(p_token_hash") < add.indexOf("select * into p"), "every applicant write checks the link first");
  assert.ok(add.includes("if not v_fresh and (r.id is null or r.status <> 'rejected')"), "with a re-upload link only a rejected document is replaced");
  assert.ok(/revoke all on function %s from public, anon, authenticated/.test(sql) && sql.includes("grant execute on function %s to service_role"), "link functions are service-role only");
});

/* ------------------------------------------------------------------ roles */

test("only admin and trainer exist, the role is never client-assigned, and only an Admin approval writes one", () => {
  assert.deepEqual([...status.STAFF_ROLES], ["admin", "trainer"]);
  const schema = read("supabase/migrations/20261105180000_hr_staff_schema.sql");
  assert.ok(/grant update \(requested_role\) on hr\.staff_applications/.test(schema), "applicants can only update the requested role");
  assert.ok(!/grant (insert|update|delete)[^;]*hr\.staff_roles[^;]*to authenticated/.test(schema), "no browser write access to hr.staff_roles");
  const rpcs = read("supabase/migrations/20261105190000_hr_staff_rpcs.sql");
  for (const name of ["hr_admin_staff_approve", "hr_admin_staff_reject", "hr_admin_staff_activate", "hr_admin_staff_deactivate", "hr_staff_reopen"]) {
    const start = rpcs.indexOf(`function public.${name}`);
    assert.ok(start > 0 && /hr\.require_admin\(\)/.test(rpcs.slice(start, start + 600)), `${name} checks for an administrator`);
  }
  assert.ok(/'Admin', 'Active'/.test(rpcs) && !/'Trainer'/.test(rpcs), "only an Admin role ever writes cms_users");
});

/* ------------------------------------------------------------------ login routing */

test("staff destinations are added without changing existing routing", () => {
  const cms = { active: true, mustChangePassword: false };
  assert.deepEqual(routing.decideLogin({ cms, portal: "no_access" }), { kind: "go", to: "/admin" });
  assert.deepEqual(routing.decideLogin({ cms: null, portal: "active" }), { kind: "go", to: "/agency" });
  assert.deepEqual(routing.decideLogin({ cms: null, portal: "no_access", staff: "draft" }), { kind: "go", to: "/staff" });
  assert.deepEqual(routing.decideLogin({ cms: null, portal: "no_access", staff: "active" }), { kind: "go", to: "/staff" }, "an active trainer has only the staff page");
  assert.deepEqual(routing.decideLogin({ cms, portal: "no_access", staff: "active" }), { kind: "go", to: "/admin" }, "an active admin goes straight to the CMS");
  assert.deepEqual(routing.decideLogin({ cms: null, portal: "active", staff: "submitted" }), { kind: "choose", options: ["portal", "staff"] });
  assert.equal(routing.decideLogin({ cms: null, portal: "no_access", staff: "none" }).kind, "blocked");
  assert.equal(routing.destinationFor("staff", "/staff/apply"), "/staff/apply");
  assert.equal(routing.destinationFor("staff", "/admin"), "/staff");
});

/* ------------------------------------------------------------------ reading documents */

const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF");
function port(bytes: Uint8Array | null) {
  const calls: Array<{ status: string; extracted: Record<string, string>; error?: string }> = [];
  return { calls, apply: async (s: string, extracted: Record<string, string>, error?: string) => { calls.push({ status: s, extracted, error }); }, download: async () => bytes };
}
const passportDoc = { id: "doc-1", category: "Passport", filename: "passport.pdf", mimeType: "application/pdf" };

test("a passport is read into name, date of birth, document number and expiry", async () => {
  const p = port(PDF);
  const result = await core.runStaffExtraction(passportDoc, mock.createMockProvider(), p);
  assert.equal(result, "done");
  assert.deepEqual(p.calls.map((c) => c.status), ["processing", "done"]);
  const done = p.calls[1].extracted;
  assert.equal(done.first_name, "Asha"); assert.equal(done.last_name, "Testperson"); assert.equal(done.dob, "1999-04-05");
  assert.equal(done.passport_number, "X1234567"); assert.equal(done.passport_expiry, "2031-08-09");
});

test("reading failures are recorded and never stop the form", async () => {
  for (const scenario of ["timeout", "server-error", "malformed", "invalid-file"] as const) {
    const p = port(PDF);
    assert.equal(await core.runStaffExtraction(passportDoc, mock.createMockProvider({ scenario }), p), "failed", scenario);
    assert.equal(p.calls.at(-1)!.status, "failed");
  }
  assert.equal(await core.runStaffExtraction(passportDoc, null, port(PDF)), "unavailable", "no provider configured");
  assert.equal(await core.runStaffExtraction(passportDoc, mock.createMockProvider(), port(null)), "failed", "file missing");
  assert.equal(await core.runStaffExtraction(passportDoc, mock.createMockProvider(), port(new TextEncoder().encode("not a pdf at all"))), "failed", "not a real PDF");
  assert.equal(await core.runStaffExtraction({ ...passportDoc, category: "Resume" }, mock.createMockProvider(), port(PDF)), "failed", "unknown category");
});

test("an empty reading and the wrong kind of document fill nothing", async () => {
  const empty = port(PDF);
  assert.equal(await core.runStaffExtraction(passportDoc, mock.createMockProvider({ scenario: "empty" }), empty), "no_fields");
  assert.deepEqual(empty.calls.at(-1)!.extracted, {});
  const wrong = port(PDF);
  const visa = { id: "doc-2", category: "Visa", filename: "visa.pdf", mimeType: "application/pdf" };
  assert.equal(await core.runStaffExtraction(visa, mock.createMockProvider({ scenario: "foreign-visa-mismatch" }), wrong), "no_fields");
  assert.deepEqual(wrong.calls.at(-1)!.extracted, {});
  assert.match(wrong.calls.at(-1)!.error ?? "", /does not look like/);
});

test("staff reading reuses the shared reader, runs only through the onboarding link, and leaves the student function alone", async () => {
  assert.equal(core.STAFF_READER_CATEGORY["English"], "English Test");
  assert.equal(core.STAFF_READER_CATEGORY["PTE"], undefined, "legacy PTE / English Certificate are gone");
  const index = read("supabase/functions/staff-onboarding/index.ts");
  assert.ok(index.includes("../_shared/document-extraction/select.ts") && !index.includes("portal_claim_document_extraction_job"), "shared adapters, no student queue");
  assert.ok(!existsSync("supabase/functions/staff-document-extract"), "the standalone staff-document-extract function is deleted (HR-02d2)");
  assert.ok(!read("supabase/config.toml").includes("staff-document-extract"));
  // The lab-only OpenAI redirect works only against a local Supabase URL.
  const seen: string[] = [];
  const spy = (async (u: string | URL | Request) => { seen.push(String(u)); return new Response("{}"); }) as typeof fetch;
  await core.readerFetch({ SUPABASE_URL: "http://kong:8000", EF_OPENAI_API_URL: "http://host.docker.internal:1/" }, spy)("https://api.openai.com/v1/responses");
  await core.readerFetch({ SUPABASE_URL: "https://xcpydisstlvtvcsqnjob.supabase.co", EF_OPENAI_API_URL: "http://host.docker.internal:1" }, spy)("https://api.openai.com/v1/responses");
  await core.readerFetch({ SUPABASE_URL: "http://kong:8000" }, spy)("https://api.openai.com/v1/responses");
  assert.deepEqual(seen, ["http://host.docker.internal:1/v1/responses", "https://api.openai.com/v1/responses", "https://api.openai.com/v1/responses"]);
});

test("the Employees tabs cover every reviewed status once and match the database filter", () => {
  const tabs = status.EMPLOYEE_TABS;
  assert.deepEqual(tabs.map((t) => t.id), ["applications", "invited", "documents", "offers", "active", "closed"]);
  assert.deepEqual([...tabs[0].statuses], ["applied"]);
  assert.deepEqual([...tabs[3].statuses], ["offer_sent", "offer_signed"]);
  assert.deepEqual([...tabs[5].statuses], ["rejected", "inactive"]);
  const all = tabs.flatMap((t) => [...t.statuses]);
  assert.equal(new Set(all).size, all.length, "no status is in two tabs");
  assert.deepEqual(status.STAFF_STATUSES.filter((s) => !all.includes(s)), [], "every status is in a tab");
  assert.deepEqual(tabs.filter((t) => t.countBadge).map((t) => t.id), ["applications", "documents", "offers"]);
  assert.equal(status.employeeTab("bogus").id, "applications");
  const sql = read("supabase/migrations/20261110090000_hr_staff_enrolment_v2.sql");
  const fn = sql.slice(sql.indexOf("create or replace function public.hr_admin_staff_list"));
  assert.ok(fn.indexOf("perform hr.require_admin();") > 0 && fn.indexOf("perform hr.require_admin();") < fn.indexOf("select count(*)"), "the admin check runs before any read");
  assert.ok(fn.includes("s is null or s not in ('applied','invited','documents_submitted','offer_sent','offer_signed','active','rejected','inactive')"), "every p_statuses value is validated");
  assert.ok(sql.includes("drop function if exists public.hr_admin_staff_list(text, text, integer, integer);"), "no ambiguous overload is left behind");
});

/* ------------------------------------------------------------------ HR-02e offers */

async function makePdf(pages = 2): Promise<Uint8Array> {
  const doc = await PdfLib.PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage().drawText(`Offer page ${i + 1}`, { x: 50, y: 700 });
  return await doc.save({ useObjectStreams: false });
}
/** A PDF whose trailer declares encryption (what a password-protected export looks like to pdf-lib). */
async function encryptedPdf(): Promise<Uint8Array> {
  const text = new TextDecoder("latin1").decode(await makePdf(1));
  const marked = text.replace(/trailer\s*<</, "trailer\n<< /Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>");
  assert.notEqual(marked, text, "fixture: the trailer was found");
  return Uint8Array.from(marked, (c) => c.charCodeAt(0));
}

test("offer PDF: a real PDF passes (pdf-lib loads AND modifies it); encrypted, fake, empty and oversized files are refused clearly", async () => {
  assert.deepEqual(await offerPdf.inspectOfferPdf(PdfLib, await makePdf(3)), { ok: true, pages: 3 });
  assert.deepEqual(await offerPdf.inspectOfferPdf(PdfLib, await encryptedPdf()), { ok: false, error: offerPdf.OFFER_ENCRYPTED });
  assert.match(offerPdf.OFFER_ENCRYPTED, /password-protected or encrypted/);
  assert.equal((await offerPdf.inspectOfferPdf(PdfLib, new TextEncoder().encode("MZ not a pdf"))).ok, false);
  assert.equal((await offerPdf.inspectOfferPdf(PdfLib, new TextEncoder().encode("%PDF-1.7\n garbage with no objects"))).ok, false, "a file that only starts like a PDF is refused");
  assert.equal((await offerPdf.inspectOfferPdf(PdfLib, new Uint8Array(0))).ok, false);
  assert.equal((await offerPdf.inspectOfferPdf(PdfLib, new Uint8Array(offerPdf.MAX_OFFER_BYTES + 1))).ok, false, "over 7 MB (it is emailed back signed)");
});

test("offer PDF: signing keeps every original page and adds one signature page", async () => {
  const signed = await offerPdf.stampSignedOffer(PdfLib, await makePdf(2), { signerName: "Ann Ápplicant", signedAt: "2026-11-09T10:00:00.000Z", ip: "203.0.113.5",
    userAgent: "Mozilla/5.0 (Windows NT 10.0) ".repeat(8), consent: offerPdf.OFFER_CONSENT, offerFilename: "offer.pdf", offerSha256: "ab".repeat(32) });
  const doc = await PdfLib.PDFDocument.load(signed);
  assert.equal(doc.getPageCount(), 3, "2 original pages + the signature page");
  assert.match(doc.getSubject() ?? "", /signed by Ann Applicant/, "accents are made PDF-safe");
});

test("staff-admin offer upload: admin and state first, PDF checked before storage, recorded with its sha256, replaced unsent offer deleted", async () => {
  const file = { name: "Offer Letter.pdf", bytes: new Uint8Array(100) };
  const detail = { hr_admin_staff_detail: { data: { profile: { status: "documents_submitted" } } }, hr_admin_staff_offer_add: { data: { offer: { id: "o-1" }, replacedPath: `${PROFILE}/offer/old.pdf` } } };
  let run = adminDeps({ file, db: detail });
  let r = await staffAdmin.handleAdmin({ action: "offer_upload", profileId: PROFILE }, run.deps);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(run.names(), ["admin:hr_admin_staff_detail", "upload", "admin:hr_admin_staff_offer_add", "remove"]);
  assert.deepEqual(run.calls[2][1], { p_id: PROFILE, p_path: `${PROFILE}/offer/rnd.pdf`, p_filename: "Offer Letter.pdf", p_size: 100, p_sha256: "f".repeat(64) });
  assert.deepEqual(run.calls[3][1], [`${PROFILE}/offer/old.pdf`], "the unsent offer it replaces is deleted");

  run = adminDeps({ file, db: detail, inspect: { ok: false, error: offerPdf.OFFER_ENCRYPTED } });
  r = await staffAdmin.handleAdmin({ action: "offer_upload", profileId: PROFILE }, run.deps);
  assert.deepEqual([r.status, r.body.error, r.body.field], [400, offerPdf.OFFER_ENCRYPTED, "file"], "the admin is told why");
  assert.ok(!run.names().includes("upload"), "nothing is stored");

  run = adminDeps({ file, db: { hr_admin_staff_detail: { data: { profile: { status: "invited" } } } } });
  assert.equal((await staffAdmin.handleAdmin({ action: "offer_upload", profileId: PROFILE }, run.deps)).status, 400);
  assert.ok(!run.names().includes("upload"), "wrong state: nothing stored");
  run = adminDeps({ file, db: { hr_admin_staff_detail: { error: { code: "42501", message: "Only an administrator can do this." } } } });
  assert.equal((await staffAdmin.handleAdmin({ action: "offer_upload", profileId: PROFILE }, run.deps)).status, 403);
  assert.ok(!run.names().includes("upload"), "non-admin: nothing stored");
  run = adminDeps({ file, db: { ...detail, hr_admin_staff_offer_add: { error: { code: "23514", message: "Upload an offer once the documents are submitted (withdraw a sent offer first)." } } } });
  assert.equal((await staffAdmin.handleAdmin({ action: "offer_upload", profileId: PROFILE }, run.deps)).status, 400);
  assert.deepEqual(run.calls.at(-1), ["remove", [`${PROFILE}/offer/rnd.pdf`]], "a refused record removes the stored file");
  assert.equal((await staffAdmin.handleAdmin({ action: "offer_upload", profileId: PROFILE }, adminDeps().deps)).status, 400, "no file");
  assert.equal(staffAdmin.offerName("C:\\x\\letter"), "letter.pdf");
});

test("staff-admin offer send/withdraw: the offer link follows the link rules (hash only, failed send cancels it); withdraw needs a note", async () => {
  const sent = { hr_admin_staff_offer_send: { data: { invite: { id: "inv-9", expiresAt: "2026-12-09T00:00:00Z" }, email: "ann@example.test", name: "Ann" } } };
  let run = adminDeps({ db: sent });
  let r = await staffAdmin.handleAdmin({ action: "offer_send", profileId: PROFILE }, run.deps);
  assert.equal(r.status, 200);
  assert.deepEqual(run.calls[0], ["admin:hr_admin_staff_offer_send", { p_id: PROFILE, p_token_hash: "h".repeat(64) }]);
  assert.equal(run.mails[0].kind, "offer");
  assert.equal(run.mails[0].link, `https://x.example/staff/offer#t=${"T".repeat(43)}`);
  assert.ok(!JSON.stringify(run.calls).includes("T".repeat(43)), "the token reaches no database call");
  run = adminDeps({ db: sent, send: "failed" });
  r = await staffAdmin.handleAdmin({ action: "offer_send", profileId: PROFILE }, run.deps);
  assert.equal(r.status, 502);
  assert.deepEqual(run.calls.at(-1), ["admin:hr_admin_staff_invite_cancel", { p_id: PROFILE, p_invite: "inv-9" }], "the offer link nobody received is cancelled");
  run = adminDeps();
  assert.equal((await staffAdmin.handleAdmin({ action: "offer_withdraw", profileId: PROFILE, note: " " }, run.deps)).status, 400);
  assert.equal((await staffAdmin.handleAdmin({ action: "offer_withdraw", profileId: PROFILE, note: "Role filled" }, run.deps)).status, 200);
  assert.deepEqual(run.calls.at(-1), ["admin:hr_admin_staff_offer_withdraw", { p_id: PROFILE, p_note: "Role filled" }]);
  const mail = hrMail.renderHrEmail("offer", { name: "Ann" }, { siteUrl: "https://x.example", link: "https://x.example/staff/offer#t=abc", expiresAt: "2026-12-09T00:00:00Z" });
  assert.match(mail?.text ?? "", /staff\/offer#t=abc/);
  assert.equal(hrMail.renderHrEmail("offer", {}, { siteUrl: "https://x.example" }), null, "no offer email without its link");
});

test("onboarding offer sign: link-checked, the stored offer must match its upload hash, signed copy is a new file recorded with its own hash", async () => {
  const file = { hr_svc_offer_file: { data: { profileId: "p-1", offerId: "o-1", path: "p-1/offer/o.pdf", sha256: "sha(3)", filename: "offer.pdf" } } };
  let run = linkDeps({ db: { ...file, hr_svc_offer_sign: { data: { readOnly: true } } } });
  const req = { action: "offer_sign", token: LINK, ip: "203.0.113.5", userAgent: "UA-1", fields: { name: "  Ann   Applicant ", consent: true } };
  let r = await onboard.handleOnboarding(req, run.deps);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(run.names().filter((n) => n !== "limit"), ["hr_svc_offer_file", "download", "stamp", "upload", "hr_svc_offer_sign"]);
  const stamp = run.calls.find(([n]) => n === "stamp")![1] as Record<string, unknown>;
  assert.deepEqual([stamp.signerName, stamp.ip, stamp.userAgent, stamp.consent, stamp.offerSha256, stamp.signedAt], ["Ann Applicant", "203.0.113.5", "UA-1", offerPdf.OFFER_CONSENT, "sha(3)", "2026-11-09T10:00:00.000Z"]);
  assert.deepEqual(run.calls.find(([n]) => n === "hr_svc_offer_sign")![1], { p_token_hash: `h(${LINK})`, p_offer: "o-1", p_signer_name: "Ann Applicant", p_consent_text: offerPdf.OFFER_CONSENT,
    p_ip: "203.0.113.5", p_user_agent: "UA-1", p_signed_path: "p-1/offer/signed-rnd.pdf", p_signed_sha256: "sha(8)" });
  assert.equal(r.body.consent, offerPdf.OFFER_CONSENT, "the page shows the exact wording that is stored");

  for (const fields of [{ name: "", consent: true }, { name: "Ann", consent: "yes" }, { name: "<b>Ann</b>", consent: true }]) {
    run = linkDeps({ db: file });
    assert.equal((await onboard.handleOnboarding({ ...req, fields }, run.deps)).status, 400, JSON.stringify(fields));
    assert.ok(!run.names().includes("hr_svc_offer_file"), "nothing is read before the form is valid");
  }
  run = linkDeps({ db: file, original: new Uint8Array(4) });
  assert.equal((await onboard.handleOnboarding(req, run.deps)).status, 500, "a stored offer that differs from the uploaded one is never signed");
  assert.ok(!run.names().includes("upload"));
  run = linkDeps({ db: file, stampFails: true });
  assert.equal((await onboard.handleOnboarding(req, run.deps)).status, 500);
  assert.ok(!run.names().includes("upload"));
  run = linkDeps({ db: { ...file, hr_svc_offer_sign: { error: { code: "23514", message: "This offer can no longer be signed." } } } });
  assert.equal((await onboard.handleOnboarding(req, run.deps)).status, 400);
  assert.deepEqual(run.calls.at(-1), ["remove", ["p-1/offer/signed-rnd.pdf"]], "a refused signature removes the signed file");
  run = linkDeps({ db: { hr_svc_offer_file: { error: { code: "28000", message: "x" } } } });
  r = await onboard.handleOnboarding(req, run.deps);
  assert.deepEqual([r.status, r.body.code], [403, "link_invalid"], "a document link, a revoked or expired offer link: the neutral answer");
});

test("onboarding offer view: 5-minute signed URL for the offer or (after signing) the signed copy", async () => {
  const run = linkDeps({ db: { hr_svc_offer_path: { data: "p-1/offer/signed-x.pdf" } } });
  const r = await onboard.handleOnboarding(linkRequest("offer_view_url", { which: "signed" }), run.deps);
  assert.deepEqual(r.body, { url: "signed:p-1/offer/signed-x.pdf:300" });
  assert.deepEqual(run.calls.find(([n]) => n === "hr_svc_offer_path")![1], { p_token_hash: `h(${LINK})`, p_which: "signed" });
});

test("HR outbox: signed-offer emails go out only with the signed PDF attached, to the applicant and to HR", async () => {
  const config = hrMail.readHrMailConfig(MAIL_ENV);
  const rows = [
    { id: 1, profileId: "p", kind: "signed_offer", audience: "applicant", to: "ann@example.test", payload: { name: "Ann", offerId: "o-1" }, attempts: 1 },
    { id: 2, profileId: "p", kind: "admin_offer_signed", audience: "admin", to: null, payload: { name: "Ann", email: "ann@example.test", offerId: "o-1" }, attempts: 1 },
    { id: 3, profileId: "p", kind: "signed_offer", audience: "applicant", to: "bob@example.test", payload: { name: "Bob", offerId: "o-2" }, attempts: 1 },
  ];
  const provider = mailLib.createMockEmailProvider([{ kind: "accepted", messageId: "m" }]);
  const out = outboxPort(rows);
  const port = { ...out.port, attachment: async (row: { payload: Record<string, unknown> }) => (row.payload.offerId === "o-1" ? { name: "offer-signed.pdf", contentType: "application/pdf", contentBase64: "JVBERi0=" } : null) };
  await hrMail.drainHrEmails(port as never, provider, config);
  assert.deepEqual(out.results.map(([id, state]) => `${id}:${state}`), ["1:sent", "2:sent", "3:failed"]);
  assert.equal(provider.sent.length, 2);
  assert.ok(provider.sent.every((m) => m.attachments?.[0]?.name === "offer-signed.pdf" && m.attachments[0].contentType === "application/pdf"));
  assert.equal(provider.sent[1].to, "a@example.test, b@example.test", "HR gets the signed copy");
  assert.match(out.results[2][3] ?? "", /could not be attached/, "no PDF: not sent, failed for the admin to see");
  assert.equal(drainLib.signedName("Offer Letter.pdf"), "Offer Letter-signed.pdf");
});

/* ------------------------------------------------------------------ HR-02f activation */

test("staff-admin activate: an existing confirmed login is linked and active at once, no invite", async () => {
  const run = adminDeps({ login: { id: "student-login", confirmed: true, invited: false, signedIn: true },
    db: { hr_admin_staff_activate_account: { data: { email: "ann@example.test", name: "Ann", existingLogin: true, activated: true, detail: { d: 1 } } } } });
  const r = await staffAdmin.handleAdmin({ action: "activate", profileId: PROFILE, role: "trainer", joiningDate: "2026-12-01" }, run.deps);
  assert.deepEqual([r.status, r.body.activated, r.body.inviteSent], [200, true, false]);
  assert.deepEqual(run.names(), ["admin:hr_admin_staff_activate_account", "findLogin", "admin:hr_admin_staff_activate_account"], "check, look up, record: no invite");
  assert.deepEqual(run.calls[0][1], { p_id: PROFILE, p_role: "trainer", p_joining_date: "2026-12-01", p_confirm_admin: false, p_auth_user_id: null }, "the first call only checks");
  assert.equal((run.calls[2][1] as Record<string, unknown>).p_auth_user_id, "student-login");
});

test("staff-admin activate: no login gets the Auth invite to /staff/welcome, then the new login is recorded (active after the claim)", async () => {
  const db = { hr_admin_staff_activate_account: { data: { email: "ann@example.test", name: "Ann", existingLogin: false, activated: false, detail: { d: 2 } } } };
  let run = adminDeps({ db });
  let r = await staffAdmin.handleAdmin({ action: "activate", profileId: PROFILE, role: "admin", joiningDate: "2026-12-01", confirmAdmin: true }, run.deps);
  assert.deepEqual([r.status, r.body.activated, r.body.inviteSent], [200, false, true]);
  assert.deepEqual(run.names(), ["admin:hr_admin_staff_activate_account", "findLogin", "invite", "admin:hr_admin_staff_activate_account"]);
  assert.deepEqual(run.calls[2][1], { email: "ann@example.test", name: "Ann", redirectTo: "https://x.example/staff/welcome" });
  assert.deepEqual([(run.calls[3][1] as Record<string, unknown>).p_auth_user_id, (run.calls[3][1] as Record<string, unknown>).p_confirm_admin], ["new-login", true]);

  run = adminDeps({ db, inviteError: "Error sending invite email" });
  r = await staffAdmin.handleAdmin({ action: "activate", profileId: PROFILE, role: "trainer", joiningDate: "2026-12-01" }, run.deps);
  assert.equal(r.status, 502);
  assert.match(String(r.body.error), /Nothing was changed; try again/);
  assert.equal(run.names().filter((n) => n === "admin:hr_admin_staff_activate_account").length, 1, "a failed invite records nothing");

  run = adminDeps({ db, login: { id: "invited-login", confirmed: false, invited: true, signedIn: false } });
  r = await staffAdmin.handleAdmin({ action: "activate", profileId: PROFILE, role: "trainer", joiningDate: "2026-12-01" }, run.deps);
  assert.equal(r.status, 200, "a just-invited, never-used login is invited again (resend)");
  assert.ok(run.names().includes("invite"));

  run = adminDeps({ db, login: { id: "half-signed-up", confirmed: false, invited: false, signedIn: false } });
  r = await staffAdmin.handleAdmin({ action: "activate", profileId: PROFILE, role: "trainer", joiningDate: "2026-12-01" }, run.deps);
  assert.equal(r.status, 400, "an unconfirmed login someone else created is never taken over");
  assert.ok(!run.names().includes("invite"));
});

test("staff-admin activate: role, date and admin rights are checked before any login is touched", async () => {
  for (const body of [{ role: "boss", joiningDate: "2026-12-01" }, { role: "trainer", joiningDate: "01/12/2026" }]) {
    const run = adminDeps();
    assert.equal((await staffAdmin.handleAdmin({ action: "activate", profileId: PROFILE, ...body }, run.deps)).status, 400);
    assert.deepEqual(run.names(), []);
  }
  const run = adminDeps({ db: { hr_admin_staff_activate_account: { error: { code: "42501", message: "Only an administrator can do this." } } } });
  assert.equal((await staffAdmin.handleAdmin({ action: "activate", profileId: PROFILE, role: "trainer", joiningDate: "2026-12-01" }, run.deps)).status, 403);
  assert.deepEqual(run.names(), ["admin:hr_admin_staff_activate_account"], "no Auth lookup or invite for a non-admin");
});

test("activation follow-ups: existing login gets HR's 'access ready' email (no link), the invite is marked staff, an expired invite can be resent", async () => {
  const db = { hr_admin_staff_activate_account: { data: { email: "ann@example.test", name: "Ann", existingLogin: true, activated: true, detail: {} } } };
  let run = adminDeps({ db, login: { id: "student-login", confirmed: true, invited: false, signedIn: true } });
  assert.equal((await staffAdmin.handleAdmin({ action: "activate", profileId: PROFILE, role: "trainer", joiningDate: "2026-12-01" }, run.deps)).status, 200);
  assert.equal(run.drains(), 1, "the queued access-ready email is sent right away");
  const mail = hrMail.renderHrEmail("access_ready", { name: "Ann", email: "ann@example.test", role: "admin" }, { siteUrl: "https://x.example" });
  assert.equal(mail?.subject, "Your Skyline staff access is ready");
  assert.match(mail?.text ?? "", /set up as an Admin/);
  assert.match(mail?.text ?? "", /password you already use \(ann@example\.test\)/);
  assert.ok(!/https?:\/\//.test(mail?.text ?? ""), "no link in it: the person signs in the usual way");
  assert.ok(hrMail.DRAINABLE_KINDS.includes("access_ready"));
  assert.match(read("supabase/functions/staff-admin/index.ts"), /inviteUserByEmail\(email, \{ data: \{ name, account_type: "staff" \}, redirectTo \}\)/, "the shared Invite user template can tell staff apart");

  const waiting = { hr_admin_staff_detail: { data: { profile: { status: "offer_signed" }, application: { account_invited_at: "2026-11-09T00:00:00Z" }, employment: { joiningDate: "2026-12-01" }, roles: [{ role: "trainer", revokedAt: null }] } },
    hr_admin_staff_activate_account: { data: { email: "ann@example.test", name: "Ann", existingLogin: false, activated: false, detail: {} } } };
  run = adminDeps({ db: waiting, login: { id: "invited-login", confirmed: false, invited: true, signedIn: false } });
  const r = await staffAdmin.handleAdmin({ action: "resend_activation", profileId: PROFILE }, run.deps);
  assert.deepEqual([r.status, r.body.inviteSent, r.body.resent], [200, true, true]);
  assert.deepEqual(run.calls.find(([n]) => n === "invite")![1], { email: "ann@example.test", name: "Ann", redirectTo: "https://x.example/staff/welcome" });
  assert.deepEqual([(run.calls[1][1] as Record<string, unknown>).p_role, (run.calls[1][1] as Record<string, unknown>).p_joining_date], ["trainer", "2026-12-01"], "the recorded role and date are reused");
  run = adminDeps({ db: waiting, login: { id: "invited-login", confirmed: false, invited: true, signedIn: true } });
  assert.equal((await staffAdmin.handleAdmin({ action: "resend_activation", profileId: PROFILE }, run.deps)).status, 400, "a login that was already used is never re-invited");
  assert.ok(!run.names().includes("invite"));
  run = adminDeps({ db: { hr_admin_staff_detail: { data: { profile: { status: "active" }, application: { account_invited_at: "x" }, employment: { joiningDate: "2026-12-01" }, roles: [{ role: "trainer", revokedAt: null }] } } } });
  assert.equal((await staffAdmin.handleAdmin({ action: "resend_activation", profileId: PROFILE }, run.deps)).status, 400, "nothing waiting: nothing sent");
  assert.ok(!run.names().includes("invite"));
});

test("retention purge: only the scheduled job may run it; files are deleted before the application is marked; a storage failure is retried next run", async () => {
  const due = { hr_svc_retention_due: { data: [{ profileId: PROFILE, paths: [`${PROFILE}/resume/r.pdf`, `${PROFILE}/passport/p.pdf`, "someone-else/x.pdf"] }] }, hr_svc_retention_mark: { data: true } };
  const removed: string[][] = [];
  const make = (extra: Record<string, unknown>) => { const run = adminDeps(); const svc: Array<[string, unknown]> = [];
    Object.assign(run.deps, { serviceRpc: async (name: string, args: Record<string, unknown>) => { svc.push([name, args]); const a = (due as Record<string, { data: unknown }>)[name]; return { data: a?.data ?? null, error: null }; },
      retentionMonths: 6, purgeFiles: async (paths: string[]) => { removed.push(paths); return { error: null }; } }, extra); return { run, svc }; };
  let { run, svc } = make({ isWorker: false });
  assert.equal((await staffAdmin.handleAdmin({ action: "purge" }, run.deps)).status, 403, "an admin or anyone else cannot purge");
  assert.equal(svc.length, 0);
  ({ run, svc } = make({ isWorker: true }));
  const r = await staffAdmin.handleAdmin({ action: "purge" }, run.deps);
  assert.deepEqual([r.status, r.body.applications, r.body.files], [200, 1, 2]);
  assert.deepEqual(removed.at(-1), [`${PROFILE}/resume/r.pdf`, `${PROFILE}/passport/p.pdf`], "only that person's own folder");
  assert.deepEqual(svc.map(([n]) => n), ["hr_svc_retention_due", "hr_svc_retention_mark"], "files first, then the mark");
  ({ run, svc } = make({ isWorker: true, purgeFiles: async () => ({ error: "storage down" }) }));
  const failed = await staffAdmin.handleAdmin({ action: "purge" }, run.deps);
  assert.deepEqual([failed.status, failed.body.failed], [207, 1]);
  assert.ok(!svc.some(([n]) => n === "hr_svc_retention_mark"), "not marked: the next run tries again");
  const sql = read("supabase/migrations/20261110090000_hr_staff_enrolment_v2.sql");
  assert.ok(sql.includes("cron.schedule('hr-retention-purge', '15 3 * * *', 'select public.hr_retention_dispatch();')") && sql.includes("perform cron.alter_job(v_job, active := false)"), "a daily job, created inactive");
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(sql), "no key in the migration (Vault only)");
  assert.match(read("supabase/functions/staff-admin/index.ts"), /isWorker: body\.action === "purge" && \(await authorizeWorker\(/);
});

/* ------------------------------------------------------------------ HR-02i Careers on the no-login form, Add staff member */

const JOB = "0b7b1c1e-0000-4000-8000-0000000000bb";
test("Careers apply: the job and the cover letter go with the same checks; a cover letter file is checked by content and stored in its own folder", async () => {
  let run = applyDeps({ apply: { ok: true, profileId: "p-1", jobApplicationId: "ja-1" } });
  const cover = new File([PDF_BYTES], "letter.pdf", { type: "application/pdf" });
  let r = await apply.handleApply(applyForm({ jobId: JOB, coverLetter: "I teach.\r\nThanks", coverLetterFile: cover }), { ip: "203.0.113.5" }, run.deps);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const applyArgs = run.calls.find(([n]) => n === "hr_svc_apply")![1] as Record<string, unknown>;
  assert.deepEqual([applyArgs.p_job, applyArgs.p_cover_letter], [JOB, "I teach.\nThanks"]);
  const names = run.calls.map(([n]) => n).filter((n) => n !== "limit");
  assert.deepEqual(names, ["hr_svc_apply", "upload", "hr_svc_apply_resume", "upload", "hr_svc_job_cover_letter"], "resume first, then the cover letter");
  assert.equal((run.calls.filter(([n]) => n === "upload")[1][1] as { p: string }).p, "p-1/cover-letter/rnd.pdf");
  assert.equal((run.calls.find(([n]) => n === "hr_svc_job_cover_letter")![1] as Record<string, unknown>).p_application, "ja-1");

  for (const [overrides, field] of [
    [{ jobId: "not-a-uuid" }, "jobId"],
    [{ coverLetter: "no job" }, "coverLetter"],
    [{ jobId: JOB, coverLetter: "x".repeat(5001) }, "coverLetter"],
    [{ jobId: JOB, coverLetterFile: new File([new Uint8Array([0x4d, 0x5a, 0, 0])], "letter.pdf") }, "coverLetterFile"],
    [{ coverLetterFile: cover }, "coverLetterFile"],
  ] as const) {
    run = applyDeps();
    r = await apply.handleApply(applyForm(overrides as Record<string, string | File>), { ip: "203.0.113.5" }, run.deps);
    assert.deepEqual([r.status, r.body.field], [400, field], JSON.stringify(overrides).slice(0, 80));
    assert.ok(!run.calls.some(([n]) => n === "hr_svc_apply"), "nothing is recorded");
  }
  run = applyDeps({ apply: { ok: false, reason: "job_closed" } });
  r = await apply.handleApply(applyForm({ jobId: JOB }), { ip: "203.0.113.5" }, run.deps);
  assert.deepEqual([r.status, r.body.error], [400, "This job is no longer open."]);
  run = applyDeps({ apply: { ok: false, reason: "exists" } });
  r = await apply.handleApply(applyForm({ jobId: JOB, coverLetterFile: cover }), { ip: "203.0.113.5" }, run.deps);
  assert.equal(r.status, 200, "an existing application: the same thank-you");
  assert.ok(!run.calls.some(([n]) => n === "upload"), "...and nothing is stored");
  assert.equal(apply.MAX_REQUEST_BYTES, 2 * apply.MAX_RESUME_BYTES + 64 * 1024, "room for a resume and a cover letter");
});

test("Add staff member: the record first, then the document link to the new record; refusals pass through", async () => {
  const db = { hr_admin_staff_add: { data: { ok: true, profileId: PROFILE } }, hr_admin_staff_invite: { data: { invite: { id: "inv-a", expiresAt: "2026-11-23T00:00:00Z" }, email: "ada@example.test", name: "Ada" } } };
  let run = adminDeps({ db });
  let r = await staffAdmin.handleAdmin({ action: "add", firstName: "Ada", lastName: "Added", email: "ada@example.test", phone: "+61412345678" }, run.deps);
  assert.deepEqual([r.status, r.body.emailSent, r.body.profileId], [200, true, PROFILE]);
  assert.deepEqual(run.names(), ["admin:hr_admin_staff_add", "admin:hr_admin_staff_invite", "svc:hr_svc_email_log"]);
  assert.deepEqual(run.calls[1][1], { p_id: PROFILE, p_purpose: "documents", p_token_hash: "h".repeat(64) });
  run = adminDeps({ db, send: "failed" });
  r = await staffAdmin.handleAdmin({ action: "add", firstName: "Ada", lastName: "Added", email: "ada@example.test", phone: "+61412345678" }, run.deps);
  assert.deepEqual([r.status, r.body.profileId], [502, PROFILE], "the record stays; the page shows the failed email");
  assert.deepEqual(run.calls.at(-1), ["admin:hr_admin_staff_invite_cancel", { p_id: PROFILE, p_invite: "inv-a" }]);
  run = adminDeps({ db: { hr_admin_staff_add: { error: { code: "23505", message: "This email or mobile already has a staff record. Open it from Employees." } } } });
  r = await staffAdmin.handleAdmin({ action: "add", firstName: "Ada", lastName: "Added", email: "ada@example.test", phone: "+61412345678" }, run.deps);
  assert.deepEqual([r.status, run.names()], [400, ["admin:hr_admin_staff_add"]]);
  const jobs = await load.import<typeof import("../src/lib/jobs.ts")>("../src/lib/jobs.ts");
  assert.deepEqual(jobs.applyProblems({ hasResume: false, coverLetter: "" }), ["Attach your resume."]);
  assert.deepEqual(jobs.applyProblems({ hasResume: true, coverLetter: "" }), [], "the cover letter is optional");
  assert.equal(jobs.jobFileProblem({ name: "old.doc", type: "application/msword", size: 10 }), "Upload a PDF or Word (.docx) file.");
});

/* ------------------------------------------------------------------ HR-02j Candidates: hire and send document link, manual candidate files */

const APP = "0b7b1c1e-0000-4000-8000-0000000000cc";

test("hire: the document link is made for the candidate's person (learned from the database), emailed, logged; a failed email cancels it", async () => {
  const hired = { hr_admin_candidate_hire: { data: { invite: { id: "inv-9", expiresAt: "2026-11-23T00:00:00Z" }, email: "cara@example.test", name: "Cara", rejected: [], profileId: PROFILE, jobTitle: "Trainer" } } };
  let run = adminDeps({ db: hired });
  let r = await staffAdmin.handleAdmin({ action: "hire", applicationId: APP }, run.deps);
  assert.deepEqual([r.status, r.body.emailSent, r.body.profileId], [200, true, PROFILE]);
  assert.deepEqual(run.calls[0], ["admin:hr_admin_candidate_hire", { p_id: APP, p_token_hash: "h".repeat(64) }], "only the hash reaches the database");
  assert.equal((run.calls.find(([n]) => n === "svc:hr_svc_email_log")![1] as Record<string, unknown>).p_profile, PROFILE, "the log belongs to the person the database named");
  assert.equal(run.mails[0].to, "cara@example.test");
  assert.equal((await staffAdmin.handleAdmin({ action: "hire", profileId: PROFILE }, run.deps)).status, 400, "a candidate application id is required");
  run = adminDeps({ db: hired, send: "failed" });
  r = await staffAdmin.handleAdmin({ action: "hire", applicationId: APP }, run.deps);
  assert.equal(r.status, 502);
  assert.deepEqual(run.calls.find(([n]) => n === "admin:hr_admin_staff_invite_cancel")![1], { p_id: PROFILE, p_invite: "inv-9" }, "the link nobody received is cancelled");
  run = adminDeps({ db: { hr_admin_candidate_hire: { error: { code: "23514", message: "Mark the candidate selected before hiring." } } } });
  r = await staffAdmin.handleAdmin({ action: "hire", applicationId: APP }, run.deps);
  assert.deepEqual([r.status, r.body.error], [400, "Mark the candidate selected before hiring."]);
  assert.ok(!run.names().includes("svc:hr_svc_email_log") && run.mails.length === 0, "nothing sent, nothing logged");
});

test("candidate_file: an open manual candidate only, checked by content, stored in the person's folder, recorded as the caller", async () => {
  const open = { hr_admin_candidate: { data: { id: APP, profileId: PROFILE, source: "manual", status: "applied" } }, hr_admin_candidate_file: { data: { ok: true, replacedPath: `${PROFILE}/resume/old.pdf` } } };
  let run = adminDeps({ db: open, file: { name: "fake/path/cv.pdf", bytes: PDF_BYTES } });
  let r = await staffAdmin.handleAdmin({ action: "candidate_file", applicationId: APP, which: "resume" }, run.deps);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((run.calls.find(([n]) => n === "upload")![1] as { p: string }).p, `${PROFILE}/resume/rnd.pdf`);
  assert.deepEqual(run.calls.find(([n]) => n === "admin:hr_admin_candidate_file")![1], { p_application: APP, p_which: "resume", p_path: `${PROFILE}/resume/rnd.pdf`, p_filename: "cv.pdf", p_mime: "application/pdf", p_size: PDF_BYTES.length });
  assert.deepEqual(run.calls.find(([n]) => n === "remove")![1], [`${PROFILE}/resume/old.pdf`], "the replaced file is deleted");
  assert.ok(run.names().indexOf("admin:hr_admin_candidate") < run.names().indexOf("upload"), "the admin and state check comes before any storage write");
  run = adminDeps({ db: open, file: { name: "cv.pdf", bytes: new Uint8Array([0x4d, 0x5a, 0, 1]) } });
  r = await staffAdmin.handleAdmin({ action: "candidate_file", applicationId: APP, which: "cover_letter" }, run.deps);
  assert.equal(r.status, 400);
  assert.ok(!run.names().includes("upload"), "a renamed non-PDF is never stored");
  run = adminDeps({ db: { hr_admin_candidate: { data: { id: APP, profileId: PROFILE, source: "careers", status: "applied" } } }, file: { name: "cv.pdf", bytes: PDF_BYTES } });
  assert.equal((await staffAdmin.handleAdmin({ action: "candidate_file", applicationId: APP, which: "resume" }, run.deps)).status, 400, "a Careers applicant's files are kept");
  assert.ok(!run.names().includes("upload"));
  run = adminDeps({ db: { hr_admin_candidate: { error: { code: "42501", message: "Only an administrator can do this." } } }, file: { name: "cv.pdf", bytes: PDF_BYTES } });
  assert.equal((await staffAdmin.handleAdmin({ action: "candidate_file", applicationId: APP, which: "resume" }, run.deps)).status, 403);
  run = adminDeps({ db: { ...open, hr_admin_candidate_file: { error: { code: "22023", message: "The file location is not valid." } } }, file: { name: "cv.pdf", bytes: PDF_BYTES } });
  r = await staffAdmin.handleAdmin({ action: "candidate_file", applicationId: APP, which: "resume" }, run.deps);
  assert.equal(r.status, 400);
  assert.deepEqual(run.calls.find(([n]) => n === "remove")![1], [`${PROFILE}/resume/rnd.pdf`], "a refused record removes the stored file");
  assert.equal((await staffAdmin.handleAdmin({ action: "candidate_file", applicationId: APP, which: "photo" }, run.deps)).status, 400, "resume or cover letter only");
  assert.equal(staffAdmin.ACTIONS.includes("hire" as never) && staffAdmin.ACTIONS.includes("candidate_file" as never), true);
});

test("jobs and candidates tree: department > job > stage > candidate, and search", async () => {
  const tree = await load.import<typeof import("../src/lib/recruitmentTree.ts")>("../src/lib/recruitmentTree.ts");
  type J = import("../src/lib/jobsApi.ts").AdminJob;
  type C = import("../src/lib/recruitmentApi.ts").CandidateRow;
  const job = (id: string, title: string, department = ""): J =>
    ({ id, title, department, description: "", employmentType: "full_time", salary: "", location: "Melbourne", status: "open", postedAt: "", updatedAt: "", applied: 0, hired: 0, declined: 0 });
  const cand = (id: string, firstName: string, status: C["status"], stage: C["stage"] = "screening"): C =>
    ({ id, profileId: `p-${id}`, jobTitle: "", source: "careers", appliedAt: "2026-11-01T00:00:00Z", status, stage, firstName, lastName: "", email: `${id}@example.test`, phone: "" });
  const jobs = [job("t", "Trainer", "Education"), job("a", "Admissions Officer", "Admissions"), job("c", "Cleaner")];
  const byJob = new Map([["t", [cand("1", "Zoe", "applied", "interview"), cand("2", "Amy", "applied", "interview"), cand("3", "Bob", "hired", "selected"), cand("4", "Cy", "declined")]], ["a", []]]);
  const depts = tree.buildDepartmentTree(jobs, byJob);
  assert.deepEqual(depts.map((d) => d.name), ["Admissions", "Education", "No department"], "departments A-Z, no department last");
  const trainer = depts[1].jobs[0];
  assert.deepEqual(trainer.stages.map((s) => s.key), ["interview", "hired", "declined"], "pipeline order, empty stages left out");
  assert.deepEqual(trainer.stages[0].candidates.map((c) => c.firstName), ["Amy", "Zoe"], "candidates sorted by name");
  assert.equal(trainer.total, 4); assert.equal(trainer.inProgress, 2);
  assert.equal(tree.treeStage(cand("x", "X", "withdrawn", "interview")), "withdrawn", "a closed application sits under how it closed");
  assert.equal(tree.jobBranchMatches(trainer, "zoe"), true, "a candidate match keeps the job");
  assert.equal(tree.jobBranchMatches(trainer, "education"), true);
  assert.equal(tree.jobBranchMatches(depts[0].jobs[0], "zoe"), false);
  assert.ok(read("src/pages/admin/JobsPage.tsx").includes("<RecruitmentTree byDepartment") && read("src/pages/admin/CandidatesPage.tsx").includes("<RecruitmentTree"), "both pages offer the tree view");
});

test("resume autofill reads basic contact details and ignores references", async () => {
  const { resumeContactFromText } = await load.import<typeof import("../src/lib/resumeContact.ts")>("../src/lib/resumeContact.ts");
  assert.deepEqual(resumeContactFromText([
    "Curriculum vitae", "Élodie O’Neill", "Trainer", "Email: ELODIE@EXAMPLE.TEST | Mobile: 0412 345 678",
    "Professional experience", "Contact: references@example.test · 0400 111 222",
  ].join("\n")), { firstName: "Élodie", lastName: "O’Neill", email: "elodie@example.test", phone: "+61412345678" });
  assert.deepEqual(resumeContactFromText("Name: Priya\nEmail: priya@example.test\n+91 98765 43210"),
    { firstName: "Priya", lastName: "", email: "priya@example.test", phone: "+919876543210" });
  assert.deepEqual(resumeContactFromText("Skills\nTrainer"), { email: undefined, phone: undefined });
  const ambiguous = resumeContactFromText("Jane Doe\na@example.test | b@example.test\nMobile: 0412 345 678 / 0400 111 222");
  assert.equal(ambiguous.email, undefined);
  assert.equal(ambiguous.phone, undefined);
});

test("simple employees: validation, file checks, upload path, two statuses", async () => {
  const emp = await load.import<typeof import("../src/lib/employeeRules.ts")>("../src/lib/employeeRules.ts");
  const ok = { firstName: "Mary-Jane", lastName: "O'Neil", email: "mary@example.com", phone: "0412 345 678" };
  assert.deepEqual(emp.employeeProblems(ok), {});
  assert.deepEqual(Object.keys(emp.employeeProblems(emp.EMPTY_EMPLOYEE)).sort(), ["email", "firstName", "lastName", "phone"], "every field is required");
  assert.equal(emp.employeeProblems({ ...ok, firstName: "J0hn" }).firstName, "The first name can only contain letters, spaces, hyphens, apostrophes and full stops.");
  assert.equal(emp.employeeProblems({ ...ok, lastName: "x".repeat(101) }).lastName, "The last name must be 100 characters or fewer.");
  assert.equal(emp.employeeProblems({ ...ok, email: "mary@example" }).email, "Enter a valid email address.");
  assert.ok(emp.employeeProblems({ ...ok, phone: "0412" }).phone?.startsWith("Enter a valid mobile number"));
  assert.deepEqual(emp.employeeProblems({ ...ok, phone: "+64 21 123 4567" }), {}, "an international number is fine");
  assert.equal(emp.employeeFileProblem({ type: "application/pdf", size: 1000, name: "a.pdf" }), null);
  assert.equal(emp.employeeFileProblem({ type: "application/zip", size: 1000, name: "a.zip" }), "Upload a PDF, JPG, PNG or Word file.");
  assert.equal(emp.employeeFileProblem({ type: "image/png", size: emp.EMPLOYEE_DOC_MAX_BYTES + 1, name: "a.png" }), "The file must be 10 MB or smaller.");
  assert.equal(emp.employeeDocPath("abc", "../My Passport (1).pdf", "r1"), "employees/abc/r1-My_Passport_1_.pdf", "the file name cannot leave the employee's folder");
  assert.deepEqual(Object.keys(emp.EMPLOYEE_STATUS_LABEL), ["active", "inactive"], "two statuses only");
  const sql = read("supabase/migrations/20261110170000_hr_employees_simple.sql");
  for (const c of emp.EMPLOYEE_DOC_CATEGORIES) assert.ok(sql.includes(`'${c}'`), `the database accepts ${c}`);
  assert.ok(sql.includes("'Enter a valid email address.'") && sql.includes("drop trigger if exists employment_activation_guard"), "the database validates too and activation needs no login");
  const page = read("src/pages/admin/StaffDetailPage.tsx");
  assert.ok(page.includes("employeeDocumentUrl(") && !/getPublicUrl|\.download\(/.test(page), "files open through signed URLs only");
});
