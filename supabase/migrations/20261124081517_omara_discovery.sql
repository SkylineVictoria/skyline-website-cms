-- OMARA-DISCOVERY (2026-11-24, owner: "OMARA Business & Migration Agent Discovery" in Master Data › Businesses).
-- When staff add a business by ABN, the Edge Function omara-discovery finds the business's registered migration agents on the
-- public OMARA Register of Migration Agents (portal.mara.gov.au) and staff link the ones they confirm to the business.
--
-- Method (no OMARA API exists): a commercial web search API (Brave Search or Tavily, key in Integrations › Connections, Vault)
-- returns indexed public agent detail pages (…/register-of-migration-agent-details/?ContactID=<guid>); the function then makes ONE
-- plain HTTP GET per detail page, sequentially, with a gap between requests (Business Rule omara.request_gap_ms) and small
-- per-business caps (omara.max_search_queries, omara.max_agent_pages). The register's internal search service is NOT used.
-- A manual fallback (staff paste OMARA detail links) uses the same fetch / parse / match.
--
-- These agents are migration agents on a public register, NOT SLIT education agents: nothing is written to public.agents.
-- Their contact details are for verification and onboarding only, not for marketing.
--
-- New:
--   public.omara_agents                 one row per MARN, the last parsed official record (CMS admins read; writes via the service role)
--   public.omara_agent_businesses       which SLIT businesses (agencies) an agent is linked to; many businesses per agent
--   public.omara_agent_verifications    every fetch of an official record (outcome, what changed)
--   public.omara_discovery_runs         every discovery / import (provider, queries, counts, estimated cost)
--   public.omara_agents_for_agency(uuid), public.omara_link_agents(uuid, text[], jsonb), public.omara_unlink_agent(uuid, text)  (SLIT admins)
--   public.omara_agent_upsert(jsonb), public.omara_agent_check_failed(text, text, text), public.omara_discovery_run_record(jsonb)  (service role)
--   public.integration_search_api_key(text), public.integration_search_check_record(text, boolean, text)  (service role)
--   integration_definitions rows brave_search / tavily; Business Rules omara.* (category Agents)
-- Changed (each the LIVE definition from pg_get_functiondef on xcpydisstlvtvcsqnjob, 2026-11-24, plus the new branch only):
--   public.integration_comm_credentials_save / _clear / _summary   (+ brave_search, tavily)
--   public.edge_function_names()   (+ omara-discovery; and student-application-invite, student-practice, deployed 2026-11-23 without being added)
-- Additive. Rollback (manual): re-create the three integration functions and edge_function_names from 20261124061517 / 20261123111517,
-- drop the new functions and the four omara_* tables, delete the brave_search / tavily connections, definitions and the omara.* rules.
begin;

-- 1. Tables ------------------------------------------------------------------------------------------------------------------------

create table public.omara_agents (
  marn text primary key check (marn ~ '^\d{7}$'),
  full_name text not null check (char_length(full_name) between 1 and 200),
  status text,
  registration_commenced_at timestamptz,
  business_name text,
  address_line text,
  suburb text,
  state text,
  postcode text,
  country text,
  phone text,
  email text,
  website text,
  contact_id uuid unique,
  source_url text not null check (source_url ~ '^https://[^[:space:]]+$'),
  register_updated_at timestamptz,
  verified_at timestamptz not null,
  disciplinary jsonb,
  raw_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.omara_agents is 'Registered migration agents as last read from their public OMARA register page (one plain GET per page). Not SLIT education agents. Contact details are for verification and onboarding only, never for marketing.';
comment on column public.omara_agents.registration_commenced_at is 'The register''s "most recent registration commenced on" value (the page shows it in UTC and converts it to local time with JavaScript).';
comment on column public.omara_agents.disciplinary is 'Only a disciplinary decision page found for this MARN and confirmed by fetching it; null = none verified (never guessed).';

create table public.omara_agent_businesses (
  marn text not null references public.omara_agents(marn) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  confidence int not null default 0 check (confidence between 0 and 100),
  evidence jsonb not null default '[]'::jsonb,
  linked_by uuid,
  linked_at timestamptz not null default now(),
  unique (marn, agency_id)
);
create index omara_agent_businesses_agency_idx on public.omara_agent_businesses(agency_id);
comment on table public.omara_agent_businesses is 'Registered migration agents staff confirmed as working for a SLIT business (agency). Many businesses per agent.';

create table public.omara_agent_verifications (
  id bigint generated always as identity primary key,
  marn text not null,
  fetched_at timestamptz not null default now(),
  source_url text not null,
  outcome text not null check (outcome in ('new', 'unchanged', 'changed', 'not_found', 'error')),
  changed jsonb not null default '{}'::jsonb
);
create index omara_agent_verifications_marn_idx on public.omara_agent_verifications(marn, fetched_at desc);

create table public.omara_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references public.agencies(id) on delete set null,
  abn text check (abn is null or abn ~ '^\d{11}$'),
  names jsonb not null default '[]'::jsonb,
  provider text not null check (provider in ('brave', 'tavily', 'manual', 'none')),
  queries jsonb not null default '[]'::jsonb,
  results int not null default 0 check (results >= 0),
  pages_fetched int not null default 0 check (pages_fetched >= 0),
  est_cost_usd numeric(10, 4) not null default 0 check (est_cost_usd >= 0),
  error text check (error is null or char_length(error) <= 500),
  created_at timestamptz not null default now(),
  created_by uuid
);
create index omara_discovery_runs_agency_idx on public.omara_discovery_runs(agency_id, created_at desc);

alter table public.omara_agents enable row level security;
alter table public.omara_agent_businesses enable row level security;
alter table public.omara_agent_verifications enable row level security;
alter table public.omara_discovery_runs enable row level security;
revoke all on public.omara_agents, public.omara_agent_businesses, public.omara_agent_verifications, public.omara_discovery_runs from public, anon, authenticated;
grant select on public.omara_agents, public.omara_agent_businesses, public.omara_agent_verifications, public.omara_discovery_runs to authenticated;
grant all on public.omara_agents, public.omara_agent_businesses, public.omara_agent_verifications, public.omara_discovery_runs to service_role;
create policy omara_agents_admin_read on public.omara_agents for select to authenticated using (public.cms_is_admin());
create policy omara_agent_businesses_admin_read on public.omara_agent_businesses for select to authenticated using (public.cms_is_admin());
create policy omara_agent_verifications_admin_read on public.omara_agent_verifications for select to authenticated using (public.cms_is_admin());
create policy omara_discovery_runs_admin_read on public.omara_discovery_runs for select to authenticated using (public.cms_is_admin());

-- 2. Service-role writers ------------------------------------------------------------------------------------------------------------

/** One parsed official record (omara-discovery): inserted or updated by MARN; every call adds a verification row. Service role only. */
create function public.omara_agent_upsert(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_marn text := btrim(coalesce(p->>'marn', '')); v_old public.omara_agents; v_changed jsonb := '{}'::jsonb; v_outcome text; k text;
  v_contact uuid; v_url text := btrim(coalesce(p->>'sourceUrl', ''));
  fields text[] := array['full_name', 'status', 'registration_commenced_at', 'business_name', 'address_line', 'suburb', 'state', 'postcode', 'country',
    'phone', 'email', 'website', 'register_updated_at'];
  src text[] := array['fullName', 'status', 'registrationCommencedAt', 'businessName', 'addressLine', 'suburb', 'state', 'postcode', 'country',
    'phone', 'email', 'website', 'registerUpdatedAt'];
  i int;
  t text := '';
begin
  if jsonb_typeof(p) is distinct from 'object' or length(p::text) > 20000 then raise exception 'The agent record could not be read.' using errcode = '22023'; end if;
  if v_marn !~ '^\d{7}$' then raise exception 'A MARN has 7 digits.' using errcode = '22023'; end if;
  if btrim(coalesce(p->>'fullName', '')) = '' then raise exception 'The agent record has no name.' using errcode = '22023'; end if;
  if v_url !~ '^https://[^[:space:]]+$' then raise exception 'The agent record has no source link.' using errcode = '22023'; end if;
  if coalesce(p->>'contactId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_contact := (p->>'contactId')::uuid; end if;
  -- Another MARN holding this ContactID is a stale row: the register's page now names this MARN, so the link moves here.
  if v_contact is not null then update public.omara_agents set contact_id = null, updated_at = now() where contact_id = v_contact and marn <> v_marn; end if;
  select * into v_old from public.omara_agents where marn = v_marn for update;
  if found then
    for i in 1 .. array_length(fields, 1) loop
      k := fields[i];
      execute format('select ($1).%I::text', k) into t using v_old;
      if coalesce(t, '') is distinct from coalesce(nullif(btrim(coalesce(p->>src[i], '')), ''), '') then
        -- Timestamps compare as instants, not as text.
        if k in ('registration_commenced_at', 'register_updated_at') and t is not null and nullif(p->>src[i], '') is not null
           and t::timestamptz = (p->>src[i])::timestamptz then continue; end if;
        v_changed := v_changed || jsonb_build_object(k, jsonb_build_object('from', t, 'to', nullif(btrim(coalesce(p->>src[i], '')), '')));
      end if;
    end loop;
    v_outcome := case when v_changed = '{}'::jsonb then 'unchanged' else 'changed' end;
  else
    v_outcome := 'new';
  end if;
  insert into public.omara_agents(marn, full_name, status, registration_commenced_at, business_name, address_line, suburb, state, postcode, country,
    phone, email, website, contact_id, source_url, register_updated_at, verified_at, disciplinary, raw_fields)
  values (v_marn, left(btrim(p->>'fullName'), 200), nullif(left(btrim(coalesce(p->>'status', '')), 100), ''),
    nullif(p->>'registrationCommencedAt', '')::timestamptz, nullif(left(btrim(coalesce(p->>'businessName', '')), 300), ''),
    nullif(left(btrim(coalesce(p->>'addressLine', '')), 300), ''), nullif(left(btrim(coalesce(p->>'suburb', '')), 100), ''),
    nullif(left(btrim(coalesce(p->>'state', '')), 10), ''), nullif(left(btrim(coalesce(p->>'postcode', '')), 10), ''),
    nullif(left(btrim(coalesce(p->>'country', '')), 80), ''), nullif(left(btrim(coalesce(p->>'phone', '')), 40), ''),
    nullif(left(btrim(coalesce(p->>'email', '')), 200), ''), nullif(left(btrim(coalesce(p->>'website', '')), 300), ''),
    v_contact, left(v_url, 500), nullif(p->>'registerUpdatedAt', '')::timestamptz, coalesce(nullif(p->>'verifiedAt', '')::timestamptz, now()),
    case when jsonb_typeof(p->'disciplinary') in ('object', 'array') then p->'disciplinary' end,
    case when jsonb_typeof(p->'rawFields') = 'object' then p->'rawFields' else '{}'::jsonb end)
  on conflict (marn) do update set full_name = excluded.full_name, status = excluded.status, registration_commenced_at = excluded.registration_commenced_at,
    business_name = excluded.business_name, address_line = excluded.address_line, suburb = excluded.suburb, state = excluded.state,
    postcode = excluded.postcode, country = excluded.country, phone = excluded.phone, email = excluded.email, website = excluded.website,
    contact_id = coalesce(excluded.contact_id, public.omara_agents.contact_id), source_url = excluded.source_url,
    register_updated_at = coalesce(excluded.register_updated_at, public.omara_agents.register_updated_at), verified_at = excluded.verified_at,
    -- A disciplinary decision once verified stays until a later check verifies another one.
    disciplinary = coalesce(excluded.disciplinary, public.omara_agents.disciplinary), raw_fields = excluded.raw_fields, updated_at = now();
  insert into public.omara_agent_verifications(marn, source_url, outcome, changed) values (v_marn, left(v_url, 500), v_outcome, v_changed);
  return jsonb_build_object('marn', v_marn, 'outcome', v_outcome, 'changed', v_changed);
end;
$$;

/** A re-check that could not read the agent's page (gone, not a detail page any more, the register not answering). Service role only. */
create function public.omara_agent_check_failed(p_marn text, p_url text, p_outcome text) returns void
language sql security definer set search_path = public as $$
  insert into public.omara_agent_verifications(marn, source_url, outcome)
  select p_marn, left(coalesce(p_url, ''), 500), case when p_outcome = 'not_found' then 'not_found' else 'error' end
  where p_marn ~ '^\d{7}$';
$$;

/** One discovery or link import (omara-discovery): provider, queries sent, counts and the estimated search cost. Service role only. */
create function public.omara_discovery_run_record(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_agency uuid;
begin
  if coalesce(p->>'agencyId', '') ~* '^[0-9a-f-]{36}$' then select id into v_agency from public.agencies where id = (p->>'agencyId')::uuid; end if;
  insert into public.omara_discovery_runs(agency_id, abn, names, provider, queries, results, pages_fetched, est_cost_usd, error, created_by)
  values (v_agency, case when coalesce(p->>'abn', '') ~ '^\d{11}$' then p->>'abn' end,
    case when jsonb_typeof(p->'names') = 'array' then p->'names' else '[]'::jsonb end,
    case when p->>'provider' in ('brave', 'tavily', 'manual', 'none') then p->>'provider' else 'none' end,
    case when jsonb_typeof(p->'queries') = 'array' then p->'queries' else '[]'::jsonb end,
    greatest(coalesce((p->>'results')::int, 0), 0), greatest(coalesce((p->>'pagesFetched')::int, 0), 0),
    greatest(coalesce((p->>'estCostUsd')::numeric, 0), 0), nullif(left(coalesce(p->>'error', ''), 500), ''),
    case when coalesce(p->>'createdBy', '') ~* '^[0-9a-f-]{36}$' then (p->>'createdBy')::uuid end)
  returning id into v_id;
  return v_id;
end;
$$;

-- 3. Staff (SLIT admins) -------------------------------------------------------------------------------------------------------------

/** The registered migration agents linked to a business, with their last official record and when it was verified. */
create function public.omara_agents_for_agency(p_agency uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_business_require();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'marn', a.marn, 'fullName', a.full_name, 'status', a.status, 'registrationCommencedAt', a.registration_commenced_at,
      'businessName', a.business_name, 'addressLine', a.address_line, 'suburb', a.suburb, 'state', a.state, 'postcode', a.postcode,
      'country', a.country, 'phone', a.phone, 'email', a.email, 'website', a.website, 'contactId', a.contact_id, 'sourceUrl', a.source_url,
      'registerUpdatedAt', a.register_updated_at, 'verifiedAt', a.verified_at, 'disciplinary', a.disciplinary,
      'confidence', l.confidence, 'evidence', l.evidence, 'linkedAt', l.linked_at, 'linkedBy', l.linked_by)
      order by a.full_name)
    from public.omara_agent_businesses l join public.omara_agents a on a.marn = l.marn where l.agency_id = p_agency), '[]'::jsonb);
end;
$$;

/** Links registered migration agents (already read from the register: rows of omara_agents) to a business. p_evidence: {MARN: {confidence, evidence[]}}. */
create function public.omara_link_agents(p_agency uuid, p_marns text[], p_evidence jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_marns text[]; v_missing text[]; m text; e jsonb; v_count int := 0;
begin
  perform public.admin_business_require();
  if not exists (select 1 from public.agencies where id = p_agency) then raise exception 'Business not found' using errcode = 'P0002'; end if;
  select array_agg(distinct btrim(x)) into v_marns from unnest(coalesce(p_marns, '{}')) x where btrim(x) <> '';
  if v_marns is null or array_length(v_marns, 1) = 0 then raise exception 'Choose at least one agent.' using errcode = '22023'; end if;
  if array_length(v_marns, 1) > 50 then raise exception 'Link up to 50 agents at a time.' using errcode = '22023'; end if;
  if exists (select 1 from unnest(v_marns) x where x !~ '^\d{7}$') then raise exception 'A MARN has 7 digits.' using errcode = '22023'; end if;
  select array_agg(x) into v_missing from unnest(v_marns) x where not exists (select 1 from public.omara_agents a where a.marn = x);
  if v_missing is not null then
    raise exception 'Read these agents from the register first: %', array_to_string(v_missing, ', ') using errcode = '22023';
  end if;
  foreach m in array v_marns loop
    e := case when jsonb_typeof(p_evidence) = 'object' and jsonb_typeof(p_evidence->m) = 'object' then p_evidence->m else '{}'::jsonb end;
    insert into public.omara_agent_businesses(marn, agency_id, confidence, evidence, linked_by, linked_at)
    values (m, p_agency, least(greatest(coalesce(case when e->>'confidence' ~ '^\d{1,3}$' then (e->>'confidence')::int end, 0), 0), 100),
      case when jsonb_typeof(e->'evidence') = 'array' and length((e->'evidence')::text) <= 4000 then e->'evidence' else '[]'::jsonb end, auth.uid(), now())
    on conflict (marn, agency_id) do update set confidence = excluded.confidence, evidence = excluded.evidence, linked_by = excluded.linked_by, linked_at = now();
    v_count := v_count + 1;
  end loop;
  perform public.admin_business_audit('omara_agents_linked', p_agency, p_agency, jsonb_build_object('marns', to_jsonb(v_marns)));
  return jsonb_build_object('agencyId', p_agency, 'linked', v_count);
end;
$$;

create function public.omara_unlink_agent(p_agency uuid, p_marn text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform public.admin_business_require();
  delete from public.omara_agent_businesses where agency_id = p_agency and marn = btrim(coalesce(p_marn, ''));
  get diagnostics n = row_count;
  if n > 0 then perform public.admin_business_audit('omara_agent_unlinked', p_agency, p_agency, jsonb_build_object('marn', btrim(p_marn))); end if;
  return jsonb_build_object('agencyId', p_agency, 'removed', n);
end;
$$;

-- 4. Search API connections (Brave Search, Tavily) in Integrations › Connections ----------------------------------------------------

insert into public.integration_definitions(id, name, auth_type, availability, description) values
  ('brave_search', 'Brave Search', 'api_key', 'available', 'Finds the public OMARA register pages of a business''s registered migration agents.'),
  ('tavily', 'Tavily', 'api_key', 'available', 'Finds the public OMARA register pages of a business''s registered migration agents (alternative to Brave Search).')
on conflict (id) do nothing;

create or replace function public.integration_comm_credentials_save(p_connection uuid, p_fields jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare c record; f jsonb := coalesce(p_fields, '{}'::jsonb); v_fields jsonb; ch jsonb; v_names text[] := '{}'; v_name text; v_url text;
begin
  select id, tenant_id, connector_id, status into c from public.integration_connections where id = p_connection;
  if not found then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not coalesce(public.integration_can_manage(c.tenant_id), false) or not coalesce(public.integration_module_access(), false) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if c.connector_id not in ('clicksend', 'whatsapp', 'microsoft_teams', 'google_maps', 'brave_search', 'tavily') then raise exception 'This application is set up elsewhere' using errcode = '22023'; end if;
  if c.status = 'disabled' then raise exception 'Enable the connection first' using errcode = '55000'; end if;
  if c.connector_id = 'clicksend' then
    if btrim(coalesce(f->>'username', '')) = '' or length(f->>'username') > 200 or length(btrim(coalesce(f->>'apiKey', ''))) < 8 or length(f->>'apiKey') > 200 then
      raise exception 'Enter the ClickSend API username and API key' using errcode = '22023';
    end if;
    if nullif(btrim(coalesce(f->>'from', '')), '') is not null and btrim(f->>'from') !~ '^([A-Za-z][A-Za-z0-9 ]{0,10}|\+[1-9][0-9]{7,14})$' then
      raise exception 'The sender must be up to 11 letters or numbers starting with a letter, or a number like +61412345678' using errcode = '22023';
    end if;
    v_fields := jsonb_build_object('username', btrim(f->>'username'), 'apiKey', btrim(f->>'apiKey'), 'from', nullif(btrim(coalesce(f->>'from', '')), ''));
  elsif c.connector_id = 'whatsapp' then
    if btrim(coalesce(f->>'phoneNumberId', '')) !~ '^[0-9]{5,30}$' then raise exception 'Enter the WhatsApp phone number ID (numbers only, from Meta)' using errcode = '22023'; end if;
    if length(btrim(coalesce(f->>'token', ''))) < 20 or length(f->>'token') > 1000 or btrim(f->>'token') ~ '\s' then raise exception 'Enter the WhatsApp access token' using errcode = '22023'; end if;
    v_fields := jsonb_build_object('phoneNumberId', btrim(f->>'phoneNumberId'), 'token', btrim(f->>'token'), 'displayNumber', left(btrim(coalesce(f->>'displayNumber', '')), 40));
  elsif c.connector_id = 'google_maps' then
    if btrim(coalesce(f->>'apiKey', '')) !~ '^AIza[0-9A-Za-z_-]{30,}$' or length(btrim(f->>'apiKey')) > 200 then
      raise exception 'Enter the Google Maps API key (it starts with AIza)' using errcode = '22023';
    end if;
    v_fields := jsonb_build_object('apiKey', btrim(f->>'apiKey'));
  elsif c.connector_id = 'brave_search' then
    -- OMARA-DISCOVERY: Brave Search API subscription token, checked loosely (20-200 characters, no spaces).
    if btrim(coalesce(f->>'apiKey', '')) !~ '^\S{20,200}$' then
      raise exception 'Enter the Brave Search API key (20 to 200 characters, no spaces)' using errcode = '22023';
    end if;
    v_fields := jsonb_build_object('apiKey', btrim(f->>'apiKey'));
  elsif c.connector_id = 'tavily' then
    -- OMARA-DISCOVERY: Tavily API keys start with "tvly-".
    if btrim(coalesce(f->>'apiKey', '')) !~ '^tvly-\S{8,195}$' then
      raise exception 'Enter the Tavily API key (it starts with tvly-)' using errcode = '22023';
    end if;
    v_fields := jsonb_build_object('apiKey', btrim(f->>'apiKey'));
  else
    if jsonb_typeof(f->'channels') <> 'array' or jsonb_array_length(f->'channels') not between 1 and 20 then
      raise exception 'Add between 1 and 20 Microsoft Teams channels' using errcode = '22023';
    end if;
    for ch in select * from jsonb_array_elements(f->'channels') loop
      v_name := btrim(coalesce(ch->>'name', '')); v_url := btrim(coalesce(ch->>'url', ''));
      if v_name = '' or length(v_name) > 60 then raise exception 'Give every channel a name (up to 60 characters)' using errcode = '22023'; end if;
      if lower(v_name) = any(v_names) then raise exception 'Channel names must be different' using errcode = '22023'; end if;
      if not public.comm_team_microsoft_host_ok(v_url) then raise exception 'The link for "%" is not a Microsoft Teams channel link', v_name using errcode = '22023'; end if;
      v_names := v_names || lower(v_name);
    end loop;
    v_fields := jsonb_build_object('channels', (select jsonb_agg(jsonb_build_object('name', btrim(x->>'name'), 'url', btrim(x->>'url'))) from jsonb_array_elements(f->'channels') x));
  end if;
  perform public.integration_credential_write(c.id, 'api_key', jsonb_build_object('version', 1, 'fields', v_fields)::text);
  update public.integration_connections set status = 'connected', last_success_at = now(), updated_at = now() where id = c.id;
  insert into public.integration_logs(connection_id, connector_id, severity, code, correlation_id) values (c.id, c.connector_id, 'info', 'credential_rotated', gen_random_uuid());
end;
$function$;

create or replace function public.integration_comm_credentials_clear(p_connection uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare c record;
begin
  select id, tenant_id, connector_id into c from public.integration_connections where id = p_connection;
  if not found then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not coalesce(public.integration_can_manage(c.tenant_id), false) or not coalesce(public.integration_module_access(), false) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if c.connector_id not in ('clicksend', 'whatsapp', 'microsoft_teams', 'google_maps', 'brave_search', 'tavily') then raise exception 'This application is set up elsewhere' using errcode = '22023'; end if;
  perform public.integration_credential_write(c.id, 'api_key', '');
  update public.integration_connections set status = case when status = 'disabled' then status else 'not_connected' end, updated_at = now() where id = c.id;
  insert into public.integration_logs(connection_id, connector_id, severity, code, correlation_id) values (c.id, c.connector_id, 'info', 'credentials_revoked', gen_random_uuid());
end;
$function$;

create or replace function public.integration_comm_summary(p_connection uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare c record; v text; f jsonb;
begin
  select id, tenant_id, connector_id into c from public.integration_connections where id = p_connection;
  if not found then return null; end if;
  if not coalesce(public.integration_can_manage(c.tenant_id), false) then raise exception 'Administrator access required' using errcode = '42501'; end if;
  v := public.integration_credential_read(c.id, 'api_key');
  if v is null or v = '' then return jsonb_build_object('saved', false); end if;
  f := (v::jsonb)->'fields';
  return jsonb_build_object('saved', true) || case c.connector_id
    when 'clicksend' then jsonb_build_object('username', left(f->>'username', 2) || '…' || coalesce(substring(f->>'username' from '(@.*)$'), ''), 'from', f->>'from')
    when 'whatsapp' then jsonb_build_object('phoneNumberId', '…' || right(f->>'phoneNumberId', 4), 'displayNumber', nullif(f->>'displayNumber', ''))
    when 'microsoft_teams' then jsonb_build_object('channels', (select jsonb_agg(x->>'name') from jsonb_array_elements(f->'channels') x))
    when 'google_maps' then jsonb_build_object('keyEnd', '…' || right(f->>'apiKey', 4))
    -- OMARA-DISCOVERY search keys: only the last four characters, never the key.
    when 'brave_search' then jsonb_build_object('keyEnd', '…' || right(f->>'apiKey', 4))
    when 'tavily' then jsonb_build_object('keyEnd', '…' || right(f->>'apiKey', 4))
    else '{}'::jsonb end;
end;
$function$;

/** The saved API key of the organization-wide Brave Search or Tavily connection (null when none / disconnected / disabled). Service role only. */
create function public.integration_search_api_key(p_connector text) returns text
language sql stable security definer set search_path = public as $$
  select case when p_connector in ('brave_search', 'tavily')
    then nullif(btrim(coalesce(public.integration_comm_fields(p_connector)->>'apiKey', '')), '') end;
$$;

/** omara-discovery's "Check connection" outcome on the Brave Search / Tavily connection; a success also sets last_success_at. Service role only. */
create function public.integration_search_check_record(p_connector text, p_ok boolean, p_code text) returns void
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_code text := left(lower(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9_]', '_', 'g')), 30);
begin
  if p_connector not in ('brave_search', 'tavily') then return; end if;
  select id into v_id from public.integration_connections where connector_id = p_connector and tenant_id is null limit 1;
  if v_id is null then return; end if;
  if p_ok then update public.integration_connections set last_success_at = now(), updated_at = now() where id = v_id; end if;
  insert into public.integration_logs(connection_id, connector_id, severity, code, correlation_id)
  values (v_id, p_connector, case when p_ok then 'info' else 'warn' end,
    case when p_ok then 'connection_test_succeeded' else 'connection_test_failed' || case when v_code <> '' then '_' || v_code else '' end end, gen_random_uuid());
end;
$$;

revoke all on function public.integration_comm_credentials_save(uuid, jsonb), public.integration_comm_credentials_clear(uuid), public.integration_comm_summary(uuid),
  public.integration_search_api_key(text), public.integration_search_check_record(text, boolean, text),
  public.omara_agent_upsert(jsonb), public.omara_agent_check_failed(text, text, text), public.omara_discovery_run_record(jsonb),
  public.omara_agents_for_agency(uuid), public.omara_link_agents(uuid, text[], jsonb), public.omara_unlink_agent(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.integration_comm_credentials_save(uuid, jsonb), public.integration_comm_credentials_clear(uuid), public.integration_comm_summary(uuid),
  public.omara_agents_for_agency(uuid), public.omara_link_agents(uuid, text[], jsonb), public.omara_unlink_agent(uuid, text) to authenticated;
grant execute on function public.integration_search_api_key(text), public.integration_search_check_record(text, boolean, text),
  public.omara_agent_upsert(jsonb), public.omara_agent_check_failed(text, text, text), public.omara_discovery_run_record(jsonb) to service_role;

-- 5. Edge Function allowlist (browser error reports and the daily health check) --------------------------------------------------

create or replace function public.edge_function_names() returns text[] language sql immutable as $f$
 select array['address-search', 'admin-view-as', 'calendly-admin', 'cms-admin-users', 'cricos-lookup', 'document-signing', 'email-sender', 'guest-documents',
  'holiday-sync', 'intake-groups', 'integrations-admin', 'integrations-credentials', 'integrations-refresh', 'integrations-webhook', 'lms-bulk-worker', 'notification-delivery', 'omara-abr-enrich',
  'omara-discovery', 'omara-ingest', 'payments', 'portal-admin-users', 'portal-application-delete', 'portal-document-delete', 'portal-document-extract', 'portal-invite-activate',
  'portal-self-register', 'public-assistant', 'public-assistant-index', 'staff-admin', 'staff-onboarding', 'staff-register', 'student-application-invite', 'student-office365',
  'student-practice', 'support-ticket-mail', 'tga-course-import', 'usi-service', 'validated-document-upload', 'xero-push']::text[]
$f$;

-- 6. Business Rules (category Agents; nothing hard-coded) ----------------------------------------------------------------------------

select public.business_rule_add_setting('omara.discovery_enabled', 'Find registered migration agents (OMARA)', 'Agents',
  'agency_agents', 'business', 'boolean', 'true'::jsonb, '{}'::jsonb,
  'Yes: Add business looks for the business''s registered migration agents on the public OMARA register (needs a Brave Search or Tavily key in Integrations › Connections; without one staff paste OMARA links). No: the panel offers only pasted links.');
select public.business_rule_add_setting('omara.search_provider', 'Search service for OMARA pages', 'Agents',
  'agency_agents', 'business', 'dropdown', '"Brave"'::jsonb, '{"allowed":["Brave","Tavily"]}'::jsonb,
  'Which web search API finds the public OMARA agent pages. Its key is saved in Integrations › Connections.',
  '["Brave","Tavily"]'::jsonb);
select public.business_rule_add_setting('omara.max_search_queries', 'Searches per business (OMARA)', 'Agents',
  'agency_agents', 'business', 'number', '6'::jsonb, '{"min":1,"max":20}'::jsonb,
  'The most web searches made to find one business''s agents. Each search is paid (see Search cost).');
select public.business_rule_add_setting('omara.max_agent_pages', 'OMARA pages read per business', 'Agents',
  'agency_agents', 'business', 'number', '20'::jsonb, '{"min":1,"max":50}'::jsonb,
  'The most OMARA agent pages read (one request each) for one business, discovered or pasted.');
select public.business_rule_add_setting('omara.request_gap_ms', 'Pause between OMARA requests (ms)', 'Agents',
  'agency_agents', 'business', 'number', '1000'::jsonb, '{"min":500,"max":10000}'::jsonb,
  'Milliseconds between two requests, so the public register is read gently, one page at a time.');
select public.business_rule_add_setting('omara.match_threshold', 'OMARA match shown as likely', 'Agents',
  'agency_agents', 'business', 'number', '60'::jsonb, '{"min":0,"max":100}'::jsonb,
  'Agents scoring at least this (0-100: business name, website and email domain, postcode / state) are marked as likely and pre-ticked; others are listed unticked.');
select public.business_rule_add_setting('omara.reverify_days', 'Re-read an OMARA record after (days)', 'Agents',
  'agency_agents', 'business', 'number', '30'::jsonb, '{"min":0,"max":365}'::jsonb,
  'An agent read from the register more recently than this is not fetched again by a discovery (Re-verify always fetches). 0 = never fetch again automatically.');
select public.business_rule_add_setting('omara.allowed_domains', 'OMARA register addresses allowed', 'Agents',
  'agency_agents', 'business', 'list', '["portal.mara.gov.au"]'::jsonb, '{}'::jsonb,
  'Only agent pages on these hosts are read (government .gov.au hosts only).');
select public.business_rule_add_setting('omara.search_cost_usd', 'Search cost per query (US$)', 'Agents',
  'agency_agents', 'business', 'number', '0.005'::jsonb, '{"min":0,"max":1}'::jsonb,
  'The estimated price of one web search, used to record the cost of each discovery.');

commit;
