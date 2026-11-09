import { supabase } from "@/pages/admin/lib/supabase";
import type { StaffDocCategory, StaffStatus } from "@/lib/staffStatus";
import type { StaffDocSummary, StaffDocument } from "@/lib/staffApi";

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
}
export interface OnboardingView {
  profile: OnboardingProfile; status: StaffStatus; mode: "documents" | "reupload"; readOnly: boolean; expiresAt: string;
  documents: StaffDocument[]; requiredCategories: StaffDocCategory[]; summary: StaffDocSummary;
}

export class LinkInvalidError extends Error {}

const STORE = "skyline.staff-link.";
/** Reads the token from #t=... (then stores it for this tab and clears it from the address bar), or the stored one. */
export function takeLinkToken(kind: "onboard" | "offer"): string | null {
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

async function invoke(body: Record<string, unknown> | FormData): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke("staff-onboarding", { body });
  if (error) {
    let message = error.message;
    let code: string | undefined;
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try {
        const parsed = (await context.clone().json()) as { error?: string; code?: string };
        if (parsed?.error) message = parsed.error;
        code = parsed?.code;
      } catch { /* keep the generic message */ }
    }
    if (code === "link_invalid") throw new LinkInvalidError(message);
    throw new Error(message || "Something went wrong. Please try again.");
  }
  return (data ?? {}) as Record<string, unknown>;
}
const viewOf = (r: Record<string, unknown>) => r.view as OnboardingView;

export const onboarding = {
  open: async (t: string) => viewOf(await invoke({ action: "open", t })),
  save: async (t: string, patch: Record<string, string | boolean | null>) => viewOf(await invoke({ action: "save", t, patch })),
  setExpiry: async (t: string, id: string, expiryDate: string) => viewOf(await invoke({ action: "expiry", t, id, expiryDate })),
  remove: async (t: string, id: string) => viewOf(await invoke({ action: "remove", t, id })),
  extract: async (t: string, id: string) => viewOf(await invoke({ action: "extract", t, id })),
  submit: async (t: string) => viewOf(await invoke({ action: "submit", t })),
  viewUrl: async (t: string, id: string) => String((await invoke({ action: "view_url", t, id })).url ?? ""),
  upload: async (t: string, category: StaffDocCategory, file: File, expiryDate: string | null, replaces?: string) => {
    if (file.size <= 0 || file.size > 10 * 1024 * 1024) throw new Error("The file must be 10 MB or smaller.");
    const body = new FormData();
    body.set("action", "upload");
    body.set("t", t);
    body.set("category", category);
    body.set("expiryDate", expiryDate ?? "");
    body.set("replaces", replaces ?? "");
    body.set("file", file, file.name);
    return viewOf(await invoke(body));
  },
};

/** /staff/offer#t=: the offer sent by link (HR-02e). The consent wording comes from the server and is stored with the signature. */
export interface OfferView {
  name: string; status: StaffStatus; readOnly: boolean; expiresAt: string;
  offer: { id: string; filename: string; fileSize: number; sentAt: string | null; signedAt: string | null; signerName: string | null };
}
export const offerLink = {
  open: async (t: string) => { const r = await invoke({ action: "offer_open", t }); return { view: r.view as OfferView, consent: String(r.consent ?? "") }; },
  viewUrl: async (t: string, which: "offer" | "signed") => String((await invoke({ action: "offer_view_url", t, which })).url ?? ""),
  sign: async (t: string, name: string, consent: boolean) => { const r = await invoke({ action: "offer_sign", t, name, consent }); return { view: r.view as OfferView, consent: String(r.consent ?? "") }; },
};
