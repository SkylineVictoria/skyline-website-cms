-- Release fix: a notification must never be sent retroactively.
-- (a) A delivery is created as 'suppressed' (reason legacy_scope_not_activated) unless an activation is in force for its scope when the
--     event happens: applications without a tenant (the legacy scope) and institutions that have not been approved by a platform
--     administrator never accumulate pending deliveries that could be sent later.
-- (b) Activation is a point in time. Activating a scope suppresses every delivery of that scope that is still pending and was created
--     before the activation (reason created_before_activation), and the claim only considers deliveries created at or after the
--     activation it relies on, so a pause followed by a resume, or an old backlog, can never be released. Deliveries that are 'sending',
--     'sent' or 'unknown' are not touched. created_at of a delivery now uses the statement clock so ordering against activation is exact.
-- Rows that exist before this migration are not rewritten; any that are still pending in a scope are suppressed when that scope is
-- activated.
--
-- Rollback / compensation (additive; run manually): re-create public.notification_enqueue_deliveries, public.notification_claim_delivery and
-- public.notification_set_activation as in 20261026200000. Suppressed rows keep their reason and are never deleted.
-- Never applied to the hosted project without release approval.
begin;

create or replace function public.notification_enqueue_deliveries() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a public.enrollment_applications; v_id uuid; v_cfg jsonb; v_defaults jsonb := public.tenant_config_defaults('notifications');
  v_tpl jsonb; v_vars jsonb; v_enabled boolean; v_pref boolean; v_sender jsonb; r record; v_active boolean;
begin
  if new.event not in ('application_submitted', 'application_status_changed') then return new; end if;
  select * into a from public.enrollment_applications where id = new.application_id;
  select id, config into v_id, v_cfg from public.tenant_config_versions where tenant_id = new.tenant_id and kind = 'notifications' and state = 'published';
  v_enabled := coalesce((v_cfg->'defaults'->>new.event)::boolean, (v_defaults->'defaults'->>new.event)::boolean, true);
  if not v_enabled then return new; end if;
  v_tpl := coalesce(v_cfg->'templates'->new.event, v_defaults->'templates'->new.event);
  v_sender := case when v_cfg->'sender' is not null and public.notification_sender_allowed(new.tenant_id, v_cfg->'sender'->>'email') then v_cfg->'sender' else null end;
  v_active := exists (select 1 from public.notification_activation act where act.revoked_at is null and act.tenant_id is not distinct from new.tenant_id);
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
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (new.id, new.tenant_id, new.application_id, r.auth_user_id, r.email, new.event, case when v_cfg is null then 'default' else 'published' end, v_id, v_sender,
      public.notification_render(v_tpl->>'subject', v_vars), public.notification_render(v_tpl->>'body', v_vars),
      case when v_active and v_pref then 'pending' else 'suppressed' end,
      case when not v_active then 'legacy_scope_not_activated' when v_pref then null else 'recipient_opted_out' end, clock_timestamp())
    on conflict (outbox_id, recipient_user) do nothing;
  end loop;
  return new;
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
    and exists (select 1 from public.notification_activation a where a.revoked_at is null and a.tenant_id is not distinct from x.tenant_id and x.created_at >= a.approved_at)
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

create or replace function public.notification_set_activation(p_tenant uuid, p_active boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare v_at timestamptz;
begin
  if not public.tenant_is_platform_admin() then raise exception 'Platform authorization required' using errcode = '42501'; end if;
  if nullif(trim(coalesce(p_note, '')), '') is null then raise exception 'A note is required' using errcode = '22023'; end if;
  if p_tenant is not null and not exists (select 1 from public.tenants where id = p_tenant) then raise exception 'Institution not found' using errcode = 'P0002'; end if;
  if coalesce(p_active, false) then
    insert into public.notification_activation(tenant_id, note, approved_by, approved_at) values (p_tenant, left(trim(p_note), 300), auth.uid(), clock_timestamp())
    on conflict do nothing returning approved_at into v_at;
    if v_at is not null then
      update public.notification_deliveries set state = 'suppressed', state_reason = 'created_before_activation', updated_at = now()
      where state = 'pending' and tenant_id is not distinct from p_tenant and created_at < v_at;
    end if;
  else
    update public.notification_activation set revoked_at = now(), revoked_by = auth.uid() where revoked_at is null and tenant_id is not distinct from p_tenant;
  end if;
  insert into public.tenant_access_audit(tenant_id, actor, action, details)
  values (p_tenant, auth.uid(), case when coalesce(p_active, false) then 'notification_activate' else 'notification_deactivate' end, jsonb_build_object('note', left(trim(p_note), 300)));
end;
$$;

commit;
