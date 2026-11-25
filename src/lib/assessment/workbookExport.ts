/**
 * ASM-WORKBOOK item 8, browser side: "Export as workbook PDF", and the letterhead every workbook view draws.
 *
 * ASM-HEADER (owner, 2026-11-23): the header is the master workbook's: the header picture on the left (the institution setting
 * Assessments > Settings > Workbook header, asm_workbook_header; the bundled Skyline logo /templates/image.png until one is set or
 * while the database does not have the setting yet) and the address block on the right (Website Settings: address, RTO / CRICOS,
 * email, phone), with a line under it. No legal-name line. Changing the setting tells every open preview (HEADER_EVENT).
 */
import { supabase } from "@/pages/admin/lib/supabase";
import { loadLogo } from "../../../supabase/functions/_shared/notification/submission-pdf";
import { rasteriseLogo } from "@/pages/agency/lib/applicationPdf";
import { buildWorkbookPdf, type WorkbookAttempt, type WorkbookInstitution } from "./workbookPdf";
import type { AttemptHistory } from "./resultsSheet";
import type { Definition } from "./types";
import type { AttemptSignature } from "./api";

/** The Skyline logo shipped with the site: "Use current Skyline logo", and the header while none is set. */
export const DEFAULT_WORKBOOK_HEADER = "/templates/image.png";
/** Shown beside the upload: what a header picture should be. */
export const WORKBOOK_HEADER_HINT = "PNG, at least 1200 × 300 px, transparent or white background, under 1 MB";
export const WORKBOOK_HEADER_MAX_BYTES = 1024 * 1024;
/** window event fired after the header setting changes; previews listen and read it again. */
export const HEADER_EVENT = "asm-workbook-header";

/** The letterhead as the pages draw it: the header picture's address and the address block (no name line). */
export interface WorkbookLetterhead { name: string; lines: string[]; logoUrl: string | null }
/** The header setting: available = the database has it (migration 20261123235917); url = the picture set, null = none yet. */
export interface WorkbookHeaderSetting { available: boolean; url: string | null }

let addressCache: Promise<{ name: string; lines: string[] }> | null = null;
let headerCache: Promise<WorkbookHeaderSetting> | null = null;

function readAddress(): Promise<{ name: string; lines: string[] }> {
  addressCache ??= (async () => {
    const fallback = { name: "Skyline Institute of Technology", lines: [] as string[] };
    try {
      const { data, error } = await supabase.from("cms_settings").select("name, address, rto, cricos, email, phone").order("id", { ascending: true }).limit(1);
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
      return { name: s("name") || fallback.name, lines };
    } catch {
      return fallback;
    }
  })();
  return addressCache;
}

/** The header setting (null url: none set yet). A database without the setting reads as not available. */
export function workbookHeaderSetting(): Promise<WorkbookHeaderSetting> {
  headerCache ??= (async () => {
    const { data, error } = await supabase.rpc("asm_workbook_header");
    if (error) return { available: false, url: null };
    const url = (data as { url?: string | null } | null)?.url ?? null;
    return { available: true, url: url || null };
  })();
  return headerCache;
}

/** Saves the header picture (a template-assets URL or DEFAULT_WORKBOOK_HEADER; null clears it) and refreshes every preview. */
export async function saveWorkbookHeader(url: string | null): Promise<string | null> {
  const { data, error } = await supabase.rpc("asm_workbook_header_set", { p_url: url });
  if (error) throw new Error(error.message || "The workbook header was not saved.");
  const saved = (data as { url?: string | null } | null)?.url ?? null;
  headerCache = Promise.resolve({ available: true, url: saved });
  window.dispatchEvent(new CustomEvent(HEADER_EVENT, { detail: saved }));
  return saved;
}

export async function workbookLetterhead(): Promise<WorkbookLetterhead> {
  const [address, header] = await Promise.all([readAddress(), workbookHeaderSetting()]);
  return { name: address.name, lines: address.lines, logoUrl: header.url ?? DEFAULT_WORKBOOK_HEADER };
}

/** The letterhead with the picture's bytes, for the PDF. */
export async function workbookInstitution(): Promise<WorkbookInstitution> {
  const head = await workbookLetterhead();
  let logo: WorkbookInstitution["logo"] = null;
  try { logo = head.logoUrl ? await loadLogo(head.logoUrl, window.location.origin, fetch, window.location.protocol === "http:", rasteriseLogo) : null; } catch { logo = null; }
  return { name: head.name, lines: head.lines, logo };
}

/** The blank workbook (as a student receives it) for the wizard's "Workbook (PDF) view". */
export async function blankWorkbookPdf(definition: Definition, title: string): Promise<Uint8Array> {
  const institution = await workbookInstitution();
  const history: AttemptHistory = { student: null, trainers: [], assessment: null, attempts: [], complete: true };
  return buildWorkbookPdf({ definition, title, institution, history, blank: true, attempt: { attemptNo: 1, responses: {}, assessorResponses: {}, results: [], evidence: [], submittedAt: null } });
}

/** A marked submission as the workbook PDF (bytes), for the sign-off's Preview PDF. */
export async function workbookPdfBytes(args: { definition: Definition; attempt: WorkbookAttempt; history: AttemptHistory; title: string; maxAttempts?: number; signatures?: AttemptSignature[] }): Promise<Uint8Array> {
  const institution = await workbookInstitution();
  return buildWorkbookPdf({ ...args, institution });
}

export async function downloadWorkbookPdf(args: { definition: Definition; attempt: WorkbookAttempt; history: AttemptHistory; title: string; maxAttempts?: number; signatures?: AttemptSignature[] }): Promise<void> {
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
