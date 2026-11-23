import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const testModule = process.env.SLIT_RULES_TEST_PGLITE;
const { PGlite } = await import(testModule ? pathToFileURL(testModule).href : "@electric-sql/pglite");
const db = new PGlite();
const admin = "a5000000-0000-4000-8000-000000000001";
const approver = "a5000000-0000-4000-8000-000000000002";
const trainer = "a5000000-0000-4000-8000-000000000003";
const tenant = "a5000000-0000-4000-8000-000000000004";
const identifier = "lms.unit_upload_max_bytes";

try {
  // Database interfaces supplied by the existing app/Supabase. Isolated fixtures.
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('app.actor', true), '')::uuid $$;
    create function public.tenant_current() returns uuid language sql stable as
      $$ select nullif(current_setting('app.tenant', true), '')::uuid $$;
    create function public.tenant_scope(uuid) returns boolean language sql stable as
      $$ select $1 is not distinct from public.tenant_current() $$;
    create function public.cms_is_admin() returns boolean language sql stable as
      $$ select auth.uid()::text in ('${admin}','${approver}') $$;
    create function public.tenant_has_role(uuid,text[]) returns boolean language sql stable as
      $$ select public.cms_is_admin() and $1 = public.tenant_current() $$;
    create function public.unit_content_can_edit() returns boolean language sql stable as
      $$ select auth.uid()::text = '${trainer}' $$;
    create table public.admin_menu_items (
      id text primary key, parent_id text references public.admin_menu_items, label text, route text,
      icon_key text, sort_order int, is_enabled boolean, permission_key text, permission_scope text, is_system boolean
    );
    insert into public.admin_menu_items(id,label) values ('administration','Administration');
    create table storage.buckets(id text primary key, file_size_limit bigint);
    insert into storage.buckets values ('unit-content',26214400);
    create table storage.objects(bucket_id text, name text, metadata jsonb, unique(bucket_id,name));
    create table public.cms_course_units(id text primary key, tenant_id uuid, course_id text);
    insert into public.cms_course_units values ('unit-a',null,'course-a'),('unit-b','${tenant}','course-b');
    create table public.unit_contents(id int primary key, unit_id text, kind text, storage_path text, size_bytes int, title text);
    grant select, insert, update on public.unit_contents to authenticated;
    insert into storage.objects values ('unit-content','unit-a/a.pdf','{"size":5000}'),
      ('unit-content','unit-a/b.docx','{"size":5000}'),('unit-content','unit-a/small.pdf','{"size":900}');
  `);
  const inventoryFile = "20261120222000_business_rules_inventory.sql";
  for (const file of ["20261120220000_business_rules.sql", "20261120221000_business_rule_lms_upload.sql", inventoryFile, inventoryFile]) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"));
  }
  // Test the release against the pristine migration state and then restore the
  // draft fixture for the existing draft-to-publication lifecycle cases.
  const publication = await readFile(new URL("../supabase/migrations/20261120223000_publish_existing_business_rule.sql", import.meta.url), "utf8");
  await db.exec("begin");
  await db.exec(publication.replace(/^begin;\s*$/m, "").replace(/\ncommit;\s*$/, ""));
  const counts = (await db.query("select state, count(*)::int as count from public.business_rule_versions group by state")).rows;
  if (counts.length !== 2 || !counts.some(row => row.state === "published" && row.count === 1) ||
      !counts.some(row => row.state === "reference" && row.count === 12)) throw new Error("Release leaves unexpected rule states");
  const liveBaseline = (await db.query("select public.business_rule_evaluate('', $1, '{}') as value", [identifier])).rows[0].value;
  if (liveBaseline !== 26214400) throw new Error("Release changed the live upload limit");
  const snapshot = (await db.query("select count(*)::int as count from public.business_rule_audit_logs where action = 'publish' and after_data->'value' = '26214400'")).rows[0];
  if (snapshot.count !== 1) throw new Error("Release did not record upload publication");
  const catalog = await readFile(new URL("../supabase/migrations/20261120224000_business_rules_source_catalog.sql", import.meta.url), "utf8");
  const importCatalog = catalog.replace(/^begin;\s*$/m, "").replace(/\ncommit;\s*$/, "");
  await db.exec(importCatalog);
  await db.exec(importCatalog);
  const catalogCounts = (await db.query(`select
    count(*) filter (where v.state = 'reference' and r.registration->>'handler' = 'inventory_only')::int as reference_count,
    count(*) filter (where v.state = 'draft')::int as drafts,
    count(*) filter (where v.state = 'published')::int as published
    from public.business_rule_versions v join public.business_rules r on r.id = v.rule_id`)).rows[0];
  if (catalogCounts.reference_count !== 103 || catalogCounts.drafts !== 0 || catalogCounts.published !== 1) {
    throw new Error("The source catalog must add only unique reference records");
  }
  console.log("PASS source catalog adds 91 references, preserves the live rule and can be re-imported safely");
  const recheck = await readFile(new URL("../supabase/migrations/20261120225000_business_rules_runtime_recheck.sql", import.meta.url), "utf8");
  const importRecheck = recheck.replace(/^begin;\s*$/m, "").replace(/\ncommit;\s*$/, "");
  await db.exec(importRecheck);
  await db.exec(importRecheck);
  const rechecked = (await db.query(`select
    count(*) filter(where state = 'reference')::int as reference_count,
    count(*) filter(where state = 'draft')::int as drafts,
    count(*) filter(where state = 'published')::int as published
    from public.business_rule_versions`)).rows[0];
  if (rechecked.reference_count !== 129 || rechecked.drafts !== 0 || rechecked.published !== 1) {
    throw new Error("The second audit must add references without changing published state");
  }
  console.log("PASS runtime recheck adds 26 unique references without creating drafts or changing published state");
  await db.exec("rollback");
  console.log("PASS release classifies inventory as references, publishes the existing upload limit and leaves no drafts");

  const setActor = id => db.query("select set_config('app.actor',$1,false)", [id]);
  const setTenant = id => db.query("select set_config('app.tenant',$1,false)", [id]);
  const request = async (command, payload = {}) =>
    (await db.query("select public.business_rules_admin($1,$2::jsonb) result", [command, payload])).rows[0].result;
  const limit = async extension => Number((await db.query(
    "select public.unit_learning_file_limit('unit-a',$1) result", [extension])).rows[0].result);
  const seeRule = async () => (await request("list")).rules.find(rule => rule.identifier === identifier);
  const assert = (condition, label) => { if (!condition) throw new Error(label); console.log(`PASS ${label}`); };
  const rejects = async (action, code, message, label) => {
    try { await action(); } catch (e) {
      assert(e.code === code && e.message.includes(message), `${label} [${e.code}: ${e.message}]`);
      return;
    }
    throw new Error(`Expected rejection: ${label}`);
  };
  const params = (rule, definition = rule.versions[0].definition) => ({
    rule_id: rule.id, expected_version: rule.versions[0].id, definition, reason: "Isolated workflow test",
  });

  await db.exec("set role authenticated");
  await setActor(trainer);
  await rejects(() => request("list"), "42501", "administrator", "Non-admin blocked");
  await rejects(() => db.exec("select * from public.business_rules"), "42501", "permission denied", "Direct table access blocked");
  assert(await limit("pdf") === 26214400, "Existing bucket limit before policy approval");

  await setActor(admin);
  let rule = await seeRule();
  const seed = rule.versions[0];
  assert(seed.state === "draft" && seed.origin === "migration", "Existing value registered as unapproved draft");
  const reference = await request("list");
  const inventory = reference.rules.filter(item => item.registration?.handler === "inventory_only");
  assert(inventory.length === 12 && inventory.every(item => item.versions.length === 1 && item.versions[0].state === "draft"),
    "Legacy inventory is visible, stays in draft, and can be imported twice without duplication");
  const attendance = inventory.find(item => item.identifier === "lms.attendance_alert_threshold");
  assert(attendance?.versions[0].definition.value === 80, "Inventory retains the observed source value");
  await rejects(() => request("publish", params(attendance)), "22023", "Unknown registered workflow handler",
    "Review-only inventory cannot be published through the Admin API");
  const other = { ...seed.definition, identifier: "crm.example_policy", scope: "admissions", name: "Sample policy", entity: "application", value_type: "boolean", value: false };
  await request("save", { definition: other, reason: "New sample" });
  assert((await request("list")).rules.some(r => r.identifier === other.identifier), "Administrator can create a rule");
  await rejects(() => request("save", { definition: other, reason: "Duplicate" }), "23505", "already in use", "Duplicate rule identifiers rejected");
  await setTenant(tenant);
  assert(!(await request("list")).rules.length, "Verified tenant cannot read legacy scope");
  await rejects(() => request("save", params(rule)), "42501", "Rule unavailable", "Verified tenant cannot edit legacy policy by ID");
  await setTenant("");

  const conditional = { ...seed.definition, value: 1000, approval_required: true, groups: [
    { match: "all", conditions: [{ field: "file.extension", operator: "equals", operand: "pdf" }] },
    { match: "any", conditions: [{ field: "course.id", operator: "equals", operand: "course-a" }, { field: "unit.id", operator: "equals", operand: "unit-b" }] },
  ] };
  const yes = await request("preview", { definition: conditional, context: { "file.extension": "pdf", "course.id": "course-a" } });
  const no = await request("preview", { definition: conditional, context: { "file.extension": "docx", "course.id": "course-a" } });
  assert(yes.matched && yes.value === 1000 && !no.matched && no.action === "none", "Visual IF/THEN/ELSE preview evaluates AND, OR and related course");
  await rejects(() => request("save", params(rule, { ...conditional, value: "1000" })), "22023", "numeric", "Invalid values rejected");
  await rejects(() => request("preview", { definition: { ...conditional, then_action: "eval" } }), "22023", "actions", "Unregistered action rejected");
  await request("save", params(rule, conditional));
  await rejects(() => request("save", params(rule, conditional)), "40001", "another session", "Stale edits rejected");
  rule = await seeRule();
  await setActor(trainer);
  assert(await limit("pdf") === 26214400, "New draft leaves workflow behavior intact");
  await setActor(admin);
  await rejects(() => request("publish", params(rule)), "42501", "second administrator", "Publication requires approval when requested");
  await rejects(() => request("approve", params(rule)), "42501", "different administrator", "Author cannot self-approve");
  await setActor(approver);
  await request("approve", params(rule));
  await setActor(admin);
  await request("publish", params(rule));
  await setActor(trainer);
  assert(await limit("pdf") === 1000 && await limit("docx") === 26214400, "Published policy takes effect without a deployment");
  await rejects(() => db.exec("insert into public.unit_contents values (1,'unit-a','file','unit-a/a.pdf',1,'Forged size')"),
    "22023", "published learning content limit", "Server rejects oversized file despite forged client size");
  await db.exec("insert into public.unit_contents values (1,'unit-a','file','unit-a/small.pdf',1,'Valid file')");
  await db.exec("update public.unit_contents set title='Renamed file' where id=1");
  await db.exec("insert into public.unit_contents values (2,'unit-a','file','unit-a/b.docx',1,'Unmatched format')");
  await db.exec("insert into public.unit_contents values (3,'unit-a','text',null,null,'Existing note flow')");
  assert((await db.query("select size_bytes from public.unit_contents where id=1")).rows[0].size_bytes === 900,
    "Actual Storage size wins and existing file edits and notes still work");

  await setActor(admin);
  rule = await seeRule();
  const prior = rule.versions[0];
  const tomorrow = (await db.query("select ((now() at time zone 'Australia/Melbourne')::date + 1)::text as next_date")).rows[0].next_date;
  await request("save", params(rule, { ...prior.definition, approval_required: false, value: 500, starts_on: tomorrow }));
  rule = await seeRule();
  await rejects(() => request("publish", params(rule)), "42501", "second administrator", "Existing approval requirement cannot be removed without approval");
  await setActor(approver);
  await request("approve", params(rule));
  await setActor(admin);
  await request("publish", params(rule));
  await setActor(trainer);
  assert(await limit("pdf") === 1000, "Future effective version leaves today's rule unchanged");
  await setActor(admin);
  rule = await seeRule();
  await request("save", params(rule, { ...rule.versions[0].definition, value: 510 }));
  rule = await seeRule();
  await setActor(approver);
  await request("approve", params(rule));
  await setActor(admin);
  await rejects(() => request("publish", params(rule)), "22023", "already has this date", "Conflicting scheduled version blocked");
  await request("save", params(rule, { ...prior.definition, approval_required: false, enabled: false }));
  rule = await seeRule();
  await setActor(approver);
  await request("approve", params(rule));
  await setActor(admin);
  await request("publish", params(rule));
  await setActor(trainer);
  assert(await limit("pdf") === 26214400, "Publishing an inactive version restores the documented Storage ceiling");
  await setActor(admin);
  rule = await seeRule();
  await request("rollback", { ...params(rule), target_version: prior.id });
  rule = await seeRule();
  assert(rule.versions[0].origin === "rollback" && rule.versions[0].definition.value === 1000, "Rollback restores prior value as a draft");
  const history = (await request("list")).history;
  assert(history.some(row => row.action === "publish" && row.actor === admin && row.after_data.value === 1000 && row.before_data === null && row.reason),
    "History records actor, reason and published value");

  await db.exec("reset role");
  const registration = reference.rules.find(r => r.id === rule.id).registration;
  await db.query("select public.business_rule_register('', $1, $2::jsonb)", [identifier, registration]);
  await db.exec("set role authenticated");
  assert((await seeRule()).versions[0].id === rule.versions[0].id, "Re-registering a rule preserves administrator versions");
  await db.exec("reset role");
  await db.exec("update storage.buckets set file_size_limit=null where id='unit-content'");
  await db.exec("set role authenticated");
  await setActor(trainer);
  await rejects(() => limit("pdf"), "22023", "unavailable", "Missing continuity configuration fails safely");

  await db.exec(`
    reset role;
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as 'select 1::bigint';
    alter table storage.buckets add column name text, add column public boolean;
    create table public.tenants(id uuid primary key);
    create table public.cms_courses(id text primary key, tenant_id uuid, code text, name text);
    alter table public.cms_course_units add column code text, add column name text;
    insert into public.cms_courses values ('course-a',null,'CPC30620','Painting and Decorating');
    update public.cms_course_units set code='CPCCWHS2001', name='WHS' where id='unit-a';
    create table public.asm_assessments(id uuid primary key, tenant_id uuid, unit_id text);
    create table public.asm_assignments(id uuid primary key, assessment_id uuid);
    create function public.asm_is_admin() returns boolean language sql as 'select public.cms_is_admin()';
    create function public.asm_trainer_profile() returns uuid language sql as $$ select auth.uid() $$;
    create function public.asm_can_assess(uuid,uuid) returns boolean language sql as $$ select $2 = '${trainer}'::uuid $$;
    create function public.portal_student_id() returns uuid language sql as $$ select auth.uid() $$;
    create function public.student_enrolled_unit_ids(uuid) returns setof text language sql
      as $$ select 'unit-a'::text where $1 = '${approver}'::uuid $$;
    create or replace function public.cms_is_admin() returns boolean language sql stable
      as $$ select auth.uid() = '${admin}'::uuid $$;
    alter table storage.objects enable row level security;
    grant select,insert on storage.objects to authenticated;
    grant usage on schema storage to authenticated;
  `);
  const batch = await readFile(new URL("../supabase/migrations/20261120233517_business_rules_live_batch1.sql", import.meta.url), "utf8");
  await db.exec(batch.slice(batch.indexOf("create or replace function public.business_rule_patch_function"), batch.indexOf("-- Turns a reference")));
  const bulkMigration = "20261123081000_lms_bulk_resources.sql";
  await db.exec(await readFile(new URL(`../supabase/migrations/${bulkMigration}`, import.meta.url), "utf8"));
  const bulk = async (action, data = {}) =>
    (await db.query("select public.lms_bulk_admin($1,$2::jsonb) result", [action, data])).rows[0].result;
  const resources = async () => (await db.query("select public.lms_bulk_resources('unit-a') as result")).rows[0].result;
  const canGet = async path => (await db.query("select public.lms_bulk_storage_allowed($1,false) as result", [path])).rows[0].result;
  await db.exec("set role authenticated");
  await rejects(() => bulk("list"), "42501", "administration", "Trainer cannot manage bulk imports");
  await setActor(admin);
  await rejects(() => bulk("policy"), "22023", "missing max_mib", "Bulk settings stay inactive before publication");
  const ids = ["lms.bulk_max_mib", "lms.bulk_max_files", "lms.bulk_formats", "lms.bulk_confidence",
    "lms.bulk_instructions", "lms.bulk_default_audience", "lms.bulk_duplicates", "lms.bulk_allow_publication",
    "lms.bulk_confirm_each", "lms.bulk_learning_label", "lms.bulk_assessment_label", "lms.bulk_self_assessment_label", "lms.bulk_assessor_label"];
  for (const id of ids) {
    const found = (await request("list")).rules.find(r => r.identifier === id);
    assert(found?.versions[0].state === "draft", `${id} is registered and ready for SLIT review`);
    await request("publish", params(found));
  }
  const policy = await bulk("policy");
  assert(policy.max_files >= 100 && policy.formats.includes("zip"), "Published bulk policy enables multi-file ZIP imports");
  await rejects(() => bulk("begin", {files: [{name:"file.exe",bytes:100}]}), "P0001", "Unsupported", "Server rejects an unsupported type");
  await rejects(() => bulk("begin", {files: [{name:"file.pdf",bytes:27_000_000}]}), "P0001", "configured size", "Server rejects an oversized file");
  const batchJob = await bulk("begin", {files: Array.from({length:105}, (_, i) => ({name:`document-${i}.pdf`,bytes:10}))});
  assert(batchJob.files.length === 105, "105 files reserved in one operation");
  const job = await bulk("begin", {unit:"unit-a",files:[{name:"student.pdf",bytes:100},{name:"assessor.pdf",bytes:100},{name:"updated.pdf",bytes:100},{name:"duplicate.pdf",bytes:100}]});
  await rejects(() => bulk("uploaded", {job:job.id,id:job.files[0].id}), "P0001", "Upload incomplete", "Interrupted upload cannot be queued");
  const complete = async (entry, confidentiality, sha256, signals = {}, jobId = job.id) => {
    await db.query("insert into storage.objects values ('lms-bulk-resources',$1,$2::jsonb)", [entry.object_path,{size:100}]);
    await bulk("uploaded", {job:jobId,id:entry.id});
    await db.exec("reset role");
    const lease = (await db.query("select public.lms_bulk_claim() result")).rows[0].result;
    assert(lease.id === entry.id, "Worker claimed the queued file");
    const outcome = {classification:{title:"Workbook",unitCode:"CPCCWHS2001",courseCode:"CPC30620",category:"learning",confidence:98,confidentiality,...signals},sha256};
    const settle = (token) => db.query("select public.lms_bulk_finish($1,$2,$3::jsonb) result",[entry.id,token,outcome]);
    assert((await settle("00000000-0000-4000-8000-000000000000")).rows[0].result === false, "Stale worker cannot save a result");
    assert((await settle(lease.lease)).rows[0].result, "Worker saved the classification");
    await db.exec("set role authenticated");
  };
  const [learner, confidential, updated, duplicate] = job.files;
  await complete(learner,"student_safe","learner-hash");
  await complete(confidential,"mixed","confidential-hash");
  await complete(updated,"student_safe","updated-hash");
  await complete(duplicate,"student_safe","learner-hash");
  const review = await bulk("detail",{job:job.id});
  assert(review.every(f => f.matches[0].id === "unit-a"), "Classifications match the existing unit");
  const approval = (entry, extra = {}) => ({id:entry.id,unit:"unit-a",category:"learning",audience:"student_staff",...extra});
  const approve = (...items) => bulk("approve",{job:job.id,items});
  assert((await approve({ id: learner.id }, approval(learner), approval(confidential)))[1].ok, "Bulk approval isolates invalid rows");
  assert(!(await approve(approval(confidential)))[0].ok, "Mixed content requires explicit review");
  assert((await approve(approval(confidential,{reviewed:true})))[0].ok, "Reviewed mixed content can be imported in quarantine");
  let list = await resources();
  const first = list.find(r => r.path === learner.object_path);
  const held = list.find(r => r.path === confidential.object_path);
  assert(held.audience === "assessor" && held.security_hold, "Backend forces assessor access for mixed material");
  assert(!first.published_at, "Approval does not publish");
  await setActor(approver);
  assert(!(await canGet(learner.object_path)), "Enrolled student cannot open unpublished resource");
  assert((await db.query("select name from storage.objects where name=$1",[learner.object_path])).rows.length === 0, "Storage RLS denies direct unpublished file reads");
  await setActor(admin);
  await rejects(() => bulk("publish",{id:first.id}), "P0001", "Verify the file", "Student publication requires confidentiality confirmation");
  await bulk("publish",{id:first.id,contentChecked:true});
  await bulk("publish",{id:held.id});
  await setActor(approver);
  assert(await canGet(learner.object_path), "Enrolled student can open explicitly published resource");
  assert(!(await canGet(confidential.object_path)), "Enrolled student cannot open published confidential resource");
  assert((await resources()).length === 1, "Student resource list excludes confidential material");
  await setActor(trainer);
  assert(!(await canGet(confidential.object_path)), "Unassigned trainer cannot read assessor material");
  await db.exec("reset role; insert into public.asm_assessments values (gen_random_uuid(),null,'unit-a'); insert into public.asm_assignments select gen_random_uuid(),id from public.asm_assessments; set role authenticated;");
  assert(await canGet(confidential.object_path), "Assigned assessor can read published assessor material");
  await setActor(admin);
  assert(!(await approve(approval(duplicate)))[0].ok, "Identical document requires a duplicate decision");
  assert((await approve(approval(duplicate,{skipExisting:true})))[0].ok, "Identical upload can be skipped");
  assert((await approve(approval(updated,{previousId:first.id})))[0].ok, "Changed document can be stored as a version");
  list = await resources();
  const next = list.find(r => r.path === updated.object_path);
  assert(next.previous_id === first.id && !next.published_at, "New version preserves the original and stays unpublished");
  await bulk("publish",{id:next.id,contentChecked:true});
  await setActor(approver);
  assert(!(await canGet(learner.object_path)) && await canGet(updated.object_path), "Publishing the new version removes student access to the superseded file");
  await db.exec(`reset role;
    insert into public.cms_courses values ('course-alt',null,'CPP12345','Other qualification');
    insert into public.cms_course_units values ('unit-shared',null,'course-alt','CPCCWHS2001','WHS'),
      ('unit-other',null,'course-alt','CPCCWHS1001','Construction safety');
    set role authenticated;
  `);
  await setActor(admin);
  assert((await bulk("catalogue")).units.length === 3, "Bulk course picker is limited to the active tenant");
  const multi = await bulk("begin", {files: ["ambiguous.pdf","missing.pdf","second-unit.pdf"].map(name => ({name,bytes:100}))});
  await complete(multi.files[0],"student_safe","ambiguous-hash",{courseCode:null},multi.id);
  await complete(multi.files[1],"student_safe","missing-hash",{courseCode:null,unitCode:null},multi.id);
  await complete(multi.files[2],"student_safe","other-unit-hash",{courseCode:"CPP12345",unitCode:"CPCCWHS1001"},multi.id);
  const reviewed = await bulk("detail",{job:multi.id});
  const matches = id => reviewed.find(row => row.id === id).matches;
  assert(matches(multi.files[0].id).length === 2 && matches(multi.files[1].id).length === 0, "Ambiguous and missing codes require selection");
  const multiApproval = await bulk("approve",{job:multi.id,items:[
    approval(multi.files[0]), approval(multi.files[1]), approval(multi.files[2],{unit:"unit-other"}),
  ]});
  assert(!multiApproval[0].ok && !multiApproval[1].ok && multiApproval[2].ok, "Backend requires review of exceptions and routes an exact second-unit match");
  assert((await bulk("approve",{job:multi.id,items:[approval(multi.files[0],{unit:"unit-shared",reviewed:true})]}))[0].ok,
    "An administrator can resolve an ambiguous match without changing master data");
  const threshold = (await request("list")).rules.find(r => r.identifier === "lms.bulk_confidence");
  await request("save", params(threshold, {...threshold.versions[0].definition,value:99,priority:1}));
  const draft = (await request("list")).rules.find(r => r.id === threshold.id);
  assert((await bulk("policy")).confidence === 85, "Unpublished threshold changes do not affect review");
  await request("publish", params(draft));
  assert((await bulk("policy")).confidence === 99, "Publishing changes the confidence threshold without a deployment");

  await db.exec(`reset role;
    create table public.enrollment_students(id uuid primary key);
    insert into public.enrollment_students values ('${approver}'), ('${trainer}');
    alter table public.asm_assignments add column tenant_id uuid, add column status text default 'open', add column due_at timestamptz;
    alter table public.asm_assessments add column title text default 'Workplace safety';
    create function public.asm_assignment_eligible(uuid) returns setof uuid language sql
      as $$ select '${approver}'::uuid where exists(select 1 from public.asm_assignments where id=$1) $$;
    alter table public.unit_contents add column body text default '', add column file_name text, add column visible_to_students boolean default true,
      add column updated_at timestamptz default now();
    update public.unit_contents set visible_to_students=false;
    insert into public.unit_contents(id,unit_id,kind,title,body) values
      (991,'unit-a','text','Safety guide','Reporting hazards helps you prevent incidents.'),
      (992,'unit-a','text','Assessor Resources: Marking keys','This must never be used to generate practice.');
  `);
  await db.exec(await readFile(new URL("../supabase/migrations/20261123173000_student_practice.sql", import.meta.url), "utf8"));
  await db.exec("set role authenticated");
  const practice = async (action, input = {}) =>
    (await db.query("select public.student_practice($1,$2::jsonb) result", [action,input])).rows[0].result;
  const practiceScope = { unitId:"unit-a", difficulty:"easy" };
  await setActor(approver);
  await rejects(() => practice("next",practiceScope),"22023","has not been enabled","Practice disabled while its rules are drafts");
  await rejects(() => db.exec("select * from public.lms_practice_questions"),"42501","permission denied","Student cannot read hidden practice answer keys");
  await setActor(admin);
  const practiceRules = ["lms.practice_enabled","lms.practice_daily_batches","lms.practice_level_evidence","lms.practice_level_accuracy"];
  for (const id of practiceRules) {
    const rule = (await request("list")).rules.find(row => row.identifier === id);
    await request("publish",params(rule));
  }
  await setActor(approver);
  assert((await practice("catalogue")).units.length===1,"Practice catalogue is scoped to enrolled units");
  assert((await practice("next",practiceScope)).state==="generate","Published learner material can start a practice batch");
  const lease = await practice("prepare",practiceScope);
  assert(lease.state==="reserved" && lease.source.title!=="Assessor Resources: Marking keys","Practice only reserves learner-visible materials");
  assert((await practice("prepare",practiceScope)).state==="generating","Concurrent generation leases are fenced");
  await rejects(() => db.query("select public.lms_practice_finish($1,'[]')",[lease.requestId]),"42501","permission denied","Students cannot manufacture generated questions");
  await db.exec("reset role");
  const candidate = {prompt:"Why report hazards?",choices:["To prevent incidents","To delay work","To erase records","To skip training"],correct:0,
    explanation:"Reporting helps prevent incidents.",evidence:"Reporting hazards helps you prevent incidents.",topic:"Hazard reporting"};
  const finishPractice = (id,questions) => db.query("select public.lms_practice_finish($1,$2::jsonb) result",[id,JSON.stringify(questions)]);
  assert((await finishPractice(lease.requestId,[candidate,candidate])).rows[0].result===1,"Worker saves one copy of a repeated practice question");
  await db.exec("set role authenticated");
  const served = (await practice("next",practiceScope)).question;
  assert(served?.feedback===null && served?.correct===undefined,"Answer and feedback withheld before submission");
  await setActor(trainer);
  await rejects(() => practice("answer",{...practiceScope,questionId:served.id,selected:0}),"42501","enrolled unit","Unenrolled student cannot submit another student's answer");
  await setActor(approver);
  const feedback = await practice("answer",{...practiceScope,questionId:served.id,selected:0});
  assert(feedback.feedback.correct===0 && feedback.feedback.selected===0,"Answer submission returns marked feedback");
  assert((await practice("answer",{...practiceScope,questionId:served.id,selected:1})).feedback.selected===0,"A repeated submission cannot change the recorded answer");
  assert((await practice("bookmark",{...practiceScope,questionId:served.id,saved:true})).saved,"Question bookmarks persist");
  const studentProgress = await practice("progress",practiceScope);
  assert(studentProgress.answered===1 && studentProgress.accuracy===100 && studentProgress.saved.length===1,"Progress reflects recorded answers and saved questions");
  assert((await practice("next",practiceScope)).state==="generate","Practice continues with new questions after the bank is exhausted");
  await rejects(() => practice("next",{...practiceScope,assignmentId:"00000000-0000-4000-8000-000000000000"}),"42501","not assigned","Assessment practice rejects an unassigned id");
  await db.exec("reset role");
  const assignment = (await db.query("select id from public.asm_assignments limit 1")).rows[0].id;
  await db.exec("set role authenticated");
  assert((await practice("prepare",{assignmentId:assignment,difficulty:"advanced"})).assessmentTitle==="Workplace safety",
    "Assigned assessment practice resolves the authorised unit and title");
  await setActor(admin);
  await bulk("unpublish",{id:next.id});
  await db.exec("reset role; update public.unit_contents set visible_to_students=false where id=991; set role authenticated");
  await setActor(approver);
  await rejects(() => practice("recall",{...practiceScope,questionId:served.id}),"42501","no longer available","Removing student access to the source hides its practice questions");

} finally {
  await db.close();
}
