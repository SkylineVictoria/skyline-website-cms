import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

// Offline unit tests for staff self-registration: phone normalisation (three twins kept in step), status transitions (kept in step with
// the database), duplicate-check messages, submit rules, login routing and document reading with the deterministic mock provider.
const load = createJiti(import.meta.url, { alias: { "@": path.resolve("src") } });
const phone = await load.import<typeof import("../src/lib/staffPhone.ts")>("../src/lib/staffPhone.ts");
const edgePhone = await load.import<typeof import("../supabase/functions/_shared/staff-phone.ts")>("../supabase/functions/_shared/staff-phone.ts");
const status = await load.import<typeof import("../src/lib/staffStatus.ts")>("../src/lib/staffStatus.ts");
const checklistLib = await load.import<typeof import("../src/lib/documentChecklist.ts")>("../src/lib/documentChecklist.ts");
const routing = await load.import<typeof import("../src/lib/loginRouting.ts")>("../src/lib/loginRouting.ts");
const core = await load.import<typeof import("../supabase/functions/staff-document-extract/core.ts")>("../supabase/functions/staff-document-extract/core.ts");
const mock = await load.import<typeof import("../supabase/functions/_shared/document-extraction/mock.ts")>("../supabase/functions/_shared/document-extraction/mock.ts");
const apply = await load.import<typeof import("../supabase/functions/staff-register/core.ts")>("../supabase/functions/staff-register/core.ts");
const captchaLib = await load.import<typeof import("../supabase/functions/_shared/captcha.ts")>("../supabase/functions/_shared/captcha.ts");

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
    ["active", "inactive"], ["inactive", "active"], ["rejected", "applied"]];
  for (const from of status.STAFF_STATUSES) for (const to of status.STAFF_STATUSES) {
    assert.equal(status.canTransition(from, to), allowed.some(([a, b]) => a === from && b === to), `${from} -> ${to}`);
  }
  assert.equal(status.canTransition("applied", "active"), false, "nobody skips review");
  assert.equal(status.canTransition("invited", "offer_sent"), false, "no offer before the documents are submitted");
});

test("the TypeScript transition table matches the database function and the status list", () => {
  const sql = read("supabase/migrations/20261109100000_hr_staff_documents_review.sql");
  const body = sql.slice(sql.indexOf("function hr.staff_transition_allowed"), sql.indexOf("function hr.staff_status_guard"));
  const pairs = [...body.matchAll(/\('([a-z_]+)','([a-z_]+)'\)/g)].map((m) => [m[1], m[2]]);
  assert.equal(pairs.length, 15);
  for (const from of status.STAFF_STATUSES) for (const to of status.STAFF_STATUSES) {
    assert.equal(status.canTransition(from, to), pairs.some(([a, b]) => a === from && b === to), `database ${from} -> ${to}`);
  }
  const check = sql.slice(sql.indexOf("add constraint staff_profiles_status_check"));
  const list = check.match(/status in \(([^)]*)\)/)?.[1].replace(/'/g, "").split(",").map((s) => s.trim());
  assert.deepEqual(list, [...status.STAFF_STATUSES]);
});

test("admin actions follow the status", () => {
  for (const s of ["applied", "invited", "documents_submitted", "offer_sent", "offer_signed"] as const) assert.deepEqual(status.adminActionsFor(s), ["reject"]);
  assert.deepEqual(status.adminActionsFor("active"), ["deactivate"]);
  assert.deepEqual(status.adminActionsFor("inactive"), ["reactivate"]);
  assert.deepEqual(status.adminActionsFor("rejected"), ["reopen"]);
  for (const s of status.STAFF_STATUSES) for (const action of status.adminActionsFor(s)) {
    const to = { approve: "", reject: "rejected", activate: "active", reactivate: "active", deactivate: "inactive", reopen: "applied" }[action];
    assert.ok(status.canTransition(s, to as never), `${action} from ${s} is a legal move`);
  }
  const sql = read("supabase/migrations/20261109100000_hr_staff_documents_review.sql");
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
  assert.deepEqual(calls[2][1], { p_first_name: "Ann", p_last_name: "Applicant", p_email: "ann@example.test", p_phone: "+61412345678" });
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
const complete = { firstName: "Tara", lastName: "Trainer", dateOfBirth: "1990-05-06", addressStreet: "1 Example St", addressCountry: "Australia", emergencyName: "Em", emergencyRelationship: "Sibling", emergencyPhone: "+61422333444", requestedRole: "trainer", isAustralianCitizen: false as boolean | null, documents: docs("2026-11-09") };

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
  assert.equal(status.submitProblems({ ...complete, requestedRole: null }, today).length, 1);
  assert.ok(status.submitProblems({ firstName: "", lastName: "", dateOfBirth: null, addressStreet: "", addressCountry: "", emergencyName: "", emergencyRelationship: "", emergencyPhone: null, requestedRole: null, isAustralianCitizen: null, documents: [] }, today).length >= 10);
});

test("the document rules match the database", () => {
  const sql = read("supabase/migrations/20261109100000_hr_staff_documents_review.sql");
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
  const sql = read("supabase/migrations/20261109100000_hr_staff_documents_review.sql");
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

test("staff reading reuses the shared reader and leaves the student function byte-for-byte alone", () => {
  assert.equal(core.STAFF_READER_CATEGORY["English"], "English Test");
  assert.equal(core.STAFF_READER_CATEGORY["PTE"], undefined, "legacy PTE / English Certificate are gone");
  const index = read("supabase/functions/staff-document-extract/index.ts");
  assert.ok(index.includes("../_shared/document-extraction/select.ts") && !index.includes("portal_claim_document_extraction_job"), "shared adapters, no student queue");
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
  const sql = read("supabase/migrations/20261109100000_hr_staff_documents_review.sql");
  const fn = sql.slice(sql.indexOf("create or replace function public.hr_admin_staff_list"));
  assert.ok(fn.indexOf("perform hr.require_admin();") > 0 && fn.indexOf("perform hr.require_admin();") < fn.indexOf("select count(*)"), "the admin check runs before any read");
  assert.ok(fn.includes("s is null or s not in ('applied','invited','documents_submitted','offer_sent','offer_signed','active','rejected','inactive')"), "every p_statuses value is validated");
  assert.ok(sql.includes("drop function if exists public.hr_admin_staff_list(text, text, integer, integer);"), "no ambiguous overload is left behind");
});
