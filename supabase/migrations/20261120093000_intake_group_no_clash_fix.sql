-- intake_group_no_clash_fix: APPLIED on hosted 2026-11-20 by another session, recorded in supabase_migrations.schema_migrations as
-- 20261120093000 with the statements placeholder 'see repo file'; the file itself never reached the repo.
-- Recovered 2026-11-20 from hosted pg_stat_statements, statement text verbatim (only this header and the closing semicolon added); the
-- function body is byte-identical to the hosted definition (md5 of pg_proc.prosrc d3ae134f6f0440404285b0f61f545eca).
-- The fix: 20261120001500 read `new.intake_id` inside a CASE also when the trigger fires on course_intakes, whose rows have no intake_id;
-- the intake is now chosen with IF, so only the field of the firing table is read. Triggers course_intakes_no_clash and
-- intake_trainers_no_clash are unchanged.
create or replace function public.intake_group_no_clash() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
declare v_intake uuid; c record; v_problem text;
begin
  if tg_table_name = 'course_intakes' then v_intake := new.id; else v_intake := new.intake_id; end if;
  for c in select * from public.class_sessions where intake_id = v_intake and status <> 'cancelled' and session_date >= current_date loop
    v_problem := public.class_session_clash(c.id, c.intake_id, c.unit_id, c.room_id, c.trainer_id, c.session_date, c.start_time, c.end_time);
    if v_problem is not null then raise exception '%', v_problem using errcode = '23P01'; end if;
  end loop;
  return null;
end $function$;
