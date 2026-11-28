-- AXCELERATE-NEXT-CYCLE (owner 2026-11-28: "check the timeline of SLIT vs aXcelerate for the master calendar and units"; "make it match with
-- master calendar"; "add last year cycle for each new import and map qualification and dates like Himani, with trainers, class and breaks").
-- Cycle 1 matched aXcelerate exactly, but the other cycles drifted (units laid one after another, break days left out, aXcelerate's own next
-- dates ignored), batch C2 kept old dates, and a class whose units run at the same time (CPC30220 / CPC50220) could not be imported at all.
--   * axcelerate_cycle_layout: every other cycle is a copy of aXcelerate's class: each unit keeps its offset from the class start and its own
--     length (units that run together stay together, breaks included); the next cycle starts where aXcelerate already has dates for it
--     (a student's unit enrolment after the class), and those units start on aXcelerate's dates.
--   * axcelerate_course_calendars: the calendars always start in the past, with the cycle of the last year (cycles before aXcelerate's class
--     until one starts at least 12 months back), 10 cycles in all, CoE and VoE.
--   * axcelerate_cycle_batches_sync: each calendar-cycle batch (C<n>) takes its cycle's unit dates; its students' unfinished units follow
--     (a started unit keeps its start; a unit with a result is never moved) through one narrow exception in the permanent-allocation guard
--     (lms_allocation_private.preserve_allocation, setting skyline.cycle_sync_batch); the batch's classes are laid out again.
--   * course_master_group_hours: an aXcelerate import is not refused for weekly hours below the master's (aXcelerate's dates are the truth;
--     units that run together made it ask for 96-100 hours a week).
--   * axcelerate_student_values: a year of highest school level that aXcelerate does not have is stored as Not stated (@@@@), and prior
--     education items without their recognition letter as prior education Not stated (@), each with a warning to ask the student, so the
--     Qualification is no longer refused for them (AVETMISS "not stated" codes, not invented values).
-- Existing data: each imported course's calendars are built again.
begin;

create or replace function public.axcelerate_cycle_layout(p_connection uuid, p_course text, p_cycle integer, p_known boolean, p_rows jsonb, p_start date default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_first date := (select min((x->>'start')::date) from jsonb_array_elements(p_rows) x);
  v_last date := (select max((x->>'end')::date) from jsonb_array_elements(p_rows) x);
  v_start date := coalesce(p_start, (select max(end_date) from axcelerate_calendar_rows where cycle = p_cycle - 1) + 1);
  v_known jsonb := '{}'::jsonb; r record; v_s date; v_anchor record;
begin
  if v_start is null or v_first is null then return; end if;
  if p_known then
    -- aXcelerate's own dates for units after its class (each student's unit enrolment), the earliest per unit within the next year.
    select coalesce(jsonb_object_agg(k.unit_id, k.s), '{}'::jsonb) into v_known from (
      select split_part(l.axcelerate_id, ':', 2) as unit_id, min(public.axcelerate_date(l.raw->>'STARTDATE')) as s
        from public.axcelerate_links l
        join public.cms_course_units cu on cu.id = split_part(l.axcelerate_id, ':', 2) and cu.course_id = p_course
       where l.connection_id = p_connection and l.entity = 'unit_result'
         and public.axcelerate_date(l.raw->>'STARTDATE') > v_last and public.axcelerate_date(l.raw->>'STARTDATE') <= v_last + 400
       group by 1) k;
    -- The cycle starts so that the earliest unit aXcelerate has a date for keeps its place in the class.
    select x->>'unitId' as unit_id, (x->>'start')::date - v_first as off into v_anchor
  -- rule-policy: technical axcelerate-next-cycle 2026-11-28 owner (AXCELERATE-NEXT-CYCLE): calendar layout and import mapping from aXcelerate; fixed, no configurable value.
      from jsonb_array_elements(p_rows) x where v_known ? (x->>'unitId') order by (x->>'start')::date, x->>'unitId' limit 1;
    if v_anchor.unit_id is not null then v_start := (v_known->>v_anchor.unit_id)::date - v_anchor.off; end if;
  end if;
  -- Each unit keeps its offset from the class start and its own length (units that run together stay together).
  for r in select x->>'unitId' as unit_id, row_number() over (order by (x->>'start')::date, x->>'unitId') as sort,
                  (x->>'start')::date - v_first as off, (x->>'end')::date - (x->>'start')::date as len
             from jsonb_array_elements(p_rows) x order by 2 loop
    v_s := coalesce((v_known->>r.unit_id)::date, v_start + r.off);
    insert into axcelerate_calendar_rows values (p_cycle, r.unit_id, greatest(round((r.len + 1) / 7.0, 1), 0.5), r.sort, v_s, v_s + greatest(r.len, 0));
  end loop;
end $$;
drop function if exists public.axcelerate_cycle_layout(uuid, text, integer, boolean, jsonb);
revoke all on function public.axcelerate_cycle_layout(uuid, text, integer, boolean, jsonb, date) from public, anon, authenticated;

-- The permanent-allocation guard: one narrow exception for the aXcelerate cycle sync (axcelerate_cycle_batches_sync): an unfinished
-- allocation in the batch being synced may take the batch's unit dates; nothing else about it changes.
do $$
declare d text := pg_get_functiondef('lms_allocation_private.preserve_allocation()'::regprocedure); a text := '-- STUDENT-DELETE-EVERYTHING';
begin
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'preserve_allocation: anchor not found once'; end if;
  d := replace(d, a, '-- AXCELERATE-NEXT-CYCLE: the cycle sync moves an unfinished allocation of the batch it syncs to the batch''s unit dates.
 if tg_op = ''UPDATE'' and tg_table_name = ''lms_unit_students'' then
  if coalesce(current_setting(''skyline.cycle_sync_batch'', true), '''') <> '''' and new.batch_id::text = current_setting(''skyline.cycle_sync_batch'', true)
     and new.intake_id is not distinct from old.intake_id and new.unit_id is not distinct from old.unit_id
     and new.student_id is not distinct from old.student_id and new.course_id is not distinct from old.course_id
     and new.allocated_at is not distinct from old.allocated_at and new.carried_from_intake_id is not distinct from old.carried_from_intake_id
     and old.actual_end_date is null and old.assigned_end_date >= public.course_intake_today() then
   return new;
  end if;
 end if;
 ' || a);
  execute d;
end $$;

create or replace function public.axcelerate_cycle_batches_sync(p_connection uuid, p_course text)
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0; v_cycle integer; v_load text; v_moved integer; v_warn text; v_today date := public.course_intake_today();
begin
  for r in select b.id, x.axcelerate_id from public.axcelerate_links x join public.intake_batches b on b.id::text = x.target_id
            where x.connection_id = p_connection and x.entity = 'batch' and x.axcelerate_id like 'cycle:' || p_course || ':%' and b.archived_at is null loop
    v_cycle := nullif(substring(r.axcelerate_id from '([0-9]+)$'), '')::integer;
    v_load := split_part(r.axcelerate_id, ':', 3);
    if v_cycle is null then continue; end if;
    update public.intake_batch_units xb set start_date = m.start_date, end_date = m.end_date
      from (select unit_id, start_date, end_date from public.course_voe_units where course_id = p_course and cycle = v_cycle and v_load = 'voe'
            union all
            select unit_id, start_date, end_date from public.course_coe_units where course_id = p_course and cycle = v_cycle and v_load <> 'voe') m
     where xb.batch_id = r.id and xb.unit_id = m.unit_id and m.start_date is not null
       and (xb.start_date, xb.end_date) is distinct from (m.start_date, m.end_date);
    get diagnostics v_moved = row_count;
    update public.intake_batches b set start_date = z.s, end_date = z.e, updated_at = now()
      from (select min(start_date) as s, max(end_date) as e from public.intake_batch_units where batch_id = r.id) z
     where b.id = r.id and z.s is not null and (b.start_date, b.end_date) is distinct from (z.s, z.e);
    -- The batch's students' unfinished units follow (a started unit keeps its start; a unit with a result stays).
    perform set_config('skyline.cycle_sync_batch', r.id::text, true);
    update public.lms_unit_students u
       set assigned_start_date = case when u.assigned_start_date <= v_today then u.assigned_start_date else xb.start_date end,
           assigned_end_date = xb.end_date
      from public.intake_batch_units xb
     where u.batch_id = r.id and xb.batch_id = r.id and xb.unit_id = u.unit_id
       and coalesce(u.outcome_code, '') not in ('20', '30', '40', '41', '51', '52', '60', '61')
       and u.assigned_end_date >= v_today and u.actual_end_date is null
       and (u.assigned_start_date, u.assigned_end_date) is distinct from
           (case when u.assigned_start_date <= v_today then u.assigned_start_date else xb.start_date end, xb.end_date);
    perform set_config('skyline.cycle_sync_batch', '', true);
    -- Its classes again on the new dates.
    if v_moved > 0 then v_warn := public.axcelerate_batch_timetable(r.id, null, null); end if;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.axcelerate_cycle_batches_sync(uuid, text) from public, anon, authenticated;

do $$
declare d text := pg_get_functiondef('public.axcelerate_course_calendars(uuid, uuid, uuid, text, text, jsonb)'::regprocedure); a text; b text;
begin
  a := '    else
      v_start := case when c <= k then v_first - (k - c + 1) * v_span else (select max(end_date) from axcelerate_calendar_rows where cycle = c - 1) + 1 end;
      insert into axcelerate_calendar_rows select c, m.unit_id, m.weeks, m.sort, m.start_date, m.end_date from public.course_master_layout(p_course, v_start, v_pattern) m;
    end if;';
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'axcelerate_course_calendars: layout anchor not found once'; end if;
  -- rule-policy: technical axcelerate-next-cycle 2026-11-28 owner (AXCELERATE-NEXT-CYCLE): later cycles repeat aXcelerate's unit lengths and its known dates; fixed, no configurable value.
  d := replace(d, a, '    elsif c <= k then
      -- Cycles before aXcelerate''s: copies of its class, a whole class length earlier each (AXCELERATE-NEXT-CYCLE).
      perform public.axcelerate_cycle_layout(p_connection, p_course, c, false, v_rows, v_first - (k - c + 1) * v_span);
    else
      -- Later cycles: aXcelerate''s unit order and calendar lengths, the next cycle on aXcelerate''s own dates where it has them (AXCELERATE-NEXT-CYCLE).
      perform public.axcelerate_cycle_layout(p_connection, p_course, c, c = k + 2, v_rows);
    end if;');
  -- The last year's cycle: cycles before aXcelerate's class until one starts at least 12 months back (was: only cycles that started within them).
  a := 'while (v_c1 - v_span) >= (v_today - interval ''12 months'')::date and k < 9 loop';
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'axcelerate_course_calendars: cycles-back anchor not found once'; end if;
  d := replace(d, a, 'while v_c1 > (v_today - interval ''12 months'')::date and k < 9 loop');
  b := '  -- Every open class of the course follows its calendar''s current cycle; its planned classes from today on are laid out again.';
  if (length(d) - length(replace(d, b, ''))) / length(b) <> 1 then raise exception 'axcelerate_course_calendars: batches anchor not found once'; end if;
  d := replace(d, b, '  -- Calendar-cycle batches (C<n>) take their cycle''s unit dates (AXCELERATE-NEXT-CYCLE).
  perform public.axcelerate_cycle_batches_sync(p_connection, p_course);
' || b);
  execute d;
end $$;

-- An aXcelerate import is not refused for weekly hours (its dates are the truth); other changes still are.
do $$
  -- rule-policy: technical axcelerate-next-cycle 2026-11-28 owner (AXCELERATE-NEXT-CYCLE): calendar layout and import mapping from aXcelerate; fixed, no configurable value.
declare d text := pg_get_functiondef('public.course_master_group_hours()'::regprocedure); a text := ' v_problem := public.course_master_group_problem(';
begin
  -- rule-policy: technical axcelerate-next-cycle 2026-11-28 owner (AXCELERATE-NEXT-CYCLE): calendar layout and import mapping from aXcelerate; fixed, no configurable value.
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'course_master_group_hours: anchor not found once'; end if;
  d := replace(d, a, ' if coalesce(current_setting(''axcelerate.importing'', true), '''') = ''on'' then return null; end if; -- AXCELERATE-NEXT-CYCLE
' || a);
  execute d;
end $$;

-- Missing AVETMISS answers from aXcelerate as Not stated, with a warning (not a refused Qualification).
do $$
declare d text := pg_get_functiondef('public.axcelerate_student_values(jsonb)'::regprocedure); a text; b text;
begin
  a := '  v := public.axcelerate_text(r, ''ATSCHOOLFLAG'', ''STILLATSCHOOL'');';
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'axcelerate_student_values: year anchor not found once'; end if;
  d := replace(d, a, '  if d->>''year_completed'' is null and d->>''school_level'' is not null and d->>''school_level'' !~ ''(02|@@)$'' then
    d := d || jsonb_build_object(''year_completed'', ''@@@@'');
    w := w || ''Year highest school level completed is not recorded in aXcelerate: stored as Not stated (@@@@). Ask the student and update it.''::text;
  end if;
' || a);
  b := '  if jsonb_array_length(v_rows) > 0 then d := d || jsonb_build_object(''prior_education'', v_rows); end if;';
  if (length(d) - length(replace(d, b, ''))) / length(b) <> 1 then raise exception 'axcelerate_student_values: prior anchor not found once'; end if;
  d := replace(d, b, '  if v = ''Yes'' and jsonb_array_length(v_rows) = 0 then
    d := d || jsonb_build_object(''prior_ed'', ''@'');
    w := w || ''Prior qualifications in aXcelerate have no recognition (A / E / I): prior education stored as Not stated (@). Ask the student and add them.''::text;
  end if;
' || b);
  execute d;
end $$;

-- Existing data: both calendars of each imported course again, from the last import's unit dates.
do $$
declare r record;
begin
  for r in select distinct on (l.target_id) l.connection_id, l.target_id as course_id, l.raw->>'class' as class, l.raw->'units' as units
             from public.axcelerate_links l
            where l.entity = 'master' and l.axcelerate_id like 'all:%' and jsonb_typeof(l.raw->'units') = 'array'
            order by l.target_id, l.last_imported_at desc loop
    perform public.axcelerate_course_calendars(r.connection_id, null, null, r.course_id, r.class, r.units);
  end loop;
end $$;

commit;
