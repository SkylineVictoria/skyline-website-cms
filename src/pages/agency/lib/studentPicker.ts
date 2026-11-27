import { looksLikeEmail } from "../../../lib/identity/email";

/** What was typed goes into the form: an email into Email, anything else into the name. */
export function prefillFromSearch(typed: string): { firstName: string; lastName: string; email: string } {
  const text = typed.trim();
  if (!text) return { firstName: "", lastName: "", email: "" };
  if (text.includes("@") || looksLikeEmail(text)) return { firstName: "", lastName: "", email: text.toLowerCase() };
  if (/^[\d\s+()-]+$/.test(text)) return { firstName: "", lastName: "", email: "" };
  const words = text.split(/\s+/);
  return { firstName: words[0] ?? "", lastName: words.slice(1).join(" "), email: "" };
}
