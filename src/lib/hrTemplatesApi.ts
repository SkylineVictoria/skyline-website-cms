import { supabase } from "@/pages/admin/lib/supabase";
import type { TemplatePerson, TemplateType } from "../../supabase/functions/_shared/hr-template";

/**
 * The HRMS side of the one template table (hr.sign_templates since 20261113170000): the letter and email templates as "Send offer
 * letter" and the mail senders read them, and one person's placeholder values. Templates themselves are created, edited, duplicated,
 * archived, deleted and made default through `signing_admin` (src/lib/signingApi.ts), the same calls as Documents & Signatures.
 * The placeholder catalogue, sanitising and rendering live in supabase/functions/_shared/hr-template.ts, shared with the Edge Functions.
 */
export interface HrTemplate {
  id: string; type: TemplateType; name: string; subject: string; bodyHtml: string; isDefault: boolean;
  archivedAt: string | null; createdAt: string; updatedAt: string;
}

function fail(error: { message?: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

/** One person's raw values for the placeholders (formatted by templateValues). */
export async function templatePerson(profileId: string): Promise<TemplatePerson> {
  const { data, error } = await supabase.rpc("hr_admin_template_values", { p_id: profileId });
  if (error) fail(error, "That person's details could not be loaded.");
  return data as TemplatePerson;
}

/** Everything "Send offer letter" needs: the templates to choose from, the person's values and what still blocks the letter. */
export interface OfferLetterContext {
  status: string; problem: string | null; values: TemplatePerson; templates: HrTemplate[];
  letter: { offerId: string; templateId: string | null; templateName: string; title: string; bodyHtml: string; edited?: boolean; createdAt: string } | null;
}
export async function offerLetterContext(profileId: string): Promise<OfferLetterContext> {
  const { data, error } = await supabase.rpc("hr_admin_offer_letter_context", { p_id: profileId });
  if (error) fail(error, "The offer letter could not be prepared.");
  return data as OfferLetterContext;
}
