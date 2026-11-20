import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const manifest = JSON.parse(readFileSync(new URL("./business-rules-registry.json", import.meta.url), "utf8"));
const classified = JSON.parse(readFileSync(new URL("./business-rules-classifications.json", import.meta.url), "utf8"));
const exceptions = new Map();
for (const entry of classified) {
  if (!["business", "technical", "security", "regulatory"].includes(entry.type) || entry.reason.length < 12) {
    throw new Error("Every classification requires a reason and a supported type.");
  }
  if (entry.type === "business" && !Object.hasOwn(manifest, entry.id)) {
    throw new Error(`Unknown classified business rule ${entry.id}.`);
  }
  if (entry.type === "regulatory" && !entry.source?.startsWith("https://")) {
    throw new Error("A regulatory exception requires an authoritative HTTPS source.");
  }
  for (const fingerprint of entry.fingerprints) exceptions.set(fingerprint, entry);
}
let errors = 0;
function fail(message) {
  console.error(message);
  errors++;
}

for (const [id, item] of Object.entries(manifest)) {
  const registration = readFileSync(item.migration, "utf8");
  const enforcement = readFileSync(item.enforcement, "utf8");
  const test = readFileSync(item.test, "utf8");
  if (!registration.includes(id) || !registration.includes(item.menu) || !/\bbusiness_rule_register\(/.test(registration)) {
    fail(`${id}: add the menu and stable identifier to the database registration migration.`);
  }
  if (!enforcement.includes(id) || !/\bbusiness_rule_evaluate\(/.test(enforcement)) {
    fail(`${id}: wire server-side enforcement to the centralized evaluator.`);
  }
  if (!test.includes(id)) fail(`${id}: add an executable workflow regression test.`);
}

const compare = process.argv[2];
if (!compare) {
  fail("Pass a trusted Git base ref to scan added lines.");
} else {
  const patch = git("diff", "--no-color", "--unified=0", "--no-ext-diff", compare, "--", "src", "supabase/functions", "supabase/migrations", "api", "server", "ocr-service", "scripts", "vercel.json");
  const changes = new Map();
  let file = "";
  let line = 0;
  for (const text of patch.split("\n")) {
    if (text.startsWith("+++ b/")) file = text.slice(6);
    else if (text.startsWith("@@")) line = Number(text.match(/\+(\d+)/)?.[1] ?? 0);
    else if (text.startsWith("+") && !text.startsWith("+++")) {
      if (!changes.has(file)) changes.set(file, []);
      changes.get(file).push({ line, text: text.slice(1) });
      line++;
    }
  }

  const term = /(?:policy|threshold|deadline|(?:min|max)[_A-Z]|capacit|eligible|eligibility|require(?:d|s|ment)|allow(?:ed)?[_A-Z]|default|approv|refund|deposit|due[_A-Z]|days|hours|weeks|remind|attendance|enrol|status|stage|transition|price|commission|install?ment|schedule|limit)/i;
  const literal = /(?:\d+(?:\.\d+)?|\b(?:true|false)\b|["'`][^"'`]+["'`])/;
  const branch = /(?:\bif\b|\bcase\b|\bwhen\b|\bconst\b|\bdefault\b|\bcheck\b|[?:=<>]|\.includes\()/i;
  const classification = /(?:\/\/|--)\s*rule-policy:\s*(business|technical|security|regulatory)\s+(\S+)\s+(.{12,})$/;
  for (const [path, added] of changes) {
    if (!/\.(?:[cm]?[jt]sx?|sql|py|json|ya?ml)$/.test(path) || /(?:^|\/)(?:tests?|[^/]+_test\.[^/]+|test-[^/]+|check-business-rules\.mjs|business-rules-(?:registry|classifications)\.json)(?:\/|$)/.test(path)) continue;
    const allLines = readFileSync(path, "utf8").split("\n");
    for (const { line: number, text } of added) {
      const candidate = text.trim();
      if (!candidate || /^(?:import\b|\/\/|--|\/\*|\*)/.test(candidate) || !term.test(candidate) || !literal.test(candidate) || !branch.test(candidate)) continue;
      const tag = allLines.slice(Math.max(0, number - 3), number).reverse().map(line => line.match(classification)).find(Boolean);
      const fingerprint = createHash("sha256").update(path + "\n" + candidate).digest("hex");
      if (exceptions.has(fingerprint)) continue;
      if (!tag) {
        fail(`${path}:${number}: classify this possible operational rule with a rule-policy annotation.`);
      } else if (tag[1] === "regulatory" && !/https:\/\//.test(tag[3])) {
        fail(`${path}:${number}: regulatory classification requires an authoritative HTTPS source.`);
      } else if (tag[1] === "business" && !Object.hasOwn(manifest, tag[2])) {
        fail(`${path}:${number}: business rule ${tag[2]} is missing from the registry manifest.`);
      }
    }
  }
}
if (errors) process.exitCode = 1;
else console.log(`Business Rules check passed (${Object.keys(manifest).length} registered rule identifiers).`);
