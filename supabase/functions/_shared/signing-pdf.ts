// Documents & Signatures: the signed PDF and the completion certificate (SIGN-02). Runtime-neutral (Deno function and the offline tests
// run the same code; pdf-lib comes from the function's import map or node_modules). Everything is drawn from the ORIGINAL document every
// time somebody signs, so a signed copy never depends on an earlier signed copy. The PDFs exist only in memory here; nothing is logged.
import { degrees, rgb } from "pdf-lib";
import { PdfWriter, type ImageData, type Row } from "./notification/pdf-layout.ts";
import { formatDateTime } from "./notification/submission-pdf.ts";
import { paletteOf } from "./offer-letter-pdf.ts";
import { DEFAULT_INSTITUTION, type Letterhead } from "./letterhead.ts";
import { initialsOf } from "./signing.ts";

export interface StampField { id?: string; recipient_id: string | null; type: string; page: number; x: number; y: number; w: number; h: number; value: string | null; done: boolean }
export interface StampSigner {
  id: string; name: string; email: string; role: string; order?: number; required?: boolean; state: string; signer_name?: string | null; signed_at?: string | null;
  signature_kind?: string | null; signature_image?: string | null; viewed_at?: string | null; sent_at?: string | null; ip?: string | null; user_agent?: string | null;
}
export interface StampInput { reference: string; title: string; fields: StampField[]; recipients: StampSigner[] }
export const MAX_SIGNATURE_IMAGE_BYTES = 280 * 1024;

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
/** A drawn or uploaded signature as the PNG the page made of it (the page converts every picture to PNG), or an error the signer can act on. */
export function signatureImageBytes(base64: unknown): Uint8Array {
  const text = typeof base64 === "string" ? base64.replace(/^data:image\/png;base64,/, "") : "";
  if (!/^[A-Za-z0-9+/]+=*$/.test(text)) throw new Error("Draw or upload your signature first.");
  const bytes = fromBase64(text);
  if (!isPng(bytes) || bytes.length > MAX_SIGNATURE_IMAGE_BYTES) throw new Error("The signature picture could not be used. Draw it again or choose a smaller picture.");
  return bytes;
}

const INK = rgb(0.05, 0.1, 0.3), GREY = rgb(0.42, 0.45, 0.5);

/**
 * The original with every completed field drawn where it was placed (x, y, w, h are fractions of the page, from its top-left corner) and,
 * for a signer who signed without a signature field on a page, a "Signatures" page at the end. Fields of people who have not signed yet stay empty.
 * A field without a recipient is text the sender printed (a template variable on a PDF template).
 */
export async function stampDocument(original: Uint8Array, input: StampInput): Promise<Uint8Array> {
  // The writer starts one new page after the document's own (used for the signature page below, removed again when nobody needs it).
  const writer = await PdfWriter.open(original, paletteOf(null));
  const pdf = writer.pdf, pages = pdf.getPages().slice(0, -1);
  const signers = new Map(input.recipients.map((r) => [r.id, r]));
  const images = new Map<string, Awaited<ReturnType<typeof pdf.embedPng>>>();
  const imageOf = async (signer: StampSigner) => {
    if (signer.signature_kind === "typed" || !signer.signature_image) return null;
    if (!images.has(signer.id)) images.set(signer.id, await pdf.embedPng(signatureImageBytes(signer.signature_image)));
    return images.get(signer.id)!;
  };
  const fit = (text: string, bold: boolean, width: number, height: number, max = 22) => {
    const font = bold ? writer.bold : writer.regular;
    let size = Math.min(max, height * 0.72);
    while (size > 5 && font.widthOfTextAtSize(text, size) > width) size -= 0.5;
    return { font, size };
  };
  const placedSignature = new Set<string>();
  for (const field of input.fields) {
    if (!field.done) continue;
    const page = pages[field.page - 1];
    if (!page) continue;
    const { width: W, height: H } = page.getSize();
    const box = { x: field.x * W, y: H - (field.y + field.h) * H, w: field.w * W, h: field.h * H };
    const signer = field.recipient_id ? signers.get(field.recipient_id) : null;
    if (field.type === "signature" || field.type === "initials") {
      if (!signer || signer.state !== "signed") continue;
      if (field.type === "signature") placedSignature.add(signer.id);
      const image = field.type === "signature" ? await imageOf(signer) : null;
      const caption = `${writer.clean(signer.signer_name ?? signer.name)}  ${String(signer.signed_at ?? "").slice(0, 16).replace("T", " ")} UTC  ${input.reference}`;
      const captionH = field.type === "signature" && box.h > 22 ? 6 : 0;
      if (image) {
        const scale = Math.min(box.w / image.width, (box.h - captionH) / image.height);
        page.drawImage(image, { x: box.x, y: box.y + captionH + (box.h - captionH - image.height * scale) / 2, width: image.width * scale, height: image.height * scale });
      } else {
        const text = writer.clean(field.type === "initials" ? initialsOf(signer.signer_name ?? signer.name) : signer.signer_name ?? signer.name, true);
        const { font, size } = fit(text, true, box.w - 4, box.h - captionH);
        page.drawText(text, { x: box.x + 2, y: box.y + captionH + (box.h - captionH - size) / 2 + size * 0.22, size, font, color: INK, xSkew: degrees(12) });
      }
      if (captionH) page.drawText(caption.slice(0, 120), { x: box.x, y: box.y + 0.5, size: Math.min(4.5, fit(caption, false, box.w, 100, 4.5).size), font: writer.regular, color: GREY });
    } else if (field.type === "checkbox") {
      if (field.value !== "true") continue;
      const s = Math.min(box.w, box.h), cx = box.x + (box.w - s) / 2, cy = box.y + (box.h - s) / 2;
      page.drawLine({ start: { x: cx + s * 0.15, y: cy + s * 0.5 }, end: { x: cx + s * 0.4, y: cy + s * 0.2 }, thickness: Math.max(1, s * 0.12), color: INK });
      page.drawLine({ start: { x: cx + s * 0.4, y: cy + s * 0.2 }, end: { x: cx + s * 0.85, y: cy + s * 0.8 }, thickness: Math.max(1, s * 0.12), color: INK });
    } else {
      const text = writer.clean(String(field.value ?? "")).trim();
      if (!text) continue;
      const { font, size } = fit(text, false, box.w - 2, box.h, 11);
      page.drawText(text, { x: box.x + 1, y: box.y + (box.h - size) / 2 + size * 0.22, size, font, color: rgb(0, 0, 0) });
    }
  }
  const loose = input.recipients.filter((r) => r.state === "signed" && !placedSignature.has(r.id));
  if (loose.length) {
    writer.header({ institution: DEFAULT_INSTITUTION, logo: null, title: "Signatures", meta: ["Signature page", input.reference] });
    for (const signer of loose) {
      let image: ImageData | null = null;
      if (signer.signature_kind !== "typed" && signer.signature_image) { image = { bytes: signatureImageBytes(signer.signature_image), type: "png" }; await writer.prepareImage(image); }
      const rows: Row[] = [
        { label: "Signature", paras: image ? [{ spans: [{ text: "" }], image }] : [{ spans: [{ text: signer.signer_name ?? signer.name }], bold: true, size: 14 }] },
        { label: "Signed by", paras: [{ spans: [{ text: signer.signer_name ?? signer.name }] }, { spans: [{ text: signer.email, tone: "muted" }] }] },
        { label: "Signed at", paras: [{ spans: [{ text: `${formatDateTime(signer.signed_at) || signer.signed_at} (Australia/Sydney)` }] }, { spans: [{ text: `${signer.signed_at} UTC`, tone: "muted" }] }] },
      ];
      writer.section(signer.role, rows);
    }
    writer.footers(DEFAULT_INSTITUTION, `${input.title} | ${input.reference}`);
  } else pdf.removePage(pdf.getPageCount() - 1);
  pdf.setSubject(`Signed electronically. Reference ${input.reference}`.replace(/[^\x20-\x7e]/g, "?"));
  return await writer.save();
}

export interface CertificateInput extends StampInput {
  id: string; createdAt: string; sentAt?: string | null; completedAt: string; signingMode: string; originalHash: string; signedHash: string; consent: string; chainOk: boolean;
  events: Array<{ event: string; at: string; recipient_id?: string | null; hash?: string | null }>;
}
const EVENT_LABEL: Record<string, string> = { created: "Request created", sent: "Sent for signature", recipient_invited: "Invitation queued", viewed: "Opened by", signed: "Signed by", declined: "Declined by",
  completed: "Completed", resent: "Invitation sent again", reminder_queued: "Reminder queued", email_sent: "Email sent to", email_failed: "Email failed for", email_queued: "Email retried for",
  fields_changed: "Fields changed", opened_signed_in: "Opened while signed in by" };
export const signingEventLabel = (event: string) => EVENT_LABEL[event] ?? event.replaceAll("_", " ");

/** The completion certificate: the document and its hashes, every signer with how and when they signed, and the history with its hash chain. */
export async function buildCertificate(input: CertificateInput, letterhead?: Letterhead | null): Promise<Uint8Array> {
  const institution = letterhead?.institution?.trim() || DEFAULT_INSTITUTION;
  const writer = await PdfWriter.create(`Completion certificate ${input.reference}`, paletteOf(letterhead?.primary));
  let logo = letterhead?.logo ?? null;
  if (logo) { try { await writer.prepareImage(logo); } catch { logo = null; } }
  const when = (value?: string | null) => value ? `${formatDateTime(value) || value} (Australia/Sydney) / ${new Date(value).toISOString()} UTC` : "not recorded";
  writer.header({ institution, logo, title: "Completion certificate", meta: [input.reference, `Completed ${formatDateTime(input.completedAt) || input.completedAt}`] });
  writer.block([{ spans: [{ text: `This certificate records how "${input.title}" was signed through personal links sent by ${institution}. It records access to those links and the actions taken with them; it is not a government identity check or a legal certification.`, tone: "muted" }] }], 10);
  writer.section("Document", [
    { label: "Title", paras: [{ spans: [{ text: input.title }], bold: true }] },
    { label: "Reference", paras: [{ spans: [{ text: input.reference }] }, { spans: [{ text: input.id, tone: "muted" }] }] },
    { label: "Signing order", paras: [{ spans: [{ text: input.signingMode === "parallel" ? "Everyone at the same time" : "One after another" }] }] },
    { label: "Created", paras: [{ spans: [{ text: when(input.createdAt) }] }] },
    { label: "Sent", paras: [{ spans: [{ text: when(input.sentAt) }] }] },
    { label: "Completed", paras: [{ spans: [{ text: when(input.completedAt) }] }] },
    { label: "Original SHA-256", paras: [{ spans: [{ text: input.originalHash }] }] },
    { label: "Signed PDF SHA-256", paras: [{ spans: [{ text: input.signedHash }] }] },
  ]);
  for (const signer of input.recipients) {
    const signed = signer.state === "signed";
    writer.section(`${signer.role}: ${signer.name}`, [
      { label: "Email", paras: [{ spans: [{ text: signer.email }] }] },
      { label: "Result", paras: [{ spans: [{ text: signed ? "Signed" : signer.required === false ? "Optional, did not sign" : signer.state }], bold: true }] },
      ...(signed ? [
        { label: "Signed as", paras: [{ spans: [{ text: signer.signer_name ?? signer.name }] }] },
        { label: "Signature", paras: [{ spans: [{ text: signer.signature_kind === "drawn" ? "Drawn on the page" : signer.signature_kind === "uploaded" ? "Uploaded picture" : "Typed name" }] }] },
        { label: "Opened", paras: [{ spans: [{ text: when(signer.viewed_at) }] }] },
        { label: "Signed", paras: [{ spans: [{ text: when(signer.signed_at) }] }] },
        { label: "IP address", paras: [{ spans: [{ text: signer.ip ?? "not available" }] }] },
        { label: "Browser", paras: [{ spans: [{ text: signer.user_agent ?? "not available" }] }] },
        { label: "Agreement", paras: [{ spans: [{ text: input.consent }], check: true }] },
      ] satisfies Row[] : []),
    ]);
  }
  const names = new Map(input.recipients.map((r) => [r.id, r.name]));
  writer.section("History", [
    ...input.events.map((e) => ({ label: `${new Date(e.at).toISOString().slice(0, 19).replace("T", " ")} UTC`,
      paras: [{ spans: [{ text: `${signingEventLabel(e.event)}${e.recipient_id && names.get(e.recipient_id) ? ` ${names.get(e.recipient_id)}` : ""}` }] }, ...(e.hash ? [{ spans: [{ text: e.hash, tone: "muted" as const }], size: 7 }] : [])] })),
    { label: "History check", paras: [{ spans: [{ text: input.chainOk ? "Each entry carries the hash of the entry before it; the chain was intact when this certificate was made." : "The history chain did NOT verify when this certificate was made.", tone: input.chainOk ? "normal" : "danger" }] }] },
  ]);
  writer.footers(institution, `Completion certificate ${input.reference}`);
  return await writer.save();
}
