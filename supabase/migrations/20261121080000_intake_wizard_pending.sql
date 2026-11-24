-- An intake made by the course wizard stays hidden (wizard_pending, status draft) until the whole wizard is finished:
-- CoE and VoE weekly calendars and CoE and VoE daily timetables. Finishing opens both intakes of the course.
alter table public.course_intakes add column if not exists wizard_pending boolean not null default false;

create or replace function public.rto_intake_wizard(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_course text := d->>'courseId'; v_id uuid := nullif(d->>'intakeId', '')::uuid;
begin
 if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'Only an RTO Manager can use the course wizard.' using errcode = '42501'; end if;
 if p_action = 'mark' then
  update public.course_intakes set wizard_pending = true, status = 'draft', is_active = false where id = v_id and not exists (select 1 from public.intake_enrolments e where e.intake_id = v_id);
  return jsonb_build_object('ok', true);
 elsif p_action = 'pending' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', ci.id, 'load', ci.study_load, 'startDate', ci.start_date) order by ci.created_at) from public.course_intakes ci
   where ci.course_id = v_course and ci.wizard_pending), '[]'::jsonb);
 elsif p_action = 'finish' then
  update public.course_intakes set wizard_pending = false, status = 'open', is_active = true, updated_at = now() where course_id = v_course and wizard_pending;
  return jsonb_build_object('ok', true);
 end if;
 raise exception 'Unknown action' using errcode = '22023';
end $$;
revoke all on function public.rto_intake_wizard(text, jsonb) from public, anon;
grant execute on function public.rto_intake_wizard(text, jsonb) to authenticated;

do $$
declare d text; a1 constant text := 'jsonb_agg(public.rto_intake_json(ci) order by ci.start_date desc) from public.course_intakes ci)';
 a2 constant text := 'ci.course_id = c.id and ci.status in (''open'', ''full'', ''draft'')';
begin
 d := pg_get_functiondef('public.rto_admin(text, jsonb)'::regprocedure);
 if position(a1 in d) = 0 or position(a2 in d) = 0 then raise exception 'anchor not found in rto_admin'; end if;
 d := replace(d, a1, 'jsonb_agg(public.rto_intake_json(ci) order by ci.start_date desc) from public.course_intakes ci where not ci.wizard_pending)');
 d := replace(d, a2, 'ci.course_id = c.id and not ci.wizard_pending and ci.status in (''open'', ''full'', ''draft'')');
 execute d;
end $$;
