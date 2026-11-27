// SIGNED-APPLICATION (owner 2026-11-27): the signature page added after the submitted application form: who signed and when, the
// declarations in the wording the student agreed to (ticked), the drawn signature(s) and, for an under-18 student, the parent / guardian.
// One builder for the email worker (notification-delivery) and the portal's Download, so every copy is the same document.
// No signing certificate detail (IP, signing key, user agent, hashes) is ever passed in or printed: the database keeps those.

export interface SignedParts {
  signatures: { role: "student" | "guardian"; name: string; png: string; signedAt: string }[];
  declarations: { key?: string; title: string; body: string | null; role: string; name: string; at: string }[];
  guardian?: { name: string; relationship: string | null; at: string } | null;
  signedBy?: string | null;
  signedAt?: string | null;
}

/** True when there is something signed to print. */
export const hasSignedParts = (s: SignedParts | null | undefined): s is SignedParts =>
  !!s && ((Array.isArray(s.signatures) && s.signatures.length > 0) || (Array.isArray(s.declarations) && s.declarations.length > 0));

/** Who signed and when: the student's drawn signature, else the recorded signer, else the first declaration. */
export function signedBy(s: SignedParts, fallbackName: string): { name: string; at: string | null } {
  const student = s.signatures.find((x) => x.role === "student");
  const declared = s.declarations.find((d) => d.role !== "guardian");
  return { name: student?.name || s.signedBy || declared?.name || fallbackName, at: student?.signedAt || s.signedAt || declared?.at || null };
}

// The standard PDF font covers Latin-1 only: typographic quotes and dashes are mapped, anything else prints as "?".
const latin1 = (t: string) => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/•/g, "-")
  .replace(/\r/g, "").replace(/[^\n\x20-\x7E\xA0-\xFF]/g, "?");

/** Appends the signature page(s) to the application PDF and returns the new PDF. */
export async function appendSignedPage(pdfBytes: Uint8Array, parts: SignedParts, opts: { reference: string; studentName: string; timezone?: string | null }): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.load(pdfBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const tz = opts.timezone || "Australia/Melbourne";
  const day = (v: string | null | undefined) => {
    if (!v) return "";
    try { return new Date(v).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: tz }); } catch { return String(v).slice(0, 10); }
  };
  const W = 595.28, H = 841.89, LEFT = 50, RIGHT = 545, TOP = 790, BOTTOM = 60;
  let page = pdf.addPage([W, H]);
  let y = TOP;
  const ensure = (room: number) => { if (y - room < BOTTOM) { page = pdf.addPage([W, H]); y = TOP; } };
  const write = (text: string, size = 10, f = font, gap = 14, x = LEFT) => {
    for (const paragraph of latin1(text).split(/\n+/)) {
      let row = "";
      const flush = () => { ensure(gap); page.drawText(row, { x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) }); y -= gap; };
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const next = row ? `${row} ${word}` : word;
        if (f.widthOfTextAtSize(next, size) > RIGHT - x && row) { flush(); row = word; } else row = next;
      }
      if (row) flush();
    }
  };
  const who = signedBy(parts, opts.studentName || "the student");
  write("Signed application", 16, bold, 24);
  write(`Application ${opts.reference}`, 10, font, 16);
  write(`Signed by ${who.name}${who.at ? ` on ${day(who.at)}` : ""}`, 11, bold, 22);
  write("Declarations agreed", 12, bold, 18);
  for (const d of parts.declarations.filter((x) => x.role !== "guardian")) {
    ensure(40);
    page.drawRectangle({ x: LEFT, y: y - 2, width: 9, height: 9, borderWidth: 0.8, borderColor: rgb(0.2, 0.2, 0.2) });
    page.drawText("x", { x: LEFT + 2, y: y - 0.5, size: 8, font: bold, color: rgb(0.1, 0.1, 0.1) });
    write(d.title, 10, bold, 13, LEFT + 16);
    write(d.body || "(The wording of this declaration version is not stored.)", 8.5, font, 11, LEFT + 16);
    y -= 6;
  }
  y -= 8;
  const signature = async (label: string, png: string | null, line: string) => {
    ensure(130);
    write(label, 12, bold, 16);
    if (png) {
      try {
        const image = await pdf.embedPng(png.replace(/^data:image\/png;base64,/, ""));
        const scale = Math.min(220 / image.width, 80 / image.height, 1);
        page.drawImage(image, { x: LEFT, y: y - image.height * scale, width: image.width * scale, height: image.height * scale });
        y -= image.height * scale + 8;
      } catch { write("(signature image could not be read)", 9); }
    }
    write(line, 10, font, 22);
  };
  const student = parts.signatures.find((s) => s.role === "student");
  await signature("Signature of the student", student?.png ?? null,
    student ? `${student.name} - signed ${day(student.signedAt)}` : `${who.name} - agreed to the declarations on ${day(who.at)} (signed before drawn signatures were introduced)`);
  const guardianSig = parts.signatures.find((s) => s.role === "guardian");
  if (guardianSig || parts.guardian) {
    const name = guardianSig?.name || parts.guardian?.name || "";
    const relationship = parts.guardian?.relationship ? ` (${parts.guardian.relationship})` : "";
    await signature("Signature of the parent / guardian", guardianSig?.png ?? null,
      guardianSig ? `${name}${relationship} - signed ${day(guardianSig.signedAt)}` : `${name}${relationship} - not signed yet`);
  }
  return await pdf.save();
}
