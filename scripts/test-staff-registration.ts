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
  assert.match(sent[0].subject, /^Please sign/); assert.equal(sent[1].attachments?.length, 2);
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
  assert.deepEqual(acts("applied"), ["send_documents_link", "reject"]);
  assert.deepEqual(acts("invited"), ["resend_documents_link", "reject"], "no live link: nothing to revoke");
  assert.deepEqual(acts("invited", { liveDocumentLink: true }), ["resend_documents_link", "revoke_link", "reject"]);
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
].map((d, i) => ({ ...d, id: `d${i}`, extractionStatus: "pending" as const, extracted: {} }));
const completeDetails = {
  is_australian_citizen: false as boolean | null, first_name: "Tara", middle_name: "", last_name: "Trainer", date_of_birth: "1990-05-06", phone: "+61400000111",
  address_street: "1 Example St", address_line2: "", address_suburb: "Melbourne", address_country: "Australia", address_state: "VIC", address_postcode: "3000",
  emergency_name: "Em", emergency_phone: "+61422333444", emergency_relationship: "Sibling", nationality: "Indian", passport_number: "PA1234567", visa_subclass: "485", visa_conditions: "",
  tax_residency: "resident", tax_free_threshold: "yes", study_loan: "no", super_choice: "default", super_fund_name: "", super_fund_abn: "", super_usi: "", super_member_number: "",
};

test("submit needs the details, citizenship, every required document with a current expiry date, and the bank details", () => {
  const now = new Date("2026-11-09T02:00:00Z");
  const today = "2026-11-09";
  const all = docs(today);
  const without = (category: string) => all.filter((d) => d.category !== category);
  const texts = (details = completeDetails, documents = all, bank = true) => wizardLib.wizardProblems(details, documents, bank, now).map((p) => p.text);
  assert.deepEqual(texts(), []);
  assert.deepEqual(texts(completeDetails, without("Passport")), ["A passport is required before you can submit."]);
  assert.deepEqual(texts(completeDetails, without("Visa")), ["Upload your visa."]);
  assert.deepEqual(texts(completeDetails, without("English")), ["Upload your English test result."]);
  assert.deepEqual(texts({ ...completeDetails, is_australian_citizen: true, visa_subclass: "" }, without("Visa").filter((d) => d.category !== "English")), [], "a citizen needs no visa, no English result and no visa subclass");
  assert.deepEqual(texts(completeDetails, without("Academic")), ["Upload your academic results."]);
  assert.deepEqual(texts(completeDetails, without("Health Insurance")), ["Upload your health insurance."]);
  assert.deepEqual(texts(completeDetails, docs("2026-11-08")), ["Enter a current expiry date for your health insurance."]);
  assert.deepEqual(texts(completeDetails, [...without("English"), { ...all[2], expiryDate: "2026-01-01" }]), ["Enter a current expiry date for your English test result."]);
  assert.deepEqual(texts(completeDetails, [...without("Passport"), { ...all[0], expiryDate: null }]), ["Enter a current expiry date for your passport."], "a passport uploaded without its date still needs one before Submit");
  assert.deepEqual(texts(completeDetails, [...all, { ...all[0], id: "lic", category: "Driving Licence", expiryDate: "2020-01-01" }]), [], "the optional licence never blocks Submit");
  assert.deepEqual(texts({ ...completeDetails, is_australian_citizen: null }), ["Tell us whether you are an Australian citizen."]);
  assert.deepEqual(texts(completeDetails, all, false), ["Enter your bank details."]);
  assert.ok(!texts().some((p) => /role/i.test(p)), "no role is asked of an applicant");
  const blank = wizardLib.wizardProblems({ ...staffRules.EMPTY_STAFF_DETAILS }, [], false, now);
  assert.deepEqual(blank.map((p) => p.text), [
    "Tell us whether you are an Australian citizen.", "Enter your first name.", "Enter your last name.", "Enter your date of birth.", "Enter your mobile number.",
    "Enter the street address.", "Enter the suburb or city.", "Enter the country.", "Enter the emergency contact's name.", "Enter the emergency contact's phone number.",
    "Enter how they are related to you.", "Enter your nationality.", "Enter your passport number.",
    "Tell us your residency status for tax purposes.", "Tell us whether you have a study or training support loan.", "Choose how your super is paid.",
    "A passport is required before you can submit.", "Upload your visa.", "Upload your English test result.", "Upload your academic results.", "Upload your health insurance.",
    "Enter your bank details.",
  ], "everything missing, in the order the database checks it");
  // Each problem belongs to the step that fixes it; a step is complete (ticked) once it has none.
  assert.deepEqual([...new Set(blank.map((p) => p.step))], ["documents", "prefill", "personal", "tax", "bank"]);
  assert.deepEqual(wizardLib.STAFF_WIZARD.map((s) => s.id), ["documents", "prefill", "personal", "bank", "tax", "review"], "Tax and super sits between Bank details and Review");
  assert.ok(!texts().some((p) => /tax file|tfn/i.test(p)) && !Object.keys(staffRules.EMPTY_STAFF_DETAILS).some((k) => /tfn|tax_file/.test(k)), "no tax file number is asked for anywhere");
  assert.equal(wizardLib.stepComplete("documents", blank), false);
  assert.equal(wizardLib.stepComplete("review", []), true);
  assert.equal(wizardLib.stepComplete("review", wizardLib.wizardProblems(completeDetails, all, false, now)), false);
  // The address belongs to Personal details, or to Check details when an Australian licence gave it.
  const licence = { id: "lic", category: "Driving Licence", expiryDate: "2030-01-01", extractionStatus: "done" as const, extracted: { au_street: "9 Licence Rd" } };
  assert.equal(wizardLib.wizardProblems({ ...completeDetails, address_suburb: "" }, all, true, now)[0].step, "personal");
  assert.equal(wizardLib.wizardProblems({ ...completeDetails, address_suburb: "" }, [...all, licence], true, now)[0].step, "prefill");
  assert.ok(wizardLib.stepFields("prefill", true).includes("address_street") && !wizardLib.stepFields("personal", true).includes("address_street"));
  assert.ok(wizardLib.stepFields("personal", false).includes("address_street") && !wizardLib.stepFields("prefill", false).includes("address_street"));
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
  for (const c of emp.EMPLOYEE_DOC_CATEGORIES) assert.ok(sql.includes(`'${c}'`), `the database accepts ${c}`);
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
  assert.deepEqual(acts("applied", { openJobApplication: true }), ["send_documents_link", "reject"], "a Careers applicant gets the document link from the employee page too");
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
  const sql = read("supabase/migrations/20261111100000_hr_templates.sql") + read("supabase/migrations/20261113090000_hr_locations_job_type_login.sql");
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

  const wrongStage = flowDeps({ db: { hr_admin_staff_detail: { data: { profile: { ...DETAIL_READY.profile, status: "invited" } } } } });
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
  for (const call of ['signingAdmin<SigningContext>("list")', '"template_duplicate"', '"template_default"', '"template_archive"', '"template_delete"', "<TemplateEditor", "<TemplatePreviewDialog", "TEMPLATE_TYPES.map("]) assert.ok(templates.includes(call), `Templates page: ${call}`);
  const editor = read("src/pages/admin/components/signing/TemplateEditor.tsx");
  for (const call of ['"template_save"', "sanitizeTemplateHtml(", "templateText(", "placeholdersFor(", "<RichTextEditor", "is_default", "SUBJECT_VARIABLES"]) assert.ok(editor.includes(call), `the one template editor: ${call}`);
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
  // Both wizards are built from the same components.
  for (const file of ["src/pages/agency/components/ApplicationWizard.tsx", "src/pages/staff/StaffOnboardingPage.tsx"]) {
    const text = read(file);
    for (const part of ["WizardShell", "WizardStepper"]) assert.ok(text.includes(`@/components/shared/wizard/${part}`), `${file} uses the shared ${part}`);
  }
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
    { field: "first_name", message: "The first name must be 100 characters or fewer." }, { field: "date_of_birth", message: "You must be between 10 and 100 years old." },
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
  assert.deepEqual([r.status, r.body.error, r.body.field], [400, "You must be between 10 and 100 years old.", "date_of_birth"]);
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
  assert.deepEqual(wizardLib.STAFF_WIZARD.map((s) => s.id), ["documents", "prefill", "personal", "bank", "tax", "review"]);
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
