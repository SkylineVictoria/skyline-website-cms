// Staff onboarding by emailed link (HR-02c). Runtime-neutral and injectable so every branch is tested offline
// (scripts/test-staff-registration.ts); index.ts wires it to Deno, Supabase Storage and the document reader.
// There is no login: every action carries the link token, which is hashed here (sha256) and checked by the database on EVERY
// call (hr_svc_* functions, service role only): unknown, expired, revoked or replaced links all get one neutral answer, and a
// link that was used (submitted) is read-only. Files pass through this function: type and size are checked by content before
// anything is stored, and the database says whether this link may upload that document type BEFORE the file is written.
import { STAFF_READER_CATEGORY } from "./reader.ts";

export const LINK_INVALID = "This link is not valid any more. Ask us for a new one.";
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_REQUEST_BYTES = MAX_DOCUMENT_BYTES + 64 * 1024;
/** Invalid-link answers allowed per caller IP in BAD_LINK_WINDOW seconds before that IP is refused for every action. */
export const BAD_LINK_LIMIT = 20;
export const BAD_LINK_WINDOW = 600;
export const ACTIONS = ["open", "save", "upload", "remove", "expiry", "view_url", "extract", "submit"] as const;
export type OnboardingAction = (typeof ACTIONS)[number];

export interface OnboardingRequest { action: string; token: unknown; ip: string | null; fields: Record<string, unknown>; file?: File | null }
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

async function handleLink(action: OnboardingAction, req: OnboardingRequest, deps: OnboardingDeps): Promise<OnboardingResult> {
  if (typeof req.token !== "string" || !TOKEN.test(req.token)) return linkInvalid();
  const link = await deps.hash(req.token);
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
