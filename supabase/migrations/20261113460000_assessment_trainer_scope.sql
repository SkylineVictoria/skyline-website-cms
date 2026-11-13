-- Assessment Management hardening, T3: trainer scope (DECISIONS.md D-22, replaces D-15).
-- Marking (mark_save, mark_return, assessor evidence) and unit-outcome sign-off are allowed only for
--  (a) an active staff profile on batch_trainers for that batch holding the trainer role (hr.staff_roles.role = 'trainer',
--      not revoked) while asm_settings.require_trainer_role is true (default), or any active batch trainer when it is false;
--  (b) a named assessor on the assignment (asm_assignment_trainers), role not required;
--  (c) a CMS Admin / RTO Manager (unit outcomes through asm_admin; marking still needs a staff identity for the audit trail).
-- Reading (my_assignments, pending_marking, assignment_students, attempt_get, feedback) stays open to every batch trainer.

alter table public.asm_settings add column if not exists require_trainer_role boolean not null default true;

create or replace function public.asm_has_trainer_role(p_profile uuid) returns boolean
language sql stable security definer set search_path = public as $$
 select exists (select 1 from hr.staff_roles r where r.profile_id = p_profile and r.role = 'trainer' and r.revoked_at is null);
$$;
revoke all on function public.asm_has_trainer_role(uuid) from public, anon, authenticated;

-- May the caller mark / sign off work of this assignment? Builds on asm_trainer_on_assignment (own profile, inside the tenant).
create or replace function public.asm_can_assess(p_assignment uuid, p_profile uuid default public.asm_trainer_profile()) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare a public.asm_assignments; v_required boolean;
begin
 if public.asm_is_admin() then return true; end if;
 if p_profile is null or not public.asm_trainer_on_assignment(p_assignment, p_profile) then return false; end if;
 if exists (select 1 from public.asm_assignment_trainers x where x.assignment_id = p_assignment and x.staff_id = p_profile) then return true; end if;
 select * into a from public.asm_assignments where id = p_assignment;
 v_required := coalesce((public.asm_effective_settings(a.assessment_id)->>'require_trainer_role')::boolean, true);
 return (not v_required) or public.asm_has_trainer_role(p_profile);
end $$;
revoke all on function public.asm_can_assess(uuid, uuid) from public, anon;
grant execute on function public.asm_can_assess(uuid, uuid) to authenticated;

create or replace function public.asm_can_assess_attempt(p_attempt uuid) returns boolean
language sql stable security definer set search_path = public as $$
 select exists (select 1 from public.asm_attempts t where t.id = p_attempt and public.asm_can_assess(t.assignment_id));
$$;
revoke all on function public.asm_can_assess_attempt(uuid) from public, anon;
grant execute on function public.asm_can_assess_attempt(uuid) to authenticated;

-- Assessor uploads need the marking right, not just batch membership.
create or replace function public.asm_evidence_path_writable(p_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_attempt uuid; v_seg text; t public.asm_attempts;
begin
 if auth.uid() is null or p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_.-]{1,80}/[^/]{1,200}$' then return false; end if;
 v_attempt := split_part(p_name, '/', 1)::uuid; v_seg := split_part(p_name, '/', 2);
 select * into t from public.asm_attempts where id = v_attempt;
 if t.id is null or not public.tenant_scope(t.tenant_id) then return false; end if;
 if v_seg = 'assessor' then return t.state in ('submitted', 'marking') and public.asm_can_assess(t.assignment_id); end if;
 return coalesce(t.state = 'draft' and t.student_id = public.asm_student_id(), false);
end $$;

-- Unit outcome with sign-off (never automatic): the signer must be allowed to assess the student in a batch of that unit's
-- course (or be a named assessor on an assignment the student attempted), or be an Admin / RTO Manager. The client's
-- batchId / assessmentId are checked against the student and the unit; the unit must be inside the caller's tenant.
create or replace function public.asm_record_unit_outcome(d jsonb, p_role text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_student uuid := public.asm_json_uuid(d, 'studentId'); v_unit text := public.asm_json_text(d, 'unitId'); v_out text := upper(coalesce(d->>'outcome', ''));
 v_prev uuid; v_id uuid; v_staff uuid := public.asm_trainer_profile(); v_name text; v_ids uuid[]; v_batch uuid := public.asm_json_uuid(d, 'batchId');
 v_assessment uuid := public.asm_json_uuid(d, 'assessmentId'); v_tenant uuid; v_allowed boolean := false;
begin
 if v_student is null or v_unit is null then raise exception 'studentId and unitId are required' using errcode = '22023'; end if;
 if v_out not in ('C', 'NYC') then raise exception 'outcome must be C or NYC' using errcode = '22023'; end if;
 select tenant_id into v_tenant from public.cms_course_units where id = v_unit;
 if not found or not public.tenant_scope(v_tenant) then raise exception 'Unit not found' using errcode = 'P0002'; end if;
 if not exists (select 1 from public.enrollment_students s where s.id = v_student) then raise exception 'Student not found' using errcode = 'P0002'; end if;
 if v_batch is not null and not exists (select 1 from public.batch_enrolments e where e.batch_id = v_batch and e.student_id = v_student) then
  raise exception 'The student is not enrolled in that batch' using errcode = '22023'; end if;
 if v_assessment is not null and not exists (select 1 from public.asm_assessments a where a.id = v_assessment and a.unit_id = v_unit and public.tenant_scope(a.tenant_id)) then
  raise exception 'The assessment does not belong to this unit' using errcode = '22023'; end if;
 if p_role = 'trainer' then
  if v_staff is null then raise exception 'Only an active trainer can sign off' using errcode = '42501'; end if;
  -- (a) a batch of the unit's course the student is in, where the caller is a batch trainer with the role (or the role is not required)
  v_allowed := exists (
   select 1 from public.batch_enrolments e join public.batches b on b.id = e.batch_id join public.course_intakes i on i.id = b.intake_id
   join public.cms_course_units u on u.id = v_unit and u.course_id = i.course_id
   join public.batch_trainers bt on bt.batch_id = b.id and bt.staff_id = v_staff
   where e.student_id = v_student and e.status in ('active', 'completed') and (v_batch is null or b.id = v_batch)
     and (public.asm_has_trainer_role(v_staff) or not coalesce((select s.require_trainer_role from public.asm_settings s
           where coalesce(s.tenant_id, '00000000-0000-0000-0000-000000000000') = coalesce(v_tenant, '00000000-0000-0000-0000-000000000000')), true)));
  -- (b) a named assessor on an assignment of this unit the student attempted
  if not v_allowed then
   v_allowed := exists (
    select 1 from public.asm_assignments a join public.asm_assessments x on x.id = a.assessment_id and x.unit_id = v_unit
    join public.asm_assignment_trainers at on at.assignment_id = a.id and at.staff_id = v_staff
    join public.asm_attempts t on t.assignment_id = a.id and t.student_id = v_student
    where public.tenant_scope(a.tenant_id));
  end if;
  if not v_allowed then raise exception 'Only a trainer with the trainer role, a named assessor or an administrator can sign off this student' using errcode = '42501'; end if;
  select btrim(first_name || ' ' || last_name) into v_name from hr.staff_profiles where id = v_staff;
 else
  if not public.asm_is_admin() then raise exception 'Not authorised' using errcode = '42501'; end if;
  select name into v_name from public.cms_users where auth_user_id = auth.uid();
 end if;
 if not coalesce((d->>'signOff')::boolean, false) then raise exception 'Tick the sign-off declaration to record the outcome' using errcode = '22023'; end if;
 select coalesce(array_agg(ta.v::uuid), '{}') into v_ids from jsonb_array_elements_text(coalesce(d->'attemptIds', '[]')) as ta(v);
 if exists (select 1 from unnest(v_ids) i where not exists (select 1 from public.asm_attempts t where t.id = i and t.student_id = v_student)) then raise exception 'An attempt does not belong to the student' using errcode = '23503'; end if;
 select id into v_prev from public.asm_unit_outcomes o where o.student_id = v_student and o.unit_id = v_unit and not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = o.id) order by signed_at desc limit 1;
 insert into public.asm_unit_outcomes(student_id, unit_id, assessment_id, batch_id, outcome, evidence_attempt_ids, signed_by, signed_staff_id, signed_role, signed_name, notes, supersedes_id)
 values (v_student, v_unit, v_assessment, v_batch, v_out, v_ids, auth.uid(), v_staff, p_role, coalesce(nullif(v_name, ''), 'Assessor'), coalesce(d->>'notes', ''), v_prev) returning id into v_id;
 perform public.asm_notify_student(v_student, 'outcome', 'Unit outcome recorded', 'The outcome for ' || (select code || ' ' || name from public.cms_course_units where id = v_unit) || ' is ' || case v_out when 'C' then 'Competent' else 'Not Yet Competent' end || '.', null, null, v_tenant);
 perform public.asm_log(p_role, 'unit_outcome_record', 'unit_outcome', v_id::text, jsonb_build_object('studentId', v_student, 'unitId', v_unit, 'outcome', v_out, 'supersedes', v_prev), v_tenant);
 return jsonb_build_object('ok', true, 'id', v_id);
end $$;
revoke all on function public.asm_record_unit_outcome(jsonb, text) from public, anon, authenticated;

-- In-place patches (single-line anchors, exact counts; see 20261113450000).
do $mig$
declare d text; n text; cnt integer; fn text;
 patches text[][] := array[
  -- marking needs the marking right (mark_save and mark_return both lock the attempt with this line)
  array['public.asm_trainer(text, jsonb)',
   $o$select * into v_att from public.asm_attempts where id = v_id for update;$o$,
   $o$if not public.asm_can_assess_attempt(v_id) then raise exception 'Only a trainer with the trainer role, a named assessor or an administrator can mark this attempt' using errcode = '42501'; end if;
  select * into v_att from public.asm_attempts where id = v_id for update;$o$, '2'],
  -- assessor evidence
  array['public.asm_trainer(text, jsonb)',
   $o$if v_path is null or split_part(v_path, '/', 1) <> v_id::text or split_part(v_path, '/', 2) <> 'assessor' then$o$,
   $o$if not public.asm_can_assess_attempt(v_id) then raise exception 'Only a trainer with the trainer role, a named assessor or an administrator can attach assessor files' using errcode = '42501'; end if;
  if v_path is null or split_part(v_path, '/', 1) <> v_id::text or split_part(v_path, '/', 2) <> 'assessor' then$o$, '1'],
  -- the workspace learns whether it may mark
  array['public.asm_trainer(text, jsonb)',
   $o$'toMark', (select count(*) from public.asm_attempts t where t.assignment_id = a.id and t.state in ('submitted', 'marking')),$o$,
   $o$'canAssess', public.asm_can_assess(a.id, v_staff), 'toMark', (select count(*) from public.asm_attempts t where t.assignment_id = a.id and t.state in ('submitted', 'marking')),$o$, '1'],
  array['public.asm_trainer(text, jsonb)',
   $o$return public.asm_attempt_json(v_id, 'trainer') || jsonb_build_object('definition', v_ver.definition, 'assessmentTitle', v_as.title, 'unitId', v_as.unit_id,$o$,
   $o$return public.asm_attempt_json(v_id, 'trainer') || jsonb_build_object('canAssess', public.asm_can_assess(v_att.assignment_id, v_staff), 'definition', v_ver.definition, 'assessmentTitle', v_as.title, 'unitId', v_as.unit_id,$o$, '1'],
  array['public.asm_trainer(text, jsonb)',
   $o$'isTrainer', exists (select 1 from hr.staff_roles r where r.profile_id = v_staff and r.role = 'trainer' and r.revoked_at is null),$o$,
   $o$'isTrainer', public.asm_has_trainer_role(v_staff), 'requireTrainerRole', coalesce((select s.require_trainer_role from public.asm_settings s where coalesce(s.tenant_id, '00000000-0000-0000-0000-000000000000') = coalesce(public.tenant_current(), '00000000-0000-0000-0000-000000000000')), true),$o$, '1'],
  -- the setting is saved with the others
  array['public.asm_admin(text, jsonb)',
   $o$late_submission = coalesce(d->>'lateSubmission', late_submission), rollup_rule = coalesce(d->>'rollupRule', rollup_rule), due_soon_days = coalesce((d->>'dueSoonDays')::integer, due_soon_days),$o$,
   $o$late_submission = coalesce(d->>'lateSubmission', late_submission), rollup_rule = coalesce(d->>'rollupRule', rollup_rule), due_soon_days = coalesce((d->>'dueSoonDays')::integer, due_soon_days),
   require_trainer_role = coalesce((d->>'requireTrainerRole')::boolean, require_trainer_role),$o$, '1']
 ];
begin
 for i in 1 .. array_length(patches, 1) loop
  fn := patches[i][1];
  d := pg_get_functiondef(fn::regprocedure);
  cnt := (length(d) - length(replace(d, patches[i][2], ''))) / length(patches[i][2]);
  if cnt <> patches[i][4]::integer then raise exception 'asm trainer scope: anchor % in % found % times, expected %', patches[i][2], fn, cnt, patches[i][4]; end if;
  n := replace(d, patches[i][2], patches[i][3]);
  execute n;
 end loop;
end $mig$;
