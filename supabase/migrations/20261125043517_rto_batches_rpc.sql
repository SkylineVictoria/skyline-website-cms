-- LMS-BATCHES screens (2026-11-25): one RPC behind the intake sheet's Batches tab, public.rto_batches(action, data).
-- Read (Admins / RTO Managers): list, sessions, members, log. Write: save / archive / times_save (RTO Managers), assign (Admins and
-- RTO Managers, like placing a student). Batches and memberships are archived, never deleted; a batch's class times are replaced and
-- the intake's classes planned again from every batch's class times.
-- Down: drop function public.rto_batches(text, jsonb).
begin;

create function public.batch_for_allocation(p_enrolment uuid, p_intake uuid, p_unit text) returns uuid
language sql stable security definer set search_path to 'public' as $f$
  select bs.batch_id from public.batch_students bs join public.intake_batches bb on bb.id = bs.batch_id
   where bs.enrolment_id = p_enrolment and bs.archived_at is null and bb.intake_id = p_intake and (bs.unit_id = p_unit or bs.unit_id is null)
   order by (bs.unit_id is null), bs.assigned_at desc limit 1;
$f$;

create function public.rto_batches(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
#variable_conflict use_column
declare
  d jsonb := coalesce(p_data, '{}'::jsonb);
  v_intake uuid; v_batch uuid; v_enrol uuid; b public.intake_batches; v_out jsonb; v_n int; t jsonb; x jsonb; v_reason text;
  is_rto boolean := coalesce(public.cms_is_rto_manager(), false);
  is_admin boolean := coalesce(public.cms_is_admin(), false);
begin
  if not (is_rto or is_admin) then raise exception 'Admins and RTO Managers only' using errcode = '42501'; end if;

  if p_action = 'list' then
    v_intake := (d->>'intakeId')::uuid;
    return coalesce((select jsonb_agg(jsonb_build_object(
      'id', b.id, 'intakeId', b.intake_id, 'code', b.code, 'name', b.name, 'roomId', b.room_id, 'room', r.name, 'capacity', b.capacity,
      'defaultTrainerId', b.default_trainer_id, 'trainer', (select trim(concat_ws(' ', sp.first_name, sp.last_name)) from hr.staff_profiles sp where sp.id = b.default_trainer_id),
      'sort', b.sort, 'archivedAt', b.archived_at,
      'students', (select count(distinct bs.enrolment_id) from public.batch_students bs where bs.batch_id = b.id and bs.archived_at is null),
      'upcoming', (select count(*) from public.class_sessions s where s.batch_id = b.id and s.status = 'scheduled' and s.session_date >= public.course_intake_today()),
      'weeklyHours', (select round(coalesce(sum(extract(epoch from (t.end_time - t.start_time))) / 3600.0, 0)::numeric, 1) from public.intake_class_times t where t.batch_id = b.id),
      'classTimes', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'weekday', t.weekday, 'start', to_char(t.start_time, 'HH24:MI'), 'end', to_char(t.end_time, 'HH24:MI'),
          'sessionType', t.session_type, 'roomId', t.room_id, 'trainerId', t.trainer_id) order by t.weekday, t.start_time) from public.intake_class_times t where t.batch_id = b.id), '[]'::jsonb)
    ) order by b.archived_at nulls first, b.sort, b.code)
    from public.intake_batches b left join public.classrooms r on r.id = b.room_id
    where b.intake_id = v_intake and (coalesce((d->>'includeArchived')::boolean, false) or b.archived_at is null)), '[]'::jsonb);

  elsif p_action = 'sessions' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'batchId', s.batch_id, 'batch', b.code, 'date', s.session_date,
        'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'), 'sessionType', s.session_type, 'status', s.status,
        'unitCode', u.code, 'unitName', u.name, 'room', r.name, 'trainer', (select trim(concat_ws(' ', sp.first_name, sp.last_name)) from hr.staff_profiles sp where sp.id = s.trainer_id),
        'delivery', s.delivery) order by s.session_date, s.start_time, b.code)
      from public.class_sessions s join public.intake_batches b on b.id = s.batch_id
      left join public.cms_course_units u on u.id = s.unit_id left join public.classrooms r on r.id = s.room_id
      where (d->>'batchId' is null or s.batch_id = (d->>'batchId')::uuid)
        and (d->>'intakeId' is null or s.intake_id = (d->>'intakeId')::uuid)
        and s.session_date between coalesce((d->>'from')::date, public.course_intake_today()) and coalesce((d->>'to')::date, public.course_intake_today() + 13)), '[]'::jsonb);

  elsif p_action = 'members' then
    v_intake := (d->>'intakeId')::uuid;
    return coalesce((select jsonb_agg(jsonb_build_object('enrolmentId', e.id, 'studentId', e.student_id,
        'name', st.full_name, 'status', e.status, 'courseStart', e.course_start_date, 'courseEnd', e.course_end_date,
        'batches', coalesce((select jsonb_agg(jsonb_build_object('batchId', bs.batch_id, 'unitId', bs.unit_id, 'unitCode', u.code) order by bs.assigned_at)
            from public.batch_students bs left join public.cms_course_units u on u.id = bs.unit_id
           where bs.enrolment_id = e.id and bs.archived_at is null), '[]'::jsonb)) order by st.full_name)
      from public.intake_enrolments e join public.enrollment_students st on st.id = e.student_id
      where e.intake_id = v_intake and e.status in ('active', 'deferred')), '[]'::jsonb);

  elsif p_action = 'log' then
    return coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'action', l.action, 'unitId', l.unit_id, 'from', fb.code, 'to', tb.code, 'reason', l.reason) order by l.at desc)
      from public.batch_assignment_log l left join public.intake_batches fb on fb.id = l.from_batch_id left join public.intake_batches tb on tb.id = l.to_batch_id
      where l.enrolment_id = (d->>'enrolmentId')::uuid), '[]'::jsonb);

  elsif p_action = 'save' then
    if not is_rto then raise exception 'Only an RTO Manager can change batches.' using errcode = '42501'; end if;
    v_batch := nullif(d->>'id', '')::uuid;
    if v_batch is null then
      v_intake := (d->>'intakeId')::uuid;
      if not exists (select 1 from public.course_intakes where id = v_intake and archived_at is null) then raise exception 'Intake not found' using errcode = 'P0002'; end if;
      select count(*) into v_n from public.intake_batches where intake_id = v_intake;
      insert into public.intake_batches (intake_id, code, name, room_id, capacity, default_trainer_id, sort, updated_by)
      values (v_intake, coalesce(nullif(trim(d->>'code'), ''), 'B' || (v_n + 1)), nullif(trim(d->>'name'), ''), nullif(d->>'roomId', '')::uuid,
              nullif(d->>'capacity', '')::int, nullif(d->>'defaultTrainerId', '')::uuid, v_n + 1, auth.uid())
      returning id into v_batch;
    else
      update public.intake_batches set code = coalesce(nullif(trim(d->>'code'), ''), code), name = nullif(trim(d->>'name'), ''),
             room_id = nullif(d->>'roomId', '')::uuid, capacity = nullif(d->>'capacity', '')::int, default_trainer_id = nullif(d->>'defaultTrainerId', '')::uuid,
             updated_at = now(), updated_by = auth.uid()
       where id = v_batch and archived_at is null;
      if not found then raise exception 'Batch not found or archived' using errcode = 'P0002'; end if;
    end if;
    return jsonb_build_object('id', v_batch);

  elsif p_action = 'archive' then
    if not is_rto then raise exception 'Only an RTO Manager can archive batches.' using errcode = '42501'; end if;
    select * into b from public.intake_batches where id = (d->>'id')::uuid for update;
    if b.id is null or b.archived_at is not null then raise exception 'Batch not found or already archived' using errcode = 'P0002'; end if;
    if not exists (select 1 from public.intake_batches o where o.intake_id = b.intake_id and o.id <> b.id and o.archived_at is null) then
      raise exception 'This is the intake''s only batch. Add another batch first, or archive the intake.' using errcode = '23514';
    end if;
    v_reason := coalesce(nullif(trim(d->>'reason'), ''), 'Batch archived');
    -- students in it move to the intake's first other batch (logged)
    update public.batch_students bs set archived_at = now(), archive_reason = v_reason where bs.batch_id = b.id and bs.archived_at is null;
    update public.intake_batches set archived_at = now(), updated_at = now(), updated_by = auth.uid() where id = b.id;
    insert into public.batch_students (enrolment_id, batch_id, assigned_by)
    select distinct e.id, public.intake_first_batch(b.intake_id), auth.uid() from public.intake_enrolments e
     where e.intake_id = b.intake_id and e.status = 'active'
       and not exists (select 1 from public.batch_students bs where bs.enrolment_id = e.id and bs.archived_at is null);
    -- its weekly times stop; future classes without a register go
    delete from public.class_sessions s where s.batch_id = b.id and s.session_date >= public.course_intake_today()
      and not exists (select 1 from public.lms_attendance_register g where g.batch_id = b.id and g.class_date = s.session_date);
    delete from public.intake_class_times where batch_id = b.id;
    return jsonb_build_object('archived', true);

  elsif p_action = 'times_save' then
    if not is_rto then raise exception 'Only an RTO Manager can change class times.' using errcode = '42501'; end if;
    select * into b from public.intake_batches where id = (d->>'batchId')::uuid and archived_at is null;
    if b.id is null then raise exception 'Batch not found or archived' using errcode = 'P0002'; end if;
    delete from public.intake_class_times where batch_id = b.id;
    v_n := 0;
    for t in select * from jsonb_array_elements(coalesce(d->'times', '[]'::jsonb)) loop
      v_n := v_n + 1;
      insert into public.intake_class_times (batch_id, weekday, slot, start_time, end_time, session_type, room_id, trainer_id, sort)
      values (b.id, (t->>'weekday')::smallint,
              case when (t->>'start')::time < '12:00' then 'morning' when (t->>'start')::time < '17:00' then 'afternoon' else 'evening' end,
              (t->>'start')::time, (t->>'end')::time, coalesce(nullif(t->>'sessionType', ''), 'theory'),
              coalesce(nullif(t->>'roomId', '')::uuid, b.room_id), coalesce(nullif(t->>'trainerId', '')::uuid, b.default_trainer_id), v_n);
    end loop;
    v_out := '{}'::jsonb;
    if coalesce((d->>'regenerate')::boolean, true) then v_out := public.rto_class_sessions_generate(b.intake_id); end if;
    return jsonb_build_object('times', v_n, 'classes', v_out);

  elsif p_action = 'assign' then
    v_enrol := (d->>'enrolmentId')::uuid;
    if not exists (select 1 from public.intake_enrolments where id = v_enrol) then raise exception 'Enrolment not found' using errcode = 'P0002'; end if;
    v_reason := nullif(trim(d->>'reason'), '');
    -- wanted = [{batchId, unitId|null}]; memberships not wanted are archived, new ones added
    update public.batch_students bs set archived_at = now(), archive_reason = coalesce(v_reason, 'Changed by staff')
     where bs.enrolment_id = v_enrol and bs.archived_at is null
       and not exists (select 1 from jsonb_array_elements(coalesce(d->'batches', '[]'::jsonb)) w
                        where (w->>'batchId')::uuid = bs.batch_id and nullif(w->>'unitId', '') is not distinct from bs.unit_id);
    for x in select * from jsonb_array_elements(coalesce(d->'batches', '[]'::jsonb)) loop
      if not exists (select 1 from public.batch_students bs where bs.enrolment_id = v_enrol and bs.archived_at is null
                      and bs.batch_id = (x->>'batchId')::uuid and bs.unit_id is not distinct from nullif(x->>'unitId', '')) then
        insert into public.batch_students (enrolment_id, batch_id, unit_id, assigned_by) values (v_enrol, (x->>'batchId')::uuid, nullif(x->>'unitId', ''), auth.uid());
      end if;
    end loop;
    if not exists (select 1 from public.batch_students where enrolment_id = v_enrol and archived_at is null and unit_id is null) then
      raise exception 'A student needs at least one batch for the whole course.' using errcode = '23514';
    end if;
    -- unit allocations follow the new choice (logged by lms_unit_students_batch)
    perform set_config('lms.batch_reason', coalesce(v_reason, 'Batch changed by staff'), true);
    update public.lms_unit_students a set batch_id = public.batch_for_allocation(v_enrol, a.intake_id, a.unit_id)
     where a.intake_id = (select e.intake_id from public.intake_enrolments e where e.id = v_enrol)
       and a.student_id = (select e.student_id from public.intake_enrolments e where e.id = v_enrol)
       and public.batch_for_allocation(v_enrol, a.intake_id, a.unit_id) is not null
       and a.batch_id is distinct from public.batch_for_allocation(v_enrol, a.intake_id, a.unit_id);
    perform set_config('lms.batch_reason', '', true);
    return jsonb_build_object('ok', true);
  end if;
  raise exception 'Unknown action %', p_action using errcode = '22023';
end $$;
revoke all on function public.rto_batches(text, jsonb) from public, anon;
grant execute on function public.rto_batches(text, jsonb) to authenticated;
revoke all on function public.batch_for_allocation(uuid, uuid, text) from public, anon;
grant execute on function public.batch_for_allocation(uuid, uuid, text) to authenticated;

commit;
