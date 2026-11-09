-- Calendly on the Contact page, managed from the CMS (Global > Contact Information): the scheduling link lives on
-- cms_settings (served to the public site like phone and email); the Calendly API token lives in a separate
-- cms_integration_secrets table that only the service role and the definer functions below can read, so it is never
-- part of the public settings snapshot. The calendly-admin Edge Function uses the token to check the connection and
-- list the account's event types; the browser only ever learns whether a token is saved and its last 4 characters.
-- Rollback (manual): drop function public.cms_integration_secret_set(text, uuid, text), public.cms_integration_status(text, uuid),
-- public.cms_integration_can_manage(uuid); drop table public.cms_integration_secrets; alter table public.cms_settings drop column calendly_url.
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table public.cms_settings add column if not exists calendly_url text not null default ''
 constraint cms_settings_calendly_url_check check (calendly_url = '' or calendly_url ~ '^https://calendly\.com/[A-Za-z0-9][A-Za-z0-9_.-]*(/[A-Za-z0-9_.-]+)*/?$');

create table if not exists public.cms_integration_secrets (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete cascade,
 provider text not null check (provider in ('calendly')),
 secret text not null,
 updated_at timestamptz not null default now(),
 updated_by uuid
);
create unique index if not exists cms_integration_secrets_one_per_site
 on public.cms_integration_secrets(provider, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table public.cms_integration_secrets enable row level security;
revoke all on public.cms_integration_secrets from public, anon, authenticated;

-- The Skyline site (tenant null) is managed by CMS Admins; a tenant site by its tenant admins.
create or replace function public.cms_integration_can_manage(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
 select case when p_tenant is null then public.cms_is_admin() else public.tenant_has_role(p_tenant, array['tenant_admin']) end;
$$;
revoke all on function public.cms_integration_can_manage(uuid) from public, anon;
grant execute on function public.cms_integration_can_manage(uuid) to authenticated;

create or replace function public.cms_integration_status(p_provider text, p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public as $$
 select case when not public.cms_integration_can_manage(p_tenant) then jsonb_build_object('configured', false, 'updatedAt', null, 'hint', '')
  else coalesce(
   (select jsonb_build_object('configured', true, 'updatedAt', s.updated_at, 'hint', right(s.secret, 4))
     from public.cms_integration_secrets s where s.provider = p_provider and s.tenant_id is not distinct from p_tenant),
   jsonb_build_object('configured', false, 'updatedAt', null, 'hint', '')) end;
$$;
revoke all on function public.cms_integration_status(text, uuid) from public, anon;
grant execute on function public.cms_integration_status(text, uuid) to authenticated;

-- Saves (or, with an empty value, removes) the token. The value is never returned.
create or replace function public.cms_integration_secret_set(p_provider text, p_tenant uuid, p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v text := btrim(coalesce(p_secret, ''));
begin
 if p_provider is distinct from 'calendly' then raise exception 'Unknown integration' using errcode = '22023'; end if;
 if not public.cms_integration_can_manage(p_tenant) then raise exception 'Administrator access required' using errcode = '42501'; end if;
 if v = '' then
  delete from public.cms_integration_secrets where provider = p_provider and tenant_id is not distinct from p_tenant;
  return public.cms_integration_status(p_provider, p_tenant);
 end if;
 if char_length(v) < 20 or char_length(v) > 4000 or v !~ '^[A-Za-z0-9._-]+$' then
  raise exception 'That does not look like a Calendly personal access token. Copy it from Calendly > Integrations > API & webhooks.' using errcode = '22023';
 end if;
 insert into public.cms_integration_secrets(tenant_id, provider, secret, updated_by) values (p_tenant, p_provider, v, auth.uid())
 on conflict (provider, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))
 do update set secret = excluded.secret, updated_at = now(), updated_by = excluded.updated_by;
 return public.cms_integration_status(p_provider, p_tenant);
end $$;
revoke all on function public.cms_integration_secret_set(text, uuid, text) from public, anon;
grant execute on function public.cms_integration_secret_set(text, uuid, text) to authenticated;
