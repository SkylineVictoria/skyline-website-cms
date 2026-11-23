import { defineConfig } from "@playwright/test";

// USI test data helpers (2026-11-23, owner): scripts/e2e/*.spec.ts drive the REAL UI of an app that is already running; nothing starts
// a server here. Unlike e2e/ (local Supabase stack only), these may run against the dev server on localhost:3001, which uses the
// backend in .env: today that is the HOSTED project. So a run is refused unless E2E_TARGET says which backend it will write to:
//   E2E_TARGET=local-stack  the app at E2E_BASE_URL uses a local Supabase stack (npx supabase start)
//   E2E_TARGET=hosted       the app's backend is the hosted project: only with the owner's approval for that run
// Credentials come from E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD (never in the repo).
//   npx playwright test -c scripts/e2e/playwright.config.ts
const target = process.env.E2E_TARGET ?? "";
if (target !== "local-stack" && target !== "hosted") {
  throw new Error("Set E2E_TARGET=local-stack or E2E_TARGET=hosted (the backend this run writes to). See scripts/e2e/playwright.config.ts.");
}

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  timeout: 600_000,   // upload + passport reader can take minutes on hosted
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3001",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    headless: process.env.E2E_HEADED !== "1",
  },
  outputDir: process.env.E2E_OUTPUT_DIR ?? `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/skyline-e2e-results`,
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
