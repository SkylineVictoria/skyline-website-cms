-- An intake made by the course wizard exists for nobody until the whole wizard is finished (CoE and VoE weekly calendars and daily timetables):
-- 1. it is created hidden in the same statement (no moment where it is open),
-- 2. its Microsoft 365 group is not made and nobody is told until the wizard ends,
-- 3. an abandoned one is removed automatically after the number of hours set in Business Rules (lms.wizard_draft_hours).
select public.business_rule_add_setting('lms.wizard_draft_hours', 'Hours before an unfinished course wizard is cleared', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'number', '24'::jsonb, '{"min":1,"max":720}'::jsonb,
  'The course wizard keeps its CoE and VoE intakes hidden until the whole wizard is finished. If nobody finishes it within this many hours, the hidden intakes are deleted (the course keeps its calendars; the wizard can be run again).');

do $$
declare d text; a1 constant text := E'returning id into v_id;\n  else'; a2 text := 'where (p_intake is null or g.intake_id = p_intake)';
begin
 d := pg_get_functiondef('public.rto_admin(text,jsonb)'::regprocedure);
 if position(a1 in d) = 0 then raise exception 'anchor not found in rto_admin'; end if;
 execute replace(d, a1, E'returning id into v_id;\n   if coalesce((d->>''wizard'')::boolean, false) then update public.course_intakes set wizard_pending = true, status = ''draft'', is_active = false where id = v_id; end if;\n  else');
 d := pg_get_functiondef('public.intake_group_m365_work(uuid)'::regprocedure);
 if position(a2 in d) = 0 then raise exception 'anchor not found in intake_group_m365_work'; end if;
 execute replace(d, a2, a2 || ' and not exists (select 1 from public.course_intakes ci where ci.id = g.intake_id and ci.wizard_pending)');
 d := pg_get_functiondef('public.intake_groups_dispatch()'::regprocedure);
 a2 := 'from public.intake_groups g where g.status = ''active''';
 if position(a2 in d) = 0 then raise exception 'anchor not found in intake_groups_dispatch'; end if;
 execute replace(d, a2, a2 || ' and not exists (select 1 from public.course_intakes ci where ci.id = g.intake_id and ci.wizard_pending)');
end $$;

create or replace function public.intake_wizard_cleanup() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
 delete from public.course_intakes ci
  where ci.wizard_pending and ci.created_at < now() - make_interval(hours => public.rule_int('lms.wizard_draft_hours', 24))
    and not exists (select 1 from public.intake_enrolments e where e.intake_id = ci.id)
    and not exists (select 1 from public.lms_intake_students s where s.intake_id = ci.id)
    and not exists (select 1 from public.enrollment_application_courses c where c.intake_id = ci.id)
    and not exists (select 1 from public.asm_assignments a where a.intake_id = ci.id)
    and not exists (select 1 from public.course_completions cc where cc.intake_id = ci.id);
 get diagnostics n = row_count;
 return n;
end $$;
revoke all on function public.intake_wizard_cleanup() from public, anon, authenticated;

do $$ begin
 if exists (select 1 from pg_extension where extname = 'pg_cron') then
  perform cron.unschedule(jobid) from cron.job where jobname = 'intake-wizard-cleanup';
  perform cron.schedule('intake-wizard-cleanup', '17 * * * *', 'select public.intake_wizard_cleanup()');
 end if;
end $$;
