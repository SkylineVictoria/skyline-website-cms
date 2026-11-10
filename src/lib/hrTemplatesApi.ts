import { supabase } from "@/pages/admin/lib/supabase";
import type { TemplatePerson, TemplateType } from "../../supabase/functions/_shared/hr-template";

/**
 * HRMS > Templates (Admin only; every call is a SECURITY DEFINER function that checks hr.require_admin()). The placeholder
 * catalogue, sanitising and rendering live in supabase/functions/_shared/hr-template.ts, shared with the Edge Functions that send.
 */
export interface HrTemplate {
  id: string; type: TemplateType; name: string; subject: string; bodyHtml: string; isDefault: boolean;
  archivedAt: string | null; createdAt: string; updatedAt: string;
}
export interface HrTemplateForm { type: TemplateType; name: string; subject: string; bodyHtml: string }

function fail(error: { message?: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}
async function one(name: string, args: Record<string, unknown>, fallback: string): Promise<HrTemplate> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) fail(error, fallback);
  return data as HrTemplate;
}

export async function listTemplates(): Promise<HrTemplate[]> {
  const { data, error } = await supabase.rpc("hr_admin_templates", { p_include_archived: true });
  if (error) fail(error, "The templates could not be loaded.");
  return (data ?? []) as HrTemplate[];
}
export const saveTemplate = (id: string | null, form: HrTemplateForm) => one("hr_admin_template_save", { p_id: id, p_template: form }, "The template could not be saved.");
export const duplicateTemplate = (id: string) => one("hr_admin_template_duplicate", { p_id: id }, "The template could not be copied.");
export const archiveTemplate = (id: string, archived: boolean) => one("hr_admin_template_archive", { p_id: id, p_archived: archived }, "That could not be done.");
export const setDefaultTemplate = (id: string) => one("hr_admin_template_set_default", { p_id: id }, "The default could not be changed.");

/** One person's raw values for the placeholders (formatted by templateValues). */
export async function templatePerson(profileId: string): Promise<TemplatePerson> {
  const { data, error } = await supabase.rpc("hr_admin_template_values", { p_id: profileId });
  if (error) fail(error, "That person's details could not be loaded.");
  return data as TemplatePerson;
}

/** Everything "Send offer letter" needs: the templates to choose from, the person's values and what still blocks the letter. */
export interface OfferLetterContext {
  status: string; problem: string | null; values: TemplatePerson; templates: HrTemplate[];
  letter: { offerId: string; templateId: string | null; templateName: string; title: string; bodyHtml: string; createdAt: string } | null;
}
export async function offerLetterContext(profileId: string): Promise<OfferLetterContext> {
  const { data, error } = await supabase.rpc("hr_admin_offer_letter_context", { p_id: profileId });
  if (error) fail(error, "The offer letter could not be prepared.");
  return data as OfferLetterContext;
}
