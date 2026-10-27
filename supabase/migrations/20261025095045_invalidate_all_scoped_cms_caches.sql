-- Contact/settings/navigation/SEO changes must invalidate stale answers too.
create or replace function public.cms_track_edit() returns trigger
language plpgsql security definer set search_path=public as $$
declare t uuid; key text;
begin
 t:=case when tg_op='DELETE' then old.tenant_id else new.tenant_id end;
 key:=coalesce(t::text,'legacy');
 perform pg_advisory_xact_lock(hashtextextended('cms:'||key,0));
 insert into public.cms_edit_state(scope_key,tenant_id,version) values(key,t,1)
 on conflict(scope_key) do update set version=cms_edit_state.version+1;
 update public.tenant_website_config set content_version=content_version+1 where tenant_id=t;
 delete from public.public_assistant_answer_cache where tenant_id is not distinct from t;
 return case when tg_op='DELETE' then old else new end;
end; $$;

