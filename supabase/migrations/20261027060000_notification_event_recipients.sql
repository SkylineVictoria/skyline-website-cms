-- Migration 92 (P08-05): admin-managed notification recipients and events. Additive; local only until released.
-- Events: application_submitted, application_status_changed (other status moves), offer_accepted, coe_voe_issued. portal_set_application_status now names the event
-- after the target status (offer_accepted -> offer_accepted, coe_issued -> coe_voe_issued). Per-event settings: internal recipient emails (max 10), and toggles for
-- the assigned agent, the agency admins and the student. Tenants keep them in the published 'notifications' configuration (key "events", versioned and audited by the
-- existing draft / publish commands); the legacy Skyline scope, which has no configuration row, keeps them in notification_legacy_event_settings.
-- Defaults keep today's behaviour (submitted / other status changes: agent + agency admins) and add offer_accepted -> agent, coe_voe_issued -> agent + student.
-- Deliveries now support recipients that are not portal users (recipient_user null: internal addresses and the student); the migration 84 activation / suppression
-- rules, opt-outs and sender rules apply unchanged. A person already receiving a copy for the same event is never emailed twice.
-- Rollback (manual): re-create tenant_config_validate / tenant_config_defaults / portal_set_application_status / portal_set_notification_preference / notification_enqueue_deliveries
-- from migrations 80 / 91 / 79 / 80 / 91, restore the preference check, then drop the functions and table added here. Non-user delivery rows must be removed first.
begin;

alter table public.notification_deliveries alter column recipient_user drop not null;
create unique index notification_deliveries_outbox_email on public.notification_deliveries(outbox_id, lower(recipient_email)) where recipient_user is null;
alter table public.notification_preferences drop constraint notification_preferences_event_check;
alter table public.notification_preferences add constraint notification_preferences_event_check check (event in ('application_submitted', 'application_status_changed', 'offer_accepted', 'coe_voe_issued'));

create table public.notification_legacy_event_settings(
  event text primary key check (event in ('application_submitted', 'application_status_changed', 'offer_accepted', 'coe_voe_issued')),
  settings jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.notification_legacy_event_settings enable row level security;
revoke all on public.notification_legacy_event_settings from public, anon, authenticated, service_role;
grant select on public.notification_legacy_event_settings to service_role;

create function public.notification_default_event_settings(p_event text) returns jsonb language sql immutable set search_path = public as $$
  select case p_event
    when 'application_submitted' then '{"recipients":[],"notifyAgent":true,"notifyAgencyAdmins":true,"notifyStudent":false}'::jsonb
    when 'application_status_changed' then '{"recipients":[],"notifyAgent":true,"notifyAgencyAdmins":true,"notifyStudent":false}'::jsonb
    when 'offer_accepted' then '{"recipients":[],"notifyAgent":true,"notifyAgencyAdmins":false,"notifyStudent":false}'::jsonb
    when 'coe_voe_issued' then '{"recipients":[],"notifyAgent":true,"notifyAgencyAdmins":false,"notifyStudent":true}'::jsonb
  end;
$$;

create function public.notification_event_check(p_settings jsonb) returns void language plpgsql immutable set search_path = public as $$
declare k text; e jsonb; seen text[] := '{}'; addr text;
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then raise exception 'Event settings must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_settings) loop
    if k not in ('recipients', 'notifyAgent', 'notifyAgencyAdmins', 'notifyStudent') then raise exception 'Unknown event setting' using errcode = '22023'; end if;
  end loop;
  foreach k in array array['notifyAgent', 'notifyAgencyAdmins', 'notifyStudent'] loop
    if p_settings ? k and jsonb_typeof(p_settings->k) <> 'boolean' then raise exception 'Recipient toggles must be true or false' using errcode = '22023'; end if;
  end loop;
  if p_settings ? 'recipients' then
    if jsonb_typeof(p_settings->'recipients') <> 'array' then raise exception 'Recipients must be a list of email addresses' using errcode = '22023'; end if;
    if jsonb_array_length(p_settings->'recipients') > 10 then raise exception 'At most 10 internal recipients per event' using errcode = '22023'; end if;
    for e in select * from jsonb_array_elements(p_settings->'recipients') loop
      if jsonb_typeof(e) <> 'string' then raise exception 'Each recipient must be an email address' using errcode = '22023'; end if;
      addr := lower(btrim(e #>> '{}'));
      if length(addr) > 254 or addr ~ '[[:cntrl:]]' or addr !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then raise exception 'Invalid recipient email address' using errcode = '22023'; end if;
      if addr = any (seen) then raise exception 'Duplicate recipient email address' using errcode = '22023'; end if;
      seen := seen || addr;
    end loop;
  end if;
end;
$$;

create function public.notification_events_check(p_events jsonb) returns void language plpgsql immutable set search_path = public as $$
declare k text;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'object' then raise exception 'events must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_events) loop
    if k not in ('application_submitted', 'application_status_changed', 'offer_accepted', 'coe_voe_issued') then raise exception 'Unknown notification event' using errcode = '22023'; end if;
    perform public.notification_event_check(p_events->k);
  end loop;
end;
$$;

-- Effective settings for one event in one scope: defaults overlaid with what the scope configured.
create function public.notification_event_settings(p_tenant uuid, p_event text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb := public.notification_default_event_settings(p_event); o jsonb;
begin
  if p_tenant is null then
    select l.settings into o from public.notification_legacy_event_settings l where l.event = p_event;
  else
    select c.config->'events'->p_event into o from public.tenant_config_versions c where c.tenant_id = p_tenant and c.kind = 'notifications' and c.state = 'published';
  end if;
  if o is not null and jsonb_typeof(o) = 'object' then v := v || o; end if;
  return v;
end;
$$;

create function public.notification_event_settings_state(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare ev text; events jsonb := '{}'::jsonb; eff jsonb;
begin
  if auth.uid() is null or not (case when p_tenant is null then public.cms_is_admin() else public.tenant_has_role(p_tenant, array['tenant_admin']) end) then
    raise exception 'Organization administrator access required' using errcode = '42501'; end if;
  foreach ev in array array['application_submitted', 'application_status_changed', 'offer_accepted', 'coe_voe_issued'] loop
    events := events || jsonb_build_object(ev, public.notification_event_settings(p_tenant, ev));
  end loop;
  if p_tenant is null then return jsonb_build_object('legacy', true, 'version', 0, 'source', 'legacy', 'config', '{}'::jsonb, 'events', events); end if;
  eff := public.tenant_config_effective(p_tenant, 'notifications');
  return jsonb_build_object('legacy', false, 'version', eff->'version', 'source', eff->'source', 'config', eff->'config', 'events', events);
end;
$$;

-- Legacy scope (no configuration row): same validation, attributable, no addresses in the audit details.
create function public.notification_save_legacy_event(p_event text, p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if auth.uid() is null or not public.cms_is_admin() then raise exception 'Organization administrator access required' using errcode = '42501'; end if;
  if p_event is null or p_event not in ('application_submitted', 'application_status_changed', 'offer_accepted', 'coe_voe_issued') then raise exception 'Unknown notification event' using errcode = '22023'; end if;
  perform public.notification_event_check(p_settings);
  v := public.notification_default_event_settings(p_event) || p_settings;
  v := jsonb_set(v, '{recipients}', coalesce((select jsonb_agg(distinct lower(btrim(x))) from jsonb_array_elements_text(v->'recipients') x), '[]'::jsonb));
  insert into public.notification_legacy_event_settings(event, settings, updated_by) values (p_event, v, auth.uid())
  on conflict (event) do update set settings = excluded.settings, updated_by = excluded.updated_by, updated_at = now();
  insert into public.tenant_access_audit(tenant_id, actor, action, details)
  values (null, auth.uid(), 'notification_event_settings', jsonb_build_object('event', p_event, 'recipientCount', jsonb_array_length(v->'recipients'), 'notifyAgent', v->'notifyAgent', 'notifyAgencyAdmins', v->'notifyAgencyAdmins', 'notifyStudent', v->'notifyStudent'));
  return v;
end;
$$;

create or replace function public.tenant_config_validate(p_kind text, p_config jsonb) returns void language plpgsql set search_path = public as $$
declare
  statuses constant text[] := array['draft','submitted','under_review','action_required','offer_issued','offer_accepted','coe_issued','enrolled','rejected','withdrawn'];
  terminal constant text[] := array['enrolled','rejected','withdrawn'];
  tenant_roles constant text[] := array['tenant_admin','editor','staff','viewer'];
  perms constant text[] := array['cms.read','cms.edit','applications.review','members.manage','domains.manage','config.manage'];
  reserved constant text[] := array['members.manage','domains.manage','config.manage'];
  providers constant text[] := array['openai','azure','postmark','stripe'];
  fonts constant text[] := array['Arial','Georgia','Verdana','system-ui'];
  events constant text[] := array['application_submitted','application_status_changed','offer_accepted','coe_voe_issued'];
  vars constant text[] := array['reference','status','previousStatus','institution'];
  tk text; ph text;
  k text; v jsonb; item jsonb; s text[]; r text; seen text[] := '{}'; pair text; pairs text[] := '{}';
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object' then raise exception 'Configuration must be an object' using errcode = '22023'; end if;
  if p_kind = 'workflow' then
    for k in select jsonb_object_keys(p_config) loop if k not in ('statuses', 'transitions') then raise exception 'Unknown workflow field' using errcode = '22023'; end if; end loop;
    if jsonb_typeof(p_config->'statuses') is distinct from 'array' or jsonb_typeof(p_config->'transitions') is distinct from 'array' then raise exception 'Workflow needs statuses and transitions arrays' using errcode = '22023'; end if;
    select array_agg(x) into s from jsonb_array_elements_text(p_config->'statuses') x;
    if s is null or cardinality(s) > 10 or exists (select 1 from unnest(s) x where x <> all (statuses)) then raise exception 'Unknown workflow status' using errcode = '22023'; end if;
    if cardinality(s) <> (select count(distinct x) from unnest(s) x) then raise exception 'Duplicate workflow status' using errcode = '22023'; end if;
    if not (s @> array['draft','submitted']) then raise exception 'Workflow must include draft and submitted' using errcode = '22023'; end if;
    if jsonb_array_length(p_config->'transitions') > 60 then raise exception 'Too many transitions' using errcode = '22023'; end if;
    for item in select * from jsonb_array_elements(p_config->'transitions') loop
      if jsonb_typeof(item) <> 'object' then raise exception 'Invalid transition' using errcode = '22023'; end if;
      for k in select jsonb_object_keys(item) loop if k not in ('from', 'to', 'roles') then raise exception 'Unknown transition field' using errcode = '22023'; end if; end loop;
      if jsonb_typeof(item->'from') is distinct from 'string' or jsonb_typeof(item->'to') is distinct from 'string' then raise exception 'Invalid transition' using errcode = '22023'; end if;
      if (item->>'from') <> all (s) or (item->>'to') <> all (s) or item->>'from' = item->>'to' then raise exception 'Transition uses an unlisted status' using errcode = '22023'; end if;
      if (item->>'from') = any (terminal) then raise exception 'Terminal statuses cannot have transitions' using errcode = '22023'; end if;
      pair := (item->>'from') || '>' || (item->>'to');
      if pair = any (pairs) then raise exception 'Duplicate transition' using errcode = '22023'; end if;
      pairs := pairs || pair;
      if item ? 'roles' then
        if jsonb_typeof(item->'roles') <> 'array' then raise exception 'Invalid transition roles' using errcode = '22023'; end if;
        for r in select jsonb_array_elements_text(item->'roles') loop if r <> all (array['agency','tenant_admin','editor','staff','viewer']) then raise exception 'Unknown transition role' using errcode = '22023'; end if; end loop;
      end if;
    end loop;
    if exists (
      with recursive reach(st) as (
        select 'draft'::text
        union select t->>'to' from reach join jsonb_array_elements(p_config->'transitions') t on t->>'from' = reach.st)
      select 1 from unnest(s) x where x not in (select st from reach)) then
      raise exception 'Every workflow status must be reachable from draft' using errcode = '22023';
    end if;
  elsif p_kind = 'roles' then
    for k in select jsonb_object_keys(p_config) loop if k <> 'roles' then raise exception 'Unknown roles field' using errcode = '22023'; end if; end loop;
    if jsonb_typeof(p_config->'roles') is distinct from 'object' then raise exception 'Roles must be an object' using errcode = '22023'; end if;
    for k, v in select * from jsonb_each(p_config->'roles') loop
      if k <> all (tenant_roles) then raise exception 'Unknown role' using errcode = '22023'; end if;
      if jsonb_typeof(v) <> 'array' then raise exception 'Role permissions must be an array' using errcode = '22023'; end if;
      seen := '{}';
      for r in select jsonb_array_elements_text(v) loop
        if r <> all (perms) then raise exception 'Unknown permission' using errcode = '22023'; end if;
        if r = any (seen) then raise exception 'Duplicate permission' using errcode = '22023'; end if;
        if r = any (reserved) and k <> 'tenant_admin' then raise exception 'Administration permissions are reserved for institution administrators' using errcode = '22023'; end if;
        seen := seen || r;
      end loop;
    end loop;
    if not (p_config->'roles' ? 'tenant_admin') or not ((p_config->'roles'->'tenant_admin') @> '["members.manage","domains.manage","config.manage"]'::jsonb) then
      raise exception 'Institution administrators must keep member, domain and configuration management' using errcode = '22023';
    end if;
  elsif p_kind = 'integration' then
    for k in select jsonb_object_keys(p_config) loop if k <> 'integrations' then raise exception 'Unknown integration field' using errcode = '22023'; end if; end loop;
    if jsonb_typeof(p_config->'integrations') is distinct from 'array' or jsonb_array_length(p_config->'integrations') > 10 then raise exception 'Integrations must be an array of at most 10' using errcode = '22023'; end if;
    for item in select * from jsonb_array_elements(p_config->'integrations') loop
      if jsonb_typeof(item) <> 'object' then raise exception 'Invalid integration' using errcode = '22023'; end if;
      for k in select jsonb_object_keys(item) loop if k not in ('provider', 'enabled', 'secretNames', 'settings') then raise exception 'Unknown integration field' using errcode = '22023'; end if; end loop;
      if jsonb_typeof(item->'provider') is distinct from 'string' or (item->>'provider') <> all (providers) then raise exception 'Unknown integration provider' using errcode = '22023'; end if;
      if (item->>'provider') = any (seen) then raise exception 'Duplicate integration provider' using errcode = '22023'; end if;
      seen := seen || (item->>'provider');
      if jsonb_typeof(item->'enabled') is distinct from 'boolean' then raise exception 'enabled must be true or false' using errcode = '22023'; end if;
      if item ? 'secretNames' then
        if jsonb_typeof(item->'secretNames') <> 'array' or jsonb_array_length(item->'secretNames') > 10 then raise exception 'secretNames must be an array of at most 10' using errcode = '22023'; end if;
        for r in select jsonb_array_elements_text(item->'secretNames') loop
          if r !~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$' or length(r) > 64 then raise exception 'secretNames must be environment variable names, never values' using errcode = '22023'; end if;
        end loop;
      end if;
      if item ? 'settings' then
        if jsonb_typeof(item->'settings') <> 'object' then raise exception 'settings must be an object' using errcode = '22023'; end if;
        for k, v in select * from jsonb_each(item->'settings') loop
          if k !~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$' or k ~* '(secret|password|passwd|token|credential|api[_-]?key|private)' then raise exception 'Setting names must not look like credentials' using errcode = '22023'; end if;
          if jsonb_typeof(v) not in ('string', 'number', 'boolean') then raise exception 'Settings must be plain values' using errcode = '22023'; end if;
          if jsonb_typeof(v) = 'string' and (length(v #>> '{}') > 200 or (v #>> '{}') ~ '^(eyJ|sk[-_]|pk[-_]|sbp_|AKIA|xox[a-z]-)' or (v #>> '{}') ~ '^[A-Za-z0-9+/=_-]{32,}$') then
            raise exception 'Setting values must not look like credentials' using errcode = '22023';
          end if;
        end loop;
      end if;
    end loop;
  elsif p_kind = 'branding' then
    for k, v in select * from jsonb_each(p_config) loop
      if k in ('primaryColor', 'accentColor') then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Colours must be #rrggbb' using errcode = '22023'; end if;
      elsif k in ('headingFont', 'bodyFont') then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') <> all (fonts) then raise exception 'Unsupported font' using errcode = '22023'; end if;
      else raise exception 'Unknown branding field' using errcode = '22023';
      end if;
    end loop;
  elsif p_kind = 'notifications' then
    for k in select jsonb_object_keys(p_config) loop if k not in ('sender', 'templates', 'defaults', 'events') then raise exception 'Unknown notification field' using errcode = '22023'; end if; end loop;
    if p_config ? 'sender' then
      v := p_config->'sender';
      if jsonb_typeof(v) <> 'object' then raise exception 'sender must be an object' using errcode = '22023'; end if;
      for k in select jsonb_object_keys(v) loop if k not in ('name', 'email') then raise exception 'Unknown sender field' using errcode = '22023'; end if; end loop;
      if jsonb_typeof(v->'name') is distinct from 'string' or length(v->>'name') not between 1 and 100 or (v->>'name') ~ '[<>"\r\n]' then raise exception 'Invalid sender name' using errcode = '22023'; end if;
      if jsonb_typeof(v->'email') is distinct from 'string' or length(v->>'email') > 254 or (v->>'email') !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then raise exception 'Invalid sender email' using errcode = '22023'; end if;
    end if;
    if p_config ? 'templates' then
      if jsonb_typeof(p_config->'templates') <> 'object' then raise exception 'templates must be an object' using errcode = '22023'; end if;
      for k, v in select * from jsonb_each(p_config->'templates') loop
        if k <> all (events) then raise exception 'Unknown notification event' using errcode = '22023'; end if;
        if jsonb_typeof(v) <> 'object' then raise exception 'Invalid template' using errcode = '22023'; end if;
        for tk in select jsonb_object_keys(v) loop if tk not in ('subject', 'body') then raise exception 'Unknown template field' using errcode = '22023'; end if; end loop;
        if jsonb_typeof(v->'subject') is distinct from 'string' or jsonb_typeof(v->'body') is distinct from 'string' then raise exception 'Templates need a subject and a body' using errcode = '22023'; end if;
        if length(v->>'subject') not between 1 and 150 or (v->>'subject') ~ '[\r\n]' then raise exception 'Invalid subject' using errcode = '22023'; end if;
        if length(v->>'body') not between 1 and 2000 then raise exception 'Invalid body' using errcode = '22023'; end if;
        if (v->>'subject') ~ '[<>]' or (v->>'body') ~ '[<>]' then raise exception 'Templates are plain text: remove < and >' using errcode = '22023'; end if;
        for ph in select m[1] from regexp_matches((v->>'subject') || ' ' || (v->>'body'), '\{\{([^{}]*)\}\}', 'g') as m loop
          if ph <> all (vars) then raise exception 'Unknown template placeholder' using errcode = '22023'; end if;
        end loop;
        if regexp_replace((v->>'subject') || ' ' || (v->>'body'), '\{\{[^{}]*\}\}', '', 'g') ~ '[{}]' then raise exception 'Malformed template placeholder' using errcode = '22023'; end if;
      end loop;
    end if;
    if p_config ? 'defaults' then
      if jsonb_typeof(p_config->'defaults') <> 'object' then raise exception 'defaults must be an object' using errcode = '22023'; end if;
      for k, v in select * from jsonb_each(p_config->'defaults') loop
        if k <> all (events) or jsonb_typeof(v) <> 'boolean' then raise exception 'Invalid notification default' using errcode = '22023'; end if;
      end loop;
    end if;
    if p_config ? 'events' then perform public.notification_events_check(p_config->'events'); end if;
  else
    raise exception 'Unknown configuration kind' using errcode = '22023';
  end if;
end;
$$;
create or replace function public.tenant_config_defaults(p_kind text) returns jsonb language sql immutable set search_path = public as $$
  select case p_kind
    when 'workflow' then jsonb_build_object(
      'statuses', '["draft","submitted","action_required","offer_accepted","coe_issued","enrolled","rejected","withdrawn"]'::jsonb,
      'transitions', '[{"from":"draft","to":"submitted"},
        {"from":"submitted","to":"action_required"},{"from":"submitted","to":"offer_accepted"},{"from":"submitted","to":"rejected"},{"from":"submitted","to":"withdrawn"},
        {"from":"action_required","to":"submitted"},{"from":"action_required","to":"offer_accepted"},{"from":"action_required","to":"rejected"},{"from":"action_required","to":"withdrawn"},
        {"from":"offer_accepted","to":"coe_issued"},{"from":"offer_accepted","to":"rejected"},{"from":"offer_accepted","to":"withdrawn"},
        {"from":"coe_issued","to":"enrolled"},{"from":"coe_issued","to":"withdrawn"}]'::jsonb)
    when 'roles' then '{"roles":{"tenant_admin":["cms.read","cms.edit","applications.review","members.manage","domains.manage","config.manage"],"editor":["cms.read","cms.edit"],"staff":["cms.read","applications.review"],"viewer":[]}}'::jsonb
    when 'integration' then '{"integrations":[]}'::jsonb
    when 'notifications' then jsonb_build_object(
      'templates', jsonb_build_object(
        'application_submitted', jsonb_build_object('subject', 'Application {{reference}} was submitted', 'body', 'Application {{reference}} has been submitted to {{institution}} and is awaiting review.'),
        'application_status_changed', jsonb_build_object('subject', 'Application {{reference}} is now {{status}}', 'body', 'The status of application {{reference}} changed from {{previousStatus}} to {{status}}.'),
        'offer_accepted', jsonb_build_object('subject', 'Offer accepted for application {{reference}}', 'body', 'The offer for application {{reference}} has been accepted. {{institution}} will now prepare the next steps.'),
        'coe_voe_issued', jsonb_build_object('subject', 'CoE / VoE issued for application {{reference}}', 'body', 'The CoE / VoE for application {{reference}} has been issued by {{institution}}.')),
      'defaults', '{"application_submitted":true,"application_status_changed":true,"offer_accepted":true,"coe_voe_issued":true}'::jsonb)
    when 'branding' then '{"primaryColor":"#2563eb","headingFont":"Arial","bodyFont":"Arial"}'::jsonb
  end;
$$;

create or replace function public.portal_set_application_status(p_application_id uuid,p_status text,p_note text default '') returns void
language plpgsql security definer set search_path=public as $$
declare a public.enrollment_applications; allowed boolean; v_config jsonb; v_role text;
begin
 select * into a from public.enrollment_applications where id=p_application_id for update;
 if not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode='42501'; end if;
 if a.status=p_status then return; end if;
 select config into v_config from public.tenant_config_versions where id=a.workflow_version_id;
 if v_config is null then
  allowed:=public.portal_legacy_transition_allowed(a.status,p_status);
 else
  select role into v_role from public.tenant_memberships where tenant_id=a.tenant_id and auth_user_id=auth.uid() and active;
  allowed:=public.portal_pinned_transition_allowed(v_config,a.status,p_status,v_role,public.tenant_is_platform_admin());
 end if;
 if not allowed then raise exception 'Invalid admissions transition: % to %',a.status,p_status using errcode='22023'; end if;
 if p_status='action_required' and nullif(btrim(p_note),'') is null then raise exception 'A correction reason is required' using errcode='22023'; end if;
 perform set_config('portal.status_command',a.id::text,true);
 perform set_config('portal.status_note',coalesce(p_note,''),true);
 update public.enrollment_applications set status=p_status where id=a.id;
 insert into public.portal_audit_log(actor,actor_name,actor_role,action,target_type,target_id,application_id,detail)
 values(auth.uid(),coalesce(auth.jwt()->>'email','Authorized reviewer'),'slit_admin','status_change','application',a.id::text,a.id,jsonb_build_object('from',a.status,'to',p_status,'note',p_note)||case when v_config is null then '{}'::jsonb else jsonb_build_object('workflowVersion',(select version from public.tenant_config_versions where id=a.workflow_version_id)) end);
 insert into public.admission_event_outbox(application_id,tenant_id,event,payload)
 values(a.id,a.tenant_id,case p_status when 'offer_accepted' then 'offer_accepted' when 'coe_issued' then 'coe_voe_issued' else 'application_status_changed' end,jsonb_build_object('from',a.status,'to',p_status,'actor',auth.uid()));
end; $$;

create or replace function public.portal_set_notification_preference(p_event text, p_email_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_event is null or p_event not in ('application_submitted', 'application_status_changed', 'offer_accepted', 'coe_voe_issued') or p_email_enabled is null then raise exception 'Unknown notification event' using errcode = '22023'; end if;
  insert into public.notification_preferences(auth_user_id, event, email_enabled) values (auth.uid(), p_event, p_email_enabled)
  on conflict (auth_user_id, event) do update set email_enabled = excluded.email_enabled, updated_at = now();
end;
$$;

create or replace function public.notification_enqueue_deliveries() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a public.enrollment_applications; v_id uuid; v_cfg jsonb; v_defaults jsonb := public.tenant_config_defaults('notifications');
  v_tpl jsonb; v_vars jsonb; v_enabled boolean; v_pref boolean; v_sender jsonb; r record; v_active boolean; v_set jsonb; v_source text;
  v_subject text; v_body text; v_addr text; v_state text; v_reason text;
begin
  if new.event not in ('application_submitted', 'application_status_changed', 'offer_accepted', 'coe_voe_issued') then return new; end if;
  select * into a from public.enrollment_applications where id = new.application_id;
  select id, config into v_id, v_cfg from public.tenant_config_versions where tenant_id = new.tenant_id and kind = 'notifications' and state = 'published';
  v_enabled := coalesce((v_cfg->'defaults'->>new.event)::boolean, (v_defaults->'defaults'->>new.event)::boolean, true);
  if not v_enabled then return new; end if;
  v_tpl := coalesce(v_cfg->'templates'->new.event, v_defaults->'templates'->new.event);
  v_sender := case when v_cfg->'sender' is not null and public.notification_sender_allowed(new.tenant_id, v_cfg->'sender'->>'email') then v_cfg->'sender' else null end;
  v_active := exists (select 1 from public.notification_activation act where act.revoked_at is null and act.tenant_id is not distinct from new.tenant_id);
  v_set := public.notification_event_settings(new.tenant_id, new.event);
  v_source := case when v_cfg is null then 'default' else 'published' end;
  v_vars := jsonb_build_object(
    'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)),
    'status', public.portal_status_label(coalesce(new.payload->>'to', a.status)),
    'previousStatus', public.portal_status_label(coalesce(new.payload->>'from', case when new.event = 'application_submitted' then 'draft' else '' end)),
    'institution', coalesce((select name from public.tenants where id = new.tenant_id), 'Skyline'));
  v_subject := public.notification_render(v_tpl->>'subject', v_vars);
  v_body := public.notification_render(v_tpl->>'body', v_vars);
  -- Portal users: the assigned agent and / or the agency admins, per the event settings; per-user opt-outs apply.
  for r in
    select p.auth_user_id, lower(trim(p.email)) as email from public.portal_profiles p
    where p.status = 'Active' and p.auth_user_id is not null and nullif(trim(p.email), '') is not null
      and ((coalesce((v_set->>'notifyAgent')::boolean, false) and p.id = a.assigned_agent_id)
        or (coalesce((v_set->>'notifyAgencyAdmins')::boolean, false) and exists (select 1 from public.agency_memberships m where m.user_id = p.id and m.agency_id = a.agency_id and m.status = 'Active' and m.role = 'agency_admin')))
  loop
    v_pref := coalesce((select email_enabled from public.notification_preferences where auth_user_id = r.auth_user_id and event = new.event), true);
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (new.id, new.tenant_id, new.application_id, r.auth_user_id, r.email, new.event, v_source, v_id, v_sender, v_subject, v_body,
      case when v_active and v_pref then 'pending' else 'suppressed' end,
      case when not v_active then 'legacy_scope_not_activated' when v_pref then null else 'recipient_opted_out' end, clock_timestamp())
    on conflict do nothing;
  end loop;
  -- Recipients without a portal account: the configured internal addresses and, when enabled, the student. One delivery per address per event.
  v_state := case when v_active then 'pending' else 'suppressed' end;
  v_reason := case when v_active then null else 'legacy_scope_not_activated' end;
  for v_addr in
    select distinct x from (
      select lower(btrim(e)) as x from jsonb_array_elements_text(coalesce(v_set->'recipients', '[]'::jsonb)) e
      union all
      select lower(btrim(a.student_email)) where coalesce((v_set->>'notifyStudent')::boolean, false) and a.student_email ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' and length(a.student_email) <= 254
    ) s where x is not null and x <> ''
  loop
    if exists (select 1 from public.notification_deliveries d where d.outbox_id = new.id and lower(d.recipient_email) = v_addr) then continue; end if;
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (new.id, new.tenant_id, new.application_id, null, v_addr, new.event, v_source, v_id, v_sender, v_subject, v_body, v_state, v_reason, clock_timestamp())
    on conflict do nothing;
  end loop;
  return new;
end;
$$;

revoke all on function public.notification_default_event_settings(text), public.notification_event_check(jsonb), public.notification_events_check(jsonb), public.notification_event_settings(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.notification_event_settings_state(uuid), public.notification_save_legacy_event(text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.notification_event_settings_state(uuid), public.notification_save_legacy_event(text, jsonb) to authenticated;
grant execute on function public.notification_event_settings(uuid, text) to service_role;

commit;
