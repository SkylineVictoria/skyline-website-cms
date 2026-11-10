// The letterhead every Skyline PDF shares (offer letter, signature page; the submitted application reads the same settings through
// notification_delivery_submission): the institution name, its logo and primary colour from Website Settings (public.cms_settings).
// Every part is optional: a missing or unreadable logo prints the name instead, an invalid colour falls back to the Skyline orange.
import type { ImageData } from "./notification/pdf-layout.ts";
import { loadLogo } from "./notification/pdf-logo.ts";

export interface Letterhead { institution: string; logo: ImageData | null; primary: string | null }
export const DEFAULT_INSTITUTION = "Skyline Institute of Technology";

interface SettingsClient { from(table: string): { select(columns: string): { order(column: string, options: { ascending: boolean }): { limit(n: number): PromiseLike<{ data: unknown; error: unknown }> } } } }

/** Reads the first Website Settings row with the given client (service role in the functions) and fetches the logo; never throws. */
export async function loadLetterhead(client: SettingsClient, fetcher: typeof fetch = fetch): Promise<Letterhead> {
  const fallback: Letterhead = { institution: DEFAULT_INSTITUTION, logo: null, primary: null };
  try {
    const { data, error } = await client.from("cms_settings").select("name, logo, primary_color, theme_configured").order("id", { ascending: true }).limit(1);
    const row = !error && Array.isArray(data) && data[0] && typeof data[0] === "object" ? data[0] as Record<string, unknown> : null;
    if (!row) return fallback;
    const institution = String(row.name ?? "").trim() || DEFAULT_INSTITUTION;
    const primary = row.theme_configured === true && typeof row.primary_color === "string" ? row.primary_color : null;
    const logo = typeof row.logo === "string" && row.logo.trim() ? await loadLogo(row.logo, null, fetcher) : null;
    return { institution, logo, primary };
  } catch {
    return fallback;
  }
}
