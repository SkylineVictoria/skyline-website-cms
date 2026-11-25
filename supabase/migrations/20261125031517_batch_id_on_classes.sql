-- LMS-BATCHES step 2 (2026-11-25): class times, batch trainers, class sessions and attendance registers belong to a batch.
-- intake_id stays on every row (filled from the batch, a different intake is refused) so the ~100 functions that read by intake keep
-- working; a row written without a batch goes to the intake's first batch (B1). Uniqueness moves to the batch (two batches of one intake
-- may meet at the same time in different rooms); the student / same-group clash is per batch, room and trainer clashes still cover every
-- batch; each batch must give the Master's weekly hours on its own. Sessions take room / trainer from their batch's class time, then the
-- batch's room / default trainer. The unused intake_class_times.legacy_batch_session_id is dropped.
-- Down: restore the four intake-level unique keys, drop the batch_id columns and triggers, re-run the patched functions from the previous
--       migration that defined them (pattern list below).
begin;

create or replace function pg_temp.fpatch(p_name text, p_lit text, p_new text, p_expect int default 1) returns void
language plpgsql as $$
declare v_oid oid; d text; pat text; n int;
begin
  select p.oid into strict v_oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_name;
  d := pg_get_functiondef(v_oid);
  pat := regexp_replace(regexp_replace(p_lit, '([.*+?^${}()|\[\]\\])', '\\\1', 'g'), ' ', '\s+', 'g');
  select count(*) into n from regexp_matches(d, pat, 'g');
  if n <> p_expect then raise exception 'fpatch %: expected % match(es) of [%], found %', p_name, p_expect, p_lit, n; end if;
  execute regexp_replace(d, pat, replace(p_new, '\', '\\'), 'g');
end $$;

-- Until step 9 turns intake deletes into archiving, an intake that may still be deleted (unfinished wizard intake) takes its batches with
-- it; the batch links are NO ACTION (checked at the end of the statement) so that cascade works.
alter table public.intake_batches drop constraint intake_batches_intake_id_fkey;
alter table public.intake_batches add constraint intake_batches_intake_id_fkey foreign key (intake_id) references public.course_intakes(id) on delete cascade;

alter table public.intake_class_times add column batch_id uuid references public.intake_batches(id);
alter table public.intake_trainers add column batch_id uuid references public.intake_batches(id);
alter table public.class_sessions add column batch_id uuid references public.intake_batches(id);
alter table public.lms_attendance_register add column batch_id uuid references public.intake_batches(id);

-- Backfill to B1 without firing the tables' own triggers (nothing else changes on these rows).
alter table public.intake_class_times disable trigger user;
alter table public.intake_trainers disable trigger user;
alter table public.class_sessions disable trigger user;
alter table public.lms_attendance_register disable trigger user;
update public.intake_class_times set batch_id = public.intake_default_batch(intake_id) where batch_id is null;
update public.intake_trainers set batch_id = public.intake_default_batch(intake_id) where batch_id is null;
update public.class_sessions set batch_id = public.intake_default_batch(intake_id) where batch_id is null;
update public.lms_attendance_register set batch_id = public.intake_default_batch(intake_id) where batch_id is null and intake_id is not null;
alter table public.intake_class_times enable trigger user;
alter table public.intake_trainers enable trigger user;
alter table public.class_sessions enable trigger user;
alter table public.lms_attendance_register enable trigger user;

alter table public.intake_class_times alter column batch_id set not null;
alter table public.intake_trainers alter column batch_id set not null;
alter table public.class_sessions alter column batch_id set not null;
alter table public.lms_attendance_register alter column batch_id set not null;

-- batch_id <-> intake_id kept consistent; a row without a batch goes to the intake's first batch.
create function public.intake_batch_fill() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_intake uuid;
begin
  if new.batch_id is null then
    if new.intake_id is null then raise exception 'A class row needs an intake or a batch.' using errcode = '23502'; end if;
    new.batch_id := public.intake_default_batch(new.intake_id);
  end if;
  select b.intake_id into v_intake from public.intake_batches b where b.id = new.batch_id;
  if v_intake is null then raise exception 'Batch not found.' using errcode = '23503'; end if;
  if new.intake_id is null then new.intake_id := v_intake;
  elsif new.intake_id <> v_intake then raise exception 'That batch belongs to another intake.' using errcode = '23514'; end if;
  return new;
end $$;
create trigger a0_batch_fill before insert or update of batch_id, intake_id on public.intake_class_times for each row execute function public.intake_batch_fill();
create trigger a0_batch_fill before insert or update of batch_id, intake_id on public.intake_trainers for each row execute function public.intake_batch_fill();
create trigger a0_batch_fill before insert or update of batch_id, intake_id on public.class_sessions for each row execute function public.intake_batch_fill();
create trigger a0_batch_fill before insert or update of batch_id, intake_id on public.lms_attendance_register for each row execute function public.intake_batch_fill();

-- After the class time's room / trainer (class_sessions_a_from_week): the batch's room and default trainer.
create function public.class_sessions_batch_defaults() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare b public.intake_batches;
begin
  if new.trainer_id is null or new.room_id is null then
    select * into b from public.intake_batches where id = new.batch_id;
    new.trainer_id := coalesce(new.trainer_id, b.default_trainer_id);
    new.room_id := coalesce(new.room_id, b.room_id);
  end if;
  return new;
end $$;
create trigger class_sessions_b_batch_defaults before insert on public.class_sessions for each row execute function public.class_sessions_batch_defaults();

-- Uniqueness per batch.
drop index public.class_sessions_intake_date_start_key;
create unique index class_sessions_batch_date_start_key on public.class_sessions (batch_id, session_date, start_time);
create index class_sessions_batch_date_idx on public.class_sessions (batch_id, session_date);
alter table public.intake_class_times drop constraint intake_class_times_no_duplicate_time;
alter table public.intake_class_times add constraint intake_class_times_no_duplicate_time unique (batch_id, weekday, start_time) deferrable initially deferred;
alter table public.intake_class_times drop column legacy_batch_session_id;
alter table public.intake_trainers drop constraint intake_trainers_pkey;
alter table public.intake_trainers add primary key (batch_id, staff_id);
create index intake_trainers_intake_idx on public.intake_trainers (intake_id);
drop index public.lms_attendance_register_intake_unit_date_key;
create unique index lms_attendance_register_batch_unit_date_key on public.lms_attendance_register (batch_id, intake_unit_id, class_date);

-- Generators write each class time's batch.
select pg_temp.fpatch('rto_class_sessions_generate', 'insert into public.class_sessions(intake_id, session_date, start_time, end_time, session_type, room_id, unit_id) values (p_batch, v_day,',
  'insert into public.class_sessions(batch_id, intake_id, session_date, start_time, end_time, session_type, room_id, unit_id) values (s.batch_id, p_batch, v_day,');
select pg_temp.fpatch('rto_class_sessions_generate', 'on conflict (intake_id, session_date, start_time)', 'on conflict (batch_id, session_date, start_time)');
select pg_temp.fpatch('course_master_classes', 'insert into public.class_sessions(intake_id, session_date, start_time, end_time, session_type, room_id, unit_id) values (p_batch, v_day,',
  'insert into public.class_sessions(batch_id, intake_id, session_date, start_time, end_time, session_type, room_id, unit_id) values (s.batch_id, p_batch, v_day,');
select pg_temp.fpatch('class_sessions_from_week', 't.intake_id = new.intake_id', 't.batch_id = new.batch_id');
select pg_temp.fpatch('intake_class_times_to_classes', 'cs.intake_id = new.intake_id', 'cs.batch_id = new.batch_id');

-- Attendance registers per batch.
select pg_temp.fpatch('lms_attendance', 'on conflict(intake_id,intake_unit_id,class_date)', 'on conflict(batch_id,intake_unit_id,class_date)');
select pg_temp.fpatch('trainer_session_attendance_save', 'where intake_id = cs.intake_id and intake_unit_id = v_iu', 'where batch_id = cs.batch_id and intake_unit_id = v_iu');
select pg_temp.fpatch('trainer_session_attendance_save', 'insert into public.lms_attendance_register(intake_id, intake_unit_id, class_date, state, updated_by) values (cs.intake_id,',
  'insert into public.lms_attendance_register(batch_id, intake_id, intake_unit_id, class_date, state, updated_by) values (cs.batch_id, cs.intake_id,');
select pg_temp.fpatch('trainer_session_attendance_save', 'on conflict (intake_id, intake_unit_id, class_date)', 'on conflict (batch_id, intake_unit_id, class_date)');
select pg_temp.fpatch('trainer_session_attendance', 'where intake_id = cs.intake_id and intake_unit_id = v_iu', 'where batch_id = cs.batch_id and intake_unit_id = v_iu');
select pg_temp.fpatch('admin_class_session_students', 'reg.intake_id = cs.intake_id', 'reg.batch_id = cs.batch_id');
select pg_temp.fpatch('admin_class_calendar', 'reg.intake_id = s.intake_id and iu.unit_id = s.unit_id', 'reg.batch_id = s.batch_id and iu.unit_id = s.unit_id');

-- Clashes: the same batch can't meet twice; other batches (of any intake) clash on room or trainer.
select pg_temp.fpatch('class_session_clash_ex', 'declare v_room uuid;', 'declare v_batch uuid; v_room uuid;');
select pg_temp.fpatch('class_session_clash_ex', 'v_room := coalesce(p_room, (select classroom_id from public.course_intakes where id = p_intake));',
  'v_batch := coalesce(nullif(current_setting(''lms.batch_id'', true), '''')::uuid, (select x.batch_id from public.class_sessions x where x.id = p_id), public.intake_first_batch(p_intake)); v_room := coalesce(p_room, (select b.room_id from public.intake_batches b where b.id = v_batch), (select classroom_id from public.course_intakes where id = p_intake));');
select pg_temp.fpatch('class_session_clash_ex', 'if c.intake_id = p_intake then return format(''This intake already has a class',
  'if c.batch_id = v_batch then return format(''This batch already has a class');
select pg_temp.fpatch('class_sessions_no_clash', 'v_problem := public.class_session_clash_ex(new.id,',
  'perform set_config(''lms.batch_id'', new.batch_id::text, true); v_problem := public.class_session_clash_ex(new.id,');
select pg_temp.fpatch('class_sessions_no_clash', 'new.joined_session_id); if v_problem',
  'new.joined_session_id); perform set_config(''lms.batch_id'', '''', true); if v_problem');
select pg_temp.fpatch('rto_class_session_clashes', 'o.intake_id <> a.intake_id', 'o.batch_id <> a.batch_id');

-- Weekly hours: every batch on its own must give what the Master needs.
select pg_temp.fpatch('course_master_group_problem',
  'coalesce((select sum(extract(epoch from (s.end_time - s.start_time))) / 3600.0 from public.intake_class_times s where s.intake_id = ci.id), 0)',
  'coalesce((select min(z.h) from (select sum(extract(epoch from (s.end_time - s.start_time))) / 3600.0 as h from public.intake_class_times s where s.intake_id = ci.id group by s.batch_id) z), 0)');

commit;
