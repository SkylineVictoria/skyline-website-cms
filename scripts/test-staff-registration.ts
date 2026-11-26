import { refuseHosted } from "./lab/hosted-guard.mjs";
refuseHosted("test-staff-registration"); // local stack only; --allow-hosted to override (scripts/lab/hosted-guard.mjs)
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
const person = await load.import<typeof import("../supabase/functions/_shared/validation/person.ts")>("../supabase/functions/_shared/validation/person.ts");
const staffRules = await load.import<typeof import("../supabase/functions/_shared/validation/staff-onboarding.ts")>("../supabase/functions/_shared/validation/staff-onboarding.ts");
const wizardLib = await load.import<typeof import("../src/lib/staffOnboardingWizard.ts")>("../src/lib/staffOnboardingWizard.ts");
const enrolLib = await load.import<typeof import("../src/lib/enrolForm.ts")>("../src/lib/enrolForm.ts");
const employeeRulesLib = await load.import<typeof import("../src/lib/employeeRules.ts")>("../src/lib/employeeRules.ts");

const read = (file: string) => readFileSync(path.resolve(file), "utf8");

const signing = await load.import<typeof import("../supabase/functions/_shared/signing.ts")>("../supabase/functions/_shared/signing.ts");
test("signing templates require all variables, reject malformed tokens and substitute once", () => {
  assert.deepEqual(signing.signingVariables("{{full_name}} {{ course }} {{full_name}}"), ["full_name", "course"]);
  assert.equal(signing.fillSigningTemplate("Dear {{full_name}}", { full_name: "{{salary}}" }), "Dear {{salary}}");
  assert.throws(() => signing.fillSigningTemplate("{{course}}", {}), /course/);
  assert.throws(() => signing.fillSigningTemplate("{{course}}", { course: " " }), /course/);
  assert.throws(() => signing.signingVariables("{{Course Name}}"), /variables/);
  assert.throws(() => signing.fillSigningTemplate("{{constructor}}", {}), /constructor/);
  assert.throws(() => signing.fillSigningTemplate("{{course}}", { course: "x".repeat(2001) }), /2,000/);
});
test("signing values are plain text and cannot introduce HTML", () => {
  const text = signing.fillSigningTemplate("Hello {{full_name}}", { full_name: '<script>alert(1)</script>' });
  assert.equal(signing.signingHtml(text), '<p>Hello &lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(signing.signingNameValid("\n"), false);
  assert.equal(signing.signingNameValid("Asha\nPatel"), false);
  assert.equal(signing.signingNameValid("Asha Patel"), true);
});
const signingPdf = await load.import<typeof import("../supabase/functions/_shared/signing-pdf.ts")>("../supabase/functions/_shared/signing-pdf.ts");
const signingCore = await load.import<typeof import("../supabase/functions/document-signing/core.ts")>("../supabase/functions/document-signing/core.ts");
const onboarding = await load.import<typeof import("../supabase/functions/_shared/agent-onboarding.ts")>("../supabase/functions/_shared/agent-onboarding.ts");
const onboardingPdf = await load.import<typeof import("../supabase/functions/_shared/agent-onboarding-pdf.ts")>("../supabase/functions/_shared/agent-onboarding-pdf.ts");
const onboardingFn = await load.import<typeof import("../supabase/functions/document-signing/onboarding.ts")>("../supabase/functions/document-signing/onboarding.ts");
/** Every text item of a PDF with its page and position (pdf.js), to check where a field was printed. */
async function pdfText(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise; const items: Array<{ page: number; text: string; x: number; y: number; w: number; h: number }> = [];
  for (let n = 1; n <= doc.numPages; n++) { const page = await doc.getPage(n); const view = page.getViewport({ scale: 1 });
    for (const t of (await page.getTextContent()).items as Array<{ str: string; transform: number[] }>) items.push({ page: n, text: t.str, x: t.transform[4], y: t.transform[5], w: view.width, h: view.height }); }
  return items;
}
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
test("signing variables: record fields with a dot, sample fill marks what is missing, sender fields count", () => {
  assert.deepEqual(signing.signingVariables("{{student.first_name}} {{course.fees}} {{current_date}}"), ["student.first_name", "course.fees", "current_date"]);
  assert.throws(() => signing.signingVariables("{{student.first.name}}"), /variables/);
  assert.equal(signing.sampleFill("Dear {{student.first_name}}, fee {{course.fees}}", { "student.first_name": "Asha" }), "Dear Asha, fee [course.fees]");
  assert.equal(signing.fillSigningTemplate("{{employee.position}} from {{current_date}}", { "employee.position": "Trainer", current_date: "11 November 2026" }), "Trainer from 11 November 2026");
  assert.deepEqual(signing.templateVariables({ title: "{{student.full_name}}", body: null, fields: [{ role: "sender", value: "{{course.name}}" }, { role: "student", value: "{{ignored}}" }] }), ["student.full_name", "course.name"]);
  assert.match(signing.signingToday(new Date("2026-11-11T02:00:00Z")), /^11 November 2026$/);
  for (const key of ["student.first_name", "student.last_name", "student.email", "student.address", "course.name", "course.fees", "current_date"]) assert.ok(signing.SUBJECT_VARIABLES.student.includes(key), key);
  for (const key of ["employee.name", "employee.position"]) assert.ok(signing.SUBJECT_VARIABLES.employee.includes(key), key);
});
test("signing recipients: 1 to 10, each with a name and their own email, at least one required", () => {
  const two = signing.checkRecipients([{ name: "Asha Patel", email: "ASHA@example.test" }, { name: "Hari Manager", email: "hari@example.test", required: false, order: 2, label: "HR Manager", role: "hr" }]);
  assert.deepEqual(two.map((r) => [r.email, r.role, r.order, r.required]), [["asha@example.test", "signer1", 1, true], ["hari@example.test", "hr", 2, false]]);
  assert.throws(() => signing.checkRecipients([]), /between 1 and 10/);
  assert.throws(() => signing.checkRecipients(Array.from({ length: 11 }, (_, i) => ({ name: "Some One", email: `p${i}@example.test` }))), /between 1 and 10/);
  assert.throws(() => signing.checkRecipients([{ name: "A B", email: "x@example.test" }, { name: "C D", email: "X@example.test" }]), /listed twice/);
  assert.throws(() => signing.checkRecipients([{ name: "A B", email: "not-an-email" }]), /recipient 1/);
  assert.throws(() => signing.checkRecipients([{ name: "A B", email: "a@example.test", required: false }]), /required/);
});
test("signing: a Word document becomes template text, split variables joined, no DOCTYPE", () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>Dear {{student.</w:t></w:r><w:r><w:t>first_name}}</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Fee: &amp; </w:t><w:tab/><w:t>{{course.fees}}</w:t></w:r></w:p></w:body></w:document>';
  assert.equal(signing.docxXmlToText(xml), "Dear {{student.first_name}}\n\nFee: & \t{{course.fees}}");
  assert.throws(() => signing.docxXmlToText('<!DOCTYPE x><w:p><w:t>x</w:t></w:p>'), /could not be read/);
  assert.throws(() => signing.docxXmlToText("<w:document/>"), /No text/);
});
test("signing emails: only invitations and reminders carry the link; each kind says what happened", () => {
  const job = { kind: "invite" as const, audience: "recipient" as const, title: "Employment contract", reference: "SLIT-2026-000001", name: "Asha", role: "Employee", message: "Please sign by Friday", expires_at: "2026-11-20T00:00:00Z" };
  const invite = signing.renderSigningEmail(job, "https://slit.example/sign#t=abc")!;
  assert.match(invite.subject, /^Please sign: Employment contract$/); assert.match(invite.text, /sign#t=abc/); assert.match(invite.text, /Please sign by Friday/); assert.match(invite.text, /SLIT-2026-000001/);
  assert.equal(signing.renderSigningEmail(job, null), null, "no invitation without a link");
  assert.match(signing.renderSigningEmail({ ...job, kind: "reminder" }, "https://x/sign#t=r")!.subject, /^Reminder to sign/);
  for (const kind of ["expired", "declined", "voided", "completed"] as const) for (const audience of ["recipient", "admin"] as const) {
    const mail = signing.renderSigningEmail({ ...job, kind, audience, reason: "Wrong salary", declined_by: "Hari" }, "https://x/sign#t=never")!;
    assert.ok(mail && !/https?:\/\//.test(mail.text), `${kind}/${audience} has no link`);
  }
  assert.match(signing.renderSigningEmail({ ...job, kind: "declined", audience: "admin", reason: "Wrong salary", declined_by: "Hari" }, null)!.text, /Hari declined.*\n\nReason given: Wrong salary/s);
});
test("signed PDF: each completed field is printed inside its box on its page; others stay empty", async () => {
  const original = await PdfLib.PDFDocument.create(); original.addPage([595.28, 841.89]); original.addPage([595.28, 841.89]);
  const recipients = [{ id: "r1", name: "Asha Patel", email: "a@example.test", role: "Employee", state: "signed", signer_name: "Asha Patel", signed_at: "2026-11-11T01:00:00Z", signature_kind: "typed" },
    { id: "r2", name: "Hari Manager", email: "h@example.test", role: "HR Manager", state: "sent" }];
  const fields = [{ recipient_id: "r1", type: "signature", page: 2, x: 0.1, y: 0.7, w: 0.35, h: 0.08, value: "signed", done: true },
    { recipient_id: "r1", type: "text", page: 1, x: 0.5, y: 0.2, w: 0.4, h: 0.03, value: "Student 4471", done: true },
    { recipient_id: "r1", type: "checkbox", page: 1, x: 0.1, y: 0.3, w: 0.03, h: 0.02, value: "true", done: true },
    { recipient_id: "r2", type: "signature", page: 2, x: 0.55, y: 0.7, w: 0.35, h: 0.08, value: null, done: false }];
  const bytes = await signingPdf.stampDocument(await original.save(), { reference: "SLIT-2026-000001", title: "Contract", fields, recipients });
  assert.equal((await PdfLib.PDFDocument.load(bytes)).getPageCount(), 2, "no extra page when every signer has a placed signature");
  const text = await pdfText(bytes);
  const inBox = (t: { x: number; y: number; w: number; h: number }, f: { x: number; y: number; w: number; h: number }) => t.x >= f.x * t.w - 1 && t.x <= (f.x + f.w) * t.w && t.y >= t.h * (1 - f.y - f.h) - 1 && t.y <= t.h * (1 - f.y) + 1;
  const answer = text.find((t) => t.text.includes("Student 4471"))!; assert.ok(answer && answer.page === 1 && inBox(answer, fields[1]), JSON.stringify(answer));
  const sig = text.find((t) => t.text === "Asha Patel")!; assert.ok(sig && sig.page === 2 && inBox(sig, fields[0]), JSON.stringify(sig));
  assert.ok(!text.some((t) => t.text.includes("Hari")), "the second signer's field is empty until they sign");
  assert.ok(!text.some((t) => /UTC|SLIT-2026-000001/.test(t.text)), "no caption (name, time, reference) under a signature");
  // A signer with no placed signature field gets a signature page.
  const loose = await signingPdf.stampDocument(await original.save(), { reference: "SLIT-2026-000002", title: "Contract", fields: [], recipients: [{ ...recipients[0], signature_kind: "drawn", signature_image: PNG_1PX }] });
  assert.equal((await PdfLib.PDFDocument.load(loose)).getPageCount(), 3);
  assert.ok((await pdfText(loose)).some((t) => t.page === 3 && t.text.includes("Asha Patel")));
});
test("signature pictures must be PNG and small; the certificate carries both hashes and the history", async () => {
  assert.equal(signingPdf.signatureImageBytes(`data:image/png;base64,${PNG_1PX}`)[1], 0x50);
  assert.throws(() => signingPdf.signatureImageBytes(btoa("GIF89a....")), /could not be used/);
  assert.throws(() => signingPdf.signatureImageBytes("<svg>"), /Draw or upload/);
  const certificate = await signingPdf.buildCertificate({ id: "00000000-0000-4000-8000-000000000001", reference: "SLIT-2026-000003", title: "Consent form", fields: [], createdAt: "2026-11-10T00:00:00Z",
    sentAt: "2026-11-10T00:01:00Z", completedAt: "2026-11-11T00:00:00Z", signingMode: "sequential", originalHash: "a".repeat(64), signedHash: "b".repeat(64), consent: signing.SIGNING_CONSENT, chainOk: true,
    recipients: [{ id: "r1", name: "Asha Patel", email: "a@example.test", role: "Student", state: "signed", signer_name: "Asha Patel", signed_at: "2026-11-11T00:00:00Z", signature_kind: "drawn", ip: "203.0.113.5" }],
    events: [{ event: "created", at: "2026-11-10T00:00:00Z" }, { event: "signed", at: "2026-11-11T00:00:00Z", recipient_id: "r1", hash: "c".repeat(64) }] });
  const words = (await pdfText(certificate)).map((t) => t.text).join(" "), tight = words.replace(/\s+/g, "");
  for (const expected of ["SLIT-2026-000003", "Asha Patel", "203.0.113.5", "Drawn on the page", "Signed by Asha Patel"]) assert.ok(words.includes(expected), expected);
  assert.ok(tight.includes("a".repeat(64)) && tight.includes("b".repeat(64)), "both hashes");
  assert.match(words, /not a government identity check or a legal certification/);
});
test("signing mail: each job is sent once; a completed copy is sent only with matching files; closed requests send nothing", async () => {
  const sent: Array<{ to: string; subject: string; attachments?: unknown[] }> = []; const results: Array<[number, string]> = [];
  const files: Record<string, Uint8Array> = { "r/signed-1.pdf": new Uint8Array([1, 2, 3]), "r/certificate-1.pdf": new Uint8Array([4, 5]) };
  const hashOf = (b: Uint8Array) => signingCore.sha256Hex(b);
  let queue: Array<Record<string, unknown>> = [
    { id: 1, kind: "invite", audience: "recipient", title: "Contract", reference: "SLIT-1", to: "a@example.test", name: "Asha", token: "t".repeat(64) },
    { id: 2, kind: "completed", audience: "recipient", title: "Contract", reference: "SLIT-1", to: "a@example.test", signed_path: "r/signed-1.pdf", signed_hash: await hashOf(files["r/signed-1.pdf"]), certificate_path: "r/certificate-1.pdf", certificate_hash: await hashOf(files["r/certificate-1.pdf"]) },
    { id: 3, kind: "completed", audience: "admin", title: "Contract", reference: "SLIT-1", sender_email: "admin@example.test", signed_path: "r/signed-1.pdf", signed_hash: "0".repeat(64), certificate_path: "r/certificate-1.pdf", certificate_hash: await hashOf(files["r/certificate-1.pdf"]) },
  ];
  const ports = { isServiceCaller: false, uuid: () => "u", later: () => undefined, letterhead: async () => null, admin: async () => ({}),
    service: async (action: string, args: { data?: { id?: number; state?: string } } = {}) => { if (action === "notify_claim") { const out = queue; queue = []; return out; } if (action === "notify_result") results.push([args.data!.id!, args.data!.state!]); return {}; },
    storage: { download: async (p: string) => files[p] ?? null, upload: async () => true, remove: async () => undefined, signedUrl: async () => null },
    mail: { config: { from: { name: "Skyline", email: "hr@example.test" }, adminTo: ["hr@example.test"], siteUrl: "https://slit.example", problems: [] },
      provider: { id: "mock", send: async (m: { to: string; subject: string; attachments?: unknown[] }) => { sent.push(m); return { kind: "accepted" as const, messageId: `m-${sent.length}` }; } } },
  } as unknown as Parameters<typeof signingCore.drainSigningMail>[0];
  const first = await signingCore.drainSigningMail(ports);
  assert.deepEqual(first, { sent: 2, failed: 1, requeued: 0 });
  assert.deepEqual(results, [[1, "sent"], [2, "sent"], [3, "failed"]], "a changed signed PDF is never attached");
  assert.match(sent[0].subject, /^Please sign/); assert.equal(sent[1].attachments?.length, 1, "the signed document only (2026-11-20: the audit record is never emailed)");
  assert.ok(!JSON.stringify(sent).toLowerCase().includes("certificate"), "no certificate attachment, name or wording in any email");
  assert.deepEqual(await signingCore.drainSigningMail(ports), { sent: 0, failed: 0, requeued: 0 }, "nothing is sent twice");
  const off = await signingCore.drainSigningMail({ ...ports, mail: { ...ports.mail, provider: null } } as typeof ports);
  assert.deepEqual(off, { sent: 0, failed: 0, requeued: 0 }, "with sending off nothing is claimed");
});
test("signing links: a malformed token is refused before the database is asked", async () => {
  let asked = false;
  const ports = { service: async () => { asked = true; return {}; } } as unknown as Parameters<typeof signingCore.handleSigning>[1];
  await assert.rejects(signingCore.handleSigning({ body: { action: "open", token: "../../x" }, upload: null, ip: null, userAgent: null }, ports), (e: Error & { status?: number }) => e.status === 403);
  assert.equal(asked, false);
});

/* ------------------------------------------------------------------ TPL-02 document templates: header / body / footer, [Variables] */
const richHtml = await load.import<typeof import("../supabase/functions/_shared/rich-html.ts")>("../supabase/functions/_shared/rich-html.ts");
const tplVars = await load.import<typeof import("../supabase/functions/_shared/template-variables.ts")>("../supabase/functions/_shared/template-variables.ts");
const documentPdf = await load.import<typeof import("../supabase/functions/_shared/document-pdf.ts")>("../supabase/functions/_shared/document-pdf.ts");
const docxImport = await load.import<typeof import("../src/lib/docxImport.ts")>("../src/lib/docxImport.ts");
const SLIT_HEADER = `<table style="border:none;width:100%"><tr><td style="width:50%"><strong style="font-size:14pt">Skyline Institute of Technology</strong></td><td style="text-align:right;width:50%">Level 8, 310 King Street, Melbourne VIC 3000<br>RTO 45989 | CRICOS 04114B<br>info@slit.edu.au | +61 3 9125 1661<br>https://slit.edu.au/</td></tr></table>`;
const SLIT_FOOTER = `<p>LETTER OF OFFER AND WRITTEN AGREEMENT &nbsp; Version Oct 2024 &nbsp; Student Initial [Student Initial] &nbsp; Page [Page Number]</p><p style="font-size:8pt">INDOPACIFIC GLOBAL PTY LTD T/A SKYLINE INSTITUTE OF TECHNOLOGY (SLIT) ABN: 20 643 760 721</p>`;
const FEE_ROWS = Array.from({ length: 36 }, (_, i) => `<tr><td>Fee item ${i + 1}: a description long enough to wrap onto a second line inside its cell of the fee table</td><td style="text-align:right">$${(i + 1) * 100}.00</td></tr>`).join("");
const AGREEMENT = `<h2>1. Fees</h2><p>Dear [Student Name] ([Student ID]), you start [Course Name] on [Start Date] ([Intake]). Your emergency contact is [Emergency Contact Name].</p><table><tr><th>Fee item</th><th>Amount</th></tr>${FEE_ROWS}</table><h2>2. Agreement</h2><p>${"The student agrees to the terms of this written agreement. ".repeat(60)}</p><p>Emergency contact again: [Emergency Contact Name].</p>`;
const STUDENT_VALUES = { "student.full_name": "Asha Patel", "student.id": "SLIT-APP-0042", "course.name": "Diploma of Business", "course.start_date": "3 February 2027", "course.intake": "February 2027", current_date: "11 November 2026" };

test("template variables: one registry; record values fill, page numbers and initials are automatic, any other [token] is a signer field", () => {
  for (const name of ["Page Number", "Total Pages", "Date", "Student Name", "Student ID", "Course Name", "Course Code", "Intake", "Start Date", "Agent Name"]) assert.ok(tplVars.lookupVariable(name), name);
  assert.equal(tplVars.lookupVariable("student   NAME")?.name, "Student Name", "case and spacing do not matter");
  assert.equal(tplVars.lookupVariable("USI"), undefined, "[USI] is not a variable yet (room left for it)");
  assert.equal(new Set(tplVars.TEMPLATE_VARIABLES.map((v) => v.name.toLowerCase())).size, tplVars.TEMPLATE_VARIABLES.length, "names are unique");
  for (const v of tplVars.TEMPLATE_VARIABLES) assert.ok(Boolean(v.keys?.length) !== Boolean(v.render || v.field), `${v.name} resolves one way`);
  assert.deepEqual(tplVars.resolveToken("Student Name", STUDENT_VALUES), { kind: "value", text: "Asha Patel" });
  assert.deepEqual(tplVars.resolveToken("Start Date", { "employee.start_date": "2027-01-04" }), { kind: "value", text: "2027-01-04" }, "an employee's start date on staff documents");
  assert.deepEqual(tplVars.resolveToken("Intake", {}), { kind: "missing", name: "Intake" });
  assert.deepEqual(tplVars.resolveToken("Intake", {}, true), { kind: "value", text: "[Intake]" }, "a preview shows what is missing");
  assert.deepEqual(tplVars.resolveToken("Page Number", {}), { kind: "page" });
  assert.deepEqual(tplVars.resolveToken("Student Initial", {}), { kind: "field", field: "initials", label: "Student Initial" });
  assert.deepEqual(tplVars.resolveToken(" Guardian  Name ", {}), { kind: "field", field: "text", label: "Guardian Name" });
  for (const literal of ["1", " ", "___", "2024"]) assert.deepEqual(tplVars.resolveToken(literal, {}), { kind: "literal" }, `[${literal}] stays text`);
  assert.deepEqual(tplVars.tokenReport(["Dear [Student Name], [Guardian Name] [Page Number] of [Total Pages] [guardian name] [x] [1]"]),
    { known: ["Student Name"], fields: ["Guardian Name", "x"], automatic: ["Page Number", "Total Pages"] });
  assert.deepEqual(tplVars.variableKeys(["[Intake] [Course Name]"]), [{ name: "Intake", key: "course.intake" }, { name: "Course Name", key: "course.name" }]);
  assert.equal(tplVars.isTokenFieldLabel(tplVars.tokenFieldLabel("Guardian Name")), true);
  assert.equal(tplVars.isTokenFieldLabel("Initial here"), false, "a field placed by hand is not a token field");
});

test("template HTML: the allow-list keeps tables, uploaded pictures, colours and sizes; scripts, handlers, linked pictures and javascript links go", () => {
  const dirty = `<p onclick="x()">Hi<script>alert(1)</script><style>p{}</style></p><img src="https://evil.example/x.png"><img src="data:image/png;base64,${PNG_1PX}" onerror="x()" width="120">`
    + `<a href="javascript:alert(1)">bad</a><a href="https://slit.edu.au/">good</a><iframe src="https://x"></iframe><table border="0"><tr><td style="width:50%;background-color:#eeeeee;position:fixed">L</td><td align="right">R</td></tr></table>`
    + `<font size="5" color="red" face="Arial">big</font><span style="font-size:11pt;font-weight:700;color:rgb(0,0,255)">blue</span>`;
  const clean = richHtml.sanitizeRichHtml(dirty);
  for (const gone of ["script", "alert", "onclick", "onerror", "evil.example", "javascript", "iframe", "<style", "position", "font-family"]) assert.ok(!clean.includes(gone), `${gone} removed: ${clean}`);
  for (const kept of [`src="data:image/png;base64,${PNG_1PX}"`, "width:90pt", '<a href="https://slit.edu.au/">good</a>', '<table style="border:none">', "width:50%", "background-color:#eeeeee",
    "text-align:right", "font-size:18pt", "color:#ff0000", "font-size:11pt", "font-weight:bold", "color:#0000ff"]) assert.ok(clean.includes(kept), `${kept} kept: ${clean}`);
  assert.equal(richHtml.sanitizeRichHtml("<p>a<p>b<ul><li>one<li>two</ul>"), "<p>a</p><p>b</p><ul><li>one</li><li>two</li></ul>", "implied closes");
  assert.equal(richHtml.sanitizeRichHtml(richHtml.sanitizeRichHtml(dirty)), clean, "sanitising twice changes nothing");
  assert.equal(richHtml.richPlainText("<h1>Fees</h1><table><tr><td>Tuition</td><td>$1</td></tr></table><p>A<br>B</p>"), "Fees\nTuition\t$1\nA\nB");
  assert.deepEqual(richHtml.bracketWarnings("Dear [Student Name", "Body"), ['Body: a [ or ] without its pair in "Dear [Student Name"']);
  assert.deepEqual(richHtml.bracketWarnings("Tick [ ] here", "Footer"), ['Footer: an empty [ ] in "Tick [ ] here"']);
  assert.deepEqual(richHtml.bracketWarnings("Dear [Student Name], [Intake]", "Body"), []);
  assert.equal(richHtml.joinSplitTokens("Dear [Student <strong>Name</strong>], hi"), "Dear [Student Name]<strong></strong>, hi");
  assert.equal(richHtml.joinSplitTokens("<strong>[Student </strong>Name]"), "<strong>[Student Name]</strong>");
  // The database refuses the same things on top of the pages' allow-list (hr.rich_html_problem in 20261113190000).
  const migration = read("supabase/migrations/20261113190000_template_sections.sql");
  for (const rule of ["script|style|iframe", "on[a-z]+", "javascript|vbscript", "data:image/(png|jpeg);base64,"]) assert.ok(migration.includes(rule), rule);
});

test("document PDF: the header and footer repeat on every page with the right page number; fee table rows never split; values, signer fields and initials placed", async () => {
  const made = await documentPdf.buildDocumentPdf({ title: "Letter of offer", header: SLIT_HEADER, body: AGREEMENT, footer: SLIT_FOOTER, values: STUDENT_VALUES, brackets: true });
  assert.ok(made.pages >= 3, `pages: ${made.pages}`);
  assert.deepEqual([made.missing, made.unsupported], [[], null]);
  const items = await pdfText(made.bytes);
  const pageText = (n: number) => items.filter((t) => t.page === n).map((t) => t.text).join(" ");
  for (let n = 1; n <= made.pages; n++) {
    const text = pageText(n);
    for (const expected of ["Skyline Institute of Technology", "Level 8, 310 King Street, Melbourne VIC 3000", "CRICOS 04114B", "+61 3 9125 1661", "LETTER OF OFFER AND WRITTEN AGREEMENT", "Version Oct 2024", "ABN: 20 643 760 721"])
      assert.ok(text.includes(expected), `page ${n}: ${expected}`);
    assert.match(text, new RegExp(`Page ${n}(?!\\d)`), `page ${n} prints its own number`);
    const header = items.find((t) => t.page === n && t.text.includes("CRICOS"))!, footer = items.find((t) => t.page === n && t.text.includes("ABN"))!;
    assert.ok(header.y > 760 && footer.y < 60, `page ${n}: the header at the top, the footer at the bottom`);
  }
  const all = items.map((t) => t.text).join(" ");
  for (const value of ["Dear Asha Patel (SLIT-APP-0042)", "Diploma of Business", "3 February 2027", "(February 2027)"]) assert.ok(all.includes(value), value);
  assert.ok(!/\[(Student Name|Intake|Page Number|Student Initial)\]/.test(all), "no registry token is printed as text");
  // A fee row is on one page: its description and its amount together, each exactly once.
  for (let i = 1; i <= 36; i++) {
    const label = items.filter((t) => t.text.includes(`Fee item ${i}:`)), amount = items.filter((t) => t.text === `$${i * 100}.00`);
    assert.equal(label.length, 1, `fee item ${i} printed once`); assert.equal(amount.length, 1, `amount ${i} printed once`);
    assert.equal(label[0].page, amount[0].page, `fee row ${i} is not split across pages`);
  }
  const bodyRows = made.placed.filter((r) => r.top < 760);
  assert.ok(bodyRows.every((r) => r.bottom > 55), "every row ends above the footer");
  // Fields: the initials in every footer, the signer's token once per place it appears (one question on the signing page).
  const initials = made.fields.filter((f) => f.type === "initials");
  assert.deepEqual(initials.map((f) => f.page), Array.from({ length: made.pages }, (_, i) => i + 1), "Student Initial on every page");
  const answers = made.fields.filter((f) => f.type === "text");
  assert.deepEqual([...new Set(answers.map((f) => f.label))], ["[Emergency Contact Name]"]);
  assert.equal(answers.length, 2, "the token appears twice in the body");
  for (const f of made.fields) assert.ok(f.x >= 0 && f.y >= 0 && f.x + f.w <= 1.0001 && f.y + f.h <= 1.0001 && f.w > 0 && f.h > 0, JSON.stringify(f));
  const loaded = await PdfLib.PDFDocument.load(made.bytes);
  const fontNames = loaded.context.enumerateIndirectObjects().map(([, obj]) => obj instanceof PdfLib.PDFDict ? obj.get(PdfLib.PDFName.of("BaseFont"))?.toString() : undefined).filter(Boolean);
  assert.ok(fontNames.some((name) => /Arimo-Regular/.test(String(name))) && fontNames.some((name) => /Arimo-Bold/.test(String(name))), `set in Arimo: ${fontNames.join(", ")}`);
  // Signed: the initials land in the footer box of every page and the answer in its boxes (the existing stamp, from the fields).
  const signer = { id: "r1", name: "Asha Patel", email: "a@example.test", role: "Student", state: "signed", signer_name: "Asha Patel", signed_at: "2026-11-11T01:00:00Z", signature_kind: "typed" };
  const signed = await signingPdf.stampDocument(made.bytes, { reference: "SLIT-2026-000099", title: "Letter of offer", recipients: [signer],
    fields: made.fields.map((f) => ({ ...f, recipient_id: "r1", value: f.type === "text" ? "Ravi Patel 0412 345 678" : "signed", done: true })) });
  const stamped = await pdfText(signed);
  for (let n = 1; n <= made.pages; n++) assert.ok(stamped.some((t) => t.page === n && t.text === "AP" && t.y < 60), `initials AP in the footer of page ${n}`);
  assert.equal(stamped.filter((t) => t.text.includes("Ravi Patel 0412 345 678")).length, 2, "the answer is printed wherever the token was");
  // Missing values are reported (the function refuses to send); a preview shows them; text no font can print is reported.
  const noIntake = await documentPdf.buildDocumentPdf({ title: "x", body: "<p>[Intake] [Course Code]</p>", values: {}, brackets: true });
  assert.deepEqual(noIntake.missing, ["Intake", "Course Code"]);
  assert.ok((await pdfText((await documentPdf.buildDocumentPdf({ title: "x", body: "<p>[Intake]</p>", values: {}, brackets: true, sample: true })).bytes)).some((t) => t.text.includes("[Intake]")));
  assert.equal((await documentPdf.buildDocumentPdf({ title: "x", body: "<p>名前 Ελληνικά</p>", values: {}, brackets: true })).unsupported, "名前");
  // With brackets off (a template not yet saved in the new editor) square brackets are plain text.
  const literal = await documentPdf.buildDocumentPdf({ title: "x", body: "<p>Tick [Guardian Name]</p>", values: {}, brackets: false });
  assert.deepEqual([literal.fields.length, (await pdfText(literal.bytes)).some((t) => t.text.includes("[Guardian Name]"))], [0, true]);
});

test("Mark as enrolled (2026-11-21): only from CoE / VoE issued in the menu and the database; the mailbox step reuses Create Email and never blocks enrolment", () => {
  const menu = read("src/components/shared/application-status/TakeActionMenu.tsx"), dialog = read("src/components/shared/application-status/EnrolMailboxDialog.tsx");
  const form = read("src/pages/admin/components/CreateEmailSection.tsx"), list = read("src/pages/admin/components/EnrolledWithoutMailbox.tsx"), fn = read("supabase/functions/student-office365/index.ts");
  const sql = read("supabase/migrations/20261121051517_enrolled_guard_and_mailbox.sql");
  // Earlier statuses: shown disabled with the reason; after Enrol succeeds (the status is saved) the mailbox step opens.
  assert.ok(menu.includes('const BEFORE_COE = ["draft", "submitted", "under_review", "action_required", "offer_issued", "offer_accepted"]') && menu.includes('aria-disabled="true" title="Issue the CoE/VoE first"'));
  assert.ok(menu.includes("onDone={(result) => { changed(result); setMailbox(true); }}") && menu.includes("<EnrolMailboxDialog applicationId={application.id} studentId={application.studentId}"));
  // The same Create Email form, Student and the linked profile locked, the outcome logged on the application; Skip logs and closes.
  assert.ok(dialog.includes('<CreateEmailForm initialKind="student" personId={student}') && dialog.includes("locked applicationId={applicationId}") && dialog.includes('logApplicationMailbox(applicationId, "skipped"'));
  // 2026-11-23: a caller without the student (the Applications list row) still gets the form: the dialog reads the application's own
  // student profile (student_id is NOT NULL), and only if none is found lets staff choose the student there (never Email Management).
  assert.ok(dialog.includes('supabase.from("enrollment_applications").select("student_id").eq("id", applicationId)') && dialog.includes('<CreateEmailForm initialKind="student" personQuery=')
    && !dialog.includes("then use Email Management"));
  assert.ok(form.includes("export default function CreateEmailSection() {") && form.includes("return <CreateEmailForm />;") && form.includes("disabled={locked || !status?.connected"));
  assert.ok(fn.includes("caller.rpc('application_mailbox_log'") && fn.includes("body.dryRun!==true") && list.includes("<EnrolMailboxDialog"));
  // The database: Enrolled only from CoE / VoE issued (or Undo back to it), never inserted as Enrolled, no "-> Enrolled" transition from elsewhere.
  assert.ok(sql.includes("before insert or update of status on public.enrollment_applications") && sql.includes("if old.status = 'enrolled' or old.status = 'coe_issued' then return new; end if;")
    && sql.includes("check (to_status is distinct from 'enrolled' or from_status = 'coe_issued')") && sql.includes("if p_outcome = 'created' and (m.student_id is null or m.ms_user_id is null)"));
});
test("offer letter ADMIN USE ONLY: boxes are drawn (never \"?\"), ACCEPTED ticked at signing, Yes + date only on the payment copy", async () => {
  const layout = await load.import<typeof import("../src/lib/offerSigningLayout.ts")>("../src/lib/offerSigningLayout.ts");
  const td = (t: string) => `<td style="border:1px solid #808080"><p>${t}</p></td>`;
  const body = `<p>Student Signature</p><table><tr><td colspan="7"><p><strong>ADMIN USE ONLY</strong></p></td></tr>`
    + `<tr>${td("<strong>Offer</strong>")}${td("ACCEPTED")}${td("☐")}${td("DEFERRED")}${td("☐")}${td("DECLINED")}${td("☐")}</tr>`
    + `<tr>${td("<strong>Payment made</strong>")}${td("Yes")}${td("☐")}${td("No")}${td("☐")}${td("Date:")}<td style="border:1px solid #808080"></td></tr></table>`
    + `<p>Inline ☑ ☒ ✓ ✔ ✗ ✘</p>`;
  const made = await documentPdf.buildDocumentPdf({ title: "Letter", body, values: {}, brackets: false });
  assert.equal(made.unsupported, null, "tick boxes and ticks are shapes, not characters a font lacks");
  assert.ok(!(await pdfText(made.bytes)).some((t) => /[?☐-☒✓-✘]/.test(t.text)), "no \"?\" and no box character in the text layer");
  assert.deepEqual(made.boxes.map((b) => b.shape), ["box", "box", "box", "box", "box", "box-tick", "box-cross"]);
  assert.equal(made.blanks.length, 1);
  const admin = layout.adminTableFields({ boxes: made.boxes, blanks: made.blanks });
  assert.deepEqual(admin.map((f) => [f.type, f.label]), [["checkbox", "Offer accepted"], ["checkbox", "Payment made"], ["text", "Payment date"]], "nothing on DEFERRED, DECLINED or No");
  const accepted = made.boxes[0];
  assert.deepEqual([admin[0].page, admin[0].x, admin[0].y], [accepted.page, +accepted.x.toFixed(5), +accepted.y.toFixed(5)], "the field is the drawn box");
  assert.deepEqual(layout.adminTableFields(null), []);
  // PDF #1: what signing stamps (hr.sign_auto_value with no payment): ACCEPTED ticked, the payment boxes and the date empty.
  const atSigning = (f: (typeof admin)[number]) => f.label === "Offer accepted" ? "true" : f.label === "Payment made" ? "false" : "";
  const recipients = [{ id: "r1", role: "Student", name: "S", email: "s@example.com", state: "signed", signer_name: "S", signature_kind: "typed", signature_image: null, signed_at: "2026-11-21T01:00:00Z" }];
  const signed = await signingPdf.stampDocument(made.bytes, { reference: "SLIT-T", title: "Letter", recipients,
    fields: [{ recipient_id: "r1", type: "signature", page: 1, x: 0.4, y: 0.05, w: 0.3, h: 0.04, value: "signed", done: true }, ...admin.map((f) => ({ ...f, recipient_id: "r1", value: atSigning(f), done: true }))] });
  assert.ok(!(await pdfText(signed)).some((t) => /\d\d\/\d\d\/\d{4}/.test(t.text)), "no payment date on the signed letter");
  // PDF #2: the payment copy (document-signing offer_payment_copy): the signed bytes unchanged at the start, Yes ticked, the date printed.
  const copy = await signingPdf.stampDocument(signed, { reference: "SLIT-T", title: "Letter", recipients: [], incremental: true,
    fields: admin.filter((f) => f.label !== "Offer accepted").map((f) => ({ ...f, recipient_id: null, value: f.type === "checkbox" ? "true" : "21/11/2026", done: true })) });
  assert.ok(copy.length > signed.length && Buffer.from(copy.subarray(0, signed.length)).equals(Buffer.from(signed)), "the signed letter is the copy's first bytes");
  assert.ok((await pdfText(copy)).some((t) => t.text === "21/11/2026"), "the paid date is printed");
});

/** A small .docx made here (no file on disk): a heading, a token Word split across a bold run, a fee table with a token in a cell. */
async function sampleDocx(): Promise<Uint8Array> {
  const { zipSync, strToU8 } = await import("fflate");
  const r = (t: string, bold = false) => `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
  const cell = (t: string) => `<w:tc><w:p>${r(t)}</w:p></w:tc>`;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`
    + `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${r("1. Fees and charges")}</w:p>`
    + `<w:p>${r("Dear ")}${r("[Student ")}${r("Name]", true)}${r(", your intake is [Intake]. Guardian: [Guardian Name].")}</w:p>`
    + `<w:tbl><w:tr>${cell("Fee item")}${cell("Amount")}</w:tr><w:tr>${cell("Tuition")}${cell("$14,000.00")}</w:tr><w:tr>${cell("Materials ([Materials Fee])")}${cell("$500.00")}</w:tr></w:tbl></w:body></w:document>`;
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": strToU8(doc),
  });
}
test("Word import: the heading, the fee table and every [token] survive, and become variables and signer fields", async () => {
  const { html } = await docxImport.docxToTemplateHtml(await sampleDocx());
  assert.ok(html.includes("<h1>1. Fees and charges</h1>"), html);
  assert.match(html, /<table><tr><td><p>Fee item<\/p><\/td><td><p>Amount<\/p><\/td><\/tr><tr><td><p>Tuition<\/p><\/td><td><p>\$14,000\.00<\/p><\/td><\/tr>/);
  for (const token of ["[Student Name]", "[Intake]", "[Guardian Name]", "[Materials Fee]"]) assert.ok(html.includes(token), `${token} survived`);
  assert.deepEqual(tplVars.tokenReport([richHtml.richPlainText(html)]), { known: ["Student Name", "Intake"], fields: ["Guardian Name", "Materials Fee"], automatic: [] });
  const made = await documentPdf.buildDocumentPdf({ title: "Imported", body: html, values: STUDENT_VALUES, brackets: true });
  assert.deepEqual(made.fields.map((f) => f.label), ["[Guardian Name]", "[Materials Fee]"]);
  const text = (await pdfText(made.bytes)).map((t) => t.text).join(" ");
  for (const expected of ["Tuition", "$14,000.00", "Asha Patel", "February 2027"]) assert.ok(text.includes(expected), expected);
  await assert.rejects(docxImport.docxToTemplateHtml(new TextEncoder().encode("not a zip")), /not a Word/);
});

test("signing function: a sectioned template's preview and request carry the header, footer and signer fields; old templates render as before; one answer per token", async () => {
  const template = { id: "00000000-0000-4000-8000-0000000000a1", name: "Offer", title: "Letter of offer", kind: "text", status: "active", category: "enrolment_agreement", bracket_variables: true,
    header_html: SLIT_HEADER, footer_html: SLIT_FOOTER, body_html: "<p>Dear [Student Name], guardian [Guardian Name].</p>", body: "Dear", fields: [], roles: [{ key: "student", label: "Student", order: 1, required: true }],
    signing_mode: "sequential", expiry_days: 14, reminder_days: 3 };
  assert.equal(signingCore.isSectioned(template), true);
  assert.equal(signingCore.isSectioned({ kind: "text", body: "Dear {{full_name}}", body_html: "<p>Dear {{full_name}}</p>", header_html: null, footer_html: null, bracket_variables: false }), false, "an existing template keeps its renderer");
  assert.equal(signingCore.isSectioned({ kind: "pdf", header_html: "<p>x</p>" }), false);
  let created: Record<string, unknown> | null = null; const stored: string[] = []; let n = 0;
  const ports = { isServiceCaller: false, later: () => undefined, letterhead: async () => null, uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    admin: async (action: string, _id: string | null, data: Record<string, unknown>) => {
      if (action === "list") return { templates: [template], requests: [] };
      if (action === "subject_search") return [];
      if (action === "create") { created = data; return { id: _id, reference: "SLIT-2026-000099" }; }
      throw new Error(`unexpected ${action}`);
    },
    service: async () => true,
    storage: { download: async () => null, upload: async (p: string) => { stored.push(p); return true; }, remove: async () => undefined, signedUrl: async () => null },
    mail: { provider: null, config: { from: null, adminTo: [], siteUrl: "", problems: [] } },
  } as unknown as Parameters<typeof signingCore.handleSigning>[1];
  const call = (body: Record<string, unknown>) => signingCore.handleSigning({ body, upload: null, ip: null, userAgent: null }, ports);
  const preview = await call({ action: "template_preview", template }) as { pdfBase64: string; signerFields: Array<{ label: string; type: string }> };
  assert.deepEqual(preview.signerFields.map((f) => `${f.type}:${f.label}`), ["text:[Guardian Name]", "initials:Student Initial"]);
  const previewText = (await pdfText(Uint8Array.from(Buffer.from(preview.pdfBase64, "base64")))).map((t) => t.text).join(" ");
  assert.ok(previewText.includes("CRICOS 04114B") && previewText.includes("[Student Name]") && previewText.includes("Guardian Name"), "a preview shows the letterhead, the missing value and the field's label");
  await assert.rejects(call({ action: "create", templateId: template.id, recipients: [{ name: "Asha Patel", email: "asha@example.test", role: "student" }], values: {} }), /\[Student Name\] has no value/);
  await call({ action: "create", templateId: template.id, recipients: [{ name: "Asha Patel", email: "asha@example.test", role: "student" }, { name: "Hari Admissions", email: "hari@example.test", role: "officer", order: 2 }],
    values: { "student.full_name": "Asha Patel" } });
  const fields = (created as unknown as { fields: Array<{ type: string; role: string; label: string; page: number }> }).fields;
  assert.deepEqual(fields.map((f) => `${f.role}:${f.type}:${f.label}:${f.page}`), ["student:text:[Guardian Name]:1", "student:initials:Student Initial:1"], "the first signer gets the token and the initials");
  assert.equal(stored.length, 1, "one original PDF stored");
  // Signing: two boxes of the same token must carry one answer.
  const record = { id: "r", state: "sent", fields: [{ id: "f1", type: "text", label: "[Guardian Name]" }, { id: "f2", type: "text", label: "[Guardian Name]" }] };
  const linkPorts = { ...ports, service: async (action: string) => { if (action === "open") return record; throw new Error(`unexpected ${action}`); } } as typeof ports;
  await assert.rejects(signingCore.handleSigning({ body: { action: "sign", token: "a".repeat(64), name: "Asha Patel", agreed: true, values: { f1: "Ravi", f2: "Someone else" } }, upload: null, ip: null, userAgent: null }, linkPorts),
    /one answer for \[Guardian Name\]/);
});

/* ------------------------------------------------------------------ agent onboarding documents (2026-11-17) */

const BLANKS = { form: "public/templates/agent_application_form_template_blank.pdf", agreement: "public/templates/agent_agreement_template_blank.pdf", referee: "public/templates/agent_referee_check_form_template_blank.pdf" } as const;
const blankBytes = (which: keyof typeof BLANKS) => new Uint8Array(readFileSync(path.resolve(BLANKS[which])));
test("agent onboarding: the registry and the two blanks agree; every widget becomes a placed field with its page, type and key; a different PDF is refused", async () => {
  for (const which of ["form", "agreement"] as const) {
    const bytes = blankBytes(which);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), onboarding.AGENT_ONBOARDING_DOCS[which].sha256, `${which}: the shipped blank is the registered one`);
    const read = await onboardingPdf.readBlankTemplate(which, bytes);
    assert.equal(read.pages, onboarding.AGENT_ONBOARDING_DOCS[which].pages);
    for (const f of read.fields) assert.ok(f.x >= 0 && f.y >= 0 && f.x + f.w <= 1.0001 && f.y + f.h <= 1.0001 && f.w > 0 && f.h > 0 && f.page >= 1 && f.page <= read.pages, JSON.stringify(f));
    const flat = await PdfLib.PDFDocument.load(read.flattened);
    assert.equal(flat.getForm().getFields().length, 0, "the stored template has no interactive fields left");
    assert.equal(flat.getPageCount(), read.pages);
    const keys = new Set(read.fields.map((f) => f.key));
    for (const [key, spec] of Object.entries(onboarding.AGENT_ONBOARDING_FIELDS)) if (spec.doc === which) assert.ok(keys.has(key), `${which}: ${key} is placed`);
    if (which === "agreement") {
      assert.deepEqual(read.fields.filter((f) => f.key === "agent_organisation_name").map((f) => f.page).sort((a, b) => a - b), [1, 1, 10, 11, 11], "the organisation name prints on pages 1, 10 and 11");
      const sign = read.fields.find((f) => f.key === "agent_signature")!; assert.ok(sign.role === "agent" && sign.type === "signature" && sign.page === 11 && sign.required);
      const slit = read.fields.find((f) => f.key === "admin_signature")!; assert.ok(slit.role === "sender" && slit.type === "signature" && slit.value === "{{admin_signature}}");
      assert.equal(read.fields.find((f) => f.key === "agent_signed_date")!.type, "date");
    } else {
      assert.deepEqual(read.fields.filter((f) => f.key.startsWith("litigation_involved")).map((f) => `${f.key}:${f.type}:${f.required}`).sort(), ["litigation_involved:NO:checkbox:true", "litigation_involved:YES:checkbox:true"], "a radio group is one tick box per option");
      assert.equal(read.fields.filter((f) => f.key === "org_chart_attached:YES").length, 1);
      assert.equal(read.fields.find((f) => f.key === "agent_gst_registered:YES")!.role, "sender");
      assert.equal(read.fields.find((f) => f.key === "agent_signature_form")!.page, 2);
      assert.equal(read.fields.filter((f) => f.key.startsWith("ref2_")).length, 6);
    }
  }
  const other = await PdfLib.PDFDocument.create(); other.addPage(); other.addPage();
  await assert.rejects(onboardingPdf.readBlankTemplate("form", await other.save()), /lacks/);
});
test("agent onboarding: values resolve into what the sender prints and what the agent fills; answers come back by key; the term is two years", () => {
  const box = { page: 1, x: 0.3, y: 0.3, w: 0.3, h: 0.03, required: false, label: "" };
  const fields = [
    { ...box, key: "agent_abn_form", type: "text", role: "sender", required: true, value: "{{agent_abn}}" },
    { ...box, key: "agent_website", type: "text", role: "sender", value: "{{agent_website}}" },
    { ...box, key: "agent_gst_registered:YES", type: "checkbox", role: "sender", value: "{{agent_gst_registered}}" },
    { ...box, key: "agent_gst_registered:NO", type: "checkbox", role: "sender", value: "{{agent_gst_registered}}" },
    { ...box, key: "agent_signatory_name", type: "text", role: "agent", required: true, value: "" },
    { ...box, key: "admin_signature", type: "signature", role: "sender", value: "{{admin_signature}}" },
    { ...box, key: "admin_witness_name", type: "text", role: "sender", value: "{{admin_witness_name}}" },
    { ...box, key: "agreement_commencement_date", type: "text", role: "sender", value: "{{agreement_commencement_date}}" },
    { ...box, key: "agent_commission_percent", type: "text", role: "sender", value: "{{agent_commission_percent}}" },
  ] as Parameters<typeof onboarding.resolveFields>[0];
  const r = onboarding.resolveFields(fields, { agent_abn: "12345678901", agent_gst_registered: "YES", agent_signatory_name: "Ravi Kumar", admin_signature: "data:image/png;base64,x", agreement_commencement_date: "2026-11-17", agent_commission_percent: "25" });
  assert.deepEqual(r.printed.map((f) => `${f.key}=${f.value}`), ["agent_abn_form=12 345 678 901", "agent_gst_registered:YES=true", "admin_signature=data:image/png;base64,x", "agreement_commencement_date=17/11/2026", "agent_commission_percent=25%"]);
  assert.deepEqual(r.recipient.map((f) => `${f.key}:${f.role}:${f.required}:${f.value}`), ["agent_website:agent:false:", "agent_signatory_name:agent:true:Ravi Kumar"], "no website on record: the agent's optional field; the signatory prefilled");
  assert.deepEqual(onboarding.collectAnswers([{ key: "litigation_involved:YES", type: "checkbox", value: "true" }, { key: "litigation_involved:NO", type: "checkbox", value: "false" },
    { key: "ref1_email", type: "text", value: " a@b.test " }, { key: "agent_signature_form", type: "signature", value: "signed" }, { key: "agent_signed_date_form", type: "date", value: "17/11/2026" }]),
    { litigation_involved: "YES", ref1_email: "a@b.test", agent_signed_date: "17/11/2026" });
  assert.equal(onboarding.expiryDate("2026-11-17"), "2028-11-16");
  assert.equal(onboarding.expiryDate("2028-02-29"), "2030-02-28", "no 29 February two years on: the anniversary is 1 March, the term ends the day before");
  assert.deepEqual(onboarding.acroFieldName("eatc_completed:NO"), { name: "eatc_completed_no", option: null });
  assert.deepEqual(onboarding.acroFieldName("works_with_sub_agents:NO"), { name: "works_with_sub_agents", option: "Choice2" });
  assert.equal(onboarding.registryKey("form", "agent_abn", null), "agent_abn_form");
  assert.equal(onboarding.registryKey("agreement", "agent_abn", null), "agent_abn");
  assert.equal(signingPdf.layoutText({ widthOfTextAtSize: (t: string, s: number) => t.length * s * 0.5 } as never, "a long answer that will not fit on one line of this box", 100, 30).lines.length > 1, true, "a long answer wraps in a tall box");
});
test("agent onboarding: the referee check blank (F05) is registered and placed; a referee's fields resolve from the application form's reference", async () => {
  const bytes = blankBytes("referee");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), onboarding.AGENT_ONBOARDING_DOCS.referee.sha256, "the shipped F05 blank is the registered one");
  const read = await onboardingPdf.readBlankTemplate("referee", bytes);
  assert.equal(read.pages, 1);
  assert.deepEqual(read.fields.map((f) => `${f.key}:${f.role}:${f.type}:${f.required}`).sort(), [
    "agent_agency_name_referee:sender:text:false", "agent_office_address:sender:text:false", "referee_address:referee:text:false", "referee_contact_person_1:referee:text:true", "referee_contact_person_2:referee:text:false",
    "referee_email:sender:text:false", "referee_fax:referee:text:false", "referee_organisation:referee:text:true", "referee_phone:referee:text:true", "referee_signature:referee:signature:true"].sort());
  assert.equal((await PdfLib.PDFDocument.load(read.flattened)).getForm().getFields().length, 0);
  assert.equal(onboarding.signerRole("referee").key, "referee"); assert.equal(onboarding.signerRole("form").key, "agent");
  const r = onboarding.resolveFields(read.fields, { agent_agency_name: "Acme Education Pty Ltd", agent_office_address: "1 Test St, Melbourne VIC 3000", referee_email: "priya@example.test",
    referee_organisation: "Harbour College", referee_contact_person_1: "Priya Nair, Admissions Lead", referee_phone: "0400 111 222" });
  assert.deepEqual(r.printed.map((f) => `${f.key}=${f.value}`).sort(), ["agent_agency_name_referee=Acme Education Pty Ltd", "agent_office_address=1 Test St, Melbourne VIC 3000", "referee_email=priya@example.test"], "the agency and the referee's email are printed (read-only)");
  assert.deepEqual(r.recipient.map((f) => `${f.key}:${f.value}`).sort(), ["referee_address:", "referee_contact_person_1:Priya Nair, Admissions Lead", "referee_contact_person_2:", "referee_fax:", "referee_organisation:Harbour College", "referee_phone:0400 111 222", "referee_signature:"],
    "the referee's fields are prefilled where the form gave them and editable");
  assert.equal(onboarding.answerKey("agent_agency_name_referee"), "agent_agency_name");
  assert.equal(onboarding.STAGE_LABEL.references_pending, "Waiting for referees");
});
test("agent onboarding (staged): the form goes alone; signing it sends a prefilled referee check to each referee; the agreement needs References received or a reason; a changed email voids and resends; an uploaded form counts and staff are told", async () => {
  const stored = new Map<string, Uint8Array>(); const saved: Array<Record<string, unknown>> = []; const rpcs: Array<[string, Record<string, unknown>]> = []; const services: Array<[string, Record<string, unknown>]> = [];
  const created: Array<Record<string, unknown>> = []; const sent: string[] = []; const voided: string[] = []; const mails: Array<{ to: string; subject: string; textBody: string }> = []; let n = 0;
  const templates = () => saved.map((t) => ({ id: t.id, systemKey: t.__key, status: "active", sourcePath: t.source_path, sourceHash: t.source_hash, sourcePages: t.source_pages, fields: t.fields, expiryDays: 30, reminderDays: 3 }));
  const refereeTemplate = () => templates().find((t) => t.systemKey === "agent_referee_check_form") ?? null;
  const referees = [
    { id: "40000000-0000-4000-8000-000000000001", position: 1, name: "Priya Nair", organisation: "Harbour College", positionTitle: "Admissions Lead", email: "priya@example.test", phone: "0400 111 222", address: "2 Harbour Rd", status: "pending", requestId: null as string | null },
    { id: "40000000-0000-4000-8000-000000000002", position: 2, name: "Sam Lee", organisation: "Metro Institute", positionTitle: "", email: "sam@example.test", phone: "0400 333 444", address: "", status: "pending", requestId: null as string | null },
  ];
  const state = { stage: "application_sent", notifiedAgent: false, notifiedStaff: false };
  const openOnboarding = new Set<string>();
  const follow = () => ({ id: "20000000-0000-4000-8000-000000000001", stage: state.stage, agency: { id: "30000000-0000-4000-8000-000000000001", name: "Acme Education Pty Ltd" },
    agent: { id: "10000000-0000-4000-8000-000000000001", name: "Ravi Kumar", email: "ravi@example.test" }, sentBy: { email: "hari@example.test", name: "Hari Admin" }, contacts: ["admissions@example.test"],
    values: { agent_agency_name: "Acme Education Pty Ltd", agent_office_address: "1 Test St, Melbourne, VIC, 3000, Australia" }, referees: referees.map((r) => ({ ...r })),
    received: referees.filter((r) => r.status === "received").length, total: referees.length, template: refereeTemplate(), notified: { agentReferees: state.notifiedAgent, staffReferences: state.notifiedStaff } });
  const ports = { isServiceCaller: false, later: (work: Promise<unknown>) => work.then(() => undefined), letterhead: async () => null, uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    admin: async (action: string, id: string | null, data: Record<string, unknown>) => {
      if (action === "subject_search") return [];
      if (action === "template_save") throw new Error("the blanks install through agency_onboarding_template_install, not template_save");
      if (action === "create") { created.push({ ...data, id }); return { id, reference: `SLIT-2026-00${created.length}` }; }
      if (action === "send") { sent.push(id!); return { id, state: "sent" }; }
      if (action === "void") { voided.push(id!); return { id, state: "void" }; }
      throw new Error(`unexpected ${action}`);
    },
    callerRpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push([name, args]);
      if (name === "agency_onboarding_template_install") {
        // The database's claim of the key: the first insert wins (unique index), every later call reuses it.
        const key = String(args.p_key); const have = saved.find((t) => t.__key === key);
        if (have && (args.p_data as Record<string, unknown> | null)?.refresh === true) {
          const d = args.p_data as Record<string, unknown>; Object.assign(have, { fields: d.fields, source_path: d.source_path, source_hash: d.source_hash, source_pages: d.source_pages, version: Number(have.version ?? 1) + 1 });
          return { id: have.id, systemKey: key, reused: false, refreshed: true, fields: (d.fields as unknown[]).length, pages: d.source_pages, status: "active", version: have.version };
        }
        if (have) return { id: have.id, systemKey: key, reused: true, fields: (have.fields as unknown[]).length, pages: have.source_pages, status: "active" };
        if (!args.p_data) return null;
        const d = args.p_data as Record<string, unknown>; saved.push({ ...d, __key: key });
        return { id: d.id, systemKey: key, reused: false, fields: (d.fields as unknown[]).length, pages: d.source_pages, status: "active" };
      }
      if (name === "agency_onboarding_templates") return templates();
      if (name === "agency_onboarding_prepare") return { agency: { id: args.p_agency, name: "Acme Education Pty Ltd", abn: null }, agent: { id: (args.p_agent as string | null) ?? "10000000-0000-4000-8000-000000000001", name: "Ravi Kumar", email: "ravi@example.test" },
        admin: { name: "Hari Admin", position: "", signaturePng: null }, values: { agent_agency_name: "Acme Education Pty Ltd", agent_organisation_name: "Acme Education Pty Ltd", contact_email: "ravi@example.test", agent_signatory_name: "Ravi Kumar", declarant_name: "Ravi Kumar" } };
      if (name === "agency_onboarding_create") {
        // One open onboarding per business (unique index): a second F04 for the same business is refused.
        if (openOnboarding.has(String(args.p_agency))) throw { message: "This business already has an onboarding in progress. Cancel its open request first, or continue it." };
        openOnboarding.add(String(args.p_agency)); return { id: "20000000-0000-4000-8000-000000000001", reference: "SLIT-2026-001", stage: "application_sent" };
      }
      if (name === "admin_business_create") return { agencyId: "30000000-0000-4000-8000-000000000002", businessId: "30000000-0000-4000-8000-000000000002", agencyName: String((args.p_agency as Record<string, unknown>).name), contactAgentId: "10000000-0000-4000-8000-000000000002" };
      if (name === "agency_onboarding_presend_save") return { onboardingId: "22000000-0000-4000-8000-000000000001", savedAt: "2026-11-20T00:00:00Z", contact: { id: (args.p_data as { agentId: string }).agentId, name: "Pat Contact", email: "zz-test-poc@blackhole.postmarkapp.com" } };
      if (name === "agency_onboarding_agreement_create") {
        const d = args.p_data as Record<string, unknown>;
        if (state.stage !== "references_received" && !(typeof d.override_reason === "string" && d.override_reason.length >= 5)) throw { message: "Give a reason for sending the agreement before both references are back" };
        state.stage = "agreement_sent"; return { id: args.p_onboarding, stage: "agreement_sent", override: !!d.override_reason };
      }
      if (name === "agency_onboarding_referee_change_email") { const r = referees.find((x) => x.id === args.p_referee)!; const prev = r.requestId; r.email = String(args.p_email); r.status = "pending"; r.requestId = null; return { id: r.id, onboardingId: "20000000-0000-4000-8000-000000000001", previousRequestId: prev, email: r.email }; }
      if (name === "agency_onboarding_referee_upload") { const r = referees.find((x) => x.id === args.p_referee)!; const prev = r.requestId; r.status = "received"; state.stage = referees.every((x) => x.status === "received") ? "references_received" : "references_pending"; return { id: r.id, onboardingId: "20000000-0000-4000-8000-000000000001", previousRequestId: prev, stage: state.stage, base64Length: String(args.p_base64).length }; }
      throw new Error(`unexpected rpc ${name}`);
    },
    serviceRpc: async (name: string, args: Record<string, unknown>) => {
      services.push([name, args]);
      if (name === "agency_onboarding_followup") return follow();
      if (name === "agency_onboarding_referee_request_create") { const r = referees.find((x) => x.id === args.p_referee)!; r.status = "sent"; r.requestId = String((args.p_data as Record<string, unknown>).id); state.stage = "references_pending"; return { requestId: r.requestId, reference: `SLIT-2026-R${r.position}` }; }
      if (name === "agency_onboarding_mark_notified") { if (args.p_kind === "agent_notified_referees") state.notifiedAgent = true; else state.notifiedStaff = true; return null; }
      throw new Error(`unexpected service ${name}`);
    },
    service: async (action: string) => { if (action === "notify_claim") return []; if (action === "path_referenced") return false; return true; },
    storage: { download: async (p: string) => stored.get(p) ?? null, upload: async (p: string, bytes: Uint8Array) => { stored.set(p, bytes); return true; }, remove: async (paths: string[]) => { for (const p of paths) stored.delete(p); }, signedUrl: async () => null },
    mail: { provider: { id: "mock", send: async (m: { to: string; subject: string; textBody: string }) => { mails.push(m); return { kind: "accepted" as const, messageId: `m-${mails.length}` }; } }, config: { from: { name: "SLIT", email: "noreply@example.test" }, adminTo: ["admin@example.test"], siteUrl: "https://site.example.test", problems: [] } },
  } as unknown as Parameters<typeof signingCore.handleSigning>[1];
  const call = (body: Record<string, unknown>, upload: { name: string; bytes: Uint8Array } | null = null) => signingCore.handleSigning({ body, upload, ip: null, userAgent: null }, ports);
  const install = (which: "form" | "referee" | "agreement") => call({ action: "agent_onboarding_install", which }, { name: `${which}.pdf`, bytes: blankBytes(which) }) as Promise<{ id: string; reused: boolean }>;
  for (const which of ["form", "referee"] as const) await install(which);
  // Two sends installing the agreement at once: both upload, the database gives the key to one, the other reuses it and drops its file.
  const [winner, loser] = await Promise.all([install("agreement"), install("agreement")]);
  assert.equal(winner.id, loser.id, "two concurrent installs end with the same template");
  assert.deepEqual([winner.reused, loser.reused], [false, true], "the first claims the key, the second reuses it");
  // Installing again (the CMS retries on every "missing" error) reuses the template without a new row or a new file.
  const reinstall = await install("form");
  assert.ok(reinstall.reused && reinstall.id === saved[0].id, "a second install of the form reuses the first template");
  assert.deepEqual(saved.map((t) => `${t.__key}:${(t.roles as Array<{ key: string }>)[0].key}`), ["agent_application_form:agent", "agent_referee_check_form:referee", "agent_agreement:agent"], "three blanks, one template per key, the referee check signed by a referee");
  assert.equal([...stored.keys()].filter((p) => p.startsWith("templates/")).length, 3, "one stored source per template: the losing upload was removed");
  assert.ok(saved.every((t) => stored.has(String(t.source_path))), "every template's source is the stored one");
  // A corrected blank: refresh replaces the file and the fields of the same template (version + 1), never a new row.
  const beforeRefresh = { id: saved[2].id, source: String(saved[2].source_path) };
  const refreshed = await call({ action: "agent_onboarding_install", which: "agreement", refresh: true }, { name: "agreement.pdf", bytes: blankBytes("agreement") }) as { id: string; refreshed: boolean; version: number; pages: number };
  assert.ok(refreshed.refreshed && refreshed.id === beforeRefresh.id && refreshed.version === 2 && refreshed.pages === 13, "the agreement template is refreshed in place at version 2");
  assert.equal(saved.length, 3, "still three templates"); assert.notEqual(saved[2].source_path, beforeRefresh.source, "with a new source file");
  assert.ok(String(saved[2].source_path).startsWith(`templates/${beforeRefresh.id}/`), "stored under the template's own id (the kind_source check)");
  assert.ok(stored.has(String(saved[2].source_path)) && [...stored.keys()].filter((p) => p.startsWith("templates/")).length === 4, "the new source is stored (the old one stays for requests already sent)");
  // Stage 1: the application form alone.
  const sentForm = await call({ action: "agent_onboarding_send_application", agencyId: "30000000-0000-4000-8000-000000000001", message: "Welcome" }) as { id: string; sent: boolean; stage: string };
  assert.ok(sentForm.sent && sentForm.stage === "application_sent" && sent.includes(sentForm.id));
  const form = created[0] as { title: string; fields: Array<{ key: string; page: number }>; category: string };
  assert.equal(form.title, "Agent application form: Acme Education Pty Ltd");
  assert.ok(form.fields.every((f) => f.page <= 2) && form.fields.some((f) => f.key === "ref2_email") && !form.fields.some((f) => f.key === "agent_signature"), "only the form's 2 pages and fields, no agreement");
  assert.equal((await PdfLib.PDFDocument.load(stored.get(`${sentForm.id}/original.pdf`)!)).getPageCount(), 2);
  assert.equal((rpcs.find(([name]) => name === "agency_onboarding_create")![1].p_data as Record<string, unknown>).form_pages, 2);
  // The agent signs the form: the link-holder path completes it and the referee checks go out by themselves.
  const original = stored.get(`${sentForm.id}/original.pdf`)!; const originalHash = await signingCore.sha256Hex(original);
  const recipient = { id: "r1", name: "Ravi Kumar", email: "ravi@example.test", role: "Agent", state: "sent" };
  const fieldRows = form.fields.map((f, i) => ({ id: `f${i}`, recipient_id: "r1", type: (f as { type: string }).type, page: f.page, x: 0.5, y: 0.8, w: 0.3, h: 0.03, label: f.key, key: f.key, value: (f as { value: string }).value, required: (f as { required: boolean }).required }));
  const record = { id: sentForm.id, state: "sent", original_hash: originalHash, recipient, fields: fieldRows, signers: [], onboarding: { id: "20000000-0000-4000-8000-000000000001", kind: "application", formPages: 2 } };
  let signData: Record<string, unknown> | null = null;
  const linkPorts = { ...ports, service: async (action: string, args: { data?: Record<string, unknown> }) => {
    if (action === "rate") return true;
    if (action === "open") return record;
    if (action === "sign_plan") return { id: sentForm.id, reference: "SLIT-2026-001", title: form.title, revision: 1, complete: true, signed_at: "2026-11-17T01:00:00Z", original_path: `${sentForm.id}/original.pdf`, original_hash: originalHash,
      created_at: "2026-11-17T00:00:00Z", sent_at: "2026-11-17T00:01:00Z", signing_mode: "sequential", recipient_id: "r1", chain_ok: true, offer: false, onboarding: record.onboarding,
      fields: fieldRows.map((f) => ({ ...f, done: true, value: f.type === "checkbox" ? String((args.data?.values as Record<string, string>)?.[f.id] === "true") : f.type === "date" ? "17/11/2026" : ((args.data?.values as Record<string, string>)?.[f.id] ?? f.value ?? "") })),
      recipients: [{ ...recipient, state: "signed", signer_name: "Ravi Kumar", signed_at: "2026-11-17T01:00:00Z", signature_kind: "typed" }], events: [] };
    if (action === "sign") { signData = args.data ?? null; state.stage = "application_signed"; return { state: "signed" }; }
    if (action === "notify_claim") return [];
    if (action === "path_referenced") return false;
    throw new Error(`unexpected ${action}`);
  } } as typeof ports;
  const values = Object.fromEntries(fieldRows.filter((f) => f.type === "text").map((f) => [f.id, f.value || "x"]));
  values[fieldRows.find((f) => f.key === "litigation_involved:NO")!.id] = "true"; values[fieldRows.find((f) => f.key === "eatc_completed:YES")!.id] = "true";
  // The title is chosen from the list since 2026-11-19 (ABN prefill brief): a free-text "x" is refused.
  const titleField = fieldRows.find((f) => f.key === "contact_title"); if (titleField) values[titleField.id] = "Mr";
  // The two referees need different emails (2026-11-19).
  for (const n of [1, 2]) { const email = fieldRows.find((f) => f.key === `ref${n}_email`); if (email) values[email.id] = referees[n - 1].email; }
  // 2026-11-19: referees are other people with their own phones (E.164 kept); a postcode in Province moves to the Suburb box.
  const setKey = (key: string, value: string) => { const f = fieldRows.find((x) => x.key === key); if (f) values[f.id] = value; };
  for (const n of [1, 2]) { setKey(`ref${n}_contact_name`, referees[n - 1].name); setKey(`ref${n}_phone`, referees[n - 1].phone); }
  setKey("contact_given_name", "Ravi"); setKey("contact_family_name", "Kumar"); setKey("declarant_name", "Ravi Kumar"); setKey("contact_phone", "0412 345 678"); setKey("contact_email", "ravi@example.test");
  setKey("office_suburb", "Footscray"); setKey("office_province", "3011");
  // F04 wizard (2026-11-19): the sign step needs every declaration ticked and a MARN of digits; it prints "ACN … / MARN …" in the registration box.
  const signAs = (application: unknown) => signingCore.handleSigning({ body: { action: "sign", token: "c".repeat(64), name: "Ravi Kumar", agreed: true, values: { ...values }, documentHash: originalHash, application }, upload: null, ip: "203.0.113.9", userAgent: "test" }, linkPorts);
  const allTicked = Object.fromEntries(onboarding.F04_DECLARATIONS.map((d) => [d.key, true]));
  await assert.rejects(signAs(undefined), /complete every step/, "no wizard answers: refused");
  await assert.rejects(signAs({ acn: "", marn: "", declarations: { ...allTicked, code_of_ethics: false } }), /Tick every declaration statement before you sign \(1 not ticked\)/);
  await assert.rejects(signAs({ acn: "", marn: "12AB", declarations: allTicked }), /MARN is a number: digits only/);
  await assert.rejects(signAs({ acn: "60358467", marn: "", declarations: allTicked }), /ACN has 9 digits/);
  const signed = await signAs({ acn: "603584676", marn: "1234567", declarations: allTicked }) as { signed: boolean; complete: boolean };
  assert.ok(signed.signed && signed.complete);
  assert.equal((signData as unknown as { form_base64?: string }).form_base64, undefined, "a staged request is not split: its signed PDF is the document");
  const registrationBox = fieldRows.find((f) => f.key === "agent_registration_number");
  if (registrationBox) assert.equal((signData as unknown as { values: Record<string, string> }).values[registrationBox.id], "ACN 603 584 676 / MARN 1234567", "the registration box prints the ACN and the MARN");
  const signedValue = (key: string) => (signData as unknown as { values: Record<string, string> }).values[fieldRows.find((f) => f.key === key)!.id];
  assert.deepEqual([signedValue("office_province"), signedValue("office_suburb")], ["", "Footscray 3011"], "office_province never holds a postcode: it is printed in the Suburb box");
  assert.deepEqual([signedValue("ref1_phone"), signedValue("ref2_phone"), signedValue("contact_phone")], ["+61400111222", "+61400333444", "+61412345678"], "phones are kept as E.164");
  const extra = services.find(([name]) => name === "agency_onboarding_application_extra");
  assert.deepEqual(extra && [(extra[1].p_data as { agent_acn: string }).agent_acn, (extra[1].p_data as { agent_marn: string }).agent_marn, Object.keys((extra[1].p_data as { declarations: object }).declarations).length], ["603584676", "1234567", 5], "the ACN, the MARN and the declarations are kept");
  const refereeCreates = services.filter(([name]) => name === "agency_onboarding_referee_request_create");
  assert.equal(refereeCreates.length, 2, "one referee check per referee, sent when the form was signed");
  const first = refereeCreates[0][1].p_data as { title: string; message: string; fields: Array<{ key: string; role: string; value: string; required: boolean }>; original_hash: string; id: string };
  assert.equal(refereeCreates[0][1].p_referee, referees[0].id);
  assert.match(first.title, /^Agent referee check: Acme Education Pty Ltd \(reference 1\)/);
  assert.match(first.message, /Ravi Kumar of Acme Education Pty Ltd .* named you as a referee/);
  assert.ok(first.fields.every((f) => f.role === "referee") && first.fields.find((f) => f.key === "referee_organisation")!.value === "Harbour College" && first.fields.find((f) => f.key === "referee_contact_person_1")!.value === "Priya Nair, Admissions Lead", "prefilled from the form's reference 1, editable");
  assert.ok(!first.fields.some((f) => f.key === "referee_email"), "the referee's email is printed, not editable");
  const refereeText = (await pdfText(stored.get(`${first.id}/original.pdf`)!)).map((t) => t.text).join(" ");
  assert.ok(refereeText.includes("priya@example.test") && refereeText.includes("Acme Education Pty Ltd") && refereeText.includes("1 Test St, Melbourne"), "the F05 prints the agency, its office address and the referee's email");
  assert.equal(await signingCore.sha256Hex(stored.get(`${first.id}/original.pdf`)!), first.original_hash);
  assert.ok(mails.some((m) => m.to === "ravi@example.test" && /referees have been contacted/i.test(m.subject) && m.textBody.includes("Priya Nair (Harbour College) and Sam Lee (Metro Institute)")), "the agent is told once");
  assert.ok(state.notifiedAgent && services.some(([name, a]) => name === "agency_onboarding_mark_notified" && a.p_kind === "agent_notified_referees"));
  assert.equal(state.stage, "references_pending");
  // Stage 3 is gated: no reason, no agreement; a reason passes it to the database and is reported.
  const agreementInput = { action: "agent_onboarding_send_agreement", agencyId: "30000000-0000-4000-8000-000000000001", onboardingId: "20000000-0000-4000-8000-000000000001", commencementDate: "2026-11-17", territory: "India", commissionPercent: "25", adminPosition: "CEO", adminSignature: { kind: "typed", name: "Hari Admin" } };
  await assert.rejects(call(agreementInput), /Give a reason for sending the agreement/);
  assert.equal(stored.size, 4 + 1 + 2 + 2, "the refused agreement's PDF is removed again (four sources after the refresh, the form, two referee checks, the signed form and its certificate stay)");
  // A referee's email changes: the old request is voided and a new check goes out.
  const changed = await call({ action: "agent_onboarding_referee_change", refereeId: referees[1].id, email: "sam.lee@newplace.test", name: "Sam Lee" }) as { sent: number; email: string };
  assert.ok(changed.sent === 1 && changed.email === "sam.lee@newplace.test" && voided.length === 1 && voided[0] === (refereeCreates[1][1].p_data as { id: string }).id, "the old request is voided");
  assert.equal(services.filter(([name]) => name === "agency_onboarding_referee_request_create").length, 3);
  assert.equal(mails.filter((m) => /referees have been contacted/i.test(m.subject)).length, 1, "the agent is not told again");
  // Reference 1 arrives by email: staff upload it; reference 2 is also uploaded, so both are in and staff are told once.
  const pdf = await PdfLib.PDFDocument.create(); pdf.addPage([595.28, 841.89]); const uploadBytes = await pdf.save();
  const up1 = await call({ action: "agent_onboarding_referee_upload", refereeId: referees[0].id }, { name: "ref1.pdf", bytes: uploadBytes }) as { stage: string; notified: boolean };
  assert.ok(up1.stage === "references_pending" && up1.notified === false && voided.length === 2, "the first upload voids its open request; nothing to tell staff yet");
  const up2 = await call({ action: "agent_onboarding_referee_upload", refereeId: referees[1].id }, { name: "ref2.pdf", bytes: uploadBytes }) as { stage: string; notified: boolean };
  assert.ok(up2.stage === "references_received" && up2.notified === true);
  // 2026-11-18: both referees back = Ready for review (the staff email's subject).
  const staffMail = mails.find((m) => /Ready for review/.test(m.subject))!;
  assert.ok(staffMail && staffMail.to.includes("hari@example.test") && staffMail.to.includes("admissions@example.test") && !staffMail.to.includes("admin@example.test"), "the staff member who started it and the admissions contact");
  assert.ok(state.notifiedStaff);
  await assert.rejects(call({ action: "agent_onboarding_referee_upload", refereeId: referees[0].id }, { name: "x.pdf", bytes: new TextEncoder().encode("not a pdf") }), /PDF/i);
  // Now the agreement goes without a reason, prefilled as before.
  const agreement = await call(agreementInput) as { sent: boolean; stage: string; override: boolean; id: string };
  assert.ok(agreement.sent && agreement.stage === "agreement_sent" && agreement.override === false);
  const agreementCreate = rpcs.filter(([name]) => name === "agency_onboarding_agreement_create").pop()![1].p_data as Record<string, unknown>;
  assert.equal(agreementCreate.override_reason, null); assert.equal(agreementCreate.expiry_date, "2028-11-16");
  const agreementText = await pdfText(stored.get(`${agreement.id}/original.pdf`)!);
  assert.ok(agreementText.some((t) => t.page === 11 && t.text.includes("India")) && agreementText.some((t) => t.page === 1 && t.text.includes("Acme Education Pty Ltd")), "the agreement prints Items 3 to 5 and the agency");
  // Earlier with a reason: the override goes to the database.
  state.stage = "references_pending";
  const early = await call({ ...agreementInput, overrideReason: "Referee 2 confirmed by phone" }) as { override: boolean };
  assert.equal(early.override, true);
  assert.equal((rpcs.filter(([name]) => name === "agency_onboarding_agreement_create").pop()![1].p_data as Record<string, unknown>).override_reason, "Referee 2 confirmed by phone");

  // Add business (2026-11-20): the business and its point of contact are saved with a DRAFT onboarding; nothing is emailed until staff
  // send it from the pre-send step.
  const sentBefore = sent.length, mailsBefore = mails.length;
  const added = await call({ action: "agent_onboarding_business_create", agency: { name: "ZZ Test Agency", code: "ZZ-TEST", registration_number: "11111111111" }, contactEmail: "ZZ-Test-POC@blackhole.postmarkapp.com", contactName: "Pat Contact" }) as { agencyId: string; application: unknown; presend: boolean; onboardingId: string | null; warning?: string };
  assert.ok(added.presend && added.application === null && added.onboardingId === "22000000-0000-4000-8000-000000000001" && !added.warning, "a draft is opened for the pre-send step");
  assert.deepEqual(rpcs.filter(([name]) => name === "admin_business_create").map(([, a]) => [a.p_contact_email, a.p_contact_name]), [["zz-test-poc@blackhole.postmarkapp.com", "Pat Contact"]]);
  assert.equal((rpcs.filter(([name]) => name === "agency_onboarding_presend_save").pop()![1].p_data as { agentId: string }).agentId, "10000000-0000-4000-8000-000000000002", "the draft is for the point of contact");
  assert.equal(sent.length, sentBefore, "no application form is sent by Add business"); assert.equal(mails.length, mailsBefore, "and nothing is emailed");
  // The earlier action (an F04 alone) still refuses a second application for a business already in progress.
  const voidedBefore = voided.length;
  await assert.rejects(call({ action: "agent_onboarding_send_application", agencyId: "30000000-0000-4000-8000-000000000001" }), /already has an onboarding in progress/);
  assert.equal(sent.length, sentBefore, "no second F04"); assert.equal(voided.length, voidedBefore + 1, "the unsent draft is voided");
  // A bad contact is refused before anything is saved.
  await assert.rejects(call({ action: "agent_onboarding_business_create", agency: { name: "X" }, contactEmail: "not-an-email", contactName: "Pat" }), /email address/);
  assert.equal(rpcs.filter(([name]) => name === "admin_business_create").length, 1);
});

test("sign once (2026-11-20): staff pre-fill the F04 and the agreement terms; Send makes ONE request (F04 + P06) with every Yes / No at No and no references; the agency admin signs once with a drawn witness; the signed PDF is split; Approve without referees countersigns and issues the agreement and emails it", async () => {
  const stored = new Map<string, Uint8Array>(); const saved: Array<Record<string, unknown>> = []; const rpcs: Array<[string, Record<string, unknown>]> = []; const services: Array<[string, Record<string, unknown>]> = [];
  const created: Array<Record<string, unknown>> = []; const sent: string[] = []; const mails: Array<{ to: string; subject: string; textBody: string; attachments?: Array<{ name: string; contentBase64: string }> }> = []; let n = 0;
  const agencyId = "32000000-0000-4000-8000-000000000001", onboardingId = "22000000-0000-4000-8000-000000000009";
  const contact = { id: "12000000-0000-4000-8000-000000000001", name: "Ravi Kumar", email: "ravi@example.test" };
  const state = { stage: "draft", presend: null as Record<string, unknown> | null, notifiedAgent: false };
  const referees = [1, 2].map((p) => ({ id: `42000000-0000-4000-8000-00000000000${p}`, position: p, name: p === 1 ? "Priya Nair" : "Sam Lee", organisation: "Harbour College", positionTitle: "", email: `ref${p}@example.test`, phone: "+61400111222", address: "", status: "pending", requestId: null as string | null }));
  const templates = () => saved.map((t) => ({ id: t.id, systemKey: t.__key, status: "active", sourcePath: t.source_path, sourceHash: t.source_hash, sourcePages: t.source_pages, fields: t.fields, expiryDays: 30, reminderDays: 3 }));
  const follow = () => ({ id: onboardingId, kind: "business", combined: true, stage: state.stage, agency: { id: agencyId, name: "Acme Education Pty Ltd" }, agent: contact, sentBy: { email: "hari@example.test", name: "Hari Admin" }, contacts: [], admins: [],
    values: { agent_agency_name: "Acme Education Pty Ltd", agent_office_address: "1 Test St" }, referees: referees.map((r) => ({ ...r })), received: 0, total: 2, template: templates().find((t) => t.systemKey === "agent_referee_check_form") ?? null,
    notified: { agentReferees: state.notifiedAgent, staffReferences: false } });
  let signData: Record<string, unknown> | null = null;
  const blankCache = new Map<string, { path: string; sha256: string }>(); const queued: string[] = [];
  const split = { pending: true, form: "", agreement: "" }; const signedRequest = { id: "", path: "", hash: "" };
  const ports = { isServiceCaller: false, later: (work: Promise<unknown>) => work.then(() => undefined), letterhead: async () => null, uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    admin: async (action: string, id: string | null, data: Record<string, unknown>) => {
      if (action === "subject_search") return [];
      if (action === "create") { created.push({ ...data, id }); return { id, reference: `SLIT-2026-10${created.length}` }; }
      if (action === "send") { sent.push(id!); return { id, state: "sent" }; }
      throw new Error(`unexpected ${action}`);
    },
    callerRpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push([name, args]);
      if (name === "agency_onboarding_template_install") {
        const key = String(args.p_key); const have = saved.find((t) => t.__key === key);
        if (have) return { id: have.id, systemKey: key, reused: true, fields: (have.fields as unknown[]).length, pages: have.source_pages, status: "active" };
        if (!args.p_data) return null;
        const d = args.p_data as Record<string, unknown>; saved.push({ ...d, __key: key }); return { id: d.id, systemKey: key, reused: false, fields: (d.fields as unknown[]).length, pages: d.source_pages, status: "active" };
      }
      if (name === "agency_onboarding_templates") return templates();
      if (name === "agency_onboarding_prepare") return { agency: { id: agencyId, name: "Acme Education Pty Ltd", abn: "51824753556" }, agent: contact, admin: { name: "Hari Admin", position: "CEO", signaturePng: null },
        values: { agent_agency_name: "Acme Education Pty Ltd", contact_email: contact.email, agent_website: "acme.example.test" } };
      if (name === "agency_abr_get") return null;
      // The business's ACN kept by the database (2026-11-20).
      if (name === "agency_acn_sync") return { acn: "603584676", source: "register" };
      if (name === "agency_onboarding_presend_get") return { onboardingId: state.presend ? onboardingId : null, stage: state.presend ? "draft" : null, openStage: state.stage === "draft" ? null : state.stage,
        agency: { id: agencyId, name: "Acme Education Pty Ltd", abn: "51824753556", status: "Onboarding" }, contact, presend: (state.presend?.presend ?? null) as Record<string, unknown> | null,
        terms: { commencementDate: state.presend?.commencementDate ?? null, territory: state.presend?.territory ?? "", commissionPercent: state.presend?.commissionPercent ?? null }, witness: { name: null, png: null }, savedAt: null, savedBy: null };
      if (name === "agency_onboarding_presend_save") {
        const d = args.p_data as Record<string, unknown>;
        state.presend = { ...d, presend: { answers: d.answers, acn: d.acn, marn: d.marn } };
        return { onboardingId, savedAt: "2026-11-20T00:00:00Z", contact };
      }
      if (name === "agency_onboarding_presend_send") { state.stage = "application_sent"; return { id: onboardingId, requestId: args.p_request, reference: "SLIT-2026-101", stage: "application_sent" }; }
      if (name === "agency_onboarding_prefill_record" || name === "agency_abr_facts_record") return null;
      // The merged blank cache (2026-11-20): one entry per pair of template versions; a second put is told which file is the one.
      if (name === "agency_onboarding_blank_cache_get") return blankCache.get(String(args.p_key)) ?? null;
      if (name === "agency_onboarding_blank_cache_put") { const have = blankCache.get(String(args.p_key)); if (have) return { ...have, mine: false }; const row = { path: String(args.p_path), sha256: String(args.p_sha256) }; blankCache.set(String(args.p_key), row); return { ...row, mine: true }; }
      if (name === "agency_onboarding_approve") { state.stage = "references_approved"; return { id: onboardingId, stage: state.stage, agencyStatus: "Active", combined: true, refereesPending: 2, slitWitness: true }; }
      if (name === "agency_onboarding_file") return { name: "Acme - Agent Agreement (signed).pdf", base64: split.agreement };
      // 2026-11-21: the SLIT signatory stored when the application was sent (Approve does not stamp it again).
      if (name === "agency_onboarding_review_get") { const d = rpcs.find(([k]) => k === "agency_onboarding_presend_send")?.[1].p_data as Record<string, string> | undefined;
        return { slitSignatory: d ? { organisation: "INDOPACIFIC GLOBAL PTY LTD", name: d.admin_name, position: d.admin_position, kind: d.slit_signature_kind, image: null, typed: d.slit_signature, signedOn: d.signed_on } : null }; }
      if (name === "agency_onboarding_agreement_issue") { state.stage = "agreement_signed"; return { stage: "agreement_signed", name: "Acme Education Pty Ltd", commencementDate: "2026-12-01", expiryDate: "2028-11-30", contact }; }
      throw new Error(`unexpected rpc ${name}`);
    },
    serviceRpc: async (name: string, args: Record<string, unknown>) => {
      services.push([name, args]);
      if (name === "agency_onboarding_followup") return follow();
      if (name === "agency_onboarding_referee_request_create") { const r = referees.find((x) => x.id === args.p_referee)!; r.status = "sent"; r.requestId = String((args.p_data as { id: string }).id); state.stage = "references_pending"; return { requestId: r.requestId }; }
      if (name === "agency_onboarding_mark_notified") { state.notifiedAgent = true; return null; }
      if (name === "agency_onboarding_application_extra" || name === "agency_onboarding_witness_record") return null;
      if (name === "agency_business_release") return { released: true, name: "Acme Education Pty Ltd", invitations: [] };
      // The follow-up calls (2026-11-20): queued by the database; the test runs them itself (runFollowups).
      if (name === "agency_onboarding_followup_queue") { queued.push(String(args.p_step)); return queued.length; }
      if (name === "agency_onboarding_split_source") return { pending: split.pending, requestId: signedRequest.id, state: "signed", path: signedRequest.path, hash: signedRequest.hash, formPages: 2 };
      if (name === "agency_onboarding_split_store") { split.form = String(args.p_form); split.agreement = String(args.p_agreement); split.pending = false; return { stored: true }; }
      throw new Error(`unexpected service ${name}`);
    },
    service: async (action: string) => { if (action === "notify_claim") return []; if (action === "path_referenced") return false; return true; },
    storage: { download: async (p: string) => stored.get(p) ?? null, upload: async (p: string, bytes: Uint8Array) => { stored.set(p, bytes); return true; }, remove: async (paths: string[]) => { for (const p of paths) stored.delete(p); }, signedUrl: async () => null },
    mail: { provider: { id: "mock", send: async (m: { to: string; subject: string; textBody: string }) => { mails.push(m); return { kind: "accepted" as const, messageId: `m-${mails.length}` }; } }, config: { from: { name: "SLIT", email: "noreply@example.test" }, adminTo: ["admin@example.test"], siteUrl: "https://site.example.test", problems: [] } },
  } as unknown as Parameters<typeof signingCore.handleSigning>[1];
  const call = (body: Record<string, unknown>) => signingCore.handleSigning({ body, upload: null, ip: null, userAgent: null }, ports);
  for (const which of ["form", "referee", "agreement"] as const) await signingCore.handleSigning({ body: { action: "agent_onboarding_install", which }, upload: { name: `${which}.pdf`, bytes: blankBytes(which) }, ip: null, userAgent: null }, ports);

  // The pre-send step: a draft keeps what staff typed; a witness name without a drawn signature is refused (never typed).
  await assert.rejects(call({ action: "agent_onboarding_presend_save", agencyId, data: { witnessName: "Jo Witness" } }), /must draw their signature/);
  await call({ action: "agent_onboarding_presend_save", agencyId, data: { answers: { contact_title: "Mr", contact_position: "Director", agent_website: "https://acme.example.test", ref1_email: "x@example.test" } } });
  assert.deepEqual((state.presend!.answers as Record<string, string>), { contact_title: "Mr", contact_position: "Director", agent_website: "https://acme.example.test" }, "the references are never pre-filled by staff");
  const opened = await call({ action: "agent_onboarding_presend_open", agencyId }) as { fields: Array<{ key: string; value: string }>; terms: { territory: string } };
  const openedValue = (key: string) => opened.fields.find((f) => f.key === key)?.value;
  assert.deepEqual([openedValue("litigation_involved:NO"), openedValue("litigation_involved:YES"), openedValue("works_with_sub_agents:NO"), openedValue("eatc_completed:NO")], ["true", "", "true", "true"], "every Yes / No question opens at No");
  assert.equal(openedValue("contact_title"), "Mr", "what staff saved is shown again");
  assert.equal((opened as unknown as { acn: string }).acn, "603584676", "Prepare application shows the business's ACN");
  // Send needs the agreement terms.
  await assert.rejects(call({ action: "agent_onboarding_presend_send", agencyId, data: { answers: {}, commencementDate: "2026-12-01", commissionPercent: "25" } }), /territory/);
  // 2026-11-21: GST inclusive / exclusive is required (never guessed) and must be one of the two; SLIT staff set it in Prepare application only.
  await assert.rejects(call({ action: "agent_onboarding_presend_send", agencyId, data: { answers: {}, commencementDate: "2026-12-01", territory: "India, Nepal", commissionPercent: "25" } }), /GST inclusive or GST exclusive/);
  await assert.rejects(call({ action: "agent_onboarding_presend_save", agencyId, data: { commissionGst: "maybe" } }), /GST inclusive or GST exclusive/);
  const sentApp = await call({ action: "agent_onboarding_presend_send", agencyId, data: { answers: { contact_title: "Mr", contact_position: "Director" }, commencementDate: "2026-12-01", territory: "India, Nepal", commissionPercent: "25", commissionGst: "exclusive",
    adminName: "Hari Admin", adminPosition: "Chief Executive Officer", adminSignature: { kind: "typed", name: "Hari Admin" }, witnessName: "Sue Witness", witnessPng: PNG_1PX } }) as { id: string; sent: boolean; combined: boolean; slitWitness: boolean };
  assert.ok(sentApp.sent && sentApp.combined && sentApp.slitWitness && sent.length === 1, "one request, emailed to the point of contact");
  const original = stored.get(`${sentApp.id}/original.pdf`)!;
  assert.equal((await PdfLib.PDFDocument.load(original)).getPageCount(), 15, "the F04's 2 pages followed by the P06's 13");
  const request = created[0] as { title: string; fields: Array<{ key: string; page: number; type: string; value: string; required: boolean }> };
  const field = (key: string) => request.fields.find((f) => f.key === key);
  assert.ok(field("agent_signature_form")!.page <= 2 && field("agent_signature")!.page > 2 && field("agent_signature")!.type === "signature", "one signer, a signature box on each document");
  assert.ok(field("agent_witness_name")?.required && !field("agent_witness_signature"), "the witness name is the agency admin's to give; the witness signature is never a typing field");
  assert.ok(!request.fields.some((f) => /^ref[12]_/.test(f.key) && f.value), "the references are empty");
  assert.deepEqual([field("litigation_involved:NO")!.value, field("litigation_involved:YES")!.value, field("eatc_completed:NO")!.value], ["true", "", "true"], "Yes / No questions arrive at No");
  const agreementText = await pdfText(original);
  assert.ok(agreementText.some((t) => t.page > 2 && t.text.includes("India, Nepal")) && agreementText.some((t) => t.page > 2 && t.text.includes("25%")), "the agreement terms are printed on the P06 pages");
  assert.ok(agreementText.some((t) => t.page > 2 && t.text.includes("Sue Witness")), "the SLIT witness from Prepare application is printed on the agreement");
  assert.ok(agreementText.some((t) => t.page === 3 && t.text.includes("51 824 753 556, ACN 603 584 676")), "the agreement's (ABN ...) line carries the business's ACN");
  const sendData = rpcs.find(([name]) => name === "agency_onboarding_presend_send")![1].p_data as { form_pages: number; witness_box: { page: number } | null };
  assert.ok(sendData.form_pages === 2 && sendData.witness_box && sendData.witness_box.page > 2, "where the witness will draw is kept");
  // 2026-11-21: SLIT's signatory is printed when sending (name, position, typed signature, today's date) and recorded; GST printed with Item 4.
  const sentSig = sendData as unknown as Record<string, string>;
  assert.deepEqual([sentSig.admin_name, sentSig.admin_position, sentSig.slit_signature_kind, sentSig.slit_signature, sentSig.signed_on], ["Hari Admin", "Chief Executive Officer", "typed", "Hari Admin", signingCore.isoToday()]);
  const p11 = agreementText.filter((t) => t.page === 2 + 11).map((t) => t.text).join(" | ");
  assert.ok(p11.includes("Hari Admin") && p11.includes("Chief Executive Officer") && p11.includes(signingCore.isoToday().split("-").reverse().join("/")), `the SLIT signatory block is filled on the agreement's signature page: ${p11}`);
  // 2026-11-21 (owner): no extra "Agent's Fee (Item 4)" line; the Item 4 sentence itself reads "... Percentage of tuition fee Excluding GST."
  assert.ok(agreementText.some((t) => t.page === 2 + 11 && t.text === "Excluding GST. This applies to eligible onshore and offshore"), "the GST choice is in the Item 4 sentence");
  assert.ok(!agreementText.some((t) => /Agent's Fee \(Item 4\):/.test(t.text)), "the separate Agent's Fee line is gone");
  assert.ok(!JSON.stringify((created[0] as { field_values: Record<string, string> }).field_values).includes("admin_signature\""), "the SLIT signature is not kept in the request's field values");
  assert.equal(rpcs.filter(([name]) => name === "agency_onboarding_create").length, 0, "the draft becomes the application (no second onboarding row)");

  // The agency admin signs once; the witness types a name and draws.
  const originalHash = await signingCore.sha256Hex(original);
  const recipient = { id: "r1", name: contact.name, email: contact.email, role: "Business contact", state: "sent" };
  const fieldRows = request.fields.map((f, i) => ({ id: `f${i}`, recipient_id: "r1", type: f.type, page: f.page, x: 0.5, y: 0.8, w: 0.3, h: 0.03, label: f.key, key: f.key, value: f.value, required: f.required }));
  const plan = { id: onboardingId, kind: "application", formPages: 2, combined: true, witness: { preset: false, box: { ...sendData.witness_box!, x: 0.1, y: 0.1, w: 0.3, h: 0.05 } } };
  const record = { id: sentApp.id, state: "sent", original_hash: originalHash, recipient, fields: fieldRows, signers: [], onboarding: plan };
  const linkPorts = { ...ports, service: async (action: string, args: { data?: Record<string, unknown> }) => {
    if (action === "rate") return true;
    if (action === "open") return record;
    if (action === "sign_plan") return { id: sentApp.id, reference: "SLIT-2026-101", title: request.title, revision: 1, complete: true, signed_at: "2026-11-20T01:00:00Z", original_path: `${sentApp.id}/original.pdf`, original_hash: originalHash,
      created_at: "2026-11-20T00:00:00Z", sent_at: "2026-11-20T00:01:00Z", signing_mode: "sequential", recipient_id: "r1", chain_ok: true, offer: false, onboarding: plan,
      fields: fieldRows.map((f) => ({ ...f, done: true, value: f.type === "checkbox" ? String((args.data?.values as Record<string, string>)?.[f.id] === "true") : f.type === "date" ? "20/11/2026" : ((args.data?.values as Record<string, string>)?.[f.id] ?? f.value ?? "") })),
      recipients: [{ ...recipient, state: "signed", signer_name: contact.name, signed_at: "2026-11-20T01:00:00Z", signature_kind: "typed" }], events: [] };
    if (action === "sign") { signData = args.data ?? null; state.stage = "application_signed"; Object.assign(signedRequest, { id: sentApp.id, path: String(args.data?.current_path), hash: String(args.data?.current_hash) }); return { state: "signed" }; }
    if (action === "notify_claim") return [];
    if (action === "path_referenced") return false;
    throw new Error(`unexpected ${action}`);
  } } as typeof ports;
  const values: Record<string, string> = Object.fromEntries(fieldRows.filter((f) => f.type === "text").map((f) => [f.id, f.value || "x"]));
  for (const f of fieldRows.filter((x) => x.type === "checkbox")) values[f.id] = f.value === "true" ? "true" : "false";
  const setKey = (key: string, value: string) => { const f = fieldRows.find((x) => x.key === key); if (f) values[f.id] = value; };
  for (const p of [1, 2]) { setKey(`ref${p}_contact_name`, referees[p - 1].name); setKey(`ref${p}_email`, referees[p - 1].email); setKey(`ref${p}_phone`, "+6140011122" + p); }
  setKey("contact_title", "Mr"); setKey("contact_given_name", "Ravi"); setKey("contact_family_name", "Kumar"); setKey("contact_email", contact.email); setKey("contact_phone", "+61412345678");
  setKey("declarant_name", "Ravi Kumar"); setKey("declarant_role", "Director"); setKey("office_suburb", "Footscray"); setKey("office_province", "");
  const allTicked = Object.fromEntries(onboarding.F04_DECLARATIONS.map((d) => [d.key, true]));
  const signAs = (witness: unknown) => signingCore.handleSigning({ body: { action: "sign", token: "c".repeat(64), name: "Ravi Kumar", agreed: true, values: { ...values }, documentHash: originalHash,
    application: { acn: "", marn: "", declarations: allTicked, witness } }, upload: null, ip: "203.0.113.9", userAgent: "test" }, linkPorts);
  await assert.rejects(signAs(undefined), /witness's full name/);
  await assert.rejects(signAs({ name: "Jo Witness" }), /draw their signature/);
  const signed = await signAs({ name: "Jo Witness", png: PNG_1PX }) as { signed: boolean; complete: boolean };
  assert.ok(signed.signed && signed.complete);
  const d = signData as unknown as { values: Record<string, string>; form_base64: string; agreement_base64: string };
  const signedValue = (key: string) => d.values[fieldRows.find((f) => f.key === key)!.id];
  assert.deepEqual([signedValue("agent_signatory_name"), signedValue("agent_signatory_position"), signedValue("agent_witness_name")], ["Ravi Kumar", "Director", "Jo Witness"], "the agreement's signatory is the declarant; the witness named");
  const pages = async (b64: string) => (await PdfLib.PDFDocument.load(new Uint8Array(Buffer.from(b64, "base64")))).getPageCount();
  // 2026-11-20 (CPU budget): the signature commits the whole signed document; the split and the referee checks are follow-up calls.
  assert.equal(d.form_base64, undefined, "no split inside the signing request");
  assert.deepEqual(queued, ["split"], "the split is queued");
  assert.equal(services.filter(([name]) => name === "agency_onboarding_referee_request_create").length, 0, "nothing else runs in the signing request");
  const audit = signData as unknown as { certificate_path: string; certificate_hash: string };
  assert.ok(/\/certificate-[0-9a-f-]+\.pdf$/.test(String(audit.certificate_path)) && stored.has(String(audit.certificate_path)) && /^[0-9a-f]{64}$/.test(String(audit.certificate_hash)),
    "2026-11-20: the audit record (completion certificate) is still made and stored as evidence");
  const signedText = await pdfText(stored.get(signedRequest.path)!);
  assert.ok(signedText.some((t) => t.page > 2 && t.text.includes("India, Nepal")) && signedText.some((t) => t.page <= 2 && t.text.includes("Ravi")), "pdf.js reads the signed copy (incremental updates on the original)");
  const followup = (step: string) => signingCore.handleSigning({ body: { action: "onboarding_followup", onboardingId, step }, upload: null, ip: null, userAgent: null }, { ...ports, isServiceCaller: true } as typeof ports);
  await assert.rejects(signingCore.handleSigning({ body: { action: "onboarding_followup", onboardingId, step: "split" }, upload: null, ip: null, userAgent: null }, ports), /Not available/, "only the service may run a follow-up");
  assert.deepEqual(await followup("split"), { step: "split", split: true });
  assert.deepEqual([await pages(split.form), await pages(split.agreement)], [2, 13], "the one signed PDF is split into the application form and the agreement");
  assert.deepEqual(queued, ["split", "after_application"], "the split queues the rest");
  assert.deepEqual(await followup("split"), { step: "split", split: false }, "a repeated split call does nothing");
  await followup("after_application");
  assert.ok(services.some(([name, a]) => name === "agency_onboarding_witness_record" && a.p_name === "Jo Witness" && a.p_png === PNG_1PX), "the drawn witness is kept on the onboarding");
  assert.equal(services.filter(([name]) => name === "agency_onboarding_referee_request_create").length, 2, "both referees get their check at once");
  assert.ok(mails.some((m) => /^Ready for review: Acme Education Pty Ltd$/.test(m.subject) && /do not need to wait/.test(m.textBody)), "staff may review at once");
  assert.ok(mails.some((m) => m.to === contact.email && /do not need to wait for them/.test(m.textBody)), "the agency admin is not held up by the referees");

  // Approve while both referees are still pending: no second signature; the agreement is countersigned, issued and emailed; sign-ins released.
  await assert.rejects(call({ action: "agent_onboarding_approve", onboardingId, agencyId, adminName: "Hari Admin", adminPosition: "CEO", adminSignature: { kind: "typed", name: "Hari Admin" }, adminWitness: { name: "Sue Witness" } }), /must draw their signature/);
  state.stage = "references_pending";
  const approved = await call({ action: "agent_onboarding_approve", onboardingId, agencyId, adminName: "Hari Admin", adminPosition: "CEO", adminSignature: { kind: "typed", name: "Hari Admin" }, adminWitness: { name: "Other Witness", png: PNG_1PX } }) as
    { approved: boolean; combined: boolean; refereesPending: number; issued: { issued: boolean; emailed: boolean; released: boolean } | null; warning?: string };
  assert.ok(approved.approved && approved.combined && approved.refereesPending === 2 && approved.issued?.issued && approved.issued.emailed && approved.issued.released && !approved.warning, JSON.stringify(approved));
  assert.equal(sent.length, 1, "no P06 request is sent for a second signature");
  const issue = rpcs.find(([name]) => name === "agency_onboarding_agreement_issue")![1] as { p_base64: string; p_data: { admin_name: string; admin_witness_name: string } };
  const issuedText = await pdfText(new Uint8Array(Buffer.from(issue.p_base64, "base64")));
  assert.ok(issue.p_data.admin_name === "Hari Admin" && issue.p_data.admin_witness_name === null && issuedText.some((t) => t.text.includes("Hari Admin")), "the SLIT signatory is printed on the issued agreement; the SLIT witness set before sending is not replaced");
  const issuedMail = mails.find((m) => m.to === contact.email && /Your agent agreement/.test(m.subject))!;
  assert.ok(issuedMail && issuedMail.attachments?.length === 1 && /Agent Agreement\.pdf$/.test(issuedMail.attachments[0].name), "the completed agreement is emailed to the agency admin");
});

test("P06 Item 4 (2026-11-21): the GST words are redacted from the text (no copy of \"Including/Excluding\" left in any stream), the chosen basis printed in the page's own Calibri on the original baseline", async () => {
  const agreement = await onboardingPdf.readBlankTemplate("agreement", blankBytes("agreement"));
  const form = await onboardingPdf.readBlankTemplate("form", blankBytes("form"));
  const redact = await load.import<typeof import("../supabase/functions/_shared/pdf-redact.ts")>("../supabase/functions/_shared/pdf-redact.ts");
  type P = { key: string; type: string; page: number; x: number; y: number; w: number; h: number; value: string; label: string; inline?: unknown };
  const formPages = onboarding.AGENT_ONBOARDING_DOCS.form.pages;
  // The merged blank as Send caches it: the words removed once, in a full save.
  let redacted = false;
  const merged = await onboardingPdf.mergePdfs([form.flattened, agreement.flattened], (doc) => {
    redacted = redact.redactLineFrom(doc, doc.getPages()[formPages + onboardingFn.ITEM4_PAGE - 1], { baseline: onboardingFn.ITEM4_BASELINE, from: onboardingFn.ITEM4_REDACT_FROM });
  });
  assert.ok(redacted, "the blank's Item 4 words are found and removed");
  /** How many streams of the file still hold the glyphs of "Including/Excluding" (kerning between strings ignored). */
  const leftovers = async (bytes: Uint8Array, pageIndex: number) => {
    const doc = await PdfLib.PDFDocument.load(bytes);
    const fonts = doc.getPages()[pageIndex].node.Resources()!.lookup(PdfLib.PDFName.of("Font"), PdfLib.PDFDict);
    let codes = "";
    for (const [, ref] of fonts.entries()) {
      const f = doc.context.lookup(ref, PdfLib.PDFDict);
      if (String(f.get(PdfLib.PDFName.of("BaseFont"))).endsWith("+Calibri")) codes = signingPdf.glyphCodes(signingPdf.toUnicodeGlyphs(new TextDecoder("latin1").decode(PdfLib.decodePDFRawStream(doc.context.lookup(f.get(PdfLib.PDFName.of("ToUnicode"))) as never).decode())), "Including/Excluding") ?? "";
    }
    assert.equal(codes.length, 19 * 4, "every glyph is in the page's Calibri");
    let hits = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PdfLib.PDFRawStream)) continue;
      let text = ""; try { text = new TextDecoder("latin1").decode(PdfLib.decodePDFRawStream(obj).decode()); } catch { continue; }
      if ([...text.matchAll(/<([0-9A-Fa-f]+)>/g)].map((m) => m[1].toUpperCase()).join("").includes(codes)) hits++;
    }
    return hits;
  };
  assert.equal(await leftovers(agreement.flattened, 10), 1, "control: the blank holds the words in one stream");
  assert.equal(await leftovers(merged, formPages + 10), 0, "the cached blank holds no copy of them");
  const stamp = async (original: Uint8Array, gst: string | null, page = formPages + 11) => {
    const { printed } = onboarding.resolveFields(agreement.fields, { agent_commission_percent: "10" });
    const words = onboardingFn.commissionGstWords(agreement.fields, { commissionPercent: "10", commissionGst: gst });
    const fields = [...printed, ...(words ? [words] : [])].map((x: P) => ({ recipient_id: null, type: x.type, page: x.page + page - 11, x: x.x, y: x.y, w: x.w, h: x.h, value: x.value, done: true, label: x.label, inline: (x.inline ?? null) as never }));
    return { words, bytes: await signingPdf.stampDocument(original, { reference: "", title: "t", recipients: [], incremental: true, fields }) };
  };
  for (const [gst, word] of [["inclusive", "Including"], ["exclusive", "Excluding"]] as const) {
    const { words, bytes } = await stamp(merged, gst);
    assert.equal(words!.value, `${word} GST. This applies to eligible onshore and offshore`);
    const all = await pdfText(bytes);
    const text = all.filter((t) => t.page === formPages + 11);
    const line = text.find((t) => t.text === words!.value)!;
    assert.ok(line && Math.abs(line.x - 270.5) < 0.6 && Math.abs(line.y - 444.11) < 0.3, `same place and baseline as the words it replaces: ${JSON.stringify(line)}`);
    assert.ok(text.some((t) => t.text === "________Percentage of tuition fee"), "the sentence's start is untouched");
    assert.ok(text.some((t) => t.text === "10%"), "the percentage stays in its blank");
    assert.ok(!all.some((t) => t.text.includes("Including/Excluding")), "copy / search finds only the chosen basis");
    assert.ok(!text.some((t) => /Agent's Fee \(Item 4\):/.test(t.text) || (t.y > 416 && t.y < 441 && /GST/.test(t.text))), "nothing printed on the next lines or the heading");
    assert.equal(await leftovers(bytes, formPages + 10), 0, "no stream of the sent PDF holds the removed words");
    const doc = await PdfLib.PDFDocument.load(bytes);
    const contents = doc.getPage(formPages + 10).node.Contents();
    const streams = contents instanceof PdfLib.PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
    const last = new TextDecoder("latin1").decode(PdfLib.decodePDFRawStream(streams[streams.length - 1] as never).decode());
    assert.match(last, /\/C2_0 9\.96 Tf/, "the page's own Calibri at 9.96 pt");
    assert.ok(!/ re\s+f\b/.test(last) && !/\bW\s+n\b/.test(last), "no white box and no clipped redraw: the words are gone, not covered");
  }
  // The same removal at stamp time when a blank still has the words (cached before this change): the sent page text is clean too.
  const late = await stamp(agreement.flattened, "exclusive", 11);
  assert.ok(!(await pdfText(late.bytes)).some((t) => t.text.includes("Including/Excluding")), "removed at stamp time from an older blank");
  // An onboarding sent before the GST choice (corrected now) prints the blank's own words again: the line is never left short.
  assert.equal((await stamp(merged, null)).words!.value, "Including/Excluding GST. This applies to eligible onshore and offshore");
  const glyphs = signingPdf.toUnicodeGlyphs("1 beginbfchar\n<0003> <0020>\nendbfchar\n1 beginbfrange\n<0010> <0012> <0041>\nendbfrange");
  assert.deepEqual([signingPdf.glyphCodes(glyphs, "AB C"), signingPdf.glyphCodes(glyphs, "AZ")], ["001000110003" + "0012", null], "a missing glyph falls back to the stamp's own font");
  assert.ok(read("supabase/functions/document-signing/onboarding.ts").includes("agreement.sourceHash.slice(0, 16)}:i4r1`"), "blanks cached before the redaction are not reused");
});

test("Send-back correction (2026-11-21): every signed answer loads (Yes / No from the reviewed answers), only flagged answers are checked, saved and changed; re-sign keeps the rest as signed (one flag and several)", async () => {
  const logic = await load.import<typeof import("../src/components/signing/f04WizardLogic.ts")>("../src/components/signing/f04WizardLogic.ts");
  // As production stored SLIT-2026-000060: tick boxes without a value, text values kept; the reviewed answers hold YES / NO.
  const f = (key: string, type: string, value: string | null = null, required = false) => ({ id: `f-${key}`, key, type, value, required, label: key, page: 1, x: 0, y: 0, w: 0, h: 0 });
  const fields = [f("agent_legal_entity", "text", "PURVA", true), f("contact_email", "text", "pat@example.test", true), f("org_chart_attached:YES", "checkbox", null, true), f("org_chart_attached:NO", "checkbox", null, true),
    f("litigation_involved:YES", "checkbox", null, true), f("litigation_involved:NO", "checkbox", null, true), f("litigation_details", "text"), f("eatc_completed:YES", "checkbox", null, true), f("eatc_completed:NO", "checkbox", null, true),
    f("staff_count", "text"), f("popular_courses", "text"), f("ref1_email", "text", "same@example.test", true), f("ref2_email", "text", "same@example.test", true), f("declarant_name", "text", "Pat Lee", true), f("declarant_role", "text", "CEO", true)];
  const reviewed = { agent_legal_entity: "PURVA", contact_email: "pat@example.test", org_chart_attached: "NO", litigation_involved: "NO", eatc_completed: "NO", staff_count: "12", popular_courses: "Diploma of IT",
    ref1_email: "same@example.test", ref2_email: "same@example.test", declarant_name: "Pat Lee", declarant_role: "CEO" };
  type WizField = Parameters<typeof logic.f04Problems>[1][number];
  const wizFields = fields as unknown as WizField[];
  for (const flags of [{ org_chart_attached: "" }, { org_chart_attached: "Attach the chart", litigation_involved: "Explain the dispute", staff_count: "" }] as Array<Record<string, string>>) {
    const several = Object.keys(flags).length > 1;
    // 1. The page opens with every signed answer, Yes / No included (they were blank: "Choose Yes or No").
    const opened = logic.initialF04(logic.withSignedAnswers(wizFields, reviewed), null, null, null);
    assert.deepEqual([opened.answers.org_chart_attached, opened.answers.litigation_involved, opened.answers.eatc_completed, opened.answers.staff_count, opened.answers.popular_courses],
      ["NO", "NO", "NO", "12", "Diploma of IT"], "every answer as signed");
    // 2. Only flagged answers are checked: the unflagged Yes / No questions and the duplicate reference emails do not block Next / Sign.
    const all = { ...logic.f04Problems(logic.F04_STEP.agency, wizFields, opened), ...logic.f04Problems(logic.F04_STEP.references, wizFields, opened) };
    const blank = { ...opened, answers: { ...opened.answers, eatc_completed: "", ref2_email: "same@example.test" } };
    const unscoped = { ...logic.f04Problems(logic.F04_STEP.agency, wizFields, blank), ...logic.f04Problems(logic.F04_STEP.references, wizFields, blank) };
    assert.ok(Object.keys(unscoped).includes("eatc_completed") && Object.keys(unscoped).includes("ref2_email"), "without the scope these would block");
    assert.deepEqual(logic.correctionScope(unscoped, flags), {}, "a correction checks only the flagged answers");
    assert.deepEqual(Object.keys(logic.correctionScope(all, flags)), [], "the opened answers are complete");
    // A flagged question answered Yes needs its follow-up / upload; that is checked.
    const yes = { ...opened, answers: { ...opened.answers, org_chart_attached: "YES", ...(several ? { litigation_involved: "YES" } : {}) } };
    const needed = Object.keys(logic.correctionScope(logic.f04Problems(logic.F04_STEP.agency, wizFields, yes, {}), flags)).sort();
    assert.deepEqual(needed, several ? ["attach_org_chart", "litigation_details"] : ["attach_org_chart"]);
    // 3. Save sends only the flagged answers (with the follow-up and the declarant), and the server accepts exactly that.
    const draft = logic.correctionDraft({ ...yes, answers: { ...yes.answers, litigation_details: "A 2019 contract dispute, settled" }, step: 3 }, flags);
    assert.deepEqual(Object.keys(draft.answers!).sort(), (several ? ["declarant_name", "declarant_role", "litigation_details", "litigation_involved", "org_chart_attached", "staff_count"] : ["declarant_name", "declarant_role", "org_chart_attached"]).sort());
    assert.ok(!("acn" in draft) && !("marn" in draft), "the ACN / MARN only when flagged");
    assert.equal(onboarding.correctionDraftProblem(draft as Record<string, unknown>, flags), null, "the server accepts the flagged answers");
    assert.match(String(onboarding.correctionDraftProblem({ answers: { org_chart_attached: "YES", contact_email: "new@example.test", eatc_completed: "YES" } }, flags)),
      /^Only the answers SLIT asked you to correct can be changed\. Not saved: .*(Contact email|contact email).*$/, "an unflagged answer is refused by name");
    assert.match(String(onboarding.correctionDraftProblem({ answers: {}, acn: "004028077" }, flags)), /Not saved: ACN/);
    assert.equal(onboarding.correctionEditable("attach_org_chart", flags), true, "the flagged question's upload");
    assert.equal(onboarding.correctionEditable("attach_business_profile", flags), false);
    // 4. Re-sign: whatever the page posts, every unflagged answer is signed as reviewed (Yes / No ticks from the reviewed answers).
    const posted: Record<string, unknown> = Object.fromEntries(fields.map((x) => [x.id, x.type === "checkbox" ? "false" : "changed"]));
    posted["f-org_chart_attached:YES"] = "true"; if (several) { posted["f-litigation_involved:YES"] = "true"; posted["f-litigation_details"] = "A 2019 contract dispute, settled"; posted["f-staff_count"] = "14"; }
    signingCore.lockUnflagged(fields, posted, flags, reviewed);
    assert.deepEqual([posted["f-eatc_completed:NO"], posted["f-eatc_completed:YES"], posted["f-contact_email"], posted["f-agent_legal_entity"], posted["f-org_chart_attached:YES"]],
      ["true", "false", "pat@example.test", "PURVA", "true"], "unflagged as reviewed (No stays ticked); the flagged answer as corrected");
    assert.deepEqual([posted["f-litigation_involved:NO"], posted["f-litigation_involved:YES"], posted["f-litigation_details"], posted["f-staff_count"], posted["f-declarant_name"]],
      several ? ["false", "true", "A 2019 contract dispute, settled", "14", "changed"] : ["true", "false", "", "", "changed"], several ? "every flagged answer as corrected" : "litigation as reviewed");
  }
  // Wiring: the page uses the scope and the draft filter; the server checks the draft and uploads; the stage fix is a migration.
  const wizard = read("src/components/signing/F04Wizard.tsx"), core = read("supabase/functions/document-signing/core.ts"), sql = read("supabase/migrations/20261121022517_onboarding_correction_answers.sql");
  assert.ok(wizard.includes("correctionScope(p, flags)") && wizard.includes("withSignedAnswers(fields, signedAnswers)") && wizard.includes("correcting ? correctionDraft(whole, flags) : whole"));
  assert.ok(core.includes("correctionDraftProblem(draft as Record<string, unknown>, open.flags ?? {})") && core.includes("correctionEditable(`attach_${kind}`") && core.includes("lockUnflagged(fields, values, correction.flags ?? {}, correction.answers ?? {})"));
  assert.ok(sql.includes("'answers', coalesce(o.answers, '{}'::jsonb)") && sql.includes("o.stage not in (''application_sent'', ''correction_requested'')"), "the save / upload stage fix");
});

test("witness signatures (2026-11-20): a drawn signature in any field is a picture, never \"data:image\" text (send, sign and approve stamps)", async () => {
  const agreement = await onboardingPdf.readBlankTemplate("agreement", blankBytes("agreement"));
  // As the hosted template stores them (installed 2026-11-17): both witness signature boxes are "text" fields.
  type P = { type: string; page: number; x: number; y: number; w: number; h: number; value: string; label: string; key: string };
  const asHosted = agreement.fields.map((f: P) => /witness_signature$/.test(f.key) ? { ...f, type: "text" } : f);
  const drawing = `data:image/png;base64,${PNG_1PX}`;
  const sent = onboarding.resolveFields(asHosted, { admin_witness_name: "Sue Witness", admin_witness_signature: drawing, agent_territory: "India" });
  const toStamp = (fields: P[], recipient: string | null) => fields.map((f) => ({ recipient_id: recipient, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, value: f.value, done: true, label: f.label }));
  const afterSend = await signingPdf.stampDocument(agreement.flattened, { reference: "", title: "t", recipients: [], incremental: true, fields: toStamp(sent.printed, null) });
  // Signing: the agency witness's drawing arrives as the value of its (text) field, and the admin signs with a drawn signature.
  const signerFields = sent.recipient.map((f: P) => ({ ...f, value: f.key === "agent_witness_signature" ? drawing : f.key === "agent_witness_name" ? "Raj Witness" : f.type === "signature" ? "" : "x" }));
  const recipients = [{ id: "r1", name: "Ravi Kumar", email: "r@example.test", role: "Business contact", state: "signed", signer_name: "Ravi Kumar", signed_at: "2026-11-20T00:00:00Z", signature_kind: "drawn", signature_image: PNG_1PX }];
  const afterSign = await signingPdf.stampDocument(afterSend, { reference: "SLIT-2026-000099", title: "t", recipients, incremental: true, fields: toStamp(signerFields, "r1") });
  const admin = onboarding.resolveFields(asHosted, { admin_name: "Hari Admin", admin_position: "CEO", admin_signature: drawing, admin_signed_date: "2026-11-20" }).printed.filter((f: P) => f.key.startsWith("admin_") && !f.key.startsWith("admin_witness"));
  const issued = await signingPdf.stampDocument(afterSign, { reference: "", title: "t", recipients: [], incremental: true, fields: toStamp(admin, null) });
  for (const [step, bytes] of [["send", afterSend], ["sign", afterSign], ["approve", issued]] as const) {
    const leaked = (await pdfText(bytes)).filter((t) => /data:image|base64,/i.test(t.text));
    assert.equal(leaked.length, 0, `after ${step}: no field prints a data URL as text (${leaked.map((t) => `p${t.page} ${t.text.slice(0, 30)}`).join("; ")})`);
  }
  const doc = await PdfLib.PDFDocument.load(issued);
  const imagesOn = (n: number) => { const xo = doc.getPage(n).node.Resources()?.lookup(PdfLib.PDFName.of("XObject")); return xo instanceof PdfLib.PDFDict ? xo.keys().length : 0; };
  const box = (key: string) => agreement.fields.find((f: P) => f.key === key)!;
  const base = await PdfLib.PDFDocument.load(agreement.flattened);
  const baseImages = (n: number) => { const xo = base.getPage(n).node.Resources()?.lookup(PdfLib.PDFName.of("XObject")); return xo instanceof PdfLib.PDFDict ? xo.keys().length : 0; };
  for (const key of ["admin_witness_signature", "agent_witness_signature"]) {
    const page = box(key).page - 1;
    assert.ok(imagesOn(page) > baseImages(page), `${key}: the drawing is embedded as a picture on page ${page + 1}`);
  }
  const text = (await pdfText(issued)).map((t) => t.text).join(" ");
  assert.ok(text.includes("Sue Witness") && text.includes("Raj Witness") && text.includes("Hari Admin"), "the witness names and the SLIT signatory still print as text");
});

test("F04 step order (2026-11-20): Business, References, Contact, Agency, Review & sign in the agency admin's form, Prepare application and the staff review; drafts and send-back follow", async () => {
  const logic = await load.import<typeof import("../src/components/signing/f04WizardLogic.ts")>("../src/components/signing/f04WizardLogic.ts");
  const ids = (steps: number[]) => steps.map((i) => logic.F04_STEPS[i].id);
  assert.deepEqual(ids(logic.visibleSteps("agent", null)), ["business", "references", "contact", "agency", "review"], "the agency admin's invited view");
  assert.deepEqual(ids(logic.visibleSteps("admin-review", null)), ["business", "references", "contact", "agency", "review"], "the staff F04 review dialog");
  assert.deepEqual(ids(logic.visibleSteps("admin-prefill", null)), ["business", "contact", "agency", "review"], "Prepare application: same order, the references are the agency admin's");
  // Send back for correction: each flagged answer opens its own step, in the new order, then Review & sign.
  const flagged = { contact_email: "wrong", ref2_phone: "missing", litigation_involved: "explain", agent_abn: "check" };
  assert.deepEqual(ids(logic.visibleSteps("correction", flagged)), ["business", "references", "contact", "agency", "review"]);
  assert.deepEqual(ids(logic.visibleSteps("correction", { ref1_email: "x" })), ["references", "review"], "only the references flagged");
  assert.deepEqual(ids(logic.visibleSteps("correction", { office_address: "x", services_provided: "y" })), ["contact", "agency", "review"]);
  for (const [key, step] of [["agent_legal_entity", "business"], ["marn", "business"], ["ref1_contact_name", "references"], ["ref2_email", "references"], ["contact_phone", "contact"],
    ["office_suburb", "contact"], ["agent_website", "contact"], ["eatc_completed", "agency"], ["students_per_year", "agency"]] as const) {
    assert.equal(logic.F04_STEPS[logic.stepOfKey(key)].id, step, `${key} is flagged on the ${step} step`);
  }
  // Each step checks its own answers at its new position.
  const refFields = [1, 2].flatMap((n) => ["contact_name", "organisation", "email", "phone"].map((p) => ({ key: `ref${n}_${p}`, type: "text", required: true }))) as never;
  const empty = { answers: {}, acn: "", marn: "", declarations: {}, step: logic.F04_STEP.references };
  assert.ok(Object.keys(logic.f04Problems(logic.F04_STEP.references, refFields, empty)).some((k) => k.startsWith("ref1_")), "the References step (second) asks for the references");
  assert.deepEqual(logic.f04Problems(logic.F04_STEP.contact, refFields, empty), {}, "the Contact step does not ask for the references");
  // References (2026-11-21): their own email and phone each, never the agency admin's own email; shown before the other checks pass.
  const refs = (answers: Record<string, string>, ownEmails: string[] = []) => logic.f04Problems(logic.F04_STEP.references, refFields, { ...empty, answers }, {}, { ownEmails });
  const two = { ref1_contact_name: "Ana Roy", ref1_organisation: "A", ref1_email: "ana@a.test", ref1_phone: "+61412345678", ref2_contact_name: "Ben Li", ref2_organisation: "B", ref2_email: "ben@b.test", ref2_phone: "+61412345679" };
  assert.deepEqual(refs(two), {});
  assert.deepEqual(refs({ ...two, ref2_email: "ANA@a.test", ref2_organisation: "" }), { ref2_organisation: "Enter reference 2's organisation.", ref2_email: "Each reference needs their own email." }, "shown while other answers are still missing");
  assert.deepEqual(refs({ ...two, ref2_phone: "0412 345 678" }), { ref2_phone: "Each reference needs their own phone." });
  assert.deepEqual(refs({ ...two, ref1_email: "me@agency.test" }, ["Me@Agency.test"]), { ref1_email: "A reference's email can't be your own email." }, "the signer's own email");
  assert.deepEqual(refs({ ...two, contact_email: "ben@b.test" }), { ref2_email: "A reference's email can't be your own email." }, "the contact's email");
  assert.deepEqual(refs({ ...two, ref2_contact_name: "ana roy" }), {}, "the same contact name is only a warning");
  assert.equal(refs({ ...two, ref1_phone: "" }).ref1_phone, "Enter reference 1's phone.", "the hint beside Next");
  // The agency admin's form: Next / Sign disabled with the missing item beside them; errors on leaving a field; Save always enabled; layout.
  const f04 = read("src/components/signing/F04Wizard.tsx");
  assert.ok(f04.includes(`disabled={!!busy || (gated && !!missing)} onClick={next} data-testid="f04-next"`) && f04.includes(`data-testid="f04-next-hint"`) && f04.includes("disabled={!canSubmit || !!busy}"));
  assert.ok(f04.includes("onBlur={onBlurField}") && f04.includes("touched.has(k)") && !/data-testid="f04-save-later"[^>]*disabled|disabled=\{!!busy\} className="cursor-pointer text-sm font-semibold text-primary-700 underline-offset-2 hover:underline disabled:opacity-50" data-testid="f04-save-later"/.test(f04));
  assert.ok(f04.includes(`<EmailBox id={\`f04-\${k("email")}\`}`) && f04.includes("[overflow-wrap:anywhere]") && f04.includes('<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">'), "email on its own row and wrapping; cards side by side only on wide screens");
  // Progress saving: a draft keeps its step by id; one saved before the change (position only, old order) reopens at the same step.
  assert.equal(logic.F04_STEPS[logic.draftStep({ step: 1 })].id, "contact", "an old draft at position 1 was on Contact");
  assert.equal(logic.F04_STEPS[logic.draftStep({ step: 3 })].id, "references", "an old draft at position 3 was on References");
  assert.equal(logic.F04_STEPS[logic.draftStep({ step: 0, stepId: "agency" })].id, "agency", "a new draft by its step id");
  assert.equal(logic.draftStep(null), 0);
});

test("CPU budget (2026-11-20, 546 in production): each PDF step of send, sign once, split and approve stays under 1 s of CPU here; incremental updates keep the original bytes", async () => {
  const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
  const timed = async <T>(name: string, work: () => Promise<T>, budget = 1000): Promise<T> => {
    const t = cpuMs(); const out = await work(); const used = cpuMs() - t;
    assert.ok(used < budget, `${name} used ${used.toFixed(0)} ms of CPU (budget ${budget} ms)`);
    return out;
  };
  const form = await onboardingPdf.readBlankTemplate("form", blankBytes("form")), agreement = await onboardingPdf.readBlankTemplate("agreement", blankBytes("agreement"));
  const png = PNG_1PX;
  const merged = await timed("merge the two blanks (once per template version)", () => onboardingPdf.mergePdfs([form.flattened, agreement.flattened]));
  // The shipped blanks were 1.63 MB merged (P06 page content stored uncompressed, 250-460 dpi pictures); optimised 2026-11-20 to ~1.1 MB.
  assert.ok(merged.length < 1_200_000, `the merged F04 + P06 blank is ${merged.length} bytes (budget 1.2 MB)`);
  const loaded = await PdfLib.PDFDocument.load(merged);
  const rawContent = loaded.getPages().flatMap((p) => { const c = p.node.Contents(); const refs = c instanceof PdfLib.PDFArray ? c.asArray() : [c];
    return refs.map((r) => loaded.context.lookup(r as PdfLib.PDFRef)).filter((s) => s instanceof PdfLib.PDFRawStream && !s.dict.get(PdfLib.PDFName.of("Filter"))); });
  assert.equal(rawContent.length, 0, "every page's content is compressed");
  const values: Record<string, string> = { agent_legal_entity: "Acme Education Pty Ltd", agent_abn: "51824753556", contact_given_name: "Ravi", contact_family_name: "Kumar", contact_email: "ravi@example.test", declarant_name: "Ravi Kumar" };
  onboarding.yesNoDefaults(form.fields, values);
  const formR = onboarding.resolveFields(form.fields, values, { editablePrefill: true });
  const agrR = onboarding.resolveFields(agreement.fields, { agent_organisation_name: "Acme Education Pty Ltd", agent_abn: "51824753556", agreement_commencement_date: "2026-12-01", agent_territory: "India, Nepal",
    agent_commission_percent: "25", admin_witness_name: "Sue Witness", admin_witness_signature: `data:image/png;base64,${png}` });
  type P = { type: string; page: number; x: number; y: number; w: number; h: number; value: string; label: string; key: string };
  const printed = (fields: P[], offset = 0) => fields.map((f) => ({ recipient_id: null, type: f.type, page: f.page + offset, x: f.x, y: f.y, w: f.w, h: f.h, value: f.value, done: true, label: f.label }));
  const sent = await timed("send: stamp the merged blank (incremental)", () => signingPdf.stampDocument(merged, { reference: "", title: "t", recipients: [], incremental: true, fields: [...printed(formR.printed), ...printed(agrR.printed, 2)] }));
  assert.deepEqual(sent.subarray(0, merged.length), merged, "the merged blank is kept byte for byte (incremental update)");
  const fields = [...formR.recipient, ...agrR.recipient.map((f: P) => ({ ...f, page: f.page + 2 }))]
    .map((f: P, i: number) => ({ recipient_id: "r1", type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, done: true, label: f.label, value: f.type === "checkbox" ? (i % 2 ? "true" : "false") : f.type === "text" ? `Answer ${i}, Course counselling, Applications and admissions` : null }));
  const recipients = [{ id: "r1", name: "Ravi Kumar", email: "ravi@example.test", role: "Business contact", state: "signed", signer_name: "Ravi Kumar", signed_at: "2026-11-20T00:00:00Z", signature_kind: "drawn", signature_image: png }];
  const signedDoc = await timed(`sign: stamp ${fields.length} fields on 15 pages (incremental)`, () => signingPdf.stampDocument(sent, { reference: "SLIT-2026-000099", title: "t", recipients, fields, incremental: true }));
  assert.deepEqual(signedDoc.subarray(0, sent.length), sent, "the sent document is kept byte for byte inside the signed copy");
  await timed("sign: completion certificate", () => signingPdf.buildCertificate({ reference: "SLIT-2026-000099", title: "t", fields, recipients, id: "x", createdAt: "2026-11-20T00:00:00Z", sentAt: "2026-11-20T00:00:00Z",
    completedAt: "2026-11-20T00:00:00Z", signingMode: "sequential", originalHash: "a".repeat(64), signedHash: "b".repeat(64), consent: "I agree.", chainOk: true, events: [] }, null));
  const [formPart, agreementPart] = await timed("follow-up: split into F04 + P06", () => onboardingPdf.splitPdf(signedDoc, 2));
  const admin = onboarding.resolveFields(agreement.fields, { admin_name: "Hari Admin", admin_position: "CEO", admin_signature: "Hari Admin", admin_signed_date: "2026-11-20" }).printed.filter((f: P) => f.key.startsWith("admin_"));
  const issued = await timed("approve: stamp the SLIT signatory on the signed P06 (incremental)", () => signingPdf.stampDocument(agreementPart, { reference: "", title: "t", recipients: [], incremental: true, fields: printed(admin) }));
  const issuedText = (await pdfText(issued)).map((t) => t.text).join(" ");
  assert.ok(issuedText.includes("Hari Admin") && issuedText.includes("India, Nepal"), "pdf.js reads the signatory and the terms from the issued agreement");
  assert.equal((await PdfLib.PDFDocument.load(formPart)).getPageCount(), 2);
  // A document that does not end with a cross-reference table (an xref stream): stamped by a full re-write instead, never broken.
  assert.equal(signingPdf.previousXref(form.flattened), null, "the installed blank ends with an xref stream");
  const rewritten = await signingPdf.stampDocument(form.flattened, { reference: "", title: "t", recipients: [], incremental: true, fields: printed(formR.printed) });
  assert.equal((await PdfLib.PDFDocument.load(rewritten)).getPageCount(), 2);
  // Fonts: Latin-1 text prints in the built-in Helvetica (no font file, no fontkit); anything else still embeds Noto Sans.
  const latin = Buffer.from(issued.subarray(agreementPart.length)).toString("latin1");
  assert.ok(latin.includes("/Helvetica") && !latin.includes("/FontFile2"), "the approve stamp embeds no font file");
  const noto = await signingPdf.stampDocument(agreementPart, { reference: "", title: "t", recipients: [], incremental: true, fields: printed(admin).map((f) => f.label.includes("ame") || f.type === "text" ? { ...f, value: "Kaʻula Ah−Kim" } : f) });
  const notoTail = Buffer.from(noto.subarray(agreementPart.length)).toString("latin1");
  assert.ok(notoTail.includes("/FontFile2"), "a character only Noto Sans has (ʻ, −) embeds Noto Sans");
  const before = new Set((await pdfText(agreementPart)).map((t) => t.text)); const notoItems = (await pdfText(noto)).map((t) => t.text).filter((t) => !before.has(t)); assert.ok(notoItems.some((t) => t.includes("Kaʻula Ah−Kim")), "pdf.js reads the name in Noto Sans");
});

test("onboarding per business (2026-11-19): Add business checks the blanks before saving; the signed agreement makes the business ready (nothing goes to it); Activate sends ONE set-password email to the contact and each held agent; per-agent actions are refused; a rejection is polite", async () => {
  const mails: Array<{ to: string; subject: string; textBody: string }> = []; const services: Array<[string, Record<string, unknown>]> = []; const voided: string[] = []; const rpcs: Array<[string, Record<string, unknown>]> = [];
  const issued = new Map<string, string>();
  const business = "31000000-0000-4000-8000-000000000001", onboardingId = "21000000-0000-4000-8000-000000000001";
  const poc = { id: "11000000-0000-4000-8000-000000000001", name: "Pat Contact", email: "zz-test-poc@blackhole.postmarkapp.com" };
  const held = [1, 2, 3].map((i) => ({ id: `11000000-0000-4000-8000-00000000000${i + 1}`, name: `ZZ Agent ${i}`, email: `zz-test-agent-${i}@blackhole.postmarkapp.com` }));
  const invitation = (p: { id: string; name: string; email: string }, i: number, contact: boolean, sent = false) =>
    ({ id: `71000000-0000-4000-8000-00000000000${i}`, email: p.email, name: p.name, role: contact ? "agency_admin" : "agent", expiresAt: "2099-01-01T00:00:00Z", sent, contact, agentId: p.id });
  const ports = { isServiceCaller: false, later: (work: Promise<unknown>) => work.then(() => undefined), letterhead: async () => null, uuid: () => "00000000-0000-4000-8000-00000000ffff",
    admin: async (action: string, id: string | null) => { if (action === "subject_search") return []; if (action === "void") { voided.push(id!); return { id, state: "void" }; } throw new Error(`unexpected ${action}`); },
    callerRpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push([name, args]);
      if (name === "agency_onboarding_templates") return [];
      if (name === "admin_business_create") throw new Error("nothing is saved while a blank is missing");
      if (name === "agency_business_activate") return { businessId: business, name: "ZZ Test Agency", status: "Active", onboardingId, contact: poc, heldReleased: 3, skipped: [],
        // The third agent's invitation was already emailed (a retry after a partial failure): it is not emailed again.
        invitations: [invitation(poc, 1, true), invitation(held[0], 2, false), invitation(held[1], 3, false), invitation(held[2], 4, false, true)] };
      if (name === "agency_onboarding_decline") return { id: args.p_onboarding, stage: "declined", kind: "business", openRequestIds: ["90000000-0000-4000-8000-000000000001", "90000000-0000-4000-8000-000000000002"],
        agent: { id: poc.id, name: poc.name, email: poc.email }, agency: { id: business, name: "ZZ Test Agency" } };
      throw new Error(`unexpected rpc ${name}`);
    },
    serviceRpc: async (name: string, args: Record<string, unknown>) => {
      services.push([name, args]);
      if (name === "agency_onboarding_followup") return { id: onboardingId, kind: "business", stage: "agreement_signed", agency: { id: business, name: "ZZ Test Agency" }, agent: { id: poc.id, name: poc.name, email: poc.email },
        sentBy: { email: "hari@example.test", name: "Hari Admin" }, contacts: ["admissions@example.test"], values: {}, referees: [], received: 2, total: 2, template: null, notified: { agentReferees: true, staffReferences: true } };
      if (name === "portal_invitation_link_issue") { issued.set(String(args.p_invitation), String(args.p_token_hash)); return {}; }
      if (name === "agency_onboarding_activation") throw new Error("the signed agreement must never activate the business");
      // 2026-11-18: a business still Onboarding (not approved through the review) releases nothing; staff are told it is ready to activate.
      if (name === "agency_business_release") return { released: false, businessId: business, name: "ZZ Test Agency", invitations: [], skipped: [] };
      throw new Error(`unexpected service ${name}`);
    },
    service: async () => false,
    storage: { download: async () => null, upload: async () => true, remove: async () => undefined, signedUrl: async () => null },
    mail: { provider: { id: "mock", send: async (m: { to: string; subject: string; textBody: string }) => { mails.push(m); return { kind: "accepted" as const, messageId: `m-${mails.length}` }; } }, config: { from: { name: "SLIT", email: "noreply@example.test" }, adminTo: [], siteUrl: "https://site.example.test/", problems: [] } },
  } as unknown as Parameters<typeof signingCore.handleSigning>[1];
  const call = (body: Record<string, unknown>) => signingCore.handleSigning({ body, upload: null, ip: null, userAgent: null }, ports);

  // Add business with a blank missing: the CMS is told which to install; the business is not saved (a retry cannot make a second one).
  await assert.rejects(call({ action: "agent_onboarding_business_create", agency: { name: "ZZ Test Agency", code: "ZZ-TEST" }, contactEmail: poc.email, contactName: poc.name }), /Install the agent onboarding templates first.*\(form\)/);
  assert.ok(!rpcs.some(([name]) => name === "admin_business_create"), "nothing saved without the blanks");

  // The agreement is signed: staff are told the business is ready; nothing goes to the business; nothing is activated.
  await onboardingFn.afterCompletion({ ports, store: async () => undefined, fileBytes: async () => new Uint8Array(), commit: () => undefined }, { id: onboardingId, kind: "agreement" });
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /^Ready to activate: ZZ Test Agency$/);
  assert.ok(mails[0].to.includes("hari@example.test") && mails[0].to.includes("admissions@example.test") && /press Activate/.test(mails[0].textBody), "staff are told to press Activate");
  assert.ok(!mails.some((m) => m.to === poc.email), "the point of contact gets nothing yet");

  // Activate: one set-password email to the contact and one sign-in email to each held agent not emailed yet.
  const activated = await call({ action: "agent_onboarding_business_activate", businessId: business }) as { emailed: string[]; failed: string[]; heldReleased: number };
  assert.deepEqual(activated.emailed, [poc.email, held[0].email, held[1].email]); assert.deepEqual(activated.failed, []); assert.equal(activated.heldReleased, 3);
  assert.deepEqual(rpcs.filter(([name]) => name === "agency_business_activate").map(([, a]) => a.p_business), [business]);
  const contactMail = mails.find((m) => m.to === poc.email)!;
  assert.ok(contactMail && /Set your password/.test(contactMail.subject) && /is now active/.test(contactMail.textBody));
  for (const agent of held.slice(0, 2)) {
    const m = mails.find((x) => x.to === agent.email)!;
    assert.ok(m && /Your Skyline agent portal sign-in for ZZ Test Agency/.test(m.subject) && /added as an agent of ZZ Test Agency/.test(m.textBody), `${agent.email} gets the sign-in email`);
    assert.ok(!/application form|referee|agreement/i.test(m.textBody), "an agent's email carries no onboarding document");
  }
  assert.ok(!mails.some((m) => m.to === held[2].email), "an invitation already emailed is not emailed again");
  for (const m of mails.filter((x) => x.to !== mails[0].to)) {
    const token = m.textBody.match(/https:\/\/site\.example\.test\/agency\/accept-invite#t=([A-Za-z0-9_-]{40,100})/)![1];
    assert.ok([...issued.values()].includes(createHash("sha256").update(token).digest("hex")), "the database holds the SHA-256 of each token, not the token");
  }
  assert.equal(issued.size, 3);

  // Agents have no onboarding of their own: every per-agent action is refused before anything runs.
  const before = rpcs.length;
  for (const action of ["agent_onboarding_add_agent", "agent_onboarding_agent_activate", "agent_onboarding_agent_agreement_send", "agent_onboarding_agent_agreement_upload", "agent_onboarding_agent_countersigner_change"]) {
    await assert.rejects(call({ action, businessId: business, onboardingId, name: "Zed", email: "zed@example.test" }), (e: Error & { status?: number }) => /no onboarding of their own/.test(e.message) && e.status === 410, action);
  }
  assert.equal(rpcs.length, before, "no database call for a retired action");

  // A rejection of the business's references: the decline RPC, every open request voided, the contact told without the reason.
  const rejected = await call({ action: "agent_onboarding_reject", onboardingId, reason: "Referee 2 could not confirm the agency" }) as { stage: string; emailed: boolean };
  assert.equal(rejected.stage, "declined"); assert.equal(rejected.emailed, true);
  assert.deepEqual(voided, ["90000000-0000-4000-8000-000000000001", "90000000-0000-4000-8000-000000000002"], "the open requests are voided");
  const decline = mails[mails.length - 1];
  assert.equal(decline.to, poc.email);
  assert.ok(!decline.textBody.includes("Referee 2") && /unable to proceed/.test(decline.textBody), "the decline email is polite and never shows the reason");
});

test("Google Maps manual search (2026-11-24): any text, up to five places, closed left out, no key / short text / error answered plainly", async () => {
  const places = await load.import<typeof import("../supabase/functions/_shared/google-places.ts")>("../supabase/functions/_shared/google-places.ts");
  const sent: string[] = [];
  const answer = (body: unknown, status = 200) => (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body)).textQuery); return Response.json(body, { status }); }) as unknown as typeof fetch;
  const raw = (id: string, name: string, status = "OPERATIONAL") => ({ id, displayName: { text: name }, businessStatus: status, addressComponents: [{ longText: "Perth", types: ["locality"] }, { longText: "WA", shortText: "WA", types: ["administrative_area_level_1"] }] });
  const many = Array.from({ length: 7 }, (_, i) => raw(`p${i}`, `Aussizz ${i}`));
  many[1] = raw("p1", "Aussizz closed", "CLOSED_PERMANENTLY");
  const found = await places.searchPlaces("Aussizz Melbourne", "k", answer({ places: many }), { state: "VIC" });
  assert.ok(found.ok && found.places.length === 5 && !found.places.some((p) => p.placeId === "p1"), "five places, closed one left out");
  assert.equal(sent[0], "Aussizz Melbourne VIC Australia");
  await places.searchPlaces("12 Smith St, Perth, Australia", "k", answer({ places: [] }));
  assert.equal(sent[1], "12 Smith St, Perth, Australia", "text naming Australia is sent as typed");
  const none = await places.searchPlaces("Nothing here", "k", answer({}));
  assert.deepEqual([none.ok, (none as { reason: string }).reason], [false, "not_found"]);
  const bad = await places.searchPlaces("Aussizz", "k", answer({}, 403));
  assert.deepEqual([bad.ok, (bad as { reason: string }).reason], [false, "unavailable"]);
  const calls = sent.length;
  assert.equal((await places.searchPlaces("Aussizz", "", answer({}))).ok, false);
  assert.equal((await places.searchPlaces("ab", "k", answer({}))).ok, false);
  assert.equal(sent.length, calls, "no key / under 3 letters: no call");
});

test("Google Maps autofill (2026-11-24): Places (New) Text Search with the field mask, address parts, best match by name and state, cache, missing key skipped, rule off, Add business returns the office and the F04 takes it", async () => {
  const places = await load.import<typeof import("../supabase/functions/_shared/google-places.ts")>("../supabase/functions/_shared/google-places.ts");
  const components = [
    { longText: "5", shortText: "5", types: ["subpremise"] }, { longText: "123", shortText: "123", types: ["street_number"] },
    { longText: "Church Street", shortText: "Church St", types: ["route"] }, { longText: "Parramatta", shortText: "Parramatta", types: ["locality", "political"] },
    { longText: "New South Wales", shortText: "NSW", types: ["administrative_area_level_1", "political"] }, { longText: "Australia", shortText: "AU", types: ["country", "political"] },
    { longText: "2150", shortText: "2150", types: ["postal_code"] }];
  assert.deepEqual(places.parseAddressComponents(components), { street: "5/123 Church Street", suburb: "Parramatta", state: "NSW", postcode: "2150", country: "Australia" });
  assert.deepEqual(places.parseAddressComponents([{ longText: "Level 2", types: ["subpremise"] }, { longText: "Collins Street", types: ["route"] }, { longText: "Melbourne", types: ["locality"] }, { longText: "Victoria", shortText: "VIC", types: ["administrative_area_level_1"] }]),
    { street: "Level 2 Collins Street", suburb: "Melbourne", state: "VIC", postcode: "", country: "" });
  assert.deepEqual(places.parseAddressComponents(null), { street: "", suburb: "", state: "", postcode: "", country: "" });
  assert.equal(places.placesQuery("ABC Education Pty Ltd", "new south wales"), "ABC Education Pty Ltd NSW Australia");
  assert.ok(places.nameSimilarity("ABC EDUCATION PTY LTD", "ABC Education") === 1 && places.nameSimilarity("Global Education", "Global Education Consultants Sydney") >= 0.85);
  assert.ok(places.nameSimilarity("Global", "Global Plumbing Services") < 0.6, "one shared word is not a match");
  const raw = (id: string, name: string, comps = components, extra: Record<string, unknown> = {}) => ({ id, displayName: { text: name }, formattedAddress: "x", addressComponents: comps,
    websiteUri: "https://abc.example", nationalPhoneNumber: "(02) 9999 0000", internationalPhoneNumber: "+61 2 9999 0000", googleMapsUri: "https://maps.google.com/?cid=1", businessStatus: "OPERATIONAL", ...extra });
  const vic = components.map((c) => c.types.includes("administrative_area_level_1") ? { longText: "Victoria", shortText: "VIC", types: c.types } : c);
  const candidates = [raw("p-other-state", "ABC Education", vic), raw("p-closed", "ABC Education", components, { businessStatus: "CLOSED_PERMANENTLY" }), raw("p-near", "ABC Migration"), raw("p-best", "ABC Education Group Parramatta")];
  const best = places.pickBestPlace(candidates, { names: ["ABC Education Pty Ltd"], state: "NSW", postcode: "2150" });
  assert.equal(best?.placeId, "p-best", "same state, open, closest name");
  assert.ok(best!.matchPercent >= 85 && best!.website === "https://abc.example" && best!.phone === "(02) 9999 0000");
  assert.equal(places.pickBestPlace([raw("p-near", "ABC Migration")], { names: ["ABC Education"], state: "NSW" }), null, "below the match needed");
  assert.equal(places.pickBestPlace(candidates.slice(0, 2), { names: ["ABC Education"], state: "NSW" }), null, "another state / closed for good never match");
  assert.equal(places.pickBestPlace([raw("p-near", "ABC Migration")], { names: ["ABC Education"], state: "NSW", postcode: "2150" }, 30)?.placeId, "p-near", "the rule's lower match accepts it");
  assert.deepEqual(places.placeF04Values(best), { office_street_address: "5/123 Church Street", office_suburb: "Parramatta 2150", office_state: "NSW", office_country: "Australia", agent_website: "https://abc.example" });
  assert.equal(places.placeAddressLine(best), "5/123 Church Street, Parramatta NSW 2150");

  // The call: POST, key and field mask in headers, AU region; no key: nothing called; an error: unavailable; a miss on the first name tries the legal name.
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchPlaces = (answer: (body: { textQuery: string }) => Response) => (async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return answer(JSON.parse(String(init.body))); }) as unknown as typeof fetch;
  const noKey = await places.searchPlace({ names: ["ABC Education"], state: "NSW" }, "", fetchPlaces(() => new Response("{}")));
  assert.deepEqual([noKey.ok, (noKey as { reason: string }).reason, calls.length], [false, "not_configured", 0], "missing key: skipped, no call");
  const ok = await places.searchPlace({ names: ["ABC Education", "ABC EDUCATION PTY LTD"], state: "NSW", postcode: "2150" }, "key-1", fetchPlaces(() => Response.json({ places: candidates })));
  assert.ok(ok.ok && ok.place.placeId === "p-best");
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(calls[0].url, "https://places.googleapis.com/v1/places:searchText"); assert.equal(calls[0].init.method, "POST");
  assert.equal(h["X-Goog-Api-Key"], "key-1");
  assert.equal(h["X-Goog-FieldMask"], "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.websiteUri,places.nationalPhoneNumber,places.internationalPhoneNumber,places.googleMapsUri,places.businessStatus");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { textQuery: "ABC Education NSW Australia", regionCode: "AU", languageCode: "en", pageSize: 5 });
  assert.equal(calls.length, 1, "the same name twice is searched once");
  calls.length = 0;
  const second = await places.searchPlace({ names: ["Sunrise Study", "ABC Education Pty Ltd"], state: "NSW" }, "key-1", fetchPlaces((b) => Response.json({ places: b.textQuery.startsWith("ABC") ? candidates : [] })));
  assert.ok(second.ok && calls.length === 2, "the legal name when the trading name finds nothing");
  const down = await places.searchPlace({ names: ["ABC Education"], state: "NSW" }, "key-1", fetchPlaces(() => new Response("denied", { status: 403 })));
  assert.deepEqual([down.ok, (down as { reason: string }).reason], [false, "unavailable"]);
  const thrown = await places.searchPlace({ names: ["ABC Education"], state: "NSW" }, "key-1", (async () => { throw new Error("timeout"); }) as unknown as typeof fetch);
  assert.deepEqual([thrown.ok, (thrown as { reason: string }).reason], [false, "unavailable"], "a timeout never throws");
  // The cache by ABN: a hit makes no call; "not found" is kept too; "unavailable" is not.
  const store = new Map<string, { found: boolean; place: unknown }>();
  const cache = { get: async (abn: string) => (store.get(abn) as never) ?? null, put: async (abn: string, _q: string, place: unknown) => { store.set(abn, { found: place !== null, place }); } };
  calls.length = 0;
  const first = await places.searchPlaceCached("12 345 678 901", { names: ["ABC Education"], state: "NSW" }, "key-1", cache, fetchPlaces(() => Response.json({ places: candidates })));
  const again = await places.searchPlaceCached("12345678901", { names: ["ABC Education"], state: "NSW" }, "key-1", cache, fetchPlaces(() => Response.json({ places: [] })));
  assert.ok(first.ok && !first.cached && again.ok && again.cached && calls.length === 1, "reused from the cache");
  await places.searchPlaceCached("49004028077", { names: ["Nobody Here"], state: "VIC" }, "key-1", cache, fetchPlaces(() => Response.json({ places: [] })));
  assert.deepEqual(store.get("49004028077"), { found: false, place: null });
  await places.searchPlaceCached("53004085616", { names: ["ABC"], state: "VIC" }, "key-1", cache, fetchPlaces(() => new Response("", { status: 500 })));
  assert.ok(!store.has("53004085616"));
  const unset = await places.searchPlaceCached("12345678901", { names: ["ABC"] }, "", cache);
  assert.equal((unset as { reason: string }).reason, "not_configured");

  // The function: Add business's ABN lookup returns the office (cached by ABN, service role); the rule switches it off; no key: configured false.
  const BHP = "49004028077";
  const abrAnswer = `c(${JSON.stringify({ Abn: BHP, AbnStatus: "Active", AbnStatusEffectiveFrom: "2000-11-01", Acn: "004028077", AddressPostcode: "3000", AddressState: "VIC", BusinessName: ["BHP"], EntityName: "BHP GROUP LIMITED", EntityTypeName: "Australian Public Company", Gst: "2000-07-01", Message: "" })}`;
  const bhpPlace = raw("p-bhp", "BHP", vic.map((c) => c.types.includes("locality") ? { ...c, longText: "Melbourne" } : c.types.includes("postal_code") ? { ...c, longText: "3000" } : c));
  const service: Array<[string, Record<string, unknown>]> = [];
  const mkPorts = (key: string, rules: Record<string, unknown> = {}) => ({ isServiceCaller: false, later: (w: Promise<unknown>) => w.then(() => undefined), letterhead: async () => null, uuid: () => "00000000-0000-4000-8000-00000000eeee",
    abr: { guid: "guid-1", fetch: (async () => new Response(abrAnswer)) as unknown as typeof fetch },
    places: { key, fetch: fetchPlaces(() => Response.json({ places: [bhpPlace] })) },
    admin: async (action: string) => { if (action === "subject_search") return []; throw new Error(`unexpected ${action}`); },
    callerRpc: async (name: string) => { if (name === "abr_lookup_save") return "2026-11-24T00:00:00Z"; throw new Error(`unexpected rpc ${name}`); },
    serviceRpc: async (name: string, args: Record<string, unknown>) => {
      service.push([name, args]);
      if (name === "business_rule_values") return rules;
      if (name === "google_place_cache_get") return null;
      if (name === "google_place_cache_put") return null;
      throw new Error(`unexpected service rpc ${name}`);
    }, service: async () => false,
    storage: { download: async () => null, upload: async () => true, remove: async () => undefined, signedUrl: async () => null },
    mail: { provider: null, config: { from: null, siteUrl: "", adminTo: [] } } }) as unknown as Parameters<typeof signingCore.handleSigning>[1];
  type Looked = { ok: boolean; places?: { configured: boolean; ok: boolean; place?: { street: string; suburb: string; state: string; postcode: string; website: string; phone: string; mapsUri: string } } };
  const call = (ports: Parameters<typeof signingCore.handleSigning>[1]) => signingCore.handleSigning({ body: { action: "agent_onboarding_abn_lookup", abn: BHP }, upload: null, ip: null, userAgent: null }, ports) as Promise<Looked>;
  calls.length = 0;
  const looked = await call(mkPorts("key-1"));
  assert.ok(looked.ok && looked.places?.ok, "the office comes back with the ABN lookup");
  assert.deepEqual([looked.places!.place!.street, looked.places!.place!.suburb, looked.places!.place!.state, looked.places!.place!.postcode, looked.places!.place!.website], ["5/123 Church Street", "Melbourne", "VIC", "3000", "https://abc.example"]);
  assert.equal(JSON.parse(String(calls[0].init.body)).textQuery, "BHP VIC Australia");
  assert.ok(service.some(([n, a]) => n === "google_place_cache_put" && a.p_abn === BHP), "kept by ABN");
  calls.length = 0;
  const off = await call(mkPorts("key-1", { "agents.google_maps_autofill": false }));
  assert.ok(off.ok && off.places === undefined && calls.length === 0, "rule off: no Google call");
  const noKeyLookup = await call(mkPorts(""));
  assert.ok(noKeyLookup.ok && noKeyLookup.places?.configured === false && calls.length === 0, "no key: nothing called, the lookup works as before");

  // The F04: the office postcode kept on the business joins the suburb; the business record's office row and website are used.
  const f04 = signingCore.f04Prefill({ details: null, confirmed: { legalEntity: "ABC", tradingName: "ABC", gstRegistered: true, state: "NSW", postcode: "2000" },
    record: { office_street_address: "5/123 Church Street", office_suburb: "Parramatta", office_postcode: "2150", office_state: "NSW", agent_website: "https://abc.example" } });
  assert.deepEqual([f04.office_street_address, f04.office_suburb, f04.office_state, f04.agent_website], ["5/123 Church Street", "Parramatta 2150", "NSW", "https://abc.example"]);

  // The source: the key only from the function's environment, never in the browser code; staff confirm on Add business; Add business keeps it.
  assert.match(read("supabase/functions/document-signing/index.ts"), /Deno\.env\.get\("EF_GOOGLE_MAPS_KEY"\)/);
  assert.ok(!/EF_GOOGLE_MAPS_KEY|X-Goog-Api-Key|places\.googleapis/.test(read("src/pages/admin/components/AddBusinessForm.tsx") + read("src/lib/signingApi.ts")), "the key never reaches the browser");
  assert.ok(read("src/pages/admin/components/AddBusinessForm.tsx").includes("Head office") && read("supabase/functions/document-signing/onboarding.ts").includes(`ctx.rpc("agency_places_attach"`));
  assert.ok(read("supabase/functions/.env.example").includes("EF_GOOGLE_MAPS_KEY="));
});

test("Google Maps connection (2026-11-24): the key saved in Integrations > Connections (Vault, service RPC) is used before EF_GOOGLE_MAPS_KEY, read once per request; Check connection makes one places.id search, admins only, reports Google's error; the key never reaches the browser or the summary", async () => {
  const places = await load.import<typeof import("../supabase/functions/_shared/google-places.ts")>("../supabase/functions/_shared/google-places.ts");
  const VAULT_KEY = "AIzaVaultKey_0123456789abcdefghijklmnopq", ENV_KEY = "AIzaEnvKey-0123456789abcdefghijklmnopqrs";
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchPlaces = (answer: () => Response) => (async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return answer(); }) as unknown as typeof fetch;
  const keyOf = (i: number) => (calls[i].init.headers as Record<string, string>)["X-Goog-Api-Key"];
  const service: Array<[string, Record<string, unknown>]> = [];
  const BHP = "49004028077";
  const abrAnswer = `c(${JSON.stringify({ Abn: BHP, AbnStatus: "Active", AbnStatusEffectiveFrom: "2000-11-01", Acn: "004028077", AddressPostcode: "3000", AddressState: "VIC", BusinessName: ["BHP"], EntityName: "BHP GROUP LIMITED", EntityTypeName: "Australian Public Company", Gst: "2000-07-01", Message: "" })}`;
  const mkPorts = (opts: { env: string; vault: unknown; admin?: boolean; answer?: () => Response }) => ({ isServiceCaller: false, later: (w: Promise<unknown>) => w.then(() => undefined), letterhead: async () => null, uuid: () => "00000000-0000-4000-8000-00000000eeef",
    abr: { guid: "guid-1", fetch: (async () => new Response(abrAnswer)) as unknown as typeof fetch },
    places: { key: opts.env, fetch: fetchPlaces(opts.answer ?? (() => Response.json({ places: [] }))) },
    admin: async (action: string) => { if (action === "subject_search") return []; throw new Error(`unexpected ${action}`); },
    callerRpc: async (name: string) => { if (name === "abr_lookup_save") return "2026-11-24T00:00:00Z"; if (name === "cms_is_admin") return opts.admin ?? true; throw new Error(`unexpected rpc ${name}`); },
    serviceRpc: async (name: string, args: Record<string, unknown>) => {
      service.push([name, args]);
      if (name === "integration_google_maps_key") { if (opts.vault instanceof Error) throw opts.vault; return opts.vault; }
      if (name === "business_rule_values") return {};
      if (["google_place_cache_get", "google_place_cache_put", "integration_google_maps_check_record"].includes(name)) return null;
      throw new Error(`unexpected service rpc ${name}`);
    }, service: async () => false,
    storage: { download: async () => null, upload: async () => true, remove: async () => undefined, signedUrl: async () => null },
    mail: { provider: null, config: { from: null, siteUrl: "", adminTo: [] } } }) as unknown as Parameters<typeof signingCore.handleSigning>[1];
  const lookup = (ports: Parameters<typeof signingCore.handleSigning>[1]) => signingCore.handleSigning({ body: { action: "agent_onboarding_abn_lookup", abn: BHP }, upload: null, ip: null, userAgent: null }, ports) as Promise<{ places?: { configured: boolean } }>;

  // Key source: the connection first, the secret as fallback, nothing when neither; the service RPC is read once per request.
  calls.length = 0; service.length = 0;
  const both = mkPorts({ env: ENV_KEY, vault: `  ${VAULT_KEY} ` });
  assert.equal(await signingCore.placesKey(both), VAULT_KEY);
  await lookup(both);
  assert.ok(calls.length >= 1 && calls.every((_, i) => keyOf(i) === VAULT_KEY), "the saved connection's key is sent, not the secret");
  assert.equal(service.filter(([n]) => n === "integration_google_maps_key").length, 1, "read once per request (ports)");
  calls.length = 0;
  await lookup(mkPorts({ env: ENV_KEY, vault: null }));
  assert.ok(calls.length >= 1 && keyOf(0) === ENV_KEY, "no saved connection: EF_GOOGLE_MAPS_KEY");
  assert.equal(await signingCore.placesKey(mkPorts({ env: ENV_KEY, vault: new Error("rpc down") })), ENV_KEY, "the RPC failing falls back too");
  assert.equal(await signingCore.placesKey(mkPorts({ env: ENV_KEY, vault: { apiKey: VAULT_KEY } })), ENV_KEY, "only a text answer counts");
  calls.length = 0;
  const none = await lookup(mkPorts({ env: "", vault: null }));
  assert.ok(none.places?.configured === false && calls.length === 0, "neither: not set up, no call");

  // Check connection: one search, field mask places.id, the key in the header only; Google's error text reported; logged; admins only.
  const check = (ports: Parameters<typeof signingCore.handleSigning>[1]) => signingCore.handleSigning({ body: { action: "integration_google_maps_check" }, upload: null, ip: null, userAgent: null }, ports) as Promise<Record<string, unknown>>;
  calls.length = 0; service.length = 0;
  const good = await check(mkPorts({ env: ENV_KEY, vault: VAULT_KEY, answer: () => Response.json({ places: [{ id: "p1" }] }) }));
  assert.deepEqual(good, { ok: true, source: "connection" });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, places.PLACES_SEARCH_URL);
  assert.equal((calls[0].init.headers as Record<string, string>)["X-Goog-FieldMask"], "places.id");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { textQuery: "Melbourne VIC Australia", regionCode: "AU", languageCode: "en", pageSize: 1 });
  assert.ok(service.some(([n, a]) => n === "integration_google_maps_check_record" && a.p_ok === true));
  const googleError = { error: { code: 403, message: "Places API (New) has not been used in project 123 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }] } };
  const bad = await check(mkPorts({ env: "", vault: VAULT_KEY, answer: () => Response.json(googleError, { status: 403 }) }));
  assert.deepEqual([bad.ok, bad.reason, bad.status, bad.code, bad.source], [false, "rejected", 403, "SERVICE_DISABLED", "connection"]);
  assert.match(String(bad.message), /has not been used in project 123/);
  assert.ok(!JSON.stringify(bad).includes(VAULT_KEY) && !JSON.stringify(good).includes(VAULT_KEY), "the answer never holds the key");
  const echoed = await places.checkPlacesKey(VAULT_KEY, (async () => Response.json({ error: { message: `bad key ${VAULT_KEY}` } }, { status: 400 })) as unknown as typeof fetch);
  assert.ok(!echoed.ok && !JSON.stringify(echoed).includes(VAULT_KEY), "an echoed key is stripped");
  const fallback = await check(mkPorts({ env: ENV_KEY, vault: null, answer: () => Response.json({}) }));
  assert.deepEqual([fallback.ok, fallback.source], [true, "fallback_secret"]);
  calls.length = 0;
  const unset = await check(mkPorts({ env: "", vault: null }));
  assert.deepEqual([unset.ok, unset.reason, unset.source, calls.length], [false, "not_configured", "none", 0]);
  const down = await places.checkPlacesKey(VAULT_KEY, (async () => { throw new Error("timeout"); }) as unknown as typeof fetch);
  assert.deepEqual([down.ok, (down as { reason: string }).reason], [false, "unavailable"]);
  calls.length = 0;
  await assert.rejects(check(mkPorts({ env: ENV_KEY, vault: VAULT_KEY, admin: false })), (e: Error & { status?: number }) => e.status === 403);
  assert.equal(calls.length, 0, "not an admin: no Google call");

  // The screen: Google Maps uses the Vault form (password input, Check connection through document-signing, never a key in the browser);
  // the summary shown is the key's last four characters (keyEnd), never apiKey.
  const form = read("src/pages/admin/integrations/CommConnectionForm.tsx");
  assert.ok(form.includes("'google_maps'") && form.includes("integration_comm_credentials_save") && form.includes("checkGoogleMapsConnection") && form.includes("summary?.keyEnd"));
  assert.ok(form.includes("https://console.cloud.google.com/apis/credentials") && form.includes("Enable Places API (New) and restrict the key to it"));
  assert.ok(!/summary\??\.apiKey|X-Goog-Api-Key|places\.googleapis/.test(form + read("src/lib/signingApi.ts")), "no key read back or sent from the browser");
  assert.ok(read("src/pages/admin/integrations/ConnectionsPage.tsx").includes("VAULT_FORM_CONNECTORS"));
});

test("ABN prefill (2026-11-19): the ABR lookup checks the checksum first, needs the GUID, reads a found / cancelled / missing ABN and survives the register being down; the F04 prefill maps the brief's fields, stays editable and is recorded; the title and the referees are checked", async () => {
  const abrLib = await load.import<typeof import("../supabase/functions/_shared/validation/abr.ts")>("../supabase/functions/_shared/validation/abr.ts");
  const BHP = "49004028077"; // BHP Group Limited, a large listed company (public ABN)
  const answer = (body: Record<string, unknown>) => `c(${JSON.stringify(body)})`;
  const found = { Abn: BHP, AbnStatus: "Active", AbnStatusEffectiveFrom: "2000-11-01", Acn: "004028077", AddressDate: "2019-04-08", AddressPostcode: "3000", AddressState: "VIC",
    BusinessName: ["BHP", "BHP BILLITON", "BHP"], EntityName: "BHP GROUP LIMITED", EntityTypeCode: "PUB", EntityTypeName: "Australian Public Company", Gst: "2000-07-01", Message: "" };
  let calls: string[] = [];
  const fetchWith = (respond: (url: string) => Response | Promise<Response>) => (async (url: string) => { calls.push(String(url)); return respond(String(url)); }) as unknown as typeof fetch;

  // A mistyped number is refused before any call; no GUID: nothing is called and Add business keeps its earlier behaviour.
  calls = [];
  const invalid = await abrLib.lookupAbr("49 004 028 078", "guid-1", fetchWith(() => new Response("")));
  assert.ok(!invalid.ok && invalid.reason === "invalid" && calls.length === 0, "an invalid checksum is never sent");
  const notSet = await abrLib.lookupAbr(BHP, "", fetchWith(() => new Response("")));
  assert.ok(!notSet.ok && notSet.reason === "not_configured" && calls.length === 0, "no GUID, no call");

  // Found: the JSONP answer is read; the GUID is in the query string (server side only).
  const ok = await abrLib.lookupAbr("49 004 028 077", "guid-1", fetchWith(() => new Response(answer(found))));
  assert.ok(ok.ok, "found");
  assert.match(calls[calls.length - 1], /^https:\/\/abr\.business\.gov\.au\/json\/AbnDetails\.aspx\?abn=49004028077&callback=c&guid=guid-1$/);
  if (ok.ok) {
    assert.deepEqual({ ...ok.details, sourceUrl: undefined }, { abn: BHP, acn: "004028077", abnStatus: "Active", active: true, statusFrom: "2000-11-01", entityName: "BHP GROUP LIMITED",
      entityType: "Australian Public Company", businessNames: ["BHP", "BHP BILLITON"], gstRegistered: true, gstFrom: "2000-07-01", state: "VIC", postcode: "3000", sourceUrl: undefined });
    assert.equal(ok.raw.EntityName, "BHP GROUP LIMITED", "the raw answer is kept for the business record");
  }
  // Cancelled: found, not active (staff are warned and may add it with a reason).
  const cancelled = await abrLib.lookupAbr("53 004 085 616", "guid-1", fetchWith(() => new Response(answer({ ...found, Abn: "53004085616", AbnStatus: "Cancelled", AbnStatusEffectiveFrom: "2015-06-30", Gst: null, BusinessName: [] }))));
  assert.ok(cancelled.ok && !cancelled.details.active && cancelled.details.abnStatus === "Cancelled" && !cancelled.details.gstRegistered, "a cancelled ABN is reported, not hidden");
  // Not found, a refused GUID, the register down (timeout, HTTP 500, unreadable body): never throws.
  const missing = await abrLib.lookupAbr(BHP, "guid-1", fetchWith(() => new Response(answer({ Abn: "", Message: "No records found", BusinessName: [] }))));
  assert.ok(!missing.ok && missing.reason === "not_found");
  const badGuid = await abrLib.lookupAbr(BHP, "guid-x", fetchWith(() => new Response(answer({ Abn: "", Message: "The GUID entered is not recognised as a Registered Party" }))));
  assert.ok(!badGuid.ok && badGuid.reason === "unavailable" && /EF_ABR_GUID/.test(badGuid.message), "a refused GUID is a set-up problem");
  for (const respond of [() => { throw new DOMException("The operation timed out.", "TimeoutError"); }, () => new Response("oops", { status: 500 }), () => new Response("<html>maintenance</html>")]) {
    const down = await abrLib.lookupAbr(BHP, "guid-1", fetchWith(respond as () => Response));
    assert.ok(!down.ok && down.reason === "unavailable" && /still add the business/.test(down.message), "the register being down never blocks Add business");
  }

  // The F04 prefill (brief): Legal Entity, Trading / Agency name (the chosen business name), ABN/ACN, GST, State, postcode in the
  // Suburb box (never Province), Country, Year founded; the contact from Add business; nothing else.
  const details = ok.ok ? ok.details : null;
  const values = abrLib.abrApplicationValues({ details, confirmed: { legalEntity: "BHP GROUP LIMITED", tradingName: "BHP BILLITON", gstRegistered: true, state: "VIC", postcode: "3000" },
    contact: { givenName: "Pat", familyName: "Contact", email: "ZZ-Test-POC@blackhole.postmarkapp.com", phone: "+61412345678" } });
  assert.deepEqual(values, { agent_legal_entity: "BHP GROUP LIMITED", agent_trading_name: "BHP BILLITON", agent_agency_name: "BHP BILLITON", agent_abn: "49004028077", agent_acn: "004 028 077",
    agent_gst_registered: "YES", office_state: "VIC", office_country: "Australia", agent_year_founded: "2000", contact_given_name: "Pat", contact_family_name: "Contact",
    contact_email: "zz-test-poc@blackhole.postmarkapp.com", contact_phone: "+61412345678" });
  assert.ok(Object.keys(values).every((k) => (abrLib.ABR_PREFILL_KEYS as readonly string[]).includes(k)) && !("office_province" in values) && !("agent_registration_number" in values), "no postcode alone in the Suburb box (round 3) and never in Province; the registration number stays blank");
  // Staff edits win over the register; no business name falls back to the entity name; GST left to the contact.
  const edited = abrLib.abrApplicationValues({ details: { ...details!, businessNames: [], acn: "" }, confirmed: { legalEntity: "BHP Group Ltd", tradingName: "", gstRegistered: null, state: "WA", postcode: "6000" }, contact: { givenName: "", familyName: "", email: "", phone: "" } });
  assert.equal(edited.agent_trading_name, "BHP Group Ltd"); assert.equal(edited.office_state, "WA"); assert.ok(!("office_suburb" in edited), "a postcode alone is no suburb"); assert.ok(!("office_province" in edited)); assert.equal(edited.agent_gst_registered, "YES", "the register's GST when staff leave it");
  assert.equal(edited.agent_abn, BHP);

  // Editable: with the prefill switch, every value we hold is the contact's field, already filled in (nothing printed); the GST pair comes ticked.
  const box = { page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.02, required: false, label: "", value: "" };
  const placed = ["agent_legal_entity", "agent_registration_number", "agent_abn_form", "agent_gst_registered:YES", "agent_gst_registered:NO", "office_suburb", "office_province", "agent_year_founded", "contact_title"]
    .map((key) => ({ ...box, key, type: onboarding.AGENT_ONBOARDING_FIELDS[key].type, role: onboarding.AGENT_ONBOARDING_FIELDS[key].role, label: onboarding.AGENT_ONBOARDING_FIELDS[key].label }));
  const editable = onboarding.resolveFields(placed, values, { editablePrefill: true });
  const byKey = Object.fromEntries(editable.recipient.map((f) => [f.key, f]));
  assert.equal(editable.printed.length, 0, "nothing prefilled is printed (the contact can change all of it)");
  assert.equal(byKey.agent_legal_entity.value, "BHP GROUP LIMITED"); assert.equal(byKey.agent_legal_entity.role, "agent");
  assert.equal(byKey["agent_abn_form"].value, "49 004 028 077", "the ABN box holds the ABN only (the ACN goes to the registration box)"); assert.equal(byKey["agent_abn_form"].required, true);
  assert.equal(byKey["agent_gst_registered:YES"].value, "true"); assert.equal(byKey["agent_gst_registered:NO"].value, "");
  assert.equal(byKey.office_suburb.value, "", "no suburb name known: blank for the address search"); assert.equal(byKey.office_province.value, "", "Province never holds the postcode"); assert.equal(byKey.agent_registration_number.value, "", "Business/MARA/Registration Number stays manual");
  assert.equal(byKey.agent_year_founded.value, "2000"); assert.equal(byKey.contact_title.value, "");
  // Registry fixes (2026-11-19): the registration number is the contact's field, never prefilled, even from a template installed when it was the sender's;
  // the signer is the "Business contact"; an activated onboarding reads "Business activated"; Ready to activate is shown for a signed business agreement.
  const oldTemplate = onboarding.resolveFields([{ ...box, key: "agent_registration_number", type: "text", role: "sender", label: "Registration number (ACN)" }], { ...values, agent_registration_number: "ACN 004 028 077" });
  assert.deepEqual([oldTemplate.printed.length, oldTemplate.recipient[0]?.role, oldTemplate.recipient[0]?.value, oldTemplate.recipient[0]?.label], [0, "agent", "", "Business/MARA/Registration number"]);
  assert.equal(onboarding.AGENT_ONBOARDING_FIELDS.agent_registration_number.role, "agent"); assert.ok(!onboarding.AGENT_ONBOARDING_FIELDS.agent_registration_number.autoOrAgent);
  assert.equal(onboarding.ONBOARDING_SIGNER_ROLE.label, "Business contact"); assert.equal(onboarding.STAGE_LABEL.activated, "Business activated");
  assert.ok(read("src/pages/admin/lib/agentOnboarding.ts").includes(`if (kind === "business" && stage === "agreement_signed") return "Ready to activate";`), "Ready to activate in the stage words");
  assert.equal(values.agent_year_founded, "2000", "Year founded is passed as agent_year_founded");
  // Without the switch (no ABR confirmation on the business), the earlier behaviour: values we hold are printed.
  assert.ok(onboarding.resolveFields(placed, values).printed.some((f) => f.key === "agent_legal_entity"), "earlier behaviour unchanged without the prefill");

  // Signing checks: the title from the list; different referee emails; the same name is only a warning.
  assert.match(String(abrLib.checkApplicationAnswers({ contact_title: "Pat Contact" }).error), /title from the list/);
  assert.equal(abrLib.checkApplicationAnswers({ contact_title: "Dr" }).error, null);
  assert.match(String(abrLib.checkApplicationAnswers({ ref1_email: "Ref@Example.test", ref2_email: "ref@example.test " }).error), /different email/);
  // Business Rules agents.referee_emails_must_differ = "May be the same" (batch 4): the same address is accepted for both referees.
  assert.equal(abrLib.checkApplicationAnswers({ ref1_email: "Ref@Example.test", ref2_email: "ref@example.test " }, { refereeEmailsDistinct: false }).error, null);
  assert.deepEqual(abrLib.checkApplicationAnswers({ ref1_email: "a@example.test", ref2_email: "b@example.test", ref1_contact_name: "Sam Lee", ref2_contact_name: "sam lee" }), { error: null, warnings: ["Both references have the same contact name. Check that they are two different people."] });

  // F04 wizard (2026-11-19): the public ABN Lookup page (no GUID) gives the same prefill; PURVA TECH PTY LTD (86 603 584 676) has no business name.
  const abnLib = await load.import<typeof import("../supabase/functions/_shared/validation/abn.ts")>("../supabase/functions/_shared/validation/abn.ts");
  const purvaHtml = `<h1>Current details for ABN 86 603 584 676</h1><table><tr><th>Entity name:</th><td>PURVA TECH PTY LTD</td></tr><tr><th>ABN status:</th><td>Active from 07 Jan 2015</td></tr><tr><th>Entity type:</th><td>Australian Private Company</td></tr>` +
    `<tr><th>Goods &amp; Services Tax (GST):</th><td>Registered from 07 Jan 2015</td></tr><tr><th>Main business location:</th><td>VIC 3029</td></tr></table>` +
    `<table><caption>ASIC registration - ACN or ARBN</caption><tr><td>603 584 676</td></tr></table>`;
  const purvaPage = abnLib.parseAgencyAbnPage(purvaHtml, "86603584676");
  if (purvaPage.legalName) {
    const purva = abrLib.pageToAbrDetails(purvaPage);
    const pv = abrLib.abrApplicationValues({ details: purva, confirmed: null, contact: { givenName: "", familyName: "", email: "", phone: "" } });
    assert.deepEqual([pv.agent_trading_name, pv.agent_year_founded, pv.agent_acn, pv.agent_gst_registered], ["PURVA TECH PTY LTD", "2015", "603 584 676", "YES"], "trading name falls back to the entity name; year from the ABN status date; the ACN");
    assert.deepEqual(abrLib.abrFactLines(abrLib.abrFacts(purva, "2026-11-19T00:00:00Z")).map((l) => l.value), ["Active from 07 Jan 2015", "Australian Private Company", "GST registered from 07 Jan 2015"]);
  }
  assert.equal(abnLib.abrPageDate("Registered from 07 Jan 2015"), "2015-01-07"); assert.equal(abnLib.abrPageDate("Cancelled"), "");
  assert.equal(onboarding.composeRegistrationNumber("603584676", "1234567"), "ACN 603 584 676 / MARN 1234567");
  assert.equal(onboarding.composeRegistrationNumber("", "1234567"), "MARN 1234567"); assert.equal(onboarding.composeRegistrationNumber("603 584 676", ""), "ACN 603 584 676"); assert.equal(onboarding.composeRegistrationNumber("", ""), "");
  assert.equal(onboarding.F04_DECLARATIONS.length, 5); assert.ok(onboarding.F04_DECLARATIONS.find((d) => d.key === "code_of_ethics")?.link, "the Code of Ethics has its link");
  assert.throws(() => signingCore.checkApplicationSubmission({ acn: "", marn: "", declarations: Object.fromEntries(onboarding.F04_DECLARATIONS.map((d) => [d.key, true])) }, { litigation_involved: "YES" }), /details of the litigation/);
  assert.throws(() => signingCore.checkApplicationSubmission({ acn: "", marn: "", declarations: Object.fromEntries(onboarding.F04_DECLARATIONS.map((d) => [d.key, true])) }, { works_with_sub_agents: "YES" }), /sub-agent agency/);
  // The function: the lookup is admin-only, cached by ABN, and reports "not set up" without a GUID; Add business keeps the confirmed values
  // on the business (a failure there still saves the business and sends the form, without the prefill).
  const rpcs: Array<[string, Record<string, unknown>]> = []; const adminCalls: string[] = [];
  const mkPorts = (guid: string) => ({ isServiceCaller: false, later: (w: Promise<unknown>) => w.then(() => undefined), letterhead: async () => null, uuid: () => "00000000-0000-4000-8000-00000000eeee",
    abr: { guid, fetch: fetchWith(() => new Response(answer(found))) },
    admin: async (action: string) => { adminCalls.push(action); if (action === "subject_search") return []; throw new Error(`unexpected ${action}`); },
    callerRpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push([name, args]);
      if (name === "abr_lookup_save") return "2026-11-19T00:00:00Z";
      if (name === "agency_onboarding_templates") return [];
      throw new Error(`unexpected rpc ${name}`);
    },
    serviceRpc: async () => { throw new Error("no service calls"); }, service: async () => false,
    storage: { download: async () => null, upload: async () => true, remove: async () => undefined, signedUrl: async () => null },
    mail: { provider: null, config: { from: null, siteUrl: "", adminTo: [] } } }) as unknown as Parameters<typeof signingCore.handleSigning>[1];
  const looked = await signingCore.handleSigning({ body: { action: "agent_onboarding_abn_lookup", abn: "49 004 028 077" }, upload: null, ip: null, userAgent: null }, mkPorts("guid-1")) as { configured: boolean; ok: boolean; details: { entityName: string }; cached: boolean };
  assert.ok(looked.configured && looked.ok && looked.details.entityName === "BHP GROUP LIMITED" && looked.cached, "looked up and cached");
  assert.ok(adminCalls.includes("subject_search"), "administrators only");
  const saved = rpcs.find(([name]) => name === "abr_lookup_save")!;
  assert.equal(saved[1].p_abn, BHP); assert.equal((saved[1].p_raw as { EntityName: string }).EntityName, "BHP GROUP LIMITED");
  const unset = await signingCore.handleSigning({ body: { action: "agent_onboarding_abn_lookup", abn: BHP }, upload: null, ip: null, userAgent: null }, mkPorts("")) as { configured: boolean; ok: boolean };
  assert.deepEqual([unset.configured, unset.ok], [false, false], "no GUID: the CMS uses the earlier lookup");

  // The source: the GUID only from the function's environment, the sign step runs the checks, the signing page has the title list.
  assert.match(read("supabase/functions/document-signing/index.ts"), /Deno\.env\.get\("EF_ABR_GUID"\) \|\| Deno\.env\.get\("ABR_GUID"\)/);
  assert.ok(!/EF_ABR_GUID|ABR_GUID/.test(read("src/pages/admin/components/AddBusinessForm.tsx") + read("src/lib/signingApi.ts")), "the GUID never reaches the browser");
  assert.ok(read("supabase/functions/document-signing/core.ts").includes("checkApplicationAnswers(byKey, "), "the server refuses what the page refuses");
  assert.ok(read("src/pages/SigningPage.tsx").includes(`f.key === "contact_title"`) && read("src/pages/SigningPage.tsx").includes("F04_TITLES.map"), "the title is a list on the signing page");
  const migration = read("supabase/migrations/20261119103517_abn_prefill.sql");
  assert.ok(["create table public.abr_lookups", "abr_raw jsonb", "abr_fetched_at timestamptz", "agency_abr_attach", "agency_onboarding_prefill_record", "'prefill_reviewed'", "after update of answers on public.agency_onboarding"].every((s) => migration.includes(s)), "cache, business record, prefill history");
});


test("F04 prefill on open (2026-11-19): an old request's blank fields are filled server side from the cached register and the business record, existing values never overwritten; office_province never holds a postcode; referees checked (duplicates, self) server side; phones as E.164; the short wizard's rules", async () => {
  const abrLib = await load.import<typeof import("../supabase/functions/_shared/validation/abr.ts")>("../supabase/functions/_shared/validation/abr.ts");
  const logic = await load.import<typeof import("../src/components/signing/f04WizardLogic.ts")>("../src/components/signing/f04WizardLogic.ts");
  const purva = { abn: "86603584676", acn: "603584676", abnStatus: "Active", active: true, statusFrom: "2015-01-07", entityName: "PURVA TECH PTY LTD", entityType: "Australian Private Company",
    businessNames: [] as string[], gstRegistered: true, gstFrom: "2015-01-07", state: "VIC", postcode: "3029", sourceUrl: "https://abr.business.gov.au/ABN/View?abn=86603584676" };
  // A request sent before v31 (like 86b0d7f5, PURVA TECH): trading name, year founded, website, street, suburb and title blank; the postcode in Province.
  const sentValues: Record<string, string> = { agent_legal_entity: "PURVA TECH PTY LTD", agent_agency_name: "PURVA TECH PTY LTD", agent_abn_form: "86 603 584 676", "agent_gst_registered:YES": "true",
    contact_email: "kept@example.test", contact_phone: "+61938938943", office_state: "VIC", office_province: "3029", office_country: "Australia" };
  const keys = ["agent_legal_entity", "agent_trading_name", "agent_agency_name", "agent_abn_form", "agent_year_founded", "agent_gst_registered:YES", "agent_gst_registered:NO", "contact_title",
    "contact_email", "contact_phone", "agent_website", "office_street_address", "office_suburb", "office_state", "office_province", "office_country"];
  const fieldsOf = (values: Record<string, string>) => keys.map((key, i) => ({ id: `f${i}`, type: key.includes(":") ? "checkbox" : "text", key, label: key, page: 1, x: 0, y: 0, w: 0.1, h: 0.02, required: false, value: values[key] ?? "" }));
  const original = new TextEncoder().encode("%PDF-1.4 test"); const originalHash = await signingCore.sha256Hex(original);
  const rpcs: Array<[string, Record<string, unknown>]> = []; let fetches = 0; let cached: unknown = purva;
  const html = `<h1>Current details for ABN 86 603 584 676</h1><table><tr><th>Entity name:</th><td>PURVA TECH PTY LTD</td></tr><tr><th>ABN status:</th><td>Active from 07 Jan 2015</td></tr>` +
    `<tr><th>Entity type:</th><td>Australian Private Company</td></tr><tr><th>Goods &amp; Services Tax (GST):</th><td>Registered from 07 Jan 2015</td></tr><tr><th>Main business location:</th><td>VIC 3029</td></tr></table>` +
    `<table><caption>ASIC registration - ACN or ARBN</caption><tr><td>603 584 676</td></tr></table>`;
  const openWith = async (fields: ReturnType<typeof fieldsOf>, extra: Record<string, unknown> = {}) => signingCore.handleSigning({ body: { action: "open", token: "d".repeat(64), ...extra }, upload: null, ip: "203.0.113.5", userAgent: "test" }, {
    isServiceCaller: false, uuid: () => "00000000-0000-4000-8000-0000000000aa", later: () => undefined, letterhead: async () => null, mail: { provider: null, config: { from: null, siteUrl: "", adminTo: [] } },
    abr: { guid: "", fetch: (async () => { fetches++; return new Response(html); }) as unknown as typeof fetch },
    service: async (action: string) => {
      if (action === "rate") return true;
      if (action === "open") return { id: "50000000-0000-4000-8000-000000000001", reference: "SLIT-2026-000040", title: "Agent application form: PURVA TECH PTY LTD", state: "viewed", original_path: "x/original.pdf", original_hash: originalHash,
        recipient: { id: "r1", name: "Gourav Gupta", email: "kept@example.test", state: "viewed" }, fields, signers: [], onboarding: { id: "o1", kind: "application", formPages: 2, agencyName: "PURVA TECH PTY LTD" } };
      throw new Error(`unexpected ${action}`);
    },
    admin: async () => { throw new Error("no admin"); },
    serviceRpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push([name, args]);
      if (name === "agency_onboarding_wizard_get") return { draft: null, saved_at: null, facts: abrLib.abrFacts(purva, "2026-11-18T08:47:08Z"), abn: "86603584676", abr: null, attachments: {},
        record: { contact_email: "other@example.test", agent_website: "https://purva.example", office_street_address: "1 Test St", office_suburb: "Altona North", contact_title: "Mr", contact_phone: "0412 345 678" } };
      if (name === "abr_business_cache_get") return cached;
      if (name === "abr_business_cache_put") return null;
      if (name === "agency_onboarding_prefill_blanks") return args.p_values;
      if (name === "agency_onboarding_facts_save") return null;
      throw new Error(`unexpected rpc ${name}`);
    },
    storage: { download: async () => original, upload: async () => true, remove: async () => undefined, signedUrl: async () => "https://signed.example/x" },
  } as unknown as Parameters<typeof signingCore.handleSigning>[1]) as Promise<{ fields: Array<{ key: string; value: string }>; application: { prefill: Record<string, string>; filled: string[] } }>;

  const opened = await openWith(fieldsOf(sentValues));
  const at = (key: string) => opened.fields.find((f) => f.key === key)!.value;
  const filled = rpcs.find(([name]) => name === "agency_onboarding_prefill_blanks")![1].p_values as Record<string, string>;
  assert.deepEqual(Object.keys(filled).sort(), ["agent_trading_name", "agent_website", "agent_year_founded", "contact_title", "office_street_address", "office_suburb"], "only the blank keys are sent to be filled");
  assert.deepEqual([at("agent_trading_name"), at("agent_year_founded"), opened.application.prefill.agent_acn], ["PURVA TECH PTY LTD", "2015", "603 584 676"], "ACN, trading name and year founded come back filled");
  assert.deepEqual([at("agent_website"), at("office_street_address"), at("office_suburb"), at("contact_title")], ["https://purva.example", "1 Test St", "Altona North 3029", "Mr"], "website, address, suburb (with the postcode) and title from the business record");
  assert.deepEqual([at("contact_email"), at("contact_phone"), at("agent_legal_entity"), at("office_province")], ["kept@example.test", "+61938938943", "PURVA TECH PTY LTD", "3029"], "values already there are never overwritten by the open");
  assert.equal(fetches, 0, "the cached register answer is used: no new lookup");
  // Follow-up (2026-11-18): the open also writes the ACN (digits) into the request's stored values and fixes their office row.
  assert.deepEqual(rpcs.find(([name]) => name === "agency_onboarding_record_fill")?.[1], { p_request: "50000000-0000-4000-8000-000000000001", p_values: { agent_acn: "603584676" } });
  assert.ok(!rpcs.some(([name]) => name === "abr_business_cache_put"), "a cache hit is not written again");
  // Nothing blank: no fill. A cache miss: the register is asked once and the answer cached.
  rpcs.length = 0;
  await openWith(fieldsOf({ ...sentValues, ...filled, agent_trading_name: "Purva", agent_year_founded: "2015", contact_title: "Ms" }));
  assert.ok(!rpcs.some(([name]) => name === "agency_onboarding_prefill_blanks"), "a form with nothing blank is left as it is");
  rpcs.length = 0; cached = null;
  const missed = await openWith(fieldsOf(sentValues));
  assert.equal(fetches, 1, "a cache miss asks the register (the public page without the GUID)");
  assert.equal((rpcs.find(([name]) => name === "abr_business_cache_put")![1].p_details as { entityName: string }).entityName, "PURVA TECH PTY LTD", "and caches the answer in abr_businesses");
  assert.equal(missed.fields.find((f) => f.key === "agent_year_founded")!.value, "2015");
  const migration = read("supabase/migrations/20261119153412_f04_prefill_short.sql");
  assert.ok(["coalesce(btrim(f.value), '') = ''", "on conflict (abn) do update", "public.abr_businesses", "p := p - 'office_province'", "'office_suburb', nullif(coalesce("].every((s) => migration.includes(s)),
    "the database fills blanks only, caches by ABN and moves the sign-up postcode to the Suburb box");

  // office_province never holds a postcode: the register's prefill, the wizard's values and the shared rule.
  const values = abrLib.abrApplicationValues({ details: purva, confirmed: null, contact: { givenName: "", familyName: "", email: "", phone: "" } });
  assert.ok(!("office_province" in values) && !("office_suburb" in values) && values.office_state === "VIC", "round 3: no postcode alone in the Suburb box");
  assert.deepEqual(onboarding.normalizeOfficeAddress({ office_province: "2166", office_suburb: "Cabramatta" }), { office_province: "", office_suburb: "Cabramatta 2166" });
  assert.deepEqual(onboarding.normalizeOfficeAddress({ office_province: "Punjab", office_suburb: "Ludhiana" }), { office_province: "Punjab", office_suburb: "Ludhiana" }, "an overseas province stays");
  assert.deepEqual(onboarding.splitSuburb("Altona North 3025"), { suburb: "Altona North", postcode: "3025" });
  const wizFields = fieldsOf(sentValues) as unknown as Parameters<typeof logic.initialF04>[0];
  const wiz = logic.initialF04(wizFields, null, { agent_acn: "603 584 676" }, null);
  assert.deepEqual([wiz.answers.office_province, wiz.answers.office_postcode, wiz.acn], ["", "", "603584676"], "round 3: the old Province postcode is dropped (no suburb name known: the address search fills it); the ACN in digits");
  const signed = logic.f04Values(wizFields, { ...wiz, answers: { ...wiz.answers, office_suburb: "Altona North" } });
  assert.deepEqual([signed[wizFields.find((f) => f.key === "office_suburb")!.id], signed[wizFields.find((f) => f.key === "office_province")!.id]], ["Altona North", ""]);
  const signedWithPostcode = logic.f04Values(wizFields, { ...wiz, answers: { ...wiz.answers, office_suburb: "Altona North", office_postcode: "3025" } });
  assert.equal(signedWithPostcode[wizFields.find((f) => f.key === "office_suburb")!.id], "Altona North 3025");

  // Referees (server rule, shared with the page): different emails and phones, neither is the applicant; phones with a country code.
  const me = { contact_given_name: "Ravi", contact_family_name: "Kumar", contact_email: "ravi@example.test", contact_phone: "+61412345678", declarant_name: "Ravi Kumar" };
  const two = { ref1_contact_name: "Priya Nair", ref1_email: "priya@example.test", ref1_phone: "+61400111222", ref2_contact_name: "Sam Lee", ref2_email: "sam@example.test", ref2_phone: "+61400333444" };
  assert.equal(abrLib.checkApplicationAnswers({ ...me, ...two }).error, null);
  assert.match(String(abrLib.checkApplicationAnswers({ ...me, ...two, ref2_phone: "0400 111 222" }).error), /different phone numbers/);
  assert.match(String(abrLib.checkApplicationAnswers({ ...me, ...two, ref1_email: "RAVI@example.test" }).error), /Reference 1 has your own email address/);
  assert.match(String(abrLib.checkApplicationAnswers({ ...me, ...two, ref2_phone: "0412 345 678" }).error), /Reference 2 has your own phone number/);
  assert.match(String(abrLib.checkApplicationAnswers({ ...me, ...two, ref2_contact_name: "ravi  KUMAR" }).error), /Reference 2 has your own name/);
  assert.match(String(abrLib.checkApplicationAnswers({ ...me, ...two, ref1_phone: "12345" }).error), /reference 1's phone with its country code/);
  // ... and the sign step refuses it in core.ts before anything is made.
  const signFields = Object.entries({ ...me, ...two, ref2_email: "ravi@example.test" }).map(([key, value], i) => ({ id: `s${i}`, type: "text", key, label: key, value }));
  await assert.rejects(signingCore.handleSigning({ body: { action: "sign", token: "e".repeat(64), name: "Ravi Kumar", agreed: true, values: {}, application: { acn: "", marn: "", declarations: {} } }, upload: null, ip: null, userAgent: null }, {
    isServiceCaller: false, later: () => undefined, uuid: () => "x",
    service: async (action: string) => { if (action === "rate") return true; if (action === "open") return { id: "s1", state: "viewed", recipient: { id: "r1", state: "viewed" }, fields: signFields, onboarding: { id: "o1", kind: "application" } }; throw new Error(`unexpected ${action}`); },
  } as unknown as Parameters<typeof signingCore.handleSigning>[1]), /Reference 2 has your own email address/, "server side in core.ts");
  // E.164.
  assert.deepEqual(["0412 345 678", "+91 98765 43210", "03 9123 4567", "12345", ""].map((p) => abrLib.phoneE164(p)), ["+61412345678", "+919876543210", "+61391234567", null, null]);

  // The short wizard: five steps since round 3 (Review & sign); chips with Other; an upload asked for on Yes; referee problems before signing.
  assert.deepEqual(logic.F04_STEPS.map((s) => s.short), ["Business", "References", "Contact", "Agency", "Review & sign"], "2026-11-20: the references straight after the business");
  assert.equal(logic.writeChips(["Accommodation", "Course counselling"], "Visa reviews", logic.SERVICES), "Course counselling, Accommodation, Visa reviews");
  assert.deepEqual(logic.readChips("Course counselling, Accommodation, Visa reviews", logic.SERVICES), { picked: ["Course counselling", "Accommodation"], other: "Visa reviews" });
  assert.deepEqual(logic.readChips("Canada, Other", logic.COUNTRIES), { picked: ["Canada"], other: "" }); assert.equal(logic.readChips("Canada", logic.COUNTRIES).other, null);
  const qFields = [{ id: "q1", type: "checkbox", key: "org_chart_attached:YES", label: "", page: 1, x: 0, y: 0, w: 0, h: 0, required: false, value: "" }, { id: "q2", type: "text", key: "services_provided", label: "", page: 1, x: 0, y: 0, w: 0, h: 0, required: false, value: "" }] as unknown as Parameters<typeof logic.f04Problems>[1];
  const agencyStep = (answers: Record<string, string>, files = {}) => logic.f04Problems(logic.F04_STEP.agency, qFields, { answers, acn: "", marn: "", declarations: {}, step: logic.F04_STEP.agency }, files);
  assert.match(agencyStep({ org_chart_attached: "YES" }).attach_org_chart, /Upload the organisational chart, or answer No/);
  assert.equal(agencyStep({ org_chart_attached: "YES" }, { org_chart: { name: "chart.pdf", size: 10 } }).attach_org_chart, undefined);
  assert.match(agencyStep({ services_provided: "Accommodation, Other" }).services_provided, /Name the other services/);
});

test("F04 round 3 (2026-11-18): year founded from the ABN's Active-from date (server and page, a blank draft value never hides it), names prefilled from the contact, Position chips with Other, I agree to all, ACN with spaces accepted at sign time, the Suburb box never a postcode alone", async () => {
  const abrLib = await load.import<typeof import("../supabase/functions/_shared/validation/abr.ts")>("../supabase/functions/_shared/validation/abr.ts");
  const logic = await load.import<typeof import("../src/components/signing/f04WizardLogic.ts")>("../src/components/signing/f04WizardLogic.ts");
  const field = (key: string, value = "", required = false) => ({ id: `f-${key}`, type: key.includes(":") ? "checkbox" : "text", key, label: key, page: 1, x: 0, y: 0, w: 0.1, h: 0.02, required, value });
  type WizFields = Parameters<typeof logic.initialF04>[0];
  // PURVA TECH (86 603 584 676) as kept on the business profile: Active from 07 Jan 2015, ACN 603 584 676, no business name.
  const purvaFacts = { abn: "86603584676", acn: "603584676", abnStatus: "Active", statusFrom: "2015-01-07", entityName: "PURVA TECH PTY LTD", entityType: "Australian Private Company",
    gstRegistered: true, gstFrom: "2015-01-07", sourceUrl: "https://abr.business.gov.au/ABN/View?abn=86603584676", fetchedAt: "2026-11-18T08:47:08Z" };

  // 1. Year founded from the ABN date.
  assert.deepEqual([abrLib.abrYearFounded("2015-01-07", "Active"), abrLib.abrYearFounded("2015-01-07", ""), abrLib.abrYearFounded("2019-03-01", "Cancelled"), abrLib.abrYearFounded("", "Active")], ["2015", "2015", "", ""],
    "the year of an active ABN's date; a cancelled ABN's date is its cancellation");
  assert.deepEqual(["1999", "2000", "2015", ""].map(abrLib.yearMayPredateAbn), [true, true, false, false], "1999 / 2000 (the ABN scheme's start) get the hint");
  assert.equal(abrLib.YEAR_BEFORE_ABN_HINT, "Business may be older than its ABN; edit if needed.");
  // Server: no register details at hand (lookup down, nothing cached), the profile's facts still give year, ACN, legal and trading name.
  const fromFacts = signingCore.f04Prefill({ details: null, confirmed: null, record: {}, facts: purvaFacts });
  assert.deepEqual([fromFacts.agent_year_founded, fromFacts.agent_acn, fromFacts.agent_legal_entity, fromFacts.agent_trading_name], ["2015", "603 584 676", "PURVA TECH PTY LTD", "PURVA TECH PTY LTD"]);
  // Page: the field holds 2015 but the saved draft holds "" (the real PURVA TECH draft): the draft's blank never empties it.
  const purvaFields = ["agent_trading_name", "agent_year_founded", "contact_position", "declarant_role", "office_suburb", "office_street_address"].map((k) => field(k)) as unknown as WizFields;
  purvaFields.find((f) => f.key === "agent_year_founded")!.value = "2015";
  const draft = { acn: "603 584 676", answers: { agent_trading_name: "PURVA TECH PTY LTD", agent_year_founded: "", contact_position: "Test", office_suburb: "Melbourne", office_postcode: "3000" }, declarations: {}, marn: "", step: 2 };
  const purva = logic.initialF04(purvaFields, purvaFacts, { agent_acn: "603 584 676", contact_given_name: "Gourav", contact_family_name: "Gupta", agent_legal_entity: "PURVA TECH PTY LTD" }, draft, "Recipient Name");
  assert.deepEqual([purva.answers.agent_year_founded, purva.acn, purva.answers.agent_trading_name, purva.answers.agent_legal_entity, purva.step], ["2015", "603584676", "PURVA TECH PTY LTD", "PURVA TECH PTY LTD", logic.F04_STEP.agency], "a draft saved at position 2 before 2026-11-20 was on Agency: it reopens there");
  // Page fallback with the field blank and no server fill: the card's date gives the year.
  const blankYear = logic.initialF04([field("agent_year_founded")] as unknown as WizFields, purvaFacts, null, null);
  assert.equal(blankYear.answers.agent_year_founded, "2015", "the page takes the year from the card's Active-from date when the server left it blank");
  assert.equal(logic.yearFromFacts({ statusFrom: "1999-11-01", abnStatus: "Active" }), "1999");

  // 2. Names fill themselves: the declarant is the contact (name and position); trading name falls back to the legal name.
  assert.deepEqual([purva.answers.declarant_name, purva.answers.declarant_role], ["Gourav Gupta", "Test"], "declarant from contact_given_name + contact_family_name, role from the position");
  const server = signingCore.f04Prefill({ details: null, confirmed: null, record: { contact_given_name: "Pat", contact_family_name: "Contact", contact_position: "Director" }, facts: purvaFacts });
  assert.deepEqual([server.declarant_name, server.declarant_role], ["Pat Contact", "Director"]);
  assert.equal(logic.initialF04([field("declarant_name")] as unknown as WizFields, null, null, null, "Only Recipient").answers.declarant_name, "Only Recipient", "no contact name: the recipient's");
  assert.equal(logic.initialF04([field("agent_trading_name"), field("agent_legal_entity", "ACME PTY LTD")] as unknown as WizFields, null, null, null).answers.agent_trading_name, "ACME PTY LTD");
  assert.equal(logic.TRADING_SAME_HINT, "Same as legal name; change if you trade differently");

  // 3. Position as chips: CEO / Director / Manager / Owner, or Other with the typed text (also the declaration's "Your role").
  assert.deepEqual([...logic.POSITIONS], ["CEO", "Director", "Manager", "Owner"]);
  assert.deepEqual(logic.readChoice("director", logic.POSITIONS), { picked: "Director", other: null });
  assert.deepEqual(logic.readChoice("Test", logic.POSITIONS), { picked: null, other: "Test" }, "a position not on the list is Other with its text");
  assert.deepEqual(logic.readChoice("Other", logic.POSITIONS), { picked: null, other: "" });
  assert.deepEqual([logic.writeChoice("CEO", null), logic.writeChoice(null, ""), logic.writeChoice(null, "Head of admissions"), logic.writeChoice(null, null)], ["CEO", "Other", "Head of admissions", ""]);
  // F04 pre-send SLIT signatory position (2026-11-21): the same chips; Other needs its text; the plain text is what is sent and printed.
  const wizard = read("src/components/signing/F04Wizard.tsx"), presend = read("src/pages/admin/components/F04PresendDialog.tsx");
  assert.ok(wizard.includes(`<ChoiceChips id="prefill-signatory-position" label="SLIT signatory position" required`) && !wizard.includes(`id="f04-prefill-signatory-position" name="adminPosition"`), "chips, not a text box");
  assert.ok(presend.includes("readChoice(o.signatory.position, POSITIONS)") && presend.includes("choiceUnnamed(signatory.position)") && presend.includes("adminPosition: signatory.position.trim()"));
  assert.deepEqual([logic.choiceUnnamed("Other"), logic.choiceUnnamed("Head of admissions"), logic.choiceUnnamed("CEO")], [true, false, false]);
  const contactFields = [field("contact_position", "", true)] as unknown as WizFields;
  const contactStep = (position: string) => logic.f04Problems(logic.F04_STEP.contact, contactFields, { answers: { contact_position: position }, acn: "", marn: "", declarations: {}, step: logic.F04_STEP.contact }).contact_position;
  assert.deepEqual([contactStep(""), contactStep("Other"), contactStep("Head of admissions"), contactStep("Owner")], ["Enter the contact's position.", "Type the position.", undefined, undefined]);
  const reviewFields = [field("declarant_name", "", true), field("declarant_role", "", true)] as unknown as WizFields;
  const reviewStep = (answers: Record<string, string>, declarations: Record<string, boolean> = logic.allDeclarations(true)) => logic.f04Problems(logic.REVIEW_STEP, reviewFields, { answers, acn: "", marn: "", declarations, step: logic.REVIEW_STEP });
  assert.equal(reviewStep({ declarant_name: "Pat Contact", declarant_role: "Other" }).declarant_role, "Type your role.");
  assert.deepEqual(reviewStep({ declarant_name: "Pat Contact", declarant_role: "Director" }), {});

  // 4. I agree to all: every statement at once; some ticked = indeterminate; the server still needs each one.
  const all = logic.allDeclarations(true);
  assert.equal(logic.declarationsState(all), "all"); assert.equal(logic.declarationsState({}), "none");
  assert.equal(logic.declarationsState({ ...all, [onboarding.F04_DECLARATIONS[0].key]: false }), "some");
  assert.equal(logic.declarationsState(logic.allDeclarations(false)), "none", "unticking all clears every line");
  assert.equal(Object.keys(reviewStep({ declarant_name: "Pat Contact", declarant_role: "Owner" }, { ...all, [onboarding.F04_DECLARATIONS[2].key]: false })).length, 1, "one line unticked: one problem");
  assert.throws(() => signingCore.checkApplicationSubmission({ acn: "", marn: "", declarations: { ...all, [onboarding.F04_DECLARATIONS[0].key]: false } }, {}), /Tick every declaration statement/);

  // 5. ACN: digits before the check and in storage; "004 028 077" (the test F04's draft) is accepted at sign time.
  assert.equal(signingCore.checkApplicationSubmission({ acn: "004 028 077", marn: "", declarations: all }, {}).acn, "004028077");
  assert.equal(signingCore.checkApplicationSubmission({ acn: "004-028-077", marn: "", declarations: all }, {}).acn, "004028077");
  assert.throws(() => signingCore.checkApplicationSubmission({ acn: "004 028 07", marn: "", declarations: all }, {}), /The ACN has 9 digits/);
  assert.equal(abrLib.printAcn("004028077"), "004 028 077", "shown in its groups");
  assert.equal(logic.f04Problems(logic.F04_STEP.business, [] as unknown as WizFields, { answers: {}, acn: "004 028 077", marn: "", declarations: {}, step: logic.F04_STEP.business }).acn, undefined, "the page accepts spaces too");

  // 6. The Suburb box never holds a postcode alone (the test F04 stored "3000").
  assert.deepEqual(onboarding.normalizeOfficeAddress({ office_suburb: "3000" }), { office_suburb: "" });
  assert.deepEqual(onboarding.normalizeOfficeAddress({ office_province: "3029", office_suburb: "" }), { office_province: "", office_suburb: "" });
  assert.deepEqual(onboarding.normalizeOfficeAddress({ office_province: "3029", office_suburb: "3000" }), { office_province: "", office_suburb: "" });
  assert.equal(signingCore.f04Prefill({ details: null, confirmed: null, record: { office_suburb: "3000" } }).office_suburb, undefined, "the open never fills a postcode alone");
  assert.equal(signingCore.f04Prefill({ details: { ...abrLib.factsToDetails(purvaFacts)!, postcode: "3029" }, confirmed: null, record: { office_suburb: "Altona North" } }).office_suburb, "Altona North 3029", "the register's postcode joins a named suburb");
  const zz = logic.initialF04([field("office_suburb", "3000"), field("office_street_address")] as unknown as WizFields, null, null, null);
  assert.deepEqual([zz.answers.office_suburb, zz.answers.office_postcode], ["", ""], "a stored postcode alone opens blank for the address search");
  const suburbField = [field("office_suburb")] as unknown as WizFields;
  assert.equal(logic.f04Values(suburbField, { ...zz, answers: { office_suburb: "", office_postcode: "3000" } })["f-office_suburb"], "", "never signed as a postcode alone");
  assert.equal(logic.f04Problems(logic.F04_STEP.contact, suburbField, { ...zz, answers: { office_suburb: "", office_postcode: "3000", office_country: "Australia" } }).office_suburb, "Enter the suburb or city for this postcode.");
  const sql = read("supabase/migrations/20261119171538_f04_round3.sql");
  assert.ok(["if v_sub ~ '^\\d{4}$' then", "p := p - 'office_suburb';", "'office_suburb', nullif(v_sub, '')", "update hr.sign_fields f set value = null", "r.state in ('sent', 'viewed', 'email_failed')"].every((s) => sql.includes(s)),
    "the send-side SQL drops a postcode-only suburb and unsigned F04s are cleaned");

  // 7. Five steps with a review; the sticky footer, Enter = Next, autosave and the success screen are in the page.
  assert.equal(logic.F04_STEPS[logic.REVIEW_STEP].id, "review");
  const page = read("src/components/signing/F04Wizard.tsx");
  assert.ok(["stickyFooter", "e.key !== \"Enter\"", "AUTOSAVE_PAUSE", "Saved ✓", "I agree to all of the above", "indeterminate", "We've emailed your 2 referees", "SLIT reviews", "You'll receive the agent agreement",
    "f04-download", "f04-review-edit-", "Back to review", "Dancing_Script", "f04-ethics-link"].every((s) => page.includes(s)), "the round-3 page pieces are there");
  assert.ok(read("src/index.css").replace(/\r\n/g, "\n").includes("prefers-reduced-motion: reduce) {\n  .f04-tick-circle"),"the success tick respects reduced motion");
});

test("F04 follow-ups (2026-11-18): a company's ACN from its ABN when the register gives none (send, open, page), check digit verified; a postcode kept as the Province leaves the stored values of unsigned F04s", async () => {
  const abrLib = await load.import<typeof import("../supabase/functions/_shared/validation/abr.ts")>("../supabase/functions/_shared/validation/abr.ts");
  const logic = await load.import<typeof import("../src/components/signing/f04WizardLogic.ts")>("../src/components/signing/f04WizardLogic.ts");
  assert.deepEqual([abrLib.acnValid("603584676"), abrLib.acnValid("004 028 077"), abrLib.acnValid("123456789"), abrLib.acnValid("60358467")], [true, true, false, false], "ASIC's ACN check digit");
  assert.equal(abrLib.acnFromAbn("86 603 584 676", "Australian Private Company"), "603584676", "PURVA TECH: the last nine digits of a company's ABN");
  assert.equal(abrLib.acnFromAbn("49004028077", "Australian Public Company"), "004028077");
  assert.equal(abrLib.acnFromAbn("86603584676", "Individual/Sole Trader"), "", "not a company: no ACN");
  assert.equal(abrLib.acnFromAbn("12345678901", "Australian Private Company"), "", "nine digits that fail the check digit are not an ACN");
  // 2026-11-20 (owner): one rule for the business's ACN (resolveAcn here, public.acn_resolve in the database).
  // Company: the register's ASIC number first, else the last nine digits of the ABN.
  assert.deepEqual(abrLib.resolveAcn({ abn: "49 004 028 077", acn: "004 028 077", entityType: "Australian Public Company" }), { acn: "004028077", source: "register" }, "BHP: the register's ACN");
  assert.deepEqual(abrLib.resolveAcn({ abn: "49004028077", acn: "", entityType: "Australian Public Company" }), { acn: "004028077", source: "derived" }, "BHP without the register's ACN: derived");
  assert.deepEqual(abrLib.resolveAcn({ abn: "86603584676", acn: null, entityType: "Australian Private Company" }), { acn: "603584676", source: "derived" }, "a private company: derived");
  assert.deepEqual(abrLib.resolveAcn({ abn: "49004028077", acn: "123456789", entityType: "Australian Public Company" }), { acn: "004028077", source: "derived" }, "an invalid register value is not used");
  // Sole trader: never derived, even when the ABN's last nine digits would pass the ACN check.
  assert.deepEqual(abrLib.resolveAcn({ abn: "49004028077", acn: "", entityType: "Individual/Sole Trader" }), { acn: "", source: null }, "sole trader: blank");
  assert.deepEqual(abrLib.resolveAcn({ abn: "99386710529", acn: "", entityType: "Individual/Sole Trader" }), { acn: "", source: null }, "PURVA (sole trader): blank");
  // Trust and partnership: never derived (a trust's ABN is not its trustee company's).
  assert.deepEqual(abrLib.resolveAcn({ abn: "49004028077", acn: "", entityType: "Discretionary Trading Trust" }), { acn: "", source: null }, "trust: blank");
  assert.deepEqual(abrLib.resolveAcn({ abn: "49004028077", acn: "", entityType: "Trustee company of a Fixed Unit Trust" }), { acn: "", source: null }, "anything naming a trust: blank");
  assert.deepEqual(abrLib.resolveAcn({ abn: "49004028077", acn: "", entityType: "Family Partnership" }), { acn: "", source: null }, "partnership: blank");
  assert.equal(abrLib.isCompanyEntity("Australian Private Company") && abrLib.isCompanyEntity("Australian Public Company"), true);
  // The agreement's "(ABN ...)" blank.
  assert.equal(abrLib.abnWithAcn("49004028077", "004028077"), "49 004 028 077, ACN 004 028 077");
  assert.equal(abrLib.abnWithAcn("99386710529", ""), "99 386 710 529", "no ACN: the ABN alone");
  // The F04 values follow the same rule (a sole trader's or a trust's form opens with the ACN blank and editable).
  const noContact = { givenName: "", familyName: "", email: "", phone: "" };
  const soleTrader = { abn: "49004028077", acn: "", abnStatus: "Active", active: true, statusFrom: "", entityName: "J SMITH", entityType: "Individual/Sole Trader",
    businessNames: [] as string[], gstRegistered: false, gstFrom: "", state: "VIC", postcode: "3000", sourceUrl: "" };
  assert.equal(abrLib.abrApplicationValues({ details: soleTrader, confirmed: null, contact: noContact }).agent_acn ?? "", "", "sole trader: the F04 ACN stays blank");
  assert.equal(abrLib.abrApplicationValues({ details: { ...soleTrader, entityName: "THE SMITH FAMILY TRUST", entityType: "Discretionary Trading Trust" }, confirmed: null, contact: noContact }).agent_acn ?? "", "", "trust: the F04 ACN stays blank");
  assert.equal(abrLib.abrApplicationValues({ details: { ...soleTrader, entityName: "BHP GROUP LIMITED", entityType: "Australian Public Company", acn: "004028077" }, confirmed: null, contact: noContact }).agent_acn,
    "004 028 077", "company: the F04 ACN from the register");
  // The database rule is the same (migration 20261120113517).
  const acnSql = readFileSync(new URL("../supabase/migrations/20261120113517_agency_acn.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(acnSql.includes("p_entity_type ~* 'company' and p_entity_type !~* '(trust|partnership|sole\\s*trader|individual)'"), "the same company rule in SQL");
  assert.ok(acnSql.includes("if public.acn_valid(v_reg) then return jsonb_build_object('acn', v_reg, 'source', 'register');"), "the register's ACN first");
  // Send: the register's details without an ACN.
  const purva = { abn: "86603584676", acn: "", abnStatus: "Active", active: true, statusFrom: "2015-01-07", entityName: "PURVA TECH PTY LTD", entityType: "Australian Private Company",
    businessNames: [] as string[], gstRegistered: true, gstFrom: "2015-01-07", state: "VIC", postcode: "3029", sourceUrl: "" };
  assert.equal(abrLib.abrApplicationValues({ details: purva, confirmed: null, contact: { givenName: "", familyName: "", email: "", phone: "" } }).agent_acn, "603 584 676", "send: derived and printed");
  // Open: the profile's facts without an ACN.
  assert.equal(signingCore.f04Prefill({ details: null, confirmed: null, record: {}, facts: { ...abrLib.abrFacts(purva, "2026-11-18T08:47:08Z") } }).agent_acn, "603 584 676", "open: derived from the facts");
  // Page: no prefill, facts without an ACN.
  const page = logic.initialF04([] as unknown as Parameters<typeof logic.initialF04>[0], { ...abrLib.abrFacts(purva, "2026-11-18T08:47:08Z") }, null, null);
  assert.equal(page.acn, "603584676", "page fallback");
  assert.ok(read("supabase/functions/document-signing/onboarding.ts").includes("if (values.agent_acn) values.agent_acn = acnDigits(values.agent_acn);"), "send: the stored values keep the ACN as digits");
  const sql = read("supabase/migrations/20261119190841_f04_acn_province.sql");
  assert.ok(["create or replace function public.acn_from_abn", "agency_onboarding_record_fill", "agency_onboarding_office_fix", "v := v - 'office_province'", "update hr.sign_fields f set value = null",
    "r.state in ('sent', 'viewed', 'email_failed')", "grant execute on function public.agency_onboarding_record_fill(uuid, jsonb) to service_role"].every((s) => sql.includes(s)), "the migration fills the ACN and clears a Province postcode on unsigned F04s only");
});

test("Agency onboarding review loop (2026-11-18): one wizard in three modes, flagged answers only in a correction (locked server side), staff changes as a diff, revision values from the answers, F04 never chosen by hand, statuses", async () => {
  const logic = await load.import<typeof import("../src/components/signing/f04WizardLogic.ts")>("../src/components/signing/f04WizardLogic.ts");
  type WizFields = Parameters<typeof logic.initialF04>[0];
  const field = (key: string, value = "", type = key.includes(":") ? "checkbox" : "text") => ({ id: `f-${key}`, type, key, label: key, page: 1, x: 0, y: 0, w: 0.1, h: 0.02, required: false, value });
  // Flags: an answer key, "acn" / "marn", or the whole office address.
  assert.equal(onboarding.correctionFlagged("agent_trading_name", { agent_trading_name: "" }), true);
  assert.equal(onboarding.correctionFlagged("office_suburb", { office_address: "Wrong suburb" }), true, "one flag covers the office address");
  assert.equal(onboarding.correctionFlagged("contact_email", { office_address: "" }), false);
  // The steps a correction shows: those with a flagged answer, then Review & sign.
  const ids = (steps: number[]) => steps.map((i) => logic.F04_STEPS[i].id);
  assert.deepEqual(["acn", "office_address", "litigation_involved", "ref2_phone", "agent_year_founded"].map((k) => logic.F04_STEPS[logic.stepOfKey(k)].id), ["business", "contact", "agency", "references", "business"]);
  assert.deepEqual(ids(logic.visibleSteps("correction", { ref1_email: "x", agent_trading_name: "y" })), ["business", "references", "review"]);
  assert.deepEqual(ids(logic.visibleSteps("admin-review", { ref1_email: "x" })), ["business", "references", "contact", "agency", "review"], "staff see every step");
  assert.deepEqual(ids(logic.visibleSteps("agent", null)), ["business", "references", "contact", "agency", "review"]);
  assert.equal(logic.correctionEditable("declarant_name", {}), true, "the declaration is given again");
  assert.equal(logic.correctionEditable("contact_email", { agent_trading_name: "" }), false);
  // Server side (core.ts): a correction's unflagged fields keep the values they were sent with, whatever the page posts.
  const fields = [field("agent_trading_name", "Old Pty Ltd"), field("contact_email", "pat@example.test"), field("litigation_involved:YES", ""), field("litigation_involved:NO", "true"),
    field("declarant_name", "Pat"), field("agent_registration_number", "ACN 603 584 676")];
  const posted: Record<string, unknown> = { "f-agent_trading_name": "New Pty Ltd", "f-contact_email": "hacker@example.test", "f-litigation_involved:YES": "true", "f-litigation_involved:NO": "false", "f-declarant_name": "Pat Probe", "f-agent_registration_number": "x" };
  signingCore.lockUnflagged(fields, posted, { agent_trading_name: "Use the registered name" });
  assert.deepEqual(posted, { "f-agent_trading_name": "New Pty Ltd", "f-contact_email": "pat@example.test", "f-litigation_involved:YES": "false", "f-litigation_involved:NO": "true", "f-declarant_name": "Pat Probe", "f-agent_registration_number": "x" },
    "only the flagged answer and the declaration change; the registration box is composed again from ACN / MARN");
  assert.equal(signingCore.F04_SYSTEM_KEY, onboarding.AGENT_ONBOARDING_DOCS.form.key);
  assert.match(signingCore.F04_NOT_HERE, /sent automatically/);
  // 2026-11-21: every onboarding blank (F04, P06, F05) stays in the onboarding flow: hidden in New signing request and refused by create.
  assert.deepEqual([...signingCore.ONBOARDING_SYSTEM_KEYS].sort(), Object.values(onboarding.AGENT_ONBOARDING_DOCS).map((d) => d.key).sort());
  assert.ok(read("src/pages/admin/components/signing/ComposeRequest.tsx").includes('!ONBOARDING_KEYS.has(t.system_key ?? "")') && read("src/pages/admin/components/signing/ComposeRequest.tsx").includes('<option value="agency">An agency</option>'));
  assert.ok(signing.SUBJECT_VARIABLES.agency.includes("agency.commission") && signing.SUBJECT_VARIABLES.agency.includes("agency.legal_name") && signing.SUBJECT_VARIABLES.agency.includes("agency.abn"), "agency variables");
  // Staff review: the wizard reads the answers; Save sends only what changed (in the server's answer format, ACN digits).
  const reviewed = logic.reviewFields([{ id: "a", key: "agent_trading_name", type: "text", label: "", required: false, page: 1 }, { id: "b", key: "litigation_involved:YES", type: "checkbox", label: "", required: true, page: 1 },
    { id: "c", key: "litigation_involved:NO", type: "checkbox", label: "", required: true, page: 1 }, { id: "d", key: "office_suburb", type: "text", label: "", required: false, page: 1 }],
    { agent_trading_name: "Old Pty Ltd", litigation_involved: "NO", office_suburb: "Melbourne 3000", agent_acn: "603584676" });
  assert.deepEqual(reviewed.map((f) => f.value), ["Old Pty Ltd", "", "true", "Melbourne 3000"]);
  const opened = logic.initialF04(reviewed, null, { agent_acn: "603584676", agent_marn: "1234567" }, null);
  assert.deepEqual([opened.acn, opened.marn], ["603584676", "1234567"], "the review opens with the reviewed ACN and MARN");
  assert.deepEqual(logic.reviewChanges(reviewed, opened, opened), {}, "opening changes nothing");
  const edited = { ...opened, acn: "004028077", answers: { ...opened.answers, agent_trading_name: "New Pty Ltd", litigation_involved: "YES", office_postcode: "3001" } };
  assert.deepEqual(logic.reviewChanges(reviewed, opened, edited), { agent_trading_name: "New Pty Ltd", litigation_involved: "YES", office_suburb: "Melbourne 3001", agent_acn: "004028077" });
  // The staff-edited revision is drawn from the answers (tick boxes, the registration box).
  const onb = await load.import<typeof import("../supabase/functions/document-signing/onboarding.ts")>("../supabase/functions/document-signing/onboarding.ts");
  assert.deepEqual(onb.valuesFromAnswers([{ key: "agent_trading_name", type: "text" }, { key: "litigation_involved:YES", type: "checkbox" }, { key: "litigation_involved:NO", type: "checkbox" },
    { key: "agent_registration_number", type: "text" }, { key: "agent_signature_form", type: "signature", value: "kept" }, { key: "agent_abn_form", type: "text" }],
    { agent_trading_name: "New Pty Ltd", litigation_involved: "YES", agent_acn: "603584676", agent_marn: "123", agent_abn: "86603584676" }),
    ["New Pty Ltd", "true", "false", "ACN 603 584 676 / MARN 123", "kept", "86603584676"]);
  for (const action of ["agent_onboarding_review_save", "agent_onboarding_correction_send", "agent_onboarding_approve"]) assert.equal(typeof onb.ONBOARDING_ACTIONS[action], "function", action);
  // The statuses and the database rules (lab-checked; here the migration text).
  assert.deepEqual([...onboarding.BUSINESS_STATUS_FLOW], ["Application sent", "Awaiting referees", "Ready for review", "Correction requested", "Resubmitted", "Active"]);
  const sql = read("supabase/migrations/20261119232741_onboarding_review_loop.sql");
  assert.ok(["'correction_requested', 'resubmitted'", "create or replace function public.agency_onboarding_label", "create or replace function public.agency_onboarding_approve", "create or replace function public.agency_business_release",
    "grant execute on function public.agency_business_release(uuid) to service_role", "perform public.agency_onboarding_resubmitted(", "'Referee details corrected by the applicant'", "when a.status = 'Active' and public.agency_awaiting_agreement(a.id) then 'Onboarding'",
    "'staff_edit'", "agent_application_edited", "Resubmitted: review the corrections"].every((s) => sql.includes(s)), "stages, label, approve, release after the agreement, audit, dashboard");
  // The page pieces: three modes in one wizard, the review dialog, the panel's status line and resends, the F04 kept out of Send a document.
  const wizard = read("src/components/signing/F04Wizard.tsx"), dialog = read("src/pages/admin/components/F04ReviewDialog.tsx"), panel = read("src/pages/admin/components/AgentOnboardingPanel.tsx");
  assert.ok(["mode?: F04Mode", "Save changes", "Send back for correction", "Approve and activate agency", "f04-flag-", "f04-locked-", "f04-correction-banner"].every((s) => wizard.includes(s)));
  assert.ok(dialog.includes("mode=\"admin-review\"") && dialog.includes("refereePanel"));
  assert.ok(["resend-link", "Resend to referee", "review-application", "correction-history", "approveAgency"].every((s) => panel.includes(s)) && !panel.includes("SendApplicationDialog") && !panel.includes("send-agreement-anyway"));
  assert.ok(read("src/pages/admin/components/signing/SubjectSigningPanel.tsx").includes("withoutF04("));
});

const softBreakMod = await load.import<typeof import("../src/components/signing/softBreak.ts")>("../src/components/signing/softBreak.ts");
test("review application dialog (2026-11-20): opens on Review and decide, actions on every step, staff subtitle, one reference per row, ACN, agreement card, referee status", () => {
  const wizard = read("src/components/signing/F04Wizard.tsx").replace(/\r\n/g, "\n"), dialog = read("src/pages/admin/components/F04ReviewDialog.tsx").replace(/\r\n/g, "\n");
  // 1. Staff start on the summary; the tabs and the Edit links still move between steps.
  assert.ok(wizard.includes(`const firstStep = mode === "admin-review" ? REVIEW_STEP :`), "opens on Review and decide");
  assert.ok(wizard.includes(`onSelect={(n) => goTo(order[n])}`) && wizard.includes("data-testid={`f04-review-edit-${STEPS[index].id}`}") && wizard.includes(`data-testid="f04-review-back-summary"`), "tabs, Edit links, back to the summary");
  // 2. The three actions sit in the footer on every step (no "last step only" branch); Save only with unsaved edits.
  const buttons = wizard.slice(wizard.indexOf("const adminButtons = admin && review ?"), wizard.indexOf("// The pre-send step: Save draft"));
  assert.ok(buttons.includes("f04-review-send-back") && buttons.includes("f04-review-approve") && !buttons.includes("last ?") && !buttons.includes("f04-next"), "Send back and Approve on every step");
  assert.ok(wizard.includes("disabled={!dirty || !!reviewBusy}") && wizard.includes("footerStart={admin ? adminSave :"), "Save changes in the footer, enabled only with unsaved edits");
  // 3. The staff subtitle.
  assert.ok(wizard.includes("· Review the application, then approve or send it back.</> :"), "staff subtitle");
  // 4. One reference per row, the email and phone on their own lines, wrapped at sensible points.
  assert.ok(wizard.includes("section(F04_STEP.references, [[\"Reference 1\", ref(1)], [\"Reference 2\", ref(2)]], true)") && wizard.includes("f04-review-ref-${n}-email"), "one reference per row");
  assert.ok(wizard.includes("softBreak(a.contact_email)") && wizard.includes("softBreak(a.agent_website)") && !/break-all/.test(wizard), "emails and web addresses never split mid-word");
  const pieces = (node: unknown) => (Array.isArray(node) ? node : [node]).map((n) => (n as { props?: { children?: unknown[] } })?.props?.children ?? n);
  const broken = pieces(softBreakMod.softBreak("ravi.kumar@globaledu.com.au")) as unknown[][];
  assert.deepEqual(broken.map((c) => [c[0], c[1] !== null]), [["ravi", false], [".", true], ["kumar", false], ["@", true], ["globaledu", false], [".", true], ["com", false], [".", true], ["au", false]], "breaks only after . and @");
  assert.equal(softBreakMod.softBreak(""), "");
  // 5. ACN on the Business card, the agreement card with pictures, the referee status with Resend.
  assert.ok(wizard.includes(`["ACN", state.acn ? printAcn(state.acn) : admin ? "—" : ""]`) && dialog.includes("agent_acn: review.answers.agent_acn || review.acn ||"), "ACN from the answers or the business");
  for (const id of ["f04-review-agreement", "f04-review-agreement-signature", "f04-review-agreement-agency-witness", "f04-review-agreement-slit-witness", "Signed {formatSignedAt(sig.signedAt)}"]) assert.ok(wizard.includes(id), id);
  assert.ok(dialog.includes("data:image/png;base64,") && dialog.includes("agencySignature:") && dialog.includes("slitWitness:"), "witness pictures stored as bare base64 become images");
  assert.ok(dialog.includes("f04-referee-status-") && dialog.includes("\"Sent, not completed\"") && dialog.includes("\"Not sent yet\"") && dialog.includes("resendReferee(ref)"), "referee status with Resend");
  const sql = read("supabase/migrations/20261120153517_onboarding_review_summary.sql").replace(/\r\n/g, "\n");
  assert.ok(sql.includes("'acn', a.acn, 'acnSource', a.acn_source") && sql.includes("'image', r.signature_image, 'signedAt', r.signed_at") && sql.includes("public.agency_onboarding_review_get(uuid)"), "review data: ACN and the agency admin's signature");
});

const m365 = await load.import<typeof import("../supabase/functions/_shared/microsoft365.ts")>("../supabase/functions/_shared/microsoft365.ts");
test("Microsoft 365 status (2026-11-20): one app-only check behind Email Management and Connections; every item a real Graph call; no secret leaves", async () => {
  const SECRET = "s3cr3t-value-never-returned";
  const env = (over: Record<string, string> = {}) => (n: string) => ({ EF_MICROSOFT365_CLIENT_ID: "00000000-aaaa-bbbb-cccc-000000001234", EF_MICROSOFT365_CLIENT_SECRET: SECRET,
    EF_MICROSOFT365_TENANT_ID: "tenant-1", EF_MICROSOFT365_STUDENT_DOMAIN: "student.slit.edu.au", ...over } as Record<string, string>)[n];
  const jwt = (roles: string[]) => `h.${btoa(JSON.stringify({ roles })).replace(/=+$/, "")}.sig`;
  const ALL = ["User.ReadWrite.All", "Organization.Read.All", "LicenseAssignment.ReadWrite.All", "Domain.Read.All", "User-PasswordProfile.ReadWrite.All", "RoleManagement.Read.Directory", "Mail.Send"];
  const graph = (o: { roles?: string[]; token?: Response; domains?: Array<{ id: string; isVerified: boolean }>; skus?: unknown[]; domainStatus?: number }) => {
    const calls: string[] = [];
    const request = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input); calls.push(`${init?.method ?? "GET"} ${url.replace(/\?.*$/, "")}`);
      if (url.includes("login.microsoftonline.com")) return o.token ?? new Response(JSON.stringify({ access_token: jwt(o.roles ?? ALL) }), { status: 200 });
      if (url.includes("/organization")) return new Response(JSON.stringify({ value: [{ id: "tenant-1", displayName: "Skyline Institute of Technology", verifiedDomains: [{ name: "slit.edu.au" }] }] }));
      if (url.includes("/domains")) return o.domainStatus ? new Response("{}", { status: o.domainStatus }) : new Response(JSON.stringify({ value: o.domains ?? [{ id: "slit.edu.au", isVerified: true }, { id: "student.slit.edu.au", isVerified: true }] }));
      if (url.includes("/subscribedSkus")) return new Response(JSON.stringify({ value: o.skus ?? [{ skuPartNumber: "STANDARDWOFFPACK_STUDENT", prepaidUnits: { enabled: 500 }, consumedUnits: 120, capabilityStatus: "Enabled" }, { skuPartNumber: "O365_BUSINESS_PREMIUM", prepaidUnits: { enabled: 10 }, consumedUnits: 10 }] }));
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    return { request, calls };
  };
  // Ready: connection, consent, both domains verified, student seats free; GET only, nothing created.
  const ok = graph({});
  const ready = await m365.microsoft365Status(env(), ok.request);
  assert.deepEqual([ready.ready, ready.checks, ready.tenant?.name, ready.clientIdEnd, ready.consent.missing, ready.consent.welcomeEmail], [true, { connection: "ok", consent: "ok", domain: "ok", licence: "ok" }, "Skyline Institute of Technology", "1234", [], true]);
  assert.deepEqual(ready.licences[0], { sku: "STANDARDWOFFPACK_STUDENT", total: 500, available: 380, student: true, staff: false }, "the student licence first, seats left");
  assert.ok(ok.calls.slice(1).every((c) => c.startsWith("GET ")) && ok.calls[0].startsWith("POST https://login.microsoftonline.com/tenant-1/"), "only reads after the token");
  assert.ok(!JSON.stringify(ready).includes(SECRET) && !JSON.stringify(ready).includes("h.ey"), "no secret or token in the result");
  // Missing admin consent: the token's roles say exactly which application permissions to add.
  const partial = await m365.microsoft365Status(env(), graph({ roles: ["User.ReadWrite.All", "Organization.Read.All"], domainStatus: 403 }).request);
  assert.deepEqual([partial.ready, partial.checks.consent, partial.consent.missing], [false, "missing", ["LicenseAssignment.ReadWrite.All", "Domain.Read.All", "User-PasswordProfile.ReadWrite.All", "RoleManagement.Read.Directory"]]);
  assert.match(partial.problems[0], /Admin consent is missing for: LicenseAssignment\.ReadWrite\.All, Domain\.Read\.All, User-PasswordProfile\.ReadWrite\.All, RoleManagement\.Read\.Directory\. In Entra > App registrations/);
  assert.equal(partial.checks.domain, "missing", "without Domain.Read.All the organization's verified domains are used: the student domain is not listed there");
  // A wrong / expired secret: plain advice, never Microsoft's text.
  const bad = await m365.microsoft365Status(env(), graph({ token: new Response(JSON.stringify({ error: "invalid_client", error_codes: [7000215], error_description: "AADSTS7000215: Invalid client secret provided. Trace" }), { status: 401 }) }).request);
  assert.deepEqual([bad.connected, bad.checks.connection, bad.checks.consent], [false, "failed", "not_checked"]);
  assert.match(bad.problems[0], /client secret \(wrong or expired\)/); assert.ok(!bad.problems.join(" ").includes("Trace"));
  // Not set up at all.
  const none = await m365.microsoft365Status(env({ EF_MICROSOFT365_CLIENT_SECRET: "" }), graph({}).request);
  assert.deepEqual([none.configured, none.checks.connection, none.ready], [false, "missing", false]);
  // Domain not verified, no student seats.
  const blocked = await m365.microsoft365Status(env(), graph({ domains: [{ id: "slit.edu.au", isVerified: true }, { id: "student.slit.edu.au", isVerified: false }], skus: [{ skuPartNumber: "STANDARDWOFFPACK_STUDENT", prepaidUnits: { enabled: 5 }, consumedUnits: 5 }] }).request);
  assert.deepEqual([blocked.checks.domain, blocked.checks.licence, blocked.domains], ["missing", "missing", [{ name: "slit.edu.au", verified: true, found: true }, { name: "student.slit.edu.au", verified: false, found: true }]]);
  assert.ok(blocked.problems.some((p) => /student\.slit\.edu\.au is in Microsoft 365 but not verified/.test(p)) && blocked.problems.some((p) => /No STANDARDWOFFPACK_STUDENT seats are free/.test(p)));
  // The screens: no hard-coded status; one shared check; Microsoft 365 first on Connections; named "connection verified" messages.
  const page = read("src/pages/admin/EmailManagementPage.tsx"), connections = read("src/pages/admin/integrations/ConnectionsPage.tsx"), fn = read("supabase/functions/student-office365/index.ts"), adminFn = read("supabase/functions/integrations-admin/index.ts");
  assert.ok(!page.includes("Not configured") && !page.includes("Microsoft 365 connection required.") && page.includes("<Microsoft365Badge />") && read("src/pages/admin/components/CreateEmailSection.tsx").includes("fetchEmailPeople(kind, personQuery)"), "Email Management reads the live status and loads people");
  assert.ok(connections.includes("Number(b.connector_id === M365) - Number(a.connector_id === M365)") && connections.includes("<Microsoft365Panel />") && !connections.includes("announce('Connection verified.')") && !connections.includes("setNotice('Connection verified.')"), "Microsoft 365 first, its own panel, named messages");
  assert.ok(fn.includes("action==='m365_status'||action==='people'") && fn.includes("caller.rpc('admin_business_require')") && adminFn.includes("c.connector_id==='microsoft365'") && adminFn.includes("microsoft365Status("), "both functions use the one check");
  const sql = read("supabase/migrations/20261120163517_email_management_people.sql").replace(/\r\n/g, "\n");
  assert.ok(sql.includes("perform public.admin_business_require();") && sql.includes("revoke all on function public.email_mgmt_people(text, text) from public, anon;"), "people list: SLIT administrators only");
});

const prov = await load.import<typeof import("../supabase/functions/_shared/office365-provision.ts")>("../supabase/functions/_shared/office365-provision.ts");
const dir = await load.import<typeof import("../supabase/functions/_shared/office365-directory.ts")>("../supabase/functions/_shared/office365-directory.ts");
test("Account directory (2026-11-21): guests out, shared apart, Skyline people linked; licence removal never for self, admins or shared; admin roles unreadable refuses all", async () => {
  const ENV: Record<string, string> = { EF_MICROSOFT365_CLIENT_ID: "c", EF_MICROSOFT365_CLIENT_SECRET: "s", EF_MICROSOFT365_TENANT_ID: "t", EF_MICROSOFT365_STUDENT_DOMAIN: "student.slit.edu.au", EF_MICROSOFT365_WELCOME_SENDER: "noreply@slit.edu.au" };
  const STU = "stu-sku", FAC = "fac-sku";
  const u = (id: string, upn: string, o: Record<string, unknown> = {}) => ({ id, userPrincipalName: upn, mail: upn, displayName: upn.split("@")[0], accountEnabled: true, userType: "Member", assignedLicenses: [], assignedPlans: [], usageLocation: "AU", ...o });
  const ids = Array.from({ length: 11 }, (_, i) => `aaaaaaaa-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`);
  const seed = [
    u(ids[0], "asha.patel@student.slit.edu.au", { assignedLicenses: [{ skuId: STU }], assignedPlans: [{ service: "exchange", capabilityStatus: "Enabled" }] }),
    u(ids[1], "sam.lee@slit.edu.au", { assignedLicenses: [{ skuId: FAC }], assignedPlans: [{ service: "exchange", capabilityStatus: "Enabled" }] }),
    u(ids[2], "it.admin@slit.edu.au", { assignedLicenses: [{ skuId: FAC }] }),
    u(ids[3], "global.admin@slit.edu.au", { assignedLicenses: [{ skuId: FAC }] }),
    u(ids[4], "noreply@slit.edu.au", { accountEnabled: false }),
    u(ids[5], "visitor_gmail.com#EXT#@slit.onmicrosoft.com", { userType: "Guest" }),
    u(ids[6], "subscriptions@slit.edu.au", { accountEnabled: false, assignedLicenses: [{ skuId: FAC }] }),
    u(ids[7], "new.student@student.slit.edu.au", { usageLocation: null }),
    // A former student: sign-in blocked, still licensed, nobody in Skyline: a student (blocked), never a shared mailbox.
    u(ids[8], "old.student@student.slit.edu.au", { accountEnabled: false, assignedLicenses: [{ skuId: STU }] }),
    // Group-based licence: cannot be removed from the user.
    u(ids[9], "group.student@student.slit.edu.au", { assignedLicenses: [{ skuId: STU }], licenseAssignmentStates: [{ skuId: STU, assignedByGroup: "grp-1", state: "Active" }] }),
    // Microsoft answers 200 but keeps the licence (sticky): never reported as removed.
    u(ids[10], "sticky.student@student.slit.edu.au", { assignedLicenses: [{ skuId: STU }] }),
  ];
  const run = (opts: { rolesStatus?: number; skylineBlocked?: string[] } = {}) => {
    const calls: string[] = []; const rpcs: Array<[string, Record<string, unknown>]> = [];
    const users = seed.map((x) => structuredClone(x)) as Array<Record<string, unknown> & { id: string; assignedLicenses: Array<{ skuId: string }> }>;
    const request = (async (input: string | URL, init?: RequestInit) => {
      const url = decodeURIComponent(String(input)), method = init?.method ?? "GET"; calls.push(`${method} ${url.replace("https://graph.microsoft.com/v1.0", "")}`);
      if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "tok" }));
      if (url.includes("/subscribedSkus")) return new Response(JSON.stringify({ value: [{ skuId: STU, skuPartNumber: "STANDARDWOFFPACK_STUDENT", prepaidUnits: { enabled: 425 }, consumedUnits: 333 },
        { skuId: FAC, skuPartNumber: "STANDARDWOFFPACK_FACULTY", prepaidUnits: { enabled: 45 }, consumedUnits: 25 }, { skuId: "flow", skuPartNumber: "FLOW_FREE", prepaidUnits: { enabled: 1000000 }, consumedUnits: 2 }] }));
      if (url.includes("/directoryRoles")) return opts.rolesStatus ? new Response("{}", { status: opts.rolesStatus }) : new Response(JSON.stringify({ value: [{ members: [{ id: ids[3] }] }] }));
      if (url.includes("/users?$select")) return new Response(JSON.stringify({ value: users }));
      const m = /\/users\/([^?/]+)(\/assignLicense)?/.exec(url);
      if (m && method === "GET") { const x = users.find((y) => y.id === m[1]); return x ? new Response(JSON.stringify(x)) : new Response("{}", { status: 404 }); }
      if (m && (method === "POST" || method === "PATCH")) {
        // The fake tenant applies the change, as Microsoft would (except the sticky account), so the server's re-read can confirm it.
        const x = users.find((y) => y.id === m[1]); const b = JSON.parse(String(init?.body ?? "{}"));
        if (x && m[2] && x.id !== ids[10]) x.assignedLicenses = [...x.assignedLicenses.filter((l) => !(b.removeLicenses ?? []).includes(l.skuId)), ...(b.addLicenses ?? []).map((l: { skuId: string }) => ({ skuId: l.skuId }))];
        if (x && !m[2]) Object.assign(x, b);
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as typeof fetch;
    const rpc = async (name: string, args: Record<string, unknown>) => { rpcs.push([name, args]);
      if (name === "email_account_skyline_blocked") return { data: opts.skylineBlocked ?? [], error: null };
      if (name === "o365_directory_people") return { data: [{ email: "asha.patel@student.slit.edu.au", kind: "student", id: "s1", name: "Asha Patel", source: "account" }, { email: "sam.lee@slit.edu.au", kind: "trainer", id: "p1", name: "Sam Lee", source: "record" }], error: null };
      return { data: 1, error: null }; };
    dir.resetDirectoryCache();
    return { ports: { env: (n: string) => ENV[n], fetch: request, rpc } as unknown as import("../supabase/functions/_shared/office365-provision.ts").Ports, calls, rpcs };
  };
  const w = run();
  const page = await dir.directoryList(w.ports, "IT.Admin@slit.edu.au", {});
  const rows = page.body.rows as Array<{ upn: string; type: string; canRemove: boolean; removeBlocked: string | null; person: { id: string } | null; assign: { name: string } | null }>;
  const byUpn = (x: string) => rows.find((r) => r.upn === x)!;
  assert.deepEqual([page.body.counts, rows.length], [{ accounts: 10, activeMailboxes: 2, byType: { student: 5, employee: 0, trainer: 1, agent: 0, not_linked: 2, shared: 2 } }, 8], "guests left out, shared under their own filter");
  assert.ok(!rows.some((r) => r.upn.includes("#EXT#")) && !rows.some((r) => r.type === "shared"));
  assert.deepEqual([byUpn("asha.patel@student.slit.edu.au").person?.id, byUpn("asha.patel@student.slit.edu.au").canRemove, byUpn("sam.lee@slit.edu.au").type], ["s1", true, "trainer"]);
  assert.deepEqual([byUpn("it.admin@slit.edu.au").removeBlocked, byUpn("global.admin@slit.edu.au").removeBlocked], ["Your own account", "Has an admin role"]);
  assert.deepEqual([byUpn("new.student@student.slit.edu.au").type, byUpn("new.student@student.slit.edu.au").assign?.name], ["student", "A1 for students"], "student domain: the student licence only");
  assert.deepEqual([byUpn("old.student@student.slit.edu.au").type, byUpn("old.student@student.slit.edu.au").canRemove], ["student", true], "a blocked former student is a student whose licence can be removed");
  const shared = await dir.directoryList(run().ports, "it.admin@slit.edu.au", { type: "shared" });
  assert.deepEqual((shared.body.rows as Array<{ upn: string; canRemove: boolean }>).map((r) => [r.upn, r.canRemove]), [["noreply@slit.edu.au", false], ["subscriptions@slit.edu.au", false]]);
  // Remove: only the allowed one changes; every account answered and logged (refused ones too); other licences untouched.
  const wr = run();
  const removed = await dir.licenceRemove(wr.ports, "it.admin@slit.edu.au", [ids[0], ids[2], ids[3], ids[6]]);
  assert.deepEqual([removed.body.removed, removed.body.refused], [1, 3]);
  assert.deepEqual(wr.calls.filter((c) => c.startsWith("POST /users")), [`POST /users/${ids[0]}/assignLicense`]);
  const okRow = (removed.body.results as Array<{ ok: boolean; row?: { licences: unknown[]; upn: string } }>).find((x) => x.ok)!.row!;
  assert.deepEqual([okRow.upn, okRow.licences], ["asha.patel@student.slit.edu.au", []], "the row comes back from Microsoft's re-read: no licence");
  assert.deepEqual(wr.rpcs.filter(([n]) => n === "email_account_audit_add").map(([, a]) => [a.p_upn, a.p_result]),
    [["asha.patel@student.slit.edu.au", "ok"], ["it.admin@slit.edu.au", "refused"], ["global.admin@slit.edu.au", "refused"], ["subscriptions@slit.edu.au", "refused"]]);
  assert.deepEqual(wr.rpcs.find(([n]) => n === "o365_licence_record")?.[1], { p_upn: "asha.patel@student.slit.edu.au", p_sku: null });
  // Group-based licence: refused before any call, the group named; sticky licence: Microsoft said 200 but still lists it: not removed, not success.
  const wg = run();
  const group = await dir.licenceRemove(wg.ports, "it.admin@slit.edu.au", [ids[9]]);
  assert.deepEqual([group.body.removed, wg.calls.filter((c) => c.startsWith("POST /users")).length], [0, 0]);
  assert.match(String((group.body.results as Array<{ error: string }>)[0].error), /group-based licensing, group grp-1/);
  const ws = run();
  const sticky = await dir.licenceRemove(ws.ports, "it.admin@slit.edu.au", [ids[10]]);
  assert.deepEqual([sticky.body.removed, sticky.body.refused, ws.rpcs.some(([n]) => n === "o365_licence_record")], [0, 1, false], "never success unless Microsoft confirms");
  assert.match(String((sticky.body.results as Array<{ error: string }>)[0].error), /still lists the licence/);
  assert.deepEqual(ws.rpcs.filter(([n]) => n === "email_account_audit_add").map(([, a]) => [a.p_action, a.p_result]), [["licence_removed", "failed"]]);
  // Block / allow sign-in: same protections; PATCH accountEnabled; confirmed; logged.
  const wb = run();
  const blocked = await dir.signinSet(wb.ports, "it.admin@slit.edu.au", [ids[1], ids[2], ids[3], ids[4]], false);
  assert.deepEqual([blocked.body.changed, blocked.body.refused], [1, 3]);
  assert.deepEqual(wb.calls.filter((c) => c.startsWith("PATCH")), [`PATCH /users/${ids[1]}`]);
  const bRows = blocked.body.results as Array<{ upn: string; ok: boolean; error?: string; row?: { enabled: boolean; canAllow: boolean; type: string } }>;
  assert.deepEqual([bRows[0].row?.enabled, bRows[0].row?.canAllow, bRows[0].row?.type], [false, true, "trainer"]);
  assert.deepEqual(bRows.slice(1).map((x) => x.error), ["Your own account", "Has an admin role", "Shared mailbox"]);
  assert.deepEqual(wb.rpcs.filter(([n]) => n === "email_account_audit_add").map(([, a]) => [a.p_action, a.p_upn, a.p_result]),
    [["signin_blocked", "sam.lee@slit.edu.au", "ok"], ["signin_blocked", "it.admin@slit.edu.au", "refused"], ["signin_blocked", "global.admin@slit.edu.au", "refused"], ["signin_blocked", "noreply@slit.edu.au", "refused"]]);
  assert.equal((await dir.signinSet(run().ports, "it.admin@slit.edu.au", [ids[1]], "no")).status, 400);
  assert.equal((await dir.signinSet(run({ rolesStatus: 403 }).ports, "it.admin@slit.edu.au", [ids[1]], false)).body.code, "admin_roles_unreadable");
  // An unlinked account Skyline blocked is a blocked account (Allow sign-in offered), not a shared mailbox.
  const back = await dir.directoryList(run({ skylineBlocked: ["subscriptions@slit.edu.au"] }).ports, "it.admin@slit.edu.au", { status: "blocked" });
  const sub = (back.body.rows as Array<{ upn: string; type: string; canAllow: boolean }>).find((r) => r.upn === "subscriptions@slit.edu.au")!;
  assert.deepEqual([sub.type, sub.canAllow], ["not_linked", true]);
  // Admin roles unreadable (no RoleManagement.Read.Directory): nothing removed, the exact permission named.
  const wn = run({ rolesStatus: 403 });
  const none = await dir.licenceRemove(wn.ports, "it.admin@slit.edu.au", [ids[0]]);
  assert.deepEqual([none.status, none.body.code, wn.calls.filter((c) => c.startsWith("POST") && !c.includes("login.")).length], [409, "admin_roles_unreadable", 0]);
  assert.match(String(none.body.error), /RoleManagement\.Read\.Directory/);
  // Assign: the person's type decides (student domain: student licence); usage location set first when missing.
  const wa = run();
  const assigned = await dir.licenceAssign(wa.ports, "it.admin@slit.edu.au", ids[7]);
  assert.deepEqual([assigned.status, assigned.body.licence, (assigned.body.row as { licences: Array<{ name: string }> }).licences.map((l) => l.name)], [200, "A1 for students", ["A1 for students"]]);
  assert.deepEqual(wa.calls.filter((c) => /^(POST|PATCH) /.test(c) && !c.includes("login.")), [`PATCH /users/${ids[7]}`, `POST /users/${ids[7]}/assignLicense`]);
  assert.equal((await dir.licenceAssign(run().ports, "it.admin@slit.edu.au", ids[4])).status, 409, "a shared mailbox gets no licence");
  // The card counts only the two Skyline licences (never FLOW_FREE and other free / trial SKUs).
  const page2 = read("src/pages/admin/components/AccountDirectory.tsx");
  assert.ok(page2.includes("(student?.available ?? 0) + (staff?.available ?? 0)") && page2.includes("They lose Outlook and Office apps. Their mailbox is kept for 30 days"));
  assert.ok(page2.includes("(confirmed by Microsoft)") && page2.includes("freshNext.current = true") && page2.includes("Block sign-in") && page2.includes("Allow sign-in"), "success only from confirmed results; fresh re-read after an action");
});
test("Create Email for staff (2026-11-20): staff domain and faculty licence, existing mailbox found first, number only for a different person, dry run writes nothing", async () => {
  const ENV: Record<string, string> = { EF_MICROSOFT365_CLIENT_ID: "c", EF_MICROSOFT365_CLIENT_SECRET: "s", EF_MICROSOFT365_TENANT_ID: "t", EF_MICROSOFT365_STUDENT_DOMAIN: "student.slit.edu.au", EF_MICROSOFT365_WELCOME_SENDER: "admin@slit.edu.au" };
  // 1 and 2: domain and licence by person type; a staff plan can never be the student one.
  assert.deepEqual(["student", "employee", "trainer", "agent"].map((k) => { const p = prov.planFor(k as never, (n) => ENV[n]); return [p.domain, p.sku]; }),
    [["student.slit.edu.au", "STANDARDWOFFPACK_STUDENT"], ["slit.edu.au", "STANDARDWOFFPACK_FACULTY"], ["slit.edu.au", "STANDARDWOFFPACK_FACULTY"], ["slit.edu.au", "STANDARDWOFFPACK_FACULTY"]], "agents too get the faculty licence (owner's second brief)");
  assert.throws(() => prov.planFor("employee", (n) => ({ ...ENV, EF_MICROSOFT365_STAFF_DOMAIN: "student.slit.edu.au" } as Record<string, string>)[n]), /staff_plan_invalid/);
  assert.throws(() => prov.planFor("trainer", (n) => ({ ...ENV, EF_MICROSOFT365_STAFF_SKU: "STANDARDWOFFPACK_STUDENT" } as Record<string, string>)[n]), /staff_plan_invalid/);
  assert.ok(!read("src/pages/admin/EmailManagementPage.tsx").includes("OFFICESUBSCRIPTION_FACULTY") && !read("supabase/functions/_shared/office365-provision.ts").match(/addLicenses:[^\n]*OFFICESUBSCRIPTION/), "the apps-only licence is never assigned");
  // A fake tenant: users, seats; every call recorded.
  type U = { id: string; userPrincipalName: string; mail: string | null; displayName: string };
  let mailFails = false;
  let groupMails: string[] = []; let postConflict = false; let claimKeepsOld = false; let senderExists = true;
  const world =(users: U[], faculty = { enabled: 45, consumed: 25 }) => {
    const calls: string[] = []; const rpcs: string[] = []; const steps: string[] = [];
    const request = (async (input: string | URL, init?: RequestInit) => {
      const url = decodeURIComponent(String(input)), method = init?.method ?? "GET"; calls.push(`${method} ${url.replace("https://graph.microsoft.com/v1.0", "")}`);
      if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "tok" }));
      if (url.includes("/domains?")) return new Response(JSON.stringify({ value: [{ id: "slit.edu.au", isVerified: true }, { id: "student.slit.edu.au", isVerified: true }, { id: "slit.onmicrosoft.com", isVerified: true }, { id: "old.slit.edu.au", isVerified: false }] }));
      if (method === "PATCH") return new Response(null, { status: 204 });
      if (url.includes("/members/$ref")) return new Response(null, { status: 204 });
      if (url.includes("/subscribedSkus")) return new Response(JSON.stringify({ value: [{ skuId: "stu", skuPartNumber: "STANDARDWOFFPACK_STUDENT", prepaidUnits: { enabled: 425 }, consumedUnits: 332 },
        { skuId: "fac", skuPartNumber: "STANDARDWOFFPACK_FACULTY", prepaidUnits: { enabled: faculty.enabled }, consumedUnits: faculty.consumed }, { skuId: "apps", skuPartNumber: "OFFICESUBSCRIPTION_FACULTY", prepaidUnits: { enabled: 7 }, consumedUnits: 6 }] }));
      if (method === "GET" && url.includes("/users/admin@slit.edu.au?$select=id")) return senderExists ? new Response(JSON.stringify({ id: "sender" })) : new Response(JSON.stringify({ error: { code: "Request_ResourceNotFound" } }), { status: 404 });
      const m = /\/users\/([^?/]+)\?/.exec(url);
      if (m && method === "GET") { const u = users.find((x) => x.id === m[1] || x.userPrincipalName === m[1]); return u ? new Response(JSON.stringify(u)) : new Response("{}", { status: 404 }); }
      if (url.includes("/users?$filter=")) {
        const name = /displayName eq '(.+?)'/.exec(url)?.[1]?.replace(/''/g, "'"); const smtp = /smtp:(.+?)'/.exec(url)?.[1];
        return new Response(JSON.stringify({ value: users.filter((u) => (name && u.displayName === name) || (smtp && (u.mail === smtp || u.userPrincipalName === smtp))) }));
      }
      if (url.includes("/groups?$filter=")) { const smtp = /smtp:(.+?)'/.exec(url)?.[1]; return new Response(JSON.stringify({ value: groupMails.filter((g) => g === smtp).map((g) => ({ id: g })) })); }
      if (method === "POST" && url.endsWith("/users")) return postConflict
        ? new Response(JSON.stringify({ error: { code: "Request_BadRequest", message: "Another object with the same value for property userPrincipalName already exists.", details: [{ code: "ObjectConflict" }] } }), { status: 400 })
        : new Response(JSON.stringify({ id: "new-user" }), { status: 201 });
      if (url.includes("/licenseDetails")) return new Response(JSON.stringify({ value: [] }));
      if (url.includes("/assignLicense")) return new Response("{}");
      if (url.includes("/sendMail")) return mailFails ? new Response(JSON.stringify({ error: { code: "MailboxNotEnabledForRESTAPI", message: "The mailbox is either inactive, soft-deleted, or is hosted on-premise." } }), { status: 404 }) : new Response(null, { status: 202 });
      throw new Error(`unexpected ${method} ${url}`);
    }) as typeof fetch;
    const person = { fullName: "Asha Patel", recordEmail: "asha.personal@example.test", trainer: true, account: null as null | Record<string, unknown> };
    const rpc = async (name: string, args: Record<string, unknown>) => { rpcs.push(name);
      if (name.endsWith("_prepare")) return { data: person, error: null };
      if (name.endsWith("_claim")) return { data: { conflict: false, upn: claimKeepsOld && person.account ? person.account.email : args.p_upn, msUserId: null }, error: null };
      if (name.endsWith("_finish") || name === "o365_link" || name === "o365_step") { steps.push(`${args.p_step ?? name}:${args.p_ok ?? ""}:${args.p_detail ?? ""}`); return { data: {}, error: null }; }
      throw new Error(name); };
    const ports = { env: (n: string) => ENV[n], fetch: request, rpc } as unknown as import("../supabase/functions/_shared/office365-provision.ts").Ports;
    return { ports, calls, rpcs, person, steps };
  };
  const STAFF = "11111111-1111-4111-8111-111111111111";
  const writes = (calls: string[]) => calls.filter((c) => /^(POST|PATCH|DELETE) /.test(c) && !c.includes("login.microsoftonline.com"));
  // Dry run for an employee: slit.edu.au, faculty licence with its seats, the welcome email masked; nothing created or written.
  const w1 = world([]);
  const dry = await prov.provision(w1.ports, "employee", STAFF, { dryRun: true });
  assert.equal(dry.status, 200);
  assert.deepEqual([dry.body.email, dry.body.sku, dry.body.licence], ["asha.patel@slit.edu.au", "STANDARDWOFFPACK_FACULTY", { total: 45, available: 20 }]);
  assert.match(String(dry.body.welcomeTo), /^as[*]+@example[.]test$/, "the welcome address masked");
  assert.deepEqual([writes(w1.calls), w1.rpcs], [[], ["staff_o365_prepare"]], "dry run: no Microsoft write, no claim / finish");
  // A trainer that is not a trainer is refused; the student kind uses the student domain and licence.
  const w2 = world([]); w2.person.trainer = false;
  assert.equal((await prov.provision(w2.ports, "trainer", STAFF, { dryRun: true })).status, 400);
  const w3 = world([]);
  const sdry = await prov.provision(w3.ports, "student", STAFF, { dryRun: true });
  assert.deepEqual([sdry.body.email, sdry.body.sku], ["asha.patel@student.slit.edu.au", "STANDARDWOFFPACK_STUDENT"]);
  // 3. Already has a mailbox: the work email on the record (or the linked account) is found; no second account, link offered.
  const mine: U = { id: "aaaaaaaa-0000-4000-8000-000000000001", userPrincipalName: "asha.patel@slit.edu.au", mail: "asha.patel@slit.edu.au", displayName: "Asha Patel" };
  const w4 = world([mine]); w4.person.recordEmail = "asha.patel@slit.edu.au";
  const has = await prov.provision(w4.ports, "employee", STAFF);
  assert.deepEqual([has.status, has.body.code, (has.body.existing as Array<{ match: string }>)[0].match], [409, "already_has", "email"]);
  assert.match(String(has.body.error), /^Already has asha\.patel@slit\.edu\.au\. Link it/);
  assert.deepEqual(writes(w4.calls), [], "nothing created");
  const look = await prov.lookup(w4.ports, "employee", STAFF);
  assert.deepEqual([look.status, look.body.address, String(look.body.blocked)], [200, null, "Already has asha.patel@slit.edu.au. Link it to this record instead of creating another."]);
  // Same name, maybe a different person: refused until the administrator says so; then the address gets a number.
  const namesake: U = { id: "aaaaaaaa-0000-4000-8000-000000000002", userPrincipalName: "asha.patel@slit.edu.au", mail: "asha.patel@slit.edu.au", displayName: "Asha Patel" };
  const w5 = world([namesake]);
  const maybe = await prov.provision(w5.ports, "employee", STAFF);
  assert.deepEqual([maybe.status, maybe.body.code], [409, "possible_match"]); assert.deepEqual(writes(w5.calls), []);
  const other = await prov.provision(w5.ports, "employee", STAFF, { dryRun: true, differentPerson: true });
  assert.equal(other.body.email, "asha.patel2@slit.edu.au", "the number only for a different person");
  // Link: the existing account (staff domain only).
  const w6 = world([mine]);
  assert.deepEqual((await prov.link(w6.ports, "employee", STAFF, mine.id)).body, { ok: true, linked: true, email: "asha.patel@slit.edu.au" });
  const studentAcct: U = { id: "aaaaaaaa-0000-4000-8000-000000000003", userPrincipalName: "asha.patel@student.slit.edu.au", mail: null, displayName: "Asha Patel" };
  const w7 = world([studentAcct]);
  assert.match(String((await prov.link(w7.ports, "trainer", STAFF, studentAcct.id)).body.error), /staff record links only to an @slit\.edu\.au account/);
  // No faculty seat left: blocked BEFORE any user is created.
  const w8 = world([], { enabled: 45, consumed: 45 });
  const full = await prov.provision(w8.ports, "employee", STAFF);
  assert.deepEqual([full.status, full.body.code, writes(w8.calls), w8.rpcs], [409, "no_licences_available", [], ["staff_o365_prepare"]]);
  assert.match(String(full.body.error), /No Office 365 A1 for faculty licences are free \(45 of 45 in use\)/);
  // A real create (mocked): user, faculty licence, welcome email, recorded; the password never in the reply.
  const w9 = world([]);
  const made = await prov.provision(w9.ports, "employee", STAFF);
  assert.deepEqual([made.status, made.body.email, w9.rpcs.filter((r) => r !== "o365_step")], [200, "asha.patel@slit.edu.au", ["staff_o365_prepare", "staff_o365_claim", "staff_o365_finish"]]);
  assert.deepEqual(w9.steps.filter((x) => !x.startsWith("staff_o365_finish")), ["account:true:", "licence:true:STANDARDWOFFPACK_FACULTY", "welcome:true:"], "each step recorded (no groups until mapped)");
  assert.deepEqual(writes(w9.calls).map((c) => c.split(" ")[1].replace(/\/users\/[^/]+/, "/users/:id")), ["/users", "/users/:id/assignLicense", "/users/:id/sendMail"]);
  assert.ok(!JSON.stringify(made.body).toLowerCase().includes("password"));
  // The screens: Agent gone from Create Email, the "not created from here yet" note gone, a dry run and a link button.
  const section = read("src/pages/admin/components/CreateEmailSection.tsx"), page = read("src/pages/admin/EmailManagementPage.tsx");
  assert.ok(![section, page].some((t) => t.includes("are not created from here yet")) && section.includes(`const KIND_LABEL: Record<MailboxKind, string> = { student: "Student", employee: "Employee", trainer: "Trainer", agent: "Agent" };`) && section.includes("lookupOffice365(") && section.includes("linkOffice365(") && page.includes("<CreateEmailSection />"), "staff types incl. agents");

  // Round 2. Domains: verified, never onmicrosoft.com, only the person type's own; the server refuses anything else.
  const wd = world([]);
  const lk = await prov.lookup(wd.ports, "agent", STAFF);
  assert.deepEqual([lk.body.domains, (await prov.lookup(world([]).ports, "student", STAFF)).body.domains], [["slit.edu.au"], ["student.slit.edu.au"]]);
  for (const bad of ["student.slit.edu.au", "slit.onmicrosoft.com", "old.slit.edu.au"]) {
    const r = await prov.provision(world([]).ports, "employee", STAFF, { dryRun: true, domain: bad });
    assert.deepEqual([r.status, r.body.code], [400, "domain_not_allowed"], bad);
  }
  assert.equal((await prov.provision(world([]).ports, "student", STAFF, { dryRun: true, domain: "slit.edu.au" })).body.code, "domain_not_allowed", "no staff domain for a student");
  // Never a second account: once the Microsoft user exists, create is refused (no parth.patel1); Resend is the way.
  const wc = world([]); wc.person.account = { email: "asha.patel@slit.edu.au", status: "failed", lastError: "welcome_email_failed", welcomeSentAt: null, msUserId: "aaaaaaaa-0000-4000-8000-0000000000aa", steps: { accountCreatedAt: "2026-11-19T13:02:28Z", licenceAssignedAt: null, groupsAddedAt: null, groupsError: null, welcomeSentAt: null, welcomeError: "404:MailboxNotEnabledForRESTAPI" } };
  const again = await prov.provision(wc.ports, "employee", STAFF, { differentPerson: true });
  assert.deepEqual([again.status, again.body.code, writes(wc.calls)], [409, "already_created", []]);
  assert.match(String((await prov.lookup(wc.ports, "employee", STAFF)).body.blocked), /^Already created asha\.patel@slit\.edu\.au\. Use Resend login email\.$/);
  // Resend: dry run changes nothing; for real a new temporary password (PATCH), the missing licence finished, the email sent; no password returned.
  const existingUser: U = { id: "aaaaaaaa-0000-4000-8000-0000000000aa", userPrincipalName: "asha.patel@slit.edu.au", mail: "asha.patel@slit.edu.au", displayName: "Asha Patel" };
  const wr = world([existingUser]); wr.person.account = wc.person.account;
  const rdry = await prov.resend(wr.ports, "employee", STAFF, { dryRun: true });
  assert.deepEqual([rdry.status, rdry.body.licenceNeeded, writes(wr.calls), wr.steps], [200, true, [], []]);
  const rr = await prov.resend(wr.ports, "employee", STAFF);
  assert.deepEqual([rr.status, rr.body.email], [200, "asha.patel@slit.edu.au"]);
  assert.deepEqual(writes(wr.calls).map((c) => c.split(" ")[0] + " " + c.split(" ")[1].replace(/\/users\/[^/]+/, "/users/:id")), ["POST /users/:id/assignLicense", "PATCH /users/:id", "POST /users/:id/sendMail"]);
  assert.deepEqual(wr.steps, ["licence:true:STANDARDWOFFPACK_FACULTY", "welcome:true:"]);
  assert.ok(!JSON.stringify(rr.body).toLowerCase().includes("password\""), "no password in the reply");
  // A failed login email keeps Microsoft's error code (never its text) and marks the step failed.
  mailFails = true;
  const wf = world([existingUser]); wf.person.account = wc.person.account;
  const rf = await prov.resend(wf.ports, "employee", STAFF);
  mailFails = false;
  assert.deepEqual([rf.status, rf.body.graphCode, wf.steps.at(-1)], [409, "404:MailboxNotEnabledForRESTAPI", "welcome:false:404:MailboxNotEnabledForRESTAPI"]);
  assert.ok(!JSON.stringify(rf.body).includes("soft-deleted"), "Microsoft's message text is not passed on");
  // A linked account (not made by Skyline) is not resent; groups come from the mapping (none until the owner maps them).
  const wl = world([existingUser]); wl.person.account = { ...wc.person.account, linked: true };
  assert.equal((await prov.resend(wl.ports, "employee", STAFF)).body.code, "linked");
  assert.deepEqual([prov.groupIds(prov.planFor("employee", (n) => ENV[n]), (n) => ENV[n]), prov.groupIds(prov.planFor("student", (n) => ({ ...ENV, EF_MICROSOFT365_GROUPS_STUDENT: "11111111-2222-4333-8444-555555555555, nope" } as Record<string, string>)[n]), (n) => ({ ...ENV, EF_MICROSOFT365_GROUPS_STUDENT: "11111111-2222-4333-8444-555555555555, nope" } as Record<string, string>)[n])],
    [[], ["11111111-2222-4333-8444-555555555555"]]);
  assert.ok(section.includes('data-testid="email-resend"') && section.includes('data-testid="email-domain"') && section.includes("{created ? null : confirming"), "Resend replaces Create once the account exists; the domain dropdown");

  // Editable username (2026-11-21). The format rules, identical on the screen and the server.
  for (const bad of ["", "   ", "a b", ".asha", "asha.", "asha..patel", "x".repeat(65), "asha+patel", "asha@patel", "äsha"]) assert.ok(prov.usernameProblem(bad), `refused: ${JSON.stringify(bad)}`);
  for (const good of ["asha.patel", "a_patel-2", "x".repeat(64), " Asha.Patel "]) assert.equal(prov.usernameProblem(good), null, good);
  const fnText = (file: string) => /export function usernameProblem[\s\S]*?\n}\r?\n/.exec(read(file))?.[0].replace(/\r\n/g, "\n");
  assert.ok(fnText("src/pages/admin/lib/microsoft365.ts") && fnText("src/pages/admin/lib/microsoft365.ts") === fnText("supabase/functions/_shared/office365-provision.ts"), "one rule set on screen and server");
  // The live check: free, taken by a user (UPN / mail / proxy address), taken by a group, bad format, a domain not offered.
  const taken: U = { id: "aaaaaaaa-0000-4000-8000-0000000000bb", userPrincipalName: "office@slit.edu.au", mail: "office@slit.edu.au", displayName: "Office" };
  groupMails = ["staffroom@slit.edu.au"];
  const ca = (u: string, d = "slit.edu.au", users: U[] = [taken]) => prov.checkAddress(world(users).ports, "employee", u, d);
  assert.deepEqual((await ca("Asha.Patel")).body, { available: true, address: "asha.patel@slit.edu.au" });
  assert.deepEqual([(await ca("office")).body.available, (await ca("office")).body.code], [false, "address_in_use"], "a user's address");
  assert.equal((await ca("staffroom")).body.available, false, "a group's address");
  assert.deepEqual([(await ca("asha..patel")).body.available, (await ca("asha..patel")).body.code], [false, "username_invalid"]);
  assert.deepEqual([(await ca("asha", "student.slit.edu.au")).status, (await ca("asha", "student.slit.edu.au")).body.code], [400, "domain_not_allowed"]);
  const checkWorld = world([taken]); await prov.checkAddress(checkWorld.ports, "employee", "asha", "slit.edu.au");
  assert.ok(checkWorld.calls.some((c) => c.includes("userPrincipalName eq 'asha@slit.edu.au' or mail eq 'asha@slit.edu.au' or proxyAddresses/any(p:p eq 'smtp:asha@slit.edu.au')")), "one Graph filter: UPN, mail, proxy address");
  assert.deepEqual([writes(checkWorld.calls), checkWorld.rpcs], [[], []], "the check writes nothing");
  // Create uses the typed username exactly (never regenerated, no number even for a namesake confirmed as a different person).
  const wu = world([namesake]);
  assert.equal((await prov.provision(wu.ports, "employee", STAFF, { dryRun: true, differentPerson: true, username: " Asha.P " })).body.email, "asha.p@slit.edu.au");
  const wuMade = world([]);
  const madeU = await prov.provision(wuMade.ports, "employee", STAFF, { username: "a.patel" });
  assert.deepEqual([madeU.status, madeU.body.email], [200, "a.patel@slit.edu.au"]);
  // Checked again on the server: bad format, taken by a user or a group -> refused before anything is reserved or created.
  for (const [u, code] of [["a..patel", "username_invalid"], ["office", "address_in_use"], ["staffroom", "address_in_use"]] as const) {
    const wx = world([taken]); const r = await prov.provision(wx.ports, "employee", STAFF, { username: u });
    assert.deepEqual([r.body.code, writes(wx.calls), wx.rpcs], [code, [], ["staff_o365_prepare"]], u);
  }
  // Race: free when checked, taken by the time POST /users runs -> a clear "already in use" error, the attempt recorded as failed.
  postConflict = true;
  const wrace = world([]); const race = await prov.provision(wrace.ports, "employee", STAFF, { username: "late.comer" });
  postConflict = false;
  assert.deepEqual([race.status, race.body.code, race.body.email], [409, "address_in_use", "late.comer@slit.edu.au"]);
  assert.match(String(race.body.error), /^late\.comer@slit\.edu\.au is already in use in Microsoft 365\. Choose another username\.$/);
  assert.ok(wrace.steps.some((s) => s.startsWith("staff_o365_finish:")), "the failed attempt recorded");
  // A failed earlier attempt whose reserved address the database would not change: refused, nothing created under another address.
  claimKeepsOld = true;
  const wold = world([]); wold.person.account = { email: "asha.patel@slit.edu.au", status: "failed", lastError: "address_in_use", welcomeSentAt: null, msUserId: null };
  const kept = await prov.provision(wold.ports, "employee", STAFF, { username: "asha.p" });
  claimKeepsOld = false; groupMails = [];
  assert.deepEqual([kept.body.code, writes(wold.calls)], ["address_reserved", []]);
  // The claim takes the submitted address for a row without a Microsoft user (all three record types), never for one with a user.
  const claimSql = read("supabase/migrations/20261121003517_o365_claim_submitted_upn.sql").replace(/\r\n/g, "\n");
  for (const t of ["student", "staff", "agent"]) assert.ok(claimSql.includes(`create or replace function public.${t}_o365_claim(`) && claimSql.includes(`update public.${t}_office365_accounts set upn = v_upn where ${t}_id = p_${t};`), t);
  assert.equal(claimSql.split("if a.ms_user_id is null and v_upn <> '' and v_upn <> a.upn then").length - 1, 3);
  assert.equal(claimSql.split("check (upn ~ '^[a-z0-9_-]([a-z0-9._-]{0,62}[a-z0-9_-])?@[a-z0-9.-]+$' and strpos(split_part(upn, '@', 1), '..') = 0)").length - 1, 3,
    "every account table holds the username rules: a-z 0-9 . _ -, no leading / trailing / double dot, at most 64 before the @");
  // The screen: editable, live checks through the Edge Function, Use suggested, the helper text.
  const sec2 = read("src/pages/admin/components/CreateEmailSection.tsx");
  assert.ok(!/id="email-name" readOnly /.test(sec2) && sec2.includes("readOnly={!editable}") && sec2.includes("checkOffice365Address(") && !sec2.includes("graph.microsoft.com")
    && sec2.includes("}, 500);") && sec2.includes('data-testid="email-use-suggested"') && sec2.includes("createOffice365(kind, person.id, { differentPerson, domain, username, ...(applicationId ? { applicationId } : {}) })")
    && sec2.includes("Suggested from the person's name. You can change it. Only the tenant's verified domains are offered."), "editable username on Create Email");

  // Login email sender (2026-11-21). Missing sender: nothing created, no password reset, a clear message naming it.
  senderExists = false;
  const ws1 = world([]); const noSend = await prov.provision(ws1.ports, "employee", STAFF);
  assert.deepEqual([noSend.status, noSend.body.code, writes(ws1.calls), ws1.rpcs], [409, "sender_missing", [], ["staff_o365_prepare"]]);
  assert.match(String(noSend.body.error), /^Login emails are sent from admin@slit\.edu\.au, which does not exist in Microsoft 365\..*Nothing was created or changed\.$/);
  const ws2 = world([existingUser]); ws2.person.account = wc.person.account;
  const noSendResend = await prov.resend(ws2.ports, "employee", STAFF);
  assert.deepEqual([noSendResend.body.code, writes(ws2.calls), ws2.steps], ["sender_missing", [], []], "resend: no licence, group or password change without a sender");
  senderExists = true;
  // The sender exists but sending fails: the messages name the sender and Microsoft's code; resend says the password was reset.
  mailFails = true;
  const wm = world([]); const madeNoMail = await prov.provision(wm.ports, "employee", STAFF);
  const wm2 = world([existingUser]); wm2.person.account = wc.person.account; const resendNoMail = await prov.resend(wm2.ports, "employee", STAFF);
  mailFails = false;
  assert.equal(madeNoMail.body.error, "asha.patel@slit.edu.au was created, but the login email could not be sent from admin@slit.edu.au (Microsoft: 404 MailboxNotEnabledForRESTAPI). Fix the sender mailbox, then use Resend login email (it sets a new temporary password).");
  assert.deepEqual([resendNoMail.body.passwordReset, resendNoMail.body.error], [true, "A new temporary password was set for asha.patel@slit.edu.au, but the login email could not be sent from admin@slit.edu.au (Microsoft: 404 MailboxNotEnabledForRESTAPI). Fix the sender mailbox, then Resend again (it sets another new temporary password)."]);
  assert.ok(read("supabase/functions/_shared/office365-provision.ts").includes('console.warn(JSON.stringify({ fn: "student-office365", action, step: "welcome", kind, graphCode: code }))'), "Microsoft's code in the function log, no addresses");
  // The screens: Create / Resend blocked while the sender is missing; the student page resends (never creates) once the account exists.
  const lib = read("src/pages/admin/lib/microsoft365.ts"), panel = read("src/pages/admin/components/StudentOffice365Panel.tsx"), sec3 = read("src/pages/admin/components/CreateEmailSection.tsx");
  assert.ok(lib.includes('{ key: "sender", label: "Login email sender"') && lib.includes("export function senderBlock(") && sec3.includes("const noSender = senderBlock(status);")
    && sec3.includes("!!status?.ready && !noSender &&") && sec3.includes('data-testid="email-sender-missing"'), "Create Email: sender in the checklist, Create blocked without it");
  assert.ok(panel.includes('resendOffice365("student", studentId)') && panel.includes("const created = !!account?.msUserId && !account.linked && !active;") && panel.includes("Set a new temporary password for"), "student page: Resend login email after the account exists");
  assert.ok(read("supabase/functions/_shared/microsoft365.ts").includes("!status.sender.exchangeLicence && status.sender.enabled"), "a shared mailbox (sign-in blocked, no licence) is not a problem");
});

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
    ["documents_submitted", "invited"], ["documents_submitted", "offer_sent"], ["documents_submitted", "offer_signed"], ["documents_submitted", "rejected"],
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
  const latest = read("supabase/migrations/20261113031341_staff_signed_documents.sql");
  const body = latest.slice(latest.indexOf("function hr.staff_transition_allowed"), latest.indexOf("function hr.staff_signing_problem"));
  const pairs = [...body.matchAll(/\('([a-z_]+)','([a-z_]+)'\)/g)].map((m) => [m[1], m[2]]);
  // The latest table lists 14 pairs; any move to active / inactive is allowed by the database (the RPCs decide when), so
  // those are compared only where the TypeScript table offers them.
  assert.equal(pairs.length, 14);
  assert.match(body, /p_to in \('active', 'inactive'\)/);
  for (const from of status.STAFF_STATUSES) for (const to of status.STAFF_STATUSES) {
    if (to === "active" || to === "inactive") continue;
    assert.equal(status.canTransition(from, to), pairs.some(([a, b]) => a === from && b === to), `database ${from} -> ${to}`);
  }
  const check = sql.slice(sql.indexOf("add constraint staff_profiles_status_check"));
  const list = check.match(/status in \(([^)]*)\)/)?.[1].replace(/'/g, "").split(",").map((s) => s.trim());
  assert.deepEqual(list, [...status.STAFF_STATUSES]);
});

test("Employees actions follow the status and what exists; each one is a legal move with a confirmation", () => {
  const base = { liveDocumentLink: false, rejectedDocuments: 0, allApproved: false, offer: null, activationInvited: false };
  const acts = (status: string, extra: Record<string, unknown> = {}) => status && staffStatusLib.employeeActions({ ...base, ...extra, status } as never);
  // STAFF-OFFER-FULL-PART-TIME: offer details first, then Send offer, before any document.
  assert.deepEqual(acts("applied"), ["add_pay_details", "send_documents_link", "reject"]);
  assert.deepEqual(acts("applied", { payComplete: true }), ["send_offer", "edit_pay_details", "send_documents_link", "reject"]);
  assert.deepEqual(acts("invited"), ["add_pay_details", "resend_documents_link", "reject"], "no live link: nothing to revoke");
  assert.deepEqual(acts("invited", { liveDocumentLink: true }), ["add_pay_details", "resend_documents_link", "revoke_link", "reject"]);
  assert.deepEqual(acts("documents_submitted"), ["reject"], "nothing to offer before every document is approved");
  assert.deepEqual(acts("documents_submitted", { rejectedDocuments: 1 }), ["send_reupload_link", "reject"]);
  assert.deepEqual(acts("documents_submitted", { allApproved: true }), ["add_pay_details", "reject"], "pay details come before the offer");
  assert.deepEqual(acts("documents_submitted", { allApproved: true, payComplete: true, offer: { sent: false } }), ["send_offer", "edit_pay_details", "reject"]);
  assert.deepEqual(acts("offer_sent"), ["resend_offer", "withdraw_offer", "reject"]);
  assert.deepEqual(acts("offer_signed"), ["activate", "reject"]);
  assert.deepEqual(acts("documents_submitted", { allApproved: true, signaturesReady: true }), ["activate", "add_pay_details", "reject"], "signed documents in: activate without an offer");
  assert.deepEqual(acts("documents_submitted", { signaturesReady: true }), ["reject"], "documents must be approved first");
  assert.deepEqual(acts("offer_sent", { signaturesReady: true }), ["activate", "resend_offer", "withdraw_offer", "reject"]);
  assert.deepEqual(acts("offer_signed", { activationInvited: true }), ["resend_activation", "reject"]);
  assert.deepEqual(acts("active"), ["deactivate"]);
  assert.deepEqual(acts("inactive"), ["reactivate"]);
  assert.deepEqual(acts("rejected"), ["reopen"]);
  for (const st of status.STAFF_STATUSES) {
    for (const extra of [{}, { liveDocumentLink: true, rejectedDocuments: 2, allApproved: true, offer: { sent: false }, activationInvited: true, signaturesReady: true }]) {
      for (const action of staffStatusLib.employeeActions({ ...base, ...extra, status: st } as never)) {
        const to = staffStatusLib.EMPLOYEE_ACTION_TARGET[action];
        // Activating before the offer is signed passes through offer_signed ("signed documents received").
        assert.ok(to === null || status.canTransition(st, to) || (action === "activate" && status.canTransition(st, "offer_signed")), `${action} from ${st} is a legal move`);
        const spec = staffStatusLib.EMPLOYEE_ACTION[action];
        assert.ok(spec.label && spec.confirm && spec.explain, `${action} has a confirmation dialog`);
      }
    }
  }
  for (const action of ["reject", "withdraw_offer", "reopen"] as const) assert.equal(staffStatusLib.EMPLOYEE_ACTION[action].note, "required", `${action} needs a note`);
  for (const kind of ["application_received", "already_applied", "admin_new_application", "document_invite", "reupload_invite", "admin_documents_submitted", "offer", "signed_offer", "admin_offer_signed", "admin_offer_declined", "rejected", "access_ready"]) {
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

test("apply (email unique within a role, 2026-11-12): an email that already has a staff record is a public 409; a mobile duplicate stays the thank-you", async () => {
  let run = applyDeps({ apply: { ok: false, reason: "exists", field: "email" } });
  const taken = await apply.handleApply(applyForm(), { ip: null }, run.deps);
  assert.equal(taken.status, 409);
  assert.deepEqual(taken.body, { code: "email_taken", message: "An account with this email already exists. Sign in or reset your password.", details: null,
    error: "An account with this email already exists. Sign in or reset your password." }, "the public sentence; never the role");
  assert.ok(!run.names().includes("upload"), "nothing is stored");
  run = applyDeps({ apply: { ok: false, reason: "exists", field: "phone" } });
  assert.deepEqual(await apply.handleApply(applyForm(), { ip: null }, run.deps), { status: 200, body: { ok: true } }, "a mobile on another record is not reported");
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
    checkOwnership: async () => ({ ok: true as const, passportId: null }),
    recordCategory: async () => true,
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

test("signing tick (2026-11-20): the scheduled job's service-role JWT is a service caller even when SUPABASE_SERVICE_ROLE_KEY holds an sb_secret_ key; nothing else is", async () => {
  const serviceRole = await load.import<typeof import("../supabase/functions/_shared/service-role.ts")>("../supabase/functions/_shared/service-role.ts");
  const url = "https://xcpydisstlvtvcsqnjob.supabase.co";
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.c2lnbmF0dXJl`;
  const cron = jwt({ iss: "supabase", ref: "xcpydisstlvtvcsqnjob", role: "service_role" });
  const secret = "sb_secret_" + "x".repeat(32);
  // The case that broke: pg_cron sends the legacy JWT, the function's own key is the newer opaque secret.
  assert.equal(serviceRole.isServiceCaller(`Bearer ${cron}`, secret, url), true, "the scheduled job is the service");
  assert.equal(serviceRole.isServiceCaller(`Bearer ${secret}`, secret, url), true, "the function's own key still is");
  assert.equal(serviceRole.isServiceCaller(`Bearer ${jwt({ ref: "xcpydisstlvtvcsqnjob", role: "anon" })}`, secret, url), false, "anon key");
  assert.equal(serviceRole.isServiceCaller(`Bearer ${jwt({ sub: "user-1", role: "authenticated" })}`, secret, url), false, "a signed-in user");
  assert.equal(serviceRole.isServiceCaller(`Bearer ${jwt({ ref: "qoylrmorezlqdvufonmx", role: "service_role" })}`, secret, url), false, "another project's service key");
  assert.equal(serviceRole.isServiceCaller(`Bearer ${secret.slice(0, -1)}y`, secret, url), false, "a near miss of the secret");
  assert.equal(serviceRole.isServiceCaller("", secret, url), false); assert.equal(serviceRole.isServiceCaller(null, "", url), false);
  // document-signing uses this rule (not a plain comparison with SUPABASE_SERVICE_ROLE_KEY).
  const index = readFileSync(new URL("../supabase/functions/document-signing/index.ts", import.meta.url), "utf8");
  assert.match(index, /isServiceCaller: isServiceCaller\(authorization, serviceKey, env\.SUPABASE_URL\)/);
});

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
  const r = await onboard.handleOnboarding(linkRequest("upload", { category: "Passport", expiryDate: "2031-01-01", replaces: "" }, new File([PDF_BYTES], "C:\\docs\\passport.pdf", { type: "application/pdf" })), run.deps);
  assert.equal(r.status, 200);
  assert.deepEqual(run.names().filter((n) => n !== "limit"), ["hr_svc_upload_target", "upload", "hr_svc_document_add", "remove"]);
  assert.deepEqual(run.calls.find(([n]) => n === "upload")![1], { p: "p-1/passport/validated-rnd.pdf", type: "application/pdf", size: PDF_BYTES.length });
  const added = run.calls.find(([n]) => n === "hr_svc_document_add")![1] as Record<string, unknown>;
  assert.deepEqual([added.p_path, added.p_filename, added.p_mime, added.p_expiry], ["p-1/passport/validated-rnd.pdf", "passport.pdf", "application/pdf", "2031-01-01"]);
  assert.deepEqual(run.calls.at(-1), ["remove", ["p-1/passport/old.pdf"]], "the replaced file is deleted");
  assert.deepEqual(run.scheduled, ["Passport"], "a passport is read");

  run = linkDeps();
  await onboard.handleOnboarding(linkRequest("upload", { category: "Academic" }, new File([PNG_BYTES], "results.png", { type: "image/png" })), run.deps);
  assert.deepEqual(run.scheduled, [], "academic results are not read automatically");

  for (const [label, file] of [["exe renamed", new File([new Uint8Array([0x4d, 0x5a, 1, 2])], "p.pdf")], ["png named pdf", new File([PNG_BYTES], "p.pdf")], ["gif", new File([new TextEncoder().encode("GIF89a....")], "p.gif")], ["empty", new File([], "p.pdf")], ["too big", new File([PDF_BYTES, new Uint8Array(onboard.MAX_DOCUMENT_BYTES)], "p.pdf")]] as const) {
    run = linkDeps();
    const bad = await onboard.handleOnboarding(linkRequest("upload", { category: "Passport" }, file), run.deps);
    assert.equal(bad.status, 400, label);
    assert.ok(!run.names().includes("hr_svc_upload_target") && !run.names().includes("upload"), `${label}: nothing stored`);
  }

  run = linkDeps({ db: { hr_svc_upload_target: { error: { code: "23514", message: "Only a rejected document can be replaced." } } } });
  const refused = await onboard.handleOnboarding(linkRequest("upload", { category: "Visa" }, new File([PDF_BYTES], "v.pdf", { type: "application/pdf" })), run.deps);
  assert.deepEqual([refused.status, refused.body.error], [400, "Only a rejected document can be replaced."]);
  assert.ok(!run.names().includes("upload"), "a refused type is never stored");

  run = linkDeps({ db: { hr_svc_document_add: { error: { code: "22023", message: "The document location is not valid." } } } });
  const noExpiry = await onboard.handleOnboarding(linkRequest("upload", { category: "Passport" }, new File([PDF_BYTES], "p.pdf", { type: "application/pdf" })), run.deps);
  assert.equal(noExpiry.status, 400);
  assert.deepEqual(run.calls.at(-1), ["remove", ["p-1/passport/validated-rnd.pdf"]], "an unrecorded file is deleted");

  run = linkDeps();
  assert.equal((await onboard.handleOnboarding(linkRequest("upload", { category: "Passport", expiryDate: "next year" }, new File([PDF_BYTES], "p.pdf")), run.deps)).body.field, "expiryDate");
});

test("onboarding: a rejected category leaves the current file and checklist untouched", async () => {
  const run = linkDeps();
  const result = await onboard.handleOnboarding(linkRequest("upload", { category: "Academic" },
    new File([PDF_BYTES], "passport.pdf", { type: "application/pdf" })), {
    ...run.deps, checkOwnership: async () => ({ ok: false, status: 422, error: "Upload an academic record." }),
  });
  assert.deepEqual(result, { status: 422, body: { error: "Upload an academic record.", field: "file" } });
  assert.deepEqual(run.names().filter((name) => name !== "limit"), ["hr_svc_upload_target"]);
  assert.deepEqual(run.scheduled, []);
});

test("onboarding: a missing category receipt removes only the new object", async () => {
  const run = linkDeps();
  const result = await onboard.handleOnboarding(linkRequest("upload", { category: "Passport" },
    new File([PDF_BYTES], "passport.pdf", { type: "application/pdf" })), {
    ...run.deps, recordCategory: async () => false,
  });
  assert.equal(result.status, 503);
  assert.ok(!run.names().includes("hr_svc_document_add"));
  assert.deepEqual(run.calls.at(-1), ["remove", ["p-1/passport/validated-rnd.pdf"]]);
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

test("branded email layout (2026-11-24): same words, escaped, https buttons, sign-off becomes the signature, Postmark adds HTML to text-only mail", async () => {
  const eh = await load.import<typeof import("../supabase/functions/_shared/email-html.ts")>("../supabase/functions/_shared/email-html.ts");
  eh.resetEmailBranding();
  eh.setEmailBranding({ logoUrl: "https://cdn.example/logo.png", logoWidth: 350, logoHeight: 88, legalName: "Example Pty Ltd T/A Skyline", rto: "45989", cricos: "04114B", email: "info@example.test" });
  const text = "Hello Ann <b>,\n\nSet your password to open the agent portal:\nhttps://x.example/agency/accept-invite#t=abc\n\n- one\n- two\n\nName: Ann\nEmail: ann@example.test\n\nMessage from the sender:\nBring ID.\n\nPay your initial deposit: https://x.example/sign#t=def\n\nhttp://evil.example/x\n\nSkyline Institute of Technology\nThis is an automated message.";
  const parts = eh.textEmailBlocks(text);
  assert.deepEqual(parts.blocks.map((b) => b.type), ["p", "p", "button", "list", "details", "note", "button", "p"]);
  assert.ok(parts.signedOff && parts.greeting, "the plain-text sign-off is taken off and the email greets the person");
  const html = eh.textEmailHtml("Set your password", text);
  assert.ok(html.startsWith("<!doctype html>") && html.includes("Hello Ann &lt;b&gt;,") && !html.includes("<b>,"), "data is escaped");
  assert.ok(html.includes('href="https://x.example/agency/accept-invite#t=abc"') && html.includes(">Set your password</a>") && html.includes(">Pay your initial deposit</a>"), "labelled links are buttons");
  assert.ok(!html.includes('href="http://evil.example/x"'), "plain http links are not made clickable on a hosted address");
  assert.ok(html.includes('src="https://cdn.example/logo.png"') && html.includes('width="175"') && html.includes("RTO 45989") && html.includes("Kind regards,") && html.includes("<!--email-note-->"));
  assert.equal(eh.readableOnWhite("#ea6619"), "#b64f13", "the button colour is darkened until white text reads on it");
  assert.equal(eh.safeEmailUrl("javascript:alert(1)"), null);
  const sent: Array<Record<string, unknown>> = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ ErrorCode: 0, MessageID: "abcdef12-3456" }), { status: 200 }); }) as unknown as typeof fetch;
  const provider = hrMail.selectHrMailProvider({ EF_NOTIFICATION_EMAIL_ENABLED: "true", EF_POSTMARK_SERVER_TOKEN: "t", SUPABASE_URL: "https://xcpydisstlvtvcsqnjob.supabase.co" }, { fetch: fakeFetch })!;
  await provider.send({ deliveryId: "d", from: { name: "n", email: "f@example.test" }, to: "x@example.test", subject: "Ready for review: ZZ", textBody: "ZZ signed." });
  assert.equal(sent[0].TextBody, "ZZ signed.", "the text part is unchanged");
  assert.ok(String(sent[0].HtmlBody).includes("Ready for review: ZZ") && String(sent[0].HtmlBody).includes("ZZ signed."), "text-only mail gets the branded HTML");
  eh.resetEmailBranding();
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
  { category: "Passport", expiryDate: today }, { category: "Visa", expiryDate: "2030-01-01" }, { category: "Void Cheque", expiryDate: null },
  { category: "Academic", expiryDate: null }, { category: "Academic", expiryDate: null },
].map((d, i) => ({ ...d, id: `d${i}`, extractionStatus: "pending" as const, extracted: {} }));
const completeDetails = {
  is_australian_citizen: false as boolean | null, first_name: "Tara", middle_name: "", last_name: "Trainer", date_of_birth: "1990-05-06", phone: "+61400000111",
  address_street: "1 Example St", address_line2: "", address_suburb: "Melbourne", address_country: "Australia", address_state: "VIC", address_postcode: "3000",
  emergency_name: "Em", emergency_phone: "+61422333444", emergency_relationship: "Sibling", nationality: "Indian", passport_number: "PA1234567", visa_subclass: "485", visa_conditions: "",
  tax_residency: "resident", tax_free_threshold: "yes", study_loan: "no", super_choice: "default", super_fund_name: "", super_fund_abn: "", super_usi: "", super_member_number: "",
};

test("submit needs the details, citizenship and every required document with a current expiry date (documents only: no bank, tax or super)", () => {
  const now = new Date("2026-11-09T02:00:00Z");
  const today = "2026-11-09";
  const all = docs(today);
  const without = (category: string) => all.filter((d) => d.category !== category);
  const texts = (details = completeDetails, documents = all, bank = true) => wizardLib.wizardProblems(details, documents, bank, now).map((p) => p.text);
  assert.deepEqual(texts(), []);
  assert.deepEqual(texts(completeDetails, without("Passport")), ["A passport is required before you can submit."]);
  assert.deepEqual(texts(completeDetails, without("Visa")), [], "the visa is optional");
  assert.deepEqual(texts(completeDetails, without("Void Cheque")), [], "the void cheque is optional");
  assert.deepEqual(texts({ ...completeDetails, is_australian_citizen: true, visa_subclass: "" }, without("Visa")), [], "a citizen needs no visa and no visa subclass");
  assert.deepEqual(texts(completeDetails, without("Academic")), [], "academic results are optional");
  assert.deepEqual(texts(completeDetails, docs("2026-11-08")), ["Enter a current expiry date for your passport."]);
  assert.deepEqual(texts(completeDetails, [...all, { ...all[0], id: "en", category: "English", expiryDate: "2020-01-01" }, { ...all[0], id: "hi", category: "Health Insurance", expiryDate: "2020-01-01" }]), [], "English and health insurance are no longer asked: an old upload never blocks Submit");
  assert.deepEqual(texts(completeDetails, [...without("Passport"), { ...all[0], expiryDate: null }]), ["Enter a current expiry date for your passport."], "a passport uploaded without its date still needs one before Submit");
  assert.deepEqual(texts(completeDetails, [...all, { ...all[0], id: "lic", category: "Driving Licence", expiryDate: "2020-01-01" }]), [], "the optional licence never blocks Submit");
  assert.deepEqual(texts({ ...completeDetails, is_australian_citizen: null }), ["Tell us whether you are an Australian citizen."]);
  assert.deepEqual(texts(completeDetails, all, false), [], "bank details are not asked on the link");
  assert.ok(!texts().some((p) => /role/i.test(p)), "no role is asked of an applicant");
  const blank = wizardLib.wizardProblems({ ...staffRules.EMPTY_STAFF_DETAILS }, [], false, now);
  assert.deepEqual(blank.map((p) => p.text), [
    "Tell us whether you are an Australian citizen.", "Enter your first name.", "Enter your last name.", "Enter your date of birth.", "Enter your mobile number.",
    "Enter the street address.", "Enter the suburb or city.", "Enter the country.", "Enter the emergency contact's name.", "Enter the emergency contact's phone number.",
    "Enter how they are related to you.", "Enter your nationality.", "Enter your passport number.",
    "A passport is required before you can submit.",
  ], "everything missing, in the order the database checks it");
  // Each problem belongs to the step that fixes it; a step is complete (ticked) once it has none.
  assert.deepEqual([...new Set(blank.map((p) => p.step))], ["documents", "prefill", "personal"]);
  assert.deepEqual(wizardLib.STAFF_WIZARD.map((s) => s.id), ["documents", "prefill", "personal", "review"], "documents only: no Bank details or Tax and super steps");
  assert.ok(!texts().some((p) => /tax file|tfn/i.test(p)) && !Object.keys(staffRules.EMPTY_STAFF_DETAILS).some((k) => /tfn|tax_file/.test(k)), "no tax file number is asked for anywhere");
  assert.equal(wizardLib.stepComplete("documents", blank), false);
  assert.equal(wizardLib.stepComplete("review", []), true);
  assert.equal(wizardLib.stepComplete("review", wizardLib.wizardProblems(completeDetails, without("Passport"), false, now)), false);
  // The address belongs to Personal details, or to Check details when an Australian licence gave it.
  const licence = { id: "lic", category: "Driving Licence", expiryDate: "2030-01-01", extractionStatus: "done" as const, extracted: { au_street: "9 Licence Rd" } };
  assert.equal(wizardLib.wizardProblems({ ...completeDetails, address_suburb: "" }, all, true, now)[0].step, "personal");
  assert.equal(wizardLib.wizardProblems({ ...completeDetails, address_suburb: "" }, [...all, licence], true, now)[0].step, "prefill");
  assert.ok(wizardLib.stepFields("prefill", true).includes("address_street") && !wizardLib.stepFields("personal", true).includes("address_street"));
  assert.ok(wizardLib.stepFields("personal", false).includes("address_street") && !wizardLib.stepFields("prefill", false).includes("address_street"));
});

test("the document rules match the database", () => {
  const sql = read("supabase/migrations/20261110090000_hr_staff_enrolment_v2.sql");
  const voidCheque = read("supabase/migrations/20261122033517_staff_void_cheque_documents.sql");
  const passportOnly = read("supabase/migrations/20261122053517_staff_docs_passport_only.sql");
  assert.deepEqual(status.requiredStaffCategories(true), ["Passport"], "only the passport for citizens");
  assert.deepEqual(status.requiredStaffCategories(false), ["Passport"], "only the passport for non-citizens");
  assert.ok(passportOnly.includes("'citizen', jsonb_build_array('Passport'), 'other', jsonb_build_array('Passport')"), "the published rule lists only the passport");
  assert.deepEqual(status.requiredStaffCategories(null), status.requiredStaffCategories(false), "unanswered counts as a non-citizen");
  assert.ok(!status.requiredStaffCategories(false).includes("Driving Licence" as never), "the licence is never required");
  assert.ok(voidCheque.includes("check (category = any (array['Passport','Visa','English','Academic','Driving Licence','Health Insurance','Void Cheque']))"), "the allowed list has the seven types");
  assert.deepEqual([...status.STAFF_DOC_CATEGORIES].sort(), ["Academic", "Driving Licence", "English", "Health Insurance", "Passport", "Visa", "Void Cheque"]);
  assert.ok(sql.includes("p_category in ('Passport','Visa','Driving Licence','Health Insurance'); $fn$;"), "the SQL requires the same expiry dates");
  assert.ok(sql.includes("p_category in ('Passport','Visa','English','Driving Licence','Health Insurance'); $fn$;"), "the SQL accepts the same expiry dates");
  for (const c of status.STAFF_DOC_CATEGORIES) {
    assert.equal(status.staffDocNeedsExpiry(c), ["Passport", "Visa", "Driving Licence", "Health Insurance"].includes(c), `needs expiry: ${c}`);
    assert.equal(status.staffDocTakesExpiry(c), c !== "Academic" && c !== "Void Cheque", `takes expiry: ${c}`);
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
  // One screen each, in this order: passport, visa (non-citizens), the optional licence, void cheque, academic results; a visa a citizen
  // uploaded anyway is shown as optional.
  assert.deepEqual(status.staffDocKinds(true).map((k) => `${k.category}:${k.required}`), ["Passport:true", "Driving Licence:false", "Void Cheque:false", "Academic:false"]);
  assert.deepEqual(status.staffDocKinds(true, [{ category: "Visa" }]).map((k) => `${k.category}:${k.required}`), ["Passport:true", "Visa:false", "Driving Licence:false", "Void Cheque:false", "Academic:false"]);
  assert.deepEqual(status.staffDocKinds(false).map((k) => `${k.category}:${k.required}:${k.expiry}`),
    ["Passport:true:required", "Visa:false:required", "Driving Licence:false:required", "Void Cheque:false:none", "Academic:false:none"]);
  const list = status.staffChecklist([
    { category: "Passport", status: "approved", expiryDate: "2026-11-20" },
    { category: "Academic", status: "approved", expiryDate: null }, { category: "Academic", status: "rejected", expiryDate: null, reviewNote: "Unreadable" },
    { category: "Driving Licence", status: "pending", expiryDate: "2027-01-01" },
    { category: "Void Cheque", status: "pending", expiryDate: null },
  ], true, today);
  assert.deepEqual(list.map((i) => [i.kind.category, i.state, i.files, i.expiry]), [["Passport", "approved", 1, "soon"], ["Driving Licence", "pending", 1, "ok"], ["Void Cheque", "pending", 1, "none"], ["Academic", "rejected", 2, "none"]]);
  assert.deepEqual(list[3].notes, ["Unreadable"]);
  assert.deepEqual(checklistLib.approvedCount(list), { approved: 1, required: 1 }, "x/N counts required types only (only the passport)");
  assert.deepEqual(status.staffChecklist([], false, today).map((i) => i.state).join(","), "missing,missing,missing,missing,missing");
  assert.deepEqual(checklistLib.approvedCount(status.staffChecklist([], false, today)), { approved: 0, required: 1 });
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
  // The student upload function (validated-document-upload) uses the shared copy: the same redirect, only for a local Supabase.
  const labFetch = await load.import<typeof import("../supabase/functions/_shared/document-extraction/lab-reader-fetch.ts")>("../supabase/functions/_shared/document-extraction/lab-reader-fetch.ts");
  seen.length = 0;
  await labFetch.readerFetch({ SUPABASE_URL: "http://kong:8000", EF_OPENAI_API_URL: "http://host.docker.internal:1/" }, spy)("https://api.openai.com/v1/responses");
  await labFetch.readerFetch({ SUPABASE_URL: "https://xcpydisstlvtvcsqnjob.supabase.co", EF_OPENAI_API_URL: "http://host.docker.internal:1" }, spy)("https://api.openai.com/v1/responses");
  assert.deepEqual(seen, ["http://host.docker.internal:1/v1/responses", "https://api.openai.com/v1/responses"]);
  assert.ok(read("supabase/functions/validated-document-upload/index.ts").includes("fetch: readerFetch({ SUPABASE_URL: url"), "the student upload function reads through the lab redirect");
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
  assert.deepEqual(await offerPdf.inspectOfferPdf(await makePdf(3)), { ok: true, pages: 3 });
  assert.deepEqual(await offerPdf.inspectOfferPdf(await encryptedPdf()), { ok: false, error: offerPdf.OFFER_ENCRYPTED });
  assert.match(offerPdf.OFFER_ENCRYPTED, /password-protected or encrypted/);
  assert.equal((await offerPdf.inspectOfferPdf(new TextEncoder().encode("MZ not a pdf"))).ok, false);
  assert.equal((await offerPdf.inspectOfferPdf(new TextEncoder().encode("%PDF-1.7\n garbage with no objects"))).ok, false, "a file that only starts like a PDF is refused");
  assert.equal((await offerPdf.inspectOfferPdf(new Uint8Array(0))).ok, false);
  assert.equal((await offerPdf.inspectOfferPdf(new Uint8Array(offerPdf.MAX_OFFER_BYTES + 1))).ok, false, "over 7 MB (it is emailed back signed)");
});

/** The fonts each page of a PDF draws with: the shared styling embeds Noto Sans on every page it makes. */
async function pdfFonts(bytes: Uint8Array): Promise<string[][]> {
  const doc = await PdfLib.PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const fonts = page.node.Resources()?.lookup(PdfLib.PDFName.of("Font"));
    if (!(fonts instanceof PdfLib.PDFDict)) return [];
    return fonts.entries().map(([, ref]) => { const dict = doc.context.lookup(ref); return dict instanceof PdfLib.PDFDict ? String(dict.get(PdfLib.PDFName.of("BaseFont"))) : "?"; });
  });
}

test("businesses (2026-11-20): an Active business offers only Active / Inactive and never goes back to Onboarding; Delete business only for SLIT admins once Inactive or at Application sent, removes everything silently, the link says no longer available", async () => {
  const del = await load.import<typeof import("../src/pages/admin/lib/businessDelete.ts")>("../src/pages/admin/lib/businessDelete.ts");
  // 1. The dropdown: Active and Inactive only (the status catalog also has Onboarding).
  const catalog = [{ value: "Active", label: "Active" }, { value: "Inactive", label: "Inactive" }, { value: "Onboarding", label: "Onboarding" }];
  assert.deepEqual(del.businessDropdownStatuses(catalog).map((c) => c.value), ["Active", "Inactive"]);
  assert.ok(read("src/pages/admin/BusinessesPage.tsx").includes("{dropdownStatuses.map((item) => ("), "the row dropdown uses the filtered list");
  // ... and the database refuses Onboarding for a business that was ever active, by any path; direct API deletes are refused too.
  const sql = read("supabase/migrations/20261120133517_business_status_guard_and_delete.sql").replace(/\r\n/g, "\n");
  assert.match(sql, /if new\.status = 'Onboarding' and old\.status is distinct from 'Onboarding' and \(old\.status = 'Active' or old\.onboarding_completed_at is not null\) then/);
  assert.match(sql, /create trigger agencies_status_guard before update of status on public\.agencies/);
  assert.match(sql, /if current_user in \('authenticated', 'anon'\) then\n   raise exception 'Delete a business with Delete business/);
  // 2. Who sees Delete business: a SLIT administrator, a business at Application sent, never a system business.
  const row = (over: Record<string, unknown> = {}) => ({ status: "Onboarding", onboardingLabel: "Application sent", agencyCode: "ZZ-1", ...over });
  assert.equal(del.canOfferBusinessDelete(row(), true), true);
  assert.equal(del.canOfferBusinessDelete(row(), false), false, "other staff: hidden");
  for (const label of ["Not sent yet", "Awaiting referees", "Ready for review", "Correction requested", "Resubmitted", null]) assert.equal(del.canOfferBusinessDelete(row({ onboardingLabel: label }), true), true, `${label}: offered (owner 2026-11-24, any status)`);
  assert.equal(del.canOfferBusinessDelete(row({ status: "Active" }), true), true, "Active: offered (owner 2026-11-24)");
  assert.equal(del.canOfferBusinessDelete(row({ status: "Inactive", onboardingLabel: "Ready for review" }), true), true, "Inactive: offered (owner 2026-11-24)");
  for (const code of ["SLIT-DIRECT", "TEST-VIEW", "slit-direct"]) assert.equal(del.canOfferBusinessDelete(row({ agencyCode: code }), true), false, `${code}: never`);
  // 2026-11-20 follow-up: the admin role is read whatever its case; every other row gets a reason (the greyed-out icon's tooltip).
  assert.deepEqual(["Admin", "admin", " ADMIN ", "Editor", "", null].map((r) => del.isSlitAdmin(r as string)), [true, true, true, false, false, false]);
  assert.equal(del.deleteBlockReason(row(), true), null);
  assert.match(del.deleteBlockReason(row(), false)!, /Only a SLIT administrator/);
  assert.match(del.deleteBlockReason(row({ agencyCode: "SLIT-DIRECT", status: "Active" }), true)!, /never be deleted/);
  assert.equal(del.deleteBlockReason(row({ status: "Active", onboardingLabel: null }), true), null);
  assert.equal(del.deleteBlockReason(row({ status: "Inactive", onboardingLabel: null }), true), null);
  assert.equal(del.deleteBlockReason(row({ status: "Inactive", onboardingLabel: "Awaiting referees" }), true), null);
  assert.match(del.deleteBlockReason(row({ status: "Inactive", students: 1 }), true)!, /cannot be deleted/);
  assert.equal(del.deleteBlockReason(row({ onboardingLabel: "Not sent yet" }), true), null);
  assert.equal(del.deleteBlockReason(row({ onboardingLabel: "Awaiting referees" }), true), null);
  // The database matches (owner 2026-11-24: any status).
  const anySql = read("supabase/migrations/20261124091517_business_delete_any_status.sql");
  assert.ok(!/a\.status = 'Active'/.test(anySql) && !/Inactive first/.test(anySql), "no status check left in admin_business_delete_block");
  assert.match(del.deleteBlockReason(row({ students: 2 }), true)!, /students or applications/);
  const listPage = read("src/pages/admin/BusinessesPage.tsx");
  assert.ok(listPage.includes("const isAdmin = isSlitAdmin(user?.role);") && listPage.includes("title={reason}") && listPage.includes("border-red-300"), "red Delete where possible, a tooltip elsewhere");
  // The tabs: Onboarding is a filter the list accepts and counts; every business is in exactly one tab, so they add up to All.
  const listSql = read("supabase/migrations/20261120143517_business_list_onboarding_tab.sql").replace(/\r\n/g, "\n");
  assert.ok(listSql.includes("not in ('', 'Active', 'Inactive', 'Onboarding')"), "Onboarding accepted as a filter");
  assert.ok(listSql.includes("'onboarding', (select count(*) from searched where status = 'Onboarding' and not pending_review), 'pending', (select count(*) from searched where pending_review)"));
  assert.ok(listSql.includes("'inactive', (select count(*) from searched where status = 'Inactive' and not pending_review)"));
  assert.ok(listPage.includes(`: value === "Onboarding" ? counts?.onboarding`), "the Onboarding tab shows its count");
  // The typed confirmation: the name (case and spaces ignored) or the ABN.
  assert.equal(del.deleteConfirmMatches("  purva  tech pty ltd ", "PURVA TECH PTY LTD", "86603584676"), true);
  assert.equal(del.deleteConfirmMatches("86 603 584 676", "PURVA TECH PTY LTD", "86603584676"), true);
  assert.equal(del.deleteConfirmMatches("PURVA TECH", "PURVA TECH PTY LTD", "86603584676"), false);
  assert.equal(del.deleteConfirmMatches("", "PURVA TECH PTY LTD", ""), false);
  // The database rules (the same ones the screens use) and the complete removal.
  for (const rule of ["'This is a system business: it cannot be deleted.'", "o.stage <> 'application_sent'", "r.state not in ('sent', 'viewed') or r.signed_at is not null",
    "'This business has students or applications: make it Inactive instead.'", "if not public.cms_is_admin() then raise exception 'Only a SLIT administrator can delete a business.'",
    "raise exception 'Type the business name or its ABN exactly to confirm.'"]) assert.ok(sql.includes(rule), `rule: ${rule}`);
  for (const table of ["hr.sign_fields", "hr.sign_tokens", "hr.sign_token_history", "hr.sign_codes", "hr.sign_notifications", "hr.sign_events", "public.agency_onboarding_drafts",
    "public.agency_onboarding_attachments", "public.agency_onboarding_corrections", "public.agency_onboarding_revisions", "public.agency_onboarding_referees", "public.agency_onboarding_events",
    "hr.sign_recipients", "hr.sign_requests", "public.agency_onboarding", "public.comm_messages", "public.comm_conversations", "public.notification_deliveries", "public.portal_audit_log",
    "public.agency_invitations", "public.agency_memberships", "public.agency_tenant_agents", "public.agency_tenants", "public.agents", "public.portal_profiles", "auth.users", "public.agencies"]) {
    assert.ok(new RegExp(`delete from ${table.replace(".", "\\.")}\\b`).test(sql), `deletes ${table}`);
  }
  assert.match(sql, /set local session_replication_role = replica;/, "triggers off: nothing is queued or emailed");
  assert.match(sql, /insert into public\.business_deletions\(deleted_by, deleted_by_name, business_name, abn\)/, "one minimal audit row");
  assert.match(sql, /raise exception 'This link is no longer available\.'/, "a deleted request's link: neutral");
  // The function: the database deletes, then the signing files it names are removed from storage; nothing is emailed.
  const removed: string[] = []; const rpcs: string[] = [];
  const ctx = { body: { agencyId: "11111111-1111-4111-8111-111111111111", confirm: "ZZ Test" }, admin: async () => null,
    rpc: async (name: string) => { rpcs.push(name); return { deleted: true, name: "ZZ Test", abn: "49004028077", files: ["r1/original.pdf", "r1/signed-x.pdf"], counts: { agents: 1 } }; },
    ports: { storage: { remove: async (paths: string[]) => { removed.push(...paths); } } } };
  const out = await onboardingFn.deleteBusiness(ctx as never) as { deleted: boolean; filesRemoved: number; filesLeft: number };
  assert.deepEqual([out.deleted, out.filesRemoved, out.filesLeft, rpcs, removed], [true, 2, 0, ["admin_business_delete"], ["r1/original.pdf", "r1/signed-x.pdf"]]);
  assert.ok(!/send|mail|notify/i.test(rpcs.join(" ")), "no email call");
  // The signing page: a deleted link shows "This link is no longer available", with nothing to request.
  assert.match(read("supabase/functions/document-signing/core.ts"), /if \(\/no longer available\/i\.test\(e\.message\)\) throw new SigningError\(LINK_GONE, 410\);/);
  const page = read("src/pages/SigningPage.tsx");
  assert.ok(page.includes(`const gone = /no longer available/i.test(message);`) && page.includes(">This link is no longer available</p>"), "neutral page");
});

test("completion certificate (2026-11-20): never emailed, downloaded or shown to anyone; only the signed documents leave; the audit record stays on the signing request for staff", async () => {
  // Emails: every completion email (to the signer, an offer with a deposit, the administrator) mentions and attaches the signed document only.
  const base = { id: 1, title: "Contract", reference: "SLIT-1", name: "Ann", to: "a@example.test", signed_path: "r/s.pdf", signed_hash: "a".repeat(64), certificate_path: "r/c.pdf", certificate_hash: "b".repeat(64) };
  for (const job of [{ ...base, kind: "completed", audience: "recipient" }, { ...base, kind: "completed", audience: "admin", signers: [{ name: "Ann", role: "Student", state: "signed" }] },
    { ...base, kind: "completed", audience: "recipient", deposit: { label: "AUD 500.00", link: "https://x.example/sign#t=1" } }]) {
    const mail = signing.renderSigningEmail(job as never, null)!;
    assert.ok(mail && !/certificate|IP address|user agent/i.test(`${mail.subject} ${mail.text}`), `no certificate wording: ${mail.subject}`);
    assert.match(mail.text, /signed (document|copy) is attached/);
  }
  // The signer's view and every download: no certificate link or kind anywhere.
  const core = read("supabase/functions/document-signing/core.ts");
  assert.ok(!core.includes("certificateUrl"), "the signing link's view has no certificate link");
  assert.match(core, /const files: Array<\[string, string, string\]> = \[\[job\.signed_path, job\.signed_hash, `\$\{safeName\(job\.title\)\}-signed\.pdf`\]\];/, "the completion email attaches the signed PDF only");
  assert.match(core, /if \(which === "certificate"\) \{/, "staff still open the audit record from the signing request (admin_url)");
  for (const file of ["src/pages/SigningPage.tsx", "src/pages/agency/components/AgencyAgreementCard.tsx", "src/pages/agency/components/ApplicationStatusPanels.tsx", "src/pages/admin/components/AgentOnboardingPanel.tsx"]) {
    const text = read(file);
    assert.ok(!/certificateUrl|"certificate"\)|application_certificate"|referee_certificate:|offer-letter-certificate|\["form", "agreement", "certificate"\]/.test(text), `${file}: no certificate download`);
  }
  assert.ok(!read("src/pages/admin/components/AgentOnboardingPanel.tsx").includes("· IP "), "the business page shows no IP address");
  assert.match(read("src/pages/admin/components/signing/RequestDetail.tsx"), /View audit record/, "the signing request page (staff only) keeps the audit record");
  // The database refuses the certificate kinds in every download and lists none (portal offer letters, agency onboarding).
  const sql = read("supabase/migrations/20261120123517_signing_certificate_private.sql").replace(/\r\n/g, "\n");
  assert.match(sql, /if p_kind in \('certificate', 'application_certificate'\) or p_kind like 'referee_certificate:%' then\n  raise exception 'The audit record is not downloadable/);
  assert.match(sql, /elsif p_kind = 'certificate' then\n  raise exception 'The audit record is not downloadable/);
  for (const changed of [`'hasCertificate', false`, `'certificate', false, 'application_certificate', false)`, `'form', f.form_content is not null, 'certificate', false)`, `'agreement', o.agreement_content is not null, 'certificate', false)`]) {
    assert.ok(sql.includes(changed), `listed as not available: ${changed}`);
  }
  // Staff (HR) offers: the signed copy carries the signature, not the audit details (kept in hr_svc_offer_sign).
  const signedOffer = await offerPdf.stampSignedOffer(await makePdf(1), { signerName: "Asha Patel", signedAt: "2026-11-20T00:00:00Z", ip: "203.0.113.5", userAgent: "Mozilla/5.0 Test",
    consent: offerPdf.OFFER_CONSENT, offerFilename: "offer.pdf", offerSha256: "ab".repeat(32) });
  const offerText = (await pdfText(signedOffer)).map((t) => t.text).join(" ");
  assert.ok(offerText.includes("Asha Patel") && !/203\.0\.113\.5|Mozilla|IP address|Browser|abab/.test(offerText), "no IP address, browser or hash on the staff offer's signed copy");
});

const signedTime = await load.import<typeof import("../src/lib/signedTime.ts")>("../src/lib/signedTime.ts");
test("signing done page (2026-11-20): Melbourne time with its zone, a new download link per click, steps inside the card, no stale-link note, no certificate", async () => {
  // 4. The signed time: SLIT's time zone, named.
  assert.equal(signedTime.formatSignedAt("2026-11-19T05:42:00Z"), "19 Nov 2026, 4:42 pm AEDT");
  assert.equal(signedTime.formatSignedAt("2026-07-01T02:05:00Z"), "1 Jul 2026, 12:05 pm AEST", "winter: standard time");
  assert.equal(signedTime.formatSignedAt("2026-11-19T13:00:00Z"), "20 Nov 2026, 12:00 am AEDT", "the Melbourne date, not the UTC one");
  assert.deepEqual([signedTime.formatSignedAt(null), signedTime.formatSignedAt("not a date")], ["", ""]);
  // 3. "download": the same document the page shows, a new link every call; only the signed PDF once signed, never the certificate.
  const bytes = new Uint8Array([1, 2, 3]); const hash = await signingCore.sha256Hex(bytes);
  let n = 0; const asked: string[] = [];
  const record = { id: "r", title: "Agent referee check", state: "signed", signed_path: "r/signed.pdf", signed_hash: hash, original_path: "r/original.pdf", original_hash: hash,
    certificate_path: "r/certificate.pdf", certificate_hash: hash, recipient: { id: "x", state: "signed" }, fields: [] };
  const ports = { isServiceCaller: false, later: () => undefined, service: async (name: string) => (name === "open" ? record : true),
    storage: { download: async () => bytes, upload: async () => true, remove: async () => undefined, signedUrl: async (p: string, _s: number, name?: string) => { asked.push(`${p}|${name}`); return `https://x.example/${p}?t=${++n}`; } },
    mail: { provider: null, config: { from: null, adminTo: [], siteUrl: "", problems: [] } } } as unknown as Parameters<typeof signingCore.handleSigning>[1];
  const download = () => signingCore.handleSigning({ body: { action: "download", token: "a".repeat(64) }, upload: null, ip: null, userAgent: null }, ports) as Promise<{ url: string }>;
  const first = await download(), second = await download();
  assert.ok(first.url !== second.url && first.url.includes("r/signed.pdf"), "a fresh link per click");
  assert.ok(asked.length === 2 && asked.every((a) => a.startsWith("r/signed.pdf|") && a.endsWith("-signed.pdf")), `the signed PDF, named as signed: ${asked.join(", ")}`);
  assert.ok(!asked.some((a) => a.includes("certificate")), "never the completion certificate");
  await assert.rejects(signingCore.handleSigning({ body: { action: "download", token: "../x" }, upload: null, ip: null, userAgent: null }, ports), (e: Error & { status?: number }) => e.status === 403, "a bad link is refused");
  assert.equal(await read("src/lib/signingApi.ts").includes(`signingAction<{ url?: string }>({ action: "download", token })`), true);
  // 1, 2 and 5. One shared done component: steps stacked on a phone and in a row from md up, the Download button in the same section, no footer bar.
  const done = read("src/components/signing/SigningDone.tsx"), wizard = read("src/components/signing/F04Wizard.tsx"), page = read("src/pages/SigningPage.tsx");
  assert.ok(done.includes("grid w-full max-w-sm grid-cols-1") && done.includes("md:grid-flow-col") && done.includes("break-words"), "steps wrap and stack");
  assert.match(done, /<section className="mt-5 flex w-full flex-col items-center gap-5"[^>]*>[\s\S]*What happens next[\s\S]*<DownloadSigned[\s\S]*<\/section>/, "the download sits in the steps' section, centred");
  assert.ok(done.includes("The download could not start.") && done.includes("Try again"), "an inline error with a retry");
  assert.ok(wizard.includes("stepper={null} footerStart={null} footerEnd={null}>") && wizard.includes("<SigningDone "), "F04: no footer divider, the shared layout");
  assert.ok(read("src/components/shared/wizard/WizardShell.tsx").includes("footerStart == null && footerEnd == null ? null"), "no empty footer bar");
  assert.equal((page.match(/<SigningDone /g) ?? []).length, 3, "offer letter, completed document (referee, agreement, HR) and signed-by-me use it");
  for (const [file, text] of [["SigningDone", done], ["F04Wizard", wizard], ["SigningPage", page]] as const) {
    assert.ok(!/few minutes; reload|reload this page for/i.test(text), `${file}: no stale-link note`);
    assert.ok(!/certificate/i.test(text), `${file}: no certificate anywhere`);
  }
  assert.ok(!page.includes("href={view.url} download") && !wizard.includes("href={view.url} download"), "no stored link offered for download");
});

test("offer PDF: signing keeps every original page and adds one signature page on the shared styling", async () => {
  const signed = await offerPdf.stampSignedOffer(await makePdf(2), { signerName: "Ann Ápplicant", signedAt: "2026-11-09T10:00:00.000Z", ip: "203.0.113.5",
    userAgent: "Mozilla/5.0 (Windows NT 10.0) ".repeat(8), consent: offerPdf.OFFER_CONSENT, offerFilename: "offer.pdf", offerSha256: "ab".repeat(32) });
  const doc = await PdfLib.PDFDocument.load(signed);
  assert.equal(doc.getPageCount(), 3, "2 original pages + the signature page");
  assert.match(doc.getSubject() ?? "", /signed by Ann Applicant/, "accents are made PDF-safe");
  const fonts = await pdfFonts(signed);
  assert.ok(fonts[0].every((f) => /Helvetica/.test(f)) && fonts[1].every((f) => /Helvetica/.test(f)), "the original pages are untouched");
  assert.ok(fonts[2].length >= 1 && fonts[2].every((f) => /NotoSans/.test(f)), `the signature page uses the shared fonts: ${fonts[2].join(", ")}`);
  assert.deepEqual([doc.getPage(2).getWidth(), doc.getPage(2).getHeight()], [595.28, 841.89], "A4, as every Skyline PDF");
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

  // OFFER-BEFORE-DOCUMENTS-FIX: Invited may get an offer now; a sent offer still cannot be replaced by an upload.
  run = adminDeps({ file, db: { hr_admin_staff_detail: { data: { profile: { status: "offer_sent" } } } } });
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
  // Email unique within a role (20261113240000): the email refusal carries hint email_taken and is a 409 for the email field.
  run = adminDeps({ db: { hr_admin_staff_add: { error: { code: "23505", hint: "email_taken", message: "This email or mobile already has a staff record. Open it from Employees." } as { code: string; message: string } } } });
  r = await staffAdmin.handleAdmin({ action: "add", firstName: "Ada", lastName: "Added", email: "ada@example.test", phone: "+61412345678" }, run.deps);
  assert.deepEqual([r.status, r.body.code, r.body.message, run.names()], [409, "email_taken", "This email is already in use. Please use a different email address.", ["admin:hr_admin_staff_add"]]);
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
  const ok = { firstName: "Mary-Jane", lastName: "O'Neil", email: "mary@example.com", phone: "+61412345678" };
  assert.deepEqual(emp.employeeProblems(ok), {});
  assert.deepEqual(Object.keys(emp.employeeProblems(emp.EMPTY_EMPLOYEE)).sort(), ["email", "firstName", "lastName", "phone"], "every field is required");
  assert.equal(emp.employeeProblems({ ...ok, firstName: "J0hn" }).firstName, "The first name can only contain letters, spaces, hyphens, apostrophes and full stops.");
  assert.equal(emp.employeeProblems({ ...ok, lastName: "x".repeat(101) }).lastName, "The last name must be 100 characters or fewer.");
  assert.equal(emp.employeeProblems({ ...ok, email: "mary@example" }).email, "Enter a valid email address.");
  // The same phone rules as the student and agent forms (PhoneInput stores E.164).
  assert.deepEqual(emp.employeeProblems({ ...ok, phone: "+61412345678" }), {});
  assert.deepEqual(emp.employeeProblems({ ...ok, phone: "+61398765432" }), {}, "any Australian number, as for students");
  assert.deepEqual(emp.employeeProblems({ ...ok, phone: "+919876543210" }), {}, "other countries from the dropdown");
  assert.equal(emp.mobileProblem(""), "Enter the mobile number.");
  assert.equal(emp.mobileProblem("+6141234"), "Enter a 10-digit Australian number starting with 0, e.g. 041 234 5678.");
  assert.equal(emp.mobileProblem("+9112"), "Enter a valid phone number for the selected country.");
  assert.equal(emp.formatMobile("+61412345678"), "041 234 5678");
  assert.ok(read("src/pages/admin/components/EmployeeFormDialog.tsx").includes("<PhoneInput"), "the form uses the student / agent phone field");
  const phoneSql = read("supabase/migrations/20261110190000_hr_employee_phone_like_students.sql");
  assert.ok(phoneSql.includes("'^\\+61[1-9]\\d{8}$'") && phoneSql.includes("Enter a 10-digit Australian number starting with 0, e.g. 041 234 5678."), "the database uses the same rule and message");
  assert.equal(emp.employeeFileProblem({ type: "application/pdf", size: 1000, name: "a.pdf" }), null);
  assert.equal(emp.employeeFileProblem({ type: "application/zip", size: 1000, name: "a.zip" }), "Upload a PDF, JPG, PNG or Word file.");
  assert.equal(emp.employeeFileProblem({ type: "image/png", size: emp.EMPLOYEE_DOC_MAX_BYTES + 1, name: "a.png" }), "The file must be 10 MB or smaller.");
  assert.equal(emp.employeeDocPath("abc", "../My Passport (1).pdf", "r1"), "employees/abc/r1-My_Passport_1_.pdf", "the file name cannot leave the employee's folder");
  assert.deepEqual(Object.keys(emp.EMPLOYEE_STATUS_LABEL), ["active", "inactive"], "two statuses only");
  const sql = read("supabase/migrations/20261110170000_hr_employees_simple.sql");
  const voidChequeSql = read("supabase/migrations/20261122033517_staff_void_cheque_documents.sql");
  for (const c of emp.EMPLOYEE_DOC_CATEGORIES) assert.ok(sql.includes(`'${c}'`) || voidChequeSql.includes(`'${c}'`), `the database accepts ${c}`);
  assert.ok(sql.includes("'Enter a valid email address.'") && sql.includes("drop trigger if exists employment_activation_guard"), "the database validates too and activation needs no login");
  // Several documents at once: the type is guessed from the file name; each type once per batch.
  assert.equal(emp.guessDocCategory("John_Passport.pdf"), "Passport");
  assert.equal(emp.guessDocCategory("visa-grant-notice.pdf"), "Visa");
  assert.equal(emp.guessDocCategory("drivers licence front.jpg"), "Driving Licence");
  assert.equal(emp.guessDocCategory("PTE results.pdf"), "PTE");
  assert.equal(emp.guessDocCategory("IELTS.pdf"), "English Certificate");
  assert.equal(emp.guessDocCategory("OSHC policy.pdf"), "Health Insurance");
  assert.equal(emp.guessDocCategory("John CV 2026.docx"), "Resume");
  assert.equal(emp.guessDocCategory("Bachelor transcript.pdf"), "Academic");
  assert.equal(emp.guessDocCategory("scan001.jpg", ["Passport"]), "Visa", "an unknown name takes the first type not used yet");
  assert.deepEqual(emp.duplicateCategories(["Passport", "Visa", "Passport"]), ["Passport"]);
  assert.deepEqual(emp.duplicateCategories(["Passport", "Visa"]), []);
  const upload = read("src/pages/admin/components/EmployeeDocumentsUpload.tsx");
  assert.ok(upload.includes("multiple") && upload.includes("onDrop") && upload.includes("uploadEmployeeDocument("), "several files by picking or dropping, each uploaded on its own");
  const page = read("src/pages/admin/StaffDetailPage.tsx");
  assert.ok(page.includes("employeeDocumentUrl(") && !/getPublicUrl|\.download\(/.test(page), "files open through signed URLs only");
});

/* ------------------------------------------------------------------ onboarding flow (2026-11-10): stages, pay details, templates, offer + login */
const tpl = await load.import<typeof import("../supabase/functions/_shared/hr-template.ts")>("../supabase/functions/_shared/hr-template.ts");
const letterLib = await load.import<typeof import("../supabase/functions/_shared/offer-letter-pdf.ts")>("../supabase/functions/_shared/offer-letter-pdf.ts");
const submissionLib = await load.import<typeof import("../supabase/functions/_shared/notification/submission-pdf.ts")>("../supabase/functions/_shared/notification/submission-pdf.ts");

test("onboarding: only the step that is next is offered, and every stage has its label and banner", () => {
  const base = { liveDocumentLink: false, rejectedDocuments: 0, allApproved: false, offer: null, activationInvited: false };
  const acts = (st: string, extra: Record<string, unknown> = {}) => staffStatusLib.employeeActions({ ...base, ...extra, status: st } as never);
  assert.deepEqual(acts("applied", { openJobApplication: true }), ["add_pay_details", "send_documents_link", "reject"], "a Careers applicant gets the document link from the employee page too");
  assert.deepEqual(acts("documents_submitted", { allApproved: true }), ["add_pay_details", "reject"], "documents approved: pay details are next, not the offer");
  assert.deepEqual(acts("documents_submitted", { allApproved: true, payComplete: true }), ["send_offer", "edit_pay_details", "reject"]);
  assert.deepEqual(acts("documents_submitted", { rejectedDocuments: 1, payComplete: true }), ["send_reupload_link", "reject"], "no offer while a document is rejected");
  assert.deepEqual(acts("offer_sent", { hasLogin: true, passwordSet: false }), ["resend_offer", "resend_login", "withdraw_offer", "reject"]);
  assert.deepEqual(acts("offer_sent", { hasLogin: true, passwordSet: true }), ["resend_offer", "withdraw_offer", "reject"], "no new sign-in link once a password is chosen");
  assert.deepEqual(acts("offer_signed", { hasLogin: true, passwordSet: true }), ["activate", "reject"]);
  assert.deepEqual(staffStatusLib.ONBOARDING_STAGES, ["applied", "shortlisted", "documents_requested", "documents_submitted", "documents_approved", "pay_details", "offer_sent", "offer_signed", "active"]);
  for (const stage of staffStatusLib.ONBOARDING_STAGES) assert.ok(staffStatusLib.ONBOARDING_STAGE_LABEL[stage] && staffStatusLib.ONBOARDING_STAGE_HINT[stage], `${stage} has a label and a banner`);
  assert.equal(staffStatusLib.EMPLOYEE_ACTION.deactivate.note, "required", "marking inactive needs a reason");
  assert.equal(staffStatusLib.EMAIL_KIND_LABEL.login_link, "Sign-in link");
  const sql = read("supabase/migrations/20261111090000_hr_onboarding_stages_pay.sql");
  for (const stage of staffStatusLib.ONBOARDING_STAGES) assert.ok(sql.includes(`'${stage}'`), `the database knows the ${stage} stage`);
  for (const label of Object.values(staffStatusLib.ONBOARDING_STAGE_LABEL)) assert.ok(sql.includes(`'${label}'`), `the database uses the same label: ${label}`);
});

test("pay details form: every field is checked, the same way as the database", () => {
  const ok = { jobTitle: "Trainer", employmentType: "full_time", startDate: "2026-12-01", payBasis: "hourly", rate: "42.50", payScheduleId: "s-1", hoursPerWeek: "38", locationId: "l-1" };
  const check = (over: Record<string, string>) => staffStatusLib.payDetailsProblems({ ...ok, ...over }, "2026-11-10");
  assert.deepEqual(check({}), {});
  assert.ok(check({ jobTitle: " " }).jobTitle);
  assert.ok(check({ employmentType: "casual" }).employmentType, "casual is no longer a job type (we employ no casual staff)");
  assert.deepEqual(check({ employmentType: "contract" }), {}, "contract is a job type");
  assert.equal(check({ locationId: "" }).locationId, "Choose the work location.", "the work location comes from HRMS > Locations and is required");
  assert.ok(check({ startDate: "" }).startDate && check({ startDate: "2001-01-01" }).startDate && check({ startDate: "2030-01-01" }).startDate);
  assert.ok(check({ payBasis: "" }).payBasis);
  assert.ok(check({ rate: "abc" }).rate && check({ rate: "0" }).rate && check({ rate: "-5" }).rate && check({ rate: "1.234" }).rate);
  assert.match(String(check({ rate: "85000" }).rate), /too high/, "an annual figure entered as hourly is caught");
  assert.match(String(check({ payBasis: "salary", rate: "42.50" }).rate), /too low/, "an hourly figure entered as annual is caught");
  assert.deepEqual(check({ payBasis: "salary", rate: "85000" }), {});
  assert.ok(check({ payScheduleId: "" }).payScheduleId);
  assert.ok(check({ hoursPerWeek: "" }).hoursPerWeek && check({ hoursPerWeek: "99" }).hoursPerWeek && check({ hoursPerWeek: "x" }).hoursPerWeek);
  assert.deepEqual(check({ employmentType: "contract", hoursPerWeek: "" }), {}, "a contract needs no hours");
  const sql = read("supabase/migrations/20261111090000_hr_onboarding_stages_pay.sql") + read("supabase/migrations/20261113090000_hr_locations_job_type_login.sql");
  assert.ok(sql.includes("Choose the work location.") && sql.includes("'full_time', 'part_time', 'contract'"), "the database has the location rule and the three job types");
  for (const message of ["Enter the position (job title).", "Choose the employment type.", "Enter the start date.", "The start date must be within the last year or the next two years.",
    "Enter the pay rate as a number, for example 38.50.", "That hourly rate looks too high. Check the pay basis.", "That annual salary looks too low. Check the pay basis.", "Choose the pay schedule.",
    "Enter the hours per week.", "The hours per week must be between 1 and 80."]) assert.ok(sql.includes(message), `the database has the same rule: ${message}`);
});

const PERSON = { firstName: "Asha", lastName: "Patel", email: "asha@example.test", position: "Trainer <Cookery>", employmentType: "part_time", startDate: "2027-02-02", payRate: 42.5,
  payBasis: "hourly", paySchedule: "Fortnightly", payType: "fortnightly", hoursPerWeek: 22.5, companyName: "Skyline Institute of Technology", today: "2026-11-10" };

test("templates: placeholders fill from the person, values are escaped, missing data and unknown placeholders are caught before sending", () => {
  const values = tpl.templateValues(PERSON, { signing_link: "https://x.example/staff/welcome#t=abc" });
  assert.equal(values.full_name, "Asha Patel");
  assert.equal(values.employment_type, "Part time");
  assert.equal(values.start_date, "2 February 2027");
  assert.equal(values.pay_rate, "$42.50");
  assert.equal(values.pay_basis, "per hour");
  assert.equal(values.hours_per_week, "22.5");
  assert.equal(values.today, "10 November 2026");
  assert.equal(tpl.templateValues({ payRate: 85000, payBasis: "salary" }).pay_rate + " " + tpl.templateValues({ payRate: 85000, payBasis: "salary" }).pay_basis, "$85,000.00 per year");
  assert.equal(tpl.templateValues({}).position, "", "nothing is invented for a value the person does not have");
  // The owner's variable names (2026-11-11) resolve from the same record; pay_type is the pay schedule's frequency.
  assert.deepEqual([values.employee_full_name, values.employee_email, values.job_title, values.job_type, values.job_location, values.pay_type, values.today_date],
    ["Asha Patel", "asha@example.test", "Trainer <Cookery>", "Part time", "", "Fortnightly", "10 November 2026"], "employee_*, job_* , pay_type and today_date fill from the record");
  assert.equal(tpl.templateValues({ employmentType: "contract" }).job_type, "Contract");
  assert.equal(tpl.templateValues({ payType: "monthly" }).pay_type, "Monthly");
  assert.equal(tpl.templateValues({ payType: "weekly" }).pay_type, "", "an unknown pay type is empty, so the renderer refuses to send it");
  const owners = tpl.renderMessage({ subject: "Agreement: {{job_title}}", bodyHtml: "<p>{{employee_full_name}} ({{employee_email}}) works {{job_type}} at {{job_location}}, paid {{pay_type}}, from {{start_date}}. Dated {{today_date}}.</p>" }, values);
  assert.deepEqual([owners.missing, owners.unknown], [["job_location"], []], "an empty record value is reported as missing (never sent as raw {{job_location}})");
  assert.ok(owners.html.includes("Asha Patel (asha@example.test) works Part time"), "the rest is filled in");
  for (const key of ["employee_full_name", "employee_email", "job_title", "job_location", "job_type", "pay_type", "today_date"]) assert.ok(tpl.PLACEHOLDERS.some((p) => p.key === key), `{{${key}}} is in the picker`);

  const letter = tpl.renderMessage({ subject: "Offer: {{position}} for {{ full_name }}", bodyHtml: "<p>Dear {{first_name}},</p><p>You start on <strong>{{start_date}}</strong> at {{pay_rate}} {{pay_basis}} ({{pay_schedule}}), {{hours_per_week}} hours. Manager: {{manager_name}}.</p>" }, values);
  assert.deepEqual([letter.missing, letter.unknown], [[], []], "an optional value (the manager) may be empty");
  assert.equal(letter.subject, "Offer: Trainer <Cookery> for Asha Patel", "the subject is plain text");
  assert.ok(letter.html.includes("Dear Asha,") && letter.html.includes("<strong>2 February 2027</strong>") && letter.html.includes("$42.50 per hour (Fortnightly), 22.5 hours"));
  assert.ok(!/\{\{/.test(letter.html), "no placeholder is left");
  // A line that only holds an empty optional detail is left out (no bare "Reporting to:"), together with a list left empty.
  const lines = tpl.renderMessage({ subject: "x", bodyHtml: "<ul><li>Position: {{position}}</li><li>Location: {{work_location}}</li><li>Reporting to: {{manager_name}}</li></ul><p>Department: {{department}}</p><ul><li>{{department}}</li></ul><p>Regards, {{first_name}} {{manager_name}}</p>" }, values);
  assert.equal(lines.html, "<ul><li>Position: Trainer &lt;Cookery&gt;</li></ul><p>Regards, Asha </p>", "empty optional lines and the empty list are gone; a line with something else in it stays");
  assert.deepEqual([lines.missing, lines.unknown], [[], []]);
  const withManager = tpl.renderMessage({ subject: "x", bodyHtml: "<ul><li>Reporting to: {{manager_name}}</li><li>Location: {{work_location}}</li></ul>" }, { ...values, manager_name: "Jordan Lee" });
  assert.equal(withManager.html, "<ul><li>Reporting to: Jordan Lee</li></ul>", "the line is shown for someone who has the detail");
  const escaped = tpl.renderMessage({ subject: "x", bodyHtml: "<p>{{position}}</p>" }, values);
  assert.ok(escaped.html.includes("Trainer &lt;Cookery&gt;") && !escaped.html.includes("<Cookery>"), "a value can never add markup");

  const gaps = tpl.renderMessage({ subject: "Offer", bodyHtml: "<p>{{first_name}} starts as {{position}} on {{start_date}} at {{pay_rate}}. {{bogus}}</p>" }, tpl.templateValues({ firstName: "Asha" }));
  assert.deepEqual(gaps.missing, ["position", "start_date", "pay_rate"], "each placeholder without a value is named");
  assert.deepEqual(gaps.unknown, ["bogus"], "a placeholder that does not exist is named");
  assert.equal(tpl.placeholderLabels(gaps.missing), "Position, Start date, Pay rate");

  const email = tpl.renderMessage({ subject: "Your offer from {{company_name}}", bodyHtml: "<p>Hello {{first_name}},</p><p><a href=\"{{signing_link}}\">Sign in</a></p><ul><li>One</li><li>Two</li></ul>" }, values);
  assert.ok(email.html.includes('<a href="https://x.example/staff/welcome#t=abc">Sign in</a>'), "a link placeholder fills the link");
  assert.equal(email.text, "Hello Asha,\n\nSign in (https://x.example/staff/welcome#t=abc)\n\n- One\n- Two", "the plain-text version carries the link and the list");
  assert.ok(tpl.emailHtmlDocument(email.html).startsWith("<!doctype html>"));
  assert.deepEqual(tpl.templatePlaceholders("{{ a }} {{b}} {{A}}"), ["a", "b"]);
  // The catalogue: link placeholders belong only to the emails that carry that link; every kind lists what it must contain.
  assert.ok(!tpl.placeholdersFor("offer_letter").some((p) => p.key === "signing_link") && tpl.placeholdersFor("offer_email").some((p) => p.key === "signing_link"));
  assert.ok(tpl.placeholdersFor("document_reupload").some((p) => p.key === "rejected_documents") && !tpl.placeholdersFor("document_request").some((p) => p.key === "rejected_documents"));
  for (const key of ["first_name", "full_name", "position", "employment_type", "start_date", "pay_rate", "pay_basis", "pay_schedule", "hours_per_week", "manager_name", "company_name", "today", "signing_link", "login_url"]) {
    assert.ok(tpl.PLACEHOLDERS.some((p) => p.key === key), `{{${key}}} is in the list an Admin inserts from`);
  }
  const sql = read("supabase/migrations/20261111100000_hr_templates.sql") + read("supabase/migrations/20261113090000_hr_locations_job_type_login.sql")
    + read("supabase/migrations/20261124001517_staff_offer_variables.sql");
  for (const t of tpl.TEMPLATE_TYPES) assert.ok(sql.includes(`'${t.type}'`), `the database knows the ${t.type} template`);
  for (const p of tpl.PLACEHOLDERS) assert.ok(sql.includes(`'${p.key}'`), `the database allows {{${p.key}}}`);
});

test("templates: the sanitiser keeps the formatting and drops everything unsafe", () => {
  const clean = tpl.sanitizeTemplateHtml;
  assert.equal(clean('<p onclick="x()">Hi <b>there</b> <i>you</i></p>'), "<p>Hi <strong>there</strong> <em>you</em></p>", "event handlers go, bold and italic stay");
  assert.equal(clean("<p>Before</p><script>alert(1)</script><style>p{}</style><iframe src=x></iframe><p>After</p>"), "<p>Before</p><p>After</p>", "scripts, styles and frames go with their content");
  assert.equal(clean('<a href="javascript:alert(1)">x</a> <a href="https://ok.example/a">y</a> <a href="{{signing_link}}">z</a>'), 'x <a href="https://ok.example/a">y</a> <a href="{{signing_link}}">z</a>', "only http(s), mailto and placeholder links");
  assert.equal(clean('<img src=x onerror="alert(1)"><svg onload=alert(1)></svg>text'), "text");
  assert.equal(clean('<span style="font-weight: bold; color:red">B</span><span style="font-style:italic">I</span>'), "<strong>B</strong><em>I</em>", "styled spans become tags; colours go");
  assert.equal(clean('<div style="text-align:center;font-size:40px">Centre</div>'), '<p style="text-align:center">Centre</p>', "alignment is the only style kept");
  assert.equal(clean("<ul><li>One<li>Two</ul>"), "<ul><li>One</li><li>Two</li></ul>", "the result is well formed");
  assert.equal(clean("<p>Unclosed <strong>bold"), "<p>Unclosed <strong>bold</strong></p>");
  assert.equal(clean("a < b"), "a &lt; b");
  assert.equal(clean("<h1>T</h1><h6>S</h6><blockquote><p>Q</p></blockquote><hr>"), "<h1>T</h1><h4>S</h4><blockquote><p>Q</p></blockquote><hr>");
  // Rendering sanitises again: a template stored before a rule changed still comes out clean.
  assert.ok(!tpl.renderMessage({ subject: "s", bodyHtml: "<p>Hi</p><script>bad()</script>" }, {}).html.includes("script"));
});

test("offer letter PDF: made from the filled-in template, loadable, signable, and it refuses an empty or endless letter", async () => {
  const html = tpl.renderMessage({ subject: "Offer of employment", bodyHtml: "<h2>Offer: {{position}}</h2><p>Dear {{first_name}}, “welcome” — 日本</p><ul><li>Start: {{start_date}}</li><li>Pay: <strong>{{pay_rate}}</strong> {{pay_basis}}</li></ul><p style=\"text-align:center\"><em>Yours</em> <u>sincerely</u></p>" },
    tpl.templateValues(PERSON)).html;
  const made = await letterLib.buildLetterPdf({ title: "Offer of employment", html, footer: "Skyline Institute of Technology", date: "2026-11-10" });
  assert.equal(new TextDecoder().decode(made.bytes.subarray(0, 5)), "%PDF-");
  assert.equal(made.pages, 1);
  const inspected = await offerPdf.inspectOfferPdf(made.bytes);
  assert.deepEqual(inspected, { ok: true, pages: 1 }, "it passes the same checks as an uploaded offer");
  const letterhead = { institution: "Skyline Institute of Technology", logo: null, primary: "#1d4ed8" };
  const signed = await offerPdf.stampSignedOffer(made.bytes, { signerName: "Asha Patel", signedAt: "2026-11-10T00:00:00Z", ip: null, userAgent: null, consent: offerPdf.OFFER_CONSENT, offerFilename: "offer.pdf", offerSha256: "a".repeat(64) }, letterhead);
  const signedDoc = await PdfLib.PDFDocument.load(signed);
  assert.equal(signedDoc.getPageCount(), 2, "the signature page is added to the generated letter");
  assert.equal(signedDoc.getTitle(), "Offer of employment", "the letter's own metadata is kept");
  // One styling for every Skyline PDF: the letter, its signature page and the submitted application are all A4 in the embedded Noto Sans.
  const application = await submissionLib.buildSubmissionPdf({ reference: "SK-1", institution: "Skyline Institute of Technology", version: 1, submittedAt: "2026-11-10T00:00:00Z", snapshot: { values: { first_name: "Ada" } } });
  for (const [name, bytes] of [["offer letter", made.bytes], ["signed offer", signed], ["application", application]] as const) {
    const fonts = await pdfFonts(bytes);
    assert.ok(fonts.length >= 1 && fonts.every((page) => page.length >= 1 && page.every((f) => /NotoSans/.test(f))), `${name}: Noto Sans on every page (${JSON.stringify(fonts)})`);
    const doc = await PdfLib.PDFDocument.load(bytes);
    assert.ok(doc.getPages().every((p) => p.getWidth() === 595.28 && p.getHeight() === 841.89), `${name}: A4`);
  }
  const branded = await letterLib.buildLetterPdf({ title: "Offer of employment", html, letterhead: { institution: "Another College", logo: null, primary: "#1d4ed8" } });
  assert.equal(branded.pages, 1, "the letterhead's name and colour are drawn in place of the defaults");
  assert.deepEqual(letterLib.paletteOf("#1d4ed8").primary.map((v) => Math.round(v * 255)), [29, 78, 216], "the letterhead colour becomes the writer's palette");
  assert.deepEqual([letterLib.paletteOf(null).primary.map((v) => Math.round(v * 255)), submissionLib.resolvePrimary(null).fellBack], [submissionLib.resolvePrimary(null).rgb.map((v) => Math.round(v)), true], "no colour set: the same default as the application PDF (the Skyline orange, darkened to read on white)");
  const long = await letterLib.buildLetterPdf({ title: "Long", html: "<p>Line of text for the letter.</p>".repeat(140) });
  assert.ok(long.pages >= 3, "a long letter flows onto more pages");
  await assert.rejects(letterLib.buildLetterPdf({ title: "Empty", html: "<p> </p>" }), /empty/);
  await assert.rejects(letterLib.buildLetterPdf({ title: "Endless", html: "<p>Line</p>".repeat(3000) }), /longer than/);
  assert.equal(letterLib.letterFileName("Offer: Trainer/Chef", "Asha Patel"), "Offer Trainer Chef - Asha Patel.pdf");
  assert.equal(await letterLib.unsupportedText(["Asha Patel", "Offer of employment"]), null, "Latin text prints as typed");
  assert.equal(await letterLib.unsupportedText(["Asha Patel", "नमस्ते"]), "नमस्ते", "text the font cannot set is reported, not altered");
});

/** adminDeps plus what the onboarding-flow actions use; `calls` records every call so a test can prove what did NOT happen. */
function flowDeps(options: Parameters<typeof adminDeps>[0] & { template?: Record<string, { name: string; subject: string; bodyHtml: string } | null>; person?: Record<string, unknown>; mail?: "sent" | "failed" | "skipped"; createError?: string } = {}) {
  const base = adminDeps(options);
  const sent: Array<{ to: string; message: { subject: string; text: string; html?: string }; deliveryId: string }> = [];
  const deps = {
    ...base.deps,
    templateMail: async (profileId: string, type: string, templateId?: string | null) => {
      base.calls.push(["templateMail", { profileId, type, templateId: templateId ?? null }]);
      const t = options.template?.[type];
      return { template: t ? { id: "tpl-1", ...t } : null, values: options.person ?? PERSON };
    },
    sendTemplate: async (mail: { to: string; message: { subject: string; text: string; html?: string }; deliveryId: string }) => {
      sent.push(mail);
      return options.mail === "failed" ? { state: "failed" as const, error: "inactive_recipient" } : options.mail === "skipped" ? { state: "skipped" as const, error: "off" } : { state: "sent" as const, messageId: "m-9" };
    },
    accountUrl: (token: string) => `https://x.example/staff/welcome#t=${token}`,
    createLogin: async (email: string, name: string) => { base.calls.push(["createLogin", { email, name }]); return options.createError ? { userId: null, error: options.createError } : { userId: "made-login", error: null }; },
    deleteLogin: async (userId: string) => { base.calls.push(["deleteLogin", userId]); },
    letterPdf: async (input: { title: string; html: string; footer: string }) => { base.calls.push(["letterPdf", input]); return { bytes: new Uint8Array([37, 80, 68, 70, 45, 1, 2, 3]), pages: 2 }; },
    unsupportedText: async (texts: string[]) => { base.calls.push(["unsupportedText", texts]); return texts.find((t) => /[^\u0000-\u024F\u2010-\u2027\u20AC]/.test(t)) ?? null; },
  };
  return { ...base, deps, sent };
}
const TEMPLATE_ID = "0b7b1c1e-0000-4000-8000-0000000000dd";
const LETTER_CONTEXT = { status: "documents_submitted", problem: null, values: PERSON, templates: [
  { id: TEMPLATE_ID, type: "offer_letter", name: "Standard offer letter", subject: "Offer of employment: {{position}}", bodyHtml: "<p>Dear {{first_name}}, you start on {{start_date}} at {{pay_rate}} {{pay_basis}}.</p>" }] };

test("staff-admin offer_generate: fills the template, refuses missing data before anything is stored, records the PDF with the rendered letter", async () => {
  const ok = flowDeps({ db: { hr_admin_offer_letter_context: { data: LETTER_CONTEXT }, hr_admin_offer_letter_add: { data: { offer: { id: "o-1" }, replacedPath: `${PROFILE}/offer/old.pdf` } } } });
  const made = await staffAdmin.handleAdmin({ action: "offer_generate", profileId: PROFILE, templateId: TEMPLATE_ID }, ok.deps as never);
  assert.equal(made.status, 200);
  assert.deepEqual([made.body.pages, made.body.title, made.body.templateName], [2, "Offer of employment: Trainer <Cookery>", "Standard offer letter"]);
  const added = ok.calls.find(([n]) => n === "admin:hr_admin_offer_letter_add")![1] as Record<string, unknown>;
  assert.equal(added.p_template, TEMPLATE_ID);
  assert.equal(added.p_path, `${PROFILE}/offer/rnd.pdf`, "stored in the person's own offer folder");
  assert.equal(added.p_html, "<p>Dear Asha, you start on 2 February 2027 at $42.50 per hour.</p>", "the exact rendered letter is saved with the offer");
  assert.equal((added.p_values as Record<string, string>).start_date, "2 February 2027", "...with the values it was filled with");
  assert.equal(added.p_filename, "Offer of employment Trainer Cookery - Asha Patel.pdf");
  assert.deepEqual(ok.calls.find(([n]) => n === "remove")![1], [`${PROFILE}/offer/old.pdf`], "an unsent letter it replaces is deleted");
  assert.ok(ok.names().indexOf("admin:hr_admin_offer_letter_context") < ok.names().indexOf("upload"), "admin and state are checked before anything is stored");

  const missing = flowDeps({ db: { hr_admin_offer_letter_context: { data: { ...LETTER_CONTEXT, values: { firstName: "Asha" } } } } });
  const refused = await staffAdmin.handleAdmin({ action: "offer_generate", profileId: PROFILE, templateId: TEMPLATE_ID }, missing.deps as never);
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body.missing, ["position", "start_date", "pay_rate", "pay_basis"], "missing data is named");
  assert.match(String(refused.body.error), /Position, Start date, Pay rate, Pay basis have no value/);
  assert.ok(!missing.names().includes("letterPdf") && !missing.names().includes("upload"), "nothing is made or stored");

  const blocked = flowDeps({ db: { hr_admin_offer_letter_context: { data: { ...LETTER_CONTEXT, problem: "Add the pay details first." } } } });
  assert.deepEqual((await staffAdmin.handleAdmin({ action: "offer_generate", profileId: PROFILE, templateId: TEMPLATE_ID }, blocked.deps as never)).body, { error: "Add the pay details first." }, "no letter before the pay details");
  const notAdmin = flowDeps({ db: { hr_admin_offer_letter_context: { error: { code: "42501", message: "Only an administrator can do this." } } } });
  assert.equal((await staffAdmin.handleAdmin({ action: "offer_generate", profileId: PROFILE, templateId: TEMPLATE_ID }, notAdmin.deps as never)).status, 403);
  const dbRefuses = flowDeps({ db: { hr_admin_offer_letter_context: { data: LETTER_CONTEXT }, hr_admin_offer_letter_add: { error: { code: "23514", message: "Upload an offer once the documents are submitted (withdraw a sent offer first)." } } } });
  assert.equal((await staffAdmin.handleAdmin({ action: "offer_generate", profileId: PROFILE, templateId: TEMPLATE_ID }, dbRefuses.deps as never)).status, 400);
  assert.deepEqual(dbRefuses.calls.find(([n]) => n === "remove")![1], [`${PROFILE}/offer/rnd.pdf`], "a refused record removes the stored file");
  assert.equal((await staffAdmin.handleAdmin({ action: "offer_generate", profileId: PROFILE, templateId: "nope" }, ok.deps as never)).status, 400);
});

test("staff-admin offer_preview and edited letters: the preview is the letter that is sent; edits change this copy only; unprintable text is refused before anything is made", async () => {
  // Preview: the same letter the generate step makes (same title, html and footer go to the PDF builder); nothing is stored.
  const previewed = flowDeps({ db: { hr_admin_offer_letter_context: { data: LETTER_CONTEXT } } });
  const p = await staffAdmin.handleAdmin({ action: "offer_preview", profileId: PROFILE, templateId: TEMPLATE_ID }, previewed.deps as never);
  assert.equal(p.status, 200);
  assert.deepEqual([p.body.pages, p.body.title, p.body.edited, p.body.templateName], [2, "Offer of employment: Trainer <Cookery>", false, "Standard offer letter"]);
  assert.equal(p.body.pdfBase64, Buffer.from([37, 80, 68, 70, 45, 1, 2, 3]).toString("base64"), "the PDF bytes come back for the iframe");
  assert.ok(!previewed.names().includes("upload") && !previewed.names().includes("admin:hr_admin_offer_letter_add"), "a preview stores nothing");
  const generated = flowDeps({ db: { hr_admin_offer_letter_context: { data: LETTER_CONTEXT }, hr_admin_offer_letter_add: { data: { offer: { id: "o-1" } } } } });
  await staffAdmin.handleAdmin({ action: "offer_generate", profileId: PROFILE, templateId: TEMPLATE_ID }, generated.deps as never);
  assert.deepEqual(previewed.calls.find(([n]) => n === "letterPdf")![1], generated.calls.find(([n]) => n === "letterPdf")![1], "preview = final: the PDF builder gets exactly the same input");
  const recorded = generated.calls.find(([n]) => n === "admin:hr_admin_offer_letter_add")![1] as Record<string, unknown>;
  assert.deepEqual([recorded.p_edited, recorded.p_template_html], [false, null], "an unedited letter is recorded as the template's render");

  // Edited for this copy: sanitised, stored with the template's own render, the template itself untouched (no template_save call).
  const html = "<p>Dear Asha, you start on 2 February 2027 at $42.50 per hour.</p><p>We also cover your <strong>relocation</strong>.</p><script>alert(1)</script>";
  const edited = flowDeps({ db: { hr_admin_offer_letter_context: { data: LETTER_CONTEXT }, hr_admin_offer_letter_add: { data: { offer: { id: "o-2" } } } } });
  const e = await staffAdmin.handleAdmin({ action: "offer_generate", profileId: PROFILE, templateId: TEMPLATE_ID, html }, edited.deps as never);
  assert.equal(e.status, 200);
  assert.equal(e.body.edited, true);
  const added = edited.calls.find(([n]) => n === "admin:hr_admin_offer_letter_add")![1] as Record<string, unknown>;
  assert.equal(added.p_html, "<p>Dear Asha, you start on 2 February 2027 at $42.50 per hour.</p><p>We also cover your <strong>relocation</strong>.</p>", "the edited text is sanitised and is what the PDF is made from");
  assert.deepEqual([added.p_edited, added.p_template_html], [true, "<p>Dear Asha, you start on 2 February 2027 at $42.50 per hour.</p>"], "the template's render is kept beside the edited copy");
  assert.deepEqual((edited.calls.find(([n]) => n === "letterPdf")![1] as { html: string }).html, added.p_html, "the PDF is the edited letter");
  assert.ok(!edited.names().some((n) => /template_save/.test(n)), "the saved template is not changed by a per-letter edit");
  const previewEdited = flowDeps({ db: { hr_admin_offer_letter_context: { data: LETTER_CONTEXT } } });
  const pe = await staffAdmin.handleAdmin({ action: "offer_preview", profileId: PROFILE, templateId: TEMPLATE_ID, html }, previewEdited.deps as never);
  assert.deepEqual([pe.body.edited, pe.body.html], [true, added.p_html], "the preview of an edited letter shows the edited copy");
  const same = flowDeps({ db: { hr_admin_offer_letter_context: { data: LETTER_CONTEXT }, hr_admin_offer_letter_add: { data: { offer: { id: "o-3" } } } } });
  await staffAdmin.handleAdmin({ action: "offer_generate", profileId: PROFILE, templateId: TEMPLATE_ID, html: "<p>Dear Asha, you start on 2 February 2027 at $42.50 per hour.</p>" }, same.deps as never);
  assert.equal((same.calls.find(([n]) => n === "admin:hr_admin_offer_letter_add")![1] as Record<string, unknown>).p_edited, false, "text identical to the template's render is not an edit");

  // A placeholder left in the edited text, or text the PDF font cannot print, stops before anything is made or stored.
  const left = flowDeps({ db: { hr_admin_offer_letter_context: { data: LETTER_CONTEXT } } });
  const l = await staffAdmin.handleAdmin({ action: "offer_preview", profileId: PROFILE, templateId: TEMPLATE_ID, html: "<p>Dear {{first_name}}, {{bonus}}</p>" }, left.deps as never);
  assert.deepEqual([l.status, l.body.missing], [400, ["first_name", "bonus"]]);
  assert.match(String(l.body.error), /still has \{\{first_name\}\}, \{\{bonus\}\}/);
  const glyphs = flowDeps({ db: { hr_admin_offer_letter_context: { data: LETTER_CONTEXT } } });
  const g = await staffAdmin.handleAdmin({ action: "offer_generate", profileId: PROFILE, templateId: TEMPLATE_ID, html: "<p>Dear Asha, नमस्ते.</p>" }, glyphs.deps as never);
  assert.deepEqual([g.status, g.body.code, g.body.unsupported], [400, "unsupported_text", "Dear Asha, नमस्ते."]);
  assert.match(String(g.body.error), /cannot be printed in the PDF/);
  assert.ok(!glyphs.names().includes("letterPdf") && !glyphs.names().includes("upload"), "nothing is made or stored");
});

const EMPLOYEE_ACTIVE = { id: PROFILE, status: "active", email: "asha@example.test", firstName: "Asha", lastName: "Patel", hasLogin: false, passwordSet: false };
const LOGIN_LINKED = { profileId: PROFILE, email: "asha@example.test", name: "Asha Patel", needsPassword: true, expiresAt: "2026-11-18T00:00:00Z", invite: { id: "inv-login" } };
test("staff-admin invite_login: an existing (Active) employee gets one email with a one-time set-password link; the login is linked to them; no password anywhere", async () => {
  const d = flowDeps({ db: { hr_admin_emp_get: { data: EMPLOYEE_ACTIVE }, hr_admin_emp_login_invite: { data: LOGIN_LINKED } } });
  const r = await staffAdmin.handleAdmin({ action: "invite_login", profileId: PROFILE }, d.deps as never);
  assert.deepEqual([r.status, r.body.emailSent, r.body.needsPassword, r.body.expiresAt], [200, true, true, "2026-11-18T00:00:00Z"]);
  assert.deepEqual(d.calls.find(([n]) => n === "createLogin")![1], { email: "asha@example.test", name: "Asha Patel" }, "a login is created when the person has none");
  assert.deepEqual(d.calls.find(([n]) => n === "admin:hr_admin_emp_login_invite")![1], { p_id: PROFILE, p_auth_user_id: "made-login", p_account_hash: "h".repeat(64) }, "the database links the login and gets only the HASH of the link");
  const link = `https://x.example/staff/welcome#t=${"T".repeat(43)}`;
  assert.equal(d.sent.length, 1);
  assert.ok(d.sent[0].message.text.includes(link) && d.sent[0].message.text.includes("until 18 November 2026"), "one email carries the personal link and its expiry");
  assert.equal((d.calls.find(([n]) => n === "svc:hr_svc_email_log")![1] as Record<string, unknown>).p_kind, "login_link");
  assert.ok(!JSON.stringify(d.calls).includes("T".repeat(43)) && !JSON.stringify(r.body).includes("T".repeat(43)), "the token is never stored, logged or shown when the email went out");
  assert.ok(!/password\s*(is|:)/i.test(d.sent[0].message.text), "no password is sent: only a link to choose one");

  // Only an active employee without a chosen password; people being onboarded get their link with the offer.
  const invited = flowDeps({ db: { hr_admin_emp_get: { data: { ...EMPLOYEE_ACTIVE, status: "invited" } } } });
  const i = await staffAdmin.handleAdmin({ action: "invite_login", profileId: PROFILE }, invited.deps as never);
  assert.equal(i.status, 400); assert.match(String(i.body.error), /active employee/); assert.ok(!invited.names().includes("createLogin"));
  const done = flowDeps({ db: { hr_admin_emp_get: { data: { ...EMPLOYEE_ACTIVE, hasLogin: true, passwordSet: true } } } });
  assert.match(String((await staffAdmin.handleAdmin({ action: "invite_login", profileId: PROFILE }, done.deps as never)).body.error), /already chosen a password/);

  // A login they already use (an administrator, agent or student): linked, no new login, the email points at the login page.
  const existing = flowDeps({ login: { id: "their-login", confirmed: true, invited: false, signedIn: true },
    db: { hr_admin_emp_get: { data: EMPLOYEE_ACTIVE }, hr_admin_emp_login_invite: { data: { ...LOGIN_LINKED, needsPassword: false, expiresAt: null, invite: null } } } });
  const x = await staffAdmin.handleAdmin({ action: "invite_login", profileId: PROFILE }, existing.deps as never);
  assert.deepEqual([x.status, x.body.needsPassword], [200, false]);
  assert.ok(!existing.names().includes("createLogin"));
  assert.equal((existing.calls.find(([n]) => n === "admin:hr_admin_emp_login_invite")![1] as Record<string, unknown>).p_account_hash, null);
  assert.ok(existing.sent[0].message.text.includes("https://x.example/login?next=%2Fstaff"));

  // Email switched off: the link is handed to the admin once. A failed email cancels the link.
  const off = flowDeps({ mail: "skipped", db: { hr_admin_emp_get: { data: EMPLOYEE_ACTIVE }, hr_admin_emp_login_invite: { data: LOGIN_LINKED } } });
  const o = await staffAdmin.handleAdmin({ action: "invite_login", profileId: PROFILE }, off.deps as never);
  assert.deepEqual([o.status, o.body.emailSent, o.body.link], [200, false, link]);
  const failed = flowDeps({ mail: "failed", db: { hr_admin_emp_get: { data: EMPLOYEE_ACTIVE }, hr_admin_emp_login_invite: { data: LOGIN_LINKED } } });
  const f = await staffAdmin.handleAdmin({ action: "invite_login", profileId: PROFILE }, failed.deps as never);
  assert.equal(f.status, 502);
  assert.deepEqual(failed.calls.find(([n]) => n === "admin:hr_admin_staff_invite_cancel")![1], { p_id: PROFILE, p_invite: "inv-login" }, "the link that nobody received is cancelled");
});

test("punch times across the Melbourne daylight-saving changes: a 22:00 to 06:00 shift is 7 hours when clocks go forward and 9 when they go back", async () => {
  const hrTime = await load.import<typeof import("../src/lib/hrTime.ts")>("../src/lib/hrTime.ts");
  const minutes = (from: string, to: string) => (Date.parse(hrTime.zonedToInstant(to)) - Date.parse(hrTime.zonedToInstant(from))) / 60000;
  assert.equal(minutes("2026-10-03T22:00", "2026-10-04T06:00"), 420, "DST starts 2026-10-04 02:00: the night loses an hour");
  assert.equal(minutes("2027-04-03T22:00", "2027-04-04T06:00"), 540, "DST ends 2027-04-04 03:00: the night gains an hour");
  assert.equal(minutes("2026-11-10T09:00", "2026-11-10T17:30"), 510, "an ordinary day is unchanged");
  assert.equal(hrTime.instantToZoned(hrTime.zonedToInstant("2026-10-04T02:30")), "2026-10-04T03:30", "a wall-clock time that does not exist on the spring-forward night moves forward an hour, never to a different day");
  assert.equal(hrTime.instantToZoned(hrTime.zonedToInstant("2027-04-04T02:30")).slice(0, 16), "2027-04-04T02:30", "a repeated autumn hour round-trips to the same wall-clock time");
  assert.deepEqual([hrTime.tzAbbrev("2026-10-03T12:00:00Z"), hrTime.tzAbbrev("2026-10-04T12:00:00Z")], ["AEST", "AEDT"], "the label follows the zone (the database stores instants; hr.local_date decides the work day)");
});

const DETAIL_READY = { profile: { status: "documents_submitted", email: "asha@example.test", first_name: "Asha", last_name: "Patel" } };
const OFFER_EMAIL = { name: "Standard offer email", subject: "Your offer letter from {{company_name}}", bodyHtml: "<p>Hello {{first_name}},</p><p>Your offer for {{position}}: <a href=\"{{signing_link}}\">{{signing_link}}</a> (until {{link_expiry}})</p>" };
const SENT_FIRST = { firstSend: true, needsPassword: true, expiresAt: "2026-11-17T00:00:00Z", invite: { id: "inv-acct" }, offer: { id: "o-1" } };

test("staff-admin offer_send_login: one email with a one-time set-password link; no password anywhere", async () => {
  const d = flowDeps({ template: { offer_email: OFFER_EMAIL }, db: { hr_admin_staff_detail: { data: DETAIL_READY }, hr_admin_onboarding_offer_send: { data: SENT_FIRST } } });
  const r = await staffAdmin.handleAdmin({ action: "offer_send_login", profileId: PROFILE }, d.deps as never);
  assert.deepEqual([r.status, r.body.emailSent, r.body.needsPassword, r.body.firstSend], [200, true, true, true]);
  assert.deepEqual(d.calls.find(([n]) => n === "createLogin")![1], { email: "asha@example.test", name: "Asha Patel" }, "a login is created when the person has none");
  const sentArgs = d.calls.find(([n]) => n === "admin:hr_admin_onboarding_offer_send")![1] as Record<string, unknown>;
  assert.deepEqual(sentArgs, { p_id: PROFILE, p_auth_user_id: "made-login", p_account_hash: "h".repeat(64) }, "the database gets the login and only the HASH of the link");
  assert.equal(d.sent.length, 1, "one email");
  assert.equal(d.sent[0].to, "asha@example.test");
  assert.equal(d.sent[0].message.subject, "Your offer letter from Skyline Institute of Technology");
  const link = `https://x.example/staff/welcome#t=${"T".repeat(43)}`;
  assert.ok(d.sent[0].message.text.includes(link) && d.sent[0].message.html!.includes(link), "the email carries the personal link");
  assert.ok(d.sent[0].message.text.includes("until 17 November 2026"), "...and says when it expires (7 days)");
  const logged = d.calls.find(([n]) => n === "svc:hr_svc_email_log")![1] as Record<string, unknown>;
  assert.equal(logged.p_kind, "offer");
  assert.ok(!JSON.stringify(d.calls).includes("T".repeat(43)), "the token is never stored or logged");
  assert.ok(!/"(p_)?(temp(orary)?_?)?password"\s*:/i.test(JSON.stringify(d.calls)) && !/password\s*(is|:)/i.test(d.sent[0].message.text), "no password is generated, stored or sent: only a link to choose one");
  assert.ok(!JSON.stringify(r.body).includes("T".repeat(43)), "the admin does not get the link when the email went out");
  assert.ok(d.names().indexOf("templateMail") < d.names().indexOf("createLogin"), "the email template is checked before a login is made");

  // A login the person already uses (a student or agent): no new login, no link; they sign in with their own password.
  const existing = flowDeps({ template: { offer_email: OFFER_EMAIL }, login: { id: "their-login", confirmed: true, invited: false, signedIn: true },
    db: { hr_admin_staff_detail: { data: DETAIL_READY }, hr_admin_onboarding_offer_send: { data: { ...SENT_FIRST, needsPassword: false, expiresAt: null, invite: null } } } });
  const e = await staffAdmin.handleAdmin({ action: "offer_send_login", profileId: PROFILE }, existing.deps as never);
  assert.deepEqual([e.status, e.body.needsPassword], [200, false]);
  assert.ok(!existing.names().includes("createLogin"));
  assert.deepEqual((existing.calls.find(([n]) => n === "admin:hr_admin_onboarding_offer_send")![1] as Record<string, unknown>).p_account_hash, null);
  assert.ok(existing.sent[0].message.text.includes("https://x.example/login?next=%2Fstaff"), "the email points at the login page");

  // Email switched off: the link is handed to the admin once.
  const off = flowDeps({ mail: "skipped", template: { offer_email: OFFER_EMAIL }, db: { hr_admin_staff_detail: { data: DETAIL_READY }, hr_admin_onboarding_offer_send: { data: SENT_FIRST } } });
  const o = await staffAdmin.handleAdmin({ action: "offer_send_login", profileId: PROFILE }, off.deps as never);
  assert.deepEqual([o.status, o.body.emailSent, o.body.link], [200, false, link]);

  // No template of that kind: the built-in text is used, still with the link.
  const builtIn = flowDeps({ db: { hr_admin_staff_detail: { data: DETAIL_READY }, hr_admin_onboarding_offer_send: { data: SENT_FIRST } } });
  assert.equal((await staffAdmin.handleAdmin({ action: "offer_send_login", profileId: PROFILE }, builtIn.deps as never)).status, 200);
  assert.ok(builtIn.sent[0].message.text.includes(link) && builtIn.sent[0].message.html === undefined);
});

test("staff-admin offer_send_login: a failed email undoes everything; a refusal leaves no half-made login", async () => {
  // First send, email fails: offer unsent, links revoked, person unlinked, and the login this request made is deleted.
  const failed = flowDeps({ mail: "failed", template: { offer_email: OFFER_EMAIL }, db: { hr_admin_staff_detail: { data: DETAIL_READY }, hr_admin_onboarding_offer_send: { data: SENT_FIRST } } });
  const r = await staffAdmin.handleAdmin({ action: "offer_send_login", profileId: PROFILE }, failed.deps as never);
  assert.deepEqual([r.status, r.body.emailSent, r.body.rolledBack], [502, false, true]);
  assert.match(String(r.body.error), /could not be sent \(inactive_recipient\)\. Nothing went out and nothing was changed/);
  assert.deepEqual(failed.calls.find(([n]) => n === "admin:hr_admin_onboarding_offer_unsend")![1], { p_id: PROFILE, p_unlink: true });
  assert.deepEqual(failed.calls.find(([n]) => n === "deleteLogin")![1], "made-login", "no half-created account is left");
  assert.equal((failed.calls.find(([n]) => n === "svc:hr_svc_email_log")![1] as Record<string, unknown>).p_state, "failed", "the failure is logged for the admin");

  // The same failure for a login that already existed: undone, but that login is NOT deleted.
  const kept = flowDeps({ mail: "failed", template: { offer_email: OFFER_EMAIL }, login: { id: "their-login", confirmed: false, invited: true, signedIn: false },
    db: { hr_admin_staff_detail: { data: DETAIL_READY }, hr_admin_onboarding_offer_send: { data: SENT_FIRST } } });
  await staffAdmin.handleAdmin({ action: "offer_send_login", profileId: PROFILE }, kept.deps as never);
  assert.deepEqual(kept.calls.find(([n]) => n === "admin:hr_admin_onboarding_offer_unsend")![1], { p_id: PROFILE, p_unlink: false });
  assert.ok(!kept.names().includes("deleteLogin"));

  // The database refuses (for example no pay details): the login made a moment ago is removed and nothing is sent.
  const refused = flowDeps({ template: { offer_email: OFFER_EMAIL }, db: { hr_admin_staff_detail: { data: DETAIL_READY }, hr_admin_onboarding_offer_send: { error: { code: "23514", message: "An offer cannot be sent yet. Add the pay details first." } } } });
  const x = await staffAdmin.handleAdmin({ action: "offer_send_login", profileId: PROFILE }, refused.deps as never);
  assert.deepEqual([x.status, x.body.error], [400, "An offer cannot be sent yet. Add the pay details first."]);
  assert.ok(refused.names().includes("deleteLogin") && refused.sent.length === 0);

  // The email template cannot be filled: stopped before a login exists.
  const gap = flowDeps({ person: { firstName: "Asha" }, template: { offer_email: OFFER_EMAIL }, db: { hr_admin_staff_detail: { data: DETAIL_READY } } });
  const g = await staffAdmin.handleAdmin({ action: "offer_send_login", profileId: PROFILE }, gap.deps as never);
  assert.equal(g.status, 400);
  assert.match(String(g.body.error), /needs Position, which this person does not have yet.*Nothing was sent/);
  assert.ok(!gap.names().includes("createLogin") && !gap.names().includes("admin:hr_admin_onboarding_offer_send"));

  // The login cannot be created: nothing else happens.
  const noLogin = flowDeps({ createError: "rate limited", template: { offer_email: OFFER_EMAIL }, db: { hr_admin_staff_detail: { data: DETAIL_READY } } });
  assert.equal((await staffAdmin.handleAdmin({ action: "offer_send_login", profileId: PROFILE }, noLogin.deps as never)).status, 502);
  assert.ok(!noLogin.names().includes("admin:hr_admin_onboarding_offer_send"));

  // A resend whose email fails: the offer stays out; only the new link is cancelled.
  const resend = flowDeps({ mail: "failed", template: { offer_email: OFFER_EMAIL }, login: { id: "their-login", confirmed: false, invited: false, signedIn: false },
    db: { hr_admin_staff_detail: { data: { profile: { ...DETAIL_READY.profile, status: "offer_sent" } } }, hr_admin_onboarding_offer_send: { data: { ...SENT_FIRST, firstSend: false } } } });
  const z = await staffAdmin.handleAdmin({ action: "offer_send_login", profileId: PROFILE }, resend.deps as never);
  assert.equal(z.status, 502);
  assert.ok(!resend.names().includes("admin:hr_admin_onboarding_offer_unsend"), "an offer that is out is never silently unsent");
  assert.deepEqual(resend.calls.find(([n]) => n === "admin:hr_admin_staff_invite_cancel")![1], { p_id: PROFILE, p_invite: "inv-acct" });

  const wrongStage = flowDeps({ db: { hr_admin_staff_detail: { data: { profile: { ...DETAIL_READY.profile, status: "active" } } } } });
  assert.equal((await staffAdmin.handleAdmin({ action: "offer_send_login", profileId: PROFILE }, wrongStage.deps as never)).status, 400);
  const notAdmin = flowDeps({ db: { hr_admin_staff_detail: { error: { code: "42501", message: "Only an administrator can do this." } } } });
  assert.equal((await staffAdmin.handleAdmin({ action: "offer_send_login", profileId: PROFILE }, notAdmin.deps as never)).status, 403);
});

test("staff-admin resend_login and send_documents: a new one-time link; document emails use the HRMS template", async () => {
  const resend = flowDeps({ template: { welcome_login: { name: "Welcome", subject: "Your sign-in", bodyHtml: "<p>{{first_name}}: {{signing_link}} until {{link_expiry}}</p>" } },
    db: { hr_admin_onboarding_login_resend: { data: { email: "asha@example.test", expiresAt: "2026-11-17T00:00:00Z", invite: { id: "inv-2" } } } } });
  const r = await staffAdmin.handleAdmin({ action: "resend_login", profileId: PROFILE }, resend.deps as never);
  assert.deepEqual([r.status, r.body.emailSent], [200, true]);
  assert.deepEqual(resend.calls.find(([n]) => n === "admin:hr_admin_onboarding_login_resend")![1], { p_id: PROFILE, p_account_hash: "h".repeat(64) });
  assert.ok(resend.sent[0].message.text.includes(`https://x.example/staff/welcome#t=${"T".repeat(43)}`) && resend.sent[0].message.text.includes("17 November 2026"));
  assert.equal((resend.calls.find(([n]) => n === "svc:hr_svc_email_log")![1] as Record<string, unknown>).p_kind, "login_link");
  const failed = flowDeps({ mail: "failed", db: { hr_admin_onboarding_login_resend: { data: { email: "asha@example.test", expiresAt: "2026-11-17T00:00:00Z", invite: { id: "inv-2" } } } } });
  assert.equal((await staffAdmin.handleAdmin({ action: "resend_login", profileId: PROFILE }, failed.deps as never)).status, 502);
  assert.deepEqual(failed.calls.find(([n]) => n === "admin:hr_admin_staff_invite_cancel")![1], { p_id: PROFILE, p_invite: "inv-2" }, "a link nobody received is cancelled");
  const chosen = flowDeps({ db: { hr_admin_onboarding_login_resend: { error: { code: "23514", message: "This person has already chosen a password." } } } });
  assert.equal((await staffAdmin.handleAdmin({ action: "resend_login", profileId: PROFILE }, chosen.deps as never)).status, 400);
  assert.equal(chosen.sent.length, 0);

  // Send document link from the employee page: the database decides (hire the job application, or the plain link).
  const invite = { invite: { id: "inv-1", expiresAt: "2026-11-24T00:00:00Z" }, email: "asha@example.test", name: "Asha Patel", rejected: [], profileId: PROFILE };
  const docs = flowDeps({ template: { document_request: { name: "Docs", subject: "Documents for {{company_name}}", bodyHtml: "<p>Hi {{first_name}}, <a href=\"{{document_link}}\">upload here</a> by {{link_expiry}}.</p>" } },
    db: { hr_admin_onboarding_documents_invite: { data: invite } } });
  const s = await staffAdmin.handleAdmin({ action: "send_documents", profileId: PROFILE }, docs.deps as never);
  assert.deepEqual([s.status, s.body.emailSent], [200, true]);
  assert.deepEqual(docs.calls.find(([n]) => n === "admin:hr_admin_onboarding_documents_invite")![1], { p_id: PROFILE, p_token_hash: "h".repeat(64) });
  const rendered = (docs.mails[0] as { rendered: { subject: string; text: string } }).rendered;
  assert.equal(rendered.subject, "Documents for Skyline Institute of Technology", "the document email is the Admin's template");
  assert.ok(rendered.text.includes(`https://x.example/staff/onboard#t=${"T".repeat(43)}`) && rendered.text.includes("24 November 2026"));
  // A template that cannot be filled is not sent: the link is cancelled, like any failed email.
  const broken = flowDeps({ person: { lastName: "Patel" }, template: { document_request: { name: "Docs", subject: "Hi", bodyHtml: "<p>{{first_name}} {{document_link}}</p>" } }, db: { hr_admin_onboarding_documents_invite: { data: invite } } });
  const b = await staffAdmin.handleAdmin({ action: "send_documents", profileId: PROFILE }, broken.deps as never);
  assert.equal(b.status, 502);
  assert.match(String(b.body.error), /"Docs" template needs First name/);
  assert.equal(broken.mails.length, 0);
  assert.ok(broken.names().includes("admin:hr_admin_staff_invite_cancel"));
  // The re-upload email lists each rejected document with its reason.
  const again = flowDeps({ template: { document_reupload: { name: "Again", subject: "Again", bodyHtml: "<p>{{rejected_documents}}</p><p>{{document_link}}</p>" } },
    db: { hr_admin_staff_invite: { data: { ...invite, rejected: [{ category: "Passport", note: "Photo page cut off" }, { category: "Visa", note: "Expired" }] } } } });
  await staffAdmin.handleAdmin({ action: "send_invite", profileId: PROFILE, purpose: "reupload" }, again.deps as never);
  assert.ok((again.mails[0] as { rendered: { text: string } }).rendered.text.includes("Passport: Photo page cut off\nVisa: Expired"));
});

test("outbox: the rejection email uses the HRMS template when one exists, and the built-in text otherwise", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const provider = { id: "mock", send: async (m: Record<string, unknown>) => { sent.push(m); return { kind: "accepted" as const, messageId: "abcdef123456" }; } };
  const config = hrMail.readHrMailConfig(MAIL_ENV);
  const row = { id: 7, profileId: PROFILE, kind: "rejected" as const, audience: "applicant" as const, to: "asha@example.test", payload: { name: "Asha Patel" }, attempts: 0 };
  const port = (template: unknown) => ({ claim: async () => [row], result: async () => undefined, template: async () => template as never });
  await hrMail.drainHrEmails(port(tpl.renderMessage({ subject: "About your application, {{first_name}}", bodyHtml: "<p>Dear {{first_name}}, thank you.</p>" }, tpl.templateValues(PERSON))) as never, provider as never, config);
  assert.equal(sent[0].subject, "About your application, Asha");
  assert.ok(String(sent[0].htmlBody).includes("<p>Dear Asha, thank you.</p>") && sent[0].textBody === "Dear Asha, thank you.", "HTML with a plain-text version");
  await hrMail.drainHrEmails(port(null) as never, provider as never, config);
  assert.equal(sent[1].subject, "Your staff application");
  assert.equal(sent[1].htmlBody, undefined, "no template: the built-in plain text");
});

function accountDeps(options: Parameters<typeof linkDeps>[0] & { setError?: string } = {}) {
  const base = linkDeps({ ...options, db: { hr_svc_account_open: { data: { name: "Asha Patel", firstName: "Asha", email: "asha@example.test", expiresAt: "2026-11-17T00:00:00Z", authUserId: "login-1" } },
    hr_svc_account_done: { data: { ok: true, email: "asha@example.test" } }, ...(options.db ?? {}) } });
  const passwords: Array<[string, string]> = [];
  return { ...base, passwords, deps: { ...base.deps, setPassword: async (userId: string, password: string) => { passwords.push([userId, password]); return { error: options.setError ?? null }; } } };
}

test("set-password link: the person chooses the password, weak ones are refused, and the link works once", async () => {
  const rule = onboard.passwordProblem;
  assert.equal(rule("Short1", ""), "Choose a password of at least 12 characters.");
  assert.equal(rule("onlylettersonly", ""), "Use at least one letter and one number.");
  assert.equal(rule("123456789012345", ""), "Use at least one letter and one number.");
  assert.equal(rule("asha.patel2026x", "asha.patel@example.test"), "Do not use your email address as the password.");
  assert.equal(rule("x".repeat(72) + "1", ""), "Choose a password of at most 72 characters.");
  assert.equal(rule("correct horse 42 battery", "asha@example.test"), null);

  const open = accountDeps();
  const view = await onboard.handleOnboarding(linkRequest("account_open") as never, open.deps as never);
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.view, { name: "Asha Patel", firstName: "Asha", email: "asha@example.test", expiresAt: "2026-11-17T00:00:00Z" }, "the page never learns the login id");

  const weak = accountDeps();
  const w = await onboard.handleOnboarding(linkRequest("account_setup", { password: "tooshort1" }) as never, weak.deps as never);
  assert.deepEqual([w.status, w.body.field], [400, "password"]);
  assert.equal(weak.passwords.length, 0, "a weak password never reaches Auth");
  assert.ok(!weak.names().includes("hr_svc_account_done"), "...and the link is not used up");

  const ok = accountDeps();
  const done = await onboard.handleOnboarding(linkRequest("account_setup", { password: "correct horse 42 battery" }) as never, ok.deps as never);
  assert.deepEqual(done.body, { ok: true, email: "asha@example.test" }, "the answer carries no password");
  assert.deepEqual(ok.passwords, [["login-1", "correct horse 42 battery"]], "the password goes to the login the LINK belongs to, never one named by the browser");
  assert.ok(ok.names().indexOf("hr_svc_account_open") < ok.names().indexOf("hr_svc_account_done"), "the link is checked first and used up last");
  assert.ok(!JSON.stringify(ok.calls).includes("correct horse"), "the password is never passed to the database or logged");

  const used = accountDeps({ db: { hr_svc_account_open: { error: { code: "28000", message: "This link is not valid any more. Ask us for a new one." } } } });
  const u = await onboard.handleOnboarding(linkRequest("account_setup", { password: "correct horse 42 battery" }) as never, used.deps as never);
  assert.deepEqual([u.status, u.body.code], [403, "link_invalid"], "a used, expired or replaced link gets the one neutral answer");
  assert.equal(used.passwords.length, 0);

  const authDown = accountDeps({ setError: "Database error" });
  const a = await onboard.handleOnboarding(linkRequest("account_setup", { password: "correct horse 42 battery" }) as never, authDown.deps as never);
  assert.equal(a.status, 503);
  assert.ok(!authDown.names().includes("hr_svc_account_done"), "a password that was not saved does not use the link up");
  const breached = accountDeps({ setError: "Password is known to be weak and easy to guess" });
  assert.equal((await onboard.handleOnboarding(linkRequest("account_setup", { password: "correct horse 42 battery" }) as never, breached.deps as never)).body.field, "password");
  const noToken = accountDeps();
  assert.equal((await onboard.handleOnboarding({ ...linkRequest("account_setup", { password: "correct horse 42 battery" }, null, ""), session: { userId: "someone" } } as never, noToken.deps as never)).body.code, "link_invalid", "a session is not a set-password link");
});

test("signed in before Active: the person reaches their own offer and documents, and nothing else", async () => {
  const DOC = "0b7b1c1e-0000-4000-8000-0000000000ee";
  const session = (action: string, fields: Record<string, unknown> = {}, user: string | null = "login-1") => ({ ...linkRequest(action, fields, null, null), session: user ? { userId: user } : null });
  const mine = linkDeps({ db: { hr_svc_staff_session: { data: "s".repeat(64) }, hr_svc_offer_open: { data: { name: "Asha", status: "offer_sent" } }, hr_svc_staff_document_path: { data: "p-1/passport/x.pdf" } } });
  const opened = await onboard.handleOnboarding(session("offer_open") as never, mine.deps as never);
  assert.equal(opened.status, 200);
  assert.deepEqual(mine.calls.find(([n]) => n === "hr_svc_staff_session")![1], { p_user: "login-1" }, "the database resolves the SESSION's user to their own offer");
  assert.deepEqual(mine.calls.find(([n]) => n === "hr_svc_offer_open")![1], { p_token_hash: "s".repeat(64) });
  const url = await onboard.handleOnboarding(session("my_document_url", { id: DOC }) as never, mine.deps as never);
  assert.equal(url.body.url, "signed:p-1/passport/x.pdf:300");
  assert.deepEqual(mine.calls.find(([n]) => n === "hr_svc_staff_document_path")![1], { p_user: "login-1", p_doc: DOC });

  // No session and no link: nothing.
  const anon = linkDeps();
  assert.equal((await onboard.handleOnboarding(session("offer_open", {}, null) as never, anon.deps as never)).body.code, "link_invalid");
  assert.equal((await onboard.handleOnboarding(session("my_document_url", { id: DOC }, null) as never, anon.deps as never)).status, 401);
  assert.ok(!anon.names().includes("hr_svc_staff_session") && !anon.names().includes("hr_svc_staff_document_path"));
  // A session opens the offer and own documents only: not the details form, uploads or submit of the document link.
  for (const action of ["open", "save", "upload", "remove", "submit", "view_url", "account_open", "account_setup"]) {
    const other = linkDeps({ db: { hr_svc_staff_session: { data: "s".repeat(64) } } });
    assert.equal((await onboard.handleOnboarding(session(action, { patch: {}, password: "correct horse 42 battery" }) as never, other.deps as never)).body.code, "link_invalid", `${action} is not available to a session`);
    assert.ok(!other.names().includes("hr_svc_staff_session"));
  }
  // Someone with no offer (or whose offer was withdrawn) gets a calm answer, not another person's letter.
  const none = linkDeps({ db: { hr_svc_staff_session: { error: { code: "28000", message: "There is no offer for this login." } } } });
  const n = await onboard.handleOnboarding(session("offer_open") as never, none.deps as never);
  assert.deepEqual([n.status, n.body.code], [404, "no_offer"]);
  assert.ok(!none.names().includes("hr_svc_offer_open"));
  const notMine = linkDeps({ db: { hr_svc_staff_document_path: { error: { code: "P0002", message: "Document not found." } } } });
  assert.equal((await onboard.handleOnboarding(session("my_document_url", { id: DOC }) as never, notMine.deps as never)).status, 404, "another person's document is not found");
  // A link token always wins over a session (an Admin signed in on the same browser never opens the link as themselves).
  const both = linkDeps();
  await onboard.handleOnboarding({ ...linkRequest("offer_open"), session: { userId: "admin-1" } } as never, both.deps as never);
  assert.ok(!both.names().includes("hr_svc_staff_session"));
});

test("onboarding pages are wired: stepper, stage actions, templates, set-password link, own offer before Active", () => {
  const detail = read("src/pages/admin/StaffOnboardingDetail.tsx");
  assert.ok(detail.includes("<OnboardingStepper") && detail.includes("adminOnboarding(") && detail.includes("<PayDetailsDialog") && detail.includes("<SendOfferDialog"), "the employee page shows the stepper and the stage dialogs");
  assert.ok(detail.includes("staffAdminActions.sendDocuments(") && detail.includes("staffAdminActions.resendLogin(") && detail.includes("timelineText("), "document link, resend login and the history");
  assert.ok(!/uploadOffer\(|staffAdminActions\.sendOffer\(/.test(detail), "the offer goes out through the Send offer letter dialog only");
  const stepper = read("src/pages/admin/components/hrms/OnboardingStepper.tsx");
  assert.ok(stepper.includes("ri-check-line") && stepper.includes("Current") && stepper.includes("lg:flex-row") && stepper.includes("flex-col"), "ticks, a Current label, stacked on a narrow screen");
  const offer = read("src/pages/admin/components/hrms/SendOfferDialog.tsx");
  assert.ok(offer.includes("renderMessage(") && offer.includes("generateOffer(") && offer.includes("sendOfferWithLogin(") && offer.includes("offer-confirm"), "template, preview, confirmation, then send");
  const router = read("src/router/config.tsx");
  assert.ok(router.includes('path: "staff/templates", element: <RequireAdmin><TemplatesPage /></RequireAdmin>'), "Templates is an Admin-only route");
  // One template system (20261113170000): the HRMS page lists and changes templates through signing_admin, with the one editor.
  const templates = read("src/pages/admin/TemplatesPage.tsx");
  for (const call of ['signingAdmin<SigningContext>("list")', '"template_duplicate"', '"template_archive"', '"template_delete"', "<TemplateEditor", "<TemplatePreviewDialog", "TEMPLATE_TYPES.map("]) assert.ok(templates.includes(call), `Templates page: ${call}`);
  const editor = read("src/pages/admin/components/signing/TemplateEditor.tsx");
  for (const call of ['"template_save"', "sanitizeTemplateHtml(", "templateText(", "placeholdersFor(", "<RichTextEditor", "SUBJECT_VARIABLES"]) assert.ok(editor.includes(call), `the one template editor: ${call}`);
  assert.ok(!templates.includes("template_default") && !editor.includes("is_default"), "template defaults are absent from the list and editor");
  const templatesApi = read("src/lib/hrTemplatesApi.ts");
  assert.ok(templatesApi.includes("templatePerson(") && templatesApi.includes("hr_admin_offer_letter_context") && !/hr_admin_template_(save|duplicate|archive|set_default)/.test(templatesApi), "the HRMS API keeps only the letter context and the person's values; template changes go through signing_admin");
  assert.ok(!read("src/pages/admin/components/hrms/SendOfferDialog.tsx").includes("saveTemplate(") && read("src/pages/admin/components/hrms/SendOfferDialog.tsx").includes('"template_save"'), "Save as new template uses the one table");
  const welcome = read("src/pages/staff/StaffWelcomePage.tsx");
  assert.ok(welcome.includes('takeLinkToken("account")') && welcome.includes("accountLink.setup(") && welcome.includes("signInWithPassword("), "the set-password link signs the person in afterwards");
  const home = read("src/pages/staff/StaffHomePage.tsx");
  assert.ok(home.includes("myOfferApi") && home.includes("myDocumentUrl(") && home.includes("staff-preactive"), "before Active: the offer and own documents");
  const api = read("src/lib/staffOnboardingApi.ts");
  assert.ok(!/localStorage/.test(api + welcome), "the link token is kept for the tab only");
  for (const file of ["src/pages/staff/StaffWelcomePage.tsx", "src/pages/admin/StaffOnboardingDetail.tsx", "supabase/functions/staff-admin/core.ts", "supabase/functions/staff-onboarding/index.ts"]) {
    assert.ok(!/console\.(log|info|debug)\(/.test(read(file)), `${file} logs nothing`);
  }
  const m3 = read("supabase/migrations/20261111110000_hr_offer_login.sql");
  assert.ok(m3.includes("interval '7 days'") && !/password\s+text|encrypted_password/i.test(m3), "the link lasts 7 days and the database never holds a password");
});

/* ------------------------------------------------------------------ onboarding wizard: one set of rules for students and staff */

test("shared rules: the student forms and the staff wizard call the same functions", () => {
  // Students: enrolForm.ts only re-exports the shared module (no second copy of a rule).
  assert.equal(enrolLib.emailProblem, person.emailProblem);
  assert.equal(enrolLib.mobileProblem, person.mobileProblem);
  assert.equal(enrolLib.dateOfBirthProblem, person.dateOfBirthProblem);
  assert.equal(enrolLib.parseDateOfBirth, person.parseDateOfBirth);
  assert.equal(enrolLib.validEmail, person.validEmail);
  for (const file of ["src/lib/enrolForm.ts", "src/pages/agency/components/ApplicationWizard.tsx", "src/pages/agency/lib/portalApplications.ts", "src/lib/employeeRules.ts", "src/lib/staffOnboardingApi.ts",
    "src/pages/staff/StaffOnboardingPage.tsx", "supabase/functions/staff-onboarding/core.ts"]) {
    assert.match(read(file), /_shared\/validation\/(person|staff-onboarding)/, `${file} uses the shared rules`);
  }
  // Both wizards are built from the same components: the shared shell and one of the shared steppers (the application wizard shows
  // its steps as grouped stages, WizardStages; the staff wizard one pill per step, WizardStepper), never a stepper of their own.
  for (const file of ["src/pages/agency/components/ApplicationWizard.tsx", "src/pages/staff/StaffOnboardingPage.tsx"]) {
    const text = read(file);
    assert.ok(text.includes("@/components/shared/wizard/WizardShell"), `${file} uses the shared WizardShell`);
    assert.ok(["WizardStepper", "WizardStages"].some((part) => text.includes(`@/components/shared/wizard/${part}`)), `${file} uses a shared stepper`);
    assert.ok(!/function\s+\w*(Stepper|Stages)\s*\(/.test(text), `${file} defines no stepper of its own`);
  }
  assert.ok(read("src/pages/agency/components/ApplicationWizard.tsx").includes("@/components/shared/wizard/WizardStages"), "the application wizard shows grouped stages");
  assert.ok(read("src/pages/agency/components/ApplicationWizard.tsx").includes("@/components/shared/wizard/WizardDocumentStep"));
  assert.ok(read("src/components/shared/wizard/DocumentWizard.tsx").includes("@/components/shared/wizard/WizardDocumentStep"), "staff uploads use the student upload screen");
  for (const file of ["src/pages/agency/components/WizardQuestionStep.tsx", "src/pages/staff/StaffOnboardingPage.tsx"]) {
    assert.ok(read(file).includes("@/components/shared/wizard/EmergencyContactFields"), `${file} uses the shared emergency contact`);
  }
  assert.ok(!existsSync(path.resolve("src/pages/agency/components/WizardDocumentStep.tsx")) && !existsSync(path.resolve("src/pages/agency/components/DocumentWizard.tsx")), "no second copy is left behind");
});

test("shared rules: phone, email, name, date of birth, emergency contact, address and files", () => {
  // Phone: the country-code field's value (E.164) with one of the picker's nine countries.
  assert.equal(person.phoneProblem("+61412345678", "missing"), "");
  assert.equal(person.phoneProblem("", "missing"), "missing");
  assert.equal(person.phoneProblem("0412345678", "missing"), "missing", "no country code");
  assert.equal(person.phoneProblem("+33123456789", "missing"), "missing", "a country that is not offered");
  assert.equal(person.phoneProblem("+6141234567", "missing"), "Enter a 10-digit Australian number starting with 0, e.g. 041 234 5678.");
  assert.equal(person.phoneProblem("+9198765", "missing"), "Enter a valid phone number for the selected country.");
  assert.equal(person.mobileProblem(""), "Enter your mobile number.");
  // Email and name.
  assert.equal(person.emailProblem(""), "Enter your email address.");
  assert.equal(person.emailProblem("a@b"), "Enter a valid email address, like name@company.com.au.");
  assert.equal(person.emailProblem("Name@Company.com.au"), "");
  assert.equal(person.nameProblem(" ", "first name"), "Enter your first name.");
  assert.equal(person.nameProblem("x".repeat(101), "last name"), "The last name must be 100 characters or fewer.");
  // Date of birth: 10 to 100 years old, a real date, ISO or day/month/year.
  const today = new Date("2026-11-10T03:00:00Z");
  assert.equal(person.dateOfBirthProblem("", today), "Enter your date of birth.");
  assert.equal(person.dateOfBirthProblem("1990-02-30", today), "Enter a real date of birth.");
  assert.equal(person.dateOfBirthProblem("2016-11-11", today), "You must be between 10 and 100 years old.");
  assert.equal(person.dateOfBirthProblem("2016-11-10", today) + person.dateOfBirthProblem("1926-11-10", today) + person.dateOfBirthProblem("5/6/1990", today), "");
  assert.deepEqual(person.dateOfBirthRange(today), { min: "1926-11-10", max: "2016-11-10" });
  // Emergency contact: the student wording is unchanged; staff are addressed as "you".
  assert.deepEqual(person.emergencyContactProblems({ name: "", phone: "", relationship: "" }), {
    name: "Enter the emergency contact's name.", phone: "Enter the emergency contact's phone number.", relationship: "Enter how they are related to the student." });
  assert.equal(person.emergencyContactProblems({ name: "Em", phone: "+61422333444", relationship: "" }, "you").relationship, "Enter how they are related to you.");
  assert.deepEqual(person.emergencyContactProblems({ name: "Em", phone: "+61422333444", relationship: "Sibling" }), {});
  assert.equal(person.emergencyContactProblems({ name: "Em", phone: "+6142", relationship: "Sibling" }).phone, "Enter a 10-digit Australian number starting with 0, e.g. 041 234 5678.");
  // Address: Australia needs a state from the list and a 4-digit postcode.
  const address = { street: "1 Example St", line2: "", suburb: "Melbourne", state: "vic", postcode: "3000", country: "Australia" };
  assert.deepEqual(person.addressProblems(address), {});
  assert.deepEqual(person.addressProblems({ ...address, state: "Punjab", postcode: "30" }), { state: "Choose the state or territory.", postcode: "Enter the 4-digit postcode." });
  assert.deepEqual(person.addressProblems({ ...address, country: "India", state: "Punjab", postcode: "144001" }), {});
  assert.deepEqual(person.addressProblems({ street: "", line2: "", suburb: "", state: "", postcode: "", country: "" }), { street: "Enter the street address.", suburb: "Enter the suburb or city.", country: "Enter the country." });
  // Files: size, then name and declared type, then content; the messages are the student wizard's.
  const pdf = new Uint8Array(PDF_BYTES.subarray(0, 8)), png = PNG_BYTES.subarray(0, 8);
  assert.equal(person.documentFileProblem({ name: "p.pdf", size: 100, type: "application/pdf" }, pdf), "");
  assert.equal(person.documentFileProblem({ name: "p.jpeg", size: 100, type: "image/jpeg" }, new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "");
  assert.equal(person.documentFileProblem({ name: "p.pdf", size: 0, type: "application/pdf" }, pdf), "Each document must be a PDF, JPG, or PNG no larger than 10 MB.");
  assert.equal(person.documentFileProblem({ name: "p.pdf", size: person.DOCUMENT_MAX_BYTES + 1, type: "application/pdf" }), "Each document must be a PDF, JPG, or PNG no larger than 10 MB.");
  assert.equal(person.documentFileProblem({ name: "p.gif", size: 100, type: "image/gif" }), "Only PDF, JPG, and PNG documents are supported.");
  assert.equal(person.documentFileProblem({ name: "p.pdf", size: 100, type: "" }), "Only PDF, JPG, and PNG documents are supported.");
  assert.equal(person.documentFileProblem({ name: "p.pdf", size: 100, type: "application/pdf" }, png), "The selected file does not match its declared document type.");
  assert.equal(person.DOCUMENT_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(onboard.MAX_DOCUMENT_BYTES, person.DOCUMENT_MAX_BYTES, "the function's limit is the shared one");
});

test("shared rules: bank details (staff only) and how they are shown", () => {
  assert.deepEqual(person.bankProblems({ accountName: "", bsb: "", accountNumber: "" }), {
    accountName: "Enter the account name.", bsb: "The BSB must be 6 digits, for example 062-000.", accountNumber: "The account number must be 4 to 10 digits." });
  assert.deepEqual(person.bankProblems({ accountName: "Jo Journey", bsb: "062-000", accountNumber: "1234 4321" }), {});
  assert.equal(person.bankProblems({ accountName: "x".repeat(101), bsb: "062000", accountNumber: "1234" }).accountName, "The account name must be 100 characters or fewer.");
  assert.equal(person.bankProblems({ accountName: "Jo", bsb: "06200", accountNumber: "1234" }).bsb, "The BSB must be 6 digits, for example 062-000.");
  assert.equal(person.bankProblems({ accountName: "Jo", bsb: "062000", accountNumber: "12345678901" }).accountNumber, "The account number must be 4 to 10 digits.");
  assert.equal(person.formatBsb("062000"), "062-000");
  assert.equal(person.maskBsb("062-000"), "06••••");
  assert.equal(person.maskAccountNumber("1234 4321"), "•••• 4321");
  assert.equal(person.maskAccountNumber("555666"), "•••• 66", "a short number shows only two digits");
  assert.equal(person.bsbBank("062-000"), "Commonwealth Bank");
  assert.equal(person.bsbBank("733000"), "Westpac");
  assert.equal(person.bsbBank("999999"), "", "an unknown code names no bank");
  assert.equal(person.bsbBank("0620"), "");
  // The Add / Edit employee form keeps its "all blank is fine" rule on top of the shared one.
  assert.deepEqual(employeeRulesLib.bankProblems({ accountName: "", bsb: "", accountNumber: "", bankName: "" }), {});
  assert.deepEqual(employeeRulesLib.bankProblems({ accountName: "Jo", bsb: "1", accountNumber: "12345678", bankName: "" }), { bsb: "The BSB must be 6 digits, for example 062-000." });
  // The database repeats the messages.
  const sql = read("supabase/migrations/20261112090000_hr_onboarding_wizard.sql");
  for (const message of ["Enter the account name.", "The account name must be 100 characters or fewer.", person.BSB_MESSAGE, person.ACCOUNT_NUMBER_MESSAGE,
    "Enter a 10-digit Australian number starting with 0, e.g. 041 234 5678.", "Enter a valid phone number for the selected country.", "You must be between 10 and 100 years old.", "Enter a real date of birth.",
    "Choose the state or territory.", "Enter the 4-digit postcode.", "Enter how they are related to you.", person.PASSPORT_NUMBER_MESSAGE, "Enter your visa type or subclass.",
    person.DOCUMENT_SIZE_MESSAGE, person.DOCUMENT_TYPE_MESSAGE]) {
    assert.ok(sql.includes(message.replace(/'/g, "''")), `the database has "${message}"`);
  }
  assert.ok(/pgp_sym_encrypt/.test(sql) && /hr_bank_details_key/.test(sql) && /employee_bank_no_plain_text/.test(sql), "bank details are stored encrypted, the plain columns locked");
  assert.ok(!/raise (notice|log|warning)[^;]*(bsb|account)/i.test(sql), "the migration never prints a bank value");
});

test("staff wizard rules: a draft takes blanks, the final check needs everything, in wizard order", () => {
  const details = { ...staffRules.EMPTY_STAFF_DETAILS };
  const now = new Date("2026-11-10T03:00:00Z");
  assert.deepEqual(staffRules.staffProblems(details, staffRules.STAFF_FIELDS, false, now), [{ field: "phone", message: "Enter your mobile number." }], "only the mobile may never be blank");
  assert.deepEqual(staffRules.staffProblems({ ...details, first_name: "x".repeat(101), date_of_birth: "2020-01-01", emergency_phone: "0422", passport_number: "12" }, ["first_name", "date_of_birth", "emergency_phone", "passport_number"], false, now), [
    { field: "first_name", message: "The first name must be 100 characters or fewer." }, { field: "date_of_birth", message: "You must be between 14 and 100 years old." },
    { field: "emergency_phone", message: "Enter the emergency contact's phone number." }, { field: "passport_number", message: "Enter the passport number: 6 to 12 letters and numbers." }]);
  assert.equal(staffRules.staffFieldProblem("address_state", { ...details, address_country: "Australia", address_state: "Punjab" }, false, now), "Choose the state or territory.");
  assert.equal(staffRules.staffFieldProblem("address_state", { ...details, address_country: "Australia" }, false, now), "", "blank is fine in a draft");
  assert.equal(staffRules.staffFieldProblem("address_state", { ...details, address_country: "Australia" }, true, now), "Choose the state or territory.");
  assert.equal(staffRules.staffFieldProblem("visa_subclass", { ...details, is_australian_citizen: false }, true, now), "Enter your visa type or subclass.");
  assert.equal(staffRules.staffFieldProblem("visa_subclass", { ...details, is_australian_citizen: true }, true, now), "");
  assert.equal(staffRules.staffFieldProblem("visa_conditions", { ...details, visa_conditions: "8105\nNo other limits" }, true, now), "", "work conditions may run over lines");
  assert.equal(staffRules.staffFieldProblem("middle_name", details, true, now), "", "a middle name is never required");
  // What is stored: trimmed, the date as ISO, an Australian state and the passport number in capitals.
  const typed = { ...details, date_of_birth: " 3/2/1991 ", address_country: "Australia", address_state: "vic", passport_number: " pa 1234567 ", first_name: "  Jo " };
  assert.deepEqual(["date_of_birth", "address_state", "passport_number", "first_name"].map((k) => staffRules.normalizeStaffField(k as never, typed, now)), ["1991-02-03", "VIC", "PA1234567", "Jo"]);
  assert.equal(staffRules.normalizeStaffField("address_state", { ...typed, address_country: "India", address_state: "Punjab" }, now), "Punjab");
  assert.deepEqual([...staffRules.STAFF_STEP_FIELDS.documents, ...staffRules.STAFF_STEP_FIELDS.prefill, ...staffRules.STAFF_STEP_FIELDS.personal, ...staffRules.STAFF_STEP_FIELDS.tax].sort(), [...staffRules.STAFF_FIELDS].sort(), "every field belongs to exactly one step");
});

test("tax and super rules (option A): the declaration answers and the super choice, conditional on each other; the same messages in SQL; no tax file number", () => {
  const now = new Date("2026-11-10T03:00:00Z");
  const base = { ...staffRules.EMPTY_STAFF_DETAILS };
  const problem = (field: string, patch: Partial<typeof base>, final: boolean) => staffRules.staffFieldProblem(field as never, { ...base, ...patch }, final, now);
  assert.equal(problem("tax_residency", {}, false), "", "blank in a draft");
  assert.equal(problem("tax_residency", {}, true), "Tell us your residency status for tax purposes.");
  assert.equal(problem("tax_residency", { tax_residency: "martian" }, false), "Choose your residency status for tax purposes.");
  assert.equal(problem("tax_free_threshold", { tax_residency: "resident" }, true), "Tell us whether you claim the tax-free threshold.");
  assert.equal(problem("tax_free_threshold", { tax_residency: "foreign" }, true), "", "a foreign resident or a working holiday maker is not asked");
  assert.equal(problem("tax_free_threshold", { tax_residency: "resident", tax_free_threshold: "maybe" }, false), "Answer yes or no for the tax-free threshold.");
  assert.equal(problem("study_loan", {}, true), "Tell us whether you have a study or training support loan.");
  assert.equal(problem("super_choice", {}, true), "Choose how your super is paid.");
  assert.equal(problem("super_choice", { super_choice: "bank" }, false), "Choose how your super is paid.");
  assert.equal(problem("super_fund_name", { super_choice: "own" }, true), "Enter the name of your super fund.");
  assert.equal(problem("super_fund_name", { super_choice: "default" }, true), "", "the default fund needs no details");
  assert.equal(problem("super_fund_abn", { super_choice: "smsf" }, true), "Enter the fund's ABN.");
  assert.equal(problem("super_fund_abn", { super_fund_abn: "51 824 753 556" }, false), "", "the ABN check digits, spaces allowed");
  assert.equal(problem("super_fund_abn", { super_fund_abn: "51824753557" }, false), "Enter a valid ABN; its check digits do not match.");
  assert.equal(problem("super_fund_abn", { super_fund_abn: "123" }, false), "ABN must contain 11 digits.");
  assert.equal(problem("super_usi", { super_usi: "abc-def" }, false), "The USI must be up to 20 letters and numbers.");
  assert.equal(problem("super_usi", { super_choice: "own" }, true), "", "the USI is never required");
  assert.equal(problem("super_member_number", { super_choice: "own" }, true), "Enter your member number.");
  assert.equal(problem("super_member_number", { super_choice: "smsf" }, true), "", "an SMSF has no member number");
  assert.equal(problem("super_member_number", { super_member_number: "a@b" }, false), "The member number must be up to 30 letters, numbers, spaces or hyphens.");
  // Stored: the ABN as digits, the USI in capitals.
  const typed = { ...base, super_fund_abn: " 51 824 753 556 ", super_usi: " sta0100au " };
  assert.deepEqual(["super_fund_abn", "super_usi"].map((k) => staffRules.normalizeStaffField(k as never, typed, now)), ["51824753556", "STA0100AU"]);
  // The review card and the Admin's card say the same, including where the tax file number goes.
  const rows = wizardLib.taxSuperRows({ ...base, tax_residency: "resident", tax_free_threshold: "yes", study_loan: "no", super_choice: "own", super_fund_name: "AustralianSuper", super_fund_abn: "65714394898", super_usi: "STA0100AU", super_member_number: "123456" });
  assert.deepEqual(rows, [["Residency for tax", "Australian resident for tax purposes"], ["Tax-free threshold", "Yes"], ["Study or training loan", "No"], ["Super", "My own super fund"],
    ["Fund", "AustralianSuper"], ["Fund ABN", "65 714 394 898"], ["USI", "STA0100AU"], ["Member number", "123456"], ["Tax file number", "Given through Xero, not collected here"]]);
  assert.deepEqual(wizardLib.taxSuperRows({ ...base, tax_residency: "whm", study_loan: "no", super_choice: "default" }).map((r) => r[0]), ["Residency for tax", "Study or training loan", "Super", "Tax file number"]);
  // The database repeats the lists, the messages and the ABN check, and the retention purge clears every answer.
  const sql = read("supabase/migrations/20261112110000_hr_tax_super.sql");
  for (const message of ["Tell us your residency status for tax purposes.", "Tell us whether you claim the tax-free threshold.", "Tell us whether you have a study or training support loan.", "Choose how your super is paid.",
    "Enter the name of your super fund.", "Enter the fund''s ABN.", "The USI must be up to 20 letters and numbers.", "Enter your member number.", "The member number must be up to 30 letters, numbers, spaces or hyphens."]) assert.ok(sql.includes(message), message);
  assert.ok(sql.includes("('', 'resident', 'foreign', 'whm')") && sql.includes("('', 'default', 'own', 'smsf')") && sql.includes("array[10,1,3,5,7,9,11,13,15,17,19]"), "the same lists and ABN weights");
  for (const column of staffRules.STAFF_STEP_FIELDS.tax) assert.ok(sql.includes(`${column} = ''`), `retention clears ${column}`);
  assert.ok(!/tfn|tax_file/i.test(sql), "the migration has no tax file number column");
});

test("onboarding save: checked with the shared rules before the database, answered with the field; stored normalised", async () => {
  let run = linkDeps();
  let r = await onboard.handleOnboarding(linkRequest("save", { patch: { date_of_birth: "2020-01-01" } }), run.deps);
  assert.deepEqual([r.status, r.body.error, r.body.field], [400, "You must be between 14 and 100 years old.", "date_of_birth"], "staff minimum age: Business Rule hrms.staff_minimum_age (14)");
  staffRules.setStaffMinimumAge(16);
  assert.equal(staffRules.staffFieldProblem("date_of_birth", { ...staffRules.EMPTY_STAFF_DETAILS, date_of_birth: "15/06/2011" }, true, new Date("2026-11-20T00:00:00Z")), "You must be between 16 and 100 years old.", "a changed rule moves the age");
  assert.equal(staffRules.staffDateOfBirthRange(new Date("2026-11-20T00:00:00Z")).max, "2010-11-20");
  staffRules.setStaffMinimumAge(14);
  assert.ok(!run.names().includes("hr_svc_onboarding_save"), "nothing invalid reaches the database");
  for (const [patch, field, message] of [
    [{ emergency_phone: "0422 333 444" }, "emergency_phone", "Enter the emergency contact's phone number."],
    [{ phone: "" }, "phone", "Enter your mobile number."],
    [{ passport_number: "12" }, "passport_number", "Enter the passport number: 6 to 12 letters and numbers."],
    [{ first_name: 5 }, "first_name", "Check the first name field."],
    [{ is_australian_citizen: "yes" }, "is_australian_citizen", "Tell us whether you are an Australian citizen."],
    [{ address_country: "Australia", address_postcode: "30" }, "address_postcode", "Enter the 4-digit postcode."],
  ] as const) {
    run = linkDeps();
    r = await onboard.handleOnboarding(linkRequest("save", { patch }), run.deps);
    assert.deepEqual([r.status, r.body.field, r.body.error], [400, field, message], JSON.stringify(patch));
    assert.ok(!run.names().includes("hr_svc_onboarding_save"));
  }
  // The state rule looks at the country already saved when the patch does not carry it.
  run = linkDeps({ db: { hr_svc_onboarding_open: { data: { profile: { address_country: "Australia", is_australian_citizen: false } } } } });
  r = await onboard.handleOnboarding(linkRequest("save", { patch: { address_state: "Punjab" } }), run.deps);
  assert.deepEqual([r.status, r.body.field], [400, "address_state"]);
  run = linkDeps({ db: { hr_svc_onboarding_open: { data: { profile: { address_country: "Australia", is_australian_citizen: false } } } } });
  r = await onboard.handleOnboarding(linkRequest("save", { patch: { address_state: "vic", date_of_birth: "3/2/1991", passport_number: "pa 1234567", first_name: " Jo ", is_australian_citizen: true, hacker: "x" } }), run.deps);
  assert.equal(r.status, 200);
  assert.deepEqual((run.calls.find(([n]) => n === "hr_svc_onboarding_save")![1] as { p_patch: unknown }).p_patch,
    { is_australian_citizen: true, first_name: "Jo", date_of_birth: "1991-02-03", address_state: "VIC", passport_number: "PA1234567" }, "normalised, in wizard order, unknown keys dropped");
  run = linkDeps();
  assert.deepEqual([(await onboard.handleOnboarding(linkRequest("save", { patch: { hacker: "x" } }), run.deps)).body.error], ["Nothing to save."]);
});

test("onboarding bank_save: the shared rule, the field named, the numbers never echoed", async () => {
  assert.ok((onboard.ACTIONS as readonly string[]).includes("bank_save"));
  let run = linkDeps();
  let r = await onboard.handleOnboarding(linkRequest("bank_save", { bank: { accountName: "Jo Journey", bsb: "0620", accountNumber: "98765432" } }), run.deps);
  assert.deepEqual([r.status, r.body.field, r.body.error], [400, "bsb", "The BSB must be 6 digits, for example 062-000."]);
  assert.ok(!JSON.stringify(r.body).includes("98765432") && !JSON.stringify(r.body).includes("0620"), "a refusal never repeats what was typed");
  assert.ok(!run.names().includes("hr_svc_onboarding_bank_save"));
  run = linkDeps();
  r = await onboard.handleOnboarding(linkRequest("bank_save", { bank: { accountName: "", bsb: "", accountNumber: "" } }), run.deps);
  assert.deepEqual([r.status, r.body.field, r.body.error], [400, "accountName", "Enter the account name."]);
  for (const bank of [null, "x", [1], undefined]) assert.equal((await onboard.handleOnboarding(linkRequest("bank_save", { bank }), linkDeps().deps)).body.error, "Enter your bank details.");
  run = linkDeps();
  r = await onboard.handleOnboarding(linkRequest("bank_save", { bank: { accountName: " Jo Journey ", bsb: "062-000", accountNumber: "9876 5432", bankName: "Commonwealth Bank", extra: "x" } }), run.deps);
  assert.equal(r.status, 200);
  assert.deepEqual(run.calls.find(([n]) => n === "hr_svc_onboarding_bank_save")![1], { p_token_hash: `h(${LINK})`, p_bank: { accountName: "Jo Journey", bsb: "062000", accountNumber: "98765432", bankName: "Commonwealth Bank" } });
  run = linkDeps({ db: { hr_svc_onboarding_bank_save: { error: { code: "28000", message: "x" } } } });
  r = await onboard.handleOnboarding(linkRequest("bank_save", { bank: { accountName: "Jo", bsb: "062000", accountNumber: "98765432" } }), run.deps);
  assert.deepEqual([r.status, r.body.code], [403, "link_invalid"], "a dead link gets the neutral answer here too");
  // Nothing in the function writes a bank value to a log.
  const source = read("supabase/functions/staff-onboarding/core.ts") + read("supabase/functions/staff-onboarding/index.ts");
  assert.ok(!/console\.(log|info|warn|error)\([^)]*(bank|bsb|account)/i.test(source), "no bank value is logged");
});

test("onboarding upload: the shared document messages, by size, declared type and content", async () => {
  const send = (file: File) => onboard.handleOnboarding(linkRequest("upload", { category: "Passport" }, file), linkDeps().deps);
  assert.deepEqual([(await send(new File([], "p.pdf", { type: "application/pdf" }))).body.error], [person.DOCUMENT_SIZE_MESSAGE]);
  assert.deepEqual([(await send(new File([new TextEncoder().encode("GIF89a....")], "p.gif", { type: "image/gif" }))).body.error], [person.DOCUMENT_TYPE_MESSAGE]);
  assert.deepEqual([(await send(new File([PDF_BYTES], "p.pdf"))).body.error], [person.DOCUMENT_TYPE_MESSAGE], "a file with no declared type is refused, as in the student wizard");
  assert.deepEqual([(await send(new File([PNG_BYTES], "p.pdf", { type: "application/pdf" }))).body.error], [person.DOCUMENT_CONTENT_MESSAGE]);
  const run = linkDeps();
  const ok = await onboard.handleOnboarding(linkRequest("upload", { category: "Visa" }, new File([PDF_BYTES], "visa.pdf", { type: "application/pdf" })), run.deps);
  assert.equal(ok.status, 200);
  assert.equal((run.calls.find(([n]) => n === "hr_svc_document_add")![1] as { p_expiry: unknown }).p_expiry, null, "a file may be uploaded without its expiry date");
});

test("wizard: where each pre-filled value came from, what could not be read, and what does not match", () => {
  const today = "2026-11-10";
  const passport = { id: "p", category: "Passport", expiryDate: null, extractionStatus: "done" as const,
    extracted: { first_name: "TARA", last_name: "TRAINER", dob: "1990-05-06", passport_number: "PA 1234567", passport_expiry: "2031-01-01", nationality: "" , citizenship: "Indian" } };
  const note = (field: string, value: string, documents = [passport]) => wizardLib.prefillNote(field as never, value, documents as never, today);
  assert.deepEqual(note("first_name", "Tara"), { kind: "match", text: "From your passport" }, "upper and lower case are the same name");
  assert.deepEqual(note("date_of_birth", "1990-05-06"), { kind: "match", text: "From your passport" });
  assert.deepEqual(note("passport_number", "pa1234567"), { kind: "match", text: "From your passport" });
  assert.deepEqual(note("nationality", "Indian"), { kind: "match", text: "From your passport" }, "the citizenship is used when the nationality was not read");
  assert.deepEqual(note("last_name", "Teacher"), { kind: "differs", text: 'This does not match your passport, which shows "TRAINER". Check which is right.', suggestion: "TRAINER" });
  assert.deepEqual(note("date_of_birth", ""), { kind: "differs", text: 'Your passport shows "06/05/1990".', suggestion: "1990-05-06" });
  assert.deepEqual(note("middle_name", ""), { kind: "unread", text: "We could not read this from your passport. Please type it." });
  assert.equal(note("middle_name", "Typed"), null, "a typed value with nothing read against it has no note");
  assert.deepEqual(note("expiry:Passport", "2031-01-01"), { kind: "match", text: "From your passport" });
  assert.equal(note("expiry:Passport", "", [{ ...passport, extracted: { passport_expiry: "2020-01-01" } }])!.kind, "expired");
  assert.deepEqual(note("first_name", "Tara", [{ ...passport, extractionStatus: "processing" as const }]), { kind: "reading", text: "Reading your passport…" });
  assert.equal(note("first_name", "", [{ ...passport, extractionStatus: "unavailable" as const, extracted: {} }])!.kind, "unread", "with reading switched off the field is simply typed");
  assert.equal(note("first_name", "Tara", []), null, "no document, no note");
  assert.equal(note("visa_subclass", "485", [{ id: "v", category: "Visa", expiryDate: null, extractionStatus: "done" as const, extracted: { visa_subclass: "485" } }])!.text, "From your visa");
  assert.equal(note("address_street", "9 Licence Rd", [{ id: "l", category: "Driving Licence", expiryDate: null, extractionStatus: "done" as const, extracted: { au_street: "9 Licence Rd" } }])!.text, "From your driving licence");
  assert.equal(note("emergency_name", "Em"), null, "fields no document can give have no note");
  assert.equal(wizardLib.readerDate("03/02/1991"), "1991-02-03");
  assert.equal(wizardLib.isBeingRead({ ...passport, extractionStatus: "pending" as const }), true);
  assert.equal(wizardLib.isBeingRead({ ...passport, category: "Academic", extractionStatus: "pending" as const }), false, "academic results are never read");
  assert.deepEqual(wizardLib.STAFF_WIZARD.map((s) => s.id), ["documents", "prefill", "personal", "review"]);
  // What the server sends becomes the wizard's fields.
  const details = wizardLib.detailsOf({ first_name: "Jo", phone_e164: "+61400000111", emergency_phone_e164: null, is_australian_citizen: true, date_of_birth: null, passport_number: "N1234567" });
  assert.deepEqual([details.first_name, details.phone, details.emergency_phone, details.is_australian_citizen, details.date_of_birth, details.passport_number], ["Jo", "+61400000111", "", true, "", "N1234567"]);
});

test("onboarding address_search: the student form's Geoscape lookup through the private link, typing as the fallback", async () => {
  assert.ok((onboard.ACTIONS as readonly string[]).includes("address_search"));
  const open = { hr_svc_onboarding_open: { data: { readOnly: false, mode: "documents" } } };
  const pick = { line: "12 Smith St", line2: "", suburb: "Melbourne", state: "VIC", postcode: "3000", country: "Australia" };
  const withSearch = (options: Parameters<typeof linkDeps>[0], answer: unknown, seen: string[] = []) => {
    const run = linkDeps(options);
    return { ...run, seen, deps: { ...run.deps, searchAddress: async (q: string) => { seen.push(q); if (answer === "throw") throw new Error("boom"); return answer as never; } } };
  };
  let run = withSearch({ db: open }, { kind: "ok", suggestions: [pick], attribution: "x" });
  let r = await onboard.handleOnboarding(linkRequest("address_search", { q: "  12 Smith St Mel  " }), run.deps);
  assert.deepEqual([r.status, r.body], [200, { ok: true, suggestions: [pick], attribution: "x" }]);
  assert.deepEqual(run.seen, ["12 Smith St Mel"], "the trimmed text is searched once");
  assert.ok(run.calls.some(([n, b]) => n === "limit" && String(b).startsWith("staff-onboarding:link:address:")), "address searches have their own allowance");
  assert.ok(!run.calls.some(([n, b]) => n === "limit" && String(b).startsWith("staff-onboarding:link:any:")), "...and do not use up the link's other calls");
  // Too short: no lookup. No function key, a provider fault or a crash: "unavailable" and nothing else.
  run = withSearch({ db: open }, { kind: "ok", suggestions: [pick], attribution: "" });
  r = await onboard.handleOnboarding(linkRequest("address_search", { q: "12 " }), run.deps);
  assert.deepEqual([r.status, r.body, run.seen], [200, { ok: true, suggestions: [] }, []]);
  for (const answer of [{ kind: "unavailable", reason: "provider_status_429" }, "throw"]) {
    run = withSearch({ db: open }, answer);
    r = await onboard.handleOnboarding(linkRequest("address_search", { q: "12 Smith St" }), run.deps);
    assert.deepEqual([r.status, r.body], [503, { ok: false, unavailable: true }], "no reason, key or query in the answer");
  }
  const bare = linkDeps({ db: open });
  assert.equal((await onboard.handleOnboarding(linkRequest("address_search", { q: "12 Smith St" }), bare.deps)).status, 503, "not configured is unavailable too");
  // Only this person's open documents link: a dead link is 403, a submitted or re-upload link is refused, and nothing is searched.
  run = withSearch({ db: { hr_svc_onboarding_open: { error: { code: "28000", message: "x" } } } }, { kind: "ok", suggestions: [pick], attribution: "" });
  r = await onboard.handleOnboarding(linkRequest("address_search", { q: "12 Smith St" }), run.deps);
  assert.deepEqual([r.status, r.body.code, run.seen], [403, "link_invalid", []]);
  for (const state of [{ readOnly: true, mode: "documents" }, { readOnly: false, mode: "reupload" }]) {
    run = withSearch({ db: { hr_svc_onboarding_open: { data: state } } }, { kind: "ok", suggestions: [pick], attribution: "" });
    r = await onboard.handleOnboarding(linkRequest("address_search", { q: "12 Smith St" }), run.deps);
    assert.deepEqual([r.status, run.seen], [400, []], JSON.stringify(state));
  }
  run = withSearch({ db: open, limit: (b) => !b.startsWith("staff-onboarding:link:address:") }, { kind: "ok", suggestions: [pick], attribution: "" });
  r = await onboard.handleOnboarding(linkRequest("address_search", { q: "12 Smith St" }), run.deps);
  assert.deepEqual([r.status, r.headers?.["Retry-After"], run.seen], [429, "60", []], "40 a minute per link, as in the student function");
  assert.equal(onboard.ADDRESS_SEARCH_LIMIT, 40);
  // The same helper, key name and endpoint as the live address-search function; the browser uses the same search box.
  const index = read("supabase/functions/staff-onboarding/index.ts");
  assert.ok(index.includes('from "../_shared/validation/address.ts"') && index.includes("EF_ADDRESS_SEARCH_GEOSCAPE_KEY") && index.includes("isLocalSupabaseUrl(SUPABASE_URL)"));
  assert.equal(read("supabase/functions/_shared/validation/address.ts"), read("recovered/live-edge-functions-2026-11-02/_shared/validation/address.ts"), "the helper is the one the live address-search function runs");
  for (const file of ["src/pages/agency/components/ApplicationWorkspace.tsx", "src/pages/staff/StaffOnboardingPage.tsx"]) assert.ok(read(file).includes("@/components/shared/wizard/AddressSearch"), `${file} uses the shared address search`);
  assert.ok(!/console\.(log|info|warn|error)\([^)]*\b(q|query)\b/.test(read("supabase/functions/staff-onboarding/core.ts") + index), "the search text is never logged");
});

/* ------------------------------------------------------------------ Offer letter (LOO) templates: pictures, pasted formatting, {{variables}} */
const letterVars = await load.import<typeof import("../supabase/functions/_shared/letter-variables.ts")>("../supabase/functions/_shared/letter-variables.ts");
type LetterVariableT = import("../supabase/functions/_shared/letter-variables.ts").LetterVariable;
const LOO_MIGRATION = read("supabase/migrations/20261113270000_offer_letter_templates.sql");
/** The registry exactly as the migration seeds public.letter_variables (the one registry; the pages read it from the database). */
const LETTER_REGISTRY: LetterVariableT[] = (() => {
  const S = "'((?:[^']|'')*)'";
  const row = new RegExp(`\\(${S}, ${S}, ${S}, ${S}, ${S}, ${S}, ${S}, ${S}, ${S}, (true|false), (true|false),\\s*${S}, ${S}, (\\d+)\\)`, "g");
  const un = (s: string) => s.replace(/''/g, "'");
  return [...LOO_MIGRATION.matchAll(row)].map((m) => ({
    key: m[1], group: un(m[2]) as LetterVariableT["group"], label: un(m[3]), description: un(m[4]), sourceKind: m[5] as LetterVariableT["sourceKind"], source: un(m[7]),
    format: m[8] as LetterVariableT["format"], inputType: m[9] as LetterVariableT["inputType"], required: m[10] === "true", editableSource: m[11] === "true",
    aliases: un(m[12]).replace(/^\{|\}$/g, "").split(",").filter(Boolean), sample: un(m[13]),
  }));
})();
const LOGO = "https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/template-assets/default/0b8f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4.png";

test("offer letter HTML: pictures in template-assets keep their size, other pictures go; Word cell borders, padding, rowspan and line spacing are kept", () => {
  const clean = richHtml.sanitizeRichHtml(`<p style="text-align:center"><img src="${LOGO}" width="160" height="48" alt="SLIT"></p><img src="https://evil.example/a.png"><img src="file:///C:/Users/x/image001.png">`
    + `<img src="http://127.0.0.1:54321/storage/v1/object/public/template-assets/default/0b8f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c5.jpg">`
    + `<table class="MsoTableGrid" border="1" cellspacing="0" style="border-collapse:collapse;border:none"><tr><td rowspan="2" style="width:120pt;border:solid windowtext 1.0pt;padding:0cm 5.4pt 0cm 5.4pt;vertical-align:middle">Fees</td>`
    + `<td style="border:solid windowtext 1.0pt;border-left:none;mso-border-alt:solid windowtext .5pt;padding:0cm 5.4pt 0cm 5.4pt"><p class="MsoNormal" style="margin-bottom:0cm;line-height:150%"><b>Tuition</b></p></td></tr>`
    + `<tr><td style="border-top:none;border-left:none;border-bottom:1px solid #333333;border-right:solid windowtext 1.0pt">AUD$14,500.00</td></tr></table>`);
  assert.ok(clean.includes(`<img src="${LOGO}" alt="SLIT" style="width:120pt;height:36pt">`), `logo kept with its size: ${clean}`);
  assert.ok(clean.includes('<p style="text-align:center"><img'), "the picture's alignment (its paragraph) is kept");
  assert.ok(clean.includes("127.0.0.1:54321/storage/v1/object/public/template-assets/"), "the local stack's template-assets is accepted");
  for (const gone of ["evil.example", "file:///", "mso-border-alt", "MsoTableGrid"]) assert.ok(!clean.includes(gone), `${gone} removed`);
  for (const kept of ['rowspan="2"', "border-top:1pt solid #000000", "border-left:none", "padding:0pt 5.4pt", "vertical-align:middle", "line-height:1.5", "margin-bottom:0pt", "border-bottom:0.75pt solid #333333", "<strong>Tuition</strong>"])
    assert.ok(clean.includes(kept), `${kept} kept: ${clean}`);
  assert.equal(richHtml.sanitizeRichHtml(clean), clean, "sanitising twice changes nothing");
  assert.equal(richHtml.borderOf("medium none"), "none");
  assert.equal(richHtml.lineHeightOf("normal"), null);
  // The database accepts the same pictures and refuses the rest (hr.rich_html_problem in 20261113270000).
  assert.ok(LOO_MIGRATION.includes("template-assets/") && LOO_MIGRATION.includes("Pictures must be uploaded into the template"));
});

test("offer letter variables: one registry from the database; unmapped tokens and old placeholders with suggestions; conversion; modifiers; what blocks Send", () => {
  assert.ok(LETTER_REGISTRY.length >= 55, `registry rows: ${LETTER_REGISTRY.length}`);
  for (const key of ["student.full_name", "student.dob", "student.passport_number", "student.nationality", "student.address", "student.initial_line", "course.name", "course.intake", "course.start_date",
    "fees.tuition", "fees.total", "agent.name", "agency.name", "application.reference", "offer.conditions", "institute.name", "institute.abn", "page.number", "page.total"])
    assert.ok(LETTER_REGISTRY.some((v) => v.key === key), key);
  assert.deepEqual([...new Set(LETTER_REGISTRY.map((v) => v.group))], ["Student", "Course", "Fees", "Agent / Agency", "Application", "Institute", "Page"]);
  const html = "<p>Dear {{student.full_name}} $[dogField] {example2:inline} [Page Number] [optional note] {{foo.bar}} {{student.dob|shout}} {{student.dob|upper}} $[Passport <b>No</b>]</p>";
  const found = letterVars.unmappedTokens(html, LETTER_REGISTRY);
  assert.deepEqual(found.map((t) => t.token).sort(), ["$[Passport No]", "$[dogField]", "[Page Number]", "{example2:inline}", "{{foo.bar}}", "{{student.dob|shout}}"].sort());
  assert.equal(found.find((t) => t.token === "[Page Number]")?.suggestion?.key, "page.number", "an old [Page Number] is suggested as {{page.number}}");
  assert.equal(found.find((t) => t.token === "$[Passport No]")?.suggestion?.key, "student.passport_number");
  assert.equal(found.find((t) => t.token === "$[dogField]")?.suggestion, undefined, "an unknown old name has no suggestion: staff map it");
  assert.equal(letterVars.replaceToken("<p>$[Passport <b>No</b>] and [Page Number]</p>", "$[Passport No]", "student.passport_number"), "<p>{{student.passport_number}} and [Page Number]</p>", "converted across Word's tags");
  assert.deepEqual(letterVars.letterKeys(html), ["student.full_name", "foo.bar", "student.dob"]);
  const family = { value: "O'Neil-Smith", raw: "o'neil-smith", source: "x", missing: false };
  assert.equal(letterVars.applyModifier(family, "upper"), "O'NEIL-SMITH");
  assert.equal(letterVars.applyModifier(family, "raw"), "o'neil-smith");
  assert.equal(letterVars.conditionsText(""), "Nil");
  assert.equal(letterVars.conditionsText("- Provide IELTS 6.0\n- Pay the deposit"), "1. Provide IELTS 6.0\n2. Pay the deposit");
  const spec = (key: string) => LETTER_REGISTRY.find((v) => v.key === key)!;
  assert.equal(letterVars.formatTyped(spec("student.dob"), "2001-04-12"), "12/04/2001");
  assert.equal(letterVars.formatTyped(spec("student.dob"), "2001-04-12", "D Month YYYY"), "12 April 2001");
  assert.equal(letterVars.formatTyped(spec("fees.tuition"), "14500"), "AUD$14,500.00");
  assert.equal(letterVars.formatTyped(spec("student.given_name"), "ASHA rani"), "Asha Rani");
  // Send: a required detail must have a value; an optional one a value or the "leave blank" tick.
  const tpl = "<p>{{course.cricos}} {{fees.material}} {{page.number}} {{offer.conditions}}</p>";
  const missing = letterVars.missingDetails(tpl, LETTER_REGISTRY, {});
  assert.deepEqual(missing.map((m) => m.variable.key), ["course.cricos", "fees.material"], "page numbers and conditions are never missing");
  assert.equal(letterVars.blockingDetails(missing, []).length, 2);
  assert.equal(letterVars.blockingDetails(missing, [{ key: "fees.material", value: "", mode: "blank" }]).length, 1, "the optional one ticked blank");
  assert.equal(letterVars.blockingDetails(missing, [{ key: "course.cricos", value: "", mode: "blank" }, { key: "fees.material", value: "", mode: "blank" }]).length, 1, "a required one cannot be blank");
  assert.equal(letterVars.blockingDetails(missing, [{ key: "course.cricos", value: "0101234", mode: "letter" }, { key: "fees.material", value: "", mode: "blank" }]).length, 0, "nothing blocks");
});

test("offer letter PDF: logo and office details in the header and the footer on every page, Page x of y, values and conditions printed, missing variables marked on every page", async () => {
  const header = `<table style="border:none;width:100%"><tr><td style="width:40%"><img src="${LOGO}" style="width:90pt;height:30pt"></td>`
    + `<td style="text-align:right;width:60%">{{institute.name}}<br>{{institute.address}}<br>RTO {{institute.rto}} | CRICOS {{institute.cricos}}</td></tr></table>`;
  const footer = `<p>Page {{page.number}} of {{page.total}} &nbsp; {{student.initial_line}} &nbsp; Course CRICOS {{course.cricos}}</p>`;
  const body = `<h2>Letter of offer</h2><p>Dear {{student.full_name}} ({{student.family_name|upper}}), born {{student.dob}}, passport {{student.passport_number}}.</p>`
    + `<table><tr><td rowspan="2" style="vertical-align:middle">Fees for {{course.intake}}</td><td>Tuition {{fees.tuition}}</td></tr><tr><td>Total {{fees.total}}</td></tr></table>`
    + `<p>Conditions:</p><p>{{offer.conditions}}</p>` + Array.from({ length: 60 }, (_, i) => `<p style="line-height:1.5">Clause ${i + 1}: the student agrees to the terms of enrolment, refunds and attendance.</p>`).join("");
  const v = (value: string) => ({ value, raw: value, source: "test", missing: false });
  const values = { "institute.name": v("Skyline Institute of Technology"), "institute.address": v("Level 8, 310 King Street, Melbourne VIC 3000"), "institute.rto": v("45989"), "institute.cricos": v("04114B"),
    "student.full_name": v("Ms Asha Rani O'Neil-Smith"), "student.family_name": v("O'Neil-Smith"), "student.dob": v("12/04/2001"), "student.passport_number": v("N1234567"), "course.intake": v("February 2027"),
    "fees.tuition": v("AUD$14,500.00"), "fees.total": v("AUD$14,750.00"), "course.cricos": { value: "", raw: "", source: "Course setup › CRICOS code", missing: true } };
  const made = await documentPdf.buildDocumentPdf({ title: "Letter of offer", header, body, footer, values: {}, brackets: false, images: { [LOGO]: Uint8Array.from(atob(PNG_1PX), (c) => c.charCodeAt(0)) },
    curly: letterVars.letterResolver(LETTER_REGISTRY, values, [], "Provide IELTS 6.0\nPay the deposit") });
  assert.ok(made.pages >= 2, `pages: ${made.pages}`);
  assert.deepEqual(made.missing, ["course.cricos"]);
  assert.deepEqual([...new Set(made.marks.filter((m) => m.key === "course.cricos").map((m) => m.page))], Array.from({ length: made.pages }, (_, i) => i + 1), "the missing footer variable is marked on every page");
  for (const m of made.marks) assert.ok(m.x >= 0 && m.y >= 0 && m.x + m.w <= 1.0001 && m.y + m.h <= 1.0001 && m.w > 0, JSON.stringify(m));
  const items = await pdfText(made.bytes);
  for (let n = 1; n <= made.pages; n++) {
    const text = items.filter((t) => t.page === n).map((t) => t.text).join(" ");
    for (const expected of ["Skyline Institute of Technology", "RTO 45989 | CRICOS 04114B", `Page ${n} of ${made.pages}`, "Student initials:", "[CRICOS course code]"]) assert.ok(text.includes(expected), `page ${n}: ${expected}`);
  }
  const all = items.map((t) => t.text).join(" ");
  for (const expected of ["O'Neil-Smith (O'NEIL-SMITH), born 12/04/2001, passport N1234567.", "Fees for February 2027", "Tuition AUD$14,500.00", "Total AUD$14,750.00", "1. Provide IELTS 6.0", "2. Pay the deposit"])
    assert.ok(all.includes(expected), expected);
  assert.ok(!/\{\{/.test(all), "no {{token}} is printed");
  // The logo is embedded and drawn on every page (the header repeats).
  const loaded = await PdfLib.PDFDocument.load(made.bytes);
  for (const page of loaded.getPages()) {
    const xobjects = page.node.Resources()?.lookup(PdfLib.PDFName.of("XObject"), PdfLib.PDFDict);
    assert.ok(xobjects && xobjects.keys().length >= 1, "the logo is on the page");
  }
  // The sample preview fills every variable from the registry's samples.
  const sample = await documentPdf.buildDocumentPdf({ title: "x", header, body: "<p>{{student.full_name}} {{course.cricos}}</p>", footer, values: {}, brackets: false,
    curly: letterVars.letterResolver(LETTER_REGISTRY, {}, [], "", true) });
  assert.deepEqual([sample.missing, sample.marks.length], [[], 0]);
  assert.ok((await pdfText(sample.bytes)).map((t) => t.text).join(" ").includes("Ms Asha Rani Patel 0101234"), "sample values print");
});

const letterBlocks = await load.import<typeof import("../supabase/functions/_shared/letter-variables.ts")>("../supabase/functions/_shared/letter-variables.ts");
test("letter {{#if discount}} rows print only for the courses that have a discount", () => {
  const html = "<table><tr><td>{{#each courses}}</td></tr><tr><td>{{course.name}}</td></tr><tr><td>{{#if discount}}</td></tr><tr><td>Discount {{fees.discount_percent}}</td></tr><tr><td>{{/if}}</td></tr><tr><td>{{/each}}</td></tr></table>";
  const two = letterBlocks.expandLetterBlocks(html, 2, { discounts: [true, false] });
  assert.ok(two.includes("Discount {{fees.discount_percent}}"), "the first course keeps its discount row");
  assert.ok(!two.includes("{{fees.discount_percent#1}}"), "the second course has no discount row");
  assert.ok(two.includes("{{course.name#1}}"), "the second course's own variables are still numbered");
  assert.ok(!/#if discount|\{\{\s*\/if\s*\}\}/.test(two), "no markers are left");
  assert.equal((two.match(/<tr>/g) ?? []).length, 3);
  const none = letterBlocks.expandLetterBlocks(html, 2, {});
  assert.ok(!none.includes("Discount"), "without discount information nothing prints");
  assert.equal((none.match(/<tr>/g) ?? []).length, 2);
  const outside = "<p>{{#if discount}}</p><p>Less discount</p><p>{{/if}}</p><p>Total</p>";
  assert.equal(letterBlocks.expandLetterBlocks(outside, 2, { discounts: [false, true] }), "<p>Less discount</p><p>Total</p>");
  assert.equal(letterBlocks.expandLetterBlocks(outside, 1, { discounts: [false] }), "<p>Total</p>");
  assert.ok(letterBlocks.isBlockMarker("#if discount"));
  // Other blocks still resolve on their own after a discount block.
  assert.equal(letterBlocks.expandLetterBlocks("<p>{{#if discount}}</p><p>D</p><p>{{/if}}</p><p>{{#if gst}}</p><p>G</p><p>{{/if}}</p>", 1, { discounts: [true], gst: false }), "<p>D</p>");
});

// OMARA migration agent discovery (2026-11-24). FIXTURE: a trimmed SAVED COPY (fetched 2026-11-24, plain GET) of one public OMARA register
// detail page (ContactID 82da41e4-a252-e311-9402-005056ab0eca), kept only to test the parser offline; it is not a live check.
const OMARA_FIXTURE = `<html><head><title>Registered migration agent details · OMARA Self-Service Portal</title><script>var x = "<label class=\\"resgister-fullname\\">Not this</label>";</script></head><body>
<h1>Registered migration agent details</h1>
<div class="container register-details"><div class="row"><div class="col-sm-8">
 <label class="resgister-fullname">Dharmendrakumar Dilipbhai Patel</label><br/>
 <label class="resgister-label">Migration agent registration number: &nbsp;</label><label class="resgister-value">0956090</label><br/>
 <label class="resgister-label">Current status: &nbsp;</label><label class="resgister-value">Registered</label><br/>
 <label class="resgister-label">Agent most recent registration commenced on </label>
 <label class="resgister-value" id="regDate">
 2025-03-14 01:00 PM
 </label><br/>
 <h3>Contact details</h3><br/>
 <table>
 <tr><td class="label-contact-details"> Business name </td><td> Aussizz Migration and Education Consultants (Melbourne) </td></tr>
 <tr><td> Business address </td><td> Level 1/ 7-9 Elizabeth Street
Melbourne VIC 3000
Australia
 </td></tr>
 <tr><td> Phone </td><td> 61396023435 </td></tr>
 <tr><td> Email address </td><td> <a href="mailto:director@aussizzgroup.com">director@aussizzgroup.com<a> </td></tr>
 <tr><td> Website </td><td> <a id="weburl" href="www.aussizz.com" target="_blank">www.aussizz.com<a> </td></tr>
 </table></div></div>
 <div class="row"><div class="col-sm-12"><h4>Other business associated with this agent</h4></div>
 <div class="col-sm-12"><span>There are no records to display.</span><span>You don't have permissions to view these records.</span></div></div></div>
<label class="label-last-upd">The register of agents was last updated on</label>&nbsp;<label id="lastUpdated">2026-09-16 05:50 AM</label>
</body></html>`;
const omara = await load.import<typeof import("../supabase/functions/_shared/omara.ts")>("../supabase/functions/_shared/omara.ts");
const omaraCore = await load.import<typeof import("../supabase/functions/omara-discovery/core.ts")>("../supabase/functions/omara-discovery/core.ts");
const OMARA_ID = "82da41e4-a252-e311-9402-005056ab0eca";
const omaraUrl = (id: string) => `https://portal.mara.gov.au/search-the-register-of-migration-agents/register-of-migration-agent-details/?ContactID=${id}`;
const AUSSIZZ = { names: ["Aussizz", "Aussizz Group", "Aussizz Migration", "Aussizz Migration and Education Consultants"], website: "aussizz.com" };

test("OMARA (2026-11-24): the saved detail page parses into the official record (MARN, status, commenced, business, branch address, contacts, register date); other businesses withheld", () => {
  const a = omara.parseOmaraDetail(OMARA_FIXTURE, omaraUrl(OMARA_ID.toUpperCase()), "2026-11-24T00:00:00.000Z");
  assert.ok(a);
  assert.deepEqual([a.marn, a.fullName, a.status, a.registrationCommencedAt], ["0956090", "Dharmendrakumar Dilipbhai Patel", "Registered", "2025-03-14T13:00:00.000Z"]);
  assert.deepEqual([a.businessName, a.addressLine, a.suburb, a.state, a.postcode, a.country], ["Aussizz Migration and Education Consultants (Melbourne)", "Level 1/ 7-9 Elizabeth Street", "Melbourne", "VIC", "3000", "Australia"]);
  assert.deepEqual([a.phone, a.email, a.website, a.contactId, a.registerUpdatedAt, a.otherBusinesses, a.disciplinary],
    ["61396023435", "director@aussizzgroup.com", "www.aussizz.com", OMARA_ID, "2026-09-16T05:50:00.000Z", "unavailable", null]);
  assert.equal(a.sourceUrl, omaraUrl(OMARA_ID), "canonical link (lower-case ContactID)");
  assert.equal(omara.parseOmaraDetail("<html><h1>Search for registered migration agents</h1></html>", omaraUrl(OMARA_ID), "x"), null, "not a detail page");
  assert.equal(omara.parseOmaraDetail(OMARA_FIXTURE.replace("0956090", "95609"), omaraUrl(OMARA_ID), "x"), null, "a MARN has 7 digits");
  assert.deepEqual(omara.splitAddress(["227, Findon Road, Findon SOUTH AUSTRALIA 5023", "Australia"]), { addressLine: "227, Findon Road", suburb: "Findon", state: "SA", postcode: "5023", country: "Australia" });
});

test("OMARA: only detail pages on allowed .gov.au hosts are read; ContactIDs deduped; queries capped; matching scores name, website / email domain and location", async () => {
  assert.deepEqual(omara.parseDetailUrl(`${omaraUrl(OMARA_ID)}&x=1`), { contactId: OMARA_ID, url: omaraUrl(OMARA_ID) });
  for (const bad of [omaraUrl(OMARA_ID).replace("https", "http"), omaraUrl(OMARA_ID).replace("portal.mara.gov.au", "portal.mara.gov.au.evil.com"),
    "https://portal.mara.gov.au/search-the-register-of-migration-agents/?ContactID=" + OMARA_ID, omaraUrl("not-a-guid"), "https://evil.example/x", "javascript:alert(1)"]) {
    assert.equal(omara.parseDetailUrl(bad), null, bad);
  }
  assert.deepEqual(omara.allowedHosts(["portal.mara.gov.au", "evil.com", "https://www.mara.gov.au/x"]), ["portal.mara.gov.au", "www.mara.gov.au"]);
  assert.deepEqual(omara.allowedHosts(["evil.com"]), ["portal.mara.gov.au"], "a rule edit cannot point the reader elsewhere");
  const q = omara.buildQueries({ names: ["Aussizz Migration and Education Consultants Pty Ltd"], website: "https://www.aussizz.com/" }, 4);
  assert.equal(q.length, 4);
  assert.ok(q[0].startsWith('site:portal.mara.gov.au "Aussizz Migration and Education Consultants Pty Ltd" "Registered migration agent details"'));
  assert.equal(q[1], 'site:portal.mara.gov.au "aussizz.com"');
  assert.ok(omara.nameVariants(["Aussizz Group Pty Ltd"]).includes("Aussizz"), "legal ending stripped");
  const melb = omara.parseOmaraDetail(OMARA_FIXTURE, omaraUrl(OMARA_ID), "t")!;
  const m = omara.scoreMatch(melb, AUSSIZZ);
  assert.equal(m.confidence, 88);
  assert.deepEqual(m.evidence, ['Business name contains "Aussizz Migration and Education Consultants"', "Same website (aussizz.com)", "Email domain aussizzgroup.com matches the business name"]);
  assert.equal(omara.scoreMatch({ businessName: "OZEE Migration Services", website: "https://OZEEMIGRATION.COM.AU", email: "sumit@ozeemigration.com.au", postcode: "5023", state: "SA", suburb: "" }, AUSSIZZ).confidence, 0,
    "trade words alone (Migration) are not a match");
  assert.equal(omara.scoreMatch(melb, { ...AUSSIZZ, postcode: "3000" }).confidence, 98);
});

test("OMARA: Brave / Tavily request shapes, hits filtered to the register, one GET per page in order with the pause, MARN dedupe, search-only beyond the cap, no key = manual", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const slept: number[] = [];
  const other = "5767a795-f53d-eb11-9450-000d3ad152db";
  const page = (id: string, marn: string) => OMARA_FIXTURE.replace("0956090", marn).replace(OMARA_ID, id);
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith(omara.BRAVE_URL)) return Response.json({ web: { results: [
      { url: omaraUrl(OMARA_ID), title: "Registered migration agent details", description: "Aussizz" },
      { url: omaraUrl(OMARA_ID.toUpperCase()) + "&a=1", title: "dup", description: "" },
      { url: omaraUrl(other), title: "Registered migration agent details", description: "Aussizz Chermside" },
      { url: "https://example.com/aussizz", title: "not the register", description: "" }] } });
    if (String(url) === omara.TAVILY_URL) return Response.json({ results: [{ url: omaraUrl(OMARA_ID), title: "t", content: "c" }] });
    if (String(url) === omaraUrl(OMARA_ID)) return new Response(page(OMARA_ID, "0956090"));
    if (String(url) === omaraUrl(other)) return new Response(page(other, "0956090")); // same MARN on a second ContactID: deduped
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  const opts = { provider: "brave" as const, key: "BSA-test-key-0123456789", fetch: fakeFetch, sleep: async (ms: number) => { slept.push(ms); }, now: () => new Date("2026-11-24T00:00:00Z"),
    maxQueries: 2, maxPages: 20, gapMs: 1000, threshold: 60, allowed: ["portal.mara.gov.au"] };
  const out = await omara.discover(AUSSIZZ, opts);
  const brave = calls.filter((c) => c.url.startsWith(omara.BRAVE_URL));
  assert.equal(brave.length, 2, "capped at maxQueries");
  assert.equal((brave[0].init.headers as Record<string, string>)["X-Subscription-Token"], "BSA-test-key-0123456789");
  assert.match(brave[0].url, /[?&]q=site%3Aportal\.mara\.gov\.au%20%22Aussizz%22/);
  assert.match(brave[0].url, /&count=20$/);
  const pages = calls.filter((c) => c.url.startsWith("https://portal.mara.gov.au"));
  assert.deepEqual(pages.map((c) => c.url), [omaraUrl(OMARA_ID), omaraUrl(other)], "one GET per ContactID, in order");
  assert.equal((pages[0].init.headers as Record<string, string>)["User-Agent"], "Mozilla/5.0 (compatible; SLIT-CMS)");
  assert.ok(slept.every((ms) => ms === 1000) && slept.length === 2, "a pause between searches and between pages");
  assert.equal(out.agents.length, 1, "deduped by MARN");
  assert.equal(out.agents[0].verification, "verified");
  assert.equal(out.pagesFetched, 2);
  // Tavily: POST with include_domains.
  calls.length = 0;
  await omara.discover(AUSSIZZ, { ...opts, provider: "tavily", key: "tvly-abcdefgh12345", maxQueries: 1 });
  const tav = JSON.parse(String(calls[0].init.body));
  assert.deepEqual([calls[0].init.method, tav.api_key, tav.include_domains, tav.max_results], ["POST", "tvly-abcdefgh12345", ["portal.mara.gov.au"], 20]);
  // Page cap: the rest is "found in search, not verified".
  calls.length = 0;
  const capped = await omara.discover(AUSSIZZ, { ...opts, maxQueries: 1, maxPages: 1 });
  assert.deepEqual(capped.agents.map((a) => a.verification).sort(), ["search_only", "verified"]);
  // A refused key stops the searches and is reported.
  const refused = await omara.discover(AUSSIZZ, { ...opts, fetch: (async () => Response.json({ error: { detail: "bad token" } }, { status: 401 })) as unknown as typeof fetch });
  assert.equal(refused.searches, 1);
  assert.match(refused.errors[0], /HTTP 401: bad token/);
  // No key: nothing is searched or fetched.
  calls.length = 0;
  const none = await omara.discover(AUSSIZZ, { ...opts, key: null });
  assert.deepEqual([none.configured, calls.length], [false, 0]);

  // The Edge Function core: admins only, no key -> configured false (manual), discovered records saved, run recorded with the cost.
  const service: [string, Record<string, unknown>][] = [];
  const ports = (o: { admin?: boolean; key?: string | null } = {}) => ({
    isAdmin: async () => o.admin ?? true, callerId: async () => "00000000-0000-0000-0000-000000000001",
    rpc: async (fn: string) => fn === "business_rule_values" ? { data: { "omara.max_search_queries": 1, "omara.request_gap_ms": 10 }, error: null } : { data: { linked: 1 }, error: null },
    service: async (fn: string, args: Record<string, unknown>) => { service.push([fn, args]); return fn === "integration_search_api_key" ? (o.key === undefined ? "BSA-test-key-0123456789" : o.key) : "run-1"; },
    agentsByContact: async () => [], agentByMarn: async () => null, agencyFacts: async () => null,
    fetch: fakeFetch, sleep: async () => {}, now: () => new Date("2026-11-24T00:00:00Z"),
  });
  await assert.rejects(omaraCore.handle({ action: "discover", names: ["Aussizz"] }, ports({ admin: false })), /Only administrators/);
  const manual = await omaraCore.handle({ action: "discover", names: ["Aussizz"] }, ports({ key: null }));
  assert.deepEqual([manual.configured, (manual.agents as unknown[]).length], [false, 0]);
  service.length = 0;
  const found = await omaraCore.handle({ action: "discover", names: ["Aussizz"], website: "aussizz.com" }, ports());
  assert.equal((found.agents as unknown[]).length, 1);
  assert.ok(service.some(([fn, a]) => fn === "omara_agent_upsert" && (a.p as { marn: string }).marn === "0956090"));
  const run = service.find(([fn]) => fn === "omara_discovery_run_record")![1].p as Record<string, unknown>;
  assert.deepEqual([run.provider, run.estCostUsd, run.pagesFetched], ["brave", 0.005, 2]);
  assert.equal(omaraCore.settingsFrom({ "omara.request_gap_ms": 10 }).gapMs, 500, "never faster than 500 ms");
  // Pasted links: only OMARA detail pages; no search is made.
  calls.length = 0;
  const imported = await omaraCore.handle({ action: "import_urls", urls: [omaraUrl(OMARA_ID), "https://example.com/x"], names: ["Aussizz"] }, ports());
  assert.deepEqual([(imported.agents as unknown[]).length, (imported.rejected as string[]).length], [1, 1]);
  assert.ok(calls.every((c) => !c.url.startsWith(omara.BRAVE_URL)));
  // These agents are never SLIT education agents: nothing here writes public.agents.
  assert.ok(!/from\("agents"\)|\.from\('agents'\)|insert into public\.agents/.test(read("supabase/functions/omara-discovery/index.ts") + read("supabase/functions/omara-discovery/core.ts") + read("supabase/functions/_shared/omara.ts")));
  assert.ok(read("src/pages/admin/components/OmaraAgentsPanel.tsx").includes("not for marketing"));
  assert.ok(read("supabase/config.toml").includes("[functions.omara-discovery]\n# OMARA-DISCOVERY") && /\[functions\.omara-discovery\][\s\S]*?verify_jwt = true/.test(read("supabase/config.toml")));
});

test("Business Documents tab (2026-11-24): upload / view / resend / change email checked and logged in the database, never a certificate", () => {
  const sql = read("supabase/migrations/20261124203517_business_document_actions.sql").replace(/\r\n/g, "\n");
  // Every new staff function starts with the SLIT administrator check (server-side, not hidden buttons).
  for (const fn of ["admin_business_document_add", "admin_business_document_status", "admin_business_resend_prepare", "admin_business_signed_copy_logged", "admin_business_contact_email_change"]) {
    const body = sql.slice(sql.indexOf(`function public.${fn}(`));
    assert.match(body.slice(0, 1500), /perform public\.admin_business_require\(\);/, `${fn} checks the administrator`);
  }
  assert.match(sql, /check \(kind in \('agent_agreement', 'id', 'insurance', 'other'\)\)/);
  for (const event of ["document_uploaded", "application_resent", "signed_copy_sent", "email_changed"]) assert.ok(sql.includes(`'${event}'`), `event ${event} logged`);
  // Resend: same request (no new one), expired link rotated, cooldown from a Business Rule; the signed copy never includes a certificate.
  assert.ok(!/insert into hr\.sign_requests/.test(sql) && sql.includes("delete from hr.sign_tokens where recipient_id = c.id"));
  assert.ok(sql.includes("'agents.document_resend_cooldown_minutes'") && sql.includes("Sent a moment ago."));
  const edge = read("supabase/functions/document-signing/onboarding.ts");
  const resend = edge.slice(edge.indexOf("export async function resendBusinessApplication"), edge.indexOf("export async function changeBusinessContactEmail"));
  assert.ok(resend.includes('"form"') && resend.includes('"agreement"') && !/certificate"|certificate_content/.test(resend));
  // Change email: unique among agents only; the login moves first and back again if the database refuses.
  assert.match(sql, /'This email is already in use'/);
  assert.ok(!/from public\.(students|enrollment_students|cms_users) [a-z]+ where lower/.test(sql.slice(sql.indexOf("admin_business_contact_email_change"))));
  const change = edge.slice(edge.indexOf("export async function changeBusinessContactEmail"));
  assert.ok(change.indexOf("p_apply: false") < change.indexOf("changeEmail(check.authUserId, check.new)") && change.includes("changeEmail(check.authUserId!, check.old)"));
  assert.ok(read("supabase/functions/document-signing/index.ts").includes("updateUserById(authUserId, { email, email_confirm: true })"));
  // Screens: 60-second links, View only for PDF / pictures, the bucket's types and size checked first, every certificate kind still refused by the RPC.
  const data = read("src/pages/admin/lib/businessData.ts");
  assert.ok(data.includes("createSignedUrl(path, 60,") && data.includes('["pdf", "png", "jpg", "jpeg"].includes(extensionOf(name))'));
  for (const ext of ["pdf", "png", "jpg", "jpeg", "doc", "docx"]) assert.ok(data.includes(`${ext}: "`), ext);
  const ui = read("src/pages/admin/components/BusinessDocumentActions.tsx");
  assert.ok(ui.includes("Resend application") && ui.includes("Email signed copy") && ui.includes("Last sent") && ui.includes("Other documents") && ui.includes('aria-label="Change email"'));
  assert.ok(read("src/pages/admin/lib/agentOnboarding.ts").includes("export async function viewOnboardingFile"));
});

test("Business Documents tab: Send for signature to the business (agency admin filled in as the signer; one-time PDF when no agency template)", () => {
  const tab = read("src/pages/admin/components/BusinessOnboarding.tsx");
  assert.ok(tab.includes('<SubjectSigningPanel type="agency" id={business.id}') && tab.includes("alsoAgentId={contact?.agentId}") && tab.includes('buttonLabel="Send for signature"'));
  const panel = read("src/pages/admin/components/signing/SubjectSigningPanel.tsx");
  assert.ok(panel.includes('setSource(list.some((t) => t.status === "active" && t.kind !== "email" && (t.audience === "any" || t.audience === type)) ? "template" : "upload")'));
  assert.ok(panel.includes('initialSource={source}') && read("src/pages/admin/components/signing/ComposeRequest.tsx").includes('useState<"template" | "upload">(initialSource)'));
  // The signer fills in from the record (subject_values), so nobody types the agency admin's email.
  assert.ok(read("src/pages/admin/components/signing/ComposeRequest.tsx").includes("i === 0 && !r.name && !r.email ? { ...r, name: s.name, email: s.email } : r"));
});

test("Portal: the business admin agent invites their own agents (Users › Your agents); Onboarding agents of an active business can be invited, Inactive cannot", () => {
  const sql = read("supabase/migrations/20261124213517_portal_agent_invites.sql").replace(/\r\n/g, "\n");
  assert.match(sql, /elsif c->>'role' = 'agency_admin' then v_agency := \(c->>'agencyId'\)::uuid;\n else raise exception 'Only the business admin agent can invite agents\.'/);
  assert.ok(sql.includes("g.status in ('Inactive', 'Declined')") && sql.includes("where business_id = v_agency and email = v_email and status = 'Onboarding'"));
  // The business must still be operational (signed agreement) before anyone is invited.
  assert.ok(sql.includes("public.agency_effective_status(a) = 'Active'") && sql.includes("hint = 'business_not_operational'"));
  assert.ok(sql.includes("and (inv.invited_by = p_actor or inv.role in ('agent', 'agency_admin'))"));
  const data = read("src/pages/agency/lib/portalData.ts");
  assert.ok(data.includes('if (a.hasLogin) return { label: "Active"') && data.includes('return { label: "Not invited", tone: "warn", action: "invite" }'));
  assert.ok(read("src/pages/agency/users/page.tsx").includes("{!isSlit ? <BusinessAgentInvites"));
});

test("Agent status (2026-11-24): Active only once the agent has created a password; Invited while the invitation waits; Not invited otherwise", async () => {
  const src = read("src/pages/admin/lib/businessData.ts");
  const fn = src.slice(src.indexOf("export function agentSignInStatus"), src.indexOf("export function awaitingPassword"));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const agentSignInStatus = new Function("agent", fn.replace(/^export function agentSignInStatus\([^)]*\)[^{]*\{/, "").replace(/\}\s*$/, "").replace(/ as AgentStatus/g, "")) as (a: Record<string, unknown>) => string;
  assert.equal(agentSignInStatus({ status: "Active", profileId: "p1", invitationId: null }), "Active");
  assert.equal(agentSignInStatus({ status: "Active", profileId: null, invitationId: "i1" }), "Invited");
  assert.equal(agentSignInStatus({ status: "Invited", profileId: null, invitationId: "i1" }), "Invited");
  assert.equal(agentSignInStatus({ status: "Active", profileId: null, invitationId: null }), "Not invited");
  for (const s of ["Inactive", "Onboarding", "Declined"]) assert.equal(agentSignInStatus({ status: s, profileId: null, invitationId: "i1" }), s);
  for (const f of ["src/pages/admin/BusinessDetailPage.tsx", "src/pages/admin/AgentsPage.tsx", "src/pages/admin/AgentDetailPage.tsx"]) assert.ok(read(f).includes("agentSignInStatus("), f);
  assert.ok(!read("src/pages/admin/BusinessDetailPage.tsx").includes('r.status === "Invited" && business.status === "Active" ? "Active"'), "Invited is no longer shown as Active");
});

test("Portal: the business admin agent deactivates / reactivates their agents; SLIT too; the agent record follows a portal sign-in switched off", () => {
  const sql = read("supabase/migrations/20261124223517_portal_agent_deactivate.sql").replace(/\r\n/g, "\n");
  assert.ok(sql.includes("raise exception 'You can only manage agents of your own business.'") && sql.includes("raise exception 'You cannot change your own access.'")
    && sql.includes("raise exception 'Only SLIT can change another business admin agent.'"));
  // Inactive switches off the record, the sign-in and the waiting invitation (as the CMS Deactivate does).
  assert.ok(sql.includes("update public.agency_invitations set status = 'revoked'") && sql.includes("update public.agency_memberships set status = p_status"));
  assert.ok(sql.includes("where profile_id = p_profile and business_id = m.agency_id and status in ('Active', 'Inactive') and status <> v_status"));
  const ui = read("src/pages/agency/components/BusinessAgentInvites.tsx");
  assert.ok(ui.includes('a.role === "agent" && a.email.toLowerCase() !== myEmail') && ui.includes('"Deactivate" : "Reactivate"'));
  // The invitation link opens the workspace's own page, where the agent creates their password.
  assert.ok(read("supabase/functions/portal-admin-users/index.ts").includes("/agency/accept-invite#t=${token}"));
});

test("Students (2026-11-24): the finish-application link asks for a password; agents, business admin agents and SLIT invite a student to the portal", () => {
  const sql = read("supabase/migrations/20261124233517_student_portal_invite.sql").replace(/\r\n/g, "\n");
  assert.ok(sql.includes("create or replace function public.portal_my_password_set()") && sql.includes("u.encrypted_password"));
  // An agent may invite only their own student (role student); the helper is internal.
  assert.ok(sql.includes("c->>'role' = 'agent' and p_role = 'student' and public.portal_student_is_mine(p_actor, p_student)"));
  assert.ok(sql.includes("revoke all on function public.portal_student_is_mine(uuid, uuid) from public, anon, authenticated;"));
  assert.ok(sql.includes("c->>'role' = 'agent' and inv.role = 'student'"));
  // Active only once the student has created a password.
  assert.ok(sql.includes("case when coalesce(v_pw, false) then 'active' else 'no_password' end"));
  const fn = read("supabase/functions/portal-admin-users/index.ts");
  assert.ok(fn.includes('ctx?.role === "agent" && ((action === "invite" && parsed.role === "student") || action === "resend")'));
  // Since 2026-11-26 the password is created at the signature (SignPasswordFields, portal_my_password_set via hasPortalLogin).
  const signPw = read("src/pages/agency/components/ApplicationHandoff.tsx") + read("src/pages/agency/lib/handoff.ts");
  assert.ok(signPw.includes('supabase.rpc("portal_my_password_created")') && signPw.includes("supabase.auth.updateUser({ password: value.password })") && signPw.includes("passwordProblem(next, again)"));
  const detail = read("src/pages/agency/applications/detail/page.tsx");
  assert.equal((detail.match(/<StudentPortalInvite /g) ?? []).length, 2, "both the incomplete and the full application views");
  const ui = read("src/pages/agency/components/StudentPortalInvite.tsx");
  assert.ok(ui.includes('action: "invite", role: "student", studentId') && ui.includes("portalPasswordResetUrl()"));
});

test("Employees list (2026-11-24): a Sign-in column; Can sign in only once a password is chosen; active staff without one get Send / Resend sign-in link", () => {
  const page = read("src/pages/admin/StaffPage.tsx");
  assert.ok(page.includes('"Status", "Sign-in", "Actions"]') && page.includes("<EmployeeSignIn row={r}"));
  assert.ok(page.includes('if (r.hasLogin && r.passwordSet) return { label: "Can sign in"') && page.includes('return { label: "Not invited", tone: "muted" }'));
  assert.ok(page.includes('row.status === "active" && !(row.hasLogin && row.passwordSet)') && page.includes("staffAdminActions.inviteLogin(row.id)"));
});

test("Staff offer first (2026-11-24): Full time / Part time letters, offer before documents, accept or decline, documents after signing", () => {
  const sql = read("supabase/migrations/20261124235517_staff_offer_full_part_time.sql").replace(/\r\n/g, "\n");
  assert.ok(sql.includes("('Staff Offer Letter - Full time', 'Full time'") && sql.includes("('Staff Offer Letter - Part time', 'Part time'"));
  assert.ok(sql.includes("Run 20261124001517_staff_offer_variables first"));
  assert.ok(sql.includes("or (p_from in ('applied', 'invited') and p_to = 'offer_sent') or (p_from = 'offer_sent' and p_to = 'invited')"));
  assert.ok(sql.includes("if p.status not in ('applied', 'invited', 'documents_submitted') then raise exception 'Offer details are added"));
  assert.ok(sql.includes("create or replace function public.hr_svc_offer_decline") && sql.includes("update hr.staff_profiles set status = 'rejected' where id = p.id;"));
  assert.ok(sql.includes("else v_status in ('invited', 'offer_signed') end") && sql.includes("if p.status = 'invited' then update hr.staff_profiles set status = 'documents_submitted'"));
  assert.ok(sql.includes("create or replace function public.hr_svc_staff_documents_link") && sql.includes("grant execute on function public.hr_svc_staff_documents_link(uuid, text) to service_role;"));
  const onboarding = read("supabase/functions/staff-onboarding/core.ts");
  assert.ok(onboarding.includes('case "offer_decline"') && onboarding.includes('if (action === "documents_link") return documentsLink(req, deps);'));
  const admin = read("supabase/functions/staff-admin/core.ts");
  assert.ok(admin.includes('if (body.offerFirst === true) return') && admin.includes('["applied", "invited", "documents_submitted", "offer_sent"].includes'));
  assert.ok(read("src/pages/staff/components/OfferPanel.tsx").includes("api.decline(reason.trim())"));
  assert.ok(read("src/pages/staff/StaffHomePage.tsx").includes("{me.status === \"offer_signed\" ? <DocumentsWizardButton /> : null}"));
  assert.ok(read("src/pages/admin/components/EmployeeFormDialog.tsx").includes("offerFirst: true"));
});

test("Offer declined (2026-11-24): HR is emailed with the person's reason", () => {
  const sql = read("supabase/migrations/20261124235917_offer_declined_email.sql").replace(/\r\n/g, "\n");
  assert.ok(sql.includes("'admin_offer_declined']::text[]") && sql.includes("perform hr.queue_email(p.id, 'admin_offer_declined', 'admin'"));
  assert.ok(hrMail.DRAINABLE_KINDS.includes("admin_offer_declined"));
  const mail = hrMail.renderHrEmail("admin_offer_declined", { name: "Ann Lee", email: "ann@example.test", reason: "Took another role" }, { siteUrl: "https://site.example", profileId: "p-1" } as never)!;
  assert.equal(mail.subject, "Ann Lee declined the offer");
  assert.ok(mail.text.includes("Reason: Took another role") && mail.text.includes("https://site.example/admin/staff/employees/p-1"));
  assert.ok(hrMail.renderHrEmail("admin_offer_declined", { name: "Ann", email: "a@x.test" }, {} as never)!.text.includes("Reason: none given"));
  assert.ok(read("supabase/functions/staff-onboarding/index.ts").includes('action === "offer_decline") && result.status === 200'));
});

test("Offer before documents fix (2026-11-24): the letter is made from Applied / Invited without approved documents", () => {
  const sql = read("supabase/migrations/20261125000517_offer_before_documents_fix.sql").replace(/\r\n/g, "\n");
  assert.ok(sql.includes("v_problem := case when v_status in ('applied', 'invited') then hr.onboarding_pay_problem(p_id)"));
  assert.ok(sql.includes("if p.status not in ('applied', 'invited', 'documents_submitted') then raise exception 'Prepare an offer"));
  assert.ok(read("supabase/functions/staff-admin/core.ts").includes('if (!["applied", "invited", "documents_submitted"].includes(String((before.data'));
});

test("Offer signatures (2026-11-24): CEO signature and date under the closing line, the employee's drawn signature on the signed copy", () => {
  const letter = read("supabase/functions/_shared/offer-letter-pdf.ts");
  assert.ok(letter.includes("CLOSING.test(") && letter.includes("image: signature }, { spans: [{ text: `Date: ${date}` }]"));
  assert.ok(read("supabase/functions/staff-admin/index.ts").includes("signature: await signatorySignature(service, signatory)"));
  assert.ok(read("supabase/functions/_shared/letterhead.ts").includes("export async function signatorySignature("));
  const onboarding = read("supabase/functions/staff-onboarding/core.ts");
  assert.ok(onboarding.includes("const image = drawnSignature(req.fields.signature);") && onboarding.includes("offerSha256: file.sha256, image });"));
  assert.ok(read("supabase/functions/_shared/offer-pdf.ts").includes('label: "Employee signature"'));
  assert.ok(read("src/pages/staff/StaffOnboardingPage.tsx").includes("<SignaturePad onChange={setSignImage} />"));
  assert.ok(read("src/pages/staff/components/OfferPanel.tsx").includes("api.sign(name.trim(), signature)"));
  assert.ok(read("supabase/migrations/20261125003517_offer_signatory_ceo.sql").includes("('hrms.offer_signatory_name', 'Hardik Amin')"));
  // The signed copy also goes to the admin who sent the offer and to the signatory (owner: "Admin and hardik all").
  assert.ok(read("supabase/functions/_shared/hr-mail-drain.ts").includes('service.rpc("hr_svc_offer_mail_people", { p_offer: offerId })'));
  assert.ok(read("supabase/functions/_shared/hr-mail.ts").includes("...extra.map((a) => a.trim().toLowerCase()).filter((a) => EMAIL.test(a))"));
  assert.ok(read("supabase/migrations/20261125004517_offer_signed_copy_people.sql").includes("join public.cms_users u on u.auth_user_id = o.sent_by"));
});

test("Offer signed last (2026-11-24): Accept and continue opens the wizard; its last screen signs the offer and submits", () => {
  const sql = read("supabase/migrations/20261125001517_offer_sign_after_documents.sql").replace(/\r\n/g, "\n");
  assert.ok(sql.includes("else v_status in ('invited', 'offer_sent', 'offer_signed') end"));
  assert.ok(sql.includes("raise exception 'Add your details and documents first; you sign the offer on the last screen.'"));
  assert.ok(sql.includes("elsif p.status = 'offer_sent' then return jsonb_build_object('purpose', 'sign');"));
  assert.ok(read("supabase/functions/staff-onboarding/core.ts").includes('?.purpose === "sign") return { status: 200, body: { purpose: "sign" } };'));
  const panel = read("src/pages/staff/components/OfferPanel.tsx");
  assert.ok(panel.includes('data-testid="offer-accept-continue"') && panel.includes("window.location.assign(`/staff/onboard#t=${link.token}`)"));
  const wizard = read("src/pages/staff/StaffOnboardingPage.tsx");
  assert.ok(wizard.includes('const signsOffer = view.status === "offer_sent";') && wizard.includes("await myOfferApi.sign(signName.trim(), signImage)") && wizard.includes('"Sign the offer and submit"'));
  assert.ok(read("src/pages/staff/StaffHomePage.tsx").includes("acceptViaWizard"));
});

test("Employees Active / Inactive (2026-11-24): Delete with the same confirmation as the other tabs", () => {
  const page = read("src/pages/admin/StaffPage.tsx");
  assert.ok(page.includes('"Status", "Sign-in", "Actions"]') && page.includes("data-testid={`employee-delete-${r.id}`}"));
  assert.ok(page.includes("setDeleting({ id: r.id, name: [r.firstName, r.lastName].filter(Boolean).join(\" \"), email: r.email })"));
});

test("Birth country from the passport (2026-11-25): Were you born in {issuing country}? Yes = that AVETMISS label, No = a searched country, not the passport's", async () => {
  const lib = await load.import<typeof import("../src/pages/agency/lib/birthCountry.ts")>("../src/pages/agency/lib/birthCountry.ts");
  // avetmiss_code_search('country', 'India', 5) and an alias hit, as Postgres returned them for the migration's codes.
  assert.equal(lib.pickPassportCountry("India", [{ code: "7103", label: "India" }]), "India");
  assert.equal(lib.pickPassportCountry("india", [{ code: "7103", label: "India" }, { code: "9999", label: "British Indian Ocean Territory" }]), "India");
  assert.equal(lib.pickPassportCountry("Turkey", [{ code: "4215", label: "Türkiye" }]), "Türkiye", "the only hit (alias)");
  assert.equal(lib.pickPassportCountry("Korea", [{ code: "6202", label: "Korea, Democratic People's Republic of (North)" }, { code: "6203", label: "Korea, Republic of (South)" }]), "", "unsure: the search field only");
  assert.equal(lib.pickPassportCountry("", [{ code: "7103", label: "India" }]), "");
  const field = read("src/pages/agency/components/BirthCountryField.tsx"), wizard = read("src/pages/agency/components/ApplicationWizard.tsx"), steps = read("src/pages/agency/components/WizardFinishSteps.tsx");
  assert.ok(read("src/lib/countrySearch.ts").includes('supabase.rpc("avetmiss_code_search", { p_set: "country", p_query: query, p_limit: limit })'));
  assert.ok(field.includes('if (answer === "Yes") onChange("birth_country", label);') && field.includes('else if (value === label) onChange("birth_country", "");'), "Yes sets the label, No starts empty");
  assert.ok(field.includes("{!label || born === \"No\" ? ("), "the search shows on No, or without a passport country");
  assert.ok(!wizard.includes('fill("birth_country", next.citizenship'), "no longer copied from the citizenship");
  assert.ok(wizard.includes('errors[BORN_IN_PASSPORT_COUNTRY] = "Choose Yes or No."') && wizard.includes('filled("birth_country") === passportLabel'));
  assert.ok(steps.includes("<BirthCountryField passportCountry={passportCountry}") && !steps.includes('select("birth_country"'));
});

test("Residency after the passport (2026-11-25): AU / NZ Domestic (no question, no visa), PR Yes -> PR evidence, PR No -> the visa screen (in / out of Australia not asked)", async () => {
  const r = await load.import<typeof import("../src/pages/agency/lib/residency.ts")>("../src/pages/agency/lib/residency.ts");
  assert.ok(r.isDomesticPassport("Australia") && r.isDomesticPassport("new zealand") && !r.isDomesticPassport("India"));
  assert.equal(r.visaNeed("Australia", ""), "none");
  assert.equal(r.visaNeed("New Zealand", "Yes"), "none", "domestic ignores a stale answer");
  assert.equal(r.visaNeed("India", "Yes"), "pr");
  assert.equal(r.visaNeed("India", "No"), "visa", "not PR: the visa screen to get the status");
  assert.equal(r.visaNeed("India", ""), "none", "unanswered: held on the passport screen");
  assert.equal(r.visaNeed("", ""), "none");
  assert.ok(r.residencyAnswered("Australia", "") && r.residencyAnswered("India", "Yes") && r.residencyAnswered("India", "No"));
  assert.ok(!r.residencyAnswered("India", "") && !r.residencyAnswered("", ""), "an unread passport country is asked too");
  assert.equal(r.PR_ANSWER, "au_permanent_resident");
  assert.equal(r.studentKind("India", "Yes"), "domestic", "PR = domestic");
  assert.equal(r.studentKind("India", "No"), "international");
  assert.equal(r.studentKind("Australia", ""), "domestic");
  assert.equal(r.studentKind("India", ""), "");
  assert.ok(!r.notPermanentSubclass("189") && !r.notPermanentSubclass("") && r.notPermanentSubclass("500") && r.notPermanentSubclass("Subclass 485"), "PR evidence: 500 / 485 flagged");
  const wizard = read("src/pages/agency/components/ApplicationWizard.tsx"), ui = read("src/pages/agency/components/WizardResidency.tsx");
  assert.ok(ui.includes("Are you an Australian permanent resident?") && !ui.includes("Are you currently in Australia?"), "the in-Australia question is gone");
  assert.ok(wizard.includes('need === "pr" || (need === "visa" && Boolean(item.required))'), "PR evidence required; the visa as the Business Rule says");
  assert.ok(wizard.includes("if (skipStep(ALL_STEPS[next]) && next !== step)"), "the visa step is passed over when not needed");
  assert.ok(wizard.includes("values[PR_ANSWER] = pr;") && !wizard.includes("au_currently_in_australia") && !wizard.includes("VisaDetails"));
  assert.ok(!wizard.includes("issuing_country:"), "issuing_country is saved as before (not written by the wizard)");
  assert.ok(wizard.includes('defaultLoad={kind === "international" ? "coe" : undefined}') && read("src/pages/agency/components/IntakeSelect.tsx").includes("(defaultLoad && loadsOffered.includes(defaultLoad) ? defaultLoad : null)"), "international: CoE chosen to start with");
  const steps = read("src/pages/agency/lib/wizardConfig.ts").split("export const WIZARD_STEPS")[1].split("];")[0];
  assert.deepEqual([...steps.matchAll(/\n    id: "(\w+)"/g)].map((m) => m[1]).slice(0, 2), ["passport", "visa"], "the visa screen follows the passport");
  assert.ok(ui.includes("a <strong>domestic</strong> student") && ui.includes("The course is offered as <strong>CoE</strong>") && ui.includes("upload the current Australian visa grant notice"));
});

test("Full form country of birth (2026-11-25): the same AVETMISS country search as the wizard, in a hidden form input; no copy from citizenship", () => {
  const form = read("src/pages/agency/components/ApplicationWorkspace.tsx"), search = read("src/components/shared/CountrySearch.tsx"), field = read("src/pages/agency/components/BirthCountryField.tsx");
  assert.ok(form.includes('field.name === "birth_country" ? (') && form.includes("<FormCountrySearch id={`${FORM_ID}-${field.name}`} name={field.name}"));
  assert.ok(!form.includes("birth_country: String(values.citizenship"), "no longer copied from citizenship");
  assert.ok(search.includes('<input ref={hidden} type="text" hidden tabIndex={-1}') && !search.includes("hidden readOnly"), "required check stays on (readOnly would bar it)");
  assert.ok(search.includes('input.addEventListener("change", sync)'), "values restored into the form show in the box");
  assert.ok(field.includes('import CountrySearch from "@/components/shared/CountrySearch";'), "the wizard uses the same search");
  assert.ok(read("src/lib/countrySearch.ts").includes('supabase.rpc("avetmiss_code_search", { p_set: "country"'));
});

test("Funding onshore only (2026-11-25): AVETMISS funding source 32 (offshore) switched off and refused; visa holders default to 31", () => {
  const sql = read("supabase/migrations/20261125160517_funding_onshore_only.sql");
  assert.ok(sql.includes("set is_active = false\n where code_set = 'funding_source' and code = '32'"));
  assert.ok(sql.includes("intake_enrolments_funding_onshore_only check (funding_source_code is distinct from '32')"));
  assert.ok(sql.includes("lms_unit_students_funding_onshore_only check (funding_source_code is distinct from '32')"));
  assert.ok(read("src/lib/avetmissCodes.ts").includes("all.filter((c) => c.is_active || c.code === current)"), "inactive codes are not offered");
});

test("AVETMISS unit location from the timetable (2026-11-25, 20261125153850): most face-to-face scheduled hours, theory first on a tie, then batch room, then intake classroom; manual locations kept; Results shows the source", () => {
  const sql = read("supabase/migrations/20261125153850_avetmiss_location_from_class_sessions.sql").replace(/\r\n/g, "\n");
  // a) the timetable: the student's batch sessions for that intake + unit, scheduled, face to face, in a room with a location
  assert.ok(sql.includes("where s.intake_id = p_intake and s.unit_id = p_unit\n       and s.status = 'scheduled' and s.delivery = 'face_to_face'"), "cancelled and online sessions are ignored");
  assert.ok(sql.includes("join classrooms c on c.id = s.room_id and c.location_id is not null"));
  assert.ok(sql.includes("order by sum(secs) desc, bool_or(session_type = 'theory') desc, location_id"), "most hours, then theory, then location_id");
  // b) then the batch's room, c) then the intake's classroom, in that order inside one coalesce
  const order = ["from sessions", "join intake_batches b on b.id = mb.batch_id", "join classrooms c on c.id = ci.classroom_id"].map((s) => sql.indexOf(s));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], "timetable, then batch room, then intake classroom");
  // statement-level triggers with transition tables; manual locations never overwritten
  for (const op of ["ins", "upd", "del"]) assert.ok(sql.includes(`CREATE TRIGGER class_sessions_avetmiss_location_${op} AFTER `) && sql.includes(`FOR EACH STATEMENT EXECUTE FUNCTION class_sessions_avetmiss_location_${op}()`), `${op} trigger per statement`);
  assert.ok(sql.includes("REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows"), "the update trigger sees old and new rooms");
  assert.equal(sql.split("(u.location_id is null or u.location_is_auto)").length - 1, 3, "each trigger touches automatic or empty locations only");
  assert.ok(sql.trimEnd().endsWith("where u.location_id is null or u.location_is_auto;"), "the backfill at the end skips manual locations");
  // Behaviour is proven by the SQL suite on the installed code (U1 60 h / 40 h, equal hours, fallbacks, cancelled / online, moves).
  const suite = read("supabase/tests/avetmiss_unit_location.sql");
  assert.ok(suite.includes("select plan(17);") && suite.includes("pg_get_functiondef(r.oid)") && suite.includes("'a manual location is not overwritten on update'"));
  // Results page: the source of a saved location, the empty choice goes back to automatic, manual override unchanged.
  const page = read("src/pages/admin/lms/LmsResultsPage.tsx");
  assert.ok(page.includes("From timetable</>") && page.includes("Set by hand</>") && page.includes('const AUTO_LOCATION = "Automatic (from timetable)";'));
  assert.ok(page.includes('edit(r, { locationId: e.target.value })'), "a picked location is still saved (and made manual by the database)");
  const rpc = read("supabase/migrations/20261125180517_avetmiss_unit_results_location_auto.sql");
  assert.ok(rpc.includes("'locationIsAuto', coalesce(l.location_is_auto, false),") && !/alter table/i.test(rpc), "the flag is returned, no column added");
});

test("Agent fills, student signs (2026-11-25, 20261125190517): only the student (or a guardian for under 18) consents and submits; agents send it to the student", () => {
  const sql = read("supabase/migrations/20261125190517_application_student_signs.sql").replace(/\r\n/g, "\n");
  // Server: submit and resubmit refuse anyone but the student's own portal account; each declaration recorded with its text hash.
  assert.ok(sql.includes("if not skyline_private.is_application_student(a.id) then\n  raise exception 'Only the student can sign and submit this application."));
  assert.ok(sql.includes("raise exception 'Only the student can sign and resubmit this application."));
  assert.ok(sql.includes("signer_role, signer_user_id, declaration_key, text_version, text_hash, ip, user_agent, guardian_name, guardian_relationship, guardian_email"));
  assert.ok(sql.includes("new.hash := encode(sha256(convert_to(new.body, 'UTF8')), 'hex')"), "the hash is made from the stored text, never supplied");
  // Locks: the agent is view-only while the student has it; every save path goes through portal_lock_draft / portal_can_edit_application.
  assert.ok(sql.includes("and not skyline_private.handoff_blocks_edit(app_id);") && sql.includes("if skyline_private.handoff_blocks_edit(a.id) then"));
  assert.ok(sql.includes("'Your agent set the agency, course, intake and fees. Use Request a change to ask for a change'"));
  // Invites need a portal account (password or Google), and the daily limit is now exact.
  assert.ok(sql.includes("if coalesce(u.encrypted_password, '') = '' and not exists(select 1 from auth.identities d where d.user_id = u.id and d.provider = 'google'"));
  assert.ok(sql.includes("and created_at >= statement_timestamp() - interval '1 day') >= send_limit then"));
  // Under 18: the guardian verifies a code (5 tries, 10 minutes) and signs; then the application is submitted.
  assert.ok(sql.includes("then 'waiting_guardian' else state end") && sql.includes("clock_timestamp() + interval '10 minutes'") && sql.includes("if c.attempts >= 5 then"));
  // Frontend: no agent consent ticks or consent uploads left in the submit path; agents send to the student.
  const review = read("src/pages/agency/components/ApplicationReview.tsx");
  assert.ok(!review.includes("authorised to submit it on the student") && review.includes("<DeclarationTicks who=\"student\""));
  const workspace = read("src/pages/agency/components/ApplicationWorkspace.tsx");
  assert.ok(!workspace.includes("uploadConsentDocument(") && workspace.includes("await sendApplicationInvitation(application.id);"));
  const wizard = read("src/pages/agency/components/ApplicationWizard.tsx");
  assert.ok(!wizard.includes('method: "electronic", confirmed: true, authorised: true') && wizard.includes("declarationConsent(declarationsRef.current.ticked)"));
  assert.ok(read("src/router/config.tsx").includes('{ path: "/guardian-sign", element: <GuardianSignPage /> }'));
  // The lab suite proves the behaviour (agent / admin / staff refused, locks, take back, change request, diff, guardian, expired links).
  assert.ok(read("supabase/tests/application_student_signs.sql").includes("select plan(67);"));
});

test("Invite link (2026-11-26, 20261126090517): an existing account signs in (Forgot password); a first-time email starts as a guest and creates the password at the signature", () => {
  const sql = read("supabase/migrations/20261126090517_application_invite_guest_start.sql");
  assert.ok(read("supabase/migrations/20261126110517_invite_returning_student.sql").includes("'account', case when u.id is not null and skyline_private.student_account_established(u.id, s.id) then 'login' else 'new' end"), "sign-in only for a student who made their own password or submitted before");
  assert.ok(!sql.includes("raise exception 'Create your password (or sign in with Google) before opening the application'"), "accept no longer needs a password");
  assert.ok(sql.includes("raise exception 'Create your password before signing, so you can sign in to your SLIT account later'"));
  const fn = read("supabase/functions/student-application-invite/index.ts");
  assert.ok(fn.includes('if (found.account !== "new") return json({ error: "This email already has a SLIT account. Sign in to continue." }, 409);'), "never a link-only sign-in to an existing account");
  const page = read("src/pages/agency/application-invite/page.tsx");
  assert.ok(page.includes('check.account === "login"') && page.includes("Forgot password?") && page.includes("Start my application"));
  assert.ok(read("src/pages/agency/components/ApplicationWizard.tsx").includes("await saveSignPassword(signPasswordRef.current);"));
  assert.ok(read("supabase/tests/application_student_signs.sql").includes("select plan(67);"));
});
