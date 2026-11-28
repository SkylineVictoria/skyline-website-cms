-- STUDENT-PHONE-OPTIONAL (owner, 2026-11-28: "adding a student still asks the phone number; we decided it is optional and not shown").
-- 1. portal_student_save (Add student for admins and agents): the mobile may be empty (stored as null); a given one is still checked for
--    a duplicate as before.
-- 2. The submission check and the application progress: the mobile is required only when SLIT publishes the rule
--    admissions.application_mobile_required as true (it was never published; its unpublished default is now false, not true).
begin;

create or replace function pg_temp.ph_patch(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_fn);
begin
  if position(p_from in v_def) = 0 then
    if position(p_to in v_def) > 0 then return; end if; -- already patched (a re-run)
    raise exception 'STUDENT-PHONE-OPTIONAL patch: % does not contain %', p_fn, p_from;
  end if;
  execute replace(v_def, p_from, p_to);
end $$;

select pg_temp.ph_patch('public.portal_student_save(uuid,uuid,text,text,text,date,text,text,text,text)'::regprocedure,
  $f$ if v_email = '' or v_phone = '' then raise exception 'Enter the student''s email and mobile' using errcode = '22023'; end if;$f$,
  $t$ if v_email = '' then raise exception 'Enter the student''s email' using errcode = '22023'; end if;$t$);
select pg_temp.ph_patch('public.portal_student_save(uuid,uuid,text,text,text,date,text,text,text,text)'::regprocedure,
  $f$ if exists (select 1 from public.enrollment_students x where public.student_phone_key(x.phone) = public.student_phone_key(v_phone)) then$f$,
  $t$ if v_phone <> '' and exists (select 1 from public.enrollment_students x where public.student_phone_key(x.phone) = public.student_phone_key(v_phone)) then$t$);
select pg_temp.ph_patch('public.portal_student_save(uuid,uuid,text,text,text,date,text,text,text,text)'::regprocedure,
  $f$ v_details := jsonb_build_object('email', v_email, 'confirm_email', v_email, 'mobile', v_phone);$f$,
  $t$ v_details := jsonb_build_object('email', v_email, 'confirm_email', v_email) || case when v_phone <> '' then jsonb_build_object('mobile', v_phone) else '{}'::jsonb end;$t$);
select pg_temp.ph_patch('public.portal_student_save(uuid,uuid,text,text,text,date,text,text,text,text)'::regprocedure,
  $f$ values (g.business_id, v_tenant, g.id, v_name, v_email, v_phone, p_date_of_birth,$f$,
  $t$ values (g.business_id, v_tenant, g.id, v_name, v_email, nullif(v_phone, ''), p_date_of_birth,$t$);

select pg_temp.ph_patch('public.portal_validate_submission(uuid)'::regprocedure,
  $f$public.rule_bool('admissions.application_mobile_required', true)$f$, $t$public.rule_bool('admissions.application_mobile_required', false)$t$);
select pg_temp.ph_patch('skyline_private.wizard_application_progress(uuid)'::regprocedure,
  $f$public.rule_bool('admissions.application_mobile_required', true)$f$, $t$public.rule_bool('admissions.application_mobile_required', false)$t$);

-- The unpublished draft of the rule shows the owner's decision (it stays a draft: SLIT publishes it to make the mobile required again).
update public.business_rule_versions v set definition = jsonb_set(v.definition, '{value}', 'false'::jsonb)
  from public.business_rules r where r.id = v.rule_id and r.identifier = 'admissions.application_mobile_required' and v.state = 'draft' and v.published_at is null;

commit;
