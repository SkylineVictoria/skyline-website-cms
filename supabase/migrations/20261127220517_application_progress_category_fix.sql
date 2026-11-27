-- APPLICATION-PROGRESS-CATEGORY (owner 2026-11-27): "Application progress could not be loaded: column reference "category" is
-- ambiguous". skyline_private.wizard_application_progress had a variable named category next to enrollment_application_documents.category
-- (the bug was already in 20261127150517 and was copied into 20261127200517): the variable is renamed v_category; nothing else changes.
-- Down: re-run the function from 20261127200517_application_progress_for_agents.sql.
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
  v_category text;
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
        v_category := case field_name when 'passport_copy' then 'Passport' when 'visa_copy' then 'Visa'
          when 'english_upload' then 'English Test' when 'academic_upload' then 'Academic' end;
        filled := exists(select 1 from public.enrollment_application_documents d join storage.objects o
          on o.bucket_id = d.bucket_name and o.name = d.storage_path where d.id in (select public.application_document_ids(p_application))
          and d.category = v_category and d.is_current);
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

commit;
