import { buildSubmissionPdf, loadLogo, type LogoFormat } from "../../../../supabase/functions/_shared/notification/submission-pdf";
import type { ImageData } from "../../../../supabase/functions/_shared/notification/pdf-layout";
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

/** APPLICATION-DRAWN-SIGNATURE: what the signed copy prints (public.application_signed_copy). */
export interface SignedCopy {
  signatures: { role: "student" | "guardian"; name: string; png: string; signedAt: string; ip: string | null }[];
  declarations: { key: string; title: string; role: string; name: string; at: string; ip: string | null; guardian: string | null }[];
  handoff: { state: string | null; signedAt: string | null; signedBy: string | null } | null;
}

export async function getSignedCopy(applicationId: string): Promise<SignedCopy | null> {
  const { data, error } = await supabase.rpc("application_signed_copy", { p_application: applicationId });
  if (error) return null;
  return data as SignedCopy;
}

/** The signed copy: the application PDF with a signature page (declarations ticked, who, when, IP, the drawn signatures). */
export async function buildSignedApplicationPdf(application: ApplicationDetail, copy: SignedCopy): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const brand = await branding();
  const base = await buildSubmissionPdf({
    reference: application.reference || "Draft", institution: brand.institution, version: application.version,
    submittedAt: application.submittedAt, snapshot: { ...application.data, courses: application.courses },
    branding: { primary: brand.primary, logo: brand.logo, timezone: brand.timezone },
  });
  const pdf = await PDFDocument.load(base);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const safe = (t: string) => t.replace(/[^\x20-\x7E -ÿ]/g, "?");
  const when = (v: string | null) => (v ? new Date(v).toLocaleString("en-AU", { timeZone: brand.timezone || "Australia/Melbourne" }) : "");
  let page = pdf.addPage([595.28, 841.89]);
  let y = 790;
  const line = (text: string, size = 10, f = font, gap = 15) => {
    if (y < 60) { page = pdf.addPage([595.28, 841.89]); y = 790; }
    const words = safe(text).split(" "); let row = "";
    for (const w of words) {
      const next = row ? `${row} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > 495 && row) { page.drawText(row, { x: 50, y, size, font: f, color: rgb(0.1, 0.1, 0.1) }); y -= gap; row = w; } else row = next;
    }
    if (row) { page.drawText(row, { x: 50, y, size, font: f, color: rgb(0.1, 0.1, 0.1) }); y -= gap; }
  };
  line("Signed declaration", 16, bold, 24);
  line(`Application ${application.reference || application.id}`, 10, font, 22);
  line("Declarations read and agreed", 12, bold, 18);
  for (const d of copy.declarations) {
    line(`- ${d.title}`, 10, bold, 13);
    line(`  Agreed by ${d.guardian ? `${d.guardian} (parent / guardian)` : d.name} on ${when(d.at)}${d.ip ? `, from ${d.ip}` : ""}`, 9, font, 16);
  }
  y -= 8;
  for (const s of copy.signatures) {
    if (y < 200) { page = pdf.addPage([595.28, 841.89]); y = 790; }
    line(s.role === "guardian" ? "Signature of the parent / guardian" : "Signature of the student", 12, bold, 16);
    try {
      const png = await pdf.embedPng(s.png.replace(/^data:image\/png;base64,/, ""));
      const scale = Math.min(220 / png.width, 80 / png.height, 1);
      page.drawImage(png, { x: 50, y: y - png.height * scale, width: png.width * scale, height: png.height * scale });
      y -= png.height * scale + 8;
    } catch { line("(signature image could not be read)", 9); }
    line(`${s.name} - signed ${when(s.signedAt)}${s.ip ? ` from ${s.ip}` : ""}`, 10, font, 22);
  }
  if (!copy.signatures.length) line("No drawn signature is recorded for this application (signed before drawn signatures were introduced).", 10);
  return pdf.save();
}
