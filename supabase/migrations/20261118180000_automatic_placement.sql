-- AUTOMATIC-PLACEMENT (2026-11-18): students are placed in batches by the system, never by hand. When an application reaches Offer accepted (or CoE issued /
-- Enrolled) the student is placed in a batch of the application's intake (or the course's open intake): the first batch with a free seat, a new batch
-- when it is full, the next intake when they join after a prerequisite unit ended, from the intake's first day or today if it is running. A withdrawn or
-- rejected application withdraws the placement. A sweep (every 15 minutes, and when a course's usual classes change) places anyone still waiting.
-- Staff can still override (an Admin or RTO Manager, with a reason, kept in rto_placement_overrides): place a student by hand on a chosen day, move one to another
-- batch, or remove one; an override-removed student is not placed again by the automation.
-- Other manual paths are closed: batch_enrolments accepts a new row only from these automatic functions or the carry-over planner (so the old `enrol` action
-- and a hand-picked "joins on" no longer work), rto_batch_assign only runs automatically, and rto_batch_join is dropped.
-- Additive apart from dropping rto_batch_join (added 20261118110000, only the removed picker called it).
-- The record of every staff override.
create table public.rto_placement_overrides (
 id uuid primary key default gen_random_uuid(),
 student_id uuid not null references public.enrollment_students(id) on delete cascade,
 course_id text not null,
 batch_id uuid references public.batches(id) on delete set null,
 enrolment_id uuid,
 action text not null check (action in ('place', 'move', 'remove')),
 reason text not null check (length(btrim(reason)) > 0),
 detail jsonb not null default '{}'::jsonb,
 actor uuid default auth.uid(),
 at timestamptz not null default now()
);
create index rto_placement_overrides_student on public.rto_placement_overrides(student_id, course_id, at);
alter table public.rto_placement_overrides enable row level security;
revoke all on public.rto_placement_overrides from anon, authenticated;

create function public.rto_auto_placing() returns boolean language sql stable as $$ select coalesce(current_setting('rto.auto_place', true), '') = 'on' $$;

-- The automatic path creates batches and their class calendars without a signed-in RTO manager.
do $$
declare d text; r record; a1 constant text := 'coalesce(public.cms_is_rto_manager(), false)'; a2 constant text := 'if not public.cms_is_rto_manager() then raise exception ''Only an RTO Manager can generate class sessions.''';
begin
 for r in select p.oid::regprocedure as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('rto_batch_clone', 'rto_intake_default_batch') loop
  d := pg_get_functiondef(r.f);
  if position(a1 in d) = 0 then raise exception 'anchor not found in %', r.f; end if;
  execute replace(d, a1, '(coalesce(public.cms_is_rto_manager(), false) or public.rto_auto_placing())');
 end loop;
 d := pg_get_functiondef('public.rto_class_sessions_generate(uuid)'::regprocedure);
 if position(a2 in d) = 0 then raise exception 'anchor not found in rto_class_sessions_generate'; end if;
 execute replace(d, 'if not public.cms_is_rto_manager() then raise exception ''Only an RTO Manager can generate class sessions.''', 'if not (public.cms_is_rto_manager() or public.rto_auto_placing()) then raise exception ''Only an RTO Manager can generate class sessions.''');
end $$;

drop function public.rto_batch_join(uuid, uuid, text, date);

create or replace function public.rto_batch_assign(p_student uuid, p_course text, p_intake uuid default null, p_type text default 'CoE', p_on date default current_date) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_intake uuid := p_intake; v_batch uuid; v_enrol uuid; v_latest uuid; v_on date := p_on; v_next uuid; v_src public.course_intakes;
begin
 if not public.rto_auto_placing() then raise exception 'Students are placed in batches automatically when their offer is accepted.' using errcode = '42501'; end if;
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
  perform public.rto_direct_application(p_student, v_intake);
 end if;
 insert into public.batch_enrolments(batch_id, student_id, enrolment_type, status, enrolled_on)
 values (v_batch, p_student, coalesce(nullif(p_type, ''), 'CoE'), 'active', v_on)
 on conflict (batch_id, student_id) do update set status = 'active', enrolment_type = excluded.enrolment_type
 returning id into v_enrol;
 return v_enrol;
end $$;

-- The LMS allocation trigger places automatically too.
create or replace function public.rto_lms_place_student() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_course text;
begin
 select ci.course_id into v_course from public.course_intakes ci where ci.id = new.intake_id;
 if exists(select 1 from public.batch_enrolments e join public.batches b on b.id = e.batch_id
   where b.intake_id = new.intake_id and e.student_id = new.student_id and e.status in ('active', 'deferred', 'completed')) then
  return null;
 end if;
 begin
  perform set_config('rto.auto_place', 'on', true);
  perform public.rto_batch_assign(new.student_id, v_course, new.intake_id, 'CoE', greatest((new.enrolled_at at time zone 'Australia/Melbourne')::date, (select start_date from public.course_intakes where id = new.intake_id)));
 exception when others then null;
 end;
 perform set_config('rto.auto_place', 'off', true);
 return null;
end $$;

-- A batch enrolment can only be created automatically.
create function public.batch_enrolments_auto_only() returns trigger language plpgsql as $$
begin
 if public.rto_auto_placing() or coalesce(current_setting('rto.carry_over_planning', true), '') = 'on' then return new; end if;
 raise exception 'Students are placed in batches automatically when their offer is accepted.' using errcode = '42501';
end $$;
create trigger batch_enrolments_auto_only before insert on public.batch_enrolments for each row execute function public.batch_enrolments_auto_only();

-- Place one application's student.
create function public.rto_auto_place_one(p_app uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; c record; i public.course_intakes; n integer := 0;
begin
 select * into a from public.enrollment_applications where id = p_app;
 if a.id is null or a.student_id is null or a.status not in ('offer_accepted', 'coe_issued', 'enrolled') then return 0; end if;
 for c in select * from public.enrollment_application_courses where application_id = a.id loop
  if exists (select 1 from public.batch_enrolments e join public.batches b on b.id = e.batch_id join public.course_intakes ci on ci.id = b.intake_id
   where e.student_id = a.student_id and ci.course_id = c.course_id and e.status in ('active', 'deferred', 'completed')) then continue; end if;
  -- Staff removed this student from the course by hand: leave them out.
  if exists (select 1 from public.rto_placement_overrides o where o.student_id = a.student_id and o.course_id = c.course_id and o.action = 'remove'
   and not exists (select 1 from public.rto_placement_overrides o2 where o2.student_id = o.student_id and o2.course_id = o.course_id and o2.action = 'place' and o2.at > o.at)) then continue; end if;
  i := null;
  if c.intake_id is not null then select * into i from public.course_intakes where id = c.intake_id; end if;
  begin
   perform set_config('rto.auto_place', 'on', true);
   perform public.rto_batch_assign(a.student_id, c.course_id, c.intake_id, case when i.study_load = 'voe' then 'VoE' else 'CoE' end,
    greatest(public.course_intake_today(), coalesce(i.start_date, public.course_intake_today())));
   n := n + 1;
  exception when others then null;
  end;
  perform set_config('rto.auto_place', 'off', true);
 end loop;
 return n;
end $$;

create function public.rto_auto_place_sweep() returns integer
language plpgsql security definer set search_path = public as $$
declare a record; n integer := 0;
begin
 for a in select id from public.enrollment_applications where status in ('offer_accepted', 'coe_issued', 'enrolled') and student_id is not null loop
  begin n := n + public.rto_auto_place_one(a.id); exception when others then null; end;
 end loop;
 return n;
end $$;

create function public.rto_application_placement() returns trigger language plpgsql security definer set search_path = public as $$
begin
 if new.status in ('offer_accepted', 'coe_issued', 'enrolled') and old.status is distinct from new.status then
  begin perform public.rto_auto_place_one(new.id); exception when others then null; end;
 elsif new.status in ('withdrawn', 'rejected') and old.status in ('offer_accepted', 'coe_issued', 'enrolled') then
  update public.batch_enrolments e set status = 'withdrawn'
  where e.student_id = new.student_id and e.status in ('active', 'deferred')
   and e.batch_id in (select b.id from public.batches b join public.course_intakes ci on ci.id = b.intake_id
    where ci.course_id in (select c.course_id from public.enrollment_application_courses c where c.application_id = new.id));
 end if;
 return new;
end $$;
create trigger enrollment_applications_placement after update of status on public.enrollment_applications for each row execute function public.rto_application_placement();

-- A course's usual classes change: anyone who could not be placed before is tried again.
create function public.rto_defaults_replace() returns trigger language plpgsql security definer set search_path = public as $$
begin
 begin perform public.rto_auto_place_sweep(); exception when others then null; end;
 return null;
end $$;
create trigger course_class_defaults_place after insert or update on public.course_class_defaults for each row execute function public.rto_defaults_replace();

-- Students whose offer is accepted but who are not in a batch yet (for the CMS to show why).
create function public.rto_placement_waiting() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('studentId', s.id, 'name', s.full_name, 'courseId', c.course_id, 'courseName', coalesce(nullif(c.course_title, ''), c.course_code),
   'intakeId', c.intake_id, 'since', a.updated_at) order by a.updated_at)
  from public.enrollment_applications a join public.enrollment_application_courses c on c.application_id = a.id join public.enrollment_students s on s.id = a.student_id
  where a.status in ('offer_accepted', 'coe_issued', 'enrolled')
   and not exists (select 1 from public.batch_enrolments e join public.batches b on b.id = e.batch_id join public.course_intakes ci on ci.id = b.intake_id
    where e.student_id = a.student_id and ci.course_id = c.course_id and e.status in ('active', 'deferred', 'completed'))
   and not exists (select 1 from public.rto_placement_overrides o where o.student_id = a.student_id and o.course_id = c.course_id and o.action = 'remove'
    and not exists (select 1 from public.rto_placement_overrides o2 where o2.student_id = o.student_id and o2.course_id = o.course_id and o2.action = 'place' and o2.at > o.at))), '[]'::jsonb);
end $$;

-- Staff override: place a student in a chosen batch on a chosen day. The seat guard still applies (a full batch refuses).
create function public.rto_staff_place(p_batch uuid, p_student uuid, p_type text, p_on date, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b public.batches; i public.course_intakes; v_on date := coalesce(p_on, public.course_intake_today()); v_enrol uuid;
begin
 if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then raise exception 'Only an Admin or an RTO Manager can place a student by hand.' using errcode = '42501'; end if;
 if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why you are placing this student by hand.' using errcode = '22023'; end if;
 select * into b from public.batches where id = p_batch;
 if b.id is null or not b.is_active then raise exception 'Choose an active batch.' using errcode = '22023'; end if;
 select * into i from public.course_intakes where id = b.intake_id;
 if v_on < i.start_date then raise exception 'The student cannot join before the intake starts (%).', i.start_date using errcode = '22023'; end if;
 if i.end_date is not null and v_on > i.end_date then raise exception 'The student cannot join after the intake ends (%).', i.end_date using errcode = '22023'; end if;
 if not public.rto_student_on_course(p_student, i.course_id) then perform public.rto_direct_application(p_student, i.id); end if;
 perform set_config('rto.auto_place', 'on', true);
 insert into public.batch_enrolments(batch_id, student_id, enrolment_type, status, enrolled_on)
 values (p_batch, p_student, coalesce(nullif(p_type, ''), 'CoE'), 'active', v_on)
 on conflict (batch_id, student_id) do update set status = 'active', enrolment_type = excluded.enrolment_type, enrolled_on = excluded.enrolled_on
 returning id into v_enrol;
 perform set_config('rto.auto_place', 'off', true);
 insert into public.rto_placement_overrides(student_id, course_id, batch_id, enrolment_id, action, reason, detail)
 values (p_student, i.course_id, p_batch, v_enrol, 'place', btrim(p_reason), jsonb_build_object('on', v_on, 'type', p_type));
 return jsonb_build_object('enrolmentId', v_enrol, 'batchId', b.id, 'batch', b.name, 'intakeId', b.intake_id, 'joinedOn', v_on);
end $$;

-- Staff override: move a student to another batch of the same course.
create function public.rto_staff_move(p_enrolment uuid, p_to_batch uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e public.batch_enrolments; src public.course_intakes; dst public.course_intakes; tb public.batches;
begin
 if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then raise exception 'Only an Admin or an RTO Manager can move a student.' using errcode = '42501'; end if;
 if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why you are moving this student.' using errcode = '22023'; end if;
 select * into e from public.batch_enrolments where id = p_enrolment;
 if e.id is null then raise exception 'Enrolment not found.' using errcode = 'P0002'; end if;
 select ci.* into src from public.batches b join public.course_intakes ci on ci.id = b.intake_id where b.id = e.batch_id;
 select * into tb from public.batches where id = p_to_batch;
 select * into dst from public.course_intakes where id = tb.intake_id;
 if tb.id is null or not tb.is_active or dst.course_id <> src.course_id then raise exception 'Choose an active batch of the same course.' using errcode = '22023'; end if;
 if exists (select 1 from public.batch_enrolments x where x.batch_id = p_to_batch and x.student_id = e.student_id and x.id <> e.id and x.status in ('active', 'deferred')) then raise exception 'The student is already in that batch.' using errcode = '22023'; end if;
 update public.batch_enrolments set batch_id = p_to_batch where id = e.id;
 insert into public.rto_placement_overrides(student_id, course_id, batch_id, enrolment_id, action, reason, detail)
 values (e.student_id, src.course_id, p_to_batch, e.id, 'move', btrim(p_reason), jsonb_build_object('from', e.batch_id));
 return jsonb_build_object('enrolmentId', e.id, 'batchId', p_to_batch);
end $$;

-- Staff override: take a student out of a batch; the automation will not place them in this course again.
create function public.rto_staff_remove(p_enrolment uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e public.batch_enrolments; ci public.course_intakes;
begin
 if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then raise exception 'Only an Admin or an RTO Manager can remove a student.' using errcode = '42501'; end if;
 if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why you are removing this student.' using errcode = '22023'; end if;
 select * into e from public.batch_enrolments where id = p_enrolment;
 if e.id is null then raise exception 'Enrolment not found.' using errcode = 'P0002'; end if;
 select c.* into ci from public.batches b join public.course_intakes c on c.id = b.intake_id where b.id = e.batch_id;
 update public.batch_enrolments set status = 'withdrawn' where id = e.id;
 insert into public.rto_placement_overrides(student_id, course_id, batch_id, enrolment_id, action, reason) values (e.student_id, ci.course_id, e.batch_id, e.id, 'remove', btrim(p_reason));
 return jsonb_build_object('enrolmentId', e.id, 'status', 'withdrawn');
end $$;

-- The override log of one student (staff).
create function public.rto_placement_overrides_list(p_student uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('action', o.action, 'reason', o.reason, 'at', o.at, 'batch', b.name, 'detail', o.detail) order by o.at desc)
  from public.rto_placement_overrides o left join public.batches b on b.id = o.batch_id where o.student_id = p_student), '[]'::jsonb);
end $$;

revoke all on function public.rto_staff_place(uuid, uuid, text, date, text), public.rto_staff_move(uuid, uuid, text), public.rto_staff_remove(uuid, text), public.rto_placement_overrides_list(uuid) from public, anon;
grant execute on function public.rto_staff_place(uuid, uuid, text, date, text), public.rto_staff_move(uuid, uuid, text), public.rto_staff_remove(uuid, text), public.rto_placement_overrides_list(uuid) to authenticated;

revoke all on function public.rto_auto_placing(), public.rto_auto_place_one(uuid), public.rto_auto_place_sweep(), public.rto_application_placement(), public.rto_defaults_replace(),
 public.batch_enrolments_auto_only(), public.rto_lms_place_student(), public.rto_batch_assign(uuid, text, uuid, text, date) from public, anon, authenticated;
revoke all on function public.rto_placement_waiting() from public, anon;
grant execute on function public.rto_placement_waiting() to authenticated;

do $$ begin
 if exists (select 1 from pg_extension where extname = 'pg_cron') then
  perform cron.unschedule(jobid) from cron.job where jobname = 'rto-auto-place';
  perform cron.schedule('rto-auto-place', '*/15 * * * *', 'select public.rto_auto_place_sweep()');
 end if;
end $$;
