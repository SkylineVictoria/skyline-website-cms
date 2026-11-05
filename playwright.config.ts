import { defineConfig } from "@playwright/test";
import { E2E_ANON_KEY, E2E_API_URL, E2E_PORT, assertLocalOnly } from "./e2e/env";

// End-to-end tests run against a LOCAL Supabase stack only (npx supabase start, plus `npx supabase functions serve`), never against
// the hosted project: e2e/env.ts refuses any API URL that is not 127.0.0.1 / localhost. Start the stack first (see e2e/README note in
// docs/SUPABASE.md), then `npm run test:e2e`. The dev server uses its own port (E2E_PORT, default 3011) with the local URL and key
// injected through the process environment, so a developer's own server on 3001 or TenderFlow on 3000 is never reused or disturbed.
assertLocalOnly();

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  // One shared local database and one mail inbox: tests run one after another.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${E2E_PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
    url: `http://127.0.0.1:${E2E_PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_PUBLIC_SUPABASE_URL: E2E_API_URL,
      VITE_PUBLIC_SUPABASE_ANON_KEY: E2E_ANON_KEY,
      VITE_PUBLIC_SITE_URL: `http://127.0.0.1:${E2E_PORT}`,
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
