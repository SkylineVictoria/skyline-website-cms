-- AXCELERATE-BREAKS (owner 2026-11-28: "Term break is not getting imported properly with aXcelerate at all"): aXcelerate's calendar
-- (/course/calendar) answers with no events for this account, so no break was ever imported. aXcelerate's term breaks are where its classes
-- stop: a run of 7 or more days with no aXcelerate class day (the workshop days imported as class days, entity 'class_day') between two class
-- days of the course is a term break of that course, from the day after the last class to the day before the next one.
-- axcelerate_class_breaks(course) writes them through axcelerate_import_break (link 'break', key <course>:gap:<from>, matched by dates, a
-- break deleted in Skyline stays skipped, a Skyline edit is kept as a conflict); a gap that a Skyline break already covers is not added again;
-- an aXcelerate gap break that no longer matches aXcelerate's class days (classes added in the gap) is removed unless edited in Skyline.
-- axcelerate_import_unit_results calls it after the class days are written and before the batches' classes are laid out, so generated
-- classes skip the breaks. Existing data: run once for every course with aXcelerate class days.
begin;

create or replace function public.axcelerate_class_breaks(p_connection uuid, p_run uuid, p_actor uuid, p_course text)
returns integer language plpgsql security definer set search_path = public as $$
declare g record; n integer := 0; v_keys text[] := '{}'; v_key text; l public.axcelerate_links;
begin
  if p_course is null then return 0; end if;
  for g in
    with d as (
      select distinct s.session_date as dt
        from public.class_sessions s
        join public.axcelerate_links cl on cl.connection_id = p_connection and cl.entity = 'class_day' and cl.target_id = s.id::text
        join public.course_intakes ci on ci.id = s.intake_id
       where ci.course_id = p_course and coalesce(s.status, '') <> 'cancelled'),
    x as (select dt, lead(dt) over (order by dt) as nxt from d)
    select dt + 1 as start_date, nxt - 1 as end_date from x where nxt - dt - 1 >= 7 order by dt
  loop
    v_key := p_course || ':gap:' || g.start_date::text;
    v_keys := v_keys || v_key;
    -- A Skyline break of the course (or a break already imported) that covers the whole gap is enough.
    if exists (select 1 from public.academic_breaks b where b.course_id = p_course and b.start_date <= g.start_date and b.end_date >= g.end_date
                  and not exists (select 1 from public.axcelerate_links bl where bl.connection_id = p_connection and bl.entity = 'break'
                                    and bl.axcelerate_id = v_key and bl.target_id = b.id::text)) then
      continue;
    end if;
    perform public.axcelerate_import_break(p_connection, p_run, p_actor, p_course,
      jsonb_build_object('id', 'gap:' || g.start_date::text, 'label', 'Term break', 'start', g.start_date, 'end', g.end_date,
        'source', 'aXcelerate class days (no classes from ' || g.start_date::text || ' to ' || g.end_date::text || ')'));
    n := n + 1;
  end loop;
  -- Gap breaks aXcelerate no longer shows (not edited in Skyline) go.
  for l in select * from public.axcelerate_links where connection_id = p_connection and entity = 'break'
             and axcelerate_id like p_course || ':gap:%' and not (axcelerate_id = any(v_keys)) loop
    if l.edited_in_skyline_at is null or l.edited_in_skyline_at <= l.last_imported_at then
      perform public.axcelerate_importing(p_actor);
      delete from public.academic_breaks where id::text = l.target_id;
      delete from public.axcelerate_links where id = l.id;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.axcelerate_class_breaks(uuid, uuid, uuid, text) from public, anon, authenticated;

do $$
declare d text := pg_get_functiondef('public.axcelerate_import_unit_results(uuid, uuid, uuid, uuid, jsonb)'::regprocedure); a text;
begin
  a := '  -- Batches with aXcelerate class days take aXcelerate''s weekly days and times; the intake''s other batches copy them.';
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'axcelerate_import_unit_results: breaks anchor not found once'; end if;
  d := replace(d, a, '  -- aXcelerate''s term breaks (the gaps in its class days) first, so the classes laid out below skip them (AXCELERATE-BREAKS).
  perform public.axcelerate_class_breaks(p_connection, p_run, p_actor, i.course_id);
' || a);
  execute d;
end $$;

-- Existing data: the courses that already have aXcelerate class days.
do $$
declare r record;
begin
  for r in select distinct cl.connection_id, ci.course_id
             from public.axcelerate_links cl
             join public.class_sessions s on s.id::text = cl.target_id
             join public.course_intakes ci on ci.id = s.intake_id
            where cl.entity = 'class_day' loop
    perform public.axcelerate_class_breaks(r.connection_id, null, null, r.course_id);
  end loop;
end $$;

commit;
