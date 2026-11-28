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
export async function classifyDocument(applicationId: string, file: File, person?: { firstName: string; lastName: string }): Promise<{ step: string; type: string; nameMatch?: boolean | null }> {
  const { supabase } = await import("@/pages/admin/lib/supabase");
  const body = new FormData();
  body.set("applicationId", applicationId);
  body.set("file", file);
  // DOCUMENT-FINDER: with the student's name, the scanner also says whether the document is theirs.
  if (person?.firstName.trim() && person.lastName.trim()) { body.set("firstName", person.firstName.trim()); body.set("lastName", person.lastName.trim()); }
  const { data, error } = await supabase.functions.invoke<{ step?: string; type?: string; nameMatch?: boolean | null }>("document-classify", { body });
  if (error || !data || typeof data.type !== "string") throw new Error("Scanning is unavailable.");
  return { step: typeof data.step === "string" ? data.step : "", type: data.type, nameMatch: typeof data.nameMatch === "boolean" ? data.nameMatch : null };
}

/**
 * DOCUMENT-FINDER (owner 2026-11-28: "with the student's consent, find all their required documents"). A browser cannot search a
 * computer by itself: with the student's consent the browser asks for ONE folder (Downloads first) and everything inside it, sub-folders
 * included, is looked at here on the device. Only the likeliest files go on to be scanned (the document type, and whether it is the
 * student's: document-classify); nothing else leaves the device. Phones, Safari and Firefox have no folder access: the caller opens
 * their photo and file picker instead.
 */
export const canSearchFolders = (): boolean => typeof window !== "undefined" && "showDirectoryPicker" in window;

const SKIP_FOLDERS = /^(\.|node_modules$|appdata$|library$|\$recycle\.bin$|system volume information$|windows$|program files)/i;
const DOC_FILE = /\.(pdf|png|jpe?g)$/i;
const MIME_OF: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

/** How likely a file is to be one of the student's documents, from its name, size and age (higher first). */
export function documentScore(file: { name: string; size: number; lastModified: number }, person?: { firstName: string; lastName: string }, now = Date.now()): number {
  const name = file.name.toLowerCase();
  let score = 0;
  if (guessDocumentType(file.name)) score += 4;
  for (const part of [person?.firstName, person?.lastName]) if (part && part.trim().length >= 2 && name.includes(part.trim().toLowerCase())) score += 3;
  if (/\b(scan|img|image|photo|doc|cam|whatsapp)\b/.test(name.replace(/[_\-.]+/g, " "))) score += 1;
  if (/\.pdf$/i.test(name)) score += 1;
  const years = (now - file.lastModified) / (365 * 24 * 3600 * 1000);
  score += years < 1 ? 2 : years < 3 ? 1 : 0;
  if (file.size < 20 * 1024) score -= 3; // icons, thumbnails
  return score;
}

type DirectoryHandle = { name: string; kind: "directory"; values: () => AsyncIterable<DirectoryHandle | { kind: "file"; name: string; getFile: () => Promise<File> }> };

/**
 * Asks for a folder (Downloads first) and returns its likeliest document files, best first (at most `limit`). Null when the person
 * cancelled the folder choice. `onProgress` is told how many files were looked at.
 */
export async function findDocumentsInFolder(person: { firstName: string; lastName: string } | undefined, onProgress: (looked: number) => void, limit = 40): Promise<File[] | null> {
  const picker = (window as unknown as { showDirectoryPicker: (o: Record<string, unknown>) => Promise<DirectoryHandle> }).showDirectoryPicker;
  let root: DirectoryHandle;
  try { root = await picker({ id: "slit-documents", mode: "read", startIn: "downloads" }); }
  catch { return null; }
  const found: File[] = [];
  let looked = 0;
  const walk = async (dir: DirectoryHandle, depth: number) => {
    if (depth > 6 || looked > 5000) return;
    for await (const entry of dir.values()) {
      if (looked > 5000) return;
      if (entry.kind === "directory") { if (!SKIP_FOLDERS.test(entry.name)) await walk(entry as DirectoryHandle, depth + 1); continue; }
      looked += 1;
      if (looked % 50 === 0) onProgress(looked);
      if (!DOC_FILE.test(entry.name)) continue;
      try {
        const file = await (entry as { getFile: () => Promise<File> }).getFile();
        if (file.size <= 0 || file.size > 10 * 1024 * 1024) continue;
        // Some systems give no type: the name decides it (the upload checks the content again).
        const ext = file.name.split(".").pop()!.toLowerCase();
        found.push(file.type ? file : new File([file], file.name, { type: MIME_OF[ext], lastModified: file.lastModified }));
      } catch { /* unreadable: skipped */ }
    }
  };
  await walk(root, 0);
  onProgress(looked);
  const now = Date.now();
  return found.sort((a, b) => documentScore(b, person, now) - documentScore(a, person, now) || b.lastModified - a.lastModified).slice(0, limit);
}
