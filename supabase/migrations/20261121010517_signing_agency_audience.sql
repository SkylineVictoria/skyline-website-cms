-- Document signing (owner 2026-11-21): "An agency" in New signing request. Templates get a new audience "agency" (Used for: Agency);
-- a request can be for a business (subject_type 'agency'). The recipient defaults to the business's agency admin (point of contact);
-- the variables fill from the business record: name, legal name, ABN, ACN, address, email, phone, the contact, and the commission %
-- with its GST choice from the business's onboarding (the signed one first, else the latest). The onboarding templates (F04, P06, F05)
-- are never offered there (screen) and refused by document-signing's create (server); they stay in the onboarding flow.
-- hr.sign_subject / hr.sign_subject_search are replaced from their live definitions (pg_get_functiondef, 2026-11-21): only the agency
-- branches (marked AGENCY-SUBJECT) and the final error text change.

alter table hr.sign_templates drop constraint if exists sign_templates_audience_check,
  add constraint sign_templates_audience_check check (audience = any (array['any', 'student', 'employee', 'agent', 'agency']));
alter table hr.sign_requests drop constraint if exists sign_requests_subject_type_check,
  add constraint sign_requests_subject_type_check check (subject_type = any (array['student', 'employee', 'agent', 'agency']));

CREATE OR REPLACE FUNCTION hr.sign_subject(p_type text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hr', 'public', 'pg_temp'
AS $function$
declare j jsonb; d jsonb; e jsonb; b jsonb; a jsonb; v_name text; v_first text; v_last text; v_address text; v_course jsonb; out jsonb; v_extra jsonb := '{}'::jsonb;
 v_today text := to_char(now() at time zone 'Australia/Melbourne', 'FMDD FMMonth YYYY'); v_pct text; v_gst text;
begin
 if p_type = 'student' and to_regclass('public.enrollment_students') is not null then
  execute 'select to_jsonb(s) from public.enrollment_students s where s.id = $1' into j using p_id;
  if j is null then raise exception 'Student not found'; end if;
  d := case when jsonb_typeof(j->'details') = 'object' then j->'details' else '{}'::jsonb end;
  v_name := btrim(coalesce(j->>'full_name', ''));
  v_first := coalesce(nullif(btrim(coalesce(d->>'first_name', '')), ''), split_part(v_name, ' ', 1));
  v_last := coalesce(nullif(btrim(coalesce(d->>'last_name', '')), ''), nullif(btrim(substr(v_name, length(split_part(v_name, ' ', 1)) + 1)), ''), '');
  v_address := array_to_string(array_remove(array[nullif(btrim(coalesce(d->>'au_street', d->>'ov_street', '')), ''), nullif(btrim(coalesce(d->>'au_suburb', d->>'ov_city', '')), ''),
   nullif(btrim(coalesce(d->>'au_state', d->>'ov_state', '')), ''), nullif(btrim(coalesce(d->>'au_postcode', d->>'ov_postcode', '')), ''), nullif(btrim(coalesce(d->>'ov_country', '')), '')], null), ', ');
  if to_regclass('public.enrollment_applications') is not null and to_regclass('public.enrollment_application_courses') is not null then
   execute 'select jsonb_build_object(''name'', c.course_title, ''code'', c.course_code, ''id'', c.course_id, ''intake_id'', c.intake_id, ''reference'', coalesce(ap.reference, ''''),
      ''agent_profile'', ap.assigned_agent_id, ''preferred'', coalesce(public.application_values(ap.id)->>''preferred_intake'', '''')) from public.enrollment_application_courses c
     join public.enrollment_applications ap on ap.id = c.application_id where ap.student_id = $1 order by ap.created_at desc, c.created_at limit 1' into v_course using p_id;
  end if;
  if v_course is not null and to_regclass('public.cms_courses') is not null then
   execute 'select $1 || jsonb_build_object(''fees'', k.fees, ''duration'', k.duration, ''cricos'', k.cricos) from public.cms_courses k where k.id = $2 or (k.code <> '''' and k.code = $3) limit 1'
    into a using v_course, v_course->>'id', v_course->>'code';
   v_course := coalesce(a, v_course);
  end if;
  -- The chosen intake (INT-01), the application reference as the student ID, and who brought the student.
  if v_course->>'intake_id' is not null then
   select jsonb_build_object('course.intake', public.course_intake_name(i), 'course.start_date', to_char(i.start_date, 'FMDD FMMonth YYYY'),
     'course.end_date', coalesce(to_char(i.end_date, 'FMDD FMMonth YYYY'), '')) into v_extra from public.course_intakes i where i.id = (v_course->>'intake_id')::uuid;
   v_extra := coalesce(v_extra, '{}'::jsonb);
  end if;
  -- A course without real intakes (the fallback months): [Intake] is the month the applicant chose; [Start Date] stays to be typed.
  if v_course is not null and v_course->>'intake_id' is null and nullif(v_course->>'preferred', '') is not null then
   v_extra := v_extra || jsonb_build_object('course.intake', v_course->>'preferred');
  end if;
  v_extra := v_extra || jsonb_build_object('student.id', coalesce(v_course->>'reference', ''),
   'agent.name', coalesce((select g.full_name from public.agents g where g.id = (j->>'agent_id')::uuid),
     (select p.full_name from public.portal_profiles p where p.id = (v_course->>'agent_profile')::uuid), ''),
   'agency.name', coalesce((select coalesce(nullif(to_jsonb(x)->>'name', ''), to_jsonb(x)->>'legal_name') from public.agencies x where x.id = (j->>'agency_id')::uuid), ''));
  out := jsonb_build_object('name', coalesce(nullif(v_name, ''), btrim(v_first || ' ' || v_last)), 'email', lower(coalesce(j->>'email', '')), 'tenant_id', j->>'tenant_id', 'values', jsonb_build_object(
   'student.first_name', v_first, 'student.last_name', v_last, 'student.full_name', coalesce(nullif(v_name, ''), btrim(v_first || ' ' || v_last)), 'student.email', coalesce(j->>'email', ''),
   'student.phone', coalesce(j->>'phone', d->>'mobile', ''), 'student.address', v_address, 'student.date_of_birth', coalesce(j->>'date_of_birth', d->>'dob', ''),
   'student.passport_number', coalesce(nullif(j->>'passport_number', ''), d->>'passport_number', ''), 'student.nationality', coalesce(nullif(j->>'nationality', ''), d->>'nationality', ''),
   'course.name', coalesce(v_course->>'name', ''), 'course.code', coalesce(v_course->>'code', ''), 'course.fees', coalesce(v_course->>'fees', ''),
   'course.duration', coalesce(v_course->>'duration', ''), 'course.cricos', coalesce(v_course->>'cricos', '')) || v_extra);
 elsif p_type = 'employee' then
  select to_jsonb(p) into j from hr.staff_profiles p where p.id = p_id;
  if j is null then raise exception 'Employee not found'; end if;
  if to_regclass('hr.employment') is not null then execute 'select to_jsonb(x) from hr.employment x where x.profile_id = $1' into e using p_id; end if;
  e := coalesce(e, '{}'::jsonb);
  v_name := btrim(regexp_replace(concat_ws(' ', j->>'first_name', j->>'middle_name', j->>'last_name'), '\s+', ' ', 'g'));
  v_address := array_to_string(array_remove(array[nullif(btrim(coalesce(j->>'address_street', '')), ''), nullif(btrim(coalesce(j->>'address_line2', '')), ''), nullif(btrim(coalesce(j->>'address_suburb', '')), ''),
   nullif(btrim(coalesce(j->>'address_state', '')), ''), nullif(btrim(coalesce(j->>'address_postcode', '')), ''), nullif(btrim(coalesce(j->>'address_country', '')), '')], null), ', ');
  out := jsonb_build_object('name', v_name, 'email', lower(coalesce(j->>'email', '')), 'values', jsonb_build_object(
   'employee.name', v_name, 'employee.first_name', coalesce(j->>'first_name', ''), 'employee.last_name', coalesce(j->>'last_name', ''), 'employee.email', coalesce(j->>'email', ''),
   'employee.phone', coalesce(j->>'phone_e164', ''), 'employee.address', v_address, 'employee.position', coalesce(e->>'job_title', ''), 'employee.department', coalesce(e->>'department', ''),
   'employee.employment_type', replace(coalesce(e->>'employment_type', ''), '_', ' '), 'employee.start_date', coalesce(e->>'joining_date', ''), 'employee.work_location', coalesce(e->>'work_location', '')));
 elsif p_type = 'agent' and to_regclass('public.agents') is not null then
  execute 'select to_jsonb(g) from public.agents g where g.id = $1' into j using p_id;
  if j is null then raise exception 'Agent not found'; end if;
  if to_regclass('public.agencies') is not null then execute 'select to_jsonb(x) from public.agencies x where x.id = $1' into b using (j->>'business_id')::uuid; end if;
  b := coalesce(b, '{}'::jsonb);
  out := jsonb_build_object('name', coalesce(j->>'full_name', ''), 'email', lower(coalesce(j->>'email', '')), 'values', jsonb_build_object(
   'agent.name', coalesce(j->>'full_name', ''), 'agent.email', coalesce(j->>'email', ''), 'agent.phone', coalesce(j->>'phone', ''), 'agent.marn', coalesce(j->>'marn', ''),
   'agency.name', coalesce(b->>'name', b->>'legal_name', ''), 'agency.abn', coalesce(b->>'registration_number', ''), 'agency.email', coalesce(b->>'email', ''), 'agency.phone', coalesce(b->>'phone', '')) || public.agent_onboarding_values((j->>'id')::uuid));
 -- AGENCY-SUBJECT: a business. The recipient is its agency admin (point of contact); the commission and its GST choice come from its
 -- onboarding (the signed agreement first, else the latest one with a commission), else the business profile's commission.
 elsif p_type = 'agency' and to_regclass('public.agencies') is not null then
  select to_jsonb(x) into b from public.agencies x where x.id = p_id;
  if b is null then raise exception 'Business not found'; end if;
  select to_jsonb(g) into j from public.agents g where g.business_id = p_id and g.role = 'agency_admin' order by g.created_at limit 1;
  j := coalesce(j, '{}'::jsonb);
  select jsonb_build_object('pct', trim_scale(o.commission_percent)::text, 'gst', o.commission_gst) into a from public.agency_onboarding o
   where o.agency_id = p_id and o.commission_percent is not null and o.stage not in ('cancelled', 'declined', 'expired')
   order by (o.stage in ('agreement_signed', 'activated')) desc, o.created_at desc limit 1;
  v_pct := coalesce(nullif(a->>'pct', ''), nullif(regexp_replace(coalesce(b->'profile'->>'agent_commission_percent', ''), '[^0-9.]', '', 'g'), ''), '');
  v_gst := case a->>'gst' when 'inclusive' then 'GST inclusive' when 'exclusive' then 'GST exclusive' else '' end;
  v_address := array_to_string(array_remove(array[nullif(btrim(coalesce(b->>'address', '')), ''), nullif(btrim(coalesce(b->>'country', '')), '')], null), ', ');
  out := jsonb_build_object('name', coalesce(nullif(j->>'full_name', ''), b->>'name', ''), 'email', lower(coalesce(nullif(j->>'email', ''), b->>'business_email', '')), 'values', jsonb_build_object(
   'agency.name', coalesce(b->>'name', ''),
   'agency.legal_name', coalesce(nullif(b->'abr_confirmed'->>'legalName', ''), nullif(b->'abr_details'->>'entityName', ''), nullif(b->'profile'->>'agent_legal_entity', ''), b->>'name', ''),
   'agency.abn', coalesce(b->>'registration_number', ''), 'agency.acn', coalesce(b->>'acn', ''), 'agency.address', v_address,
   'agency.email', coalesce(b->>'business_email', ''), 'agency.phone', coalesce(b->>'phone', ''),
   'agency.contact_name', coalesce(j->>'full_name', ''), 'agency.contact_email', coalesce(j->>'email', ''),
   'agency.commission_percent', case when v_pct = '' then '' else v_pct || '%' end, 'agency.commission_gst', v_gst,
   'agency.commission', case when v_pct = '' then '' else v_pct || '%' || case when v_gst = '' then '' else ' (' || v_gst || ')' end end));
 else raise exception 'Choose a student, an employee, an agent or an agency';
 end if;
 return jsonb_set(out, '{values}', (out->'values') || jsonb_build_object('current_date', v_today));
end $function$;

CREATE OR REPLACE FUNCTION hr.sign_subject_search(p_type text, p_query text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hr', 'public', 'pg_temp'
AS $function$
declare q text := '%' || replace(replace(lower(btrim(coalesce(p_query, ''))), '%', ''), '_', '\_') || '%'; out jsonb;
begin
 if p_type = 'student' and to_regclass('public.enrollment_students') is not null then
  execute 'select jsonb_agg(x) from (select s.id, s.full_name as name, coalesce(s.email, '''') as email from public.enrollment_students s
    where lower(s.full_name) like $1 or lower(coalesce(s.email, '''')) like $1 order by s.full_name limit 20) x' into out using q;
 elsif p_type = 'employee' then
  select jsonb_agg(x) into out from (select p.id, btrim(p.first_name || ' ' || p.last_name) as name, p.email from hr.staff_profiles p
   where lower(p.first_name || ' ' || p.last_name) like q or lower(coalesce(p.email, '')) like q order by p.first_name, p.last_name limit 20) x;
 elsif p_type = 'agent' and to_regclass('public.agents') is not null then
  execute 'select jsonb_agg(x) from (select g.id, g.full_name as name, g.email from public.agents g
    where lower(g.full_name) like $1 or lower(g.email) like $1 order by g.full_name limit 20) x' into out using q;
 -- AGENCY-SUBJECT: businesses by name, ABN or code; the email shown is the point of contact's (else the business email).
 elsif p_type = 'agency' and to_regclass('public.agencies') is not null then
  select jsonb_agg(x) into out from (select a.id, a.name, coalesce((select g.email from public.agents g where g.business_id = a.id and g.role = 'agency_admin' order by g.created_at limit 1), a.business_email, '') as email
   from public.agencies a where not coalesce(a.is_direct, false) -- SLIT's own "direct students" business is not an agency
    and (lower(a.name) like q or regexp_replace(coalesce(a.registration_number, ''), '\s', '', 'g') like replace(q, ' ', '') or lower(coalesce(a.code, '')) like q)
   order by a.name limit 20) x;
 end if;
 return coalesce(out, '[]'::jsonb);
end $function$;
