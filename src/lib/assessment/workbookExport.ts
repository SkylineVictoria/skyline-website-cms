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

/** The letterhead as the page view (Review step) draws it: name, lines and the logo's address (no bytes). */
export interface WorkbookLetterhead { name: string; lines: string[]; logoUrl: string | null }
let letterheadCache: Promise<{ head: WorkbookLetterhead; logo: string }> | null = null;
function readLetterhead(): Promise<{ head: WorkbookLetterhead; logo: string }> {
  letterheadCache ??= (async () => {
    const fallback = { head: { name: FALLBACK.name, lines: [], logoUrl: null }, logo: "" };
    try {
      const { data, error } = await supabase.from("cms_settings").select("name, legal_name, logo, address, rto, cricos, email, phone").order("id", { ascending: true }).limit(1);
      const row = !error && Array.isArray(data) && data[0] ? (data[0] as Record<string, unknown>) : null;
      if (!row) return fallback;
      const s = (k: string) => (typeof row[k] === "string" ? (row[k] as string).trim() : "");
      const address = s("address").split(/\n|,\s*(?=[A-Z][a-z]+ [A-Z]{2,3}\b)/).map((x) => x.trim()).filter(Boolean);
      const lines = [
        ...address,
        [s("rto") ? `RTO: ${s("rto")}` : "", s("cricos") ? `CRICOS: ${s("cricos")}` : ""].filter(Boolean).join(" "),
        s("email") ? `Email: ${s("email")}` : "",
        s("phone") ? `Phone: ${s("phone")}` : "",
      ].filter(Boolean);
      return { head: { name: s("legal_name") || s("name") || FALLBACK.name, lines, logoUrl: s("logo") || null }, logo: s("logo") };
    } catch {
      return fallback;
    }
  })();
  return letterheadCache;
}
export async function workbookLetterhead(): Promise<WorkbookLetterhead> { return (await readLetterhead()).head; }

/** The blank workbook (as a student receives it) for the wizard's "Workbook (PDF) view". */
export async function blankWorkbookPdf(definition: Definition, title: string): Promise<Uint8Array> {
  const institution = await workbookInstitution();
  const history: AttemptHistory = { student: null, trainers: [], assessment: null, attempts: [], complete: true };
  return buildWorkbookPdf({ definition, title, institution, history, blank: true, attempt: { attemptNo: 1, responses: {}, assessorResponses: {}, results: [], evidence: [], submittedAt: null } });
}

export async function workbookInstitution(): Promise<WorkbookInstitution> {
  try {
    const { head, logo: logoUrl } = await readLetterhead();
    return { name: head.name, lines: head.lines, logo: logoUrl ? await loadLogo(logoUrl, window.location.origin, fetch, window.location.protocol === "http:", rasteriseLogo) : null };
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
