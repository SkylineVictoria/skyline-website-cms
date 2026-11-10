// Staff onboarding by emailed link (HR-02c). Runtime-neutral and injectable so every branch is tested offline
// (scripts/test-staff-registration.ts); index.ts wires it to Deno, Supabase Storage and the document reader.
// There is no login: every action carries the link token, which is hashed here (sha256) and checked by the database on EVERY
// call (hr_svc_* functions, service role only): unknown, expired, revoked or replaced links all get one neutral answer, and a
// link that was used (submitted) is read-only. Files pass through this function: type and size are checked by content before
// anything is stored, and the database says whether this link may upload that document type BEFORE the file is written.
import { STAFF_READER_CATEGORY } from "./reader.ts";
import { OFFER_CONSENT, type Signature } from "../_shared/offer-pdf.ts";
//
// Offer by link (HR-02e; /staff/offer#t=, purpose offer): offer_open, offer_view_url (offer, or the signed copy afterwards) and
// offer_sign. Signing re-checks the link, downloads the offer and compares it with the sha256 recorded at upload, adds the
// signature page (typed name, time, IP, browser, the fixed consent text, the offer hash), stores the signed copy as a NEW file
// and records it with its own sha256; any refusal after the upload removes that file. The consent text is fixed server-side.

// Login with the offer (2026-11-10): account_open / account_setup work on the one-time set-password link (purpose account, 7 days)
// that goes out with the offer: the person chooses their own password (never generated, stored or logged here), the Auth admin API
// sets it and confirms the email, and the link is marked used. After that the person is signed in, and offer_open / offer_view_url /
// offer_sign / my_document_url may come WITHOUT a link token: index.ts verifies the session and passes the user id, and the database
// resolves that user to their own offer link (hr_svc_staff_session) or their own document (hr_svc_staff_document_path). A session
// never reaches anyone else's record, and nothing but the offer and own documents is served before the person is Active.

export const LINK_INVALID = "This link is not valid any more. Ask us for a new one.";
export const NO_OFFER = "There is no offer letter for your account right now.";
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 72;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_REQUEST_BYTES = MAX_DOCUMENT_BYTES + 64 * 1024;
/** Invalid-link answers allowed per caller IP in BAD_LINK_WINDOW seconds before that IP is refused for every action. */
export const BAD_LINK_LIMIT = 20;
export const BAD_LINK_WINDOW = 600;
export const ACTIONS = ["open", "save", "upload", "remove", "expiry", "view_url", "extract", "submit", "offer_open", "offer_view_url", "offer_sign", "account_open", "account_setup", "my_document_url"] as const;
export type OnboardingAction = (typeof ACTIONS)[number];

export interface OnboardingRequest { action: string; token: unknown; ip: string | null; userAgent?: string | null; fields: Record<string, unknown>; file?: File | null;
  /** The verified signed-in user (index.ts checks the session with Auth); used only when no link token is sent. */
  session?: { userId: string } | null }
export interface OnboardingResult { status: number; body: Record<string, unknown>; headers?: Record<string, string> }
export interface DocumentToRead { id: string; category: string; filename: string; mimeType: string; storagePath: string }
export interface OnboardingDeps {
  takeRateLimit(bucket: string, limit: number, windowSeconds: number): Promise<boolean>;
  /** Reads a bucket's count in its current window without adding to it (hr_svc_rate_count). */
  rateCount(bucket: string, windowSeconds: number): Promise<number>;
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<{ error: string | null }>;
  remove(paths: string[]): Promise<void>;
  signedUrl(path: string, seconds: number): Promise<string | null>;
  scheduleExtraction(doc: DocumentToRead): void;
  hash(value: string): Promise<string>;
  newId(): string;
  /** Offer signing: the stored file, its sha256, and the signature page added with pdf-lib. */
  download(path: string): Promise<Uint8Array | null>;
  sha256(bytes: Uint8Array): Promise<string>;
  stampOffer(original: Uint8Array, signature: Signature): Promise<Uint8Array>;
  now(): Date;
  /** Auth admin: sets the password the person chose and confirms their email. Never logged. */
  setPassword?(userId: string, password: string): Promise<{ error: string | null }>;
}

/** What is wrong with a chosen password (null = fine). The same rule is shown on the page. */
export function passwordProblem(password: unknown, email = ""): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) return `Choose a password of at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Choose a password of at most ${PASSWORD_MAX} characters.`;
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "Use at least one letter and one number.";
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (email && (password.toLowerCase() === email.toLowerCase() || (local.length >= 4 && password.toLowerCase().includes(local)))) return "Do not use your email address as the password.";
  return null;
}

const TOKEN = /^[A-Za-z0-9_-]{40,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const linkInvalid = (): OnboardingResult => ({ status: 403, body: { error: LINK_INVALID, code: "link_invalid" } });
const bad = (error: string, field?: string): OnboardingResult => ({ status: 400, body: field ? { error, field } : { error } });

/** Maps a database refusal to an answer: the link failure is always the same neutral text; rule failures show their message. */
function fromDb(error: { code?: string; message?: string }): OnboardingResult {
  if (error.code === "28000") return linkInvalid();
  if (["23514", "22023", "P0002", "23505"].includes(error.code ?? "")) return bad(error.message || "That could not be saved.");
  return { status: 500, body: { error: "Something went wrong. Please try again shortly." } };
}

/** The file kind from its CONTENT (and a matching name): PDF, PNG or JPEG only. */
export function sniffDocument(filename: string, bytes: Uint8Array): { mime: string; ext: string } | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const pdf = bytes.length > 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";
  const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (pdf && ext === "pdf") return { mime: "application/pdf", ext: "pdf" };
  if (png && ext === "png") return { mime: "image/png", ext: "png" };
  if (jpg && (ext === "jpg" || ext === "jpeg")) return { mime: "image/jpeg", ext: "jpg" };
  return null;
}

export function safeDocumentName(name: string): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from a user-supplied file name
  const base = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
  return base || "document";
}

export async function handleOnboarding(req: OnboardingRequest, deps: OnboardingDeps): Promise<OnboardingResult> {
  if (!(ACTIONS as readonly string[]).includes(req.action)) return bad("Unknown action.");
  const action = req.action as OnboardingAction;
  const ipKey = await deps.hash(req.ip ?? "anonymous");
  const badBucket = `staff-onboarding:bad:ip:${ipKey}`;
  // Guessing links: after BAD_LINK_LIMIT invalid-link answers in the window, this IP gets nothing but 429 until it passes.
  if ((await deps.rateCount(badBucket, BAD_LINK_WINDOW)) >= BAD_LINK_LIMIT) {
    return { status: 429, body: { error: "Please wait a few minutes before trying again." }, headers: { "Retry-After": String(BAD_LINK_WINDOW) } };
  }
  if (!(await deps.takeRateLimit(`staff-onboarding:ip:${ipKey}`, 300, 600))) {
    return { status: 429, body: { error: "Please wait a few minutes before trying again." }, headers: { "Retry-After": "600" } };
  }
  const result = await handleLink(action, req, deps);
  if (result.body.code === "link_invalid") await deps.takeRateLimit(badBucket, BAD_LINK_LIMIT, BAD_LINK_WINDOW);
  return result;
}

const SESSION_ACTIONS: readonly OnboardingAction[] = ["offer_open", "offer_view_url", "offer_sign", "my_document_url"];

async function handleLink(action: OnboardingAction, req: OnboardingRequest, deps: OnboardingDeps): Promise<OnboardingResult> {
  let link: string;
  const hasToken = typeof req.token === "string" && req.token !== "";
  if (!hasToken && req.session && SESSION_ACTIONS.includes(action)) {
    // Signed in: the database resolves this user to their own record. Nobody else's offer or document can be reached this way.
    if (action === "my_document_url") {
      const id = typeof req.fields.id === "string" && UUID.test(req.fields.id) ? req.fields.id : null;
      if (!id) return bad("Document not found.");
      const { data, error } = await deps.rpc("hr_svc_staff_document_path", { p_user: req.session.userId, p_doc: id });
      if (error) return error.code === "P0002" ? { status: 404, body: { error: "Document not found." } } : fromDb(error);
      const url = await deps.signedUrl(String(data), 300);
      return url ? { status: 200, body: { url } } : { status: 500, body: { error: "The document could not be opened." } };
    }
    const session = await deps.rpc("hr_svc_staff_session", { p_user: req.session.userId });
    if (session.error) return session.error.code === "28000" ? { status: 404, body: { error: NO_OFFER, code: "no_offer" } } : fromDb(session.error);
    link = String(session.data);
  } else {
    if (action === "my_document_url") return { status: 401, body: { error: "Sign in to open your documents." } };
    if (typeof req.token !== "string" || !TOKEN.test(req.token)) return linkInvalid();
    link = await deps.hash(req.token);
  }
  const perLink = action === "upload" ? 60 : 600;
  if (!(await deps.takeRateLimit(`staff-onboarding:link:${action === "upload" ? "upload" : "any"}:${link}`, perLink, 3600))) {
    return { status: 429, body: { error: "Please wait a while before trying again." }, headers: { "Retry-After": "3600" } };
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => deps.rpc(name, { p_token_hash: link, ...args });
  const view = async (name: string, args: Record<string, unknown> = {}): Promise<OnboardingResult> => {
    const { data, error } = await call(name, args);
    return error ? fromDb(error) : { status: 200, body: { view: data } };
  };
  const docId = (): string | null => (typeof req.fields.id === "string" && UUID.test(req.fields.id) ? req.fields.id : null);

  switch (action) {
    case "account_open": {
      const { data, error } = await call("hr_svc_account_open");
      if (error) return fromDb(error);
      const view = data as { name: string; firstName: string; email: string; expiresAt: string };
      return { status: 200, body: { view: { name: view.name, firstName: view.firstName, email: view.email, expiresAt: view.expiresAt }, passwordMin: PASSWORD_MIN } };
    }
    case "account_setup": {
      if (!deps.setPassword) return { status: 503, body: { error: "Passwords cannot be set here." } };
      // The link is checked first (one neutral answer when it is not usable), then the password, then Auth, then the link is used up.
      const opened = await call("hr_svc_account_open");
      if (opened.error) return fromDb(opened.error);
      const account = opened.data as { email: string; authUserId: string };
      const problem = passwordProblem(req.fields.password, account.email);
      if (problem) return bad(problem, "password");
      const set = await deps.setPassword(account.authUserId, req.fields.password as string);
      if (set.error) {
        return /weak|pwned|leaked|compromised|should contain|at least/i.test(set.error)
          ? bad("That password is too easy to guess or has appeared in a data breach. Choose a different one.", "password")
          : { status: 503, body: { error: "The password could not be saved. Please try again." } };
      }
      const done = await call("hr_svc_account_done");
      if (done.error) return fromDb(done.error);
      return { status: 200, body: { ok: true, email: account.email } };
    }
    case "offer_open": {
      const { data, error } = await call("hr_svc_offer_open");
      return error ? fromDb(error) : { status: 200, body: { view: data, consent: OFFER_CONSENT } };
    }
    case "offer_view_url": {
      const which = req.fields.which === "signed" ? "signed" : "offer";
      const { data, error } = await call("hr_svc_offer_path", { p_which: which });
      if (error) return fromDb(error);
      const url = await deps.signedUrl(String(data), 300);
      return url ? { status: 200, body: { url } } : { status: 500, body: { error: "The offer could not be opened." } };
    }
    case "offer_sign": return signOffer(req, deps, call);
    case "open": return view("hr_svc_onboarding_open");
    case "submit": return view("hr_svc_onboarding_submit");
    case "save": {
      const patch = req.fields.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) return bad("Nothing to save.");
      return view("hr_svc_onboarding_save", { p_patch: patch });
    }
    case "expiry": {
      const id = docId();
      const expiry = String(req.fields.expiryDate ?? "");
      if (!id) return bad("Document not found.");
      if (!DATE.test(expiry)) return bad("Enter a valid expiry date.", "expiryDate");
      return view("hr_svc_document_set_expiry", { p_id: id, p_expiry: expiry });
    }
    case "remove": {
      const id = docId();
      if (!id) return bad("Document not found.");
      const { data, error } = await call("hr_svc_document_remove", { p_id: id });
      if (error) return fromDb(error);
      const result = data as { removedPath?: string; view?: unknown };
      if (result.removedPath) await deps.remove([result.removedPath]);
      return { status: 200, body: { view: result.view } };
    }
    case "view_url": {
      const id = docId();
      if (!id) return bad("Document not found.");
      const { data, error } = await call("hr_svc_document_path", { p_id: id });
      if (error) return fromDb(error);
      const url = await deps.signedUrl(String(data), 300);
      return url ? { status: 200, body: { url } } : { status: 500, body: { error: "The document could not be opened." } };
    }
    case "extract": {
      const id = docId();
      if (!id) return bad("Document not found.");
      const { data, error } = await call("hr_svc_document_for_extraction", { p_id: id });
      if (error) return fromDb(error);
      const doc = data as DocumentToRead;
      if (STAFF_READER_CATEGORY[doc.category]) deps.scheduleExtraction(doc);
      return view("hr_svc_onboarding_open");
    }
    case "upload": {
      const category = String(req.fields.category ?? "");
      const expiry = String(req.fields.expiryDate ?? "");
      const replaces = String(req.fields.replaces ?? "");
      if (expiry && !DATE.test(expiry)) return bad("Enter a valid expiry date.", "expiryDate");
      if (replaces && !UUID.test(replaces)) return bad("Document not found.");
      const file = req.file;
      if (!file) return bad("Choose a file to upload.", "file");
      if (file.size < 1 || file.size > MAX_DOCUMENT_BYTES) return bad("The file must be 10 MB or smaller.", "file");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const kind = sniffDocument(file.name, bytes);
      if (!kind) return bad("Upload a PDF, JPG or PNG file.", "file");
      // The database decides first whether this link may upload this type now; nothing is stored when it may not.
      const target = await call("hr_svc_upload_target", { p_category: category, p_replaces: replaces || null });
      if (target.error) return fromDb(target.error);
      const { profileId, folder } = target.data as { profileId: string; folder: string };
      const path = `${profileId}/${folder}/${deps.newId()}.${kind.ext}`;
      const stored = await deps.upload(path, bytes, kind.mime);
      if (stored.error) return { status: 503, body: { error: "The upload failed. Please try again." } };
      const added = await call("hr_svc_document_add", {
        p_category: category, p_path: path, p_filename: safeDocumentName(file.name), p_mime: kind.mime, p_size: bytes.length,
        p_expiry: expiry || null, p_replaces: replaces || null,
      });
      if (added.error) { await deps.remove([path]); return fromDb(added.error); }
      const result = added.data as { id: string; replacedPaths?: string[]; view?: unknown };
      if (result.replacedPaths?.length) await deps.remove(result.replacedPaths);
      if (STAFF_READER_CATEGORY[category]) deps.scheduleExtraction({ id: result.id, category, filename: safeDocumentName(file.name), mimeType: kind.mime, storagePath: path });
      return { status: 200, body: { view: result.view, id: result.id } };
    }
  }
}

type Call = (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;

async function signOffer(req: OnboardingRequest, deps: OnboardingDeps, call: Call): Promise<OnboardingResult> {
  const name = String(req.fields.name ?? "").replace(/\s+/g, " ").trim();
  // eslint-disable-next-line no-control-regex -- a signature name never carries control characters
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f<>]/.test(name)) return bad("Type your full name to sign.", "name");
  if (req.fields.consent !== true) return bad("Tick the box to agree.", "consent");
  const offer = await call("hr_svc_offer_file");
  if (offer.error) return fromDb(offer.error);
  const file = offer.data as { profileId: string; offerId: string; path: string; sha256: string; filename: string };
  const original = await deps.download(file.path);
  // The file must be exactly the one the admin uploaded and sent.
  if (!original || (await deps.sha256(original)) !== file.sha256) return { status: 500, body: { error: "The offer letter could not be checked. Please contact us." } };
  const signedAt = deps.now().toISOString();
  let signed: Uint8Array;
  try {
    signed = await deps.stampOffer(original, { signerName: name, signedAt, ip: req.ip, userAgent: (req.userAgent ?? "").slice(0, 500) || null, consent: OFFER_CONSENT,
      offerFilename: file.filename, offerSha256: file.sha256 });
  } catch {
    return { status: 500, body: { error: "The offer could not be signed. Please contact us." } };
  }
  const signedSha = await deps.sha256(signed);
  const path = `${file.profileId}/offer/signed-${deps.newId()}.pdf`;
  const stored = await deps.upload(path, signed, "application/pdf");
  if (stored.error) return { status: 503, body: { error: "Signing failed. Please try again." } };
  const recorded = await call("hr_svc_offer_sign", { p_offer: file.offerId, p_signer_name: name, p_consent_text: OFFER_CONSENT, p_ip: req.ip,
    p_user_agent: (req.userAgent ?? "").slice(0, 500) || null, p_signed_path: path, p_signed_sha256: signedSha });
  if (recorded.error) { await deps.remove([path]); return fromDb(recorded.error); }
  return { status: 200, body: { view: recorded.data, consent: OFFER_CONSENT } };
}
