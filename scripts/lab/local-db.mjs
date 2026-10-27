import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const APPROVED_PROJECT = 'xcpydisstlvtvcsqnjob';
export const EXCLUDED_PROJECT = 'qoylrmorezlqdvufonmx';
export const TEST_CONTAINER = 'skyline-phase2-db';
export const TEST_DATABASE = 'skyline_phase2_test';
const exec = promisify(execFile);

export function assertInspection(context, container, expectedName = TEST_CONTAINER) {
  if (![TEST_CONTAINER, 'skyline-phase2-clean-db', 'skyline-phase2-replay-db'].includes(expectedName)) throw new Error('Unknown test container.');
  if (context?.Endpoints?.docker?.Host !== 'npipe:////./pipe/dockerDesktopLinuxEngine')
    throw new Error('Only the local Docker Desktop named pipe is permitted.');
  if (container?.Name !== `/${expectedName}` || !/^[a-f0-9]{64}$/.test(container.Id ?? ''))
    throw new Error('Unexpected disposable container identity.');
  if (container.Config?.Labels?.['skyline.source-project'] !== APPROVED_PROJECT ||
      container.Config?.Labels?.['skyline.phase2.disposable'] !== 'true')
    throw new Error('Missing approved source-project/disposable labels.');
  if (container.State?.Running !== true || container.HostConfig?.NetworkMode !== 'none' ||
      Object.keys(container.NetworkSettings?.Networks ?? {}).some(k => k !== 'none') ||
      Object.keys(container.HostConfig?.PortBindings ?? {}).length)
    throw new Error('The test database must be running without network or published ports.');
  if (container.HostConfig?.Privileged || container.HostConfig?.PidMode === 'host' ||
      (container.Mounts ?? []).length ||
      !container.HostConfig?.Tmpfs?.['/var/lib/postgresql/data'])
    throw new Error('Only memory-only database storage without host/volume mounts is permitted.');
  if ((container.Config?.Env ?? []).some(e => /^(?:SUPABASE_|VITE_|OPENAI_|AZURE_|POSTMARK_|STRIPE_|DOCUMENT_EXTRACTION_WORKER_SECRET=|PUBLIC_ASSISTANT_WORKER_SECRET=)/.test(e)))
    throw new Error('Provider or application configuration is forbidden in the test container.');
  return container.Id;
}

export function assertDatabaseIdentity(identity, expectedSystemId) {
  if (identity?.database !== TEST_DATABASE || identity.role !== 'postgres' ||
      identity.server_address !== null || !/^\d+$/.test(identity.system_identifier ?? '') ||
      identity.system_identifier !== expectedSystemId || identity.vault_secret_count !== 0)
    throw new Error('Database identity or empty-Vault check failed. No SQL executed.');
}

export async function docker(args, input) {
  // Explicit local context; never inherit a remote DOCKER_HOST/TLS override.
  const env = { ...process.env };
  for (const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']) delete env[key];
  if (input === undefined) {
    const { stdout } = await exec('docker', ['--context','desktop-linux',...args],
      { env, windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }
  return new Promise((resolve, reject) => {
    const child = execFile('docker', ['--context','desktop-linux',...args],
      { env, windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => error ? reject(Object.assign(new Error('Isolated SQL command failed.'),
        { sqlOutput: stdout + stderr })) : resolve(stdout));
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
}

export async function verifyLocalDatabase(expectedSystemId, containerName = TEST_CONTAINER) {
  const context = JSON.parse(await docker(['context','inspect','desktop-linux']))[0];
  const container = JSON.parse(await docker(['inspect',containerName]))[0];
  const containerId = assertInspection(context, container, containerName);
  const raw = await docker(['exec',containerId,'psql','-X','-qAt','-v','ON_ERROR_STOP=1',
    '-U','postgres','-d',TEST_DATABASE,'-c',
    "begin read only; select json_build_object('database',current_database(),'role',current_user,'server_address',inet_server_addr(),'system_identifier',(select system_identifier::text from pg_control_system()),'vault_secret_count',(select count(*) from vault.secrets)); commit;"]);
  const identity = JSON.parse(raw.trim());
  assertDatabaseIdentity(identity, expectedSystemId);
  return { containerId, identity };
}

export async function localSql(expectedSystemId, sql, bootstrap = false, containerName = TEST_CONTAINER) {
  const verified = await verifyLocalDatabase(expectedSystemId, containerName);
  // Pinned container ID closes a name-replacement race; -X ignores psql startup files.
  return docker(['exec','-i',verified.containerId,'psql','-X','-qAt','-v','ON_ERROR_STOP=1',
    '-U',bootstrap ? 'supabase_admin' : 'postgres','-d',TEST_DATABASE], sql);
}
