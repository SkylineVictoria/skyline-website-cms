-- P07-03: delivery recovery, sender ownership, owner activation gate and administrator visibility.
-- Recovery: notification_recover_stuck() turns every expired 'sending' lease into 'unknown' (the worker runs it first). An
-- 'unknown' delivery may or may not have reached the provider and Postmark has no idempotency key, so it is never resent
-- automatically; an institution administrator reviews it (tenant_notification_resolve): "retry" accepts the duplicate risk
-- and requeues it, "abandon" closes it. Every decision is audited with actor, tenant, delivery and reason.
-- Sender ownership: an institution's configured sender is used only if its address is explicitly approved for that
-- institution by a platform administrator, or its domain equals one of the institution's verified hostnames. Otherwise the
-- delivery falls back to the platform sender (or fails 'sender_unconfigured'). The check is made when the delivery is created
-- and again when it is claimed.
-- Activation gate (owner review before going live): no delivery is claimed for an institution (or the legacy, tenant-less
-- scope) until a platform administrator records an activation with a note; deactivating stops sending and keeps every
-- delivery queued. This is in addition to the EF_NOTIFICATION_EMAIL_ENABLED switch of the Edge Function.
-- Visibility: tenant_notification_overview gives administrators counts, the deliveries needing review and the latest
-- deliveries with masked recipient addresses; no message body is returned.
--
-- Rollback / compensation (additive; run manually):
--   drop function if exists public.notification_recover_stuck(), public.notification_set_activation(uuid, boolean, text), public.tenant_set_notification_sender(uuid, text, boolean, text),
--     public.tenant_notification_overview(uuid), public.tenant_notification_resolve(uuid, uuid, text, text), public.notification_sender_allowed(uuid, text), public.notification_mask_email(text);
--   drop table if exists public.notification_activation, public.tenant_notification_senders;
--   re-create public.notification_claim_delivery from 20261026190000 and public.notification_enqueue_deliveries from 20261026180000.
-- Never applied to the hosted project without release approval.
begin;

create table public.notification_activation(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),
  note text not null check (length(trim(note)) > 0),
  approved_by uuid,
  approved_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid
);
create unique index notification_activation_active on public.notification_activation((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))) where revoked_at is null;
alter table public.notification_activation enable row level security;
revoke all on public.notification_activation from public, anon, authenticated, service_role;
grant select on public.notification_activation to service_role;

create table public.tenant_notification_senders(
  tenant_id uuid not null references public.tenants(id),
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  approved_by uuid,
  approved_at timestamptz not null default now(),
  revoked_at timestamptz,
  note text,
  primary key (tenant_id, email)
);
alter table public.tenant_notification_senders enable row level security;
revoke all on public.tenant_notification_senders from public, anon, authenticated, service_role;
grant select on public.tenant_notification_senders to authenticated, service_role;
create policy tenant_notification_senders_read on public.tenant_notification_senders for select to authenticated
  using (public.tenant_has_role(tenant_id, array['tenant_admin']));

create function public.notification_mask_email(p_email text) returns text language sql immutable set search_path = public as $$
  select left(split_part(p_email, '@', 1), 1) || '***@' || split_part(p_email, '@', 2);
$$;

create function public.notification_sender_allowed(p_tenant uuid, p_email text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_tenant is not null and p_email is not null and (
    exists (select 1 from public.tenant_notification_senders s where s.tenant_id = p_tenant and s.email = lower(trim(p_email)) and s.revoked_at is null)
    or exists (select 1 from public.tenant_domains d where d.tenant_id = p_tenant and d.verified_at is not null and d.hostname = split_part(lower(trim(p_email)), '@', 2)));
$$;

create or replace function public.notification_enqueue_deliveries() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a public.enrollment_applications; v_id uuid; v_cfg jsonb; v_defaults jsonb := public.tenant_config_defaults('notifications');
  v_tpl jsonb; v_vars jsonb; v_enabled boolean; v_pref boolean; v_sender jsonb; r record;
begin
  if new.event not in ('application_submitted', 'application_status_changed') then return new; end if;
  select * into a from public.enrollment_applications where id = new.application_id;
  select id, config into v_id, v_cfg from public.tenant_config_versions where tenant_id = new.tenant_id and kind = 'notifications' and state = 'published';
  v_enabled := coalesce((v_cfg->'defaults'->>new.event)::boolean, (v_defaults->'defaults'->>new.event)::boolean, true);
  if not v_enabled then return new; end if;
  v_tpl := coalesce(v_cfg->'templates'->new.event, v_defaults->'templates'->new.event);
  v_sender := case when v_cfg->'sender' is not null and public.notification_sender_allowed(new.tenant_id, v_cfg->'sender'->>'email') then v_cfg->'sender' else null end;
  v_vars := jsonb_build_object(
    'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)),
    'status', replace(coalesce(new.payload->>'to', a.status), '_', ' '),
    'previousStatus', replace(coalesce(new.payload->>'from', case when new.event = 'application_submitted' then 'draft' else '' end), '_', ' '),
    'institution', coalesce((select name from public.tenants where id = new.tenant_id), 'Skyline'));
  for r in
    select p.auth_user_id, lower(trim(p.email)) as email from public.portal_profiles p
    where p.status = 'Active' and p.auth_user_id is not null and nullif(trim(p.email), '') is not null
      and (p.id = a.assigned_agent_id or exists (select 1 from public.agency_memberships m where m.user_id = p.id and m.agency_id = a.agency_id and m.status = 'Active' and m.role = 'agency_admin'))
  loop
    v_pref := coalesce((select email_enabled from public.notification_preferences where auth_user_id = r.auth_user_id and event = new.event), true);
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason)
    values (new.id, new.tenant_id, new.application_id, r.auth_user_id, r.email, new.event, case when v_cfg is null then 'default' else 'published' end, v_id, v_sender,
      public.notification_render(v_tpl->>'subject', v_vars), public.notification_render(v_tpl->>'body', v_vars),
      case when v_pref then 'pending' else 'suppressed' end, case when v_pref then null else 'recipient_opted_out' end)
    on conflict (outbox_id, recipient_user) do nothing;
  end loop;
  return new;
end;
$$;

create function public.notification_recover_stuck() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.notification_deliveries set state = 'unknown', last_error_code = 'lease_expired', lease_token = null, lease_expires_at = null, updated_at = now()
  where state = 'sending' and lease_expires_at < clock_timestamp();
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.notification_claim_delivery() returns setof public.notification_deliveries
language plpgsql security definer set search_path = public as $$
declare d public.notification_deliveries;
begin
  perform public.notification_recover_stuck();
  select * into d from public.notification_deliveries x
  where x.state = 'pending' and x.next_attempt_at <= now()
    and (x.tenant_id is null or exists (select 1 from public.tenants t where t.id = x.tenant_id and t.status = 'active'))
    and exists (select 1 from public.notification_activation a where a.revoked_at is null and a.tenant_id is not distinct from x.tenant_id)
  order by x.seq for update skip locked limit 1;
  if not found then return; end if;
  if exists (select 1 from public.notification_preferences p where p.auth_user_id = d.recipient_user and p.event = d.event and not p.email_enabled) then
    update public.notification_deliveries set state = 'suppressed', state_reason = 'recipient_opted_out', updated_at = now() where id = d.id;
    return;
  end if;
  update public.notification_deliveries set state = 'sending', attempt_count = attempt_count + 1, lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + interval '3 minutes', updated_at = now(),
    sender = case when d.sender is not null and public.notification_sender_allowed(d.tenant_id, d.sender->>'email') then d.sender else null end
  where id = d.id returning * into d;
  return next d;
end;
$$;

create function public.notification_set_activation(p_tenant uuid, p_active boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.tenant_is_platform_admin() then raise exception 'Platform authorization required' using errcode = '42501'; end if;
  if nullif(trim(coalesce(p_note, '')), '') is null then raise exception 'A note is required' using errcode = '22023'; end if;
  if p_tenant is not null and not exists (select 1 from public.tenants where id = p_tenant) then raise exception 'Institution not found' using errcode = 'P0002'; end if;
  if coalesce(p_active, false) then
    insert into public.notification_activation(tenant_id, note, approved_by) values (p_tenant, left(trim(p_note), 300), auth.uid()) on conflict do nothing;
  else
    update public.notification_activation set revoked_at = now(), revoked_by = auth.uid() where revoked_at is null and tenant_id is not distinct from p_tenant;
  end if;
  insert into public.tenant_access_audit(tenant_id, actor, action, details)
  values (p_tenant, auth.uid(), case when coalesce(p_active, false) then 'notification_activate' else 'notification_deactivate' end, jsonb_build_object('note', left(trim(p_note), 300)));
end;
$$;

create function public.tenant_set_notification_sender(p_tenant uuid, p_email text, p_approved boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(coalesce(p_email, '')));
begin
  if not public.tenant_is_platform_admin() then raise exception 'Platform authorization required' using errcode = '42501'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then raise exception 'Enter a valid email address' using errcode = '22023'; end if;
  if nullif(trim(coalesce(p_note, '')), '') is null then raise exception 'A note is required' using errcode = '22023'; end if;
  if not exists (select 1 from public.tenants where id = p_tenant) then raise exception 'Institution not found' using errcode = 'P0002'; end if;
  if coalesce(p_approved, false) then
    insert into public.tenant_notification_senders(tenant_id, email, approved_by, note) values (p_tenant, v_email, auth.uid(), left(trim(p_note), 300))
    on conflict (tenant_id, email) do update set revoked_at = null, approved_by = auth.uid(), approved_at = now(), note = excluded.note;
  else
    update public.tenant_notification_senders set revoked_at = now() where tenant_id = p_tenant and email = v_email and revoked_at is null;
  end if;
  insert into public.tenant_access_audit(tenant_id, actor, action, details)
  values (p_tenant, auth.uid(), case when coalesce(p_approved, false) then 'sender_approve' else 'sender_revoke' end, jsonb_build_object('email', v_email, 'note', left(trim(p_note), 300)));
end;
$$;

create function public.tenant_notification_overview(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_cfg jsonb; v_email text;
begin
  if not public.tenant_has_role(p_tenant, array['tenant_admin']) then raise exception 'Tenant administration required' using errcode = '42501'; end if;
  select config into v_cfg from public.tenant_config_versions where tenant_id = p_tenant and kind = 'notifications' and state = 'published';
  v_email := v_cfg->'sender'->>'email';
  return jsonb_build_object(
    'activated', exists (select 1 from public.notification_activation where tenant_id = p_tenant and revoked_at is null),
    'isPlatformAdmin', public.tenant_is_platform_admin(),
    'sender', jsonb_build_object('configured', v_email, 'allowed', public.notification_sender_allowed(p_tenant, v_email),
      'approved', coalesce((select jsonb_agg(s.email order by s.email) from public.tenant_notification_senders s where s.tenant_id = p_tenant and s.revoked_at is null), '[]'::jsonb)),
    'counts', coalesce((select jsonb_object_agg(state, n) from (select state, count(*) as n from public.notification_deliveries where tenant_id = p_tenant and created_at > now() - interval '30 days' group by state) c), '{}'::jsonb),
    'review', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'event', x.event, 'recipient', public.notification_mask_email(x.recipient_email), 'attempts', x.attempt_count, 'errorCode', x.last_error_code, 'at', x.updated_at) order by x.seq)
      from (select * from public.notification_deliveries where tenant_id = p_tenant and state = 'unknown' order by seq limit 50) x), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'event', x.event, 'recipient', public.notification_mask_email(x.recipient_email), 'state', x.state, 'attempts', x.attempt_count, 'errorCode', x.last_error_code, 'at', x.created_at) order by x.seq desc)
      from (select * from public.notification_deliveries where tenant_id = p_tenant order by seq desc limit 50) x), '[]'::jsonb));
end;
$$;

create function public.tenant_notification_resolve(p_tenant uuid, p_delivery uuid, p_action text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.notification_deliveries;
begin
  if not public.tenant_has_role(p_tenant, array['tenant_admin']) then raise exception 'Tenant administration required' using errcode = '42501'; end if;
  if p_action is null or p_action not in ('retry', 'abandon') then raise exception 'Unknown action' using errcode = '22023'; end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'A reason is required' using errcode = '22023'; end if;
  select * into d from public.notification_deliveries where id = p_delivery and tenant_id = p_tenant for update;
  if not found then raise exception 'Delivery not found' using errcode = 'P0002'; end if;
  if d.state <> 'unknown' then raise exception 'Only an unknown outcome needs review' using errcode = '22023'; end if;
  if p_action = 'retry' then
    update public.notification_deliveries set state = 'pending', next_attempt_at = now(), last_error_code = 'review_retry', updated_at = now() where id = d.id;
  else
    update public.notification_deliveries set state = 'failed', last_error_code = 'abandoned', updated_at = now() where id = d.id;
  end if;
  insert into public.tenant_access_audit(tenant_id, actor, action, target, details)
  values (p_tenant, auth.uid(), 'notification_' || p_action, d.recipient_user, jsonb_build_object('delivery', d.id, 'reason', left(trim(p_reason), 300), 'duplicateRiskAccepted', p_action = 'retry'));
end;
$$;

revoke all on function public.notification_mask_email(text), public.notification_sender_allowed(uuid, text), public.notification_recover_stuck(),
  public.notification_set_activation(uuid, boolean, text), public.tenant_set_notification_sender(uuid, text, boolean, text),
  public.tenant_notification_overview(uuid), public.tenant_notification_resolve(uuid, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.notification_recover_stuck() to service_role;
grant execute on function public.notification_set_activation(uuid, boolean, text), public.tenant_set_notification_sender(uuid, text, boolean, text),
  public.tenant_notification_overview(uuid), public.tenant_notification_resolve(uuid, uuid, text, text) to authenticated;

commit;
