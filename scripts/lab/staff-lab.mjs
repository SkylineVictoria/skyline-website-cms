#!/usr/bin/env node
// HR-02 staff enrolment lab: a FRESH, separate local Supabase stack (project "skyline-staff-lab", ports 57320-57329) built from
// the repo's migrations (all of them, including 20261109100000) and Edge Functions, with the local mail inbox and the Turnstile
// mock. Re-runnable: `up` always throws the previous lab stack away first. Nothing here talks to a hosted project.
//
//   node scripts/lab/staff-lab.mjs up       fresh stack + migrations + functions served (prints the URLs and keys file)
//   node scripts/lab/staff-lab.mjs apply    end-to-end checks of the public staff application (HR-02b)
//   node scripts/lab/staff-lab.mjs onboard  end-to-end checks of onboarding by link (HR-02c)
//   node scripts/lab/staff-lab.mjs sql      runs every supabase/tests/*.sql suite on the lab database
//   node scripts/lab/staff-lab.mjs down     stops the lab stack (no backup)
//
// Work files live in the OS temp dir (never the repo). The repo's migrations do not replay on a fresh stack because a few objects
// exist only on hosted; LAB_SHIMS below creates minimal stand-ins for them (lab only, see OPS-01 for the real fix).
// Secrets: only the local stack's own demo keys are used; supabase/functions/.env is never copied.
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
const LAB_SECRETS = { EF_CAPTCHA_SECRET_KEY: "local-mock", EF_NOTIFICATION_EMAIL_ENABLED: "false" };
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
  check("received (applicant) and new application (admin) emails are queued",
    psql(`select string_agg(e.kind || ':' || e.state, ',' order by e.id) from hr.staff_emails e join hr.staff_profiles p on p.id = e.profile_id where p.email = '${email}';`) === "application_received:queued,admin_new_application:queued");
  const anonRead = await fetch(`${lab.apiUrl}/storage/v1/object/staff-documents/${row[3]}`, { headers: { apikey: lab.anonKey, Authorization: `Bearer ${lab.anonKey}` } });
  check("the resume cannot be read anonymously", anonRead.status >= 400, String(anonRead.status));

  const again = await postApply(lab, { ...base, firstName: "Again", __ip: "198.51.100.3" }, pdf);
  check("the same email again gets the same thank-you", again.status === 200 && again.body.ok === true, JSON.stringify(again.body));
  check("...and nothing new is stored", psql(`select count(*) from hr.staff_emails e join hr.staff_profiles p on p.id = e.profile_id where p.email = '${email}';`) === "2"
    && psql(`select first_name from hr.staff_profiles where email = '${email}';`) === "Lab");

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

/* ------------------------------------------------------------------ helpers shared by the HR-02c..f checks */

const LAB_ADMIN = { id: "1ab00000-0000-4000-8000-0000000000a1", email: "lab.admin@example.test" };
/** A CMS Admin in the lab database (idempotent), so admin RPCs run with a real admin JWT claim. */
function ensureLabAdmin() {
  psql(`insert into auth.users(id, email, email_confirmed_at, aud, role, raw_user_meta_data) values ('${LAB_ADMIN.id}', '${LAB_ADMIN.email}', now(), 'authenticated', 'authenticated', '{}') on conflict (id) do nothing;
insert into public.cms_users(id, name, email, role, status, auth_user_id, must_change_password) values ('lab-admin', 'Lab Admin', '${LAB_ADMIN.email}', 'Admin', 'Active', '${LAB_ADMIN.id}', false) on conflict (id) do nothing;`);
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
  ensureLabAdmin();
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

  // The reader runs after the response; without provider settings it records "unavailable" (manual entry continues).
  let reading = "";
  for (let i = 0; i < 20 && !["unavailable", "failed", "done", "no_fields"].includes(reading); i++) {
    await new Promise((r) => setTimeout(r, 500));
    reading = psql(`select extraction_status from hr.staff_documents where id = '${passportId}';`);
  }
  check("the passport reading ran after the upload (no provider in the lab: 'unavailable')", reading === "unavailable", reading);

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
  if (command === "up") await up();
  else if (command === "apply") await apply();
  else if (command === "onboard") await onboard();
  else if (command === "sql") sqlSuites();
  else if (command === "down") { const r = supabase(["stop", "--no-backup"]); console.log(r.code === 0 ? "Lab stopped." : r.out); }
  else throw new Error(`unknown command ${command} (up | apply | onboard | sql | down)`);
} catch (error) {
  console.error(`ERROR ${error instanceof Error ? error.message : error}`);
  process.exit(2);
}
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
