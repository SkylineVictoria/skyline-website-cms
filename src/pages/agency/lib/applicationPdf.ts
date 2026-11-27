import { buildSubmissionPdf, loadLogo, type LogoFormat } from "../../../../supabase/functions/_shared/notification/submission-pdf";
import type { ImageData } from "../../../../supabase/functions/_shared/notification/pdf-layout";
import { appendSignedPage, hasSignedParts, signedBy, type SignedParts } from "../../../../supabase/functions/_shared/notification/signed-page";
import { supabase } from "@/pages/admin/lib/supabase";
import { currentPortalScope } from "@/lib/portalScope";
import type { ApplicationDetail } from "@/pages/agency/lib/portalApplications";

/** The browser can turn a WebP, GIF or SVG logo into a PNG through a canvas (the Edge runtime cannot). null when it cannot be drawn. */
export async function rasteriseLogo(bytes: Uint8Array, format: LogoFormat): Promise<ImageData | null> {
  const type = format === "svg" ? "image/svg+xml" : format === "webp" ? "image/webp" : "image/gif";
  const url = URL.createObjectURL(new Blob([bytes as unknown as ArrayBuffer], { type }));
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error("decode")); img.src = url; });
    const scale = Math.min(1, 600 / Math.max(1, image.naturalWidth || image.width));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width || 300) * scale));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height || 100) * scale));
    canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return png ? { bytes: new Uint8Array(await png.arrayBuffer()), type: "png" } : null;
  } catch {
    return null;
  } finally { URL.revokeObjectURL(url); }
}

/** The letterhead from Website Settings (name, logo, colour, timezone); anything missing only degrades the look, never the download. */
async function branding(): Promise<{ institution: string; logo: ImageData | null; primary: string | null; timezone: string | null }> {
  const fallback = { institution: currentPortalScope()?.name || "Skyline Institute of Technology", logo: null, primary: null, timezone: null };
  try {
    const { data, error } = await supabase.from("cms_settings").select("name, logo, primary_color, theme_configured, timezone").order("id", { ascending: true }).limit(1);
    const row = !error && Array.isArray(data) && data[0] ? data[0] as Record<string, unknown> : null;
    if (!row) return fallback;
    const logo = typeof row.logo === "string" && row.logo.trim() ? await loadLogo(row.logo, window.location.origin, fetch, window.location.protocol === "http:", rasteriseLogo) : null;
    return {
      institution: String(row.name ?? "").trim() || fallback.institution, logo,
      primary: row.theme_configured === true && typeof row.primary_color === "string" ? row.primary_color : null,
      timezone: typeof row.timezone === "string" ? row.timezone : null,
    };
  } catch {
    return fallback;
  }
}

/** Builds the application PDF in the browser from the loaded record (the same branded builder as the submission email) and saves it. */
export async function downloadApplicationPdf(application: ApplicationDetail): Promise<void> {
  const brand = await branding();
  const bytes = await buildSubmissionPdf({
    reference: application.reference || "Draft",
    institution: brand.institution,
    version: application.version,
    submittedAt: application.submittedAt,
    snapshot: { ...application.data, courses: application.courses },
    branding: { primary: brand.primary, logo: brand.logo, timezone: brand.timezone },
  });
  const url = URL.createObjectURL(new Blob([bytes as unknown as ArrayBuffer], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `application-${(application.reference || application.id).replace(/[^A-Za-z0-9-]/g, "")}.pdf`;
  document.body.appendChild(link); // some browsers ignore a click on a detached link
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Records an administrator opening or exporting application data. The audit log accepts no direct client writes, so this goes through
 * portal_log_admin_access, which only administrators may call. A failed log stops the download; the one exception is a database that
 * does not have the function yet (not released), where downloads keep working unlogged.
 */
export async function logAdminAccess(applicationId: string, action: "document_viewed" | "document_downloaded" | "pdf_exported", detail: Record<string, unknown> = {}): Promise<void> {
  const { error } = await supabase.rpc("portal_log_admin_access", { p_application_id: applicationId, p_action: action, p_detail: detail });
  if (!error) return;
  if (error.code === "PGRST202" || error.code === "42883") return;
  throw new Error(`The access could not be logged, so nothing was opened. ${error.message}`);
}

/**
 * SIGNED-APPLICATION (owner 2026-11-27): what was signed (public.application_signed_copy): the drawn signatures, the declarations with the
 * wording the student agreed to (stored with its version, not today's text), the parent / guardian, the submission snapshot, and the
 * signed copy the portal keeps (made by the submission email). No signing certificate details (IP, signing key, user agent, hashes)
 * ever reach the page or the PDF: they stay in the database.
 */
export interface SignedCopy extends SignedParts {
  declarations: (SignedParts["declarations"][number] & { key: string; version: string | null; guardian: string | null; guardianRelationship: string | null })[];
  handoff: { state: string | null; signedAt: string | null; signedBy: string | null } | null;
  storedCopy: { version: number; fileName: string; createdAt: string } | null;
  submission: { reference: string | null; submittedAt: string | null; version: number | null; snapshot: Record<string, unknown> } | null;
}

export async function getSignedCopy(applicationId: string): Promise<SignedCopy | null> {
  const { data, error } = await supabase.rpc("application_signed_copy", { p_application: applicationId });
  if (error) return null;
  return data as SignedCopy;
}

/** Who signed and when, for the card ("Signed by <student> on <date>"). */
export function signedSummary(copy: SignedCopy, fallbackName: string): { name: string; at: string | null } {
  const who = signedBy(copy, fallbackName);
  return { name: who.name, at: who.at || copy.handoff?.signedAt || copy.submission?.submittedAt || null };
}

/** The portal's stored signed copy (made by the submission email), or null when there is none yet. */
async function storedSignedCopy(applicationId: string): Promise<Uint8Array | null> {
  const { data, error } = await supabase.rpc("application_signed_copy_file", { p_application: applicationId });
  if (error || !data || typeof (data as { content?: unknown }).content !== "string") return null;
  return Uint8Array.from(atob((data as { content: string }).content), (c) => c.charCodeAt(0));
}

/**
 * The signed application: the stored copy when the portal has one; otherwise built here the same way the email worker builds it
 * (the submitted form from the submission snapshot, then the signature page from the shared builder).
 */
export async function buildSignedApplicationPdf(application: ApplicationDetail, copy: SignedCopy): Promise<Uint8Array> {
  if (copy.storedCopy) {
    const stored = await storedSignedCopy(application.id);
    if (stored) return stored;
  }
  const brand = await branding();
  const submission = copy.submission;
  const reference = submission?.reference || application.reference || "Draft";
  const form = await buildSubmissionPdf({
    reference, institution: brand.institution, version: submission?.version ?? application.version,
    submittedAt: submission?.submittedAt ?? application.submittedAt,
    snapshot: submission?.snapshot ?? { ...application.data, courses: application.courses },
    branding: { primary: brand.primary, logo: brand.logo, timezone: brand.timezone },
  });
  return hasSignedParts(copy) ? appendSignedPage(form, copy, { reference, studentName: application.studentName || "", timezone: brand.timezone }) : form;
}
