-- One template system (owner's brief 2026-11-11, part 2): the HRMS letters and emails of 20261111100000 (hr.templates) move into the
-- signing templates of 20261113140000 (hr.sign_templates), which become the single template table for letters, emails and documents
-- to sign. Additive only; hr.templates is left in place (no longer read or written by any function) until the owner drops it.
--
-- What theirs gains from ours: `body_html` (rich text from the allow-list editor, {{placeholders}}), `subject` (email subject),
-- `is_default` (one default per category), kind 'email' and the five email categories (offer_email, document_request,
-- document_reupload, welcome_login, rejection), the HRMS validation (hr.template_problem) on those kinds, `hr.text_to_html` /
-- `hr.html_to_text` so a text template and a rich one are the same thing to every reader. What stays theirs: versions
-- (hr.sign_template_versions), PDF sources, signer roles and placed fields, audience, archive and soft delete.
--
-- Data: every hr.templates row is copied with the SAME id (kind text for an offer letter, email for the rest; audience employee;
-- category = the old type; status archived when it was archived; version 1 snapshot). hr.staff_offer_letters.template_id now
-- references hr.sign_templates (same ids, so every sent letter keeps its link; the letter's own copy, values and PDF are untouched).
-- The HRMS RPCs keep their names and JSON shapes (hr_admin_templates, hr_admin_template_save / _duplicate / _archive / _set_default,
-- hr_admin_offer_letter_context, hr_admin_offer_letter_add, hr_svc_template_mail) but read and write hr.sign_templates, with a
-- version snapshot on every save. signing_admin learns body_html / subject / is_default and a 'template_default' action.
--
-- Rollback (manual): point staff_offer_letters.template_id back at hr.templates (ids match), re-run the functions of 20261111100000,
-- 20261113090000 and 20261113100000, and the signing_admin of 20261113140000; the copied rows may stay.
set local lock_timeout = '5s';

-- ------------------------------------------------------------------ 1. the table
alter table hr.sign_templates drop constraint if exists sign_templates_kind_check;
alter table hr.sign_templates add constraint sign_templates_kind_check check (kind in ('text', 'pdf', 'email'));
alter table hr.sign_templates drop constraint if exists sign_templates_category_check;
alter table hr.sign_templates add constraint sign_templates_category_check check (category in (
 'enrolment_agreement', 'consent_form', 'fee_agreement', 'employment_contract', 'offer_letter', 'hr_declaration', 'agency_agreement', 'commission_agreement', 'other',
 'offer_email', 'document_request', 'document_reupload', 'welcome_login', 'rejection'));
alter table hr.sign_templates add column if not exists body_html text;
alter table hr.sign_templates drop constraint if exists sign_templates_body_html_check;
alter table hr.sign_templates add constraint sign_templates_body_html_check check (body_html is null or char_length(body_html) between 1 and 60000);
alter table hr.sign_templates add column if not exists subject text;
alter table hr.sign_templates drop constraint if exists sign_templates_subject_check;
alter table hr.sign_templates add constraint sign_templates_subject_check check (subject is null or char_length(btrim(subject)) between 1 and 200);
alter table hr.sign_templates add column if not exists is_default boolean not null default false;
alter table hr.sign_templates drop constraint if exists sign_templates_kind_source;
alter table hr.sign_templates add constraint sign_templates_kind_source check (
 (kind = 'text' and (body is not null or body_html is not null)) or
 (kind = 'email' and body_html is not null and subject is not null) or
 (kind = 'pdf' and source_hash is not null and source_path is not null and source_path like 'templates/' || id::text || '/%'));
create unique index if not exists sign_templates_one_default on hr.sign_templates(category) where is_default and deleted_at is null;
create index if not exists sign_templates_category_idx on hr.sign_templates(category, status) where deleted_at is null;

-- The HRMS kinds: letters and emails (the rest are documents to sign).
create or replace function hr.template_kind_of(p_category text) returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$
 select case when p_category = 'offer_letter' then 'text' when p_category in ('offer_email', 'document_request', 'document_reupload', 'welcome_login', 'rejection') then 'email' end;
$fn$;
revoke all on function hr.template_kind_of(text) from public, anon, authenticated;

-- Plain text of simple HTML (paragraphs, headings and list items end a line; tags and entities removed): what a text-only reader sees.
create or replace function hr.html_to_text(p_html text) returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$
 select nullif(btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
  regexp_replace(coalesce(p_html, ''), '<\s*(br)\s*/?\s*>', E'\n', 'gi'),
  '<\s*/\s*(p|h[1-6]|li|blockquote|div|tr)\s*>', E'\n\n', 'gi'),
  '<[^>]*>', '', 'g'),
  '&nbsp;', ' ', 'g'), '&amp;', '&', 'g'), '&lt;', '<', 'g'), '&gt;', '>', 'g'), '&quot;', '"', 'g'), E'\n{3,}', E'\n\n', 'g')), '');
$fn$;
revoke all on function hr.html_to_text(text) from public, anon, authenticated;

-- Simple HTML of plain text: one <p> per paragraph (a blank line between), <br> for a line break, everything escaped.
create or replace function hr.text_to_html(p_text text) returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$
 select nullif((select string_agg('<p>' || replace(x, E'\n', '<br>') || '</p>', '')
  from regexp_split_to_table(replace(replace(replace(replace(replace(coalesce(p_text, ''), E'\r\n', E'\n'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), E'\n\s*\n') x
  where btrim(x) <> ''), '');
$fn$;
revoke all on function hr.text_to_html(text) from public, anon, authenticated;

-- ------------------------------------------------------------------ 2. the HRMS rows move over (same ids)
insert into hr.sign_templates(id, name, title, body, body_html, subject, kind, audience, category, status, version, roles, fields, signing_mode, expiry_days, reminder_days,
  is_default, created_by, created_at, updated_at, deleted_at)
select t.id, t.name, t.subject, hr.html_to_text(t.body_html), t.body_html, t.subject, hr.template_kind_of(t.type), 'employee', t.type,
  case when t.archived_at is null then 'active' else 'archived' end, 1, '[{"key":"signer1","label":"Signer","order":1,"required":true}]'::jsonb, '[]'::jsonb, 'sequential', 14, 3,
  t.is_default and t.archived_at is null, coalesce(t.created_by, t.updated_by, '00000000-0000-0000-0000-000000000000'::uuid), t.created_at, t.updated_at, null
from hr.templates t
where not exists (select 1 from hr.sign_templates s where s.id = t.id)
  and not (t.is_default and t.archived_at is null and exists (select 1 from hr.sign_templates s where s.category = t.type and s.is_default and s.deleted_at is null));
insert into hr.sign_template_versions(template_id, version, snapshot, created_by, created_at)
 select s.id, 1, to_jsonb(s), s.created_by, s.updated_at from hr.sign_templates s join hr.templates t on t.id = s.id
 where not exists (select 1 from hr.sign_template_versions v where v.template_id = s.id);

-- Sent letters keep their template link (same ids) but it now points at the one table.
alter table hr.staff_offer_letters drop constraint if exists staff_offer_letters_template_id_fkey;
update hr.staff_offer_letters l set template_id = null where l.template_id is not null and not exists (select 1 from hr.sign_templates s where s.id = l.template_id);
alter table hr.staff_offer_letters add constraint staff_offer_letters_template_id_fkey foreign key (template_id) references hr.sign_templates(id) on delete set null;

-- ------------------------------------------------------------------ 3. the HRMS shape of a template (the JSON the HRMS pages and the mail senders read)
create or replace function hr.sign_template_hrms_json(t hr.sign_templates) returns jsonb
language sql stable set search_path = pg_catalog, hr, pg_temp as $fn$
 select jsonb_build_object('id', t.id, 'type', t.category, 'name', t.name, 'subject', coalesce(t.subject, t.title), 'bodyHtml', coalesce(t.body_html, hr.text_to_html(t.body), ''),
  'isDefault', t.is_default, 'archivedAt', case when t.status = 'archived' then t.updated_at end, 'createdAt', t.created_at, 'updatedAt', t.updated_at,
  'kind', t.kind, 'audience', t.audience, 'version', t.version, 'roles', t.roles, 'fields', t.fields, 'status', t.status);
$fn$;
revoke all on function hr.sign_template_hrms_json(hr.sign_templates) from public, anon, authenticated;

-- One more version of a template, as the signing editor records it.
create or replace function hr.sign_template_version(p_id uuid, p_by uuid) returns void
language sql security definer set search_path = hr, pg_temp as $fn$
 insert into hr.sign_template_versions(template_id, version, snapshot, created_by) select t.id, t.version, to_jsonb(t), p_by from hr.sign_templates t where t.id = p_id;
$fn$;
revoke all on function hr.sign_template_version(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ 4. the HRMS RPCs on the one table (same names, same JSON)
create or replace function public.hr_admin_templates(p_include_archived boolean default true) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_admin();
 return coalesce((select jsonb_agg(hr.sign_template_hrms_json(t) order by t.category, (t.status = 'archived'), t.is_default desc, lower(t.name))
  from hr.sign_templates t where t.deleted_at is null and hr.template_kind_of(t.category) is not null and (p_include_archived or t.status = 'active')), '[]'::jsonb);
end $fn$;

create or replace function public.hr_admin_template_save(p_id uuid, p_template jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); t hr.sign_templates; v_type text := p_template->>'type'; v_name text := btrim(coalesce(p_template->>'name', ''));
 v_subject text := btrim(regexp_replace(coalesce(p_template->>'subject', ''), '[[:cntrl:]]+', ' ', 'g')); v_body text := coalesce(p_template->>'bodyHtml', ''); v_problem text;
begin
 if p_id is not null then
  select * into t from hr.sign_templates where id = p_id and deleted_at is null for update;
  if not found then raise exception 'Template not found.' using errcode = 'P0002'; end if;
  if t.status = 'archived' then raise exception 'Restore the template before editing it.' using errcode = '23514'; end if;
  v_type := t.category;
 end if;
 if v_type is null or hr.template_kind_of(v_type) is null then raise exception 'Choose the kind of template.' using errcode = '22023'; end if;
 if v_name = '' or char_length(v_name) > 120 then raise exception 'Give the template a name (up to 120 characters).' using errcode = '22023'; end if;
 if v_subject = '' or char_length(v_subject) > 200 then
  raise exception '%', case when v_type = 'offer_letter' then 'Give the letter a title (up to 200 characters).' else 'Enter the email subject (up to 200 characters).' end using errcode = '22023'; end if;
 if btrim(regexp_replace(v_body, '<[^>]*>|&nbsp;|\s', '', 'g')) = '' then raise exception 'The template has no text.' using errcode = '22023'; end if;
 if char_length(v_body) > 60000 then raise exception 'The template is too long.' using errcode = '22023'; end if;
 v_problem := hr.template_problem(v_type, v_subject, v_body);
 if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;
 if exists (select 1 from hr.sign_templates x where x.category = v_type and lower(x.name) = lower(v_name) and x.id is distinct from p_id and x.status = 'active' and x.deleted_at is null) then
  raise exception 'Another template of this kind is already called "%".', v_name using errcode = '23505'; end if;
 if p_id is null then
  insert into hr.sign_templates(name, title, body, body_html, subject, kind, audience, category, is_default, created_by)
   values (v_name, v_subject, hr.html_to_text(v_body), v_body, v_subject, hr.template_kind_of(v_type), 'employee', v_type,
    not exists (select 1 from hr.sign_templates x where x.category = v_type and x.is_default and x.deleted_at is null), v_admin) returning * into t;
 else
  update hr.sign_templates set name = v_name, title = v_subject, subject = v_subject, body_html = v_body, body = hr.html_to_text(v_body), version = version + 1, updated_at = now()
   where id = p_id returning * into t;
 end if;
 perform hr.sign_template_version(t.id, v_admin);
 return hr.sign_template_hrms_json(t);
end $fn$;

create or replace function public.hr_admin_template_duplicate(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); t hr.sign_templates; v_name text;
begin
 select * into t from hr.sign_templates where id = p_id and deleted_at is null;
 if not found then raise exception 'Template not found.' using errcode = 'P0002'; end if;
 v_name := left(t.name, 113) || ' (copy)';
 while exists (select 1 from hr.sign_templates x where x.category = t.category and lower(x.name) = lower(v_name) and x.status = 'active' and x.deleted_at is null) loop
  v_name := left(v_name, 110) || ' (copy)';
  exit when char_length(v_name) > 120;
 end loop;
 insert into hr.sign_templates(name, title, body, body_html, subject, kind, audience, category, roles, fields, signing_mode, expiry_days, reminder_days, source_path, source_hash, source_pages, created_by)
  values (left(v_name, 120), t.title, t.body, t.body_html, t.subject, t.kind, t.audience, t.category, t.roles, t.fields, t.signing_mode, t.expiry_days, t.reminder_days,
   case when t.kind = 'pdf' then t.source_path end, t.source_hash, t.source_pages, v_admin) returning * into t;
 perform hr.sign_template_version(t.id, v_admin);
 return hr.sign_template_hrms_json(t);
end $fn$;

create or replace function public.hr_admin_template_archive(p_id uuid, p_archived boolean default true) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); t hr.sign_templates;
begin
 select * into t from hr.sign_templates where id = p_id and deleted_at is null for update;
 if not found then raise exception 'Template not found.' using errcode = 'P0002'; end if;
 if p_archived and t.is_default then raise exception 'This is the default template. Make another one the default before archiving it.' using errcode = '23514'; end if;
 update hr.sign_templates set status = case when p_archived then 'archived' else 'active' end, updated_at = now() where id = p_id returning * into t;
 return hr.sign_template_hrms_json(t);
end $fn$;

create or replace function public.hr_admin_template_set_default(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); t hr.sign_templates;
begin
 select * into t from hr.sign_templates where id = p_id and deleted_at is null for update;
 if not found then raise exception 'Template not found.' using errcode = 'P0002'; end if;
 if t.status = 'archived' then raise exception 'An archived template cannot be the default.' using errcode = '23514'; end if;
 update hr.sign_templates set is_default = false where category = t.category and is_default and id <> t.id;
 update hr.sign_templates set is_default = true, updated_at = now() where id = t.id returning * into t;
 return hr.sign_template_hrms_json(t);
end $fn$;

-- Everything "Send offer letter" needs: the letter and email templates to choose from, this person's values and what still blocks the letter.
create or replace function public.hr_admin_offer_letter_context(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_letter record;
begin
 perform hr.require_admin();
 if not exists (select 1 from hr.staff_profiles p where p.id = p_id) then raise exception 'Staff member not found.' using errcode = 'P0002'; end if;
 select l.template_name, l.title, l.edited, l.created_at into v_letter from hr.staff_offer_letters l join hr.staff_offers o on o.id = l.offer_id
  where l.profile_id = p_id and o.withdrawn_at is null order by l.created_at desc limit 1;
 return jsonb_build_object(
  'problem', coalesce(hr.staff_documents_problem(p_id), hr.onboarding_pay_problem(p_id)),
  'values', hr.template_values(p_id),
  'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'type', t.category, 'name', t.name, 'subject', coalesce(t.subject, t.title),
    'bodyHtml', coalesce(t.body_html, hr.text_to_html(t.body), ''), 'isDefault', t.is_default) order by t.category, t.is_default desc, lower(t.name))
    from hr.sign_templates t where t.category in ('offer_letter', 'offer_email') and t.status = 'active' and t.deleted_at is null), '[]'::jsonb),
  'letter', case when v_letter.title is null then null else jsonb_build_object('templateName', v_letter.template_name, 'title', v_letter.title, 'edited', v_letter.edited, 'createdAt', v_letter.created_at) end);
end $fn$;

create or replace function public.hr_admin_offer_letter_add(p_id uuid, p_path text, p_filename text, p_size integer, p_sha256 text, p_template uuid, p_title text, p_html text, p_values jsonb,
 p_edited boolean default false, p_template_html text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); t hr.sign_templates; r jsonb; v_problem text;
begin
 select * into t from hr.sign_templates where id = p_template and deleted_at is null;
 if not found or t.category <> 'offer_letter' or t.status <> 'active' then raise exception 'Choose an offer letter template.' using errcode = '22023'; end if;
 if p_html is null or btrim(p_html) = '' or char_length(p_html) > 200000 then raise exception 'The letter is empty or too long.' using errcode = '22023'; end if;
 if p_html ~ '\{\{\s*[A-Za-z0-9_]+\s*\}\}' then raise exception 'The letter still has placeholders that were not filled in.' using errcode = '23514'; end if;
 if coalesce(p_edited, false) and (p_template_html is null or btrim(p_template_html) = '') then raise exception 'An edited letter is recorded with what the template rendered.' using errcode = '22023'; end if;
 if p_template_html is not null and char_length(p_template_html) > 200000 then raise exception 'The letter is empty or too long.' using errcode = '22023'; end if;
 v_problem := coalesce(hr.staff_documents_problem(p_id), hr.onboarding_pay_problem(p_id));
 if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;
 r := public.hr_admin_staff_offer_add(p_id, p_path, p_filename, p_size, p_sha256);
 insert into hr.staff_offer_letters(offer_id, profile_id, template_id, template_name, title, body_html, field_values, created_by, edited, template_html)
  values ((r->'offer'->>'id')::uuid, p_id, t.id, t.name, left(btrim(coalesce(p_title, coalesce(t.subject, t.title))), 200), p_html, coalesce(p_values, '{}'::jsonb), v_admin,
   coalesce(p_edited, false), case when coalesce(p_edited, false) then p_template_html end);
 perform hr.audit_log(p_id, 'offer_letter_generated', jsonb_build_object('template', t.name, 'edited', coalesce(p_edited, false)));
 return r;
end $fn$;

create or replace function public.hr_svc_template_mail(p_profile uuid, p_type text, p_template uuid default null) returns jsonb
language sql stable security definer set search_path = public, hr, pg_temp as $fn$
 select jsonb_build_object('values', hr.template_values(p_profile),
  'template', (select jsonb_build_object('id', t.id, 'name', t.name, 'subject', coalesce(t.subject, t.title), 'bodyHtml', coalesce(t.body_html, hr.text_to_html(t.body), ''))
    from hr.sign_templates t where t.category = p_type and t.status = 'active' and t.deleted_at is null and (t.id = p_template or (p_template is null and t.is_default))
    order by (t.id = p_template) desc limit 1));
$fn$;
revoke all on function public.hr_svc_template_mail(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.hr_svc_template_mail(uuid, text, uuid) to service_role;

-- ------------------------------------------------------------------ 5. signing_admin: the same function as 20261113140000 with body_html, subject, is_default, the HRMS checks and 'template_default'
create or replace function public.signing_admin(p_action text, p_id uuid default null, p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = pg_catalog, hr, public, pg_temp as $f$
declare v_admin uuid := hr.require_admin(); r hr.sign_requests; t hr.sign_templates; c hr.sign_recipients; v jsonb; v_roles jsonb; v_subject jsonb;
 v_id uuid; v_first jsonb; v_n integer; v_snapshot jsonb; v_problem text;
begin
 p_data := coalesce(p_data, '{}'::jsonb);
 if p_action = 'list' then
  return jsonb_build_object(
   'templates', coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from hr.sign_templates x where x.deleted_at is null), '[]'::jsonb),
   'requests', coalesce((select jsonb_agg(hr.sign_request_json(x) order by x.created_at desc) from hr.sign_requests x where x.id in (select q.id from hr.sign_requests q order by q.created_at desc limit 500)), '[]'::jsonb));
 elsif p_action = 'subject_search' then
  return hr.sign_subject_search(p_data->>'type', p_data->>'query');
 elsif p_action = 'subject_values' then
  return hr.sign_subject(p_data->>'type', p_id);
 elsif p_action = 'subject_list' then
  return coalesce((select jsonb_agg(hr.sign_request_json(x) order by x.created_at desc) from hr.sign_requests x where x.subject_type = p_data->>'type' and x.subject_id = p_id), '[]'::jsonb);
 elsif p_action = 'template_save' then
  v_roles := hr.sign_roles(p_data->'roles');
  if coalesce(p_data->>'kind', (select x.kind from hr.sign_templates x where x.id = p_id), 'text') = 'email'
   and coalesce(nullif(btrim(coalesce(p_data->>'subject', '')), ''), (select x.subject from hr.sign_templates x where x.id = p_id)) is null then
   raise exception 'Enter the email subject'; end if;
  select * into t from hr.sign_templates where id = p_id and deleted_at is null for update;
  if not found then
   insert into hr.sign_templates(id, name, title, body, body_html, subject, is_default, kind, audience, category, roles, fields, signing_mode, expiry_days, reminder_days, source_path, source_hash, source_pages, created_by)
    values (coalesce(p_id, gen_random_uuid()), p_data->>'name', p_data->>'title', coalesce(nullif(btrim(coalesce(p_data->>'body', '')), ''), hr.html_to_text(p_data->>'body_html')),
     nullif(btrim(coalesce(p_data->>'body_html', '')), ''), nullif(btrim(coalesce(p_data->>'subject', '')), ''), coalesce((p_data->>'is_default')::boolean, false), coalesce(p_data->>'kind', 'text'), coalesce(p_data->>'audience', 'any'),
     coalesce(p_data->>'category', 'other'), v_roles, hr.sign_template_fields(p_data->'fields', v_roles), coalesce(p_data->>'signing_mode', 'sequential'),
     coalesce((p_data->>'expiry_days')::integer, 14), coalesce((p_data->>'reminder_days')::integer, 3), p_data->>'source_path', p_data->>'source_hash', (p_data->>'source_pages')::integer, v_admin)
    returning * into t;
  else
   update hr.sign_templates set name = p_data->>'name', title = p_data->>'title',
    body = case when kind = 'pdf' then body else coalesce(nullif(btrim(coalesce(p_data->>'body', '')), ''), hr.html_to_text(p_data->>'body_html'), body) end,
    body_html = case when kind = 'pdf' then body_html when p_data ? 'body_html' then nullif(btrim(coalesce(p_data->>'body_html', '')), '') else body_html end,
    subject = case when p_data ? 'subject' then nullif(btrim(coalesce(p_data->>'subject', '')), '') else subject end,
    is_default = coalesce((p_data->>'is_default')::boolean, is_default),
    audience = coalesce(p_data->>'audience', audience), category = coalesce(p_data->>'category', category), roles = v_roles,
    fields = hr.sign_template_fields(coalesce(p_data->'fields', fields), v_roles), signing_mode = coalesce(p_data->>'signing_mode', signing_mode),
    expiry_days = coalesce((p_data->>'expiry_days')::integer, expiry_days), reminder_days = coalesce((p_data->>'reminder_days')::integer, reminder_days),
    source_path = coalesce(p_data->>'source_path', source_path), source_hash = coalesce(p_data->>'source_hash', source_hash),
    source_pages = coalesce((p_data->>'source_pages')::integer, source_pages), version = version + 1, updated_at = now() where id = p_id returning * into t;
  end if;
  -- A letter or an email keeps the HRMS rules (allowed placeholders, the link an email must carry, no scripts); one default per category.
  if hr.template_kind_of(t.category) is not null then
   if t.kind = 'pdf' then raise exception 'A letter or email template is text, not a PDF'; end if;
   if t.kind = 'email' and t.subject is null then raise exception 'Enter the email subject'; end if;
   v_problem := hr.template_problem(t.category, coalesce(t.subject, t.title), coalesce(t.body_html, hr.text_to_html(t.body), ''));
   if v_problem is not null then raise exception '%', v_problem; end if;
  end if;
  if t.is_default then update hr.sign_templates set is_default = false where category = t.category and is_default and id <> t.id; end if;
  insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), v_admin);
  return to_jsonb(t);
 elsif p_action in ('template_duplicate','template_archive','template_delete','template_versions','template_restore','template_default') then
  select * into t from hr.sign_templates where id = p_id and deleted_at is null for update;
  if not found then raise exception 'Template not found'; end if;
  if p_action = 'template_versions' then
   return coalesce((select jsonb_agg(jsonb_build_object('version', x.version, 'created_at', x.created_at, 'name', x.snapshot->>'name', 'title', x.snapshot->>'title') order by x.version desc)
    from hr.sign_template_versions x where x.template_id = p_id), '[]'::jsonb);
  elsif p_action = 'template_archive' then
   if t.status = 'active' and t.is_default then raise exception 'This is the default template. Make another one the default before archiving it.'; end if;
   update hr.sign_templates set status = case when status = 'active' then 'archived' else 'active' end, updated_at = now() where id = p_id returning * into t;
  elsif p_action = 'template_default' then
   if t.status = 'archived' then raise exception 'An archived template cannot be the default'; end if;
   update hr.sign_templates set is_default = false where category = t.category and is_default and id <> p_id;
   update hr.sign_templates set is_default = true, updated_at = now() where id = p_id returning * into t;
  elsif p_action = 'template_delete' then
   -- Requests keep their own fixed copy, so a deleted template only leaves the lists; its history stays for the requests made from it.
   if t.is_default then raise exception 'This is the default template. Make another one the default before deleting it.'; end if;
   update hr.sign_templates set deleted_at = now(), status = 'archived' where id = p_id returning * into t;
  elsif p_action = 'template_restore' then
   select snapshot into v_snapshot from hr.sign_template_versions where template_id = p_id and version = (p_data->>'version')::integer;
   if v_snapshot is null then raise exception 'Version not found'; end if;
   update hr.sign_templates set name = v_snapshot->>'name', title = v_snapshot->>'title', body = v_snapshot->>'body', body_html = v_snapshot->>'body_html', subject = v_snapshot->>'subject',
    audience = coalesce(v_snapshot->>'audience', audience),
    category = coalesce(v_snapshot->>'category', category), roles = coalesce(v_snapshot->'roles', roles), fields = coalesce(v_snapshot->'fields', fields),
    signing_mode = coalesce(v_snapshot->>'signing_mode', signing_mode), expiry_days = coalesce((v_snapshot->>'expiry_days')::integer, expiry_days),
    reminder_days = coalesce((v_snapshot->>'reminder_days')::integer, reminder_days), source_path = coalesce(v_snapshot->>'source_path', source_path),
    source_hash = coalesce(v_snapshot->>'source_hash', source_hash), source_pages = coalesce((v_snapshot->>'source_pages')::integer, source_pages),
    version = version + 1, updated_at = now() where id = p_id returning * into t;
   insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), v_admin);
  else
   -- A copy of a PDF template shares nothing: the function copies the file first and passes the new id and path.
   v_id := coalesce((p_data->>'new_id')::uuid, gen_random_uuid());
   insert into hr.sign_templates(id, name, title, body, body_html, subject, kind, audience, category, roles, fields, signing_mode, expiry_days, reminder_days, source_path, source_hash, source_pages, created_by)
    values (v_id, left(t.name || ' (copy)', 120), t.title, t.body, t.body_html, t.subject, t.kind, t.audience, t.category, t.roles, t.fields, t.signing_mode, t.expiry_days, t.reminder_days,
     case when t.kind = 'pdf' then p_data->>'source_path' end, t.source_hash, t.source_pages, v_admin) returning * into t;
   insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, 1, to_jsonb(t), v_admin);
  end if;
  return to_jsonb(t);
 elsif p_action = 'create' then
  -- The first-stage form (one recipient_name / recipient_email, 20261110154917 and 20261113100000) is one recipient.
  if p_data->'recipients' is null and p_data ? 'recipient_email' then
   p_data := p_data || jsonb_build_object('recipients', jsonb_build_array(jsonb_build_object('name', p_data->>'recipient_name', 'email', p_data->>'recipient_email')));
  end if;
  -- A staff member (20261113100000) is the request's employee.
  if nullif(p_data->>'profile_id', '') is not null then
   if not exists (select 1 from hr.staff_profiles where id = (p_data->>'profile_id')::uuid) then raise exception 'Staff member not found'; end if;
   if p_data->>'subject_type' is null then p_data := p_data || jsonb_build_object('subject_type', 'employee', 'subject_id', p_data->>'profile_id'); end if;
  end if;
  if jsonb_typeof(p_data->'recipients') <> 'array' or jsonb_array_length(p_data->'recipients') not between 1 and 10 then raise exception 'Add between 1 and 10 recipients'; end if;
  if not exists (select 1 from jsonb_array_elements(p_data->'recipients') x where coalesce((x->>'required')::boolean, true)) then raise exception 'At least one recipient must be required'; end if;
  v_first := p_data->'recipients'->0;
  if p_data->>'subject_type' is not null then v_subject := hr.sign_subject(p_data->>'subject_type', (p_data->>'subject_id')::uuid); end if;
  insert into hr.sign_requests(id, reference, title, recipient_name, recipient_email, template_id, template_version, rendered_text, field_values, original_path, original_hash, created_by,
    signing_mode, subject_type, subject_id, tenant_id, category, expiry_days, reminder_days, message, profile_id, edited, template_text)
   values (p_id, 'SLIT-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('hr.sign_reference_seq')::text, 6, '0'), p_data->>'title', btrim(v_first->>'name'), lower(btrim(v_first->>'email')),
    (p_data->>'template_id')::uuid, (select version from hr.sign_templates where id = (p_data->>'template_id')::uuid), p_data->>'rendered_text', coalesce(p_data->'field_values', '{}'::jsonb),
    p_id::text || '/original.pdf', p_data->>'original_hash', v_admin, coalesce(p_data->>'signing_mode', 'sequential'), p_data->>'subject_type', (p_data->>'subject_id')::uuid,
    (v_subject->>'tenant_id')::uuid, coalesce(p_data->>'category', 'other'), coalesce((p_data->>'expiry_days')::integer, 14), coalesce((p_data->>'reminder_days')::integer, 3),
    nullif(btrim(coalesce(p_data->>'message', '')), ''),
    case when p_data->>'subject_type' = 'employee' then (p_data->>'subject_id')::uuid end, coalesce((p_data->>'edited')::boolean, false),
    case when coalesce((p_data->>'edited')::boolean, false) then p_data->>'template_text' end) returning * into r;
  v_n := 0;
  for v in select * from jsonb_array_elements(p_data->'recipients') loop
   v_n := v_n + 1;
   insert into hr.sign_recipients(request_id, role_key, role_label, name, email, signing_order, required)
    values (p_id, coalesce(nullif(v->>'role', ''), 'signer' || v_n), coalesce(nullif(btrim(coalesce(v->>'label', '')), ''), 'Signer ' || v_n), btrim(v->>'name'), lower(btrim(v->>'email')),
     coalesce((v->>'order')::integer, v_n), coalesce((v->>'required')::boolean, true));
  end loop;
  for v in select * from jsonb_array_elements(coalesce(p_data->'fields', '[]'::jsonb)) loop
   insert into hr.sign_fields(request_id, recipient_id, type, page, x, y, w, h, required, label)
    select k.request_id, k.id, v->>'type', (v->>'page')::integer, (v->>'x')::numeric, (v->>'y')::numeric,
     (v->>'w')::numeric, (v->>'h')::numeric, coalesce((v->>'required')::boolean, true), left(coalesce(v->>'label', ''), 120)
    from hr.sign_recipients k where k.request_id = p_id and k.role_key = v->>'role';
  end loop;
  perform hr.sign_event(p_id, 'created', null, v_admin, jsonb_build_object('original_hash', r.original_hash, 'recipients', v_n));
  return hr.sign_request_json(r);
 end if;

 select * into r from hr.sign_requests where id = p_id for update;
 if not found then raise exception 'Signing request not found'; end if;
 if p_action = 'detail' then
  return hr.sign_request_json(r) || jsonb_build_object(
   'fields', coalesce((select jsonb_agg(to_jsonb(f) order by f.page, f.y, f.x) from hr.sign_fields f where f.request_id = p_id), '[]'::jsonb),
   'events', coalesce((select jsonb_agg(to_jsonb(e) || jsonb_build_object('recipient_name', (select name from hr.sign_recipients where id = e.recipient_id)) order by e.id) from hr.sign_events e where e.request_id = p_id), '[]'::jsonb),
   'notifications', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'audience', n.audience, 'state', n.state, 'recipient_id', n.recipient_id, 'created_at', n.created_at, 'sent_at', n.sent_at, 'error', n.error) order by n.id)
     from hr.sign_notifications n where n.request_id = p_id), '[]'::jsonb),
   'chain_ok', hr.sign_chain_ok(p_id));
 elsif p_action = 'fields_save' then
  if r.state <> 'draft' then raise exception 'Fields can only be changed while the request is a draft'; end if;
  if jsonb_typeof(p_data->'fields') <> 'array' or jsonb_array_length(p_data->'fields') > 200 then raise exception 'Use no more than 200 fields'; end if;
  delete from hr.sign_fields where request_id = p_id;
  for v in select * from jsonb_array_elements(p_data->'fields') loop
   if v->>'recipient_id' is null or not exists (select 1 from hr.sign_recipients where id = (v->>'recipient_id')::uuid and request_id = p_id) then
    raise exception 'Every field must belong to a recipient of this request';
   end if;
   insert into hr.sign_fields(request_id, recipient_id, type, page, x, y, w, h, required, label)
    values (p_id, (v->>'recipient_id')::uuid, v->>'type', (v->>'page')::integer, (v->>'x')::numeric, (v->>'y')::numeric, (v->>'w')::numeric, (v->>'h')::numeric,
     coalesce((v->>'required')::boolean, true), left(coalesce(v->>'label', ''), 120));
  end loop;
  perform hr.sign_event(p_id, 'fields_changed', null, v_admin, jsonb_build_object('fields', jsonb_array_length(p_data->'fields')));
 elsif p_action = 'send' then
  if r.state <> 'draft' then raise exception 'This request has already been sent'; end if;
  update hr.sign_requests set state = 'sent', sent_at = now(), expires_at = now() + make_interval(days => expiry_days) where id = p_id returning * into r;
  perform hr.sign_event(p_id, 'sent', null, v_admin, jsonb_build_object('mode', r.signing_mode, 'expires_at', r.expires_at));
  perform hr.sign_activate(p_id);
 elsif p_action = 'resend' then
  if hr.sign_status(r) not in ('sent','viewed','partial') then raise exception 'This request is not waiting for a signature'; end if;
  select * into c from hr.sign_recipients where id = (p_data->>'recipient_id')::uuid and request_id = p_id for update;
  if not found or c.state not in ('sent','viewed') then raise exception 'This recipient is not waiting to sign'; end if;
  -- One email per press: the key carries the number of emails already made for this recipient.
  perform hr.sign_queue(p_id, c.id, 'invite', 'invite:' || c.id || ':' || (1 + (select count(*) from hr.sign_notifications where recipient_id = c.id and kind = 'invite')));
  update hr.sign_recipients set last_notified_at = now(), delivery_error = null where id = c.id;
  perform hr.sign_event(p_id, 'resent', c.id, v_admin);
 elsif p_action = 'void' then
  if r.state in ('signed','declined','void','expired') then raise exception 'This request is closed'; end if;
  update hr.sign_requests set state = 'void', token_hash = null, closed_reason = nullif(left(btrim(coalesce(p_data->>'reason', '')), 500), '') where id = p_id returning * into r;
  perform hr.sign_stop(p_id, true);
  for c in select * from hr.sign_recipients where request_id = p_id and state in ('sent','viewed','signed') loop
   perform hr.sign_queue(p_id, c.id, 'voided', 'voided:' || c.id);
  end loop;
  perform hr.sign_event(p_id, 'voided', null, v_admin, jsonb_build_object('reason', r.closed_reason));
 elsif p_action = 'delete_draft' then
  if r.state <> 'draft' then raise exception 'Only a draft can be deleted'; end if;
  update hr.sign_requests set state = 'void', closed_reason = 'Draft discarded' where id = p_id returning * into r;
  perform hr.sign_event(p_id, 'draft_discarded', null, v_admin);
 else raise exception 'Unknown signing action'; end if;
 return hr.sign_request_json(r);
end $f$;
