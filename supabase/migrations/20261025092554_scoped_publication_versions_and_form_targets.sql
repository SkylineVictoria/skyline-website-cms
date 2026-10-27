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
 return case when tg_op='DELETE' then old else new end;
end; $$;

create function public.cms_public_revision() returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare t uuid:=public.tenant_current();
begin
 if public.tenant_request_domain() is not null then
  return public.tenant_website_context();
 end if;
 if not public.tenant_scope(null) then raise exception 'Website unavailable' using errcode='42501'; end if;
 return jsonb_build_object('tenantId',null,'contentVersion',coalesce((select version from public.cms_edit_state where scope_key='legacy'),0));
end; $$;
revoke all on function public.cms_public_revision() from public,anon,authenticated,service_role;
grant execute on function public.cms_public_revision() to anon,authenticated;

-- The inherited section trigger invalidated every cached institution.
do $$ declare body text; needle text:='delete from public.public_assistant_answer_cache where cache_key is not null;'; begin
 body:=pg_get_functiondef('public.public_assistant_queue_course_section()'::regprocedure);
 if strpos(body,needle)=0 then raise exception 'Unexpected section invalidation predecessor'; end if;
 execute replace(body,needle,'delete from public.public_assistant_answer_cache where tenant_id is not distinct from (case when tg_op=''DELETE'' then old.tenant_id else new.tenant_id end);');
end; $$;

alter table public.cms_forms add column submit_url text not null default '';
alter table public.cms_forms add column submission_approved boolean not null default false;
create function public.cms_validate_form_target() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if new.tenant_id is null then return new; end if;
 if new.submit_url<>'' and (length(new.submit_url)>2048 or new.submit_url ~ '[[:space:][:cntrl:]@]' or
   not (new.submit_url ~ '^https://[^/]+/' or
    (coalesce(public.tenant_request_domain(),'') like '%.localhost' or auth.uid() is null) and new.submit_url ~ '^http://127[.]0[.]0[.]1:[0-9]+/')) then
  raise exception 'Use an approved HTTPS form endpoint' using errcode='22023';
 end if;
 if auth.uid() is not null and (tg_op='INSERT' and (new.submit_url<>'' or new.submission_approved) or tg_op='UPDATE' and
 (new.submit_url,new.submission_approved) is distinct from (old.submit_url,old.submission_approved)) and
 not public.tenant_has_role(new.tenant_id,array['tenant_admin']) then raise exception 'Tenant administrator approval required for form targets' using errcode='42501'; end if;
 return new;
end; $$;
revoke all on function public.cms_validate_form_target() from public,anon,authenticated,service_role;
create trigger validate_form_target before insert or update on public.cms_forms for each row execute function public.cms_validate_form_target();
