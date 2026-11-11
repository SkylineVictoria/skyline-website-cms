-- Course intakes (owner brief 2026-11-11, INT-01, part 2 of 2). Release ONLY after the owner confirms real intakes exist on hosted
-- (20261113200000 and the staff Intakes screen first), together with the enrolment form that shows the intake dropdown: from this
-- migration on, an application is submitted only with an open intake of its own course.
--
-- public.portal_validate_submission is the function of 20261104120000 with one more rule at the end: every course of the application
-- carries an intake that belongs to that course, is active and starts today or later (Melbourne), and the application's preferred intake
-- is that intake's own label (written by portal_save_draft_v2, so a hand-edited value is refused). The client is never trusted.
-- The rule itself is public.application_intake_problem (null when the intake is fine), so the SQL suites test it on its own.

create or replace function public.application_intake_problem(p_application_id uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare k record; v_values jsonb := public.application_values(p_application_id);
begin
 for k in select c.course_id, c.intake_id from public.enrollment_application_courses c where c.application_id = p_application_id order by c.created_at loop
  if k.intake_id is null then return 'Choose an intake for the course'; end if;
  if not public.course_intake_open_for(k.intake_id, k.course_id) then return 'The chosen intake is not open for this course any more. Choose another intake.'; end if;
 end loop;
 if (v_values->>'preferred_intake') is distinct from (select public.course_intake_display(i) from public.enrollment_application_courses c join public.course_intakes i on i.id = c.intake_id
   where c.application_id = p_application_id order by c.created_at limit 1) then
  return 'The preferred intake does not match the chosen intake. Choose the intake again.';
 end if;
 return null;
end $fn$;
revoke all on function public.application_intake_problem(uuid) from public, anon, authenticated;

create or replace function public.portal_validate_submission(p_application_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare a public.enrollment_applications; s jsonb; f jsonb; vals jsonb; field_value jsonb; v_category text; label text; v_problem text;
begin
 select * into a from public.enrollment_applications where id=p_application_id;
 vals:=public.application_values(a.id);
 for s in select value from jsonb_array_elements(public.portal_required_schema()) loop
  if not public.portal_condition_met(s->'showIf',vals) then continue; end if;
  for f in select value from jsonb_array_elements(s->'fields') loop
   if not public.portal_condition_met(f->'showIf',vals) then continue; end if;
   label:=f->>'name';field_value:=vals->label;
   if f->>'type'='file' then
    v_category:=case label when 'passport_copy' then 'Passport' when 'visa_copy' then 'Visa' when 'english_upload' then 'English Test' when 'academic_upload' then 'Academic' end;
    if v_category is null or not exists(select 1 from public.enrollment_application_documents d join storage.objects o on o.bucket_id=d.bucket_name and o.name=d.storage_path
     where d.application_id=a.id and d.category=v_category and d.is_current) then
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
 -- INT-01: an open intake of the application's own course, and the label the server wrote for it.
 v_problem := public.application_intake_problem(a.id);
 if v_problem is not null then raise exception '%', v_problem using errcode='22023'; end if;
end; $function$;
revoke all on function public.portal_validate_submission(uuid) from public,anon,authenticated,service_role;
