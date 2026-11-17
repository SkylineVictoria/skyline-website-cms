-- LMS-FIXES (end-to-end test findings, 2026-11-18). Additive (functions replaced in place, nothing dropped).
-- 1. A batch made automatically copies the class times of the intake's batch that already has dated classes (most weekly hours first),
--    not simply the last batch by name: a batch copied from one whose weekly times cannot fit the unit hours got no dated classes at all.
--    lms_batches_without_classes() lists active batches with students and no dated classes (CMS dashboard warning).
-- 2. Trainers mark attendance: trainer_session_attendance(session) and trainer_session_attendance_save(session, marks, state) for the
--    trainer of the batch (or of that unit in the batch), RTO Managers and CMS staff. A final register can be changed only by an RTO Manager.
--    Same tables as LMS > Attendance (lms_attendance_register / lms_attendance_marks), so the rates, dashboard and student view include it.
-- 3. The student timeline also shows certificates / statements (issued, revoked), staff placement overrides and attendance marks other
--    than Present.
-- Rollback (manual): restore rto_batch_pick and admin_student_timeline from 20261118100000 / 20261117081523; drop the three new functions.
begin;

-- 1 ------------------------------------------------------------------------------------------------------------------------------
-- As hosted (20261118100000) except the source batch for a new batch.
create or replace function public.rto_batch_pick(p_intake uuid, p_prefer text default null, p_on date default current_date, p_same boolean default false)
returns uuid language plpgsql security definer set search_path = public as $function$
declare ti public.course_intakes; b record; v_src uuid;
begin
 select * into ti from public.course_intakes where id = p_intake;
 if ti.id is null then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended('rto_batch_pick:' || ti.course_id, 0));
 for b in
  select bb.id from public.batches bb join public.course_intakes ci on ci.id = bb.intake_id
  where bb.is_active and ci.course_id = ti.course_id and ci.study_load = ti.study_load
   and (ci.id = ti.id or (not p_same and ci.status = 'open' and ci.start_date <= p_on and coalesce(ci.end_date, 'infinity'::date) >= p_on))
  order by (ci.id = ti.id) desc, (bb.name = p_prefer) desc, ci.start_date, bb.name
 loop
  if public.rto_batch_occupancy(b.id, p_on) < public.rto_batch_seats(b.id) then return b.id; end if;
 end loop;
 -- Copy a batch whose class times work: one with dated classes first, then the most weekly hours.
 select bb.id into v_src from public.batches bb where bb.intake_id = ti.id and bb.is_active
 order by exists (select 1 from public.class_sessions cs where cs.batch_id = bb.id) desc,
  (select coalesce(sum(extract(epoch from (s.end_time - s.start_time))), 0) from public.batch_sessions s where s.batch_id = bb.id) desc,
  bb.name desc, bb.created_at desc limit 1;
 if v_src is null then
  select bb.id into v_src from public.batches bb join public.course_intakes ci on ci.id = bb.intake_id
  where bb.is_active and ci.course_id = ti.course_id and ci.study_load = ti.study_load
  order by exists (select 1 from public.class_sessions cs where cs.batch_id = bb.id) desc,
   (select coalesce(sum(extract(epoch from (s.end_time - s.start_time))), 0) from public.batch_sessions s where s.batch_id = bb.id) desc,
   ci.start_date desc, bb.name limit 1;
 end if;
 if v_src is null then return public.rto_intake_default_batch(ti.id); end if;
 return public.rto_batch_clone(v_src, ti.id);
end $function$;

create function public.lms_batches_without_classes() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (coalesce(public.cms_is_admin(), false) or coalesce(public.cms_is_rto_manager(), false)) then raise exception 'Admin access required' using errcode = '42501'; end if;
  return (select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
    select jsonb_build_object('id', b.id, 'title', coalesce(nullif(c.code, ''), c.name) || ' · ' || b.name,
      'detail', (select count(*) from public.batch_enrolments e where e.batch_id = b.id and e.status in ('active', 'deferred')) || ' students · intake '
        || to_char(ci.start_date, 'DD Mon YYYY') || ' · set weekly class times that fit the unit hours',
      'to', '/admin/lms/intakes#' || ci.id) i, row_number() over (order by ci.start_date, b.name) n
    from public.batches b join public.course_intakes ci on ci.id = b.intake_id join public.cms_courses c on c.id = ci.course_id
    where b.is_active and coalesce(ci.end_date, ci.start_date) >= public.course_intake_today()
      and exists (select 1 from public.batch_enrolments e where e.batch_id = b.id and e.status in ('active', 'deferred'))
      and not exists (select 1 from public.class_sessions cs where cs.batch_id = b.id)) t);
end;
$$;

-- 2 ------------------------------------------------------------------------------------------------------------------------------
-- The trainer of a dated class: trains the batch, or trains that unit in the batch.
create function public.lms_session_trainer(p_session uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.class_sessions cs
    where cs.id = p_session and public.asm_trainer_profile() is not null
      and (exists (select 1 from public.batch_trainers bt where bt.batch_id = cs.batch_id and bt.staff_id = public.asm_trainer_profile())
        or exists (select 1 from public.batch_unit_trainers ut join public.intake_units iu on iu.id = ut.intake_unit_id
          where ut.batch_id = cs.batch_id and ut.staff_id = public.asm_trainer_profile() and iu.unit_id = cs.unit_id)));
$$;

create function public.trainer_session_attendance(p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cs public.class_sessions; v_iu uuid; v_reg public.lms_attendance_register;
begin
  select * into cs from public.class_sessions where id = p_session;
  if cs.id is null then raise exception 'Class not found' using errcode = 'P0002'; end if;
  if not (public.lms_session_trainer(p_session) or coalesce(public.cms_is_staff(), false)) then raise exception 'Only the trainer of this class can mark it' using errcode = '42501'; end if;
  select iu.id into v_iu from public.intake_units iu join public.batches b on b.intake_id = iu.intake_id where b.id = cs.batch_id and iu.unit_id = cs.unit_id limit 1;
  if v_iu is null then raise exception 'This class has no unit, so attendance cannot be marked' using errcode = '22023'; end if;
  select * into v_reg from public.lms_attendance_register where batch_id = cs.batch_id and intake_unit_id = v_iu and class_date = cs.session_date;
  return jsonb_build_object('sessionId', cs.id, 'date', cs.session_date, 'start', to_char(cs.start_time, 'HH24:MI'), 'end', to_char(cs.end_time, 'HH24:MI'),
    'state', coalesce(v_reg.state, 'new'), 'canChangeFinal', coalesce(public.cms_is_rto_manager(), false),
    'students', coalesce((select jsonb_agg(jsonb_build_object('enrolmentId', e.id, 'name', s.full_name,
        'status', (select m.status from public.lms_attendance_marks m where m.register_id = v_reg.id and m.enrolment_id = e.id)) order by s.full_name)
      from public.batch_enrolments e join public.enrollment_students s on s.id = e.student_id
      where e.batch_id = cs.batch_id and e.status in ('active', 'deferred') and e.enrolled_on <= cs.session_date), '[]'::jsonb));
end;
$$;

create function public.trainer_session_attendance_save(p_session uuid, p_marks jsonb, p_state text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cs public.class_sessions; v_iu uuid; v_reg uuid; v_old text; x jsonb; v_enrol uuid; v_status text;
begin
  select * into cs from public.class_sessions where id = p_session;
  if cs.id is null then raise exception 'Class not found' using errcode = 'P0002'; end if;
  if not (public.lms_session_trainer(p_session) or coalesce(public.cms_is_rto_manager(), false)) then raise exception 'Only the trainer of this class can mark it' using errcode = '42501'; end if;
  if p_state not in ('draft', 'final') then raise exception 'Invalid state' using errcode = '22023'; end if;
  if cs.session_date > public.course_intake_today() then raise exception 'Attendance can be marked on or after the class day' using errcode = '22023'; end if;
  select iu.id into v_iu from public.intake_units iu join public.batches b on b.intake_id = iu.intake_id where b.id = cs.batch_id and iu.unit_id = cs.unit_id limit 1;
  if v_iu is null then raise exception 'This class has no unit, so attendance cannot be marked' using errcode = '22023'; end if;
  select id, state into v_reg, v_old from public.lms_attendance_register where batch_id = cs.batch_id and intake_unit_id = v_iu and class_date = cs.session_date;
  if v_old = 'final' and not coalesce(public.cms_is_rto_manager(), false) then raise exception 'This register is final. Ask an RTO Manager to change it.' using errcode = '42501'; end if;
  insert into public.lms_attendance_register(batch_id, intake_unit_id, class_date, state, updated_by)
  values (cs.batch_id, v_iu, cs.session_date, p_state, auth.uid())
  on conflict (batch_id, intake_unit_id, class_date) do update set state = excluded.state, updated_at = now(), updated_by = excluded.updated_by
  returning id into v_reg;
  delete from public.lms_attendance_marks where register_id = v_reg;
  for x in select value from jsonb_array_elements(coalesce(p_marks, '[]'::jsonb)) loop
    v_enrol := (x->>'enrolmentId')::uuid; v_status := x->>'status';
    if v_status not in ('present', 'absent', 'late', 'excused') then raise exception 'Invalid attendance status' using errcode = '22023'; end if;
    if not exists (select 1 from public.batch_enrolments where id = v_enrol and batch_id = cs.batch_id and status in ('active', 'deferred')) then
      raise exception 'Student is not enrolled in this batch' using errcode = '22023';
    end if;
    insert into public.lms_attendance_marks(register_id, enrolment_id, status) values (v_reg, v_enrol, v_status);
  end loop;
  if p_state = 'final' and exists (select 1 from public.batch_enrolments e where e.batch_id = cs.batch_id and e.status in ('active', 'deferred') and e.enrolled_on <= cs.session_date
      and not exists (select 1 from public.lms_attendance_marks m where m.register_id = v_reg and m.enrolment_id = e.id)) then
    raise exception 'Mark every student before saving as final' using errcode = '22023';
  end if;
  return jsonb_build_object('saved', true, 'state', p_state);
end;
$$;

-- 3 ------------------------------------------------------------------------------------------------------------------------------
-- As 20261117081523 plus certificates, placement overrides and attendance marks.
create or replace function public.admin_student_timeline(p_student uuid) returns jsonb
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
      select o.at, 'enrolment', 'Staff override: ' || o.action || coalesce(' (batch ' || b.name || ')', ''), o.reason, null
      from public.rto_placement_overrides o left join public.batches b on b.id = o.batch_id where o.student_id = s.id
      union all
      select g.class_date::timestamptz, 'attendance', initcap(m.status) || ' in class', coalesce(u.code, '') || ' · batch ' || b.name, null
      from public.lms_attendance_marks m join public.lms_attendance_register g on g.id = m.register_id and g.state = 'final'
      join public.batch_enrolments e on e.id = m.enrolment_id join public.batches b on b.id = g.batch_id
      join public.intake_units iu on iu.id = g.intake_unit_id join public.cms_course_units u on u.id = iu.unit_id
      where e.student_id = s.id and m.status <> 'present'
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
      select cc.issued_at, 'certificate', case cc.kind when 'certificate' then 'Certificate issued' else 'Statement of attainment issued' end,
        cc.certificate_no || ' · ' || cc.course_code || ' ' || cc.course_name, null
      from public.course_completions cc where cc.student_id = s.id
      union all
      select cc.revoked_at, 'certificate', case cc.kind when 'certificate' then 'Certificate revoked' else 'Statement revoked' end,
        cc.certificate_no || coalesce(' · ' || cc.revoke_reason, ''), null
      from public.course_completions cc where cc.student_id = s.id and cc.revoked_at is not null
      union all
      select o.created_at, 'account', 'Student email account created', o.upn, null
      from public.student_office365_accounts o where o.student_id = s.id
    ) u where u.at is not null order by u.at desc limit 500
  ) t), '[]'::jsonb);
end;
$$;

revoke all on function public.lms_batches_without_classes(), public.lms_session_trainer(uuid), public.trainer_session_attendance(uuid),
  public.trainer_session_attendance_save(uuid, jsonb, text) from public, anon;
revoke all on function public.lms_session_trainer(uuid) from authenticated;
grant execute on function public.lms_batches_without_classes(), public.trainer_session_attendance(uuid), public.trainer_session_attendance_save(uuid, jsonb, text) to authenticated;

commit;
