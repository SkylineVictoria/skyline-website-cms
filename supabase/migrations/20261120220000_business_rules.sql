-- Versioned policies. The empty legacy scope is the existing unbound Skyline site,
-- while verified institution hosts use their own tenant membership and scope.
begin;

create table public.business_rule_categories (
  id uuid primary key default gen_random_uuid(), scope_key text not null,
  name text not null check (length(btrim(name)) between 1 and 100),
  unique (scope_key, id)
);
create unique index business_rule_category_name on public.business_rule_categories(scope_key, lower(name));

create table public.business_rules (
  id uuid primary key default gen_random_uuid(), scope_key text not null,
  identifier text not null check (identifier ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  registration jsonb, unique(scope_key, identifier)
);

create table public.business_rule_versions (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.business_rules(id),
  version integer not null,
  state text not null check (state in ('draft', 'published', 'superseded')),
  origin text not null check (origin in ('migration', 'administrator', 'rollback')),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  starts_on date not null, ends_on date,
  created_by uuid, created_at timestamptz not null default clock_timestamp(),
  approved_by uuid, published_by uuid, published_at timestamptz,
  unique(rule_id, version), check(ends_on is null or ends_on >= starts_on)
);
create unique index business_rule_single_draft on public.business_rule_versions(rule_id) where state = 'draft';
create index business_rule_effective on public.business_rule_versions(rule_id, starts_on desc, version desc) where state = 'published';

create table public.business_rule_conditions (
  version_id uuid not null references public.business_rule_versions(id),
  group_order integer not null,
  condition_order integer not null,
  field_key text not null, comparison text not null, operand jsonb,
  primary key(version_id, group_order, condition_order)
);
create table public.business_rule_actions (
  version_id uuid not null references public.business_rule_versions(id),
  branch text not null check (branch in ('then', 'else')),
  handler text not null check (handler in ('use_value', 'none')),
  primary key(version_id, branch)
);
create table public.business_rule_audit_logs (
  id uuid primary key default gen_random_uuid(), scope_key text not null,
  rule_id uuid references public.business_rules(id),
  action text not null, actor uuid, reason text not null, before_data jsonb, after_data jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index business_rule_history on public.business_rule_audit_logs(scope_key, created_at desc);

create table public.business_rule_field_registry (
  scope text not null, key text not null, label text not null,
  value_type text not null check (value_type in ('number', 'text', 'boolean', 'date')),
  primary key(scope, key)
);

do $$
declare relation text;
begin
  foreach relation in array array['business_rule_categories','business_rules','business_rule_versions','business_rule_conditions','business_rule_actions','business_rule_audit_logs','business_rule_field_registry'] loop
    execute format('alter table public.%I enable row level security', relation);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', relation);
  end loop;
end $$;
-- No direct grants or policies. Scoped, allowlisted commands are the only client interface.

create function public.business_rule_category_defaults() returns text[]
language sql immutable set search_path = '' as $$
  select array['Academic & Attendance','Courses & Units','Intakes & Scheduling','Batches & Class Capacity',
    'Student Management','Assessments','LMS Content & Uploads','CRM & Admissions','Agents','Finance & Payments',
    'HRMS','Documents & Signatures','CMS Website','Communications','Other'];
$$;

create function public.business_rule_assert_value(kind text, val jsonb, options jsonb default '[]') returns void
language plpgsql immutable set search_path = '' as $$
declare str text := val #>> '{}';
begin
  if val is null or val = 'null' or jsonb_typeof(options) is distinct from 'array' then
    raise exception 'Enter a valid rule value.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(options) t where jsonb_typeof(t) <> 'string' or btrim(t #>> '{}') = '')
     or (select count(*) from jsonb_array_elements(options)) <> (select count(distinct t) from jsonb_array_elements(options) t) then
    raise exception 'Enter distinct, nonempty options.' using errcode = '22023';
  end if;
  case kind
    when 'number','percentage','days','hours','weeks','currency' then
      if jsonb_typeof(val) <> 'number' then raise exception 'Enter a numeric value.' using errcode = '22023'; end if;
      if (kind = 'percentage' and str::numeric not between 0 and 100)
        or (kind in ('days','hours','weeks') and str::numeric < 0) then
        raise exception 'The value is outside the range for this type.' using errcode = '22023';
      end if;
    when 'text' then
      if jsonb_typeof(val) <> 'string' then raise exception 'Enter a text value.' using errcode = '22023'; end if;
    when 'boolean' then
      if jsonb_typeof(val) <> 'boolean' then raise exception 'Choose Yes or No.' using errcode = '22023'; end if;
    when 'date' then
      if jsonb_typeof(val) <> 'string' or str !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Enter an ISO calendar date.' using errcode = '22023'; end if;
      perform str::date;
    when 'time' then
      if jsonb_typeof(val) <> 'string' or str !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' then
        raise exception 'Enter a valid local time.' using errcode = '22023';
      end if;
    when 'dropdown' then
      if jsonb_typeof(val) <> 'string' or not options @> jsonb_build_array(val) then
        raise exception 'Choose a listed option.' using errcode = '22023';
      end if;
    when 'multiple selection','list' then
      if jsonb_typeof(val) <> 'array' then raise exception 'Enter a list.' using errcode = '22023'; end if;
      if kind = 'multiple selection' and not options @> val then raise exception 'Select listed options.' using errcode = '22023'; end if;
    when 'json' then null;
    else raise exception 'Unsupported value type.' using errcode = '22023';
  end case;
exception when invalid_datetime_format or datetime_field_overflow then
  raise exception 'Enter a valid calendar date.' using errcode = '22023';
end;
$$;

create function public.business_rule_validate(d jsonb, p_registration jsonb) returns void
language plpgsql stable set search_path = '' as $$
declare grp jsonb; c jsonb; field_type text; op text; operand jsonb; bytes numeric;
begin
  if jsonb_typeof(d) is distinct from 'object' or octet_length(d::text) > 65536
    or coalesce(length(btrim(d->>'name')), 0) not between 1 and 160
    or coalesce(d->>'identifier','') !~ '^[a-z][a-z0-9_.-]{1,99}$'
    or coalesce(d->>'scope','') !~ '^[a-z][a-z0-9_/-]{0,100}$'
    or coalesce(length(btrim(d->>'entity')),0) not between 1 and 100
    or jsonb_typeof(d->'enabled') is distinct from 'boolean'
    or jsonb_typeof(d->'approval_required') is distinct from 'boolean'
    or coalesce(d->>'match','') not in ('all','any')
    or coalesce(d->>'then_action','') not in ('use_value','none')
    or coalesce(d->>'else_action','') not in ('use_value','none')
    or coalesce(d->>'priority','') !~ '^-?[0-9]{1,9}$'
    or (coalesce(d->>'source_url','') <> '' and d->>'source_url' !~ '^https://[^[:space:]]+$') then
    raise exception 'Check the required fields, priority, source URL and actions.' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_object_keys(d)) <> 20 or not d ?& array[
    'name','identifier','category_id','scope','entity','description','value_type','value','options','groups','match',
    'then_action','else_action','priority','starts_on','ends_on','enabled','approval_required','source_url','notes'
  ] then raise exception 'Invalid rule definition. Refresh and try again.' using errcode = '22023'; end if;

  perform public.business_rule_assert_value(d->>'value_type', d->'value', d->'options');
  perform public.business_rule_assert_value('date', d->'starts_on');
  if coalesce(d->>'ends_on','') <> '' then
    perform public.business_rule_assert_value('date', d->'ends_on');
    if (d->>'ends_on')::date < (d->>'starts_on')::date then raise exception 'End date must be on or after the start date.' using errcode = '22023'; end if;
  end if;

  if jsonb_typeof(d->'groups') is distinct from 'array' or jsonb_array_length(d->'groups') > 20 then
    raise exception 'Use up to 20 condition groups.' using errcode = '22023';
  end if;
  if p_registration is not null then
    if (d->>'scope',d->>'entity',d->>'value_type') is distinct from
       (p_registration->>'scope',p_registration->>'entity',p_registration->>'value_type') then
      raise exception 'This rule is bound to its registered menu, entity and value type.' using errcode = '22023';
    end if;
    if p_registration->>'handler' = 'upload_size' then
      bytes := (d->>'value')::numeric;
      if bytes < 1 or bytes <> trunc(bytes) or bytes > (p_registration->>'maximum')::numeric then
        raise exception 'Enter a whole number of bytes within the Storage upload ceiling.' using errcode = '22023';
      end if;
    else
      raise exception 'Unknown registered workflow handler.' using errcode = '22023';
    end if;
  end if;

  for grp in select value from jsonb_array_elements(d->'groups') loop
    if coalesce(grp->>'match','') not in ('all','any') or jsonb_typeof(grp->'conditions') is distinct from 'array'
      or jsonb_array_length(grp->'conditions') not between 1 and 20 then
      raise exception 'Each condition group must contain 1 to 20 conditions.' using errcode = '22023';
    end if;
    for c in select value from jsonb_array_elements(grp->'conditions') loop
      select value_type into field_type from public.business_rule_field_registry where scope = d->>'scope' and key = c->>'field';
      if not found then raise exception 'Choose a registered field for this menu.' using errcode = '22023'; end if;
      op := c->>'operator';
      operand := c->'operand';
      if op is null or (case
        when field_type = 'number' then op not in ('equals','not equals','greater than','less than','between','is empty','is not empty')
        when field_type = 'date' then op not in ('equals','not equals','before','after','between','is empty','is not empty')
        when field_type = 'text' then op not in ('equals','not equals','contains','does not contain','is empty','is not empty')
        else op not in ('equals','not equals','is empty','is not empty') end) then
        raise exception 'This comparison is unavailable for the selected field type.' using errcode = '22023';
      end if;
      if op = 'between' then
        if jsonb_typeof(operand) is distinct from 'array' or jsonb_array_length(operand) <> 2 then
          raise exception 'Enter both ends of the range.' using errcode = '22023';
        end if;
        perform public.business_rule_assert_value(field_type, operand->0);
        perform public.business_rule_assert_value(field_type, operand->1);
        if operand->0 > operand->1 then raise exception 'The end of the range must follow the start.' using errcode = '22023'; end if;
      elsif op not in ('is empty','is not empty') then
        perform public.business_rule_assert_value(field_type, operand);
      end if;
    end loop;
  end loop;
end;
$$;

create function public.business_rule_compare(lhs jsonb, op text, rhs jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when op = 'is empty' then lhs is null or lhs in ('null', '""', '[]', '{}')
    when op = 'is not empty' then lhs is not null and lhs not in ('null', '""', '[]', '{}')
    when lhs is null or lhs = 'null' then false
    when op = 'equals' then lhs = rhs
    when op = 'not equals' then lhs <> rhs
    when op in ('greater than','after') then lhs > rhs
    when op in ('less than','before') then lhs < rhs
    when op = 'contains' then strpos(lhs #>> '{}', rhs #>> '{}') > 0
    when op = 'does not contain' then strpos(lhs #>> '{}', rhs #>> '{}') = 0
    when op = 'between' then lhs between rhs->0 and rhs->1
    else false end;
$$;

create function public.business_rule_preview(d jsonb, context jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare grp jsonb; c jsonb; field_type text; supplied jsonb; passed boolean; matched boolean;
  outcome boolean := d->>'match' = 'all'; handler text;
begin
  if jsonb_typeof(context) is distinct from 'object' or octet_length(context::text) > 65536 then
    raise exception 'Use a valid sample record.' using errcode = '22023';
  end if;
  if jsonb_array_length(d->'groups') = 0 then outcome := true; end if;
  for grp in select value from jsonb_array_elements(d->'groups') loop
    matched := grp->>'match' = 'all';
    for c in select value from jsonb_array_elements(grp->'conditions') loop
      supplied := context -> (c->>'field');
      if supplied is not null and supplied <> 'null' then
        select value_type into strict field_type from public.business_rule_field_registry where scope = d->>'scope' and key = c->>'field';
        perform public.business_rule_assert_value(field_type, supplied);
      end if;
      passed := public.business_rule_compare(supplied, c->>'operator', c->'operand');
      matched := case grp->>'match' when 'all' then matched and passed else matched or passed end;
    end loop;
    outcome := case d->>'match' when 'all' then outcome and matched else outcome or matched end;
  end loop;
  handler := d->>(case when outcome then 'then_action' else 'else_action' end);
  return jsonb_build_object('matched', outcome, 'action', handler, 'value', case when handler = 'use_value' then d->'value' end);
end;
$$;

create function public.business_rule_evaluate(p_scope_key text, p_identifier text, p_context jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d jsonb; local_date date := (statement_timestamp() at time zone 'Australia/Melbourne')::date;
begin
  select v.definition into d from public.business_rules r
  join public.business_rule_versions v on v.rule_id = r.id
  where r.scope_key = p_scope_key and r.identifier = p_identifier and v.state = 'published'
    and v.starts_on <= local_date and (v.ends_on is null or v.ends_on >= local_date)
  -- Later effective versions take precedence. Priority resolves overlapping versions with the same start.
  order by v.starts_on desc, (v.definition->>'priority')::integer desc, v.version desc limit 1;
  if d is null or not (d->>'enabled')::boolean then return null; end if;
  return public.business_rule_preview(d, p_context)->'value';
exception when others then
  raise log 'Business rule evaluation failed for identifier %, SQLSTATE %', p_identifier, sqlstate;
  raise exception 'Business rule configuration could not be evaluated. Contact an administrator.' using errcode = '22023';
end;
$$;

create function public.business_rule_register(p_scope_key text, p_identifier text, p_registration jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare row_id uuid; existing jsonb;
begin
  insert into public.business_rules(scope_key,identifier,registration) values (p_scope_key,p_identifier,p_registration)
  on conflict (scope_key, identifier) do nothing;
  select id,registration into strict row_id,existing from public.business_rules where scope_key = p_scope_key and identifier = p_identifier;
  if existing is distinct from p_registration then
    raise exception 'Rule schema changed. Add an explicit schema migration for %.', p_identifier using errcode = '22023';
  end if;
  return row_id;
end;
$$;

create function public.business_rule_index_version(p_version uuid, d jsonb) returns void
language plpgsql set search_path = '' as $$
begin
  insert into public.business_rule_conditions(version_id,group_order,condition_order,field_key,comparison,operand)
    select p_version, g.position, c.position, c.item->>'field', c.item->>'operator', c.item->'operand'
    from jsonb_array_elements(d->'groups') with ordinality g(item,position)
    cross join lateral jsonb_array_elements(g.item->'conditions') with ordinality c(item,position);
  insert into public.business_rule_actions(version_id,branch,handler)
    values (p_version,'then',d->>'then_action'),(p_version,'else',d->>'else_action');
end;
$$;

create function public.business_rules_admin(p_command text, p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare tenant uuid := public.tenant_current(); scope_id text := coalesce(tenant::text, '');
  actor_id uuid := auth.uid(); r public.business_rules; latest public.business_rule_versions; target public.business_rule_versions;
  id_value uuid; d jsonb := p_payload->'definition'; previous jsonb; current_policy jsonb; category_name text;
  reason text := btrim(coalesce(p_payload->>'reason','')); stamp date := (statement_timestamp() at time zone 'Australia/Melbourne')::date;
begin
  if actor_id is null or not coalesce(public.tenant_scope(tenant),false)
    or not coalesce(case when tenant is null then public.cms_is_admin()
      else public.tenant_has_role(tenant,array['tenant_admin']) end,false) then
    raise exception 'Business Rules administrator access is required.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text) > 140000 then
    raise exception 'Invalid rule request.' using errcode = '22023';
  end if;

  if p_command = 'list' then
    -- Initialize a tenant's editable category labels once. A rename is preserved.
    perform pg_advisory_xact_lock(hashtextextended('business_rule_categories:' || scope_id,0));
    if not exists (select 1 from public.business_rule_categories where scope_key = scope_id) then
      insert into public.business_rule_categories(scope_key,name) select scope_id, unnest(public.business_rule_category_defaults());
    end if;
    return jsonb_build_object(
      'categories', coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name)
        from public.business_rule_categories where scope_key = scope_id), '[]'),
      'rules', coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'identifier',q.identifier,'registration',q.registration,'versions',vs.items) order by q.identifier)
        from public.business_rules q cross join lateral
          (select jsonb_agg(to_jsonb(v) order by v.version desc) items from public.business_rule_versions v where v.rule_id = q.id) vs
        where q.scope_key = scope_id and vs.items is not null), '[]'),
      'fields', coalesce((select jsonb_agg(to_jsonb(f) order by f.scope, f.label) from public.business_rule_field_registry f), '[]'),
      'history', coalesce((select jsonb_agg(to_jsonb(h) order by h.created_at desc)
        from (select * from public.business_rule_audit_logs where scope_key = scope_id order by created_at desc limit 200) h), '[]')
    );
  end if;

  if p_command = 'category' then
    category_name := btrim(coalesce(p_payload->>'name',''));
    if length(category_name) not between 1 and 100 then raise exception 'Enter a category name.' using errcode = '22023'; end if;
    id_value := nullif(p_payload->>'id','')::uuid;
    if id_value is null then
      insert into public.business_rule_categories(scope_key,name) values (scope_id,category_name) returning id into id_value;
    else
      select to_jsonb(c) into previous from public.business_rule_categories c where c.id = id_value and c.scope_key = scope_id for update;
      if not found then raise exception 'Category unavailable.' using errcode = '42501'; end if;
      update public.business_rule_categories set name = category_name where id = id_value and scope_key = scope_id;
    end if;
    insert into public.business_rule_audit_logs(scope_key,action,actor,reason,before_data,after_data)
      values(scope_id,'category',actor_id,'Category saved',previous,jsonb_build_object('id',id_value,'name',category_name));
    return jsonb_build_object('category_id',id_value);
  end if;

  if p_command = 'preview' then
    select registration into r.registration from public.business_rules where scope_key = scope_id and identifier = d->>'identifier';
    perform public.business_rule_validate(d, r.registration);
    return public.business_rule_preview(d, coalesce(p_payload->'context','{}'));
  end if;

  if p_command is null or p_command not in ('save','approve','publish','rollback') or length(reason) not between 1 and 2000 then
    raise exception 'Enter a reason for this change.' using errcode = '22023';
  end if;
  if p_command = 'save' and p_payload->>'rule_id' is null then
    perform public.business_rule_validate(d, null);
    insert into public.business_rules(scope_key,identifier) values (scope_id,d->>'identifier') returning * into r;
  else
    select * into r from public.business_rules where id = (p_payload->>'rule_id')::uuid and scope_key = scope_id for update;
    if not found then raise exception 'Rule unavailable.' using errcode = '42501'; end if;
    select * into latest from public.business_rule_versions where rule_id = r.id order by version desc limit 1;
    if latest.id is distinct from (p_payload->>'expected_version')::uuid then
      raise exception 'This rule changed in another session. Refresh before editing.' using errcode = '40001';
    end if;
  end if;
  previous := latest.definition;

  if p_command = 'rollback' then
    select * into target from public.business_rule_versions where id = (p_payload->>'target_version')::uuid
      and rule_id = r.id and published_at is not null;
    if not found then raise exception 'Choose a previously published version.' using errcode = '22023'; end if;
    d := target.definition || jsonb_build_object('starts_on',stamp,'ends_on','');
  elsif p_command in ('approve','publish') then
    if latest.state is distinct from 'draft' or d is distinct from latest.definition then
      raise exception 'Save your edits as a draft before continuing.' using errcode = '22023';
    end if;
  end if;
  select v.definition into current_policy
    from public.business_rule_versions v where v.rule_id = r.id and v.state = 'published'
      and v.starts_on <= stamp and (v.ends_on is null or v.ends_on >= stamp)
    order by v.starts_on desc, (v.definition->>'priority')::integer desc, v.version desc limit 1;
  perform public.business_rule_validate(d, r.registration);
  if d->>'identifier' <> r.identifier then raise exception 'The rule identifier is immutable.' using errcode = '22023'; end if;
  if not exists (select 1 from public.business_rule_categories where id = (d->>'category_id')::uuid and scope_key = scope_id) then
    raise exception 'Choose a category in your institution.' using errcode = '22023';
  end if;

  if p_command in ('save','rollback') then
    update public.business_rule_versions set state = 'superseded' where rule_id = r.id and state = 'draft';
    insert into public.business_rule_versions(rule_id,version,state,origin,definition,starts_on,ends_on,created_by)
      values (r.id,coalesce(latest.version,0)+1,'draft',case p_command when 'rollback' then 'rollback' else 'administrator' end,
        d,(d->>'starts_on')::date,nullif(d->>'ends_on','')::date,actor_id) returning id into id_value;
    perform public.business_rule_index_version(id_value,d);
  elsif p_command = 'approve' then
    if not ((d->>'approval_required')::boolean or coalesce((current_policy->>'approval_required')::boolean,false))
      or latest.created_by is null or actor_id = latest.created_by then
      raise exception 'A different administrator must approve this draft.' using errcode = '42501';
    end if;
    update public.business_rule_versions set approved_by = actor_id where id = latest.id;
  else
    previous := current_policy;
    if ((d->>'approval_required')::boolean or coalesce((current_policy->>'approval_required')::boolean,false))
      and latest.approved_by is null then
      raise exception 'A second administrator must approve this draft before publishing.' using errcode = '42501';
    end if;
    if latest.starts_on < stamp then raise exception 'Set the effective start date to today or later.' using errcode = '22023'; end if;
    if exists (select 1 from public.business_rule_versions v where v.rule_id = r.id and v.state = 'published'
      and v.starts_on > stamp and v.starts_on = latest.starts_on and (v.definition->>'priority')::integer = (d->>'priority')::integer) then
      raise exception 'A scheduled version already has this date and priority. Choose a different date or priority.' using errcode = '22023';
    end if;
    update public.business_rule_versions set state = 'superseded'
      where rule_id = r.id and state = 'published' and starts_on = latest.starts_on and starts_on <= stamp;
    update public.business_rule_versions set state = 'published', published_by = actor_id, published_at = clock_timestamp() where id = latest.id;
  end if;
  insert into public.business_rule_audit_logs(scope_key,rule_id,action,actor,reason,before_data,after_data)
    values(scope_id,r.id,p_command,actor_id,reason,previous,d);
  return jsonb_build_object('rule_id',r.id);
exception when unique_violation then
  raise exception 'This identifier or category name is already in use.' using errcode = '23505';
when invalid_text_representation then
  raise exception 'Choose a valid category or rule version.' using errcode = '22023';
end;
$$;

revoke all on function public.business_rule_category_defaults(), public.business_rule_assert_value(text,jsonb,jsonb),
  public.business_rule_validate(jsonb,jsonb), public.business_rule_compare(jsonb,text,jsonb),
  public.business_rule_preview(jsonb,jsonb), public.business_rule_evaluate(text,text,jsonb),
  public.business_rule_register(text,text,jsonb), public.business_rule_index_version(uuid,jsonb),
  public.business_rules_admin(text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.business_rules_admin(text,jsonb) to authenticated;

insert into public.admin_menu_items(id,parent_id,label,route,icon_key,sort_order,is_enabled,permission_key,permission_scope,is_system)
values ('business_rules','administration','Business Rules & Policies','/admin/business-rules','settings',30,true,'cms.admin','current',true);

commit;
