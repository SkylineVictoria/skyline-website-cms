-- INTAKE-REPLACES-BATCH stage 1 of 4 (owner, 2026-11-19: "batch logic doesn't exist, intake and batch are the same; remove all
-- batch logic", option "Delete batch tables fully"). Additive foundation, nothing is removed yet:
--   * course_intakes gets the class group settings: classroom_id, class_days, start_time, end_time (capacity already exists);
--   * intake_class_times (weekly class times) and intake_trainers replace batch_sessions / batch_trainers;
--   * intake_units.trainer_id replaces batch_unit_trainers (one group per intake, so the intake unit carries its trainer);
--   * every table with batch_id gains intake_id (FK course_intakes) filled from the batch.
-- Bridge until stage 2 rewrites the database functions: triggers copy every batch-side write to the intake side, so both stay
-- equal while the old functions still write batches. Stage 2 switches the functions to the intake columns, stage 3 the screens,
-- stage 4 drops the batch tables, batch_id columns and these bridge triggers.
-- Hosted data at the time: 2 intakes, 2 batches (one each), 526 dated classes, 12 weekly times, 1 trainer link, no students.
-- Rollback (manual): drop the bridge triggers and functions, intake_class_times, intake_trainers, the intake_id columns and the
-- new course_intakes / intake_units columns.
begin;

-- 1. The intake carries the class group settings.
alter table public.course_intakes
  add column if not exists classroom_id uuid references public.classrooms(id) on delete set null,
  add column if not exists class_days text[] not null default '{}',
  add column if not exists start_time time,
  add column if not exists end_time time;
alter table public.intake_units add column if not exists trainer_id uuid;

update public.course_intakes i set classroom_id = b.classroom_id, class_days = coalesce(b.class_days, '{}'),
       start_time = b.start_time, end_time = b.end_time, capacity = coalesce(i.capacity, b.capacity)
  from public.batches b where b.intake_id = i.id and b.is_active;

-- 2. Weekly class times and trainers on the intake.
create table if not exists public.intake_class_times (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null references public.course_intakes(id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  slot text not null,
  start_time time not null,
  end_time time not null check (end_time > start_time),
  session_type text not null default 'theory',
  room_id uuid references public.classrooms(id) on delete set null,
  sort integer not null default 0,
  legacy_batch_session_id uuid unique,
  constraint intake_class_times_no_duplicate_time unique (intake_id, weekday, start_time) deferrable initially deferred
);
create table if not exists public.intake_trainers (
  intake_id uuid not null references public.course_intakes(id) on delete cascade,
  staff_id uuid not null,
  primary key (intake_id, staff_id)
);
alter table public.intake_class_times enable row level security;
alter table public.intake_trainers enable row level security;
drop policy if exists intake_class_times_staff_read on public.intake_class_times;
create policy intake_class_times_staff_read on public.intake_class_times for select to authenticated using (public.cms_is_admin() or public.cms_is_rto_manager());
drop policy if exists intake_trainers_staff_read on public.intake_trainers;
create policy intake_trainers_staff_read on public.intake_trainers for select to authenticated using (public.cms_is_admin() or public.cms_is_rto_manager());

insert into public.intake_class_times(intake_id, weekday, slot, start_time, end_time, session_type, room_id, sort, legacy_batch_session_id)
  select b.intake_id, s.weekday, s.slot, s.start_time, s.end_time, s.session_type, s.room_id, s.sort, s.id
    from public.batch_sessions s join public.batches b on b.id = s.batch_id
   where not exists (select 1 from public.intake_class_times x where x.legacy_batch_session_id = s.id);
insert into public.intake_trainers(intake_id, staff_id)
  select b.intake_id, t.staff_id from public.batch_trainers t join public.batches b on b.id = t.batch_id on conflict do nothing;
update public.intake_units u set trainer_id = t.staff_id
  from public.batch_unit_trainers t where t.intake_unit_id = u.id and u.trainer_id is null;

-- 3. intake_id beside every batch_id.
alter table public.class_sessions          add column if not exists intake_id uuid references public.course_intakes(id) on delete cascade;
alter table public.batch_enrolments        add column if not exists intake_id uuid references public.course_intakes(id) on delete cascade;
alter table public.lms_attendance_register add column if not exists intake_id uuid references public.course_intakes(id) on delete cascade;
alter table public.sign_batch_sends        add column if not exists intake_id uuid references public.course_intakes(id) on delete cascade;
alter table public.asm_assignments         add column if not exists intake_id uuid references public.course_intakes(id) on delete restrict;
alter table public.course_completions      add column if not exists intake_id uuid references public.course_intakes(id) on delete restrict;
alter table public.asm_unit_outcomes       add column if not exists intake_id uuid references public.course_intakes(id) on delete set null;
alter table public.rto_placement_overrides add column if not exists intake_id uuid references public.course_intakes(id) on delete set null;

update public.class_sessions t          set intake_id = b.intake_id from public.batches b where b.id = t.batch_id and t.intake_id is null;
update public.batch_enrolments t        set intake_id = b.intake_id from public.batches b where b.id = t.batch_id and t.intake_id is null;
update public.lms_attendance_register t set intake_id = b.intake_id from public.batches b where b.id = t.batch_id and t.intake_id is null;
update public.sign_batch_sends t        set intake_id = b.intake_id from public.batches b where b.id = t.batch_id and t.intake_id is null;
update public.asm_assignments t         set intake_id = b.intake_id from public.batches b where b.id = t.batch_id and t.intake_id is null;
update public.course_completions t      set intake_id = b.intake_id from public.batches b where b.id = t.batch_id and t.intake_id is null;
update public.asm_unit_outcomes t       set intake_id = b.intake_id from public.batches b where b.id = t.batch_id and t.intake_id is null;
update public.rto_placement_overrides t set intake_id = b.intake_id from public.batches b where b.id = t.batch_id and t.intake_id is null;

create index if not exists class_sessions_intake_date_idx on public.class_sessions(intake_id, session_date);
create index if not exists batch_enrolments_intake_idx on public.batch_enrolments(intake_id, student_id);
create index if not exists lms_attendance_register_intake_idx on public.lms_attendance_register(intake_id);

-- 4. Bridge triggers (removed in stage 4).
create or replace function public.intake_bridge_fill_intake_id() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.batch_id is not null and (tg_op = 'INSERT' or new.batch_id is distinct from old.batch_id or new.intake_id is null) then
    select b.intake_id into new.intake_id from public.batches b where b.id = new.batch_id;
  end if;
  return new;
end $$;

do $$ declare t text;
begin
  foreach t in array array['class_sessions','batch_enrolments','lms_attendance_register','sign_batch_sends','asm_assignments',
                           'course_completions','asm_unit_outcomes','rto_placement_overrides'] loop
    execute format('drop trigger if exists intake_bridge_fill on public.%I', t);
    execute format('create trigger intake_bridge_fill before insert or update of batch_id, intake_id on public.%I
                    for each row execute function public.intake_bridge_fill_intake_id()', t);
  end loop;
end $$;

create or replace function public.intake_bridge_batch_settings() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_active then
    update public.course_intakes set classroom_id = new.classroom_id, class_days = coalesce(new.class_days, '{}'),
           start_time = new.start_time, end_time = new.end_time, capacity = coalesce(new.capacity, capacity)
     where id = new.intake_id;
  end if;
  return new;
end $$;
drop trigger if exists intake_bridge_batch_settings on public.batches;
create trigger intake_bridge_batch_settings after insert or update of classroom_id, class_days, start_time, end_time, capacity, is_active
  on public.batches for each row execute function public.intake_bridge_batch_settings();

create or replace function public.intake_bridge_class_times() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    delete from public.intake_class_times where legacy_batch_session_id = old.id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    insert into public.intake_class_times(intake_id, weekday, slot, start_time, end_time, session_type, room_id, sort, legacy_batch_session_id)
      select b.intake_id, new.weekday, new.slot, new.start_time, new.end_time, new.session_type, new.room_id, new.sort, new.id
        from public.batches b where b.id = new.batch_id;
  end if;
  return null;
end $$;
drop trigger if exists intake_bridge_class_times on public.batch_sessions;
create trigger intake_bridge_class_times after insert or update or delete on public.batch_sessions
  for each row execute function public.intake_bridge_class_times();

create or replace function public.intake_bridge_trainers() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_intake uuid;
begin
  select intake_id into v_intake from public.batches where id = coalesce(new.batch_id, old.batch_id);
  if v_intake is null then return null; end if;
  if tg_op = 'DELETE' then
    delete from public.intake_trainers where intake_id = v_intake and staff_id = old.staff_id
      and not exists (select 1 from public.batch_trainers t join public.batches b on b.id = t.batch_id
                       where b.intake_id = v_intake and t.staff_id = old.staff_id);
  else
    insert into public.intake_trainers(intake_id, staff_id) values (v_intake, new.staff_id) on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger if exists intake_bridge_trainers on public.batch_trainers;
create trigger intake_bridge_trainers after insert or delete on public.batch_trainers
  for each row execute function public.intake_bridge_trainers();

create or replace function public.intake_bridge_unit_trainers() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    update public.intake_units set trainer_id = null where id = old.intake_unit_id and trainer_id = old.staff_id;
  else
    update public.intake_units set trainer_id = new.staff_id where id = new.intake_unit_id;
  end if;
  return null;
end $$;
drop trigger if exists intake_bridge_unit_trainers on public.batch_unit_trainers;
create trigger intake_bridge_unit_trainers after insert or update or delete on public.batch_unit_trainers
  for each row execute function public.intake_bridge_unit_trainers();

revoke all on function public.intake_bridge_fill_intake_id(), public.intake_bridge_batch_settings(), public.intake_bridge_class_times(),
  public.intake_bridge_trainers(), public.intake_bridge_unit_trainers() from public, anon, authenticated;

commit;
