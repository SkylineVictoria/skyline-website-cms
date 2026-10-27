create or replace function public.portal_validate_submission(p_application_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare a public.enrollment_applications; s jsonb; f jsonb; vals jsonb; field_value jsonb; category text; label text;
begin
 select * into a from public.enrollment_applications where id=p_application_id;
 vals:=coalesce(a.data->'values','{}');
 for s in select value from jsonb_array_elements(public.portal_required_schema()) loop
  if not public.portal_condition_met(s->'showIf',vals) then continue; end if;
  for f in select value from jsonb_array_elements(s->'fields') loop
   if not public.portal_condition_met(f->'showIf',vals) then continue; end if;
   label:=f->>'name';field_value:=vals->label;
   if f->>'type'='file' then
    category:=case label when 'passport_copy' then 'Passport' when 'visa_copy' then 'Visa' when 'english_upload' then 'English Test' when 'academic_upload' then 'Academic' end;
    if category is null or not exists(select 1 from public.enrollment_application_documents d join storage.objects o on o.bucket_id=d.bucket_name and o.name=d.storage_path
     where d.application_id=a.id and d.category=category and d.is_current) then
     raise exception 'Required document missing: %',label using errcode='22023'; end if;
   elsif f->>'type'='checkbox' then
    if jsonb_typeof(field_value) is distinct from 'array' or jsonb_array_length(field_value)=0 then raise exception 'Required selection missing: %',label using errcode='22023'; end if;
    if label='courses_of_interest' then
     if not exists(select 1 from public.enrollment_application_courses where application_id=a.id) then raise exception 'Select an institution course' using errcode='22023'; end if;
    elsif f ? 'options' then
     if exists(select 1 from jsonb_array_elements_text(field_value) v where not (f->'options' ? v)) then raise exception 'Invalid selection: %',label using errcode='22023'; end if;
    end if;
   elsif nullif(btrim(field_value#>>'{}'),'') is null then raise exception 'Required field missing: %',label using errcode='22023';
   elsif f->>'type' in ('select','radio') and f ? 'options' and label<>'agent_agency' and not(f->'options' ? (field_value#>>'{}')) then
    raise exception 'Invalid option: %',label using errcode='22023';
   elsif f->>'type'='date' then
    begin perform (field_value#>>'{}')::date; exception when others then raise exception 'Invalid date: %',label using errcode='22023'; end;
   elsif f->>'type'='email' and (field_value#>>'{}') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid email: %',label using errcode='22023';
   end if;
  end loop;
 end loop;
 if vals->>'email' is distinct from vals->>'confirm_email' then raise exception 'Email confirmation does not match' using errcode='22023'; end if;
 if a.tenant_id is not null and exists(select 1 from public.enrollment_application_courses c left join public.cms_courses cc on cc.id=c.course_id and cc.tenant_id=a.tenant_id and cc.status='Published'
  where c.application_id=a.id and cc.id is null) then raise exception 'Course is no longer published' using errcode='22023'; end if;
end; $$;
revoke all on function public.portal_validate_submission(uuid) from public,anon,authenticated,service_role;

