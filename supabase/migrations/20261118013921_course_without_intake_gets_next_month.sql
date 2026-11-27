create or replace function public.course_intakes_open(p_course text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $function$
declare v_cid text := public.course_resolve_id(p_course); v_start date; v_new uuid; v_was text; v_list jsonb;
begin
  if v_cid is not null and not exists (select 1 from public.course_intake_offered(v_cid))
     and exists (select 1 from public.cms_courses c where c.id = v_cid and (c.status = 'Published' or coalesce(public.cms_is_staff(), false))) then
    begin
      perform pg_advisory_xact_lock(hashtextextended('course_intake_auto_month:' || v_cid, 0));
      if not exists (select 1 from public.course_intake_offered(v_cid)) then
        v_was := coalesce(current_setting('rto.course', true), '');
        perform set_config('rto.course', v_cid, true);
        v_start := public.rto_next_working_day((date_trunc('month', public.course_intake_today()::timestamp) + interval '1 month')::date);
        perform set_config('rto.course', v_was, true);
        if not exists (select 1 from public.course_intakes where course_id = v_cid and start_date = v_start) then
          insert into public.course_intakes(course_id, start_date, status, auto_created) values (v_cid, v_start, 'open', true) returning id into v_new;
          perform public.intake_generate_schedule(v_new, v_start);
        end if;
      end if;
    exception when others then
      raise warning 'course_intakes_open: no intake made for %: %', v_cid, sqlerrm;
    end;
  end if;
  select coalesce(jsonb_agg(public.course_intake_json(i) || jsonb_build_object('fallback', false,
      'running', i.start_date <= public.course_intake_today()) order by i.start_date), '[]'::jsonb) into v_list
  from public.course_intakes i where i.id in (select public.course_intake_offered(v_cid));
  if jsonb_array_length(v_list) > 0 then return v_list; end if;
  if v_cid is not null and not exists (select 1 from public.course_intakes i where i.course_id = v_cid) then
    return public.course_intake_fallback(v_cid);
  end if;
  return '[]'::jsonb;
end $function$;