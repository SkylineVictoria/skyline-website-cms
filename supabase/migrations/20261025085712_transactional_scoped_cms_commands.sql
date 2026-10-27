-- Atomic structured CMS writes retain the original tables and their RLS.
create table public.cms_edit_state(
 scope_key text primary key,
 tenant_id uuid unique references public.tenants(id),
 version bigint not null default 0,
 check(scope_key=coalesce(tenant_id::text,'legacy'))
);
insert into public.cms_edit_state(scope_key) values('legacy');
insert into public.cms_edit_state(scope_key,tenant_id) select tenant_id::text,tenant_id from public.tenant_website_config;
alter table public.cms_edit_state enable row level security;
revoke all on public.cms_edit_state from public,anon,authenticated,service_role;
grant select on public.cms_edit_state to authenticated;
create policy edit_version_read on public.cms_edit_state for select to authenticated using(
 public.tenant_scope(tenant_id) and case when tenant_id is null then public.cms_is_staff()
 else public.tenant_has_role(tenant_id,array['tenant_admin','editor']) end);

create function public.tenant_cms_identity() returns jsonb
language sql stable security definer set search_path=public as $$
 select jsonb_build_object('id',auth.uid(),'name',coalesce(auth.jwt()->>'email','CMS staff'),
 'email',auth.jwt()->>'email','role',case when public.tenant_has_role(public.tenant_current(),array['tenant_admin']) then 'Admin' else 'Editor' end,
 'mustChangePassword',false)
 where public.tenant_has_role(public.tenant_current(),array['tenant_admin','editor']);
$$;
revoke all on function public.tenant_cms_identity() from public,anon,authenticated,service_role;
grant execute on function public.tenant_cms_identity() to authenticated;

-- This trigger alone may mutate version state. Clients cannot forge a version.
-- Direct REST writes also advance it, so stale editors cannot silently win.
create function public.cms_track_edit() returns trigger
language plpgsql security definer set search_path=public as $$
declare t uuid; key text;
begin
 t:=case when tg_op='DELETE' then old.tenant_id else new.tenant_id end;
 key:=coalesce(t::text,'legacy');
 perform pg_advisory_xact_lock(hashtextextended('cms:'||key,0));
 insert into public.cms_edit_state(scope_key,tenant_id,version) values(key,t,1)
 on conflict(scope_key) do update set version=cms_edit_state.version+1;
 return case when tg_op='DELETE' then old else new end;
end; $$;
revoke all on function public.cms_track_edit() from public,anon,authenticated,service_role;
do $$ declare tab text; begin
 foreach tab in array array['cms_settings','cms_social_links','cms_courses','cms_course_sections','cms_course_units',
 'cms_course_attachments','cms_course_links','cms_pages','cms_forms','cms_form_fields','cms_documents','cms_navigation_items','cms_footer','cms_seo'] loop
  execute format('create trigger cms_edit_version after insert or update or delete on public.%I for each row execute function public.cms_track_edit()',tab);
 end loop;
end; $$;

-- Append-only history remains tenant-scoped; the actor label is server-set.
do $$ declare tab text; begin
 foreach tab in array array['cms_revisions','cms_activity_log'] loop
  execute format('revoke update,delete on public.%I from authenticated',tab);
  execute format('drop policy tenant_boundary_insert on public.%I',tab);
  execute format('create policy tenant_boundary_insert on public.%I as restrictive for insert to authenticated with check(public.tenant_scope_write(tenant_id))',tab);
  execute format('create policy tenant_append_history on public.%I for insert to authenticated with check(tenant_id is not null and public.tenant_has_role(tenant_id,array[''tenant_admin'',''editor'']))',tab);
 end loop;
end; $$;
create function public.cms_stamp_history() returns trigger language plpgsql set search_path=public as $$
begin
 if auth.uid() is not null then
  if tg_table_name='cms_revisions' then new.by:=coalesce(auth.jwt()->>'email',auth.uid()::text);
  else new."user":=coalesce(auth.jwt()->>'email',auth.uid()::text); end if;
  new.at:=clock_timestamp();
 end if;
 return new;
end; $$;
revoke all on function public.cms_stamp_history() from public,anon,authenticated,service_role;
create trigger stamp_history before insert on public.cms_revisions for each row execute function public.cms_stamp_history();
create trigger stamp_history before insert on public.cms_activity_log for each row execute function public.cms_stamp_history();

create function public.cms_admin_snapshot() returns jsonb
language plpgsql stable security invoker set search_path=public as $$
declare result jsonb:='{}'; rows jsonb; tab text; t uuid:=public.tenant_current();
begin
 if public.tenant_request_domain() is not null then
  perform public.tenant_website_context();
  if not public.tenant_has_role(t,array['tenant_admin','editor']) then raise exception 'CMS access denied' using errcode='42501'; end if;
 elsif not public.cms_is_staff() or not public.tenant_scope(null) then raise exception 'CMS access denied' using errcode='42501'; end if;
 foreach tab in array array['cms_settings','cms_social_links','cms_courses','cms_course_sections','cms_course_units',
 'cms_course_attachments','cms_course_links','cms_pages','cms_forms','cms_form_fields','cms_documents','cms_navigation_items','cms_footer','cms_seo','cms_revisions','cms_activity_log'] loop
  execute format('select coalesce(jsonb_agg(to_jsonb(r)),''[]''::jsonb) from public.%I r',tab) into rows;
  result:=result||jsonb_build_object(tab,rows);
 end loop;
 -- Account administration remains with its supported identity APIs.
 if t is null then select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) into rows from public.cms_users r;
 else rows:='[]'; end if;
 result:=result||jsonb_build_object('cms_users',rows,'version',coalesce((select version from public.cms_edit_state where scope_key=coalesce(t::text,'legacy')),0));
 return result;
end; $$;
revoke all on function public.cms_admin_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.cms_admin_snapshot() to authenticated;

create function public.cms_commit(p_expected_version bigint,p_changes jsonb) returns bigint
language plpgsql security invoker set search_path=public as $$
declare t uuid:=public.tenant_current(); key text:=coalesce(t::text,'legacy'); v bigint;
 item jsonb; rowdata jsonb; tab text; columns text; updates text; ids jsonb;
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
   select string_agg(format('%I',k),','),string_agg(format('%I=excluded.%I',k,k),',') filter(where k<>'id') into columns,updates from jsonb_object_keys(rowdata) k;
   if tab in ('cms_revisions','cms_activity_log') then
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1)',tab,columns,columns,tab) using rowdata;
   else
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) on conflict(id) do update set %s',tab,columns,columns,tab,updates) using rowdata;
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
revoke all on function public.cms_commit(bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.cms_commit(bigint,jsonb) to authenticated;
