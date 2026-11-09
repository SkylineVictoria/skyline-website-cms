// Resume and cover letter files, shared by the public form (staff-register `apply`) and the admin upload for a manual candidate
// (staff-admin `candidate_file`): PDF or Word .docx only, decided by the name AND the content, 5 MB at most, and a safe display name.

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
export const RESUME_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, Math.min(to, bytes.length)));
function includesAscii(bytes: Uint8Array, needle: string): boolean {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + n.length <= bytes.length; i++) {
    for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

/** The file kind from its name AND its content: a PDF starts with %PDF-; a DOCX is a ZIP holding word/document.xml. */
export function detectResume(filename: string, bytes: Uint8Array): "pdf" | "docx" | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "pdf" && ascii(bytes, 0, 5) === "%PDF-") return "pdf";
  if (ext === "docx" && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
    && includesAscii(bytes, "[Content_Types].xml") && includesAscii(bytes, "word/document.xml")) return "docx";
  return null;
}

/** A display name for the stored file: no path, no control characters, at most 120 characters. */
export function safeFilename(name: string, kind: "pdf" | "docx"): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from a user-supplied file name
  const base = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  return base || `resume.${kind}`;
}
