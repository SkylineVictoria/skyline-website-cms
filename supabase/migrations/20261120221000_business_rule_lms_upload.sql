-- Integration for new unit learning files. The bucket remains the infrastructure
-- ceiling and the documented continuity value until a SLIT policy is effective.
begin;

insert into public.business_rule_field_registry(scope,key,label,value_type) values
 ('lms/courses','unit.id','Unit · identifier','text'),
 ('lms/courses','course.id','Related course · identifier','text'),
 ('lms/courses','file.extension','File · extension','text');

insert into public.business_rule_categories(scope_key,name)
select '', unnest(public.business_rule_category_defaults())
on conflict do nothing;

do $$
declare rule uuid; category uuid; maximum bigint; version_id uuid; d jsonb;
  start_date date := (statement_timestamp() at time zone 'Australia/Melbourne')::date;
begin
  select file_size_limit into strict maximum from storage.buckets where id = 'unit-content';
  if maximum is null then raise exception 'The unit-content Storage ceiling must be set'; end if;

  rule := public.business_rule_register('', 'lms.unit_upload_max_bytes',
    jsonb_build_object('scope','lms/courses','entity','unit_content_file','value_type','number',
      'schema_version',1,'handler','upload_size','maximum',maximum));

  select id into strict category from public.business_rule_categories where scope_key = '' and name = 'LMS Content & Uploads';
  d := jsonb_build_object(
    'name','LMS learning file upload limit (bytes)','identifier','lms.unit_upload_max_bytes','category_id',category,
    'scope','lms/courses','entity','unit_content_file','description','Maximum size in bytes of a new learning file attached to a unit.',
    'value_type','number','value',maximum,'options','[]'::jsonb,'groups','[]'::jsonb,'match','all',
    'then_action','use_value','else_action','none','priority',0,'starts_on',start_date,'ends_on','',
    'enabled',true,'approval_required',false,'source_url','',
    'notes','Imported from the existing Storage bucket as an unapproved draft. The Storage ceiling still applies to every upload.');
  perform public.business_rule_validate(d, (select registration from public.business_rules where id = rule));
  insert into public.business_rule_versions(rule_id,version,state,origin,definition,starts_on)
    values (rule,1,'draft','migration',d,start_date) on conflict (rule_id,version) do nothing returning id into version_id;
  if version_id is not null then
    perform public.business_rule_index_version(version_id,d);
    insert into public.business_rule_audit_logs(scope_key,rule_id,action,reason,after_data)
      values('',rule,'migration','Imported existing Storage limit for SLIT review.',d);
  end if;
end $$;

create function public.unit_learning_file_limit(p_unit_id text, p_extension text) returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare unit_record record; maximum bigint; configured jsonb;
begin
  if auth.uid() is null or not coalesce(public.unit_content_can_edit(),false) then
    raise exception 'Learning content edit permission is required.' using errcode = '42501';
  end if;
  select tenant_id,course_id into unit_record from public.cms_course_units where id = p_unit_id;
  if not found or not coalesce(public.tenant_scope(unit_record.tenant_id),false) then
    raise exception 'Unit unavailable.' using errcode = '42501';
  end if;
  select file_size_limit into maximum from storage.buckets where id = 'unit-content';
  if maximum is null then
    raise exception 'The Storage upload limit is unavailable. Contact an administrator.' using errcode = '22023';
  end if;
  configured := public.business_rule_evaluate(coalesce(unit_record.tenant_id::text, ''),'lms.unit_upload_max_bytes',
    jsonb_build_object('unit.id',p_unit_id,'course.id',unit_record.course_id,'file.extension',p_extension));
  if configured is null or configured = 'null' then return maximum; end if;
  if jsonb_typeof(configured) <> 'number' or (configured #>> '{}')::numeric < 1
     or (configured #>> '{}')::numeric <> trunc((configured #>> '{}')::numeric) then
    raise log 'Invalid effective value for lms.unit_upload_max_bytes';
    raise exception 'The configured learning file limit is invalid. Contact an administrator.' using errcode = '22023';
  end if;
  return least(maximum,(configured #>> '{}')::bigint);
end;
$$;
revoke all on function public.unit_learning_file_limit(text,text) from public, anon, authenticated, service_role;
grant execute on function public.unit_learning_file_limit(text,text) to authenticated;

create function public.unit_learning_file_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare actual_size bigint; effective_limit bigint; extension text;
begin
  if new.kind <> 'file' then return new; end if;
  if tg_op = 'UPDATE' and (old.kind,old.storage_path,old.size_bytes,old.unit_id) is not distinct from
    (new.kind,new.storage_path,new.size_bytes,new.unit_id) then return new; end if;

  if split_part(new.storage_path,'/',1) is distinct from new.unit_id then
    raise exception 'The file must belong to this unit.' using errcode = '22023';
  end if;
  select case when metadata->>'size' ~ '^[0-9]{1,18}$' then (metadata->>'size')::bigint end
    into actual_size from storage.objects where bucket_id = 'unit-content' and name = new.storage_path;
  if actual_size is null or actual_size <= 0 then
    raise exception 'Upload a valid file before attaching it.' using errcode = '22023';
  end if;
  extension := substring(lower(new.storage_path) from '\.([a-z0-9]+)$');
  effective_limit := public.unit_learning_file_limit(new.unit_id,extension);
  if actual_size > effective_limit then
    raise exception 'The file exceeds the published learning content limit of % bytes.', effective_limit using errcode = '22023';
  end if;
  new.size_bytes := actual_size;
  return new;
end;
$$;
revoke all on function public.unit_learning_file_check() from public, anon, authenticated, service_role;
create trigger unit_learning_file_policy before insert or update on public.unit_contents
for each row execute function public.unit_learning_file_check();

commit;
