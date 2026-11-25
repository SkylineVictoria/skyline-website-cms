-- LMS-BATCHES step 3 (2026-11-25): a student (their intake enrolment) can be in one or more batches, optionally for one unit only
-- (e.g. a missed unit taken with another batch). Memberships are archived, never deleted, and every change is logged in
-- batch_assignment_log (also used for unit allocations' batch in step 7). A batch must belong to an intake of the enrolment's course;
-- a batch with seats refuses more live members. An active enrolment is put in its intake's first batch automatically and moved when
-- its intake changes. Same policies as intake_enrolments.
-- Down: drop trigger intake_enrolments_batch_sync on public.intake_enrolments; drop function public.intake_enrolments_batch_sync();
--       drop function public.batch_students_guard(); drop table public.batch_assignment_log; drop table public.batch_students;
begin;

create table public.batch_students (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references public.intake_enrolments(id) on delete cascade,
  batch_id uuid not null references public.intake_batches(id),
  unit_id text references public.cms_course_units(id),
  assigned_at timestamptz not null default now(),
  assigned_by uuid,
  archived_at timestamptz,
  archive_reason text check (archive_reason is null or char_length(archive_reason) <= 500)
);
create unique index batch_students_live_key on public.batch_students (enrolment_id, batch_id, coalesce(unit_id, '')) where archived_at is null;
create index batch_students_batch_idx on public.batch_students (batch_id) where archived_at is null;

create table public.batch_assignment_log (
  id bigint generated always as identity primary key,
  enrolment_id uuid,
  student_id uuid,
  unit_id text,
  from_batch_id uuid,
  to_batch_id uuid,
  action text not null check (action in ('assigned', 'moved', 'archived', 'unit_batch_changed')),
  reason text check (reason is null or char_length(reason) <= 500),
  by_user uuid default auth.uid(),
  at timestamptz not null default now()
);
create index batch_assignment_log_enrolment_idx on public.batch_assignment_log (enrolment_id, at desc);

alter table public.batch_students enable row level security;
create policy batch_students_admin_write on public.batch_students for all using (public.cms_is_admin()) with check (public.cms_is_admin());
create policy batch_students_rto_write on public.batch_students for all using (public.cms_is_rto_manager()) with check (public.cms_is_rto_manager());
create policy batch_students_staff_read on public.batch_students for select using (public.cms_is_staff());
grant select, insert, update on public.batch_students to authenticated;

alter table public.batch_assignment_log enable row level security;
create policy batch_assignment_log_staff_read on public.batch_assignment_log for select using (public.cms_is_admin() or public.cms_is_rto_manager());
grant select on public.batch_assignment_log to authenticated;

-- Same course, seats, no deletes, and a log row for every change.
create function public.batch_students_guard() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_course_batch text; v_course_enrol text; v_cap integer; v_live integer; v_student uuid;
begin
  if tg_op = 'DELETE' then
    -- Only together with its enrolment (carry-over re-planning, unfinished wizard intakes); otherwise archive.
    if exists (select 1 from public.intake_enrolments e where e.id = old.enrolment_id) then
      raise exception 'Batch memberships are archived, not deleted.' using errcode = '23514';
    end if;
    return old;
  end if;
  select ci.course_id, b.capacity into v_course_batch, v_cap from public.intake_batches b join public.course_intakes ci on ci.id = b.intake_id where b.id = new.batch_id;
  select ci.course_id, e.student_id into v_course_enrol, v_student from public.intake_enrolments e join public.course_intakes ci on ci.id = e.intake_id where e.id = new.enrolment_id;
  if v_course_batch is distinct from v_course_enrol then
    raise exception 'That batch is not part of the student''s course.' using errcode = '23514';
  end if;
  if new.archived_at is null and (tg_op = 'INSERT' or old.archived_at is not null or old.batch_id <> new.batch_id) and v_cap is not null then
    select count(distinct bs.enrolment_id) into v_live from public.batch_students bs where bs.batch_id = new.batch_id and bs.archived_at is null and bs.enrolment_id <> new.enrolment_id;
    if v_live >= v_cap then raise exception 'This batch is full (% seats).', v_cap using errcode = '23514'; end if;
  end if;
  if tg_op = 'INSERT' then
    insert into public.batch_assignment_log (enrolment_id, student_id, unit_id, to_batch_id, action) values (new.enrolment_id, v_student, new.unit_id, new.batch_id, 'assigned');
  elsif old.archived_at is null and new.archived_at is not null then
    insert into public.batch_assignment_log (enrolment_id, student_id, unit_id, from_batch_id, action, reason) values (new.enrolment_id, v_student, new.unit_id, new.batch_id, 'archived', new.archive_reason);
  elsif old.batch_id <> new.batch_id then
    insert into public.batch_assignment_log (enrolment_id, student_id, unit_id, from_batch_id, to_batch_id, action) values (new.enrolment_id, v_student, new.unit_id, old.batch_id, new.batch_id, 'moved');
  end if;
  return coalesce(new, old);
end $$;
create trigger batch_students_guard before insert or update or delete on public.batch_students for each row execute function public.batch_students_guard();

-- An active enrolment sits in its intake's first batch; a new intake archives the old intake's memberships.
create function public.intake_enrolments_batch_sync() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_op = 'UPDATE' and old.intake_id is distinct from new.intake_id then
    update public.batch_students bs set archived_at = now(), archive_reason = 'Moved to another intake'
     where bs.enrolment_id = new.id and bs.archived_at is null
       and bs.batch_id in (select b.id from public.intake_batches b where b.intake_id = old.intake_id);
  end if;
  if new.status = 'active' and new.intake_id is not null
     and not exists (select 1 from public.batch_students bs join public.intake_batches b on b.id = bs.batch_id
                      where bs.enrolment_id = new.id and bs.archived_at is null and b.intake_id = new.intake_id) then
    insert into public.batch_students (enrolment_id, batch_id) values (new.id, public.intake_default_batch(new.intake_id));
  end if;
  return null;
end $$;
create trigger intake_enrolments_batch_sync after insert or update of intake_id, status on public.intake_enrolments
  for each row execute function public.intake_enrolments_batch_sync();

revoke all on function public.batch_students_guard(), public.intake_enrolments_batch_sync() from public, anon, authenticated;

-- Backfill (no enrolments on hosted today; kept for other databases).
insert into public.batch_students (enrolment_id, batch_id)
select e.id, public.intake_default_batch(e.intake_id) from public.intake_enrolments e
 where e.status = 'active' and e.intake_id is not null
   and not exists (select 1 from public.batch_students bs where bs.enrolment_id = e.id);

commit;
