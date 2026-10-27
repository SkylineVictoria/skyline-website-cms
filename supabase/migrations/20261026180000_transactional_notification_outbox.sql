-- P07-01: transactional notification outbox with versioned templates, sender and preferences.
-- Events: admission_event_outbox already receives exactly one row per committed submission or status change,
-- written in the same transaction (a rollback leaves none; a repeated status request is a no-op). An AFTER INSERT
-- trigger now turns every such event into durable per-recipient rows in notification_deliveries, in that same
-- transaction. Recipients are the same people the in-app inbox notifies (the assigned agent and the agency's
-- administrators, active profiles only); the inbox itself is untouched.
-- Templates, sender and per-event defaults are a new versioned configuration kind, 'notifications', in the
-- P06-02 store (draft/publish/restore, audit, safe defaults). Each delivery snapshots the rendered subject and body,
-- the sender and the template version used, so later publishes never rewrite history. Templates are plain text with a
-- fixed placeholder set; values are inserted as plain text (no HTML, no line breaks).
-- Per-user opt-out is a row in notification_preferences (own row via portal_set_notification_preference); an
-- opted-out recipient gets a 'suppressed' delivery for the audit trail. Nothing is sent here: delivery is P07-02.
--
-- Rollback / compensation (additive; run manually):
--   drop trigger if exists notification_enqueue on public.admission_event_outbox;
--   drop function if exists public.notification_enqueue_deliveries(), public.notification_render(text, jsonb), public.portal_set_notification_preference(text, boolean);
--   drop table if exists public.notification_deliveries, public.notification_preferences;
--   delete the 'notifications' rows from tenant_config_versions (needs the guard trigger disabled), restore the kind check, and
--   re-create tenant_config_defaults / tenant_config_validate / tenant_config_overview / tenant_config_effective from 20261026160000 / 20261026150000.
-- Never applied to the hosted project without release approval.
begin;

alter table public.tenant_config_versions drop constraint tenant_config_versions_kind_check;
alter table public.tenant_config_versions add constraint tenant_config_versions_kind_check check (kind in ('workflow', 'roles', 'integration', 'branding', 'notifications'));

create or replace function public.tenant_config_defaults(p_kind text) returns jsonb language sql immutable set search_path = public as $$
  select case p_kind
    when 'workflow' then jsonb_build_object(
      'statuses', '["draft","submitted","under_review","action_required","offer_issued","offer_accepted","coe_issued","enrolled","rejected","withdrawn"]'::jsonb,
      'transitions', '[{"from":"draft","to":"submitted"},
        {"from":"submitted","to":"under_review"},{"from":"submitted","to":"action_required"},{"from":"submitted","to":"rejected"},{"from":"submitted","to":"withdrawn"},
        {"from":"under_review","to":"action_required"},{"from":"under_review","to":"offer_issued"},{"from":"under_review","to":"rejected"},{"from":"under_review","to":"withdrawn"},
        {"from":"action_required","to":"under_review"},{"from":"action_required","to":"rejected"},{"from":"action_required","to":"withdrawn"},
        {"from":"offer_issued","to":"offer_accepted"},{"from":"offer_issued","to":"action_required"},{"from":"offer_issued","to":"rejected"},{"from":"offer_issued","to":"withdrawn"},
        {"from":"offer_accepted","to":"coe_issued"},{"from":"offer_accepted","to":"withdrawn"},
        {"from":"coe_issued","to":"enrolled"},{"from":"coe_issued","to":"withdrawn"}]'::jsonb)
    when 'roles' then '{"roles":{"tenant_admin":["cms.read","cms.edit","applications.review","members.manage","domains.manage","config.manage"],"editor":["cms.read","cms.edit"],"staff":["cms.read","applications.review"],"viewer":[]}}'::jsonb
    when 'integration' then '{"integrations":[]}'::jsonb
    when 'notifications' then jsonb_build_object(
      'templates', jsonb_build_object(
        'application_submitted', jsonb_build_object('subject', 'Application {{reference}} was submitted', 'body', 'Application {{reference}} has been submitted to {{institution}} and is awaiting review.'),
        'application_status_changed', jsonb_build_object('subject', 'Application {{reference}} is now {{status}}', 'body', 'The status of application {{reference}} changed from {{previousStatus}} to {{status}}.')),
      'defaults', '{"application_submitted":true,"application_status_changed":true}'::jsonb)
    when 'branding' then '{"primaryColor":"#2563eb","headingFont":"Arial","bodyFont":"Arial"}'::jsonb
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
  events constant text[] := array['application_submitted','application_status_changed'];
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
    for k in select jsonb_object_keys(p_config) loop if k not in ('sender', 'templates', 'defaults') then raise exception 'Unknown notification field' using errcode = '22023'; end if; end loop;
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
  else
    raise exception 'Unknown configuration kind' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.tenant_config_overview(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare k text; result jsonb := '{}'::jsonb;
begin
  if not public.tenant_has_role(p_tenant, array['tenant_admin']) then raise exception 'Tenant administration required' using errcode = '42501'; end if;
  foreach k in array array['workflow', 'roles', 'integration', 'branding', 'notifications'] loop
    result := result || jsonb_build_object(k, jsonb_build_object(
      'defaults', public.tenant_config_defaults(k),
      'published', (select jsonb_build_object('version', version, 'config', config, 'publishedAt', published_at) from public.tenant_config_versions where tenant_id = p_tenant and kind = k and state = 'published'),
      'draft', (select jsonb_build_object('config', config, 'restoredFrom', restored_from) from public.tenant_config_versions where tenant_id = p_tenant and kind = k and state = 'draft'),
      'history', coalesce((select jsonb_agg(jsonb_build_object('version', h.version, 'state', h.state, 'publishedAt', h.published_at, 'publishedBy', (select email from auth.users where id = h.published_by)) order by h.version desc)
        from public.tenant_config_versions h where h.tenant_id = p_tenant and h.kind = k and h.state <> 'draft'), '[]'::jsonb)));
  end loop;
  return result;
end;
$$;

create or replace function public.tenant_config_effective(p_tenant uuid, p_kind text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_row public.tenant_config_versions;
begin
  if p_kind not in ('workflow', 'roles', 'integration', 'branding', 'notifications') then raise exception 'Unknown configuration kind' using errcode = '22023'; end if;
  if not (case when p_kind in ('workflow', 'branding') then public.tenant_can_access(p_tenant) else public.tenant_has_role(p_tenant, array['tenant_admin']) end) then
    raise exception 'Not authorised for this configuration' using errcode = '42501';
  end if;
  select * into v_row from public.tenant_config_versions where tenant_id = p_tenant and kind = p_kind and state = 'published';
  if found then return jsonb_build_object('version', v_row.version, 'source', 'published', 'config', v_row.config); end if;
  return jsonb_build_object('version', 0, 'source', 'default', 'config', public.tenant_config_defaults(p_kind));
end;
$$;

create table public.notification_preferences(
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  event text not null check (event in ('application_submitted', 'application_status_changed')),
  email_enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (auth_user_id, event)
);
alter table public.notification_preferences enable row level security;
revoke all on public.notification_preferences from public, anon, authenticated, service_role;
grant select on public.notification_preferences to authenticated, service_role;
create policy notification_preferences_own on public.notification_preferences for select to authenticated using (auth_user_id = auth.uid());

create table public.notification_deliveries(
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  outbox_id uuid not null references public.admission_event_outbox(id),
  tenant_id uuid,
  application_id uuid not null references public.enrollment_applications(id),
  recipient_user uuid not null,
  recipient_email text not null,
  event text not null,
  template_source text not null check (template_source in ('default', 'published')),
  template_version_id uuid references public.tenant_config_versions(id),
  sender jsonb,
  subject text not null,
  body text not null,
  state text not null default 'pending' check (state in ('pending', 'suppressed')),
  state_reason text,
  created_at timestamptz not null default now(),
  unique (outbox_id, recipient_user)
);
create index notification_deliveries_pending on public.notification_deliveries(seq) where state = 'pending';
alter table public.notification_deliveries enable row level security;
revoke all on public.notification_deliveries from public, anon, authenticated, service_role;
grant select on public.notification_deliveries to service_role;

create function public.portal_set_notification_preference(p_event text, p_email_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_event is null or p_event not in ('application_submitted', 'application_status_changed') or p_email_enabled is null then raise exception 'Unknown notification event' using errcode = '22023'; end if;
  insert into public.notification_preferences(auth_user_id, event, email_enabled) values (auth.uid(), p_event, p_email_enabled)
  on conflict (auth_user_id, event) do update set email_enabled = excluded.email_enabled, updated_at = now();
end;
$$;

create function public.notification_render(p_text text, p_vars jsonb) returns text
language plpgsql immutable set search_path = public as $$
declare r text := p_text; k text; v text;
begin
  for k, v in select key, value from jsonb_each_text(p_vars) loop
    r := replace(r, '{{' || k || '}}', left(regexp_replace(coalesce(v, ''), '[\r\n\t]+', ' ', 'g'), 200));
  end loop;
  return r;
end;
$$;

create function public.notification_enqueue_deliveries() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a public.enrollment_applications; v_id uuid; v_cfg jsonb; v_defaults jsonb := public.tenant_config_defaults('notifications');
  v_tpl jsonb; v_vars jsonb; v_enabled boolean; v_pref boolean; r record;
begin
  if new.event not in ('application_submitted', 'application_status_changed') then return new; end if;
  select * into a from public.enrollment_applications where id = new.application_id;
  select id, config into v_id, v_cfg from public.tenant_config_versions where tenant_id = new.tenant_id and kind = 'notifications' and state = 'published';
  v_enabled := coalesce((v_cfg->'defaults'->>new.event)::boolean, (v_defaults->'defaults'->>new.event)::boolean, true);
  if not v_enabled then return new; end if;
  v_tpl := coalesce(v_cfg->'templates'->new.event, v_defaults->'templates'->new.event);
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
    values (new.id, new.tenant_id, new.application_id, r.auth_user_id, r.email, new.event, case when v_cfg is null then 'default' else 'published' end, v_id, v_cfg->'sender',
      public.notification_render(v_tpl->>'subject', v_vars), public.notification_render(v_tpl->>'body', v_vars),
      case when v_pref then 'pending' else 'suppressed' end, case when v_pref then null else 'recipient_opted_out' end)
    on conflict (outbox_id, recipient_user) do nothing;
  end loop;
  return new;
end;
$$;
create trigger notification_enqueue after insert on public.admission_event_outbox for each row execute function public.notification_enqueue_deliveries();

revoke all on function public.notification_render(text, jsonb), public.notification_enqueue_deliveries() from public, anon, authenticated, service_role;
revoke all on function public.portal_set_notification_preference(text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.portal_set_notification_preference(text, boolean) to authenticated;

commit;
