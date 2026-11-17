-- ADMIN-TODAY: the CMS dashboard's "Needs action today" board. One read-only function for Admins and RTO Managers returning, for each
-- area, a count and up to five items with a link target: applications to review (submitted / under review), documents waiting for
-- review, offers sent and not signed for 3+ days, deposits unpaid after signing, students below 80 % attendance (3+ classes marked),
-- assessments waiting for marking, open support tickets, today's classes and students ready for a certificate. Columns added by later
-- hosted-only migrations are read through to_jsonb(row). Additive.
-- Rollback (manual): drop function public.admin_today().
begin;

create function public.admin_today() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today date := (now() at time zone 'Australia/Melbourne')::date; r jsonb := '{}'::jsonb;
begin
  if not (coalesce(public.cms_is_admin(), false) or coalesce(public.cms_is_rto_manager(), false)) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  r := r || jsonb_build_object('applications', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', a.id, 'title', coalesce(s.full_name, 'Applicant'), 'detail', coalesce(nullif(a.reference, ''), 'Application') || ' · ' || replace(a.status, '_', ' '),
        'at', coalesce(a.submitted_at, a.updated_at), 'to', '/admin/applications/' || a.id) i, row_number() over (order by coalesce(a.submitted_at, a.updated_at)) n
      from public.enrollment_applications a left join public.enrollment_students s on s.id = a.student_id
      where a.status in ('submitted', 'under_review')) t));

  r := r || jsonb_build_object('documents', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', d.id, 'title', coalesce(s.full_name, 'Applicant'), 'detail', d.category || ' · ' || d.filename,
        'at', d.created_at, 'to', '/admin/applications/' || d.application_id) i, row_number() over (order by d.created_at) n
      from public.enrollment_application_documents d join public.enrollment_applications a on a.id = d.application_id
      left join public.enrollment_students s on s.id = a.student_id
      where d.review_state = 'Pending' and d.is_current and a.status not in ('draft', 'withdrawn', 'rejected')) t));

  r := r || jsonb_build_object('unsignedOffers', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', l.id, 'title', coalesce(s.full_name, l.recipient_name), 'detail', 'Sent ' || to_char(l.issued_at at time zone 'Australia/Melbourne', 'DD Mon'),
        'at', l.issued_at, 'to', '/admin/applications/' || l.application_id) i, row_number() over (order by l.issued_at) n
      from public.enrollment_offer_letters l join public.enrollment_applications a on a.id = l.application_id
      left join public.enrollment_students s on s.id = a.student_id
      where a.status = 'offer_issued' and l.accepted_at is null and to_jsonb(l)->>'signed_at' is null and l.issued_at < now() - interval '3 days'
        and not exists (select 1 from public.enrollment_offer_letters z where z.application_id = l.application_id and z.issued_at > l.issued_at)) t));

  r := r || jsonb_build_object('unpaidDeposits', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', l.id, 'title', coalesce(s.full_name, l.recipient_name),
        'detail', '$' || to_char((to_jsonb(l)->>'payment_amount_cents')::numeric / 100, 'FM999,999,990.00') || ' due',
        'at', coalesce((to_jsonb(l)->>'signed_at')::timestamptz, l.accepted_at), 'to', '/admin/applications/' || l.application_id) i,
        row_number() over (order by coalesce((to_jsonb(l)->>'signed_at')::timestamptz, l.accepted_at)) n
      from public.enrollment_offer_letters l join public.enrollment_applications a on a.id = l.application_id
      left join public.enrollment_students s on s.id = a.student_id
      where coalesce((to_jsonb(l)->>'payment_amount_cents')::int, 0) > 0 and to_jsonb(l)->>'deposit_paid_at' is null
        and (to_jsonb(l)->>'signed_at' is not null or l.accepted_at is not null) and a.status in ('offer_issued', 'offer_accepted')) t));

  r := r || jsonb_build_object('lowAttendance', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', e.id, 'title', s.full_name, 'detail', round(rate) || '% · ' || b.name, 'to', '/admin/students/' || s.id) i,
        row_number() over (order by rate) n
      from (select m.enrolment_id, 100.0 * count(*) filter (where m.status in ('present', 'late')) / nullif(count(*) filter (where m.status <> 'excused'), 0) rate,
              count(*) filter (where m.status <> 'excused') counted
            from public.lms_attendance_marks m join public.lms_attendance_register g on g.id = m.register_id and g.state = 'final'
            group by m.enrolment_id) x
      join public.batch_enrolments e on e.id = x.enrolment_id and e.status = 'active'
      join public.enrollment_students s on s.id = e.student_id join public.batches b on b.id = e.batch_id
      where x.counted >= 3 and x.rate < 80) t));

  r := r || jsonb_build_object('marking', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', t.id, 'title', s.full_name, 'detail', x.title || ' · attempt ' || t.attempt_no, 'at', t.submitted_at,
        'to', '/admin/assessments/' || x.id) i, row_number() over (order by t.submitted_at) n
      from public.asm_attempts t join public.asm_assignments g on g.id = t.assignment_id join public.asm_assessments x on x.id = g.assessment_id
      join public.enrollment_students s on s.id = t.student_id
      where t.state in ('submitted', 'marking')) t));

  r := r || jsonb_build_object('tickets', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', k.id, 'title', k.subject, 'detail', concat_ws(' · ', k.ref, nullif(k.requester_name, ''), replace(k.status, '_', ' ')),
        'at', k.created_at, 'to', '/admin/tickets/' || k.id) i,
        row_number() over (order by k.created_at) n
      from public.support_tickets k where k.status in ('open', 'in_progress')) t));

  r := r || jsonb_build_object('classesToday', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', cs.id, 'title', to_char(cs.start_time, 'HH24:MI') || '–' || to_char(cs.end_time, 'HH24:MI') || ' ' || coalesce(u.code, c.code),
        'detail', 'Class ' || b.name || coalesce(' · Room ' || rm.name, ''), 'to', '/admin/lms/timetable') i, row_number() over (order by cs.start_time) n
      from public.class_sessions cs join public.batches b on b.id = cs.batch_id join public.course_intakes ci on ci.id = b.intake_id
      join public.cms_courses c on c.id = ci.course_id left join public.cms_course_units u on u.id = cs.unit_id left join public.classrooms rm on rm.id = cs.room_id
      where cs.session_date = v_today and cs.status = 'scheduled') t));

  r := r || jsonb_build_object('certificatesReady', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', e.id, 'title', s.full_name, 'detail', 'Class ' || b.name || ' · all units competent', 'to', '/admin/lms/completion') i,
        row_number() over (order by s.full_name) n
      from public.batch_enrolments e join public.enrollment_students s on s.id = e.student_id join public.batches b on b.id = e.batch_id
      where e.status in ('active', 'completed')
        and not exists (select 1 from public.course_completions cc where cc.enrolment_id = e.id and cc.kind = 'certificate' and cc.revoked_at is null)
        and exists (select 1 from public.intake_units iu where iu.intake_id = b.intake_id)
        and not exists (select 1 from public.intake_units iu where iu.intake_id = b.intake_id and coalesce((
          select o.outcome from public.asm_unit_outcomes o where o.student_id = e.student_id and o.unit_id = iu.unit_id
            and not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = o.id) order by o.signed_at desc limit 1), '') <> 'C')) t));

  return r;
end;
$$;

revoke all on function public.admin_today() from public, anon;
grant execute on function public.admin_today() to authenticated;

commit;
