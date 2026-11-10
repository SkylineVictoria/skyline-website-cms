// Fetching and recognising a logo for a PDF letterhead. No PDF engine here (only the ImageData type), so a function can read Website
// Settings and fetch the logo at boot without loading pdf-lib and the embedded fonts; submission-pdf.ts re-exports these.
import type { ImageData } from "./pdf-layout.ts";

/** Detects a PNG or JPEG by its signature; anything else (SVG, WebP, HTML error pages) cannot be embedded. */
export function imageFromBytes(bytes: Uint8Array): ImageData | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { bytes, type: "png" };
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { bytes, type: "jpg" };
  return null;
}

const MAX_LOGO_BYTES = 1024 * 1024;
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|\[.*\]|\d{1,3}(\.\d{1,3}){3})$/i;

/** Formats the PDF engine cannot embed itself but a browser can rasterise to PNG. */
export type LogoFormat = "webp" | "gif" | "svg";
export function sniffUnembeddable(bytes: Uint8Array): LogoFormat | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (bytes.length > 6 && ascii(0, 4) === "GIF8") return "gif";
  const head = new TextDecoder().decode(bytes.slice(0, 512)).trimStart().toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")) ? "svg" : null;
}
export type LogoRasteriser = (bytes: Uint8Array, format: LogoFormat) => Promise<ImageData | null>;

/**
 * Fetches the tenant logo for embedding (never hotlinked). Only https URLs of public host names, PNG or JPEG, up to 1 MB and a short timeout;
 * WebP, GIF and SVG are converted to PNG when a rasteriser is supplied (the browser has one, the Edge runtime does not).
 * Anything else, including every failure, returns null so the PDF (and the email) falls back to the institution name as text; the cause is
 * logged as a short warning with the host only (never the path or query, which can carry tokens).
 */
export async function loadLogo(logo: unknown, base: string | null, fetcher: typeof fetch = fetch, allowRelativeHttp = false, rasterise?: LogoRasteriser): Promise<ImageData | null> {
  let host = "unknown";
  const fail = (reason: string) => { console.warn(`[pdf-logo] logo not embedded: ${reason} (host ${host})`); return null; };
  try {
    if (typeof logo !== "string" || !logo.trim()) return null;
    const url = new URL(logo.trim(), base ?? undefined);
    host = url.hostname;
    const local = allowRelativeHttp && url.protocol === "http:";
    if (!local && url.protocol !== "https:") return fail("URL is not https");
    if (!local && PRIVATE_HOST.test(url.hostname)) return fail("host is private or blocked");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetcher(url.toString(), { signal: controller.signal, redirect: "error" });
      if (!response.ok) return fail(`fetch returned HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_LOGO_BYTES) return fail("file is larger than 1 MB");
      const image = imageFromBytes(bytes);
      if (image) return image;
      const format = sniffUnembeddable(bytes);
      if (format && rasterise) return (await rasterise(bytes, format)) ?? fail(`${format.toUpperCase()} could not be converted to PNG`);
      return fail(format ? `${format.toUpperCase()} is not supported here, use a PNG or JPEG logo` : "file is not a PNG or JPEG image");
    } finally { clearTimeout(timer); }
  } catch (cause) { return fail(cause instanceof Error && cause.name === "AbortError" ? "fetch timed out" : "fetch failed (network, redirect or CORS)"); }
}
