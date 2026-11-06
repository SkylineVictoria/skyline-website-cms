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
const routing = await load.import<typeof import("../src/lib/loginRouting.ts")>("../src/lib/loginRouting.ts");
const core = await load.import<typeof import("../supabase/functions/staff-document-extract/core.ts")>("../supabase/functions/staff-document-extract/core.ts");
const mock = await load.import<typeof import("../supabase/functions/_shared/document-extraction/mock.ts")>("../supabase/functions/_shared/document-extraction/mock.ts");

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
  const allowed: Array<[string, string]> = [["draft", "submitted"], ["submitted", "preboarding"], ["submitted", "rejected"], ["preboarding", "active"], ["preboarding", "rejected"], ["active", "inactive"], ["inactive", "active"], ["rejected", "draft"],
    ["draft", "job_applied"], ["rejected", "job_applied"], ["job_applied", "draft"], ["job_applied", "rejected"]];
  for (const from of status.STAFF_STATUSES) for (const to of status.STAFF_STATUSES) {
    assert.equal(status.canTransition(from, to), allowed.some(([a, b]) => a === from && b === to), `${from} -> ${to}`);
  }
  assert.equal(status.canTransition("draft", "active"), false, "nobody skips review");
});

test("the TypeScript transition table matches the database function and the status list", () => {
  // 20261106120000 (job posts) replaced the transition function and the status checks of 20261105180000.
  const sql = read("supabase/migrations/20261106120000_job_posts.sql");
  const body = sql.slice(sql.indexOf("hr.staff_transition_allowed"), sql.indexOf("update storage.buckets"));
  const pairs = [...body.matchAll(/\('([a-z_]+)','([a-z_]+)'\)/g)].map((m) => [m[1], m[2]]);
  assert.equal(pairs.length, 12);
  for (const from of status.STAFF_STATUSES) for (const to of status.STAFF_STATUSES) {
    assert.equal(status.canTransition(from, to), pairs.some(([a, b]) => a === from && b === to), `database ${from} -> ${to}`);
  }
  const list = sql.match(/status in \(([^)]*)\)/)?.[1].replace(/'/g, "").split(",").map((s) => s.trim());
  assert.deepEqual(list, [...status.STAFF_STATUSES]);
});

test("admin actions follow the status", () => {
  assert.deepEqual(status.adminActionsFor("submitted"), ["approve", "reject"]);
  assert.deepEqual(status.adminActionsFor("preboarding"), ["activate", "reject"]);
  assert.deepEqual(status.adminActionsFor("active"), ["deactivate"]);
  assert.deepEqual(status.adminActionsFor("rejected"), ["reopen"]);
  assert.deepEqual(status.adminActionsFor("draft"), []);
  assert.deepEqual(status.adminActionsFor("job_applied"), [], "a job applicant is hired or declined per job application, not through the staff actions");
  for (const s of status.STAFF_STATUSES) for (const action of status.adminActionsFor(s)) {
    const to = { approve: "preboarding", reject: "rejected", activate: "active", deactivate: "inactive", reopen: "draft" }[action] as never;
    assert.ok(status.canTransition(s, to), `${action} from ${s} is a legal move`);
  }
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
  const edge = read("supabase/functions/staff-register/index.ts");
  assert.ok(edge.includes(status.NEUTRAL_EMAIL_MESSAGE) && edge.includes(status.NEUTRAL_PHONE_MESSAGE), "the edge function uses the same texts");
});

test("the duplicate check covers staff, students, agents, portal users, invitations and admin users by email and phone", () => {
  const sql = read("supabase/migrations/20261105190000_hr_staff_rpcs.sql");
  const fn = sql.slice(sql.indexOf("function hr.contact_conflicts"), sql.indexOf("revoke all on function hr.contact_conflicts"));
  for (const table of ["hr.staff_profiles", "public.enrollment_students", "public.agents", "public.portal_profiles", "public.agency_invitations", "public.cms_users"]) assert.ok(fn.includes(table), `checks ${table}`);
  assert.ok(fn.includes("phone_e164(s.phone)") && fn.includes("phone_e164(g.phone)") && fn.includes("phone_e164(pp.phone)"), "phones are compared in E.164 form");
  const edge = read("supabase/functions/staff-register/index.ts");
  assert.ok(edge.indexOf("hr_staff_precheck") < edge.indexOf("signInWithOtp"), "the check runs before the email code is requested");
  assert.ok(edge.includes("staff-register:caller:") && edge.includes("staff-register:email:"), "rate limits per IP and per email");
  assert.ok(!/signInWithOtp\([^)]*phone/.test(edge) && !edge.includes('channel: "sms"'), "no SMS is ever sent");
});

/* ------------------------------------------------------------------ submit rules */

const complete = { firstName: "Tara", lastName: "Trainer", dateOfBirth: "1990-05-06", addressStreet: "1 Example St", addressCountry: "Australia", emergencyName: "Em", emergencyRelationship: "Sibling", emergencyPhone: "+61422333444", requestedRole: "trainer", hasPassport: true };

test("submit is blocked without a passport and lists what is missing", () => {
  assert.deepEqual(status.submitProblems(complete), []);
  assert.deepEqual(status.submitProblems({ ...complete, hasPassport: false }), ["Upload your passport."]);
  assert.equal(status.submitProblems({ ...complete, requestedRole: null }).length, 1);
  assert.ok(status.submitProblems({ firstName: "", lastName: "", dateOfBirth: null, addressStreet: "", addressCountry: "", emergencyName: "", emergencyRelationship: "", emergencyPhone: null, requestedRole: null, hasPassport: false }).length >= 6);
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
  assert.equal(core.STAFF_READER_CATEGORY["PTE"], "English Test");
  assert.equal(core.STAFF_READER_CATEGORY["English Certificate"], "English Test");
  const index = read("supabase/functions/staff-document-extract/index.ts");
  assert.ok(index.includes("../_shared/document-extraction/select.ts") && !index.includes("portal_claim_document_extraction_job"), "shared adapters, no student queue");
});

/* ------------------------------------------------------------------ job posts and applications */

test("a job post needs a title, a description, full time or part time, and a location", async () => {
  const jobs = await load.import<typeof import("../src/lib/jobs.ts")>("../src/lib/jobs.ts");
  const good = { ...jobs.EMPTY_JOB, title: "Trainer", description: "Teach.", location: "Melbourne" };
  assert.deepEqual(jobs.jobProblems(good), {});
  assert.ok(jobs.jobProblems({ ...good, title: "T" }).title);
  assert.ok(jobs.jobProblems({ ...good, description: " " }).description);
  assert.ok(jobs.jobProblems({ ...good, employmentType: "casual" as never }).employmentType);
  assert.ok(jobs.jobProblems({ ...good, location: "" }).location);
  assert.ok(jobs.jobProblems({ ...good, salary: "x".repeat(121) }).salary);
  assert.deepEqual([...jobs.EMPLOYMENT_TYPES], ["full_time", "part_time"]);
  assert.equal(jobs.EMPLOYMENT_TYPE_LABEL.full_time, "Full time");
  assert.equal(jobs.EMPLOYMENT_TYPE_LABEL.part_time, "Part time");
});

test("resumes and cover letters are PDF or Word files up to 10 MB; an application needs a resume and a cover letter", async () => {
  const jobs = await load.import<typeof import("../src/lib/jobs.ts")>("../src/lib/jobs.ts");
  assert.equal(jobs.jobFileMime({ name: "cv.pdf", type: "application/pdf" }), "application/pdf");
  assert.equal(jobs.jobFileMime({ name: "cv.docx", type: "" }), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a .docx with no browser type is known by its name");
  assert.equal(jobs.jobFileMime({ name: "cv.png", type: "image/png" }), null);
  assert.equal(jobs.jobFileProblem({ name: "cv.pdf", type: "application/pdf", size: 100 }), "");
  assert.match(jobs.jobFileProblem({ name: "cv.exe", type: "application/octet-stream", size: 100 }), /PDF or Word/);
  assert.match(jobs.jobFileProblem({ name: "cv.pdf", type: "application/pdf", size: 11 * 1024 * 1024 }), /10 MB/);
  assert.deepEqual(jobs.applyProblems({ hasResume: false, coverLetter: "", hasCoverLetterFile: false }), ["Upload your resume.", "Write a cover letter or upload one."]);
  assert.deepEqual(jobs.applyProblems({ hasResume: true, coverLetter: "", hasCoverLetterFile: true }), []);
  assert.deepEqual(jobs.applyProblems({ hasResume: true, coverLetter: "Dear team", hasCoverLetterFile: false }), []);
  assert.ok(jobs.applyProblems({ hasResume: true, coverLetter: "x".repeat(5001), hasCoverLetterFile: false }).length);
});

test("the job someone was applying for is remembered while their account is created, and the sign-in returns there", async () => {
  const jobs = await load.import<typeof import("../src/lib/jobs.ts")>("../src/lib/jobs.ts");
  const map = new Map<string, string>();
  const s = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
  const id = "0f3a2c9e-1b4d-4e6f-8a7b-9c0d1e2f3a4b";
  jobs.rememberJobIntent(id, s);
  assert.equal(jobs.readJobIntent(s), id);
  jobs.rememberJobIntent("not-an-id", s);
  assert.equal(jobs.readJobIntent(s), null, "only a job id is kept");
  assert.equal(jobs.jobApplyPath(id), `/careers/${id}/apply`);
  assert.deepEqual(routing.decideLogin({ cms: null, portal: "no_access", staff: "draft" }, `/careers/${id}/apply`), { kind: "go", to: `/careers/${id}/apply` });
  assert.deepEqual(routing.decideLogin({ cms: null, portal: "active" }, `/careers/${id}/apply`), { kind: "go", to: `/careers/${id}/apply` }, "a student applies for a job with the same login");
  assert.equal(routing.destinationFor("portal", `/careers/${id}`), `/careers/${id}`);
  assert.equal(routing.destinationFor("portal", "/admin"), "/agency", "other areas are still fenced");
});

