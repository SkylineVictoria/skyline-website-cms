// Phase 5 native extraction regression (REG-DOC / REG-JOBS) against a disposable
// network:none lab. Usage: node scripts/lab/native-extraction.mjs --p04-complete [--azure] [--notify] <label>
// The lab profile flag is consumed by scripts/lab/native-lab.mjs. Requires the
// native gateway (node scripts/lab/server.mjs --p04-complete) to be running.
// Synthetic actors only; never reads .env or hosted credentials; writes its result
// JSON to the OS temp dir (skyline-native-extraction), never into the repo.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request,sql,service,anon,password,verify} from './native-lab.mjs';

const label = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'run';
const identity = await verify();
const run = Date.now().toString();
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, result: 'PASS' }); } catch (e) { results.push({ name, result: 'FAIL', error: String(e.message).slice(0, 400) }); }
  console.log(results.at(-1));
}
const mode = (m) => writeFile('tmp/phase2-native/provider.json', JSON.stringify({ mode: m }));
const edge = async (fn, body, token, extra = {}) => {
  const r = await fetch('http://127.0.0.1:55431/functions/v1/' + fn, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const stateOf = async (id) => (await sql(`select state from enrollment_document_extraction_jobs where id='${id}';`)).trim();
const waitState = async (id, want) => { for (let i = 0; i < 60; i++) { if ((await stateOf(id)) === want) return; await new Promise((r) => setTimeout(r, 250)); } throw Error(`job ${id} did not reach ${want}: ${await stateOf(id)}`); };

// Fixtures: one synthetic tenant/domain, agency, two agents in different agencies, one draft application.
const f = { tenant: randomUUID(), domain: `p5-${run}.localhost`, agency: randomUUID(), otherAgency: randomUUID(), app: randomUUID() };
await sql(`begin;insert into tenants(id,slug,name) values('${f.tenant}','p05-${run}','Phase 5 Synthetic RTO');insert into tenant_domains(hostname,tenant_id,verified_at,verification_evidence) values('${f.domain}','${f.tenant}',now(),'Phase 5 authorized synthetic fixture');insert into agencies(id,name,code,status) values('${f.agency}','Phase 5 Agency','p05-a-${run}','Active'),('${f.otherAgency}','Phase 5 Other Agency','p05-b-${run}','Active');insert into agency_tenants(agency_id,tenant_id) values('${f.agency}','${f.tenant}'),('${f.otherAgency}','${f.tenant}');commit;`);
async function actor(key, agency) {
  const email = `p05-${key}-${run}@example.test`;
  const created = await request('/auth/v1/admin/users', { method: 'POST', token: service, body: { email, password, email_confirm: true } });
  assert.equal(created.status, 200);
  const login = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
  assert.equal(login.status, 200);
  const profile = randomUUID();
  await sql(`begin;insert into portal_profiles(id,auth_user_id,full_name,email,status) values('${profile}','${created.data.id}','Synthetic ${key}','${email}','Active');insert into agency_memberships(user_id,agency_id,role,status) values('${profile}','${agency}','agent','Active');insert into agency_tenant_agents(tenant_id,agency_id,profile_id) values('${f.tenant}','${agency}','${profile}') on conflict do nothing;commit;`);
  return { token: login.data.access_token, profile };
}
const agent = await actor('agent', f.agency);
const other = await actor('other', f.otherAgency);
await sql(`insert into enrollment_applications(id,agency_id,assigned_agent_id,status,student_name,tenant_id) values('${f.app}','${f.agency}','${agent.profile}','draft','Synthetic student','${f.tenant}');`);
const headers = { 'x-tenant-domain': f.domain };
const rpc = (fn, body, token = agent.token) => request('/rest/v1/rpc/' + fn, { method: 'POST', token, headers, body });
const version = Number((await sql(`select draft_version from enrollment_applications where id='${f.app}';`)).trim());
await rpc('portal_review_draft_v2', { p_application_id: f.app, p_expected_version: version, p_values: { first_name: 'Manual protected' }, p_provenance: { first_name: 'Manual entry' }, p_confirmed: ['first_name'], p_resolutions: [{ field: 'first_name', state: 'corrected' }] });

async function upload(category) {
  const doc = randomUUID(), path = `${f.app}/${doc}.pdf`, pdf = `%PDF-1.4\nPhase 5 synthetic ${category} document.\n%%EOF`;
  assert.equal((await request('/storage/v1/object/enrollment-documents/' + path, { method: 'POST', token: agent.token, headers: { ...headers, 'Content-Type': 'application/pdf' }, body: pdf })).status, 200);
  const r = await request('/rest/v1/enrollment_application_documents', { method: 'POST', token: agent.token, headers, body: { id: doc, application_id: f.app, category, filename: doc + '.pdf', storage_path: path, bucket_name: 'enrollment-documents', mime_type: 'application/pdf', file_size: pdf.length } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { doc, path, pdf };
}

await mode('success');
const uploaded = {};
for (const category of ['Passport', 'Driving Licence', 'Visa', 'English Test', 'Academic']) {
  await check(`${category}: private upload, scoped Edge extraction, candidates, exact bytes, manual value protected`, async () => {
    const u = uploaded[category] = await upload(category);
    const queued = await edge('portal-document-extract', { documentId: u.doc }, agent.token, headers);
    assert.equal(queued.status, 200, JSON.stringify(queued));
    await waitState(queued.data.jobId, 'succeeded');
    assert.equal((await sql(`select metadata->'extraction'->'extracted'->>'first_name' from enrollment_application_documents where id='${u.doc}';`)).trim(), 'Native');
    assert.equal((await sql(`select metadata->'extraction'->'source'->>'parser' from enrollment_application_documents where id='${u.doc}';`)).trim(), 'document-extraction-v1');
    assert.equal((await request('/storage/v1/object/authenticated/enrollment-documents/' + u.path, { token: agent.token, headers })).data, u.pdf);
    assert.equal((await sql(`select data#>>'{values,first_name}' from enrollment_applications where id='${f.app}';`)).trim(), 'Manual protected');
  });
}
await check('unauthenticated enqueue is 401', async () => assert.equal((await edge('portal-document-extract', { documentId: uploaded.Passport.doc })).status, 401));
await check('other agency JWT is denied (403)', async () => assert.equal((await edge('portal-document-extract', { documentId: uploaded.Passport.doc }, other.token, headers)).status, 403));
await check('unsupported category is rejected without a job (422)', async () => {
  const u = await upload('Offer');
  assert.equal((await edge('portal-document-extract', { documentId: u.doc }, agent.token, headers)).status, 422);
  assert.equal((await sql(`select count(*) from enrollment_document_extraction_jobs where document_id='${u.doc}';`)).trim(), '0');
});
await check('provider failure queues a retry; later success recovers', async () => {
  await mode('failure');
  const u = await upload('Passport');
  const queued = await edge('portal-document-extract', { documentId: u.doc }, agent.token, headers);
  assert.equal(queued.status, 200, JSON.stringify(queued));
  for (let i = 0; i < 60 && (await sql(`select coalesce(last_error_code,'') from enrollment_document_extraction_jobs where id='${queued.data.jobId}';`)).trim() !== 'provider'; i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal((await sql(`select state||':'||last_error_code from enrollment_document_extraction_jobs where id='${queued.data.jobId}';`)).trim(), 'queued:provider');
  await sql(`update enrollment_document_extraction_jobs set next_attempt_at=now() where id='${queued.data.jobId}';`);
  await mode('success');
  const w = await edge('portal-document-extract', { jobId: queued.data.jobId, tenantId: f.tenant }, undefined, { 'x-worker-secret': 'native-worker-only' }); assert.equal(w.data.processed, true, JSON.stringify(w) + ' ' + await sql(`select state,attempt_count,last_error_code,next_attempt_at<now() from enrollment_document_extraction_jobs where id='${queued.data.jobId}';`));
  assert.equal(await stateOf(queued.data.jobId), 'succeeded');
});
await check('in-flight cancellation fences a late provider completion', async () => {
  const u = await upload('Passport');
  const id = randomUUID();
  await sql(`insert into enrollment_document_extraction_jobs(id,document_id,application_id,tenant_id) values('${id}','${u.doc}','${f.app}','${f.tenant}');`);
  await mode('hold');
  const pending = edge('portal-document-extract', { jobId: id, tenantId: f.tenant }, undefined, { 'x-worker-secret': 'native-worker-only' });
  for (let i = 0; i < 60 && (await stateOf(id)) !== 'processing'; i++) await new Promise((r) => setTimeout(r, 250));
  await sql(`update enrollment_document_extraction_jobs set state='cancelled',lease_expires_at=null where id='${id}';`);
  await mode('success');
  const r = await pending;
  assert.equal(r.data.stale, true, JSON.stringify(r));
  assert.equal(await stateOf(id), 'cancelled');
  assert.equal((await sql(`select coalesce(metadata->'extraction'->'extracted'->>'first_name','') from enrollment_application_documents where id='${u.doc}';`)).trim(), '');
});

// Azure path through the real function and database. The fake Azure lives in native-edge-entry.ts; run with --azure.
if (process.argv.includes('--azure')) {
  const azureMode = (m) => writeFile('tmp/phase2-native/azure.json', JSON.stringify({ mode: m }));
  const resetCalls = () => writeFile('tmp/phase2-native/azure-calls.log', '');
  const calls = async () => (await readFile('tmp/phase2-native/azure-calls.log', 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const count = async (prefix) => (await calls()).filter((l) => l.startsWith(prefix)).length;
  const worker = (id) => edge('portal-document-extract-azure', { jobId: id, tenantId: f.tenant }, undefined, { 'x-worker-secret': 'native-worker-only' });
  const operationOf = async (id) => (await sql(`select provider_engine||':'||operation_id from enrollment_document_extraction_operations where job_id='${id}';`)).trim();
  const waitOperation = async (id) => { for (let i = 0; i < 80; i++) { const o = await operationOf(id); if (o) return o; await new Promise((r) => setTimeout(r, 250)); } throw Error('operation id was not stored'); };
  const manualJob = async (category = 'Passport') => {
    const u = await upload(category), id = randomUUID();
    await sql(`insert into enrollment_document_extraction_jobs(id,document_id,application_id,tenant_id) values('${id}','${u.doc}','${f.app}','${f.tenant}');`);
    return { u, id };
  };

  await check('Azure: enqueue, accepted + running + succeeded poll, candidates, provenance, receipt dropped, manual value protected', async () => {
    await azureMode('success'); await resetCalls();
    const u = await upload('Passport');
    const queued = await edge('portal-document-extract-azure', { documentId: u.doc }, agent.token, headers);
    assert.equal(queued.status, 200, JSON.stringify(queued));
    await waitState(queued.data.jobId, 'succeeded');
    const log = await calls();
    assert.deepEqual([log[0], log.filter((l) => l.startsWith('GET')).length], ['POST', 2]);
    const op = log.find((l) => l.startsWith('ACCEPTED')).split(' ')[1];
    assert.equal((await sql(`select metadata->'extraction'->'extracted'->>'first_name' from enrollment_application_documents where id='${u.doc}';`)).trim(), 'Azure');
    assert.equal((await sql(`select metadata->'extraction'->'source'->>'engine' from enrollment_application_documents where id='${u.doc}';`)).trim(), 'azure-document-intelligence');
    assert.equal((await sql(`select provider_response_id from enrollment_document_extraction_jobs where id='${queued.data.jobId}';`)).trim(), op);
    assert.equal(await operationOf(queued.data.jobId), '', 'receipt must be dropped on success');
    assert.equal((await sql(`select data#>>'{values,first_name}' from enrollment_applications where id='${f.app}';`)).trim(), 'Manual protected');
  });
  await check('Azure: 429 queues a retry with no receipt; later success recovers', async () => {
    const { id } = await manualJob();
    await azureMode('rate_limit'); await resetCalls();
    assert.equal((await worker(id)).data.processed, undefined);
    assert.equal((await sql(`select state||':'||last_error_code from enrollment_document_extraction_jobs where id='${id}';`)).trim(), 'queued:rate_limit');
    assert.equal(await operationOf(id), '');
    await azureMode('success'); await sql(`update enrollment_document_extraction_jobs set next_attempt_at=now() where id='${id}';`);
    assert.equal((await worker(id)).data.processed, true);
    assert.equal(await stateOf(id), 'succeeded');
  });
  await check('Azure: a failed analysis clears the receipt so the retry resubmits instead of polling it', async () => {
    const { id } = await manualJob();
    await azureMode('failed'); await resetCalls();
    await worker(id);
    assert.equal((await sql(`select state||':'||last_error_code from enrollment_document_extraction_jobs where id='${id}';`)).trim(), 'queued:provider');
    assert.equal(await operationOf(id), '');
    await azureMode('success'); await sql(`update enrollment_document_extraction_jobs set next_attempt_at=now() where id='${id}';`);
    assert.equal((await worker(id)).data.processed, true);
    assert.equal(await count('POST'), 2);
  });
  await check('Azure: operation id stored on acceptance, reused by the worker that takes over after a crash, dropped on success; stale worker fenced', async () => {
    const { u, id } = await manualJob();
    await azureMode('hold'); await resetCalls();
    const crashed = worker(id);
    const stored = await waitOperation(id);
    const op = (await calls()).find((l) => l.startsWith('ACCEPTED')).split(' ')[1];
    assert.equal(stored, `azure-document-intelligence:${op}`);
    await sql(`update enrollment_document_extraction_jobs set lease_expires_at=now()-interval '1 second' where id='${id}';`);
    const takeover = worker(id);
    for (let i = 0; i < 60 && (await sql(`select attempt_count from enrollment_document_extraction_jobs where id='${id}';`)).trim() !== '2'; i++) await new Promise((r) => setTimeout(r, 250));
    await azureMode('success');
    const [late, taken] = await Promise.all([crashed, takeover]);
    assert.equal(taken.data.processed, true, JSON.stringify(taken));
    assert.equal(late.data.stale, true, JSON.stringify(late));
    assert.equal(await count('POST'), 1, 'the document must not be submitted a second time');
    assert.equal(await stateOf(id), 'succeeded');
    assert.equal(await operationOf(id), '');
    assert.equal((await sql(`select count(*) from enrollment_document_extraction_attempts where job_id='${id}' and state='succeeded';`)).trim(), '1');
    assert.equal((await sql(`select metadata->'extraction'->'extracted'->>'last_name' from enrollment_application_documents where id='${u.doc}';`)).trim(), 'Fixture');
  });
  await azureMode('success');
}

// Notification delivery through the real function and database (fake Postmark in native-edge-entry.ts); run with --notify.
if (process.argv.includes('--notify')) {
  const pmMode = (m) => writeFile('tmp/phase2-native/postmark.json', JSON.stringify({ mode: m }));
  const resetPm = () => writeFile('tmp/phase2-native/postmark-calls.log', '');
  const pmCalls = async () => (await readFile('tmp/phase2-native/postmark-calls.log', 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const run = (fn, bearer = service) => edge(fn, {}, bearer);
  const hook = (auth) => fetch('http://127.0.0.1:55431/functions/v1/notification-delivery/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: '{}' });
  // The sender comes from the database per organization (migration 87): this lab tenant's verified domain and address.
  await sql(`insert into notification_sender_domains(tenant_id,domain,note) values('${f.tenant}','lab.example.test','lab') on conflict do nothing; insert into notification_sender_settings(tenant_id,from_email) values('${f.tenant}','it@lab.example.test') on conflict ((coalesce(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid))) do nothing;`);
  const field = async (id, column) => (await sql(`select coalesce(${column}::text,'') from notification_deliveries where id='${id}';`)).trim();
  // Each call creates one real outbox event for the synthetic application; the database trigger creates the delivery for its assigned agent.
  const newDelivery = async () => {
    await sql(`update notification_deliveries set state='suppressed',state_reason='lab isolation' where state in ('pending','sending');`);
    await sql(`insert into admission_event_outbox(application_id,tenant_id,event,payload) values('${f.app}','${f.tenant}','application_submitted','{}');`);
    const id = (await sql(`select id from notification_deliveries where application_id='${f.app}' and state='pending' order by seq desc limit 1;`)).trim();
    assert.ok(id, 'delivery was not created by the outbox trigger');
    return id;
  };

  await check('Notify: an institution that has not been approved gets suppressed deliveries and sends nothing', async () => {
    await pmMode('success'); await resetPm();
    await sql(`insert into admission_event_outbox(application_id,tenant_id,event,payload) values('${f.app}','${f.tenant}','application_submitted','{}');`);
    const id = (await sql(`select id from notification_deliveries where application_id='${f.app}' order by seq desc limit 1;`)).trim();
    assert.ok(id, 'the outbox trigger did not create a delivery');
    assert.equal((await field(id, 'state')) + '|' + (await field(id, 'state_reason')), 'suppressed|legacy_scope_not_activated');
    const r = await run('notification-delivery');
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.data.accepted, 0);
    assert.equal((await pmCalls()).length, 0);
    await sql(`insert into notification_activation(tenant_id,note) values('${f.tenant}','lab: owner review recorded') on conflict do nothing;`);
  });
  await check('Notify: disabled configuration sends nothing and claims nothing', async () => {
    const id = await newDelivery(); await resetPm();
    const r = await run('notification-delivery-disabled');
    assert.equal(r.status, 503, JSON.stringify(r));
    assert.equal(r.data.code, 'configuration_unavailable');
    assert.equal(await field(id, 'state'), 'pending');
    assert.equal((await pmCalls()).length, 0);
  });
  await check('Notify: the worker accepts only the service-role key', async () => {
    const id = await newDelivery(); await resetPm();
    assert.equal((await run('notification-delivery', anon)).status, 403);
    assert.equal((await run('notification-delivery', 'wrong')).status, 403);
    assert.equal((await edge('notification-delivery', {})).status, 401);
    assert.equal(await field(id, 'state'), 'pending');
    assert.equal((await pmCalls()).length, 0);
  });
  await check('Notify: an enabled worker sends one plain-text message and stores the provider message id', async () => {
    const id = await newDelivery(); await pmMode('success'); await resetPm();
    const r = await run('notification-delivery');
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.data.accepted, 1);
    assert.equal(await field(id, 'state'), 'sent');
    assert.match(await field(id, 'provider_message_id'), /^[0-9a-f-]{36}$/);
    const calls = await pmCalls();
    assert.deepEqual([calls.length, calls[0].token, calls[0].deliveryId, calls[0].textOnly], [1, true, id, true]);
    assert.equal((await sql(`select count(*) from notification_delivery_attempts where delivery_id='${id}' and outcome='accepted';`)).trim(), '1');
    assert.equal((await run('notification-delivery')).data.accepted, 0, 'nothing is sent twice');
  });
  await check('Notify: a rate-limited send is retried later, not immediately', async () => {
    const id = await newDelivery(); await pmMode('rate_limit'); await resetPm();
    assert.equal((await run('notification-delivery')).data.retried, 1);
    assert.equal((await field(id, 'state')) + '|' + (await field(id, 'last_error_code')), 'pending|rate_limit');
    assert.equal((await run('notification-delivery')).data.accepted, 0);
    assert.equal((await pmCalls()).length, 1);
    await pmMode('success'); await sql(`update notification_deliveries set next_attempt_at=now() where id='${id}';`);
    assert.equal((await run('notification-delivery')).data.accepted, 1);
    assert.equal(await field(id, 'attempt_count'), '2');
  });
  await check('Notify: an unknown outcome (connection dropped) is never resent', async () => {
    const id = await newDelivery(); await pmMode('drop'); await resetPm();
    assert.equal((await run('notification-delivery')).data.unknown, 1);
    assert.equal((await field(id, 'state')) + '|' + (await field(id, 'last_error_code')), 'unknown|network');
    await pmMode('success');
    assert.equal((await run('notification-delivery')).data.accepted, 0);
    assert.equal((await pmCalls()).length, 1);
  });
  await check('Notify: an inactive recipient fails the delivery without retry', async () => {
    const id = await newDelivery(); await pmMode('inactive'); await resetPm();
    assert.equal((await run('notification-delivery')).data.failed, 1);
    assert.equal((await field(id, 'state')) + '|' + (await field(id, 'last_error_code')), 'failed|inactive_recipient');
    await pmMode('success');
  });
  await check('Notify: an internal recipient without a portal account is emailed once, next to the agent', async () => {
    // Per-event recipients come from the tenant's published notifications configuration (migration 92).
    await sql(`begin;set local session_replication_role='replica';insert into tenant_config_versions(tenant_id,kind,state,config,version,published_at) values('${f.tenant}','notifications','published','{"events":{"application_submitted":{"recipients":["ops@lab.example.test"]}}}'::jsonb,900,now());commit;`, true);
    try {
      const id = await newDelivery(); await pmMode('success'); await resetPm();
      const outbox = await field(id, 'outbox_id');
      const internal = (await sql(`select count(*) from notification_deliveries where outbox_id='${outbox}' and recipient_user is null and recipient_email='ops@lab.example.test' and state='pending';`)).trim();
      assert.equal(internal, '1');
      const r = await run('notification-delivery');
      assert.equal(r.status, 200, JSON.stringify(r));
      assert.equal((await sql(`select count(*) from notification_deliveries where outbox_id='${outbox}' and state='sent';`)).trim(), (await sql(`select count(*) from notification_deliveries where outbox_id='${outbox}';`)).trim());
      assert.equal((await pmCalls()).length, Number((await sql(`select count(*) from notification_deliveries where outbox_id='${outbox}';`)).trim()));
      assert.ok(Number((await sql(`select count(*) from notification_deliveries where outbox_id='${outbox}';`)).trim()) >= 2);
    } finally {
      await sql(`begin;set local session_replication_role='replica';delete from tenant_config_versions where tenant_id='${f.tenant}' and kind='notifications' and version=900;commit;`, true);
    }
  });
  await check('Notify: the submitted email carries the PDF, link mode sends only a link, and no form content is stored', async () => {
    await sql(`insert into enrollment_application_versions(application_id,version,snapshot,created_by_name) values('${f.app}',77,'{"values":{"first_name":"Labcase"},"courses":[]}'::jsonb,'lab');`);
    const outbox = async () => {
      await sql(`update notification_deliveries set state='suppressed',state_reason='lab isolation' where state in ('pending','sending');`);
      await sql(`insert into admission_event_outbox(application_id,tenant_id,event,payload) values('${f.app}','${f.tenant}','application_submitted','{"version":77}');`);
      await pmMode('success'); await resetPm();
      const r = await run('notification-delivery');
      assert.equal(r.status, 200, JSON.stringify(r));
      return pmCalls();
    };
    const attached = await outbox();
    assert.ok(attached.length >= 1);
    for (const call of attached) { assert.equal(call.attachments.length, 1); assert.ok(call.attachments[0].pdf && call.attachments[0].bytes > 200); assert.match(call.attachments[0].name, /^application-.*\.pdf$/); assert.equal(call.link, false); }
    assert.equal((await sql(`select count(*) from notification_deliveries where subject||body like '%Labcase%';`)).trim(), '0');
    await sql(`insert into notification_attachment_settings(tenant_id,submission_pdf) values('${f.tenant}','link');`, true);
    try {
      const linked = await outbox();
      assert.ok(linked.length >= 1);
      for (const call of linked) { assert.equal(call.attachments.length, 0); assert.equal(call.link, true); }
    } finally {
      await sql(`delete from notification_attachment_settings where tenant_id='${f.tenant}';`, true);
    }
  });
  await check('Notify: the issued CoE PDF is attached to the coe_voe_issued email for the agent and the student', async () => {
    // Seeds an issued document the way portal_coe_voe_issue leaves it (the issue command itself is covered by pgTAP).
    await sql(`begin;set local session_replication_role='replica';update enrollment_applications set student_email='lab-student@example.test' where id='${f.app}';
      with r as (insert into enrollment_registrations(application_id,tenant_id,state,coe_number,created_by,lodged_at,lodged_by,verified_at,verified_by) values('${f.app}','${f.tenant}','verified','E0000000099',gen_random_uuid(),now(),gen_random_uuid(),now(),gen_random_uuid()) returning id)
      insert into enrollment_coe_documents(application_id,tenant_id,registration_id,kind,file_name,size_bytes,sha256,content,uploaded_by,issued_at,issued_by)
      select '${f.app}','${f.tenant}',r.id,'coe','coe.pdf',15,encode(sha256(convert_to(E'%PDF-1.4\n%%EOF\n','LATIN1')),'hex'),convert_to(E'%PDF-1.4\n%%EOF\n','LATIN1'),gen_random_uuid(),now(),gen_random_uuid() from r;commit;`, true);
    await sql(`update notification_deliveries set state='suppressed',state_reason='lab isolation' where state in ('pending','sending');`);
    await sql(`insert into admission_event_outbox(application_id,tenant_id,event,payload) values('${f.app}','${f.tenant}','coe_voe_issued','{"from":"offer_accepted","to":"coe_issued"}');`);
    await pmMode('success'); await resetPm();
    const r = await run('notification-delivery');
    assert.equal(r.status, 200, JSON.stringify(r));
    const calls = await pmCalls();
    assert.ok(calls.length >= 2, 'agent and student are both emailed');
    for (const call of calls) { assert.equal(call.attachments.length, 1); assert.ok(call.attachments[0].pdf); assert.match(call.attachments[0].name, /^CoE-.*.pdf$/); }
    assert.equal((await sql(`select count(*) from notification_deliveries where recipient_email='lab-student@example.test' and event='coe_voe_issued' and state='sent';`)).trim(), '1');
  });
  await check('Notify: the Postmark callback endpoint is disabled and changes nothing', async () => {
    const id = await newDelivery(); await pmMode('success');
    await run('notification-delivery');
    const before = await field(id, 'state');
    for (const auth of [null, 'Basic ' + Buffer.from('hook:anything').toString('base64'), 'Bearer ' + service]) assert.equal((await hook(auth)).status, 410);
    assert.equal(await field(id, 'state'), before);
  });
  await check('Notify: a tenant without a database sender fails safely and sends nothing (no platform fallback)', async () => {
    const id = await newDelivery(); await resetPm(); await pmMode('success');
    await sql(`update notification_sender_domains set revoked_at=now() where tenant_id='${f.tenant}' and revoked_at is null;`);
    const r = await run('notification-delivery');
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.data.accepted, 0);
    assert.equal((await pmCalls()).length, 0);
    assert.equal((await field(id, 'state')) + '|' + (await field(id, 'last_error_code')), 'failed|sender_unconfigured');
    await sql(`update notification_sender_domains set revoked_at=null where tenant_id='${f.tenant}' and domain='lab.example.test';`);
  });
  await pmMode('success');
}

const outDir = join(tmpdir(), 'skyline-native-extraction');
await mkdir(outDir, { recursive: true });
const out = { label, run, identity, passed: results.filter((r) => r.result === 'PASS').length, failed: results.filter((r) => r.result === 'FAIL').length, provider: 'deterministic native fixture gateway; no live provider', results };
await writeFile(join(outDir, `native-extraction-${label}.json`), JSON.stringify(out, null, 2) + '\n');
console.log(`native extraction ${label}: ${out.passed} PASS / ${out.failed} FAIL`);
process.exitCode = out.failed ? 1 : 0;
const notifyResults = results.filter((r) => r.name.startsWith('Notify:'));
if (notifyResults.length) console.log(`native extraction ${label} (Notify path): ${notifyResults.filter((r) => r.result === 'PASS').length} PASS / ${notifyResults.filter((r) => r.result === 'FAIL').length} FAIL`);
const azureResults = results.filter((r) => r.name.startsWith('Azure:'));
if (azureResults.length) console.log(`native extraction ${label} (OpenAI path): ${out.passed - azureResults.filter((r) => r.result === 'PASS').length - notifyResults.filter((r) => r.result === 'PASS').length} PASS / ${out.failed - azureResults.filter((r) => r.result === 'FAIL').length - notifyResults.filter((r) => r.result === 'FAIL').length} FAIL; (Azure path): ${azureResults.filter((r) => r.result === 'PASS').length} PASS / ${azureResults.filter((r) => r.result === 'FAIL').length} FAIL`);
