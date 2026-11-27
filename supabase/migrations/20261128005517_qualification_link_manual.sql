-- QUALIFICATION-LINK (owner, 2026-11-27): gates 5 and 10, every Qualification has its application.
--  5. Re-add to intake (rto_staff_place) links the Qualification to the student's application for that course and closes that
--     application's "Place student manually" task (note: placed by hand). An Enrolled application whose Qualification is already
--     In Progress / Deferred / Suspended becomes Active at once.
-- 10. The application is the student's open application for the course (latest along the path); when there is none, the direct
--     application that placement makes (rto_direct_application, "direct enrolment"). A live Qualification still linked to a
--     withdrawn / rejected application moves to the open one.
-- Gate 1 (20261128004517) becomes direction-aware so a linked application keeps its normal path: with a live Qualification the
-- application may move forward (application_statuses.sort) or end (Withdrawn / Rejected), never back.
-- Existing rows are not changed by this migration.

-- The application to link: open (not withdrawn / rejected), same student and course, furthest along, newest.
create or replace function public.qualification_application_for(p_student uuid, p_course text) returns uuid
language sql stable security definer set search_path to 'public' as $$
  select a.id from public.enrollment_applications a
  join public.enrollment_application_courses c on c.application_id = a.id and c.course_id = p_course
  left join public.application_statuses s on s.value = a.status
  where a.student_id = p_student and a.status not in ('withdrawn', 'rejected')
  order by coalesce(s.sort, 0) desc, a.created_at desc
  limit 1;
$$;
revoke all on function public.qualification_application_for(uuid, text) from public, anon, authenticated;

-- An Enrolled application whose own Qualification has started becomes Active (the Qualification is the source).
create or replace function public.qualification_sync_application(p_application uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if exists (select 1 from public.enrollment_applications a where a.id = p_application and a.status = 'enrolled')
     and exists (select 1 from public.intake_enrolments e where e.application_id = p_application and e.status in ('active', 'deferred', 'suspended')) then
    perform set_config('qualification.sync', 'on', true);
    update public.enrollment_applications set status = 'active' where id = p_application;
    perform set_config('qualification.sync', '', true);
  end if;
end $$;
revoke all on function public.qualification_sync_application(uuid) from public, anon, authenticated;

-- Link a Qualification to its application and close that application's manual placement task.
create or replace function public.qualification_link_application(p_enrolment uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare e public.intake_enrolments; v_course text; v_app uuid; v_cur text;
begin
  select * into e from public.intake_enrolments where id = p_enrolment;
  if e.id is null then return null; end if;
  select ci.course_id into v_course from public.course_intakes ci where ci.id = e.intake_id;
  select a.status into v_cur from public.enrollment_applications a where a.id = e.application_id;
  -- rule-policy: technical qualification-link-closed A live Qualification never stays linked to a withdrawn or rejected application.
  if e.application_id is not null and (v_cur is null or v_cur not in ('withdrawn', 'rejected') or e.status not in ('tentative', 'active', 'deferred', 'suspended')) then
    v_app := e.application_id;
  else
    v_app := public.qualification_application_for(e.student_id, v_course);
    -- no open application for the course (only withdrawn / rejected ones): the direct application, as placement makes it
    if v_app is null then v_app := public.rto_direct_application(e.student_id, e.intake_id); end if;
    if v_app is distinct from e.application_id then
      update public.intake_enrolments set application_id = v_app where id = e.id;
    end if;
  end if;
  if v_app is null then return null; end if;
  update public.qualification_tasks t set status = 'done', closed_at = now(), closed_by = auth.uid(),
    closed_note = left(coalesce(nullif(btrim(p_note), ''), 'Placed by hand (Re-add to intake)'), 1000)
  where t.application_id = v_app and t.kind = 'place_manually' and t.status = 'open' and (t.event is null or t.event = v_course);
  perform public.qualification_sync_application(v_app);
  return v_app;
end $$;
revoke all on function public.qualification_link_application(uuid, text) from public, anon, authenticated;

-- 5 + 10. Re-add to intake links the Qualification.
create or replace function public.rto_staff_place(p_batch uuid, p_student uuid, p_type text, p_on date, p_reason text)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare i public.course_intakes; v_on date := coalesce(p_on, public.course_intake_today()); v_enrol uuid; v_app uuid;
begin
 if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then raise exception 'Only an Admin or an RTO Manager can place a student by hand.' using errcode = '42501'; end if;
 if public.rule_bool('lms.intake_manual_placement_reason', true) and coalesce(btrim(p_reason), '') = '' then raise exception 'Say why you are placing this student by hand.' using errcode = '22023'; end if;
 perform set_config('qualification.reason', left(coalesce(nullif(btrim(p_reason), ''), 'Placed by hand'), 200), true);
 v_enrol := public.rto_place_core(p_batch, p_student, p_type, v_on);
 perform set_config('qualification.reason', '', true);
 v_app := public.qualification_link_application(v_enrol, 'Placed by hand: ' || coalesce(nullif(btrim(p_reason), ''), 'Re-add to intake'));
 select * into i from public.course_intakes where id = p_batch;
 insert into public.rto_placement_overrides(student_id, course_id, intake_id, enrolment_id, action, reason, detail)
 values (p_student, i.course_id, i.id, v_enrol, 'place', coalesce(nullif(btrim(p_reason), ''), 'No reason given'), jsonb_build_object('on', v_on, 'type', p_type));
 select * into i from public.course_intakes where id = (select intake_id from public.intake_enrolments where id = v_enrol);
 return jsonb_build_object('enrolmentId', v_enrol, 'batchId', i.id, 'batch', public.intake_group_name(i.id), 'intakeId', i.id, 'joinedOn', v_on, 'applicationId', v_app);
end $function$;

-- Enrolled: create what is missing, then an already-started Qualification makes the application Active.
create or replace function public.qualification_on_application_enrolled() returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.status = 'enrolled' and old.status is distinct from 'enrolled' then
    perform public.qualification_create_from_application(new.id);
    perform public.qualification_sync_application(new.id);
  end if;
  return null;
end $$;

-- Gate 1, direction-aware: with a live Qualification the application moves forward or ends, never back.
create or replace function public.qualification_application_gate() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_live integer; v_started integer; v_from integer; v_to integer;
begin
  if new.status is not distinct from old.status then return new; end if;
  select count(*), count(*) filter (where e.status <> 'tentative') into v_live, v_started
    from public.intake_enrolments e where e.application_id = new.id and e.status in ('tentative', 'active', 'deferred', 'suspended');
  if v_live = 0 then return new; end if;
  -- rule-policy: technical qualification-gate-moves With a live Qualification the application only goes forward (application_statuses order) or ends (Withdrawn / Rejected).
  if new.status in ('withdrawn', 'rejected') then return new; end if;
  -- 2. An undone "Mark as enrolled": cancel the Tentative Qualification it created, quietly.
  if old.status = 'enrolled' and coalesce(current_setting('portal.status_note', true), '') like 'Undone:%' and v_started = 0 then
    perform set_config('qualification.system', 'on', true);
    perform set_config('qualification.quiet', 'on', true);
    perform set_config('qualification.reason', 'Enrolment undone', true);
    update public.intake_enrolments set status = 'withdrawn', withdrawn_on = coalesce(withdrawn_on, public.course_intake_today())
     where application_id = new.id and status = 'tentative';
    perform set_config('qualification.reason', '', true);
    perform set_config('qualification.quiet', '', true);
    perform set_config('qualification.system', '', true);
    return new;
  end if;
  select coalesce((select s.sort from public.application_statuses s where s.value = old.status), 0),
         coalesce((select s.sort from public.application_statuses s where s.value = new.status), 0) into v_from, v_to;
  if v_to > v_from and new.status not in ('withdrawn', 'rejected') then return new; end if;
  raise exception 'This application has a live Qualification (%): cancel the Qualification first, or withdraw the application.',
    (select string_agg(distinct public.qualification_label(e.status), ', ') from public.intake_enrolments e
      where e.application_id = new.id and e.status in ('tentative', 'active', 'deferred', 'suspended'))
    using errcode = '23514';
end $$;
