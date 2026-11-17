-- Agent-level onboarding (owner brief 2026-11-17, fourth): adding an agent to a business starts THEIR onboarding instead of approving and
-- inviting them at once. Add agent (CMS) or the business admin agent (portal) -> the Agent Application Form (F04, prefilled with the
-- business's details) emailed to the agent -> the agent signs -> a referee check (F05) to each of the two referees -> "1 of 2" -> both back:
-- the agent is Ready -> an administrator Activates (only then the congratulations set-password email) or Rejects (a short polite email,
-- never an invitation; the staff reason stays with staff).
--   * agents.status gains Onboarding and Declined. agency_onboarding gains kind ('business' for every existing row and the business flow,
--     'agent' for the new flow) and the stage 'activated'. One open agent onboarding per agent.
--   * The business flow (Start onboarding, agreement, business activation) is unchanged; it ignores agent onboardings.
--   * SLIT's direct business (is_direct) has no onboarding: Add agent approves there as before (@slit.edu.au only, unchanged).
--   * No sign-in invitation to an agent who is not Active, from any screen: portal_invitation_create and portal_invitation_resend refuse an
--     agent / business admin agent whose agent record is not Active, and (outside the direct business) one with no agent record at all.
--   * Existing agents keep their status, login and flags: nothing here updates an agents row; every existing agency_onboarding row is kind
--     'business' (the column default).
set local lock_timeout = '5s';

-- ------------------------------------------------------------------ schema (additive)
alter table public.agents drop constraint if exists agents_status_check;
alter table public.agents add constraint agents_status_check check (status in ('Active', 'Inactive', 'Onboarding', 'Declined'));

alter table public.agency_onboarding add column if not exists kind text not null default 'business';
alter table public.agency_onboarding drop constraint if exists agency_onboarding_kind_check;
alter table public.agency_onboarding add constraint agency_onboarding_kind_check check (kind in ('business', 'agent'));
alter table public.agency_onboarding drop constraint if exists agency_onboarding_stage_check;
alter table public.agency_onboarding add constraint agency_onboarding_stage_check check (stage in ('legacy', 'application_sent', 'application_signed', 'references_pending',
 'references_received', 'references_approved', 'declined', 'agreement_sent', 'agreement_signed', 'cancelled', 'expired', 'activated'));
create unique index if not exists agency_onboarding_agent_open_idx on public.agency_onboarding(agent_id)
 where kind = 'agent' and stage in ('application_sent', 'application_signed', 'references_pending', 'references_received');

-- ------------------------------------------------------------------ in-place patches (one-line anchors, exact counts)
create function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

-- The business flow ignores agent onboardings: one business onboarding at a time, the business page's stage, the portal card.
select pg_temp.patch('public.agency_onboarding_create(uuid, uuid, uuid, jsonb)',
 $a$x.agency_id = a.id and x.stage in ($a$, $a$x.agency_id = a.id and x.kind = 'business' and x.stage in ($a$);
select pg_temp.patch('public.admin_business_detail(uuid)',
 $a$select * into o from public.agency_onboarding x where x.agency_id = a.id order by$a$, $a$select * into o from public.agency_onboarding x where x.agency_id = a.id and x.kind = 'business' order by$a$);
select pg_temp.patch('public.admin_business_detail(uuid)',
 $a$'inactiveAgents', (select count(*) from public.agents g where g.business_id = a.id and g.status <> 'Active'),$a$,
 $a$'inactiveAgents', (select count(*) from public.agents g where g.business_id = a.id and g.status = 'Inactive'), 'onboardingAgents', (select count(*) from public.agents g where g.business_id = a.id and g.status = 'Onboarding'), 'readyAgents', (select count(*) from public.agency_onboarding x2 where x2.agency_id = a.id and x2.kind = 'agent' and x2.stage = 'references_received'),$a$);
select pg_temp.patch('public.portal_agency_onboarding(uuid)',
 $a$where o.agency_id = a.id and o.status in ('sent', 'signed')$a$, $a$where o.agency_id = a.id and o.kind = 'business' and o.status in ('sent', 'signed')$a$);
-- Start onboarding (business) never offers an agent who is in their own onboarding or was declined.
select pg_temp.patch('public.agency_onboarding_prepare(uuid, uuid)',
 $a$(x.status = 'Active' or (x.role = 'agency_admin' and x.profile_id is null))$a$, $a$(x.status = 'Active' or (x.role = 'agency_admin' and x.profile_id is null and x.status = 'Inactive'))$a$, 2);
-- The agreement and the reference approval belong to the business flow.
select pg_temp.patch('public.agency_onboarding_agreement_create(uuid, uuid, jsonb)',
 $a$if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;$a$,
 $a$if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if; if o.kind <> 'business' then raise exception 'An agent''s onboarding has no agreement: activate the agent once both references are back.' using errcode = '22023'; end if;$a$);
select pg_temp.patch('public.agency_onboarding_approve_references(uuid)',
 $a$if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;$a$,
 $a$if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if; if o.kind <> 'business' then raise exception 'Activate or reject the agent instead.' using errcode = '22023'; end if;$a$);
-- An agent's signed application form never rewrites the business's profile (the business's details were printed on it).
select pg_temp.patch('public.agency_onboarding_accept_signed(uuid, uuid, uuid, bytea, bytea, jsonb)',
 $a$update public.agencies set profile = coalesce(profile, '{}'::jsonb) || (v_answers - 'agent_signed_date'), updated_at = now() where id = o.agency_id;$a$,
 $a$if o.kind = 'business' then update public.agencies set profile = coalesce(profile, '{}'::jsonb) || (v_answers - 'agent_signed_date'), updated_at = now() where id = o.agency_id; end if;$a$);
-- Reject: an agent's onboarding also marks the agent Declined (never invited); the function words the polite email by kind.
select pg_temp.patch('public.agency_onboarding_decline(uuid, text)',
 $a$update public.agency_invitations set status = 'revoked', revoked_at = now() where agency_id = a.id and status = 'pending' and lower(email) = lower(g.email);$a$,
 $a$update public.agency_invitations set status = 'revoked', revoked_at = now() where agency_id = a.id and status = 'pending' and lower(email) = lower(g.email); if o.kind = 'agent' then update public.agents set status = 'Declined', status_changed_at = now(), status_changed_by = auth.uid(), updated_at = now() where id = g.id and status = 'Onboarding'; end if;$a$);
select pg_temp.patch('public.agency_onboarding_decline(uuid, text)',
 $a$'agency', jsonb_build_object('id', a.id, 'name', a.name));$a$, $a$'agency', jsonb_build_object('id', a.id, 'name', a.name), 'kind', o.kind);$a$);
-- The function's follow-up (referee checks, staff email) and the business page's list know the kind.
select pg_temp.patch('public.agency_onboarding_followup(uuid)',
 $a$return jsonb_build_object('id', o.id, 'stage', o.stage, 'status', o.status,$a$, $a$return jsonb_build_object('id', o.id, 'kind', o.kind, 'stage', o.stage, 'status', o.status,$a$);
select pg_temp.patch('public.agency_onboarding_list(uuid)',
 $a$jsonb_build_object('id', o.id, 'status', o.status, 'stage', o.stage,$a$, $a$jsonb_build_object('id', o.id, 'kind', o.kind, 'status', o.status, 'stage', o.stage,$a$);
select pg_temp.patch('public.agency_onboarding_list(uuid)',
 $a$'agent', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email)$a$, $a$'agent', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email, 'role', g.role, 'status', g.status)$a$);
-- Needs action today: a Ready agent is a staff decision too.
select pg_temp.patch('public.admin_today()',
 $a$'detail', 'References received: review and approve or decline'$a$,
 $a$'detail', case when o.kind = 'agent' then 'Agent ready: both references received, activate or reject' else 'References received: review and approve or decline' end$a$);

-- Add agent / Activate (CMS): a NEW agent of a business outside the direct one starts their onboarding instead (agent_onboarding_agent_add);
-- an agent in onboarding or declined is activated only from their onboarding. Re-activating an Inactive agent stays one step.
select pg_temp.patch('public.admin_agent_activate(uuid, uuid, text, text, text, text, text)',
 $a$if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;$a$,
 $a$if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if; if g.status in ('Onboarding', 'Declined') then raise exception 'This agent is going through onboarding: activate them from the business page once both references are back, or start their onboarding again.' using errcode = '23514', hint = 'agent_onboarding'; end if;$a$);
select pg_temp.patch('public.admin_agent_activate(uuid, uuid, text, text, text, text, text)',
 $a$-- An agent moves to another business only if no student ties them to their current one.$a$,
 $a$if g.id is null and not coalesce(a.is_direct, false) then raise exception 'New agents start with their onboarding: Add agent emails them the application form.' using errcode = '23514', hint = 'agent_onboarding_required'; end if;
 -- An agent moves to another business only if no student ties them to their current one.$a$);

-- No sign-in invitation to an agent who is not Active (every screen goes through these two functions).
select pg_temp.patch('public.portal_invitation_create(uuid, uuid, text, text, text, uuid)',
 $a$insert into public.agency_invitations(agency_id, email, full_name, role, invited_by, invited_by_name, student_id)$a$,
 $a$if p_role in ('agent', 'agency_admin') then
  if exists (select 1 from public.agents g where g.business_id = v_agency and g.email = v_email and g.status <> 'Active') then
   raise exception 'This agent is not active: they get their sign-in invitation once an administrator activates them.' using errcode = '22023', hint = 'agent_not_active'; end if;
  if not exists (select 1 from public.agents g where g.business_id = v_agency and g.email = v_email)
    and not exists (select 1 from public.agencies x where x.id = v_agency and coalesce(x.is_direct, false)) then
   raise exception 'Add the agent first: Add agent emails them the application form, and the sign-in invitation goes out once they are activated.' using errcode = '22023', hint = 'agent_onboarding_required'; end if;
 end if;
 insert into public.agency_invitations(agency_id, email, full_name, role, invited_by, invited_by_name, student_id)$a$);
select pg_temp.patch('public.portal_invitation_resend(uuid, uuid)',
 $a$if inv.status <> 'pending' then raise exception 'Only pending invitations can be resent.' using errcode = '22023'; end if;$a$,
 $a$if inv.status <> 'pending' then raise exception 'Only pending invitations can be resent.' using errcode = '22023'; end if;
 if inv.role in ('agent', 'agency_admin') and (exists (select 1 from public.agents g where g.business_id = inv.agency_id and g.email = inv.email and g.status <> 'Active')
   or (not exists (select 1 from public.agents g where g.business_id = inv.agency_id and g.email = inv.email) and not exists (select 1 from public.agencies x where x.id = inv.agency_id and coalesce(x.is_direct, false)))) then
  raise exception 'This agent is not active: they get their sign-in invitation once an administrator activates them.' using errcode = '22023', hint = 'agent_not_active'; end if;$a$);

-- ------------------------------------------------------------------ the agent list shows the onboarding
create or replace function public.admin_agent_rows(p_business uuid, p_search text, p_status text, p_limit integer, p_offset integer) returns jsonb
language plpgsql stable security definer set search_path = public as $function$
declare v_words text[] := public.admin_search_words(p_search); result jsonb;
begin
 with rows as (
  select g.id as agent_id, g.profile_id, g.full_name as name, g.email, g.phone, g.marn, g.role, g.business_id, g.status_changed_at,
   case when g.status = 'Onboarding' then 'Onboarding'
        when g.status = 'Declined' then 'Declined'
        when g.status <> 'Active' then 'Inactive'
        when g.profile_id is null then 'Invited'
        when exists (select 1 from public.agency_memberships m join public.portal_profiles pp on pp.id = m.user_id
          where m.user_id = g.profile_id and m.status = 'Active' and pp.status = 'Active') then 'Active'
        else 'Inactive' end as status,
   a.name as business_name, public.agency_effective_status(a) as business_status,
   coalesce(a.is_direct, false) and g.email !~ '@slit\.edu\.au$' as external_on_direct,
   (select i.id from public.agency_invitations i where i.agency_id = g.business_id and i.email = g.email and i.status = 'pending' and g.email <> '' limit 1) as invitation_id,
   (select jsonb_build_object('id', o.id, 'stage', o.stage, 'createdAt', o.created_at,
     'received', (select count(*) from public.agency_onboarding_referees f where f.onboarding_id = o.id and f.status = 'received'),
     'total', greatest((select count(*) from public.agency_onboarding_referees f where f.onboarding_id = o.id), 2),
     'ready', o.stage = 'references_received')
    from public.agency_onboarding o where o.kind = 'agent' and o.agent_id = g.id order by o.created_at desc limit 1) as onboarding
  from public.agents g
  join public.agencies a on a.id = g.business_id
  where (p_business is null or g.business_id = p_business)
   and not exists (select 1 from unnest(v_words) w where strpos(lower(concat_ws(' ', g.full_name, g.email, g.phone, g.marn, a.name)), w) = 0)
 ), filtered as (
  select *, case when business_status = 'Active' then 0 else 1 end as business_rank,
   case status when 'Active' then 0 when 'Onboarding' then 1 when 'Invited' then 2 else 3 end as rank_key
  from rows where coalesce(p_status, '') = '' or status = p_status
 ), page as (
  select * from filtered order by business_rank, rank_key, lower(name), agent_id
  limit least(greatest(coalesce(p_limit, 25), 1), 100) offset least(greatest(coalesce(p_offset, 0), 0), 1000000)
 )
 select jsonb_build_object('total', (select count(*) from filtered),
  'counts', jsonb_build_object('all', (select count(*) from rows), 'active', (select count(*) from rows where status = 'Active'),
   'invited', (select count(*) from rows where status = 'Invited'), 'inactive', (select count(*) from rows where status = 'Inactive'),
   'onboarding', (select count(*) from rows where status = 'Onboarding'), 'declined', (select count(*) from rows where status = 'Declined')),
  'rows', coalesce((select jsonb_agg(jsonb_build_object(
   'key', p.agent_id, 'agentId', p.agent_id, 'omaraId', null, 'profileId', p.profile_id, 'invitationId', p.invitation_id,
   'name', p.name, 'email', p.email, 'phone', p.phone, 'role', p.role, 'status', p.status, 'statusChangedAt', p.status_changed_at,
   'marn', p.marn, 'registered', null, 'externalOnDirect', p.external_on_direct, 'onboarding', p.onboarding,
   'businessId', p.business_id, 'businessName', p.business_name, 'businessStatus', p.business_status,
   'students', (select count(*) from public.enrollment_students s where s.agent_id = p.agent_id),
   'statusCounts', (select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb) from (select e.status, count(*) n from public.enrollment_applications e
     join public.enrollment_students s on s.id = e.student_id where s.agent_id = p.agent_id group by e.status) x)
  ) order by p.business_rank, p.rank_key, lower(p.name), p.agent_id) from page p), '[]'::jsonb))
 into result;
 return result;
end $function$;

-- The agent page and the Agents filter know the two new statuses.
select pg_temp.patch('public.admin_agent_overview(uuid)',
 $a$v_status := case when g.status <> 'Active' then 'Inactive'$a$, $a$v_status := case when g.status in ('Onboarding', 'Declined') then g.status when g.status <> 'Active' then 'Inactive'$a$);
select pg_temp.patch('public.admin_agent_overview(uuid)',
 $a$'business', jsonb_build_object('id', a.id, 'name', a.name, 'status', a.status),$a$,
 $a$'business', jsonb_build_object('id', a.id, 'name', a.name, 'status', a.status), 'onboarding', (select jsonb_build_object('id', o.id, 'stage', o.stage, 'createdAt', o.created_at, 'received', (select count(*) from public.agency_onboarding_referees f where f.onboarding_id = o.id and f.status = 'received'), 'total', greatest((select count(*) from public.agency_onboarding_referees f where f.onboarding_id = o.id), 2), 'ready', o.stage = 'references_received') from public.agency_onboarding o where o.kind = 'agent' and o.agent_id = g.id order by o.created_at desc limit 1),$a$);
select pg_temp.patch('public.admin_agent_directory(text, text, uuid, integer, integer)',
 $a$not in ('', 'Active', 'Invited', 'Inactive')$a$, $a$not in ('', 'Active', 'Invited', 'Inactive', 'Onboarding', 'Declined')$a$);

-- ------------------------------------------------------------------ the agent flow
-- Who may add an agent to a business: a SLIT administrator (CMS), or the business's own active business admin agent (portal).
create or replace function public.agent_onboarding_actor(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $f$
declare c jsonb; v_agency uuid;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if public.portal_is_slit_admin() and public.tenant_request_domain() is null then
  if p_business is null then raise exception 'Choose the business this agent works for' using errcode = '22023'; end if;
  return jsonb_build_object('business', p_business, 'staff', true, 'name', coalesce((select u.name from public.cms_users u where u.auth_user_id = auth.uid() limit 1), ''));
 end if;
 c := public.portal_actor_context(auth.uid());
 v_agency := (c->>'agencyId')::uuid;
 if c->>'role' is distinct from 'agency_admin' or v_agency is null or (p_business is not null and p_business <> v_agency) then
  raise exception 'Only a SLIT administrator or the business''s admin agent can add agents' using errcode = '42501'; end if;
 return jsonb_build_object('business', v_agency, 'staff', false, 'name', coalesce(c->>'name', ''));
end $f$;
revoke all on function public.agent_onboarding_actor(uuid) from public, anon, authenticated;

-- What the agent's application form prints: the business's details (from its profile and record), the agent's own contact; never the
-- business's referees, contact, signatory or declarant answers.
create or replace function public.agent_onboarding_agent_values(p_agent uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $f$
declare g public.agents; v jsonb; v_parts text[]; v_given text; v_family text; k text;
begin
 select * into g from public.agents where id = p_agent;
 if not found then return '{}'::jsonb; end if;
 v := public.agent_onboarding_values(g.id);
 for k in select jsonb_object_keys(v) loop
  if k ~ '^(ref[12]_|contact_|agent_signatory_|declarant_|agent_witness|litigation_|eatc_|agent_signed_date|admin_)' then v := v - k; end if;
 end loop;
 v_parts := regexp_split_to_array(btrim(coalesce(g.full_name, '')), '\s+');
 if coalesce(array_length(v_parts, 1), 0) >= 2 then v_given := array_to_string(v_parts[1:array_length(v_parts, 1) - 1], ' '); v_family := v_parts[array_length(v_parts, 1)];
 else v_given := coalesce(v_parts[1], ''); v_family := ''; end if;
 return v || jsonb_strip_nulls(jsonb_build_object('contact_given_name', nullif(v_given, ''), 'contact_family_name', nullif(v_family, ''), 'contact_email', nullif(g.email, ''),
  'contact_phone', nullif(btrim(coalesce(g.phone, '')), ''), 'declarant_name', nullif(btrim(coalesce(g.full_name, '')), ''), 'agent_signatory_name', nullif(btrim(coalesce(g.full_name, '')), '')));
end $f$;
revoke all on function public.agent_onboarding_agent_values(uuid) from public, anon, authenticated;

-- Add agent: the agent record (Onboarding, no login, no invitation) and their onboarding (kind agent, application_sent). The function then
-- makes and emails the application form (agency_onboarding_agent_application_create). p_agent restarts a Declined agent, or one whose
-- previous onboarding was cancelled or expired. The direct business adds agents as before (admin_agent_activate).
create or replace function public.agent_onboarding_agent_add(p_business uuid, p_name text, p_email text, p_phone text default '', p_role text default 'agent',
 p_message text default null, p_agent uuid default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare actor jsonb := public.agent_onboarding_actor(p_business); a public.agencies; g public.agents; o public.agency_onboarding;
 v_name text := btrim(coalesce(p_name, '')); v_email text := lower(btrim(coalesce(p_email, ''))); v_phone text := left(btrim(coalesce(p_phone, '')), 40); v_role text := coalesce(p_role, 'agent');
begin
 select * into a from public.agencies where id = (actor->>'business')::uuid for update;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 if coalesce(a.is_direct, false) then raise exception 'SLIT''s direct business has no agent onboarding: add the agent there directly.' using errcode = '22023', hint = 'direct_business'; end if;
 if not public.agency_is_operational(a.id) then
  raise exception '%', coalesce(public.agency_gate_reason(a), 'Activate the business first.') using errcode = '23514', hint = 'business_inactive'; end if;
 if v_role not in ('agent', 'agency_admin') then raise exception 'Role must be agent or business admin agent' using errcode = '22023'; end if;
 if p_agent is not null then
  select * into g from public.agents where id = p_agent and business_id = a.id for update;
  if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;
  if g.status not in ('Onboarding', 'Declined') then raise exception 'This agent is not waiting for an onboarding' using errcode = '22023'; end if;
  if v_name = '' then v_name := g.full_name; end if;
  if v_email = '' then v_email := g.email; end if;
  if v_phone = '' then v_phone := g.phone; end if;
  if p_role is null then v_role := g.role; end if;
 end if;
 if v_name = '' or v_name ~ '[[:cntrl:]]' or char_length(v_name) > 200 then raise exception 'Enter the agent''s name' using errcode = '22023'; end if;
 if v_email = '' or length(v_email) > 254 or v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then
  raise exception 'Enter the agent''s email address: the application form goes there' using errcode = '22023'; end if;
 if exists (select 1 from public.agents x where x.email = v_email and x.business_id = a.id and x.id is distinct from g.id) then
  raise exception 'An agent with this email is already in this business' using errcode = '23505', hint = 'email_taken'; end if;
 if exists (select 1 from public.cms_users u where lower(u.email) = v_email and u.role = 'Admin') then
  raise exception 'Organization administrators cannot be agents.' using errcode = '42501'; end if;
 if exists (select 1 from public.portal_profiles p join public.agency_memberships m on m.user_id = p.id where lower(p.email) = v_email and m.status = 'Active' and p.status = 'Active') then
  raise exception 'This email already belongs to an active portal user.' using errcode = '23505', hint = 'email_taken'; end if;
 if g.id is not null and exists (select 1 from public.agency_onboarding x where x.kind = 'agent' and x.agent_id = g.id
   and x.stage in ('application_sent', 'application_signed', 'references_pending', 'references_received')) then
  raise exception 'This agent''s onboarding is already in progress' using errcode = '23505'; end if;
 if g.id is null then
  insert into public.agents(business_id, full_name, email, phone, role, status, status_changed_at, status_changed_by)
  values (a.id, v_name, v_email, v_phone, v_role, 'Onboarding', now(), auth.uid()) returning * into g;
 else
  update public.agents set full_name = v_name, email = v_email, phone = v_phone, role = v_role, status = 'Onboarding', status_changed_at = now(), status_changed_by = auth.uid(), updated_at = now()
   where id = g.id returning * into g;
 end if;
 insert into public.agency_onboarding(kind, agency_id, agent_id, request_id, stage, form_pages, sent_values, sent_by, message, admin_name)
 values ('agent', a.id, g.id, null, 'application_sent', 1, '{}'::jsonb, auth.uid(), nullif(left(btrim(coalesce(p_message, '')), 2000), ''), left(coalesce(actor->>'name', ''), 150))
 returning * into o;
 perform public.agency_onboarding_log(o.id, 'agent_added', jsonb_build_object('agent', g.id, 'email', g.email, 'role', g.role, 'by', case when (actor->>'staff')::boolean then 'staff' else 'business_admin' end, 'restart', p_agent is not null));
 perform public.admin_business_audit('agent_onboarding_started', a.id, a.id, jsonb_build_object('onboarding', o.id, 'agent', g.id, 'email', g.email));
 return jsonb_build_object('onboardingId', o.id, 'agentId', g.id, 'agency', jsonb_build_object('id', a.id, 'name', a.name, 'abn', nullif(a.registration_number, '')),
  'agent', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email, 'role', g.role, 'status', g.status), 'values', public.agent_onboarding_agent_values(g.id));
end $f$;
revoke all on function public.agent_onboarding_agent_add(uuid, text, text, text, text, text, uuid) from public, anon;
grant execute on function public.agent_onboarding_agent_add(uuid, text, text, text, text, text, uuid) to authenticated;

-- An installed onboarding template by key (the function; the portal caller cannot read hr.sign_templates).
create or replace function public.agency_onboarding_template_get(p_key text) returns jsonb
language sql stable security definer set search_path = pg_catalog, public, hr as $f$
 select jsonb_build_object('id', t.id, 'systemKey', t.system_key, 'status', t.status, 'sourcePath', t.source_path, 'sourceHash', t.source_hash, 'sourcePages', t.source_pages, 'fields', t.fields,
  'expiryDays', t.expiry_days, 'reminderDays', t.reminder_days) from hr.sign_templates t where t.system_key = p_key and t.status = 'active' and t.deleted_at is null limit 1;
$f$;
revoke all on function public.agency_onboarding_template_get(text) from public, anon, authenticated;
grant execute on function public.agency_onboarding_template_get(text) to service_role;

-- The agent's application form, made and sent from the database as the referee checks are (the function stored the prefilled F04 as
-- <id>/original.pdf). Only for an agent onboarding still waiting for its form.
create or replace function public.agency_onboarding_agent_application_create(p_onboarding uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; g public.agents; r hr.sign_requests; c hr.sign_recipients; v jsonb; v_id uuid; v_days integer; v_remind integer;
begin
 p_data := coalesce(p_data, '{}'::jsonb);
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.kind <> 'agent' or o.stage <> 'application_sent' or o.application_request_id is not null then raise exception 'This onboarding is not waiting for its application form'; end if;
 select * into g from public.agents where id = o.agent_id;
 if coalesce(p_data->>'original_hash', '') !~ '^[a-f0-9]{64}$' then raise exception 'The application form document is missing'; end if;
 v_days := least(greatest(coalesce((p_data->>'expiry_days')::integer, 30), 1), 365); v_remind := least(greatest(coalesce((p_data->>'reminder_days')::integer, 3), 0), 60);
 v_id := coalesce((p_data->>'id')::uuid, gen_random_uuid());
 insert into hr.sign_requests(id, title, recipient_name, recipient_email, original_path, original_hash, state, created_by, reference, signing_mode, subject_type, subject_id, category,
   expiry_days, reminder_days, message, agency_onboarding_id, template_id, require_code, field_values)
 values (v_id, left(coalesce(nullif(btrim(coalesce(p_data->>'title', '')), ''), 'Agent application form'), 200), left(g.full_name, 150), g.email, v_id::text || '/original.pdf', p_data->>'original_hash', 'draft',
   coalesce(o.sent_by, '00000000-0000-0000-0000-000000000000'::uuid), 'SLIT-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('hr.sign_reference_seq')::text, 6, '0'), 'sequential', 'agent', g.id, 'other',
   v_days, v_remind, coalesce(nullif(left(coalesce(p_data->>'message', ''), 2000), ''), o.message), o.id, (p_data->>'template_id')::uuid, false, coalesce(p_data->'values', '{}'::jsonb))
 returning * into r;
 insert into hr.sign_recipients(request_id, role_key, role_label, name, email, signing_order, required, state)
 values (r.id, left(coalesce(nullif(p_data->>'role_key', ''), 'agent'), 40), left(coalesce(nullif(p_data->>'role_label', ''), 'Agent'), 80), left(g.full_name, 150), g.email, 1, true, 'pending') returning * into c;
 for v in select * from jsonb_array_elements(coalesce(p_data->'fields', '[]'::jsonb)) loop
  insert into hr.sign_fields(request_id, recipient_id, type, page, x, y, w, h, required, label, key, value)
  values (r.id, c.id, v->>'type', (v->>'page')::integer, (v->>'x')::numeric, (v->>'y')::numeric, (v->>'w')::numeric, (v->>'h')::numeric, coalesce((v->>'required')::boolean, true),
   left(coalesce(v->>'label', ''), 120), nullif(left(coalesce(v->>'key', ''), 80), ''), case when v->>'type' = 'text' then nullif(left(coalesce(v->>'value', ''), 500), '') end);
 end loop;
 perform hr.sign_event(r.id, 'created', null, null, jsonb_build_object('onboarding', o.id, 'document', 'application', 'original_hash', r.original_hash));
 update hr.sign_requests set state = 'sent', sent_at = now(), expires_at = now() + make_interval(days => v_days) where id = r.id returning * into r;
 perform hr.sign_event(r.id, 'sent', null, null, jsonb_build_object('mode', r.signing_mode, 'expires_at', r.expires_at));
 perform hr.sign_activate(r.id);
 update public.agency_onboarding set application_request_id = r.id, form_pages = greatest(coalesce((p_data->>'form_pages')::integer, 1), 1),
  sent_values = coalesce(p_data->'values', '{}'::jsonb) where id = o.id;
 perform public.agency_onboarding_log(o.id, 'application_sent', jsonb_build_object('request', r.reference, 'agent', g.id, 'email', g.email), o.sent_by);
 return jsonb_build_object('onboardingId', o.id, 'requestId', r.id, 'reference', r.reference, 'recipientId', c.id, 'expiresAt', r.expires_at);
end $f$;
revoke all on function public.agency_onboarding_agent_application_create(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.agency_onboarding_agent_application_create(uuid, jsonb) to service_role;

-- The form could not be made or sent: the onboarding is closed (the agent stays Onboarding; Add agent / Send again starts it again).
create or replace function public.agency_onboarding_agent_abort(p_onboarding uuid, p_reason text) returns void
language plpgsql security definer set search_path = pg_catalog, public as $f$
begin
 update public.agency_onboarding set stage = 'cancelled', status = 'closed', closed_reason = left(coalesce(nullif(btrim(p_reason), ''), 'not_sent'), 200)
  where id = p_onboarding and kind = 'agent' and stage = 'application_sent' and application_request_id is null;
 if found then perform public.agency_onboarding_log(p_onboarding, 'cancelled', jsonb_build_object('document', 'application', 'reason', left(coalesce(p_reason, ''), 200))); end if;
end $f$;
revoke all on function public.agency_onboarding_agent_abort(uuid, text) from public, anon, authenticated;
grant execute on function public.agency_onboarding_agent_abort(uuid, text) to service_role;

-- Activate: only when both references are back. The agent becomes Active and ONE invitation is made (none when they already sign in);
-- the function emails the congratulations set-password link.
create or replace function public.agency_onboarding_agent_activate(p_onboarding uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; a public.agencies; g public.agents; inv public.agency_invitations; v_received integer; v_total integer; v_login boolean := false; v_made boolean := false; v_staff text;
begin
 perform public.admin_business_require();
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.kind <> 'agent' then raise exception 'This is the business''s onboarding: it completes with the signed agreement.' using errcode = '22023'; end if;
 select count(*) filter (where status = 'received'), count(*) into v_received, v_total from public.agency_onboarding_referees where onboarding_id = o.id;
 if o.stage <> 'references_received' or v_total < 2 or v_received < v_total then
  raise exception 'The agent can be activated once both references are back (% of 2 received).', coalesce(v_received, 0) using errcode = '23514', hint = 'references_outstanding'; end if;
 select * into a from public.agencies where id = o.agency_id for update;
 if not public.agency_is_operational(a.id) then
  raise exception '%', coalesce(public.agency_gate_reason(a), 'Activate the business first.') using errcode = '23514', hint = 'business_inactive'; end if;
 select * into g from public.agents where id = o.agent_id for update;
 if g.status <> 'Onboarding' then raise exception 'This agent is not in onboarding' using errcode = '22023'; end if;
 update public.agents set status = 'Active', status_changed_at = now(), status_changed_by = auth.uid(), updated_at = now() where id = g.id returning * into g;
 if g.profile_id is not null then
  update public.portal_profiles set status = 'Active', updated_at = now() where id = g.profile_id and status <> 'Active';
  update public.agency_memberships set status = 'Active', agency_id = a.id, role = case when role = 'student' then role else g.role end, updated_at = now() where user_id = g.profile_id;
  v_login := true;
 elsif g.email <> '' then
  select * into inv from public.agency_invitations i where i.agency_id = a.id and i.email = g.email and i.status = 'pending' order by i.created_at desc limit 1;
  if inv.id is null and not exists (select 1 from public.portal_profiles p join public.agency_memberships m on m.user_id = p.id where lower(p.email) = g.email and m.status = 'Active' and p.status = 'Active') then
   select u.name into v_staff from public.cms_users u where u.auth_user_id = auth.uid() limit 1;
   insert into public.agency_invitations(agency_id, email, full_name, role, invited_by, invited_by_name) values (a.id, g.email, g.full_name, g.role, auth.uid(), coalesce(v_staff, 'Skyline'))
   returning * into inv;
   v_made := true;
  end if;
 end if;
 update public.agency_onboarding set stage = 'activated', status = 'signed', activated_at = now(), approved_by = auth.uid(), approved_at = now(), activation_invitation_id = coalesce(inv.id, activation_invitation_id)
  where id = o.id returning * into o;
 perform public.agency_onboarding_log(o.id, 'agent_activated', jsonb_build_object('agent', g.id, 'email', g.email, 'invitation', inv.id, 'login', v_login));
 perform public.admin_business_audit('agent_activated', a.id, a.id, jsonb_build_object('agent', g.full_name, 'onboarding', o.id));
 return jsonb_build_object('onboardingId', o.id, 'stage', o.stage, 'agency', jsonb_build_object('id', a.id, 'name', a.name),
  'agent', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email, 'role', g.role, 'status', g.status), 'loginExists', v_login,
  'invitation', case when inv.id is null then null else jsonb_build_object('id', inv.id, 'email', inv.email, 'name', inv.full_name, 'role', inv.role, 'expiresAt', inv.expires_at, 'new', v_made,
   'sent', inv.link_sent_at is not null) end);
end $f$;
revoke all on function public.agency_onboarding_agent_activate(uuid) from public, anon;
grant execute on function public.agency_onboarding_agent_activate(uuid) to authenticated;
