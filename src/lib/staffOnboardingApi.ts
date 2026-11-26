import { isRejectedDocumentStatus, RejectedDocumentError } from "@/lib/validatedDocumentUpload";
import { reportFunctionFailure, supabase } from "@/pages/admin/lib/supabase";
import { hrNumber, onHrRules } from "@/lib/hrRules";
import type { StaffDocCategory, StaffStatus } from "@/lib/staffStatus";
import type { StaffDocSummary, StaffDocument } from "@/lib/staffApi";
import { DOCUMENT_LIMITS, DOCUMENT_MAX_BYTES, documentFileProblem } from "../../supabase/functions/_shared/validation/person";
import type { AddressLookup, AddressPick } from "@/components/shared/wizard/AddressSearch";

/**
 * Browser calls for staff onboarding by emailed link (no login). The link token is the only credential: it arrives in the URL
 * FRAGMENT (#t=...), which browsers never send to a server or in a Referer header. takeLinkToken() moves it into this tab's
 * sessionStorage and strips it from the address bar, so a refresh keeps working and the token is not left on screen.
 * Every call goes to the staff-onboarding Edge Function, which re-checks the link in the database each time.
 */

export interface OnboardingProfile {
  first_name: string; middle_name: string; last_name: string; date_of_birth: string | null; email: string; phone_e164: string;
  address_street: string; address_line2: string; address_suburb: string; address_state: string; address_postcode: string; address_country: string;
  emergency_name: string; emergency_relationship: string; emergency_phone_e164: string | null; is_australian_citizen: boolean | null;
  nationality: string; passport_number: string; visa_subclass: string; visa_conditions: string;
  tax_residency: string; tax_free_threshold: string; study_loan: string; super_choice: string;
  super_fund_name: string; super_fund_abn: string; super_usi: string; super_member_number: string;
}
/** The person's bank details as the server gives them back: the BSB and account number are always masked (06••••, •••• 4321). */
export interface OnboardingBank { accountName: string; bsb: string; accountNumber: string; bankName: string; updatedAt: string; masked: boolean }
/** The role HR recorded for the person (read-only in the wizard): job title, work location, job type, pay type, start date. */
export interface OnboardingEmployment { jobTitle: string; workLocation: string; employmentType: string | null; joiningDate: string | null; payType: "fortnightly" | "monthly" | null }
export interface OnboardingView {
  profile: OnboardingProfile; status: StaffStatus; mode: "documents" | "reupload"; readOnly: boolean; expiresAt: string;
  documents: StaffDocument[]; requiredCategories: StaffDocCategory[]; summary: StaffDocSummary; bank: OnboardingBank | null;
  employment?: OnboardingEmployment | null;
}
/** A refused save or upload: the message and, when the server names it, the field it belongs to. */
export class FieldError extends Error { field?: string; constructor(message: string, field?: string) { super(message); this.field = field; } }

export class LinkInvalidError extends Error {}
/** The signed-in person has no offer out right now (withdrawn, or not sent yet). */
export class NoOfferError extends Error {}

const STORE = "skyline.staff-link.";
/** Reads the token from #t=... (then stores it for this tab and clears it from the address bar), or the stored one. */
export function takeLinkToken(kind: "onboard" | "offer" | "account"): string | null {
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("t");
  try {
    if (fromHash) {
      sessionStorage.setItem(STORE + kind, fromHash);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      return fromHash;
    }
    return sessionStorage.getItem(STORE + kind);
  } catch { return fromHash; }
}

/**
 * CONTACT-VERIFY (2026-11-26): a link opened from the text message proves the mobile; the email is confirmed with a 6-digit code
 * before the password, the documents or the signature. The function says so on every view (`contact`) and refuses those steps with
 * code email_unconfirmed; EmailCodeGate shows the code box from this store.
 */
export interface ContactState { emailPending: boolean; emailTo: string | null }
let contactState: ContactState | null = null;
const contactListeners = new Set<(state: ContactState | null) => void>();
function setContact(state: ContactState | null) { contactState = state; contactListeners.forEach((l) => l(state)); }
export function onContact(listener: (state: ContactState | null) => void): () => void { contactListeners.add(listener); listener(contactState); return () => { contactListeners.delete(listener); }; }
export const contactCode = {
  send: async (t: string) => { await invoke({ action: "contact_code_send", t }); },
  verify: async (t: string, code: string) => {
    const r = await invoke({ action: "contact_code_verify", t, code }) as { ok?: boolean; reason?: string; remaining?: number; error?: string };
    if (r.ok) setContact({ emailPending: false, emailTo: null });
    return r;
  },
};

async function invoke(body: Record<string, unknown> | FormData): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke("staff-onboarding", { body });
  const contact = (data as { contact?: ContactState } | null)?.contact;
  if (!error && contact && typeof contact.emailPending === "boolean") setContact(contact);
  if (error) {
    let message = error.message;
    let code: string | undefined;
    let field: string | undefined;
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try {
        const parsed = (await context.clone().json()) as { error?: string; code?: string; field?: string; emailTo?: string | null };
        if (parsed?.code === "email_unconfirmed") setContact({ emailPending: true, emailTo: parsed.emailTo ?? null });
        if (parsed?.error) message = parsed.error;
        code = parsed?.code;
        field = parsed?.field;
      } catch { /* keep the generic message */ }
    }
    if (code === "link_invalid") throw new LinkInvalidError(message);
    if (code === "no_offer") throw new NoOfferError(message);
    if (body instanceof FormData && body.get("action") === "upload" && context instanceof Response &&
      (isRejectedDocumentStatus(context.status) || (context.status === 400 && field === "file"))) {
      throw new RejectedDocumentError(message);
    }
    throw new FieldError(message || "Something went wrong. Please try again.", field);
  }
  return (data ?? {}) as Record<string, unknown>;
}
const viewOf = (r: Record<string, unknown>) => r.view as OnboardingView;

/**
 * An upload with its progress (fetch cannot report it): the same function, the same answer. The link token travels in the form
 * body like every other call; nothing about the file or the person goes into the address.
 */
function uploadWithProgress(body: FormData, onProgress?: (fraction: number) => void): Promise<Record<string, unknown>> {
  const url = import.meta.env.VITE_PUBLIC_SUPABASE_URL as string | undefined;
  const anon = import.meta.env.VITE_PUBLIC_SUPABASE_ANON_KEY as string | undefined;
  if (!onProgress || !url || !anon || typeof XMLHttpRequest === "undefined") return invoke(body);
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${url}/functions/v1/staff-onboarding`);
    request.setRequestHeader("apikey", anon);
    request.setRequestHeader("Authorization", `Bearer ${anon}`);
    request.upload.onprogress = (event) => { if (event.lengthComputable && event.total > 0) onProgress(Math.min(event.loaded / event.total, 1)); };
    request.onerror = () => reject(new Error("The upload failed. Check your connection and try again."));
    request.onload = () => {
      let parsed: { error?: string; code?: string; field?: string } & Record<string, unknown> = {};
      try { parsed = JSON.parse(request.responseText) as typeof parsed; } catch { /* not JSON */ }
      reportFunctionFailure("staff-onboarding", request.status, String(request.responseText ?? "").slice(0, 2000));
      if (request.status >= 200 && request.status < 300) { resolve(parsed); return; }
      if (parsed.code === "link_invalid") reject(new LinkInvalidError(parsed.error ?? "This link is not valid any more."));
      else if (isRejectedDocumentStatus(request.status) || (request.status === 400 && parsed.field === "file")) {
        reject(new RejectedDocumentError(parsed.error || "This document was rejected."));
      } else reject(new FieldError(parsed.error || "The upload failed. Please try again.", parsed.field));
    };
    request.send(body);
  });
}

export const onboarding = {
  open: async (t: string) => viewOf(await invoke({ action: "open", t })),
  save: async (t: string, patch: Record<string, string | boolean | null>) => viewOf(await invoke({ action: "save", t, patch })),
  setExpiry: async (t: string, id: string, expiryDate: string) => viewOf(await invoke({ action: "expiry", t, id, expiryDate })),
  remove: async (t: string, id: string) => viewOf(await invoke({ action: "remove", t, id })),
  extract: async (t: string, id: string) => viewOf(await invoke({ action: "extract", t, id })),
  submit: async (t: string) => viewOf(await invoke({ action: "submit", t })),
  viewUrl: async (t: string, id: string) => String((await invoke({ action: "view_url", t, id })).url ?? ""),
  /**
   * Australian address suggestions for the wizard's address box, through the private link (the same Geoscape lookup the student
   * form uses, reached on the server). Any failure answers "unavailable": the box says so and the address is typed by hand.
   */
  addressSearch: async (t: string, q: string, signal: AbortSignal): Promise<AddressLookup> => {
    const url = import.meta.env.VITE_PUBLIC_SUPABASE_URL as string | undefined;
    const anon = import.meta.env.VITE_PUBLIC_SUPABASE_ANON_KEY as string | undefined;
    if (!url || !anon) return { kind: "unavailable" };
    const response = await fetch(`${url}/functions/v1/staff-onboarding`, {
      method: "POST", signal, headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "address_search", t, q }),
    });
    if (response.status >= 500) reportFunctionFailure("staff-onboarding", response.status, await response.clone().text().catch(() => ""));
    const body = (await response.json().catch(() => null)) as { ok?: boolean; suggestions?: AddressPick[] } | null;
    if (!response.ok || !body?.ok || !Array.isArray(body.suggestions)) return { kind: "unavailable" };
    return { kind: "ok", suggestions: body.suggestions };
  },
  /** The person's own bank details. They go in the request body only, and come back masked. */
  saveBank: async (t: string, bank: { accountName: string; bsb: string; accountNumber: string; bankName: string }) => viewOf(await invoke({ action: "bank_save", t, bank })),
  upload: async (t: string, category: StaffDocCategory, file: File, expiryDate: string | null, replaces?: string, onProgress?: (fraction: number) => void) => {
    // The shared document rule (size, declared type, content), before anything leaves the device; the function checks again.
    const maxBytes = hrNumber("hrms.employee_document_max_bytes", DOCUMENT_MAX_BYTES);
    const limits = maxBytes > 0 && maxBytes !== DOCUMENT_MAX_BYTES ? { ...DOCUMENT_LIMITS, maxBytes } : DOCUMENT_LIMITS;
    const problem = documentFileProblem(file, new Uint8Array(await file.slice(0, 8).arrayBuffer()), limits);
    if (problem) throw new RejectedDocumentError(problem);
    const body = new FormData();
    body.set("action", "upload");
    body.set("t", t);
    body.set("category", category);
    body.set("expiryDate", expiryDate ?? "");
    body.set("replaces", replaces ?? "");
    body.set("file", file, file.name);
    return viewOf(await uploadWithProgress(body, onProgress));
  },
};

/** /staff/offer#t=: the offer sent by link (HR-02e). The consent wording comes from the server and is stored with the signature. */
export interface OfferView {
  name: string; status: StaffStatus; readOnly: boolean; expiresAt: string;
  offer: { id: string; filename: string; fileSize: number; sentAt: string | null; signedAt: string | null; signerName: string | null; declinedAt?: string | null };
}
export const offerLink = {
  open: async (t: string) => { const r = await invoke({ action: "offer_open", t }); return { view: r.view as OfferView, consent: String(r.consent ?? "") }; },
  viewUrl: async (t: string, which: "offer" | "signed") => String((await invoke({ action: "offer_view_url", t, which })).url ?? ""),
  sign: async (t: string, name: string, consent: boolean, signature?: string | null) => { const r = await invoke({ action: "offer_sign", t, name, consent, ...(signature ? { signature } : {}) }); return { view: r.view as OfferView, consent: String(r.consent ?? "") }; },
  decline: async (t: string, reason: string) => { await invoke({ action: "offer_decline", t, reason, confirm: true }); },
};

/** What the offer panel needs: by private link (the token) or for the signed-in person (their session, no token). */
export interface OfferApi {
  open(): Promise<{ view: OfferView; consent: string }>;
  viewUrl(which: "offer" | "signed"): Promise<string>;
  /** OFFER-SIGNATURES: `signature` is the PNG the person drew (base64), printed on the signed copy. */
  sign(name: string, signature?: string | null): Promise<{ view: OfferView; consent: string }>;
  /** STAFF-OFFER-FULL-PART-TIME: turn the offer down (optional reason); the record moves to Rejected / Withdrawn. */
  decline(reason: string): Promise<void>;
}
export const offerApiForLink = (t: string): OfferApi => ({ open: () => offerLink.open(t), viewUrl: (which) => offerLink.viewUrl(t, which), sign: (name, signature) => offerLink.sign(t, name, true, signature), decline: (reason) => offerLink.decline(t, reason) });
/** The signed-in person's own offer: the function resolves the session to their record; nobody else's can be reached. */
export const myOfferApi: OfferApi = {
  open: async () => { const r = await invoke({ action: "offer_open" }); return { view: r.view as OfferView, consent: String(r.consent ?? "") }; },
  viewUrl: async (which) => String((await invoke({ action: "offer_view_url", which })).url ?? ""),
  sign: async (name, signature) => { const r = await invoke({ action: "offer_sign", name, consent: true, ...(signature ? { signature } : {}) }); return { view: r.view as OfferView, consent: String(r.consent ?? "") }; },
  decline: async (reason) => { await invoke({ action: "offer_decline", reason, confirm: true }); },
};
/** STAFF-OFFER-FULL-PART-TIME: after signing the offer, a private link to the document wizard for the signed-in person (nothing emailed). */
export async function myDocumentsLink(): Promise<{ token: string; purpose: "documents" | "reupload" | "sign" }> {
  const r = await invoke({ action: "documents_link" });
  return { token: String(r.token ?? ""), purpose: r.purpose === "reupload" ? "reupload" : r.purpose === "sign" ? "sign" : "documents" };
}
/** A 5-minute link to one of the signed-in person's own onboarding documents. */
export const myDocumentUrl = async (id: string) => String((await invoke({ action: "my_document_url", id })).url ?? "");

/** /staff/welcome#t=: the one-time set-password link that goes out with the offer. */
export interface AccountView { name: string; firstName: string; email: string; expiresAt: string }
/** The shortest staff password: Business Rule auth.password_min_staff (staff-onboarding checks the same). */
export let PASSWORD_MIN = 12;
onHrRules(() => { PASSWORD_MIN = Math.max(12, hrNumber("auth.password_min_staff", 12)); });
/** The same rule the server applies (staff-onboarding passwordProblem). */
export function newPasswordProblem(password: string, confirmation: string, email = ""): string | null {
  if (password.length < PASSWORD_MIN) return `Choose a password of at least ${PASSWORD_MIN} characters.`;
  if (password.length > 72) return "Choose a password of at most 72 characters.";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "Use at least one letter and one number.";
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (email && (password.toLowerCase() === email.toLowerCase() || (local.length >= 4 && password.toLowerCase().includes(local)))) return "Do not use your email address as the password.";
  if (password !== confirmation) return "The two passwords do not match.";
  return null;
}
export const accountLink = {
  open: async (t: string) => (await invoke({ action: "account_open", t })).view as AccountView,
  /** Sets the chosen password and uses the link up; answers the email to sign in with. */
  setup: async (t: string, password: string) => String((await invoke({ action: "account_setup", t, password })).email ?? ""),
  forget: () => { try { sessionStorage.removeItem(STORE + "account"); } catch { /* storage unavailable */ } },
};

/** hr_staff_onboarding_me: the signed-in person's own record before they are Active (offer and documents only). */
export interface MyOnboarding {
  status: StaffStatus; name?: string; firstName?: string; email?: string; position?: string | null;
  offer?: { filename: string; sentAt: string; signedAt: string | null } | null;
  documents?: Array<{ id: string; category: string; filename: string; status: "pending" | "approved" | "rejected"; expiryDate: string | null; uploadedAt: string }>;
}
export async function myOnboarding(): Promise<MyOnboarding | null> {
  const { data, error } = await supabase.rpc("hr_staff_onboarding_me");
  if (error) throw new Error(error.message || "We could not load your record.");
  return (data ?? null) as MyOnboarding | null;
}
