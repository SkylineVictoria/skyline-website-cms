-- ASM-WORKBOOK (2026-11-23, owner): the results sheet of a workbook assessment and its "Export as workbook PDF".
--
-- asm_attempt_history(attempt) returns, for the student and assignment of that attempt:
--   * the cover details: student name, Student ID (the student number once Skyline stores one, else the short id the LMS
--     shows: first 8 characters of the record), the
--     assignment's named assessors and its intake's trainers, the assessment title / code, its unit and qualification;
--   * every attempt (1..n, void ones left out) with its state, dates, overall outcome and feedback, the assessor who decided it,
--     the student's typed declaration name, and each task's outcome (S / NYS), feedback, the date it was signed and by whom.
-- Read-only and additive: no table changes. Allowed for administrators / RTO Managers, the attempt's trainers and the student
-- (a student sees outcomes and feedback only of returned or final attempts, as asm_attempt_json does). Assessor-only data
-- (model answers, keys, guidance) is never part of it.

create or replace function public.asm_person_name(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
 select coalesce(
  (select nullif(btrim(coalesce(s.first_name, '') || ' ' || coalesce(s.last_name, '')), '') from hr.staff_profiles s where s.auth_user_id = p_user limit 1),
  (select nullif(btrim(u.name), '') from public.cms_users u where u.auth_user_id = p_user limit 1),
  (select nullif(btrim(u.name), '') from public.cms_users u join auth.users a on lower(a.email) = lower(u.email) where a.id = p_user limit 1));
$$;
revoke all on function public.asm_person_name(uuid) from public, anon, authenticated;

create or replace function public.asm_attempt_history(p_attempt uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t public.asm_attempts; v_role text; v_ver public.asm_versions; v_as public.asm_assessments;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 select * into t from public.asm_attempts where id = p_attempt and public.tenant_scope(tenant_id);
 if t.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
 if public.asm_is_admin() or public.asm_trainer_on_attempt(p_attempt) then v_role := 'trainer';
 elsif t.student_id = public.asm_student_id() then v_role := 'student';
 else raise exception 'Not your attempt' using errcode = '42501';
 end if;
 select * into v_ver from public.asm_versions where id = t.version_id;
 select * into v_as from public.asm_assessments where id = v_ver.assessment_id;
 return jsonb_build_object(
  -- Student ID: the student number when Skyline has one (a student_number column, read through to_jsonb so this works before
  -- it exists), else the short id the LMS shows (first 8 characters of the record)
  'student', (select jsonb_build_object('id', s.id, 'number', nullif(btrim(to_jsonb(s)->>'student_number'), ''),
     'ref', coalesce(nullif(btrim(to_jsonb(s)->>'student_number'), ''), upper(left(s.id::text, 8))), 'name', s.full_name, 'email', s.email)
     from public.enrollment_students s where s.id = t.student_id),
  -- the named assessors of the assignment and the trainers of its intake
  'trainers', coalesce((select jsonb_agg(n order by n) from (select distinct btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) as n
     from hr.staff_profiles p where p.id in (
       select x.staff_id from public.asm_assignment_trainers x where x.assignment_id = t.assignment_id
       union select it.staff_id from public.intake_trainers it join public.asm_assignments g on g.intake_id = it.intake_id where g.id = t.assignment_id)) names where n <> ''), '[]'),
  'assessment', jsonb_build_object('id', v_as.id, 'title', v_as.title, 'code', v_as.code, 'versionNo', v_ver.version_no,
     'unit', (select jsonb_build_object('code', u.code, 'name', u.name) from public.cms_course_units u where u.id = v_as.unit_id),
     'qualification', (select jsonb_build_object('code', c.code, 'name', c.name) from public.cms_courses c where c.id = v_as.course_id)),
  'attempts', coalesce((select jsonb_agg(x.j order by x.attempt_no) from (
     select a.attempt_no, jsonb_build_object(
      'id', a.id, 'attemptNo', a.attempt_no, 'state', a.state, 'submittedAt', a.submitted_at, 'returnedAt', a.returned_at, 'finalisedAt', a.finalised_at,
      'receiptNo', a.receipt_no, 'declarationName', a.declaration->>'signature',
      'outcome', case when v_role <> 'student' or a.state in ('returned', 'final') then a.outcome end,
      'overallFeedback', case when v_role <> 'student' or a.state in ('returned', 'final') then a.overall_feedback else '' end,
      'assessor', case when v_role <> 'student' or a.state in ('returned', 'final') then public.asm_person_name(a.marked_by) end,
      'tasks', case when v_role <> 'student' or a.state in ('returned', 'final') then coalesce((select jsonb_agg(jsonb_build_object(
          'taskId', r.task_id, 'outcome', r.outcome, 'feedback', r.feedback, 'signedAt', r.signed_at, 'assessor', public.asm_person_name(r.signed_by)) order by r.task_id)
        from public.asm_task_results r where r.attempt_id = a.id), '[]'::jsonb) else '[]'::jsonb end) as j
     from public.asm_attempts a where a.assignment_id = t.assignment_id and a.student_id = t.student_id and a.state <> 'void') x), '[]'));
end $$;
revoke all on function public.asm_attempt_history(uuid) from public, anon;
grant execute on function public.asm_attempt_history(uuid) to authenticated;
