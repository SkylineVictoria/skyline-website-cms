// The three sections of a document template (TPL-02) and the check shown before it is saved.
import { bracketWarnings, richPlainText } from "../../supabase/functions/_shared/rich-html";
import { tokenReport, type TokenReport } from "../../supabase/functions/_shared/template-variables";

export type Section = "header" | "body" | "footer";
export interface Sections { header_html: string; body_html: string; footer_html: string }
export const SECTION_TITLES: Record<Section, string> = { header: "Header", body: "Body", footer: "Footer" };

/** What the three sections ask for (registry variables, signer fields, automatic ones) and the bracket warnings. */
export function sectionsReport(s: Sections, title: string): { report: TokenReport; warnings: string[] } {
  const texts = { header: richPlainText(s.header_html), body: richPlainText(s.body_html), footer: richPlainText(s.footer_html) };
  return {
    report: tokenReport([title, texts.header, texts.body, texts.footer]),
    warnings: [...bracketWarnings(title, "Title"), ...(["header", "body", "footer"] as Section[]).flatMap((k) => bracketWarnings(texts[k], SECTION_TITLES[k]))],
  };
}
