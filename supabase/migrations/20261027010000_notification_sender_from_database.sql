-- Migration 87: notification sender identity comes from the database; no platform sender in Edge secrets.
-- Reuses notification_deliveries.sender, the published 'notifications' config sender and tenant_notification_senders (migration 80/82).
-- Adds a per-organization verified-domain list and an optional per-organization override (name / address / reply-to), and resolves
-- the sender at claim time. Order: override > published config sender > organization name (tenants.name) > legacy default
-- (it@slit.edu.au, "Skyline Institute of Technology", legacy scope only). An address is used only if it is approved for THAT scope
-- (approved address, verified tenant domain, or verified sender domain); otherwise the claimed delivery carries no sender and the worker
-- fails it with sender_unconfigured. There is never a fallback to another organization's sender.
-- Migration 84 behaviour (activation gate, no retroactive delivery, suppression, opt-out) is reproduced unchanged in notification_claim_delivery.
-- The legacy domain row below is a seeded default: confirm slit.edu.au (or it@slit.edu.au) is verified in Postmark before sending is activated.
-- Rollback (manual): re-create notification_claim_delivery and notification_sender_allowed as in 20261026240000 / 20261026200000, then
--   drop function public.notification_resolve_sender(uuid), public.notification_save_sender(uuid, text, text, text),
--   public.notification_set_sender_domain(uuid, text, boolean, text), public.notification_sender_state(uuid), public.notification_sender_admin(uuid),
--   public.notification_domain_admin(uuid); drop table public.notification_sender_settings, public.notification_sender_domains.
begin;

create table public.notification_sender_domains(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),
  domain text not null check (domain = lower(domain) and domain ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$' and length(domain) <= 253),
  note text,
  verified_by uuid,
  verified_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index notification_sender_domains_active on public.notification_sender_domains((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), domain) where revoked_at is null;

create table public.notification_sender_settings(
  tenant_id uuid references public.tenants(id),
  from_email text not null check (from_email = lower(from_email) and length(from_email) <= 254 and from_email ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$'),
  from_name text check (from_name is null or (length(from_name) between 1 and 100 and from_name !~ '[<>"\r\n]')),
  reply_to text check (reply_to is null or (length(reply_to) <= 254 and reply_to ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$')),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create unique index notification_sender_settings_scope on public.notification_sender_settings((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)));

-- Legacy scope (tenant_id null) is administered by SLIT (CMS) administrators; an organization by its tenant administrators / platform admins.
create function public.notification_sender_admin(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case when p_tenant is null then public.cms_is_admin()
    else public.tenant_is_platform_admin() or public.tenant_has_role(p_tenant, array['tenant_admin']) end;
$$;
-- Declaring a domain verified is narrower than editing the display sender: platform / SLIT administrators only.
create function public.notification_domain_admin(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case when p_tenant is null then public.cms_is_admin() else public.tenant_is_platform_admin() end;
$$;

alter table public.notification_sender_domains enable row level security;
alter table public.notification_sender_settings enable row level security;
revoke all on public.notification_sender_domains, public.notification_sender_settings from public, anon, authenticated, service_role;
grant select on public.notification_sender_domains, public.notification_sender_settings to authenticated, service_role;
create policy notification_sender_domains_read on public.notification_sender_domains for select to authenticated using (public.notification_sender_admin(tenant_id));
create policy notification_sender_settings_read on public.notification_sender_settings for select to authenticated using (public.notification_sender_admin(tenant_id));

insert into public.notification_sender_domains(tenant_id, domain, note) values (null, 'slit.edu.au', 'Seeded legacy default; confirm the sender is verified in Postmark');

-- An address is usable for a scope only if approved for that scope. Replaces migration 80's version (same signature) by adding the
-- per-scope verified-domain list, which is also what makes the legacy scope (tenant null) usable.
create or replace function public.notification_sender_allowed(p_tenant uuid, p_email text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_email is not null and (
    (p_tenant is not null and exists (select 1 from public.tenant_notification_senders s where s.tenant_id = p_tenant and s.email = lower(trim(p_email)) and s.revoked_at is null))
    or (p_tenant is not null and exists (select 1 from public.tenant_domains d where d.tenant_id = p_tenant and d.verified_at is not null and d.hostname = split_part(lower(trim(p_email)), '@', 2)))
    or exists (select 1 from public.notification_sender_domains v where v.tenant_id is not distinct from p_tenant and v.revoked_at is null and v.domain = split_part(lower(trim(p_email)), '@', 2)));
$$;

create function public.notification_resolve_sender(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.notification_sender_settings; v_cfg jsonb; v_email text; v_name text;
begin
  select * into s from public.notification_sender_settings x where x.tenant_id is not distinct from p_tenant;
  if p_tenant is not null then
    select c.config into v_cfg from public.tenant_config_versions c where c.tenant_id = p_tenant and c.kind = 'notifications' and c.state = 'published';
  end if;
  v_email := lower(trim(coalesce(s.from_email, v_cfg->'sender'->>'email', case when p_tenant is null then 'it@slit.edu.au' end)));
  v_name := nullif(trim(coalesce(s.from_name, v_cfg->'sender'->>'name', (select t.name from public.tenants t where t.id = p_tenant),
    case when p_tenant is null then 'Skyline Institute of Technology' end)), '');
  if v_email is null or v_name is null or not public.notification_sender_allowed(p_tenant, v_email) then return null; end if;
  return jsonb_strip_nulls(jsonb_build_object('name', left(trim(regexp_replace(v_name, '[<>"\r\n]', ' ', 'g')), 100), 'email', v_email, 'replyTo', s.reply_to));
end;
$$;

-- Sender resolved at claim time from the delivery's own scope. Everything else is migration 84's definition, unchanged.
create or replace function public.notification_claim_delivery() returns setof public.notification_deliveries
language plpgsql security definer set search_path = public as $$
declare d public.notification_deliveries;
begin
  perform public.notification_recover_stuck();
  select * into d from public.notification_deliveries x
  where x.state = 'pending' and x.next_attempt_at <= now()
    and (x.tenant_id is null or exists (select 1 from public.tenants t where t.id = x.tenant_id and t.status = 'active'))
    and exists (select 1 from public.notification_activation a where a.revoked_at is null and a.tenant_id is not distinct from x.tenant_id and x.created_at >= a.approved_at)
  order by x.seq for update skip locked limit 1;
  if not found then return; end if;
  if exists (select 1 from public.notification_preferences p where p.auth_user_id = d.recipient_user and p.event = d.event and not p.email_enabled) then
    update public.notification_deliveries set state = 'suppressed', state_reason = 'recipient_opted_out', updated_at = now() where id = d.id;
    return;
  end if;
  update public.notification_deliveries set state = 'sending', attempt_count = attempt_count + 1, lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + interval '3 minutes', updated_at = now(),
    sender = public.notification_resolve_sender(d.tenant_id)
  where id = d.id returning * into d;
  return next d;
end;
$$;

create function public.notification_save_sender(p_tenant uuid, p_email text, p_name text, p_reply_to text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(coalesce(p_email, ''))); v_name text := nullif(trim(coalesce(p_name, '')), ''); v_reply text := nullif(lower(trim(coalesce(p_reply_to, ''))), '');
begin
  if auth.uid() is null or not public.notification_sender_admin(p_tenant) then raise exception 'Organization administrator access required' using errcode = '42501'; end if;
  if p_tenant is not null and not exists (select 1 from public.tenants where id = p_tenant) then raise exception 'Organization not found' using errcode = 'P0002'; end if;
  if v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' or length(v_email) > 254 then raise exception 'Enter a valid sender email address' using errcode = '22023'; end if;
  if v_name is not null and (length(v_name) > 100 or v_name ~ '[<>"\r\n]') then raise exception 'The sender name must be 1-100 characters without quotes or angle brackets' using errcode = '22023'; end if;
  if v_reply is not null and (v_reply !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' or length(v_reply) > 254) then raise exception 'Enter a valid reply-to address' using errcode = '22023'; end if;
  if not public.notification_sender_allowed(p_tenant, v_email) then
    raise exception 'This address is not verified for this organization. An administrator must verify its domain (and verify it in Postmark) first' using errcode = '22023'; end if;
  insert into public.notification_sender_settings(tenant_id, from_email, from_name, reply_to, updated_by) values (p_tenant, v_email, v_name, v_reply, auth.uid())
  on conflict ((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))) do update
    set from_email = excluded.from_email, from_name = excluded.from_name, reply_to = excluded.reply_to, updated_by = excluded.updated_by, updated_at = now();
  insert into public.tenant_access_audit(tenant_id, actor, action, details) values (p_tenant, auth.uid(), 'sender_settings', jsonb_build_object('email', v_email, 'name', v_name, 'replyTo', v_reply));
  return public.notification_resolve_sender(p_tenant);
end;
$$;

create function public.notification_set_sender_domain(p_tenant uuid, p_domain text, p_verified boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare v_domain text := lower(trim(coalesce(p_domain, '')));
begin
  if auth.uid() is null or not public.notification_domain_admin(p_tenant) then raise exception 'Platform administrator access required' using errcode = '42501'; end if;
  if v_domain !~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$' or length(v_domain) > 253 then raise exception 'Enter a valid domain such as example.edu.au' using errcode = '22023'; end if;
  if p_tenant is not null and not exists (select 1 from public.tenants where id = p_tenant) then raise exception 'Organization not found' using errcode = 'P0002'; end if;
  if coalesce(p_verified, false) then
    if nullif(trim(coalesce(p_note, '')), '') is null then raise exception 'A note is required' using errcode = '22023'; end if;
    insert into public.notification_sender_domains(tenant_id, domain, note, verified_by) values (p_tenant, v_domain, left(trim(p_note), 300), auth.uid()) on conflict do nothing;
  else
    update public.notification_sender_domains set revoked_at = now() where tenant_id is not distinct from p_tenant and domain = v_domain and revoked_at is null;
  end if;
  insert into public.tenant_access_audit(tenant_id, actor, action, details)
  values (p_tenant, auth.uid(), case when coalesce(p_verified, false) then 'sender_domain_verify' else 'sender_domain_revoke' end, jsonb_build_object('domain', v_domain));
end;
$$;

create function public.notification_sender_state(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.notification_sender_settings;
begin
  if auth.uid() is null or not public.notification_sender_admin(p_tenant) then raise exception 'Organization administrator access required' using errcode = '42501'; end if;
  select * into s from public.notification_sender_settings x where x.tenant_id is not distinct from p_tenant;
  return jsonb_build_object('resolved', public.notification_resolve_sender(p_tenant),
    'override', case when s.from_email is null then null else jsonb_build_object('email', s.from_email, 'name', s.from_name, 'replyTo', s.reply_to) end,
    'domains', coalesce((select jsonb_agg(v.domain order by v.domain) from public.notification_sender_domains v where v.tenant_id is not distinct from p_tenant and v.revoked_at is null), '[]'::jsonb),
    'canVerifyDomains', public.notification_domain_admin(p_tenant));
end;
$$;

revoke all on function public.notification_sender_admin(uuid), public.notification_domain_admin(uuid), public.notification_resolve_sender(uuid),
  public.notification_save_sender(uuid, text, text, text), public.notification_set_sender_domain(uuid, text, boolean, text), public.notification_sender_state(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.notification_sender_admin(uuid), public.notification_domain_admin(uuid) to authenticated;
grant execute on function public.notification_save_sender(uuid, text, text, text), public.notification_set_sender_domain(uuid, text, boolean, text), public.notification_sender_state(uuid) to authenticated;
grant execute on function public.notification_resolve_sender(uuid), public.notification_sender_allowed(uuid, text) to service_role; -- read-only; the worker runs as service_role
-- notification_claim_delivery and notification_sender_allowed keep their existing grants (create or replace preserves them); the resolver is internal.
commit;
