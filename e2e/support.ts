import { execFileSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import { E2E_ANON_KEY, E2E_API_URL, E2E_DB_CONTAINER, E2E_MAIL_URL, E2E_POSTMARK_MOCK_URL, E2E_SERVICE_KEY, assertLocalOnly } from "./env";

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
  return { email: `${label.toLowerCase()}.${run}.${String(counter).padStart(4, "0")}@example.test`, phone: `+614${digits}`, local: `04${digits}` };
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

/** A real PDF (pdf-lib), and one whose trailer declares encryption (what a password-protected export looks like). */
export async function offerPdf(pages = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage().drawText(`E2E offer page ${i + 1}`, { x: 50, y: 700 });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
export async function protectedPdf(): Promise<Buffer> {
  return Buffer.from((await offerPdf()).toString("latin1").replace(/trailer\s*<</, "trailer\n<< /Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>"), "latin1");
}

/* ------------------------------------------------------------------ HR mail (mock Postmark run by scripts/lab/staff-lab.mjs e2e) */

export interface MockMail { to: string; subject: string; text: string; attachments: Array<{ Name: string; ContentType: string }> }
export async function hrMails(address?: string): Promise<MockMail[]> {
  const all = await (await fetch(`${E2E_POSTMARK_MOCK_URL}/__messages`)).json() as MockMail[];
  return address ? all.filter((m) => String(m.to).split(",").map((a) => a.trim()).includes(address)) : all;
}
/** The newest HR email to `address` whose subject matches, waiting a moment (mail is sent after the HTTP answer). */
export async function waitForHrMail(address: string, subject: RegExp): Promise<MockMail> {
  for (let i = 0; i < 60; i++) {
    const found = (await hrMails(address)).filter((m) => subject.test(m.subject)).at(-1);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No HR email "${subject}" for ${address}`);
}
export const linkToken = (text: string): string => decodeURIComponent(text.match(/#t=([A-Za-z0-9_%-]+)/)?.[1] ?? "");
/** "ok" sends; "fail" answers 422 Inactive recipient. */
export async function setHrMailMode(mode: "ok" | "fail"): Promise<void> { await fetch(`${E2E_POSTMARK_MOCK_URL}/__mode?m=${mode}`, { method: "POST" }); }

/* ------------------------------------------------------------------ staff flows through the real functions (no browser) */

export function resetRateLimits(): void {
  sql(`delete from public.public_assistant_rate_limits where bucket like 'staff-register:%' or bucket like 'staff-onboarding:%' or bucket like 'self-register:%'`);
}

/** The public application (staff-register), as the form sends it. Returns the profile id. */
export async function applyAsStaff(label: string): Promise<{ id: string; email: string; local: string }> {
  const who = person(label);
  const form = new FormData();
  for (const [k, v] of Object.entries({ action: "apply", firstName: "E2E", lastName: label, email: who.email, phone: who.phone, agreed: "true", captchaToken: "mock-ok", website: "" })) form.set(k, v);
  form.set("resume", new Blob([PDF], { type: "application/pdf" }), "cv.pdf");
  const res = await fetch(`${E2E_API_URL}/functions/v1/staff-register`, { method: "POST", body: form, headers: { apikey: E2E_ANON_KEY, "x-forwarded-for": `198.51.100.${(counter % 200) + 1}` } });
  if (res.status !== 200) throw new Error(`apply ${res.status} ${await res.text()}`);
  return { id: sql(`select id from hr.staff_profiles where email = ${q(who.email)}`), email: who.email, local: who.local };
}

export async function staffAdmin(client: SupabaseClient, body: Record<string, unknown> | FormData): Promise<Record<string, unknown>> {
  const { data, error } = await client.functions.invoke("staff-admin", { body });
  if (error) throw new Error(`staff-admin ${body instanceof FormData ? body.get("action") : body.action}: ${error.message}`);
  return data as Record<string, unknown>;
}

export async function onboard(body: Record<string, unknown>, file?: { bytes: Buffer; name: string; type?: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  let init: RequestInit;
  if (file) {
    const form = new FormData();
    for (const [k, v] of Object.entries(body)) form.set(k, String(v ?? ""));
    form.set("file", new Blob([file.bytes], { type: file.type ?? "application/pdf" }), file.name);
    init = { method: "POST", body: form, headers: { apikey: E2E_ANON_KEY } };
  } else init = { method: "POST", body: JSON.stringify(body), headers: { apikey: E2E_ANON_KEY, "content-type": "application/json" } };
  const res = await fetch(`${E2E_API_URL}/functions/v1/staff-onboarding`, init);
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

/** Takes an applicant through the real functions to `target`, as admin `adminClient`. Citizen: three required documents. */
export async function staffAt(adminClient: SupabaseClient, label: string, target: "documents_submitted" | "offer_sent" | "offer_signed" | "active", role: "admin" | "trainer" = "trainer"): Promise<{ id: string; email: string; local: string; token: string; offerToken?: string }> {
  const p = await applyAsStaff(label);
  await staffAdmin(adminClient, { action: "send_invite", profileId: p.id, purpose: "documents" });
  const token = linkToken((await waitForHrMail(p.email, /details and documents/i)).text);
  await onboard({ action: "save", t: token, patch: { first_name: "E2E", last_name: label, date_of_birth: "1990-05-06", address_street: "1 E2E St", address_country: "Australia", emergency_name: "Em", emergency_relationship: "Sibling", emergency_phone: "0422 333 444", is_australian_citizen: true } });
  for (const [category, expiryDate] of [["Passport", inDays(1500)], ["Academic", ""], ["Health Insurance", inDays(300)]]) {
    const r = await onboard({ action: "upload", t: token, category, expiryDate }, { bytes: PDF, name: `${category}.pdf` });
    if (r.status !== 200) throw new Error(`upload ${category}: ${JSON.stringify(r.body)}`);
  }
  if ((await onboard({ action: "submit", t: token })).status !== 200) throw new Error("submit failed");
  for (const id of sql(`select id from hr.staff_documents where profile_id = '${p.id}' and is_current`).split("\n").filter(Boolean)) {
    const { error } = await adminClient.rpc("hr_admin_staff_document_review", { p_doc: id, p_decision: "approved", p_note: null });
    if (error) throw new Error(`review: ${error.message}`);
  }
  if (target === "documents_submitted") return { ...p, token };
  const form = new FormData();
  form.set("action", "offer_upload"); form.set("profileId", p.id); form.set("file", new Blob([await offerPdf()], { type: "application/pdf" }), "offer.pdf");
  await staffAdmin(adminClient, form);
  await staffAdmin(adminClient, { action: "offer_send", profileId: p.id });
  const offerToken = linkToken((await waitForHrMail(p.email, /offer letter from Skyline/i)).text);
  if (target === "offer_sent") return { ...p, token, offerToken };
  const signed = await onboard({ action: "offer_sign", t: offerToken, name: `E2E ${label}`, consent: true });
  if (signed.status !== 200) throw new Error(`sign: ${JSON.stringify(signed.body)}`);
  if (target === "offer_signed") return { ...p, token, offerToken };
  // Active at once: the email already has a confirmed login (like a student or agent).
  await createAuthUser(p.email);
  await staffAdmin(adminClient, { action: "activate", profileId: p.id, role, joiningDate: inDays(14), confirmAdmin: role === "admin" });
  return { ...p, token, offerToken };
}

/* ------------------------------------------------------------------ Auth mail (Mailpit) */

export async function clearMail(): Promise<void> { await fetch(`${E2E_MAIL_URL}/api/v1/messages`, { method: "DELETE" }); }

/** The /auth/v1/verify link in the newest Auth email to `address`. */
export async function latestLink(address: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const list = await (await fetch(`${E2E_MAIL_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`)).json() as { messages?: Array<{ ID: string; Created: string }> };
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
/** Follows an Auth verify link without a browser and returns where it lands, moved onto `baseURL` (the stack's site_url differs). */
export async function authLanding(verifyLink: string, baseURL: string): Promise<string> {
  const hop = await fetch(verifyLink.replace(/^https?:\/\/[^/]+/, E2E_API_URL), { redirect: "manual" });
  return (hop.headers.get("location") ?? "").replace(/^https?:\/\/[^/]+/, baseURL);
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

export async function signInAsAdmin(page: Page, email: string): Promise<void> {
  await signInThroughTheForm(page, email);
  await expect(page).toHaveURL(/\/admin/);
}

/** Runs one Employees action through its confirmation dialog. */
export async function employeeAction(page: Page, action: string, fill?: () => Promise<void>): Promise<void> {
  await page.getByTestId(`staff-action-${action}`).click();
  await expect(page.getByTestId("staff-action-dialog")).toBeVisible();
  if (fill) await fill();
  await page.getByTestId("staff-decision-confirm").click();
}
export async function expectStatus(page: Page, label: string): Promise<void> {
  await expect(page.getByTestId("staff-detail-status")).toHaveText(label);
}
