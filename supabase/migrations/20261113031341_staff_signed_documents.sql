-- STAFF-SIGN: staff are activated only once their documents are signed. During onboarding HR can send any document through
-- Skyline Sign (Documents & signatures on the onboarding page) or upload copies signed on paper (private bucket
-- staff-signed-documents). Activation needs: no Skyline Sign request still waiting, and at least one signed document in this
-- application (an e-signed request, an uploaded signed copy, or the signed offer). HR then activates manually, from Documents
-- submitted, Offer sent or Offer signed. On the way the record moves to offer_signed ("signed documents received", an unsigned
-- offer is withdrawn) so the existing login and activation steps are unchanged.

create table if not exists hr.staff_signed_uploads (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references hr.staff_profiles(id) on delete cascade,
 title text not null check (char_length(title) between 1 and 200),
 file_name text not null check (char_length(file_name) between 1 and 200),
 storage_path text not null unique,
 size_bytes bigint not null default 0,
 uploaded_by uuid,
 created_at timestamptz not null default now()
);
create index if not exists staff_signed_uploads_profile_idx on hr.staff_signed_uploads(profile_id);
alter table hr.staff_signed_uploads enable row level security;
revoke all on hr.staff_signed_uploads from anon, authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('staff-signed-documents', 'staff-signed-documents', false, 15728640, array['application/pdf', 'image/png', 'image/jpeg',
 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;
drop policy if exists staff_signed_documents_insert on storage.objects;
create policy staff_signed_documents_insert on storage.objects for insert to authenticated
 with check (bucket_id = 'staff-signed-documents' and public.cms_is_admin());
drop policy if exists staff_signed_documents_read on storage.objects;
create policy staff_signed_documents_read on storage.objects for select to authenticated
 using (bucket_id = 'staff-signed-documents' and public.cms_is_admin());

-- Documents submitted can now go straight to "signed" (documents signed outside the offer flow).
create or replace function hr.staff_transition_allowed(p_from text, p_to text) returns boolean
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $f$
 select p_to in ('active', 'inactive') or (p_from, p_to) in (
  ('applied','invited'), ('applied','rejected'),
  ('invited','documents_submitted'), ('invited','rejected'),
  ('documents_submitted','invited'), ('documents_submitted','offer_sent'), ('documents_submitted','offer_signed'), ('documents_submitted','rejected'),
  ('offer_sent','offer_signed'), ('offer_sent','documents_submitted'), ('offer_sent','rejected'),
  ('offer_signed','rejected'),
  ('rejected','applied'), ('inactive','applied'));
$f$;

-- Null when the person may be activated; otherwise what is missing. Counts only this application (since the last move to Applied).
create or replace function hr.staff_signing_problem(p_profile uuid) returns text
language plpgsql stable security definer set search_path = hr, public, pg_temp as $f$
declare p hr.staff_profiles; v_cycle timestamptz; v_waiting text;
begin
 select * into p from hr.staff_profiles where id = p_profile;
 if not found then return 'Staff application not found.'; end if;
 select coalesce(max(created_at), p.created_at) into v_cycle from hr.staff_status_events where profile_id = p.id and to_status = 'applied';
 select r.title into v_waiting from hr.sign_requests r where r.subject_type = 'employee' and r.subject_id = p.id
  and r.state in ('sending', 'sent', 'viewed', 'partial', 'email_failed') order by r.created_at limit 1;
 if v_waiting is not null then return format('"%s" is still waiting for signature. Wait until it is signed, or void it, before activating.', v_waiting); end if;
 if p.status = 'offer_signed'
  or exists (select 1 from hr.staff_offers o where o.profile_id = p.id and o.signed_at >= v_cycle)
  or exists (select 1 from hr.staff_signed_uploads u where u.profile_id = p.id and u.created_at >= v_cycle)
  or exists (select 1 from hr.sign_requests r where r.subject_type = 'employee' and r.subject_id = p.id and r.state = 'signed' and r.created_at >= v_cycle) then
  return null;
 end if;
 return 'Upload the signed documents, or send them for e-signature, before activating.';
end $f$;
revoke all on function hr.staff_signing_problem(uuid) from public, anon, authenticated;

create or replace function public.hr_admin_staff_signed_uploads(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $f$
begin
 perform hr.require_admin();
 return jsonb_build_object('problem', hr.staff_signing_problem(p_id),
  'uploads', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'title', u.title, 'fileName', u.file_name, 'path', u.storage_path, 'size', u.size_bytes,
   'createdAt', u.created_at) order by u.created_at desc) from hr.staff_signed_uploads u where u.profile_id = p_id), '[]'::jsonb));
end $f$;
revoke all on function public.hr_admin_staff_signed_uploads(uuid) from public, anon;
grant execute on function public.hr_admin_staff_signed_uploads(uuid) to authenticated;

create or replace function public.hr_admin_staff_signed_upload_add(p_id uuid, p_title text, p_path text, p_name text, p_size bigint) returns jsonb
language plpgsql security definer set search_path = public, hr, storage, pg_temp as $f$
declare v_admin uuid := hr.require_admin(); u hr.staff_signed_uploads; v_title text := left(btrim(regexp_replace(coalesce(p_title, ''), '[[:cntrl:]]', '', 'g')), 200);
begin
 if not exists (select 1 from hr.staff_profiles where id = p_id) then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if v_title = '' then raise exception 'Name the document (for example: Employment contract).' using errcode = '22023'; end if;
 if coalesce(p_path, '') not like p_id::text || '/%' or p_path like '%..%'
  or not exists (select 1 from storage.objects o where o.bucket_id = 'staff-signed-documents' and o.name = p_path) then
  raise exception 'Upload the file first' using errcode = '22023'; end if;
 insert into hr.staff_signed_uploads(profile_id, title, file_name, storage_path, size_bytes, uploaded_by)
 values (p_id, v_title, left(coalesce(nullif(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), ''), 'document'), 200), p_path, greatest(coalesce(p_size, 0), 0), v_admin)
 returning * into u;
 return jsonb_build_object('id', u.id);
end $f$;
revoke all on function public.hr_admin_staff_signed_upload_add(uuid, text, text, text, bigint) from public, anon;
grant execute on function public.hr_admin_staff_signed_upload_add(uuid, text, text, text, bigint) to authenticated;

create or replace function public.hr_admin_staff_signed_upload_remove(p_upload uuid) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $f$
declare v_admin uuid := hr.require_admin(); u hr.staff_signed_uploads;
begin
 delete from hr.staff_signed_uploads where id = p_upload returning * into u;
 if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
 insert into public.storage_cleanup_queue(bucket_name, storage_path, reason, requested_by) values ('staff-signed-documents', u.storage_path, 'staff signed document removed', v_admin);
 return jsonb_build_object('ok', true);
end $f$;
revoke all on function public.hr_admin_staff_signed_upload_remove(uuid) from public, anon;
grant execute on function public.hr_admin_staff_signed_upload_remove(uuid) to authenticated;

-- Activation: from Documents submitted, Offer sent or Offer signed, once the signing check passes.
do $do$
declare d text := pg_get_functiondef('public.hr_admin_staff_activate_account(uuid,text,date,uuid,boolean)'::regprocedure);
 old_status text := $s$ if p.status <> 'offer_signed' then raise exception 'Only a person who signed the offer can be activated.' using errcode = '23514'; end if;$s$;
 new_status text := $s$ if p.status not in ('documents_submitted', 'offer_sent', 'offer_signed') then raise exception 'Only a person in onboarding can be activated.' using errcode = '23514'; end if;
 v_problem := hr.staff_signing_problem(p.id);
 if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;$s$;
 old_link text := $s$ update hr.staff_profiles set auth_user_id = p_auth_user_id where id = p.id;$s$;
 new_link text := $s$ -- Signed documents received outside the offer flow: an unsigned offer is withdrawn and the record moves to offer_signed.
 if p.status <> 'offer_signed' then
  update hr.staff_offers set withdrawn_at = now(), withdrawn_by = v_admin where profile_id = p.id and withdrawn_at is null and signed_at is null;
  perform set_config('hr.actor', v_admin::text, true); perform set_config('hr.actor_kind', 'admin', true); perform set_config('hr.note', 'Signed documents received', true);
  update hr.staff_profiles set status = 'offer_signed' where id = p.id;
 end if;
 update hr.staff_profiles set auth_user_id = p_auth_user_id where id = p.id;$s$;
begin
 if position(old_status in d) = 0 or position(old_link in d) = 0 then raise exception 'hr_admin_staff_activate_account changed; update this migration'; end if;
 d := replace(replace(d, old_status, new_status), old_link, new_link);
 execute d;
end $do$;
