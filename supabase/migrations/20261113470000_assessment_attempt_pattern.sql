-- Assessment Management hardening, T4: the attempt pattern, enforced server-side.
--  * max_attempts (institution setting, per-assessment override) counts non-void attempts; nothing opens a further attempt
--    beyond it except an administrator's explicit override (overrideLimit: true, audited).
--  * reassessment window: a Not Yet Satisfactory decision opens the next attempt due in reassessment_days (or the assessor's date).
--  * late submissions: block refuses after the due date unless the assignment's late_until extends it; allow accepts and
--    flags late, but never after late_until when one is set.
--  * one open attempt per student per assignment (partial unique index asm_attempts_one_open and asm_next_attempt).
--  * a draft voided (student left the batch, exclusion, cancelled assignment) no longer blocks the next attempt: the next
--    number is max + 1 and the void attempt does not count (bug found in T2: unique violation on attempt 1).
--  * reopen / void only by an administrator or an assessor allowed on the assignment (asm_can_assess), always audited;
--    an assessor cannot exceed the limit, an administrator must say overrideLimit.
--  * autosave row-version conflicts are refused (40001) when rowVersion is sent, submitted attempts are immutable
--    (asm_attempts_guard) and every attempt keeps the assignment's version (asm_open_attempt): unchanged, now tested.

create unique index if not exists asm_attempts_one_open on public.asm_attempts(assignment_id, student_id) where state = 'draft';

create or replace function public.asm_attempt_count(p_assignment uuid, p_student uuid) returns integer
language sql stable security definer set search_path = public as $$
 select count(*)::integer from public.asm_attempts t where t.assignment_id = p_assignment and t.student_id = p_student and t.state <> 'void';
$$;
revoke all on function public.asm_attempt_count(uuid, uuid) from public, anon, authenticated;

create or replace function public.asm_max_attempts(p_assignment uuid) returns integer
language sql stable security definer set search_path = public as $$
 select coalesce((public.asm_effective_settings(a.assessment_id)->>'max_attempts')::integer, 3) from public.asm_assignments a where a.id = p_assignment;
$$;
revoke all on function public.asm_max_attempts(uuid) from public, anon, authenticated;

-- The only way a further attempt is opened: open assignment, no draft yet, under the limit (or an audited administrator override).
create or replace function public.asm_next_attempt(p_assignment uuid, p_student uuid, p_due timestamptz, p_copy_from uuid default null, p_override boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare a public.asm_assignments; v_no integer; v_count integer; v_max integer; v_id uuid;
begin
 select * into a from public.asm_assignments where id = p_assignment for update;
 if a.id is null then raise exception 'Assignment not found' using errcode = 'P0002'; end if;
 if a.status <> 'open' then raise exception 'This assessment is closed' using errcode = '42501'; end if;
 if exists (select 1 from public.asm_attempts t where t.assignment_id = p_assignment and t.student_id = p_student and t.state = 'draft') then
  raise exception 'The student already has an open attempt' using errcode = '23505'; end if;
 v_count := public.asm_attempt_count(p_assignment, p_student); v_max := public.asm_max_attempts(p_assignment);
 if v_count >= v_max then
  if not p_override or not public.asm_is_admin() then
   raise exception 'The maximum of % attempts has been reached', v_max using errcode = '42501';
  end if;
 end if;
 select coalesce(max(attempt_no), 0) + 1 into v_no from public.asm_attempts where assignment_id = p_assignment and student_id = p_student;
 if v_no > 10 then raise exception 'No further attempt can be opened for this student' using errcode = '22023'; end if;
 v_id := public.asm_open_attempt(p_assignment, p_student, v_no, p_due, p_copy_from);
 if v_count >= v_max then
  perform public.asm_log('admin', 'attempt_limit_override', 'attempt', v_id::text, jsonb_build_object('assignmentId', p_assignment, 'studentId', p_student, 'attemptNo', v_no, 'maxAttempts', v_max), a.tenant_id);
 end if;
 return v_id;
end $$;
revoke all on function public.asm_next_attempt(uuid, uuid, timestamptz, uuid, boolean) from public, anon, authenticated;

-- In-place patches (single-line anchors, exact counts; see 20261113450000).
do $mig$
declare d text; n text; cnt integer; fn text;
 patches text[][] := array[
  -- trainer: NYS opens the next attempt only under the limit; attempt numbers skip voids
  array['public.asm_trainer(text, jsonb)',
   $o$elsif v_att.attempt_no < v_max and v_a.status = 'open' then$o$,
   $o$elsif public.asm_attempt_count(v_a.id, v_att.student_id) < v_max and v_a.status = 'open' then$o$, '1'],
  array['public.asm_trainer(text, jsonb)',
   $o$v_next := public.asm_open_attempt(v_a.id, v_att.student_id, v_att.attempt_no + 1, v_due, v_id);$o$,
   $o$v_next := public.asm_next_attempt(v_a.id, v_att.student_id, v_due, v_id, false);$o$, '1'],
  -- trainer: void and reopen by an assessor who may mark, audited, never beyond the limit
  array['public.asm_trainer(text, jsonb)',
   $o$elsif p_action = 'unit_outcome_record' then$o$,
   $o$elsif p_action = 'attempt_void' then
  v_id := public.asm_json_uuid(d, 'id');
  if not public.asm_can_assess_attempt(v_id) then raise exception 'Only an assessor of this assignment or an administrator can void an attempt' using errcode = '42501'; end if;
  update public.asm_attempts set state = 'void', voided_at = now(), void_reason = coalesce(public.asm_json_text(d, 'reason'), 'voided by assessor') where id = v_id and state <> 'void' returning * into v_att;
  if v_att.id is null then raise exception 'Attempt not found or already void' using errcode = 'P0002'; end if;
  perform public.asm_log('trainer', 'attempt_void', 'attempt', v_id::text, jsonb_build_object('reason', v_att.void_reason), v_att.tenant_id);
  return jsonb_build_object('ok', true);
 elsif p_action = 'attempt_reopen' then
  v_id := public.asm_json_uuid(d, 'id');
  if not public.asm_can_assess_attempt(v_id) then raise exception 'Only an assessor of this assignment or an administrator can reopen an attempt' using errcode = '42501'; end if;
  select * into v_att from public.asm_attempts where id = v_id;
  if v_att.state not in ('returned', 'final') then raise exception 'Only a returned or finalised attempt can be reopened' using errcode = '42501'; end if;
  select * into v_a from public.asm_assignments where id = v_att.assignment_id; select * into v_as from public.asm_assessments where id = v_a.assessment_id;
  v_set := public.asm_effective_settings(v_as.id);
  v_due := coalesce(public.asm_json_ts(d, 'dueAt'), now() + make_interval(days => coalesce((v_set->>'reassessment_days')::integer, 5)));
  v_next := public.asm_next_attempt(v_a.id, v_att.student_id, v_due, v_att.id, false);
  insert into public.asm_reassessments(attempt_id, student_id, requested_role, reason, state, new_due_at, next_attempt_id, decided_by, decided_at)
  values (v_att.id, v_att.student_id, 'trainer', coalesce(d->>'reason', 'reopened by assessor'), 'opened', v_due, v_next, auth.uid(), now());
  perform public.asm_notify_student(v_att.student_id, 'reassessment', 'Your assessment has been reopened', 'A further attempt is open until ' || to_char(v_due at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.', v_next, v_a.id, v_att.tenant_id);
  perform public.asm_log('trainer', 'attempt_reopen', 'attempt', v_id::text, jsonb_build_object('nextAttemptId', v_next, 'dueAt', v_due, 'reason', d->>'reason'), v_att.tenant_id);
  return jsonb_build_object('ok', true, 'attemptId', v_next);
 elsif p_action = 'unit_outcome_record' then$o$, '1'],
  -- student: the first (or next after a void) attempt goes through the same gate; late_until is a hard end in both modes
  array['public.asm_student(text, jsonb)',
   $o$v_att.id := public.asm_open_attempt(v_id, v_student, 1, public.asm_due_for(v_id, v_student));$o$,
   $o$v_att.id := public.asm_next_attempt(v_id, v_student, public.asm_due_for(v_id, v_student), null, false);$o$, '1'],
  array['public.asm_student(text, jsonb)',
   $o$if v_now > v_due and (v_set->>'late_submission') = 'block' and (v_a.late_until is null or v_now > v_a.late_until) then$o$,
   $o$if v_now > v_due and (((v_set->>'late_submission') = 'block' and (v_a.late_until is null or v_now > v_a.late_until)) or (v_a.late_until is not null and v_now > v_a.late_until)) then$o$, '1'],
  -- admin: reopen and reassessment approval go through the gate; beyond the limit only with overrideLimit
  array['public.asm_admin(text, jsonb)',
   $o$v_next := public.asm_open_attempt(v_att.assignment_id, v_att.student_id, (select max(attempt_no) + 1 from public.asm_attempts where assignment_id = v_att.assignment_id and student_id = v_att.student_id), v_due, v_att.id);$o$,
   $o$v_next := public.asm_next_attempt(v_att.assignment_id, v_att.student_id, v_due, v_att.id, coalesce((d->>'overrideLimit')::boolean, false));$o$, '2']
 ];
begin
 for i in 1 .. array_length(patches, 1) loop
  fn := patches[i][1];
  d := pg_get_functiondef(fn::regprocedure);
  cnt := (length(d) - length(replace(d, patches[i][2], ''))) / length(patches[i][2]);
  if cnt <> patches[i][4]::integer then raise exception 'asm attempt pattern: anchor % in % found % times, expected %', patches[i][2], fn, cnt, patches[i][4]; end if;
  n := replace(d, patches[i][2], patches[i][3]);
  execute n;
 end loop;
end $mig$;
