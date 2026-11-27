-- SIGNUP-PHONE-OPTIONAL + MY-QUALIFICATION (owner, 2026-11-27).
-- 1. Student sign-up without a mobile number (hidden for now, added back later): portal_self_register and
--    portal_self_enrol_complete accept an empty phone; a given one is still checked as before. A student whose email is already on a
--    record claims it with the code emailed to that address (the email proves it); a given mobile must still match the record.
--    An empty phone is stored as null (never ''), and the "already on record" mobile check only runs for a given number.
-- 2. My Qualification: portal_my_qualifications() lists the signed-in student's own Qualifications (course, intake, status,
--    dates, the documents they may see; no reasons or internal notes); qualification_document_get lets the student open them.

create or replace function pg_temp.q_patch_phone(p_fn text, p_from text, p_to text, p_all boolean default false) returns void language plpgsql as $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_fn;
  if position(p_from in coalesce(v_def, '')) = 0 then raise exception 'SIGNUP-PHONE-OPTIONAL patch: % does not contain %', p_fn, p_from; end if;
  if p_all then v_def := replace(v_def, p_from, p_to);
  else v_def := overlay(v_def placing p_to from position(p_from in v_def) for char_length(p_from)); end if;
  execute v_def;
end $$;

-- 1a. Email sign-up (portal-self-register).
select pg_temp.q_patch_phone('portal_self_register', 'if v_phone = '''' then raise exception ''Enter your mobile number.'' using errcode = ''22023''; end if;',
  'null; -- the mobile number is optional for now (SIGNUP-PHONE-OPTIONAL)');
select pg_temp.q_patch_phone('portal_self_register', 'if public.student_phone_key(s.phone) is distinct from public.student_phone_key(v_phone) and not (',
  'if v_phone <> '''' and public.student_phone_key(s.phone) is distinct from public.student_phone_key(v_phone) and not (');
select pg_temp.q_patch_phone('portal_self_register', 'if exists (select 1 from public.enrollment_students x where public.student_phone_key(x.phone) = public.student_phone_key(v_phone)) then',
  'if v_phone <> '''' and exists (select 1 from public.enrollment_students x where public.student_phone_key(x.phone) = public.student_phone_key(v_phone)) then');
select pg_temp.q_patch_phone('portal_self_register', 'values (a.id, null, null, v_name, v_email, v_phone, v_dob, v_details) returning * into s;',
  'values (a.id, null, null, v_name, v_email, nullif(v_phone, ''''), v_dob, v_details) returning * into s;');

-- 1b. Sign-up completed after Google (portal_self_enrol_complete).
select pg_temp.q_patch_phone('portal_self_enrol_complete', 'if v_phone !~ ''^\+[1-9]\d{7,14}$'' then',
  'if v_phone <> '''' and v_phone !~ ''^\+[1-9]\d{7,14}$'' then');
select pg_temp.q_patch_phone('portal_self_enrol_complete', 'if exists (select 1 from public.enrollment_students x where public.student_phone_key(x.phone) = public.student_phone_key(v_phone)) then',
  'if v_phone <> '''' and exists (select 1 from public.enrollment_students x where public.student_phone_key(x.phone) = public.student_phone_key(v_phone)) then');
select pg_temp.q_patch_phone('portal_self_enrol_complete', 'values (a.id, null, null, v_name, v_email, v_phone, v_dob, v_details) returning * into s;',
  'values (a.id, null, null, v_name, v_email, nullif(v_phone, ''''), v_dob, v_details) returning * into s;');
select pg_temp.q_patch_phone('portal_self_enrol_complete', 'left(v_phone, 40)', 'nullif(left(v_phone, 40), '''')', true);

-- 2. My Qualification (student workspace).
create or replace function public.portal_my_qualifications() returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare v_student uuid := public.portal_student_id();
begin
  if v_student is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'status', e.status, 'label', public.qualification_label(e.status),
      'courseCode', c.code, 'courseName', c.name, 'intakeName', public.intake_group_name(ci.id), 'type', e.enrolment_type,
      'startDate', coalesce(e.course_start_date, e.enrolled_on), 'endDate', e.course_end_date, 'resumeDate', e.resume_date,
      'documents', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'title', d.title, 'fileName', d.file_name) order by d.created_at), '[]'::jsonb)
                    from public.intake_enrolment_documents d where d.enrolment_id = e.id and d.student_visible and d.copy_state = 'copied'))
      order by coalesce(e.course_start_date, e.enrolled_on) desc)
    from public.intake_enrolments e join public.course_intakes ci on ci.id = e.intake_id left join public.cms_courses c on c.id = ci.course_id
    where e.student_id = v_student and e.archived_at is null), '[]'::jsonb);
end $$;
revoke all on function public.portal_my_qualifications() from public, anon;
grant execute on function public.portal_my_qualifications() to authenticated;

create or replace function public.qualification_document_get(p_document uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare d public.intake_enrolment_documents; e public.intake_enrolments;
begin
  select * into d from public.intake_enrolment_documents where id = p_document;
  select * into e from public.intake_enrolments where id = d.enrolment_id;
  if d.id is null or not (public.cms_is_staff()
       or (d.student_visible and e.application_id is not null and public.portal_can_access_application(e.application_id))
       or (d.student_visible and e.student_id = public.portal_student_id())) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if d.content is null then raise exception 'This copy is not made yet.' using errcode = '22023'; end if;
  return jsonb_build_object('fileName', coalesce(d.file_name, d.title), 'mimeType', coalesce(d.mime_type, 'application/octet-stream'), 'content', encode(d.content, 'base64'));
end $$;
