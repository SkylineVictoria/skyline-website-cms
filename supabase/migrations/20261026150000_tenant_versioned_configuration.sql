-- P06-02: validated, versioned, audited tenant configuration (workflow, roles, integration, branding).
-- Model: one editable draft per (tenant, kind); publishing assigns the next version number and
-- supersedes the previous one. Published and superseded rows are immutable and never deleted, so
-- a restore creates a new draft from an old version and is published like any other change.
-- No configuration published = built-in safe defaults (tenant_config_defaults); the legacy
-- hard-coded admissions transitions are unchanged and are NOT yet driven by this store.
-- Secrets: only environment variable NAMES may be stored (integration.secretNames); keys and
-- values that look like credentials are rejected, so a secret value can never be saved or returned.
-- New applications record the workflow version published at creation (enrollment_applications.
-- workflow_version_id); later publishes never change it.
--
-- Rollback / compensation (additive; run manually, in this order, only if reverting P06-02):
--   drop trigger if exists tenant_pin_workflow on public.enrollment_applications;
--   drop function if exists public.tenant_pin_workflow_version();
--   alter table public.enrollment_applications drop column if exists workflow_version_id;
--   drop function if exists public.tenant_config_effective(uuid, text), public.tenant_config_overview(uuid),
--     public.tenant_config_restore(uuid, text, integer), public.tenant_config_publish(uuid, text, integer),
--     public.tenant_config_save_draft(uuid, text, jsonb, integer), public.tenant_config_validate(text, jsonb),
--     public.tenant_config_defaults(text), public.tenant_config_guard();
--   drop table if exists public.tenant_config_versions;   -- discards configuration history; export it first
-- Never applied to the hosted project without release approval.
begin;

create table public.tenant_config_versions(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  kind text not null check (kind in ('workflow', 'roles', 'integration', 'branding')),
  version integer check (version > 0),
  state text not null check (state in ('draft', 'published', 'superseded')),
  config jsonb not null check (jsonb_typeof(config) = 'object' and pg_column_size(config) < 65536),
  restored_from integer,
  created_by uuid,
  created_at timestamptz not null default now(),
  published_by uuid,
  published_at timestamptz,
  check ((state = 'draft') = (version is null)),
  unique (tenant_id, kind, version)
);
create unique index tenant_config_one_draft on public.tenant_config_versions(tenant_id, kind) where state = 'draft';
create unique index tenant_config_one_published on public.tenant_config_versions(tenant_id, kind) where state = 'published';
alter table public.tenant_config_versions enable row level security;
revoke all on public.tenant_config_versions from public, anon, authenticated, service_role;
grant select on public.tenant_config_versions to authenticated, service_role;
create policy tenant_config_read on public.tenant_config_versions for select to authenticated
  using (public.tenant_has_role(tenant_id, array['tenant_admin']));

create function public.tenant_config_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Configuration history is retained' using errcode = '55000'; end if;
  if new.tenant_id <> old.tenant_id or new.kind <> old.kind or new.id <> old.id then raise exception 'Configuration identity is fixed' using errcode = '55000'; end if;
  if old.state = 'draft' then return new; end if;
  if old.state = 'published' and new.state = 'superseded' and new.config = old.config and new.version = old.version then return new; end if;
  raise exception 'Published configuration is immutable' using errcode = '55000';
end;
$$;
create trigger tenant_config_guard before update or delete on public.tenant_config_versions for each row execute function public.tenant_config_guard();

create function public.tenant_config_defaults(p_kind text) returns jsonb language sql immutable set search_path = public as $$
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
    when 'roles' then '{"roles":{"tenant_admin":["cms.read","cms.edit","cms.publish","applications.read","applications.review","members.manage","domains.manage","config.manage"],"editor":["cms.read","cms.edit","cms.publish"],"staff":["cms.read","applications.read","applications.review"],"viewer":["cms.read","applications.read"]}}'::jsonb
    when 'integration' then '{"integrations":[]}'::jsonb
    when 'branding' then '{"primaryColor":"#2563eb","headingFont":"Arial","bodyFont":"Arial"}'::jsonb
  end;
$$;

create function public.tenant_config_validate(p_kind text, p_config jsonb) returns void language plpgsql set search_path = public as $$
declare
  statuses constant text[] := array['draft','submitted','under_review','action_required','offer_issued','offer_accepted','coe_issued','enrolled','rejected','withdrawn'];
  terminal constant text[] := array['enrolled','rejected','withdrawn'];
  tenant_roles constant text[] := array['tenant_admin','editor','staff','viewer'];
  perms constant text[] := array['cms.read','cms.edit','cms.publish','applications.read','applications.review','members.manage','domains.manage','config.manage'];
  providers constant text[] := array['openai','azure','postmark','stripe'];
  fonts constant text[] := array['Arial','Georgia','Verdana','system-ui'];
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
        seen := seen || r;
      end loop;
    end loop;
    if not (p_config->'roles' ? 'tenant_admin') or not ((p_config->'roles'->'tenant_admin') @> '["members.manage","config.manage"]'::jsonb) then
      raise exception 'Institution administrators must keep member and configuration management' using errcode = '22023';
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
  else
    raise exception 'Unknown configuration kind' using errcode = '22023';
  end if;
end;
$$;

create function public.tenant_config_save_draft(p_tenant uuid, p_kind text, p_config jsonb, p_base_version integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_current integer;
begin
  if not public.tenant_has_role(p_tenant, array['tenant_admin']) then raise exception 'Tenant administration required' using errcode = '42501'; end if;
  perform public.tenant_config_validate(p_kind, p_config);
  perform 1 from public.tenants where id = p_tenant for update;
  select coalesce(max(version), 0) into v_current from public.tenant_config_versions where tenant_id = p_tenant and kind = p_kind and state <> 'draft';
  if coalesce(p_base_version, 0) <> v_current then raise exception 'Configuration changed since it was loaded' using errcode = '40001'; end if;
  insert into public.tenant_config_versions(tenant_id, kind, state, config, created_by) values (p_tenant, p_kind, 'draft', p_config, auth.uid())
  on conflict (tenant_id, kind) where state = 'draft' do update set config = excluded.config, restored_from = null, created_by = auth.uid(), created_at = now();
  insert into public.tenant_access_audit(tenant_id, actor, action, details) values (p_tenant, auth.uid(), 'config_draft', jsonb_build_object('kind', p_kind, 'baseVersion', v_current));
  return jsonb_build_object('kind', p_kind, 'baseVersion', v_current, 'draft', true);
end;
$$;

create function public.tenant_config_publish(p_tenant uuid, p_kind text, p_base_version integer) returns integer
language plpgsql security definer set search_path = public as $$
declare v_current integer; v_draft public.tenant_config_versions; v_next integer;
begin
  if not public.tenant_has_role(p_tenant, array['tenant_admin']) then raise exception 'Tenant administration required' using errcode = '42501'; end if;
  perform 1 from public.tenants where id = p_tenant for update;
  select * into v_draft from public.tenant_config_versions where tenant_id = p_tenant and kind = p_kind and state = 'draft' for update;
  if not found then raise exception 'There is no draft to publish' using errcode = '22023'; end if;
  perform public.tenant_config_validate(p_kind, v_draft.config);
  select coalesce(max(version), 0) into v_current from public.tenant_config_versions where tenant_id = p_tenant and kind = p_kind and state <> 'draft';
  if coalesce(p_base_version, 0) <> v_current then raise exception 'Configuration changed since it was loaded' using errcode = '40001'; end if;
  v_next := v_current + 1;
  update public.tenant_config_versions set state = 'superseded' where tenant_id = p_tenant and kind = p_kind and state = 'published';
  update public.tenant_config_versions set state = 'published', version = v_next, published_by = auth.uid(), published_at = now() where id = v_draft.id;
  insert into public.tenant_access_audit(tenant_id, actor, action, details)
  values (p_tenant, auth.uid(), 'config_publish', jsonb_build_object('kind', p_kind, 'version', v_next, 'restoredFrom', v_draft.restored_from));
  return v_next;
end;
$$;

create function public.tenant_config_restore(p_tenant uuid, p_kind text, p_version integer) returns void
language plpgsql security definer set search_path = public as $$
declare v_old public.tenant_config_versions;
begin
  if not public.tenant_has_role(p_tenant, array['tenant_admin']) then raise exception 'Tenant administration required' using errcode = '42501'; end if;
  perform 1 from public.tenants where id = p_tenant for update;
  select * into v_old from public.tenant_config_versions where tenant_id = p_tenant and kind = p_kind and version = p_version and state <> 'draft';
  if not found then raise exception 'Version not found' using errcode = 'P0002'; end if;
  perform public.tenant_config_validate(p_kind, v_old.config);
  insert into public.tenant_config_versions(tenant_id, kind, state, config, restored_from, created_by) values (p_tenant, p_kind, 'draft', v_old.config, p_version, auth.uid())
  on conflict (tenant_id, kind) where state = 'draft' do update set config = excluded.config, restored_from = excluded.restored_from, created_by = auth.uid(), created_at = now();
  insert into public.tenant_access_audit(tenant_id, actor, action, details) values (p_tenant, auth.uid(), 'config_restore', jsonb_build_object('kind', p_kind, 'fromVersion', p_version));
end;
$$;

create function public.tenant_config_overview(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare k text; result jsonb := '{}'::jsonb;
begin
  if not public.tenant_has_role(p_tenant, array['tenant_admin']) then raise exception 'Tenant administration required' using errcode = '42501'; end if;
  foreach k in array array['workflow', 'roles', 'integration', 'branding'] loop
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

-- Effective configuration: the published version, else the built-in defaults. Workflow and branding
-- are readable by anyone with access to the institution; roles and integration only by its administrators.
create function public.tenant_config_effective(p_tenant uuid, p_kind text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_row public.tenant_config_versions;
begin
  if p_kind not in ('workflow', 'roles', 'integration', 'branding') then raise exception 'Unknown configuration kind' using errcode = '22023'; end if;
  if not (case when p_kind in ('workflow', 'branding') then public.tenant_can_access(p_tenant) else public.tenant_has_role(p_tenant, array['tenant_admin']) end) then
    raise exception 'Not authorised for this configuration' using errcode = '42501';
  end if;
  select * into v_row from public.tenant_config_versions where tenant_id = p_tenant and kind = p_kind and state = 'published';
  if found then return jsonb_build_object('version', v_row.version, 'source', 'published', 'config', v_row.config); end if;
  return jsonb_build_object('version', 0, 'source', 'default', 'config', public.tenant_config_defaults(p_kind));
end;
$$;

alter table public.enrollment_applications add column workflow_version_id uuid references public.tenant_config_versions(id);
create function public.tenant_pin_workflow_version() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then new.workflow_version_id := old.workflow_version_id; return new; end if;
  new.workflow_version_id := case when new.tenant_id is null then null
    else (select id from public.tenant_config_versions where tenant_id = new.tenant_id and kind = 'workflow' and state = 'published') end;
  return new;
end;
$$;
create trigger tenant_pin_workflow before insert or update on public.enrollment_applications for each row execute function public.tenant_pin_workflow_version();

revoke all on function public.tenant_config_guard(), public.tenant_config_defaults(text), public.tenant_config_validate(text, jsonb), public.tenant_pin_workflow_version(),
  public.tenant_config_save_draft(uuid, text, jsonb, integer), public.tenant_config_publish(uuid, text, integer), public.tenant_config_restore(uuid, text, integer),
  public.tenant_config_overview(uuid), public.tenant_config_effective(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.tenant_config_save_draft(uuid, text, jsonb, integer), public.tenant_config_publish(uuid, text, integer), public.tenant_config_restore(uuid, text, integer),
  public.tenant_config_overview(uuid), public.tenant_config_effective(uuid, text) to authenticated;

commit;
