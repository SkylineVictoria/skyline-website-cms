#!/usr/bin/env node
// HR-02 staff enrolment lab: a FRESH, separate local Supabase stack (project "skyline-staff-lab", ports 57320-57329) built from
// the repo's migrations (all of them, including 20261109100000) and Edge Functions, with the local mail inbox and the Turnstile
// mock. Re-runnable: `up` always throws the previous lab stack away first. Nothing here talks to a hosted project.
//
//   node scripts/lab/staff-lab.mjs up       fresh stack + migrations + functions served (prints the URLs and keys file)
//   node scripts/lab/staff-lab.mjs apply    end-to-end checks of the public staff application (HR-02b)
//   node scripts/lab/staff-lab.mjs onboard  end-to-end checks of onboarding by link (HR-02c)
//   node scripts/lab/staff-lab.mjs emails   end-to-end checks of HR email: outbox, invite links, failures, retry (HR-02d)
//   node scripts/lab/staff-lab.mjs offer    end-to-end checks of the offer: upload checks, send, view, sign, signed PDF emailed (HR-02e)
//   node scripts/lab/staff-lab.mjs sql      runs every supabase/tests/*.sql suite on the lab database
//   node scripts/lab/staff-lab.mjs down     stops the lab stack (no backup)
//
// Work files live in the OS temp dir (never the repo). The repo's migrations do not replay on a fresh stack because a few objects
// exist only on hosted; LAB_SHIMS below creates minimal stand-ins for them (lab only, see OPS-01 for the real fix).
// Secrets: only the local stack's own demo keys are used; supabase/functions/.env is never copied.
// Email: the functions send through the Postmark adapter, redirected (local only, EF_POSTMARK_API_URL) to a mock Postmark server
// that this script runs on port 57390 while a check command runs; nothing reaches Postmark.
// Document reading: staff-onboarding's reader calls OpenAI, redirected (local only, EF_OPENAI_API_URL) to a mock on port 57391
// that answers a fixed passport (name, middle name, date of birth); nothing reaches OpenAI.
import http from "node:http";
import { spawnSync } from "node:child_process";
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
const LAB_SECRETS = {
  EF_CAPTCHA_SECRET_KEY: "local-mock",
  EF_NOTIFICATION_EMAIL_ENABLED: "true",
  EF_POSTMARK_SERVER_TOKEN: "lab-postmark-token",
  EF_POSTMARK_API_URL: `http://host.docker.internal:${MOCK_POSTMARK_PORT}`,
  EF_HR_EMAIL_FROM: "Skyline HR <hr@lab.example.test>",
  EF_HR_ADMIN_NOTIFY_TO: "hr.one@lab.example.test, hr.two@lab.example.test",
  EF_HR_PUBLIC_SITE_URL: "http://127.0.0.1:57330",
  OPENAI_API_KEY: "lab-openai-key",
  OPENAI_DOCUMENT_MODEL: "lab-reader",
  EF_OPENAI_API_URL: `http://host.docker.internal:${MOCK_OPENAI_PORT}`,
};
/** What the mock reader "reads" from every passport. */
const MOCK_PASSPORT = { first_name: "PASSPORT", middle_name: "Mock", last_name: "READER", dob: "1985-02-03", passport_number: "PA1234567", passport_expiry: "2033-01-01" };
const EXCLUDE = "studio,imgproxy,logflare,vector,supavisor,realtime,postgres-meta";

// LAB ONLY stand-ins for hosted state the repo cannot replay (file name = position in the migration order). Never shipped.
const LAB_SHIMS = {
  // 20261102094611 references public.student_profiles(id), a hosted table that no repo migration creates.
  "00000000000000_lab_shim_student_profiles.sql":
    "create table if not exists public.student_profiles (id uuid primary key default gen_random_uuid());\n",
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
  for (const file of fs.readdirSync(path.join(REPO, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    fs.copyFileSync(path.join(REPO, "supabase", "migrations", file), path.join(migrations, file));
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
        const token = req.headers["x-postmark-server-token"];
        if (req.url !== "/email" || token !== LAB_SECRETS.EF_POSTMARK_SERVER_TOKEN) { res.writeHead(401); return res.end("{}"); }
        if (postmark.mode === "down") { res.writeHead(503); return res.end("{}"); }
        postmark.messages.push({ to: body.To, from: body.From, subject: body.Subject, text: body.TextBody, attachments: body.Attachments ?? [], mode: postmark.mode });
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
// follows the adapter. A passport gets MOCK_PASSPORT; any other category answers with no fields.
const reader = { calls: 0, server: null };
function startMockReader() {
  return new Promise((resolve, reject) => {
    reader.server = http.createServer((req, res) => {
      const parts = [];
      req.on("data", (c) => parts.push(c));
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { /* keep {} */ }
        if (req.url !== "/v1/responses" || req.headers.authorization !== `Bearer ${LAB_SECRETS.OPENAI_API_KEY}`) { res.writeHead(401); return res.end("{}"); }
        reader.calls++;
        const names = body.text?.format?.schema?.properties?.fields?.required ?? [];
        const category = (String(body.instructions ?? "").match(/in this (.+?) document\./) ?? [])[1] ?? "Other";
        const fields = Object.fromEntries(names.map((n) => [n, category === "Passport" ? (MOCK_PASSPORT[n] ?? null) : null]));
        const result = { document_type: category, category_mismatch: false, fields, evidence: [] };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `resp_lab_${reader.calls}`, output_text: JSON.stringify(result), usage: {} }));
      });
    });
    reader.server.on("error", reject);
    reader.server.listen(MOCK_OPENAI_PORT, "0.0.0.0", () => resolve());
  });
}
const stopMockReader = () => new Promise((r) => (reader.server ? reader.server.close(() => r()) : r()));
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
async function onboardCall(lab, body, file) {
  let init;
  if (file) {
    const form = new FormData();
    for (const [k, v] of Object.entries(body)) form.set(k, String(v ?? ""));
    form.set("file", file.blob, file.name);
    init = { method: "POST", body: form, headers: { apikey: lab.anonKey } };
  } else {
    init = { method: "POST", body: JSON.stringify(body), headers: { apikey: lab.anonKey, "content-type": "application/json" } };
  }
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
    address_country: "Australia", emergency_name: "Em", emergency_relationship: "Sibling", emergency_phone: "0422 333 444", is_australian_citizen: false };
  const saved = await onboardCall(lab, { action: "save", t: link.token, patch: details });
  check("personal details save through the link", saved.status === 200 && saved.body.view?.profile?.emergency_phone_e164 === "+61422333444", JSON.stringify(saved.body).slice(0, 200));

  const pdf = (name) => ({ blob: new Blob([PDF], { type: "application/pdf" }), name });
  const png = { blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], { type: "image/png" }), name: "results.png" };
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
  check("a visa without an expiry date is refused and its file removed", noExpiry.status === 400
    && psql(`select count(*) from storage.objects where bucket_id = 'staff-documents' and name like '${person.id}/visa/%';`) === "1", JSON.stringify(noExpiry.body));

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
  const prePassport = await onboardCall(lab, { action: "upload", t: preLink.token, category: "Passport", expiryDate: future(6) }, pdf("my-passport.pdf"));
  const preDoc = psql(`select id from hr.staff_documents where profile_id = '${pre.id}' and category = 'Passport' and is_current;`);
  const preReading = await readingDone(preDoc);
  const preView = await onboardCall(lab, { action: "open", t: preLink.token });
  const readDoc = preView.body.view?.documents?.find((d) => d.id === preDoc);
  check("prefill through the link: the passport fills date of birth and middle name", prePassport.status === 200 && preReading === "done" && reader.calls > before
    && psql(`select date_of_birth || '|' || middle_name from hr.staff_profiles where id = '${pre.id}';`) === "1985-02-03|Mock", `${preReading} ${psql(`select date_of_birth || '|' || middle_name from hr.staff_profiles where id = '${pre.id}';`)}`);
  check("...the read first/last name and date of birth reach the onboarding page, and the applied name is kept", readDoc?.extracted?.first_name === "PASSPORT" && readDoc?.extracted?.last_name === "READER"
    && readDoc?.extracted?.dob === "1985-02-03" && psql(`select first_name || '|' || last_name from hr.staff_profiles where id = '${pre.id}';`) === "Lab|prefill", JSON.stringify(readDoc?.extracted ?? {}).slice(0, 200));
  const callsBefore = reader.calls;
  const foreignRead = await onboardCall(lab, { action: "extract", t: preLink.token, id: otherId });
  check("another person's document cannot be read with this link (nothing sent to the reader)", foreignRead.status >= 400 && foreignRead.status < 500 && reader.calls === callsBefore, JSON.stringify(foreignRead.body));
  asAdmin(`select public.hr_admin_staff_invite_revoke('${pre.id}', 'documents');`);
  const revokedRead = await onboardCall(lab, { action: "extract", t: preLink.token, id: preDoc });
  check("a revoked link cannot start a reading", revokedRead.status === 403 && reader.calls === callsBefore, JSON.stringify(revokedRead.body));

  const academic = psql(`select id from hr.staff_documents where profile_id = '${person.id}' and category = 'Academic' and filename = 'transcript.pdf' and is_current;`);
  const removed = await onboardCall(lab, { action: "remove", t: link.token, id: academic });
  check("removing a file deletes it from storage", removed.status === 200 && psql(`select count(*) from storage.objects o join hr.staff_documents d on d.storage_path = o.name where d.id = '${academic}';`) === "0");

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
  const pdfFile = (name) => ({ blob: new Blob([PDF], { type: "application/pdf" }), name });
  const year = new Date().getFullYear();
  await onboardCall(lab, { action: "save", t: token, patch: { first_name: "Lab", last_name: "Mail", date_of_birth: "1990-05-06", address_street: "1 Lab St", address_country: "Australia",
    emergency_name: "Em", emergency_relationship: "Sibling", emergency_phone: "0422 333 444", is_australian_citizen: false } });
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
  if (["apply", "onboard", "emails", "offer"].includes(command)) { await startMockPostmark(); await startMockReader(); }
  if (command === "up") await up();
  else if (command === "apply") await apply();
  else if (command === "onboard") await onboard();
  else if (command === "emails") await emails();
  else if (command === "offer") await offer();
  else if (command === "sql") sqlSuites();
  else if (command === "down") { const r = supabase(["stop", "--no-backup"]); console.log(r.code === 0 ? "Lab stopped." : r.out); }
  else throw new Error(`unknown command ${command} (up | apply | onboard | emails | offer | sql | down)`);
} catch (error) {
  console.error(`ERROR ${error instanceof Error ? error.message : error}`);
  await stopMockPostmark(); await stopMockReader();
  process.exit(2);
}
await stopMockPostmark(); await stopMockReader();
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
