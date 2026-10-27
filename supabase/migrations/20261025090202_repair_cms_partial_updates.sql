-- Captured partial-update constraint failures; preserve defaulted columns on existing rows.
create or replace function public.cms_commit(p_expected_version bigint,p_changes jsonb) returns bigint
language plpgsql security invoker set search_path=public as $$
declare t uuid:=public.tenant_current(); key text:=coalesce(t::text,'legacy'); v bigint;
 item jsonb; rowdata jsonb; tab text; columns text; updates text; ids jsonb; affected bigint;
begin
 if auth.uid() is null then raise exception 'CMS access denied' using errcode='42501'; end if;
 if public.tenant_request_domain() is not null then
  perform public.tenant_website_context();
  if not public.tenant_has_role(t,array['tenant_admin','editor']) then raise exception 'CMS access denied' using errcode='42501'; end if;
 elsif not public.cms_is_staff() or not public.tenant_scope(null) then raise exception 'CMS access denied' using errcode='42501'; end if;
 if jsonb_typeof(p_changes)<>'array' or length(p_changes::text)>4194304 or jsonb_array_length(p_changes)>32 then raise exception 'Invalid CMS command' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('cms:'||key,0));
 select coalesce((select version from public.cms_edit_state where scope_key=key),0) into v;
 if p_expected_version is distinct from v then raise exception 'CMS changed in another session. Reload before saving.' using errcode='40001'; end if;
 for item in select value from jsonb_array_elements(p_changes) loop
  tab:=item->>'table';
  if tab is null or not tab=any(array['cms_settings','cms_social_links','cms_courses','cms_course_sections','cms_course_units',
   'cms_course_attachments','cms_course_links','cms_pages','cms_forms','cms_form_fields','cms_documents','cms_navigation_items','cms_footer','cms_seo','cms_revisions','cms_activity_log']) then raise exception 'Unsupported CMS table' using errcode='22023'; end if;
  for rowdata in select value from jsonb_array_elements(coalesce(item->'upserts','[]')) loop
   if rowdata->>'id' is null then raise exception 'Record ID required' using errcode='22023'; end if;
   if rowdata ? 'tenant_id' and (rowdata->>'tenant_id') is distinct from t::text then raise exception 'Incorrect tenant selector' using errcode='42501'; end if;
   rowdata:=rowdata||jsonb_build_object('tenant_id',t);
   if exists(select 1 from jsonb_object_keys(rowdata) k where not exists(select 1 from pg_attribute a where a.attrelid=format('public.%I',tab)::regclass and a.attname=k and a.attnum>0 and not a.attisdropped)) then raise exception 'Unsupported CMS column' using errcode='22023'; end if;
   select string_agg(format('%I',k),','),string_agg(format('%I=src.%I',k,k),',') filter(where k<>'id') into columns,updates from jsonb_object_keys(rowdata) k;
   if tab in ('cms_revisions','cms_activity_log') then
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1)',tab,columns,columns,tab) using rowdata;
   else
    execute format('update public.%I dest set %s from jsonb_populate_record(null::public.%I,$1) src where dest.id::text=$2 and dest.tenant_id is not distinct from $3',tab,updates,tab) using rowdata,rowdata->>'id',t;
    get diagnostics affected=row_count;
    if affected=0 then
     execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1)',tab,columns,columns,tab) using rowdata;
    end if;
   end if;
  end loop;
 end loop;
 -- Children delete before parents. Upserts above have already established new
 -- parents; any constraint/RLS failure rolls back every table and version.
 for item in select value from jsonb_array_elements(p_changes) with ordinality order by ordinality desc loop
  tab:=item->>'table'; ids:=coalesce(item->'deletes','[]');
  if tab in ('cms_revisions','cms_activity_log') and jsonb_array_length(ids)>0 then raise exception 'History is append only' using errcode='42501'; end if;
  if jsonb_array_length(ids)>0 then
   execute format('delete from public.%I where id::text in (select jsonb_array_elements_text($1)) and tenant_id is not distinct from $2',tab) using ids,t;
  end if;
 end loop;
 return coalesce((select version from public.cms_edit_state where scope_key=key),0);
end; $$;
