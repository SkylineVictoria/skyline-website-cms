-- APPLICATION-PROGRESS-AGENTS (owner 2026-11-27): the agent's "Application not yet signed" panel showed "Application progress could not
-- be loaded": skyline_private.wizard_application_progress caught only sqlstate 22023 from portal_validate_submission, so any other
-- refusal there (for example "Only the student can submit this application" for an agent) failed the whole progress read.
--   * wizard_application_progress: any refusal of the submission check means "not ready" (never an error); it also returns
--     agentComplete = every required answer is filled except the student's own declaration and signature (declaration,
--     declaration_name, digital_signature, declaration_date, any terms field), so the agent may send it to the student to sign;
--   * portal_wizard_invitation_status passes agentComplete on (same access rule as before).
-- Down: re-run the two functions from 20261127150517_student_documents.sql / 20261123165538_student_application_wizard.sql.
begin;

CREATE OR REPLACE FUNCTION skyline_private.wizard_application_progress(p_application uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  values_map jsonb := public.application_values(p_application);
  section jsonb;
  field jsonb;
  field_name text;
  field_value jsonb;
  category text;
  done int := 0;
  applicable int := 0;
  agent_missing int := 0;
  filled boolean;
  ready boolean := false;
begin
  for section in select value from jsonb_array_elements(public.portal_required_schema()) loop
    if not public.portal_condition_met(section->'showIf', values_map) then continue; end if;
    for field in select value from jsonb_array_elements(section->'fields') loop
      field_name := field->>'name';
      if not public.portal_condition_met(field->'showIf', values_map) or public.admissions_field_optional(field_name)
         or (field_name = 'mobile' and not public.rule_bool('admissions.application_mobile_required', true)) then continue; end if;
      applicable := applicable + 1;
      field_value := values_map->field_name;
      if field->>'type' = 'file' then
        category := case field_name when 'passport_copy' then 'Passport' when 'visa_copy' then 'Visa'
          when 'english_upload' then 'English Test' when 'academic_upload' then 'Academic' end;
        filled := exists(select 1 from public.enrollment_application_documents d join storage.objects o
          on o.bucket_id = d.bucket_name and o.name = d.storage_path where d.id in (select public.application_document_ids(p_application))
          and d.category = category and d.is_current);
      elsif field_name = 'courses_of_interest' then
        filled := exists(select 1 from public.enrollment_application_courses c where c.application_id = p_application);
      elsif jsonb_typeof(field_value) = 'array' then
        filled := jsonb_array_length(field_value) > 0;
      else
        filled := nullif(btrim(field_value #>> '{}'), '') is not null;
      end if;
      if filled then done := done + 1;
      elsif not (field->>'type' = 'terms' or field_name in ('declaration', 'declaration_name', 'digital_signature', 'declaration_date')) then
        agent_missing := agent_missing + 1;
      end if;
    end loop;
  end loop;
  begin
    perform public.portal_validate_submission(p_application);
    ready := true;
  exception when others then
    ready := false;
  end;
  return jsonb_build_object('completion', case when applicable = 0 then 0 else least(99, round(100.0 * done / applicable)) end,
    'ready', ready, 'agentComplete', applicable > 0 and agent_missing = 0, 'agentMissing', agent_missing);
end;
$function$;

create or replace function public.portal_wizard_invitation_status(p_application uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('invitationStatus', coalesce(
    case when i.state in ('sent','sending') and i.expires_at <= statement_timestamp() then 'Expired'
      when i.state = 'sent' and exists(select 1 from skyline_private.student_application_invites old
       where old.application_id = a.id and old.id <> i.id and old.sent_at is not null) then 'Resent'
      when i.state = 'revoked' then 'Expired'
      else initcap(i.state) end, 'Not Sent'),
    'updatedBy', coalesce(nullif(p.full_name, ''), u.email, ''),
    'lastStep', a.data#>>'{wizard,activeStep}', 'lastSaved', coalesce(a.data->>'savedAt', a.updated_at::text),
    'completion', case when a.submitted_at is not null then to_jsonb(100) else progress.result->'completion' end,
    'agentComplete', case when a.submitted_at is not null then true else coalesce((progress.result->>'agentComplete')::boolean, false) end,
    'agentMissing', coalesce((progress.result->>'agentMissing')::int, 0),
    'status', case when a.submitted_at is not null then 'Submitted'
      when progress.result->'ready' = 'true' then 'Ready for Submission'
      when a.data ? 'savedAt' then 'In Progress' else 'Draft' end)
  from public.enrollment_applications a
  left join lateral (select * from skyline_private.student_application_invites x
    where x.application_id = a.id order by x.created_at desc, x.id desc limit 1) i on true
  left join auth.users u on u.id::text = a.data->>'preparedBy'
  left join public.portal_profiles p on p.auth_user_id = u.id
  cross join lateral (select skyline_private.wizard_application_progress(a.id) result
    where auth.uid() is not null and public.portal_can_access_application(a.id)) progress
  where a.id = p_application and auth.uid() is not null and public.portal_can_access_application(a.id);
$$;
revoke all on function public.portal_wizard_invitation_status(uuid) from public, anon, authenticated;
grant execute on function public.portal_wizard_invitation_status(uuid) to authenticated;

commit;
