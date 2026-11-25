-- STUDY-REASON-FROM-APPLICATION (owner 2026-11-25): Activate in an intake refused "AVETMISS details missing: study reason"
-- although the application answered it. Two causes:
-- * the enrolment check (intake_enrolments_avetmiss_required, 20261125025533) read the answer only from the student record
--   (enrollment_students.details), but the wizard saves it on the application (data.values.study_reason);
-- * two of the form's labels carry old numbers: "For personal interest or self-development - 09" is AVETMISS 12 and
--   "To get skills for community/voluntary work - 10" is AVETMISS 13, so avetmiss_code() found no code for them.
-- Now: those labels are aliases of 12 / 13 (the other form labels already end in their AVETMISS code), and the enrolment takes
-- the study reason from the student record, else from the student's latest application that answered it.
-- Down: delete the two aliases; re-run intake_enrolments_avetmiss_required from 20261125025533.
begin;

insert into public.avetmiss_code_aliases (code_set, alias, code) values
  ('study_reason', 'for personal interest or self-development - 09', '12'),
  ('study_reason', 'for personal interest or self-development', '12'),
  ('study_reason', 'to get skills for community/voluntary work - 10', '13'),
  ('study_reason', 'to get skills for community/voluntary work', '13')
on conflict (code_set, alias) do update set code = excluded.code;

create or replace function public.intake_enrolments_avetmiss_required()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_missing text[];
begin
  -- Study reason: from the enrolment, else the student's record, else the student's latest application that answered it.
  if new.study_reason_code is null then
    select avetmiss_code('study_reason', s.details->>'study_reason') into new.study_reason_code
      from enrollment_students s where s.id = new.student_id;
  end if;
  if new.study_reason_code is null then
    select avetmiss_code('study_reason', a.data #>> '{values,study_reason}') into new.study_reason_code
      from enrollment_applications a
     where a.student_id = new.student_id and nullif(btrim(a.data #>> '{values,study_reason}'), '') is not null
     order by a.updated_at desc nulls last, a.created_at desc
     limit 1;
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

commit;
