-- AXCELERATE-NEXT-CYCLE (owner 2026-11-28: "check the timeline of SLIT vs aXcelerate for the master calendar and units"; fix approved).
-- Cycle 1 matched aXcelerate exactly, but from November 2026 the master calendar drifted from aXcelerate:
--   * the next cycles were 5 weeks short: unit lengths left out the term-break days and 2027 has no breaks yet;
--   * the first units of the next cycle started 3-7 days before aXcelerate's own dates for them (19 Nov, 18 Jan, 22 Feb);
--   * batch C2 kept the dates of the calendar before it was built again.
-- Now (axcelerate_course_calendars): every cycle after aXcelerate's repeats aXcelerate's unit order with each unit's calendar length (from
-- its start to the next unit's start in aXcelerate's class, breaks included), and in the next cycle a unit aXcelerate already has a date for
-- (a student's unit enrolment after the class) starts on that date, the unit before it ending the day before (axcelerate_cycle_layout).
-- Then each calendar-cycle batch (C<n>) takes its cycle's unit dates and its start and end (axcelerate_cycle_batches_sync); students' own
-- unit dates are not moved. Existing data: each imported course's calendars are built again.
begin;

create or replace function public.axcelerate_cycle_layout(p_connection uuid, p_course text, p_cycle integer, p_known boolean, p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_prev date := (select max(end_date) from axcelerate_calendar_rows where cycle = p_cycle - 1);
  v_last date := (select max((x->>'end')::date) from jsonb_array_elements(p_rows) x);
  v_known jsonb := '{}'::jsonb; r record; v_s date; v_e date; v_next date;
begin
  if v_prev is null then return; end if;
  if p_known then
    -- aXcelerate's own dates for units after its class (each student's unit enrolment), the earliest per unit within the next year.
    select coalesce(jsonb_object_agg(k.unit_id, k.s), '{}'::jsonb) into v_known from (
      select split_part(l.axcelerate_id, ':', 2) as unit_id, min(public.axcelerate_date(l.raw->>'STARTDATE')) as s
        from public.axcelerate_links l
        join public.cms_course_units cu on cu.id = split_part(l.axcelerate_id, ':', 2) and cu.course_id = p_course
       where l.connection_id = p_connection and l.entity = 'unit_result'
         and public.axcelerate_date(l.raw->>'STARTDATE') > v_last and public.axcelerate_date(l.raw->>'STARTDATE') <= v_last + 400
       group by 1) k;
  end if;
  for r in select z.unit_id, z.sort, z.len, z.next_unit from (
      select x->>'unitId' as unit_id, row_number() over w as sort,
             coalesce(lead((x->>'start')::date) over w - (x->>'start')::date, (x->>'end')::date - (x->>'start')::date + 1) as len,
             lead(x->>'unitId') over w as next_unit
        from jsonb_array_elements(p_rows) x
      window w as (order by x->>'start', x->>'unitId')) z order by z.sort loop
    v_s := coalesce((v_known->>r.unit_id)::date, v_prev + 1);
    v_e := v_s + greatest(r.len, 1) - 1;
    v_next := (v_known->>r.next_unit)::date;
    if v_next is not null and v_next > v_s then v_e := v_next - 1; end if;
    insert into axcelerate_calendar_rows values (p_cycle, r.unit_id, greatest(round((v_e - v_s + 1) / 7.0, 1), 0.5), r.sort, v_s, v_e);
    v_prev := v_e;
  end loop;
end $$;
revoke all on function public.axcelerate_cycle_layout(uuid, text, integer, boolean, jsonb) from public, anon, authenticated;

create or replace function public.axcelerate_cycle_batches_sync(p_connection uuid, p_course text)
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0; v_cycle integer; v_load text;
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
    update public.intake_batches b set start_date = z.s, end_date = z.e, updated_at = now()
      from (select min(start_date) as s, max(end_date) as e from public.intake_batch_units where batch_id = r.id) z
     where b.id = r.id and z.s is not null and (b.start_date, b.end_date) is distinct from (z.s, z.e);
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
      v_start := v_first - (k - c + 1) * v_span;
      insert into axcelerate_calendar_rows select c, m.unit_id, m.weeks, m.sort, m.start_date, m.end_date from public.course_master_layout(p_course, v_start, v_pattern) m;
    else
      -- Later cycles: aXcelerate''s unit order and calendar lengths, the next cycle on aXcelerate''s own dates where it has them (AXCELERATE-NEXT-CYCLE).
      perform public.axcelerate_cycle_layout(p_connection, p_course, c, c = k + 2, v_rows);
    end if;');
  b := '  -- Every open class of the course follows its calendar''s current cycle; its planned classes from today on are laid out again.';
  if (length(d) - length(replace(d, b, ''))) / length(b) <> 1 then raise exception 'axcelerate_course_calendars: batches anchor not found once'; end if;
  d := replace(d, b, '  -- Calendar-cycle batches (C<n>) take their cycle''s unit dates (AXCELERATE-NEXT-CYCLE).
  perform public.axcelerate_cycle_batches_sync(p_connection, p_course);
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
