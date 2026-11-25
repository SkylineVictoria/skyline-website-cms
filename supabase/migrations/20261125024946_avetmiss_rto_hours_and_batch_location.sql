-- Pulled from hosted supabase_migrations.schema_migrations (applied on hosted by another session without a repo file; 2026-11-25).
-- 1. Unit hours: AVETMISS NAT00060 reports the RTO's own hours (cms_course_units.slit_hours), not the national list.
alter table public.cms_course_units
  add column avetmiss_nominal_hours integer generated always as (slit_hours) stored;
comment on column public.cms_course_units.slit_hours is 'Your RTO hours: the organisation''s own total hours for the unit (theory + practical + assessment). This is what AVETMISS reports.';
comment on column public.cms_course_units.avetmiss_nominal_hours is 'NAT00060 nominal hours = your RTO hours (slit_hours). Never the national list.';
comment on column public.cms_course_units.nominal_hours is 'Reference only: NCVER nationally agreed hours. Not reported; AVETMISS uses your RTO hours.';

create or replace function public.rto_unit_hours_save(p_unit_id text, p_slit integer, p_theory integer, p_practical integer, p_assessment integer)
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare u public.cms_course_units;
begin
  if not public.cms_is_rto_manager() then raise exception 'Only an RTO Manager can set unit hours.' using errcode = '42501'; end if;
  if p_slit is null or p_theory is null or p_practical is null or p_assessment is null then
    raise exception 'Enter your RTO hours, theory, practical and assessment hours.' using errcode = '22023'; end if;
  if p_slit < 0 or p_theory < 0 or p_practical < 0 or p_assessment < 0 then
    raise exception 'Hours cannot be negative.' using errcode = '22023'; end if;
  if p_slit = 0 then
    raise exception 'Your RTO hours must be more than 0 (they are reported to NCVER).' using errcode = '22023'; end if;
  if p_theory + p_practical + p_assessment <> p_slit then
    raise exception 'Theory, practical and assessment hours must add up to your RTO hours (%).', p_slit using errcode = '22023'; end if;
  update public.cms_course_units set slit_hours = p_slit, theory_hours = p_theory, practical_hours = p_practical,
    assessment_hours = p_assessment, hours_confirmed_at = now(), hours_confirmed_by = auth.uid()
   where id = p_unit_id returning * into u;
  if not found then raise exception 'Unit not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object('unitId', u.id, 'slitHours', u.slit_hours, 'theoryHours', u.theory_hours,
    'practicalHours', u.practical_hours, 'assessmentHours', u.assessment_hours, 'confirmedAt', u.hours_confirmed_at);
end;
$function$;

-- 2. Unit results: location comes from the student's batch room; RTO hours must be set before a unit is delivered.
alter table public.lms_unit_students
  add column location_is_auto boolean not null default false;
comment on column public.lms_unit_students.location_is_auto is 'true = location_id was taken from the student''s batch room; it follows batch changes until staff set it by hand.';

-- The location of the batch a student is in for a unit (unit-specific batch first, then whole-course batch)
create or replace function public.avetmiss_batch_location(p_intake uuid, p_student uuid, p_unit text)
returns uuid language sql stable security definer set search_path = public as $$
  select c.location_id
    from intake_enrolments e
    join batch_students bs on bs.enrolment_id = e.id and bs.archived_at is null
                          and (bs.unit_id = p_unit or bs.unit_id is null)
    join intake_batches b on b.id = bs.batch_id and b.archived_at is null
    join classrooms c on c.id = b.room_id
   where e.intake_id = p_intake and e.student_id = p_student and c.location_id is not null
   order by (bs.unit_id is not null) desc, bs.assigned_at desc nulls last
   limit 1;
$$;
revoke all on function public.avetmiss_batch_location(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.lms_unit_students_avetmiss()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_loc uuid;
begin
  -- Staff picked a location by hand: stop following the batch
  if tg_op = 'UPDATE' and new.location_id is distinct from old.location_id and new.location_is_auto is not distinct from old.location_is_auto then
    new.location_is_auto := false;
  end if;
  if new.location_id is null or new.location_is_auto then
    v_loc := avetmiss_batch_location(new.intake_id, new.student_id, new.unit_id);
    if v_loc is not null then new.location_id := v_loc; new.location_is_auto := true; end if;
  end if;
  if tg_op = 'INSERT' and not exists (select 1 from cms_course_units u where u.id = new.unit_id and coalesce(u.slit_hours, 0) > 0) then
    raise exception 'Set your RTO hours for unit % before students are enrolled in it (they are reported to NCVER).',
      (select code from cms_course_units where id = new.unit_id) using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger lms_unit_students_avetmiss
  before insert or update on public.lms_unit_students
  for each row execute function public.lms_unit_students_avetmiss();

-- When a student is placed in or moved between batches, their units follow (unless staff set the location by hand)
create or replace function public.batch_students_avetmiss_location()
returns trigger language plpgsql security definer set search_path = public as $$
declare e record;
begin
  select intake_id, student_id into e from intake_enrolments where id = coalesce(new.enrolment_id, old.enrolment_id);
  if e.intake_id is null then return null; end if;
  update lms_unit_students u
     set location_id = coalesce(avetmiss_batch_location(u.intake_id, u.student_id, u.unit_id), u.location_id),
         location_is_auto = true
   where u.intake_id = e.intake_id and u.student_id = e.student_id
     and (u.location_id is null or u.location_is_auto)
     and (coalesce(new.unit_id, old.unit_id) is null or u.unit_id = coalesce(new.unit_id, old.unit_id));
  return null;
end $$;
create trigger batch_students_avetmiss_location
  after insert or update or delete on public.batch_students
  for each row execute function public.batch_students_avetmiss_location();

-- A batch moved to another room: its students' units follow
create or replace function public.intake_batches_avetmiss_location()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update lms_unit_students u
     set location_id = coalesce(avetmiss_batch_location(u.intake_id, u.student_id, u.unit_id), u.location_id),
         location_is_auto = true
   where u.location_is_auto
     and exists (select 1 from batch_students bs join intake_enrolments e on e.id = bs.enrolment_id
                  where bs.batch_id = new.id and e.intake_id = u.intake_id and e.student_id = u.student_id);
  return null;
end $$;
create trigger intake_batches_avetmiss_location
  after update of room_id on public.intake_batches
  for each row when (new.room_id is distinct from old.room_id)
  execute function public.intake_batches_avetmiss_location();

revoke all on function public.lms_unit_students_avetmiss(), public.batch_students_avetmiss_location(), public.intake_batches_avetmiss_location() from public, anon, authenticated;
