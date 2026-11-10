import { hasValidatedDocumentPath } from "./document-category.ts";
// Pure helpers for the guest document link: token handling, request checks and the document list shown to the student. No I/O.
// The student only ever receives status and the detected document type: never a value read from a document.
import { sniffContent } from "./guest-sniff.ts";

export const GUEST_MAX_BYTES = 10 * 1024 * 1024;
export const GUEST_CONSENT_VERSION = "guest-docs-v1";
/** The categories a step can store, in step order. Passport is the only required one; the step decides the category, never the file name. */
export const GUEST_CATEGORIES = ["Passport", "Visa", "English Test", "Academic", "Driving Licence", "Health Insurance"] as const;
export type GuestCategory = typeof GUEST_CATEGORIES[number];
/** Steps that accept several files; every other step keeps one file and replaces it. */
export const MULTIPLE_CATEGORIES: readonly string[] = ["Academic"];
/** Steps the student may answer with "I don't have this" (recorded for the agent). */
export const DECLARABLE: readonly string[] = ["Visa", "English Test", "Academic"];
export const MAX_GUEST_DOCUMENTS = 30;

/** 32 random bytes as unpadded base64url (43 characters), as portal_create_guest_link issues them. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function tokenHashHex(token: string): Promise<string | null> {
  if (!TOKEN_PATTERN.test(token)) return Promise.resolve(null);
  const base64 = token.replace(/-/g, "+").replace(/_/g, "/") + "=";
  const raw = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return crypto.subtle.digest("SHA-256", raw).then((digest) => "\\x" + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""));
}

export const isGuestCategory = (value: unknown): value is GuestCategory => typeof value === "string" && (GUEST_CATEGORIES as readonly string[]).includes(value);
export const isDeclarable = (value: unknown): boolean => typeof value === "string" && DECLARABLE.includes(value);

export type FileCheck = { ok: true; name: string; mime: string } | { ok: false; code: "empty" | "too_large" | "type"; found?: string };

/**
 * Size and content. The bytes decide (PDF, JPEG, PNG); the declared type and the extension never accept a file on their own, because an
 * error page saved as .pdf carries both. The stored name and type follow the content. HEIC is not accepted: the browser converts it first.
 */
export function checkGuestFile(bytes: Uint8Array, _declaredMime: string, name: string): FileCheck {
  if (!bytes.length) return { ok: false, code: "empty", found: "an empty file" };
  if (bytes.length > GUEST_MAX_BYTES) return { ok: false, code: "too_large" };
  const sniffed = sniffContent(bytes);
  if (!sniffed.ok) return { ok: false, code: "type", found: sniffed.found };
  const base = name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]/g, "_").slice(-110) || "document";
  return { ok: true, name: `${base}.${sniffed.ext}`, mime: sniffed.mime };
}

/** An opaque per-link reference for a document, so no database id leaves the server. Meaningful only together with its token. */
export async function documentRef(linkId: string, documentId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${linkId}:${documentId}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type GuestState = "reading" | "done" | "failed";
export function guestState(extractionStatus: unknown): GuestState {
  const status = String(extractionStatus ?? "queued");
  if (status === "failed" || status === "cancelled") return "failed";
  return status === "queued" || status === "processing" ? "reading" : "done";
}

/** What the extraction says the file is, as one of our categories; null when it says Other / unknown or nothing. */
export function detectedCategory(documentType: unknown): GuestCategory | null {
  const text = String(documentType ?? "");
  if ((GUEST_CATEGORIES as readonly string[]).includes(text)) return text as GuestCategory;
  if (/passport/i.test(text)) return "Passport";
  if (/licen[cs]e|driver/i.test(text)) return "Driving Licence";
  if (/visa/i.test(text)) return "Visa";
  if (/ielts|pte|toefl|english/i.test(text)) return "English Test";
  if (/transcript|diploma|degree|academic|education/i.test(text)) return "Academic";
  if (/insurance|oshc|health/i.test(text)) return "Health Insurance";
  return null;
}

/** The only shape of a document the student receives. Whatever the extraction read stays on the server. */
export type PublicDocument = { ref: string; category: string; filename: string; state: GuestState; detected: GuestCategory | null; mismatch: boolean; confirmed: boolean };
export function publicDocument(ref: string, row: { category: unknown; filename: unknown; metadata: unknown; storage_path?: string }): PublicDocument {
  const metadata = (row.metadata ?? {}) as { extraction?: { status?: string; source?: { documentType?: string; categoryMismatch?: boolean } }; guest?: { confirmedAt?: string } };
  const category = String(row.category);
  const state = guestState(metadata.extraction?.status);
  const finished = state === "done";
  const checked = hasValidatedDocumentPath(row.storage_path ?? "");
  const detected = checked ? detectedCategory(category) : finished ? detectedCategory(metadata.extraction?.source?.documentType) : null;
  const mismatch = !checked && finished && (metadata.extraction?.source?.categoryMismatch === true || (detected !== null && detected !== category));
  return { ref, category, filename: String(row.filename), state, detected, mismatch, confirmed: Boolean(metadata.guest?.confirmedAt) };
}

/** Visa copy is hidden when the passport shows Australia. null = not known yet (the passport has not been read). */
export function passportIsAustralian(values: Record<string, unknown>): boolean {
  return ["nationality", "citizenship", "issuing_country"].some((field) => /^australia(n)?$/i.test(String(values[field] ?? "").trim()));
}
export function visaApplies(passport: { state: GuestState } | null, values: Record<string, unknown>): boolean | null {
  if (!passport || passport.state === "reading") return null;
  if (passport.state === "failed") return true;
  return !passportIsAustralian(values);
}
