// Hosted guard for every test, lab, reset and seed script.
//
// Test, lab, reset and seed scripts only ever run against a local stack. refuseHosted() stops the script before it does anything
// when its environment or its command line points at a hosted Supabase project, unless the explicit --allow-hosted flag is passed
// (the flag is removed from process.argv so the script's own parser never sees it). The Submissions project
// (qoylrmorezlqdvufonmx) is refused even with the flag.
//
// Use in a script:      import { refuseHosted } from "./lab/hosted-guard.mjs"; refuseHosted("test:my-suite");
// Guard a spawned CLI:  assertLocalCommand("npx", ["supabase", "db", "reset"]) throws on --linked / --remote / --db-url / a hosted URL.
// Wrap an npm script:   node scripts/lab/hosted-guard.mjs [--allow-hosted] -- npx supabase test db supabase/tests/x.sql
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HOSTED_PROJECT = "xcpydisstlvtvcsqnjob";
export const FORBIDDEN_PROJECT = "qoylrmorezlqdvufonmx";
const HOSTED_PATTERN = /supabase\.(co|in|com)\b|pooler\.supabase|xcpydisstlvtvcsqnjob|qoylrmorezlqdvufonmx/i;
// CLI flags that make the Supabase CLI (or psql) talk to a remote database instead of the local stack.
const REMOTE_FLAGS = /^--(linked|remote|db-url|project-ref)(=|$)/;
const ENV_NAME = /(^|_)(URL|URI|DSN|HOST|PGHOST|DATABASE_URL|PROJECT_REF|PROJECT_ID)$/;

/** Names of environment variables whose value points at a hosted project. */
export function hostedEnv(env = process.env) {
  return Object.entries(env).filter(([name, value]) => value && ENV_NAME.test(name) && HOSTED_PATTERN.test(value)).map(([name]) => name);
}

/** Reasons a command line points at a hosted project (empty when it is local). */
export function hostedArgs(args) {
  const reasons = [];
  for (const arg of args.map(String)) {
    if (REMOTE_FLAGS.test(arg)) reasons.push(arg.split("=")[0]);
    else if (HOSTED_PATTERN.test(arg)) reasons.push("a hosted address in the arguments");
  }
  return reasons;
}

function allowFlag(argv) {
  const i = argv.indexOf("--allow-hosted");
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}

function fail(label, reasons, allowed) {
  const forbidden = reasons.some((r) => /qoylrmorezlqdvufonmx/i.test(r));
  const text = `${label}: refusing to run against a hosted Supabase project (${[...new Set(reasons)].join(", ")}).`;
  if (forbidden) throw new Error(`${text} The Submissions project is never touched.`);
  if (!allowed) throw new Error(`${text} Test, lab, reset and seed scripts run against a local stack only; pass --allow-hosted to override.`);
  console.warn(`${label}: --allow-hosted given; continuing against a hosted target (${[...new Set(reasons)].join(", ")}).`);
}

/** Stop the current script when its environment or argv points at a hosted project, unless --allow-hosted is passed. */
export function refuseHosted(label = "script", { argv = process.argv, env = process.env } = {}) {
  const allowed = allowFlag(argv);
  const envHits = hostedEnv(env);
  const reasons = [...envHits.map((n) => `${n}=${/qoylrmorezlqdvufonmx/i.test(env[n]) ? FORBIDDEN_PROJECT : "hosted"}`), ...hostedArgs(argv.slice(2))];
  if (reasons.length) fail(label, reasons, allowed);
  if (allowed) process.env.SKYLINE_ALLOW_HOSTED = "1";
  return allowed;
}

/** Throw before spawning a command whose arguments point at a hosted project (unless the script was started with --allow-hosted). */
export function assertLocalCommand(bin, args, label = "script") {
  const reasons = hostedArgs([bin, ...args]);
  if (reasons.length) fail(`${label} (${[bin, ...args.slice(0, 3)].join(" ")})`, reasons, process.env.SKYLINE_ALLOW_HOSTED === "1");
}

// CLI wrapper: node scripts/lab/hosted-guard.mjs [--allow-hosted] -- <command> [args...]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = [...process.argv];
  const sep = argv.indexOf("--");
  const command = sep >= 0 ? argv.splice(sep).slice(1) : [];
  // `npm run x -- --allow-hosted` lands after the wrapped command: take it from there too, never pass it on.
  if (allowFlag(command)) argv.push("--allow-hosted");
  try {
    refuseHosted("hosted-guard", { argv });
    if (command.length) assertLocalCommand(command[0], command.slice(1), "hosted-guard");
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (command.length) {
    const res = spawnSync(command[0], command.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
    process.exit(res.status ?? 1);
  }
}
