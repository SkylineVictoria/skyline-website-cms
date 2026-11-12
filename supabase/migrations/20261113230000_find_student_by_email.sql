-- Applications: the student email step (Admin CMS "New application", agent portal "Start application").
-- An email is unique within the student role (20261112042544). The step needs one answer per email:
--   free     no student record has this email: create the student and the application as today
--            (an agent's or staff member's email is fine: roles may share an email);
--   student  a student the caller may start an application for has it: reuse that student ({id, full_name} only);
--   taken    another student the caller can't see has it: the generic "already in use" message, nothing else.
-- "May start an application for" is exactly portal_create_student_application's rule (20261104270000): a SLIT admin;
-- the student themself; or, in the student's business, an agency admin or the student's own agent. So a reuse answer is
-- always accepted by the create call. Nothing about another business's student (name, business, count) is returned.
-- Signed-in callers only; read-only; no table or row changes.

create or replace function public.find_student_by_email(p_email text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_admin boolean; v_self uuid; v_agency uuid; v_agency_admin boolean; v_profile uuid;
  s record;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if v_email = '' or length(v_email) > 254 then raise exception 'Enter an email address.' using errcode = '22023'; end if;

  select x.id, x.full_name, x.agency_id, g.profile_id as agent_profile
    into s
    from public.enrollment_students x
    left join public.agents g on g.id = x.agent_id
   where lower(btrim(coalesce(x.email, ''))) = v_email
   order by x.updated_at desc
   limit 1;
  if not found then return jsonb_build_object('status', 'free'); end if;

  v_admin := public.portal_is_slit_admin();
  v_self := public.portal_student_id();
  if v_admin or v_self = s.id then
    return jsonb_build_object('status', 'student', 'id', s.id, 'full_name', coalesce(s.full_name, ''));
  end if;
  if v_self is null then
    v_agency := public.portal_agency_id();
    v_agency_admin := public.portal_is_agency_admin();
    v_profile := public.portal_profile_id();
    if s.agency_id is not distinct from v_agency and v_agency is not null
       and (v_agency_admin or (v_profile is not null and s.agent_profile is not distinct from v_profile)) then
      return jsonb_build_object('status', 'student', 'id', s.id, 'full_name', coalesce(s.full_name, ''));
    end if;
  end if;
  return jsonb_build_object('status', 'taken');
end $fn$;

revoke all on function public.find_student_by_email(text) from public, anon;
grant execute on function public.find_student_by_email(text) to authenticated;

-- portal_student_save (latest: 20261104260000) unchanged except that its duplicate-email refusals carry hint email_taken, like the
-- trigger, so the forms map them to the email field. Messages, codes, checks and the mobile refusal are as before.
create or replace function public.portal_student_save(p_student uuid, p_agent uuid, p_full_name text, p_email text, p_phone text,
 p_date_of_birth date default null, p_passport text default '', p_nationality text default '',
 p_first_name text default '', p_last_name text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare g public.agents; s public.enrollment_students; v_hint text;
 v_first text := btrim(coalesce(p_first_name, '')); v_last text := btrim(coalesce(p_last_name, ''));
 v_name text := coalesce(nullif(btrim(coalesce(p_full_name, '')), ''), btrim(concat_ws(' ', nullif(btrim(coalesce(p_first_name, '')), ''), nullif(btrim(coalesce(p_last_name, '')), ''))));
 v_email text := lower(btrim(coalesce(p_email, ''))); v_phone text := btrim(coalesce(p_phone, ''));
 v_passport text := upper(regexp_replace(coalesce(p_passport, ''), '\s', '', 'g')); v_tenant uuid := public.tenant_current();
 v_details jsonb;
begin
 if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
 select * into g from public.agents where id = p_agent;
 if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;
 if not public.portal_is_slit_admin() then
  if g.business_id is distinct from public.portal_agency_id() then raise exception 'This agent belongs to another business' using errcode = '42501'; end if;
  if not public.portal_is_agency_admin() and g.profile_id is distinct from public.portal_profile_id() then
   raise exception 'Agents can add only their own students' using errcode = '42501'; end if;
 end if;
 if v_email <> '' and (length(v_email) > 254 or v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$') then raise exception 'Enter a valid email address' using errcode = '22023'; end if;
 if length(v_name) > 200 or v_name ~ '[[:cntrl:]]' or length(v_first) > 100 or length(v_last) > 100 or concat(v_first, v_last) ~ '[[:cntrl:]]' then
  raise exception 'Enter a valid name' using errcode = '22023'; end if;
 if length(v_phone) > 40 or length(v_passport) > 40 then raise exception 'Enter a valid phone number and passport number' using errcode = '22023'; end if;
 if p_student is not null then
  select * into s from public.enrollment_students where id = p_student for update;
  if not found then raise exception 'Student not found' using errcode = 'P0002'; end if;
  if s.agency_id <> g.business_id then raise exception 'This student belongs to another business' using errcode = '23514'; end if;
  return jsonb_build_object('id', s.id, 'name', s.full_name, 'email', coalesce(s.email, ''), 'phone', coalesce(s.phone, ''), 'businessId', s.agency_id, 'agentId', s.agent_id, 'reused', true);
 end if;
 if v_email = '' or v_phone = '' then raise exception 'Enter the student''s email and mobile' using errcode = '22023'; end if;
 if exists (select 1 from public.enrollment_students x where lower(btrim(coalesce(x.email, ''))) = v_email) then
  raise exception 'A student with this email already exists' using errcode = '23505', hint = 'email_taken'; end if;
 if exists (select 1 from public.enrollment_students x where public.student_phone_key(x.phone) = public.student_phone_key(v_phone)) then
  raise exception 'A student with this mobile already exists' using errcode = '23505'; end if;
 v_details := jsonb_build_object('email', v_email, 'confirm_email', v_email, 'mobile', v_phone);
 if v_first <> '' then v_details := v_details || jsonb_build_object('first_name', v_first); end if;
 if v_last <> '' then v_details := v_details || jsonb_build_object('last_name', v_last); end if;
 insert into public.enrollment_students(agency_id, tenant_id, agent_id, full_name, email, phone, date_of_birth, passport_number, nationality, created_by, details)
 values (g.business_id, v_tenant, g.id, v_name, v_email, v_phone, p_date_of_birth, v_passport, btrim(coalesce(p_nationality, '')), public.portal_profile_id(), v_details)
 returning * into s;
 return jsonb_build_object('id', s.id, 'name', s.full_name, 'email', coalesce(s.email, ''), 'phone', coalesce(s.phone, ''), 'businessId', s.agency_id, 'agentId', s.agent_id, 'reused', false);
exception when unique_violation then
 -- The identity trigger (or a racing insert of the same email) keeps its email_taken hint; other duplicates stay as before.
 get stacked diagnostics v_hint = pg_exception_hint;
 if v_hint = 'email_taken' then
  raise exception 'A student with this email already exists' using errcode = '23505', hint = 'email_taken';
 end if;
 raise exception 'A student with this email or mobile already exists' using errcode = '23505';
end $$;

revoke all on function public.portal_student_save(uuid, uuid, text, text, text, date, text, text, text, text) from public, anon;
grant execute on function public.portal_student_save(uuid, uuid, text, text, text, date, text, text, text, text) to authenticated, service_role;
