-- STAFF-ONBOARD-SIMPLE (2026-11-22, admin request). Additive.
-- 1. Staff role list (hr.staff_role_types): Trainer and Admin built in; an Admin can add a role from the Add employee dialog. Phase 1:
--    every role takes the system access of Trainer or Admin (its `access`); per-role permissions come later on a Roles page.
--    hr_admin_role_types() lists them; hr_admin_role_type_add(label, access) adds one (case-insensitive unique label).
-- 2. hr_admin_staff_add takes the role and no longer needs a mobile (the person gives it in the wizard). The application stores the
--    role (role_type) and its access as requested_role, so the activation step starts on the right access. When access is granted
--    (hr.staff_roles insert) the role is copied there by trigger when its access matches.
-- 3. The onboarding link is documents only: submit no longer asks for bank details, tax or super (HR collects them on the
--    employee page). Personal details from the documents are still checked.
-- Rollback (manual): restore hr_admin_staff_add(text,text,text,text) and hr_svc_onboarding_submit from their earlier definitions;
-- drop the two RPCs, the trigger, the role_type columns and hr.staff_role_types.
begin;

create table if not exists hr.staff_role_types (
 key text primary key check (key ~ '^[a-z0-9_]{2,40}$'),
 label text not null check (char_length(btrim(label)) between 2 and 60 and label !~ '[[:cntrl:]<>]'),
 access text not null check (access in ('trainer', 'admin')),
 -- rule-policy: technical column-default New roles are not built in; Trainer and Admin rows set is_system.
 is_system boolean not null default false,
 created_by uuid,
 created_at timestamptz not null default now()
);
create unique index if not exists staff_role_types_label_key on hr.staff_role_types (lower(btrim(label)));
insert into hr.staff_role_types(key, label, access, is_system) values ('trainer', 'Trainer', 'trainer', true), ('admin', 'Admin', 'admin', true)
on conflict (key) do nothing;
alter table hr.staff_role_types enable row level security;
revoke all on hr.staff_role_types from anon, authenticated;

alter table hr.staff_applications add column if not exists role_type text references hr.staff_role_types(key);
alter table hr.staff_roles add column if not exists role_type text references hr.staff_role_types(key);

create or replace function public.hr_admin_role_types() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $$
begin
 perform hr.require_admin();
 return coalesce((select jsonb_agg(jsonb_build_object('key', t.key, 'label', t.label, 'access', t.access, 'system', t.is_system) order by t.is_system desc, lower(t.label))
   from hr.staff_role_types t), '[]'::jsonb);
end $$;

create or replace function public.hr_admin_role_type_add(p_label text, p_access text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $$
declare v_admin uuid := hr.require_admin(); v_label text := regexp_replace(btrim(coalesce(p_label, '')), '\s+', ' ', 'g'); v_key text; v_n int := 1;
 t hr.staff_role_types;
begin
 if char_length(v_label) < 2 or char_length(v_label) > 60 or v_label ~ '[[:cntrl:]<>]' then raise exception 'Enter a role name (2 to 60 characters).' using errcode = '22023'; end if;
 if p_access not in ('trainer', 'admin') then raise exception 'Choose the access: Trainer or Admin.' using errcode = '22023'; end if;
 select * into t from hr.staff_role_types where lower(btrim(label)) = lower(v_label);
 if t.key is not null then return jsonb_build_object('key', t.key, 'label', t.label, 'access', t.access, 'system', t.is_system, 'existing', true); end if;
 v_key := left(trim(both '_' from regexp_replace(lower(v_label), '[^a-z0-9]+', '_', 'g')), 36);
 if char_length(v_key) < 2 then v_key := 'role'; end if;
 while exists (select 1 from hr.staff_role_types where key = case when v_n = 1 then v_key else v_key || '_' || v_n end) loop v_n := v_n + 1; end loop;
 if v_n > 1 then v_key := v_key || '_' || v_n; end if;
 insert into hr.staff_role_types(key, label, access, created_by) values (v_key, v_label, p_access, v_admin) returning * into t;
 return jsonb_build_object('key', t.key, 'label', t.label, 'access', t.access, 'system', false, 'existing', false);
end $$;

-- The 4-argument version is replaced by one whose mobile and role are optional (old named calls still resolve).
drop function if exists public.hr_admin_staff_add(text, text, text, text);
create or replace function public.hr_admin_staff_add(p_first_name text, p_last_name text, p_email text, p_phone text default null, p_role_type text default null)
returns jsonb language plpgsql security definer set search_path = public, hr, pg_temp as $function$
declare v_admin uuid := hr.require_admin(); v_email text := hr.email_key(p_email); v_phone text := null;
 v_first text := btrim(coalesce(p_first_name, '')); v_last text := btrim(coalesce(p_last_name, '')); p hr.staff_profiles; t hr.staff_role_types;
begin
 if v_email is null or v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' or char_length(v_email) > 254 then raise exception 'Enter a valid email address.' using errcode = '22023'; end if;
 if nullif(btrim(coalesce(p_phone, '')), '') is not null then
  v_phone := hr.phone_e164(p_phone);
  if v_phone is null then raise exception 'Enter a valid mobile number.' using errcode = '22023'; end if;
 end if;
 if v_first = '' or v_last = '' or char_length(v_first) > 100 or char_length(v_last) > 100 or (v_first || v_last) ~ '[[:cntrl:]<>]' then raise exception 'Enter the first and last name.' using errcode = '22023'; end if;
 if nullif(btrim(coalesce(p_role_type, '')), '') is not null then
  select * into t from hr.staff_role_types where key = p_role_type;
  if t.key is null then raise exception 'Choose a role from the list.' using errcode = '22023'; end if;
 end if;
 if exists (select 1 from hr.staff_profiles s where s.email = v_email or (v_phone is not null and s.phone_e164 = v_phone)) then
  raise exception 'This email or mobile already has a staff record. Open it from Employees.' using errcode = '23505',
   hint = case when exists (select 1 from hr.staff_profiles s where s.email = v_email) then 'email_taken' else '' end; end if;
 -- rule-policy: technical audit-context Records who added the person in the existing staff history.
 perform set_config('hr.actor', v_admin::text, true); perform set_config('hr.actor_kind', 'admin', true); perform set_config('hr.note', 'Added by an administrator', true);
 insert into hr.staff_profiles(first_name, last_name, email, phone_e164) values (v_first, v_last, v_email, v_phone) returning * into p;
 insert into hr.staff_applications(profile_id, role_type, requested_role) values (p.id, t.key, t.access);
 return jsonb_build_object('ok', true, 'profileId', p.id);
end $function$;

-- Granting access copies the chosen role when its access matches what was granted.
create or replace function hr.staff_roles_take_role_type() returns trigger
language plpgsql security definer set search_path = public, hr, pg_temp as $$
begin
 if new.role_type is null then
  select a.role_type into new.role_type from hr.staff_applications a join hr.staff_role_types t on t.key = a.role_type
  where a.profile_id = new.profile_id and t.access = new.role;
 end if;
 return new;
end $$;
drop trigger if exists staff_roles_take_role_type on hr.staff_roles;
create trigger staff_roles_take_role_type before insert on hr.staff_roles for each row execute function hr.staff_roles_take_role_type();

-- Documents only: as before without tax, super and bank details.
create or replace function public.hr_svc_onboarding_submit(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, hr, pg_temp as $function$
declare i hr.staff_invites; p hr.staff_profiles; c text; v_problem jsonb;
begin
 i := hr.invite_for_write(p_token_hash, array['documents','reupload']);
 select * into p from hr.staff_profiles where id = i.profile_id for update;
 if i.purpose = 'documents' then
  v_problem := hr.v_staff_problem(hr.staff_details_json(p), array['is_australian_citizen','first_name','middle_name','last_name','date_of_birth','phone',
   'address_street','address_line2','address_suburb','address_country','address_state','address_postcode',
   'emergency_name','emergency_phone','emergency_relationship','nationality','passport_number','visa_subclass','visa_conditions'], true);
  if v_problem is not null then raise exception '%', v_problem->>'message' using errcode = '23514'; end if;
 elsif p.is_australian_citizen is null then raise exception 'Tell us whether you are an Australian citizen.' using errcode = '23514';
 end if;
 foreach c in array hr.staff_required_categories(p.is_australian_citizen) loop
  if not exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current) then
   -- rule-policy: technical existing-check Same required documents as before; only bank, tax and super were removed.
   raise exception '%', case c when 'Passport' then 'A passport is required before you can submit.' else 'Upload your ' || hr.staff_doc_label(c) || '.' end
    using errcode = '23514'; end if;
  if exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current
     and ((d.expiry_date is null and hr.staff_doc_needs_expiry(c)) or d.expiry_date < current_date)) then
   raise exception 'Enter a current expiry date for your %.', hr.staff_doc_label(c) using errcode = '23514'; end if;
 end loop;
 -- rule-policy: technical existing-check Unchanged re-upload rule.
 if exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.is_current and d.status = 'rejected') then
  raise exception 'Replace every document we asked you to upload again.' using errcode = '23514'; end if;
 perform set_config('hr.actor_kind', 'applicant', true);
 perform set_config('hr.note', case when i.purpose = 'reupload' then 'Documents uploaded again' else 'Documents submitted' end, true);
 -- rule-policy: technical existing-transition Unchanged: submitting moves the person to Documents submitted.
 update hr.staff_profiles set status = 'documents_submitted' where id = p.id;
 update hr.staff_applications set submitted_at = now() where profile_id = p.id;
 update hr.staff_invites set used_at = now() where id = i.id returning * into i;
 -- rule-policy: technical existing-email Unchanged admin notice that documents were submitted.
 perform hr.queue_email(p.id, 'admin_documents_submitted', 'admin', jsonb_build_object('reupload', i.purpose = 'reupload'));
 return hr.staff_applicant_view(i);
end $function$;

revoke all on function public.hr_admin_role_types(), public.hr_admin_role_type_add(text, text), public.hr_admin_staff_add(text, text, text, text, text) from public, anon;
grant execute on function public.hr_admin_role_types(), public.hr_admin_role_type_add(text, text), public.hr_admin_staff_add(text, text, text, text, text) to authenticated;
revoke all on function public.hr_svc_onboarding_submit(text) from public, anon, authenticated;
grant execute on function public.hr_svc_onboarding_submit(text) to service_role;

commit;
