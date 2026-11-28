// BULK-DOCUMENTS (owner 2026-11-28): the bulk upload's first guess of each file's type (the user confirms it; the upload checks the file).
/** The document type a file name suggests ("" when it does not say). Never trusted: the upload checks the file itself. */
export function guessDocumentType(filename: string): string {
  const name = filename.toLowerCase().replace(/[_\-.]+/g, " ");
  if (/\b(passport|pp|bio ?page|biodata)\b/.test(name)) return "passport";
  if (/\b(visa|vevo|grant|subclass|immi|pr evidence)\b/.test(name)) return "visa";
  if (/\b(ielts|pte|toefl|oet|cambridge|english|duolingo|trf)\b/.test(name)) return "english";
  if (/\b(licen[cs]e|driver|driving|dl)\b/.test(name)) return "licence";
  if (/\b(transcript|degree|diploma|certificate|cert|marksheet|marks|academic|bachelor|master|hsc|ssc|year ?1[02]|grade|school|university|award)\b/.test(name)) return "academic";
  return "";
}


/**
 * BULK-DOCUMENTS (owner 2026-11-28: "scan each file and attach it where it is needed, no manual categories"): asks document-classify
 * which document a file is. Returns the wizard step id ("" when the application does not ask for it) and the type read; throws when
 * the scanner cannot answer (not deployed, unavailable, limit reached), so the screen can fall back to asking.
 */
export async function classifyDocument(applicationId: string, file: File): Promise<{ step: string; type: string }> {
  const { supabase } = await import("@/pages/admin/lib/supabase");
  const body = new FormData();
  body.set("applicationId", applicationId);
  body.set("file", file);
  const { data, error } = await supabase.functions.invoke<{ step?: string; type?: string }>("document-classify", { body });
  if (error || !data || typeof data.type !== "string") throw new Error("Scanning is unavailable.");
  return { step: typeof data.step === "string" ? data.step : "", type: data.type };
}
