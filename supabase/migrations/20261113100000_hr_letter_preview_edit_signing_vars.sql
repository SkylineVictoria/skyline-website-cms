begin;

-- Preview and edit before sending (2026-11-11). An offer letter or a signing document is previewed as the PDF will look, may be
-- edited for THIS copy only (the template is untouched), and the text that went out is kept beside what the template rendered.
-- A signing request can belong to a staff member, whose record fills the letter variables. Additive only.

-- ------------------------------------------------------------------ 1. offer letters: the sent copy and the template's render
alter table hr.staff_offer_letters
 add column if not exists edited boolean not null default false,
 add column if not exists template_html text;

-- The same recorder with two more facts: whether the admin edited the letter, and what the template rendered before the edits
-- (null when nothing was changed). Older callers pass nine arguments and nothing changes for them.
drop function if exists public.hr_admin_offer_letter_add(uuid, text, text, integer, text, uuid, text, text, jsonb);
create function public.hr_admin_offer_letter_add(p_id uuid, p_path text, p_filename text, p_size integer, p_sha256 text, p_template uuid, p_title text, p_html text, p_values jsonb,
 p_edited boolean default false, p_template_html text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); t hr.templates; r jsonb; v_problem text;
begin
 select * into t from hr.templates where id = p_template;
 if not found or t.type <> 'offer_letter' or t.archived_at is not null then raise exception 'Choose an offer letter template.' using errcode = '22023'; end if;
 if p_html is null or btrim(p_html) = '' or char_length(p_html) > 200000 then raise exception 'The letter is empty or too long.' using errcode = '22023'; end if;
 if p_html ~ '\{\{\s*[A-Za-z0-9_]+\s*\}\}' then raise exception 'The letter still has placeholders that were not filled in.' using errcode = '23514'; end if;
 if coalesce(p_edited, false) and (p_template_html is null or btrim(p_template_html) = '') then raise exception 'An edited letter is recorded with what the template rendered.' using errcode = '22023'; end if;
 if p_template_html is not null and char_length(p_template_html) > 200000 then raise exception 'The letter is empty or too long.' using errcode = '22023'; end if;
 v_problem := coalesce(hr.staff_documents_problem(p_id), hr.onboarding_pay_problem(p_id));
 if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;
 r := public.hr_admin_staff_offer_add(p_id, p_path, p_filename, p_size, p_sha256);
 insert into hr.staff_offer_letters(offer_id, profile_id, template_id, template_name, title, body_html, field_values, created_by, edited, template_html)
  values ((r->'offer'->>'id')::uuid, p_id, t.id, t.name, left(btrim(coalesce(p_title, t.subject)), 200), p_html, coalesce(p_values, '{}'::jsonb), v_admin,
   coalesce(p_edited, false), case when coalesce(p_edited, false) then p_template_html end);
 perform hr.audit_log(p_id, 'offer_letter_generated', jsonb_build_object('template', t.name, 'edited', coalesce(p_edited, false)));
 return r;
end $fn$;
revoke all on function public.hr_admin_offer_letter_add(uuid, text, text, integer, text, uuid, text, text, jsonb, boolean, text) from public, anon;
grant execute on function public.hr_admin_offer_letter_add(uuid, text, text, integer, text, uuid, text, text, jsonb, boolean, text) to authenticated;

-- The context the Send offer dialog loads also names the letter already out as edited or not.
create or replace function public.hr_admin_offer_letter_context(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.staff_profiles; v_problem text;
begin
 perform hr.require_admin();
 select * into p from hr.staff_profiles where id = p_id;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 v_problem := case when p.status <> 'documents_submitted' then 'An offer letter is made once the documents are submitted (withdraw a sent offer first).'
  else coalesce(hr.staff_documents_problem(p.id), hr.onboarding_pay_problem(p.id)) end;
 return jsonb_build_object('status', p.status, 'problem', v_problem, 'values', hr.template_values(p.id),
  'templates', coalesce((select jsonb_agg(hr.template_json(t) order by t.type, t.is_default desc, lower(t.name)) from hr.templates t
    where t.type in ('offer_letter', 'offer_email') and t.archived_at is null), '[]'::jsonb),
  'letter', (select jsonb_build_object('offerId', l.offer_id, 'templateId', l.template_id, 'templateName', l.template_name, 'title', l.title, 'bodyHtml', l.body_html,
     'edited', l.edited, 'createdAt', l.created_at)
    from hr.staff_offer_letters l join hr.staff_offers o on o.id = l.offer_id where l.profile_id = p.id and o.withdrawn_at is null order by l.created_at desc limit 1));
end $fn$;

-- ------------------------------------------------------------------ 2. signing: the staff member, the edit and the template's text
alter table hr.sign_requests
 add column if not exists profile_id uuid references hr.staff_profiles(id),
 add column if not exists edited boolean not null default false,
 add column if not exists template_text text;
create index if not exists sign_requests_profile_idx on hr.sign_requests(profile_id) where profile_id is not null;

create or replace function public.signing_admin(p_action text, p_id uuid default null, p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = pg_catalog, hr, public, pg_temp as $f$
declare v_admin uuid := hr.require_admin(); r hr.sign_requests; t hr.sign_templates; v_event text; v_profile uuid;
begin
 if p_action = 'list' then
  return jsonb_build_object('templates',coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from hr.sign_templates x),'[]'),
   'requests',coalesce((select jsonb_agg(to_jsonb(x) - 'token_hash' - 'field_values' - 'rendered_text' - 'template_text' order by x.created_at desc)
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
  v_profile := nullif(p_data->>'profile_id', '')::uuid;
  if v_profile is not null and not exists (select 1 from hr.staff_profiles where id = v_profile) then raise exception 'Staff member not found'; end if;
  insert into hr.sign_requests(id,title,recipient_name,recipient_email,template_id,rendered_text,field_values,original_path,original_hash,created_by,profile_id,edited,template_text)
   values(p_id,p_data->>'title',p_data->>'recipient_name',lower(p_data->>'recipient_email'),(p_data->>'template_id')::uuid,
    p_data->>'rendered_text',coalesce(p_data->'field_values','{}'),p_id::text||'/original.pdf',p_data->>'original_hash',v_admin,
    v_profile,coalesce((p_data->>'edited')::boolean,false),case when coalesce((p_data->>'edited')::boolean,false) then p_data->>'template_text' end) returning * into r;
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

commit;
