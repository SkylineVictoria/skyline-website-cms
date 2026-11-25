-- FUNDING-ONSHORE-ONLY (owner, 2026-11-25): SLIT trains in house only, so every international (visa holder) enrolment is an
-- onshore client: AVETMISS funding source 31. Code 32 (International offshore client) is switched off: hidden from every
-- dropdown (avetmissOptions shows active codes only) and refused by the database on enrolments and unit enrolments.
-- None of either table held 32 when this was written (checked on hosted 2026-11-25).

update public.avetmiss_codes set is_active = false
 where code_set = 'funding_source' and code = '32';

alter table public.intake_enrolments
  add constraint intake_enrolments_funding_onshore_only check (funding_source_code is distinct from '32');
comment on constraint intake_enrolments_funding_onshore_only on public.intake_enrolments is
  'SLIT trains in house only: AVETMISS funding source 32 (International offshore client) is never used; visa holders are 31.';

alter table public.lms_unit_students
  add constraint lms_unit_students_funding_onshore_only check (funding_source_code is distinct from '32');
comment on constraint lms_unit_students_funding_onshore_only on public.lms_unit_students is
  'SLIT trains in house only: AVETMISS funding source 32 (International offshore client) is never used; visa holders are 31.';
