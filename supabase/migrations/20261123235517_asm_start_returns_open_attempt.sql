-- ASM-OPEN-RACE (2026-11-23, owner): starting an assessment returns the student's open attempt when there is one.
--
-- Before: assessment_open created attempt 1 through asm_next_attempt when the student had no attempt. Two opens at the same time
-- (a double load, two tabs, a double click) both saw no attempt; the second waited on the assignment's lock and then failed with
-- "The student already has an open attempt" (23505), shown to the student as an error.
-- Now: asm_start_attempt returns the open (draft) attempt if there is one, else creates the next one; when a simultaneous start wins
-- the race (asm_next_attempt's check, or the partial unique index on insert), it returns the attempt that start created.
-- One open attempt per student per assignment stays guaranteed by the partial unique index asm_attempts_one_open (created by
-- 20261113470000; recreated here only if it is missing). asm_next_attempt itself is unchanged: staff reassessment still refuses a
-- second open attempt with its message.
-- Additive: one new function; asm_student's assessment_open is patched in place on an exact anchor (one occurrence, either line
-- ending) so hosted-only changes to asm_student are kept; no table, row or other function changes.

do $$
begin
 if exists (select 1 from public.asm_attempts where state = 'draft' group by assignment_id, student_id having count(*) > 1) then
  raise exception 'Some students have two open attempts on one assessment; resolve them before this migration (nothing was changed)';
 end if;
end $$;
create unique index if not exists asm_attempts_one_open on public.asm_attempts(assignment_id, student_id) where state = 'draft';

create or replace function public.asm_start_attempt(p_assignment uuid, p_student uuid, p_tenant uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
 -- already open (another tab, or a start that finished first): that attempt
 select id into v_id from public.asm_attempts where assignment_id = p_assignment and student_id = p_student and state = 'draft';
 if v_id is not null then return v_id; end if;
 begin
  v_id := public.asm_next_attempt(p_assignment, p_student, public.asm_due_for(p_assignment, p_student), null, false);
 exception when unique_violation then
  -- a simultaneous start created it while this one waited for the assignment's lock (asm_next_attempt's check) or inserted
  -- at the same moment (asm_attempts_one_open): return that attempt, committed by then
  select id into v_id from public.asm_attempts where assignment_id = p_assignment and student_id = p_student and state = 'draft';
  if v_id is null then raise; end if;
  return v_id;
 end;
 perform public.asm_log('student', 'attempt_open', 'attempt', v_id::text, jsonb_build_object('assignmentId', p_assignment), p_tenant);
 return v_id;
end $$;
revoke all on function public.asm_start_attempt(uuid, uuid, uuid) from public, anon, authenticated;

-- assessment_open: create attempt 1 through asm_start_attempt (the two lines it replaces created and logged it)
do $$
declare
 v_def text := pg_get_functiondef('public.asm_student(text,jsonb)'::regprocedure);
 v_pat text := 'v_att\.id := public\.asm_next_attempt\(v_id, v_student, public\.asm_due_for\(v_id, v_student\), null, false\);\r?\n[ \t]*perform public\.asm_log\(''student'', ''attempt_open'', ''attempt'', v_att\.id::text, jsonb_build_object\(''assignmentId'', v_id\), v_a\.tenant_id\);';
 v_n integer;
begin
 if position('public.asm_start_attempt(v_id, v_student, v_a.tenant_id)' in v_def) > 0 then return; end if; -- already patched
 select count(*) into v_n from regexp_matches(v_def, v_pat, 'g');
 if v_n <> 1 then raise exception 'asm_student assessment_open anchor found % times (expected 1); nothing was changed', v_n; end if;
 execute regexp_replace(v_def, v_pat, 'v_att.id := public.asm_start_attempt(v_id, v_student, v_a.tenant_id);');
end $$;
