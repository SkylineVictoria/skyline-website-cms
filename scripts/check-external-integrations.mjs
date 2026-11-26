// Run in CI to require a registry mapping or a reviewed exception for new dependencies.
// Existing findings are baselined separately so the check can detect growth without reclassifying legacy providers.
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(readFileSync(resolve(root, 'scripts/external-integrations-manifest.json'), 'utf8'));
const migrations = readdirSync(resolve(root, 'supabase/migrations')).filter(name => name.endsWith('.sql'))
  .map(name => readFileSync(resolve(root, 'supabase/migrations', name), 'utf8'))
  .filter(sql => /insert\s+into\s+public\.integration_definitions\b/i.test(sql)).join('\n');

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /(?<![._-](?:test|spec))\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

function dependencies(path) {
  const source = readFileSync(path, 'utf8');
  const hosts = [...source.matchAll(/https?:\/\/([a-z\d-]+(?:\.[a-z\d-]+)+)(?=[:/\s'"\x60?]|$)/gi)]
    .map(match => `host:${match[1].toLowerCase()}`);
  const credentials = [...source.matchAll(/\b(?:EF_|VITE_|[A-Z]+_)[A-Z0-9_]*(?:_API_KEY|_ACCESS_TOKEN|_SERVER_TOKEN|_CLIENT_SECRET|_USERNAME|_PASSWORD|_GUID|_WEBHOOK_URL|_SERVICE_URL|_BASE_URL|_API_URL|_SECRET_KEY|_SITE_KEY|_GEOSCAPE_KEY)\b/g)]
    .map(match => `env:${match[0]}`);
  const imports = [...source.matchAll(/\b(?:from\s*|import\s*\(\s*)['"]((?:npm:)?(?:@[\w.-]+\/)?[\w.-]+)(?=@|\/|['"])/g)]
    .map(match => match[1].replace(/^npm:/, ''))
    .filter(name => name !== '@' && !name.startsWith('.') && /(?:api|auth|sdk|stripe|supabase|openai|soap|google|azure|twilio|docusign|sentry|^@aws-sdk)/i.test(name))
    .map(name => `sdk:${name}`);
  return new Set([...hosts, ...credentials, ...imports]);
}

const locations = new Map();
for (const path of [resolve(root, 'src'), resolve(root, 'supabase/functions')].flatMap(sourceFiles)) {
  for (const dependency of dependencies(path)) {
    if (!locations.has(dependency)) locations.set(dependency, relative(root, path));
  }
}

const known = new Set([...Object.keys(manifest.legacy), ...Object.keys(manifest.exceptions)]);
let failed = false;
for (const [id, indicators] of Object.entries(manifest.providers)) {
  if (!migrations.includes(`('${id}'`)) {
    console.error(`Provider ${id} has no version-controlled registration.`);
    failed = true;
  }
  for (const indicator of indicators) known.add(indicator);
}

const unknown = [...locations.entries()].filter(([key]) => !known.has(key)).sort(([a], [b]) => a.localeCompare(b));
if (process.argv.includes('--inventory')) {
  for (const [key, path] of unknown) console.log(`${key}\t${path}`);
} else if (unknown.length || failed) {
  for (const [key, path] of unknown) console.error(`${key} in ${path} requires a registry mapping or reviewed exception.`);
  process.exitCode = 1;
} else {
  console.log(`External integration audit passed (${locations.size} distinct dependencies).`);
}
