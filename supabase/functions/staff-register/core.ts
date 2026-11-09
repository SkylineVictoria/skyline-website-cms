// Public staff application ("Enroll now" > Staff). Runtime-neutral and injectable so every branch is tested offline
// (scripts/test-staff-registration.ts); index.ts wires it to Deno, Supabase and the CAPTCHA verifier.
// No auth account is created here. Order of checks: per-IP rate limit (fails closed), honeypot, fields, resume type/size/magic
// bytes, CAPTCHA, per-email rate limit, then hr_svc_apply (service role). The resume is stored privately at
// staff-documents/{profile id}/resume/{random}.{pdf|docx} and recorded by hr_svc_apply_resume, which queues the
// "application received" and "new application" emails. An email or number that already has an application gets the same
// thank-you answer and nothing is stored or sent, so the form never reveals who has applied.
// Careers (HR-02i): the same form with jobId (an open job), an optional cover letter text (<= 5000) and an optional cover letter file
// (PDF or Word .docx, 5 MB, checked by content like the resume), stored at {profile id}/cover-letter/ and recorded by
// hr_svc_job_cover_letter. An open application applying for another job gets that job added and the same thank-you.
import type { CaptchaVerifier } from "../_shared/captcha.ts";
import { cleanEmail } from "../_shared/user-input.ts";
import { toE164 } from "../_shared/staff-phone.ts";

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
/** The whole request (resume + fields) may not be larger than this; index.ts refuses bigger bodies before reading them. */
export const MAX_REQUEST_BYTES = 2 * MAX_RESUME_BYTES + 64 * 1024;
export const MAX_COVER_LETTER_CHARS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex -- a cover letter keeps line breaks and tabs, nothing else below space
const LETTER_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const RESUME_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

export interface ApplyResult { status: number; body: Record<string, unknown>; headers?: Record<string, string> }
export interface ApplyDeps {
  captcha: CaptchaVerifier;
  takeRateLimit(bucket: string, limit: number, windowSeconds: number): Promise<boolean>;
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message?: string } | null }>;
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<{ error: string | null }>;
  remove(path: string): Promise<void>;
  hash(value: string): Promise<string>;
  newId(): string;
}

// eslint-disable-next-line no-control-regex -- control characters are never valid in a name
const CONTROL = /[\u0000-\u001f\u007f<>]/;
const THANKS: ApplyResult = { status: 200, body: { ok: true } };
const fieldError = (field: string, error: string): ApplyResult => ({ status: 400, body: { error, field } });

function cleanPersonName(value: unknown, label: string): { ok: true; value: string } | { ok: false; error: string } {
  const name = String(value ?? "").trim();
  if (!name) return { ok: false, error: `Enter your ${label}.` };
  if (CONTROL.test(name) || name.length > 100) return { ok: false, error: `Check your ${label}.` };
  return { ok: true, value: name };
}

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, Math.min(to, bytes.length)));
function includesAscii(bytes: Uint8Array, needle: string): boolean {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + n.length <= bytes.length; i++) {
    for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

/** The resume kind from its name AND its content: a PDF starts with %PDF-; a DOCX is a ZIP holding word/document.xml. */
export function detectResume(filename: string, bytes: Uint8Array): "pdf" | "docx" | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "pdf" && ascii(bytes, 0, 5) === "%PDF-") return "pdf";
  if (ext === "docx" && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
    && includesAscii(bytes, "[Content_Types].xml") && includesAscii(bytes, "word/document.xml")) return "docx";
  return null;
}

/** A display name for the stored resume: no path, no control characters, at most 120 characters. */
export function safeFilename(name: string, kind: "pdf" | "docx"): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from a user-supplied file name
  const base = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  return base || `resume.${kind}`;
}

export async function handleApply(form: FormData, meta: { ip: string | null }, deps: ApplyDeps): Promise<ApplyResult> {
  const callerKey = await deps.hash(meta.ip ?? "anonymous");
  if (!(await deps.takeRateLimit(`staff-register:caller:apply:${callerKey}`, 5, 600))) {
    return { status: 429, body: { error: "Please wait a few minutes before trying again." }, headers: { "Retry-After": "600" } };
  }
  // A filled honeypot field is a bot: answer as if it worked and record nothing.
  if (String(form.get("website") ?? "").trim()) return THANKS;

  const first = cleanPersonName(form.get("firstName"), "first name");
  if (!first.ok) return fieldError("firstName", first.error);
  const last = cleanPersonName(form.get("lastName"), "last name");
  if (!last.ok) return fieldError("lastName", last.error);
  const email = cleanEmail(form.get("email"));
  if (!email.ok) return fieldError("email", email.error);
  const phone = toE164(form.get("phone"));
  if (!phone) return fieldError("phone", "Enter your mobile number with its country code.");
  if (String(form.get("agreed") ?? "") !== "true") return fieldError("agreed", "Please agree to the terms and privacy policy.");

  const resume = form.get("resume");
  if (!resume || typeof resume === "string") return fieldError("resume", "Attach your resume (PDF or Word .docx).");
  if (resume.size < 1 || resume.size > MAX_RESUME_BYTES) return fieldError("resume", "The resume must be 5 MB or smaller.");
  const bytes = new Uint8Array(await resume.arrayBuffer());
  const kind = detectResume(resume.name, bytes);
  if (!kind) return fieldError("resume", "Attach your resume as a PDF or Word (.docx) file.");

  const jobRaw = String(form.get("jobId") ?? "").trim();
  if (jobRaw && !UUID.test(jobRaw)) return fieldError("jobId", "This job is no longer open.");
  const coverText = String(form.get("coverLetter") ?? "").replace(/\r\n/g, "\n").trim();
  if (coverText && !jobRaw) return fieldError("coverLetter", "A cover letter goes with a job application.");
  if (coverText.length > MAX_COVER_LETTER_CHARS || LETTER_CONTROL.test(coverText)) return fieldError("coverLetter", `Keep the cover letter under ${MAX_COVER_LETTER_CHARS} characters.`);
  const coverFile = form.get("coverLetterFile");
  let cover: { bytes: Uint8Array; kind: "pdf" | "docx"; name: string } | null = null;
  if (coverFile && typeof coverFile !== "string" && coverFile.size > 0) {
    if (!jobRaw) return fieldError("coverLetterFile", "A cover letter goes with a job application.");
    if (coverFile.size > MAX_RESUME_BYTES) return fieldError("coverLetterFile", "The cover letter must be 5 MB or smaller.");
    const coverBytes = new Uint8Array(await coverFile.arrayBuffer());
    const coverKind = detectResume(coverFile.name, coverBytes);
    if (!coverKind) return fieldError("coverLetterFile", "Attach the cover letter as a PDF or Word (.docx) file.");
    cover = { bytes: coverBytes, kind: coverKind, name: coverFile.name };
  }

  const captcha = await deps.captcha.verify(form.get("captchaToken"), meta.ip);
  if (!captcha.ok) {
    return captcha.reason === "unavailable"
      ? { status: 503, body: { error: "We could not check the security challenge. Please try again shortly." } }
      : fieldError("captcha", "Complete the security check and try again.");
  }
  if (!(await deps.takeRateLimit(`staff-register:email:apply:${await deps.hash(email.value)}`, 3, 3600))) {
    return { status: 429, body: { error: "Please wait a while before applying again with this email." }, headers: { "Retry-After": "3600" } };
  }

  const { data, error } = await deps.rpc("hr_svc_apply", { p_first_name: first.value, p_last_name: last.value, p_email: email.value, p_phone: phone,
    p_job: jobRaw || null, p_cover_letter: coverText || null });
  const applied = data as { ok?: boolean; reason?: string; profileId?: string; jobApplicationId?: string | null } | null;
  if (error || !applied) return { status: 503, body: { error: "We could not save your application right now. Please try again shortly." } };
  if (applied.ok !== true) {
    if (applied.reason === "invalid_email") return fieldError("email", "Enter a valid email address.");
    if (applied.reason === "invalid_phone") return fieldError("phone", "Enter your mobile number with its country code.");
    if (applied.reason === "invalid_name") return fieldError("firstName", "Check your name.");
    if (applied.reason === "job_closed") return fieldError("jobId", "This job is no longer open.");
    if (applied.reason === "invalid_cover_letter") return fieldError("coverLetter", `Keep the cover letter under ${MAX_COVER_LETTER_CHARS} characters.`);
    return THANKS; // 'exists': same answer as success, nothing stored, nothing sent.
  }

  const path = `${applied.profileId}/resume/${deps.newId()}.${kind}`;
  const stored = await deps.upload(path, bytes, RESUME_TYPES[kind]);
  if (stored.error) return { status: 503, body: { error: "We could not store your resume. Please try again shortly." } };
  const recorded = await deps.rpc("hr_svc_apply_resume", {
    p_profile: applied.profileId, p_path: path, p_filename: safeFilename(resume.name, kind), p_mime: RESUME_TYPES[kind], p_size: bytes.length,
  });
  if (recorded.error) {
    await deps.remove(path);
    return { status: 503, body: { error: "We could not save your application right now. Please try again shortly." } };
  }
  if (cover && applied.jobApplicationId) {
    // The application stands either way; a cover letter file that cannot be stored is removed again.
    const coverPath = `${applied.profileId}/cover-letter/${deps.newId()}.${cover.kind}`;
    const coverStored = await deps.upload(coverPath, cover.bytes, RESUME_TYPES[cover.kind]);
    if (!coverStored.error) {
      const coverRecorded = await deps.rpc("hr_svc_job_cover_letter", {
        p_application: applied.jobApplicationId, p_path: coverPath, p_filename: safeFilename(cover.name, cover.kind), p_mime: RESUME_TYPES[cover.kind], p_size: cover.bytes.length,
      });
      if (coverRecorded.error) await deps.remove(coverPath);
    }
  }
  return THANKS;
}
