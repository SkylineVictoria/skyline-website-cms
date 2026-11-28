-- AXCELERATE-QUALIFICATIONS (owner 2026-11-28: "first import everything which is needed to import that record so no problems in
-- importing any record"; decision: an imported course is an Enrolled application + its Qualification in the matching class).
-- One way only, aXcelerate -> Skyline (axcelerate-import reads /contact/enrolments/:id, /course/detail, /course/instance/detail).
--   * A class needs a classroom or class times before a student can be placed (intake_has_group). An imported aXcelerate class has
--     neither: axcelerate_class_room gives it a placeholder classroom "aXcelerate import (set room)" at its campus (staff set the real
--     room later); a class that already has a room or class times is left alone.
--   * axcelerate_import_qualification: per aXcelerate course enrolment (type p): an application in the student's business, created the
--     way portal_create_student_application does (reference, draft, the student's answers), naming the course and the class, then moved to
--     Enrolled through qualification_move_application (the path Skyline uses itself); the existing trigger creates the Qualification in the
--     class (rto_place_core) and starts it when the course has started. The AVETMISS checks of submit and enrolment run unchanged.
--     Study reason: from the enrolment; when aXcelerate has none, Not specified (@@) with a warning. Withdrawn / cancelled in aXcelerate:
--     the Qualification is withdrawn on aXcelerate's finish date. Completed / deferred / suspended: kept In Progress with a warning
--     (Completed needs every unit result; deferred / suspended need a resume date). If the student cannot be placed, nothing is kept and
--     the reason is the import error.
--   * axcelerate_record_badge also returns the aXcelerate ID (the student page's "Refresh from aXcelerate").
begin;

/** A placeholder classroom for an imported class that has no room and no class times (so students can be placed in it). */
create or replace function public.axcelerate_class_room(p_intake uuid, p_actor uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare i public.course_intakes; v_room uuid; v_loc uuid;
begin
  select * into i from public.course_intakes where id = p_intake;
  if i.id is null then raise exception 'Class not found' using errcode = 'P0002'; end if;
  if public.intake_has_group(i.id) then return i.classroom_id; end if;
  -- A room belongs to a location (AVETMISS: every unit delivered in it is reported with that location), so the class needs its campus.
  select l.id into v_loc from public.locations l where l.name = i.campus order by l.created_at limit 1;
  if v_loc is null then
    raise exception 'The class % has no campus Skyline knows (aXcelerate gave %): set the class''s campus and room on the Intakes page, then import again.',
      coalesce(i.name, i.label, i.id::text), coalesce(nullif(i.campus, ''), 'none') using errcode = '22023';
  end if;
  select c.id into v_room from public.classrooms c where c.name = 'aXcelerate import (set room)' and c.location_id = v_loc order by c.created_at limit 1;
  if v_room is null then
    insert into public.classrooms(name, campus, location_id, is_active) values ('aXcelerate import (set room)', i.campus, v_loc, true) returning id into v_room;
  end if;
  perform public.axcelerate_importing(p_actor);
  update public.course_intakes set classroom_id = v_room where id = i.id;
  return v_room;
end $$;

/**
 * One aXcelerate course enrolment -> an Enrolled application and its Qualification in the class p_intake.
 * Returns {action: created | linked | unchanged | updated | skipped, id (the Qualification), application, warnings}.
 */
create or replace function public.axcelerate_import_qualification(p_connection uuid, p_run uuid, p_actor uuid, p_student uuid, p_rec jsonb, p_intake uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb := coalesce(p_rec, '{}'::jsonb);
  v_ax text := coalesce(public.axcelerate_text(r, 'ENROLID', 'ENROLMENTID'), public.axcelerate_text(r, 'INSTANCEID') || ':' || p_student::text);
  v_status text := lower(coalesce(public.axcelerate_text(r, 'STATUS', 'ENROLMENTSTATUS'), ''));
  v_start date := public.axcelerate_date(public.axcelerate_text(r, 'STARTDATE', 'ENROLMENTDATE'));
  v_finish date := public.axcelerate_date(public.axcelerate_text(r, 'FINISHDATE', 'ENDDATE'));
  v_name text := left(coalesce(public.axcelerate_text(r, 'NAME', 'CODE'), 'aXcelerate course'), 200);
  s public.enrollment_students; i public.course_intakes; c record; l public.axcelerate_links;
  v_app uuid; v_ref text; v_enrol uuid; v_reason text; v_rv text; v_on date; v_warn jsonb := '[]'::jsonb; v_task text; v_action text := 'created';
begin
  if v_ax is null then raise exception 'The enrolment has no aXcelerate ID' using errcode = '22023'; end if;
  perform public.axcelerate_importing(p_actor);
  if public.axcelerate_is_skipped(p_connection, 'qualification', v_ax) then return public.axcelerate_outcome('skipped', null, jsonb_build_object('name', v_name)); end if;
  select * into s from public.enrollment_students where id = p_student;
  select * into i from public.course_intakes where id = p_intake;
  if s.id is null then raise exception 'Student not found' using errcode = 'P0002'; end if;
  if i.id is null then raise exception 'The class of % was not imported', v_name using errcode = 'P0002'; end if;
  select id, name, code into c from public.cms_courses where id = i.course_id;

  l := public.axcelerate_link_find(p_connection, 'qualification', v_ax);
  if l.id is not null and exists (select 1 from public.intake_enrolments where id = l.target_id::uuid) then
    v_enrol := l.target_id::uuid; v_action := 'unchanged';
  else
    select e.id into v_enrol from public.intake_enrolments e where e.intake_id = i.id and e.student_id = s.id;
    if v_enrol is not null then v_action := 'linked'; end if;
  end if;

  if v_enrol is null then
    perform public.axcelerate_class_room(i.id, p_actor);
    -- Study reason (NAT00120): from the enrolment; Not specified (@@) when aXcelerate has none.
    v_rv := public.axcelerate_text(r, 'STUDYREASONID', 'STUDYREASON', 'STUDY_REASON_ID');
    v_reason := case when v_rv is not null then public.axcelerate_avetmiss_answer('study_reason', v_rv) end;
    if v_reason is null then
      if v_rv is not null then v_warn := v_warn || to_jsonb(format('Study reason "%s" is not an AVETMISS code: stored as Not specified (@@).', v_rv));
      else v_warn := v_warn || to_jsonb('aXcelerate has no study reason for this course: stored as Not specified (@@). Ask the student and update it.'::text); end if;
      v_reason := public.axcelerate_avetmiss_answer('study_reason', '@@');
    end if;
    -- The application, as portal_create_student_application makes it (reference, draft, the student's answers), in the student's business.
    v_ref := public.portal_next_application_reference();
    perform set_config('skyline.student_id', s.id::text, true);
    insert into public.enrollment_applications(reference, agency_id, tenant_id, status, student_name, student_email, intake, source)
    values (v_ref, s.agency_id, s.tenant_id, 'draft', s.full_name, coalesce(s.email, ''), left(coalesce(i.name, i.label), 120), 'axcelerate')
    returning id into v_app;
    perform set_config('skyline.student_id', '', true);
    perform set_config('portal.draft_command', v_app::text, true);
    update public.enrollment_applications set data = jsonb_build_object('values', coalesce(s.details, '{}'::jsonb)
        || jsonb_build_object('intake_id', i.id, 'study_reason', v_reason, 'intake_join_date', to_char(greatest(coalesce(v_start, i.start_date), i.start_date), 'YYYY-MM-DD')))
     where id = v_app;
    perform set_config('portal.draft_command', '', true);
    -- The course; the class is in the answers (intake_id), which the Qualification step reads too. Not on the course row: that row only
    -- takes a class still offered for applications, and an imported class may be full or finished.
    insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, intake_id, tenant_id)
    values (v_app, i.course_id, c.code, c.name, null, s.tenant_id);
    -- Submitted (the signed path: the student signed in aXcelerate; owner: the offer / signing / CoE steps happened in aXcelerate), with
    -- the submit AVETMISS check unchanged, then Enrolled the way Skyline moves applications itself; the Qualification trigger places the
    -- student in the class.
    perform set_config('portal.status_command', v_app::text, true);
    perform set_config('portal.signed_submit', v_app::text, true);
    perform set_config('portal.status_note', 'Imported from aXcelerate (enrolment ' || v_ax || ')', true);
    update public.enrollment_applications set status = 'submitted', submitted_at = now(), submitted_by = p_actor where id = v_app;
    perform set_config('portal.status_command', '', true);
    perform set_config('portal.signed_submit', '', true);
    perform set_config('portal.status_note', '', true);
    v_on := greatest(coalesce(v_start, i.start_date), i.start_date);
    if i.end_date is not null and v_on > i.end_date then v_on := i.end_date; end if;
    perform set_config('qualification.enrolment_date', to_char(v_on, 'YYYY-MM-DD'), true);
    perform public.qualification_move_application(v_app, 'enrolled', 'Imported from aXcelerate (enrolment ' || v_ax || ')');
    perform set_config('qualification.enrolment_date', '', true);
    select e.id into v_enrol from public.intake_enrolments e where e.application_id = v_app order by e.status_changed_at desc nulls last limit 1;
    if v_enrol is null then
      select t.detail into v_task from public.qualification_tasks t where t.application_id = v_app order by t.created_at desc limit 1;
      raise exception 'Not imported: % could not be placed in the class: %', v_name, coalesce(v_task, 'see Tasks › Place student manually') using errcode = '22023';
    end if;
  end if;

  -- aXcelerate's status.
  if v_status ~ '(withdraw|cancel|discontinu)' then
    if exists (select 1 from public.intake_enrolments where id = v_enrol and status in ('tentative', 'active', 'deferred', 'suspended')) then
      perform set_config('qualification.system', 'on', true);
      perform set_config('qualification.reason', 'Withdrawn in aXcelerate', true);
      perform set_config('qualification.effective_on', to_char(coalesce(v_finish, public.course_intake_today()), 'YYYY-MM-DD'), true);
      update public.intake_enrolments set status = 'withdrawn', withdrawn_on = coalesce(withdrawn_on, v_finish, public.course_intake_today()) where id = v_enrol;
      perform set_config('qualification.system', '', true);
      perform set_config('qualification.reason', '', true);
      perform set_config('qualification.effective_on', '', true);
      if v_action = 'unchanged' then v_action := 'updated'; end if;
    end if;
  elsif v_status like '%complete%' then
    v_warn := v_warn || to_jsonb('Completed in aXcelerate: the Qualification stays In Progress until every unit result is imported (Skyline completes it only then).'::text);
  elsif v_status ~ '(defer|suspend)' then
    v_warn := v_warn || to_jsonb(format('%s in aXcelerate: kept In Progress (Skyline needs the resume date; set it on the Qualification).', initcap(v_status)));
  end if;

  perform public.axcelerate_link_save(p_connection, p_run, 'qualification', v_ax, 'public.intake_enrolments', v_enrol::text, r || jsonb_build_object('NAME', v_name));
  select application_id into v_app from public.intake_enrolments where id = v_enrol;
  return public.axcelerate_outcome(v_action, v_enrol::text, jsonb_build_object('name', v_name, 'application', v_app,
    'status', (select status from public.intake_enrolments where id = v_enrol), 'warnings', v_warn));
end $$;

/** The import badge on a record, and its aXcelerate ID (the student page's "Refresh from aXcelerate"). Replaces the 20261128041517 version. */
create or replace function public.axcelerate_record_badge(p_table text, p_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public.cms_is_admin() then (select jsonb_build_object('importedAt', l.first_imported_at, 'lastImportedAt', l.last_imported_at,
           'editedInSkylineAt', l.edited_in_skyline_at, 'axcelerateId', l.axcelerate_id, 'entity', l.entity)
           from public.axcelerate_links l where l.target_table = p_table and l.target_id = p_id order by l.first_imported_at limit 1) end;
$$;

revoke all on function public.axcelerate_class_room(uuid, uuid) from public, anon, authenticated;
revoke all on function public.axcelerate_import_qualification(uuid, uuid, uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.axcelerate_class_room(uuid, uuid), public.axcelerate_import_qualification(uuid, uuid, uuid, uuid, jsonb, uuid) to service_role;

commit;
