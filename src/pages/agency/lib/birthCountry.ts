/** Answer keys the wizard keeps on screen only (never saved): the passport country's AVETMISS label and the Yes / No answer. */
export const PASSPORT_COUNTRY_LABEL = "passport_country_label";
export const BORN_IN_PASSPORT_COUNTRY = "born_in_passport_country";

export type CountryRow = { code: string; label: string };

/** The AVETMISS label for a scanned country: the exact label (any case), else the only hit (an alias); "" when unsure. */
export function pickPassportCountry(scanned: string, rows: CountryRow[]): string {
  const query = scanned.trim().toLowerCase();
  if (!query) return "";
  const exact = rows.find((row) => row.label.toLowerCase() === query);
  if (exact) return exact.label;
  return rows.length === 1 ? rows[0].label : "";
}
