-- Pulled from hosted supabase_migrations.schema_migrations (applied on hosted by another session without a repo file; 2026-11-25).
-- NAT00060: subjects / units
alter table public.cms_course_units
  add column field_of_education_code text check (field_of_education_code ~ '^[0-9]{6}$'),
  add column vet_flag boolean not null default true;
comment on column public.cms_course_units.field_of_education_code is 'NAT00060 subject field of education identifier (6-digit ASCED).';

-- NAT00120: one row per student per unit = the AVETMISS training activity record
alter table public.lms_unit_students
  add column actual_start_date date,
  add column actual_end_date date,
  add column outcome_code text check (public.avetmiss_is_code('outcome', outcome_code)),
  add column outcome_recorded_at timestamptz,
  add column outcome_recorded_by uuid,
  add column delivery_mode_identifier text check (delivery_mode_identifier ~ '^[YN]{3}$'),
  add column predominant_delivery_mode text check (public.avetmiss_is_code('predominant_delivery_mode', predominant_delivery_mode)),
  add column location_id uuid references public.locations(id) on delete restrict,
  add column funding_source_code text check (public.avetmiss_is_code('funding_source', funding_source_code)),
  add column outcome_evidence_note text check (char_length(outcome_evidence_note) <= 2000),
  add column outcome_evidence_path text,
  add constraint lms_unit_students_withdrawal_date check (outcome_code is distinct from '40' or actual_end_date is not null),
  add constraint lms_unit_students_dates_order check (actual_end_date is null or actual_start_date is null or actual_end_date >= actual_start_date);
comment on column public.lms_unit_students.delivery_mode_identifier is 'NAT00120 delivery mode: three Y/N flags for internal, external and workplace-based delivery (e.g. YNN = classroom).';
comment on column public.lms_unit_students.outcome_code is 'AVETMISS outcome identifier – national: 20 C, 30 NYC, 40 withdrawn (needs actual_end_date), 51/52 RPL, 60 credit transfer, 70 continuing, 85 not yet started.';
create index lms_unit_students_location_idx on public.lms_unit_students (location_id);
create index lms_unit_students_outcome_idx on public.lms_unit_students (outcome_code);
