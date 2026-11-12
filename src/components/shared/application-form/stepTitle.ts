import { sectionHeading } from "../../feature/applicationFieldHelpers";

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "via"]);
const ACRONYMS = new Set(["USI", "AVETMISS", "OSHC", "SLIT", "VEVO", "RPL", "CRICOS", "COE", "AU"]);

/**
 * The name a step is shown under ("Australian Visa", "Student Identifier (AVETMISS)"), from the step config's title. Display only:
 * matching between steps and missing items still uses sectionHeading.
 */
export function stepTitle(title: string | undefined, index: number): string {
  const heading = sectionHeading(title, index);
  if (heading !== heading.toUpperCase()) return heading;
  return heading
    .split(/(\s+|\/|\(|\))/)
    .map((part, position) => {
      const word = part.replace(/[^A-Za-z]/g, "");
      if (!word) return part;
      if (ACRONYMS.has(word.toUpperCase())) return part.toUpperCase();
      const lower = part.toLowerCase();
      if (position > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}
