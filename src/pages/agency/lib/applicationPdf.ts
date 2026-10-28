import { buildSubmissionPdf } from "../../../../supabase/functions/_shared/notification/submission-pdf";
import { supabase } from "@/pages/admin/lib/supabase";
import { currentPortalScope } from "@/lib/portalScope";
import type { ApplicationDetail } from "@/pages/agency/lib/portalApplications";

/** Builds the application PDF in the browser from the loaded record (same builder as the submission email) and saves it. */
export function downloadApplicationPdf(application: ApplicationDetail): void {
  const bytes = buildSubmissionPdf({
    reference: application.reference || "Draft",
    institution: currentPortalScope()?.name || "Skyline Institute of Technology",
    version: application.version,
    submittedAt: application.submittedAt,
    snapshot: { ...application.data, courses: application.courses },
  });
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
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
