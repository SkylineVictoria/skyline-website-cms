#!/usr/bin/env node
// MIGRATION-SYNC (owner, 2026-11-27): hosted's applied migration versions must equal the files in supabase/migrations.
// Every migration applied to hosted is committed to the repo in the same push, and nothing in the repo is left unapplied.
// Fails (exit 1) on any difference and lists it. Read-only: it only lists hosted's history.
//
//   SUPABASE_ACCESS_TOKEN=... node scripts/check-migration-sync.mjs        (CI: GitHub secret SUPABASE_ACCESS_TOKEN)
//   node scripts/check-migration-sync.mjs --hosted-file versions.json      (a saved list: [{version,name}] or {rows:[...]})
//
// Only the approved project is read (xcpydisstlvtvcsqnjob); never the Submissions project.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_REF = "xcpydisstlvtvcsqnjob";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "supabase", "migrations");

function repoVersions() {
  const out = new Map();
  const problems = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const m = /^(\d{14}|\d{4})_(.+)\.sql$/.exec(file);
    if (!m) { problems.push(`not named <version>_<name>.sql (version: 14 digits, or the 4-digit 0001-0013 of the first release): ${file}`); continue; }
    if (out.has(m[1])) problems.push(`two files share version ${m[1]}: ${out.get(m[1])} and ${file}`);
    else out.set(m[1], file);
  }
  return { out, problems };
}

async function hostedVersions() {
  const i = process.argv.indexOf("--hosted-file");
  if (i > 0) {
    const j = JSON.parse(fs.readFileSync(process.argv[i + 1], "utf8"));
    return Array.isArray(j) ? j : j.rows;
  }
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is not set (GitHub › Settings › Secrets › Actions).");
  const base = `https://api.supabase.com/v1/projects/${PROJECT_REF}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const list = await fetch(`${base}/database/migrations`, { headers });
  if (list.ok) return await list.json();
  // Fallback: the same list through a read-only query.
  const q = await fetch(`${base}/database/query`, {
    method: "POST", headers,
    body: JSON.stringify({ query: "select version, name from supabase_migrations.schema_migrations order by version", read_only: true }),
  });
  if (!q.ok) throw new Error(`could not read hosted's migration history: ${list.status} / ${q.status} ${await q.text()}`);
  return await q.json();
}

const { out: repo, problems } = repoVersions();
let hosted;
try { hosted = await hostedVersions(); } catch (e) { console.error(`Migration sync: ${e.message}`); process.exit(2); }
const hostedMap = new Map(hosted.map((r) => [String(r.version), r.name ?? ""]));

const hostedOnly = [...hostedMap].filter(([v]) => !repo.has(v));
const repoOnly = [...repo].filter(([v]) => !hostedMap.has(v));

console.log(`Migration sync: hosted ${hostedMap.size} versions, repo ${repo.size} files.`);
for (const p of problems) console.log(`  REPO: ${p}`);
for (const [v, n] of hostedOnly) console.log(`  HOSTED ONLY (applied on hosted, no file in supabase/migrations): ${v}_${n}`);
for (const [, f] of repoOnly) console.log(`  REPO ONLY (file not applied / not recorded on hosted): ${f}`);
if (problems.length || hostedOnly.length || repoOnly.length) {
  console.log("FAIL: commit every migration hosted ran (same version, the SQL hosted ran), and apply + record every repo migration, in the same push.");
  process.exit(1);
}
console.log("PASS: every hosted version has its file and every file is on hosted.");
