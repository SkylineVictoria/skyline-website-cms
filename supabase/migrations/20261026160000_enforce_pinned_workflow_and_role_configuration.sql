-- P06-04: enforce the pinned workflow version and the published role configuration server-side.
-- Roles: tenant_has_role(tenant, roles[]) is what every RLS policy and RPC already calls. The three role
-- sets the policies use are now bound to configurable permissions (their DEFAULT holders are exactly those
-- role sets, so nothing changes until a roles configuration is published):
--   {tenant_admin, editor}          = cms.edit
--   {tenant_admin, editor, staff}   = cms.read
--   {tenant_admin, staff}           = applications.review
-- tenant_admin always passes these checks (no lockout); platform administrators are unaffected; any other
-- role array (including the all-roles membership check) keeps its literal meaning. members.manage,
-- domains.manage and config.manage are reserved for tenant_admin and cannot be given to other roles.
-- A published roles configuration overrides per role; a role it omits keeps its default permissions.
-- Workflow: portal_set_application_status reads the workflow version pinned on the application. Without a
-- pin (legacy and not-yet-configured institutions) the original hard-coded transitions apply unchanged.
-- Configured transitions can never leave 'draft' (submission keeps its validated command) and may be
-- limited to roles; a transition that names roles also admits platform administrators.
--
-- Rollback / compensation (additive; run manually to return to the 20261026150000 behavior):
--   Re-create public.tenant_has_role(uuid, text[]) as in 20261024175010 (role = any(p_roles) only),
--   re-create public.portal_set_application_status as in 20261025154647, then:
--   drop function if exists public.tenant_role_permission(uuid, text, text), public.tenant_roles_permission(text[]),
--     public.portal_legacy_transition_allowed(text, text), public.portal_pinned_transition_allowed(jsonb, text, text, text, boolean);
--   and re-create public.tenant_config_defaults / tenant_config_validate from 20261026150000.
-- Never applied to the hosted project without release approval.
begin;

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
  else
    raise exception 'Unknown configuration kind' using errcode = '22023';
  end if;
end;
$$;

create function public.tenant_roles_permission(p_roles text[]) returns text language sql immutable set search_path = public as $$
  select case (select array_agg(distinct x order by x) from unnest(p_roles) x)
    when array['editor','tenant_admin'] then 'cms.edit'
    when array['editor','staff','tenant_admin'] then 'cms.read'
    when array['staff','tenant_admin'] then 'applications.review'
    else null end;
$$;

create function public.tenant_role_permission(p_tenant uuid, p_role text, p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select c.config->'roles'->p_role ? p_perm from public.tenant_config_versions c where c.tenant_id = p_tenant and c.kind = 'roles' and c.state = 'published' and c.config->'roles' ? p_role),
    public.tenant_config_defaults('roles')->'roles'->p_role ? p_perm, false);
$$;

create or replace function public.tenant_has_role(p_tenant uuid, p_roles text[] default array['tenant_admin','editor','staff','viewer']) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.tenants where id = p_tenant and status = 'active') and
  (public.tenant_is_platform_admin() or exists(
    select 1 from public.tenant_memberships m
    where m.tenant_id = p_tenant and m.auth_user_id = auth.uid() and m.active and
      case when public.tenant_roles_permission(p_roles) is null then m.role = any (p_roles)
           else m.role = 'tenant_admin' or public.tenant_role_permission(p_tenant, m.role, public.tenant_roles_permission(p_roles)) end));
$$;

create function public.portal_legacy_transition_allowed(p_from text, p_to text) returns boolean language sql immutable set search_path = public as $$
  select case p_from
    when 'submitted' then p_to in ('under_review','action_required','rejected','withdrawn')
    when 'under_review' then p_to in ('action_required','offer_issued','rejected','withdrawn')
    when 'action_required' then p_to in ('under_review','rejected','withdrawn')
    when 'offer_issued' then p_to in ('offer_accepted','action_required','rejected','withdrawn')
    when 'offer_accepted' then p_to in ('coe_issued','withdrawn')
    when 'coe_issued' then p_to in ('enrolled','withdrawn')
    else false end;
$$;

create function public.portal_pinned_transition_allowed(p_config jsonb, p_from text, p_to text, p_caller_role text, p_platform boolean) returns boolean
language sql immutable set search_path = public as $$
  select p_from <> 'draft' and exists (
    select 1 from jsonb_array_elements(p_config->'transitions') t
    where t->>'from' = p_from and t->>'to' = p_to
      and (not (t ? 'roles') or p_platform or (p_caller_role is not null and t->'roles' ? p_caller_role)));
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
 values(a.id,a.tenant_id,'application_status_changed',jsonb_build_object('from',a.status,'to',p_status,'actor',auth.uid()));
end; $$;

revoke all on function public.tenant_roles_permission(text[]), public.tenant_role_permission(uuid, text, text), public.portal_legacy_transition_allowed(text, text),
  public.portal_pinned_transition_allowed(jsonb, text, text, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.tenant_roles_permission(text[]), public.tenant_role_permission(uuid, text, text) to authenticated, anon;
grant execute on function public.portal_legacy_transition_allowed(text, text), public.portal_pinned_transition_allowed(jsonb, text, text, text, boolean) to authenticated;

commit;
