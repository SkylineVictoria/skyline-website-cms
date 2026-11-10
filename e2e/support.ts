import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
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

/** An Editor: a CMS user who is not an Admin (HRMS is closed to them). */
export async function createEditor(label = "editor") {
  const { email } = person(label);
  const id = await createAuthUser(email);
  sql(`insert into public.cms_users(id, name, email, role, status, auth_user_id, must_change_password) values (gen_random_uuid()::text, 'E2E Editor', ${q(email)}, 'Editor', 'Active', '${id}', false)`);
  return { email, id };
}

/**
 * Screenshots of a step, desktop (1440 wide) and mobile (390 wide), written to E2E_SHOTS_DIR (outside the repo) when it is set.
 * Without it nothing is written, so a normal run leaves no files behind.
 */
let shots = 0;
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  shots += 1;
  const original = page.viewportSize();
  for (const [label, size] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(dir, `${String(shots).padStart(2, "0")}-${name}-${label}.png`), fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

/**
 * With E2E_SHOTS_DIR set, saves the markup of one element next to the screenshots (one tag per line), so two runs can be
 * compared character by character.
 */
export async function domSnapshot(page: Page, selector: string, name: string): Promise<void> {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const html = await page.locator(selector).first().evaluate((el) => el.outerHTML);
  writeFileSync(path.join(dir, `dom-${name}.html`), html.split("><").join(">\n<"));
}

/**
 * With E2E_SHOTS_DIR set, puts two saved screenshots next to each other (student on the left, staff on the right) in one image,
 * compare-<name>.png. The screenshots are found by the end of their file name; a missing one skips the picture.
 */
export async function sideBySide(page: Page, name: string, title: string, left: string, right: string): Promise<void> {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return;
  const find = (suffix: string) => readdirSync(dir).filter((file) => file.endsWith(`${suffix}.png`) && !file.startsWith("compare-")).sort().pop();
  const a = find(left), b = find(right);
  if (!a || !b) return;
  const src = (file: string) => `data:image/png;base64,${readFileSync(path.join(dir, file)).toString("base64")}`;
  const view = await page.context().newPage();
  await view.setViewportSize({ width: 1600, height: 900 });
  await view.setContent(`<body style="margin:0;padding:24px;font-family:system-ui,sans-serif;background:#f4f4f5">
    <h1 style="font-size:20px;margin:0 0 16px">${title}</h1>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start">
      <figure style="margin:0"><figcaption style="font-weight:600;margin-bottom:8px">Student wizard</figcaption><img src="${src(a)}" style="width:100%;border:1px solid #d4d4d8"></figure>
      <figure style="margin:0"><figcaption style="font-weight:600;margin-bottom:8px">Staff onboarding wizard</figcaption><img src="${src(b)}" style="width:100%;border:1px solid #d4d4d8"></figure>
    </div></body>`);
  await view.screenshot({ path: path.join(dir, `compare-${name}.png`), fullPage: true });
  await view.close();
}

/**
 * LOCAL ONLY: records a reading for a student application document straight in the lab database (no reader is called), so the
 * student wizard can be walked through. The test stops the browser's own call to portal-document-extract first.
 */
export function markStudentDocumentRead(applicationId: string, category: string, extracted: Record<string, string>): void {
  const extraction = { status: "unreviewed", extracted, confirmed: {}, source: { engine: "e2e-mock", parser: "document-extraction-v1" } };
  sql(`update public.enrollment_application_documents set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{extraction}', ${q(JSON.stringify(extraction))}::jsonb)
    where application_id = '${applicationId}' and category = ${q(category)} and is_current`);
}

/** The pay details an offer needs (hr_admin_onboarding_pay_save), as the admin form sends them. */
export async function payDetails(adminClient: SupabaseClient, profileId: string, over: Record<string, string> = {}): Promise<void> {
  const schedule = sql("select id from hr.pay_schedules where is_active order by name limit 1");
  const location = sql("insert into hr.locations(name) values ('E2E Campus') on conflict (lower(btrim(name))) do update set name = excluded.name returning id");
  const { error } = await adminClient.rpc("hr_admin_onboarding_pay_save", { p_id: profileId, p_details: { jobTitle: "Trainer", employmentType: "full_time", startDate: inDays(21), payBasis: "hourly", rate: "42.50",
    payScheduleId: schedule, hoursPerWeek: "38", locationId: location, ...over } });
  if (error) throw new Error(`pay details: ${error.message}`);
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

export interface MockMail { to: string; subject: string; text: string; html?: string | null; attachments: Array<{ Name: string; ContentType: string }> }
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
  const saved = await onboard({ action: "save", t: token, patch: { first_name: "E2E", last_name: label, date_of_birth: "1990-05-06", address_street: "1 E2E St", address_suburb: "Melbourne", address_state: "VIC", address_postcode: "3000",
    address_country: "Australia", emergency_name: "Em", emergency_relationship: "Sibling", emergency_phone: "+61 422 333 444", is_australian_citizen: true, nationality: "Australian", passport_number: "PE1234567",
    tax_residency: "resident", tax_free_threshold: "yes", study_loan: "no", super_choice: "default" } });
  if (saved.status !== 200) throw new Error(`details: ${JSON.stringify(saved.body)}`);
  const bank = await onboard({ action: "bank_save", t: token, bank: { accountName: `E2E ${label}`, bsb: "062-000", accountNumber: "1234 4321" } });
  if (bank.status !== 200) throw new Error(`bank details: ${JSON.stringify(bank.body)}`);
  for (const [category, expiryDate] of [["Passport", inDays(1500)], ["Academic", ""], ["Health Insurance", inDays(300)]]) {
    const r = await onboard({ action: "upload", t: token, category, expiryDate }, { bytes: PDF, name: `${category}.pdf` });
    if (r.status !== 200) throw new Error(`upload ${category}: ${JSON.stringify(r.body)}`);
  }
  if ((await onboard({ action: "submit", t: token })).status !== 200) throw new Error("submit failed");
  for (const id of sql(`select id from hr.staff_documents where profile_id = '${p.id}' and is_current`).split("\n").filter(Boolean)) {
    const { error } = await adminClient.rpc("hr_admin_staff_document_review", { p_doc: id, p_decision: "approved", p_note: null });
    if (error) throw new Error(`review: ${error.message}`);
  }
  // Onboarding flow: the pay details come before any offer (documents approved + pay details = ready for the offer).
  await payDetails(adminClient, p.id);
  if (target === "documents_submitted") return { ...p, token };
  // An uploaded PDF sent by its own link (the path that needs no login); the browser journeys use the template + sign-in link.
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

/** Runs one Candidates action through its confirmation dialog (HR-02j). */
export async function candidateAction(page: Page, action: string, fill?: () => Promise<void>): Promise<void> {
  await page.getByTestId(`candidate-action-${action}`).click();
  await expect(page.getByTestId("candidate-dialog")).toBeVisible();
  if (fill) await fill();
  await page.getByTestId("candidate-confirm").click();
}

/**
 * The shared second half of the journey, from the emailed document link to My HR: details and documents on /staff/onboard (no login),
 * review, pay details, the offer letter from a template sent with the person's sign-in link (`office` is signed in as an
 * administrator), the person choosing their password on /staff/welcome and signing the offer on /staff, activation, and a fresh
 * sign-in. Used by the Enroll now journey and the Careers journey. Each step is screenshotted when E2E_SHOTS_DIR is set.
 */
export async function journeyFromDocumentLink(visitor: Page, office: Page, baseURL: string, who: { email: string; profileId: string; fullName: string; street: string; jobTitle?: string }): Promise<void> {
  const token = linkToken((await waitForHrMail(who.email, /details and documents/i)).text);

  // The applicant's wizard on /staff/onboard (no login): documents first, details read from them, the rest typed, bank details, review.
  await visitor.goto(`/staff/onboard#t=${token}`);
  await expect(visitor.getByTestId("staff-step-documents")).toBeVisible();
  expect(visitor.url()).not.toContain(token);
  await shot(visitor, "staff-wizard-documents");
  await visitor.getByTestId("staff-citizen-yes").click();
  await expect(visitor.getByTestId("staff-required-summary")).toContainText("Passport, Academic results, Health insurance (0 of 3 uploaded)");
  for (const slug of ["passport", "academic", "health-insurance"]) {
    await visitor.getByTestId(`staff-doc-${slug}`).locator('input[type="file"]').first().setInputFiles({ name: `${slug}.pdf`, mimeType: "application/pdf", buffer: PDF });
    await expect.poll(() => sql(`select count(*) from hr.staff_documents d where d.profile_id = '${who.profileId}' and d.is_current and lower(replace(d.category, ' ', '-')) = '${slug}'`)).toBe("1");
  }
  await expect(visitor.getByTestId("staff-doc-passport")).toContainText("Done ✓");
  await expect(visitor.getByTestId("staff-required-summary")).toContainText("3 of 3 uploaded");
  await shot(visitor, "staff-wizard-documents-uploaded");
  await visitor.getByTestId("staff-next").click();

  // Check details: read from the passport (the lab reader answers a fixed passport), each with where it came from.
  await expect(visitor.getByTestId("staff-step-prefill")).toBeVisible();
  await expect(visitor.getByTestId("staff-date_of_birth")).toHaveValue("1985-02-03");
  await expect(visitor.getByTestId("staff-source-date_of_birth")).toContainText("From your passport");
  await expect(visitor.getByTestId("staff-passport_number")).toHaveValue("PA1234567");
  await expect(visitor.getByTestId("staff-nationality")).toHaveValue("New Zealander");
  await expect(visitor.getByTestId("staff-expiry-passport")).toHaveValue("2033-01-01");
  // The name they applied with is kept; the passport's different name is pointed out for checking.
  await expect(visitor.getByTestId("staff-source-first_name")).toContainText('does not match your passport, which shows "PASSPORT"');
  await shot(visitor, "staff-wizard-check-details");
  await visitor.getByTestId("staff-next").click();
  await expect(visitor.getByTestId("staff-step-notice")).toContainText("Enter a current expiry date for your health insurance.");
  await visitor.getByTestId("staff-expiry-health-insurance").fill(inDays(300));
  await expect.poll(() => sql(`select count(*) from hr.staff_documents where profile_id = '${who.profileId}' and category = 'Health Insurance' and is_current and expiry_date is not null`)).toBe("1");
  await visitor.getByTestId("staff-next").click();

  // Personal details: the address search (the student form's Geoscape lookup; the lab answers fixed addresses), then the emergency contact.
  await expect(visitor.getByTestId("staff-step-personal")).toBeVisible();
  await visitor.locator("#address-search").fill("12 Smith St Mel");
  await expect(visitor.locator("#address-search-results").getByRole("option").first()).toContainText("12 Smith St, Melbourne VIC 3000");
  await shot(visitor, "staff-wizard-address-search");
  await visitor.locator("#address-search-results").getByRole("option").first().click();
  await expect(visitor.getByTestId("staff-address_street")).toHaveValue("12 Smith St");
  await expect(visitor.getByTestId("staff-address_suburb")).toHaveValue("Melbourne");
  await expect(visitor.getByTestId("staff-address_state")).toHaveValue("VIC");
  await expect(visitor.getByTestId("staff-address_postcode")).toHaveValue("3000");
  await visitor.getByTestId("staff-address_street").fill(who.street);
  await visitor.getByTestId("staff-emergency_name").fill("Em Contact");
  await visitor.getByTestId("staff-emergency_relationship").fill("Sibling");
  await visitor.locator("#staff-emergency_phone").fill("0422333444");
  await visitor.getByTestId("staff-next").click();

  // Bank details: saved on Continue, shown back masked.
  await expect(visitor.getByTestId("staff-step-bank")).toBeVisible();
  await visitor.getByTestId("staff-bank-accountName").fill(who.fullName);
  await visitor.getByTestId("staff-bank-bsb").fill("062000");
  await visitor.getByTestId("staff-bank-accountNumber").fill("12344321");
  await expect(visitor.getByTestId("staff-bank-name")).toContainText("Commonwealth Bank");
  await shot(visitor, "staff-wizard-bank");
  await visitor.getByTestId("staff-next").click();

  // Tax and super: the declaration answers and the super choice (no tax file number is asked for).
  await expect(visitor.getByTestId("staff-step-tax")).toBeVisible();
  await visitor.getByTestId("staff-tax_residency-resident").click();
  await visitor.getByTestId("staff-tax_free_threshold-yes").click();
  await visitor.getByTestId("staff-study_loan-no").click();
  await visitor.getByTestId("staff-super_choice-default").click();
  await shot(visitor, "staff-wizard-tax-super");
  await visitor.getByTestId("staff-next").click();

  // Review and submit.
  await expect(visitor.getByTestId("staff-step-review")).toBeVisible();
  await expect(visitor.getByTestId("staff-problems")).toContainText("All required fields are complete.");
  await expect(visitor.getByTestId("staff-review-bank")).toContainText("•••• 4321");
  await expect(visitor.getByTestId("staff-review-bank")).not.toContainText("12344321");
  expect(sql(`select address_street || '/' || address_state || '/' || emergency_phone_e164 from hr.staff_profiles where id = '${who.profileId}'`)).toBe(`${who.street}/VIC/+61422333444`);
  await shot(visitor, "staff-wizard-review");
  await visitor.getByTestId("staff-submit").click();
  await expect(visitor.getByTestId("staff-onboard-submitted")).toBeVisible();
  await waitForHrMail("hr.one@lab.example.test", /has uploaded documents/);

  // Review in the admin UI: the stepper follows each stage.
  await office.goto(`/admin/staff/employees/${who.profileId}`);
  await expectStatus(office, "Documents submitted");
  await expect(office.getByTestId("staff-onboarding-progress")).toHaveAttribute("data-stage", "documents_submitted");
  await expect(office.getByTestId("staff-action-add_pay_details")).toHaveCount(0);
  await expect(office.getByTestId("staff-action-send_offer")).toHaveCount(0);
  await shot(office, "admin-documents-submitted");
  for (const id of sql(`select id from hr.staff_documents where profile_id = '${who.profileId}' and is_current`).split("\n")) {
    await office.getByTestId(`staff-doc-approve-${id}`).click();
    await expect(office.getByTestId(`staff-doc-approve-${id}`)).toHaveCount(0);
  }
  await office.reload();
  await expect(office.getByTestId("staff-onboarding-progress")).toHaveAttribute("data-stage", "documents_approved");
  await expect(office.getByTestId("onboarding-step-documents_approved")).toHaveAttribute("data-state", "current");
  await expect(office.getByTestId("staff-action-send_offer")).toHaveCount(0);
  await shot(office, "admin-documents-approved");

  // Pay details: required before the offer, every field checked.
  await office.getByTestId("staff-action-add_pay_details").click();
  await expect(office.getByTestId("pay-details-dialog")).toBeVisible();
  await office.getByTestId("pay-job-title").fill(who.jobTitle ?? "Trainer");
  await office.getByTestId("pay-employment-type").selectOption("full_time");
  await office.getByTestId("pay-start-date").fill(inDays(21));
  await office.getByTestId("pay-basis").selectOption("hourly");
  await office.getByTestId("pay-rate").fill("85000");
  await office.getByTestId("pay-details-save").click();
  await expect(office.getByTestId("pay-problem-rate")).toContainText("too high");
  await expect(office.getByTestId("pay-problem-payScheduleId")).toBeVisible();
  await expect(office.getByTestId("pay-problem-hoursPerWeek")).toBeVisible();
  await office.getByTestId("pay-rate").fill("42.50");
  await office.getByTestId("pay-schedule").selectOption({ index: 1 });
  await office.getByTestId("pay-hours").fill("38");
  await shot(office, "admin-pay-details-form");
  await office.getByTestId("pay-details-save").click();
  await expect(office.getByTestId("staff-onboarding-progress")).toHaveAttribute("data-stage", "pay_details");
  await expect(office.getByTestId("staff-pay-details")).toContainText("$42.50 an hour");
  await shot(office, "admin-pay-details-added");

  // Send offer letter: pick the template, preview it filled in, confirm, send (one email with the sign-in link).
  await office.getByTestId("staff-action-send_offer").click();
  await expect(office.getByTestId("offer-letter-preview")).toContainText("$42.50 per hour");
  await expect(office.getByTestId("offer-letter-preview")).toContainText(who.jobTitle ?? "Trainer");
  await expect(office.getByTestId("offer-letter-preview")).not.toContainText("{{");
  await shot(office, "admin-offer-preview");
  await office.getByTestId("offer-send-next").click();
  await expect(office.getByTestId("offer-confirm")).toContainText(who.email);
  await shot(office, "admin-offer-confirm");
  await office.getByTestId("offer-send-confirm").click();
  await expectStatus(office, "Offer sent");
  await expect(office.getByTestId("staff-login-state")).toContainText("password not chosen yet");
  await expect(office.getByTestId("staff-offer-template")).toContainText("Standard offer letter");
  await shot(office, "admin-offer-sent");
  const offerMail = await waitForHrMail(who.email, /offer letter from/i);
  expect(offerMail.text).toContain("/staff/welcome#t=");
  expect(offerMail.text).not.toMatch(/temporary password|password is|password:/i);
  const accountToken = linkToken(offerMail.text);
  expect(sql(`select count(*) from hr.staff_invites where profile_id = '${who.profileId}' and token_hash = '${accountToken}'`)).toBe("0");

  // The person: choose a password through the one-time link, then read and sign the offer on their own page.
  await visitor.goto(`/staff/welcome#t=${accountToken}`);
  await expect(visitor.getByTestId("staff-set-password")).toContainText(who.email);
  expect(visitor.url()).not.toContain(accountToken);
  await visitor.getByTestId("set-password-new").fill("short1");
  await visitor.getByTestId("set-password-confirm").fill("short1");
  await visitor.getByTestId("set-password-save").click();
  await expect(visitor.getByTestId("staff-set-password")).toContainText("at least 12 characters");
  await visitor.getByTestId("set-password-new").fill(PASSWORD);
  await visitor.getByTestId("set-password-confirm").fill(PASSWORD);
  await shot(visitor, "person-set-password");
  await visitor.getByTestId("set-password-save").click();
  await expect(visitor).toHaveURL(/\/staff$/);
  await expect(visitor.getByTestId("staff-preactive")).toBeVisible();
  await expect(visitor.getByTestId("staff-preactive-document")).toHaveCount(3);
  await expect(visitor.getByRole("heading", { name: "My HR" })).toHaveCount(0);
  await expect(visitor.getByTestId("my-hr-role")).toHaveCount(0);
  await expect(visitor.getByTestId("offer-open-pdf")).toHaveAttribute("target", "_blank");
  await shot(visitor, "person-own-offer-before-active");
  expect((await onboard({ action: "account_open", t: accountToken })).status).toBe(403); // the link works once
  await visitor.getByLabel(/Your full name/).fill(who.fullName);
  await visitor.getByRole("checkbox").check();
  await visitor.getByRole("button", { name: "Sign the offer" }).click();
  await expect(visitor.getByTestId("offer-status-line")).toContainText("You signed this offer");
  await expect(visitor.getByTestId("staff-home-status")).toContainText("Thank you for signing");
  await shot(visitor, "person-offer-signed");
  let signedMail: MockMail;
  try { signedMail = await waitForHrMail(who.email, /Your signed offer letter/); }
  catch (e) {
    // The lab's mock mail server can time out under load; the admin then sees the failure under Emails and retries it (the real path).
    const failed = sql(`select e.id from hr.staff_emails e where e.profile_id = '${who.profileId}' and e.kind = 'signed_offer' and e.state = 'failed' order by e.id desc limit 1`);
    if (!failed) throw e;
    await office.reload();
    await office.getByTestId(`staff-email-retry-${failed}`).click();
    signedMail = await waitForHrMail(who.email, /Your signed offer letter/);
  }
  expect(signedMail.attachments[0]?.ContentType).toBe("application/pdf");

  // Activation: the person already has their login, so they are a current employee at once.
  await office.reload();
  await expectStatus(office, "Offer signed");
  await expect(office.getByTestId("staff-login-state")).toContainText("Password chosen");
  await shot(office, "admin-offer-signed");
  await employeeAction(office, "activate", async () => { await expect(office.getByTestId("staff-joining-date")).toHaveValue(inDays(21)); });
  await expectStatus(office, "Active");
  await expect(office.getByTestId("onboarding-step-active")).toHaveAttribute("data-state", "done");
  await expect(office.getByTestId("staff-timeline")).toContainText("Offer signed");
  await expect(office.getByTestId("staff-timeline")).toContainText("E2E Admin");
  await shot(office, "admin-active");
  expect(sql(`select joining_date::text from hr.employment where profile_id = '${who.profileId}'`)).toBe(inDays(21));
  expect(sql(`select status from hr.staff_profiles where id = '${who.profileId}'`)).toBe("active");
  await office.goto("/admin/staff/employees");
  await office.getByRole("tab", { name: "Active", exact: true }).click();
  await office.getByLabel("Search employees").fill(who.email);
  await expect(office.getByTestId("employees-table")).toContainText(who.email);

  // The person's page turns into My HR; a fresh sign-in lands there with the role, documents and the signed offer (and the job).
  await visitor.reload();
  await expect(visitor.getByRole("heading", { name: "My HR" })).toBeVisible();
  await signOutEverywhere(visitor);
  await signInThroughTheForm(visitor, who.email);
  await expect(visitor).toHaveURL(/\/staff$/);
  await expect(visitor.getByRole("heading", { name: "My HR" })).toBeVisible();
  await expect(visitor.getByTestId("my-hr-role")).toContainText("Trainer");
  await expect(visitor.getByTestId("my-hr-document")).toHaveCount(3);
  await expect(visitor.getByRole("button", { name: "Open the signed offer" })).toBeVisible();
  if (who.jobTitle) await expect(visitor.getByTestId("my-hr-employment")).toContainText(who.jobTitle);
  await shot(visitor, "person-my-hr");
}
