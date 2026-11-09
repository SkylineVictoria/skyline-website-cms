-- Remove the OMARA register completely (owner's decision, 2 Nov 2026). Deletes the register copy (omara_agents), the
-- business-to-agent links taken from it (business_agent_affiliations), the MARN links (agent_directory_links), the 4,784
-- businesses that were created from it, and the OMARA/MARN fields elsewhere. Nothing in use depended on it: no business created
-- from it had a workspace or agents, no agent had been activated from it, and no MARN was linked.
-- Functions keep their signatures and the shape of what they return, so the screens already live keep working (OMARA parts
-- simply come back empty) until the screens without OMARA are released.
-- Not reversible: the data can only come back by importing the public OMARA register again.
set local lock_timeout='5s';
set local statement_timeout='120s';

-- ------------------------------------------------------------------ functions no longer needed
drop function if exists public.admin_link_agent_marn(uuid, uuid, text);
drop function if exists public.admin_agent_detail(uuid);
drop function if exists public.admin_agents_list(text, text, uuid, integer, integer);
drop function if exists public.admin_business_link_agency(uuid, uuid);

-- ------------------------------------------------------------------ data and tables
alter table public.business_agents drop column omara_agent_id;
-- The three reference each other (keys and read rules), so they are dropped in one statement.
drop table public.agent_directory_links, public.business_agent_affiliations, public.omara_agents;
drop function if exists public.omara_attach_directory_business();
delete from public.businesses b where b.identity_status = 'directory_candidate'
 and not exists (select 1 from public.agencies a where a.business_id = b.id)
 and not exists (select 1 from public.business_agents g where g.business_id = b.id)
 and not exists (select 1 from public.enrollment_students s join public.agencies a on a.id = s.agency_id where a.business_id = b.id);
drop policy businesses_admin_create_unverified on public.businesses;
create policy businesses_admin_create_unverified on public.businesses for insert to authenticated
 with check (public.portal_is_slit_admin() and identity_status = 'unverified'
  and registration_country is null and registration_type is null and registration_number is null and verified_at is null);
alter table public.businesses drop column directory_name_key;
comment on table public.businesses is 'Canonical business IDs for agencies. Private business contacts remain in agencies. Verify legal identifiers before onboarding or merging.';

-- ------------------------------------------------------------------ membership sync without MARN links
create or replace function public.business_agent_sync_membership() returns trigger
language plpgsql security definer set search_path = '' as $fn$
declare p public.portal_profiles; v_business uuid; v_id uuid; v_status text;
begin
 select * into p from public.portal_profiles where id = new.user_id;
 select business_id into v_business from public.agencies where id = new.agency_id;
 if v_business is null then return new; end if;
 v_status := case when new.status = 'Active' and coalesce(p.status, 'Active') = 'Active' then 'Active' else 'Inactive' end;
 select id into v_id from public.business_agents where profile_id = new.user_id;
 if v_id is null then
  -- A SLIT activation waiting for this person: same business and email, no login yet.
  select id into v_id from public.business_agents
   where profile_id is null and business_id = v_business and email <> '' and email = lower(btrim(coalesce(p.email, '')))
   order by updated_at desc limit 1;
 end if;
 if v_id is null then
  insert into public.business_agents(business_id, profile_id, full_name, email, phone, role, status, status_changed_at)
  values (v_business, new.user_id, coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''), 'Portal user'),
   lower(btrim(coalesce(p.email, ''))), left(coalesce(p.phone, ''), 40), new.role, v_status, now());
 else
  update public.business_agents set profile_id = new.user_id, business_id = v_business, role = new.role,
   status_changed_at = case when status is distinct from v_status then now() else status_changed_at end,
   status = v_status, updated_at = now()
  where id = v_id;
 end if;
 return new;
end $fn$;

-- ------------------------------------------------------------------ businesses
create or replace function public.admin_business_set_status(p_business uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare b public.businesses; a public.agencies; v_created boolean := false;
begin
 perform public.admin_business_require();
 if p_status is null or p_status not in ('Active','Inactive') then raise exception 'Status must be Active or Inactive' using errcode = '22023'; end if;
 select * into b from public.businesses where id = p_business for update;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 if b.identity_status = 'archived' then raise exception 'This business record was merged into another one' using errcode = '22023'; end if;
 select * into a from public.agencies where business_id = b.id for update;
 if p_status = 'Active' and a.id is null then
  -- First activation creates the workspace; contact details are added on the business page.
  begin
   insert into public.agencies(name, code, country, status, business_id)
   values (b.display_name, 'B-' || upper(substr(replace(b.id::text, '-', ''), 1, 8)), coalesce(b.registration_country, 'Australia'), 'Active', b.id)
   returning * into a;
  exception when unique_violation then
   raise exception 'An agency with this name already exists. Open that agency instead.' using errcode = '23505';
  end;
  v_created := true;
 elsif a.id is not null and a.status is distinct from p_status then
  update public.agencies set status = p_status, updated_at = now() where id = a.id;
 end if;
 update public.businesses set status = p_status, status_changed_at = now(), status_changed_by = auth.uid() where id = b.id;
 perform public.admin_business_audit(case when p_status = 'Active' then 'business_activated' else 'business_deactivated' end,
  b.id, a.id, jsonb_build_object('name', b.display_name, 'workspaceCreated', v_created));
 return jsonb_build_object('businessId', b.id, 'status', p_status, 'agencyId', a.id, 'workspaceCreated', v_created);
end $fn$;

-- p_source is kept for the screens already live: every business is now added by SLIT ('omara' matches nothing).
create or replace function public.admin_business_list(p_search text default '', p_status text default '', p_source text default '',
 p_workspace text default '', p_limit integer default 25, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare v_words text[] := public.admin_search_words(p_search); result jsonb;
begin
 perform public.admin_business_require();
 if coalesce(p_status, '') not in ('', 'Active', 'Inactive') then raise exception 'Invalid status' using errcode = '22023'; end if;
 if coalesce(p_source, '') not in ('', 'omara', 'manual') then raise exception 'Invalid source' using errcode = '22023'; end if;
 if coalesce(p_workspace, '') not in ('', 'yes', 'no') then raise exception 'Invalid workspace filter' using errcode = '22023'; end if;
 with base as (
  select b.id, b.display_name as name, b.status, b.identity_status,
   a.id as agency_id, a.code as agency_code, a.business_email, a.primary_contact, a.phone as agency_phone, a.address as agency_address,
   (select string_agg(concat_ws(' ', g.full_name, g.email), ' ') from public.business_agents g where g.business_id = b.id) as haystack
  from public.businesses b
  left join public.agencies a on a.business_id = b.id
  where b.identity_status <> 'archived'
 ), searched as (
  select * from base s
  where coalesce(p_source, '') <> 'omara'
   and (coalesce(p_workspace, '') = '' or (p_workspace = 'yes') = (s.agency_id is not null))
   and not exists (select 1 from unnest(v_words) w where strpos(lower(concat_ws(' ', s.name, s.agency_code, s.business_email,
     s.primary_contact, s.agency_phone, s.agency_address, s.haystack)), w) = 0)
 ), filtered as (
  select *, case when status = 'Active' then 0 when agency_id is not null then 1 else 2 end as rank_key
  from searched where coalesce(p_status, '') = '' or status = p_status
 ), page as (
  select * from filtered order by rank_key, lower(name), id
  limit least(greatest(coalesce(p_limit, 25), 1), 100) offset least(greatest(coalesce(p_offset, 0), 0), 1000000)
 )
 select jsonb_build_object(
  'total', (select count(*) from filtered),
  'counts', jsonb_build_object('all', (select count(*) from searched),
   'active', (select count(*) from searched where status = 'Active'),
   'inactive', (select count(*) from searched where status = 'Inactive')),
  'rows', coalesce((select jsonb_agg(jsonb_build_object(
    'id', p.id, 'name', p.name, 'status', p.status, 'source', 'manual', 'identityStatus', p.identity_status,
    'agencyId', p.agency_id, 'agencyCode', coalesce(p.agency_code, ''),
    'place', coalesce(nullif(p.agency_address, ''), ''),
    'contact', coalesce(p.primary_contact, ''), 'email', coalesce(p.business_email, ''),
    'omaraAgents', 0, 'omaraEnded', 0,
    'admins', (select count(*) from public.agency_memberships m join public.portal_profiles pp on pp.id = m.user_id
      where m.agency_id = p.agency_id and m.role = 'agency_admin' and m.status = 'Active' and pp.status = 'Active'),
    'agents', (select count(*) from public.agency_memberships m join public.portal_profiles pp on pp.id = m.user_id
      where m.agency_id = p.agency_id and m.role = 'agent' and m.status = 'Active' and pp.status = 'Active'),
    'students', (select count(*) from public.enrollment_students s where s.agency_id = p.agency_id),
    'applications', (select count(*) from public.enrollment_applications e where e.agency_id = p.agency_id),
    'statusCounts', case when p.agency_id is null then '{}'::jsonb else public.admin_status_counts(p.agency_id) end
   ) order by p.rank_key, lower(p.name), p.id) from page p), '[]'::jsonb))
 into result;
 return result;
end $fn$;

create or replace function public.admin_business_detail(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare b public.businesses; a public.agencies;
begin
 perform public.admin_business_require();
 select * into b from public.businesses where id = p_business;
 if not found then return null; end if;
 select * into a from public.agencies where business_id = b.id;
 return jsonb_build_object(
  'id', b.id, 'name', b.display_name, 'status', b.status, 'identityStatus', b.identity_status,
  'registration', jsonb_build_object('country', b.registration_country, 'type', b.registration_type, 'number', b.registration_number),
  'statusChangedAt', b.status_changed_at, 'createdAt', b.created_at, 'source', 'manual',
  'directoryContact', jsonb_build_object('name', '', 'email', '', 'phone', '', 'address', '', 'website', '', 'place', ''),
  'agency', case when a.id is null then null else jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name, 'status', a.status,
   'email', a.business_email, 'phone', a.phone, 'address', a.address, 'country', a.country, 'contact', a.primary_contact,
   'registrationNumber', a.registration_number, 'createdAt', a.created_at) end,
  'counts', jsonb_build_object('omaraAgents', 0, 'omaraEnded', 0,
   'admins', (select count(*) from public.agency_memberships m join public.portal_profiles pp on pp.id = m.user_id
     where m.agency_id = a.id and m.role = 'agency_admin' and m.status = 'Active' and pp.status = 'Active'),
   'agents', (select count(*) from public.agency_memberships m join public.portal_profiles pp on pp.id = m.user_id
     where m.agency_id = a.id and m.role = 'agent' and m.status = 'Active' and pp.status = 'Active'),
   'students', (select count(*) from public.enrollment_students s where s.agency_id = a.id),
   'applications', (select count(*) from public.enrollment_applications e where e.agency_id = a.id)),
  'statusCounts', case when a.id is null then '{}'::jsonb else public.admin_status_counts(a.id) end);
end $fn$;

-- Kept only so the OMARA tab of the screens already live shows nothing instead of an error; the new screens do not call it.
create or replace function public.admin_business_agents(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
begin
 perform public.admin_business_require();
 return '[]'::jsonb;
end $fn$;

-- The Add business page's duplicate search: agencies already added (the OMARA part is gone). Same signature and shape as before.
create or replace function public.admin_agency_directory(p_search text default '', p_status text default '', p_limit integer default 25,
 p_offset integer default 0, p_key text default null) returns jsonb
language plpgsql stable security invoker set search_path = public as $fn$
declare result jsonb; v_words text[] := public.admin_search_words(p_search);
begin
 if auth.uid() is null or not public.portal_is_slit_admin() then raise exception 'Agency administration required' using errcode = '42501'; end if;
 if coalesce(p_status, '') not in ('', 'Active', 'Inactive') then raise exception 'Invalid agency status' using errcode = '22023'; end if;
 with directory as (
  select a.id::text as id, a.id::text as existing_agency_id, a.directory_key, a.name, a.code, a.registration_number,
   a.business_email, a.phone, a.address, a.country, a.primary_contact, a.status, a.is_permanent, a.created_at,
   (select count(*) from public.agency_memberships m where m.agency_id = a.id and m.role = 'agent') as agent_count,
   (select count(*) from public.enrollment_applications e where e.agency_id = a.id) as application_count,
   'portal'::text as source, ''::text as marn
  from public.agencies a
  where public.tenant_scope(null::uuid)
 ), filtered as (
  select * from directory d where (coalesce(p_key, '') = '' or d.directory_key = p_key) and (coalesce(p_status, '') = '' or d.status = p_status)
   and not exists (select 1 from unnest(v_words) w where strpos(lower(concat_ws(' ', d.name, d.code, d.business_email, d.primary_contact)), w) = 0)
 )
 select jsonb_build_object('total', (select count(*) from filtered),
  'rows', coalesce((select jsonb_agg(to_jsonb(f) order by lower(f.name), f.id) from
   (select * from filtered order by lower(name), id limit least(greatest(coalesce(p_limit, 25), 1), 100) offset greatest(coalesce(p_offset, 0), 0)) f), '[]'::jsonb))
 into result;
 return result;
end $fn$;

-- ------------------------------------------------------------------ agents
-- p_omara is kept in the signature for the screens already live and is ignored.
create or replace function public.admin_agent_activate(p_agent uuid, p_omara uuid, p_business uuid, p_new_business text,
 p_name text, p_email text, p_role text default 'agent') returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
 g public.business_agents; b public.businesses; v_agency uuid; v_old_agency uuid;
 v_business_created boolean := false; v_business_activated boolean := false;
 v_name text := btrim(coalesce(p_name, '')); v_email text := lower(btrim(coalesce(p_email, ''))); v_new text := btrim(coalesce(p_new_business, ''));
begin
 perform public.admin_business_require();
 if coalesce(p_role, '') not in ('agent', 'agency_admin') then raise exception 'Role must be agent or agency admin' using errcode = '22023'; end if;
 if v_email <> '' and (length(v_email) > 254 or v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$') then
  raise exception 'Enter a valid email address' using errcode = '22023'; end if;
 if v_name ~ '[[:cntrl:]]' or length(v_name) > 200 then raise exception 'Enter a valid name' using errcode = '22023'; end if;
 if p_agent is not null then
  select * into g from public.business_agents where id = p_agent for update;
  if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;
 end if;
 if v_name = '' then v_name := coalesce(nullif(btrim(g.full_name), ''), ''); end if;
 if v_name = '' then raise exception 'Enter the agent''s name' using errcode = '22023'; end if;
 if v_email = '' then v_email := coalesce(g.email, ''); end if;

 if v_new <> '' then
  if length(v_new) > 200 or v_new ~ '[[:cntrl:]]' then raise exception 'Enter a valid business name' using errcode = '22023'; end if;
  if exists (select 1 from public.businesses x where lower(btrim(x.display_name)) = lower(v_new) and x.identity_status <> 'archived') then
   raise exception 'A business with this name already exists. Choose it from the list instead.' using errcode = '23505'; end if;
  insert into public.businesses(display_name, identity_status) values (v_new, 'unverified') returning * into b;
  v_business_created := true;
 else
  select * into b from public.businesses where id = p_business;
  if not found then raise exception 'Choose the business this agent works for' using errcode = '22023'; end if;
  if b.identity_status = 'archived' then raise exception 'This business record was merged into another one' using errcode = '22023'; end if;
 end if;
 if b.status <> 'Active' then
  perform public.admin_business_set_status(b.id, 'Active');
  v_business_activated := true;
 end if;
 select id into v_agency from public.agencies where business_id = b.id;

 if g.profile_id is not null then
  select agency_id into v_old_agency from public.agency_memberships where user_id = g.profile_id;
  if v_old_agency is distinct from v_agency then
   if exists (select 1 from public.enrollment_applications e where e.assigned_agent_id = g.profile_id and e.agency_id = v_old_agency) then
    raise exception 'This agent has applications with their current business, so they stay attached to it.' using errcode = '23514'; end if;
  end if;
 end if;

 if g.id is null then
  insert into public.business_agents(business_id, full_name, email, role, status, status_changed_at, status_changed_by)
  values (b.id, v_name, v_email, p_role, 'Active', now(), auth.uid()) returning * into g;
 else
  update public.business_agents set business_id = b.id, full_name = v_name, email = v_email, role = p_role, status = 'Active',
   status_changed_at = now(), status_changed_by = auth.uid(), updated_at = now() where id = g.id returning * into g;
 end if;
 if g.profile_id is not null then
  update public.portal_profiles set status = 'Active', updated_at = now() where id = g.profile_id and status <> 'Active';
  update public.agency_memberships set status = 'Active', role = p_role, agency_id = v_agency, updated_at = now() where user_id = g.profile_id;
 end if;
 perform public.admin_business_audit('agent_activated', b.id, v_agency, jsonb_build_object('agent', v_name,
  'businessCreated', v_business_created, 'businessActivated', v_business_activated));
 return jsonb_build_object('agentId', g.id, 'businessId', b.id, 'businessName', b.display_name, 'agencyId', v_agency,
  'businessCreated', v_business_created, 'businessActivated', v_business_activated,
  'hasLogin', g.profile_id is not null, 'email', v_email, 'name', v_name, 'role', p_role);
end $fn$;

create or replace function public.admin_agent_directory(p_search text default '', p_status text default '', p_business uuid default null,
 p_limit integer default 25, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare v_words text[] := public.admin_search_words(p_search); result jsonb;
begin
 perform public.admin_business_require();
 if coalesce(p_status, '') not in ('', 'Active', 'Invited', 'Inactive') then raise exception 'Invalid status' using errcode = '22023'; end if;
 with rows as (
  select g.id as agent_id, g.profile_id, g.full_name as name, g.email, g.phone, g.role, g.business_id,
   case when g.status <> 'Active' then 'Inactive'
        when g.profile_id is null then 'Invited'
        when exists (select 1 from public.agency_memberships m join public.portal_profiles pp on pp.id = m.user_id
          where m.user_id = g.profile_id and m.status = 'Active' and pp.status = 'Active') then 'Active'
        else 'Inactive' end as status,
   b.display_name as business_name, b.status as business_status
  from public.business_agents g
  left join public.businesses b on b.id = g.business_id
  where (p_business is null or g.business_id = p_business)
   and not exists (select 1 from unnest(v_words) w where strpos(lower(concat_ws(' ', g.full_name, g.email, g.phone, b.display_name)), w) = 0)
 ), filtered as (
  select *, case status when 'Active' then 0 when 'Invited' then 1 else 2 end as rank_key from rows where coalesce(p_status, '') = '' or status = p_status
 ), page as (
  select * from filtered order by rank_key, lower(name), agent_id
  limit least(greatest(coalesce(p_limit, 25), 1), 100) offset least(greatest(coalesce(p_offset, 0), 0), 1000000)
 )
 select jsonb_build_object('total', (select count(*) from filtered),
  'counts', jsonb_build_object('all', (select count(*) from rows), 'active', (select count(*) from rows where status = 'Active'),
   'invited', (select count(*) from rows where status = 'Invited'), 'inactive', (select count(*) from rows where status = 'Inactive')),
  'rows', coalesce((select jsonb_agg(jsonb_build_object(
   'key', p.agent_id, 'agentId', p.agent_id, 'omaraId', null, 'profileId', p.profile_id,
   'name', p.name, 'email', p.email, 'phone', p.phone, 'role', p.role, 'status', p.status,
   'marn', '', 'registered', null, 'place', '',
   'businessId', p.business_id, 'businessName', coalesce(p.business_name, ''), 'businessStatus', p.business_status,
   'students', case when p.profile_id is null then 0 else (select count(distinct e.student_id) from public.enrollment_applications e where e.assigned_agent_id = p.profile_id) end,
   'statusCounts', case when p.profile_id is null then '{}'::jsonb else (select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
     from (select e.status, count(*) n from public.enrollment_applications e where e.assigned_agent_id = p.profile_id group by e.status) s) end
  ) order by p.rank_key, lower(p.name), p.agent_id) from page p), '[]'::jsonb))
 into result;
 return result;
end $fn$;

create or replace function public.admin_agent_overview(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare g public.business_agents; b public.businesses; p public.portal_profiles; v_status text;
begin
 perform public.admin_business_require();
 select * into g from public.business_agents where id = p_id or profile_id = p_id limit 1;
 if g.id is null then return null; end if;
 select * into b from public.businesses where id = g.business_id;
 if g.profile_id is not null then select * into p from public.portal_profiles where id = g.profile_id; end if;
 v_status := case when g.status <> 'Active' then 'Inactive' when g.profile_id is null then 'Invited'
  when exists (select 1 from public.agency_memberships m where m.user_id = g.profile_id and m.status = 'Active') and p.status = 'Active' then 'Active' else 'Inactive' end;
 return jsonb_build_object(
  'key', g.id, 'agentId', g.id, 'profileId', g.profile_id, 'omaraId', null,
  'name', g.full_name, 'email', g.email, 'phone', coalesce(nullif(g.phone, ''), p.phone, ''), 'role', g.role, 'status', v_status,
  'statusChangedAt', g.status_changed_at,
  'business', case when b.id is null then null else jsonb_build_object('id', b.id, 'name', b.display_name, 'status', b.status) end,
  'omara', null,
  'applications', case when g.profile_id is null then '[]'::jsonb else public.admin_application_rows(null, g.profile_id) end,
  'students', case when g.profile_id is null then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.full_name, 'email', coalesce(s.email, ''))), '[]'::jsonb)
    from public.enrollment_students s where exists (select 1 from public.enrollment_applications e where e.student_id = s.id and e.assigned_agent_id = g.profile_id)) end);
end $fn$;
;
