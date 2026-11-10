// Content sniffing shared by the guest-documents function and the browser (Drive download check). Pure; no imports.
// The decision is made by the bytes, never by the declared type or the extension.

export type Sniffed = { ok: true; kind: "pdf" | "jpeg" | "png"; mime: string; ext: string } | { ok: false; found: string };

const text = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));

/** "%PDF-" anywhere in the first 1024 bytes (the PDF spec allows leading bytes), a JPEG or PNG signature at offset 0. */
export function sniffContent(bytes: Uint8Array): Sniffed {
  if (!bytes.length) return { ok: false, found: "an empty file" };
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ok: true, kind: "jpeg", mime: "image/jpeg", ext: "jpg" };
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { ok: true, kind: "png", mime: "image/png", ext: "png" };
  if (text(bytes, 0, Math.min(bytes.length, 1024)).includes("%PDF-")) return { ok: true, kind: "pdf", mime: "application/pdf", ext: "pdf" };
  const head = text(bytes, 0, Math.min(bytes.length, 64)).replace(/^﻿|^\xEF\xBB\xBF/, "").trimStart();
  const lower = head.toLowerCase();
  if (lower.startsWith("<!doctype html") || lower.startsWith("<html") || lower.startsWith("<head") || lower.startsWith("<body")) return { ok: false, found: "a web page (HTML)" };
  if (lower.startsWith("<?xml") || lower.startsWith("<")) return { ok: false, found: "XML or a web page" };
  if (lower.startsWith("{") || lower.startsWith("[")) return { ok: false, found: "JSON" };
  if (text(bytes, 4, 8) === "ftyp" && /heic|heix|hevc|mif1|msf1|heif/i.test(text(bytes, 8, 12))) return { ok: false, found: "a HEIC photo (not converted)" };
  if (text(bytes, 0, 2) === "PK") return { ok: false, found: "a ZIP or Office file" };
  if (text(bytes, 0, 3) === "GIF") return { ok: false, found: "a GIF image" };
  // eslint-disable-next-line no-control-regex -- looking for binary bytes
  if (!/[\u0000-\u0008\u000e-\u001f]/.test(text(bytes, 0, Math.min(bytes.length, 512)))) return { ok: false, found: "plain text" };
  return { ok: false, found: "an unrecognised file type" };
}
