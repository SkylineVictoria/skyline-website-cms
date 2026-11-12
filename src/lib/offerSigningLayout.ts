import { supabase } from "@/pages/admin/lib/supabase";

/**
 * Where the student signs an offer letter, found in the letter's own text (the template letter and an uploaded PDF alike): initials on
 * every page (in the right margin, level with the footer), the signature in the box next to "Student Signature", the date next to the
 * "Date" below it, and the YES / NO answer after "I elect to pay more ... pre-paid fee". Boxes are fractions of the page from its top-left
 * corner (the hr.sign_fields convention). Without a signature block, the signature, date and answer go near the end of the last page.
 */
export interface OfferLayoutField { type: "initials" | "signature" | "date" | "choice"; page: number; x: number; y: number; w: number; h: number; label: string }
interface Item { str: string; x: number; top: number; bottom: number; right: number; page: number; W: number; H: number }

const CHOICE_LABEL = "I elect to pay more than the required pre-paid fee";
/** Approximate advance widths (Arial / Arimo, em) to find where a run of characters sits inside one text item. */
const charWidth = (c: string) => /[ .,:;·'|!]/.test(c) ? 0.278 : /[il]/.test(c) ? 0.222 : /[Ifjt]/.test(c) ? 0.278 : /[r()-]/.test(c) ? 0.333 : /[mM]/.test(c) ? 0.833
  : /[wW]/.test(c) ? (c === "W" ? 0.944 : 0.722) : /[A-Z]/.test(c) ? 0.667 : 0.556;
const textWidth = (text: string) => [...text].reduce((n, c) => n + charWidth(c), 0) || 1;
const clamp = (v: number) => Math.min(Math.max(v, 0), 1);
const box = (type: OfferLayoutField["type"], page: number, W: number, H: number, x: number, top: number, w: number, h: number, label: string): OfferLayoutField => {
  const fx = clamp(x / W), fy = clamp(top / H);
  return { type, page, x: +fx.toFixed(5), y: +fy.toFixed(5), w: +Math.min(w / W, 1 - fx).toFixed(5), h: +Math.min(h / H, 1 - fy).toFixed(5), label };
};

export async function findOfferSigningLayout(bytes: Uint8Array): Promise<OfferLayoutField[]> {
  const [pdf, worker] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")]);
  pdf.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdf.getDocument({ data: bytes.slice() });
  try {
    const doc = await task.promise;
    const items: Item[] = [];
    const pages: Array<{ W: number; H: number }> = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const view = page.getViewport({ scale: 1 });
      const W = view.width, H = view.height;
      pages.push({ W, H });
      const content = await page.getTextContent();
      for (const raw of content.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number }>) {
        if (!raw.str || !raw.str.trim() || !raw.transform) continue;
        const size = Math.abs(raw.height || raw.transform[3] || 10);
        const x = raw.transform[4], baseline = raw.transform[5];
        items.push({ str: raw.str, x, top: H - baseline - size, bottom: H - baseline + size * 0.25, right: x + (raw.width ?? 0), page: n, W, H });
      }
    }
    const fields: OfferLayoutField[] = [];
    // Initials: every page. On the letter's own "Student Initial ______" blank (the SLIT footer) when there is one; otherwise in the
    // right margin, level with the "Page n of m" line (or the foot of the page).
    pages.forEach(({ W, H }, i) => {
      const onPage = items.filter((it) => it.page === i + 1);
      const blank = onPage.filter((it) => /student\s+initials?\b[^_]*_{3,}/i.test(it.str)).at(-1);
      if (blank) {
        const match = blank.str.match(/(student\s+initials?\b[^_]*)(_{3,})/i)!;
        const start = (match.index ?? 0) + match[1].length;
        const scale = (blank.right - blank.x) / textWidth(blank.str);
        const x = blank.x + textWidth(blank.str.slice(0, start)) * scale, w = textWidth(match[2]) * scale;
        const height = blank.bottom - blank.top;
        fields.push(box("initials", i + 1, W, H, x, blank.top - height * 0.9, Math.max(w, 30), height * 1.9, "Initials"));
        return;
      }
      const line = onPage.filter((it) => /page\s+\d+\s+of\s+\d+/i.test(it.str)).at(-1);
      fields.push(box("initials", i + 1, W, H, W * 0.928, line ? line.top - 6 : H * 0.9, W * 0.062, 20, "Initials"));
    });
    const last = <T,>(list: T[]) => list[list.length - 1];
    const label = last(items.filter((it) => /student'?s?\s+signature/i.test(it.str)));
    if (label) {
      const { page, W, H } = label;
      const sameRow = (a: Item, b: Item) => a.page === b.page && Math.abs(a.top - b.top) < 3;
      // The value column: where the student's name is printed on the row above, else just after the label.
      const nameLabel = last(items.filter((it) => it.page === page && it.top < label.top && /student'?s?\s+name/i.test(it.str)));
      const nameValue = nameLabel ? items.filter((it) => sameRow(it, nameLabel) && it.x > nameLabel.right + 2).sort((a, b) => a.x - b.x)[0] : undefined;
      const column = Math.max(nameValue?.x ?? 0, label.right + 10);
      const dateLabel = items.filter((it) => it.page === page && it.top > label.top + 2 && /^\s*date\s*:?\s*$/i.test(it.str)).sort((a, b) => a.top - b.top)[0];
      const sigTop = label.top - 3;
      const sigBottom = dateLabel ? dateLabel.top - 3 : label.bottom + 30;
      const height = Math.min(Math.max(sigBottom - sigTop, 20), 54);
      const width = Math.min(230, W * 0.93 - column);
      fields.push(box("signature", page, W, H, column, sigTop, width, height, "Student signature"));
      fields.push(box("date", page, W, H, column, dateLabel ? dateLabel.top - 2 : sigTop + height + 4, Math.min(120, width), 15, "Date"));
      const elect = last(items.filter((it) => /elect\s+to\s+pay\s+more/i.test(it.str) && (it.page < page || (it.page === page && it.top < label.top))));
      if (elect) {
        const line = items.filter((it) => sameRow(it, elect));
        const end = Math.max(...line.map((it) => it.right));
        fields.push(box("choice", elect.page, elect.W, elect.H, Math.min(end + 8, elect.W * 0.93 - 70), elect.top - 3, 70, 16, CHOICE_LABEL));
      } else fields.push(box("choice", page, W, H, column, Math.max(sigTop - 22, 20), 70, 16, CHOICE_LABEL));
    } else {
      const n = pages.length, { W, H } = pages[n - 1];
      fields.push(box("choice", n, W, H, W * 0.55, H * 0.7, 70, 16, CHOICE_LABEL));
      fields.push(box("signature", n, W, H, W * 0.35, H * 0.75, 220, 48, "Student signature"));
      fields.push(box("date", n, W, H, W * 0.35, H * 0.82, 120, 15, "Date"));
    }
    return fields;
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/** Before Resend offer letter: the current letter's signing places (a letter issued before online signing has none yet). */
export async function prepareOfferResend(applicationId: string): Promise<void> {
  try {
    const current = await supabase.rpc("portal_offer_letter_current", { p_application: applicationId });
    const id = (current.data as { id?: string } | null)?.id;
    if (current.error || !id) return;
    const content = await supabase.rpc("portal_offer_letter_content", { p_letter: id });
    const base64 = (content.data as { contentBase64?: string } | null)?.contentBase64;
    if (content.error || !base64) return;
    await saveOfferSigningLayout(id, Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
  } catch { /* the defaults are used */ }
}

/** Stores where the student signs this letter (before the email is sent); a failure only means the default places are used. */
export async function saveOfferSigningLayout(letterId: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const layout = await findOfferSigningLayout(bytes);
    const { error } = await supabase.rpc("portal_offer_letter_sign_layout", { p_letter: letterId, p_layout: layout });
    if (error) throw new Error(error.message);
    return true;
  } catch (error) {
    console.warn("[offer-signing] the signing places could not be stored; the defaults will be used", error);
    return false;
  }
}
