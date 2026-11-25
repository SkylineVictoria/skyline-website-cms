-- LMS-BATCHES step 7 (2026-11-25): a student's unit allocation names the batch whose classes they attend (lms_unit_students.batch_id).
-- New allocations take the student's batch for that unit (a unit-only membership first, then their general membership in the intake,
-- then the intake's first batch); the batch must belong to the allocation's intake (a missed unit carried to a later rolling cycle uses
-- that later intake's batches). The batch can be changed later (owner); every change is logged (batch_assignment_log,
-- 'unit_batch_changed'). Intake, unit, student and dates stay permanent (lms_allocation_private.preserve_allocation, unchanged).
-- Timetables, class lists and clash checks show a student only the classes of their own batch(es) (public.enrolment_in_session).
-- Down: drop trigger a0_unit_batch on public.lms_unit_students; drop function public.lms_unit_students_batch();
--       re-run the four patched functions without "public.enrolment_in_session(...) and"; drop function public.enrolment_in_session(uuid, uuid, text);
--       alter table public.lms_unit_students drop column batch_id.
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

alter table public.lms_unit_students add column batch_id uuid references public.intake_batches(id);
create index lms_unit_students_batch_idx on public.lms_unit_students (batch_id);

-- The batch an enrolment attends for a unit: allocation's batch, else a unit-only membership, else a general membership, else B1.
create function public.enrolment_unit_batch(p_enrolment uuid, p_unit text) returns uuid
language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    (select a.batch_id from public.intake_enrolments e join public.lms_unit_students a on a.intake_id = e.intake_id and a.student_id = e.student_id
      where e.id = p_enrolment and a.unit_id = p_unit and a.batch_id is not null limit 1),
    (select bs.batch_id from public.batch_students bs where bs.enrolment_id = p_enrolment and bs.unit_id = p_unit and bs.archived_at is null order by bs.assigned_at desc limit 1),
    (select bs.batch_id from public.batch_students bs join public.intake_batches b on b.id = bs.batch_id join public.intake_enrolments e on e.id = bs.enrolment_id
      where bs.enrolment_id = p_enrolment and bs.unit_id is null and bs.archived_at is null and b.intake_id = e.intake_id order by b.sort, b.code limit 1),
    (select public.intake_first_batch(e.intake_id) from public.intake_enrolments e where e.id = p_enrolment));
$$;

-- Does this enrolment attend this batch's class for this unit? (A class with no unit: any live membership of the batch, or B1.)
create function public.enrolment_in_session(p_enrolment uuid, p_batch uuid, p_unit text) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select case
    when p_unit is not null then public.enrolment_unit_batch(p_enrolment, p_unit) = p_batch
    else exists (select 1 from public.batch_students bs where bs.enrolment_id = p_enrolment and bs.batch_id = p_batch and bs.archived_at is null)
      or (not exists (select 1 from public.batch_students bs where bs.enrolment_id = p_enrolment and bs.archived_at is null)
          and p_batch = (select public.intake_first_batch(e.intake_id) from public.intake_enrolments e where e.id = p_enrolment))
  end;
$$;

create function public.lms_unit_students_batch() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_enrol uuid; v_intake uuid;
begin
  select e.id into v_enrol from public.intake_enrolments e where e.intake_id = new.intake_id and e.student_id = new.student_id order by (e.status = 'active') desc limit 1;
  if new.batch_id is null then
    new.batch_id := coalesce(
      (select bs.batch_id from public.batch_students bs where bs.enrolment_id = v_enrol and bs.unit_id = new.unit_id and bs.archived_at is null order by bs.assigned_at desc limit 1),
      (select bs.batch_id from public.batch_students bs join public.intake_batches b on b.id = bs.batch_id
        where bs.enrolment_id = v_enrol and bs.unit_id is null and bs.archived_at is null and b.intake_id = new.intake_id order by b.sort, b.code limit 1),
      public.intake_default_batch(new.intake_id));
  end if;
  select b.intake_id into v_intake from public.intake_batches b where b.id = new.batch_id;
  if v_intake is distinct from new.intake_id then raise exception 'That batch is not part of the allocation''s intake.' using errcode = '23514'; end if;
  if tg_op = 'UPDATE' and old.batch_id is distinct from new.batch_id then
    insert into public.batch_assignment_log (enrolment_id, student_id, unit_id, from_batch_id, to_batch_id, action, reason)
    values (v_enrol, new.student_id, new.unit_id, old.batch_id, new.batch_id, 'unit_batch_changed', nullif(current_setting('lms.batch_reason', true), ''));
  end if;
  return new;
end $$;
create trigger a0_unit_batch before insert or update of batch_id on public.lms_unit_students for each row execute function public.lms_unit_students_batch();

revoke all on function public.lms_unit_students_batch() from public, anon, authenticated;
grant execute on function public.enrolment_unit_batch(uuid, text), public.enrolment_in_session(uuid, uuid, text) to authenticated;

-- Backfill (no allocations on hosted today).
update public.lms_unit_students set batch_id = null where batch_id is null;

-- Students see / are listed for their own batch's classes only.
select pg_temp.fpatch('my_class_schedule', 'e.status in (''active'', ''deferred'') and (cs.unit_id is null or exists',
  'e.status in (''active'', ''deferred'') and public.enrolment_in_session(e.id, cs.batch_id, cs.unit_id) and (cs.unit_id is null or exists');
select pg_temp.fpatch('admin_student_schedule', 'e.status in (''active'', ''deferred'') and (cs.unit_id is null or exists',
  'e.status in (''active'', ''deferred'') and public.enrolment_in_session(e.id, cs.batch_id, cs.unit_id) and (cs.unit_id is null or exists');
select pg_temp.fpatch('admin_class_session_students', 'e.status in (''active'', ''deferred'') and (cs.unit_id is null or exists',
  'e.status in (''active'', ''deferred'') and public.enrolment_in_session(e.id, cs.batch_id, cs.unit_id) and (cs.unit_id is null or exists');
select pg_temp.fpatch('enrolment_class_slots', 'cs.intake_id = e.intake_id and cs.unit_id = u.unit_id',
  'cs.intake_id = e.intake_id and cs.unit_id = u.unit_id and public.enrolment_in_session(e.id, cs.batch_id, cs.unit_id)');

commit;
