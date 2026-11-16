import { expect, test, type Page } from "@playwright/test";
import { E2E_API_URL } from "./env";

test.use({ launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {} });

/** Local deterministic transport tests, never live customer accounts. */
async function setup(page: Page, role = "Admin") {
  const user = { id: "00000000-0000-4000-8000-000000000099", email: "admin@example.invalid", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
  const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: user.id, exp: 4102444800, role: "authenticated" })).toString("base64url")}.test`;
  await page.addInitScript(({ user, token }) => {
    localStorage.setItem("sb-127-auth-token", JSON.stringify({ user, access_token: token, refresh_token: "local-test-only", expires_at: 4102444800, expires_in: 3600, token_type: "bearer" }));
  }, { user, token });
  await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort());
  const requests: string[] = [];
  await page.route(`${E2E_API_URL}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    let body: unknown = [];
    if (path.endsWith("/user")) body = user;
    if (path.endsWith("/cms_users")) {
      const profile = { id: "admin-test", name: "Preview Administrator", email: user.email, role, status: "Active", must_change_password: false };
      body = route.request().url().includes("auth_user_id=") ? profile : [profile];
    }
    if (path.endsWith("/cms_admin_snapshot")) body = { version: 1 };
    if (path.endsWith("/cms_user_ui_prefs")) body = {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return requests;
}

for (const width of [1440, 390]) {
  test(`Switch View: repeated portal switching and return at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const requests = await setup(page);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/admin");
    await page.getByRole("button").filter({ hasText: "PA" }).click();
    const menu = page.getByLabel("Switch View", { exact: true });
    await expect(menu.getByRole("link")).toHaveCount(4);
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await menu.getByRole("link", { name: "Student View" }).click();
    const frame = page.frameLocator('iframe[title="student portal preview"]');
    if (width < 1024) await frame.getByRole("button", { name: "Open menu", exact: true }).click();
    await frame.getByRole("link", { name: "My assessments", exact: true }).click();
    await expect(frame.getByRole("heading", { name: "My assessments", exact: true })).toBeVisible();
    await frame.getByRole("button", { name: "Results & progress" }).click();
    await expect(frame.getByText("No units yet:", { exact: false })).toBeVisible();
    for (const view of ["agent", "staff", "student"]) {
      await page.locator("summary").click();
      await page.getByRole("link", { name: `${view[0].toUpperCase()}${view.slice(1)} View`, exact: true }).click();
      const portal = page.frameLocator("iframe");
      await expect(portal.getByText("Sample data · Read-only.", { exact: false })).toBeVisible();
      if (view === "staff") await expect(portal.getByTestId("my-hr-role")).toContainText("Sample Staff");
      if (view === "agent") await expect(portal.getByText("Sample Agency").first()).toBeVisible();
    }
    // Real backend calls from the frame are ONLY the authorization check.
    const frames = page.frames().filter(f => f !== page.mainFrame());
    expect(frames).toHaveLength(1);
    expect(requests.some(path => /portal_query_applications|hr_staff_me|asm_student|booking_me/.test(path))).toBe(false);
    await page.getByRole("link", { name: "Return to Admin" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("Switch View: editor cannot see the menu or open either preview route", async ({ page }) => {
  await setup(page, "Editor");
  await page.goto("/admin");
  await page.getByRole("button").filter({ hasText: "PA" }).click();
  await expect(page.getByLabel("Switch View", { exact: true })).toHaveCount(0);
  await page.goto("/admin/switch-view/student");
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/portal-preview/student");
  await expect(page.getByRole("alert")).toContainText("Administrator access is required");
});
