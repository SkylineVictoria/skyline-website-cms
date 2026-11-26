#!/usr/bin/env node
// AVETMISS compliance gate (CI, no database): node scripts/check-avetmiss.mjs <base-commit>
// Fails when a change (1) drops or disables an AVETMISS guard (trigger, constraint or avetmiss_* function) without the line
// comment `-- avetmiss-reviewed: <reason>`, or (2) adds a column to a NAT source table without changing an AVETMISS test suite
// (supabase/tests/avetmiss_*.sql). Rules: CLAUDE.md "AVETMISS compliance" and docs/compliance/AVETMISS.md.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const base = process.argv[2] || "HEAD^";
const changed = execFileSync("git", ["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`], { encoding: "utf8" })
  .split("\n").filter(Boolean);
const migrations = changed.filter((f) => /^supabase\/migrations\/.*\.sql$/.test(f));
const testsChanged = changed.some((f) => /^supabase\/tests\/avetmiss_.*\.sql$/.test(f));
const NAT_TABLES = /alter\s+table\s+(if\s+exists\s+)?(public\.)?(enrollment_students|enrollment_applications|intake_enrolments|lms_unit_students|cms_course_units|cms_courses|locations|course_completions|student_disabilities|student_prior_education|cms_settings)\b[^;]*\badd\s+column/i;
const WEAKEN = /(drop\s+trigger|disable\s+trigger|drop\s+constraint|drop\s+function|drop\s+table)[^;\n]*avetmiss|disable\s+trigger\s+all/i;
const problems = [];
for (const file of migrations) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (WEAKEN.test(line) && !/--\s*avetmiss-reviewed:\s*\S/.test(line) && !/^\s*--/.test(line)) {
      // `drop ... if exists` immediately followed by its re-creation is the normal replace pattern.
      const next = lines.slice(i + 1, i + 4).join("\n");
      const name = line.match(/(trigger|constraint|function)\s+(if\s+exists\s+)?([\w.]+)/i)?.[3]?.split(".").pop();
      if (!(name && new RegExp(`create\\s+(or\\s+replace\\s+)?(constraint\\s+)?(trigger|function)?[^\\n]*\\b${name}\\b|add\\s+constraint\\s+${name}\\b`, "i").test(next)))
        problems.push(`${file}:${i + 1}: removes or disables an AVETMISS guard: ${line.trim()}`);
    }
  });
  const text = lines.join("\n");
  if (NAT_TABLES.test(text) && !testsChanged)
    problems.push(`${file}: adds a column to a NAT source table; add or update a case in supabase/tests/avetmiss_*.sql`);
}
if (problems.length) { console.error(`AVETMISS gate FAILED:\n${problems.join("\n")}`); process.exit(1); }
console.log(`AVETMISS gate passed (${migrations.length} migration file(s) checked against ${base}).`);
