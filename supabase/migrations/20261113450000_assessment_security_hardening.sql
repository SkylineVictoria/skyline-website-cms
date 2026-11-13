-- Assessment Management hardening, T2: RPC and RLS security review (docs/assessment-integration/HARDENING.md).
-- Gaps closed here, each with a negative test in supabase/tests/assessment_management.sql:
--  1. asm_admin trusted every id the client sent: an Admin / RTO Manager acting under another institution's domain could read
--     and edit assessments, versions, assignments, attempts, bank questions and outcomes of a different tenant by id.
--     Now asm_admin_scope_check() refuses (P0002, "not found") any referenced id outside the caller's tenant_scope, and every
--     list action is filtered by tenant_scope.
--  2. asm_trainer_on_assignment(assignment, profile) was callable by any signed-in user with any profile id (a membership
--     oracle) and ignored the tenant; it now answers only for the caller's own profile (admins and system jobs excepted)
--     and only inside the caller's tenant. Every trainer action and every trainer RLS policy goes through it.
--  3. The student RPC bound attempts by owner only; the tenant is checked too (defence in depth: a student cannot be enrolled
--     across tenants today, but the rule is now explicit).
--  4. Evidence reads by an admin ignored the tenant; asm_evidence_path_readable now requires tenant_scope of the attempt.
--  5. asm_calendar's admin branches listed every tenant's assignments.
--  6. Pure helpers (validators, JSON helpers) and trigger functions were executable by PUBLIC / anon with no search_path pin;
--     the view asm_version_questions was writable by anon / authenticated (harmless under security_invoker, but wrong).
-- Reviewed and found sound: SECURITY DEFINER + search_path on every RPC and policy helper; no client writes on asm_* tables;
-- assessor keys only through asm_question_keys (admin / trainer-on-version) and never in a student view; storage paths are
-- bound to an attempt id the policy checks; signed URLs are only possible where the SELECT policy admits the row.

-- ------------------------------------------------------------------ 6. grants and search_path on helpers / triggers / view
do $$
declare r record;
begin
 for r in select p.oid::regprocedure as fn, p.prosecdef, p.prorettype from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname like 'asm\_%' and p.proconfig is null loop
  execute format('alter function %s set search_path = public', r.fn);
  execute format('revoke all on function %s from public, anon', r.fn);
  -- pure helpers (validators, JSON helpers) stay callable by signed-in users: no data access, and the security_invoker view
  -- asm_version_questions evaluates asm_definition_questions as the caller; trigger functions are never callable
  if r.prorettype = 'trigger'::regtype then execute format('revoke all on function %s from authenticated', r.fn); end if;
 end loop;
end $$;
revoke all on public.asm_version_questions from public, anon, authenticated;
grant select on public.asm_version_questions to authenticated;

-- ------------------------------------------------------------------ 2. trainer scope: own profile only, inside the tenant
create or replace function public.asm_trainer_on_assignment(p_assignment uuid, p_profile uuid default public.asm_trainer_profile()) returns boolean
language sql stable security definer set search_path = public as $$
 select p_profile is not null
  and (auth.uid() is null or p_profile = public.asm_trainer_profile() or public.asm_is_admin())
  and exists (
   select 1 from public.asm_assignments a
   left join public.batch_trainers bt on bt.batch_id = a.batch_id and bt.staff_id = p_profile
   left join public.asm_assignment_trainers at on at.assignment_id = a.id and at.staff_id = p_profile
   where a.id = p_assignment and (bt.staff_id is not null or at.staff_id is not null)
     and (auth.uid() is null or public.tenant_scope(a.tenant_id)));
$$;

-- ------------------------------------------------------------------ 4. evidence reads inside the tenant
create or replace function public.asm_evidence_path_readable(p_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_attempt uuid; t public.asm_attempts;
begin
 if auth.uid() is null or p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' then return false; end if;
 v_attempt := split_part(p_name, '/', 1)::uuid;
 select * into t from public.asm_attempts where id = v_attempt;
 if t.id is null or not public.tenant_scope(t.tenant_id) then return false; end if;
 return coalesce(public.asm_is_admin() or public.asm_trainer_on_assignment(t.assignment_id) or t.student_id = public.asm_student_id(), false);
end $$;

-- ------------------------------------------------------------------ 1. admin: every client-sent id must be inside the caller's tenant
create or replace function public.asm_admin_scope_check(p_action text, d jsonb) returns void
language plpgsql stable security definer set search_path = public as $$
declare v uuid; v_text text;
begin
 v := public.asm_json_uuid(d, 'id');
 if v is not null then
  if p_action like 'assessment\_%' and not exists (select 1 from public.asm_assessments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Assessment not found' using errcode = 'P0002';
  elsif p_action like 'assignment\_%' and not exists (select 1 from public.asm_assignments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Assignment not found' using errcode = 'P0002';
  elsif p_action like 'attempt\_%' and not exists (select 1 from public.asm_attempts x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Attempt not found' using errcode = 'P0002';
  elsif p_action like 'bank\_%' and not exists (select 1 from public.asm_question_bank x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Bank question not found' using errcode = 'P0002';
  elsif p_action like 'version\_%' and not exists (select 1 from public.asm_versions x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Version not found' using errcode = 'P0002';
  elsif p_action like 'reassessment\_%' and not exists (select 1 from public.asm_reassessments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Request not found' using errcode = 'P0002';
  end if;
 end if;
 v := public.asm_json_uuid(d, 'assessmentId');
 if v is not null and not exists (select 1 from public.asm_assessments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
 v := public.asm_json_uuid(d, 'fromAssessmentId');
 if v is not null and not exists (select 1 from public.asm_assessments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Source assessment not found' using errcode = 'P0002'; end if;
 v := public.asm_json_uuid(d, 'versionId');
 if v is not null and not exists (select 1 from public.asm_versions x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Version not found' using errcode = 'P0002'; end if;
 v := public.asm_json_uuid(d, 'assignmentId');
 if v is not null and not exists (select 1 from public.asm_assignments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Assignment not found' using errcode = 'P0002'; end if;
 v := public.asm_json_uuid(d, 'batchId');
 if v is not null and not exists (select 1 from public.batches b join public.course_intakes i on i.id = b.intake_id join public.cms_courses c on c.id = i.course_id where b.id = v and public.tenant_scope(c.tenant_id)) then raise exception 'Batch not found' using errcode = 'P0002'; end if;
 v_text := public.asm_json_text(d, 'courseId');
 if v_text is not null and not exists (select 1 from public.cms_courses c where c.id = v_text and public.tenant_scope(c.tenant_id)) then raise exception 'Course not found' using errcode = 'P0002'; end if;
 v_text := public.asm_json_text(d, 'unitId');
 if v_text is not null and not exists (select 1 from public.cms_course_units u where u.id = v_text and public.tenant_scope(u.tenant_id)) then raise exception 'Unit not found' using errcode = 'P0002'; end if;
end $$;
revoke all on function public.asm_admin_scope_check(text, jsonb) from public, anon, authenticated;

-- The RPC bodies are patched in place (as 20261112160438_email_html_all.sql did): every anchor is a single line of the
-- original text and must match exactly the expected number of times, or the migration fails loudly.
do $mig$
declare d text; n text; cnt integer; fn text;
 patches text[][] := array[
  -- asm_admin: the scope check right after the role check, and tenant filters on every list
  array['public.asm_admin(text, jsonb)',
   $o$if not public.asm_is_admin() then raise exception 'Only an Admin or an RTO Manager can manage assessments.' using errcode = '42501'; end if;$o$,
   $o$if not public.asm_is_admin() then raise exception 'Only an Admin or an RTO Manager can manage assessments.' using errcode = '42501'; end if;
 perform public.asm_admin_scope_check(p_action, d);$o$, '1'],
  array['public.asm_admin(text, jsonb)',
   $o$where (coalesce((d->>'includeArchived')::boolean, false) or a.archived_at is null)$o$,
   $o$where public.tenant_scope(a.tenant_id) and (coalesce((d->>'includeArchived')::boolean, false) or a.archived_at is null)$o$, '1'],
  array['public.asm_admin(text, jsonb)',
   $o$where (public.asm_json_uuid(d, 'assessmentId') is null or a.assessment_id = public.asm_json_uuid(d, 'assessmentId'))$o$,
   $o$where public.tenant_scope(a.tenant_id) and (public.asm_json_uuid(d, 'assessmentId') is null or a.assessment_id = public.asm_json_uuid(d, 'assessmentId'))$o$, '1'],
  array['public.asm_admin(text, jsonb)',
   $o$where a.status <> 'cancelled' and (public.asm_json_uuid(d, 'batchId') is null or a.batch_id = public.asm_json_uuid(d, 'batchId'))$o$,
   $o$where public.tenant_scope(a.tenant_id) and a.status <> 'cancelled' and (public.asm_json_uuid(d, 'batchId') is null or a.batch_id = public.asm_json_uuid(d, 'batchId'))$o$, '1'],
  array['public.asm_admin(text, jsonb)',
   $o$where (public.asm_json_uuid(d, 'studentId') is null or o.student_id = public.asm_json_uuid(d, 'studentId'))$o$,
   $o$where public.tenant_scope(o.tenant_id) and (public.asm_json_uuid(d, 'studentId') is null or o.student_id = public.asm_json_uuid(d, 'studentId'))$o$, '1'],
  array['public.asm_admin(text, jsonb)',
   $o$from public.asm_audit_log l where (public.asm_json_text(d, 'targetType') is null$o$,
   $o$from public.asm_audit_log l where public.tenant_scope(l.tenant_id) and (public.asm_json_text(d, 'targetType') is null$o$, '1'],
  array['public.asm_admin(text, jsonb)',
   $o$from public.asm_question_bank b where b.archived_at is null$o$,
   $o$from public.asm_question_bank b where public.tenant_scope(b.tenant_id) and b.archived_at is null$o$, '1'],
  array['public.asm_admin(text, jsonb)',
   $o$from public.asm_unit_elements e where e.unit_id = v_unit), '[]');$o$,
   $o$from public.asm_unit_elements e where e.unit_id = v_unit and public.tenant_scope(e.tenant_id)), '[]');$o$, '1'],
  array['public.asm_admin(text, jsonb)',
   $o$where (public.asm_json_text(d, 'courseId') is null or i.course_id = d->>'courseId') and (coalesce((d->>'includeInactive')::boolean, false) or b.is_active)$o$,
   $o$where public.tenant_scope(c.tenant_id) and (public.asm_json_text(d, 'courseId') is null or i.course_id = d->>'courseId') and (coalesce((d->>'includeInactive')::boolean, false) or b.is_active)$o$, '1'],
  -- asm_trainer: unit elements inside the tenant
  array['public.asm_trainer(text, jsonb)',
   $o$from public.asm_unit_elements e where e.unit_id = d->>'unitId' and e.is_active), '[]');$o$,
   $o$from public.asm_unit_elements e where e.unit_id = d->>'unitId' and e.is_active and public.tenant_scope(e.tenant_id)), '[]');$o$, '1'],
  -- asm_student: attempts and assignments inside the tenant
  array['public.asm_student(text, jsonb)',
   $o$where id = v_id and student_id = v_student$o$,
   $o$where id = v_id and student_id = v_student and public.tenant_scope(tenant_id)$o$, '6'],
  array['public.asm_student(text, jsonb)',
   $o$if v_a.id is null or v_a.status = 'cancelled' or v_student not in (select public.asm_assignment_eligible(v_id)) then$o$,
   $o$if v_a.id is null or v_a.status = 'cancelled' or not public.tenant_scope(v_a.tenant_id) or v_student not in (select public.asm_assignment_eligible(v_id)) then$o$, '1'],
  array['public.asm_student(text, jsonb)',
   $o$where a.status <> 'cancelled' and v_student in (select public.asm_assignment_eligible(a.id))), '[]');$o$,
   $o$where a.status <> 'cancelled' and public.tenant_scope(a.tenant_id) and v_student in (select public.asm_assignment_eligible(a.id))), '[]');$o$, '1'],
  -- asm_calendar: admin branches inside the tenant
  array['public.asm_calendar(date, date, uuid)',
   $o$from public.asm_assignments where batch_id = p_batch and status <> 'cancelled';$o$,
   $o$from public.asm_assignments where batch_id = p_batch and status <> 'cancelled' and public.tenant_scope(tenant_id);$o$, '1'],
  array['public.asm_calendar(date, date, uuid)',
   $o$from public.asm_assignments where status <> 'cancelled';$o$,
   $o$from public.asm_assignments where status <> 'cancelled' and public.tenant_scope(tenant_id);$o$, '1']
 ];
begin
 for i in 1 .. array_length(patches, 1) loop
  fn := patches[i][1];
  d := pg_get_functiondef(fn::regprocedure);
  cnt := (length(d) - length(replace(d, patches[i][2], ''))) / length(patches[i][2]);
  if cnt <> patches[i][4]::integer then raise exception 'asm hardening: anchor % in % found % times, expected %', patches[i][2], fn, cnt, patches[i][4]; end if;
  n := replace(d, patches[i][2], patches[i][3]);
  execute n;
 end loop;
end $mig$;
