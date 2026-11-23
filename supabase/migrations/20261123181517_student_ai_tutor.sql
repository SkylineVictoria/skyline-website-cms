-- STUDENT-AI-TUTOR (owner, 2026-11-23: "allow learning with AI"): on My learning › Learn a student asks the AI about a unit
-- (explain it simply, key points, a topic, any question). Answers come only from the unit's learner material, the same sources as
-- Student Practice (lms_practice_sources: published Learning Materials / Self-Assessment resources and Learning content visible to
-- students). The student-practice Edge Function (mode "tutor") calls student_tutor_start, reads up to three sources with the
-- student's own storage access and asks the model; nothing the student types is stored, only a count for the daily limit.
-- Same switch as practice (lms.practice_enabled); at most 40 tutor questions per student a day.
-- Rollback: drop function public.student_tutor_start(text); drop table public.lms_tutor_requests;
begin;

create table public.lms_tutor_requests (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.enrollment_students(id) on delete cascade,
  unit_id text not null references public.cms_course_units(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index lms_tutor_request_student on public.lms_tutor_requests(student_id, created_at desc);
alter table public.lms_tutor_requests enable row level security;
revoke all on public.lms_tutor_requests from public, anon, authenticated;

-- Checks the student may ask about the unit, counts the question and returns the unit and its learner material.
create function public.student_tutor_start(p_unit text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare student uuid := public.portal_student_id(); tenant uuid; unit_title text; settings jsonb; used integer;
begin
  if auth.uid() is null or student is null then raise exception 'Sign in as a student to learn with AI.' using errcode = '42501'; end if;
  select u.tenant_id, btrim(concat_ws(' ', u.code, u.name)) into tenant, unit_title from public.cms_course_units u
  where u.id = p_unit and u.id in (select public.student_enrolled_unit_ids(student)) and public.tenant_scope(u.tenant_id);
  if not found then raise exception 'Choose one of your units.' using errcode = '42501'; end if;
  settings := public.lms_practice_settings(tenant);
  if not coalesce((settings->>'enabled')::boolean, false) then
    raise exception 'Learning with AI has not been switched on yet. Contact your trainer.' using errcode = '22023';
  end if;
  select count(*) into used from public.lms_tutor_requests where student_id = student and created_at > now() - interval '1 day';
  if used >= 40 then raise exception 'You have asked the AI 40 questions today. Please try again tomorrow.' using errcode = '22023'; end if;
  if not exists (select 1 from public.lms_practice_sources(p_unit)) then
    raise exception 'This unit has no learning material for the AI to use yet.' using errcode = '22023';
  end if;
  insert into public.lms_tutor_requests(student_id, unit_id) values (student, p_unit);
  return jsonb_build_object('unitTitle', unit_title, 'sources', coalesce((select jsonb_agg(jsonb_build_object('title', s.title, 'bucket', s.bucket,
      'path', s.path, 'filename', s.filename, 'bytes', s.bytes, 'body', s.body))
    from (select * from public.lms_practice_sources(p_unit) order by version desc limit 3) s), '[]'::jsonb));
end $$;
revoke all on function public.student_tutor_start(text) from public, anon;
grant execute on function public.student_tutor_start(text) to authenticated;

commit;
