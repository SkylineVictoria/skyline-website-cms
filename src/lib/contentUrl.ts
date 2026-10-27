/** Validate URLs after parsing, including decoded HTML attributes. */
export function safeContentUrl(value: string, kind: "link" | "image" = "link"): string {
  // Retain already-approved raster images saved by the legacy inline uploader.
  // New uploads use Storage. Active SVG/HTML and data navigation remain denied.
  if (kind === "image" && value.length <= 7 * 1024 * 1024 && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(value)) return value;
  try {
    const url = new URL(value, "https://cms.invalid/");
    return ["https:", "http:", ...(kind === "link" ? ["mailto:", "tel:"] : [])].includes(url.protocol) ? value : "";
  } catch { return ""; }
}
