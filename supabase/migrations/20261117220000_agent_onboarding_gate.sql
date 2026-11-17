-- Agent onboarding gate (owner brief 2026-11-17): nobody gets an agent workspace before the onboarding is complete.
--   * A business made by staff starts as 'Onboarding' (agencies.status gains the value). Its stage follows public.agency_onboarding.
--   * One rule decides whether a business is operational: public.agency_effective_status(a) is 'Active' only when the stored status is
--     Active and the business is SLIT's own direct business (is_direct) or holds a signed, unexpired agent agreement (or a signed
--     agreement uploaded by staff). Everything the agent side goes through (portal_agency_id, portal_actor_context, portal_resolve_access,
--     invitations, Add agent) uses it, so an onboarding, declined, cancelled or expired business has no workspace, no invite and cannot
--     add students or applications; staff keep seeing its students and applications.
--   * Staff approve the references: references_received -> references_approved (who / when) before the agreement goes, or an override
--     with a typed reason as before; a rejection sets 'declined' (reason kept for staff only, open requests voided, nothing sent to the
--     portal) and staff can start again later.
--   * When the agreement is signed the business becomes Active, the agent who signed becomes the active business admin agent and ONE
--     invitation (agency_invitations) is created for them; the document-signing function sends the set-password email
--     (agency_onboarding_activation). A business made before this migration keeps its stored status.
--   * The direct business (SLIT-DIRECT, is_direct) never signs an agreement: it is exempt.

alter table public.agencies drop constraint if exists agencies_status_check;
alter table public.agencies add constraint agencies_status_check check (status in ('Active', 'Inactive', 'Onboarding'));

alter table public.agency_onboarding drop constraint if exists agency_onboarding_stage_check;
alter table public.agency_onboarding add constraint agency_onboarding_stage_check check (stage in ('legacy', 'application_sent', 'application_signed', 'references_pending',
 'references_received', 'references_approved', 'declined', 'agreement_sent', 'agreement_signed', 'cancelled', 'expired'));
alter table public.agency_onboarding
 add column if not exists approved_by uuid,
 add column if not exists approved_at timestamptz,
 add column if not exists declined_by uuid,
 add column if not exists declined_at timestamptz,
 add column if not exists decline_reason text check (decline_reason is null or length(decline_reason) <= 1000),
 add column if not exists activated_at timestamptz,
 add column if not exists activation_invitation_id uuid references public.agency_invitations(id) on delete set null;

-- ------------------------------------------------------------------ the one rule
create or replace function public.agency_effective_status(a public.agencies) returns text
language sql stable security definer set search_path = public as $f$
 select case
  when a.status = 'Onboarding' then 'Onboarding'
  when a.status <> 'Active' then 'Inactive'
  when coalesce(a.is_direct, false) then 'Active'
  when a.agreement_status = 'signed' and (a.agreement_expiry_date is null or a.agreement_expiry_date >= current_date) then 'Active'
  when exists (select 1 from public.business_documents d where d.business_id = a.id and d.kind = 'agent_agreement') then 'Active'
  else 'Inactive' end;
$f$;
revoke all on function public.agency_effective_status(public.agencies) from public, anon;
grant execute on function public.agency_effective_status(public.agencies) to authenticated, service_role;

create or replace function public.agency_is_operational(p_agency uuid) returns boolean
language sql stable security definer set search_path = public as $f$
 select exists (select 1 from public.agencies a where a.id = p_agency and public.agency_effective_status(a) = 'Active');
$f$;
revoke all on function public.agency_is_operational(uuid) from public, anon;
grant execute on function public.agency_is_operational(uuid) to authenticated, service_role;

-- Why a business is not operational, in staff words (null when it is).
create or replace function public.agency_gate_reason(a public.agencies) returns text
language sql stable security definer set search_path = public as $f$
 select case public.agency_effective_status(a)
  when 'Active' then null
  when 'Onboarding' then 'This business is still onboarding: agents can be added once its agent agreement is signed.'
  else case
   when a.status = 'Active' and a.agreement_status = 'signed' and a.agreement_expiry_date < current_date then 'The agent agreement expired on ' || to_char(a.agreement_expiry_date, 'DD/MM/YYYY') || ': renew it before agents can be added.'
   when a.status = 'Active' then 'This business has no signed agent agreement: complete the onboarding before agents can be added.'
   else 'This business is inactive.' end end;
$f$;
revoke all on function public.agency_gate_reason(public.agencies) from public, anon;
grant execute on function public.agency_gate_reason(public.agencies) to authenticated, service_role;

-- A signed agreement is the one made through the onboarding (unexpired) or the one staff uploaded.
create or replace function public.business_agreement_ready(p_business uuid) returns boolean
language sql stable security definer set search_path = public, hr as $f$
 select exists (select 1 from public.agencies a where a.id = p_business and a.agreement_status = 'signed' and (a.agreement_expiry_date is null or a.agreement_expiry_date >= current_date))
  or exists (select 1 from public.business_documents d where d.business_id = p_business and d.kind = 'agent_agreement');
$f$;

-- ------------------------------------------------------------------ the agent side reads the rule
create or replace function public.portal_agency_id() returns uuid
language sql stable security definer set search_path = public as $f$
 select m.agency_id from public.agency_memberships m
 join public.agencies a on a.id = m.agency_id and public.agency_effective_status(a) = 'Active'
 where m.user_id = public.portal_profile_id() and m.status = 'Active' limit 1;
$f$;

create or replace function public.portal_actor_context(p_actor uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $f$
declare v_slit boolean := false; v_name text; v_agency uuid; v_role text;
begin
 select true, c.name into v_slit, v_name from public.cms_users c
  where c.auth_user_id = p_actor and c.role = 'Admin' and c.status = 'Active' and not c.must_change_password limit 1;
 select m.agency_id, m.role, coalesce(v_name, p.full_name) into v_agency, v_role, v_name
  from public.agency_memberships m join public.portal_profiles p on p.id = m.user_id
  join public.agencies a on a.id = m.agency_id and public.agency_effective_status(a) = 'Active'
  where p.auth_user_id = p_actor and p.status = 'Active' and m.status = 'Active' limit 1;
 return jsonb_build_object('slit', coalesce(v_slit, false), 'agencyId', v_agency, 'role', v_role, 'name', coalesce(v_name, ''));
end $f$;

-- Invitations only into an operational business (the agreement-signed activation inserts its own row, see below).
do $p$
declare v_src text; v_n integer;
begin
 select pg_get_functiondef(p.oid) into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'portal_invitation_create';
 v_n := (length(v_src) - length(replace(v_src, 'where a.id = v_agency and a.status = ''Active''', ''))) / length('where a.id = v_agency and a.status = ''Active''');
 if v_n <> 1 then raise exception 'portal_invitation_create anchor found % times', v_n; end if;
 v_src := replace(v_src, 'where a.id = v_agency and a.status = ''Active''', 'where a.id = v_agency and public.agency_effective_status(a) = ''Active''');
 v_src := replace(v_src, 'raise exception ''The agency is not active.'' using errcode = ''22023'';', 'raise exception ''%'', coalesce((select public.agency_gate_reason(a) from public.agencies a where a.id = v_agency), ''The agency is not active.'') using errcode = ''22023'', hint = ''business_not_operational'';');
 execute v_src;
end $p$;

create or replace function public.portal_resolve_access() returns jsonb
language plpgsql security definer set search_path = public as $f$
declare v_uid uuid := auth.uid(); v_email text; v_confirmed timestamptz; inv public.agency_invitations; p public.portal_profiles; m public.agency_memberships; a public.agencies;
 v_accepted boolean := false; v_state text; v_link_needed boolean := false; v_effective text;
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 if public.cms_is_admin() then return jsonb_build_object('state', 'org_admin', 'accepted', false); end if;
 select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_uid;
 select * into p from public.portal_profiles where auth_user_id = v_uid;
 select * into m from public.agency_memberships where user_id = p.id;
 if v_confirmed is not null then
  select * into inv from public.agency_invitations i where i.email = v_email and i.status = 'pending' for update;
  if found and inv.expires_at >= now()
   and exists (select 1 from public.agencies x where x.id = inv.agency_id
    and (public.agency_effective_status(x) = 'Active' or (x.registration_requested_at is not null and x.registration_reviewed_at is null)))
   and (inv.student_id is null or exists (select 1 from public.enrollment_students s where s.id = inv.student_id and s.status = 'Active' and s.agency_id = inv.agency_id))
   and not coalesce(m.status = 'Active' and p.status = 'Active' and m.agency_id <> inv.agency_id, false) then
   if not public.portal_invitation_link_ok(inv, v_confirmed) then
    v_link_needed := true;
   else
    if p.id is null then
     insert into public.portal_profiles(auth_user_id, email, full_name, status) values (v_uid, v_email, coalesce(nullif(inv.full_name, ''), split_part(v_email, '@', 1)), 'Active') returning * into p;
    else
     update public.portal_profiles set status = 'Active', updated_at = now() where id = p.id returning * into p;
    end if;
    insert into public.agency_memberships(user_id, agency_id, role, status, student_id) values (p.id, inv.agency_id, inv.role, 'Active', inv.student_id)
    on conflict (user_id) do update set agency_id = excluded.agency_id, role = excluded.role, status = 'Active', student_id = excluded.student_id, updated_at = now() returning * into m;
    update public.agency_invitations set status = 'accepted', accepted_at = now() where id = inv.id;
    perform public.portal_user_audit(v_uid, jsonb_build_object('name', p.full_name, 'role', inv.role), 'accept_invitation', p.id::text, inv.agency_id, jsonb_build_object('email', v_email, 'role', inv.role, 'student', inv.student_id));
    v_accepted := true;
   end if;
  end if;
 end if;
 if m.user_id is null then
  v_state := case when v_link_needed then 'invite_link_required'
   when exists (select 1 from public.agency_invitations i where i.email = v_email and i.status = 'pending' and i.expires_at < now()) then 'invite_expired' else 'no_access' end;
 else
  select * into a from public.agencies where id = m.agency_id;
  v_effective := public.agency_effective_status(a);
  v_state := case when p.status <> 'Active' or m.status <> 'Active' then 'user_suspended'
   when m.role = 'student' and not exists (select 1 from public.enrollment_students s where s.id = m.student_id and s.status = 'Active') then 'user_suspended'
   when a.registration_requested_at is not null and a.registration_reviewed_at is null then 'pending_review'
   when a.registration_decision = 'declined' and a.status <> 'Active' then 'registration_declined'
   when v_effective = 'Onboarding' then 'agency_onboarding'
   when v_effective <> 'Active' and a.status = 'Active' and a.agreement_status = 'signed' and a.agreement_expiry_date < current_date then 'agreement_expired'
   when v_effective <> 'Active' then 'agency_suspended' else 'active' end;
 end if;
 return jsonb_build_object('state', v_state, 'accepted', v_accepted);
end $f$;

-- ------------------------------------------------------------------ staff side
-- Add business: the business starts as Onboarding; its point of contact waits (Inactive) for the onboarding.
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
  coalesce(p_agency->>'country', ''), v_name, 'Onboarding') returning * into a;
 insert into public.agents(business_id, full_name, email, phone, role, status, status_changed_at, status_changed_by)
 values (a.id, v_name, v_email, coalesce(p_agency->>'phone', ''), 'agency_admin', 'Inactive', now(), auth.uid()) returning * into g;
 perform public.admin_business_audit('business_created', a.id, a.id, jsonb_build_object('name', a.name, 'contact', v_email, 'onboarding', true));
 return jsonb_build_object('agencyId', a.id, 'businessId', a.id, 'agencyName', a.name, 'contactAgentId', g.id, 'onboarding', true);
end $f$;

-- Add agent / Activate: only into an operational business.
do $p$
declare v_src text; v_n integer;
begin
 select pg_get_functiondef(p.oid) into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'admin_agent_activate';
 v_n := (length(v_src) - length(replace(v_src, 'if a.status <> ''Active'' then', ''))) / length('if a.status <> ''Active'' then');
 if v_n <> 1 then raise exception 'admin_agent_activate anchor found % times', v_n; end if;
 v_src := replace(v_src, 'if a.status <> ''Active'' then', 'if not public.agency_is_operational(a.id) then');
 v_src := replace(v_src, 'raise exception ''Activate the business first: its agent agreement must be signed before agents can be added.'' using errcode = ''23514'', hint = ''business_inactive'';',
  'raise exception ''%'', coalesce(public.agency_gate_reason(a), ''Activate the business first.'') using errcode = ''23514'', hint = ''business_inactive'';');
 execute v_src;
end $p$;

-- Activate & invite by hand (an uploaded signed agreement): the business must hold a signed agreement; 'Onboarding' can be set back to Inactive.
do $p$
declare v_src text;
begin
 select pg_get_functiondef(p.oid) into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'admin_business_set_status';
 if position('if p_status = ''Active'' and a.status <> ''Active'' and not public.business_agreement_ready(a.id) then' in v_src) = 0 then raise exception 'admin_business_set_status anchor missing'; end if;
 execute v_src; -- unchanged body; business_agreement_ready above now means a signed agreement
end $p$;

-- The agents list: a business is only "Active" for its agents when operational; an agent without a login is Invited (waiting for their password).
create or replace function public.admin_agent_rows(p_business uuid, p_search text, p_status text, p_limit integer, p_offset integer) returns jsonb
language plpgsql stable security definer set search_path = public as $f$
declare v_words text[] := public.admin_search_words(p_search); result jsonb;
begin
 with rows as (
  select g.id as agent_id, g.profile_id, g.full_name as name, g.email, g.phone, g.marn, g.role, g.business_id, g.status_changed_at,
   case when g.status <> 'Active' then 'Inactive'
        when g.profile_id is null then 'Invited'
        when exists (select 1 from public.agency_memberships m join public.portal_profiles pp on pp.id = m.user_id
          where m.user_id = g.profile_id and m.status = 'Active' and pp.status = 'Active') then 'Active'
        else 'Inactive' end as status,
   a.name as business_name, public.agency_effective_status(a) as business_status,
   (select i.id from public.agency_invitations i where i.agency_id = g.business_id and i.email = g.email and i.status = 'pending' and g.email <> '' limit 1) as invitation_id
  from public.agents g
  join public.agencies a on a.id = g.business_id
  where (p_business is null or g.business_id = p_business)
   and not exists (select 1 from unnest(v_words) w where strpos(lower(concat_ws(' ', g.full_name, g.email, g.phone, g.marn, a.name)), w) = 0)
 ), filtered as (
  select *, case when business_status = 'Active' then 0 else 1 end as business_rank,
   case status when 'Active' then 0 when 'Invited' then 1 else 2 end as rank_key
  from rows where coalesce(p_status, '') = '' or status = p_status
 ), page as (
  select * from filtered order by business_rank, rank_key, lower(name), agent_id
  limit least(greatest(coalesce(p_limit, 25), 1), 100) offset least(greatest(coalesce(p_offset, 0), 0), 1000000)
 )
 select jsonb_build_object('total', (select count(*) from filtered),
  'counts', jsonb_build_object('all', (select count(*) from rows), 'active', (select count(*) from rows where status = 'Active'),
   'invited', (select count(*) from rows where status = 'Invited'), 'inactive', (select count(*) from rows where status = 'Inactive')),
  'rows', coalesce((select jsonb_agg(jsonb_build_object(
   'key', p.agent_id, 'agentId', p.agent_id, 'omaraId', null, 'profileId', p.profile_id, 'invitationId', p.invitation_id,
   'name', p.name, 'email', p.email, 'phone', p.phone, 'role', p.role, 'status', p.status, 'statusChangedAt', p.status_changed_at,
   'marn', p.marn, 'registered', null,
   'businessId', p.business_id, 'businessName', p.business_name, 'businessStatus', p.business_status,
   'students', (select count(*) from public.enrollment_students s where s.agent_id = p.agent_id),
   'statusCounts', (select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb) from (select e.status, count(*) n from public.enrollment_applications e
     join public.enrollment_students s on s.id = e.student_id where s.agent_id = p.agent_id group by e.status) x)
  ) order by p.business_rank, p.rank_key, lower(p.name), p.agent_id) from page p), '[]'::jsonb))
 into result;
 return result;
end $f$;

-- The business page: the effective status, why agents cannot be added, and the onboarding stage.
create or replace function public.admin_business_detail(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $f$
declare a public.agencies; poc public.agents; o public.agency_onboarding;
begin
 perform public.admin_business_require();
 select * into a from public.agencies where id = p_business;
 if not found then return null; end if;
 select * into poc from public.agents g where g.business_id = a.id and g.role = 'agency_admin' order by (g.status = 'Active') desc, g.created_at limit 1;
 select * into o from public.agency_onboarding x where x.agency_id = a.id order by x.created_at desc limit 1;
 return jsonb_build_object(
  'id', a.id, 'name', a.name, 'status', a.status, 'effectiveStatus', public.agency_effective_status(a), 'operational', public.agency_effective_status(a) = 'Active',
  'gateReason', public.agency_gate_reason(a), 'isDirect', coalesce(a.is_direct, false), 'createdAt', a.created_at,
  'agency', jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name, 'status', a.status, 'email', a.business_email, 'phone', a.phone,
   'address', a.address, 'country', a.country, 'contact', a.primary_contact, 'registrationNumber', a.registration_number, 'createdAt', a.created_at),
  'onboarding', jsonb_build_object('completedAt', a.onboarding_completed_at, 'agreementReady', public.business_agreement_ready(a.id),
   'stage', o.stage, 'onboardingId', o.id, 'onboardingStatus', o.status,
   'contact', case when poc.id is null then null else jsonb_build_object('agentId', poc.id, 'name', poc.full_name, 'email', poc.email, 'hasLogin', poc.profile_id is not null) end),
  'agreement', jsonb_build_object('status', a.agreement_status, 'commencementDate', a.agreement_commencement_date, 'expiryDate', a.agreement_expiry_date, 'onboardingId', a.agreement_onboarding_id,
   'expired', a.agreement_status = 'signed' and a.agreement_expiry_date < current_date),
  'profile', coalesce(a.profile, '{}'::jsonb),
  'counts', jsonb_build_object(
   'admins', (select count(*) from public.agents g where g.business_id = a.id and g.role = 'agency_admin' and g.status = 'Active'),
   'agents', (select count(*) from public.agents g where g.business_id = a.id and g.role = 'agent' and g.status = 'Active'),
   'inactiveAgents', (select count(*) from public.agents g where g.business_id = a.id and g.status <> 'Active'),
   'students', (select count(*) from public.enrollment_students s where s.agency_id = a.id),
   'applications', (select count(*) from public.enrollment_applications e where e.agency_id = a.id)),
  'statusCounts', public.admin_status_counts(a.id));
end $f$;

-- The businesses list shows the effective status and filters by it; 'Onboarding' is a filter too.
create or replace function public.admin_agency_directory(p_search text default '', p_status text default '', p_limit integer default 25, p_offset integer default 0, p_key text default null) returns jsonb
language plpgsql stable set search_path = public as $f$
declare result jsonb; v_words text[] := public.admin_search_words(p_search);
begin
 if auth.uid() is null or not public.portal_is_slit_admin() then raise exception 'Agency administration required' using errcode = '42501'; end if;
 if coalesce(p_status, '') not in ('', 'Active', 'Inactive', 'Onboarding') then raise exception 'Invalid agency status' using errcode = '22023'; end if;
 with directory as (
  select a.id::text as id, a.id::text as existing_agency_id, a.directory_key, a.name, a.code, a.registration_number,
   a.business_email, a.phone, a.address, a.country, a.primary_contact, public.agency_effective_status(a) as status, a.status as stored_status, a.is_permanent, a.created_at,
   a.agreement_status, a.agreement_expiry_date, coalesce(a.is_direct, false) as is_direct,
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
end $f$;

-- Start onboarding offers the point of contact even before the business is active (it is Inactive until the agreement is signed).
create or replace function public.agency_onboarding_prepare(p_agency uuid, p_agent uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare a public.agencies; g public.agents; u public.cms_users; v_position text;
begin
 perform public.admin_business_require();
 select * into a from public.agencies where id = p_agency;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 if p_agent is not null then select * into g from public.agents where id = p_agent and business_id = a.id;
 else select * into g from public.agents x where x.business_id = a.id and (x.status = 'Active' or (x.role = 'agency_admin' and x.profile_id is null)) order by (x.role = 'agency_admin') desc, (x.status = 'Active') desc, x.created_at limit 1; end if;
 select * into u from public.cms_users where auth_user_id = auth.uid() and status = 'Active' limit 1;
 select e.job_title into v_position from hr.staff_profiles sp join hr.employment e on e.profile_id = sp.id where sp.auth_user_id = auth.uid() order by e.created_at desc limit 1;
 return jsonb_build_object(
  'agency', jsonb_build_object('id', a.id, 'name', a.name, 'abn', a.registration_number, 'email', a.business_email, 'phone', a.phone, 'address', a.address, 'country', a.country,
   'status', a.status, 'effectiveStatus', public.agency_effective_status(a), 'agreementStatus', a.agreement_status, 'commencementDate', a.agreement_commencement_date, 'expiryDate', a.agreement_expiry_date, 'profile', coalesce(a.profile, '{}'::jsonb)),
  'agents', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.full_name, 'email', x.email, 'role', x.role, 'status', x.status) order by (x.role = 'agency_admin') desc, x.full_name)
   from public.agents x where x.business_id = a.id and (x.status = 'Active' or (x.role = 'agency_admin' and x.profile_id is null))), '[]'::jsonb),
  'agent', case when g.id is null then null else jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email, 'role', g.role) end,
  'admin', jsonb_build_object('name', coalesce(u.name, ''), 'position', coalesce(v_position, ''), 'signaturePng', u.signature_png),
  'values', case when g.id is null then '{}'::jsonb else public.agent_onboarding_values(g.id) end);
end $f$;

-- One onboarding in progress per business: the approved stage counts too.
do $p$
declare v_src text; v_n integer; v_old text := 'x.stage in (''application_sent'', ''application_signed'', ''references_pending'', ''references_received'', ''agreement_sent'')';
begin
 select pg_get_functiondef(p.oid) into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'agency_onboarding_create';
 v_n := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
 if v_n <> 1 then raise exception 'agency_onboarding_create anchor found % times', v_n; end if;
 execute replace(v_src, v_old, 'x.stage in (''application_sent'', ''application_signed'', ''references_pending'', ''references_received'', ''references_approved'', ''agreement_sent'')');
end $p$;

-- ------------------------------------------------------------------ staff approval of the references
create or replace function public.agency_onboarding_approve_references(p_onboarding uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; v_received integer; v_total integer;
begin
 perform hr.require_admin();
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.stage = 'references_approved' then return jsonb_build_object('id', o.id, 'stage', o.stage, 'approvedAt', o.approved_at); end if;
 if o.stage <> 'references_received' then raise exception 'The references can be approved once both referee checks are back'; end if;
 select count(*) filter (where status = 'received'), count(*) into v_received, v_total from public.agency_onboarding_referees where onboarding_id = o.id;
 if v_total = 0 or v_received < v_total then raise exception 'The references can be approved once both referee checks are back'; end if;
 update public.agency_onboarding set stage = 'references_approved', approved_by = auth.uid(), approved_at = now() where id = o.id returning * into o;
 perform public.agency_onboarding_log(o.id, 'references_approved', jsonb_build_object('received', v_received, 'total', v_total));
 perform public.admin_business_audit('agent_references_approved', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id));
 return jsonb_build_object('id', o.id, 'stage', o.stage, 'approvedAt', o.approved_at);
end $f$;
revoke all on function public.agency_onboarding_approve_references(uuid) from public, anon;
grant execute on function public.agency_onboarding_approve_references(uuid) to authenticated;

-- Reject: the onboarding is declined (reason for staff only), its open requests are voided afterwards by the caller, nothing reaches the portal.
create or replace function public.agency_onboarding_decline(p_onboarding uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; a public.agencies; g public.agents; v_reason text; v_open uuid[];
begin
 perform hr.require_admin();
 v_reason := nullif(left(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]', ' ', 'g')), 1000), '');
 if v_reason is null or length(v_reason) < 5 then raise exception 'Give the reason for declining (kept for staff; the agent is not shown it)'; end if;
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.stage not in ('application_sent', 'application_signed', 'references_pending', 'references_received', 'references_approved', 'agreement_sent') then
  raise exception 'This onboarding is not open'; end if;
 select * into a from public.agencies where id = o.agency_id;
 select * into g from public.agents where id = o.agent_id;
 select coalesce(array_agg(r.id), '{}') into v_open from hr.sign_requests r where r.agency_onboarding_id = o.id and r.state in ('draft', 'sent', 'viewed', 'partially_signed');
 update public.agency_onboarding set stage = 'declined', status = 'closed', closed_reason = 'declined', declined_by = auth.uid(), declined_at = now(), decline_reason = v_reason where id = o.id returning * into o;
 update public.agency_onboarding_referees set status = 'cancelled', updated_at = now() where onboarding_id = o.id and status in ('pending', 'sent');
 update public.agencies set agreement_status = 'none', agreement_onboarding_id = null, updated_at = now() where id = a.id and agreement_onboarding_id = o.id and agreement_status <> 'signed';
 update public.agency_invitations set status = 'revoked', revoked_at = now() where agency_id = a.id and status = 'pending' and lower(email) = lower(g.email);
 perform public.agency_onboarding_log(o.id, 'declined', jsonb_build_object('reason', v_reason, 'openRequests', cardinality(v_open)));
 perform public.admin_business_audit('agent_onboarding_declined', a.id, a.id, jsonb_build_object('onboarding', o.id, 'reason', v_reason));
 return jsonb_build_object('id', o.id, 'stage', o.stage, 'openRequestIds', to_jsonb(v_open),
  'agent', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email), 'agency', jsonb_build_object('id', a.id, 'name', a.name));
end $f$;
revoke all on function public.agency_onboarding_decline(uuid, text) from public, anon;
grant execute on function public.agency_onboarding_decline(uuid, text) to authenticated;

-- The agreement goes after the approval, or earlier with a typed reason (override) as before.
create or replace function public.agency_onboarding_agreement_create(p_onboarding uuid, p_request uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; r hr.sign_requests; v_start date; v_end date; v_pct numeric; v_reason text; v_received integer; v_total integer;
begin
 perform hr.require_admin();
 p_data := coalesce(p_data, '{}'::jsonb);
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.stage not in ('application_signed', 'references_pending', 'references_received', 'references_approved') then raise exception 'The agreement can be sent once the application form is signed and the references are approved'; end if;
 select count(*) filter (where status = 'received'), count(*) into v_received, v_total from public.agency_onboarding_referees where onboarding_id = o.id;
 if o.stage <> 'references_approved' then
  v_reason := nullif(left(btrim(regexp_replace(coalesce(p_data->>'override_reason', ''), '[[:cntrl:]]', ' ', 'g')), 500), '');
  if v_reason is null or length(v_reason) < 5 then raise exception 'Give a reason for sending the agreement before the references are approved'; end if;
 end if;
 select * into r from hr.sign_requests where id = p_request for update;
 if not found or r.state <> 'draft' or r.subject_type is distinct from 'agent' or r.subject_id is distinct from o.agent_id or r.agency_onboarding_id is not null then
  raise exception 'The signing request does not match this agent'; end if;
 begin v_start := (p_data->>'commencement_date')::date; v_end := (p_data->>'expiry_date')::date; exception when others then raise exception 'Enter the commencement date'; end;
 if v_start is null or v_end is null or v_end <= v_start then raise exception 'Enter the commencement date'; end if;
 if nullif(btrim(coalesce(p_data->>'commission_percent', '')), '') is not null then
  begin v_pct := (regexp_replace(p_data->>'commission_percent', '[^0-9.]', '', 'g'))::numeric; exception when others then raise exception 'Enter the commission as a percentage'; end;
  if v_pct < 0 or v_pct > 100 then raise exception 'Enter the commission as a percentage'; end if;
 end if;
 if v_reason is not null then
  update public.agency_onboarding set override_reason = v_reason, override_by = auth.uid(), override_at = now() where id = o.id;
  perform public.agency_onboarding_log(o.id, 'override', jsonb_build_object('reason', v_reason, 'stage_before', o.stage, 'received', v_received, 'total', v_total));
 end if;
 update public.agency_onboarding set agreement_request_id = r.id, stage = 'agreement_sent', commencement_date = v_start, expiry_date = v_end, territory = left(btrim(coalesce(p_data->>'territory', '')), 200),
  commission_percent = v_pct, admin_name = left(btrim(coalesce(p_data->>'admin_name', '')), 150), admin_position = left(btrim(coalesce(p_data->>'admin_position', '')), 150),
  sent_values = coalesce(sent_values, '{}'::jsonb) || coalesce(p_data->'values', '{}'::jsonb) where id = o.id returning * into o;
 update hr.sign_requests set agency_onboarding_id = o.id where id = r.id;
 update public.agencies set agreement_status = 'sent', agreement_onboarding_id = o.id, updated_at = now() where id = o.agency_id and agreement_status <> 'signed';
 perform public.agency_onboarding_log(o.id, 'agreement_sent', jsonb_build_object('request', r.reference, 'commencement', v_start, 'expiry', v_end, 'territory', o.territory, 'commission', v_pct, 'override', v_reason is not null));
 perform public.admin_business_audit('agent_onboarding_sent', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'request', r.reference, 'document', 'agreement', 'override', v_reason));
 return jsonb_build_object('id', o.id, 'requestId', r.id, 'reference', r.reference, 'stage', o.stage, 'override', v_reason is not null);
end $f$;

-- ------------------------------------------------------------------ the signed agreement activates the business
-- Called by agency_onboarding_accept_signed (agreement) and again, harmlessly, by the function: the business goes Active, the agent who
-- signed becomes its active business admin agent, and one invitation is made for them unless they already sign in.
create or replace function public.agency_onboarding_activate(p_onboarding uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; a public.agencies; g public.agents; inv public.agency_invitations; v_staff text; v_login boolean := false; v_made boolean := false;
begin
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.stage <> 'agreement_signed' then raise exception 'The agreement is not signed yet'; end if;
 select * into a from public.agencies where id = o.agency_id for update;
 select * into g from public.agents where id = o.agent_id for update;
 if not coalesce(a.is_direct, false) and a.status <> 'Active' then
  update public.agencies set status = 'Active', onboarding_completed_at = coalesce(onboarding_completed_at, now()), updated_at = now() where id = a.id returning * into a;
  perform public.admin_business_audit('business_activated', a.id, a.id, jsonb_build_object('name', a.name, 'onboarding', o.id, 'by', 'agreement_signed'));
 end if;
 if g.id is not null then
  if g.status <> 'Active' or (g.role <> 'agency_admin' and not exists (select 1 from public.agents x where x.business_id = a.id and x.role = 'agency_admin' and x.status = 'Active' and x.id <> g.id)) then
   update public.agents set status = 'Active', role = case when exists (select 1 from public.agents x where x.business_id = a.id and x.role = 'agency_admin' and x.status = 'Active' and x.id <> g.id) then role else 'agency_admin' end,
    status_changed_at = now(), status_changed_by = coalesce(o.sent_by, status_changed_by), updated_at = now() where id = g.id returning * into g;
  end if;
  if g.profile_id is not null then
   update public.portal_profiles set status = 'Active', updated_at = now() where id = g.profile_id and status <> 'Active';
   update public.agency_memberships set status = 'Active', agency_id = a.id, role = case when role = 'student' then role else g.role end, updated_at = now() where user_id = g.profile_id;
   v_login := true;
  elsif g.email <> '' then
   select * into inv from public.agency_invitations i where i.agency_id = a.id and i.email = g.email and i.status = 'pending' order by i.created_at desc limit 1;
   if inv.id is null and not exists (select 1 from public.portal_profiles p join public.agency_memberships m on m.user_id = p.id where lower(p.email) = g.email and m.status = 'Active' and p.status = 'Active') then
    select u.name into v_staff from public.cms_users u where u.auth_user_id = o.sent_by limit 1;
    insert into public.agency_invitations(agency_id, email, full_name, role, invited_by, invited_by_name) values (a.id, g.email, g.full_name, g.role, o.sent_by, coalesce(v_staff, 'Skyline'))
    returning * into inv;
    v_made := true;
   end if;
  end if;
 end if;
 if o.activated_at is null then
  update public.agency_onboarding set activated_at = now(), activation_invitation_id = coalesce(inv.id, activation_invitation_id) where id = o.id returning * into o;
  perform public.agency_onboarding_log(o.id, 'activated', jsonb_build_object('agent', g.id, 'email', g.email, 'invitation', inv.id, 'login', v_login));
 end if;
 return jsonb_build_object('onboardingId', o.id, 'agency', jsonb_build_object('id', a.id, 'name', a.name, 'status', a.status),
  'agent', case when g.id is null then null else jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email, 'role', g.role, 'status', g.status) end,
  'loginExists', v_login, 'invitation', case when inv.id is null then null else jsonb_build_object('id', inv.id, 'email', inv.email, 'name', inv.full_name, 'role', inv.role, 'expiresAt', inv.expires_at, 'new', v_made,
   'sent', inv.link_sent_at is not null) end);
end $f$;
revoke all on function public.agency_onboarding_activate(uuid) from public, anon, authenticated;
grant execute on function public.agency_onboarding_activate(uuid) to service_role;

-- accept_signed: the agreement branch activates the business.
do $p$
declare v_src text; v_n integer; v_anchor text := 'perform public.admin_business_audit(''agent_agreement_signed'', o.agency_id, o.agency_id, jsonb_build_object(''onboarding'', o.id, ''request'', r.reference, ''signer'', c.signer_name));';
begin
 select pg_get_functiondef(p.oid) into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'agency_onboarding_accept_signed';
 v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
 if v_n <> 2 then raise exception 'agency_onboarding_accept_signed anchor found % times', v_n; end if;
 -- the second occurrence is the agreement branch (the first is the merged legacy branch)
 v_src := split_part(v_src, v_anchor, 1) || v_anchor || split_part(v_src, v_anchor, 2) || v_anchor || E'\n  perform public.agency_onboarding_activate(o.id);' || split_part(v_src, v_anchor, 3);
 execute v_src;
end $p$;

-- The function (service role) sends the set-password email after the activation; the invitation link is issued through portal_invitation_link_issue.
create or replace function public.agency_onboarding_activation(p_onboarding uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
begin
 return public.agency_onboarding_activate(p_onboarding);
end $f$;
revoke all on function public.agency_onboarding_activation(uuid) from public, anon, authenticated;
grant execute on function public.agency_onboarding_activation(uuid) to service_role;

-- A person asks for a new set-password link from the expired-link page: generic answer, two minutes between sends, ten a day.
create or replace function public.portal_invitation_self_resend(p_email text, p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public as $f$
declare v_email text := lower(btrim(coalesce(p_email, ''))); inv public.agency_invitations; v_agency text;
begin
 if v_email = '' or length(v_email) > 254 or v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then return jsonb_build_object('sent', false, 'why', 'email'); end if;
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('sent', false, 'why', 'hash'); end if;
 select * into inv from public.agency_invitations i where i.email = v_email and i.status = 'pending' and i.expires_at >= now() order by i.created_at desc limit 1 for update;
 if not found then return jsonb_build_object('sent', false, 'why', 'none'); end if;
 if not exists (select 1 from public.agencies a where a.id = inv.agency_id and public.agency_effective_status(a) = 'Active') then return jsonb_build_object('sent', false, 'why', 'agency'); end if;
 if inv.link_sent_at is not null and inv.link_sent_at > now() - interval '2 minutes' then return jsonb_build_object('sent', false, 'why', 'recent'); end if;
 if coalesce(inv.sent_count, 0) >= 10 and inv.last_sent_at > now() - interval '1 day' then return jsonb_build_object('sent', false, 'why', 'limit'); end if;
 update public.agency_invitations set link_token_hash = p_token_hash, link_sent_at = now(), link_confirmed_at = null, sent_count = coalesce(sent_count, 0) + 1, last_sent_at = now() where id = inv.id returning * into inv;
 select a.name into v_agency from public.agencies a where a.id = inv.agency_id;
 return jsonb_build_object('sent', true, 'email', inv.email, 'name', inv.full_name, 'role', inv.role, 'agencyName', v_agency, 'expiresAt', inv.expires_at);
end $f$;
revoke all on function public.portal_invitation_self_resend(text, text) from public, anon, authenticated;
grant execute on function public.portal_invitation_self_resend(text, text) to service_role;

-- The portal dashboard words for the new stages.
create or replace function public.portal_agency_onboarding(p_agency uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare a public.agencies;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if not exists (select 1 from public.agency_memberships m join public.portal_profiles p on p.id = m.user_id
   where p.auth_user_id = auth.uid() and m.agency_id = p_agency and m.status = 'Active' and m.role in ('agent', 'agency_admin')) then
  raise exception 'You cannot see this agency' using errcode = '42501';
 end if;
 select * into a from public.agencies where id = p_agency;
 return jsonb_build_object('agreementStatus', a.agreement_status, 'commencementDate', a.agreement_commencement_date, 'expiryDate', a.agreement_expiry_date,
  'effectiveStatus', public.agency_effective_status(a),
  'documents', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'status', o.status, 'stage', o.stage, 'createdAt', o.created_at, 'signedAt', o.signed_at, 'commencementDate', o.commencement_date, 'expiryDate', o.expiry_date,
    'referees', jsonb_build_object('received', (select count(*) from public.agency_onboarding_referees f where f.onboarding_id = o.id and f.status = 'received'), 'total', (select count(*) from public.agency_onboarding_referees f where f.onboarding_id = o.id)),
    'files', jsonb_build_object('form', o.form_content is not null, 'agreement', o.agreement_content is not null, 'certificate', o.certificate_content is not null)) order by o.created_at desc)
   from public.agency_onboarding o where o.agency_id = a.id and o.status in ('sent', 'signed') and o.stage not in ('cancelled', 'expired', 'declined')), '[]'::jsonb));
end $f$;

-- The staff list of an onboarding: the approval, the decline (reason for staff) and the activation.
do $p$
declare v_src text; v_n integer; v_old text := '''override'', case when o.override_reason is null then null else';
begin
 select pg_get_functiondef(p.oid) into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'agency_onboarding_list';
 v_n := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
 if v_n <> 1 then raise exception 'agency_onboarding_list anchor found % times', v_n; end if;
 execute replace(v_src, v_old,
  '''approval'', case when o.approved_at is null then null else jsonb_build_object(''at'', o.approved_at, ''by'', (select name from public.cms_users u where u.auth_user_id = o.approved_by limit 1)) end,'
  || ' ''decline'', case when o.declined_at is null then null else jsonb_build_object(''at'', o.declined_at, ''reason'', o.decline_reason, ''by'', (select name from public.cms_users u where u.auth_user_id = o.declined_by limit 1)) end,'
  || ' ''activation'', case when o.activated_at is null then null else jsonb_build_object(''at'', o.activated_at, ''invitationId'', o.activation_invitation_id, ''invitationStatus'', (select i.status from public.agency_invitations i where i.id = o.activation_invitation_id)) end,'
  || ' ' || v_old);
end $p$;

-- The status lists the CMS offers: Onboarding is shown, never chosen.
create or replace function public.portal_status_catalog() returns jsonb
language sql stable security definer set search_path = public as $f$
 select jsonb_build_object(
  'application', public.portal_application_statuses(),
  'business', jsonb_build_array(
   jsonb_build_object('value','Active','label','Active'),
   jsonb_build_object('value','Onboarding','label','Onboarding','note','Agent agreement not signed yet'),
   jsonb_build_object('value','Inactive','label','Inactive')),
  'agent', jsonb_build_array(
   jsonb_build_object('value','Active','label','Active','note','Approved and signed in'),
   jsonb_build_object('value','Invited','label','Invited','note','Approved, invitation not accepted yet'),
   jsonb_build_object('value','Inactive','label','Inactive','note','Cannot sign in')),
  'student', jsonb_build_array(
   jsonb_build_object('value','Active','label','Active','note','Applications can be worked on'),
   jsonb_build_object('value','Inactive','label','Disabled','note','All applications are locked')));
$f$;

-- Needs action today: references waiting for a staff decision.
do $p$
declare v_src text;
begin
 select pg_get_functiondef(p.oid) into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'admin_today';
 if v_src is null then return; end if;
 if position('''references'', jsonb_build_object' in v_src) > 0 then return; end if;
 if (length(v_src) - length(replace(v_src, 'r := r || jsonb_build_object(''applications'',', ''))) / length('r := r || jsonb_build_object(''applications'',') <> 1 then raise exception 'admin_today anchor missing'; end if;
 execute replace(v_src, 'r := r || jsonb_build_object(''applications'',',
  'r := r || jsonb_build_object(''references'', jsonb_build_object(''count'', (select count(*) from public.agency_onboarding o where o.stage = ''references_received''),'
  || ' ''items'', coalesce((select jsonb_agg(jsonb_build_object(''id'', o.id, ''title'', a.name, ''detail'', ''References received: review and approve or decline'', ''at'', o.references_received_at, ''to'', ''/admin/businesses/'' || a.id::text) order by o.references_received_at)'
  || ' from public.agency_onboarding o join public.agencies a on a.id = o.agency_id where o.stage = ''references_received''), ''[]''::jsonb)));'
  || E'\n r := r || jsonb_build_object(''applications'',');
end $p$;
