-- Pulled from hosted supabase_migrations.schema_migrations (applied on hosted by another session without a repo file; 2026-11-25).
-- NAT00080 / NAT00085 / NAT00090 / NAT00100 student data, stored as AVETMISS codes
create sequence public.student_number_seq start 1;

alter table public.enrollment_students
  add column student_number text check (student_number ~ '^[A-Za-z0-9]{1,10}$'),
  add column sex_code text check (public.avetmiss_is_code('sex', sex_code)),
  add column birth_country_code text check (birth_country_code ~ '^([0-9]{4}|@@@@)$'),
  add column home_language_code text check (home_language_code ~ '^([0-9]{4}|@@@@)$'),
  add column english_proficiency_code text check (public.avetmiss_is_code('english_proficiency', english_proficiency_code)),
  add column indigenous_status_code text check (public.avetmiss_is_code('indigenous_status', indigenous_status_code)),
  add column school_level_code text check (public.avetmiss_is_code('school_level', school_level_code)),
  add column school_level_year text check (school_level_year ~ '^([0-9]{4}|@@@@)$'),
  add column labour_force_code text check (public.avetmiss_is_code('labour_force', labour_force_code)),
  add column disability_flag text check (public.avetmiss_is_code('flag', disability_flag)),
  add column prior_education_flag text check (public.avetmiss_is_code('flag', prior_education_flag)),
  add column at_school_flag text check (public.avetmiss_is_code('flag', at_school_flag));

create unique index enrollment_students_student_number_key on public.enrollment_students (upper(student_number));
comment on column public.enrollment_students.student_number is 'NAT00080 Client identifier: permanent, never reused. New students get SK + 8 digits; students imported from aXcelerate keep their aXcelerate client ID so NCVER sees the same person across years.';
comment on column public.enrollment_students.birth_country_code is 'SACC 4-digit code (loaded from ABS). Until then derived only when the form value carries the code.';
comment on column public.enrollment_students.home_language_code is 'ASCL 4-digit code; 1201 = English only.';

create or replace function public.enrollment_students_avetmiss()
returns trigger language plpgsql set search_path = public as $$
declare d jsonb := coalesce(new.details, '{}'::jsonb);
begin
  -- Student number: assigned once, then permanent
  if tg_op = 'INSERT' then
    if new.student_number is null then
      new.student_number := 'SK' || lpad(nextval('public.student_number_seq')::text, 8, '0');
    end if;
  elsif old.student_number is not null and new.student_number is distinct from old.student_number
        and coalesce(current_setting('skyline.allow_student_number_change', true), '') <> 'on' then
    raise exception 'The student number % is permanent and cannot be changed', old.student_number
      using errcode = 'check_violation';
  elsif old.student_number is null and new.student_number is null then
    new.student_number := 'SK' || lpad(nextval('public.student_number_seq')::text, 8, '0');
  end if;

  -- AVETMISS codes from the enrolment form answers
  if tg_op = 'INSERT' or new.details is distinct from old.details then
    new.sex_code               := coalesce(avetmiss_code('sex', d->>'gender'), new.sex_code);
    new.indigenous_status_code := coalesce(avetmiss_code('indigenous_status', d->>'atsi'), new.indigenous_status_code);
    new.school_level_code      := coalesce(avetmiss_code('school_level', d->>'school_level'), new.school_level_code);
    new.labour_force_code      := coalesce(avetmiss_code('labour_force', d->>'employment'), new.labour_force_code);
    new.disability_flag        := coalesce(avetmiss_code('flag', d->>'disability'), new.disability_flag);
    new.prior_education_flag   := coalesce(avetmiss_code('flag', d->>'prior_ed'), new.prior_education_flag);
    new.at_school_flag         := coalesce(avetmiss_code('flag', d->>'secondary_enrolled'), new.at_school_flag);
    new.home_language_code     := coalesce(avetmiss_code('language', d->>'language_home'), new.home_language_code);
    new.birth_country_code     := coalesce(avetmiss_code('country', d->>'birth_country'), new.birth_country_code);
    if btrim(coalesce(d->>'year_completed', '')) ~ '^[0-9]{4}$' then
      new.school_level_year := btrim(d->>'year_completed');
    end if;
  end if;
  return new;
end $$;

create trigger avetmiss_student_codes
  before insert or update on public.enrollment_students
  for each row execute function public.enrollment_students_avetmiss();

-- Backfill existing students (fires the trigger)
update public.enrollment_students set details = details;
update public.enrollment_students set student_number = student_number where student_number is null;

-- NAT00090: disability types (only when disability_flag = Y)
create table public.student_disabilities (
  student_id uuid not null references public.enrollment_students(id) on delete cascade,
  disability_type_code text not null check (public.avetmiss_is_code('disability_type', disability_type_code)),
  created_at timestamptz not null default now(),
  primary key (student_id, disability_type_code)
);

-- NAT00100: prior educational achievement
create table public.student_prior_education (
  student_id uuid not null references public.enrollment_students(id) on delete cascade,
  prior_education_code text not null check (public.avetmiss_is_code('prior_education', prior_education_code)),
  recognition_code text not null check (public.avetmiss_is_code('prior_education_recognition', recognition_code)),
  qualification_name text check (char_length(qualification_name) <= 200),
  created_at timestamptz not null default now(),
  primary key (student_id, prior_education_code, recognition_code)
);

alter table public.student_disabilities enable row level security;
alter table public.student_prior_education enable row level security;

-- Visible to whoever can see the student; written by SLIT staff and admins
create policy student_disabilities_read on public.student_disabilities for select
  using (exists (select 1 from public.enrollment_students s where s.id = student_id));
create policy student_disabilities_write on public.student_disabilities for all
  using (public.cms_is_staff() or public.portal_is_slit_admin())
  with check (public.cms_is_staff() or public.portal_is_slit_admin());
create policy student_prior_education_read on public.student_prior_education for select
  using (exists (select 1 from public.enrollment_students s where s.id = student_id));
create policy student_prior_education_write on public.student_prior_education for all
  using (public.cms_is_staff() or public.portal_is_slit_admin())
  with check (public.cms_is_staff() or public.portal_is_slit_admin());

-- Study reason and funding source belong to each course enrolment (NAT00120)
alter table public.intake_enrolments
  add column study_reason_code text check (public.avetmiss_is_code('study_reason', study_reason_code)),
  add column funding_source_code text check (public.avetmiss_is_code('funding_source', funding_source_code));

create or replace function public.intake_enrolments_funding_default()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.funding_source_code is null then
    new.funding_source_code := case when new.enrolment_type in ('CoE','VoE') then '31'
                                    when new.enrolment_type = 'Domestic' then '20' end;
  end if;
  return new;
end $$;
create trigger avetmiss_funding_default
  before insert or update of enrolment_type, funding_source_code on public.intake_enrolments
  for each row execute function public.intake_enrolments_funding_default();
