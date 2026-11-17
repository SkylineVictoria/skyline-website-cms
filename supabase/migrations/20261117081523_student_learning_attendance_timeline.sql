-- STUDENT-LEARNING + ATTENDANCE-SUMMARY + STUDENT-TIMELINE. Additive.
-- 1. student_my_learning(): the signed-in student's courses (through batch_enrolments > batches > course_intakes > intake_units) with
--    each unit's learning content marked "Show to students", plus their own attendance. Storage policy unit_content_files_student_read
--    lets a student open a file only when it is a visible item of a unit in one of their enrolments.
-- 2. lms_attendance_summary(batch, student): attendance per enrolment from final registers (present + late over classes marked,
--    excused classes left out); staff only. Below 80 % is flagged in the UI.
-- 3. admin_student_timeline(student): everything that happened to one student in date order (record created, applications and
--    status changes, offer letters, signing, deposit, CoE / VoE, batch enrolments, messages, automatic emails, assessment attempts,
--    student email account); SLIT administrators only, like admin_student_detail.
-- Columns added by later hosted-only migrations are read through to_jsonb(row) so a missing column reads as null.
-- Rollback (manual): drop policy unit_content_files_student_read on storage.objects; drop function public.student_my_learning(),
-- public.unit_content_student_file(text), public.student_enrolled_unit_ids(uuid), public.lms_attendance_summary(uuid, uuid),
-- public.admin_student_timeline(uuid).
begin;

-- Units of the student's current enrolments (active, deferred or completed).
create function public.student_enrolled_unit_ids(p_student uuid) returns setof text
language sql stable security definer set search_path = public as $$
  select distinct iu.unit_id
  from public.batch_enrolments e
  join public.batches b on b.id = e.batch_id
  join public.intake_units iu on iu.intake_id = b.intake_id
  where p_student is not null and e.student_id = p_student and e.status in ('active', 'deferred', 'completed');
$$;

create function public.unit_content_student_file(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.unit_contents c
    where c.kind = 'file' and c.visible_to_students and c.storage_path = p_name
      and c.unit_id in (select public.student_enrolled_unit_ids(public.portal_student_id())));
$$;

drop policy if exists unit_content_files_student_read on storage.objects;
create policy unit_content_files_student_read on storage.objects for select to authenticated
  using (bucket_id = 'unit-content' and public.unit_content_student_file(name));

create function public.student_my_learning() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_student uuid := public.portal_student_id();
begin
  if v_student is null then raise exception 'Student access required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'courses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'enrolmentId', e.id, 'status', e.status, 'batchName', b.name, 'courseName', coalesce(nullif(c.name, ''), c.code),
        'courseCode', c.code, 'intakeStart', ci.start_date, 'intakeEnd', ci.end_date,
        'attendance', (
          select jsonb_build_object('classes', count(*), 'present', count(*) filter (where m.status = 'present'),
            'late', count(*) filter (where m.status = 'late'), 'absent', count(*) filter (where m.status = 'absent'),
            'excused', count(*) filter (where m.status = 'excused'))
          from public.lms_attendance_marks m join public.lms_attendance_register r on r.id = m.register_id and r.state = 'final'
          where m.enrolment_id = e.id),
        'units', coalesce((
          select jsonb_agg(jsonb_build_object('unitId', u.id, 'code', u.code, 'name', u.name, 'startDate', iu.start_date, 'endDate', iu.end_date,
            'items', coalesce((
              select jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'title', x.title, 'body', x.body, 'url', x.url,
                'path', x.storage_path, 'fileName', x.file_name, 'mimeType', x.mime_type, 'sizeBytes', x.size_bytes) order by x.sort, x.created_at)
              from public.unit_contents x where x.unit_id = u.id and x.visible_to_students), '[]'::jsonb))
            order by iu.sort, iu.start_date, u.sort)
          from public.intake_units iu join public.cms_course_units u on u.id = iu.unit_id
          where iu.intake_id = b.intake_id), '[]'::jsonb))
        order by ci.start_date desc)
      from public.batch_enrolments e
      join public.batches b on b.id = e.batch_id
      join public.course_intakes ci on ci.id = b.intake_id
      join public.cms_courses c on c.id = ci.course_id
      where e.student_id = v_student and e.status in ('active', 'deferred', 'completed')), '[]'::jsonb));
end;
$$;

create function public.lms_attendance_summary(p_batch uuid default null, p_student uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce(public.cms_is_staff(), false) then raise exception 'CMS staff access required' using errcode = '42501'; end if;
  if p_batch is null and p_student is null then raise exception 'Choose a batch or a student' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(row order by row->>'studentName') from (
      select jsonb_build_object('enrolmentId', e.id, 'studentId', s.id, 'studentName', s.full_name, 'enrolmentStatus', e.status,
        'batchId', b.id, 'batchName', b.name, 'courseName', coalesce(nullif(c.name, ''), c.code),
        'classes', count(m.status), 'present', count(*) filter (where m.status = 'present'), 'late', count(*) filter (where m.status = 'late'),
        'absent', count(*) filter (where m.status = 'absent'), 'excused', count(*) filter (where m.status = 'excused')) as row
      from public.batch_enrolments e
      join public.enrollment_students s on s.id = e.student_id
      join public.batches b on b.id = e.batch_id
      join public.course_intakes ci on ci.id = b.intake_id
      join public.cms_courses c on c.id = ci.course_id
      left join public.lms_attendance_marks m on m.enrolment_id = e.id
        and exists (select 1 from public.lms_attendance_register r where r.id = m.register_id and r.state = 'final')
      where (p_batch is null or e.batch_id = p_batch) and (p_student is null or e.student_id = p_student)
      group by e.id, s.id, b.id, c.id) t), '[]'::jsonb);
end;
$$;

create function public.admin_student_timeline(p_student uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.enrollment_students; v_email text;
begin
  perform public.admin_business_require();
  select * into s from public.enrollment_students where id = p_student;
  if not found then return null; end if;
  v_email := lower(nullif(btrim(coalesce(s.email, '')), ''));
  return coalesce((select jsonb_agg(to_jsonb(t) order by t.at desc) from (
    select * from (
      select s.created_at as at, 'student' as kind, 'Student record created' as title, '' as detail, null::uuid as application_id
      union all
      select a.created_at, 'application', 'Application ' || coalesce(nullif(a.reference, ''), 'started'), 'Draft created', a.id
      from public.enrollment_applications a where a.student_id = s.id
      union all
      select a.submitted_at, 'application', 'Application ' || coalesce(nullif(a.reference, ''), '') || ' submitted', '', a.id
      from public.enrollment_applications a where a.student_id = s.id and a.submitted_at is not null
      union all
      select h.created_at, 'status', 'Status: ' || replace(h.new_status, '_', ' '),
        concat_ws(' · ', nullif(h.actor_name, ''), nullif(h.note, '')), h.application_id
      from public.enrollment_application_status_history h join public.enrollment_applications a on a.id = h.application_id
      where a.student_id = s.id
      union all
      select l.issued_at, 'offer', 'Offer letter sent', concat_ws(' · ', 'To ' || nullif(l.recipient_name, ''), nullif(l.issued_by_name, '')), l.application_id
      from public.enrollment_offer_letters l join public.enrollment_applications a on a.id = l.application_id where a.student_id = s.id
      union all
      select (to_jsonb(l)->>'signed_at')::timestamptz, 'offer', 'Offer letter signed', '', l.application_id
      from public.enrollment_offer_letters l join public.enrollment_applications a on a.id = l.application_id
      where a.student_id = s.id and to_jsonb(l)->>'signed_at' is not null
      union all
      select l.accepted_at, 'offer', 'Offer accepted', nullif(l.accepted_by_name, ''), l.application_id
      from public.enrollment_offer_letters l join public.enrollment_applications a on a.id = l.application_id
      where a.student_id = s.id and l.accepted_at is not null
      union all
      select (to_jsonb(l)->>'deposit_paid_at')::timestamptz, 'payment', 'Deposit paid', '', l.application_id
      from public.enrollment_offer_letters l join public.enrollment_applications a on a.id = l.application_id
      where a.student_id = s.id and to_jsonb(l)->>'deposit_paid_at' is not null
      union all
      select coalesce(d.issued_at, d.uploaded_at), 'coe', case d.kind when 'voe' then 'VoE' else 'CoE' end || case when d.issued_at is null then ' uploaded' else ' issued' end,
        coalesce(d.document_number, ''), d.application_id
      from public.enrollment_coe_documents d join public.enrollment_applications a on a.id = d.application_id
      where a.student_id = s.id and d.superseded_at is null
      union all
      select e.enrolled_on::timestamptz, 'enrolment', 'Enrolled in batch ' || b.name, coalesce(nullif(c.name, ''), c.code) || ' · ' || e.enrolment_type || ' · ' || e.status, null
      from public.batch_enrolments e join public.batches b on b.id = e.batch_id join public.course_intakes ci on ci.id = b.intake_id
      join public.cms_courses c on c.id = ci.course_id where e.student_id = s.id
      union all
      select m.created_at, 'message',
        case m.channel when 'note' then 'Internal note' when 'teams' then 'Shared to team' else initcap(m.channel) || case m.direction when 'in' then ' received' else ' sent' end end,
        left(concat_ws(': ', nullif(m.subject, ''), m.body), 200) || coalesce(' · ' || nullif(m.sent_by_name, ''), ''), null
      from public.comm_messages m join public.comm_conversations cv on cv.id = m.conversation_id
      where cv.person_kind = 'student' and cv.person_ref = s.id
      union all
      select coalesce(n.sent_at, n.created_at), 'email', 'Email: ' || n.subject,
        case when n.sent_at is not null then 'Sent automatically' else 'Not sent (' || n.state || ')' end, n.application_id
      from public.notification_deliveries n
      where v_email is not null and lower(n.recipient_email) = v_email and n.hub_message_id is null
      union all
      select t.submitted_at, 'assessment', 'Submitted ' || x.title || ' (attempt ' || t.attempt_no || ')', coalesce(t.receipt_no, ''), null
      from public.asm_attempts t join public.asm_assignments g on g.id = t.assignment_id join public.asm_assessments x on x.id = g.assessment_id
      where t.student_id = s.id and t.submitted_at is not null
      union all
      select t.finalised_at, 'assessment', 'Result for ' || x.title || ': ' || case t.outcome when 'S' then 'Satisfactory' when 'NYS' then 'Not yet satisfactory' else coalesce(t.outcome, 'final') end, '', null
      from public.asm_attempts t join public.asm_assignments g on g.id = t.assignment_id join public.asm_assessments x on x.id = g.assessment_id
      where t.student_id = s.id and t.finalised_at is not null
      union all
      select o.created_at, 'account', 'Student email account created', o.upn, null
      from public.student_office365_accounts o where o.student_id = s.id
    ) u where u.at is not null order by u.at desc limit 400
  ) t), '[]'::jsonb);
end;
$$;

revoke all on function public.student_enrolled_unit_ids(uuid), public.unit_content_student_file(text), public.student_my_learning(),
  public.lms_attendance_summary(uuid, uuid), public.admin_student_timeline(uuid) from public, anon;
revoke all on function public.student_enrolled_unit_ids(uuid) from authenticated;
grant execute on function public.unit_content_student_file(text), public.student_my_learning(), public.lms_attendance_summary(uuid, uuid),
  public.admin_student_timeline(uuid) to authenticated;

commit;
