import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPECIMEN, SPECIMEN_FILE, specimenPassportPng } from "./fixtures/specimen-passport";

// A new TEST application through the real UI, for USI testing (2026-11-23, owner).
// 1. The fictional specimen passport (scripts/e2e/fixtures/specimen-passport.ts) is made if missing.
// 2. Signs in as a test admin (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD), New application: the student's email and mobile, the sign-in
//    invitation UNTICKED, Next; business E2E_BUSINESS (default PURVA) and the agent named E2E_AGENT (default Gourav), Next. The UI has no
//    "unassigned" choice (Next needs an agent), so a business with no agents stops the test with that reason instead of guessing.
// 3. The document wizard: uploads the specimen, waits until the document is stored AND read (its state pill, not the time-based
//    animation), then checks the name and date of birth it read; Next saves the passport step. The wizard of a NEW application is never
//    closed with Close (that discards the draft).
// A rerun resumes the draft of the last run (E2E_APPLICATION_ID, else the id saved in the OS temp folder) through
// /admin/applications/<id>?wizard=1, and skips the upload when the passport was already read. E2E_NEW=1 starts a new application.
// 4. Marks the application is_test (the UI cannot): with E2E_TARGET=local-stack through the local service key; with E2E_TARGET=hosted
//    it prints the SQL to run (nothing in this script holds a hosted key).
// If the passport reader refuses the specimen, the test stops with the reader's own message: it is never bypassed.
//   E2E_TARGET=... E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... [E2E_BUSINESS=PURVA E2E_AGENT=Gourav] npx playwright test -c scripts/e2e/playwright.config.ts new-test-application

const STUDENT_EMAIL = process.env.E2E_STUDENT_EMAIL ?? "zz-test-usi@blackhole.postmarkapp.com";
const STUDENT_MOBILE = process.env.E2E_STUDENT_MOBILE ?? "0412345679";
// Owner, 2026-11-23: PURVA with its agent Gourav (Test Agency (admin preview) lists no agent to pick).
const BUSINESS = process.env.E2E_BUSINESS ?? "PURVA";
const AGENT = process.env.E2E_AGENT ?? "Gourav";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function pick(page: Page, label: string, search: string) {
  const box = page.getByRole("combobox", { name: label }).first();
  await box.click();
  await box.fill(search);
  // React ids contain ":", so match the attribute rather than a #id selector.
  const list = page.locator(`[id="${await box.getAttribute("aria-controls")}"]`);
  await expect(list.locator("li").first(), `${label}: the list opens`).toBeVisible();
  // Wait for the search to finish ("Searching…" / "Loading …" first).
  await expect(list).not.toContainText(/Searching|Loading/);
  const option = list.getByRole("option").filter({ hasText: search }).first();
  if (!(await option.count())) {
    const shown = (await list.innerText()).replace(/\s+/g, " ").trim();
    throw new Error(label === "Agent"
      ? `No agent named "${search}" at ${BUSINESS} (the list shows: ${shown || "nothing"}). The form needs an agent and has no unassigned option; set E2E_AGENT or add the agent first.`
      : `No ${label.toLowerCase()} named "${search}" (the list shows: ${shown || "nothing"}).`);
  }
  await option.click();
}

/** The draft this spec made last time (OS temp folder, outside the repo): a rerun resumes it instead of making a second application. */
const RESUME_FILE = join(tmpdir(), "skyline-e2e-test-application.json");
function savedApplicationId(): string {
  try { return String(JSON.parse(readFileSync(RESUME_FILE, "utf8")).applicationId ?? ""); } catch { return ""; }
}
function saveApplicationId(id: string): void {
  writeFileSync(RESUME_FILE, JSON.stringify({ applicationId: id, studentEmail: STUDENT_EMAIL, savedAt: new Date().toISOString() }));
}

/** Visible error / notice text near the upload (the reader's reason when it refuses a document). */
async function readerProblem(page: Page): Promise<string> {
  const notices = page.locator('[role="alert"], [data-tone="error"], .text-red-700, .text-red-800');
  const texts = (await notices.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
  return texts.join(" | ");
}

test("new TEST application with the specimen passport (USI testing)", async ({ page, baseURL }) => {
  const email = process.env.E2E_ADMIN_EMAIL ?? "", password = process.env.E2E_ADMIN_PASSWORD ?? "";
  test.skip(!email || !password, "Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (a TEST admin account).");
  if (!existsSync(SPECIMEN_FILE)) writeFileSync(SPECIMEN_FILE, specimenPassportPng());

  // 2. Sign in.
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: /^Sign in$/ }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });

  // Resume the draft of an earlier run (E2E_APPLICATION_ID, else the id this spec saved) unless E2E_NEW=1: never a second application.
  const resumeId = process.env.E2E_NEW === "1" ? "" : (process.env.E2E_APPLICATION_ID ?? savedApplicationId());
  let applicationId: string;
  if (resumeId) {
    if (!UUID.test(resumeId)) throw new Error(`E2E_APPLICATION_ID is not an application id: ${resumeId}`);
    applicationId = resumeId;
    console.log(`Resuming application ${applicationId}`);
    await page.goto(`/admin/applications/${applicationId}?wizard=1`);
  } else {
    await page.goto("/admin/applications/new");
    await page.locator("#student-email").fill(STUDENT_EMAIL);
    await page.locator("#student-mobile").fill(STUDENT_MOBILE);
    await expect(page.getByTestId("student-email-reuse"), `${STUDENT_EMAIL} already belongs to a student: resume with E2E_APPLICATION_ID, or use E2E_STUDENT_EMAIL`).toHaveCount(0);
    const invite = page.locator('input[name="invite"]');
    if (await invite.count()) { await invite.uncheck(); await expect(invite).not.toBeChecked(); }
    await page.getByRole("button", { name: /^Next/ }).click();
    await pick(page, "Business", BUSINESS);
    await pick(page, "Agent", AGENT);
    await page.getByRole("button", { name: /^Next/ }).click();
    // 3. The wizard: the application now exists; its id is in the wizard's saved step key. Saved at once so a later failure resumes it.
    await expect(page.locator('[aria-labelledby="wizard-title"]').first()).toBeVisible({ timeout: 60_000 });
    applicationId = await page.waitForFunction(() => {
      const key = Object.keys(window.localStorage).find((k) => k.startsWith("slit-portal-wizard-step:"));
      return key ? key.split(":").pop() : null;
    }, null, { timeout: 30_000 }).then((h) => h.jsonValue() as Promise<string>);
    expect(applicationId).toMatch(UUID);
    saveApplicationId(applicationId);
    console.log(`Application created: ${applicationId}`);
  }

  // The passport step, always inside the wizard (on a resumed draft the full application form is behind the wizard dialog with its own
  // upload field, read state, fields and Next: never use those).
  const wizard = page.locator('[aria-labelledby="wizard-title"]').first();
  await expect(wizard, "the document wizard is open").toBeVisible({ timeout: 60_000 });
  await expect(wizard.getByText(/Loading the document wizard/)).toHaveCount(0, { timeout: 60_000 });
  await expect(wizard.getByText(/Step 1 of \d+/), "the wizard is on its first step (Passport)").toBeVisible();
  const READ_STATES = /Ready for review|No details found|Couldn.t read|Not uploaded/;
  // Upload the specimen unless this draft's passport was already read (resume).
  await page.waitForTimeout(2000);   // the step lists the draft's documents once they are loaded
  const alreadyRead = await wizard.getByText("Ready for review").first().isVisible().catch(() => false);
  if (alreadyRead) console.log("The passport on this draft is already read: no upload.");
  else await wizard.locator('input[type="file"]:not([capture])').first().setInputFiles(SPECIMEN_FILE);
  // Wait for the upload AND the reader: the reading animation ("Uploading…", "Reading your document…", "Finding your details…",
  // "Almost there…") is time-based while the file is still uploading, so only the document's own state counts as finished.
  try {
    await expect(wizard.getByText(READ_STATES).first()).toBeVisible({ timeout: 300_000 });
    await expect(wizard.getByText(/^(Uploading…|Reading your document…|Finding your details…|Almost there…)$/)).toHaveCount(0, { timeout: 60_000 });
  } catch {
    throw new Error(`The passport was not uploaded and read within 6 minutes. On the page: ${await readerProblem(page) || "(still uploading / reading, no message shown)"}`);
  }
  const state = (await wizard.getByText(READ_STATES).first().innerText()).trim();
  if (!/Ready for review/.test(state)) {
    throw new Error(`The passport reader did not read the specimen (${state}). On the page: ${await readerProblem(page) || "(no message shown)"}`);
  }
  // The values read are listed under the document (<dd title="value">, the stored value exactly: the date as YYYY-MM-DD).
  const readValue = (value: string) => wizard.locator(`dd[title="${value}" i]`).first();
  await expect(readValue(SPECIMEN.givenNames), "given name read from the passport").toBeVisible();
  await expect(readValue(SPECIMEN.surname), "surname read from the passport").toBeVisible();
  await expect(readValue(SPECIMEN.dateOfBirth), "date of birth read from the passport (YYYY-MM-DD)").toBeVisible();
  await expect(readValue(SPECIMEN.placeOfBirth), "place of birth read from the passport (USI town of birth)").toBeVisible();
  // The wizard's own Next (the form behind has one too).
  const next = wizard.getByTestId("wizard-footer").getByRole("button", { name: /^Next/ });
  await expect(next, "the wizard lets the passport step continue").toBeEnabled();
  await next.click();
  await page.waitForTimeout(3000);   // let the draft save

  // 4. TEST flag and the link.
  const target = process.env.E2E_TARGET;
  const sql = `update public.enrollment_applications set is_test = true where id = '${applicationId}' and student_email = '${STUDENT_EMAIL}' returning id, is_test;`;
  if (target === "local-stack") {
    const url = process.env.E2E_SUPABASE_URL ?? "http://127.0.0.1:56321";
    if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("E2E_TARGET=local-stack needs a local E2E_SUPABASE_URL.");
    const { E2E_SERVICE_KEY } = await import("../../e2e/env");
    const service = createClient(url, E2E_SERVICE_KEY, { auth: { persistSession: false } });
    const { error } = await service.from("enrollment_applications").update({ is_test: true }).eq("id", applicationId).eq("student_email", STUDENT_EMAIL);
    if (error) throw new Error(`is_test not set: ${error.message}`);
    console.log("Marked is_test = true (local stack).");
  } else {
    console.log(`Hosted: mark it TEST with\n  ${sql}`);
  }
  await page.goto(`/admin/applications/${applicationId}`);
  console.log(`Link: ${new URL(`/admin/applications/${applicationId}`, baseURL).toString()}`);
});
