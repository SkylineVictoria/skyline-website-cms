import { supabase } from "@/pages/admin/lib/supabase";

/** The application's USI check, from public.usi_state (who may do what, the last result, consent). */
export interface UsiState {
  role: "staff" | "student" | "agent" | "viewer";
  canVerify: boolean; canLocate: boolean; canCreate: boolean; canConsent: boolean;
  usi: string | null;
  status: "valid" | "mismatch" | "not_found" | "deactivated" | "stale" | null;
  usiStatus: string | null;
  matches: { firstName: Match; familyName: Match; singleName: Match; dateOfBirth: Match };
  verifiedAt: string | null; environment: "test" | "production" | null; verifiedByName: string | null; verifiedByRole: string | null;
  detailsChanged: boolean;
  locateResult: string | null; locatedAt: string | null; createdAt: string | null; createDocumentType: string | null;
  consentAt: string | null; consentByName: string | null; consentRole: string | null; createRequestedAt: string | null;
  lastError: string | null; lastErrorAt: string | null;
  reverifyPending: boolean; reverifyStopped: boolean; reverifyLastError: string | null;
}
export type Match = "Match" | "NoMatch" | null;

export interface UsiVerifyReply { outcome: "valid" | "mismatch" | "not_found" | "deactivated"; usi: string; usiStatus: string; matches: UsiState["matches"]; environment: string }
export interface UsiLocateReply { outcome: string; usi: string | null; message: string | null; errors: { code: string; message: string }[]; verified: UsiVerifyReply | null; environment: string }
export interface UsiCreateReply { outcome: "created" | "failure"; usi: string | null; identityDocumentVerified: string | null; errors: { code: string; message: string }[]; verified: UsiVerifyReply | null; documentType?: string; environment: string }

/** A refusal or failure from usi-service, with its body (code, problems, missing details). */
export class UsiCallError extends Error {
  code: string;
  body: Record<string, unknown>;
  constructor(message: string, code: string, body: Record<string, unknown>) { super(message); this.code = code; this.body = body; }
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("usi-service", { body });
  if (error) {
    let parsed: Record<string, unknown> = {};
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) { try { parsed = (await context.clone().json()) as Record<string, unknown>; } catch { /* no JSON body */ } }
    throw new UsiCallError(String(parsed.error ?? error.message ?? "The USI service could not be reached."), String(parsed.code ?? ""), parsed);
  }
  return data as T;
}

export async function usiState(applicationId: string): Promise<UsiState> {
  const { data, error } = await supabase.rpc("usi_state", { p_application: applicationId });
  if (error) throw new Error(error.message || "The USI details could not be loaded.");
  return data as UsiState;
}
export async function usiConsent(applicationId: string, given: boolean, requestCreate = false): Promise<UsiState> {
  const { data, error } = await supabase.rpc("usi_consent_set", { p_application: applicationId, p_given: given, p_request_create: requestCreate });
  if (error) throw new Error(error.message || "The permission could not be saved.");
  return data as UsiState;
}
export const usiVerify = (applicationId: string, usi: string) => call<UsiVerifyReply>({ action: "verify", applicationId, usi });
export const usiLocate = (applicationId: string) => call<UsiLocateReply>({ action: "locate", applicationId });
/** Staff only. The document values are sent once and never stored (only the type is kept). */
export const usiCreate = (applicationId: string, document: { type: string; values: Record<string, string> }, overrides: { townCityOfBirth?: string; countryOfBirthCode?: string } = {}) =>
  call<UsiCreateReply>({ action: "create", applicationId, document, overrides });
export const usiCountries = () => call<{ countries: { code: string; name: string }[] }>({ action: "countries" }).then((r) => r.countries);
