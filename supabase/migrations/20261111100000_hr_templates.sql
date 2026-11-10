-- Staff onboarding flow, part 2 (owner's brief 2026-11-10): HRMS > Templates and offer letters made from a template.
-- Additive; needs 20261111090000.
--
-- hr.templates           offer letter, offer email, document request email, document re-upload email, welcome / login email and
--                        rejection email. Rich text (HTML from an allow-list, sanitised by the editor and again by every renderer)
--                        with {{placeholders}}. One default per type; archived templates are kept but not offered.
-- hr.staff_offer_letters the exact letter that was produced for a person: the template used (id and name at the time), the rendered
--                        HTML and the values. The PDF is the hr.staff_offers row it belongs to (already stored with its sha256), so
--                        editing a template later never changes a letter that was made.
-- Admin RPCs (hr.require_admin): hr_admin_templates, hr_admin_template_save, hr_admin_template_duplicate,
--  hr_admin_template_archive, hr_admin_template_set_default, hr_admin_template_values (one person's values, for preview),
--  hr_admin_offer_letter_context (template + values + what blocks the letter), hr_admin_offer_letter_add (records the generated PDF).
-- Service RPC for the Edge Functions that send email: hr_svc_template_mail (default template of a type + one person's values).
-- Menu: HRMS > Templates (same permission as the other HRMS items: Admin).
--
-- Rollback (manual): delete the menu row 'staff_templates'; drop the functions of this file and the two tables.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists hr.templates (
 id uuid primary key default gen_random_uuid(),
 type text not null check (type in ('offer_letter', 'offer_email', 'document_request', 'document_reupload', 'welcome_login', 'rejection')),
 name text not null check (char_length(btrim(name)) between 1 and 120),
 -- Emails: the subject line. Offer letter: the document title (also the PDF file name).
 subject text not null check (char_length(btrim(subject)) between 1 and 200),
 body_html text not null check (char_length(body_html) between 1 and 60000),
 is_default boolean not null default false,
 archived_at timestamptz,
 archived_by uuid,
 created_at timestamptz not null default now(),
 created_by uuid,
 updated_at timestamptz not null default now(),
 updated_by uuid,
 check (not (is_default and archived_at is not null))
);
create unique index if not exists templates_one_default on hr.templates(type) where is_default;
create index if not exists templates_type_idx on hr.templates(type, lower(name));
alter table hr.templates enable row level security;
revoke all on hr.templates from public, anon, authenticated;
drop trigger if exists templates_touch on hr.templates;
create trigger templates_touch before update on hr.templates for each row execute function hr.touch_updated_at();

create table if not exists hr.staff_offer_letters (
 offer_id uuid primary key references hr.staff_offers(id) on delete cascade,
 profile_id uuid not null references hr.staff_profiles(id) on delete cascade,
 template_id uuid references hr.templates(id) on delete set null,
 template_name text not null check (char_length(template_name) <= 120),
 title text not null check (char_length(title) <= 200),
 body_html text not null check (char_length(body_html) between 1 and 200000),
 field_values jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 created_by uuid
);
create index if not exists staff_offer_letters_profile_idx on hr.staff_offer_letters(profile_id);
alter table hr.staff_offer_letters enable row level security;
revoke all on hr.staff_offer_letters from public, anon, authenticated;

-- ------------------------------------------------------------------ helpers
create or replace function hr.template_placeholders(p_type text) returns text[]
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$
 select array['first_name','last_name','full_name','email','position','department','employment_type','start_date','pay_rate','pay_basis',
  'pay_schedule','hours_per_week','manager_name','work_location','company_name','today','login_url']
  || case when p_type in ('offer_email', 'welcome_login') then array['signing_link', 'link_expiry'] else array[]::text[] end
  || case when p_type in ('document_request', 'document_reupload') then array['document_link', 'link_expiry'] else array[]::text[] end
  || case when p_type = 'document_reupload' then array['rejected_documents'] else array[]::text[] end;
$fn$;

-- What is wrong with a template (null = fine): an unknown placeholder, a missing required link, or markup that is never allowed.
-- The editor and every renderer sanitise the HTML from an allow-list; this is the database's own floor.
create or replace function hr.template_problem(p_type text, p_subject text, p_body text) returns text
language plpgsql immutable set search_path = hr, pg_catalog, pg_temp as $fn$
declare v_key text; v_allowed text[] := hr.template_placeholders(p_type);
begin
 if p_body ~* '<\s*(script|style|iframe|object|embed|form|link|meta|base)\y' or p_body ~* '<[^>]*\son[a-z]+\s*=' or p_body ~* '(href|src)\s*=\s*["'']?\s*(javascript|vbscript|data)\s*:' then
  return 'The template contains markup that is not allowed (scripts, styles, frames or event handlers).'; end if;
 for v_key in select distinct lower(m[1]) from regexp_matches(coalesce(p_subject, '') || ' ' || coalesce(p_body, ''), '\{\{\s*([A-Za-z0-9_]+)\s*\}\}', 'g') m loop
  if v_key <> all(v_allowed) then return format('{{%s}} cannot be used in this kind of template.', v_key); end if;
 end loop;
 if p_type in ('offer_email', 'welcome_login') and p_body !~* '\{\{\s*signing_link\s*\}\}' then return 'This email must contain {{signing_link}} so the person can sign in.'; end if;
 if p_type in ('document_request', 'document_reupload') and p_body !~* '\{\{\s*document_link\s*\}\}' then return 'This email must contain {{document_link}} so the person can upload their documents.'; end if;
 return null;
end $fn$;

create or replace function hr.template_json(t hr.templates) returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $fn$
 select jsonb_build_object('id', t.id, 'type', t.type, 'name', t.name, 'subject', t.subject, 'bodyHtml', t.body_html, 'isDefault', t.is_default,
  'archivedAt', t.archived_at, 'createdAt', t.created_at, 'updatedAt', t.updated_at);
$fn$;
revoke all on function hr.template_placeholders(text), hr.template_problem(text, text, text), hr.template_json(hr.templates) from public, anon, authenticated;

-- One person's raw values for the placeholders (formatted by the shared renderer: dates, money, labels).
create or replace function hr.template_values(p_profile uuid) returns jsonb
language sql stable security definer set search_path = hr, public, pg_temp as $fn$
 select jsonb_build_object('firstName', p.first_name, 'lastName', p.last_name, 'fullName', btrim(concat_ws(' ', p.first_name, p.last_name)), 'email', p.email,
  'position', e.job_title, 'department', e.department, 'employmentType', e.employment_type, 'startDate', e.joining_date,
  'payRate', ep.rate, 'payBasis', ep.pay_basis, 'paySchedule', (select s.name from hr.pay_schedules s where s.id = ep.pay_schedule_id),
  'hoursPerWeek', case when e.profile_id is not null then hr.employee_ordinary_hours_week(p.id) end,
  'managerName', (select hr.staff_name(m) from hr.staff_profiles m where m.id = e.manager_id), 'workLocation', e.work_location,
  'companyName', coalesce((select nullif(btrim(c.name), '') from public.cms_settings c limit 1), 'Skyline Institute of Technology'),
  'today', (now() at time zone coalesce((select s.timezone from hr.settings s limit 1), 'Australia/Melbourne'))::date)
 from hr.staff_profiles p left join hr.employment e on e.profile_id = p.id left join hr.employee_pay ep on ep.profile_id = p.id
 where p.id = p_profile;
$fn$;
revoke all on function hr.template_values(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ admin RPCs
create or replace function public.hr_admin_templates(p_include_archived boolean default true) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_admin();
 return coalesce((select jsonb_agg(hr.template_json(t) order by t.type, (t.archived_at is not null), t.is_default desc, lower(t.name))
  from hr.templates t where p_include_archived or t.archived_at is null), '[]'::jsonb);
end $fn$;

create or replace function public.hr_admin_template_save(p_id uuid, p_template jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); t hr.templates; v_type text := p_template->>'type'; v_name text := btrim(coalesce(p_template->>'name', ''));
 v_subject text := btrim(regexp_replace(coalesce(p_template->>'subject', ''), '[[:cntrl:]]+', ' ', 'g')); v_body text := coalesce(p_template->>'bodyHtml', ''); v_problem text;
begin
 if p_id is not null then
  select * into t from hr.templates where id = p_id for update;
  if not found then raise exception 'Template not found.' using errcode = 'P0002'; end if;
  if t.archived_at is not null then raise exception 'Restore the template before editing it.' using errcode = '23514'; end if;
  v_type := t.type;
 end if;
 if v_type is null or v_type not in ('offer_letter', 'offer_email', 'document_request', 'document_reupload', 'welcome_login', 'rejection') then
  raise exception 'Choose the kind of template.' using errcode = '22023'; end if;
 if v_name = '' or char_length(v_name) > 120 then raise exception 'Give the template a name (up to 120 characters).' using errcode = '22023'; end if;
 if v_subject = '' or char_length(v_subject) > 200 then
  raise exception '%', case when v_type = 'offer_letter' then 'Give the letter a title (up to 200 characters).' else 'Enter the email subject (up to 200 characters).' end using errcode = '22023'; end if;
 if btrim(regexp_replace(v_body, '<[^>]*>|&nbsp;|\s', '', 'g')) = '' then raise exception 'The template has no text.' using errcode = '22023'; end if;
 if char_length(v_body) > 60000 then raise exception 'The template is too long.' using errcode = '22023'; end if;
 v_problem := hr.template_problem(v_type, v_subject, v_body);
 if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;
 if exists (select 1 from hr.templates x where x.type = v_type and lower(x.name) = lower(v_name) and x.id is distinct from p_id and x.archived_at is null) then
  raise exception 'Another template of this kind is already called "%".', v_name using errcode = '23505'; end if;
 if p_id is null then
  -- The first template of a kind becomes its default.
  insert into hr.templates(type, name, subject, body_html, is_default, created_by, updated_by)
   values (v_type, v_name, v_subject, v_body, not exists (select 1 from hr.templates x where x.type = v_type and x.is_default), v_admin, v_admin) returning * into t;
 else
  update hr.templates set name = v_name, subject = v_subject, body_html = v_body, updated_by = v_admin where id = p_id returning * into t;
 end if;
 return hr.template_json(t);
end $fn$;

create or replace function public.hr_admin_template_duplicate(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); t hr.templates; n hr.templates; v_name text; i integer := 1;
begin
 select * into t from hr.templates where id = p_id;
 if not found then raise exception 'Template not found.' using errcode = 'P0002'; end if;
 loop
  v_name := left(t.name, 100) || case when i = 1 then ' (copy)' else format(' (copy %s)', i) end;
  exit when not exists (select 1 from hr.templates x where x.type = t.type and lower(x.name) = lower(v_name) and x.archived_at is null);
  i := i + 1;
 end loop;
 insert into hr.templates(type, name, subject, body_html, is_default, created_by, updated_by) values (t.type, v_name, t.subject, t.body_html, false, v_admin, v_admin) returning * into n;
 return hr.template_json(n);
end $fn$;

create or replace function public.hr_admin_template_archive(p_id uuid, p_archived boolean default true) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); t hr.templates;
begin
 select * into t from hr.templates where id = p_id for update;
 if not found then raise exception 'Template not found.' using errcode = 'P0002'; end if;
 if coalesce(p_archived, true) then
  if t.is_default then raise exception 'This is the default template. Make another one the default before archiving it.' using errcode = '23514'; end if;
  update hr.templates set archived_at = coalesce(archived_at, now()), archived_by = v_admin, updated_by = v_admin where id = t.id returning * into t;
 else
  if exists (select 1 from hr.templates x where x.type = t.type and lower(x.name) = lower(t.name) and x.id <> t.id and x.archived_at is null) then
   raise exception 'Another template of this kind is already called "%". Rename that one first.', t.name using errcode = '23505'; end if;
  update hr.templates set archived_at = null, archived_by = null, updated_by = v_admin where id = t.id returning * into t;
 end if;
 return hr.template_json(t);
end $fn$;

create or replace function public.hr_admin_template_set_default(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); t hr.templates;
begin
 select * into t from hr.templates where id = p_id for update;
 if not found then raise exception 'Template not found.' using errcode = 'P0002'; end if;
 if t.archived_at is not null then raise exception 'An archived template cannot be the default.' using errcode = '23514'; end if;
 update hr.templates set is_default = false, updated_by = v_admin where type = t.type and is_default and id <> t.id;
 update hr.templates set is_default = true, updated_by = v_admin where id = t.id returning * into t;
 return hr.template_json(t);
end $fn$;

create or replace function public.hr_admin_template_values(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v jsonb;
begin
 perform hr.require_admin();
 v := hr.template_values(p_id);
 if v is null then raise exception 'Staff record not found.' using errcode = 'P0002'; end if;
 return v;
end $fn$;

-- Everything "Send offer letter" needs: the templates to choose from, this person's values and what still blocks the letter.
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
  'letter', (select jsonb_build_object('offerId', l.offer_id, 'templateId', l.template_id, 'templateName', l.template_name, 'title', l.title, 'bodyHtml', l.body_html, 'createdAt', l.created_at)
    from hr.staff_offer_letters l join hr.staff_offers o on o.id = l.offer_id where l.profile_id = p.id and o.withdrawn_at is null order by l.created_at desc limit 1));
end $fn$;

-- Records a letter the staff-admin function rendered and stored as a PDF: the offer row (same checks as an uploaded offer) and the
-- snapshot of what was rendered. p_html is the filled-in, sanitised letter; p_values the values it was filled with.
create or replace function public.hr_admin_offer_letter_add(p_id uuid, p_path text, p_filename text, p_size integer, p_sha256 text, p_template uuid, p_title text, p_html text, p_values jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); t hr.templates; r jsonb; v_problem text;
begin
 select * into t from hr.templates where id = p_template;
 if not found or t.type <> 'offer_letter' or t.archived_at is not null then raise exception 'Choose an offer letter template.' using errcode = '22023'; end if;
 if p_html is null or btrim(p_html) = '' or char_length(p_html) > 200000 then raise exception 'The letter is empty or too long.' using errcode = '22023'; end if;
 if p_html ~ '\{\{\s*[A-Za-z0-9_]+\s*\}\}' then raise exception 'The letter still has placeholders that were not filled in.' using errcode = '23514'; end if;
 v_problem := coalesce(hr.staff_documents_problem(p_id), hr.onboarding_pay_problem(p_id));
 if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;
 r := public.hr_admin_staff_offer_add(p_id, p_path, p_filename, p_size, p_sha256);
 insert into hr.staff_offer_letters(offer_id, profile_id, template_id, template_name, title, body_html, field_values, created_by)
  values ((r->'offer'->>'id')::uuid, p_id, t.id, t.name, left(btrim(coalesce(p_title, t.subject)), 200), p_html, coalesce(p_values, '{}'::jsonb), v_admin);
 perform hr.audit_log(p_id, 'offer_letter_generated', jsonb_build_object('template', t.name));
 return r;
end $fn$;

revoke all on function public.hr_admin_templates(boolean), public.hr_admin_template_save(uuid, jsonb), public.hr_admin_template_duplicate(uuid),
 public.hr_admin_template_archive(uuid, boolean), public.hr_admin_template_set_default(uuid), public.hr_admin_template_values(uuid),
 public.hr_admin_offer_letter_context(uuid), public.hr_admin_offer_letter_add(uuid, text, text, integer, text, uuid, text, text, jsonb) from public, anon;
grant execute on function public.hr_admin_templates(boolean), public.hr_admin_template_save(uuid, jsonb), public.hr_admin_template_duplicate(uuid),
 public.hr_admin_template_archive(uuid, boolean), public.hr_admin_template_set_default(uuid), public.hr_admin_template_values(uuid),
 public.hr_admin_offer_letter_context(uuid), public.hr_admin_offer_letter_add(uuid, text, text, integer, text, uuid, text, text, jsonb) to authenticated;

-- ------------------------------------------------------------------ service RPC (email senders)
-- The template to send for a kind of email (a chosen one, else the default) with one person's values; template null = none exists
-- (the sender then falls back to its built-in text).
create or replace function public.hr_svc_template_mail(p_profile uuid, p_type text, p_template uuid default null) returns jsonb
language sql stable security definer set search_path = public, hr, pg_temp as $fn$
 select jsonb_build_object('values', hr.template_values(p_profile),
  'template', (select jsonb_build_object('id', t.id, 'name', t.name, 'subject', t.subject, 'bodyHtml', t.body_html) from hr.templates t
    where t.type = p_type and t.archived_at is null and (t.id = p_template or (p_template is null and t.is_default)) order by (t.id = p_template) desc limit 1));
$fn$;
revoke all on function public.hr_svc_template_mail(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.hr_svc_template_mail(uuid, text, uuid) to service_role;

-- ------------------------------------------------------------------ seeds: one default of each kind (only when that kind is empty)
insert into hr.templates(type, name, subject, body_html, is_default)
select s.type, s.name, s.subject, s.body, true from (values
 ('offer_letter', 'Standard offer letter', 'Offer of employment',
  '<p>{{today}}</p><p>{{full_name}}</p><h2>Offer of employment: {{position}}</h2><p>Dear {{first_name}},</p>'
  || '<p>We are pleased to offer you the position of <strong>{{position}}</strong> with {{company_name}}. This letter sets out the main terms of the offer.</p>'
  || '<h3>Your position</h3><ul><li>Position: {{position}}</li><li>Employment type: {{employment_type}}</li><li>Start date: {{start_date}}</li>'
  || '<li>Hours: {{hours_per_week}} hours per week</li><li>Location: {{work_location}}</li><li>Reporting to: {{manager_name}}</li></ul>'
  || '<h3>Your pay</h3><p>You will be paid <strong>{{pay_rate}} {{pay_basis}}</strong>, on the {{pay_schedule}} pay schedule, less applicable tax. Superannuation is paid in addition, at the rate required by law.</p>'
  || '<h3>Conditions</h3><p>This offer depends on you holding the right to work in Australia and on the documents you provided remaining valid. Your employment is covered by the National Employment Standards and any applicable award.</p>'
  || '<h3>Accepting this offer</h3><p>To accept, read this letter and sign it electronically on the page where you are reading it.</p>'
  || '<p>We look forward to welcoming you to the team.</p><p>Yours sincerely,</p><p><strong>{{company_name}}</strong></p>'),
 ('offer_email', 'Standard offer email', 'Your offer letter from {{company_name}}',
  '<p>Hello {{first_name}},</p><p>We are pleased to offer you the position of <strong>{{position}}</strong> with {{company_name}}.</p>'
  || '<p>Your offer letter is ready to read and sign. Use your personal link to sign in:</p><p><a href="{{signing_link}}">{{signing_link}}</a></p>'
  || '<p>The first time, the link asks you to choose a password. It works until {{link_expiry}} and is personal: please do not forward it.</p>'
  || '<p>{{company_name}}<br>This is an automated message.</p>'),
 ('document_request', 'Standard document request', 'Next step: your details and documents',
  '<p>Hello {{first_name}},</p><p>Thank you for applying. Please add your personal details and documents using this private link:</p>'
  || '<p><a href="{{document_link}}">{{document_link}}</a></p><p>The link works until {{link_expiry}}. It is personal: please do not forward it. You do not need an account or a password.</p>'
  || '<p>{{company_name}}<br>This is an automated message.</p>'),
 ('document_reupload', 'Standard document re-upload', 'Please upload a document again',
  '<p>Hello {{first_name}},</p><p>We need a new copy of the following:</p><p>{{rejected_documents}}</p><p>Upload it with this private link:</p>'
  || '<p><a href="{{document_link}}">{{document_link}}</a></p><p>The link works until {{link_expiry}}. It is personal: please do not forward it.</p>'
  || '<p>{{company_name}}<br>This is an automated message.</p>'),
 ('welcome_login', 'Standard welcome and login', 'Your {{company_name}} staff sign-in',
  '<p>Hello {{first_name}},</p><p>Here is a new personal link to sign in to your staff account with {{company_name}}:</p><p><a href="{{signing_link}}">{{signing_link}}</a></p>'
  || '<p>The link asks you to choose your own password. It works until {{link_expiry}} and can be used once. After that, sign in at {{login_url}} with your email address and password.</p>'
  || '<p>{{company_name}}<br>This is an automated message.</p>'),
 ('rejection', 'Standard rejection', 'Your staff application',
  '<p>Hello {{first_name}},</p><p>Thank you for your interest in working with us. After reviewing your application we will not be continuing with it at this time.</p>'
  || '<p>We wish you all the best.</p><p>{{company_name}}<br>This is an automated message.</p>')
) as s(type, name, subject, body)
where not exists (select 1 from hr.templates t where t.type = s.type);

-- ------------------------------------------------------------------ menu: HRMS > Templates
do $menu$
declare v_item public.admin_menu_items;
begin
 select * into v_item from public.admin_menu_items where id = 'staff_pay_schedules';
 alter table public.admin_menu_items disable trigger protect_admin_menu;
 insert into public.admin_menu_items(id, parent_id, label, route, icon_key, sort_order, is_enabled, permission_key, permission_scope, is_system) values
  ('staff_templates', 'staff', 'Templates', '/admin/staff/templates', 'template', 90, true, coalesce(v_item.permission_key, 'cms.admin'), coalesce(v_item.permission_scope, 'current'), true)
 on conflict (id) do update set parent_id = 'staff', label = excluded.label, route = excluded.route, icon_key = excluded.icon_key, sort_order = excluded.sort_order, is_enabled = true;
 alter table public.admin_menu_items enable trigger protect_admin_menu;
end $menu$;
