-- Pulled from hosted supabase_migrations.schema_migrations (applied on hosted by another session without a repo file; 2026-11-25).
-- A. Trainer results flow into AVETMISS (NAT00120 outcome)
create or replace function public.asm_outcome_to_avetmiss()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_day date := (new.signed_at at time zone public.institution_tz())::date;
begin
  update lms_unit_students u
     set outcome_code = case new.outcome when 'C' then '20' when 'NYC' then '30' end,
         outcome_recorded_at = now(),
         outcome_recorded_by = new.signed_by,
         actual_end_date = coalesce(u.actual_end_date, v_day),
         actual_start_date = coalesce(u.actual_start_date, least(u.assigned_start_date, v_day))
   where u.student_id = new.student_id and u.unit_id = new.unit_id
     and (new.intake_id is null or u.intake_id = new.intake_id)
     and coalesce(u.outcome_code, '') not in ('40','41','51','52','60');  -- never overwrite withdrawn, RPL or credit transfer
  return null;
end $$;
revoke all on function public.asm_outcome_to_avetmiss() from public, anon, authenticated;
create trigger asm_outcome_to_avetmiss
  after insert on public.asm_unit_outcomes
  for each row execute function public.asm_outcome_to_avetmiss();

-- B. Withdrawing an enrolment needs the date; started units without a result close as withdrawn (40) on that date
alter table public.intake_enrolments add column withdrawn_on date;
comment on column public.intake_enrolments.withdrawn_on is 'Date the student withdrew. Required when status = withdrawn; open units close as AVETMISS outcome 40 on this date.';

create or replace function public.intake_enrolments_withdrawal()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_when = 'BEFORE' then
    if new.status = 'withdrawn' and new.withdrawn_on is null then
      raise exception 'Enter the date the student withdrew. AVETMISS reports every unfinished unit as withdrawn on that date.'
        using errcode = 'check_violation';
    end if;
    if new.status is distinct from 'withdrawn' then new.withdrawn_on := null; end if;
    return new;
  end if;
  -- AFTER: close the units that had started and have no final result. Units not started by then are not reported.
  if new.status = 'withdrawn' then
    update lms_unit_students u
       set outcome_code = '40',
           actual_end_date = new.withdrawn_on,
           actual_start_date = coalesce(u.actual_start_date, u.assigned_start_date, new.withdrawn_on),
           outcome_recorded_at = now(),
           outcome_recorded_by = auth.uid()
     where u.intake_id = new.intake_id and u.student_id = new.student_id
       and (u.outcome_code is null or u.outcome_code in ('70','85'))
       and coalesce(u.actual_start_date, u.assigned_start_date, new.withdrawn_on) <= new.withdrawn_on;
  end if;
  return null;
end $$;
revoke all on function public.intake_enrolments_withdrawal() from public, anon, authenticated;
create trigger intake_enrolments_withdrawal_before
  before insert or update of status, withdrawn_on on public.intake_enrolments
  for each row execute function public.intake_enrolments_withdrawal();
create trigger intake_enrolments_withdrawal_after
  after update of status, withdrawn_on on public.intake_enrolments
  for each row when (new.status = 'withdrawn')
  execute function public.intake_enrolments_withdrawal();

-- C. A student can only be enrolled when their AVETMISS details are complete
create or replace function public.avetmiss_student_missing(p_student uuid)
returns text[] language plpgsql stable security definer set search_path = public as $$
declare s enrollment_students; d jsonb; m text[] := '{}'; v_overseas boolean;
begin
  select * into s from enrollment_students where id = p_student;
  if not found then return array['student record']; end if;
  d := coalesce(s.details, '{}'::jsonb);
  v_overseas := nullif(btrim(d->>'au_country'), '') is not null and lower(btrim(d->>'au_country')) not in ('australia', 'au');
  if nullif(btrim(d->>'dob'), '') is null then m := array_append(m, 'date of birth'); end if;
  if s.sex_code is null then m := array_append(m, 'gender'); end if;
  if s.birth_country_code is null then m := array_append(m, 'country of birth'); end if;
  if s.home_language_code is null then m := array_append(m, 'language spoken at home'); end if;
  if s.home_language_code is distinct from '1201' and s.english_proficiency_code is null then m := array_append(m, 'how well they speak English'); end if;
  if s.indigenous_status_code is null then m := array_append(m, 'Aboriginal or Torres Strait Islander status'); end if;
  if s.school_level_code is null then m := array_append(m, 'highest school level completed'); end if;
  if s.at_school_flag is null then m := array_append(m, 'still at secondary school'); end if;
  if s.labour_force_code is null then m := array_append(m, 'employment status'); end if;
  if s.disability_flag is null then m := array_append(m, 'disability (yes/no)'); end if;
  if s.disability_flag = 'Y' and not exists (select 1 from student_disabilities x where x.student_id = s.id) then m := array_append(m, 'disability type'); end if;
  if s.prior_education_flag is null then m := array_append(m, 'prior education (yes/no)'); end if;
  if s.prior_education_flag = 'Y' and not exists (select 1 from student_prior_education x where x.student_id = s.id) then m := array_append(m, 'prior qualifications'); end if;
  if nullif(btrim(d->>'usi_number'), '') is null
     and not exists (select 1 from application_usi u join enrollment_applications a on a.id = u.application_id where a.student_id = s.id) then
    m := array_append(m, 'USI'); end if;
  if not v_overseas then
    if nullif(btrim(d->>'au_suburb'), '') is null then m := array_append(m, 'residential suburb'); end if;
    if coalesce(btrim(d->>'au_zip'), '') !~ '^[0-9]{4}$' then m := array_append(m, 'residential postcode'); end if;
    if nullif(btrim(d->>'au_state'), '') is null then m := array_append(m, 'residential state'); end if;
  end if;
  return m;
end $$;
revoke all on function public.avetmiss_student_missing(uuid) from public, anon;
grant execute on function public.avetmiss_student_missing(uuid) to authenticated;
comment on function public.avetmiss_student_missing(uuid) is 'AVETMISS details still missing for a student (empty = complete). Use it in screens to show what to collect.';

create or replace function public.intake_enrolments_avetmiss_required()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_missing text[];
begin
  -- Study reason: from the enrolment, else from the student's application answer
  if new.study_reason_code is null then
    select avetmiss_code('study_reason', s.details->>'study_reason') into new.study_reason_code
      from enrollment_students s where s.id = new.student_id;
  end if;
  v_missing := avetmiss_student_missing(new.student_id);
  if new.study_reason_code is null then v_missing := array_append(v_missing, 'study reason'); end if;
  if array_length(v_missing, 1) > 0 then
    raise exception 'This student cannot be enrolled yet. AVETMISS details missing: %.', array_to_string(v_missing, ', ')
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function public.intake_enrolments_avetmiss_required() from public, anon, authenticated;
create trigger intake_enrolments_avetmiss_required
  before insert on public.intake_enrolments
  for each row execute function public.intake_enrolments_avetmiss_required();

-- D. Payments link to their student automatically (TPS)
create or replace function public.payments_link_student()
returns trigger language plpgsql security definer set search_path = public, hr as $$
begin
  if new.student_id is null and new.subject_type = 'sign_request' then
    select coalesce(a.student_id, case when sr.subject_type = 'student' then es.id end)
      into new.student_id
      from hr.sign_requests sr
      left join enrollment_offer_letters ol on ol.id = sr.offer_letter_id
      left join enrollment_applications a on a.id = ol.application_id
      left join enrollment_students es on es.id = sr.subject_id
     where sr.id = new.subject_id;
  end if;
  return new;
end $$;
revoke all on function public.payments_link_student() from public, anon, authenticated;
create trigger payments_link_student
  before insert or update on public.payments
  for each row execute function public.payments_link_student();

update public.payments set student_id = student_id where student_id is null;
