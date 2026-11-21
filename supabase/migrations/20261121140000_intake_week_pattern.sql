-- Weekly class pattern (day, start, end, kind) of intakes that are on offer, for the application form's start-date calendar.
create or replace function public.intake_week_pattern(p_intakes uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
 if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
 return coalesce((select jsonb_object_agg(i.id::text, coalesce((select jsonb_agg(jsonb_build_object('weekday', t.weekday, 'start', to_char(t.start_time, 'HH24:MI'),
     'end', to_char(t.end_time, 'HH24:MI'), 'type', t.session_type) order by t.weekday, t.start_time)
   from public.intake_class_times t where t.intake_id = i.id), '[]'::jsonb))
  from public.course_intakes i where i.id = any(p_intakes) and i.id in (select public.course_intake_offered(i.course_id))), '{}'::jsonb);
end $$;
revoke all on function public.intake_week_pattern(uuid[]) from public, anon;
grant execute on function public.intake_week_pattern(uuid[]) to authenticated;
