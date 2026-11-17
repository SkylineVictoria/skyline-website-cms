-- LATE-JOINER-NEXT-INTAKE (2026-11-18): a student who is placed in an intake after one of its prerequisite units has ended (and is not Competent
-- in it) would take no unit there (20261118120000), yet still got a seat, and often a whole new batch, in an intake they do not study in. They are now
-- placed straight into the next intake of the course (the next one that starts after this one, or the one made automatically), from that
-- intake's first day, where the prerequisite units come first. A handpicked batch (rto_batch_join) is left to the staff member's choice.
-- Additive: one helper and rto_batch_assign redefined (as in 20261118100000) with the redirect.
create function public.rto_prereq_missed(p_student uuid, p_intake uuid, p_on date) returns boolean
language sql stable security definer set search_path = public as $$
 select exists (
  select 1 from public.intake_units p
  where p.intake_id = p_intake and p.end_date < p_on
   and exists (select 1 from public.intake_units x where x.intake_id = p_intake and x.unit_id <> p.unit_id and p.unit_id in (select public.rto_unit_requires_all(x.unit_id)))
   and not exists (select 1 from public.rto_unit_outcome(p_student, p.unit_id) o where o.outcome = 'C'));
$$;

create or replace function public.rto_batch_assign(p_student uuid, p_course text, p_intake uuid default null, p_type text default 'CoE', p_on date default current_date) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_intake uuid := p_intake; v_batch uuid; v_enrol uuid; v_latest uuid; v_on date := p_on; v_next uuid; v_src public.course_intakes;
begin
 if v_intake is null then
  v_intake := public.rto_open_intake(p_course, v_on);
  if v_intake is null then
   select ci.id into v_latest from public.course_intakes ci where ci.course_id = p_course order by ci.start_date desc limit 1;
   if v_latest is not null then v_intake := public.rto_intake_auto_next(v_latest); end if;
  end if;
  if v_intake is null then raise exception 'This course has no open intake. Add one first.' using errcode = '22023'; end if;
 end if;
 select e.id into v_enrol from public.batch_enrolments e join public.batches b on b.id = e.batch_id
 where b.intake_id = v_intake and e.student_id = p_student and e.status in ('active', 'deferred') order by e.carry_over, e.enrolled_on limit 1;
 if v_enrol is not null then return v_enrol; end if;
 -- Joining after a prerequisite unit ended: the next intake, from its first day.
 if public.rto_prereq_missed(p_student, v_intake, v_on) then
  select * into v_src from public.course_intakes where id = v_intake;
  select ci.id into v_next from public.course_intakes ci
  where ci.course_id = v_src.course_id and ci.study_load = v_src.study_load and ci.is_active and ci.status = 'open' and ci.start_date > v_src.start_date
  order by ci.start_date, ci.id limit 1;
  if v_next is null then v_next := public.rto_intake_auto_next(v_intake); end if;
  if v_next is not null then
   select ci.start_date into v_on from public.course_intakes ci where ci.id = v_next;
   v_intake := v_next;
   select e.id into v_enrol from public.batch_enrolments e join public.batches b on b.id = e.batch_id
   where b.intake_id = v_intake and e.student_id = p_student and e.status in ('active', 'deferred') order by e.carry_over, e.enrolled_on limit 1;
   if v_enrol is not null then return v_enrol; end if;
  end if;
 end if;
 v_batch := public.rto_batch_pick(v_intake, null, v_on);
 if v_batch is null then
  raise exception 'No batch could be opened for this intake. Set the course''s class days and times first.' using errcode = '22023';
 end if;
 if not public.rto_student_on_course(p_student, p_course) then
  if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'The student has no application for this course.' using errcode = '22023'; end if;
  perform public.rto_direct_application(p_student, v_intake);
 end if;
 insert into public.batch_enrolments(batch_id, student_id, enrolment_type, status, enrolled_on)
 values (v_batch, p_student, coalesce(nullif(p_type, ''), 'CoE'), 'active', v_on)
 on conflict (batch_id, student_id) do update set status = 'active', enrolment_type = excluded.enrolment_type
 returning id into v_enrol;
 return v_enrol;
end $$;
revoke all on function public.rto_prereq_missed(uuid, uuid, date), public.rto_batch_assign(uuid, text, uuid, text, date) from public, anon, authenticated;
