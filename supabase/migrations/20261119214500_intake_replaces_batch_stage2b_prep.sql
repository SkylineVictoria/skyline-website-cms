-- INTAKE-REPLACES-BATCH stage 2b prep: the intake side gets the unique rules the functions use (ON CONFLICT targets), and the
-- tables that point at batches stop needing a batch (batch_id nullable, its FK to batches dropped). Compatible with the current
-- functions (they still fill batch_id, which equals the intake id since stage 2a). Stage 2b then switches the functions to
-- intake_id; stage 4 drops batch_id and the batch tables.
begin;

create unique index if not exists class_sessions_intake_date_start_key on public.class_sessions (intake_id, session_date, start_time);
create unique index if not exists batch_enrolments_intake_student_key on public.batch_enrolments (intake_id, student_id);
create unique index if not exists lms_attendance_register_intake_unit_date_key on public.lms_attendance_register (intake_id, intake_unit_id, class_date);
create unique index if not exists asm_assignments_version_intake_key on public.asm_assignments (version_id, intake_id);
create unique index if not exists sign_batch_sends_template_intake_student_key on public.sign_batch_sends (template_id, intake_id, student_id);

do $$ declare t text; c text;
begin
  foreach t in array array['class_sessions','batch_enrolments','lms_attendance_register','sign_batch_sends','asm_assignments',
                           'course_completions','asm_unit_outcomes','rto_placement_overrides'] loop
    for c in select conname from pg_constraint where conrelid = format('public.%I', t)::regclass and confrelid = 'public.batches'::regclass loop
      execute format('alter table public.%I drop constraint %I', t, c);
    end loop;
    execute format('alter table public.%I alter column batch_id drop not null', t);
  end loop;
end $$;

alter table public.class_sessions alter column intake_id set not null;
alter table public.batch_enrolments alter column intake_id set not null;
alter table public.lms_attendance_register alter column intake_id set not null;
alter table public.sign_batch_sends alter column intake_id set not null;
alter table public.asm_assignments alter column intake_id set not null;

insert into supabase_migrations.schema_migrations(version, name, statements)
  values ('20261119214500', 'intake_replaces_batch_stage2b_prep', array['see repo file']) on conflict do nothing;
commit;
