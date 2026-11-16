#!/usr/bin/env node
// HR-02 staff enrolment lab: a FRESH, separate local Supabase stack (project "skyline-staff-lab", ports 57320-57329) built from
// the repo's migrations (all of them, including 20261110090000) and Edge Functions, with the local mail inbox and the Turnstile
// mock. Re-runnable: `up` always throws the previous lab stack away first. Nothing here talks to a hosted project.
//
//   node scripts/lab/staff-lab.mjs up       fresh stack + migrations + functions served (prints the URLs and keys file)
//   node scripts/lab/staff-lab.mjs apply    end-to-end checks of the public staff application (HR-02b)
//   node scripts/lab/staff-lab.mjs onboard  end-to-end checks of onboarding by link (HR-02c)
//   node scripts/lab/staff-lab.mjs emails   end-to-end checks of HR email: outbox, invite links, failures, retry (HR-02d)
//   node scripts/lab/staff-lab.mjs offer    end-to-end checks of the offer: upload checks, send, view, sign, signed PDF emailed (HR-02e)
//   node scripts/lab/staff-lab.mjs activate end-to-end checks of activation: Auth invite, password, claim, My HR, existing login (HR-02f)
//   node scripts/lab/staff-lab.mjs retention the real pg_cron job deletes the files of applications rejected long ago (HR-02h)
//   node scripts/lab/staff-lab.mjs flow     end-to-end checks of the onboarding flow: document link, review, pay details, offer letter from a
//                                           template, offer + one-time set-password link, own offer before Active, sign, activate, failed-email undo
//   node scripts/lab/staff-lab.mjs wizard   the onboarding wizard: the shared rules give the same answer in the browser module and in the database (one
//                                           list of inputs through both), existing bank details were encrypted by the migration, upload first > reading >
//                                           details > bank details (masked) > submit, Admin reveal (logged) and ticks, an Editor gets nothing, and the
//                                           bank numbers are in no log and no email
//   node scripts/lab/staff-lab.mjs signing  Documents & Signatures: templates and versions, variables from a student / employee / agent, one signer, three in
//                                           order, two at once, placed fields in the signed PDF, invitations, reminders, expiry, decline, void, completion
//                                           mail with the signed PDF and certificate, tamper checks and refused access (mock Postmark)
//                                           TPL-02 / INT-01: a document template with header and footer presets, [Variables] from the student's
//                                           record and chosen intake, the signer's [tokens] and initials on every page, signed through the function
//   node scripts/lab/staff-lab.mjs signing-browser  the same screens in Chromium: dashboard, template editor, field placement, send; signing on an iPhone-size screen
//   node scripts/lab/staff-lab.mjs e2e      the Playwright suite (e2e/*.spec.ts) against this lab, with the mock Postmark and reader
//   node scripts/lab/staff-lab.mjs holidays public holiday sync (20261113150000 / holiday-sync): the real function against a mock data.gov.au (2025 only)
//                                           and mock Nager.Date, refused for anon and employees, seeds adopted and confirmed, no duplicates on a re-run,
//                                           a hand-edited row kept, a failed fetch recorded with nothing changed, data.gov.au preferred when it has the
//                                           year, and the pg_cron dispatcher through pg_net with the Vault key (needs a fresh `up`: the mock URLs are
//                                           written to the functions .env at start)
//   node scripts/lab/staff-lab.mjs assistant P09-01 public assistant per tenant: two verified hosts with the same FAQ, the real public-assistant
//                                           and public-assistant-index functions (mock embeddings), cache, spoofed / unverified / unknown hosts,
//                                           a tenant document in another institution's storage refused, unpublish reflected (needs a fresh `up`)
//   node scripts/lab/staff-lab.mjs sql      runs every supabase/tests/*.sql suite on the lab database
//   node scripts/lab/staff-lab.mjs down     stops the lab stack (no backup)
//
// Work files live in the OS temp dir (never the repo). The repo's migrations do not replay on a fresh stack because a few objects
// exist only on hosted; LAB_SHIMS below creates minimal stand-ins for them (lab only, see OPS-01 for the real fix).
// Secrets: only the local stack's own demo keys are used; supabase/functions/.env is never copied.
// Email: the functions send through the Postmark adapter, redirected (local only, EF_POSTMARK_API_URL) to a mock Postmark server
// that this script runs on port 57390 while a check command runs; nothing reaches Postmark.
// Address search: staff-onboarding's address_search calls Geoscape, redirected (local only, EF_ADDRESS_SEARCH_API_URL) to a mock on port
// 57392 that answers two fixed addresses, nothing for a query with "nowhere" and a fault for one with "outage"; nothing reaches Geoscape.
// Document reading: staff-onboarding's reader calls OpenAI, redirected (local only, EF_OPENAI_API_URL) to a mock on port 57391
// that answers a fixed passport (name, middle name, date of birth); nothing reaches OpenAI.
import http from "node:http";
import nodeCrypto from "node:crypto";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = path.join(os.tmpdir(), "skyline-staff-lab");
const PROJECT = "skyline-staff-lab";
const DB_CONTAINER = `supabase_db_${PROJECT}`;
const PORTS = { shadow: 57320, api: 57321, db: 57322, studio: 57323, mail: 57324, analytics: 57327, pooler: 57329, inspector: 57383 };
const SITE = "http://127.0.0.1:57330";
const MOCK_POSTMARK_PORT = 57390;
const MOCK_OPENAI_PORT = 57391;
const MOCK_GEOSCAPE_PORT = 57392;
const MOCK_HOLIDAY_PORT = 57393;
const LAB_SECRETS = {
  EF_CAPTCHA_SECRET_KEY: "local-mock",
  EF_NOTIFICATION_EMAIL_ENABLED: "true",
  EF_POSTMARK_SERVER_TOKEN: "lab-postmark-token",
  EF_POSTMARK_API_URL: `http://host.docker.internal:${MOCK_POSTMARK_PORT}`,
  EF_HR_EMAIL_FROM: "Skyline HR <hr@lab.example.test>",
  EF_HR_ADMIN_NOTIFY_TO: "hr.one@lab.example.test, hr.two@lab.example.test",
  EF_HR_PUBLIC_SITE_URL: "http://127.0.0.1:57330",
  // The public assistant and its index worker accept a base-URL override only for this literal key and a loopback/Docker host
  // (P09-01 `assistant` checks): embeddings go to the mock below, never to OpenAI.
  OPENAI_API_KEY: "local-test-openai-key",
  OPENAI_BASE_URL: `http://host.docker.internal:${MOCK_OPENAI_PORT}/v1`,
  PUBLIC_ASSISTANT_WORKER_SECRET: "lab-public-assistant-worker-secret",
  OPENAI_DOCUMENT_MODEL: "lab-reader",
  EF_OPENAI_API_URL: `http://host.docker.internal:${MOCK_OPENAI_PORT}`,
  // Address search (Geoscape): the lab key and a mock on port 57392; nothing reaches Geoscape.
  EF_ADDRESS_SEARCH_GEOSCAPE_KEY: "lab-geoscape-key",
  EF_ADDRESS_SEARCH_API_URL: `http://host.docker.internal:${MOCK_GEOSCAPE_PORT}`,
  // Public holiday sync: mocks of data.gov.au and Nager.Date on port 57393; nothing reaches the real sources.
  EF_HOLIDAY_SYNC_DATA_GOV_URL: `http://host.docker.internal:${MOCK_HOLIDAY_PORT}/data-gov`,
  EF_HOLIDAY_SYNC_NAGER_URL: `http://host.docker.internal:${MOCK_HOLIDAY_PORT}/nager`,
};
/** What the mock reader "reads" from every passport. */
const MOCK_PASSPORT = { first_name: "PASSPORT", middle_name: "Mock", last_name: "READER", dob: "1985-02-03", passport_number: "PA1234567", passport_expiry: "2033-01-01", nationality: "New Zealander" };
/** ...and from every visa. */
const MOCK_VISA = { visa_subclass: "485", visa_stay_until: "2031-03-04", visa_grant_number: "0012345678901" };
const EXCLUDE = "studio,imgproxy,logflare,vector,supavisor,realtime,postgres-meta";

// LAB ONLY stand-ins for hosted state the repo cannot replay (file name = position in the migration order). Never shipped.
const LAB_SHIMS = {
  // 20261102094611 references public.student_profiles(id), a hosted table that no repo migration creates;
  // 20261112035802 (one email = one person) reads and guards its email column.
  "00000000000000_lab_shim_student_profiles.sql":
    "create table if not exists public.student_profiles (id uuid primary key default gen_random_uuid(), email text);\n",
  // Hosted ran remove_omara (2 Nov 2026, not in the repo) before 20261104090000, so nothing referenced omara_agents any more.
  "20261104085959_lab_shim_remove_omara_references.sql": `do $$
declare r record;
begin
 if to_regclass('public.omara_agents') is null then return; end if;
 for r in select conrelid::regclass as tbl, conname from pg_constraint where contype = 'f' and confrelid = 'public.omara_agents'::regclass loop
  execute format('alter table %s drop constraint %I', r.tbl, r.conname);
 end loop;
end $$;
`,
  // LAB FIXTURE (HR-02i): one person left at the Jobs status job_applied by 20261106120000, so the replay proves that 20261110090000 maps
  // it to applied (hosted has none). Runs between 20261106130000 and 20261109153953.
  "20261108000000_lab_fixture_job_applied.sql": `do $$
declare v_user uuid := '1ab00000-0000-4000-8000-00000000f001'; v_profile uuid;
begin
 insert into auth.users(id, email, aud, role, email_confirmed_at) values (v_user, 'lab.jobapplied@example.test', 'authenticated', 'authenticated', now()) on conflict (id) do nothing;
 alter table hr.staff_profiles disable trigger staff_status_guard;
 insert into hr.staff_profiles(auth_user_id, first_name, last_name, email, phone_e164, status) values (v_user, 'Lab', 'JobApplied', 'lab.jobapplied@example.test', '+61400000999', 'job_applied')
  returning id into v_profile;
 alter table hr.staff_profiles enable trigger staff_status_guard;
 insert into hr.staff_applications(profile_id) values (v_profile);
end $$;
`,
  // LAB FIXTURE (onboarding wizard): bank details saved in plain text before 20261112090000, so the replay proves the migration
  // encrypts what is already there and empties the plain columns.
  "20261112085959_lab_fixture_plain_bank.sql": `insert into hr.employee_bank(profile_id, account_name, bsb, account_number, bank_name)
 select id, 'Lab JobApplied', '033000', '987654321', 'Westpac' from hr.staff_profiles where email = 'lab.jobapplied@example.test' on conflict (profile_id) do nothing;
`,
};

const isWin = process.platform === "win32";
function run(bin, args, options = {}) {
  const res = spawnSync(bin, args, { cwd: REPO, encoding: "utf8", shell: isWin, maxBuffer: 64 * 1024 * 1024, ...options });
  return { code: res.status ?? 1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}
const supabase = (args, options) => run("npx", ["supabase", ...args, "--workdir", WORK], options);
export function psql(sql) {
  const res = spawnSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`psql failed: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}
const labFile = path.join(WORK, "lab.json");
const readLab = () => {
  if (!fs.existsSync(labFile)) throw new Error("The lab is not up. Run: node scripts/lab/staff-lab.mjs up");
  return JSON.parse(fs.readFileSync(labFile, "utf8"));
};

/* ------------------------------------------------------------------ config */

function setKey(toml, section, key, value) {
  const lines = toml.split(/\r?\n/);
  let current = "";
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^\[([^\]]+)\]\s*$/);
    if (header) { current = header[1]; continue; }
    if (current === section && new RegExp(`^${key}\\s*=`).test(lines[i])) { lines[i] = `${key} = ${value}`; return lines.join("\n"); }
  }
  throw new Error(`config.toml has no ${section}.${key}`);
}

function writeConfig() {
  let toml = fs.readFileSync(path.join(WORK, "supabase", "config.toml"), "utf8");
  toml = toml.replace(/^project_id = .*$/m, `project_id = "${PROJECT}"`);
  toml = setKey(toml, "api", "port", PORTS.api);
  toml = setKey(toml, "db", "port", PORTS.db);
  toml = setKey(toml, "db", "shadow_port", PORTS.shadow);
  toml = setKey(toml, "db.pooler", "port", PORTS.pooler);
  toml = setKey(toml, "db.seed", "enabled", "false");
  toml = setKey(toml, "studio", "enabled", "false");
  toml = setKey(toml, "studio", "port", PORTS.studio);
  toml = setKey(toml, "local_smtp", "port", PORTS.mail);
  toml = setKey(toml, "analytics", "enabled", "false");
  toml = setKey(toml, "analytics", "port", PORTS.analytics);
  toml = setKey(toml, "edge_runtime", "inspector_port", PORTS.inspector);
  toml = setKey(toml, "auth", "site_url", `"${SITE}"`);
  // The repo's per-function settings (verify_jwt) apply unchanged.
  const functions = fs.readFileSync(path.join(REPO, "supabase", "config.toml"), "utf8");
  fs.writeFileSync(path.join(WORK, "supabase", "config.toml"), `${toml}\n\n# ---- from the repo's supabase/config.toml\n${functions}`);
}

function copyFunctions(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isFile() && /^\.env(\..*)?$/.test(entry.name) && entry.name !== ".env.example") continue; // never copy real secrets
    const src = path.join(from, entry.name), dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyFunctions(src, dst); else fs.copyFileSync(src, dst);
  }
}

/* ------------------------------------------------------------------ commands */

async function up() {
  supabase(["stop", "--no-backup"]);
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const init = supabase(["init", "--force"]);
  if (init.code !== 0) throw new Error(`supabase init failed:\n${init.out}`);
  writeConfig();
  const migrations = path.join(WORK, "supabase", "migrations");
  fs.mkdirSync(migrations, { recursive: true });
  for (const [file, sql] of Object.entries(LAB_SHIMS)) fs.writeFileSync(path.join(migrations, file), `-- LAB ONLY (scripts/lab/staff-lab.mjs)\n${sql}`);
  // Hosted applied these after 20261113320000 although their versions sort earlier (they rewrite functions that later files define):
  // the lab replays them in the hosted order, under a lab-only version just after 20261113320000.
  const HOSTED_LATER = {
    "20261112144811_main_site_host.sql": "20261113320001_main_site_host.sql",
    // The two Master Data fee migrations alter course_fee_setups (created by 20261113270000) and application_letter_course
    // (20261113320000); hosted applied them after those, and course_management (20261113340000) syncs total_fee from them.
    "20261112172429_course_fees_master_data.sql": "20261113320002_course_fees_master_data.sql",
    "20261112172731_course_fees_three_columns.sql": "20261113320003_course_fees_three_columns.sql",
    // Business onboarding and staff signed documents read hr.sign_requests.subject_id, which the envelopes migration
    // (20261113140000) adds; hosted applied them after it.
    "20261113025808_business_onboarding.sql": "20261113140001_business_onboarding.sql",
    "20261113031341_staff_signed_documents.sql": "20261113140002_staff_signed_documents.sql",
  };
  for (const file of fs.readdirSync(path.join(REPO, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    fs.copyFileSync(path.join(REPO, "supabase", "migrations", file), path.join(migrations, HOSTED_LATER[file] ?? file));
  }
  copyFunctions(path.join(REPO, "supabase", "functions"), path.join(WORK, "supabase", "functions"));
  fs.writeFileSync(path.join(WORK, "supabase", "functions", ".env"), Object.entries(LAB_SECRETS).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");

  console.log(`Starting a fresh lab stack in ${WORK} (this replays every migration)...`);
  const start = supabase(["start", "-x", EXCLUDE]);
  if (start.code !== 0) { console.error(start.out.split(/\r?\n/).slice(-40).join("\n")); throw new Error("supabase start failed"); }
  const status = supabase(["status", "-o", "env"]);
  const env = Object.fromEntries([...status.out.matchAll(/^([A-Z_]+)="?([^"\r\n]*)"?$/gm)].map((m) => [m[1], m[2]]));
  const lab = { apiUrl: env.API_URL, anonKey: env.ANON_KEY, serviceKey: env.SERVICE_ROLE_KEY, mailUrl: env.INBUCKET_URL || env.MAILPIT_URL || `http://127.0.0.1:${PORTS.mail}`, dbContainer: DB_CONTAINER, site: SITE };
  if (!lab.apiUrl || !lab.anonKey || !lab.serviceKey) throw new Error(`could not read the lab keys:\n${status.out}`);
  fs.writeFileSync(labFile, JSON.stringify(lab, null, 2));

  // Functions are served by the stack's edge runtime; wait until staff-register answers.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { ready = (await fetch(`${lab.apiUrl}/functions/v1/staff-register`, { method: "OPTIONS" })).ok; } catch { /* not yet */ }
    if (!ready) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error("the Edge Functions did not come up (staff-register OPTIONS)");
  const migrated = psql("select count(*) from supabase_migrations.schema_migrations;");
  console.log(`Lab up: API ${lab.apiUrl}, mail ${lab.mailUrl}, ${migrated} migrations applied, functions served. Keys: ${labFile}`);
}

const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
// Document category checks (20261112100000 / staff-onboarding v7): the function asks the reader what each uploaded file IS before it is
// accepted. The lab's files carry the answer as a PDF comment ("%lab-category:Passport"), which the mock reader reads back; a file
// without it is "Unclear" (refused), as a real unreadable file would be.
const DETECTED_TYPE = { passport: "Passport", visa: "Australian Visa", english: "English Evidence", pte: "PTE", academic: "Academic", transcript: "Academic", results: "Academic",
  licence: "Driving Licence", license: "Driving Licence", oshc: "Health Insurance", health: "Health Insurance", insurance: "Health Insurance" };
const detectedTypeOf = (name) => DETECTED_TYPE[Object.keys(DETECTED_TYPE).find((k) => String(name).toLowerCase().includes(k)) ?? ""] ?? "Other";
const labPdf = (name) => new TextEncoder().encode(`%PDF-1.4\n%lab-category:${detectedTypeOf(name)}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
const labPng = (name) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, ...new TextEncoder().encode(`%lab-category:${detectedTypeOf(name)}`)]);
let failures = 0;
function check(label, ok, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` -- ${detail}`}`); if (!ok) failures++; }

async function postApply(lab, fields, file) {
  const form = new FormData();
  form.set("action", "apply");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set("resume", file.blob, file.name);
  const res = await fetch(`${lab.apiUrl}/functions/v1/staff-register`, { method: "POST", body: form, headers: { apikey: lab.anonKey, "x-forwarded-for": fields.__ip ?? "198.51.100.7" } });
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
}

async function apply() {
  const lab = readLab();
  const stamp = Date.now();
  const email = `lab.applicant.${stamp}@example.test`;
  const phone = `+614${String(stamp).slice(-8)}`;
  const base = { firstName: "Lab", lastName: "Applicant", email, phone, agreed: "true", captchaToken: "mock-ok", website: "" };
  const pdf = { blob: new Blob([PDF], { type: "application/pdf" }), name: "cv.pdf" };

  const forged = await postApply(lab, { ...base, captchaToken: "forged", __ip: "198.51.100.1" }, pdf);
  check("a forged CAPTCHA token is refused (400, field captcha)", forged.status === 400 && forged.body.field === "captcha", JSON.stringify(forged.body));
  const fake = await postApply(lab, { ...base, __ip: "198.51.100.2" }, { blob: new Blob([new Uint8Array([0x4d, 0x5a, 0, 1])]), name: "cv.pdf" });
  check("a renamed non-PDF is refused (400, field resume)", fake.status === 400 && fake.body.field === "resume", JSON.stringify(fake.body));
  check("nothing was stored for the refused requests", psql(`select count(*) from hr.staff_profiles where email = '${email}';`) === "0");

  const ok = await postApply(lab, base, pdf);
  check("a complete application is accepted (200 ok)", ok.status === 200 && ok.body.ok === true, `${ok.status} ${JSON.stringify(ok.body)}`);
  check("no-store and no-referrer headers", ok.headers.get("cache-control") === "no-store" && ok.headers.get("referrer-policy") === "no-referrer");
  const row = psql(`select p.id || '|' || p.status || '|' || coalesce(p.auth_user_id::text, 'none') || '|' || coalesce(a.resume_path, '') || '|' || coalesce(a.resume_mime, '')
    from hr.staff_profiles p join hr.staff_applications a on a.profile_id = p.id where p.email = '${email}';`).split("|");
  check("the profile is 'applied' with no login", row[1] === "applied" && row[2] === "none", row.join("|"));
  check("the resume is recorded in the person's own folder", row[3]?.startsWith(`${row[0]}/resume/`) && row[4] === "application/pdf", row.join("|"));
  check("the resume file is in the private bucket", psql(`select count(*) from storage.objects where bucket_id = 'staff-documents' and name = '${row[3]}';`) === "1");
  check("the bucket is private", psql("select public from storage.buckets where id = 'staff-documents';") === "f");
  check("no auth user was created", psql(`select count(*) from auth.users where lower(email) = '${email}';`) === "0");
  check("received (applicant) and new application (admin) emails are sent right after the answer",
    await waitFor(`select string_agg(e.kind || ':' || e.state, ',' order by e.id) from hr.staff_emails e join hr.staff_profiles p on p.id = e.profile_id where p.email = '${email}';`, "application_received:sent,admin_new_application:sent") === "application_received:sent,admin_new_application:sent");
  const anonRead = await fetch(`${lab.apiUrl}/storage/v1/object/staff-documents/${row[3]}`, { headers: { apikey: lab.anonKey, Authorization: `Bearer ${lab.anonKey}` } });
  check("the resume cannot be read anonymously", anonRead.status >= 400, String(anonRead.status));

  const again = await postApply(lab, { ...base, firstName: "Again", __ip: "198.51.100.3" }, pdf);
  check("the same email again gets the same thank-you", again.status === 200 && again.body.ok === true, JSON.stringify(again.body));
  check("...nothing is changed, and that address alone is told it already applied", psql(`select first_name from hr.staff_profiles where email = '${email}';`) === "Lab"
    && await waitFor(`select string_agg(e.kind || ':' || e.state, ',' order by e.id) from hr.staff_emails e join hr.staff_profiles p on p.id = e.profile_id where p.email = '${email}' and e.kind = 'already_applied';`, "already_applied:sent") === "already_applied:sent");

  psql(`update hr.staff_profiles set status = 'rejected' where email = '${email}';`);
  const reapply = await postApply(lab, { ...base, firstName: "Returning", __ip: "198.51.100.4" }, pdf);
  check("a rejected person can apply again (same record, applied)", reapply.status === 200
    && psql(`select status || '|' || first_name from hr.staff_profiles where email = '${email}';`) === "applied|Returning");

  let limited = null;
  for (let i = 0; i < 6 && !limited; i++) {
    const r = await postApply(lab, { ...base, email: `lab.limit.${stamp}.${i}@example.test`, phone: `+6149${String(stamp + i).slice(-7)}`, captchaToken: "forged", __ip: "198.51.100.99" }, pdf);
    if (r.status === 429) limited = r;
  }
  check("the per-caller rate limit answers 429 with Retry-After", limited !== null && limited.headers.get("retry-after") === "600");

  // HR-02i: the Jobs status job_applied left by 20261106120000 (lab fixture) is mapped to applied by 20261110090000.
  check("a person at the old Jobs status job_applied is mapped to applied, and the move is logged",
    psql("select status from hr.staff_profiles where email = 'lab.jobapplied@example.test';") === "applied"
    && psql("select count(*) from hr.staff_status_events e join hr.staff_profiles p on p.id = e.profile_id where p.email = 'lab.jobapplied@example.test' and e.from_status = 'job_applied' and e.to_status = 'applied';") === "1");

  // HR-02i Careers: the same no-login form with a job, a cover letter text and a cover letter file.
  const jobId = psql("insert into hr.jobs(title, description, employment_type, location) values ('Lab Trainer', 'Teach.', 'full_time', 'Melbourne') returning id;").split("\n")[0];
  const closed = psql("insert into hr.jobs(title, description, employment_type, location, status) values ('Lab Closed', 'Old.', 'full_time', 'Sydney', 'closed') returning id;").split("\n")[0];
  const cs = Date.now();
  const careers = { firstName: "Lab", lastName: "Careers", email: `lab.careers.${cs}@example.test`, phone: `+6148${String(cs).slice(-7)}`, agreed: "true", captchaToken: "mock-ok", website: "", __ip: `198.51.77.${cs % 250}` };
  const pdfFile = (name) => ({ blob: new Blob([PDF], { type: "application/pdf" }), name });
  const closedTry = await postApply(lab, { ...careers, jobId: closed }, pdfFile("cv.pdf"));
  check("Careers: a closed job is refused, nothing recorded", closedTry.status === 400 && psql(`select count(*) from hr.staff_profiles where email = '${careers.email}';`) === "0", JSON.stringify(closedTry.body));
  const form = new FormData();
  form.set("action", "apply");
  for (const [k, v] of Object.entries({ ...careers, jobId, coverLetter: "I would love to teach here." })) if (k !== "__ip") form.set(k, v);
  form.set("resume", new Blob([PDF], { type: "application/pdf" }), "cv.pdf");
  form.set("coverLetterFile", new Blob([PDF], { type: "application/pdf" }), "letter.pdf");
  const res = await fetch(`${lab.apiUrl}/functions/v1/staff-register`, { method: "POST", body: form, headers: { apikey: lab.anonKey, "x-forwarded-for": careers.__ip } });
  const jobRow = psql(`select p.status || '|' || j.status || '|' || j.cover_letter || '|' || coalesce(j.cover_letter_path, '-') || '|' || coalesce(a.resume_path, '-') from hr.staff_profiles p join hr.job_applications j on j.profile_id = p.id join hr.staff_applications a on a.profile_id = p.id where p.email = '${careers.email}';`).split("|");
  check("Careers apply: the same no-login form records the application with the job, the cover letter text and file (own folder)", res.status === 200 && jobRow[0] === "applied" && jobRow[1] === "applied"
    && jobRow[2] === "I would love to teach here." && /\/cover-letter\/[^/]+\.pdf$/.test(jobRow[3]) && /\/resume\//.test(jobRow[4])
    && psql(`select count(*) from storage.objects where bucket_id = 'staff-documents' and name = '${jobRow[3]}';`) === "1", jobRow.join("|"));
  await waitFor(`select count(*) from hr.staff_emails e join hr.staff_profiles p on p.id = e.profile_id where p.email = '${careers.email}' and e.state = 'sent';`, "2");
  check("...the emails name the job (applicant and HR)", mailsTo(careers.email).some((m) => m.subject === "We received your application: Lab Trainer")
    && postmark.messages.some((m) => m.subject === "New job application (Lab Trainer): Lab Careers"));
  const jobAgain = await postApply(lab, { ...careers, jobId }, pdfFile("cv2.pdf"));
  check("...applying again for the same job: the same thank-you, still one job application", jobAgain.status === 200
    && psql(`select count(*) from hr.job_applications j join hr.staff_profiles p on p.id = j.profile_id where p.email = '${careers.email}';`) === "1");

  // HR-02j Candidates: the stages as the admin console calls them, then "Hire and send document link" through staff-admin.
  await ensureLabAdmin();
  const jwt = await adminToken(lab);
  const appId = psql(`select j.id from hr.job_applications j join hr.staff_profiles p on p.id = j.profile_id where p.email = '${careers.email}' and j.status = 'applied';`);
  let fromEmployees = "";
  try { fromEmployees = asAdmin(`select public.hr_admin_staff_invite((select id from hr.staff_profiles where email = '${careers.email}'), 'documents', '${"a".repeat(64)}');`); }
  catch (e) { fromEmployees = e instanceof Error ? e.message : String(e); }
  check("Employees cannot send the document link to a Careers applicant with an open job application", /hire them from Candidates/.test(fromEmployees), fromEmployees.slice(0, 160));
  const early = await staffAdminCall(lab, jwt, { action: "hire", applicationId: appId });
  check("Candidates: no hire before the selected stage", early.status === 400 && /selected/.test(early.body.error ?? ""), JSON.stringify(early.body));
  for (const [action, extra] of [["shortlisted", {}], ["interview", { p_interview_at: new Date(Date.now() + 86_400_000).toISOString(), p_interview_notes: "Bring the portfolio." }], ["selected", {}]]) {
    const r = await restRpc(lab, jwt, "hr_admin_candidate_progress", { p_id: appId, p_action: action, ...extra });
    if (r.status !== 200) throw new Error(`${action}: ${JSON.stringify(r.body)}`);
  }
  const hired = await staffAdminCall(lab, jwt, { action: "hire", applicationId: appId });
  const hiredRow = psql(`select p.status || '|' || j.status || '|' || e.job_title || '|' || coalesce(e.joining_date::text, 'none') from hr.staff_profiles p join hr.job_applications j on j.profile_id = p.id join hr.employment e on e.profile_id = p.id where p.email = '${careers.email}' and j.id = '${appId}';`);
  check("Hire and send document link: the application is hired, the employment record comes from the job, the person is invited and the link is emailed",
    hired.status === 200 && hired.body.emailSent === true && hiredRow === "invited|hired|Lab Trainer|none" && mailsTo(careers.email).some((m) => /#t=/.test(m.text ?? "")), `${hired.status} ${JSON.stringify(hired.body)} ${hiredRow}`);

  // A manual candidate: an HR-02 record (applied, no login); the resume comes through staff-admin after the content checks; declined closes both.
  const manualEmail = `lab.manual.${cs}@example.test`;
  const manual = await restRpc(lab, jwt, "hr_admin_candidate_save", { p_id: null, p_job: jobId, p_person: { firstName: "Mia", lastName: "Manual", email: manualEmail, phone: `+6146${String(cs).slice(-7)}` }, p_cover_letter: "", p_recruiter_notes: "Call on Monday." });
  const manualId = String(manual.body ?? "");
  const manualProfile = psql(`select id from hr.staff_profiles where email = '${manualEmail}';`);
  const sendFile = async (name, bytes) => {
    const f = new FormData();
    f.set("action", "candidate_file"); f.set("applicationId", manualId); f.set("which", "resume"); f.set("file", new Blob([bytes], { type: "application/pdf" }), name);
    const res = await fetch(`${lab.apiUrl}/functions/v1/staff-admin`, { method: "POST", headers: { apikey: lab.anonKey, Authorization: `Bearer ${jwt}` }, body: f });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const fakeResume = await sendFile("cv.pdf", new Uint8Array([0x4d, 0x5a, 0, 1]));
  const realResume = await sendFile("cv.pdf", PDF);
  check("a manual candidate (applied, no login) gets a resume through staff-admin: a renamed non-PDF is refused, a PDF lands in the person's folder",
    manual.status === 200 && psql(`select status || '|' || coalesce(auth_user_id::text, 'none') from hr.staff_profiles where id = '${manualProfile}';`) === "applied|none"
    && fakeResume.status === 400 && realResume.status === 200
    && psql(`select (resume_path like '${manualProfile}/resume/%')::text from hr.staff_applications where profile_id = '${manualProfile}';`) === "true", `${manual.status} ${fakeResume.status} ${realResume.status}`);
  const careersFile = await (async () => { const f = new FormData(); f.set("action", "candidate_file"); f.set("applicationId", appId); f.set("which", "resume"); f.set("file", new Blob([PDF], { type: "application/pdf" }), "cv.pdf");
    const res = await fetch(`${lab.apiUrl}/functions/v1/staff-admin`, { method: "POST", headers: { apikey: lab.anonKey, Authorization: `Bearer ${jwt}` }, body: f }); return res.status; })();
  check("a Careers applicant's files are never replaced by an administrator", careersFile === 400, String(careersFile));
  const declined = await restRpc(lab, jwt, "hr_admin_candidate_progress", { p_id: manualId, p_action: "declined", p_reason: "Role filled", p_notify: false });
  check("declined without the email: the application and the person close, no rejection email",
    declined.status === 200 && psql(`select p.status || '|' || (select count(*) from hr.staff_emails e where e.profile_id = p.id and e.kind = 'rejected') from hr.staff_profiles p where p.id = '${manualProfile}';`) === "rejected|0", JSON.stringify(declined.body));
}

/* ------------------------------------------------------------------ mock Postmark (runs inside the check commands) */

const postmark = { messages: [], mode: "ok", server: null };
function startMockPostmark() {
  return new Promise((resolve, reject) => {
    postmark.server = http.createServer((req, res) => {
      const parts = [];
      req.on("data", (c) => parts.push(c));
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { /* keep {} */ }
        // Lab-only hooks for the Playwright suite (e2e): read what was "sent", switch failures on and off.
        if (req.url === "/__messages") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(postmark.messages)); }
        if (req.url?.startsWith("/__mode")) { postmark.mode = new URL(req.url, "http://x").searchParams.get("m") === "fail" ? "fail" : "ok"; res.writeHead(204); return res.end(); }
        const token = req.headers["x-postmark-server-token"];
        if (req.url !== "/email" || token !== LAB_SECRETS.EF_POSTMARK_SERVER_TOKEN) { res.writeHead(401); return res.end("{}"); }
        if (postmark.mode === "down") { res.writeHead(503); return res.end("{}"); }
        postmark.messages.push({ to: body.To, from: body.From, subject: body.Subject, text: body.TextBody, html: body.HtmlBody ?? null, attachments: body.Attachments ?? [], mode: postmark.mode });
        if (postmark.mode === "fail") { res.writeHead(422, { "content-type": "application/json" }); return res.end(JSON.stringify({ ErrorCode: 406, Message: "Inactive recipient" })); }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: crypto.randomUUID() }));
      });
    });
    postmark.server.on("error", reject);
    postmark.server.listen(MOCK_POSTMARK_PORT, "0.0.0.0", () => resolve());
  });
}
const stopMockPostmark = () => new Promise((r) => (postmark.server ? postmark.server.close(() => r()) : r()));

/* ------------------------------------------------------------------ mock OpenAI reader (runs inside the check commands) */
// Answers the Responses API shape the shared adapter parses. The field list comes from the request's own JSON schema, so it
// follows the adapter. A passport gets MOCK_PASSPORT, a visa MOCK_VISA; any other category answers with no fields.
const reader = { calls: 0, embeddings: 0, server: null };
function startMockReader() {
  return new Promise((resolve, reject) => {
    reader.server = http.createServer((req, res) => {
      const parts = [];
      req.on("data", (c) => parts.push(c));
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { /* keep {} */ }
        if (req.url === "/v1/embeddings" && req.headers.authorization === `Bearer ${LAB_SECRETS.OPENAI_API_KEY}`) {
          // Public assistant (P09-01): one fixed, non-zero vector, so ranking is decided by text and tenant scope alone.
          reader.embeddings++;
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ data: [{ embedding: [1, ...Array(1535).fill(0.001)] }], usage: { total_tokens: 5 } }));
        }
        if (req.url !== "/v1/responses" || req.headers.authorization !== `Bearer ${LAB_SECRETS.OPENAI_API_KEY}`) { res.writeHead(401); return res.end("{}"); }
        reader.calls++;
        if (body.text?.format?.name === "document_category_v1") {
          // What is this file? The lab's files say so in a comment; anything else is unreadable.
          const first = body.input?.[0]?.content?.[0] ?? {};
          const dataUrl = String(first.file_data ?? first.image_url ?? "");
          const content = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64").toString("latin1");
          const category = (content.match(/%lab-category:([A-Za-z ]+)/) ?? [])[1]?.trim() ?? "Unclear";
          // Holder-name matching (PR #29): the lab's files may carry %lab-holder:<printed name>; the passport attachment (second item) gives the first name.
          const holderOf = (text) => (text.match(/%lab-holder:([^\r\n%]+)/) ?? [])[1]?.trim() ?? null;
          const verify = Array.isArray(body.text?.format?.schema?.required) && body.text.format.schema.required.includes("holders");
          let extra = {};
          if (verify) {
            const second = body.input?.[0]?.content?.[1];
            const passportUrl = String(second?.file_data ?? second?.image_url ?? "");
            const passportText = passportUrl ? Buffer.from(passportUrl.slice(passportUrl.indexOf(",") + 1), "base64").toString("latin1") : (category === "Passport" ? content : "");
            const passportHolder = holderOf(passportText) ?? (passportText ? MOCK_PASSPORT.first_name + " " + MOCK_PASSPORT.last_name : null);
            const holder = holderOf(content) ?? passportHolder;
            extra = { holders: [holder], passport_first_name: passportHolder ? passportHolder.split(/\s+/)[0] : null };
          }
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ id: `resp_lab_${reader.calls}`, status: "completed", output_text: JSON.stringify({ category, ...extra }), usage: {} }));
        }
        const names = body.text?.format?.schema?.properties?.fields?.required ?? [];
        const category = (String(body.instructions ?? "").match(/in this (.+?) document\./) ?? [])[1] ?? "Other";
        const fields = Object.fromEntries(names.map((n) => [n, category === "Passport" ? (MOCK_PASSPORT[n] ?? null) : category === "Visa" ? (MOCK_VISA[n] ?? null) : null]));
        const result = { document_type: category, category_mismatch: false, fields, evidence: [] };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `resp_lab_${reader.calls}`, status: "completed", output_text: JSON.stringify(result), usage: {} }));
      });
    });
    reader.server.on("error", reject);
    reader.server.listen(MOCK_OPENAI_PORT, "0.0.0.0", () => resolve());
  });
}
const stopMockReader = () => new Promise((r) => (reader.server ? reader.server.close(() => r()) : r()));

/* ------------------------------------------------------------------ mock Geoscape (address search) */
// Answers the Verify Autocomplete shape the shared helper parses ({ results: [{ formatted }], attribution }) when the lab key is
// sent the way the helper sends it (raw in Authorization). "nowhere" in the query: no results; "outage": a provider fault.
const geoscape = { calls: 0, queries: [], server: null };
function startMockGeoscape() {
  return new Promise((resolve, reject) => {
    geoscape.server = http.createServer((req, res) => {
      const parts = [];
      req.on("data", (c) => parts.push(c));
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { /* keep {} */ }
        if (req.url !== "/v1/verify/autocomplete/AU" || req.headers.authorization !== LAB_SECRETS.EF_ADDRESS_SEARCH_GEOSCAPE_KEY) { res.writeHead(401); return res.end("{}"); }
        geoscape.calls++;
        geoscape.queries.push(String(body.query ?? ""));
        if (/outage/i.test(String(body.query))) { res.writeHead(500); return res.end("{}"); }
        const results = /nowhere/i.test(String(body.query)) ? [] : [{ formatted: "12 SMITH ST, MELBOURNE VIC 3000" }, { formatted: "UNIT 3, 12 SMITH ST, CARLTON VIC 3053" }];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results, attribution: "Lab mock" }));
      });
    });
    geoscape.server.on("error", reject);
    geoscape.server.listen(MOCK_GEOSCAPE_PORT, "0.0.0.0", () => resolve());
  });
}
const stopMockGeoscape = () => new Promise((r) => (geoscape.server ? geoscape.server.close(() => r()) : r()));

// ---- mock holiday sources (data.gov.au CKAN + Nager.Date), shapes copied from the real answers of 2026-11-11 ----
const NAGER_VIC_2026 = [
  ["2026-01-01", "New Year's Day", null], ["2026-01-26", "Australia Day", null], ["2026-03-09", "Labour Day", ["AU-VIC"]], ["2026-04-03", "Good Friday", null],
  ["2026-04-04", "Holy Saturday", ["AU-ACT", "AU-NSW", "AU-VIC"]], ["2026-04-05", "Easter Sunday", ["AU-ACT", "AU-NSW", "AU-VIC"]], ["2026-04-06", "Easter Monday", null],
  ["2026-04-25", "Anzac Day", ["AU-SA", "AU-TAS", "AU-VIC"]], ["2026-06-08", "King's Birthday", ["AU-ACT", "AU-NSW", "AU-VIC"]], ["2026-09-25", "Friday before AFL Grand Final", ["AU-VIC"]],
  ["2026-11-03", "Melbourne Cup", ["AU-VIC"]], ["2026-12-25", "Christmas Day", null], ["2026-12-28", "St. Stephen's Day", null], ["2026-03-02", "Labour Day", ["AU-WA"]],
].map(([date, name, counties]) => ({ date, localName: name, name, countryCode: "AU", global: !counties, counties, types: ["Public"] }));
const NAGER_VIC_2027 = [
  ["2027-01-01", "New Year's Day", null], ["2027-01-26", "Australia Day", null], ["2027-03-08", "Labour Day", ["AU-VIC"]], ["2027-03-26", "Good Friday", null],
  ["2027-03-27", "Holy Saturday", ["AU-VIC"]], ["2027-03-28", "Easter Sunday", ["AU-VIC"]], ["2027-03-29", "Easter Monday", null], ["2027-04-25", "Anzac Day", ["AU-SA", "AU-TAS", "AU-VIC"]],
  ["2027-06-14", "King's Birthday", ["AU-VIC"]], ["2027-09-24", "Friday before AFL Grand Final (Tentative Date)", ["AU-VIC"]], ["2027-11-02", "Melbourne Cup", ["AU-VIC"]],
  ["2027-12-27", "Christmas Day", null], ["2027-12-28", "St. Stephen's Day", null],
].map(([date, name, counties]) => ({ date, localName: name, name, countryCode: "AU", global: !counties, counties, types: ["Public"] }));
const DGA_VIC_2026 = [
  ["20260101", "New Year's Day"], ["20260126", "Australia Day"], ["20260309", "Labour Day"], ["20260403", "Good Friday"], ["20260404", "Saturday before Easter Sunday"],
  ["20260405", "Easter Sunday"], ["20260406", "Easter Monday"], ["20260425", "ANZAC Day"], ["20260608", "King's Birthday"], ["20260925", "Friday before the AFL Grand Final"],
  ["20261103", "Melbourne Cup"], ["20261225", "Christmas Day"], ["20261226", "Boxing Day"], ["20261228", "Boxing Day"],
].map(([Date, name], i) => ({ _id: i + 1, Date, "Holiday Name": name, Information: name === "Melbourne Cup" ? "Melbourne Cup Day is a public holiday across all of Victoria." : null, "More Information": "https://business.vic.gov.au/", Jurisdiction: "vic" }));
/** mode: "nager" (data.gov.au has 2025 only), "down" (Nager 503 too), "dga" (data.gov.au has 2026). */
const holidaySources = { mode: "nager", calls: [], server: null };
function startMockHolidaySources() {
  return new Promise((resolve, reject) => {
    holidaySources.server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://mock");
      holidaySources.calls.push(url.pathname);
      const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (url.pathname === "/data-gov/package_show") {
        const resources = [{ id: "r2025", name: "Australian Public Holidays 2025", datastore_active: true, format: "CSV" }];
        if (holidaySources.mode === "dga") resources.unshift({ id: "r2026", name: "Australian Public Holidays 2026", datastore_active: true, format: "CSV" });
        return send(200, { success: true, result: { resources } });
      }
      if (url.pathname === "/data-gov/datastore_search") {
        const id = url.searchParams.get("resource_id");
        return send(200, { success: true, result: { records: id === "r2026" ? DGA_VIC_2026 : [], total: id === "r2026" ? DGA_VIC_2026.length : 0 } });
      }
      const m = /^\/nager\/PublicHolidays\/(\d{4})\/AU$/.exec(url.pathname);
      if (m) {
        if (holidaySources.mode === "down") return send(503, { error: "mock outage" });
        return send(200, m[1] === "2026" ? NAGER_VIC_2026 : m[1] === "2027" ? NAGER_VIC_2027 : []);
      }
      send(404, { error: "not found" });
    });
    holidaySources.server.on("error", reject);
    holidaySources.server.listen(MOCK_HOLIDAY_PORT, "0.0.0.0", () => resolve());
  });
}
const stopMockHolidaySources = () => new Promise((r) => (holidaySources.server ? holidaySources.server.close(() => r()) : r()));
/** Waits until the document's reading has finished and returns its status. */
async function readingDone(docId) {
  let status = "";
  for (let i = 0; i < 30 && !["unavailable", "failed", "done", "no_fields"].includes(status); i++) {
    await new Promise((r) => setTimeout(r, 500));
    status = psql(`select extraction_status from hr.staff_documents where id = '${docId}';`);
  }
  return status;
}
const mailsTo = (address) => postmark.messages.filter((m) => String(m.to ?? "").split(",").map((a) => a.trim()).includes(address));
/** Waits (up to ~10 s) until the SQL answers the expected value: mail is sent after the HTTP response. */
async function waitFor(sql, expected) {
  let value = "";
  for (let i = 0; i < 40; i++) { value = psql(sql); if (value === expected) return value; await new Promise((r) => setTimeout(r, 250)); }
  return value;
}

/* ------------------------------------------------------------------ helpers shared by the HR-02c..f checks */

const LAB_ADMIN = { id: "1ab00000-0000-4000-8000-0000000000a1", email: "lab.admin@example.test", password: "lab-admin-password-1" };
/** A CMS Admin with a password in the lab (idempotent): admin RPCs and the staff-admin function run with a real admin JWT. */
async function ensureLabAdmin() {
  const lab = readLab();
  if (psql(`select count(*) from auth.users where id = '${LAB_ADMIN.id}';`) === "0") {
    const res = await fetch(`${lab.apiUrl}/auth/v1/admin/users`, { method: "POST", headers: { apikey: lab.serviceKey, Authorization: `Bearer ${lab.serviceKey}`, "content-type": "application/json" },
      body: JSON.stringify({ id: LAB_ADMIN.id, email: LAB_ADMIN.email, password: LAB_ADMIN.password, email_confirm: true }) });
    if (!res.ok) throw new Error(`could not create the lab admin: ${res.status} ${await res.text()}`);
  }
  psql(`insert into public.cms_users(id, name, email, role, status, auth_user_id, must_change_password) values ('lab-admin', 'Lab Admin', '${LAB_ADMIN.email}', 'Admin', 'Active', '${LAB_ADMIN.id}', false) on conflict (id) do nothing;`);
}
async function adminToken(lab) {
  const res = await fetch(`${lab.apiUrl}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: lab.anonKey, "content-type": "application/json" }, body: JSON.stringify({ email: LAB_ADMIN.email, password: LAB_ADMIN.password }) });
  const body = await res.json();
  if (!body.access_token) throw new Error(`lab admin sign-in failed: ${JSON.stringify(body)}`);
  return body.access_token;
}
async function staffAdminCall(lab, jwt, body) {
  const res = await fetch(`${lab.apiUrl}/functions/v1/staff-admin`, { method: "POST", headers: { apikey: lab.anonKey, Authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
/** Runs SQL as the lab Admin (role authenticated + JWT sub), the way the admin console calls the hr_admin_* functions. */
function asAdmin(sql) {
  return psql(`begin; set local role authenticated; set local request.jwt.claim.sub = '${LAB_ADMIN.id}'; set local request.jwt.claims = '{"sub":"${LAB_ADMIN.id}","role":"authenticated"}';\n${sql}\ncommit;`);
}
/** A link token like staff-admin makes: 32 random bytes, base64url; only its sha256 goes to the database. */
async function newLink() {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
  return { token, hash };
}
async function onboardCall(lab, body, file, ip) {
  let init;
  if (file) {
    const form = new FormData();
    for (const [k, v] of Object.entries(body)) form.set(k, String(v ?? ""));
    form.set("file", file.blob, file.name);
    init = { method: "POST", body: form, headers: { apikey: lab.anonKey } };
  } else {
    init = { method: "POST", body: JSON.stringify(body), headers: { apikey: lab.anonKey, "content-type": "application/json" } };
  }
  if (ip) init.headers["x-forwarded-for"] = ip; // a probe of a dead link counts against this address, not the lab's
  const res = await fetch(`${lab.apiUrl}/functions/v1/staff-onboarding`, init);
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
}
/** A fresh applicant through the real staff-register function; returns the profile id. */
async function freshApplicant(lab, label) {
  const stamp = Date.now();
  const email = `lab.${label}.${stamp}@example.test`;
  const r = await postApply(lab, { firstName: "Lab", lastName: label, email, phone: `+6147${String(stamp).slice(-7)}`, agreed: "true", captchaToken: "mock-ok", website: "", __ip: `198.51.${stamp % 200}.${stamp % 250}` },
    { blob: new Blob([PDF], { type: "application/pdf" }), name: "cv.pdf" });
  if (r.status !== 200) throw new Error(`apply failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: psql(`select id from hr.staff_profiles where email = '${email}';`), email };
}

async function onboard() {
  const lab = readLab();
  await ensureLabAdmin();
  const person = await freshApplicant(lab, "onboard");
  const link = await newLink();
  asAdmin(`select public.hr_admin_staff_invite('${person.id}', 'documents', '${link.hash}');`);
  check("the admin's document link makes the application 'invited'", psql(`select status from hr.staff_profiles where id = '${person.id}';`) === "invited");
  check("only the link hash is stored", psql(`select count(*) from hr.staff_invites where profile_id = '${person.id}' and token_hash = '${link.hash}';`) === "1"
    && psql(`select count(*) from hr.staff_invites where token_hash = '${link.token}';`) === "0");

  const wrong = await onboardCall(lab, { action: "open", t: (await newLink()).token });
  check("an unknown link gets 403 link_invalid", wrong.status === 403 && wrong.body.code === "link_invalid", JSON.stringify(wrong.body));
  const opened = await onboardCall(lab, { action: "open", t: link.token });
  check("the link opens the application (editable, documents mode)", opened.status === 200 && opened.body.view?.readOnly === false && opened.body.view?.mode === "documents", JSON.stringify(opened.body).slice(0, 200));
  check("no-store and no-referrer headers", opened.headers.get("cache-control") === "no-store" && opened.headers.get("referrer-policy") === "no-referrer");
  check("the applicant view carries no login id", !JSON.stringify(opened.body).includes("auth_user_id"));

  const details = { first_name: "Lab", last_name: "Onboard", date_of_birth: "1990-05-06", address_street: "1 Lab St", address_suburb: "Melbourne", address_state: "VIC", address_postcode: "3000",
    address_country: "Australia", emergency_name: "Em", emergency_relationship: "Sibling", emergency_phone: "+61 422 333 444", is_australian_citizen: false,
    nationality: "Indian", passport_number: "N1234567", visa_subclass: "485", tax_residency: "resident", tax_free_threshold: "yes", study_loan: "no", super_choice: "default" };
  const noCode = await onboardCall(lab, { action: "save", t: link.token, patch: { emergency_phone: "0422 333 444" } });
  check("a phone without its country code is refused on its field, with the shared message", noCode.status === 400 && noCode.body.field === "emergency_phone"
    && noCode.body.error === "Enter the emergency contact's phone number.", JSON.stringify(noCode.body));
  const saved = await onboardCall(lab, { action: "save", t: link.token, patch: details });
  check("personal details save through the link", saved.status === 200 && saved.body.view?.profile?.emergency_phone_e164 === "+61422333444", JSON.stringify(saved.body).slice(0, 200));

  const pdf = (name) => ({ blob: new Blob([labPdf(name)], { type: "application/pdf" }), name });
  const png = { blob: new Blob([labPng("results.png")], { type: "image/png" }), name: "results.png" };
  const fake = await onboardCall(lab, { action: "upload", t: link.token, category: "Passport", expiryDate: "2031-01-01" }, { blob: new Blob([new Uint8Array([0x4d, 0x5a, 0, 0])]), name: "passport.pdf" });
  check("a renamed non-PDF is refused and nothing is stored", fake.status === 400 && psql(`select count(*) from storage.objects where bucket_id = 'staff-documents' and name like '${person.id}/passport/%';`) === "0", JSON.stringify(fake.body));
  const future = (years) => `${new Date().getFullYear() + years}-06-30`;
  const uploads = [["Passport", future(5), pdf("passport.pdf")], ["Visa", future(2), pdf("visa.pdf")], ["English", "", pdf("english.pdf")], ["Academic", "", png], ["Academic", "", pdf("transcript.pdf")], ["Health Insurance", future(1), pdf("oshc.pdf")]];
  let allOk = true;
  for (const [category, expiryDate, file] of uploads) {
    const r = await onboardCall(lab, { action: "upload", t: link.token, category, expiryDate }, file);
    if (r.status !== 200) { allOk = false; console.log(`     ${category}: ${r.status} ${JSON.stringify(r.body)}`); }
  }
  check("passport, visa, English, two academic files and health insurance upload", allOk);
  check("every stored file is in the person's own folder", psql(`select count(*) from hr.staff_documents where profile_id = '${person.id}' and is_current and storage_path like '${person.id}/%';`) === "6"
    && psql(`select count(*) from storage.objects o join hr.staff_documents d on d.storage_path = o.name where d.profile_id = '${person.id}' and d.is_current;`) === "6");
  const noExpiry = await onboardCall(lab, { action: "upload", t: link.token, category: "Visa", expiryDate: "" }, pdf("visa2.pdf"));
  check("a visa may be uploaded without its expiry date; it replaces the earlier file", noExpiry.status === 200
    && psql(`select count(*) from storage.objects where bucket_id = 'staff-documents' and name like '${person.id}/visa/%';`) === "1", JSON.stringify(noExpiry.body).slice(0, 200));
  const visa2 = psql(`select id from hr.staff_documents where profile_id = '${person.id}' and category = 'Visa' and is_current;`);
  check("...the reader fills the visa's expiry date and subclass from the document", (await readingDone(visa2)) === "done"
    && psql(`select expiry_date from hr.staff_documents where id = '${visa2}';`) === MOCK_VISA.visa_stay_until, psql(`select extraction_status || ' ' || coalesce(expiry_date::text, 'none') from hr.staff_documents where id = '${visa2}';`));

  const passportId = psql(`select id from hr.staff_documents where profile_id = '${person.id}' and category = 'Passport' and is_current;`);
  const url = await onboardCall(lab, { action: "view_url", t: link.token, id: passportId });
  // Inside the local Edge runtime SUPABASE_URL is http://kong:8000 (reachable only by the containers); hosted signs public URLs.
  const fileRes = url.body.url ? await fetch(String(url.body.url).replace("http://kong:8000", lab.apiUrl)) : null;
  check("the applicant opens their own file through a short signed link", url.status === 200 && fileRes?.status === 200 && (await fileRes.text()).startsWith("%PDF-"), JSON.stringify(url.body).slice(0, 120));
  // Another applicant with a document of their own (made through the real functions), then try to open it with THIS link.
  const other = await freshApplicant(lab, "other");
  const otherLink = await newLink();
  asAdmin(`select public.hr_admin_staff_invite('${other.id}', 'documents', '${otherLink.hash}');`);
  await onboardCall(lab, { action: "upload", t: otherLink.token, category: "Passport", expiryDate: future(4) }, pdf("theirs.pdf"));
  const otherId = psql(`select id from hr.staff_documents where profile_id = '${other.id}' and is_current;`);
  const foreign = await onboardCall(lab, { action: "view_url", t: link.token, id: otherId });
  check("another person's file cannot be opened with this link", otherId.length === 36 && foreign.status === 400 && !foreign.body.url, JSON.stringify(foreign.body));

  // The reader runs after the response (mock OpenAI). Details were typed first here, so the reading must not overwrite them.
  const reading = await readingDone(passportId);
  check("the passport reading ran after the upload, and never overwrote the typed name or date of birth", reading === "done"
    && psql(`select first_name || '|' || last_name || '|' || date_of_birth from hr.staff_profiles where id = '${person.id}';`) === "Lab|Onboard|1990-05-06", reading);

  // Prefill: a fresh person uploads the passport BEFORE typing anything; the reading fills the empty date of birth and middle
  // name (the first/last name came from the application form and are kept), and the read name is offered on the document.
  const pre = await freshApplicant(lab, "prefill");
  const preLink = await newLink();
  asAdmin(`select public.hr_admin_staff_invite('${pre.id}', 'documents', '${preLink.hash}');`);
  const before = reader.calls;
  const prePassport = await onboardCall(lab, { action: "upload", t: preLink.token, category: "Passport", expiryDate: "" }, pdf("my-passport.pdf"));
  const preDoc = psql(`select id from hr.staff_documents where profile_id = '${pre.id}' and category = 'Passport' and is_current;`);
  const preReading = await readingDone(preDoc);
  const preView = await onboardCall(lab, { action: "open", t: preLink.token });
  const readDoc = preView.body.view?.documents?.find((d) => d.id === preDoc);
  check("prefill through the link: the passport fills date of birth and middle name", prePassport.status === 200 && preReading === "done" && reader.calls > before
    && psql(`select date_of_birth || '|' || middle_name from hr.staff_profiles where id = '${pre.id}';`) === "1985-02-03|Mock", `${preReading} ${psql(`select date_of_birth || '|' || middle_name from hr.staff_profiles where id = '${pre.id}';`)}`);
  check("...the read first/last name and date of birth reach the onboarding page, and the applied name is kept", readDoc?.extracted?.first_name === "PASSPORT" && readDoc?.extracted?.last_name === "READER"
    && readDoc?.extracted?.dob === "1985-02-03" && psql(`select first_name || '|' || last_name from hr.staff_profiles where id = '${pre.id}';`) === "Lab|prefill", JSON.stringify(readDoc?.extracted ?? {}).slice(0, 200));
  check("...and the passport number, nationality and the passport's expiry date (no date was typed)", psql(`select passport_number || '|' || nationality from hr.staff_profiles where id = '${pre.id}';`) === "PA1234567|New Zealander"
    && psql(`select expiry_date from hr.staff_documents where id = '${preDoc}';`) === MOCK_PASSPORT.passport_expiry, psql(`select passport_number || '|' || nationality from hr.staff_profiles where id = '${pre.id}';`));
  const callsBefore = reader.calls;
  const foreignRead = await onboardCall(lab, { action: "extract", t: preLink.token, id: otherId });
  check("another person's document cannot be read with this link (nothing sent to the reader)", foreignRead.status >= 400 && foreignRead.status < 500 && reader.calls === callsBefore, JSON.stringify(foreignRead.body));
  asAdmin(`select public.hr_admin_staff_invite_revoke('${pre.id}', 'documents');`);
  const revokedRead = await onboardCall(lab, { action: "extract", t: preLink.token, id: preDoc });
  check("a revoked link cannot start a reading", revokedRead.status === 403 && reader.calls === callsBefore, JSON.stringify(revokedRead.body));

  const academic = psql(`select id from hr.staff_documents where profile_id = '${person.id}' and category = 'Academic' and filename = 'transcript.pdf' and is_current;`);
  const removed = await onboardCall(lab, { action: "remove", t: link.token, id: academic });
  check("removing a file deletes it from storage", removed.status === 200 && psql(`select count(*) from storage.objects o join hr.staff_documents d on d.storage_path = o.name where d.id = '${academic}';`) === "0");

  const noBank = await onboardCall(lab, { action: "submit", t: link.token });
  check("submit is refused until the bank details are in", noBank.status === 400 && noBank.body.error === "Enter your bank details.", JSON.stringify(noBank.body));
  const badBank = await onboardCall(lab, { action: "bank_save", t: link.token, bank: { accountName: "Lab Onboard", bsb: "0620", accountNumber: "7700112233" } });
  check("a wrong BSB is refused on its field and the number is not repeated back", badBank.status === 400 && badBank.body.field === "bsb" && !JSON.stringify(badBank.body).includes("7700112233"), JSON.stringify(badBank.body));
  const bank = await onboardCall(lab, { action: "bank_save", t: link.token, bank: { accountName: "Lab Onboard", bsb: "062-000", accountNumber: "7700 112 233", bankName: "Commonwealth Bank" } });
  check("the bank details save through the link and come back masked", bank.status === 200 && bank.body.view?.bank?.bsb === "06••••" && bank.body.view?.bank?.accountNumber === "•••• 2233"
    && !JSON.stringify(bank.body).includes("7700112233"), JSON.stringify(bank.body.view?.bank ?? bank.body));
  check("...stored encrypted: no plain column, and the stored bytes do not contain the number", psql(`select (account_number is null and bsb is null and account_name is null)::text || '/' || (position('7700112233' in encode(account_number_enc, 'escape')) = 0)::text || '/' || hr.bank_decrypt(account_number_enc) from hr.employee_bank where profile_id = '${person.id}';`) === "true/true/7700112233");
  const submitted = await onboardCall(lab, { action: "submit", t: link.token });
  check("submit: documents_submitted and the link turns read-only", submitted.status === 200 && submitted.body.view?.readOnly === true
    && psql(`select status from hr.staff_profiles where id = '${person.id}';`) === "documents_submitted", JSON.stringify(submitted.body).slice(0, 200));
  check("the admins are told (queued)", psql(`select count(*) from hr.staff_emails where profile_id = '${person.id}' and kind = 'admin_documents_submitted';`) === "1");
  const late = await onboardCall(lab, { action: "save", t: link.token, patch: { first_name: "Late" } });
  check("nothing changes after submit (400)", late.status === 400 && psql(`select first_name from hr.staff_profiles where id = '${person.id}';`) === "Lab", JSON.stringify(late.body));
  const lateUpload = await onboardCall(lab, { action: "upload", t: link.token, category: "Passport", expiryDate: future(5) }, pdf("again.pdf"));
  check("no upload after submit, and nothing stored", lateUpload.status === 400 && psql(`select count(*) from storage.objects where bucket_id = 'staff-documents' and name like '${person.id}/passport/%';`) === "1");

  // Re-upload: the admin rejects the passport and sends a re-upload link.
  asAdmin(`select public.hr_admin_staff_document_review('${passportId}', 'rejected', 'Blurry');`);
  const re = await newLink();
  asAdmin(`select public.hr_admin_staff_invite('${person.id}', 'reupload', '${re.hash}');`);
  const reView = await onboardCall(lab, { action: "open", t: re.token });
  check("the re-upload link opens in re-upload mode", reView.status === 200 && reView.body.view?.mode === "reupload" && reView.body.view?.readOnly === false);
  const visaAgain = await onboardCall(lab, { action: "upload", t: re.token, category: "Visa", expiryDate: future(2) }, pdf("visa3.pdf"));
  check("a document that was not rejected cannot be replaced (nothing stored)", visaAgain.status === 400
    && psql(`select count(*) from storage.objects where bucket_id = 'staff-documents' and name like '${person.id}/visa/%';`) === "1", JSON.stringify(visaAgain.body));
  const detailsAgain = await onboardCall(lab, { action: "save", t: re.token, patch: { first_name: "Changed" } });
  check("a re-upload link cannot change personal details", detailsAgain.status === 403);
  const passportAgain = await onboardCall(lab, { action: "upload", t: re.token, category: "Passport", expiryDate: future(6) }, pdf("passport-new.pdf"));
  check("the rejected passport is replaced (the old file is kept)", passportAgain.status === 200
    && psql(`select count(*) from storage.objects where bucket_id = 'staff-documents' and name like '${person.id}/passport/%';`) === "2");
  const reSubmit = await onboardCall(lab, { action: "submit", t: re.token });
  check("the re-upload is sent: documents_submitted again", reSubmit.status === 200 && psql(`select status from hr.staff_profiles where id = '${person.id}';`) === "documents_submitted");

  // Revoke and expiry.
  const third = await newLink();
  asAdmin(`select public.hr_admin_staff_document_review((select id from hr.staff_documents where profile_id = '${person.id}' and category = 'Visa' and is_current), 'rejected', 'Expired soon');
select public.hr_admin_staff_invite('${person.id}', 'reupload', '${third.hash}');
select public.hr_admin_staff_invite_revoke('${person.id}');`);
  check("a revoked link answers 403", (await onboardCall(lab, { action: "open", t: third.token })).status === 403);
  const fourth = await newLink();
  asAdmin(`select public.hr_admin_staff_invite('${person.id}', 'reupload', '${fourth.hash}');`);
  psql(`update hr.staff_invites set created_at = now() - interval '20 days', expires_at = now() - interval '1 second' where token_hash = '${fourth.hash}';`);
  check("an expired link answers 403", (await onboardCall(lab, { action: "open", t: fourth.token })).status === 403);
}

/** Details and every required document (non-citizen) through a link, ready to submit. */
async function completeDocuments(lab, token) {
  const pdfFile = (name) => ({ blob: new Blob([labPdf(name)], { type: "application/pdf" }), name });
  const year = new Date().getFullYear();
  const saved = await onboardCall(lab, { action: "save", t: token, patch: { first_name: "Lab", last_name: "Mail", date_of_birth: "1990-05-06", address_street: "1 Lab St", address_suburb: "Melbourne",
    address_state: "VIC", address_postcode: "3000", address_country: "Australia", emergency_name: "Em", emergency_relationship: "Sibling", emergency_phone: "+61 422 333 444",
    is_australian_citizen: false, nationality: "Indian", passport_number: "N1234567", visa_subclass: "485",
    tax_residency: "resident", tax_free_threshold: "yes", study_loan: "no", super_choice: "default" } });
  if (saved.status !== 200) throw new Error(`details failed: ${JSON.stringify(saved.body)}`);
  const bank = await onboardCall(lab, { action: "bank_save", t: token, bank: { accountName: "Lab Mail", bsb: "062-000", accountNumber: "1234 4321" } });
  if (bank.status !== 200) throw new Error(`bank details failed: ${JSON.stringify(bank.body)}`);
  for (const [category, expiryDate] of [["Passport", `${year + 5}-06-30`], ["Visa", `${year + 2}-06-30`], ["English", ""], ["Academic", ""], ["Health Insurance", `${year + 1}-06-30`]]) {
    const r = await onboardCall(lab, { action: "upload", t: token, category, expiryDate }, pdfFile(`${category}.pdf`));
    if (r.status !== 200) throw new Error(`upload ${category} failed: ${JSON.stringify(r.body)}`);
  }
}
const liveLinks = (id) => psql(`select count(*) from hr.staff_invites where profile_id = '${id}' and revoked_at is null and superseded_at is null and used_at is null and expires_at > now();`);
const tokenIn = (text) => decodeURIComponent(String(text ?? "").match(/#t=([A-Za-z0-9_%-]+)/)?.[1] ?? "");

async function emails() {
  const lab = readLab();
  await ensureLabAdmin();
  const jwt = await adminToken(lab);
  const person = await freshApplicant(lab, "mail");

  // Outbox mail sent by the functions themselves.
  await waitFor(`select count(*) from hr.staff_emails where profile_id = '${person.id}' and state = 'sent';`, "2");
  const received = mailsTo(person.email).find((m) => /received/i.test(m.subject));
  check("'application received' reached the applicant, plain text without any link", !!received && !/https?:\/\//.test(received.text), JSON.stringify(received ?? null).slice(0, 160));
  const toAdmins = postmark.messages.find((m) => m.subject === "New staff application: Lab mail");
  check("'new application' reached every EF_HR_ADMIN_NOTIFY_TO address", toAdmins?.to === "hr.one@lab.example.test, hr.two@lab.example.test", JSON.stringify(toAdmins ?? null).slice(0, 160));
  check("the sender is EF_HR_EMAIL_FROM", /hr@lab\.example\.test/.test(received?.from ?? ""));

  // Invite link: made and mailed by staff-admin; only the hash is stored; the log has no token.
  const denied = await staffAdminCall(lab, lab.anonKey, { action: "send_invite", profileId: person.id, purpose: "documents" });
  check("staff-admin refuses a caller who is not an admin", denied.status === 401 || denied.status === 403, String(denied.status));
  const sent = await staffAdminCall(lab, jwt, { action: "send_invite", profileId: person.id, purpose: "documents" });
  const invite = mailsTo(person.email).find((m) => /details and documents/i.test(m.subject));
  const token = tokenIn(invite?.text);
  check("the admin sends the document link: emailed, 200, no token in the answer", sent.status === 200 && sent.body.emailSent === true && !!token && !JSON.stringify(sent.body).includes(token), JSON.stringify(sent.body));
  check("the link in the email opens the application", (await onboardCall(lab, { action: "open", t: token })).status === 200);
  check("the database and the email log hold no token", psql(`select count(*) from hr.staff_invites where token_hash = '${token}';`) === "0"
    && psql(`select count(*) from hr.staff_emails where profile_id = '${person.id}' and (payload::text like '%${token.slice(0, 16)}%' or payload::text like '%#t=%');`) === "0"
    && psql(`select state from hr.staff_emails where profile_id = '${person.id}' and kind = 'document_invite' order by id desc limit 1;`) === "sent");

  // A failed send: that link is cancelled at once and the admin sees the failure; the earlier link was replaced.
  postmark.mode = "fail";
  const failed = await staffAdminCall(lab, jwt, { action: "send_invite", profileId: person.id, purpose: "documents" });
  postmark.mode = "ok";
  check("a failed send answers 502 and says the link was cancelled", failed.status === 502 && failed.body.emailSent === false && failed.body.linkCancelled === true, JSON.stringify(failed.body).slice(0, 200));
  check("...no valid link is left (the new one cancelled, the old one replaced)", liveLinks(person.id) === "0" && (await onboardCall(lab, { action: "open", t: token })).status === 403);
  const detail = JSON.parse(psql(`begin; set local role authenticated; set local request.jwt.claim.sub = '${LAB_ADMIN.id}'; select public.hr_admin_staff_detail('${person.id}')::text; commit;`).split("\n").find((l) => l.startsWith("{")) ?? "{}");
  check("...and the admin sees the failure (detail.emailFailed, the failed invite email)", detail.emailFailed === true && detail.emails?.some((e) => e.kind === "document_invite" && e.state === "failed"));
  const again = await staffAdminCall(lab, jwt, { action: "send_invite", profileId: person.id, purpose: "documents" });
  const token2 = tokenIn(mailsTo(person.email).filter((m) => /details and documents/i.test(m.subject) && m.mode === "ok").at(-1)?.text);
  check("send again: exactly one live link, and it works", again.status === 200 && liveLinks(person.id) === "1" && (await onboardCall(lab, { action: "open", t: token2 })).status === 200);
  check("...and the failure flag clears once the same kind is sent", psql(`select hr.staff_email_failed('${person.id}');`) === "f");

  // An expired link is sent again the same way.
  psql(`update hr.staff_invites set created_at = now() - interval '20 days', expires_at = now() - interval '1 second' where profile_id = '${person.id}' and revoked_at is null and superseded_at is null and used_at is null;`);
  check("an expired link stops working", (await onboardCall(lab, { action: "open", t: token2 })).status === 403);
  const renewed = await staffAdminCall(lab, jwt, { action: "send_invite", profileId: person.id, purpose: "documents" });
  const token3 = tokenIn(mailsTo(person.email).filter((m) => /details and documents/i.test(m.subject) && m.mode === "ok").at(-1)?.text);
  check("the admin resends an expired link: one live link that works", renewed.status === 200 && token3 !== token2 && liveLinks(person.id) === "1" && (await onboardCall(lab, { action: "open", t: token3 })).status === 200);

  // Documents uploaded: the admins are told.
  await completeDocuments(lab, token3);
  const submitted = await onboardCall(lab, { action: "submit", t: token3 });
  check("submit works", submitted.status === 200, JSON.stringify(submitted.body).slice(0, 160));
  await waitFor(`select state from hr.staff_emails where profile_id = '${person.id}' and kind = 'admin_documents_submitted';`, "sent");
  check("'Lab Mail has uploaded documents' reached the admins", postmark.messages.some((m) => m.subject === "Lab Mail has uploaded documents" && m.to === "hr.one@lab.example.test, hr.two@lab.example.test"));

  // Re-upload link with the rejected document and its note.
  const passport = psql(`select id from hr.staff_documents where profile_id = '${person.id}' and category = 'Passport' and is_current;`);
  asAdmin(`select public.hr_admin_staff_document_review('${passport}', 'rejected', 'The photo page is cut off');`);
  const re = await staffAdminCall(lab, jwt, { action: "send_invite", profileId: person.id, purpose: "reupload" });
  const reMail = mailsTo(person.email).find((m) => /upload a document again/i.test(m.subject));
  check("the re-upload email names the document and the note, and its link opens in re-upload mode", re.status === 200 && /Passport: The photo page is cut off/.test(reMail?.text ?? "")
    && (await onboardCall(lab, { action: "open", t: tokenIn(reMail?.text) })).body.view?.mode === "reupload");

  // Outbox retries: a provider outage is retried, then failed after 3 attempts, then retried by the admin.
  postmark.mode = "down";
  const rejected = await staffAdminCall(lab, jwt, { action: "reject", profileId: person.id, note: "Position filled" });
  await staffAdminCall(lab, jwt, { action: "drain" });
  await staffAdminCall(lab, jwt, { action: "drain" });
  const failedRow = psql(`select id || '|' || state || '|' || attempts from hr.staff_emails where profile_id = '${person.id}' and kind = 'rejected';`).split("|");
  check("a provider outage is retried (3 attempts), then the rejection email is marked failed", rejected.status === 200 && failedRow[1] === "failed" && failedRow[2] === "3", failedRow.join("|"));
  postmark.mode = "ok";
  const retried = await staffAdminCall(lab, jwt, { action: "retry_email", emailId: Number(failedRow[0]) });
  check("the admin retries it and it is sent", retried.status === 200 && await waitFor(`select state from hr.staff_emails where id = ${failedRow[0]};`, "sent") === "sent"
    && mailsTo(person.email).some((m) => m.subject === "Your staff application"));
  const noLink = await staffAdminCall(lab, jwt, { action: "retry_email", emailId: Number(psql(`select id from hr.staff_emails where profile_id = '${person.id}' and kind = 'document_invite' and state = 'failed' limit 1;`)) });
  check("a failed link email is never re-sent from the outbox (send a new link instead)", noLink.status === 400, JSON.stringify(noLink.body));

  // Reject without the email.
  const quiet = await freshApplicant(lab, "quiet");
  await waitFor(`select count(*) from hr.staff_emails where profile_id = '${quiet.id}' and state = 'sent';`, "2");
  const before = mailsTo(quiet.email).length;
  const r2 = await staffAdminCall(lab, jwt, { action: "reject", profileId: quiet.id, note: "Not suitable", notify: false });
  await new Promise((r) => setTimeout(r, 1000));
  check("reject with the box unticked sends nothing", r2.status === 200 && mailsTo(quiet.email).length === before
    && psql(`select count(*) from hr.staff_emails where profile_id = '${quiet.id}' and kind = 'rejected';`) === "0");
  check("no message went anywhere but the mock (all sent rows have a mock message id)", psql("select count(*) from hr.staff_emails where state = 'sent' and provider_message_id is null;") === "0");
}

/* ------------------------------------------------------------------ offer (HR-02e) */

const sha256Hex = (bytes) => crypto.subtle.digest("SHA-256", bytes).then((d) => Buffer.from(d).toString("hex"));
async function pdfLib() { return await import("pdf-lib"); }
async function realPdf(pages) {
  const { PDFDocument } = await pdfLib();
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage().drawText(`Lab offer page ${i + 1}`, { x: 50, y: 700 });
  return await doc.save({ useObjectStreams: false });
}
async function encryptedPdf() {
  const text = Buffer.from(await realPdf(1)).toString("latin1").replace(/trailer\s*<</, "trailer\n<< /Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>");
  return new Uint8Array(Buffer.from(text, "latin1"));
}
async function uploadOffer(lab, jwt, profileId, bytes, name) {
  const form = new FormData();
  form.set("action", "offer_upload");
  form.set("profileId", profileId);
  form.set("file", new Blob([bytes], { type: "application/pdf" }), name);
  const res = await fetch(`${lab.apiUrl}/functions/v1/staff-admin`, { method: "POST", headers: { apikey: lab.anonKey, Authorization: `Bearer ${jwt}` }, body: form });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
/** Storage objects are read with the service key (the bucket is private). */
async function storageBytes(lab, objectPath) {
  const res = await fetch(`${lab.apiUrl}/storage/v1/object/staff-documents/${objectPath}`, { headers: { apikey: lab.serviceKey, Authorization: `Bearer ${lab.serviceKey}` } });
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}
/** A fresh applicant through the real functions up to documents_submitted, every document approved by the lab admin. */
async function readyForOffer(lab, label) {
  const person = await freshApplicant(lab, label);
  const link = await newLink();
  asAdmin(`select public.hr_admin_staff_invite('${person.id}', 'documents', '${link.hash}');`);
  await completeDocuments(lab, link.token);
  const submitted = await onboardCall(lab, { action: "submit", t: link.token });
  if (submitted.status !== 200) throw new Error(`submit failed: ${JSON.stringify(submitted.body)}`);
  for (const id of psql(`select id from hr.staff_documents where profile_id = '${person.id}' and is_current;`).split("\n").filter(Boolean)) {
    asAdmin(`select public.hr_admin_staff_document_review('${id}', 'approved');`);
  }
  // Onboarding flow (20261111090000): the pay details come before any offer.
  const schedule = psql("select id from hr.pay_schedules where is_active order by name limit 1;");
  const location = labLocation();
  asAdmin(`select public.hr_admin_onboarding_pay_save('${person.id}', jsonb_build_object('jobTitle', 'Lab Trainer', 'employmentType', 'full_time', 'startDate', (current_date + 30)::text,
    'payBasis', 'hourly', 'rate', '42.50', 'payScheduleId', '${schedule}', 'hoursPerWeek', '38', 'locationId', '${location}'));`);
  return { ...person, documentToken: link.token };
}

async function offer() {
  const lab = readLab();
  await ensureLabAdmin();
  const jwt = await adminToken(lab);
  const person = await readyForOffer(lab, "offer");
  const offerFiles = () => psql(`select count(*) from storage.objects where bucket_id = 'staff-documents' and name like '${person.id}/offer/%';`);

  // Upload: checked with pdf-lib before anything is stored.
  const locked = await uploadOffer(lab, jwt, person.id, await encryptedPdf(), "locked.pdf");
  check("an encrypted/protected offer PDF is refused with a clear message, nothing stored", locked.status === 400 && /password-protected or encrypted/.test(locked.body.error ?? "") && offerFiles() === "0", JSON.stringify(locked.body));
  const fake = await uploadOffer(lab, jwt, person.id, new TextEncoder().encode("MZ not a pdf"), "offer.pdf");
  check("a file that is not a PDF is refused, nothing stored", fake.status === 400 && offerFiles() === "0", JSON.stringify(fake.body));
  const original = await realPdf(2);
  const up = await uploadOffer(lab, jwt, person.id, original, "Lab Offer.pdf");
  const originalSha = await sha256Hex(original);
  check("a real offer PDF is stored and recorded with its sha256", up.status === 200 && psql(`select sha256 || '|' || filename from hr.staff_offers where profile_id = '${person.id}' and withdrawn_at is null;`) === `${originalSha}|Lab Offer.pdf` && offerFiles() === "1", JSON.stringify(up.body).slice(0, 200));
  const nonAdmin = await uploadOffer(lab, lab.anonKey, person.id, original, "x.pdf");
  check("a caller who is not an admin cannot upload an offer", nonAdmin.status >= 400 && offerFiles() === "1", String(nonAdmin.status));

  // Send: emailed inline with the offer link; a failed send cancels that link.
  postmark.mode = "fail";
  const failed = await staffAdminCall(lab, jwt, { action: "offer_send", profileId: person.id });
  postmark.mode = "ok";
  check("a failed offer email answers 502 and leaves no live offer link", failed.status === 502 && failed.body.linkCancelled === true && liveLinks(person.id) === "0", JSON.stringify(failed.body).slice(0, 200));
  const sent = await staffAdminCall(lab, jwt, { action: "offer_send", profileId: person.id });
  const offerMail = mailsTo(person.email).filter((m) => /offer letter from Skyline/i.test(m.subject) && m.mode === "ok").at(-1);
  const token = tokenIn(offerMail?.text);
  check("send again: the offer email carries a /staff/offer link; status offer_sent; one live link", sent.status === 200 && /\/staff\/offer#t=/.test(offerMail?.text ?? "") && !!token
    && psql(`select status from hr.staff_profiles where id = '${person.id}';`) === "offer_sent" && liveLinks(person.id) === "1", JSON.stringify(sent.body));
  check("the old document link does not open the offer", (await onboardCall(lab, { action: "offer_open", t: person.documentToken })).status === 403);

  // Open, view, sign.
  const opened = await onboardCall(lab, { action: "offer_open", t: token });
  check("the offer link opens the offer with the agreement wording", opened.status === 200 && opened.body.view?.offer?.filename === "Lab Offer.pdf" && /electronic signature/.test(opened.body.consent ?? "")
    && !JSON.stringify(opened.body).includes(originalSha), JSON.stringify(opened.body).slice(0, 200));
  const url = await onboardCall(lab, { action: "offer_view_url", t: token });
  const shown = url.body.url ? new Uint8Array(await (await fetch(String(url.body.url).replace("http://kong:8000", lab.apiUrl))).arrayBuffer()) : null;
  check("the applicant views the offer through a short signed link (the uploaded bytes)", !!shown && (await sha256Hex(shown)) === originalSha && /token=/.test(String(url.body.url)));
  const noName = await onboardCall(lab, { action: "offer_sign", t: token, name: " ", consent: true });
  const noConsent = await onboardCall(lab, { action: "offer_sign", t: token, name: "Lab Offer", consent: false });
  check("signing needs a typed name and the ticked agreement", noName.status === 400 && noConsent.status === 400 && psql(`select status from hr.staff_profiles where id = '${person.id}';`) === "offer_sent");
  const signed = await onboardCall(lab, { action: "offer_sign", t: token, name: "Lab Offer", consent: true });
  const row = psql(`select signed_path || '|' || signed_sha256 || '|' || sha256 || '|' || signer_name || '|' || coalesce(signer_ip, '') || '|' || (signer_user_agent is not null) from hr.staff_offers where profile_id = '${person.id}' and signed_at is not null;`).split("|");
  check("signed: offer_signed, read-only, signer details recorded", signed.status === 200 && signed.body.view?.readOnly === true && psql(`select status from hr.staff_profiles where id = '${person.id}';`) === "offer_signed"
    && row[3] === "Lab Offer" && row[5] === "true", JSON.stringify(signed.body).slice(0, 200));
  const signedBytes = row[0] ? await storageBytes(lab, row[0]) : null;
  const { PDFDocument } = await pdfLib();
  const signedDoc = signedBytes ? await PDFDocument.load(signedBytes) : null;
  check("the signed copy is a new file: original pages + 1 signature page", !!signedDoc && signedDoc.getPageCount() === 3 && row[0] !== psql(`select storage_path from hr.staff_offers where profile_id = '${person.id}';`));
  check("both hashes are stored and match the files: the original's and the signed copy's", row[2] === originalSha && !!signedBytes && (await sha256Hex(signedBytes)) === row[1] && row[1] !== row[2]
    && (await sha256Hex(await storageBytes(lab, psql(`select storage_path from hr.staff_offers where profile_id = '${person.id}';`)))) === originalSha);
  const again = await onboardCall(lab, { action: "offer_sign", t: token, name: "Lab Offer", consent: true });
  check("an offer is signed once (nothing more stored)", again.status === 400 && offerFiles() === "2", JSON.stringify(again.body));
  const signedUrl = await onboardCall(lab, { action: "offer_view_url", t: token, which: "signed" });
  check("afterwards the link shows the signed copy", signedUrl.status === 200 && !!signedUrl.body.url);

  // The signed PDF is emailed to the applicant and to HR.
  await waitFor(`select string_agg(kind || ':' || state, ',' order by id) from hr.staff_emails where profile_id = '${person.id}' and kind in ('signed_offer','admin_offer_signed');`, "signed_offer:sent,admin_offer_signed:sent");
  const toApplicant = mailsTo(person.email).find((m) => m.subject === "Your signed offer letter");
  const toHr = postmark.messages.filter((m) => m.subject === "Lab Mail signed the offer").at(-1);
  const attachedSha = async (m) => (m?.attachments?.[0]?.ContentType === "application/pdf" ? await sha256Hex(Buffer.from(m.attachments[0].Content, "base64")) : "");
  check("the applicant gets the signed PDF attached", !!toApplicant && (await attachedSha(toApplicant)) === row[1], JSON.stringify(toApplicant?.attachments?.map((a) => a.Name) ?? []));
  check("HR gets the signed PDF attached", !!toHr && toHr.to === "hr.one@lab.example.test, hr.two@lab.example.test" && (await attachedSha(toHr)) === row[1], toHr?.subject ?? "none");

  // Withdraw: back to documents_submitted, the offer link stops working.
  const second = await readyForOffer(lab, "withdraw");
  await uploadOffer(lab, jwt, second.id, await realPdf(1), "offer.pdf");
  await staffAdminCall(lab, jwt, { action: "offer_send", profileId: second.id });
  const secondToken = tokenIn(mailsTo(second.email).filter((m) => /offer letter from Skyline/i.test(m.subject)).at(-1)?.text);
  const noNote = await staffAdminCall(lab, jwt, { action: "offer_withdraw", profileId: second.id, note: "" });
  const withdrawn = await staffAdminCall(lab, jwt, { action: "offer_withdraw", profileId: second.id, note: "Role filled" });
  check("withdraw needs a note, then goes back to documents_submitted and the link stops working", noNote.status === 400 && withdrawn.status === 200
    && psql(`select status from hr.staff_profiles where id = '${second.id}';`) === "documents_submitted" && (await onboardCall(lab, { action: "offer_open", t: secondToken })).status === 403);
}

/* ------------------------------------------------------------------ activation + My HR (HR-02f) */

/** Auth mail (the Supabase "Invite user" email) goes to the stack's local Mailpit inbox. */
async function authMailsTo(lab, address) {
  const list = await (await fetch(`${lab.mailUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`)).json();
  const out = [];
  for (const m of list.messages ?? []) out.push(await (await fetch(`${lab.mailUrl}/api/v1/message/${m.ID}`)).json());
  return out;
}
const restRpc = async (lab, jwt, name, args = {}) => {
  const res = await fetch(`${lab.apiUrl}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: lab.anonKey, Authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const ownFile = async (lab, jwt, objectPath) => (await fetch(`${lab.apiUrl}/storage/v1/object/authenticated/staff-documents/${objectPath}`, { headers: { apikey: lab.anonKey, Authorization: `Bearer ${jwt}` } })).status;
/** Through the real functions to offer_signed: documents, approval, uploaded offer, offer link (made here, hash only), signature. */
async function signedPerson(lab, jwt, label) {
  const person = await readyForOffer(lab, label);
  const up = await uploadOffer(lab, jwt, person.id, await realPdf(1), "offer.pdf");
  if (up.status !== 200) throw new Error(`offer upload failed: ${JSON.stringify(up.body)}`);
  const link = await newLink();
  asAdmin(`select public.hr_admin_staff_offer_send('${person.id}', '${link.hash}');`);
  const signed = await onboardCall(lab, { action: "offer_sign", t: link.token, name: `Lab ${label}`, consent: true });
  if (signed.status !== 200) throw new Error(`sign failed: ${JSON.stringify(signed.body)}`);
  return person;
}

async function activate() {
  const lab = readLab();
  await ensureLabAdmin();
  const jwt = await adminToken(lab);
  const status = (id) => psql(`select status from hr.staff_profiles where id = '${id}';`);

  // A new person: Auth invite to /staff/welcome, password, claim, My HR.
  const person = await signedPerson(lab, jwt, "trainer");
  const year = new Date().getFullYear();
  const bad = await staffAdminCall(lab, jwt, { action: "activate", profileId: person.id, role: "admin", joiningDate: `${year}-12-01` });
  check("Admin needs the explicit confirmation (nothing sent)", bad.status === 400 && (await authMailsTo(lab, person.email)).length === 0, JSON.stringify(bad.body));
  const r = await staffAdminCall(lab, jwt, { action: "activate", profileId: person.id, role: "trainer", joiningDate: `${year}-12-01` });
  check("activate (no login yet): the Auth invite is sent, the login recorded, still offer_signed until the password is set", r.status === 200 && r.body.inviteSent === true && r.body.activated === false
    && status(person.id) === "offer_signed" && psql(`select count(*) from hr.staff_profiles p join auth.users u on u.id = p.auth_user_id where p.id = '${person.id}' and u.invited_at is not null;`) === "1", JSON.stringify(r.body).slice(0, 200));
  let invite = null;
  for (let i = 0; i < 20 && !invite; i++) { invite = (await authMailsTo(lab, person.email))[0] ?? null; if (!invite) await new Promise((res) => setTimeout(res, 500)); }
  const verifyUrl = String(invite?.HTML ?? invite?.Text ?? "").match(/https?:\/\/[^"'\s<>]+\/auth\/v1\/verify\?[^"'\s<>]+/)?.[0]?.replace(/&amp;/g, "&") ?? "";
  check("the invite email links to /auth/v1/verify and back to /staff/welcome", !!verifyUrl && /redirect_to=[^&]*%2Fstaff%2Fwelcome|redirect_to=[^&]*\/staff\/welcome/.test(verifyUrl), verifyUrl.slice(0, 160));
  const hop = await fetch(verifyUrl.replace(/^https?:\/\/[^/]+/, lab.apiUrl), { redirect: "manual" });
  const landing = hop.headers.get("location") ?? "";
  const fragment = new URLSearchParams(landing.split("#")[1] ?? "");
  const access = fragment.get("access_token") ?? "";
  check("following it lands on /staff/welcome with a session (type invite)", landing.startsWith(`${SITE}/staff/welcome`) && fragment.get("type") === "invite" && !!access, landing.slice(0, 120));
  const before = await restRpc(lab, access, "hr_staff_me");
  const signedPath = psql(`select signed_path from hr.staff_offers where profile_id = '${person.id}' and signed_at is not null;`);
  check("before the claim: no documents or files for the login", before.body?.status === "offer_signed" && (before.body?.documents ?? []).length === 0 && (await ownFile(lab, access, signedPath)) >= 400);
  const pw = await fetch(`${lab.apiUrl}/auth/v1/user`, { method: "PUT", headers: { apikey: lab.anonKey, Authorization: `Bearer ${access}`, "content-type": "application/json" }, body: JSON.stringify({ password: "Lab-staff-password-1" }) });
  const claimed = await restRpc(lab, access, "hr_staff_claim_account");
  check("password set, then the claim: active", pw.status === 200 && claimed.status === 200 && claimed.body?.status === "active" && status(person.id) === "active", JSON.stringify(claimed.body).slice(0, 160));
  const login = await (await fetch(`${lab.apiUrl}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: lab.anonKey, "content-type": "application/json" }, body: JSON.stringify({ email: person.email, password: "Lab-staff-password-1" }) })).json();
  const me = await restRpc(lab, login.access_token, "hr_staff_me");
  check("the person signs in with the new password; My HR has role, joining date, documents with expiry and the signed offer", !!login.access_token && me.body?.role === "trainer" && me.body?.joiningDate === `${year}-12-01`
    && (me.body?.documents ?? []).length === 5 && (me.body?.documents ?? []).some((d) => d.expiryDate) && me.body?.signedOffer?.signedPath === signedPath, JSON.stringify(me.body ?? {}).slice(0, 200));
  const other = await signedPerson(lab, jwt, "otherfile");
  const otherPath = psql(`select signed_path from hr.staff_offers where profile_id = '${other.id}' and signed_at is not null;`);
  check("an active person reads their own signed offer, never another person's file", (await ownFile(lab, login.access_token, signedPath)) === 200 && (await ownFile(lab, login.access_token, otherPath)) >= 400);
  check("a trainer gets no CMS access", psql(`select count(*) from public.cms_users c join hr.staff_profiles p on p.auth_user_id = c.auth_user_id where p.id = '${person.id}';`) === "0");
  check("activating again is refused", (await staffAdminCall(lab, jwt, { action: "activate", profileId: person.id, role: "trainer", joiningDate: `${year}-12-01` })).status === 400);

  // An email that already has a confirmed login (an existing student or agent): linked and active at once, no invite email.
  const existing = await signedPerson(lab, jwt, "existing");
  const created = await fetch(`${lab.apiUrl}/auth/v1/admin/users`, { method: "POST", headers: { apikey: lab.serviceKey, Authorization: `Bearer ${lab.serviceKey}`, "content-type": "application/json" },
    body: JSON.stringify({ email: existing.email, password: "Lab-student-password-1", email_confirm: true }) });
  const loginId = (await created.json()).id;
  const mailsBefore = (await authMailsTo(lab, existing.email)).length;
  const a = await staffAdminCall(lab, jwt, { action: "activate", profileId: existing.id, role: "admin", joiningDate: `${year}-12-01`, confirmAdmin: true });
  check("existing confirmed login: active at once on that login, no invite email", a.status === 200 && a.body.activated === true && a.body.inviteSent === false && status(existing.id) === "active"
    && psql(`select auth_user_id from hr.staff_profiles where id = '${existing.id}';`) === loginId && (await authMailsTo(lab, existing.email)).length === mailsBefore, JSON.stringify(a.body).slice(0, 200));
  check("the Admin role writes an active CMS Admin for that login", psql(`select role || '/' || status from public.cms_users where auth_user_id = '${loginId}';`) === "Admin/Active");
  await waitFor(`select state from hr.staff_emails where profile_id = '${existing.id}' and kind = 'access_ready';`, "sent");
  const ready = mailsTo(existing.email).find((m) => m.subject === "Your Skyline staff access is ready");
  check("...and HR emails that address 'your staff access is ready' (sign in with the existing login, no link)", !!ready && /an Admin/.test(ready.text) && /password you already use/.test(ready.text) && !/https?:\/\//.test(ready.text));

  // The Auth invite link expired: the admin resends it; the old link stays dead, the new one works.
  const late = await signedPerson(lab, jwt, "resend");
  const first = await staffAdminCall(lab, jwt, { action: "activate", profileId: late.id, role: "trainer", joiningDate: `${year}-12-01` });
  const linkOf = (m) => String(m?.HTML ?? m?.Text ?? "").match(/https?:\/\/[^"'\s<>]+\/auth\/v1\/verify\?[^"'\s<>]+/)?.[0]?.replace(/&amp;/g, "&") ?? "";
  let firstMail = null;
  for (let i = 0; i < 20 && !firstMail; i++) { firstMail = (await authMailsTo(lab, late.email))[0] ?? null; if (!firstMail) await new Promise((res) => setTimeout(res, 500)); }
  const oldLink = linkOf(firstMail);
  psql(`update auth.users set confirmation_sent_at = now() - interval '3 days', invited_at = now() - interval '3 days' where lower(email) = '${late.email}';`);
  const expired = await fetch(oldLink.replace(/^https?:\/\/[^/]+/, lab.apiUrl), { redirect: "manual" });
  check("an expired Auth invite link no longer signs in", first.status === 200 && !(expired.headers.get("location") ?? "").includes("access_token="), (expired.headers.get("location") ?? "").slice(0, 120));
  const resent = await staffAdminCall(lab, jwt, { action: "resend_activation", profileId: late.id });
  let newMail = null;
  for (let i = 0; i < 20 && !newMail; i++) { const all = await authMailsTo(lab, late.email); newMail = all.length > 1 ? all.find((m) => linkOf(m) !== oldLink) ?? null : null; if (!newMail) await new Promise((res) => setTimeout(res, 500)); }
  const fresh = await fetch(linkOf(newMail).replace(/^https?:\/\/[^/]+/, lab.apiUrl), { redirect: "manual" });
  const freshLanding = fresh.headers.get("location") ?? "";
  check("the admin resends the activation invite: a new Auth email whose link signs in to /staff/welcome", resent.status === 200 && resent.body.resent === true && !!newMail
    && freshLanding.startsWith(`${SITE}/staff/welcome`) && freshLanding.includes("access_token=") && psql(`select status from hr.staff_profiles where id = '${late.id}';`) === "offer_signed", JSON.stringify(resent.body).slice(0, 160));
  const usedLogin = await staffAdminCall(lab, jwt, { action: "resend_activation", profileId: person.id });
  check("resend is refused once the person is active", usedLogin.status === 400, JSON.stringify(usedLogin.body));
}

/* ------------------------------------------------------------------ retention (HR-02h) */

/** Public holiday sync (20261113150000 + holiday-sync): the real function against the mock sources, refusals, re-runs, failure, the cron dispatcher. */
async function holidays() {
  const lab = readLab();
  await ensureLabAdmin();
  const jwt = await adminToken(lab);
  const call = async (token) => {
    const res = await fetch(`${lab.apiUrl}/functions/v1/holiday-sync`, { method: "POST", headers: { apikey: lab.anonKey, ...(token ? { Authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: JSON.stringify({ action: "sync" }) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  // Back to the seeded state (as hosted was before the first sync) so the command can be run again without a fresh `up`, and again at
  // the end so the SQL suites that read the seeds (hrms_time_leave.sql) see them whatever ran before.
  const resetHolidaySeeds = () => psql("delete from hr.optional_holiday_requests r using hr.public_holidays h where h.id = r.holiday_id and h.state = 'VIC' and extract(year from h.holiday_date) in (2026, 2027); "
    + "delete from hr.public_holidays where state = 'VIC' and not is_optional and extract(year from holiday_date) in (2026, 2027); delete from hr.holiday_sync_runs; "
    + "insert into hr.public_holidays(holiday_date, name, state, status, source) select d::date, n, 'VIC', 'review', 'seed' from (values"
    + " ('2026-01-01','New Year''s Day'),('2026-01-26','Australia Day'),('2026-03-09','Labour Day'),('2026-04-03','Good Friday'),('2026-04-04','Saturday before Easter Sunday'),('2026-04-05','Easter Sunday'),('2026-04-06','Easter Monday'),('2026-04-25','ANZAC Day'),('2026-06-08','King''s Birthday'),('2026-11-03','Melbourne Cup Day'),('2026-12-25','Christmas Day'),('2026-12-26','Boxing Day'),('2026-12-28','Boxing Day (additional day)'),"
    + " ('2027-01-01','New Year''s Day'),('2027-01-26','Australia Day'),('2027-03-08','Labour Day'),('2027-03-26','Good Friday'),('2027-03-27','Saturday before Easter Sunday'),('2027-03-28','Easter Sunday'),('2027-03-29','Easter Monday'),('2027-04-25','ANZAC Day'),('2027-06-14','King''s Birthday'),('2027-11-02','Melbourne Cup Day'),('2027-12-25','Christmas Day'),('2027-12-26','Boxing Day'),('2027-12-27','Christmas Day (additional day)'),('2027-12-28','Boxing Day (additional day)')) v(d, n);");
  resetHolidaySeeds();
  const rows = (year) => psql(`select count(*) from hr.public_holidays where state = 'VIC' and not is_optional and extract(year from holiday_date) = ${year};`);
  const before = { y2026: rows(2026), y2027: rows(2027), runs: psql("select count(*) from hr.holiday_sync_runs;") };
  check("the migration installed the weekly cron job, active, Mondays 03:20 UTC", psql("select active::text || '/' || schedule from cron.job where jobname = 'hr-holiday-sync';") === "true/20 3 * * 1");
  const anon = await call(lab.anonKey);
  const none = await call(null);
  check("the anon key and a missing token cannot sync (403 / 401) and no run is recorded", anon.status === 403 && none.status === 401 && psql("select count(*) from hr.holiday_sync_runs;") === before.runs, `${anon.status}/${none.status}`);

  // 1. Sync now as the administrator: data.gov.au (2025 only) falls back to Nager.Date for 2026 and 2027.
  holidaySources.mode = "nager"; holidaySources.calls = [];
  const first = await call(jwt);
  const run1 = first.body.run ?? {};
  check("Sync now runs as an administrator and succeeds from Nager.Date for both years", first.status === 200 && run1.status === "ok" && run1.sources?.["2026"] === "nager" && run1.sources?.["2027"] === "nager", JSON.stringify(first.body).slice(0, 300));
  check("...data.gov.au was asked first (package_show) and the Nager mock answered both years", holidaySources.calls.includes("/data-gov/package_show") && holidaySources.calls.includes("/nager/PublicHolidays/2026/AU") && holidaySources.calls.includes("/nager/PublicHolidays/2027/AU"), holidaySources.calls.join(","));
  check("2026: 14 public holidays, all confirmed api rows (13 seeds adopted + Grand Final Friday), no duplicate dates", rows(2026) === "14"
    && psql("select count(*) from hr.public_holidays where state = 'VIC' and not is_optional and extract(year from holiday_date) = 2026 and (status <> 'confirmed' or source <> 'api');") === "0"
    && psql("select count(distinct holiday_date) from hr.public_holidays where state = 'VIC' and not is_optional and extract(year from holiday_date) = 2026;") === "14", `${rows(2026)} rows`);
  check("...Grand Final Friday 2026-09-25 and Melbourne Cup Day 2026-11-03 are confirmed with the official names", psql("select string_agg(name || ':' || status, ',' order by holiday_date) from hr.public_holidays where holiday_date in ('2026-09-25', '2026-11-03');") === "Friday before the AFL Grand Final:confirmed,Melbourne Cup Day:confirmed");
  check("...the weekend Boxing Day (26 Dec, Saturday) is kept next to the additional Monday", psql("select string_agg(holiday_date::text || ' ' || name, ',' order by holiday_date) from hr.public_holidays where holiday_date in ('2026-12-26', '2026-12-28');") === "2026-12-26 Boxing Day,2026-12-28 Boxing Day (additional day)");
  check("2027: 15 rows; the tentative Grand Final Friday waits at review, the rest is confirmed", rows(2027) === "15"
    && psql("select status from hr.public_holidays where holiday_date = '2027-09-24';") === "review"
    && psql("select count(*) from hr.public_holidays where state = 'VIC' and not is_optional and extract(year from holiday_date) = 2027 and status = 'confirmed';") === "14");
  check("the run recorded its counts (inserted + updated + unchanged = the 29 api rows)", Number(run1.inserted) + Number(run1.updated) + Number(run1.unchanged) === 29 && run1.trigger === "manual", `${run1.inserted}/${run1.updated}/${run1.unchanged}`);

  // 2. The same again: nothing changes. A row edited by hand is kept.
  const cupId = psql("select id from hr.public_holidays where holiday_date = '2026-11-03' and state = 'VIC' and not is_optional;");
  asAdmin(`select public.hr_admin_holiday_save('${cupId}', '{"note":"Metropolitan Melbourne only (edited by HR)"}');`);
  const second = await call(jwt);
  const run2 = second.body.run ?? {};
  check("a re-run inserts and updates nothing, keeps the hand-edited row and lists 28 unchanged", second.status === 200 && run2.status === "ok" && run2.inserted === 0 && run2.updated === 0 && run2.keptManual === 1 && run2.unchanged === 28 && rows(2026) === "14" && rows(2027) === "15", JSON.stringify(run2).slice(0, 300));
  check("...the hand-edited row is manual with its own note", psql("select source || '/' || note from hr.public_holidays where holiday_date = '2026-11-03';") === "manual/Metropolitan Melbourne only (edited by HR)");

  // 3. Both sources down: the run fails, nothing changes, the status RPC reports it.
  holidaySources.mode = "down";
  const third = await call(jwt);
  const run3 = third.body.run ?? {};
  check("when data.gov.au has no year and Nager.Date is down the run is recorded as failed and nothing changes", third.status === 200 && run3.status === "failed" && /Nager\.Date: .*503/.test(run3.error ?? "") && rows(2026) === "14" && rows(2027) === "15"
    && psql("select count(*) from hr.public_holidays where state = 'VIC' and not is_optional and extract(year from holiday_date) = 2027 and status = 'confirmed';") === "14", JSON.stringify(run3).slice(0, 300));
  check("...the admin status RPC shows the failed last run and the last good one", (() => { const s = JSON.parse(asAdmin("select public.hr_admin_holiday_sync_status();").split(String.fromCharCode(10)).map((l) => l.trim()).find((l) => l.startsWith("{")) ?? "{}"); return s.lastRun?.status === "failed" && s.lastOk?.status === "ok" && s.cronActive === true; })());

  // 4. data.gov.au has the year: it wins over Nager.Date.
  holidaySources.mode = "dga";
  const fourth = await call(jwt);
  const run4 = fourth.body.run ?? {};
  check("when data.gov.au has 2026 it is used for 2026 and Nager.Date only for 2027", fourth.status === 200 && run4.status === "ok" && run4.sources?.["2026"] === "data.gov.au" && run4.sources?.["2027"] === "nager" && rows(2026) === "14"
    && psql("select sync_source || '/' || status from hr.public_holidays where holiday_date = '2026-09-25';") === "data.gov.au/confirmed", JSON.stringify(run4).slice(0, 300));
  check("...a note from data.gov.au lands on an api row; the hand-edited one keeps its note", psql("select source || '/' || note from hr.public_holidays where holiday_date = '2026-11-03';") === "manual/Metropolitan Melbourne only (edited by HR)"
    && psql("select name from hr.public_holidays where holiday_date = '2026-04-25';") === "ANZAC Day");

  // 5. The pg_cron dispatcher: the Vault secrets of the retention job, pg_net POST with the service-role key, a 'cron' run.
  holidaySources.mode = "nager";
  psql("select vault.create_secret('" + lab.serviceKey + "', 'hr_retention_service_role_key', 'lab') where not exists (select 1 from vault.secrets where name = 'hr_retention_service_role_key');");
  psql("select vault.create_secret('http://kong:8000/functions/v1/staff-admin', 'hr_retention_function_url', 'lab') where not exists (select 1 from vault.secrets where name = 'hr_retention_function_url');");
  const runsBefore = psql("select count(*) from hr.holiday_sync_runs;");
  const requestId = psql("select coalesce(public.hr_holiday_sync_dispatch()::text, '');");
  let cronRun = "";
  for (let i = 0; i < 40 && !cronRun; i++) {
    await new Promise((r) => setTimeout(r, 500));
    cronRun = psql(`select status from hr.holiday_sync_runs where triggered_by = 'cron' and id > (select coalesce(max(id), 0) from (select id from hr.holiday_sync_runs order by id limit ${runsBefore}) x) order by id desc limit 1;`);
  }
  check("the dispatcher posts to holiday-sync through pg_net with the Vault key and the function records a 'cron' run that succeeds", requestId !== "" && cronRun === "ok", `request ${requestId || "none"}, run ${cronRun || "none"}`);
  check("...the hosted-style schedule is untouched by the lab", psql("select schedule from cron.job where jobname = 'hr-holiday-sync';") === "20 3 * * 1");
  resetHolidaySeeds();
  console.log(failures ? `holidays: ${failures} FAILED` : "holidays: all checks passed");
}

async function retention() {
  const lab = readLab();
  await ensureLabAdmin();
  const jwt = await adminToken(lab);
  // Two rejected applicants with files: one rejected 7 months ago (due), one recently (kept).
  const rejectedWithFiles = async (label) => {
    const person = await freshApplicant(lab, label);
    const link = await newLink();
    asAdmin(`select public.hr_admin_staff_invite('${person.id}', 'documents', '${link.hash}');`);
    await completeDocuments(lab, link.token);
    asAdmin(`select public.hr_admin_staff_reject('${person.id}', 'Lab retention', false);`);
    return person;
  };
  const old = await rejectedWithFiles("purgeold");
  const recent = await rejectedWithFiles("purgerecent");
  psql(`update hr.staff_profiles set status_changed_at = now() - interval '7 months' where id = '${old.id}';`);
  const files = (id) => psql(`select count(*) from storage.objects where bucket_id = 'staff-documents' and name like '${id}/%';`);
  check("before: both rejected applicants still have their resume and documents in storage", files(old.id) === "6" && files(recent.id) === "6", `${files(old.id)} / ${files(recent.id)}`);

  // Only the scheduled job (service_role) may purge.
  const asAdminCall = await staffAdminCall(lab, jwt, { action: "purge" });
  const anon = await fetch(`${lab.apiUrl}/functions/v1/staff-admin`, { method: "POST", headers: { apikey: lab.anonKey, Authorization: `Bearer ${lab.anonKey}`, "content-type": "application/json" }, body: JSON.stringify({ action: "purge" }) });
  check("an administrator or the anon key cannot run the purge", asAdminCall.status === 403 && anon.status === 403 && files(old.id) === "6", `${asAdminCall.status}/${anon.status}`);

  // The real pg_cron job, as installed by the migration: inactive, daily. For the lab it runs every 10 seconds for one round.
  check("the migration installed the daily job, inactive", psql("select active::text || '/' || schedule from cron.job where jobname = 'hr-retention-purge';") === "false/15 3 * * *");
  psql("select vault.create_secret('" + lab.serviceKey + "', 'hr_retention_service_role_key', 'lab') where not exists (select 1 from vault.secrets where name = 'hr_retention_service_role_key');");
  psql("select vault.create_secret('http://kong:8000/functions/v1/staff-admin', 'hr_retention_function_url', 'lab') where not exists (select 1 from vault.secrets where name = 'hr_retention_function_url');");
  psql("select cron.alter_job((select jobid from cron.job where jobname = 'hr-retention-purge'), schedule := '10 seconds', active := true);");
  let purged = "";
  for (let i = 0; i < 60 && purged !== "t"; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    purged = psql(`select (files_purged_at is not null)::text from hr.staff_applications where profile_id = '${old.id}';`).slice(0, 1);
  }
  psql("select cron.alter_job((select jobid from cron.job where jobname = 'hr-retention-purge'), schedule := '15 3 * * *', active := false);");
  const ran = psql("select count(*) from cron.job_run_details d join cron.job j on j.jobid = d.jobid where j.jobname = 'hr-retention-purge' and d.status = 'succeeded';");
  check("the cron job ran and called staff-admin through pg_net with the Vault key", Number(ran) >= 1 && purged === "t", `runs ${ran}, purged ${purged}`);
  check("the old application's files are deleted from storage; the row and its metadata stay", files(old.id) === "0"
    && psql(`select count(*) from hr.staff_documents where profile_id = '${old.id}';`) === "5" && psql(`select status from hr.staff_profiles where id = '${old.id}';`) === "rejected");
  const objectGone = await fetch(`${lab.apiUrl}/storage/v1/object/staff-documents/${psql(`select resume_path from hr.staff_applications where profile_id = '${old.id}';`)}`, { headers: { apikey: lab.serviceKey, Authorization: `Bearer ${lab.serviceKey}` } });
  check("...the resume really is gone (storage answers not found)", objectGone.status === 400 || objectGone.status === 404, String(objectGone.status));
  check("...and the personal data is removed: name, email, mobile, date of birth, address, emergency contact (status and dates stay)",
    psql(`select concat_ws('|', first_name, last_name, coalesce(email, '-'), coalesce(phone_e164, '-'), coalesce(date_of_birth::text, '-'), address_street, emergency_name, status) from hr.staff_profiles where id = '${old.id}';`) === "||-|-|-|||rejected"
    && psql(`select count(*) from hr.staff_documents where profile_id = '${old.id}' and (filename <> 'removed' or extracted <> '{}'::jsonb);`) === "0");
  check("the recently rejected application keeps every file", files(recent.id) === "6" && psql(`select (files_purged_at is null)::text from hr.staff_applications where profile_id = '${recent.id}';`) === "true");
  check("the job is back to daily and inactive", psql("select active::text || '/' || schedule from cron.job where jobname = 'hr-retention-purge';") === "false/15 3 * * *");
}

/* ------------------------------------------------------------------ onboarding flow (2026-11-10): the whole journey through the real functions */
const signIn = async (lab, email, password) => {
  const res = await fetch(`${lab.apiUrl}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: lab.anonKey, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
/** staff-onboarding as a signed-in person (no link token): the function resolves the session to their own record. */
const sessionCall = async (lab, jwt, body, ip) => {
  const res = await fetch(`${lab.apiUrl}/functions/v1/staff-onboarding`, { method: "POST", headers: { apikey: lab.anonKey, Authorization: `Bearer ${jwt}`, "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
// The work location every lab pay form uses (hr.locations, 20261113090000): made once, found again afterwards.
const labLocation = () => psql("with l as (insert into hr.locations(name) values ('Lab Campus') on conflict (lower(btrim(name))) do update set name = excluded.name returning id) select id from l;");
const paySave = (lab, jwt, id, over = {}) => restRpc(lab, jwt, "hr_admin_onboarding_pay_save", { p_id: id, p_details: { jobTitle: "Lab Trainer", employmentType: "full_time", locationId: labLocation(),
  startDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10), payBasis: "hourly", rate: "42.50", payScheduleId: psql("select id from hr.pay_schedules where is_active order by name limit 1;"), hoursPerWeek: "38", ...over } });

async function flow() {
  const lab = readLab();
  await ensureLabAdmin();
  const jwt = await adminToken(lab);
  const mailsTo = (address) => postmark.messages.filter((m) => m.to === address);
  const stage = (id) => psql(`select hr.onboarding_stage('${id}')->>'stage';`);
  const letterTemplate = psql("select id from hr.sign_templates where category = 'offer_letter' and name = 'Standard offer letter' and deleted_at is null;");
  const seededLetter = psql(`select body_html from hr.sign_templates where id = '${letterTemplate}';`);
  const PASSWORD = "correct horse 42 battery";
  // Calls that are MEANT to be refused as a dead link come from their own address (see onboardCall).
  const probe = `203.0.113.${1 + (Date.now() % 250)}`;

  // 1. Apply (the public form), then the document link from the employee page.
  const person = await freshApplicant(lab, "flow");
  check("apply: the application is at Applied", stage(person.id) === "applied");
  const sentDocs = await staffAdminCall(lab, jwt, { action: "send_documents", profileId: person.id });
  const docMail = mailsTo(person.email).at(-1);
  const docToken = tokenIn(docMail?.text);
  check("send document link: the email uses the built-in text with the private link; stage Documents requested",
    sentDocs.status === 200 && sentDocs.body.emailSent === true && docMail?.subject === "Next step: your details and documents" && docToken.length > 20
    && stage(person.id) === "documents_requested", `${sentDocs.status} ${JSON.stringify(sentDocs.body)} ${docMail?.subject}`);

  // 2. Upload and submit; nothing further is possible before review.
  await completeDocuments(lab, docToken);
  const submitted = await onboardCall(lab, { action: "submit", t: docToken });
  check("upload: the documents are submitted; stage Documents submitted", submitted.status === 200 && stage(person.id) === "documents_submitted", JSON.stringify(submitted.body));
  const tooEarly = await staffAdminCall(lab, jwt, { action: "offer_generate", profileId: person.id, templateId: letterTemplate });
  const payTooEarly = await paySave(lab, jwt, person.id);
  check("blocked: no offer letter and no pay details before the documents are approved", tooEarly.status === 400 && payTooEarly.status === 400 && /Approve every required document first/.test(`${tooEarly.body.error} ${payTooEarly.body?.message}`),
    `${tooEarly.status} ${JSON.stringify(tooEarly.body)} ${payTooEarly.status}`);

  // 3. Reject one document with a reason: the person is emailed the reason and a re-upload link; they replace it.
  const passport = psql(`select id from hr.staff_documents where profile_id = '${person.id}' and category = 'Passport' and is_current;`);
  const rejected = await restRpc(lab, jwt, "hr_admin_staff_document_review", { p_doc: passport, p_decision: "rejected", p_note: "The photo page is cut off" });
  const again = await staffAdminCall(lab, jwt, { action: "send_invite", profileId: person.id, purpose: "reupload" });
  const againMail = mailsTo(person.email).at(-1);
  const againToken = tokenIn(againMail?.text);
  check("reject a document: the reason is emailed with a link to upload it again",
    rejected.status === 200 && again.status === 200 && againMail?.subject === "Please upload a document again" && /Passport: The photo page is cut off/.test(againMail?.text ?? "") && againToken.length > 20 && againToken !== docToken,
    `${rejected.status} ${again.status} ${againMail?.subject}`);
  const year = new Date().getFullYear();
  const replaced = await onboardCall(lab, { action: "upload", t: againToken, category: "Passport", expiryDate: `${year + 6}-06-30`, replaces: passport }, { blob: new Blob([labPdf("passport")], { type: "application/pdf" }), name: "Passport-new.pdf" });
  const resubmitted = await onboardCall(lab, { action: "submit", t: againToken });
  check("the person replaces it through the link and submits again", replaced.status === 200 && resubmitted.status === 200 && stage(person.id) === "documents_submitted", `${replaced.status} ${JSON.stringify(replaced.body)} ${resubmitted.status}`);
  for (const id of psql(`select id from hr.staff_documents where profile_id = '${person.id}' and is_current;`).split("\n").filter(Boolean)) {
    await restRpc(lab, jwt, "hr_admin_staff_document_review", { p_doc: id, p_decision: "approved" });
  }
  check("approve: every required document approved; stage Documents approved", stage(person.id) === "documents_approved");

  // 4. Pay details: required before the offer, checked field by field.
  const noPay = await staffAdminCall(lab, jwt, { action: "offer_generate", profileId: person.id, templateId: letterTemplate });
  const badPay = await paySave(lab, jwt, person.id, { rate: "85000" });
  const paid = await paySave(lab, jwt, person.id);
  check("pay details: an offer is refused without them, a wrong figure is caught, then they save; stage Pay details added",
    noPay.status === 400 && /pay details/i.test(noPay.body.error ?? "") && badPay.status === 400 && /too high/.test(badPay.body?.message ?? "") && paid.status === 200 && paid.body.stage === "pay_details",
    `${noPay.status} ${JSON.stringify(noPay.body)} ${badPay.status} ${paid.status}`);

  // 5. The offer letter from the template: a real PDF and the exact rendered letter are kept against the person.
  const made = await staffAdminCall(lab, jwt, { action: "offer_generate", profileId: person.id, templateId: letterTemplate });
  const letter = psql(`select o.storage_path || '|' || l.template_name || '|' || (l.body_html !~ '\\{\\{')::text || '|' || (l.body_html like '%Lab Trainer%')::text || '|' || (l.body_html like '%$42.50%')::text
    from hr.staff_offer_letters l join hr.staff_offers o on o.id = l.offer_id where l.profile_id = '${person.id}';`).split("|");
  const letterBytes = await storageBytes(lab, letter[0]);
  check("offer letter: made from the chosen template, every placeholder filled with the person's details, stored as a PDF with the rendered copy",
    made.status === 200 && made.body.pages >= 1 && letter[1] === "Standard offer letter" && letter[2] === "true" && letter[3] === "true" && letter[4] === "true"
    && new TextDecoder().decode(letterBytes.subarray(0, 5)) === "%PDF-", `${made.status} ${JSON.stringify(made.body)} ${letter.join("|")}`);
  psql(`update hr.sign_templates set body_html = '<p>Edited later for {{first_name}}.</p>' where id = '${letterTemplate}';`);
  check("editing the template afterwards does not change the letter that was made", psql(`select (body_html like '%Lab Trainer%')::text from hr.staff_offer_letters where profile_id = '${person.id}';`) === "true");

  // 6. Send: one email with the offer and a one-time set-password link. A login exists but cannot sign in yet.
  const before = mailsTo(person.email).length;
  const sent = await staffAdminCall(lab, jwt, { action: "offer_send_login", profileId: person.id });
  const offerMail = mailsTo(person.email).at(-1);
  const accountToken = tokenIn(offerMail?.text);
  const login = psql(`select u.id || '|' || (u.email_confirmed_at is null)::text || '|' || (coalesce(u.encrypted_password, '') = '')::text || '|' || (p.auth_user_id = u.id)::text
    from auth.users u join hr.staff_profiles p on p.id = '${person.id}' where lower(u.email) = '${person.email}';`).split("|"); // id | unconfirmed | (unused) | linked
  check("send offer: one email with the sign-in link; a login is created (unconfirmed, no password anyone knows) and linked; stage Offer sent",
    sent.status === 200 && sent.body.emailSent === true && sent.body.needsPassword === true && mailsTo(person.email).length === before + 1 && /\/staff\/welcome#t=/.test(offerMail?.text ?? "")
    && /Your offer letter from/.test(offerMail?.subject ?? "") && login[1] === "true" && login[3] === "true" && stage(person.id) === "offer_sent",
    `${sent.status} ${JSON.stringify(sent.body)} ${offerMail?.subject} ${login.join("|")}`);
  check("only the hash of the link is stored; no email log holds it; nothing in the email or the answer is a password",
    psql(`select count(*) from hr.staff_invites where profile_id = '${person.id}' and token_hash = '${accountToken}';`) === "0"
    && psql(`select count(*) from hr.staff_emails where profile_id = '${person.id}' and payload::text like '%${accountToken}%';`) === "0"
    && psql(`select to_char(expires_at - created_at, 'DD') from hr.staff_invites where profile_id = '${person.id}' and purpose = 'account' and revoked_at is null and superseded_at is null;`) === "07"
    && !JSON.stringify(sent.body).includes(accountToken) && !/temporary password|password is|password:/i.test(offerMail?.text ?? ""));
  const noPassword = await signIn(lab, person.email, PASSWORD);
  const noSession = await sessionCall(lab, lab.anonKey, { action: "offer_open" }, probe);
  check("before a password is chosen nobody can sign in, and nothing opens without a session", noPassword.status === 400 && !noPassword.body.access_token && noSession.status === 403, `${noPassword.status} ${noSession.status}`);

  // 7. The person: choose a password through the link (weak ones refused), once.
  const opened = await onboardCall(lab, { action: "account_open", t: accountToken });
  const weak = await onboardCall(lab, { action: "account_setup", t: accountToken, password: "short1" });
  const set = await onboardCall(lab, { action: "account_setup", t: accountToken, password: PASSWORD });
  const reuse = await onboardCall(lab, { action: "account_setup", t: accountToken, password: "another good one 77" }, null, probe);
  check("set password: the link opens for its person, a weak password is refused, the chosen one is saved, and the link then stops working",
    opened.status === 200 && opened.body.view?.email === person.email && !("authUserId" in (opened.body.view ?? {})) && weak.status === 400 && weak.body.field === "password"
    && set.status === 200 && set.body.ok === true && reuse.status === 403 && reuse.body.code === "link_invalid", `${opened.status} ${weak.status} ${set.status} ${JSON.stringify(set.body)} ${reuse.status}`);
  const session = await signIn(lab, person.email, PASSWORD);
  const userJwt = session.body.access_token;
  check("they sign in with the password they chose (the second attempt did not change it)", session.status === 200 && Boolean(userJwt) && (await signIn(lab, person.email, "another good one 77")).status === 400, String(session.status));

  // 8. Signed in, before Active: own offer and own documents only.
  const me = await restRpc(lab, userJwt, "hr_staff_onboarding_me");
  const myHr = await restRpc(lab, userJwt, "hr_staff_me");
  const myOffer = await sessionCall(lab, userJwt, { action: "offer_open" });
  const myPdf = await sessionCall(lab, userJwt, { action: "offer_view_url", which: "offer" });
  const firstDoc = me.body?.documents?.[0];
  const myDoc = await sessionCall(lab, userJwt, { action: "my_document_url", id: firstDoc?.id });
  check("before Active the person sees their offer and their own documents",
    me.status === 200 && me.body.status === "offer_sent" && me.body.documents.length === 5 && myOffer.status === 200 && myOffer.body.view?.readOnly === false && /^http/.test(myPdf.body.url ?? "") && /^http/.test(myDoc.body.url ?? ""),
    `${me.status} ${myOffer.status} ${myPdf.status} ${myDoc.status}`);
  const adminView = await restRpc(lab, userJwt, "hr_admin_onboarding", { p_id: person.id });
  const adminAction = await staffAdminCall(lab, userJwt, { action: "activate", profileId: person.id, role: "admin", joiningDate: "2027-01-01", confirmAdmin: true });
  const direct = await ownFile(lab, userJwt, psql(`select storage_path from hr.staff_documents where id = '${firstDoc?.id}';`));
  const punch = await restRpc(lab, userJwt, "hr_time_status");
  const adminOffer = await sessionCall(lab, jwt, { action: "offer_open" });
  const otherDoc = await sessionCall(lab, jwt, { action: "my_document_url", id: firstDoc?.id });
  check("...and nothing else: no admin view or action, no direct storage, no My HR documents, no timesheet; another login reaches neither the offer nor the document",
    adminView.status >= 400 && adminAction.status === 403 && direct !== 200 && myHr.status === 200 && (myHr.body?.documents ?? []).length === 0 && punch.status >= 400
    && adminOffer.status === 404 && adminOffer.body.code === "no_offer" && otherDoc.status === 404,
    `${adminView.status} ${adminAction.status} ${direct} ${myHr.status} ${punch.status} ${adminOffer.status} ${otherDoc.status}`);

  // 9. Sign, then Activate (not possible before the signature).
  const early = await staffAdminCall(lab, jwt, { action: "activate", profileId: person.id, role: "trainer", joiningDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10) });
  const signed = await sessionCall(lab, userJwt, { action: "offer_sign", name: "Lab Flow", consent: true });
  check("blocked: no activation before the signature; then the signed-in person signs; stage Offer signed",
    early.status === 400 && /signed the offer/.test(early.body.error ?? "") && signed.status === 200 && Boolean(signed.body.view?.offer?.signedAt) && stage(person.id) === "offer_signed", `${early.status} ${signed.status} ${JSON.stringify(signed.body).slice(0, 200)}`);
  await waitFor(`select count(*) from hr.staff_emails where profile_id = '${person.id}' and kind = 'signed_offer' and state = 'sent';`, "1");
  const signedMail = mailsTo(person.email).find((m) => m.subject === "Your signed offer letter");
  check("the signed copy is emailed to the person with the PDF attached", Boolean(signedMail) && signedMail.attachments.length === 1);
  const activated = await staffAdminCall(lab, jwt, { action: "activate", profileId: person.id, role: "trainer", joiningDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10) });
  const afterJwt = (await signIn(lab, person.email, PASSWORD)).body.access_token;
  const hrAfter = await restRpc(lab, afterJwt, "hr_staff_me");
  check("activate: a current employee at once on the login they already use; all nine stages complete; My HR opens; listed under Active",
    activated.status === 200 && activated.body.activated === true && stage(person.id) === "active"
    && psql(`select count(*) from jsonb_array_elements(hr.onboarding_stage('${person.id}')->'steps') s where s->>'state' = 'done';`) === "9"
    && hrAfter.body?.status === "active" && hrAfter.body.documents.length === 5
    && psql(`select count(*) from hr.employee_pay ep join hr.staff_profiles p on p.id = ep.profile_id where p.id = '${person.id}' and p.status = 'active' and ep.pay_schedule_id is not null;`) === "1",
    `${activated.status} ${JSON.stringify(activated.body).slice(0, 160)} ${stage(person.id)}`);
  const history = JSON.parse(psql(`select hr.onboarding_timeline('${person.id}')::text;`));
  const actions = new Set(history.filter((e) => e.type === "action").map((e) => e.action));
  check("history: every action is logged with who did it and when",
    ["document_uploaded", "document_rejected", "document_approved", "pay_details_added", "offer_letter_generated", "offer_sent", "password_set", "offer_signed", "role_granted"].every((a) => actions.has(a))
    && history.some((e) => e.action === "pay_details_added" && e.actorName === "Lab Admin" && e.at) && history.some((e) => e.action === "offer_signed" && e.actorName === "The applicant")
    && history.filter((e) => e.type === "status").length >= 6, [...actions].join(","));

  // 10. A failed offer email: everything is put back, and no login is left behind.
  const second = await readyForOffer(lab, "flowfail");
  psql(`update hr.sign_templates set body_html = '<p>Dear {{first_name}}, you start as {{position}} on {{start_date}}.</p>' where id = '${letterTemplate}';`);
  await staffAdminCall(lab, jwt, { action: "offer_generate", profileId: second.id, templateId: letterTemplate });
  postmark.mode = "fail";
  const failedSend = await staffAdminCall(lab, jwt, { action: "offer_send_login", profileId: second.id });
  postmark.mode = "ok";
  check("a failed offer email is undone: not sent, no live link, no login left, and the admin is told clearly",
    failedSend.status === 502 && failedSend.body.rolledBack === true && /Nothing went out and nothing was changed/.test(failedSend.body.error ?? "")
    && psql(`select status || '|' || coalesce(auth_user_id::text, 'none') from hr.staff_profiles where id = '${second.id}';`) === "documents_submitted|none"
    && psql(`select count(*) from auth.users where lower(email) = '${second.email}';`) === "0" && liveLinks(second.id) === "0"
    && psql(`select (sent_at is null)::text from hr.staff_offers where profile_id = '${second.id}' and withdrawn_at is null;`) === "true"
    && psql(`select count(*) from hr.staff_emails where profile_id = '${second.id}' and kind = 'offer' and state = 'failed';`) === "1", `${failedSend.status} ${JSON.stringify(failedSend.body)}`);
  const retry = await staffAdminCall(lab, jwt, { action: "offer_send_login", profileId: second.id });
  const firstLink = tokenIn(mailsTo(second.email).at(-1)?.text);
  const resent = await staffAdminCall(lab, jwt, { action: "resend_login", profileId: second.id });
  const newLinkToken = tokenIn(mailsTo(second.email).at(-1)?.text);
  check("sending again works; Resend login emails a new link and the earlier one stops working",
    retry.status === 200 && retry.body.emailSent === true && resent.status === 200 && newLinkToken && newLinkToken !== firstLink
    && (await onboardCall(lab, { action: "account_open", t: firstLink }, null, probe)).status === 403 && (await onboardCall(lab, { action: "account_open", t: newLinkToken })).status === 200,
    `${retry.status} ${resent.status}`);
  psql(`update hr.staff_invites set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where profile_id = '${second.id}' and purpose = 'account' and revoked_at is null and superseded_at is null;`);
  check("an unused link expires after 7 days", (await onboardCall(lab, { action: "account_open", t: newLinkToken }, null, probe)).status === 403);
  const withdrawn = await staffAdminCall(lab, jwt, { action: "reject", profileId: second.id, note: "Took another role", notify: true });
  await waitFor(`select count(*) from hr.staff_emails where profile_id = '${second.id}' and kind = 'rejected' and state = 'sent';`, "1");
  const rejectionMail = mailsTo(second.email).find((m) => m.subject === "Your staff application");
  check("withdraw at any stage with a reason: closed, links dead, and the rejection email uses the built-in message",
    withdrawn.status === 200 && psql(`select status from hr.staff_profiles where id = '${second.id}';`) === "rejected" && liveLinks(second.id) === "0"
    && Boolean(rejectionMail) && psql(`select hr.onboarding_stage('${second.id}')->>'closed';`) === "rejected", `${withdrawn.status} ${Boolean(rejectionMail)}`);
  // Leave the lab's standard letter template as it was seeded.
  psql(`update hr.sign_templates set body_html = '${seededLetter.replace(/'/g, "''")}' where id = '${letterTemplate}';`);
}

/* ------------------------------------------------------------------ onboarding wizard */

const LAB_EDITOR = { id: "1ab00000-0000-4000-8000-0000000000e1", email: "lab.editor@example.test", password: "lab-editor-password-1" };
/** A CMS Editor (not an Admin) with a password in the lab (idempotent). */
async function editorToken(lab) {
  if (psql(`select count(*) from auth.users where id = '${LAB_EDITOR.id}';`) === "0") {
    const res = await fetch(`${lab.apiUrl}/auth/v1/admin/users`, { method: "POST", headers: { apikey: lab.serviceKey, Authorization: `Bearer ${lab.serviceKey}`, "content-type": "application/json" },
      body: JSON.stringify({ id: LAB_EDITOR.id, email: LAB_EDITOR.email, password: LAB_EDITOR.password, email_confirm: true }) });
    if (!res.ok) throw new Error(`could not create the lab editor: ${res.status} ${await res.text()}`);
  }
  psql(`insert into public.cms_users(id, name, email, role, status, auth_user_id, must_change_password) values ('lab-editor', 'Lab Editor', '${LAB_EDITOR.email}', 'Editor', 'Active', '${LAB_EDITOR.id}', false) on conflict (id) do nothing;`);
  const session = await signIn(lab, LAB_EDITOR.email, LAB_EDITOR.password);
  if (!session.body.access_token) throw new Error(`lab editor sign-in failed: ${JSON.stringify(session.body)}`);
  return session.body.access_token;
}

/** One list of inputs for the shared rules. The same list goes through the TypeScript module and through the database. */
const RULE_VECTORS = {
  today: "2026-11-10",
  phones: ["+61412345678", "+61 412 345 678", "  +61412345678  ", "+6141234567", "+610412345678", "+61", "+", "", "0412345678", "abc", "+33123456789", "+9779812345678", "+97798", "+8801712345678",
    "+14155550123", "+1415555", "+141555", "+447700900123", "+919876543210", "+91987", "+639171234567", "+94712345678", "+923001234567", "+9198765432101234"],
  names: ["", " ", "Jo", " Jo ", "x".repeat(100), "x".repeat(101), "Jo\u0001", "Jo\u007f", "O'Brien-Smith"],
  dobs: ["", "1990-05-06", "1990-02-30", "2016-11-10", "2016-11-11", "1926-11-10", "1926-11-09", "5/6/1990", "05.06.1990", "31-12-1999", "32/12/1999", "1990-5-6", "abc", "0000-01-01", "29/02/2000", "29/02/2001", " 1990-05-06 "],
  // 29 February as "today": the limits roll over the way the browser's Date does.
  leapToday: "2028-02-29", leapDobs: ["2018-02-28", "2018-03-01", "2018-03-02", "1928-02-29", "1928-02-28"],
  banks: [["", "", ""], ["Jo", "", ""], ["Jo", "062000", ""], ["Jo", "062-000", "1234 5678"], ["Jo", "06200", "12345678"], ["Jo", "0620000", "12345678"], ["Jo", "062000", "123"],
    ["Jo", "062000", "12345678901"], ["x".repeat(101), "062000", "1234"], [" Jo ", " 062 000 ", "12-34-56"], ["Jo\u0001", "062000", "1234"]],
  staff: (() => {
    const base = { is_australian_citizen: false, first_name: "Jo", middle_name: "", last_name: "Journey", date_of_birth: "1990-05-06", phone: "+61412345678", address_street: "1 Lab St", address_line2: "",
      address_suburb: "Melbourne", address_country: "Australia", address_state: "VIC", address_postcode: "3000", emergency_name: "Em", emergency_phone: "+61422333444", emergency_relationship: "Sibling",
      nationality: "Indian", passport_number: "N1234567", visa_subclass: "485", visa_conditions: "",
      tax_residency: "resident", tax_free_threshold: "yes", study_loan: "no", super_choice: "default", super_fund_name: "", super_fund_abn: "", super_usi: "", super_member_number: "" };
    const all = Object.keys(base);
    const blank = Object.fromEntries(all.map((k) => [k, k === "is_australian_citizen" ? null : ""]));
    const cases = [];
    const add = (details, keys, final) => cases.push({ details, keys, final });
    add(base, all, true); add(base, all, false); add(blank, all, true); add(blank, all, false);
    add({ ...base, is_australian_citizen: true, visa_subclass: "" }, all, true);
    add({ ...base, visa_subclass: "" }, all, true);
    add({ ...base, is_australian_citizen: null }, all, true);
    for (const [key, values] of Object.entries({
      first_name: ["", "x".repeat(101), "Jo\u0001"], middle_name: ["x".repeat(101)], last_name: [""], date_of_birth: ["", "2020-01-01", "1990-02-30", "3/2/1991"], phone: ["", "0412345678", "+6141"],
      address_street: ["", "x".repeat(201)], address_line2: ["x".repeat(201)], address_suburb: ["", "x".repeat(201)], address_country: ["", "x".repeat(201)], address_state: ["", "vic", "Punjab"],
      address_postcode: ["", "30", "30000", "abcd"], emergency_name: ["", "x".repeat(121)], emergency_phone: ["", "0422333444", "+6142"], emergency_relationship: ["", "x".repeat(61)],
      nationality: ["", "x".repeat(101)], passport_number: ["", "12", "pa 1234567", "ABCDEFGHIJKLM", "N12345!7"], visa_subclass: ["", "x".repeat(101)], visa_conditions: ["8105\nNo other limits", "x".repeat(501), "a\u0001b"],
      tax_residency: ["", "foreign", "whm", "martian"], tax_free_threshold: ["", "no", "maybe"], study_loan: ["", "yes", "x"], super_choice: ["", "own", "smsf", "bank"],
      super_fund_name: ["", "x".repeat(101), "Fund\u0001"], super_fund_abn: ["", "51 824 753 556", "51824753557", "123", "abcdefghijk"], super_usi: ["", "STA0100AU", "abc-def", "x".repeat(21)],
      super_member_number: ["", "12345-6", "x".repeat(31), "a@b"],
    })) for (const value of values) for (const final of [false, true]) add({ ...base, [key]: value }, [key], final);
    for (const final of [false, true]) {
      // Tax and super: the answers depend on each other (the threshold only for residents, the fund details only for a fund of one's own).
      add({ ...base, tax_residency: "resident", tax_free_threshold: "" }, ["tax_free_threshold"], final);
      add({ ...base, tax_residency: "foreign", tax_free_threshold: "" }, ["tax_free_threshold"], final);
      add({ ...base, super_choice: "own", super_fund_name: "", super_fund_abn: "", super_usi: "", super_member_number: "" }, ["super_fund_name", "super_fund_abn", "super_usi", "super_member_number"], final);
      add({ ...base, super_choice: "own", super_fund_name: "Fund", super_fund_abn: "51824753556", super_usi: "", super_member_number: "" }, ["super_fund_name", "super_fund_abn", "super_usi", "super_member_number"], final);
      add({ ...base, super_choice: "smsf", super_fund_name: "Fund", super_fund_abn: "51824753556", super_usi: "", super_member_number: "" }, ["super_fund_name", "super_fund_abn", "super_usi", "super_member_number"], final);
      add({ ...base, super_choice: "smsf", super_fund_name: "", super_fund_abn: "" }, ["super_fund_name", "super_fund_abn"], final);
      add({ ...base, address_country: "India", address_state: "Punjab", address_postcode: "144001" }, ["address_state", "address_postcode"], final);
      add({ ...base, address_country: "India", address_state: "", address_postcode: "x".repeat(21) }, ["address_state", "address_postcode"], final);
      add({ ...base, address_country: "AU", address_state: "nsw", address_postcode: "2000" }, ["address_country", "address_state", "address_postcode"], final);
    }
    return cases;
  })(),
};

/** Runs RULE_VECTORS through the shared TypeScript module (jiti, a temp file outside the repo) and returns one answer per input. */
function tsAnswers() {
  const runner = path.join(WORK, "rule-vectors.mts");
  const url = (rel) => new URL(`file:///${path.join(REPO, rel).replace(/\\/g, "/")}`).href;
  fs.writeFileSync(runner, `import * as person from ${JSON.stringify(url("supabase/functions/_shared/validation/person.ts"))};
import * as staff from ${JSON.stringify(url("supabase/functions/_shared/validation/staff-onboarding.ts"))};
const v = ${JSON.stringify(RULE_VECTORS)};
const today = new Date(v.today + "T00:00:00Z"), leap = new Date(v.leapToday + "T00:00:00Z");
const first = (p) => { const order = ["accountName", "bsb", "accountNumber"].find((k) => p[k]); return order ? p[order] : ""; };
const out = [
  ...v.phones.map((x) => person.phoneProblem(x, "MISSING")),
  ...v.names.map((x) => person.nameProblem(x, "first name")),
  ...v.dobs.map((x) => person.dateOfBirthProblem(x, today)),
  ...v.leapDobs.map((x) => person.dateOfBirthProblem(x, leap)),
  ...v.banks.map(([a, b, c]) => first(person.bankProblems({ accountName: a, bsb: b, accountNumber: c }))),
  ...v.staff.map((c) => { const p = staff.staffProblems(c.details, c.keys, c.final, today)[0]; return p ? p.field + "|" + p.message : "ok"; }),
  person.maskBsb("062-000"), person.maskAccountNumber("7700112233"), person.maskAccountNumber("555666"),
];
console.log(JSON.stringify(out));
`);
  const res = run("npx", ["jiti", runner]);
  if (res.code !== 0) throw new Error(`the rule runner failed:\n${res.out}`);
  return JSON.parse(res.out.trim().split(/\r?\n/).pop());
}

/** The same inputs through the database's copy of the rules (hr.v_*). */
function sqlAnswers() {
  const lit = (value) => `(${"'" + JSON.stringify(value).replace(/'/g, "''") + "'"}::jsonb #>> '{}')`;
  const v = RULE_VECTORS;
  const rows = [
    ...v.phones.map((x) => `select hr.v_phone_problem(${lit(x)}, 'MISSING')`),
    ...v.names.map((x) => `select hr.v_name_problem(${lit(x)}, 'first name')`),
    ...v.dobs.map((x) => `select hr.v_dob_problem(${lit(x)}, date '${v.today}')`),
    ...v.leapDobs.map((x) => `select hr.v_dob_problem(${lit(x)}, date '${v.leapToday}')`),
    ...v.banks.map(([a, b, c]) => `select hr.v_bank_problem(${lit(a)}, ${lit(b)}, ${lit(c)})`),
    ...v.staff.map((c) => `select coalesce((r->>'field') || '|' || (r->>'message'), 'ok') from (select hr.v_staff_problem('${JSON.stringify(c.details).replace(/'/g, "''")}'::jsonb, array[${c.keys.map((k) => `'${k}'`).join(",")}]::text[], ${c.final}, date '${v.today}') as r) x`),
  ];
  // One row per input, numbered, so an empty answer ("") keeps its line.
  const out = psql(rows.map((q, i) => `select ${i} || E'\\t' || (${q.replace(/^select /, "select ")});`.replace(/\(select /, "(select ")).join("\n"));
  const answers = out.split(/\r?\n/).map((line) => line.slice(line.indexOf("\t") + 1));
  return answers;
}

async function wizard() {
  const lab = readLab();
  await ensureLabAdmin();
  const jwt = await adminToken(lab);

  // 1. One list of inputs, two implementations, the same answers.
  const ts = tsAnswers();
  const masks = ts.splice(-3);
  const sql = sqlAnswers();
  const labels = [...RULE_VECTORS.phones.map((x) => `phone ${JSON.stringify(x)}`), ...RULE_VECTORS.names.map((x) => `name ${JSON.stringify(x.slice(0, 20))}`), ...RULE_VECTORS.dobs.map((x) => `date of birth ${JSON.stringify(x)}`),
    ...RULE_VECTORS.leapDobs.map((x) => `date of birth ${x} on 29 Feb`), ...RULE_VECTORS.banks.map((x) => `bank ${JSON.stringify(x.map((y) => y.slice(0, 12)))}`),
    ...RULE_VECTORS.staff.map((c) => `${c.final ? "final" : "draft"} [${c.keys.length > 3 ? "all fields" : c.keys.join(",")}] ${c.keys.length > 3 ? "" : JSON.stringify(c.keys.map((k) => String(c.details[k]).slice(0, 14)))}`)];
  const differ = labels.map((label, i) => ({ label, ts: ts[i], sql: sql[i] })).filter((r) => r.ts !== r.sql);
  check(`the shared rules answer the same in the browser module and in the database (${labels.length} inputs: phones, names, dates of birth, bank details, wizard fields)`, ts.length === labels.length && sql.length === labels.length && differ.length === 0,
    differ.slice(0, 6).map((r) => `${r.label}: module "${r.ts}" / database "${r.sql}"`).join(" ;; ") || `${ts.length}/${sql.length}/${labels.length}`);
  check(`...and both sides refuse and accept: ${ts.filter((a) => a === "" || a === "ok").length} valid, ${ts.filter((a) => a !== "" && a !== "ok").length} with a message`, ts.some((a) => a === "") && ts.some((a) => a.length > 3));

  // 2. Bank details that were saved in plain text before the migration are encrypted, and read back unchanged.
  check("the migration encrypted the bank details that were already there, and emptied the plain columns",
    psql(`select (b.account_name is null and b.bsb is null and b.account_number is null)::text || '/' || hr.bank_decrypt(b.account_name_enc) || '/' || hr.bank_decrypt(b.bsb_enc) || '/' || hr.bank_decrypt(b.account_number_enc)
      from hr.employee_bank b join hr.staff_profiles p on p.id = b.profile_id where p.email = 'lab.jobapplied@example.test';`) === "true/Lab JobApplied/033000/987654321");
  check("the key is in the Vault, not in a table or a setting", psql("select count(*) from vault.secrets where name = 'hr_bank_details_key';") === "1"
    && psql("select count(*) from pg_settings where name ilike '%bank%';") === "0");

  // 3. Upload first, then the reading fills the details.
  const person = await freshApplicant(lab, "wizard");
  const link = await newLink();
  asAdmin(`select public.hr_admin_staff_invite('${person.id}', 'documents', '${link.hash}');`);
  const pdf = (name) => ({ blob: new Blob([labPdf(name)], { type: "application/pdf" }), name });
  const untyped = await onboardCall(lab, { action: "upload", t: link.token, category: "Passport", expiryDate: "" }, { blob: new Blob([PDF]), name: "passport.pdf" });
  check("a file with no declared type is refused with the student wizard's message", untyped.status === 400 && untyped.body.error === "Only PDF, JPG, and PNG documents are supported.", JSON.stringify(untyped.body));
  const wrongContent = await onboardCall(lab, { action: "upload", t: link.token, category: "Passport", expiryDate: "" }, { blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "application/pdf" }), name: "passport.pdf" });
  check("a file whose content is not what it says is refused with the student wizard's message", wrongContent.status === 400 && wrongContent.body.error === "The selected file does not match its declared document type.", JSON.stringify(wrongContent.body));
  await onboardCall(lab, { action: "save", t: link.token, patch: { is_australian_citizen: false } });
  // The passport comes first, and every other document must belong to the passport holder (PR #29): the employee gets a clear message.
  const beforePassport = await onboardCall(lab, { action: "upload", t: link.token, category: "Visa", expiryDate: "" }, pdf("Visa.pdf"));
  check("staff wizard: a visa before the passport is refused and the employee is told to upload the passport first", beforePassport.status === 422 && beforePassport.body.error === "Upload the passport identity page before uploading other documents." && beforePassport.body.field === "file", JSON.stringify(beforePassport.body));
  for (const category of ["Passport", "Visa", "English", "Academic", "Health Insurance"]) {
    const r = await onboardCall(lab, { action: "upload", t: link.token, category, expiryDate: "" }, pdf(`${category}.pdf`));
    if (r.status !== 200) check(`upload ${category} without an expiry date`, false, JSON.stringify(r.body));
  }
  const otherHolder = { blob: new Blob([new TextEncoder().encode("%PDF-1.4\n%lab-category:Academic\n%lab-holder:Someone Else\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")], { type: "application/pdf" }), name: "Academic-other.pdf" };
  const mismatch = await onboardCall(lab, { action: "upload", t: link.token, category: "Academic", expiryDate: "" }, otherHolder);
  check("staff wizard: a document in someone else's name is refused with the passport-holder message and nothing is stored", mismatch.status === 422 && /passport's first name wasn't found/.test(mismatch.body.error ?? "")
    && psql(`select count(*) from hr.staff_documents where profile_id = '${person.id}' and category = 'Academic';`) === "1", JSON.stringify(mismatch.body));
  check("staff wizard: the accepted documents carry the passport they were matched against", psql(`select count(*) from hr.document_category_receipts r join storage.objects o on o.id = r.object_id where o.name like '${person.id}/%' and r.category <> 'Passport' and r.passport_document_id is not null;`) === "4");
  const docId = (category) => psql(`select id from hr.staff_documents where profile_id = '${person.id}' and category = '${category}' and is_current;`);
  const read = [await readingDone(docId("Passport")), await readingDone(docId("Visa"))];
  const view = (await onboardCall(lab, { action: "open", t: link.token })).body.view;
  const doc = (category) => view.documents.find((d) => d.category === category);
  check("five documents upload without a single date typed, and the passport and visa are read", view.documents.length === 5 && read.join() === "done,done", read.join());
  check("the reading fills date of birth, nationality, passport number and visa subclass; the applied name is kept", view.profile.date_of_birth === MOCK_PASSPORT.dob && view.profile.nationality === MOCK_PASSPORT.nationality
    && view.profile.passport_number === MOCK_PASSPORT.passport_number && view.profile.visa_subclass === MOCK_VISA.visa_subclass && view.profile.first_name === "Lab",
    JSON.stringify({ dob: view.profile.date_of_birth, nat: view.profile.nationality, pp: view.profile.passport_number, visa: view.profile.visa_subclass, first: view.profile.first_name }));
  check("...and the passport and visa expiry dates; the page is given what was read (for the 'from your passport' notes and the name check)", doc("Passport").expiryDate === MOCK_PASSPORT.passport_expiry
    && doc("Visa").expiryDate === MOCK_VISA.visa_stay_until && doc("Passport").extracted.first_name === "PASSPORT" && doc("Health Insurance").expiryDate === null, JSON.stringify([doc("Passport").expiryDate, doc("Visa").expiryDate]));

  // 4. What the documents could not give: checked on the field, saved normalised.
  const early = await onboardCall(lab, { action: "submit", t: link.token });
  check("submit before the details are complete names the first missing one", early.status === 400 && early.body.error === "Enter the street address.", JSON.stringify(early.body));
  const state = await onboardCall(lab, { action: "save", t: link.token, patch: { address_country: "Australia", address_state: "Punjab" } });
  check("an Australian address refuses a state that is not Australian, on its field", state.status === 400 && state.body.field === "address_state" && state.body.error === "Choose the state or territory.", JSON.stringify(state.body));
  const taken = await onboardCall(lab, { action: "save", t: link.token, patch: { phone: psql("select phone_e164 from hr.staff_profiles where email = 'lab.jobapplied@example.test';") } });
  check("the mobile cannot be changed to another person's number (neutral message)", taken.status === 400 && taken.body.error === "This number can't be used. Sign in or contact the administrator.", JSON.stringify(taken.body));
  const mobile = `+6148${String(Date.now()).slice(-7)}`;
  const saved = await onboardCall(lab, { action: "save", t: link.token, patch: { phone: mobile, address_street: " 9 Wizard Way ", address_suburb: "Carlton", address_country: "Australia", address_state: "vic", address_postcode: "3053",
    emergency_name: "Em Contact", emergency_phone: "+61 422 333 444", emergency_relationship: "Sibling" } });
  check("the remaining details save: mobile corrected, state in capitals, text trimmed", saved.status === 200 && saved.body.view?.profile?.phone_e164 === mobile && saved.body.view?.profile?.address_state === "VIC"
    && saved.body.view?.profile?.address_street === "9 Wizard Way" && saved.body.view?.profile?.emergency_phone_e164 === "+61422333444", JSON.stringify(saved.body).slice(0, 200));
  // Tax and super (option A): the declaration answers and the super choice through the link; the ABN check digits; no tax file number anywhere.
  const noTax = await onboardCall(lab, { action: "submit", t: link.token });
  check("submit is refused until the tax and super answers are in", noTax.status === 400 && noTax.body.error === "Tell us your residency status for tax purposes.", JSON.stringify(noTax.body));
  const badAbn = await onboardCall(lab, { action: "save", t: link.token, patch: { super_choice: "own", super_fund_abn: "51824753557" } });
  check("a fund ABN with wrong check digits is refused on its field, with the agency form's message", badAbn.status === 400 && badAbn.body.field === "super_fund_abn" && badAbn.body.error === "Enter a valid ABN; its check digits do not match.", JSON.stringify(badAbn.body));
  const tax = await onboardCall(lab, { action: "save", t: link.token, patch: { tax_residency: "resident", tax_free_threshold: "yes", study_loan: "no", super_choice: "own", super_fund_name: " Lab Super ", super_fund_abn: "51 824 753 556", super_usi: "lab0100au", super_member_number: "123456" } });
  check("the answers save normalised (ABN digits only, USI in capitals, text trimmed) and come back to the page", tax.status === 200 && tax.body.view?.profile?.super_fund_abn === "51824753556" && tax.body.view?.profile?.super_usi === "LAB0100AU"
    && tax.body.view?.profile?.super_fund_name === "Lab Super" && tax.body.view?.profile?.tax_residency === "resident", JSON.stringify(tax.body).slice(0, 300));
  check("no column in the hr schema holds a tax file number, and none is asked for", psql("select count(*) from information_schema.columns where table_schema = 'hr' and (column_name ilike '%tfn%' or column_name ilike '%tax_file%');") === "0");
  // Address search: the student form's Geoscape lookup, reached with the private link instead of a login.
  const QUERY = "77 Wizardtest Rd";
  const found = await onboardCall(lab, { action: "address_search", t: link.token, q: QUERY });
  check("the address search answers through the private link, in the student form's shape", found.status === 200 && found.body.ok === true
    && JSON.stringify(found.body.suggestions?.[0]) === JSON.stringify({ line: "12 Smith St", line2: "", suburb: "Melbourne", state: "VIC", postcode: "3000", country: "Australia" })
    && found.body.suggestions?.[1]?.line2 === "Unit 3", JSON.stringify(found.body).slice(0, 300));
  check("...the lookup was made on the server with the function's key (the browser never sees it)", geoscape.queries.includes(QUERY) && !JSON.stringify(found.body).includes(LAB_SECRETS.EF_ADDRESS_SEARCH_GEOSCAPE_KEY));
  const before = geoscape.calls;
  const short = await onboardCall(lab, { action: "address_search", t: link.token, q: "12 " });
  check("fewer than four characters makes no lookup", short.status === 200 && short.body.suggestions?.length === 0 && geoscape.calls === before);
  const none = await onboardCall(lab, { action: "address_search", t: link.token, q: "1 Nowhere St" });
  check("no match is an empty list", none.status === 200 && none.body.ok === true && none.body.suggestions?.length === 0);
  const outage = await onboardCall(lab, { action: "address_search", t: link.token, q: "1 Outage St" });
  check("a provider fault answers 'unavailable' (the page falls back to typing), with no detail", outage.status === 503 && outage.body.unavailable === true && Object.keys(outage.body).sort().join() === "ok,unavailable", JSON.stringify(outage.body));
  const guess = await onboardCall(lab, { action: "address_search", t: (await newLink()).token, q: QUERY }, null, "203.0.113.78");
  const noToken = await onboardCall(lab, { action: "address_search", q: QUERY }, null, "203.0.113.79");
  check("without this person's link there is no search (403), and no lookup is made", guess.status === 403 && noToken.status === 403 && geoscape.queries.filter((q) => q === QUERY).length === 1, `${guess.status} ${noToken.status}`);
  const noDate = await onboardCall(lab, { action: "submit", t: link.token });
  check("submit asks for the one date the reader does not give (health insurance)", noDate.status === 400 && noDate.body.error === "Enter a current expiry date for your health insurance.", JSON.stringify(noDate.body));
  const dated = await onboardCall(lab, { action: "expiry", t: link.token, id: docId("Health Insurance"), expiryDate: `${new Date().getFullYear() + 1}-06-30` });
  check("the health insurance date is typed", dated.status === 200);

  // 5. Bank details: through the link, masked on the way back, encrypted at rest.
  const ACCOUNT = "7700998877";
  const noBank = await onboardCall(lab, { action: "submit", t: link.token });
  check("submit is refused until the bank details are in", noBank.status === 400 && noBank.body.error === "Enter your bank details.", JSON.stringify(noBank.body));
  const bank = await onboardCall(lab, { action: "bank_save", t: link.token, bank: { accountName: "Lab Wizard", bsb: "062-000", accountNumber: "7700 998 877", bankName: "Commonwealth Bank" } });
  check("the person saves their bank details; the answer shows BSB 06•••• and account •••• 8877", bank.status === 200 && bank.body.view?.bank?.bsb === masks[0] && bank.body.view?.bank?.accountNumber === "•••• 8877"
    && !JSON.stringify(bank.body).includes(ACCOUNT), JSON.stringify(bank.body.view?.bank ?? bank.body));
  check("the browser's masks are the database's", masks.join() === "06••••,•••• 2233,•••• 66" && psql(`select left('062000', 2) || '••••'`) === masks[0], masks.join());
  check("at rest: no plain text, the bytes do not contain the number, and they decrypt to it", psql(`select (account_number is null and bsb is null and account_name is null)::text || '/' || (position('${ACCOUNT}' in encode(account_number_enc, 'escape')) = 0)::text || '/' || hr.bank_decrypt(account_number_enc)
    from hr.employee_bank where profile_id = '${person.id}';`) === `true/true/${ACCOUNT}`);
  const submitted = await onboardCall(lab, { action: "submit", t: link.token });
  check("everything complete: submit succeeds and the link turns read-only", submitted.status === 200 && submitted.body.view?.readOnly === true && psql(`select status from hr.staff_profiles where id = '${person.id}';`) === "documents_submitted", JSON.stringify(submitted.body).slice(0, 200));
  const afterSearch = await onboardCall(lab, { action: "address_search", t: link.token, q: "77 Wizardtest Rd" });
  check("after submit the link no longer searches addresses", afterSearch.status === 400 && geoscape.queries.filter((q) => q === "77 Wizardtest Rd").length === 1, JSON.stringify(afterSearch.body));
  const afterBank = await onboardCall(lab, { action: "bank_save", t: link.token, bank: { accountName: "Lab Wizard", bsb: "062000", accountNumber: "11112222" } });
  check("the bank details cannot be changed through the link after submit", afterBank.status === 400 && psql(`select hr.bank_decrypt(account_number_enc) from hr.employee_bank where profile_id = '${person.id}';`) === ACCOUNT, JSON.stringify(afterBank.body));
  const stranger = await newLink();
  check("another link (not this person's) reaches nothing", (await onboardCall(lab, { action: "bank_save", t: stranger.token, bank: { accountName: "X", bsb: "062000", accountNumber: "11112222" } }, null, "203.0.113.77")).status === 403);

  // 6. Administrators: masked, an audited Reveal, ticks; an Editor and a visitor get nothing.
  const masked = await restRpc(lab, jwt, "hr_admin_emp_bank_get", { p_id: person.id });
  check("an Admin sees the bank details masked", masked.status === 200 && masked.body?.bsb === "06••••" && masked.body?.accountNumber === "•••• 8877" && masked.body?.masked === true && !JSON.stringify(masked.body).includes(ACCOUNT), JSON.stringify(masked.body));
  const revealsBefore = psql(`select count(*) from hr.staff_audit where profile_id = '${person.id}' and action = 'bank_revealed';`);
  const revealed = await restRpc(lab, jwt, "hr_admin_emp_bank_reveal", { p_id: person.id });
  check("Reveal shows them in full to an Admin", revealed.status === 200 && revealed.body?.bsb === "062000" && revealed.body?.accountNumber === ACCOUNT, JSON.stringify(revealed.body).replace(ACCOUNT, "<number>"));
  check("...and is written to the history with the Admin and the time, never the number", revealsBefore === "0"
    && psql(`select count(*) || '/' || min(actor_kind) || '/' || min(actor_id::text) || '/' || min(detail::text) from hr.staff_audit where profile_id = '${person.id}' and action = 'bank_revealed';`) === `1/admin/${LAB_ADMIN.id}/{}`);
  const timeline = await restRpc(lab, jwt, "hr_admin_onboarding", { p_id: person.id });
  check("the reveal and the applicant's save show in the person's history", (timeline.body?.timeline ?? []).some((e) => e.action === "bank_revealed" && e.actorName) && (timeline.body?.timeline ?? []).some((e) => e.action === "bank_saved"),
    JSON.stringify((timeline.body?.timeline ?? []).filter((e) => String(e.action).startsWith("bank"))));
  const editorJwt = await editorToken(lab);
  const refusals = [];
  for (const [name, args] of [["hr_admin_emp_bank_get", { p_id: person.id }], ["hr_admin_emp_bank_reveal", { p_id: person.id }], ["hr_admin_emp_bank_save", { p_id: person.id, p_bank: { accountName: "X", bsb: "062000", accountNumber: "1234" } }],
    ["hr_admin_onboarding_extras", { p_id: person.id }], ["hr_admin_onboarding_check", { p_id: person.id, p_section: "bank", p_verified: true }]]) {
    const r = await restRpc(lab, editorJwt, name, args);
    refusals.push(`${r.status}:${r.body?.code ?? ""}`);
    if (JSON.stringify(r.body ?? "").includes(ACCOUNT)) refusals.push("LEAK");
  }
  check("an Editor is refused every bank and verification call (403, 42501)", refusals.every((r) => r === "403:42501"), refusals.join(" "));
  const visitor = await restRpc(lab, lab.anonKey, "hr_admin_emp_bank_reveal", { p_id: person.id });
  const linkFn = await restRpc(lab, jwt, "hr_svc_onboarding_bank_save", { p_token_hash: link.hash, p_bank: {} });
  const table = await fetch(`${lab.apiUrl}/rest/v1/employee_bank?select=*`, { headers: { apikey: lab.anonKey, Authorization: `Bearer ${editorJwt}`, "accept-profile": "hr" } });
  check("a visitor cannot reveal, a signed-in user cannot call the link function, and the table is not served", visitor.status >= 401 && visitor.status <= 403 && linkFn.status >= 401 && linkFn.status <= 404 && table.status >= 400,
    `${visitor.status} ${linkFn.status} ${table.status}`);
  check("an Editor's attempts left no reveal in the history", psql(`select count(*) from hr.staff_audit where profile_id = '${person.id}' and action = 'bank_revealed';`) === "1");
  const ticked = await restRpc(lab, jwt, "hr_admin_onboarding_check", { p_id: person.id, p_section: "bank", p_verified: true });
  const tickedPassport = await restRpc(lab, jwt, "hr_admin_onboarding_check", { p_id: person.id, p_section: "passport", p_verified: true });
  check("an Admin ticks the bank details and the passport as verified (who and when recorded)", ticked.status === 200 && ticked.body?.checks?.bank?.verifiedByName === "Lab Admin" && Boolean(tickedPassport.body?.checks?.passport?.verifiedAt), JSON.stringify(tickedPassport.body?.checks ?? tickedPassport.body));
  const tickedTax = await restRpc(lab, jwt, "hr_admin_onboarding_check", { p_id: person.id, p_section: "tax", p_verified: true });
  check("...and Tax and super; the Admin's page gets the answers with the profile", tickedTax.status === 200 && Boolean(tickedTax.body?.checks?.tax?.verifiedAt) && psql(`select super_fund_abn from hr.staff_profiles where id = '${person.id}';`) === "51824753556", JSON.stringify(tickedTax.body?.checks ?? tickedTax.body));
  const changed = await restRpc(lab, jwt, "hr_admin_emp_bank_save", { p_id: person.id, p_bank: { accountName: "Lab Wizard", bsb: "733-000", accountNumber: "555666" } });
  const extras = await restRpc(lab, jwt, "hr_admin_onboarding_extras", { p_id: person.id });
  check("an Admin changes the bank details: masked answer (two digits of a short number), and the bank tick is cleared", changed.status === 200 && changed.body?.accountNumber === masks[2] && !extras.body?.checks?.bank && Boolean(extras.body?.checks?.passport), JSON.stringify([changed.body, extras.body?.checks]));
  const detail = await restRpc(lab, jwt, "hr_admin_staff_detail", { p_id: person.id });
  check("the Admin's page gets what was read from each document, and never the bank numbers", (detail.body?.documents ?? []).find((d) => d.category === "Passport")?.extracted?.passport_number === MOCK_PASSPORT.passport_number
    && detail.body?.profile?.passport_number === MOCK_PASSPORT.passport_number && !JSON.stringify(detail.body).includes(ACCOUNT) && !JSON.stringify(timeline.body).includes(ACCOUNT));

  // 7. Review and the next stage still work: approving every document moves the stepper on.
  asAdmin(`select public.hr_admin_staff_document_review(d.id, 'approved') from hr.staff_documents d where d.profile_id = '${person.id}' and d.is_current;`);
  const stage = await restRpc(lab, jwt, "hr_admin_onboarding", { p_id: person.id });
  const summary = psql(`select (hr.staff_doc_summary('${person.id}')->>'approved') || '/' || (hr.staff_doc_summary('${person.id}')->>'required');`);
  check("Documents approved 5/5 and the stage moves to Documents approved, as before", summary === "5/5" && stage.body?.stage === "documents_approved", `${summary} ${stage.body?.stage}`);

  // 8. Nothing sensitive in the function logs, the database log, the email outbox or the mock mail server.
  await new Promise((r) => setTimeout(r, 1500));
  const logs = ["supabase_edge_runtime_skyline-staff-lab", DB_CONTAINER, "supabase_rest_skyline-staff-lab", "supabase_kong_skyline-staff-lab"].map((c) => {
    const res = spawnSync("docker", ["logs", "--since", "30m", c], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const text = `${res.stdout}${res.stderr}`;
    return `${c.replace("supabase_", "").replace("_skyline-staff-lab", "")}:${[ACCOUNT, "7700 998 877", "555666", "Wizardtest"].filter((n) => text.includes(n)).length}:${text.length > 0 ? "read" : "empty"}`;
  });
  check("the bank numbers and the address searches are in no log (edge functions, database, API, gateway)", logs.every((l) => l.split(":")[1] === "0"), logs.join(" "));
  check("...and in no queued or sent email", psql(`select count(*) from hr.staff_emails where payload::text like '%${ACCOUNT}%' or payload::text like '%555666%';`) === "0" && !JSON.stringify(postmark.messages).includes(ACCOUNT));
  check("...and in no address: the page calls carry the link token and the bank details in the request body only", !/[?&](t|bsb|account)/i.test(`${lab.apiUrl}/functions/v1/staff-onboarding`));
}

/* ------------------------------------------------------------------ Documents & Signatures (SIGN-02) */
async function signCall(lab, bearer, body, file, headers = {}) {
  let payload = JSON.stringify(body); const h = { apikey: lab.anonKey, Authorization: `Bearer ${bearer}`, ...(process.env.LAB_SIGNING_FUNCTION_URL ? { "x-forwarded-for": "203.0.113.10" } : {}), ...headers };
  if (file) { payload = new FormData(); payload.set("data", JSON.stringify(body)); payload.set("file", new Blob([file], { type: "application/pdf" }), "document.pdf"); } else h["content-type"] = "application/json";
  // LAB_SIGNING_FUNCTION_URL: the function served by a host Deno against this stack, when the stack's edge runtime cannot load its imports.
  const res = await fetch(process.env.LAB_SIGNING_FUNCTION_URL || `${lab.apiUrl}/functions/v1/document-signing`, { method: "POST", headers: h, body: payload });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const signRpc = async (lab, bearer, action, id = null, data = {}) => restRpc(lab, bearer, "signing_admin", { p_action: action, p_id: id, p_data: data });
/** A small transparent PNG with a stroke, like the page makes from a drawn signature. */
function signaturePng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const w = 120, h = 40, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.abs(y - (20 + Math.round(10 * Math.sin(x / 9)))) < 2) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = 10; raw[o + 1] = 20; raw[o + 2] = 90; raw[o + 3] = 255; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
/** The words on each page of a PDF with where they sit (pdf.js), to prove a field was printed where it was placed. */
async function pdfWords(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 }).promise; const pages = [];
  for (let i = 1; i <= doc.numPages; i++) { const page = await doc.getPage(i); const view = page.getViewport({ scale: 1 }); const text = await page.getTextContent();
    pages.push({ width: view.width, height: view.height, items: text.items.map((t) => ({ text: t.str, x: t.transform[4], y: t.transform[5] })) }); }
  return pages;
}
const sha256 = (bytes) => nodeCrypto.createHash("sha256").update(bytes).digest("hex");
/** Inside the local Edge runtime SUPABASE_URL is http://kong:8000 (reachable only by the containers); hosted signs public URLs. */
async function signedFile(url) { const res = await fetch(String(url).replace("http://kong:8000", readLab().apiUrl)); return res.ok ? new Uint8Array(await res.arrayBuffer()) : null; }

async function signing() {
  const lab = readLab();
  await ensureLabAdmin();
  await startMockPostmark();
  const run = nodeCrypto.randomBytes(3).toString("hex"), mail = (name) => `sign.${name}.${run}@example.test`;
  const CONSENT = "I have read this document and agree to its contents. I consent to sign it electronically and adopt the signature I provide here as my electronic signature.";
  const state = (id) => psql(`select state from hr.sign_requests where id = '${id}';`);
  const recState = (id) => psql(`select string_agg(state, ',' order by signing_order, id) from hr.sign_recipients where request_id = '${id}';`);
  const linkOf = (address, kind = /^Please sign|^Reminder to sign/) => tokenIn([...mailsTo(address)].reverse().find((m) => kind.test(m.subject))?.text);
  const waitMail = async (address, subject, count = 1) => { for (let i = 0; i < 40; i++) { if (mailsTo(address).filter((m) => subject.test(m.subject)).length >= count) break; await new Promise((r) => setTimeout(r, 250)); } return mailsTo(address).filter((m) => subject.test(m.subject)).length; };
  // Like the signing page (signWithRetry): a worker stopped by the runtime's CPU limit (WORKER_LIMIT) is asked again, up to twice.
  let workerRetries = 0;
  const sign = async (token, hash, extra = {}) => {
    for (let attempt = 0; ; attempt++) {
      const res = await signCall(lab, lab.anonKey, { action: "sign", token, name: "Lab Signer", agreed: true, signatureKind: "typed", documentHash: hash, ...extra });
      if (attempt >= 2 || !(res.status === 546 || res.body?.code === "WORKER_LIMIT")) return res;
      workerRetries++; await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  };
  const open = (token) => signCall(lab, lab.anonKey, { action: "open", token });
  try {
    const jwt = await adminToken(lab);
    const pdf3 = await realPdf(3);

    // ---- related records (student, employee, agent). The tables differ between this lab and a bare database, so each is best effort.
    const seed = (label, sql) => { try { return psql(sql).split("\n").pop(); } catch (e) { console.log(`SKIP seed ${label}: ${String(e.message).split("\n")[0].slice(0, 160)}`); return null; } };
    const employeeId = seed("employee", `with p as (insert into hr.staff_profiles(first_name, last_name, email, phone_e164, address_street, address_suburb, address_state, address_postcode)
      values ('Signe', 'Employee', '${mail("employee")}', '+6149${String(parseInt(run, 16)).padStart(8, "0").slice(0, 8)}', '1 Lab Street', 'Melbourne', 'VIC', '3000') returning id),
      e as (insert into hr.employment(profile_id, job_title, department) select id, 'Lab Trainer', 'Training' from p returning profile_id) select profile_id from e;`);
    const agencyId = seed("agency", `with a as (insert into public.agencies(name, code) values ('Sign Lab Agency ${run}', 'SIGN${run.toUpperCase()}') returning id) select id from a;`) ?? seed("agency (existing)", "select id from public.agencies order by created_at limit 1;");
    const agentId = agencyId && seed("agent", `with g as (insert into public.agents(business_id, full_name, email) values ('${agencyId}', 'Agnes Agent', '${mail("agent")}') returning id) select id from g;`);
    const studentId = agencyId && seed("student", `with s as (insert into public.enrollment_students(agency_id, full_name, email, details) values ('${agencyId}', 'Stu Dent', '${mail("student")}',
      '{"first_name":"Stu","last_name":"Dent","au_street":"9 Campus Road","au_suburb":"Carlton","au_state":"VIC","au_postcode":"3053"}') returning id) select id from s;`);
    if (studentId) seed("student course", `insert into public.cms_courses(id, slug, code, name, fees) values ('lab-sign-${run}', 'lab-sign-${run}', 'LAB${run}', 'Certificate IV in Lab Signing', 'AUD 12,000') on conflict do nothing;
      with ap as (insert into public.enrollment_applications(student_id, agency_id) values ('${studentId}', '${agencyId}') returning id)
      insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title) select id, 'lab-sign-${run}', 'LAB${run}', 'Certificate IV in Lab Signing' from ap; select 1;`);

    // ---- 11. unauthorized access
    const anonRpc = await restRpc(lab, lab.anonKey, "signing_admin", { p_action: "list" });
    check("unauthorized: the admin RPC refuses a visitor", anonRpc.status >= 400, JSON.stringify(anonRpc.body).slice(0, 120));
    const anonSvc = await restRpc(lab, lab.anonKey, "signing_service", { p_action: "tick" });
    check("unauthorized: the service RPC refuses a visitor", anonSvc.status >= 400);
    const adminSvc = await restRpc(lab, jwt, "signing_service", { p_action: "tick" });
    check("unauthorized: the service RPC refuses even an administrator's browser", adminSvc.status >= 400);
    const anonCreate = await signCall(lab, lab.anonKey, { action: "create", recipients: [{ name: "No Body", email: mail("nobody") }], title: "x" }, pdf3);
    check("unauthorized: a visitor cannot create a request through the function", anonCreate.status === 403, `${anonCreate.status} ${JSON.stringify(anonCreate.body)}`);
    let denied = false; try { psql("begin; set local role authenticated; select count(*) from hr.sign_requests; commit;"); } catch { denied = true; }
    check("unauthorized: the signing tables cannot be read from a browser role", denied);
    check("unauthorized: an unknown link is refused", (await open("a".repeat(64))).status === 403);

    // ---- templates: save, versions, duplicate, archive, delete, restore, PDF upload
    const tSave = await signRpc(lab, jwt, "template_save", null, { name: `Employment contract ${run}`, title: "Employment contract for {{employee.name}}",
      body: "Dear {{employee.first_name}},\n\nYou are offered the position of {{employee.position}} in {{employee.department}} on {{current_date}}.\n\nSalary: {{salary}}.", audience: "employee", category: "employment_contract",
      roles: [{ key: "employee", label: "Employee", order: 1, required: true }, { key: "hr", label: "HR Manager", order: 2, required: true }, { key: "director", label: "Director", order: 3, required: true }],
      fields: [{ type: "signature", role: "employee", page: 1, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }, { type: "date", role: "employee", page: 1, x: 0.45, y: 0.7, w: 0.2, h: 0.03 },
        { type: "text", role: "employee", page: 1, x: 0.1, y: 0.8, w: 0.4, h: 0.03, label: "Tax residency" }, { type: "checkbox", role: "employee", page: 1, x: 0.1, y: 0.85, w: 0.03, h: 0.02, label: "I agree" },
        { type: "signature", role: "hr", page: 1, x: 0.55, y: 0.78, w: 0.3, h: 0.06 }, { type: "initials", role: "director", page: 1, x: 0.8, y: 0.9, w: 0.1, h: 0.04 }],
      signing_mode: "sequential", expiry_days: 10, reminder_days: 2 });
    const tpl = tSave.body;
    check("template: created with roles, fields, expiry and reminder settings", tSave.status === 200 && tpl.version === 1 && tpl.roles?.length === 3 && tpl.fields?.length === 6 && tpl.expiry_days === 10, JSON.stringify(tSave.body).slice(0, 200));
    const tEdit = await signRpc(lab, jwt, "template_save", tpl.id, { ...tpl, name: `Employment contract ${run} v2` });
    const tVersions = await signRpc(lab, jwt, "template_versions", tpl.id);
    check("template: an edit makes version 2 and keeps version 1", tEdit.body.version === 2 && tVersions.body?.length === 2);
    const tRestore = await signRpc(lab, jwt, "template_restore", tpl.id, { version: 1 });
    check("template: restoring version 1 makes version 3 with the old name", tRestore.body.version === 3 && tRestore.body.name === `Employment contract ${run}`);
    const tBad = await signRpc(lab, jwt, "template_save", null, { name: "Bad", title: "Bad", body: "x", fields: [{ type: "signature", role: "ghost", page: 1, x: 0, y: 0, w: 0.1, h: 0.1 }] });
    check("template: a field for a signer that does not exist is refused", tBad.status >= 400);
    const tDup = await signCall(lab, jwt, { action: "template_duplicate", id: tpl.id });
    check("template: duplicate makes an independent copy", tDup.status === 200 && tDup.body.id !== tpl.id && /\(copy\)$/.test(tDup.body.name ?? ""), JSON.stringify(tDup.body).slice(0, 160));
    const tArch = await signRpc(lab, jwt, "template_archive", tDup.body.id);
    const archivedUse = await signCall(lab, jwt, { action: "create", templateId: tDup.body.id, recipients: [{ name: "Ann Archived", email: mail("arch"), role: "employee" }], values: {} });
    check("template: an archived template cannot start a request", tArch.body.status === "archived" && archivedUse.status === 400);
    await signRpc(lab, jwt, "template_delete", tDup.body.id);
    const listed = await signRpc(lab, jwt, "list");
    check("template: a deleted template leaves the list", !listed.body.templates.some((t) => t.id === tDup.body.id) && listed.body.templates.some((t) => t.id === tpl.id));
    const tPdf = await signCall(lab, jwt, { action: "template_upload", template: { name: `Consent form ${run}`, title: "Consent form", audience: "student", category: "consent_form",
      roles: [{ key: "student", label: "Student", order: 1, required: true }],
      fields: [{ type: "text", role: "sender", page: 2, x: 0.1, y: 0.2, w: 0.6, h: 0.03, value: "{{student.first_name}} {{student.last_name}} / {{course.name}}" }, { type: "signature", role: "student", page: 3, x: 0.1, y: 0.5, w: 0.3, h: 0.07 }] } }, pdf3);
    check("template: a PDF upload becomes a PDF template with its page count", tPdf.status === 200 && tPdf.body.kind === "pdf" && tPdf.body.source_pages === 3, JSON.stringify(tPdf.body).slice(0, 200));
    const notPdf = await signCall(lab, jwt, { action: "template_upload", template: { name: "Bad", title: "Bad" } }, new TextEncoder().encode("not a pdf"));
    check("template: a file that is not a PDF is refused", notPdf.status === 400);

    // ---- 4. dynamic variables
    if (employeeId) {
      const subj = await signRpc(lab, jwt, "subject_values", employeeId, { type: "employee" });
      check("variables: an employee's record fills name, position and address", subj.body?.values?.["employee.name"] === "Signe Employee" && subj.body.values["employee.position"] === "Lab Trainer" && /1 Lab Street, Melbourne, VIC, 3000/.test(subj.body.values["employee.address"]), JSON.stringify(subj.body).slice(0, 200));
      const preview = await signCall(lab, jwt, { action: "template_preview", id: tpl.id, subjectType: "employee", subjectId: employeeId });
      const words = preview.status === 200 ? (await pdfWords(Buffer.from(preview.body.pdfBase64, "base64"))).flatMap((p) => p.items.map((i) => i.text)).join(" ") : "";
      check("variables: the preview shows the record's values and marks what is still missing", /Dear Signe/.test(words) && /Lab Trainer/.test(words) && /\[salary\]/.test(words), words.slice(0, 200));
      const missing = await signCall(lab, jwt, { action: "create", templateId: tpl.id, subjectType: "employee", subjectId: employeeId, recipients: [{ name: "Signe Employee", email: mail("employee"), role: "employee" }], values: {} });
      check("variables: a request with a variable left empty is refused, naming it", missing.status === 400 && /salary/.test(missing.body.error ?? ""), JSON.stringify(missing.body));
      // The released compose form (20261113100000): recipientName / recipientEmail / profileId, preview, and an edited copy.
      const released = { templateId: tpl.id, profileId: employeeId, recipientName: "Signe Employee", recipientEmail: mail("employee"), values: { salary: "AUD 90,000" } };
      const pre = await signCall(lab, jwt, { action: "preview", ...released });
      check("released form: preview returns the filled text from the staff record", pre.status === 200 && /Dear Signe/.test(pre.body.text ?? "") && pre.body.edited === false && !!pre.body.pdfBase64, JSON.stringify(pre.body).slice(0, 200));
      const leftOver = await signCall(lab, jwt, { action: "preview", ...released, text: "Dear {{nobody}}" });
      check("released form: an edited copy with a variable left in it is refused", leftOver.status === 400 && /\{\{nobody\}\}/.test(leftOver.body.error ?? ""), JSON.stringify(leftOver.body));
      const editedCopy = await signCall(lab, jwt, { action: "create", ...released, text: `${pre.body.text}\n\nStart date to be confirmed.` });
      const row = editedCopy.status === 200 ? JSON.parse(psql(`select row_to_json(r) from (select edited, subject_type, subject_id, profile_id, rendered_text, template_text from hr.sign_requests where id = '${editedCopy.body.id}') r;`)) : {};
      check("released form: an edited copy keeps both texts and links the staff member as the employee", row.edited === true && row.subject_type === "employee" && row.subject_id === employeeId && row.profile_id === employeeId
        && /Start date to be confirmed/.test(row.rendered_text) && !/Start date/.test(row.template_text ?? "") && editedCopy.body.recipients?.length === 1, JSON.stringify(row).slice(0, 240));
      await signRpc(lab, jwt, "delete_draft", editedCopy.body.id);
    } else console.log("NOT RUN variables from an employee record (no employee could be seeded)");
    if (studentId) {
      const subj = await signRpc(lab, jwt, "subject_values", studentId, { type: "student" });
      check("variables: a student's record fills first name, last name, email and address", subj.body?.values?.["student.first_name"] === "Stu" && subj.body.values["student.last_name"] === "Dent" && subj.body.values["student.email"] === mail("student") && /9 Campus Road, Carlton/.test(subj.body.values["student.address"]), JSON.stringify(subj.body).slice(0, 240));
      if (subj.body?.values?.["course.name"]) check("variables: the student's course name and fees come from the course", subj.body.values["course.name"] === "Certificate IV in Lab Signing" && subj.body.values["course.fees"] === "AUD 12,000");
      else console.log("NOT RUN course variables (no application with a course could be seeded here)");
    } else console.log("NOT RUN variables from a student record (no student could be seeded)");

    // ---- 1. single signer, with placed fields, on an uploaded PDF
    const c1 = await signCall(lab, jwt, { action: "create", title: `Single signer ${run}`, recipients: [{ name: "Sam Single", email: mail("single") }], message: "Please sign by Friday.", ...(employeeId ? { subjectType: "employee", subjectId: employeeId } : {}) }, pdf3);
    check("single: a draft is made with a reference and one recipient", c1.status === 200 && c1.body.state === "draft" && /^SLIT-\d{4}-\d{6}$/.test(c1.body.reference ?? "") && c1.body.recipients?.length === 1, JSON.stringify(c1.body).slice(0, 200));
    const r1 = c1.body.recipients[0].id;
    const f1 = await signRpc(lab, jwt, "fields_save", c1.body.id, { fields: [{ recipient_id: r1, type: "signature", page: 3, x: 0.1, y: 0.6, w: 0.35, h: 0.08 }, { recipient_id: r1, type: "date", page: 3, x: 0.5, y: 0.6, w: 0.2, h: 0.03 },
      { recipient_id: r1, type: "name", page: 3, x: 0.1, y: 0.7, w: 0.3, h: 0.03 }, { recipient_id: r1, type: "text", page: 2, x: 0.2, y: 0.25, w: 0.5, h: 0.03, label: "Student number" },
      { recipient_id: r1, type: "checkbox", page: 2, x: 0.2, y: 0.3, w: 0.03, h: 0.02, label: "I agree" }] });
    check("single: fields are placed on the draft", f1.status === 200, JSON.stringify(f1.body).slice(0, 160));
    const foreign = await signRpc(lab, jwt, "fields_save", c1.body.id, { fields: [{ recipient_id: LAB_ADMIN.id, type: "signature", page: 1, x: 0.1, y: 0.1, w: 0.1, h: 0.1 }] });
    check("single: a field for someone who is not a recipient is refused", foreign.status >= 400);
    await signRpc(lab, jwt, "fields_save", c1.body.id, { fields: (await signRpc(lab, jwt, "detail", c1.body.id)).body.fields });
    const s1 = await signCall(lab, jwt, { action: "send", id: c1.body.id });
    check("single: sending invites the recipient", s1.status === 200 && s1.body.state === "sent" && s1.body.mail?.sent === 1, JSON.stringify(s1.body).slice(0, 200));
    const again = await signCall(lab, jwt, { action: "send", id: c1.body.id });
    check("idempotent: sending the same request twice is refused and sends nothing", again.status === 400 && (await waitMail(mail("single"), /Please sign/)) === 1);
    const t1 = linkOf(mail("single"));
    const inviteText = mailsTo(mail("single"))[0]?.text ?? "";
    check("email: the invitation carries the personal link, the sender's message and the reference", /^[a-f0-9]{64}$/.test(t1) && inviteText.includes("Please sign by Friday.") && inviteText.includes(c1.body.reference));
    const o1 = await open(t1);
    check("single: the link opens the document with only this person's fields", o1.status === 200 && o1.body.fields?.length === 5 && o1.body.recipient?.state === "viewed" && state(c1.body.id) === "viewed", JSON.stringify(o1.body).slice(0, 200));
    const shown = await signedFile(o1.body.url);
    check("single: the document is served by a short signed link and matches the recorded hash", !!shown && sha256(shown) === o1.body.documentHash);
    const textField = o1.body.fields.find((f) => f.type === "text"), boxField = o1.body.fields.find((f) => f.type === "checkbox");
    const noConsent = await signCall(lab, lab.anonKey, { action: "sign", token: t1, name: "Sam Single", agreed: false, documentHash: o1.body.documentHash });
    check("single: signing without the consent is refused", noConsent.status === 400);
    const incomplete = await sign(t1, o1.body.documentHash, { name: "Sam Single", values: {} });
    check("single: signing with a required field empty is refused", incomplete.status === 400 && /required field/.test(incomplete.body.error ?? ""), JSON.stringify(incomplete.body));
    const wrongDoc = await sign(t1, "f".repeat(64), { name: "Sam Single", values: { [textField.id]: "S1234567", [boxField.id]: "true" } });
    check("single: signing a document other than the one shown is refused", wrongDoc.status === 400 && state(c1.body.id) === "viewed");
    const done1 = await sign(t1, o1.body.documentHash, { name: "Sam Single", values: { [textField.id]: "S1234567", [boxField.id]: "true" } });
    check("single: the signature completes the request", done1.status === 200 && done1.body.complete === true && state(c1.body.id) === "signed", JSON.stringify(done1.body));
    const replay = await sign(t1, o1.body.documentHash, { name: "Sam Single", values: { [textField.id]: "S1234567", [boxField.id]: "true" } });
    check("idempotent: signing again is refused", replay.status === 400 && psql(`select count(*) from hr.sign_events where request_id = '${c1.body.id}' and event = 'signed';`) === "1");

    // ---- 10 + 5. the completed PDF: downloadable, hash recorded, fields printed where they were placed
    const after1 = await open(t1);
    const signed1 = await signedFile(after1.body.url), cert1 = after1.body.certificateUrl ? await signedFile(after1.body.certificateUrl) : null;
    const row1 = JSON.parse(psql(`select row_to_json(r) from (select signed_hash, certificate_hash, original_hash from hr.sign_requests where id = '${c1.body.id}') r;`));
    check("completed: the signer can download the signed PDF and it matches the recorded hash", !!signed1 && sha256(signed1) === row1.signed_hash && row1.signed_hash !== row1.original_hash);
    check("completed: the completion certificate is downloadable and matches its recorded hash", !!cert1 && sha256(cert1) === row1.certificate_hash);
    if (signed1) {
      const pages = await pdfWords(signed1);
      const find = (pageNo, text) => pages[pageNo - 1]?.items.find((i) => i.text.includes(text));
      const near = (item, page, fx, fy, fh) => item && Math.abs(item.x - fx * page.width) < 6 && item.y > page.height * (1 - fy - fh) - 2 && item.y < page.height * (1 - fy) + 2;
      check("placement: the PDF keeps its three pages (every signature had a place)", pages.length === 3);
      check("placement: the text answer is printed on page 2 inside its box", near(find(2, "S1234567"), pages[1], 0.2, 0.25, 0.03), JSON.stringify(find(2, "S1234567")));
      check("placement: the typed signature is printed on page 3 inside its box", near(find(3, "Sam Single"), pages[2], 0.1, 0.6, 0.08), JSON.stringify(find(3, "Sam Single")));
      check("placement: the signing date and the signer's name are printed on page 3 in their boxes", near(pages[2].items.find((i) => /^\d\d\/\d\d\/\d{4}$/.test(i.text.trim())), pages[2], 0.5, 0.6, 0.03) && pages[2].items.filter((i) => i.text.includes("Sam Single")).some((i) => near(i, pages[2], 0.1, 0.7, 0.03)));
    }
    if (cert1) { const words = (await pdfWords(cert1)).flatMap((p) => p.items.map((i) => i.text)).join(" "), tight = words.replace(/\s+/g, "");
      check("completed: the certificate names the signer, both hashes and the history", words.includes("Sam Single") && tight.includes(row1.original_hash) && tight.includes(row1.signed_hash) && /Signed by/.test(words) && words.includes(c1.body.reference), words.slice(0, 160)); }
    const copies = await waitMail(mail("single"), /Signed copy/), adminCopies = await waitMail(LAB_ADMIN.email, /Completed:/);
    const copy = mailsTo(mail("single")).find((m) => /Signed copy/.test(m.subject));
    check("email: the signer and the sender each get one completion email with the signed PDF and the certificate", copies === 1 && adminCopies === 1 && copy?.attachments?.length === 2 && sha256(Buffer.from(copy.attachments[0].Content, "base64")) === row1.signed_hash, `${copies} ${adminCopies} ${copy?.attachments?.length}`);
    const verify1 = await signCall(lab, jwt, { action: "verify", id: c1.body.id });
    check("audit: verification passes for an untouched request (history chain and three files)", verify1.status === 200 && verify1.body.ok === true && verify1.body.files?.length === 3, JSON.stringify(verify1.body));
    const adminUrl = await signCall(lab, jwt, { action: "admin_url", id: c1.body.id }), certUrl = await signCall(lab, jwt, { action: "admin_url", id: c1.body.id, which: "certificate" });
    check("completed: an administrator can retrieve the signed PDF and the certificate", adminUrl.status === 200 && certUrl.status === 200 && sha256(await signedFile(adminUrl.body.url)) === row1.signed_hash);
    const detail1 = (await signRpc(lab, jwt, "detail", c1.body.id)).body;
    const signer1 = detail1.recipients[0];
    check("audit: the signer's time, IP, browser, signature hash and the event history are recorded", !!signer1.signed_at && !!signer1.ip && !!signer1.signature_hash && detail1.chain_ok === true && ["created", "sent", "viewed", "signed", "completed"].every((e) => detail1.events.some((x) => x.event === e)), JSON.stringify(signer1).slice(0, 200));
    let frozen = false; try { psql(`update hr.sign_events set event = 'forged' where request_id = '${c1.body.id}';`); } catch { frozen = true; }
    let undeletable = false; try { psql(`delete from hr.sign_events where request_id = '${c1.body.id}';`); } catch { undeletable = true; }
    check("tamper: the history cannot be edited or deleted, even by the database owner's ordinary statements", frozen && undeletable);
    const pub = await fetch(`${lab.apiUrl}/storage/v1/object/public/signing-documents/${c1.body.id}/original.pdf`);
    const anonGet = await fetch(`${lab.apiUrl}/storage/v1/object/signing-documents/${c1.body.id}/original.pdf`, { headers: { apikey: lab.anonKey, Authorization: `Bearer ${lab.anonKey}` } });
    check("storage: no public URL and no anonymous read of a signing document", !pub.ok && !anonGet.ok, `${pub.status} ${anonGet.status}`);
    const signedPath = psql(`select signed_path from hr.sign_requests where id = '${c1.body.id}';`);
    const tamper = await fetch(`${lab.apiUrl}/storage/v1/object/signing-documents/${signedPath}`, { method: "PUT", headers: { apikey: lab.serviceKey, Authorization: `Bearer ${lab.serviceKey}`, "content-type": "application/pdf", "x-upsert": "true" }, body: await realPdf(1) });
    if (tamper.ok) {
      const verify2 = await signCall(lab, jwt, { action: "verify", id: c1.body.id }), refused = await signCall(lab, jwt, { action: "admin_url", id: c1.body.id });
      check("tamper: a changed stored PDF is detected and no longer served", verify2.body.ok === false && verify2.body.files.find((f) => f.name === "Signed document")?.ok === false && refused.status === 400 && /integrity/.test(refused.body.error ?? ""), JSON.stringify(verify2.body));
    } else console.log(`NOT RUN tamper detection on a stored file (the lab could not overwrite it: ${tamper.status})`);

    // ---- 2. sequential: Employee > HR Manager > Director, from the template
    const people = [{ name: "Signe Employee", email: mail("employee"), role: "employee", label: "Employee", order: 1 }, { name: "Hana Manager", email: mail("hr"), role: "hr", label: "HR Manager", order: 2 }, { name: "Dev Director", email: mail("director"), role: "director", label: "Director", order: 3 }];
    const c2 = await signCall(lab, jwt, { action: "create", templateId: tpl.id, recipients: people, values: { salary: "AUD 85,000", ...(employeeId ? {} : { "employee.name": "Signe Employee", "employee.first_name": "Signe", "employee.position": "Lab Trainer", "employee.department": "Training" }) }, ...(employeeId ? { subjectType: "employee", subjectId: employeeId } : {}) });
    check("sequential: a request from the template takes its mode, expiry, reminder and fields", c2.status === 200 && c2.body.signing_mode === "sequential" && c2.body.expiry_days === 10 && c2.body.reminder_days === 2 && c2.body.title === "Employment contract for Signe Employee", JSON.stringify(c2.body).slice(0, 240));
    const id2 = c2.body.id;
    check("sequential: template fields land on the matching recipients", psql(`select count(*) from hr.sign_fields where request_id = '${id2}' and recipient_id is not null;`) === "6");
    await signCall(lab, jwt, { action: "send", id: id2 });
    check("sequential: only the first signer is invited", recState(id2) === "sent,pending,pending" && (await waitMail(mail("employee"), /Please sign/)) === 1 && mailsTo(mail("hr")).length === 0 && mailsTo(mail("director")).length === 0, recState(id2));
    const tE = linkOf(mail("employee")); const oE = await open(tE);
    const eText = oE.body.fields.find((f) => f.type === "text"), eBox = oE.body.fields.find((f) => f.type === "checkbox");
    check("sequential: the first signer sees their four fields and nobody else's", oE.body.fields.length === 4 && oE.body.signers.length === 3);
    const hrField = psql(`select f.id from hr.sign_fields f join hr.sign_recipients c on c.id = f.recipient_id where f.request_id = '${id2}' and c.role_key = 'employee' and f.type = 'signature';`);
    const otherText = psql(`select id from hr.sign_fields where request_id = '${c1.body.id}' and type = 'text' and recipient_id is not null;`);
    const cross = await sign(tE, oE.body.documentHash, { name: "Signe Employee", values: { [eText.id]: "Australian resident", [eBox.id]: "true", [otherText]: "hijack" } });
    check("unauthorized: a signer cannot fill a field that is not theirs", cross.status === 403 && /own fields/.test(cross.body.error ?? "") && recState(id2) === "viewed,pending,pending" && !!hrField, `${cross.status} ${JSON.stringify(cross.body)}`);
    const sE = await sign(tE, oE.body.documentHash, { name: "Signe Employee", signatureKind: "drawn", signatureImage: signaturePng(), values: { [eText.id]: "Australian resident", [eBox.id]: "true" } });
    check("sequential: the first signature (drawn) leaves the request partially signed and invites the second signer", sE.status === 200 && sE.body.complete === false && state(id2) === "partial" && recState(id2) === "signed,sent,pending" && (await waitMail(mail("hr"), /Please sign/)) === 1 && mailsTo(mail("director")).length === 0, `${JSON.stringify(sE.body)} ${recState(id2)}`);
    const tH = linkOf(mail("hr")); const oH = await open(tH);
    const partial = await signedFile(oH.body.url);
    check("sequential: the second signer sees the document with the first signature already on it", !!partial && sha256(partial) !== oH.body.documentHash && sha256(partial) === psql(`select current_hash from hr.sign_requests where id = '${id2}';`));
    const sH = await sign(tH, oH.body.documentHash, { name: "Hana Manager", signatureKind: "uploaded", signatureImage: `data:image/png;base64,${signaturePng()}` });
    check("sequential: the second signature (uploaded picture) invites the third signer", sH.status === 200 && recState(id2) === "signed,signed,sent" && (await waitMail(mail("director"), /Please sign/)) === 1);
    check("sequential: not complete until every required signer has signed", state(id2) === "partial" && psql(`select count(*) from hr.sign_notifications where request_id = '${id2}' and kind = 'completed';`) === "0");
    const tD = linkOf(mail("director")); const oD = await open(tD);
    const sD = await sign(tD, oD.body.documentHash, { name: "Dev Director" });
    check("sequential: the third signature completes it", sD.body.complete === true && state(id2) === "signed" && recState(id2) === "signed,signed,signed");
    const done2 = await waitMail(mail("employee"), /Signed copy/) + await waitMail(mail("hr"), /Signed copy/) + await waitMail(mail("director"), /Signed copy/);
    check("sequential: each of the three signers gets exactly one completion email, and exactly one invitation each", done2 === 3 && [mail("employee"), mail("hr"), mail("director")].every((a) => mailsTo(a).filter((m) => /Please sign/.test(m.subject)).length === 1), String(done2));
    const final2 = await signedFile((await open(tD)).body.url);
    if (final2) { const words = (await pdfWords(final2))[0].items.map((i) => i.text).join(" ");
      check("sequential: the final PDF carries the answers and signatures of all signers on page 1", words.includes("Australian resident") && /DD/.test(words) && /AUD 85,000/.test(words) && /Hana Manager/.test(words), words.slice(0, 300)); }

    // ---- 3. parallel: two required and one optional, signing at the same moment
    const par = [{ name: "Pat Parallel", email: mail("p1") }, { name: "Quinn Parallel", email: mail("p2") }, { name: "Olly Optional", email: mail("p3"), required: false }];
    const c3 = await signCall(lab, jwt, { action: "create", title: `Parallel ${run}`, signingMode: "parallel", recipients: par }, pdf3);
    const id3 = c3.body.id;
    await signCall(lab, jwt, { action: "send", id: id3 });
    check("parallel: everyone is invited at once", recState(id3) === "sent,sent,sent" && (await waitMail(mail("p1"), /Please sign/)) + (await waitMail(mail("p2"), /Please sign/)) + (await waitMail(mail("p3"), /Please sign/)) === 3, recState(id3));
    const tP1 = linkOf(mail("p1")), tP2 = linkOf(mail("p2")), tP3 = linkOf(mail("p3"));
    const hash3 = (await open(tP1)).body.documentHash; await open(tP2);
    const both = await Promise.all([sign(tP1, hash3, { name: "Pat Parallel" }), sign(tP2, hash3, { name: "Quinn Parallel" })]);
    check("parallel: two people signing at the same moment both succeed and the request completes once", both.every((b) => b.status === 200) && both.filter((b) => b.body.complete).length === 1 && state(id3) === "signed", JSON.stringify(both.map((b) => b.body)));
    check("parallel: the optional recipient who did not sign is skipped, not waited for", recState(id3) === "signed,signed,skipped" && (await open(tP3)).status === 403);
    const final3 = await signedFile((await open(tP1)).body.url);
    if (final3) { const pages = await pdfWords(final3); const last = pages[pages.length - 1].items.map((i) => i.text).join(" ");
      check("parallel: with no placed fields both signatures are on an added signature page", pages.length === 4 && last.includes("Pat Parallel") && last.includes("Quinn Parallel"), last.slice(0, 200)); }
    check("parallel: completion mail goes to the two who signed and the sender, not to the skipped recipient", (await waitMail(mail("p1"), /Signed copy/)) === 1 && (await waitMail(mail("p2"), /Signed copy/)) === 1 && mailsTo(mail("p3")).filter((m) => /Signed copy/.test(m.subject)).length === 0);

    // ---- 6. reminders (and that they stop)
    const c6 = await signCall(lab, jwt, { action: "create", title: `Reminder ${run}`, reminderDays: 2, recipients: [{ name: "Rem Inder", email: mail("rem") }, { name: "Later Signer", email: mail("rem2"), order: 2 }] }, pdf3);
    const id6 = c6.body.id; await signCall(lab, jwt, { action: "send", id: id6 });
    await waitMail(mail("rem"), /Please sign/);
    const tick0 = await signCall(lab, jwt, { action: "tick" });
    check("reminders: nothing is sent before the reminder interval", tick0.status === 200 && mailsTo(mail("rem")).filter((m) => /Reminder to sign/.test(m.subject)).length === 0, JSON.stringify(tick0.body));
    psql(`update hr.sign_recipients set last_notified_at = now() - interval '3 days' where request_id = '${id6}';`);
    const tick1 = await signCall(lab, lab.serviceKey, { action: "tick" });
    check("reminders: the schedule sends one reminder to the person whose turn it is, and none to the one still waiting", tick1.body.reminders === 1 && (await waitMail(mail("rem"), /Reminder to sign/)) === 1 && mailsTo(mail("rem2")).length === 0, JSON.stringify(tick1.body));
    await signCall(lab, lab.serviceKey, { action: "tick" });
    check("idempotent: running the schedule again sends no second reminder", mailsTo(mail("rem")).filter((m) => /Reminder to sign/.test(m.subject)).length === 1);
    const tInvite = tokenIn(mailsTo(mail("rem")).find((m) => /Please sign/.test(m.subject)).text), tRemind = linkOf(mail("rem"), /Reminder to sign/);
    check("reminders: the reminder has its own link and the first link still works", tInvite !== tRemind && (await open(tInvite)).status === 200 && (await open(tRemind)).status === 200);
    const resend = await signCall(lab, jwt, { action: "resend", id: id6, recipientId: c6.body.recipients[0].id });
    check("dashboard: Resend sends the invitation again to a waiting recipient only", resend.status === 200 && (await waitMail(mail("rem"), /Please sign/, 2)) === 2 && (await signCall(lab, jwt, { action: "resend", id: id6, recipientId: c6.body.recipients[1].id })).status === 400);
    const o6 = await open(tRemind); await sign(tRemind, o6.body.documentHash, { name: "Rem Inder" });
    psql(`update hr.sign_recipients set last_notified_at = now() - interval '3 days' where request_id = '${id6}' and state = 'signed';`);
    await signCall(lab, lab.serviceKey, { action: "tick" });
    check("reminders: they stop for someone who has signed", mailsTo(mail("rem")).filter((m) => /Reminder to sign/.test(m.subject)).length === 1);
    const nonAdminTick = await signCall(lab, lab.anonKey, { action: "tick" });
    check("unauthorized: a visitor cannot run the schedule", nonAdminTick.status === 403);

    // ---- 9. voided
    const tV = linkOf(mail("rem2"));
    const voided = await signCall(lab, jwt, { action: "void", id: id6, reason: "Sent in error" });
    check("void: the request is voided and every link stops working", voided.status === 200 && state(id6) === "void" && (await open(tV)).status === 403 && (await open(tRemind)).status === 403, `${voided.status} ${state(id6)}`);
    check("void: signing a voided request is refused", (await sign(tV, o6.body.documentHash, { name: "Later Signer" })).status === 403);
    psql(`update hr.sign_recipients set last_notified_at = now() - interval '9 days' where request_id = '${id6}';`);
    const before = postmark.messages.length; await signCall(lab, lab.serviceKey, { action: "tick" });
    check("void: reminders stop at once, and the people already asked are told once", postmark.messages.slice(before).every((m) => !/Reminder to sign/.test(m.subject)) && (await waitMail(mail("rem2"), /cancelled/)) === 1);
    check("void: a completed request cannot be voided", (await signCall(lab, jwt, { action: "void", id: c1.body.id })).status === 400);

    // ---- 8. declined
    const c8 = await signCall(lab, jwt, { action: "create", title: `Decline ${run}`, signingMode: "parallel", recipients: [{ name: "Dee Cline", email: mail("dec") }, { name: "Other Signer", email: mail("dec2") }] }, pdf3);
    const id8 = c8.body.id; await signCall(lab, jwt, { action: "send", id: id8 });
    await waitMail(mail("dec"), /Please sign/); await waitMail(mail("dec2"), /Please sign/);
    const tDec = linkOf(mail("dec")), tDec2 = linkOf(mail("dec2"));
    const o8 = await open(tDec2); await sign(tDec2, o8.body.documentHash, { name: "Other Signer" });
    const declined = await signCall(lab, lab.anonKey, { action: "decline", token: tDec, reason: "The salary is wrong" });
    check("decline: a required signer declining closes the request with their reason", declined.status === 200 && state(id8) === "declined" && psql(`select decline_reason from hr.sign_recipients where request_id = '${id8}' and state = 'declined';`) === "The salary is wrong");
    check("decline: every link stops working, including the other signer's", (await open(tDec)).status === 403 && (await open(tDec2)).status === 403);
    check("decline: the sender is told with the reason, and the person who had signed is told", (await waitMail(LAB_ADMIN.email, /Declined:/)) >= 1 && /salary is wrong/.test(mailsTo(LAB_ADMIN.email).find((m) => /Declined:/.test(m.subject) && m.text.includes(c8.body.reference))?.text ?? "") && (await waitMail(mail("dec2"), /Signing cancelled/)) === 1);
    psql(`update hr.sign_recipients set last_notified_at = now() - interval '9 days' where request_id = '${id8}';`);
    const before8 = postmark.messages.length; await signCall(lab, lab.serviceKey, { action: "tick" });
    check("decline: no reminder is sent afterwards", postmark.messages.slice(before8).every((m) => !/Reminder to sign/.test(m.subject)));

    // ---- 7. expired links
    const c7 = await signCall(lab, jwt, { action: "create", title: `Expiry ${run}`, expiryDays: 1, recipients: [{ name: "Ex Pired", email: mail("exp") }] }, pdf3);
    const id7 = c7.body.id; await signCall(lab, jwt, { action: "send", id: id7 }); await waitMail(mail("exp"), /Please sign/);
    const tX = linkOf(mail("exp")); const o7 = await open(tX);
    check("expiry: the request records when its links stop (1 day here)", o7.status === 200 && Math.abs(new Date(o7.body.expiresAt) - Date.now() - 86400000) < 120000);
    psql(`update hr.sign_requests set expires_at = now() - interval '1 minute' where id = '${id7}';`);
    check("expiry: an expired link opens nothing and signs nothing", (await open(tX)).status === 403 && (await sign(tX, o7.body.documentHash, { name: "Ex Pired" })).status === 403);
    check("dashboard: an expired request shows as Expired even before the schedule runs", (await signRpc(lab, jwt, "detail", id7)).body.status === "expired");
    psql(`update hr.sign_recipients set last_notified_at = now() - interval '9 days' where request_id = '${id7}';`);
    const tickX = await signCall(lab, lab.serviceKey, { action: "tick" });
    check("expiry: the schedule closes it and tells the recipient and the sender", tickX.body.expired >= 1 && state(id7) === "expired" && (await waitMail(mail("exp"), /expired/)) === 1 && (await waitMail(LAB_ADMIN.email, /Expired:/)) >= 1, JSON.stringify(tickX.body));
    await signCall(lab, lab.serviceKey, { action: "tick" });
    check("idempotent: the expiry notice is sent once, and no reminder after expiry", mailsTo(mail("exp")).filter((m) => /expired/.test(m.subject)).length === 1 && mailsTo(mail("exp")).filter((m) => /Reminder to sign/.test(m.subject)).length === 0);

    // ---- email failure: a link nobody received does not stay valid; Resend recovers
    const c9 = await signCall(lab, jwt, { action: "create", title: `Mail failure ${run}`, recipients: [{ name: "Fay Lure", email: mail("fail") }] }, pdf3);
    postmark.mode = "fail";
    const s9 = await signCall(lab, jwt, { action: "send", id: c9.body.id });
    postmark.mode = "ok";
    const failedLink = tokenIn(mailsTo(mail("fail"))[0]?.text);
    check("email: a failed invitation is shown to the administrator and its link is not left valid", s9.body.mail?.failed === 1 && (await signRpc(lab, jwt, "detail", c9.body.id)).body.recipients[0].delivery_error && (await open(failedLink)).status === 403, JSON.stringify(s9.body.mail));
    const r9 = await signCall(lab, jwt, { action: "resend", id: c9.body.id, recipientId: c9.body.recipients[0].id });
    check("email: Resend after a failure delivers a working link", r9.status === 200 && (await open(linkOf(mail("fail")))).status === 200);

    // ---- 12. module panels: the related record lists its documents and their status
    if (employeeId) {
      const panel = await signRpc(lab, jwt, "subject_list", employeeId, { type: "employee" });
      check("modules: an employee's record lists its documents with their status", panel.body?.filter((r) => r.status !== "void").length === 2 && panel.body.filter((r) => r.status !== "void").every((r) => r.status === "signed") && panel.body.some((r) => r.category === "employment_contract"), JSON.stringify(panel.body?.map((r) => [r.title, r.status])));
    } else console.log("NOT RUN employee panel (no employee could be seeded)");
    if (studentId) {
      const cS = await signCall(lab, jwt, { action: "create", templateId: tPdf.body.id, subjectType: "student", subjectId: studentId, recipients: [{ name: "Stu Dent", email: mail("student"), role: "student" }], values: { "course.name": "Certificate IV in Lab Signing" } });
      check("modules: a consent form for a student is made from the PDF template", cS.status === 200 && cS.body.subject_type === "student" && cS.body.category === "consent_form", JSON.stringify(cS.body).slice(0, 200));
      await signCall(lab, jwt, { action: "send", id: cS.body.id }); await waitMail(mail("student"), /Please sign/);
      const tS = linkOf(mail("student")); const oS = await open(tS);
      const shownS = await signedFile(oS.body.url);
      const wordsS = shownS ? (await pdfWords(shownS))[1].items.map((i) => i.text).join(" ") : "";
      check("variables: the PDF template prints the student's name and course on page 2 before anyone signs", /Stu Dent \/ Certificate IV in Lab Signing/.test(wordsS), wordsS);
      const panelS = await signRpc(lab, jwt, "subject_list", studentId, { type: "student" });
      check("modules: the student's record lists the consent form as viewed", panelS.body?.length === 1 && panelS.body[0].status === "viewed" && panelS.body[0].recipients[0].state === "viewed");
      // A signed-in student sees and opens their own document (their confirmed email), and nobody else's.
      const studentUser = crypto.randomUUID(), strangerUser = crypto.randomUUID();
      const mk = async (id, email) => fetch(`${lab.apiUrl}/auth/v1/admin/users`, { method: "POST", headers: { apikey: lab.serviceKey, Authorization: `Bearer ${lab.serviceKey}`, "content-type": "application/json" }, body: JSON.stringify({ id, email, password: "lab-signer-password-1", email_confirm: true }) });
      const login = async (email) => (await (await fetch(`${lab.apiUrl}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: lab.anonKey, "content-type": "application/json" }, body: JSON.stringify({ email, password: "lab-signer-password-1" }) })).json()).access_token;
      await mk(studentUser, mail("student")); await mk(strangerUser, mail("stranger"));
      const sJwt = await login(mail("student")), xJwt = await login(mail("stranger"));
      const mine = await restRpc(lab, sJwt, "signing_mine", { p_action: "list" }), theirs = await restRpc(lab, xJwt, "signing_mine", { p_action: "list" });
      check("signed-in: a student sees the documents addressed to their own email and a stranger sees none", mine.body?.length === 1 && mine.body[0].title === "Consent form" && theirs.body?.length === 0, `${JSON.stringify(mine.body)} ${JSON.stringify(theirs.body)}`);
      const myToken = await restRpc(lab, sJwt, "signing_mine", { p_action: "token", p_id: mine.body[0].recipient_id }), stolen = await restRpc(lab, xJwt, "signing_mine", { p_action: "token", p_id: mine.body[0].recipient_id });
      check("signed-in: the student gets a personal link for it; another account is refused", /^[a-f0-9]{64}$/.test(myToken.body?.token ?? "") && stolen.status >= 400 && (await open(myToken.body.token)).status === 200);
      const strangerAdmin = await signCall(lab, xJwt, { action: "admin_url", id: cS.body.id });
      check("unauthorized: a signed-in person who is not an administrator cannot use the administrator actions", strangerAdmin.status === 403, `${strangerAdmin.status}`);
      const sS = await sign(myToken.body.token, oS.body.documentHash, { name: "Stu Dent" });
      check("modules: after signing, the student's record shows the consent form as completed", sS.body.complete === true && (await signRpc(lab, jwt, "subject_list", studentId, { type: "student" })).body[0].status === "signed");
    } else console.log("NOT RUN student panel and signed-in student (no student could be seeded)");
    if (agentId) {
      const cA = await signCall(lab, jwt, { action: "create", title: `Agency agreement ${run}`, category: "agency_agreement", subjectType: "agent", subjectId: agentId, recipients: [{ name: "Agnes Agent", email: mail("agent") }] }, pdf3);
      const panelA = await signRpc(lab, jwt, "subject_list", agentId, { type: "agent" });
      const vals = await signRpc(lab, jwt, "subject_values", agentId, { type: "agent" });
      check("modules: an agent's record lists its agency agreement, and the agent's variables are filled", cA.status === 200 && panelA.body?.length === 1 && panelA.body[0].status === "draft" && vals.body.values["agent.name"] === "Agnes Agent" && vals.body.values["agency.name"].startsWith("Sign Lab Agency"), JSON.stringify(vals.body).slice(0, 200));
      const discard = await signRpc(lab, jwt, "delete_draft", cA.body.id);
      check("dashboard: a draft can be discarded", discard.status === 200 && discard.body.state === "void");
    } else console.log("NOT RUN agent panel (no agent could be seeded)");

    // ---- TPL-02 + INT-01: a document template with a header and footer from presets, [Variables] from the student's record and chosen intake,
    // the signer's own [tokens] and initials on every page, through the real function: preview, create, send, open, sign, signed PDF.
    const requestsBefore = () => psql("select coalesce(md5(string_agg(id || original_hash || coalesce(template_version::text, '') || coalesce(rendered_text, ''), ',' order by id)), '') from hr.sign_requests where created_at < now() - interval '0 seconds' and id in (select id from tpl02_before);");
    psql("drop table if exists tpl02_before; create table tpl02_before as select id from hr.sign_requests;");
    const tpl02Before = requestsBefore();
    if (studentId) {
      const intakeId = psql(`insert into public.course_intakes(course_id, start_date) values ('lab-sign-${run}', current_date + 45) returning id;`).split("\n")[0];
      psql(`update public.enrollment_application_courses set intake_id = '${intakeId}' where course_id = 'lab-sign-${run}'; update public.enrollment_applications set reference = 'APP-LAB-${run}' where student_id = '${studentId}';`);
      const [intakeName, startDate] = psql(`select public.course_intake_name(i) || '|' || to_char(i.start_date, 'FMDD FMMonth YYYY') from public.course_intakes i where i.id = '${intakeId}';`).split("|");
      const LOGO = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const headerHtml = `<table style="border:none;width:100%"><tr><td style="width:50%"><img src="data:image/png;base64,${LOGO}" style="width:48px;height:48px"> <strong style="font-size:14pt">Skyline Institute of Technology</strong></td>`
        + `<td style="text-align:right;width:50%">Level 8, 310 King Street, Melbourne VIC 3000<br>RTO 45989 | CRICOS 04114B<br>info@slit.edu.au | +61 3 9125 1661<br>https://slit.edu.au/</td></tr></table>`;
      const footerHtml = `<p>LETTER OF OFFER AND WRITTEN AGREEMENT &nbsp; Version Oct 2024 &nbsp; Student Initial [Student Initial] &nbsp; Page [Page Number]</p><p style="font-size:8pt">INDOPACIFIC GLOBAL PTY LTD T/A SKYLINE INSTITUTE OF TECHNOLOGY (SLIT) &nbsp; ABN: 20 643 760 721</p>`;
      const hp = await signRpc(lab, jwt, "part_save", null, { kind: "header", name: `SLIT letterhead ${run}`, html: headerHtml });
      const fp = await signRpc(lab, jwt, "part_save", null, { kind: "footer", name: `SLIT agreement footer ${run}`, html: footerHtml });
      const parts = (await signRpc(lab, jwt, "part_list")).body ?? [];
      const preset = (kind) => parts.find((p) => p.kind === kind && p.name.endsWith(run))?.html;
      check("TPL-02: header and footer presets are saved and listed", hp.status === 200 && fp.status === 200 && !!preset("header") && !!preset("footer"), JSON.stringify([hp.body, fp.body]).slice(0, 200));
      const rows = Array.from({ length: 30 }, (_, i) => `<tr><td>Fee item ${i + 1}: tuition instalment, materials and services for study period ${i + 1}</td><td style="text-align:right">$${(i + 1) * 150}.00</td></tr>`).join("");
      const body = `<h2>1. Your offer</h2><p>Dear [Student Name] ([Student ID]), you are offered [Course Name] ([Course Code]), intake [Intake], starting [Start Date].</p>`
        + `<table><tr><th>Fee item</th><th>Amount</th></tr>${rows}</table><h2>2. Written agreement</h2><p>${"You agree to the terms of this written agreement and the refund policy. ".repeat(45)}</p>`
        + `<p>Emergency contact: [Emergency Contact Name] ([Relationship]). Confirm the emergency contact: [Emergency Contact Name].</p>`;
      const tDoc = await signRpc(lab, jwt, "template_save", null, { name: `Letter of offer ${run}`, title: `Letter of offer and written agreement ${run}`, kind: "text", audience: "student", category: "enrolment_agreement",
        body_html: body, body: "Letter of offer", header_html: preset("header"), footer_html: preset("footer"), bracket_variables: true, roles: [{ key: "student", label: "Student", order: 1, required: true }] });
      check("TPL-02: a document template is saved with the presets as its header and footer", tDoc.status === 200 && tDoc.body.header_html === preset("header") && tDoc.body.bracket_variables === true, JSON.stringify(tDoc.body).slice(0, 160));
      const pv = await signCall(lab, jwt, { action: "template_preview", id: tDoc.body.id, subjectType: "student", subjectId: studentId });
      const pvPages = pv.status === 200 ? await pdfWords(Buffer.from(pv.body.pdfBase64, "base64")) : [];
      const everyPage = (pages) => pages.length >= 2 && pages.every((p, i) => { const t = p.items.map((x) => x.text).join(" "); return t.includes("CRICOS 04114B") && t.includes("Skyline Institute of Technology") && new RegExp(`Page ${i + 1}(?!\\d)`).test(t) && t.includes("ABN: 20 643 760 721") && t.includes("Version Oct 2024"); });
      check("TPL-02 acceptance 1: the preview shows the header and footer on every page with its own page number", everyPage(pvPages), `${pv.status} pages ${pvPages.length}`);
      check("TPL-02: the preview lists the signer's fields (each token, initials on every page)", pv.status === 200 && pv.body.signerFields.filter((f) => f.type === "initials").length === pvPages.length
        && [...new Set(pv.body.signerFields.filter((f) => f.type === "text").map((f) => f.label))].sort().join(",") === "[Emergency Contact Name],[Relationship]", JSON.stringify(pv.body.signerFields ?? pv.body).slice(0, 300));
      const cDoc = await signCall(lab, jwt, { action: "create", templateId: tDoc.body.id, subjectType: "student", subjectId: studentId, recipients: [{ name: "Stu Dent", email: mail("student-doc"), role: "student" }], values: {} });
      check("TPL-02: a request is made from the student's record", cDoc.status === 200, JSON.stringify(cDoc.body).slice(0, 200));
      if (cDoc.status === 200) {
        await signCall(lab, jwt, { action: "send", id: cDoc.body.id });
        await waitMail(mail("student-doc"), /Please sign/);
        const tk = linkOf(mail("student-doc"));
        const od = await open(tk);
        const textFields = (od.body.fields ?? []).filter((f) => f.type === "text"), initialFields = (od.body.fields ?? []).filter((f) => f.type === "initials");
        const original = od.status === 200 ? await signedFile(od.body.url) : null, origPages = original ? await pdfWords(original) : [];
        check("TPL-02 acceptance 1: the PDF sent for signing has the header and footer on every page with its page number", everyPage(origPages), `pages ${origPages.length}`);
        check("TPL-02 acceptance 3: the signing screen gets one field per [token] occurrence, grouped by label, and initials on every page",
          [...new Set(textFields.map((f) => f.label))].sort().join(",") === "[Emergency Contact Name],[Relationship]" && textFields.length === 3 && initialFields.length === origPages.length, JSON.stringify(od.body.fields ?? od.body).slice(0, 300));
        const values = (answers) => Object.fromEntries(textFields.map((f) => [f.id, answers[f.label] ?? ""]));
        const empty = await sign(tk, od.body.documentHash, { name: "Stu Dent", values: values({}) });
        check("TPL-02 acceptance 3: signing is blocked until every token is filled", empty.status === 400 && /required field/.test(empty.body.error ?? ""), JSON.stringify(empty.body));
        const mixed = Object.fromEntries(textFields.map((f, i) => [f.id, f.label === "[Emergency Contact Name]" ? `Answer ${i}` : "Mother"]));
        const twoAnswers = await sign(tk, od.body.documentHash, { name: "Stu Dent", values: mixed });
        check("TPL-02: a token that appears twice takes one answer", twoAnswers.status === 400 && /one answer/.test(twoAnswers.body.error ?? ""), JSON.stringify(twoAnswers.body));
        const done = await sign(tk, od.body.documentHash, { name: "Stu Dent", values: values({ "[Emergency Contact Name]": "Ravi Dent 0412 345 678", "[Relationship]": "Father" }) });
        check("TPL-02: with every token filled the student signs", done.status === 200 && done.body.complete === true, JSON.stringify(done.body));
        const finalDoc = await signedFile((await open(tk)).body.url);
        const fPages = finalDoc ? await pdfWords(finalDoc) : [];
        const words = fPages.flatMap((p) => p.items.map((i) => i.text)).join(" ");
        check("TPL-02 acceptance 3: the signed PDF carries the answers", (words.match(/Ravi Dent 0412 345 678/g) ?? []).length === 2 && words.includes("Father"), words.slice(0, 120));
        check("TPL-02 acceptance 3: the student's initials are in the footer of every page", fPages.slice(0, origPages.length).every((p) => p.items.some((i) => i.text === "SD" && i.y < 60)), fPages.map((p) => p.items.filter((i) => i.y < 60).map((i) => i.text).join(" ")).join(" || ").slice(0, 300));
        check("TPL-02 + INT-01: [Student Name], [Student ID], [Course Name], [Intake] and [Start Date] come from the record and the chosen intake",
          ["Dear Stu Dent", `APP-LAB-${run}`, "Certificate IV in Lab Signing", intakeName, startDate].every((v) => words.includes(v)) && !/\[(Student Name|Intake|Start Date|Page Number)\]/.test(words), `${intakeName} ${startDate} ${words.slice(0, 200)}`);
        const fees = Array.from({ length: 30 }, (_, i) => i + 1).every((n) => { const a = fPages.findIndex((p) => p.items.some((x) => x.text.includes(`Fee item ${n}:`))), b = fPages.findIndex((p) => p.items.some((x) => x.text === `$${n * 150}.00`)); return a >= 0 && a === b; });
        check("TPL-02 acceptance 1: no fee table row is split across pages", fees);
      }
      // Acceptance 5: every request made before (their original PDF, template version and text) is untouched by the new templates.
      check("TPL-02 acceptance 5: every earlier request keeps its original PDF hash, template version and text", requestsBefore() === tpl02Before && tpl02Before !== "");
      psql("drop table if exists tpl02_before;");
    } else console.log("NOT RUN TPL-02 student document (no student could be seeded)");

    // ---- 7 (dashboard): every status is reported
    const all = (await signRpc(lab, jwt, "list")).body.requests.filter((r) => r.title.includes(run) || r.title.startsWith("Employment contract for") || r.title === "Consent form");
    const statuses = new Set(all.map((r) => r.status));
    check("dashboard: the list reports completed, declined, expired, voided and viewed requests with their recipients", ["signed", "declined", "expired", "void", "viewed"].every((s) => statuses.has(s)) && all.every((r) => Array.isArray(r.recipients) && r.recipients.length >= 1), [...statuses].join(","));
    const dup = psql("select count(*) - count(distinct dedupe_key) from hr.sign_notifications;");
    check("idempotent: notification jobs are unique by key", dup === "0");
    check("audit: every request's history chain verifies", psql("select count(*) from hr.sign_requests r where not hr.sign_chain_ok(r.id);") === "0");
  } finally {
    await stopMockPostmark();
  }
  console.log(`signing: ${workerRetries} sign call(s) were stopped by the runtime's CPU limit and made again`);
  console.log(failures ? `\n${failures} signing check(s) FAILED` : "\nAll signing checks passed.");
  process.exitCode = failures ? 1 : 0;
}

/** Documents & Signatures in a real browser: the admin dashboard, field placement and sending (desktop), then signing on a phone screen. */
async function signingBrowser() {
  const lab = readLab();
  await ensureLabAdmin();
  await startMockPostmark();
  const { chromium, devices } = await import("playwright");
  const shots = path.join(os.tmpdir(), "skyline-signing-shots"); fs.mkdirSync(shots, { recursive: true });
  const vite = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vite", "--port", "57330", "--strictPort", "--host", "127.0.0.1"], { cwd: REPO, shell: isWin, stdio: "ignore",
    env: { ...process.env, VITE_PUBLIC_SUPABASE_URL: lab.apiUrl, VITE_PUBLIC_SUPABASE_ANON_KEY: lab.anonKey, VITE_PUBLIC_SITE_URL: SITE } });
  // LAB_CHROMIUM: a Chromium binary to use when the pinned Playwright has not downloaded its own.
  const browser = await chromium.launch(process.env.LAB_CHROMIUM ? { executablePath: process.env.LAB_CHROMIUM } : {});
  const run = nodeCrypto.randomBytes(3).toString("hex"), mail = (n) => `ui.${n}.${run}@example.test`;
  // The function may be served outside the stack (LAB_SIGNING_FUNCTION_URL): the browser's calls to it are forwarded there.
  const forward = async (context) => {
    // Signed Storage links name the stack's internal gateway (http://kong:8000), which only containers resolve: the browser's requests
    // for them go to the lab's API address instead (as signedFile() does for the checks).
    await context.route("http://kong:8000/**", async (route) => {
      const res = await fetch(route.request().url().replace("http://kong:8000", lab.apiUrl));
      await route.fulfill({ status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/pdf", "access-control-allow-origin": "*" }, body: Buffer.from(await res.arrayBuffer()) });
    });
    if (!process.env.LAB_SIGNING_FUNCTION_URL) return;
    await context.route("**/functions/v1/document-signing", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" }, body: "ok" });
      const res = await fetch(process.env.LAB_SIGNING_FUNCTION_URL, { method: "POST", headers: { ...route.request().headers(), "x-forwarded-for": "203.0.113.20" }, body: route.request().postDataBuffer() });
      await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: Buffer.from(await res.arrayBuffer()) });
    }); };
  const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(SITE)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 1000)); }
    const jwt = await adminToken(lab);
    // ---- desktop: an administrator prepares, places fields and sends
    const desk = await browser.newContext({ viewport: { width: 1366, height: 900 } }); await forward(desk);
    const page = await desk.newPage();
    await page.goto(`${SITE}/login`);
    await page.getByRole("tab", { name: "Sign in" }).click();
    await page.locator('input[name="email"]').fill(LAB_ADMIN.email); await page.locator('input[name="password"]').fill(LAB_ADMIN.password);
    await page.getByRole("button", { name: /^sign in$/i }).last().click();
    await page.waitForURL(/\/admin/, { timeout: 30000 });
    const nav = page.getByRole("link", { name: "Documents & Signatures" }).first();
    const inNav = await nav.waitFor({ timeout: 20000 }).then(() => true, () => false);
    if (!inNav) await page.screenshot({ path: path.join(shots, "admin-nav.png"), fullPage: true });
    check("browser: Documents & Signatures is in the admin navigation", inNav);
    if (!inNav) await page.goto(`${SITE}/admin/signing`);
    if (inNav) await nav.click(); await page.waitForURL(/\/admin\/signing/);
    await page.getByTestId("status-all").waitFor({ timeout: 20000 });
    check("browser: the dashboard shows the eight status filters", (await Promise.all(["draft", "sent", "viewed", "partial", "signed", "declined", "expired", "void"].map((k) => page.getByTestId(`status-${k}`).isVisible()))).every(Boolean));
    // A template through the editor (one template system since TPL-01, Header / Body / Footer since TPL-02): a consent form whose body
    // gets a variable from the picker, previewed as PDF, saved after the variable check.
    await page.getByTestId("new-template").click();
    const studentChoice = page.getByTestId("template-audience-student").locator("..");
    await studentChoice.getByText("Choose a document category").click();
    await studentChoice.getByRole("button", { name: "Consent form" }).click();
    await page.getByTestId("template-name").fill(`UI consent ${run}`);
    await page.getByRole("option", { name: `+ Add new: UI consent ${run}` }).click();
    const bodyEditor = page.getByTestId("section-editor-body");
    await bodyEditor.click(); await page.keyboard.type("I, ");
    await page.getByTestId("variable-student-name").click();
    await page.keyboard.type(", agree to the consent form.");
    check("browser: a variable is inserted into the template text", (await bodyEditor.innerText()).includes("I, [Student Name], agree"));
    await page.getByRole("button", { name: "Preview the PDF" }).click();
    check("browser: the template preview renders the document", await page.locator("[data-pdf-page='1'] canvas").waitFor({ timeout: 30000 }).then(() => true, () => false));
    await page.screenshot({ path: path.join(shots, "template-preview.png") });
    await page.getByRole("button", { name: "Close" }).last().click();
    await page.getByTestId("template-save").click();
    await page.getByTestId("template-save-confirm").click();
    check("browser: the template is saved and listed", await page.getByTestId("template-table").getByText(`UI consent ${run}`).waitFor({ timeout: 15000 }).then(() => true, () => false));
    // A two-person request made through the function, then fields placed and sent from the screen.
    const made = await signCall(lab, jwt, { action: "create", title: `UI agreement ${run}`, recipients: [{ name: "Una Phone", email: mail("one") }, { name: "Theo Second", email: mail("two"), order: 2 }] }, await realPdf(2));
    await page.reload(); await page.getByTestId("request-search").fill(run);
    await page.getByTestId("request-table").getByText(`UI agreement ${run}`).click();
    await page.getByTestId("place-fields").click();
    await page.locator("[data-pdf-page='1'] canvas").waitFor({ timeout: 30000 });
    // Drag a signature onto page 1 for the first signer, then choose the second signer and click-place theirs.
    const target = page.getByTestId("field-page-1"); const box = await target.boundingBox();
    await page.getByTestId("field-kind-signature").dragTo(target, { targetPosition: { x: box.width * 0.3, y: box.height * 0.75 } });
    await page.getByTestId("field-owner").selectOption({ index: 1 });
    await page.getByTestId("field-kind-signature").click(); await target.click({ position: { x: box.width * 0.7, y: box.height * 0.75 } });
    await page.getByTestId("field-owner").selectOption({ index: 0 });
    await page.getByTestId("field-kind-text").click(); await target.click({ position: { x: box.width * 0.3, y: box.height * 0.5 } });
    check("browser: three fields are placed by drag and by click", (await page.getByTestId("placed-field").count()) === 3);
    await page.screenshot({ path: path.join(shots, "field-editor.png") });
    await page.getByTestId("save-fields").click();
    await page.getByRole("status").filter({ hasText: "Fields saved." }).waitFor({ timeout: 15000 });
    const placed = JSON.parse(psql(`select json_agg(json_build_object('type', f.type, 'who', c.name, 'page', f.page, 'x', f.x, 'y', f.y)) from hr.sign_fields f join hr.sign_recipients c on c.id = f.recipient_id where f.request_id = '${made.body.id}';`));
    check("browser: the placed fields are stored for the right signers and pages", placed.length === 3 && placed.filter((f) => f.who === "Una Phone").length === 2 && placed.some((f) => f.who === "Theo Second" && f.type === "signature" && f.x > 0.4) && placed.every((f) => f.page === 1), JSON.stringify(placed));
    // Field editor drag (2026-11-12): one scroll container, pointer capture, auto-scroll at the edges, a drop on another page, resize at the
    // bottom edge, mouse and touch; positions stay fractions of the page, so a reload shows every field where it was.
    {
      const pagesArea = page.getByTestId("field-pages");
      const atBottom = () => page.waitForFunction(() => { const s = document.querySelector("[data-testid='field-pages']"); return s.scrollTop + s.clientHeight >= s.scrollHeight - 2; }, null, { timeout: 20000 });
      const toTop = () => page.evaluate(() => { document.querySelector("[data-testid='field-pages']").scrollTop = 0; });
      const fieldsJson = () => JSON.parse(psql(`select json_agg(json_build_object('type', f.type, 'who', c.name, 'page', f.page, 'x', f.x, 'y', f.y, 'w', f.w, 'h', f.h) order by c.name, f.type) from hr.sign_fields f join hr.sign_recipients c on c.id = f.recipient_id where f.request_id = '${made.body.id}';`));
      const openPlacing = async () => { await page.getByTestId("place-fields").click(); await page.locator("[data-pdf-page='2'] canvas").waitFor({ timeout: 30000 }); await toTop(); };
      await openPlacing();
      check("browser: in the field editor only the pages area scrolls (the modal body does not)", await page.evaluate(() => {
        const pages = document.querySelector("[data-testid='field-pages']"), panel = document.querySelector("[data-testid='field-panel']");
        const dialog = pages.closest(".fixed");
        const scrollers = [...dialog.querySelectorAll("*")].filter((el) => el !== panel && /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1);
        return scrollers.length === 1 && scrollers[0] === pages && dialog.scrollHeight <= dialog.clientHeight + 1;
      }));
      // Mouse: a signature from page 1 to the bottom of the last page in one drag (held at the bottom edge until it has scrolled).
      const theo = page.locator("[data-pdf-page='1'] [data-testid='placed-field'][data-field-type='signature']").first();
      await theo.scrollIntoViewIfNeeded(); const sb = await pagesArea.boundingBox(); const fb = await theo.boundingBox();
      await page.mouse.move(fb.x + 10, fb.y + 5); await page.mouse.down();
      await page.mouse.move(fb.x + 20, sb.y + sb.height - 6, { steps: 12 });
      await atBottom();
      const last = await page.locator("[data-pdf-page='2']").boundingBox();
      await page.mouse.move(fb.x + 20, last.y + last.height - 70, { steps: 6 });
      await page.mouse.up();
      check("browser: a field dragged once from page 1 lands on the last page", (await page.getByTestId("field-details").innerText()).includes("page 2"));
      // Resize at the bottom edge: the field grows but stays inside its page.
      const moved = page.locator("[data-pdf-page='2'] [data-testid='placed-field']").first();
      const handle = moved.getByTestId("field-resize"); const hb = await handle.boundingBox();
      await page.mouse.move(hb.x + 3, hb.y + 3); await page.mouse.down();
      await page.mouse.move(hb.x + 60, sb.y + sb.height - 4, { steps: 8 });
      await page.waitForTimeout(400);
      await page.mouse.up();
      const pb2 = await page.locator("[data-pdf-page='2']").boundingBox(), mb = await moved.boundingBox();
      check("browser: resizing at the bottom edge keeps the field inside its page", mb.y + mb.height <= pb2.y + pb2.height + 1 && mb.width > fb.width + 30, JSON.stringify({ mb, pb2 }));
      // Touch: Una's text field from page 1 to page 2, with the same auto-scroll (Chrome's touch emulation sends pointerType "touch").
      await toTop();
      const cdp = await desk.newCDPSession(page);
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      const una = page.locator("[data-pdf-page='1'] [data-testid='placed-field'][data-field-type='text']").first(); await una.scrollIntoViewIfNeeded(); const ub = await una.boundingBox();
      const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y: Math.round(y) }] });
      await touch("touchStart", ub.x + 8, ub.y + 4);
      for (let i = 1; i <= 12; i++) await touch("touchMove", ub.x + 8, ub.y + 4 + (sb.y + sb.height - 6 - ub.y - 4) * i / 12);
      await atBottom();
      const lastTouch = await page.locator("[data-pdf-page='2']").boundingBox();
      for (let i = 1; i <= 4; i++) await touch("touchMove", ub.x + 8, sb.y + sb.height - 6 + (lastTouch.y + lastTouch.height * 0.5 - (sb.y + sb.height - 6)) * i / 4);
      await touch("touchEnd", 0, 0);
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      check("browser: a touch drag moves a field to the last page too", (await page.getByTestId("field-details").innerText()).includes("page 2"));
      await page.screenshot({ path: path.join(shots, "field-editor-dragged.png") });
      await page.getByTestId("save-fields").click();
      await page.getByRole("status").filter({ hasText: "Fields saved." }).waitFor({ timeout: 15000 });
      const saved = fieldsJson();
      const movedSignature = saved.find((f) => f.type === "signature" && f.page === 2), movedText = saved.find((f) => f.type === "text");
      check("browser: the moved fields are stored on page 2, inside the page, as fractions", saved.length === 3 && Boolean(movedSignature) && movedText?.page === 2 && movedSignature.y > 0.6 && movedSignature.y + movedSignature.h <= 1.0001
        && saved.filter((f) => f.type === "signature" && f.page === 1).length === 1 && saved.every((f) => f.x >= 0 && f.y >= 0 && f.x + f.w <= 1.0001 && f.y + f.h <= 1.0001), JSON.stringify(saved));
      // Reload: every field is shown where it is stored (unmoved ones too).
      await page.reload(); await page.getByTestId("request-search").fill(run);
      await page.getByTestId("request-table").getByText(`UI agreement ${run}`).click();
      await openPlacing();
      const shown = await page.evaluate(() => [...document.querySelectorAll("[data-testid='placed-field']")].map((el) => {
        const pageEl = el.closest("[data-pdf-page]"), p = pageEl.getBoundingClientRect(), r = el.getBoundingClientRect();
        return { type: el.getAttribute("data-field-type"), page: Number(pageEl.getAttribute("data-pdf-page")), x: (r.left - p.left) / p.width, y: (r.top - p.top) / p.height };
      }));
      const near = (a, b) => Math.abs(a - b) < 0.006;
      check("browser: after a reload every field is where it was saved", saved.length === shown.length && saved.every((f) => shown.some((s) => s.type === f.type && s.page === f.page && near(s.x, f.x) && near(s.y, f.y))), JSON.stringify({ saved, shown }));
      await page.screenshot({ path: path.join(shots, "field-editor-reloaded.png") });
      await page.getByRole("button", { name: "Close" }).last().click();
    }
    page.once("dialog", (d) => d.accept());
    await page.getByTestId("send-request").click();
    await page.getByRole("status").filter({ hasText: "Sent for signature." }).waitFor({ timeout: 20000 });
    check("browser: sending from the screen emails the first signer only", mailsTo(mail("one")).length === 1 && mailsTo(mail("two")).length === 0);
    await page.screenshot({ path: path.join(shots, "request-detail.png") });
    // ---- phone: the first signer fills the text field, draws a signature and signs
    const phone = await browser.newContext({ ...devices["iPhone 13"] }); await forward(phone);
    const mobile = await phone.newPage();
    await mobile.goto(`${SITE}/sign#t=${tokenIn(mailsTo(mail("one"))[0].text)}`);
    await mobile.locator("[data-pdf-page='1'] canvas").waitFor({ timeout: 30000 });
    check("phone: the document opens with no sideways scrolling", await noSideScroll(mobile));
    check("phone: the token is removed from the address bar", !mobile.url().includes("#t="));
    check("phone: the bottom bar asks for the missing field first", await mobile.getByRole("button", { name: /Fill in 1 field/ }).isVisible());
    await mobile.getByRole("button", { name: /Fill in 1 field/ }).tap();
    await mobile.locator("input[data-field]").fill("Student 4471");
    await mobile.getByRole("tab", { name: "Draw" }).tap();
    const pad = mobile.getByTestId("signature-pad"); await pad.scrollIntoViewIfNeeded(); const pb = await pad.boundingBox();
    await mobile.mouse.move(pb.x + 20, pb.y + pb.height / 2); await mobile.mouse.down();
    for (let x = 20; x < pb.width - 20; x += 12) await mobile.mouse.move(pb.x + x, pb.y + pb.height / 2 + Math.sin(x / 15) * 15);
    await mobile.mouse.up();
    await mobile.getByRole("checkbox", { name: /I have read this document/ }).check();
    await mobile.screenshot({ path: path.join(shots, "phone-before-sign.png"), fullPage: false });
    await mobile.getByRole("button", { name: "Sign document" }).last().tap();
    check("phone: the drawn signature is accepted", await mobile.getByText(/your signature is recorded/).waitFor({ timeout: 30000 }).then(() => true, () => false));
    check("phone: the record shows a drawn signature and the next signer is invited", psql(`select signature_kind from hr.sign_recipients where request_id = '${made.body.id}' and name = 'Una Phone';`) === "drawn" && (await (async () => { for (let i = 0; i < 40 && !mailsTo(mail("two")).length; i++) await new Promise((r) => setTimeout(r, 250)); return mailsTo(mail("two")).length; })()) === 1);
    // ---- phone: the second signer types and completes, then downloads
    const second = await phone.newPage();
    await second.goto(`${SITE}/sign#t=${tokenIn(mailsTo(mail("two"))[0].text)}`);
    await second.locator("[data-pdf-page='1'] canvas").waitFor({ timeout: 30000 });
    await second.getByRole("button", { name: "Go to signature" }).tap();
    await second.getByRole("checkbox", { name: /I have read this document/ }).check();
    await second.getByRole("button", { name: "Sign document" }).last().tap();
    check("phone: the last signature completes the document and offers the downloads", await second.getByTestId("download-signed").waitFor({ timeout: 30000 }).then(() => true, () => false) && await second.getByText("Download the completion certificate").isVisible());
    check("phone: still no sideways scrolling when complete", await noSideScroll(second));
    await second.screenshot({ path: path.join(shots, "phone-complete.png") });
    const download = await signedFile(await second.getByTestId("download-signed").getAttribute("href"));
    check("phone: the downloaded PDF is the recorded signed copy", nodeCrypto.createHash("sha256").update(Buffer.from(download)).digest("hex") === psql(`select signed_hash from hr.sign_requests where id = '${made.body.id}';`));
    // ---- the request on the dashboard as Completed
    await page.keyboard.press("Escape").catch(() => undefined); await page.goto(`${SITE}/admin/signing`); await page.getByTestId("status-signed").click(); await page.getByTestId("request-search").fill(run);
    check("browser: the dashboard lists it under Completed", await page.getByTestId("request-table").getByText(`UI agreement ${run}`).isVisible().catch(() => false));
    console.log(`Screenshots: ${shots}`);
  } finally {
    await browser.close(); vite.kill(); await stopMockPostmark();
  }
  console.log(failures ? `\n${failures} browser check(s) FAILED` : "\nAll browser signing checks passed.");
  process.exitCode = failures ? 1 : 0;
}



/** P09-01: the public assistant's knowledge, cache and index are bound to the verified public tenant (real functions, mock embeddings). */
async function assistant() {
  const lab = readLab();
  const run = Date.now().toString(36);
  const A = nodeCrypto.randomUUID(), B = nodeCrypto.randomUUID();
  const hostA = `p9a-${run}.lab.test`, hostB = `p9b-${run}.lab.test`, hostU = `p9u-${run}.lab.test`;
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  psql(`insert into public.tenants(id,slug,name,status) values(${q(A)},${q(`p9a-${run}`)},'P9 Lab Institute A','active'),(${q(B)},${q(`p9b-${run}`)},'P9 Lab Institute B','active');
insert into public.tenant_domains(hostname,tenant_id,verified_at,verification_evidence) values(${q(hostA)},${q(A)},now(),'lab'),(${q(hostB)},${q(B)},now(),'lab'),(${q(hostU)},${q(A)},null,null);
insert into public.public_assistant_faqs(question,normalized_question,answer,source_url,status,tenant_id) values
 ('What is the refund window?','what is the refund window','Alpha refunds within 7 days.','/refunds','published',${q(A)}),
 ('What is the refund window?','what is the refund window','Bravo refunds within 30 days.','/refunds','published',${q(B)});
insert into public.cms_courses(id,slug,code,name,fees,full_description,status,tenant_id) values
 (${q(`p9a-course-${run}`)},${q(`p9a-course-${run}`)},'P9LA1','Alpha Lab Diploma','AUD 11,111','Visitors gather at the north lawn beacon after the alarm.','Published',${q(A)}),
 (${q(`p9b-course-${run}`)},${q(`p9b-course-${run}`)},'P9LB1','Bravo Lab Certificate','AUD 22,222','Visitors gather at the east gate marker after the alarm.','Published',${q(B)}),
 (${q(`p9b-draft-${run}`)},${q(`p9b-draft-${run}`)},'P9LB2','Bravo Hidden Draft','AUD 1','Draft text.','Draft',${q(B)});
insert into public.cms_documents(id,name,url,status,assistant_publication_approved,bucket_name,storage_path,mime_type,file_size,tenant_id) values
 (${q(`p9b-borrowed-${run}`)},'Borrowed policy','/documents/borrowed','Published',true,'cms-media','policies/p9-borrowed.pdf','application/pdf',100,${q(B)});`);
  let ip = 0;
  const ask = async (question, { header, origin } = {}) => {
    const headers = { apikey: lab.anonKey, Authorization: `Bearer ${lab.anonKey}`, "Content-Type": "application/json", "x-forwarded-for": `203.0.113.${(++ip % 250) + 1}` };
    if (header) headers["x-tenant-domain"] = header;
    if (origin) headers.Origin = origin;
    const res = await fetch(`${lab.apiUrl}/functions/v1/public-assistant`, { method: "POST", headers, body: JSON.stringify({ question }) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const onA = { header: hostA, origin: `https://${hostA}` }, onB = { header: hostB, origin: `https://${hostB}` }, legacy = { origin: SITE };
  const text = (r) => JSON.stringify(r.body);

  // FAQ + cache: same question on two hosts; A first so that its answer is cached before B asks.
  const a1 = await ask("What is the refund window?", onA), b1 = await ask("What is the refund window?", onB), a2 = await ask("What is the refund window?", onA);
  check("assistant: tenant A host gets A's FAQ answer", a1.status === 200 && a1.body.answer === "Alpha refunds within 7 days." && a1.body.mode === "faq", text(a1));
  check("assistant: tenant B host asking the same question gets B's answer, not A's cached one", b1.status === 200 && b1.body.answer === "Bravo refunds within 30 days.", text(b1));
  check("assistant: A's cached answer is still A's", a2.body.answer === "Alpha refunds within 7 days.", text(a2));
  const cacheRows = psql(`select count(*) from public.public_assistant_answer_cache where tenant_id in (${q(A)},${q(B)})`);
  check("assistant: one cache row per tenant (two)", cacheRows === "2", cacheRows);
  const leg = await ask("What is the refund window?", legacy);
  check("assistant: the legacy site never answers from a tenant FAQ", leg.status === 200 && !/Alpha|Bravo/.test(text(leg)), text(leg));

  // Structured course answers name the tenant and list only its published courses.
  const listB = await ask("Which courses do you offer?", onB);
  check("assistant: B's course list is B's published courses only, under B's name", listB.status === 200 && /P9 Lab Institute B courses/.test(listB.body.answer)
    && listB.body.sources.some((s) => s.url === `/courses/p9b-course-${run}`) && !/Alpha Lab|Hidden Draft|SLIT/.test(text(listB)), text(listB));
  const feeA = await ask("What are the fees for P9LB1?", onA);
  check("assistant: A cannot read B's course by code", feeA.status === 200 && !/22,222|Bravo/.test(text(feeA)), text(feeA));

  // Host checks: spoofed header, unverified and unknown hosts fail closed; no fallback to another institution.
  const spoof = await ask("What is the refund window?", { header: hostA, origin: `https://${hostB}` });
  check("assistant: a tenant header that disagrees with the browser Origin is refused (403)", spoof.status === 403 && spoof.body.code === "tenant_origin_mismatch", text(spoof));
  const spoofLegacy = await ask("What is the refund window?", { header: hostA, origin: SITE });
  check("assistant: a tenant header sent from the legacy site is refused (403)", spoofLegacy.status === 403, text(spoofLegacy));
  const unverified = await ask("What is the refund window?", { header: hostU, origin: `https://${hostU}` });
  check("assistant: an unverified domain gets no answer (404)", unverified.status === 404 && unverified.body.code === "tenant_unavailable" && !/Alpha/.test(text(unverified)), text(unverified));
  const unknown = await ask("What is the refund window?", { origin: `https://unknown-${run}.lab.test` });
  check("assistant: an unknown host without a header is not answered from the legacy site (404)", unknown.status === 404, text(unknown));
  const usage = psql(`select count(*) from public.public_assistant_usage_events where tenant_id=${q(B)} and kind='retrieval'`);
  check("assistant: B's usage is recorded against B", Number(usage) >= 2, usage);

  // Index worker: drain the queue, then retrieval by meaning stays inside each tenant.
  const embeddingsBefore = reader.embeddings;
  for (let i = 0; i < 300; i++) {
    const res = await fetch(`${lab.apiUrl}/functions/v1/public-assistant-index`, { method: "POST", headers: { apikey: lab.anonKey, Authorization: `Bearer ${lab.serviceKey}`, "x-worker-secret": LAB_SECRETS.PUBLIC_ASSISTANT_WORKER_SECRET } });
    const body = await res.json().catch(() => ({}));
    if (body.processed === false && !body.stale) break;
  }
  const indexed = psql(`select string_agg(source_key||':'||coalesce(tenant_id::text,'legacy'),',' order by source_key) from public.public_assistant_sources where publication_status='published' and source_key like 'p9%${run}'`);
  check("assistant: the worker indexed A's and B's published courses under their own tenants (drafts not indexed)",
    indexed === `p9a-course-${run}:${A},p9b-course-${run}:${B}`, indexed);
  check("assistant: indexing used the mock embeddings only", reader.embeddings > embeddingsBefore, String(reader.embeddings));
  const borrowed = psql(`select state||':'||coalesce(error,'') from public.public_assistant_index_jobs where source_key=${q(`p9b-borrowed-${run}`)} order by created_at desc limit 1`);
  check("assistant: B's document pointing at the legacy institution's media is refused and never indexed", /untrusted_document_location/.test(borrowed)
    && psql(`select count(*) from public.public_assistant_sources where source_key=${q(`p9b-borrowed-${run}`)}`) === "0", borrowed);
  let privateRefused = false;
  try { psql(`insert into public.cms_documents(id,name,status,assistant_publication_approved,bucket_name,storage_path,tenant_id) values(${q(`p9b-private-${run}`)},'x','Published',true,'enrollment-documents',${q(`${B}/x.pdf`)},${q(B)})`); } catch { privateRefused = true; }
  check("assistant: a public document row cannot point at the private student bucket", privateRefused);
  const whereB = await ask("Where do visitors gather after the alarm?", onB), whereA = await ask("Where do visitors gather after the alarm?", onA), whereL = await ask("Where do visitors gather after the alarm?", legacy);
  check("assistant: B's retrieval answer comes from B's indexed course only", whereB.status === 200 && whereB.body.mode === "retrieval" && /east gate/.test(whereB.body.answer) && !/north lawn/.test(text(whereB)), text(whereB));
  check("assistant: A's retrieval answer comes from A's indexed course only", whereA.status === 200 && /north lawn/.test(whereA.body.answer) && !/east gate/.test(text(whereA)), text(whereA));
  check("assistant: the legacy site retrieves neither tenant", whereL.status === 200 && !/north lawn|east gate/.test(text(whereL)), text(whereL));

  // Unpublish: B's course leaves B's answers (cache invalidated by the CMS change).
  psql(`update public.cms_courses set status='Draft' where id=${q(`p9b-course-${run}`)}`);
  const afterB = await ask("Where do visitors gather after the alarm?", onB);
  check("assistant: unpublishing B's course removes it from B's answers", afterB.status === 200 && !/east gate/.test(text(afterB)), text(afterB));
  process.exitCode = failures ? 1 : 0;
}

function sqlSuites() {
  const dir = path.join(REPO, "supabase", "tests");
  psql("create extension if not exists pgtap with schema extensions;");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const res = spawnSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-q", "-At"], { input: fs.readFileSync(path.join(dir, file), "utf8"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const out = `${res.stdout}${res.stderr}`;
    const plan = out.match(/^1\.\.(\d+)/m)?.[1] ?? "?";
    const okCount = (out.match(/^ok /gm) ?? []).length;
    const bad = (out.match(/^not ok /gm) ?? []).length;
    const errors = (out.match(/^(psql:.*)?ERROR:/gm) ?? []).length;
    console.log(`${bad || errors || String(okCount) !== plan ? "FAIL" : "PASS"} ${file}: ${okCount}/${plan}${bad ? `, ${bad} not ok` : ""}${errors ? `, ${errors} errors` : ""}`);
    if (bad || errors || String(okCount) !== plan) { failures++; for (const line of out.split(/\r?\n/).filter((l) => /^not ok|ERROR/.test(l)).slice(0, 5)) console.log(`     ${line}`); }
  }
}

const command = process.argv[2] ?? "up";
try {
  if (["apply", "onboard", "emails", "offer", "activate", "retention", "flow", "wizard", "e2e"].includes(command)) { await startMockPostmark(); await startMockReader(); await startMockGeoscape(); }
  if (command === "assistant") await startMockReader();
  if (command === "holidays") await startMockHolidaySources();
  if (command === "up") await up();
  else if (command === "apply") await apply();
  else if (command === "onboard") await onboard();
  else if (command === "emails") await emails();
  else if (command === "offer") await offer();
  else if (command === "activate") await activate();
  else if (command === "retention") await retention();
  else if (command === "holidays") await holidays();
  else if (command === "flow") await flow();
  else if (command === "wizard") await wizard();
  else if (command === "signing") await signing();
  else if (command === "signing-browser") await signingBrowser();
  else if (command === "e2e") {
    const lab = readLab();
    const env = { ...process.env, E2E_SUPABASE_URL: lab.apiUrl, E2E_SUPABASE_ANON_KEY: lab.anonKey, E2E_SUPABASE_SERVICE_KEY: lab.serviceKey, E2E_MAIL_URL: lab.mailUrl,
      E2E_DB_CONTAINER: DB_CONTAINER, E2E_POSTMARK_MOCK_URL: `http://127.0.0.1:${MOCK_POSTMARK_PORT}` };
    const pw = await new Promise((resolve) => { const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["playwright", "test", ...process.argv.slice(3)], { cwd: REPO, env, stdio: "inherit", shell: process.platform === "win32" }); child.on("exit", (code) => resolve(code ?? 1)); });
    if (pw !== 0) failures++;
  }
  else if (command === "assistant") await assistant();
  else if (command === "sql") sqlSuites();
  else if (command === "down") { const r = supabase(["stop", "--no-backup"]); console.log(r.code === 0 ? "Lab stopped." : r.out); }
  else throw new Error(`unknown command ${command} (up | apply | onboard | emails | offer | activate | retention | holidays | flow | wizard | e2e | sql | down)`);
} catch (error) {
  console.error(`ERROR ${error instanceof Error ? error.message : error}`);
  await stopMockPostmark(); await stopMockReader(); await stopMockGeoscape(); await stopMockHolidaySources();
  process.exit(2);
}
await stopMockPostmark(); await stopMockReader(); await stopMockGeoscape(); await stopMockHolidaySources();
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
