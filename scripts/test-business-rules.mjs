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
  for (const file of ["20261120220000_business_rules.sql", "20261120221000_business_rule_lms_upload.sql"]) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"));
  }
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
} finally {
  await db.close();
}
