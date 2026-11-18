-- INTAKE-REPLACES-BATCH stage 4 of 4: batches are gone. Drops the batch tables (batches, batch_sessions, batch_trainers,
-- batch_unit_trainers, batch_unit_overrides), every batch_id column, the stage 1-2 bridge triggers and functions, and renames
-- batch_enrolments (a student in an intake) to intake_enrolments; the 54 functions that name it are rewritten in place by the
-- loop below (word-boundary replace of the table name only). Checked before: no view, policy, cron job, publication or other
-- schema depends on the batch tables; no function reads them (stage 2b). One transaction: if anything fails nothing changes.
begin;

-- 1. Bridge triggers and the intake_id fill trigger on the tables that keep their data.
do $$ declare t text;
begin
  foreach t in array array['class_sessions','batch_enrolments','lms_attendance_register','sign_batch_sends','asm_assignments',
                           'course_completions','asm_unit_outcomes','rto_placement_overrides'] loop
    execute format('drop trigger if exists intake_bridge_fill on public.%I', t);
    execute format('alter table public.%I drop column if exists batch_id', t);
  end loop;
end $$;

-- 2. The batch tables (their own triggers go with them).
drop table public.batch_unit_overrides;
drop table public.batch_unit_trainers;
drop table public.batch_trainers;
drop table public.batch_sessions;
drop table public.batches;

-- 3. Bridge and batch-only functions.
drop function if exists public.intake_bridge_fill_intake_id();
drop function if exists public.intake_bridge_batch_settings();
drop function if exists public.intake_bridge_class_times();
drop function if exists public.intake_bridge_trainers();
drop function if exists public.intake_bridge_unit_trainers();
drop function if exists public.intake_bridge_batch_id();
drop function if exists public.course_master_one_group();
drop function if exists public.course_master_lock_override();

-- 4. batch_enrolments -> intake_enrolments, and the functions that name it.
alter table public.batch_enrolments rename to intake_enrolments;
alter index if exists public.batch_enrolments_intake_student_key rename to intake_enrolments_intake_student_key;
alter index if exists public.batch_enrolments_intake_idx rename to intake_enrolments_intake_idx;
alter index if exists public.batch_enrolments_pkey rename to intake_enrolments_pkey;
alter trigger batch_enrolments_seat_guard on public.intake_enrolments rename to intake_enrolments_seat_guard;
alter trigger batch_enrolments_auto_only on public.intake_enrolments rename to intake_enrolments_auto_only;
alter trigger asm_batch_enrolment_change on public.intake_enrolments rename to asm_intake_enrolment_change;

do $$ declare f record; n int := 0;
begin
  for f in select p.oid, pg_get_functiondef(p.oid) d from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and pg_get_functiondef(p.oid) ~ '\mbatch_enrolments\M' loop
    execute regexp_replace(f.d, '\mbatch_enrolments\M', 'intake_enrolments', 'g');
    n := n + 1;
  end loop;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and pg_get_functiondef(p.oid) ~ '\mbatch_enrolments\M') then
    raise exception 'functions still name batch_enrolments';
  end if;
  raise notice 'functions rewritten: %', n;
end $$;

insert into supabase_migrations.schema_migrations(version, name, statements)
  values ('20261119233000', 'intake_replaces_batch_stage4', array['see repo file']) on conflict do nothing;
commit;
