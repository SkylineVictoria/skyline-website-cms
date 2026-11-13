-- BIZ-ONB: a new business starts in onboarding. Adding a business creates it Inactive with its point of contact as an
-- agents row (role agency_admin, no login) and sends nothing. The administrator finishes the formalities on the business
-- screen: a signed agent agreement, uploaded (private bucket business-documents) or signed through Skyline Sign by any of
-- the business's agents. Only then can the business be activated, and activating it invites the point of contact in the
-- same step. No agent can be added or invited while a business is inactive (portal_invitation_create already refuses).

alter table public.agencies add column if not exists onboarding_completed_at timestamptz;
-- Businesses already active have finished onboarding.
update public.agencies set onboarding_completed_at = coalesce(onboarding_completed_at, created_at) where status = 'Active';

create table if not exists public.business_documents (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.agencies(id) on delete cascade,
 kind text not null default 'agent_agreement' check (kind in ('agent_agreement', 'other')),
 file_name text not null check (char_length(file_name) between 1 and 200),
 storage_path text not null unique,
 size_bytes bigint not null default 0,
 uploaded_by uuid,
 created_at timestamptz not null default now()
);
create index if not exists business_documents_business_idx on public.business_documents(business_id);
alter table public.business_documents enable row level security;
revoke all on public.business_documents from anon, authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('business-documents', 'business-documents', false, 15728640, array['application/pdf', 'image/png', 'image/jpeg',
 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;
drop policy if exists business_documents_insert on storage.objects;
create policy business_documents_insert on storage.objects for insert to authenticated
 with check (bucket_id = 'business-documents' and public.portal_is_slit_admin());
drop policy if exists business_documents_read on storage.objects;
create policy business_documents_read on storage.objects for select to authenticated
 using (bucket_id = 'business-documents' and public.portal_is_slit_admin());

-- True when the business has a signed agent agreement: an uploaded one, or a completed Skyline Sign request to one of its agents.
create or replace function public.business_agreement_ready(p_business uuid) returns boolean
language sql stable security definer set search_path = public, hr as $f$
 select exists (select 1 from public.business_documents d where d.business_id = p_business and d.kind = 'agent_agreement')
  or exists (select 1 from hr.sign_requests r join public.agents g on g.id = r.subject_id
   where r.subject_type = 'agent' and g.business_id = p_business and r.state = 'signed');
$f$;
revoke all on function public.business_agreement_ready(uuid) from public, anon, authenticated;

-- Add business: the business (Inactive, onboarding) and its point of contact. No invitation, no login, no email.
create or replace function public.admin_business_create(p_agency jsonb, p_contact_email text, p_contact_name text) returns jsonb
language plpgsql security definer set search_path = public as $f$
declare a public.agencies; g public.agents; v_email text := lower(btrim(coalesce(p_contact_email, ''))); v_name text := btrim(coalesce(p_contact_name, ''));
 v_abn text := regexp_replace(coalesce(p_agency->>'registration_number', ''), '\D', '', 'g');
begin
 perform public.admin_business_require();
 if btrim(coalesce(p_agency->>'name', '')) = '' or btrim(coalesce(p_agency->>'code', '')) = '' then
  raise exception 'Agency name and a unique agency code are required.' using errcode = '22023'; end if;
 if v_abn !~ '^\d{11}$' then raise exception 'Enter the business''s 11-digit ABN.' using errcode = '22023'; end if;
 if v_email = '' or length(v_email) > 254 or v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then raise exception 'Enter a valid email address' using errcode = '22023'; end if;
 if char_length(v_name) not between 2 and 100 or v_name ~ '[[:cntrl:]]' then raise exception 'Enter the point of contact''s name (2 to 100 characters).' using errcode = '22023'; end if;
 if exists (select 1 from public.agencies where lower(code) = lower(btrim(p_agency->>'code'))) then
  raise exception 'An agency with this code already exists.' using errcode = '23505'; end if;
 insert into public.agencies(name, code, registration_number, business_email, phone, address, country, primary_contact, status)
 values (btrim(p_agency->>'name'), btrim(p_agency->>'code'), v_abn, v_email, coalesce(p_agency->>'phone', ''), coalesce(p_agency->>'address', ''),
  coalesce(p_agency->>'country', ''), v_name, 'Inactive') returning * into a;
 insert into public.agents(business_id, full_name, email, phone, role, status, status_changed_at, status_changed_by)
 values (a.id, v_name, v_email, coalesce(p_agency->>'phone', ''), 'agency_admin', 'Inactive', now(), auth.uid()) returning * into g;
 perform public.admin_business_audit('business_created', a.id, a.id, jsonb_build_object('name', a.name, 'contact', v_email, 'onboarding', true));
 return jsonb_build_object('agencyId', a.id, 'businessId', a.id, 'agencyName', a.name, 'contactAgentId', g.id, 'onboarding', true);
end $f$;
revoke all on function public.admin_business_create(jsonb, text, text) from public, anon;
grant execute on function public.admin_business_create(jsonb, text, text) to authenticated;

-- The old one-step path (Active business plus an immediate invitation) is closed.
create or replace function public.portal_agency_create_with_admin(p_actor uuid, p_agency jsonb, p_admin_email text, p_admin_name text) returns jsonb
language plpgsql security definer set search_path = public as $f$
begin
 raise exception 'Add the business in Businesses > Add business. It is activated after its agent agreement is signed.' using errcode = '22023';
end $f$;

create or replace function public.admin_business_documents(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $f$
begin
 perform public.admin_business_require();
 return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'fileName', d.file_name, 'path', d.storage_path, 'size', d.size_bytes,
  'createdAt', d.created_at, 'uploadedBy', coalesce(p.full_name, p.email, '')) order by d.created_at desc)
  from public.business_documents d left join public.portal_profiles p on p.auth_user_id = d.uploaded_by where d.business_id = p_business), '[]'::jsonb);
end $f$;
revoke all on function public.admin_business_documents(uuid) from public, anon;
grant execute on function public.admin_business_documents(uuid) to authenticated;

create or replace function public.admin_business_document_add(p_business uuid, p_kind text, p_path text, p_name text, p_size bigint) returns jsonb
language plpgsql security definer set search_path = public, storage as $f$
declare d public.business_documents;
begin
 perform public.admin_business_require();
 if not exists (select 1 from public.agencies where id = p_business) then raise exception 'Business not found' using errcode = 'P0002'; end if;
 if coalesce(p_kind, '') not in ('agent_agreement', 'other') then raise exception 'Unknown document type' using errcode = '22023'; end if;
 if coalesce(p_path, '') not like p_business::text || '/%' or p_path like '%..%'
  or not exists (select 1 from storage.objects o where o.bucket_id = 'business-documents' and o.name = p_path) then
  raise exception 'Upload the file first' using errcode = '22023'; end if;
 insert into public.business_documents(business_id, kind, file_name, storage_path, size_bytes, uploaded_by)
 values (p_business, p_kind, left(coalesce(nullif(btrim(regexp_replace(p_name, '[[:cntrl:]]', '', 'g')), ''), 'document'), 200), p_path, greatest(coalesce(p_size, 0), 0), auth.uid())
 returning * into d;
 perform public.admin_business_audit('business_document_added', p_business, p_business, jsonb_build_object('kind', d.kind, 'file', d.file_name));
 return jsonb_build_object('id', d.id);
end $f$;
revoke all on function public.admin_business_document_add(uuid, text, text, text, bigint) from public, anon;
grant execute on function public.admin_business_document_add(uuid, text, text, text, bigint) to authenticated;

create or replace function public.admin_business_document_remove(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $f$
declare d public.business_documents;
begin
 perform public.admin_business_require();
 delete from public.business_documents where id = p_id returning * into d;
 if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
 insert into public.storage_cleanup_queue(bucket_name, storage_path, reason, requested_by) values ('business-documents', d.storage_path, 'business document removed', auth.uid());
 perform public.admin_business_audit('business_document_removed', d.business_id, d.business_id, jsonb_build_object('kind', d.kind, 'file', d.file_name));
 return jsonb_build_object('ok', true);
end $f$;
revoke all on function public.admin_business_document_remove(uuid) from public, anon;
grant execute on function public.admin_business_document_remove(uuid) to authenticated;

-- Activate (and invite the point of contact) only with a signed agent agreement.
create or replace function public.admin_business_set_status(p_business uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $f$
declare a public.agencies; inv public.agency_invitations; poc public.agents; v_reviewed boolean := false; v_new jsonb;
begin
 perform public.admin_business_require();
 if p_status is null or p_status not in ('Active','Inactive') then raise exception 'Status must be Active or Inactive' using errcode = '22023'; end if;
 select * into a from public.agencies where id = p_business for update;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 if p_status = 'Active' and a.status <> 'Active' and not public.business_agreement_ready(a.id) then
  raise exception 'Upload the signed agent agreement, or have it signed through Skyline Sign, before activating this business.' using errcode = '23514', hint = 'agreement_required'; end if;
 if a.status is distinct from p_status then
  update public.agencies set status = p_status, updated_at = now(),
   onboarding_completed_at = case when p_status = 'Active' then coalesce(onboarding_completed_at, now()) else onboarding_completed_at end where id = a.id;
 end if;
 if a.registration_requested_at is not null and a.registration_reviewed_at is null then
  update public.agencies set registration_reviewed_at = now(), registration_reviewed_by = auth.uid(),
   registration_decision = case when p_status = 'Active' then 'approved' else 'declined' end, updated_at = now() where id = a.id;
  if p_status = 'Active' then
   update public.agency_invitations set expires_at = greatest(expires_at, now() + interval '7 days') where agency_id = a.id and status = 'pending';
  else
   update public.agency_invitations set status = 'revoked', revoked_at = now() where agency_id = a.id and status = 'pending';
   update public.agents set status = 'Inactive', status_changed_at = now(), status_changed_by = auth.uid(), updated_at = now()
    where business_id = a.id and profile_id is null and status <> 'Inactive';
  end if;
  v_reviewed := true;
 end if;
 select * into inv from public.agency_invitations i where i.agency_id = a.id and i.status = 'pending' and i.role = 'agency_admin' order by i.created_at limit 1;
 -- First activation: the point of contact becomes active and is invited now.
 if p_status = 'Active' and inv.id is null then
  select * into poc from public.agents g where g.business_id = a.id and g.role = 'agency_admin' and g.profile_id is null and g.email <> ''
   order by g.created_at limit 1;
  if poc.id is not null then
   update public.agents set status = 'Active', status_changed_at = now(), status_changed_by = auth.uid(), updated_at = now() where id = poc.id and status <> 'Active';
   v_new := public.portal_invitation_create(auth.uid(), a.id, poc.email, poc.full_name, 'agency_admin');
   select * into inv from public.agency_invitations where id = (v_new->>'invitationId')::uuid;
  end if;
 end if;
 perform public.admin_business_audit(case when p_status = 'Active' then 'business_activated' else 'business_deactivated' end, a.id, a.id,
  jsonb_build_object('name', a.name, 'registrationReviewed', v_reviewed, 'contactInvited', v_new is not null));
 return jsonb_build_object('businessId', a.id, 'status', p_status, 'agencyId', a.id, 'workspaceCreated', false, 'reviewed', v_reviewed,
  'pendingInvitation', case when p_status = 'Active' and inv.id is not null then jsonb_build_object('id', inv.id, 'email', inv.email, 'name', inv.full_name) else null end);
end $f$;

-- Adding or activating an agent needs an active business; it no longer activates the business on the way.
do $do$
declare d text := pg_get_functiondef('public.admin_agent_activate(uuid,uuid,text,text,text,text,text)'::regprocedure);
 old_block text := E' if a.status <> ''Active'' then\r\n  update public.agencies set status = ''Active'', updated_at = now() where id = a.id;\r\n  v_business_activated := true;\r\n end if;';
begin
 if position(old_block in d) = 0 then
  old_block := replace(old_block, E'\r\n', E'\n');
  if position(old_block in d) = 0 then raise exception 'admin_agent_activate changed; update this migration'; end if;
 end if;
 d := replace(d, old_block, E' if a.status <> ''Active'' then\n  raise exception ''Activate the business first: its agent agreement must be signed before agents can be added.'' using errcode = ''23514'', hint = ''business_inactive'';\n end if;');
 execute d;
end $do$;

create or replace function public.admin_business_detail(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $f$
declare a public.agencies; poc public.agents;
begin
 perform public.admin_business_require();
 select * into a from public.agencies where id = p_business;
 if not found then return null; end if;
 select * into poc from public.agents g where g.business_id = a.id and g.role = 'agency_admin' order by g.created_at limit 1;
 return jsonb_build_object(
  'id', a.id, 'name', a.name, 'status', a.status, 'createdAt', a.created_at,
  'agency', jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name, 'status', a.status, 'email', a.business_email, 'phone', a.phone,
   'address', a.address, 'country', a.country, 'contact', a.primary_contact, 'registrationNumber', a.registration_number, 'createdAt', a.created_at),
  'onboarding', jsonb_build_object('completedAt', a.onboarding_completed_at, 'agreementReady', public.business_agreement_ready(a.id),
   'contact', case when poc.id is null then null else jsonb_build_object('agentId', poc.id, 'name', poc.full_name, 'email', poc.email, 'hasLogin', poc.profile_id is not null) end),
  'counts', jsonb_build_object(
   'admins', (select count(*) from public.agents g where g.business_id = a.id and g.role = 'agency_admin' and g.status = 'Active'),
   'agents', (select count(*) from public.agents g where g.business_id = a.id and g.role = 'agent' and g.status = 'Active'),
   'inactiveAgents', (select count(*) from public.agents g where g.business_id = a.id and g.status <> 'Active'),
   'students', (select count(*) from public.enrollment_students s where s.agency_id = a.id),
   'applications', (select count(*) from public.enrollment_applications e where e.agency_id = a.id)),
  'statusCounts', public.admin_status_counts(a.id));
end $f$;
