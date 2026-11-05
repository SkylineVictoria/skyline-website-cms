// Local-only settings for the Playwright suite. The defaults are the public demo keys every `supabase start` stack uses; nothing
// here can reach the hosted project, and assertLocalOnly() fails the run before anything starts if the URL is not local.
export const E2E_API_URL = process.env.E2E_SUPABASE_URL ?? "http://127.0.0.1:56321";
export const E2E_MAIL_URL = process.env.E2E_MAIL_URL ?? "http://127.0.0.1:56324";
export const E2E_DB_CONTAINER = process.env.E2E_DB_CONTAINER ?? "supabase_db_staff-e2e";
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3011);
export const E2E_ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
export const E2E_SERVICE_KEY = process.env.E2E_SUPABASE_SERVICE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

export function assertLocalOnly(): void {
  for (const [name, value] of [["E2E_SUPABASE_URL", E2E_API_URL], ["E2E_MAIL_URL", E2E_MAIL_URL]] as const) {
    const host = new URL(value).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`${name} must be a local address; refusing to run end-to-end tests against ${host}.`);
  }
  if (/supabase\.(co|in)|xcpydisstlvtvcsqnjob|qoylrmorezlqdvufonmx/i.test(`${E2E_API_URL} ${process.env.VITE_PUBLIC_SUPABASE_URL ?? ""}`)) {
    throw new Error("Refusing to run end-to-end tests against a hosted Supabase project.");
  }
}
