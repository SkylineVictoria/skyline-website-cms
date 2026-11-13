-- ASSESSMENT MANAGEMENT (ASM-01, part 1 of 2): data-driven, versioned, form-built assessments mapped to course > unit and
-- delivered to batches; attempts with JSONB responses; assessor-only keys in their own table; marking, feedback, reassessment,
-- unit outcomes with sign-off; calendar events; notifications; an append-only audit log. Additive only: nothing existing is
-- dropped, renamed, narrowed or loosened. Every table has RLS with explicit SELECT policies and NO insert/update/delete policy:
-- writes go through the security-definer RPCs of part 2 (20261113440000_assessment_rpcs.sql).
--
-- Identity (docs/assessment-integration/DECISIONS.md D-02): admins are CMS Admins or RTO Managers; trainers are active
-- hr.staff_profiles on batch_trainers (or named on an assignment); students are portal_student_id(). Tenant: every row carries
-- tenant_id copied from its course (D-03), nullable for the legacy institution exactly like cms_courses.
--
-- Version definition (D-06), stored in asm_versions.definition and NEVER containing assessor data (D-05):
--   { "instructions": text, "tasks": [ { "id", "title", "instructions", "sections": [ { "id", "title", "description", "showIf",
--     "questions": [ { "id", "type", "label", "helpText", "required", "assessorOnly", "markingMode", "config", "responseSchema",
--                      "criteria": [{"id","text"}], "rubric": {"levels":[{"id","label","score"}]}, "showIf", "children": [...] } ] } ] } ] }
--   Forbidden keys anywhere in a definition: key, answerKey, modelAnswer, assessorGuidance, assessorNotes, rubricAssessor.
-- Responses (asm_attempts.responses) are one JSON object keyed by question id; a repeating group is an array of such objects,
-- a case study an object keyed by its children's ids. Validation against responseSchema is in part 2 (asm_validate_responses).

-- ------------------------------------------------------------------ roles
create or replace function public.asm_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
 select public.cms_is_admin() or public.cms_is_rto_manager();
$$;
revoke all on function public.asm_is_admin() from public, anon;
grant execute on function public.asm_is_admin() to authenticated;

-- The signed-in trainer: an active HR staff profile linked to this login (the role row is a hint, not a gate: D-15).
create or replace function public.asm_trainer_profile() returns uuid
language sql stable security definer set search_path = public as $$
 select p.id from hr.staff_profiles p where p.auth_user_id = auth.uid() and p.status = 'active' limit 1;
$$;
revoke all on function public.asm_trainer_profile() from public, anon;
grant execute on function public.asm_trainer_profile() to authenticated;

create or replace function public.asm_student_id() returns uuid
language sql stable security definer set search_path = public as $$
 select public.portal_student_id();
$$;
revoke all on function public.asm_student_id() from public, anon;
grant execute on function public.asm_student_id() to authenticated;

-- ------------------------------------------------------------------ tenant-level settings (D-09)
create table public.asm_settings (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 max_attempts integer not null default 3 check (max_attempts between 1 and 10),
 reassessment_days integer not null default 5 check (reassessment_days between 1 and 90),
 late_submission text not null default 'allow' check (late_submission in ('allow', 'block')),
 rollup_rule text not null default 'all_satisfactory' check (rollup_rule in ('all_satisfactory', 'assessor_only')),
 due_soon_days integer not null default 3 check (due_soon_days between 1 and 30),
 declaration_text text not null default 'I declare that the work submitted is my own, that I have not copied it from any other person or source, that no part of it has been written for me by another person, and that I understand reassessment and appeal arrangements. I consent to this submission being checked for plagiarism and kept as an assessment record.',
 instructions text not null default '',
 evidence_max_mb integer not null default 25 check (evidence_max_mb between 1 and 200),
 evidence_allowed_types text[] not null default array['application/pdf','image/png','image/jpeg','image/webp','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation','text/plain','video/mp4','audio/mpeg','audio/mp4','application/zip'],
 updated_by uuid,
 updated_at timestamptz not null default now()
);
create unique index asm_settings_tenant_key on public.asm_settings(coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table public.asm_settings enable row level security;
revoke all on public.asm_settings from public, anon, authenticated;
grant select on public.asm_settings to authenticated;
create policy asm_settings_tenant on public.asm_settings as restrictive for select to authenticated using (public.tenant_scope(tenant_id));
create policy asm_settings_read on public.asm_settings for select to authenticated using (public.asm_is_admin() or public.asm_trainer_profile() is not null or public.asm_student_id() is not null);
insert into public.asm_settings(tenant_id) values (null);

-- ------------------------------------------------------------------ tenant binding for every asm_* row
-- tg_argv[0] = parent table, tg_argv[1] = the column holding the parent id. The parent's tenant wins; a supplied tenant that
-- differs is refused (never a default tenant, never a client tenant id).
create or replace function public.asm_bind_tenant() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_parent uuid; v_found boolean := false; v_key text;
begin
 if tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id then
  raise exception 'Tenant ownership is immutable' using errcode = '42501';
 end if;
 v_key := to_jsonb(new)->>tg_argv[1];
 if v_key is null then raise exception 'Parent ownership missing' using errcode = '23503'; end if;
 execute format('select tenant_id, true from %s where id::text = $1', tg_argv[0]) into v_parent, v_found using v_key;
 if not coalesce(v_found, false) then raise exception 'Parent ownership missing' using errcode = '23503'; end if;
 if new.tenant_id is not null and new.tenant_id is distinct from v_parent then raise exception 'Cross-tenant parent' using errcode = '23503'; end if;
 new.tenant_id := v_parent;
 return new;
end $$;
revoke all on function public.asm_bind_tenant() from public, anon, authenticated;

create or replace function public.asm_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create or replace function public.asm_refuse_change() returns trigger language plpgsql as $$
begin raise exception '% rows are append-only', tg_table_name using errcode = '42501'; end $$;

-- ------------------------------------------------------------------ unit elements, performance criteria, evidence, conditions
create table public.asm_unit_elements (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 unit_id text not null references public.cms_course_units(id) on delete cascade,
 kind text not null check (kind in ('element', 'performance_criterion', 'performance_evidence', 'knowledge_evidence', 'assessment_condition', 'foundation_skill')),
 parent_id uuid references public.asm_unit_elements(id) on delete cascade,
 code text not null default '' check (char_length(code) <= 40),
 text text not null check (char_length(btrim(text)) between 1 and 4000),
 sort integer not null default 0,
 is_active boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index asm_unit_elements_unit_idx on public.asm_unit_elements(unit_id, kind, sort);
create trigger asm_unit_elements_tenant before insert or update on public.asm_unit_elements for each row execute function public.asm_bind_tenant('public.cms_course_units', 'unit_id');
create trigger asm_unit_elements_touch before update on public.asm_unit_elements for each row execute function public.asm_touch();

-- ------------------------------------------------------------------ question bank (versioned, reusable)
create table public.asm_question_bank (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 course_id text references public.cms_courses(id) on delete set null,
 unit_id text references public.cms_course_units(id) on delete set null,
 title text not null check (char_length(btrim(title)) between 1 and 200),
 tags text[] not null default '{}',
 question_type text not null check (question_type ~ '^[a-z][a-z0-9_]{1,40}$'),
 current_version_no integer not null default 0,
 archived_at timestamptz,
 created_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index asm_question_bank_unit_idx on public.asm_question_bank(unit_id) where archived_at is null;
create trigger asm_question_bank_touch before update on public.asm_question_bank for each row execute function public.asm_touch();
-- A bank question belongs to its course's tenant when it names one; otherwise it stays with the caller's institution (null = legacy).
create or replace function public.asm_question_bank_tenant() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_parent uuid;
begin
 if tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id then raise exception 'Tenant ownership is immutable' using errcode = '42501'; end if;
 if new.course_id is not null then
  select tenant_id into v_parent from public.cms_courses where id = new.course_id;
  if not found then raise exception 'Parent ownership missing' using errcode = '23503'; end if;
  if new.tenant_id is not null and new.tenant_id is distinct from v_parent then raise exception 'Cross-tenant parent' using errcode = '23503'; end if;
  new.tenant_id := v_parent;
 end if;
 return new;
end $$;
revoke all on function public.asm_question_bank_tenant() from public, anon, authenticated;
create trigger asm_question_bank_tenant before insert or update on public.asm_question_bank for each row execute function public.asm_question_bank_tenant();

create table public.asm_question_bank_versions (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 bank_id uuid not null references public.asm_question_bank(id) on delete cascade,
 version_no integer not null check (version_no >= 1),
 definition jsonb not null,
 keys jsonb not null default '{}',
 created_by uuid,
 created_at timestamptz not null default now(),
 unique (bank_id, version_no)
);
create trigger asm_question_bank_versions_tenant before insert or update on public.asm_question_bank_versions for each row execute function public.asm_bind_tenant('public.asm_question_bank', 'bank_id');
create trigger asm_question_bank_versions_frozen before update or delete on public.asm_question_bank_versions for each row execute function public.asm_refuse_change();

-- ------------------------------------------------------------------ assessments and immutable versions (D-06)
create table public.asm_assessments (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 course_id text not null references public.cms_courses(id) on delete restrict,
 unit_id text references public.cms_course_units(id) on delete restrict,
 code text check (code is null or char_length(btrim(code)) between 1 and 40),
 title text not null check (char_length(btrim(title)) between 1 and 200),
 description text not null default '' check (char_length(description) <= 4000),
 is_template boolean not null default false,
 current_version_id uuid,
 settings_override jsonb not null default '{}' check (jsonb_typeof(settings_override) = 'object'),
 archived_at timestamptz,
 created_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index asm_assessments_code_key on public.asm_assessments(course_id, lower(code)) where code is not null and archived_at is null;
create index asm_assessments_unit_idx on public.asm_assessments(unit_id);
create trigger asm_assessments_tenant before insert or update on public.asm_assessments for each row execute function public.asm_bind_tenant('public.cms_courses', 'course_id');
create trigger asm_assessments_touch before update on public.asm_assessments for each row execute function public.asm_touch();

-- Assessor-only data must never sit in a definition (D-05).
create or replace function public.asm_jsonb_forbidden_key(p jsonb) returns text
language plpgsql immutable as $$
declare k text; v jsonb; r text;
begin
 if p is null then return null; end if;
 if jsonb_typeof(p) = 'object' then
  for k, v in select * from jsonb_each(p) loop
   if k in ('key', 'answerKey', 'modelAnswer', 'assessorGuidance', 'assessorNotes', 'rubricAssessor') then return k; end if;
   r := public.asm_jsonb_forbidden_key(v); if r is not null then return r; end if;
  end loop;
 elsif jsonb_typeof(p) = 'array' then
  for v in select * from jsonb_array_elements(p) loop
   r := public.asm_jsonb_forbidden_key(v); if r is not null then return r; end if;
  end loop;
 end if;
 return null;
end $$;

create table public.asm_versions (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 assessment_id uuid not null references public.asm_assessments(id) on delete cascade,
 version_no integer not null check (version_no >= 1),
 status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
 definition jsonb not null default '{"tasks": []}' check (jsonb_typeof(definition) = 'object' and jsonb_typeof(definition->'tasks') = 'array'),
 checksum text check (checksum is null or checksum ~ '^[a-f0-9]{64}$'),
 published_at timestamptz,
 published_by uuid,
 retired_at timestamptz,
 created_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (assessment_id, version_no),
 check ((status = 'published' or status = 'retired') = (checksum is not null and published_at is not null)),
 check (public.asm_jsonb_forbidden_key(definition) is null)
);
create unique index asm_versions_one_draft on public.asm_versions(assessment_id) where status = 'draft';
create index asm_versions_assessment_idx on public.asm_versions(assessment_id, version_no desc);
alter table public.asm_assessments add constraint asm_assessments_current_version_fk foreign key (current_version_id) references public.asm_versions(id) on delete set null;
create trigger asm_versions_tenant before insert or update on public.asm_versions for each row execute function public.asm_bind_tenant('public.asm_assessments', 'assessment_id');
create trigger asm_versions_touch before update on public.asm_versions for each row execute function public.asm_touch();

-- A published version is frozen: its definition, number and assessment never change; status only moves forward.
create or replace function public.asm_versions_guard() returns trigger language plpgsql as $$
begin
 if tg_op = 'DELETE' then
  if old.status <> 'draft' then raise exception 'A published version cannot be deleted' using errcode = '42501'; end if;
  return old;
 end if;
 if new.assessment_id <> old.assessment_id or new.version_no <> old.version_no then raise exception 'Version identity is immutable' using errcode = '42501'; end if;
 if old.status in ('published', 'retired') then
  if new.definition is distinct from old.definition or new.checksum is distinct from old.checksum or new.published_at is distinct from old.published_at or new.published_by is distinct from old.published_by then
   raise exception 'A published version is immutable; edit creates a new draft' using errcode = '42501';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then raise exception 'A retired version stays retired' using errcode = '42501'; end if;
  if old.status = 'published' and new.status = 'draft' then raise exception 'A published version cannot go back to draft' using errcode = '42501'; end if;
 end if;
 if new.status = 'published' and old.status = 'draft' then
  if new.checksum is distinct from encode(sha256(convert_to(new.definition::text, 'UTF8')), 'hex') then raise exception 'Checksum does not match the definition' using errcode = '23514'; end if;
 end if;
 return new;
end $$;
create trigger asm_versions_guard before update or delete on public.asm_versions for each row execute function public.asm_versions_guard();

-- A question and its children (case study, repeating group) in pre-order.
create or replace function public.asm_question_tree(p_q jsonb, p_parent text, p_depth integer)
returns table (question_id text, question_type text, label text, required boolean, assessor_only boolean, marking_mode text, parent_question_id text, depth integer)
language plpgsql immutable as $$
declare c jsonb;
begin
 question_id := p_q->>'id'; question_type := p_q->>'type'; label := coalesce(p_q->>'label', ''); required := coalesce((p_q->>'required')::boolean, false);
 assessor_only := coalesce((p_q->>'assessorOnly')::boolean, p_q->>'type' in ('observation_checklist', 'third_party_report'));
 marking_mode := coalesce(p_q->>'markingMode', case when p_q->>'type' in ('instruction', 'content') then 'none' else 'criteria' end);
 parent_question_id := p_parent; depth := p_depth;
 return next;
 for c in select * from jsonb_array_elements(coalesce(p_q->'children', '[]'::jsonb)) loop
  return query select * from public.asm_question_tree(c, p_q->>'id', p_depth + 1);
 end loop;
end $$;

-- Flattened questions of a definition (tasks > sections > questions > children) for mapping, coverage and reports.
create or replace function public.asm_definition_questions(p_definition jsonb)
returns table (task_id text, task_title text, section_id text, section_title text, question_id text, question_type text, label text, required boolean,
               assessor_only boolean, marking_mode text, parent_question_id text, depth integer, pos integer)
language sql immutable as $$
 select t.value->>'id', t.value->>'title', s.value->>'id', s.value->>'title', x.question_id, x.question_type, x.label, x.required, x.assessor_only, x.marking_mode,
        x.parent_question_id, x.depth, (row_number() over (order by t.ordinality, s.ordinality, q.ordinality, x.ordinality))::integer
 from jsonb_array_elements(coalesce(p_definition->'tasks', '[]'::jsonb)) with ordinality t
 cross join lateral jsonb_array_elements(coalesce(t.value->'sections', '[]'::jsonb)) with ordinality s
 cross join lateral jsonb_array_elements(coalesce(s.value->'questions', '[]'::jsonb)) with ordinality q
 cross join lateral public.asm_question_tree(q.value, null, 0) with ordinality x
$$;

create view public.asm_version_questions with (security_invoker = true) as
 select v.id as version_id, v.assessment_id, v.version_no, v.status, q.*
 from public.asm_versions v cross join lateral public.asm_definition_questions(v.definition) q;

-- ------------------------------------------------------------------ assessor-only keys (D-05)
create table public.asm_question_keys (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 version_id uuid not null references public.asm_versions(id) on delete cascade,
 question_id text not null check (char_length(question_id) between 1 and 80),
 model_answer text,
 answer_key jsonb,
 assessor_guidance text,
 rubric_levels jsonb,
 updated_by uuid,
 updated_at timestamptz not null default now(),
 unique (version_id, question_id)
);
create trigger asm_question_keys_tenant before insert or update on public.asm_question_keys for each row execute function public.asm_bind_tenant('public.asm_versions', 'version_id');
create trigger asm_question_keys_touch before update on public.asm_question_keys for each row execute function public.asm_touch();

-- ------------------------------------------------------------------ unit mapping matrix (data, never per-unit code)
create table public.asm_unit_mappings (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 version_id uuid not null references public.asm_versions(id) on delete cascade,
 question_id text not null check (char_length(question_id) between 1 and 80),
 criterion_id text check (criterion_id is null or char_length(criterion_id) between 1 and 80),
 element_id uuid not null references public.asm_unit_elements(id) on delete cascade,
 created_at timestamptz not null default now()
);
create unique index asm_unit_mappings_key on public.asm_unit_mappings(version_id, question_id, coalesce(criterion_id, ''), element_id);
create index asm_unit_mappings_element_idx on public.asm_unit_mappings(element_id);
create trigger asm_unit_mappings_tenant before insert or update on public.asm_unit_mappings for each row execute function public.asm_bind_tenant('public.asm_versions', 'version_id');

-- ------------------------------------------------------------------ assignments: version -> batch (+ student and trainer adjustments)
create table public.asm_assignments (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 assessment_id uuid not null references public.asm_assessments(id) on delete restrict,
 version_id uuid not null references public.asm_versions(id) on delete restrict,
 batch_id uuid not null references public.batches(id) on delete restrict,
 available_from timestamptz not null default now(),
 due_at timestamptz not null,
 late_until timestamptz,
 status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
 reassign_rule text not null default 'follow_batch' check (reassign_rule in ('follow_batch', 'keep')),
 notes text not null default '' check (char_length(notes) <= 2000),
 created_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (version_id, batch_id),
 check (due_at >= available_from),
 check (late_until is null or late_until >= due_at)
);
create index asm_assignments_batch_idx on public.asm_assignments(batch_id, status);
create index asm_assignments_assessment_idx on public.asm_assignments(assessment_id);
create trigger asm_assignments_tenant before insert or update on public.asm_assignments for each row execute function public.asm_bind_tenant('public.asm_versions', 'version_id');
create trigger asm_assignments_touch before update on public.asm_assignments for each row execute function public.asm_touch();

create table public.asm_assignment_students (
 assignment_id uuid not null references public.asm_assignments(id) on delete cascade,
 student_id uuid not null references public.enrollment_students(id) on delete cascade,
 excluded boolean not null default false,
 added_manually boolean not null default false,
 due_at timestamptz,
 note text not null default '' check (char_length(note) <= 500),
 updated_by uuid,
 updated_at timestamptz not null default now(),
 primary key (assignment_id, student_id)
);
create index asm_assignment_students_student_idx on public.asm_assignment_students(student_id);

create table public.asm_assignment_trainers (
 assignment_id uuid not null references public.asm_assignments(id) on delete cascade,
 staff_id uuid not null references hr.staff_profiles(id) on delete cascade,
 primary key (assignment_id, staff_id)
);

-- Who sits an assignment: active enrolments of its batch (unless excluded) plus students added by hand.
create or replace function public.asm_assignment_eligible(p_assignment uuid) returns setof uuid
language sql stable security definer set search_path = public as $$
 select e.student_id from public.asm_assignments a join public.batch_enrolments e on e.batch_id = a.batch_id and e.status = 'active'
 where a.id = p_assignment and a.status <> 'cancelled'
   and not exists (select 1 from public.asm_assignment_students s where s.assignment_id = a.id and s.student_id = e.student_id and s.excluded)
 union
 select s.student_id from public.asm_assignments a join public.asm_assignment_students s on s.assignment_id = a.id and s.added_manually and not s.excluded
 where a.id = p_assignment and a.status <> 'cancelled';
$$;
revoke all on function public.asm_assignment_eligible(uuid) from public, anon, authenticated;

create or replace function public.asm_trainer_on_assignment(p_assignment uuid, p_profile uuid default public.asm_trainer_profile()) returns boolean
language sql stable security definer set search_path = public as $$
 select p_profile is not null and exists (
  select 1 from public.asm_assignments a
  left join public.batch_trainers bt on bt.batch_id = a.batch_id and bt.staff_id = p_profile
  left join public.asm_assignment_trainers at on at.assignment_id = a.id and at.staff_id = p_profile
  where a.id = p_assignment and (bt.staff_id is not null or at.staff_id is not null));
$$;
revoke all on function public.asm_trainer_on_assignment(uuid, uuid) from public, anon;
grant execute on function public.asm_trainer_on_assignment(uuid, uuid) to authenticated;

create or replace function public.asm_trainer_on_version(p_version uuid) returns boolean
language sql stable security definer set search_path = public as $$
 select exists (select 1 from public.asm_assignments a where a.version_id = p_version and public.asm_trainer_on_assignment(a.id));
$$;
revoke all on function public.asm_trainer_on_version(uuid) from public, anon;
grant execute on function public.asm_trainer_on_version(uuid) to authenticated;

create or replace function public.asm_student_on_assignment(p_assignment uuid) returns boolean
language sql stable security definer set search_path = public as $$
 select public.asm_student_id() is not null and public.asm_student_id() in (select public.asm_assignment_eligible(p_assignment));
$$;
revoke all on function public.asm_student_on_assignment(uuid) from public, anon;
grant execute on function public.asm_student_on_assignment(uuid) to authenticated;

create or replace function public.asm_student_on_version(p_version uuid) returns boolean
language sql stable security definer set search_path = public as $$
 select exists (select 1 from public.asm_assignments a where a.version_id = p_version and a.status <> 'cancelled' and public.asm_student_on_assignment(a.id));
$$;
revoke all on function public.asm_student_on_version(uuid) from public, anon;
grant execute on function public.asm_student_on_version(uuid) to authenticated;

-- ------------------------------------------------------------------ attempts (append-only after submission)
create sequence public.asm_receipt_seq;
create table public.asm_attempts (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 assignment_id uuid not null references public.asm_assignments(id) on delete restrict,
 version_id uuid not null references public.asm_versions(id) on delete restrict,
 student_id uuid not null references public.enrollment_students(id) on delete restrict,
 attempt_no integer not null default 1 check (attempt_no between 1 and 10),
 state text not null default 'draft' check (state in ('draft', 'submitted', 'marking', 'returned', 'final', 'void')),
 responses jsonb not null default '{}' check (jsonb_typeof(responses) = 'object'),
 assessor_responses jsonb not null default '{}' check (jsonb_typeof(assessor_responses) = 'object'),
 responses_hash text check (responses_hash is null or responses_hash ~ '^[a-f0-9]{64}$'),
 declaration jsonb check (declaration is null or jsonb_typeof(declaration) = 'object'),
 receipt_no text unique check (receipt_no is null or receipt_no ~ '^ASM-[0-9]{4}-[0-9]{6}$'),
 due_at timestamptz,
 outcome text check (outcome is null or outcome in ('S', 'NYS')),
 overall_feedback text not null default '' check (char_length(overall_feedback) <= 8000),
 started_at timestamptz not null default now(),
 submitted_at timestamptz,
 marking_started_at timestamptz,
 returned_at timestamptz,
 finalised_at timestamptz,
 voided_at timestamptz,
 void_reason text,
 marked_by uuid,
 row_version integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (assignment_id, student_id, attempt_no),
 check ((state in ('submitted', 'marking', 'returned', 'final')) = (submitted_at is not null and responses_hash is not null and declaration is not null and receipt_no is not null) or state = 'void')
);
create index asm_attempts_student_idx on public.asm_attempts(student_id, state);
create index asm_attempts_assignment_idx on public.asm_attempts(assignment_id, state);
create trigger asm_attempts_tenant before insert or update on public.asm_attempts for each row execute function public.asm_bind_tenant('public.asm_assignments', 'assignment_id');

-- Submitted attempts are locked; identity never changes; row_version moves on every update (concurrency, brief 9).
create or replace function public.asm_attempts_guard() returns trigger language plpgsql as $$
begin
 if tg_op = 'DELETE' then raise exception 'Attempts are never deleted' using errcode = '42501'; end if;
 if new.assignment_id <> old.assignment_id or new.version_id <> old.version_id or new.student_id <> old.student_id or new.attempt_no <> old.attempt_no then
  raise exception 'Attempt identity is immutable' using errcode = '42501';
 end if;
 if old.state <> 'draft' and (new.responses is distinct from old.responses or new.declaration is distinct from old.declaration
     or new.responses_hash is distinct from old.responses_hash or new.submitted_at is distinct from old.submitted_at or new.receipt_no is distinct from old.receipt_no) then
  raise exception 'A submitted attempt is locked' using errcode = '42501';
 end if;
 if old.state in ('final', 'void') and new.state <> old.state then raise exception 'A % attempt cannot change state', old.state using errcode = '42501'; end if;
 if new.state <> old.state and not (
     (old.state = 'draft' and new.state in ('submitted', 'void')) or (old.state = 'submitted' and new.state in ('marking', 'void')) or
     (old.state = 'marking' and new.state in ('returned', 'final', 'void')) or (old.state = 'returned' and new.state in ('final', 'void'))) then
  raise exception 'Attempt state % -> % is not allowed', old.state, new.state using errcode = '42501';
 end if;
 new.row_version := old.row_version + 1;
 new.updated_at := now();
 return new;
end $$;
create trigger asm_attempts_guard before update or delete on public.asm_attempts for each row execute function public.asm_attempts_guard();

create or replace function public.asm_trainer_on_attempt(p_attempt uuid) returns boolean
language sql stable security definer set search_path = public as $$
 select exists (select 1 from public.asm_attempts t where t.id = p_attempt and public.asm_trainer_on_assignment(t.assignment_id));
$$;
revoke all on function public.asm_trainer_on_attempt(uuid) from public, anon;
grant execute on function public.asm_trainer_on_attempt(uuid) to authenticated;

-- A trainer of any batch the student is (or was) enrolled in; security definer because batch tables are staff-only under RLS.
create or replace function public.asm_trainer_of_student(p_student uuid) returns boolean
language sql stable security definer set search_path = public as $$
 select public.asm_trainer_profile() is not null and exists (
  select 1 from public.batch_enrolments e join public.batch_trainers bt on bt.batch_id = e.batch_id
  where e.student_id = p_student and bt.staff_id = public.asm_trainer_profile());
$$;
revoke all on function public.asm_trainer_of_student(uuid) from public, anon;
grant execute on function public.asm_trainer_of_student(uuid) to authenticated;

create or replace function public.asm_student_on_attempt(p_attempt uuid) returns boolean
language sql stable security definer set search_path = public as $$
 select exists (select 1 from public.asm_attempts t where t.id = p_attempt and t.student_id = public.asm_student_id());
$$;
revoke all on function public.asm_student_on_attempt(uuid) from public, anon;
grant execute on function public.asm_student_on_attempt(uuid) to authenticated;

-- ------------------------------------------------------------------ evidence files (private bucket, path = attempt id first)
create table public.asm_evidence_files (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 attempt_id uuid not null references public.asm_attempts(id) on delete cascade,
 question_id text not null check (char_length(question_id) between 1 and 80),
 group_index integer,
 by_assessor boolean not null default false,
 object_path text not null check (object_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_.-]{1,80}/[^/]{1,200}$'),
 file_name text not null check (char_length(file_name) between 1 and 200),
 mime text not null default 'application/octet-stream',
 bytes integer not null default 0 check (bytes >= 0),
 sha256 text check (sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
 uploaded_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 -- a reassessment attempt carries the previous attempt's files forward (same object, new attempt row)
 unique (attempt_id, object_path)
);
create index asm_evidence_files_attempt_idx on public.asm_evidence_files(attempt_id, question_id);
create trigger asm_evidence_files_tenant before insert or update on public.asm_evidence_files for each row execute function public.asm_bind_tenant('public.asm_attempts', 'attempt_id');

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('assessment-evidence', 'assessment-evidence', false, 209715200,
 array['application/pdf','image/png','image/jpeg','image/webp','image/gif','image/heic','image/heif',
  'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain','text/csv','video/mp4','video/quicktime','audio/mpeg','audio/mp4','audio/wav','application/zip'])
on conflict (id) do nothing;

-- A student writes under their own DRAFT attempt (first path segment); an assessor writes under "<attempt>/assessor/" while marking.
create or replace function public.asm_evidence_path_writable(p_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_attempt uuid; v_seg text; t public.asm_attempts;
begin
 if auth.uid() is null or p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_.-]{1,80}/[^/]{1,200}$' then return false; end if;
 v_attempt := split_part(p_name, '/', 1)::uuid; v_seg := split_part(p_name, '/', 2);
 select * into t from public.asm_attempts where id = v_attempt;
 if t.id is null then return false; end if;
 if v_seg = 'assessor' then return t.state in ('submitted', 'marking') and public.asm_trainer_on_assignment(t.assignment_id); end if;
 return t.state = 'draft' and t.student_id = public.asm_student_id();
end $$;

create or replace function public.asm_evidence_path_readable(p_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_attempt uuid; t public.asm_attempts;
begin
 if auth.uid() is null or p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' then return false; end if;
 v_attempt := split_part(p_name, '/', 1)::uuid;
 select * into t from public.asm_attempts where id = v_attempt;
 if t.id is null then return false; end if;
 return public.asm_is_admin() or public.asm_trainer_on_assignment(t.assignment_id) or t.student_id = public.asm_student_id();
end $$;
-- Storage evaluates its policies as the requesting role, so the two path checks stay executable by signed-in users (they only
-- answer about the caller's own access).
revoke all on function public.asm_evidence_path_writable(text), public.asm_evidence_path_readable(text) from public, anon;
grant execute on function public.asm_evidence_path_writable(text), public.asm_evidence_path_readable(text) to authenticated;

drop policy if exists asm_evidence_insert on storage.objects;
create policy asm_evidence_insert on storage.objects for insert to authenticated
 with check (bucket_id = 'assessment-evidence' and public.asm_evidence_path_writable(name));
drop policy if exists asm_evidence_read on storage.objects;
create policy asm_evidence_read on storage.objects for select to authenticated
 using (bucket_id = 'assessment-evidence' and public.asm_evidence_path_readable(name));
drop policy if exists asm_evidence_delete on storage.objects;
create policy asm_evidence_delete on storage.objects for delete to authenticated
 using (bucket_id = 'assessment-evidence' and public.asm_evidence_path_writable(name));

-- ------------------------------------------------------------------ results: per question / criterion, per task
create table public.asm_results (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 attempt_id uuid not null references public.asm_attempts(id) on delete cascade,
 question_id text not null check (char_length(question_id) between 1 and 80),
 criterion_id text check (criterion_id is null or char_length(criterion_id) between 1 and 80),
 suggested_outcome text check (suggested_outcome is null or suggested_outcome in ('S', 'NYS')),
 suggested_detail jsonb,
 outcome text check (outcome is null or outcome in ('S', 'NYS')),
 score numeric(8,2),
 rubric_level_id text,
 feedback text not null default '' check (char_length(feedback) <= 8000),
 marked_by uuid,
 marked_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index asm_results_key on public.asm_results(attempt_id, question_id, coalesce(criterion_id, ''));
create trigger asm_results_tenant before insert or update on public.asm_results for each row execute function public.asm_bind_tenant('public.asm_attempts', 'attempt_id');
create trigger asm_results_touch before update on public.asm_results for each row execute function public.asm_touch();

create table public.asm_task_results (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 attempt_id uuid not null references public.asm_attempts(id) on delete cascade,
 task_id text not null check (char_length(task_id) between 1 and 80),
 rollup_suggested text check (rollup_suggested is null or rollup_suggested in ('S', 'NYS')),
 outcome text check (outcome is null or outcome in ('S', 'NYS')),
 feedback text not null default '' check (char_length(feedback) <= 8000),
 signed_by uuid,
 signed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (attempt_id, task_id)
);
create trigger asm_task_results_tenant before insert or update on public.asm_task_results for each row execute function public.asm_bind_tenant('public.asm_attempts', 'attempt_id');
create trigger asm_task_results_touch before update on public.asm_task_results for each row execute function public.asm_touch();

-- Results of a returned or final attempt are frozen (decision integrity).
create or replace function public.asm_results_guard() returns trigger language plpgsql as $$
declare v_state text;
begin
 select state into v_state from public.asm_attempts where id = coalesce(new.attempt_id, old.attempt_id);
 if v_state in ('returned', 'final', 'void') and current_setting('asm.unlock_results', true) is distinct from 'true' then
  raise exception 'Results of a % attempt are locked', v_state using errcode = '42501';
 end if;
 return coalesce(new, old);
end $$;
create trigger asm_results_frozen before insert or update or delete on public.asm_results for each row execute function public.asm_results_guard();
create trigger asm_task_results_frozen before insert or update or delete on public.asm_task_results for each row execute function public.asm_results_guard();

-- ------------------------------------------------------------------ feedback thread, reassessments
create table public.asm_feedback (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 attempt_id uuid not null references public.asm_attempts(id) on delete cascade,
 question_id text check (question_id is null or char_length(question_id) between 1 and 80),
 author uuid not null default auth.uid(),
 author_role text not null check (author_role in ('admin', 'trainer', 'student')),
 body text not null check (char_length(btrim(body)) between 1 and 8000),
 created_at timestamptz not null default now()
);
create index asm_feedback_attempt_idx on public.asm_feedback(attempt_id, created_at);
create trigger asm_feedback_tenant before insert or update on public.asm_feedback for each row execute function public.asm_bind_tenant('public.asm_attempts', 'attempt_id');
create trigger asm_feedback_frozen before update or delete on public.asm_feedback for each row execute function public.asm_refuse_change();

create table public.asm_reassessments (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 attempt_id uuid not null references public.asm_attempts(id) on delete cascade,
 student_id uuid not null references public.enrollment_students(id) on delete restrict,
 requested_by uuid not null default auth.uid(),
 requested_role text not null check (requested_role in ('admin', 'trainer', 'student')),
 reason text not null default '' check (char_length(reason) <= 4000),
 state text not null default 'requested' check (state in ('requested', 'opened', 'declined')),
 new_due_at timestamptz,
 next_attempt_id uuid references public.asm_attempts(id) on delete set null,
 decided_by uuid,
 decided_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index asm_reassessments_attempt_idx on public.asm_reassessments(attempt_id);
create trigger asm_reassessments_tenant before insert or update on public.asm_reassessments for each row execute function public.asm_bind_tenant('public.asm_attempts', 'attempt_id');
create trigger asm_reassessments_touch before update on public.asm_reassessments for each row execute function public.asm_touch();

-- ------------------------------------------------------------------ unit outcomes: Competent / Not Yet Competent, signed, insert-only
create table public.asm_unit_outcomes (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 student_id uuid not null references public.enrollment_students(id) on delete restrict,
 unit_id text not null references public.cms_course_units(id) on delete restrict,
 assessment_id uuid references public.asm_assessments(id) on delete restrict,
 batch_id uuid references public.batches(id) on delete set null,
 outcome text not null check (outcome in ('C', 'NYC')),
 evidence_attempt_ids uuid[] not null default '{}',
 signed_by uuid not null,
 signed_staff_id uuid references hr.staff_profiles(id) on delete restrict,
 signed_role text not null check (signed_role in ('trainer', 'admin')),
 signed_name text not null check (char_length(btrim(signed_name)) between 1 and 200),
 signed_at timestamptz not null default now(),
 notes text not null default '' check (char_length(notes) <= 4000),
 supersedes_id uuid references public.asm_unit_outcomes(id) on delete restrict,
 created_at timestamptz not null default now()
);
create index asm_unit_outcomes_student_idx on public.asm_unit_outcomes(student_id, unit_id, signed_at desc);
create trigger asm_unit_outcomes_tenant before insert or update on public.asm_unit_outcomes for each row execute function public.asm_bind_tenant('public.cms_course_units', 'unit_id');
create trigger asm_unit_outcomes_frozen before update or delete on public.asm_unit_outcomes for each row execute function public.asm_refuse_change();

-- ------------------------------------------------------------------ calendar events (D-10), notifications (D-11), audit log
create table public.asm_schedule_events (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 assignment_id uuid not null references public.asm_assignments(id) on delete cascade,
 kind text not null check (kind in ('due', 'practical', 'observation', 'other')),
 title text not null check (char_length(btrim(title)) between 1 and 200),
 starts_at timestamptz not null,
 ends_at timestamptz,
 room_id uuid references public.classrooms(id) on delete set null,
 trainer_staff_id uuid references hr.staff_profiles(id) on delete set null,
 notes text not null default '' check (char_length(notes) <= 2000),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (ends_at is null or ends_at >= starts_at)
);
create index asm_schedule_events_time_idx on public.asm_schedule_events(starts_at);
create index asm_schedule_events_assignment_idx on public.asm_schedule_events(assignment_id);
create trigger asm_schedule_events_tenant before insert or update on public.asm_schedule_events for each row execute function public.asm_bind_tenant('public.asm_assignments', 'assignment_id');
create trigger asm_schedule_events_touch before update on public.asm_schedule_events for each row execute function public.asm_touch();

create table public.asm_notifications (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 recipient_auth_user uuid not null,
 recipient_role text not null check (recipient_role in ('student', 'trainer', 'admin')),
 event text not null check (event in ('published', 'due_soon', 'overdue', 'submitted', 'marked', 'reassessment', 'outcome', 'reassigned', 'extended')),
 title text not null check (char_length(title) between 1 and 200),
 body text not null default '' check (char_length(body) <= 4000),
 attempt_id uuid references public.asm_attempts(id) on delete set null,
 assignment_id uuid references public.asm_assignments(id) on delete set null,
 read_at timestamptz,
 created_at timestamptz not null default now()
);
create index asm_notifications_recipient_idx on public.asm_notifications(recipient_auth_user, read_at, created_at desc);

create table public.asm_audit_log (
 id bigint generated always as identity primary key,
 tenant_id uuid references public.tenants(id) on delete restrict,
 actor uuid,
 actor_role text not null check (actor_role in ('admin', 'trainer', 'student', 'system')),
 action text not null check (char_length(action) between 1 and 80),
 target_type text not null default '' check (char_length(target_type) <= 40),
 target_id text not null default '' check (char_length(target_id) <= 80),
 detail jsonb not null default '{}',
 created_at timestamptz not null default clock_timestamp()
);
create index asm_audit_log_target_idx on public.asm_audit_log(target_type, target_id, id desc);
create trigger asm_audit_log_frozen before update or delete on public.asm_audit_log for each row execute function public.asm_refuse_change();

-- Email rides the existing outbox (D-11): the in-app row is the subject of the delivery, exactly as bookings did.
alter table public.notification_deliveries add column if not exists assessment_event_id uuid references public.asm_notifications(id) on delete set null;
create index if not exists notification_deliveries_assessment_idx on public.notification_deliveries(assessment_event_id) where assessment_event_id is not null;
alter table public.notification_deliveries drop constraint if exists notification_deliveries_subject_ref;
alter table public.notification_deliveries add constraint notification_deliveries_subject_ref
 check (application_id is not null or support_ticket_id is not null or booking_id is not null or assessment_event_id is not null or event like 'support_ticket%') not valid;

-- ------------------------------------------------------------------ RLS: SELECT only; no client writes on any asm_* table
do $$
declare t text;
begin
 foreach t in array array['asm_unit_elements','asm_question_bank','asm_question_bank_versions','asm_assessments','asm_versions','asm_question_keys','asm_unit_mappings',
   'asm_assignments','asm_assignment_students','asm_assignment_trainers','asm_attempts','asm_evidence_files','asm_results','asm_task_results','asm_feedback',
   'asm_reassessments','asm_unit_outcomes','asm_schedule_events','asm_notifications','asm_audit_log'] loop
  execute format('alter table public.%I enable row level security', t);
  execute format('revoke all on public.%I from public, anon, authenticated', t);
  execute format('grant select on public.%I to authenticated', t);
  if t not in ('asm_assignment_students', 'asm_assignment_trainers') then
   execute format('create policy %I on public.%I as restrictive for select to authenticated using (public.tenant_scope(tenant_id))', t || '_tenant', t);
  end if;
 end loop;
end $$;
revoke all on sequence public.asm_receipt_seq from public, anon, authenticated;

create policy asm_unit_elements_read on public.asm_unit_elements for select to authenticated
 using (public.asm_is_admin() or public.asm_trainer_profile() is not null);
create policy asm_question_bank_read on public.asm_question_bank for select to authenticated using (public.asm_is_admin());
create policy asm_question_bank_versions_read on public.asm_question_bank_versions for select to authenticated using (public.asm_is_admin());
create policy asm_assessments_read on public.asm_assessments for select to authenticated
 using (public.asm_is_admin()
   or exists (select 1 from public.asm_assignments a where a.assessment_id = asm_assessments.id and (public.asm_trainer_on_assignment(a.id) or public.asm_student_on_assignment(a.id))));
create policy asm_versions_read on public.asm_versions for select to authenticated
 using (public.asm_is_admin() or (status <> 'draft' and (public.asm_trainer_on_version(id) or public.asm_student_on_version(id))));
create policy asm_question_keys_read on public.asm_question_keys for select to authenticated
 using (public.asm_is_admin() or public.asm_trainer_on_version(version_id));
create policy asm_unit_mappings_read on public.asm_unit_mappings for select to authenticated
 using (public.asm_is_admin() or public.asm_trainer_on_version(version_id));
create policy asm_assignments_read on public.asm_assignments for select to authenticated
 using (public.asm_is_admin() or public.asm_trainer_on_assignment(id) or public.asm_student_on_assignment(id));
create policy asm_assignment_students_read on public.asm_assignment_students for select to authenticated
 using (public.asm_is_admin() or public.asm_trainer_on_assignment(assignment_id) or student_id = public.asm_student_id());
create policy asm_assignment_trainers_read on public.asm_assignment_trainers for select to authenticated
 using (public.asm_is_admin() or public.asm_trainer_on_assignment(assignment_id));
create policy asm_attempts_read on public.asm_attempts for select to authenticated
 using (public.asm_is_admin() or public.asm_trainer_on_assignment(assignment_id) or student_id = public.asm_student_id());
create policy asm_evidence_files_read on public.asm_evidence_files for select to authenticated
 using (public.asm_is_admin() or public.asm_trainer_on_attempt(attempt_id) or public.asm_student_on_attempt(attempt_id));
-- Students read results and task results only once the attempt has been returned or finalised.
create policy asm_results_read on public.asm_results for select to authenticated
 using (public.asm_is_admin() or public.asm_trainer_on_attempt(attempt_id)
   or exists (select 1 from public.asm_attempts t where t.id = attempt_id and t.student_id = public.asm_student_id() and t.state in ('returned', 'final')));
create policy asm_task_results_read on public.asm_task_results for select to authenticated
 using (public.asm_is_admin() or public.asm_trainer_on_attempt(attempt_id)
   or exists (select 1 from public.asm_attempts t where t.id = attempt_id and t.student_id = public.asm_student_id() and t.state in ('returned', 'final')));
create policy asm_feedback_read on public.asm_feedback for select to authenticated
 using (public.asm_is_admin() or public.asm_trainer_on_attempt(attempt_id) or public.asm_student_on_attempt(attempt_id));
create policy asm_reassessments_read on public.asm_reassessments for select to authenticated
 using (public.asm_is_admin() or public.asm_trainer_on_attempt(attempt_id) or student_id = public.asm_student_id());
create policy asm_unit_outcomes_read on public.asm_unit_outcomes for select to authenticated
 using (public.asm_is_admin() or student_id = public.asm_student_id() or public.asm_trainer_of_student(student_id));
create policy asm_schedule_events_read on public.asm_schedule_events for select to authenticated
 using (public.asm_is_admin() or public.asm_trainer_on_assignment(assignment_id) or trainer_staff_id = public.asm_trainer_profile() or public.asm_student_on_assignment(assignment_id));
create policy asm_notifications_read on public.asm_notifications for select to authenticated using (recipient_auth_user = auth.uid());
create policy asm_audit_log_read on public.asm_audit_log for select to authenticated using (public.asm_is_admin());

-- ------------------------------------------------------------------ CMS menu: Master Data › Assessments (route allow-listed in src/pages/admin/lib/adminMenu.ts)
insert into public.admin_menu_items (id, parent_id, label, route, icon_key, sort_order, permission_key, permission_scope, is_system)
select 'rto_assessments', m.parent_id, 'Assessments', '/admin/assessments', 'file', 38, 'cms.admin', 'current', true
from public.admin_menu_items m where m.id = 'agency_course_fees'
on conflict (id) do nothing;
