-- Domestic vs international comes from the passport (and a PR question for other passports)
alter table public.enrollment_students
  add column residency_status text check (residency_status in ('australian_citizen','nz_citizen','permanent_resident','international'));
comment on column public.enrollment_students.residency_status is 'From the passport scan: Australian passport -> australian_citizen, NZ -> nz_citizen, other passport + "Australian permanent resident: Yes" -> permanent_resident, otherwise international. Domestic = the first three.';

create or replace function public.enrollment_students_residency()
returns trigger language plpgsql set search_path = public as $$
declare d jsonb := coalesce(new.details, '{}'::jsonb); v_country text;
begin
  if tg_op = 'INSERT' or new.details is distinct from old.details then
    v_country := coalesce(avetmiss_code('country', d->>'issuing_country'), avetmiss_code('country', d->>'citizenship'));
    new.residency_status := case
      when v_country = '1101' then 'australian_citizen'
      when v_country = '1201' then 'nz_citizen'
      when lower(btrim(coalesce(d->>'au_permanent_resident', ''))) = 'yes' then 'permanent_resident'
      when v_country is not null then 'international'
      else new.residency_status end;
  end if;
  return new;
end $$;
create trigger avetmiss_residency
  before insert or update on public.enrollment_students
  for each row execute function public.enrollment_students_residency();

update public.enrollment_students set residency_status = case
  when coalesce(avetmiss_code('country', details->>'issuing_country'), avetmiss_code('country', details->>'citizenship')) = '1101' then 'australian_citizen'
  when coalesce(avetmiss_code('country', details->>'issuing_country'), avetmiss_code('country', details->>'citizenship')) = '1201' then 'nz_citizen'
  when lower(btrim(coalesce(details->>'au_permanent_resident', ''))) = 'yes' then 'permanent_resident'
  when coalesce(avetmiss_code('country', details->>'issuing_country'), avetmiss_code('country', details->>'citizenship')) is not null then 'international'
  end;

-- Placement: a domestic student is always Domestic (the CoE default is corrected); an international student can't be placed as Domestic
create or replace function public.intake_enrolments_residency_type()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_res text;
begin
  select residency_status into v_res from enrollment_students where id = new.student_id;
  if v_res in ('australian_citizen','nz_citizen','permanent_resident') and new.enrolment_type in ('CoE','VoE') then
    new.enrolment_type := 'Domestic';
    new.funding_source_code := null;          -- re-derived as 20 by the funding default
  elsif v_res = 'international' and new.enrolment_type = 'Domestic' then
    raise exception 'This student is not an Australian or New Zealand citizen or Australian permanent resident, so they must be placed as CoE or VoE, not Domestic.'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function public.intake_enrolments_residency_type() from public, anon, authenticated;
create trigger avetmiss_a_residency_type
  before insert or update of enrolment_type, student_id on public.intake_enrolments
  for each row execute function public.intake_enrolments_residency_type();