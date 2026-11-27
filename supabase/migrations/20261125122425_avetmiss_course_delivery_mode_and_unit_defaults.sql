-- Restored 2026-11-26 from hosted supabase_migrations.schema_migrations (version 20261125122425, applied on hosted 2026-11-25 by
-- another session without a repo file). Statements verbatim: hosted md5 of the joined statements = 0e468394155f7bf0a33878092d124197.
-- 1. Delivery mode is set on the course at onboarding (NAT00120 delivery mode identifier + predominant delivery mode)
alter table public.cms_courses
  add column delivery_mode_identifier text check (delivery_mode_identifier ~ '^[YN]{3}$' and delivery_mode_identifier <> 'NNN'),
  add column predominant_delivery_mode text check (predominant_delivery_mode in ('I','E','W')),
  add constraint cms_courses_predominant_mode_used check (
    predominant_delivery_mode is null or delivery_mode_identifier is null or
    substr(delivery_mode_identifier, case predominant_delivery_mode when 'I' then 1 when 'E' then 2 else 3 end, 1) = 'Y');
comment on column public.cms_courses.delivery_mode_identifier is 'AVETMISS delivery mode: 3 Y/N flags = classroom (internal), online/remote (external), workplace. e.g. YNN = classroom only, YYN = classroom + online.';
comment on column public.cms_courses.predominant_delivery_mode is 'Main way the course is delivered: I classroom, E online/remote, W workplace. Must be one of the modes ticked.';

create or replace function public.cms_courses_avetmiss_delivery()
returns trigger language plpgsql set search_path = public as $$
declare m text := lower(coalesce(new.mode, ''));
begin
  -- First time: read the existing "mode" text (Face to Face, Online, Blended, Workplace...)
  if new.delivery_mode_identifier is null and m <> '' then
    new.delivery_mode_identifier :=
      (case when m ~ '(face|class|campus|blend|mixed|on-?site)' then 'Y' else 'N' end) ||
      (case when m ~ '(online|distance|remote|blend|mixed|virtual)' then 'Y' else 'N' end) ||
      (case when m ~ '(workplace|work-based|work based|on-the-job|placement)' then 'Y' else 'N' end);
    if new.delivery_mode_identifier = 'NNN' then new.delivery_mode_identifier := null; end if;
  end if;
  if new.predominant_delivery_mode is null and new.delivery_mode_identifier is not null then
    new.predominant_delivery_mode := case when substr(new.delivery_mode_identifier, 1, 1) = 'Y' then 'I'
                                          when substr(new.delivery_mode_identifier, 2, 1) = 'Y' then 'E' else 'W' end;
  end if;
  -- A published course must say how it is delivered
  if new.status = 'Published' and (new.delivery_mode_identifier is null or new.predominant_delivery_mode is null) then
    raise exception 'Choose how this course is delivered (classroom, online and/or workplace, and which is the main one) before publishing it. It is reported to NCVER.'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger cms_courses_avetmiss_delivery
  before insert or update on public.cms_courses
  for each row execute function public.cms_courses_avetmiss_delivery();

update public.cms_courses set mode = mode where delivery_mode_identifier is null;

-- 2. Each student unit takes delivery mode from its course and funding source from the student's enrolment
create or replace function public.lms_unit_students_avetmiss()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_loc uuid; c record;
begin
  if tg_op = 'UPDATE' and new.location_id is distinct from old.location_id and new.location_is_auto is not distinct from old.location_is_auto then
    new.location_is_auto := false;
  end if;
  if new.location_id is null or new.location_is_auto then
    v_loc := avetmiss_batch_location(new.intake_id, new.student_id, new.unit_id);
    if v_loc is not null then new.location_id := v_loc; new.location_is_auto := true; end if;
  end if;

  -- RPL and credit transfer involve no delivery
  if new.outcome_code in ('51','52','60') then
    new.delivery_mode_identifier := 'NNN'; new.predominant_delivery_mode := 'N';
  elsif new.delivery_mode_identifier is null or new.predominant_delivery_mode is null
        or (tg_op = 'UPDATE' and old.outcome_code in ('51','52','60') and new.delivery_mode_identifier = 'NNN') then
    select delivery_mode_identifier, predominant_delivery_mode into c from cms_courses where id = new.course_id;
    new.delivery_mode_identifier := coalesce(case when new.delivery_mode_identifier = 'NNN' then null else new.delivery_mode_identifier end, c.delivery_mode_identifier);
    new.predominant_delivery_mode := coalesce(case when new.predominant_delivery_mode = 'N' then null else new.predominant_delivery_mode end, c.predominant_delivery_mode);
  end if;

  if new.funding_source_code is null then
    select e.funding_source_code into new.funding_source_code
      from intake_enrolments e where e.intake_id = new.intake_id and e.student_id = new.student_id
     order by e.created_at desc limit 1;
  end if;

  if tg_op = 'INSERT' and not exists (select 1 from cms_course_units u where u.id = new.unit_id and coalesce(u.slit_hours, 0) > 0) then
    raise exception 'Set your RTO hours for unit % before students are enrolled in it (they are reported to NCVER).',
      (select code from cms_course_units where id = new.unit_id) using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- If an enrolment's funding changes (e.g. CoE -> Domestic), its units follow
create or replace function public.intake_enrolments_funding_to_units()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update lms_unit_students set funding_source_code = new.funding_source_code
   where intake_id = new.intake_id and student_id = new.student_id
     and funding_source_code is distinct from new.funding_source_code;
  return null;
end $$;
revoke all on function public.intake_enrolments_funding_to_units() from public, anon, authenticated;
create trigger intake_enrolments_funding_to_units
  after update of funding_source_code on public.intake_enrolments
  for each row when (new.funding_source_code is distinct from old.funding_source_code)
  execute function public.intake_enrolments_funding_to_units();
