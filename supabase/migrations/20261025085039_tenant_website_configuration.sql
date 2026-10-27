-- Local Phase 3: preserve legacy singleton IDs and all existing ownership.
-- Additional verified tenant sites receive distinct settings/footer IDs.
alter table public.cms_settings drop constraint cms_settings_id_check;
alter table public.cms_settings add constraint cms_settings_positive_id check(id>0);
alter table public.cms_footer drop constraint cms_footer_id_check;
alter table public.cms_footer add constraint cms_footer_positive_id check(id>0);
alter table public.cms_footer add constraint cms_footer_tenant_identity unique(id,tenant_id);
create unique index cms_settings_one_per_tenant on public.cms_settings(tenant_id) where tenant_id is not null;
create unique index cms_footer_one_per_tenant on public.cms_footer(tenant_id) where tenant_id is not null;

alter table public.cms_settings add column primary_color text not null default '#2563eb'
 check(primary_color ~ '^#[0-9a-fA-F]{6}$');
alter table public.cms_settings add column heading_font text not null default 'Arial'
 check(heading_font in ('Arial','Georgia','Verdana','system-ui'));
alter table public.cms_settings add column body_font text not null default 'Arial'
 check(body_font in ('Arial','Georgia','Verdana','system-ui'));
alter table public.cms_settings add column map_embed_src text not null default '';
alter table public.cms_footer add column quick_links jsonb not null default '[]' check(jsonb_typeof(quick_links)='array');
alter table public.cms_footer add column student_links jsonb not null default '[]' check(jsonb_typeof(student_links)='array');

create table public.tenant_website_config(
 tenant_id uuid primary key references public.tenants(id),
 settings_id smallint not null unique,
 footer_id smallint not null unique,
 theme_version integer not null default 1 check(theme_version>0),
 content_version bigint not null default 1 check(content_version>0),
 foreign key(settings_id,tenant_id) references public.cms_settings(id,tenant_id),
 foreign key(footer_id,tenant_id) references public.cms_footer(id,tenant_id)
);
alter table public.tenant_website_config enable row level security;
revoke all on public.tenant_website_config from public,anon,authenticated,service_role;
grant select on public.tenant_website_config to anon,authenticated,service_role;
grant insert,update on public.tenant_website_config to authenticated,service_role;
create policy website_config_read on public.tenant_website_config for select to anon,authenticated
 using(public.tenant_scope(tenant_id));
create policy website_config_insert on public.tenant_website_config for insert to authenticated
 with check(public.tenant_scope(tenant_id) and public.tenant_has_role(tenant_id,array['tenant_admin']));
create policy website_config_update on public.tenant_website_config for update to authenticated
 using(public.tenant_scope(tenant_id) and public.tenant_has_role(tenant_id,array['tenant_admin']))
 with check(public.tenant_scope(tenant_id) and public.tenant_has_role(tenant_id,array['tenant_admin']));

-- Public configuration is selected only by a verified, active domain. Explicit
-- database relationships bind both singleton rows to that same tenant.
create function public.tenant_website_context() returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare t uuid:=public.tenant_current(); result jsonb;
begin
 if t is null then raise exception 'Website unavailable for this hostname' using errcode='42501'; end if;
 select jsonb_build_object('tenantId',c.tenant_id,'hostname',public.tenant_request_domain(),
 'settingsId',c.settings_id,'footerId',c.footer_id,'themeVersion',c.theme_version,'contentVersion',c.content_version)
 into result from public.tenant_website_config c
 join public.cms_settings s on s.id=c.settings_id and s.tenant_id=c.tenant_id
 join public.cms_footer f on f.id=c.footer_id and f.tenant_id=c.tenant_id
 where c.tenant_id=t and length(trim(s.name))>0;
 if result is null then raise exception 'Website configuration is incomplete' using errcode='22023'; end if;
 return result;
end; $$;
revoke all on function public.tenant_website_context() from public,anon,authenticated,service_role;
grant execute on function public.tenant_website_context() to anon,authenticated;

-- One database snapshot: auth sessions must not expose drafts to public pages.
create function public.cms_public_snapshot() returns jsonb
language plpgsql stable security invoker set search_path=public as $$
declare result jsonb:='{}'; rows jsonb; tab text; clause text;
begin
 if public.tenant_request_domain() is not null then perform public.tenant_website_context(); end if;
 foreach tab in array array['cms_settings','cms_social_links','cms_navigation_items','cms_footer','cms_courses',
 'cms_course_sections','cms_course_units','cms_course_attachments','cms_pages','cms_documents','cms_forms','cms_form_fields','cms_seo'] loop
  clause:=case when tab in ('cms_courses','cms_pages','cms_documents','cms_forms') then ' where status=''Published''' else '' end;
  execute format('select coalesce(jsonb_agg(to_jsonb(r)),''[]''::jsonb) from public.%I r%s',tab,clause) into rows;
  result:=result||jsonb_build_object(tab,rows);
 end loop;
 return result;
end; $$;
revoke all on function public.cms_public_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.cms_public_snapshot() to anon,authenticated;

-- Preserve legacy slugs; permit separate institutions to use the same routes.
alter table public.cms_pages drop constraint cms_pages_slug_key;
create unique index cms_pages_scoped_slug on public.cms_pages(tenant_id,slug) nulls not distinct;
alter table public.cms_courses drop constraint cms_courses_slug_key;
create unique index cms_courses_scoped_slug on public.cms_courses(tenant_id,slug) nulls not distinct;
