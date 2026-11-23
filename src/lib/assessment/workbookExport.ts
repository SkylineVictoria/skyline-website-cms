/**
 * ASM-WORKBOOK item 8, browser side: "Export as workbook PDF". Reads the institution's letterhead from Website Settings (name,
 * logo, address, RTO / CRICOS, email, phone), builds the PDF with `buildWorkbookPdf` and saves it. Nothing is uploaded or stored.
 */
import { supabase } from "@/pages/admin/lib/supabase";
import { loadLogo } from "../../../supabase/functions/_shared/notification/submission-pdf";
import { rasteriseLogo } from "@/pages/agency/lib/applicationPdf";
import { buildWorkbookPdf, type WorkbookAttempt, type WorkbookInstitution } from "./workbookPdf";
import type { AttemptHistory } from "./resultsSheet";
import type { Definition } from "./types";

const FALLBACK: WorkbookInstitution = { name: "Skyline Institute of Technology", lines: [], logo: null };

export async function workbookInstitution(): Promise<WorkbookInstitution> {
  try {
    const { data, error } = await supabase.from("cms_settings").select("name, legal_name, logo, address, rto, cricos, email, phone").order("id", { ascending: true }).limit(1);
    const row = !error && Array.isArray(data) && data[0] ? (data[0] as Record<string, unknown>) : null;
    if (!row) return FALLBACK;
    const s = (k: string) => (typeof row[k] === "string" ? (row[k] as string).trim() : "");
    const address = s("address").split(/\n|,\s*(?=[A-Z][a-z]+ [A-Z]{2,3}\b)/).map((x) => x.trim()).filter(Boolean);
    const lines = [
      ...address,
      [s("rto") ? `RTO: ${s("rto")}` : "", s("cricos") ? `CRICOS: ${s("cricos")}` : ""].filter(Boolean).join(" "),
      s("email") ? `Email: ${s("email")}` : "",
      s("phone") ? `Phone: ${s("phone")}` : "",
    ].filter(Boolean);
    const logo = s("logo") ? await loadLogo(s("logo"), window.location.origin, fetch, window.location.protocol === "http:", rasteriseLogo) : null;
    return { name: s("legal_name") || s("name") || FALLBACK.name, lines, logo };
  } catch {
    return FALLBACK;
  }
}

export async function downloadWorkbookPdf(args: { definition: Definition; attempt: WorkbookAttempt; history: AttemptHistory; title: string; maxAttempts?: number }): Promise<void> {
  const institution = await workbookInstitution();
  const bytes = await buildWorkbookPdf({ ...args, institution });
  const who = (args.history.student?.name || "student").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const unit = args.definition.source?.unit?.code ?? args.history.assessment?.unit?.code ?? "assessment";
  const url = URL.createObjectURL(new Blob([bytes as unknown as ArrayBuffer], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${unit}_${who}_attempt${args.attempt.attemptNo}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
