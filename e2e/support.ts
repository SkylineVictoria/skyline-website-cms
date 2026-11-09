import { execFileSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { E2E_ANON_KEY, E2E_API_URL, E2E_DB_CONTAINER, E2E_MAIL_URL, E2E_SERVICE_KEY, assertLocalOnly } from "./env";

assertLocalOnly();

export const PASSWORD = "Correct-Horse-9-Battery";
export const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
export const NEUTRAL_EMAIL = "This email can't be used. Sign in or contact the administrator.";
export const NEUTRAL_PHONE = "This number can't be used. Sign in or contact the administrator.";

let counter = 0;
const run = `${Date.now().toString(36)}`;
/** A unique address and a unique Australian mobile (local form 04xxxxxxxx and E.164 +614xxxxxxxx) for every call. */
export function person(label: string) {
  counter += 1;
  const digits = String((Date.now() % 90_000_000) + 10_000_000 + counter * 7).slice(-8);
  return { email: `${label.toLowerCase()}.${run}.${String(counter).padStart(4, "0")}@example.test`, phone: `+614${digits.slice(0, 8).slice(-8)}`.slice(0, 12), local: `04${digits.slice(0, 8)}` };
}

/** Runs SQL as postgres in the LOCAL database container and returns the trimmed output. */
export function sql(query: string): string {
  return execFileSync("docker", ["exec", "-i", E2E_DB_CONTAINER, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { input: query, encoding: "utf8" }).trim();
}
const q = (value: string) => `'${value.replace(/'/g, "''")}'`;

export const anonClient = (): SupabaseClient => createClient(E2E_API_URL, E2E_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
export const serviceClient = (): SupabaseClient => createClient(E2E_API_URL, E2E_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

export async function createAuthUser(email: string, password = PASSWORD, metadata: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: metadata });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
  return data.user.id;
}

export async function signedInClient(email: string, password = PASSWORD): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign in ${email}: ${error.message}`);
  return client;
}

/** An administrator who can use the CMS: an Auth user with an Active Admin cms_users row. */
export async function createAdmin(label = "admin") {
  const { email } = person(label);
  const id = await createAuthUser(email);
  sql(`insert into public.cms_users(id, name, email, role, status, auth_user_id, must_change_password) values (gen_random_uuid()::text, 'E2E Admin', ${q(email)}, 'Admin', 'Active', '${id}', false)`);
  return { email, id };
}

/** An existing student with a working sign-in (business, student record, portal profile and membership). */
export async function createStudentLogin(label = "student") {
  const { email, local } = person(label);
  const id = await createAuthUser(email);
  const agency = sql(`insert into public.agencies(name, code, status) values ('E2E business ${label}', 'E2E-' || substr(md5(random()::text), 1, 8), 'Active') returning id`).split("\n")[0];
  const student = sql(`insert into public.enrollment_students(agency_id, full_name, email, phone) values ('${agency}', 'E2E Student', ${q(email)}, ${q(local)}) returning id`).split("\n")[0];
  const profile = sql(`insert into public.portal_profiles(auth_user_id, full_name, email, phone, status) values ('${id}', 'E2E Student', ${q(email)}, ${q(local)}, 'Active') returning id`).split("\n")[0];
  sql(`insert into public.agency_memberships(user_id, agency_id, role, student_id) values ('${profile}', '${agency}', 'student', '${student}')`);
  return { email, local, id, agency, student };
}

/** YYYY-MM-DD `days` from today (UTC). */
export const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export type StaffCategory = "Passport" | "Visa" | "English" | "Academic" | "Driving Licence" | "Health Insurance";
const SLUG: Record<StaffCategory, string> = { Passport: "passport", Visa: "visa", English: "english", Academic: "academic", "Driving Licence": "driving-licence", "Health Insurance": "health-insurance" };

/** Uploads one file to {uid}/{doc slug}/ and registers it, exactly as the browser does. Returns the document id and path. */
export async function addStaffDocument(client: SupabaseClient, uid: string, category: StaffCategory, expiry: string | null, replaces?: string): Promise<{ id: string; path: string }> {
  const path = `${uid}/${SLUG[category]}/${category.toLowerCase().replace(/ /g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;
  const up = await client.storage.from("staff-documents").upload(path, PDF, { contentType: "application/pdf" });
  if (up.error) throw new Error(`upload ${category}: ${up.error.message}`);
  const { data, error } = await client.rpc("hr_staff_document_add", { p_category: category, p_path: path, p_filename: `${SLUG[category]}.pdf`, p_mime: "application/pdf", p_size: PDF.length, p_expiry: expiry, p_replaces: replaces ?? null });
  if (error) throw new Error(`hr_staff_document_add ${category}: ${error.message}`);
  return { id: (data as { id: string }).id, path };
}

/** A staff applicant (not a citizen) taken to `submitted` through the same functions the browser calls, with all five required documents. */
export async function submittedApplicant(label: string, role: "admin" | "trainer", options: { passportExpiry?: string } = {}) {
  const { email, phone } = person(label);
  const id = await createAuthUser(email, PASSWORD, { account_type: "staff", registrant: "staff", staff_password_set: true });
  const client = await signedInClient(email);
  const call = async (fn: string, args?: Record<string, unknown>) => { const { data, error } = await client.rpc(fn, args); if (error) throw new Error(`${fn}: ${error.message}`); return data; };
  await call("hr_staff_start", { p_phone: phone, p_requested_role: null });
  await call("hr_staff_save", { p_patch: { first_name: label, last_name: "Applicant", date_of_birth: "1990-05-06", address_street: "1 Example St", address_suburb: "Melbourne", address_state: "VIC", address_postcode: "3000", address_country: "Australia", emergency_name: "Em Contact", emergency_relationship: "Sibling", emergency_phone: "+61422333444", requested_role: role } });
  await call("hr_staff_set_citizenship", { p_citizen: false });
  const passport = await addStaffDocument(client, id, "Passport", options.passportExpiry ?? inDays(800));
  const visa = await addStaffDocument(client, id, "Visa", inDays(400));
  const english = await addStaffDocument(client, id, "English", null);
  const academic = await addStaffDocument(client, id, "Academic", null);
  const health = await addStaffDocument(client, id, "Health Insurance", inDays(300));
  await call("hr_staff_submit");
  const profileId = sql(`select id from hr.staff_profiles where auth_user_id = '${id}'`);
  return { email, phone, id, client, profileId, path: passport.path, docs: { passport, visa, english, academic, health } };
}

/** Approves every current document of a profile as `adminClient` (the admin review function, as the detail page calls it). */
export async function approveAllDocuments(adminClient: SupabaseClient, profileId: string): Promise<void> {
  for (const docId of sql(`select id from hr.staff_documents where profile_id = '${profileId}' and is_current`).split("\n").filter(Boolean)) {
    const { error } = await adminClient.rpc("hr_admin_staff_document_review", { p_doc: docId, p_decision: "approved", p_note: null });
    if (error) throw new Error(`review ${docId}: ${error.message}`);
  }
}

/* ------------------------------------------------------------------ mail (Mailpit) */

export async function clearMail(): Promise<void> { await fetch(`${E2E_MAIL_URL}/api/v1/messages`, { method: "DELETE" }); }

/** The newest email to `address`, as { code, link }. Polls briefly: Auth sends it a moment after the request. */
export async function latestMail(address: string, notBefore = 0): Promise<{ code: string; link: string; at: number }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const list = await (await fetch(`${E2E_MAIL_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`)).json() as { messages?: Array<{ ID: string; Created: string }> };
    const newest = [...(list.messages ?? [])].sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
    if (newest && Date.parse(newest.Created) > notBefore) {
      const message = await (await fetch(`${E2E_MAIL_URL}/api/v1/message/${newest.ID}`)).json() as { HTML: string };
      const code = message.HTML.match(/id="code">(\d+)</)?.[1];
      const link = (message.HTML.match(/href="([^"]+)"/)?.[1] ?? "").replace(/&amp;/g, "&");
      if (code) return { code, link, at: Date.parse(newest.Created) };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No email arrived for ${address}`);
}

/* ------------------------------------------------------------------ browser */

export async function signInThroughTheForm(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto("/login");
  await page.getByRole("tab", { name: "Sign in" }).click();
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).last().click();
}

export async function signOutEverywhere(page: Page): Promise<void> {
  await page.evaluate(() => { try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* ignore */ } });
  await page.context().clearCookies();
}

/** Calls the public staff-register function the way the page does (no browser). */
export async function staffRegister(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${E2E_API_URL}/functions/v1/staff-register`, { method: "POST", headers: { "Content-Type": "application/json", apikey: E2E_ANON_KEY }, body: JSON.stringify({ agreed: true, ...body }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

export async function expectStatusBadge(page: Page, label: string): Promise<void> {
  await expect(page.getByTestId("staff-status")).toHaveText(label);
}

/** The staff-register rate-limit counters (per IP and per email) are cleared so one test's calls never count against the next. */
export function resetRateLimits(): void {
  sql(`delete from public.public_assistant_rate_limits where bucket like 'staff-register:%' or bucket like 'self-register:%'`);
}

/** The newest email to `address` as raw HTML with its verify link and, when the template shows one, the code. */
export async function latestConfirmation(address: string, notBefore = 0): Promise<{ html: string; link: string; code: string | null; at: number }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const list = await (await fetch(`${E2E_MAIL_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`)).json() as { messages?: Array<{ ID: string; Created: string }> };
    const newest = [...(list.messages ?? [])].sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
    if (newest && Date.parse(newest.Created) > notBefore) {
      const message = await (await fetch(`${E2E_MAIL_URL}/api/v1/message/${newest.ID}`)).json() as { HTML: string };
      const link = message.HTML.match(/href="([^"]*\/auth\/v1\/verify[^"]*)"/)?.[1];
      if (link) return { html: message.HTML, link: link.replace(/&amp;/g, "&"), code: message.HTML.match(/code:?\s*(?:<[^>]+>)?\s*(\d{6})/)?.[1] ?? null, at: Date.parse(newest.Created) };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No confirmation email arrived for ${address}`);
}

/** The first link in the newest email to `address` (the invitation or confirmation link Auth sent). */
export async function latestLink(address: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const list = await (await fetch(`${E2E_MAIL_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`)).json() as { messages?: Array<{ ID: string; Created: string }> };
    const newest = [...(list.messages ?? [])].sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
    if (newest) {
      const message = await (await fetch(`${E2E_MAIL_URL}/api/v1/message/${newest.ID}`)).json() as { HTML: string };
      const link = message.HTML.match(/href="([^"]*\/auth\/v1\/verify[^"]*)"/)?.[1];
      if (link) return link.replace(/&amp;/g, "&");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No link arrived for ${address}`);
}
