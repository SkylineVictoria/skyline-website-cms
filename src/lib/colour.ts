// Colour helpers shared by the public site, the loader and the CMS theme editor (pure, browser-safe).

/** The existing Skyline orange and neutral accent (the --primary-500 / --accent-500 tokens in index.css) as sRGB hex. */
export const DEFAULT_PRIMARY_HEX = "#ea6619";
export const DEFAULT_ACCENT_HEX = "#7e8083";

export const isHexColour = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

function channel(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of white text on the given colour. */
export function contrastWithWhite(hex: string): number {
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

export type ContrastLevel = "good" | "large-only" | "poor";
export function contrastLevel(hex: string): ContrastLevel {
  const ratio = contrastWithWhite(hex);
  return ratio >= 4.5 ? "good" : ratio >= 3 ? "large-only" : "poor";
}

/** Accepts "#abc", "abc", "#aabbcc" and returns a normalised "#aabbcc", or null. */
export function normaliseHex(raw: string): string | null {
  const t = raw.trim().replace(/^#/, "");
  const full = /^[0-9a-f]{3}$/i.test(t) ? t.split("").map((c) => c + c).join("") : t;
  return /^[0-9a-f]{6}$/i.test(full) ? `#${full.toLowerCase()}` : null;
}
