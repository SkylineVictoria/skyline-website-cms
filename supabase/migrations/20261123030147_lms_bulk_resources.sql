begin;

-- Technical ceilings bound edge memory and archive expansion independently of SLIT policy.
insert into storage.buckets(id, name, public, file_size_limit)
values ('lms-bulk-resources', 'lms-bulk-resources', false, 26214400);

create table public.lms_resource_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),
  created_by uuid not null,
  unit_hint text references public.cms_course_units(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.lms_resource_import_files (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.lms_resource_imports(id),
  parent_id uuid references public.lms_resource_import_files(id),
  name text not null check (length(name) between 1 and 240),
  source_path text not null check (length(source_path) between 1 and 1024),
  object_path text not null unique,
  bytes integer not null check (bytes between 1 and 26214400),
  extension text not null,
  state text not null check (state in ('uploading','queued','processing','extracted','review','failed','excluded','imported')),
  attempts integer not null default 0,
  lease uuid,
  eligible_at timestamptz not null default now(),
  sha256 text,
  result jsonb,
  usage jsonb,
  failure text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index lms_import_files_queue on public.lms_resource_import_files(eligible_at, created_at)
where state in ('queued','processing');
create index lms_import_files_job on public.lms_resource_import_files(import_id, created_at);

create table public.lms_unit_resources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),
  unit_id text not null references public.cms_course_units(id),
  file_id uuid not null unique references public.lms_resource_import_files(id),
  previous_id uuid unique references public.lms_unit_resources(id),
  title text not null check (length(title) between 1 and 240),
  category text not null check (category in ('learning','assessment','self_assessment','assessor')),
  audience text not null check (audience in ('student_staff','staff','assessor')),
  security_hold boolean not null,
  sha256 text not null,
  assessment_id uuid references public.asm_assessments(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  check ((category <> 'assessor' and not security_hold) or audience = 'assessor'),
  check (assessment_id is null or category = 'assessment')
);
create unique index lms_resource_identical on public.lms_unit_resources(unit_id, sha256);
create index lms_resource_unit on public.lms_unit_resources(unit_id, category);

create table public.lms_resource_audit (
  id bigint generated always as identity primary key,
  file_id uuid not null references public.lms_resource_import_files(id),
  actor uuid,
  action text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.lms_resource_imports enable row level security;
alter table public.lms_resource_import_files enable row level security;
alter table public.lms_unit_resources enable row level security;
alter table public.lms_resource_audit enable row level security;
revoke all on public.lms_resource_imports, public.lms_resource_import_files, public.lms_unit_resources, public.lms_resource_audit from public, anon, authenticated;
grant select on public.lms_unit_resources to authenticated;
grant select, insert, update on public.lms_resource_imports, public.lms_resource_import_files, public.lms_unit_resources to service_role;
grant select, insert on public.lms_resource_audit to service_role;

create function public.lms_bulk_policy(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare k text; v jsonb; settings jsonb := '{}';
begin
  foreach k in array array['max_mib','max_files','formats','confidence','instructions','default_audience','duplicates','allow_publication','confirm_each',
    'learning_label','assessment_label','self_assessment_label','assessor_label']
  loop
    v := public.business_rule_evaluate(coalesce(p_tenant::text,''), 'lms.bulk_' || k, '{}');
    if (v is null or v = 'null') and p_tenant is not null then
      v := public.business_rule_evaluate('', 'lms.bulk_' || k, '{}');
    end if;
    if v is null or v = 'null' then
      raise exception 'Publish the LMS bulk upload settings in Business Rules & Policies (missing %).', k using errcode = '22023';
    end if;
    settings := settings || jsonb_build_object(k, v);
  end loop;
  return settings;
end $$;

do $$
declare item record; reg jsonb; rule uuid; version_id uuid; category uuid; d jsonb;
  today date := (statement_timestamp() at time zone 'Australia/Melbourne')::date;
begin
  insert into public.business_rule_categories(scope_key,name) values ('','LMS Content & Uploads') on conflict do nothing;
  select id into strict category from public.business_rule_categories where scope_key='' and name='LMS Content & Uploads';
  for item in select * from (values
    ('lms.bulk_max_mib','Bulk upload maximum file size (MiB)','number','25','{"min":1,"max":25}'),
    ('lms.bulk_max_files','Bulk upload maximum files per import','number','400','{"min":1,"max":1000}'),
    ('lms.bulk_formats','Bulk upload allowed extensions','multiple selection','["zip","pdf","docx","pptx","xlsx","png","jpg","jpeg","webp","mp4","webm"]','{"allowed":["zip","pdf","docx","pptx","xlsx","png","jpg","jpeg","webp","mp4","webm"]}'),
    ('lms.bulk_confidence','Bulk upload minimum AI confidence (%)','number','85','{"min":0,"max":100}'),
    ('lms.bulk_instructions','Bulk upload AI classification instructions','text','"Classify Australian VET materials according to their purpose and intended audience."','{}'),
    ('lms.bulk_default_audience','Bulk upload default visibility','dropdown','"staff"','{"allowed":["staff","student_staff","assessor"]}'),
    ('lms.bulk_duplicates','Bulk upload duplicate handling','dropdown','"review"','{"allowed":["review","skip_identical"]}'),
    ('lms.bulk_allow_publication','Allow publishing imported resources','boolean','true','{}'),
    ('lms.bulk_confirm_each','Require individual review for every document','boolean','false','{}'),
    ('lms.bulk_learning_label','Learning Materials category label','text','"Learning Materials"','{}'),
    ('lms.bulk_assessment_label','Assessments category label','text','"Assessments"','{}'),
    ('lms.bulk_self_assessment_label','Self-Assessment category label','text','"Self-Assessment"','{}'),
    ('lms.bulk_assessor_label','Assessor Resources category label','text','"Assessor Resources"','{}')
  ) as x(key,label,kind,initial,limits)
  loop
    reg := jsonb_build_object('scope','lms/courses','entity','unit_bulk_resource','value_type',item.kind,
      'schema_version',1,'handler','setting') || item.limits::jsonb;
    rule := public.business_rule_register('', item.key, reg);
    d := jsonb_build_object('identifier',item.key,'name',item.label,'category_id',category,
      'scope','lms/courses','entity','unit_bulk_resource','value_type',item.kind,'value',item.initial::jsonb,
      'description',item.label,'options',case item.key
        when 'lms.bulk_formats' then item.initial::jsonb
        else coalesce(item.limits::jsonb->'allowed','[]') end,
      'groups','[]'::jsonb,'match','all','then_action','use_value','else_action','none','priority',0,
      'starts_on',today,'ends_on','','enabled',true,'approval_required',false,'source_url','','notes','SLIT must publish before first use.');
    perform public.business_rule_validate(d, reg);
    insert into public.business_rule_versions(rule_id,version,state,origin,definition,starts_on)
      values (rule,1,'draft','migration',d,today) returning id into version_id;
    perform public.business_rule_index_version(version_id,d);
    insert into public.business_rule_audit_logs(scope_key,rule_id,action,reason,after_data)
      values ('',rule,'migration','Initial bulk upload settings for SLIT approval.',d);
  end loop;
end $$;

create function public.lms_bulk_can_manage(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and coalesce(public.asm_is_admin(),false) and public.tenant_scope(p_tenant);
$$;

create function public.lms_bulk_can_read(p_tenant uuid, p_unit text, p_audience text, p_published timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and public.tenant_scope(p_tenant) and (
    public.lms_bulk_can_manage(p_tenant)
    or (p_published is not null and (
      (p_audience = 'student_staff' and p_unit in (select public.student_enrolled_unit_ids(public.portal_student_id())))
      or exists (
        select 1 from public.asm_assessments a join public.asm_assignments s on s.assessment_id = a.id
        where a.unit_id = p_unit and a.tenant_id is not distinct from p_tenant
          and public.asm_can_assess(s.id, public.asm_trainer_profile())
      )
    ))
  );
$$;
create policy lms_resource_read on public.lms_unit_resources for select to authenticated
using (public.lms_bulk_can_read(tenant_id, unit_id, audience, published_at));

create function public.lms_bulk_storage_allowed(p_path text, p_upload boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.lms_resource_import_files f
    join public.lms_resource_imports j on j.id = f.import_id
    left join public.lms_unit_resources r on r.file_id = f.id
    where f.object_path = p_path and case when p_upload then
      public.lms_bulk_can_manage(j.tenant_id) and j.created_by = auth.uid() and f.state = 'uploading'
    when r.id is not null then public.lms_bulk_can_read(r.tenant_id, r.unit_id, r.audience, r.published_at)
    else public.lms_bulk_can_manage(j.tenant_id) and f.state = 'review' end
  );
$$;
create policy lms_bulk_upload on storage.objects for insert to authenticated
with check (bucket_id = 'lms-bulk-resources' and public.lms_bulk_storage_allowed(name,true));
create policy lms_bulk_download on storage.objects for select to authenticated
using (bucket_id = 'lms-bulk-resources' and public.lms_bulk_storage_allowed(name,false));

create policy lms_bulk_read_boundary on storage.objects as restrictive for select to authenticated
using (bucket_id <> 'lms-bulk-resources' or public.lms_bulk_storage_allowed(name,false));
create policy lms_bulk_insert_boundary on storage.objects as restrictive for insert to authenticated
with check (bucket_id <> 'lms-bulk-resources' or public.lms_bulk_storage_allowed(name,true));
create policy lms_bulk_update_boundary on storage.objects as restrictive for update to authenticated
using (bucket_id <> 'lms-bulk-resources') with check (bucket_id <> 'lms-bulk-resources');
create policy lms_bulk_delete_boundary on storage.objects as restrictive for delete to authenticated
using (bucket_id <> 'lms-bulk-resources');

create function public.lms_bulk_resources(p_unit text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,'category',r.category,'audience',r.audience,
    'published_at',r.published_at,'path',f.object_path,'name',f.name,'bytes',f.bytes,'previous_id',r.previous_id,
    'assessment_id',r.assessment_id,'security_hold',r.security_hold,'unit_id',r.unit_id) order by r.created_at desc),'[]'::jsonb)
  from public.lms_unit_resources r join public.lms_resource_import_files f on f.id = r.file_id
  where (r.unit_id = p_unit or p_unit is null) and public.lms_bulk_can_read(r.tenant_id, r.unit_id, r.audience, r.published_at);
$$;

create function public.lms_bulk_admin(p_action text, p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  tenant uuid := public.tenant_current();
  job public.lms_resource_imports;
  file public.lms_resource_import_files;
  resource public.lms_unit_resources;
  previous public.lms_unit_resources;
  unit public.cms_course_units;
  settings jsonb;
  out_id uuid;
  file_name text;
  extension text;
  size_bytes integer;
  member jsonb;
  category text;
  audience text;
  held boolean;
  related uuid;
  match_count integer;
  exact_match boolean;
  answer jsonb := '[]';
begin
  if not public.lms_bulk_can_manage(tenant) then
    raise exception 'LMS administration access required.' using errcode = '42501';
  end if;
  if p_action = 'list' then
    return coalesce((select jsonb_agg(to_jsonb(j) order by created_at desc)
      from (select * from public.lms_resource_imports where tenant_id is not distinct from tenant
        order by created_at desc limit 30) j), '[]');
  end if;
  if p_action = 'catalogue' then
    return jsonb_build_object(
      'courses',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'name',c.name) order by c.code)
        from public.cms_courses c where c.tenant_id is not distinct from tenant), '[]'),
      'units',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'course_id',u.course_id,'code',u.code,'name',u.name) order by u.code)
        from public.cms_course_units u join public.cms_courses c on c.id=u.course_id
        where u.tenant_id is not distinct from tenant and c.tenant_id is not distinct from tenant), '[]'));
  end if;
  if p_action = 'policy' then return public.lms_bulk_policy(tenant); end if;
  if p_action = 'begin' then
    settings := public.lms_bulk_policy(tenant);
    if jsonb_typeof(p_data->'files') is distinct from 'array'
       or jsonb_array_length(p_data->'files') not between 1 and floor((settings->>'max_files')::numeric)::integer then
      raise exception 'The import exceeds the configured file count.';
    end if;
    if nullif(p_data->>'unit','') is not null and not exists (
      select 1 from public.cms_course_units u where u.id = p_data->>'unit' and u.tenant_id is not distinct from tenant
    ) then raise exception 'Unit unavailable.'; end if;
    insert into public.lms_resource_imports(tenant_id, created_by, unit_hint)
      values (tenant, auth.uid(), nullif(p_data->>'unit','')) returning * into job;
    for member in select value from jsonb_array_elements(p_data->'files') loop
      file_name := member->>'name';
      size_bytes := (member->>'bytes')::integer;
      extension := lower(substring(file_name from '\.([a-zA-Z0-9]+)$'));
      if not coalesce(settings->'formats' ? extension,false) then raise exception 'Unsupported file type: %', file_name; end if;
      if size_bytes not between 1 and least(25,floor((settings->>'max_mib')::numeric)::integer) * 1048576 then
        raise exception 'File exceeds the configured size: %', file_name;
      end if;
      out_id := gen_random_uuid();
      insert into public.lms_resource_import_files(id,import_id,name,source_path,object_path,bytes,extension,state)
        values (out_id,job.id,file_name,coalesce(member->>'path',file_name),job.id::text||'/'||out_id::text,size_bytes,extension,'uploading')
        returning * into file;
      answer := answer || to_jsonb(file);
    end loop;
    return jsonb_build_object('id',job.id,'files',answer);
  end if;
  if p_action in ('publish','unpublish','link') then
    select * into resource from public.lms_unit_resources where id=(p_data->>'id')::uuid
      and tenant_id is not distinct from tenant;
    if not found then raise exception 'Resource unavailable.'; end if;
    perform pg_advisory_xact_lock(hashtextextended(resource.unit_id, 0));
    select * into strict resource from public.lms_unit_resources where id=resource.id for update;
    if p_action = 'link' then
      related := nullif(p_data->>'assessmentId','')::uuid;
      if resource.category <> 'assessment' or (related is not null and not exists (
        select 1 from public.asm_assessments a where a.id = related and a.unit_id = resource.unit_id
          and a.tenant_id is not distinct from tenant
      )) then raise exception 'Choose an assessment for the same unit.'; end if;
      update public.lms_unit_resources set assessment_id=related where id=resource.id;
    else
      if p_action = 'publish' then
        settings := public.lms_bulk_policy(tenant);
        if not (settings->>'allow_publication')::boolean then raise exception 'Publication is disabled in Business Rules & Policies.'; end if;
        if resource.audience = 'student_staff' and (p_data->'contentChecked') is distinct from 'true'::jsonb then
          raise exception 'Verify the file contains no assessor-only material before publishing to students.';
        end if;
        if exists (
          with recursive successors as (
            select r.id, r.published_at from public.lms_unit_resources r where r.previous_id=resource.id
            union all
            select r.id, r.published_at from public.lms_unit_resources r join successors s on r.previous_id=s.id
          ) select 1 from successors where published_at is not null
        ) then raise exception 'A newer version has been published.'; end if;
        with recursive ancestors as (
          select r.id, r.previous_id from public.lms_unit_resources r where r.id=resource.previous_id
          union all
          select r.id, r.previous_id from public.lms_unit_resources r join ancestors a on r.id=a.previous_id
        )
        update public.lms_unit_resources r set published_at=null from ancestors a where r.id=a.id;
      end if;
      update public.lms_unit_resources set published_at=case when p_action='publish' then now() end where id=resource.id;
    end if;
    insert into public.lms_resource_audit(file_id,actor,action) values(resource.file_id,auth.uid(),p_action);
    return to_jsonb(resource.id);
  end if;
  select * into job from public.lms_resource_imports where id=(p_data->>'job')::uuid
    and tenant_id is not distinct from tenant;
  if not found then raise exception 'Import unavailable.' using errcode = '42501'; end if;
  if p_action = 'detail' then
    return coalesce((select jsonb_agg(to_jsonb(f) - 'lease' || jsonb_build_object('matches',
      coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'course_id',u.course_id,'code',u.code,'name',u.name))
        from public.cms_course_units u join public.cms_courses c on c.id=u.course_id
        where u.tenant_id is not distinct from tenant and c.tenant_id is not distinct from tenant
          and upper(u.code)=upper(f.result->>'unitCode')), '[]'),
      'related',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'unit_id',r.unit_id,'title',r.title,'identical',r.sha256=f.sha256))
        from public.lms_unit_resources r
        where r.tenant_id is not distinct from tenant and (r.sha256=f.sha256 or lower(r.title)=lower(f.result->>'title'))), '[]'))
      order by f.created_at, f.source_path) from public.lms_resource_import_files f where f.import_id=job.id),'[]');
  end if;
  if p_action = 'approve' then
    settings := public.lms_bulk_policy(tenant);
    if jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items') > 1000 then
      raise exception 'Select documents to approve.';
    end if;
    for member in select value from jsonb_array_elements(p_data->'items') loop
      begin
        select * into strict file from public.lms_resource_import_files
          where id=(member->>'id')::uuid and import_id=job.id and state='review' for update;
        select * into strict unit from public.cms_course_units where id=member->>'unit'
          and tenant_id is not distinct from tenant;
        perform pg_advisory_xact_lock(hashtextextended(unit.id, 0));
        category := member->>'category';
        held := coalesce(file.result->>'confidentiality','unknown') <> 'student_safe'
          or coalesce(file.result->>'category','assessor') = 'assessor';
        audience := case when held or category='assessor' then 'assessor' else member->>'audience' end;
        select count(*), coalesce(bool_or(u.id=unit.id),false) into match_count, exact_match
          from public.cms_course_units u join public.cms_courses c on c.id=u.course_id
          where u.tenant_id is not distinct from tenant and c.tenant_id is not distinct from tenant
            and upper(u.code)=upper(file.result->>'unitCode')
            and (file.result->>'courseCode' is null or upper(c.code)=upper(file.result->>'courseCode'));
        if ((settings->>'confirm_each')::boolean or match_count <> 1 or not exact_match
            or coalesce((file.result->>'confidence')::numeric,0) < (settings->>'confidence')::numeric or held)
           and (member->'reviewed') is distinct from 'true'::jsonb then
          raise exception 'Review and confirm the classification first.';
        end if;
        if exists (select 1 from public.lms_unit_resources r where r.unit_id=unit.id and r.sha256=file.sha256) then
          if (member->'skipExisting') is distinct from 'true'::jsonb and settings->>'duplicates' <> 'skip_identical' then
            raise exception 'Choose Skip existing for an identical document.';
          end if;
          update public.lms_resource_import_files set state='excluded', reviewed_by=auth.uid(), reviewed_at=now() where id=file.id;
          insert into public.lms_resource_audit(file_id,actor,action) values(file.id,auth.uid(),'skip_identical');
        else
          related := nullif(member->>'previousId','')::uuid;
          if related is not null then
            select * into strict previous from public.lms_unit_resources
              where id=related and unit_id=unit.id and tenant_id is not distinct from tenant for update;
            held := held or previous.security_hold or previous.category='assessor';
            if held then audience := 'assessor'; end if;
          end if;
          insert into public.lms_unit_resources(tenant_id,unit_id,file_id,previous_id,title,category,audience,security_hold,sha256)
            values (tenant,unit.id,file.id,related,coalesce(nullif(left(file.result->>'title',240),''),file.name),category,audience,held,file.sha256)
            returning id into out_id;
          update public.lms_resource_import_files set state='imported', reviewed_by=auth.uid(), reviewed_at=now() where id=file.id;
          insert into public.lms_resource_audit(file_id,actor,action,detail)
            values(file.id,auth.uid(),'approve',jsonb_build_object('resource',out_id,'unit',unit.id,'category',category,'audience',audience));
        end if;
        answer := answer || jsonb_build_object('id',file.id,'ok',true);
      exception when others then
        answer := answer || jsonb_build_object('id',member->>'id','ok',false,'error',
          case when sqlstate='P0001' then sqlerrm else 'The file, unit or version could not be approved. Refresh and review the selection.' end);
      end;
    end loop;
    return answer;
  end if;
  select * into file from public.lms_resource_import_files where id=(p_data->>'id')::uuid and import_id=job.id for update;
  if not found then raise exception 'File unavailable.'; end if;
  if p_action = 'uploaded' and job.created_by = auth.uid() and file.state in ('uploading','queued','processing','extracted','review','imported') then
    if file.state <> 'uploading' then return to_jsonb(file.id); end if;
    if not exists (select 1 from storage.objects where bucket_id='lms-bulk-resources' and name=file.object_path
      and (metadata->>'size')::integer=file.bytes) then raise exception 'Upload incomplete or size mismatch.'; end if;
    update public.lms_resource_import_files set state='queued' where id=file.id;
  elsif p_action = 'exclude' and file.state in ('uploading','review','failed') then
    update public.lms_resource_import_files set state='excluded', reviewed_by=auth.uid(), reviewed_at=now() where id=file.id;
  elsif p_action = 'retry' and file.state = 'failed' then
    update public.lms_resource_import_files set state='queued', attempts=0, eligible_at=now(), failure=null where id=file.id;
  else raise exception 'This action is unavailable for the current file status.';
  end if;
  insert into public.lms_resource_audit(file_id,actor,action) values(file.id,auth.uid(),p_action);
  return to_jsonb(file.id);
end $$;

create function public.lms_bulk_claim() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f public.lms_resource_import_files; j public.lms_resource_imports;
begin
  update public.lms_resource_import_files set state='failed', lease=null, failure='The worker stopped before finishing. Retry the file.'
    where state='processing' and eligible_at<=now() and attempts>=3;
  select * into f from public.lms_resource_import_files
    where state in ('queued','processing') and eligible_at<=now() and attempts<3
    order by created_at, id limit 1 for update skip locked;
  if not found then return null; end if;
  update public.lms_resource_import_files set state='processing', lease=gen_random_uuid(),
    attempts=attempts+1, eligible_at=now()+interval '5 minutes'
    where id=f.id returning * into f;
  select * into strict j from public.lms_resource_imports where id=f.import_id;
  return to_jsonb(f) || jsonb_build_object('tenant',j.tenant_id);
end $$;

create function public.lms_bulk_finish(p_id uuid,p_lease uuid,p_result jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare f public.lms_resource_import_files; j public.lms_resource_imports; child jsonb; children jsonb;
begin
  select * into f from public.lms_resource_import_files where id=p_id and lease=p_lease and state='processing' for update;
  if not found then return false; end if;
  children := p_result->'children';
  if children is not null then
    select * into strict j from public.lms_resource_imports where id=f.import_id for update;
    if (select count(*) from public.lms_resource_import_files where import_id=f.import_id and (parent_id is not null or extension<>'zip'))
      + jsonb_array_length(children) > floor((public.lms_bulk_policy(j.tenant_id)->>'max_files')::numeric)::integer then
      raise exception 'Extracted files exceed the configured import limit.';
    end if;
    for child in select value from jsonb_array_elements(children) loop
      insert into public.lms_resource_import_files(import_id,parent_id,name,source_path,object_path,bytes,extension,state)
      values(f.import_id,f.id,child->>'name',child->>'path',child->>'objectPath',(child->>'bytes')::integer,child->>'extension','queued');
    end loop;
    update public.lms_resource_import_files set state='extracted',lease=null,failure=null where id=f.id;
  elsif p_result ? 'failure' then
    update public.lms_resource_import_files set
      state=case when attempts<3 and coalesce((p_result->>'retry')::boolean,false) then 'queued' else 'failed' end,
      lease=null, eligible_at=now() + make_interval(mins=>attempts), failure=p_result->>'failure' where id=f.id;
  else
    update public.lms_resource_import_files set state='review',lease=null,failure=null,
      result=p_result->'classification',usage=p_result->'usage',sha256=p_result->>'sha256' where id=f.id;
  end if;
  insert into public.lms_resource_audit(file_id,action,detail) values(f.id,
    case when children is not null then 'extract' when p_result ? 'failure' then 'fail' else 'classify' end,
    jsonb_strip_nulls(jsonb_build_object('usage',p_result->'usage','failure',p_result->>'failure')));
  return true;
end $$;

create function public.lms_bulk_dispatch() returns void
language plpgsql security definer set search_path = '' as $$
declare endpoint text; credential text; pending integer;
begin
  select count(*) into pending from (select 1 from public.lms_resource_import_files
    where state in ('queued','processing') and eligible_at <= now() limit 8) work;
  if pending=0 then return; end if;
  select regexp_replace(decrypted_secret, '/staff-admin$', '/lms-bulk-worker') into endpoint
    from vault.decrypted_secrets where name='hr_retention_function_url';
  select decrypted_secret into credential from vault.decrypted_secrets where name='hr_retention_service_role_key';
  if credential is null or endpoint is null or endpoint !~ '/lms-bulk-worker$' then
    raise exception 'LMS worker dispatch credentials are unavailable.';
  end if;
  for lane in 1..pending loop
    perform net.http_post(url=>endpoint,headers=>jsonb_build_object('Authorization','Bearer '||credential,'Content-Type','application/json'),
      body=>'{}'::jsonb,timeout_milliseconds=>90000);
  end loop;
end $$;

revoke all on function public.lms_bulk_policy(uuid), public.lms_bulk_can_manage(uuid),
  public.lms_bulk_can_read(uuid,text,text,timestamptz), public.lms_bulk_storage_allowed(text,boolean),
  public.lms_bulk_resources(text), public.lms_bulk_admin(text,jsonb), public.lms_bulk_claim(),
  public.lms_bulk_finish(uuid,uuid,jsonb), public.lms_bulk_dispatch() from public, anon, authenticated, service_role;
grant execute on function public.lms_bulk_can_read(uuid,text,text,timestamptz), public.lms_bulk_storage_allowed(text,boolean),
  public.lms_bulk_resources(text), public.lms_bulk_admin(text,jsonb) to authenticated;
grant execute on function public.lms_bulk_claim(), public.lms_bulk_finish(uuid,uuid,jsonb), public.lms_bulk_policy(uuid) to service_role;
select cron.schedule('lms-bulk-resource-worker','* * * * *','select public.lms_bulk_dispatch()');

commit;
