/**
 * Server-managed integrations (integration_definitions.availability = 'environment_managed') read their keys from Edge Function
 * secrets, not from Vault. This list names the secrets each one needs, so Integrations › Connections can show, at handover, which
 * secret names SLIT must enter in Supabase › Edge Functions › Secrets and whether each is set. Only presence is reported: a value is
 * never read out, returned or logged. Keep the names in step with the Deno.env.get calls of the functions named in `usedBy`.
 */
export type ServerSecret = { name: string; required: boolean; note: string };

export const SERVER_SECRETS: Record<string, readonly ServerSecret[]> = {
  openai: [
    { name: "OPENAI_API_KEY", required: true, note: "OpenAI API key (assessment import, AI tutor, document extraction, website assistant)" },
    { name: "OPENAI_DOCUMENT_MODEL", required: true, note: "Model used for document extraction, e.g. gpt-4.1-mini" },
    { name: "EF_ASM_IMPORT_PROVIDER", required: false, note: "Assessment import provider (openai)" },
    { name: "EF_ASM_IMPORT_MODEL", required: false, note: "Assessment import model, if different" },
  ],
  postmark: [
    { name: "EF_POSTMARK_SERVER_TOKEN", required: true, note: "Postmark server API token" },
    { name: "EF_HR_EMAIL_FROM", required: true, note: "Sender address, e.g. SLIT <noreply@slit.edu.au> (a Postmark sender signature)" },
    { name: "EF_NOTIFICATION_EMAIL_ENABLED", required: true, note: "Set to true to send emails" },
    { name: "EF_HR_PUBLIC_SITE_URL", required: true, note: "Website address used in email links, e.g. https://crm.slit.edu.au" },
    { name: "EF_HR_ADMIN_NOTIFY_TO", required: false, note: "HR inbox told about offers signed / declined" },
  ],
  geoscape: [
    { name: "EF_ADDRESS_SEARCH_GEOSCAPE_KEY", required: true, note: "Geoscape consumer key for address search" },
  ],
  training_gov_au: [
    { name: "EF_TGA_SANDBOX_USERNAME", required: true, note: "Training.gov.au web services user name" },
    { name: "EF_TGA_SANDBOX_PASSWORD", required: true, note: "Training.gov.au web services password" },
  ],
  cloudflare_turnstile: [
    { name: "EF_CAPTCHA_SECRET_KEY", required: true, note: "Turnstile secret key (the site key goes in the website's VITE_CAPTCHA_SITE_KEY)" },
  ],
  azure_document_intelligence: [
    { name: "EF_AZURE_DOCUMENT_ENDPOINT", required: true, note: "Azure resource address, e.g. https://name.cognitiveservices.azure.com" },
    { name: "EF_AZURE_DOCUMENT_API_KEY", required: true, note: "Azure Document Intelligence key" },
    { name: "EF_AZURE_DOCUMENT_MODEL", required: false, note: "Model, default prebuilt-idDocument" },
  ],
};

/** For each server-managed connector: every secret name, whether it is set, and whether it is required. Values are never read out. */
export function serverSecretStatus(get: (name: string) => string | undefined = (name) => Deno.env.get(name)) {
  const out: Record<string, { name: string; required: boolean; note: string; set: boolean }[]> = {};
  for (const [connector, secrets] of Object.entries(SERVER_SECRETS)) {
    out[connector] = secrets.map((s) => ({ ...s, set: (get(s.name) ?? "").trim() !== "" }));
  }
  return out;
}
