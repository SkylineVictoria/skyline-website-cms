-- Native SLIT signing. Local only. Existing CMS Admin authorization; no student records or offers changed.
set local lock_timeout = '5s';
create table hr.sign_templates (
 id uuid primary key default gen_random_uuid(), name text not null check(length(btrim(name)) between 1 and 120),
 title text not null check(length(btrim(title)) between 1 and 200),
 body text not null check(length(btrim(body)) between 1 and 40000),
 created_by uuid not null, updated_at timestamptz not null default now()
);
create table hr.sign_requests (
 id uuid primary key, title text not null check(length(btrim(title)) between 1 and 200),
 recipient_name text not null check(length(btrim(recipient_name)) between 2 and 150),
 recipient_email text not null check(recipient_email ~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$'),
 template_id uuid references hr.sign_templates(id), rendered_text text, field_values jsonb not null default '{}',
 original_path text not null, original_hash text not null check(original_hash ~ '^[a-f0-9]{64}$'),
 state text not null default 'draft' check(state in ('draft','sending','sent','viewed','email_failed','signed','declined','void')),
 token_hash text unique check(token_hash ~ '^[a-f0-9]{64}$'), expires_at timestamptz,
 delivery_id uuid, delivery_started_at timestamptz, delivery_error text,
 signed_path text, signed_hash text, signer_name text, signed_at timestamptz, consent text,
 created_by uuid not null, created_at timestamptz not null default now(), viewed_at timestamptz,
 check(original_path = id::text || '/original.pdf'),
 check(signed_path is null or signed_path like id::text || '/signed-%.pdf'),
 check((state = 'signed') = (signed_path is not null and signed_hash is not null and signed_at is not null and signer_name is not null and consent is not null))
);
create table hr.sign_events (
 id bigint generated always as identity primary key, request_id uuid not null references hr.sign_requests(id),
 event text not null, actor_id uuid, at timestamptz not null default now()
);
create index sign_requests_created_idx on hr.sign_requests(created_at desc);
create index sign_events_request_idx on hr.sign_events(request_id, id);
alter table hr.sign_templates enable row level security;
alter table hr.sign_requests enable row level security;
alter table hr.sign_events enable row level security;
revoke all on hr.sign_templates, hr.sign_requests, hr.sign_events from public, anon, authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('signing-documents','signing-documents',false,8388608,array['application/pdf']);
-- No browser Storage policies: all file reads/writes pass through the authorized Edge function.

create function public.signing_admin(p_action text, p_id uuid default null, p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = pg_catalog, hr, public, pg_temp as $f$
declare v_admin uuid := hr.require_admin(); r hr.sign_requests; t hr.sign_templates; v_event text;
begin
 if p_action = 'list' then
  return jsonb_build_object('templates',coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from hr.sign_templates x),'[]'),
   'requests',coalesce((select jsonb_agg(to_jsonb(x) - 'token_hash' - 'field_values' - 'rendered_text' order by x.created_at desc)
    from (select * from hr.sign_requests order by created_at desc limit 200) x),'[]'));
 elsif p_action = 'template_save' then
  if p_id is null then
   insert into hr.sign_templates(name,title,body,created_by) values(p_data->>'name',p_data->>'title',p_data->>'body',v_admin) returning * into t;
  else
   update hr.sign_templates set name=p_data->>'name',title=p_data->>'title',body=p_data->>'body',updated_at=now() where id=p_id returning * into t;
   if not found then raise exception 'Template not found'; end if;
  end if;
  return to_jsonb(t);
 elsif p_action = 'create' then
  insert into hr.sign_requests(id,title,recipient_name,recipient_email,template_id,rendered_text,field_values,original_path,original_hash,created_by)
   values(p_id,p_data->>'title',p_data->>'recipient_name',lower(p_data->>'recipient_email'),(p_data->>'template_id')::uuid,
    p_data->>'rendered_text',coalesce(p_data->'field_values','{}'),p_id::text||'/original.pdf',p_data->>'original_hash',v_admin) returning * into r;
  insert into hr.sign_events(request_id,event,actor_id) values(p_id,'created',v_admin);
  return to_jsonb(r) - 'token_hash';
 end if;
 select * into r from hr.sign_requests where id=p_id for update;
 if not found then raise exception 'Signing request not found'; end if;
 if p_action = 'detail' then
  return (to_jsonb(r)-'token_hash') || jsonb_build_object('events',coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from hr.sign_events e where e.request_id=p_id),'[]'));
 elsif p_action = 'send' then
  if r.state in ('signed','declined','void') then raise exception 'This request is closed'; end if;
  if r.state='sending' and r.delivery_started_at > now()-interval '5 minutes' then raise exception 'An email is already being sent'; end if;
  update hr.sign_requests set state='sending',token_hash=p_data->>'token_hash',expires_at=now()+interval '14 days',
   delivery_id=(p_data->>'delivery_id')::uuid,delivery_started_at=now(),delivery_error=null where id=p_id returning * into r;
  v_event := 'email_started';
 elsif p_action = 'void' then
  if r.state in ('signed','declined','void') then raise exception 'This request is closed'; end if;
  update hr.sign_requests set state='void',token_hash=null where id=p_id returning * into r;
  v_event := 'voided';
 else raise exception 'Unknown signing action'; end if;
 insert into hr.sign_events(request_id,event,actor_id) values(p_id,v_event,v_admin);
 return to_jsonb(r)-'token_hash';
end $f$;
revoke all on function public.signing_admin(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.signing_admin(text,uuid,jsonb) to authenticated;

-- Capability hashes enter only from the server. Row locks serialize signing, resending and cancellation.
create function public.signing_service(p_action text, p_hash text default null, p_id uuid default null, p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = pg_catalog,hr,public,pg_temp as $f$
declare r hr.sign_requests; v_event text;
begin
 if p_action='path_referenced' then
  return to_jsonb(exists(select 1 from hr.sign_requests where original_path=p_data->>'path' or signed_path=p_data->>'path'));
 end if;
 if p_action='delivery_result' then
  select * into r from hr.sign_requests where id=p_id for update;
  if not found or r.delivery_id is distinct from (p_data->>'delivery_id')::uuid or r.state <> 'sending' then return jsonb_build_object('stale',true); end if;
  update hr.sign_requests set state=case when p_data->>'state'='sent' then 'sent' else 'email_failed' end,
   token_hash=case when p_data->>'state'='sent' then token_hash else null end,
   delivery_error=case when p_data->>'state'='sent' then null else 'Email was not confirmed delivered. Send again to issue a new link.' end where id=r.id returning * into r;
  insert into hr.sign_events(request_id,event) values(r.id,r.state);
  return to_jsonb(r)-'token_hash';
 end if;
 if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'This signing link is invalid or expired'; end if;
 select * into r from hr.sign_requests where token_hash=p_hash for update;
 if not found or r.expires_at <= now() or r.state not in ('sent','viewed','signed') then raise exception 'This signing link is invalid or expired'; end if;
 if p_action='open' then
  if r.state='sent' then
   update hr.sign_requests set state='viewed',viewed_at=now() where id=r.id returning * into r;
   insert into hr.sign_events(request_id,event) values(r.id,'viewed');
  end if;
 elsif p_action='sign' then
  if r.state='signed' then raise exception 'This document is already signed'; end if;
  if coalesce(p_data->>'consent','') <> 'I have read this document and agree to its contents. I consent to use my typed full name as my electronic signature.'
   or length(btrim(coalesce(p_data->>'signer_name',''))) not between 2 and 150
   or p_data->>'signer_name' ~ '[[:cntrl:]]' then raise exception 'Your full name and agreement are required'; end if;
  if p_data->>'original_hash' is distinct from r.original_hash or p_data->>'signed_hash' !~ '^[a-f0-9]{64}$'
   or (p_data->>'signed_at')::timestamptz not between now()-interval '5 minutes' and now()+interval '5 seconds'
   then raise exception 'The signing document changed. Open it again'; end if;
  update hr.sign_requests set state='signed',signer_name=btrim(p_data->>'signer_name'),signed_at=(p_data->>'signed_at')::timestamptz,
   signed_hash=p_data->>'signed_hash',signed_path=p_data->>'signed_path',consent=p_data->>'consent' where id=r.id returning * into r;
  insert into hr.sign_events(request_id,event) values(r.id,'signed');
 elsif p_action='decline' then
  if r.state='signed' then raise exception 'This document is already signed'; end if;
  update hr.sign_requests set state='declined',token_hash=null where id=r.id returning * into r;
  insert into hr.sign_events(request_id,event) values(r.id,'declined');
 else raise exception 'Unknown signing action'; end if;
 return to_jsonb(r)-'token_hash';
end $f$;
revoke all on function public.signing_service(text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.signing_service(text,text,uuid,jsonb) to service_role;

do $menu$
begin
 alter table public.admin_menu_items disable trigger protect_admin_menu;
 insert into public.admin_menu_items(id,parent_id,label,route,icon_key,sort_order,is_enabled,permission_key,permission_scope,is_system)
  values('document_signing',null,'Documents & Signatures','/admin/signing','file',85,true,'cms.admin','current',true);
 alter table public.admin_menu_items enable trigger protect_admin_menu;
end $menu$;
