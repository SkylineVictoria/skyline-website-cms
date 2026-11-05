-- Staff self-registration, part 2 of 3: the functions the browser and the staff-register / staff-document-extract Edge Functions
-- call. All live in `public` (the `hr` schema is not exposed) and are SECURITY DEFINER with a fixed search_path.
--   Applicant (authenticated):  hr_staff_start, hr_staff_me, hr_staff_save, hr_staff_document_register, hr_staff_document_remove,
--                               hr_staff_submit, hr_staff_access
--   Admin (authenticated, public.cms_is_admin() checked inside): hr_admin_staff_list, hr_admin_staff_detail, hr_admin_staff_approve,
--                               hr_admin_staff_reject, hr_admin_staff_activate, hr_admin_staff_deactivate, hr_staff_reopen
--   service_role only:          hr_staff_precheck, hr_staff_document_apply_extraction, hr_contact_conflicts (internal)
-- Roles: approval records the role in hr.staff_roles. Only moving to `active` writes public.cms_users (role Admin only; a trainer
-- never gets a cms_users row), so CMS access begins at active and ends at deactivate/reject.
-- Rollback (manual): drop the functions named above.
set local lock_timeout='5s';
set local statement_timeout='60s';

-- ------------------------------------------------------------------ duplicate check (internal)
-- Which existing records already hold this email / phone. p_self is the signed-in account (its own records never count; used when
-- an existing student/agent attaches a staff application). Admin users (cms_users) always count. Returns the SOURCES for tests
-- and logs only; callers show a neutral message.
create or replace function hr.contact_conflicts(p_email text, p_phone text, p_self uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, hr, auth, pg_temp as $fn$
declare v_email text := hr.email_key(p_email); v_phone text := hr.phone_e164(p_phone); e text[] := '{}'; p text[] := '{}'; v_self_email text;
begin
 if p_self is not null then select hr.email_key(u.email) into v_self_email from auth.users u where u.id = p_self; end if;
 if v_email is not null then
  if exists (select 1 from hr.staff_profiles s where s.email = v_email and s.auth_user_id is distinct from p_self) then e := array_append(e, 'staff'); end if;
  if exists (select 1 from public.enrollment_students s where hr.email_key(s.email) = v_email
     and not exists (select 1 from public.agency_memberships m join public.portal_profiles pp on pp.id = m.user_id
       where m.student_id = s.id and pp.auth_user_id = p_self)) then e := array_append(e, 'student'); end if;
  if exists (select 1 from public.agents g where hr.email_key(g.email) = v_email
     and not exists (select 1 from public.portal_profiles pp where pp.id = g.profile_id and pp.auth_user_id = p_self)) then e := array_append(e, 'agent'); end if;
  if exists (select 1 from public.portal_profiles pp where hr.email_key(pp.email) = v_email and pp.auth_user_id is distinct from p_self) then e := array_append(e, 'portal_user'); end if;
  if exists (select 1 from public.agency_invitations i where hr.email_key(i.email) = v_email and i.status = 'pending'
     and v_self_email is distinct from v_email) then e := array_append(e, 'invitation'); end if;
  if exists (select 1 from public.cms_users c where hr.email_key(c.email) = v_email) then e := array_append(e, 'admin'); end if;
 end if;
 if v_phone is not null then
  if exists (select 1 from hr.staff_profiles s where s.phone_e164 = v_phone and s.auth_user_id is distinct from p_self) then p := array_append(p, 'staff'); end if;
  if exists (select 1 from public.enrollment_students s where (hr.phone_e164(s.phone) = v_phone or hr.phone_e164(s.details->>'mobile') = v_phone)
     and not exists (select 1 from public.agency_memberships m join public.portal_profiles pp on pp.id = m.user_id
       where m.student_id = s.id and pp.auth_user_id = p_self)) then p := array_append(p, 'student'); end if;
  if exists (select 1 from public.agents g where hr.phone_e164(g.phone) = v_phone
     and not exists (select 1 from public.portal_profiles pp where pp.id = g.profile_id and pp.auth_user_id = p_self)) then p := array_append(p, 'agent'); end if;
  if exists (select 1 from public.portal_profiles pp where hr.phone_e164(pp.phone) = v_phone and pp.auth_user_id is distinct from p_self) then p := array_append(p, 'portal_user'); end if;
 end if;
 return jsonb_build_object('email', to_jsonb(e), 'phone', to_jsonb(p), 'phoneE164', v_phone);
end $fn$;
revoke all on function hr.contact_conflicts(text, text, uuid) from public, anon, authenticated;
grant execute on function hr.contact_conflicts(text, text, uuid) to service_role;

create or replace function public.hr_staff_precheck(p_email text, p_phone text) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare c jsonb;
begin
 if hr.email_key(p_email) is null or hr.email_key(p_email) !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then
  return jsonb_build_object('ok', false, 'reason', 'invalid_email'); end if;
 if hr.phone_e164(p_phone) is null then return jsonb_build_object('ok', false, 'reason', 'invalid_phone'); end if;
 c := hr.contact_conflicts(p_email, p_phone, null);
 return jsonb_build_object('ok', jsonb_array_length(c->'email') = 0 and jsonb_array_length(c->'phone') = 0,
  'emailConflict', jsonb_array_length(c->'email') > 0, 'phoneConflict', jsonb_array_length(c->'phone') > 0, 'phoneE164', c->'phoneE164');
end $fn$;
revoke all on function public.hr_staff_precheck(text, text) from public, anon, authenticated;
grant execute on function public.hr_staff_precheck(text, text) to service_role;

-- ------------------------------------------------------------------ applicant
create or replace function public.hr_staff_me() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_uid uuid := auth.uid(); p hr.staff_profiles; a hr.staff_applications;
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid;
 if not found then return null; end if;
 select * into a from hr.staff_applications where profile_id = p.id;
 return jsonb_build_object(
  'profile', to_jsonb(p) - 'auth_user_id',
  'application', to_jsonb(a),
  'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'category', d.category, 'filename', d.filename, 'mimeType', d.mime_type,
     'fileSize', d.file_size, 'storagePath', d.storage_path, 'extractionStatus', d.extraction_status, 'extracted', d.extracted,
     'extractionError', d.extraction_error, 'createdAt', d.created_at) order by d.created_at) from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb),
  'role', (select r.role from hr.staff_roles r where r.profile_id = p.id and r.revoked_at is null),
  'events', coalesce((select jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'actorKind', e.actor_kind, 'note', e.note, 'at', e.created_at) order by e.id)
     from hr.staff_status_events e where e.profile_id = p.id), '[]'::jsonb));
end $fn$;
revoke all on function public.hr_staff_me() from public, anon;
grant execute on function public.hr_staff_me() to authenticated;

create or replace function public.hr_staff_access() returns text
language sql stable security definer set search_path = public, hr, pg_temp as $fn$
 select coalesce((select p.status from hr.staff_profiles p where p.auth_user_id = auth.uid()), 'none');
$fn$;
revoke all on function public.hr_staff_access() from public, anon;
grant execute on function public.hr_staff_access() to authenticated;

-- Creates the draft after the email is verified. p_phone defaults to the one given at sign-up (stored in the sign-up metadata).
-- Safe to repeat: an existing profile is returned unchanged. An existing student/agent/portal user attaches the application to
-- the SAME login (no second account); a CMS admin cannot.
create or replace function public.hr_staff_start(p_phone text default null, p_requested_role text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, auth, pg_temp as $fn$
declare v_uid uuid := auth.uid(); v_email text; v_confirmed timestamptz; v_meta jsonb; v_phone text; c jsonb; p hr.staff_profiles; v_attached boolean; v_role text := nullif(btrim(coalesce(p_requested_role, '')), '');
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select hr.email_key(u.email), u.email_confirmed_at, u.raw_user_meta_data into v_email, v_confirmed, v_meta from auth.users u where u.id = v_uid;
 if v_email is null or v_confirmed is null then raise exception 'Verify your email address first.' using errcode = '42501'; end if;
 if exists (select 1 from hr.staff_profiles where auth_user_id = v_uid) then return public.hr_staff_me(); end if;
 if v_role is not null and v_role not in ('admin','trainer') then raise exception 'Choose Admin or Trainer.' using errcode = '22023'; end if;
 v_phone := hr.phone_e164(coalesce(nullif(btrim(coalesce(p_phone, '')), ''), v_meta->>'staff_phone'));
 if v_phone is null then raise exception 'Enter a valid mobile number with its country code.' using errcode = '22023'; end if;
 c := hr.contact_conflicts(v_email, v_phone, v_uid);
 if jsonb_array_length(c->'email') > 0 then raise exception 'This email can''t be used. Sign in or contact the administrator.' using errcode = '23505'; end if;
 if jsonb_array_length(c->'phone') > 0 then raise exception 'This number can''t be used. Sign in or contact the administrator.' using errcode = '23505'; end if;
 v_attached := exists (select 1 from public.portal_profiles where auth_user_id = v_uid);
 perform set_config('hr.actor', v_uid::text, true); perform set_config('hr.actor_kind', 'applicant', true);
 perform set_config('hr.note', case when v_attached then 'Started from an existing account' else 'Registered' end, true);
 insert into hr.staff_profiles(auth_user_id, email, phone_e164) values (v_uid, v_email, v_phone) returning * into p;
 insert into hr.staff_applications(profile_id, requested_role) values (p.id, v_role);
 return public.hr_staff_me() || jsonb_build_object('attachedToExistingAccount', v_attached);
exception when unique_violation then
 if sqlerrm like '%staff_profiles_phone_key%' then raise exception 'This number can''t be used. Sign in or contact the administrator.' using errcode = '23505'; end if;
 if sqlerrm like '%staff_profiles_email_key%' then raise exception 'This email can''t be used. Sign in or contact the administrator.' using errcode = '23505'; end if;
 raise;
end $fn$;
revoke all on function public.hr_staff_start(text, text) from public, anon;
grant execute on function public.hr_staff_start(text, text) to authenticated;

-- Saves the keys present in p_patch (first_name, middle_name, last_name, date_of_birth, address_*, emergency_*, phone, requested_role).
create or replace function public.hr_staff_save(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_uid uuid := auth.uid(); p hr.staff_profiles; v_phone text; v_ephone text; v_dob date; v_role text; c jsonb; k text;
 text_keys constant text[] := array['first_name','middle_name','last_name','address_street','address_line2','address_suburb','address_state','address_postcode','address_country','emergency_name','emergency_relationship'];
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid for update;
 if not found then raise exception 'Start your staff application first.' using errcode = 'P0002'; end if;
 if p.status <> 'draft' then raise exception 'This application can no longer be edited.' using errcode = '23514'; end if;
 if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'Nothing to save.' using errcode = '22023'; end if;
 foreach k in array text_keys loop
  if p_patch ? k and (jsonb_typeof(p_patch->k) not in ('string','null') or char_length(coalesce(p_patch->>k, '')) > 200 or coalesce(p_patch->>k, '') ~ '[[:cntrl:]]') then
   raise exception 'Check the % field.', replace(k, '_', ' ') using errcode = '22023'; end if;
 end loop;
 if p_patch ? 'date_of_birth' then
  begin v_dob := nullif(btrim(coalesce(p_patch->>'date_of_birth', '')), '')::date; exception when others then raise exception 'Enter a valid date of birth.' using errcode = '22023'; end;
  if v_dob is not null and (v_dob > current_date - interval '14 years' or v_dob < date '1900-01-01') then raise exception 'Enter a valid date of birth.' using errcode = '22023'; end if;
 else v_dob := p.date_of_birth; end if;
 if p_patch ? 'emergency_phone' then
  v_ephone := hr.phone_e164(p_patch->>'emergency_phone');
  if nullif(btrim(coalesce(p_patch->>'emergency_phone', '')), '') is not null and v_ephone is null then raise exception 'Enter the emergency contact''s number with its country code.' using errcode = '22023'; end if;
 else v_ephone := p.emergency_phone_e164; end if;
 v_phone := p.phone_e164;
 if p_patch ? 'phone' then
  v_phone := hr.phone_e164(p_patch->>'phone');
  if v_phone is null then raise exception 'Enter a valid mobile number with its country code.' using errcode = '22023'; end if;
  if v_phone <> p.phone_e164 then
   c := hr.contact_conflicts(p.email, v_phone, v_uid);
   if jsonb_array_length(c->'phone') > 0 then raise exception 'This number can''t be used. Sign in or contact the administrator.' using errcode = '23505'; end if;
  end if;
 end if;
 if p_patch ? 'requested_role' then
  v_role := nullif(btrim(coalesce(p_patch->>'requested_role', '')), '');
  if v_role is not null and v_role not in ('admin','trainer') then raise exception 'Choose Admin or Trainer.' using errcode = '22023'; end if;
  update hr.staff_applications set requested_role = v_role where profile_id = p.id;
 end if;
 update hr.staff_profiles set
  first_name = case when p_patch ? 'first_name' then btrim(coalesce(p_patch->>'first_name', '')) else first_name end,
  middle_name = case when p_patch ? 'middle_name' then btrim(coalesce(p_patch->>'middle_name', '')) else middle_name end,
  last_name = case when p_patch ? 'last_name' then btrim(coalesce(p_patch->>'last_name', '')) else last_name end,
  date_of_birth = v_dob, phone_e164 = v_phone, emergency_phone_e164 = v_ephone,
  address_street = case when p_patch ? 'address_street' then btrim(coalesce(p_patch->>'address_street', '')) else address_street end,
  address_line2 = case when p_patch ? 'address_line2' then btrim(coalesce(p_patch->>'address_line2', '')) else address_line2 end,
  address_suburb = case when p_patch ? 'address_suburb' then btrim(coalesce(p_patch->>'address_suburb', '')) else address_suburb end,
  address_state = case when p_patch ? 'address_state' then btrim(coalesce(p_patch->>'address_state', '')) else address_state end,
  address_postcode = case when p_patch ? 'address_postcode' then btrim(coalesce(p_patch->>'address_postcode', '')) else address_postcode end,
  address_country = case when p_patch ? 'address_country' then btrim(coalesce(p_patch->>'address_country', '')) else address_country end,
  emergency_name = case when p_patch ? 'emergency_name' then btrim(coalesce(p_patch->>'emergency_name', '')) else emergency_name end,
  emergency_relationship = case when p_patch ? 'emergency_relationship' then btrim(coalesce(p_patch->>'emergency_relationship', '')) else emergency_relationship end
  where id = p.id;
 return public.hr_staff_me();
exception when unique_violation then
 raise exception 'This number can''t be used. Sign in or contact the administrator.' using errcode = '23505';
end $fn$;
revoke all on function public.hr_staff_save(jsonb) from public, anon;
grant execute on function public.hr_staff_save(jsonb) to authenticated;

-- Records a file the browser already uploaded to staff-documents/{uid}/{application}/... The file it replaces (same category) is
-- returned so the browser can delete the old object.
create or replace function public.hr_staff_document_register(p_category text, p_path text, p_filename text, p_mime text, p_size integer) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_uid uuid := auth.uid(); p hr.staff_profiles; a hr.staff_applications; d hr.staff_documents; v_old text[];
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid;
 if not found then raise exception 'Start your staff application first.' using errcode = 'P0002'; end if;
 if p.status <> 'draft' then raise exception 'This application can no longer be edited.' using errcode = '23514'; end if;
 select * into a from hr.staff_applications where profile_id = p.id;
 if p_category not in ('Passport','Visa','Driving Licence','PTE','English Certificate') then raise exception 'Unknown document type.' using errcode = '22023'; end if;
 if p_path is null or split_part(p_path, '/', 1) <> v_uid::text or split_part(p_path, '/', 2) <> a.id::text or split_part(p_path, '/', 3) = ''
  or p_path ~ '(^|/)\.\.?(/|$)' or p_path ~ '[\\%[:cntrl:]]' or char_length(p_path) > 400 or array_length(string_to_array(p_path, '/'), 1) <> 3 then
  raise exception 'The document location is not valid.' using errcode = '22023'; end if;
 if not exists (select 1 from storage.objects o where o.bucket_id = 'staff-documents' and o.name = p_path) then raise exception 'The uploaded file was not found.' using errcode = 'P0002'; end if;
 select array_agg(storage_path) into v_old from hr.staff_documents where application_id = a.id and category = p_category and is_current;
 update hr.staff_documents set is_current = false where application_id = a.id and category = p_category and is_current;
 insert into hr.staff_documents(application_id, profile_id, category, storage_path, filename, mime_type, file_size)
  values (a.id, p.id, p_category, p_path, left(btrim(p_filename), 255), p_mime, p_size) returning * into d;
 return jsonb_build_object('id', d.id, 'replacedPaths', coalesce(to_jsonb(v_old), '[]'::jsonb));
end $fn$;
revoke all on function public.hr_staff_document_register(text, text, text, text, integer) from public, anon;
grant execute on function public.hr_staff_document_register(text, text, text, text, integer) to authenticated;

create or replace function public.hr_staff_document_remove(p_id uuid) returns text
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_uid uuid := auth.uid(); d hr.staff_documents; p hr.staff_profiles;
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid;
 if not found or p.status <> 'draft' then raise exception 'This application can no longer be edited.' using errcode = '23514'; end if;
 select * into d from hr.staff_documents where id = p_id and profile_id = p.id and is_current;
 if not found then raise exception 'Document not found.' using errcode = 'P0002'; end if;
 update hr.staff_documents set is_current = false where id = d.id;
 return d.storage_path;
end $fn$;
revoke all on function public.hr_staff_document_remove(uuid) from public, anon;
grant execute on function public.hr_staff_document_remove(uuid) to authenticated;

-- Called by staff-document-extract (service role) after the provider has read a document. Fills only EMPTY profile fields of a
-- draft (name and date of birth from a passport, address from a licence); the extracted values always stay on the document.
create or replace function public.hr_staff_document_apply_extraction(p_doc uuid, p_status text, p_extracted jsonb, p_error text default null) returns void
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare d hr.staff_documents; p hr.staff_profiles; x jsonb := coalesce(p_extracted, '{}'::jsonb); v_dob date;
begin
 if p_status not in ('processing','done','no_fields','failed','unavailable') then raise exception 'Unknown extraction status.' using errcode = '22023'; end if;
 select * into d from hr.staff_documents where id = p_doc and is_current for update;
 if not found then return; end if;
 update hr.staff_documents set extraction_status = p_status, extracted = case when p_status in ('done','no_fields') then x else extracted end,
  extracted_at = case when p_status in ('done','no_fields') then now() else extracted_at end, extraction_error = left(p_error, 500) where id = d.id;
 if p_status <> 'done' then return; end if;
 select * into p from hr.staff_profiles where id = d.profile_id;
 if p.status <> 'draft' then return; end if;
 if d.category = 'Passport' then
  begin v_dob := nullif(x->>'dob', '')::date; exception when others then v_dob := null; end;
  if v_dob is not null and (v_dob > current_date - interval '14 years' or v_dob < date '1900-01-01') then v_dob := null; end if;
  update hr.staff_profiles set
   first_name = case when first_name = '' then left(btrim(coalesce(x->>'first_name', '')), 100) else first_name end,
   middle_name = case when middle_name = '' then left(btrim(coalesce(x->>'middle_name', '')), 100) else middle_name end,
   last_name = case when last_name = '' then left(btrim(coalesce(x->>'last_name', '')), 100) else last_name end,
   date_of_birth = coalesce(date_of_birth, v_dob) where id = p.id;
 elsif d.category = 'Driving Licence' then
  update hr.staff_profiles set
   address_street = case when address_street = '' then left(btrim(coalesce(x->>'au_street', '')), 200) else address_street end,
   address_line2 = case when address_line2 = '' then left(btrim(coalesce(x->>'au_line2', '')), 200) else address_line2 end,
   address_suburb = case when address_suburb = '' then left(btrim(coalesce(x->>'au_suburb', '')), 100) else address_suburb end,
   address_state = case when address_state = '' then left(btrim(coalesce(x->>'au_state', '')), 100) else address_state end,
   address_postcode = case when address_postcode = '' then left(btrim(coalesce(x->>'au_zip', '')), 20) else address_postcode end,
   address_country = case when address_country = '' and coalesce(x->>'au_street', '') <> '' then 'Australia' else address_country end where id = p.id;
 end if;
end $fn$;
revoke all on function public.hr_staff_document_apply_extraction(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.hr_staff_document_apply_extraction(uuid, text, jsonb, text) to service_role;

-- Ownership check for the extraction function: the caller's own current document of a draft, or null.
create or replace function public.hr_staff_document_for_extraction(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, hr, pg_temp as $fn$
 select jsonb_build_object('id', d.id, 'category', d.category, 'storagePath', d.storage_path, 'filename', d.filename, 'mimeType', d.mime_type)
 from hr.staff_documents d join hr.staff_profiles p on p.id = d.profile_id
 where d.id = p_id and d.is_current and p.auth_user_id = auth.uid() and p.status = 'draft';
$fn$;
revoke all on function public.hr_staff_document_for_extraction(uuid) from public, anon;
grant execute on function public.hr_staff_document_for_extraction(uuid) to authenticated;

create or replace function public.hr_staff_submit() returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_uid uuid := auth.uid(); p hr.staff_profiles; a hr.staff_applications;
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid for update;
 if not found then raise exception 'Start your staff application first.' using errcode = 'P0002'; end if;
 if p.status <> 'draft' then raise exception 'This application has already been submitted.' using errcode = '23514'; end if;
 select * into a from hr.staff_applications where profile_id = p.id;
 if not exists (select 1 from hr.staff_documents d where d.application_id = a.id and d.category = 'Passport' and d.is_current) then
  raise exception 'A passport is required before you can submit.' using errcode = '23514'; end if;
 if btrim(p.first_name) = '' or btrim(p.last_name) = '' then raise exception 'Enter your first and last name.' using errcode = '23514'; end if;
 if p.date_of_birth is null then raise exception 'Enter your date of birth.' using errcode = '23514'; end if;
 if btrim(p.address_street) = '' or btrim(p.address_country) = '' then raise exception 'Enter your address.' using errcode = '23514'; end if;
 if btrim(p.emergency_name) = '' or btrim(p.emergency_relationship) = '' or p.emergency_phone_e164 is null then
  raise exception 'Enter an emergency contact: name, relationship and phone.' using errcode = '23514'; end if;
 if a.requested_role is null then raise exception 'Choose the role you are requesting.' using errcode = '23514'; end if;
 perform set_config('hr.actor', v_uid::text, true); perform set_config('hr.actor_kind', 'applicant', true); perform set_config('hr.note', 'Submitted', true);
 update hr.staff_profiles set status = 'submitted' where id = p.id;
 update hr.staff_applications set submitted_at = now() where id = a.id;
 return public.hr_staff_me();
end $fn$;
revoke all on function public.hr_staff_submit() from public, anon;
grant execute on function public.hr_staff_submit() to authenticated;

-- ------------------------------------------------------------------ admin
create or replace function hr.require_admin() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
begin
 if auth.uid() is null or not public.cms_is_admin() then raise exception 'Only an administrator can do this.' using errcode = '42501'; end if;
 return auth.uid();
end $fn$;
revoke all on function hr.require_admin() from public, anon, authenticated;
grant execute on function hr.require_admin() to authenticated;

create or replace function public.hr_admin_staff_list(p_status text default null, p_search text default null, p_limit integer default 50, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_search text := nullif(btrim(coalesce(p_search, '')), ''); v_total integer; v_rows jsonb;
begin
 perform hr.require_admin();
 if p_status is not null and p_status <> '' and p_status not in ('draft','submitted','preboarding','active','rejected','inactive') then raise exception 'Unknown status.' using errcode = '22023'; end if;
 select count(*) into v_total from hr.staff_profiles p
  where (coalesce(p_status, '') = '' or p.status = p_status)
   and (v_search is null or concat_ws(' ', p.first_name, p.middle_name, p.last_name, p.email, p.phone_e164) ilike '%' || replace(replace(v_search, '%', ''), '_', '') || '%');
 select coalesce(jsonb_agg(r order by (r->>'updatedAt') desc), '[]'::jsonb) into v_rows from (
  select jsonb_build_object('id', p.id, 'name', btrim(concat_ws(' ', p.first_name, p.last_name)), 'email', p.email, 'phone', p.phone_e164, 'status', p.status,
   'requestedRole', a.requested_role, 'role', (select ro.role from hr.staff_roles ro where ro.profile_id = p.id and ro.revoked_at is null),
   'submittedAt', a.submitted_at, 'updatedAt', p.updated_at) as r
  from hr.staff_profiles p join hr.staff_applications a on a.profile_id = p.id
  where (coalesce(p_status, '') = '' or p.status = p_status)
   and (v_search is null or concat_ws(' ', p.first_name, p.middle_name, p.last_name, p.email, p.phone_e164) ilike '%' || replace(replace(v_search, '%', ''), '_', '') || '%')
  order by p.updated_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) q;
 return jsonb_build_object('total', v_total, 'rows', v_rows);
end $fn$;
revoke all on function public.hr_admin_staff_list(text, text, integer, integer) from public, anon;
grant execute on function public.hr_admin_staff_list(text, text, integer, integer) to authenticated;

create or replace function public.hr_admin_staff_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.staff_profiles; a hr.staff_applications;
begin
 perform hr.require_admin();
 select * into p from hr.staff_profiles where id = p_id;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 select * into a from hr.staff_applications where profile_id = p.id;
 return jsonb_build_object('profile', to_jsonb(p) - 'auth_user_id', 'application', to_jsonb(a),
  'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'category', d.category, 'filename', d.filename, 'mimeType', d.mime_type, 'fileSize', d.file_size,
     'storagePath', d.storage_path, 'extractionStatus', d.extraction_status, 'extracted', d.extracted) order by d.created_at) from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb),
  'roles', coalesce((select jsonb_agg(jsonb_build_object('role', r.role, 'grantedAt', r.granted_at, 'revokedAt', r.revoked_at) order by r.granted_at) from hr.staff_roles r where r.profile_id = p.id), '[]'::jsonb),
  'events', coalesce((select jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'actorKind', e.actor_kind, 'note', e.note, 'at', e.created_at) order by e.id) from hr.staff_status_events e where e.profile_id = p.id), '[]'::jsonb),
  'hasCmsAccess', exists (select 1 from public.cms_users c where c.auth_user_id = p.auth_user_id and c.status = 'Active'));
end $fn$;
revoke all on function public.hr_admin_staff_detail(uuid) from public, anon;
grant execute on function public.hr_admin_staff_detail(uuid) to authenticated;

-- Shared by the admin transitions: sets the audit context, moves the status and stamps the review.
create or replace function hr.staff_move(p_id uuid, p_to text, p_note text, p_admin uuid, p_review boolean) returns hr.staff_profiles
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.staff_profiles;
begin
 perform set_config('hr.actor', p_admin::text, true); perform set_config('hr.actor_kind', 'admin', true); perform set_config('hr.note', coalesce(p_note, ''), true);
 update hr.staff_profiles set status = p_to where id = p_id returning * into p;
 if p_review then update hr.staff_applications set reviewed_by = p_admin, reviewed_at = now(), review_note = left(coalesce(p_note, ''), 2000) where profile_id = p_id; end if;
 return p;
end $fn$;
revoke all on function hr.staff_move(uuid, text, text, uuid, boolean) from public, anon, authenticated;

-- submitted -> preboarding, recording the role. Granting Admin needs p_confirm_admin = true (the UI asks the Admin to confirm).
create or replace function public.hr_admin_staff_approve(p_id uuid, p_role text, p_note text default null, p_confirm_admin boolean default false) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles;
begin
 if p_role not in ('admin','trainer') then raise exception 'Choose Admin or Trainer.' using errcode = '22023'; end if;
 if p_role = 'admin' and p_confirm_admin is not true then raise exception 'Confirm that this person should become an Admin.' using errcode = '23514'; end if;
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status <> 'submitted' then raise exception 'Only a submitted application can be approved.' using errcode = '23514'; end if;
 if p.auth_user_id = v_admin then raise exception 'You cannot approve your own application.' using errcode = '42501'; end if;
 update hr.staff_roles set revoked_at = now(), revoked_by = v_admin where profile_id = p.id and revoked_at is null;
 insert into hr.staff_roles(profile_id, role, granted_by) values (p.id, p_role, v_admin);
 perform hr.staff_move(p.id, 'preboarding', coalesce(nullif(btrim(p_note), ''), 'Approved as ' || p_role), v_admin, true);
 return public.hr_admin_staff_detail(p.id);
end $fn$;
revoke all on function public.hr_admin_staff_approve(uuid, text, text, boolean) from public, anon;
grant execute on function public.hr_admin_staff_approve(uuid, text, text, boolean) to authenticated;

create or replace function public.hr_admin_staff_reject(p_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles;
begin
 if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'Add a note explaining the decision.' using errcode = '22023'; end if;
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status not in ('submitted','preboarding') then raise exception 'Only a submitted or preboarding application can be rejected.' using errcode = '23514'; end if;
 update hr.staff_roles set revoked_at = now(), revoked_by = v_admin where profile_id = p.id and revoked_at is null;
 perform hr.staff_move(p.id, 'rejected', btrim(p_note), v_admin, true);
 return public.hr_admin_staff_detail(p.id);
end $fn$;
revoke all on function public.hr_admin_staff_reject(uuid, text) from public, anon;
grant execute on function public.hr_admin_staff_reject(uuid, text) to authenticated;

-- preboarding (or a reactivated inactive person) -> active. An Admin role writes the cms_users row now; a trainer gets none.
create or replace function public.hr_admin_staff_activate(p_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; v_role text; c public.cms_users;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status not in ('preboarding','inactive') then raise exception 'Only a preboarding or inactive person can be activated.' using errcode = '23514'; end if;
 select role into v_role from hr.staff_roles where profile_id = p.id and revoked_at is null;
 if v_role is null then raise exception 'Approve the application with a role first.' using errcode = '23514'; end if;
 if v_role = 'admin' then
  select * into c from public.cms_users where auth_user_id = p.auth_user_id;
  if found then
   update public.cms_users set role = 'Admin', status = 'Active', must_change_password = false where id = c.id;
  else
   if exists (select 1 from public.cms_users where lower(email) = p.email) then raise exception 'A CMS user with this email already exists.' using errcode = '23505'; end if;
   insert into public.cms_users(id, name, email, role, status, auth_user_id, must_change_password)
    values (gen_random_uuid()::text, btrim(concat_ws(' ', p.first_name, p.last_name)), p.email, 'Admin', 'Active', p.auth_user_id, false);
  end if;
 end if;
 perform hr.staff_move(p.id, 'active', coalesce(nullif(btrim(p_note), ''), 'Activated as ' || v_role), v_admin, false);
 return public.hr_admin_staff_detail(p.id);
end $fn$;
revoke all on function public.hr_admin_staff_activate(uuid, text) from public, anon;
grant execute on function public.hr_admin_staff_activate(uuid, text) to authenticated;

create or replace function public.hr_admin_staff_deactivate(p_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status <> 'active' then raise exception 'Only an active person can be deactivated.' using errcode = '23514'; end if;
 if p.auth_user_id = v_admin then raise exception 'You cannot deactivate yourself.' using errcode = '42501'; end if;
 update public.cms_users set status = 'Inactive' where auth_user_id = p.auth_user_id;
 perform hr.staff_move(p.id, 'inactive', coalesce(nullif(btrim(p_note), ''), 'Deactivated'), v_admin, false);
 return public.hr_admin_staff_detail(p.id);
end $fn$;
revoke all on function public.hr_admin_staff_deactivate(uuid, text) from public, anon;
grant execute on function public.hr_admin_staff_deactivate(uuid, text) to authenticated;

-- rejected -> draft, so a person an Admin turned down can edit and submit again. A note is required.
create or replace function public.hr_staff_reopen(p_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles;
begin
 if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'Add a note explaining why this is reopened.' using errcode = '22023'; end if;
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status <> 'rejected' then raise exception 'Only a rejected application can be reopened.' using errcode = '23514'; end if;
 perform hr.staff_move(p.id, 'draft', btrim(p_note), v_admin, false);
 update hr.staff_applications set submitted_at = null where profile_id = p.id;
 return public.hr_admin_staff_detail(p.id);
end $fn$;
revoke all on function public.hr_staff_reopen(uuid, text) from public, anon;
grant execute on function public.hr_staff_reopen(uuid, text) to authenticated;
