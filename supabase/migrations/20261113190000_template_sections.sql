-- Document templates with Header, Body and Footer (owner brief 2026-11-11, TPL-02). Additive on 20261113170000 (one template table).
--
-- 1. hr.sign_templates gains header_html and footer_html (rich HTML, repeated on every page of the PDF) and bracket_variables: when true,
--    every [Variable Name] in the three sections is a placeholder (registry variables are filled, any other token becomes a field the
--    signer fills in). Existing rows keep their body, get an empty header and footer and bracket_variables = false, so they render exactly
--    as before until someone saves them in the new editor (which lists the signer fields it found before saving).
-- 2. hr.sign_template_parts: reusable header and footer presets. A preset is COPIED into a template when it is picked, so changing a
--    preset later never changes a template (or a document) that already used it.
-- 3. public.signing_admin becomes a thin wrapper around the released function (renamed hr.signing_admin_core, body unchanged): it adds
--    the preset actions and keeps the three new columns on save, duplicate and restore, with the version snapshot including them.
-- Sections and [variables] are for document templates (kind text, not the HRMS letter / email categories, which keep {{placeholders}}).
-- Requests are not touched: each one keeps its own fixed original PDF and hash (SLIT-2026-000001 included).

alter table hr.sign_templates add column if not exists header_html text;
alter table hr.sign_templates add column if not exists footer_html text;
alter table hr.sign_templates add column if not exists bracket_variables boolean not null default false;
alter table hr.sign_templates drop constraint if exists sign_templates_header_html_check;
alter table hr.sign_templates add constraint sign_templates_header_html_check check (header_html is null or char_length(header_html) between 1 and 400000);
alter table hr.sign_templates drop constraint if exists sign_templates_footer_html_check;
alter table hr.sign_templates add constraint sign_templates_footer_html_check check (footer_html is null or char_length(footer_html) between 1 and 400000);
-- A long agreement with fee tables (and a picture) is longer than the 60,000 characters of a letter; its plain-text copy too.
alter table hr.sign_templates drop constraint if exists sign_templates_body_html_check;
alter table hr.sign_templates add constraint sign_templates_body_html_check check (body_html is null or char_length(body_html) between 1 and 400000);
alter table hr.sign_templates drop constraint if exists sign_templates_body_check;
alter table hr.sign_templates add constraint sign_templates_body_check check (body is null or length(btrim(body)) between 1 and 200000);
alter table hr.sign_templates drop constraint if exists sign_templates_sections_kind;
alter table hr.sign_templates add constraint sign_templates_sections_kind check (
 (header_html is null and footer_html is null and not bracket_variables) or kind = 'text');

-- Defence in depth: the pages and the function sanitise from an allow-list; the database still refuses what is never allowed.
create or replace function hr.rich_html_problem(p_html text) returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$
 select case
  when p_html is null then null
  when p_html ~* '<\s*/?\s*(script|style|iframe|frame|frameset|object|embed|form|input|button|textarea|select|link|meta|base|svg|math)\y' then 'The template contains content that is not allowed (scripts, frames, forms or embedded objects).'
  when p_html ~* '<[^>]*\son[a-z]+\s*=' then 'The template contains content that is not allowed (event handlers).'
  when p_html ~* '(javascript|vbscript)\s*:' then 'The template contains a link that is not allowed.'
  when p_html ~* '<\s*img\y[^>]*\ssrc\s*=(?![\s"'']*data:image/(png|jpeg);base64,)' then 'Pictures must be uploaded into the template (PNG or JPEG), not linked from another site.'
 end;
$fn$;
revoke all on function hr.rich_html_problem(text) from public, anon, authenticated;

create table if not exists hr.sign_template_parts (
 id uuid primary key default gen_random_uuid(),
 kind text not null check (kind in ('header', 'footer')),
 name text not null check (char_length(btrim(name)) between 1 and 80),
 html text not null check (char_length(html) between 1 and 400000),
 created_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 deleted_at timestamptz
);
create unique index if not exists sign_template_parts_name on hr.sign_template_parts(kind, lower(btrim(name))) where deleted_at is null;
alter table hr.sign_template_parts enable row level security;
revoke all on hr.sign_template_parts from public, anon, authenticated;

-- The released function, unchanged, under another name. Only the wrapper below may call it.
alter function public.signing_admin(text, uuid, jsonb) rename to signing_admin_core;
alter function public.signing_admin_core(text, uuid, jsonb) set schema hr;
revoke all on function hr.signing_admin_core(text, uuid, jsonb) from public, anon, authenticated;

create function public.signing_admin(p_action text, p_id uuid default null, p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = pg_catalog, hr, public, pg_temp as $f$
declare v_admin uuid := hr.require_admin(); v_out jsonb; t hr.sign_templates; s hr.sign_templates; p hr.sign_template_parts; v_problem text; v_kind text; v_category text;
 v_snapshot jsonb; v_sections boolean;
begin
 p_data := coalesce(p_data, '{}'::jsonb);
 -- ------------------------------------------------------------ header and footer presets
 if p_action = 'part_list' then
  return coalesce((select jsonb_agg(to_jsonb(x) - 'deleted_at' order by x.kind, lower(x.name)) from hr.sign_template_parts x where x.deleted_at is null), '[]'::jsonb);
 elsif p_action = 'part_save' then
  if coalesce(p_data->>'kind', '') not in ('header', 'footer') then raise exception 'Choose header or footer' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_data->>'name', ''))) not between 1 and 80 then raise exception 'Give the preset a name (up to 80 characters)' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_data->>'html', ''))) = 0 or char_length(p_data->>'html') > 400000 then raise exception 'The preset is empty or too long' using errcode = '22023'; end if;
  v_problem := hr.rich_html_problem(p_data->>'html');
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;
  if exists (select 1 from hr.sign_template_parts x where x.deleted_at is null and x.kind = p_data->>'kind' and lower(btrim(x.name)) = lower(btrim(p_data->>'name')) and x.id is distinct from p_id) then
   raise exception 'A % preset with this name already exists', p_data->>'kind' using errcode = '23505';
  end if;
  if p_id is null then
   insert into hr.sign_template_parts(kind, name, html, created_by) values (p_data->>'kind', btrim(p_data->>'name'), p_data->>'html', v_admin) returning * into p;
  else
   update hr.sign_template_parts set name = btrim(p_data->>'name'), html = p_data->>'html', updated_at = now() where id = p_id and deleted_at is null and kind = p_data->>'kind' returning * into p;
   if not found then raise exception 'Preset not found'; end if;
  end if;
  return to_jsonb(p) - 'deleted_at';
 elsif p_action = 'part_delete' then
  update hr.sign_template_parts set deleted_at = now() where id = p_id and deleted_at is null returning * into p;
  if not found then raise exception 'Preset not found'; end if;
  return jsonb_build_object('id', p.id, 'deleted', true);
 end if;

 -- ------------------------------------------------------------ the sections are checked before the released function writes anything
 if p_action = 'template_save' then
  v_kind := coalesce(p_data->>'kind', (select x.kind from hr.sign_templates x where x.id = p_id), 'text');
  v_category := coalesce(p_data->>'category', (select x.category from hr.sign_templates x where x.id = p_id), 'other');
  v_sections := nullif(btrim(coalesce(p_data->>'header_html', '')), '') is not null or nullif(btrim(coalesce(p_data->>'footer_html', '')), '') is not null
   or coalesce((p_data->>'bracket_variables')::boolean, false);
  if v_sections and (v_kind <> 'text' or hr.template_kind_of(v_category) is not null) then
   raise exception 'A header, a footer and [variables] are for document templates, not for HRMS letters, emails or PDF templates' using errcode = '22023';
  end if;
  v_problem := coalesce(hr.rich_html_problem(p_data->>'header_html'), hr.rich_html_problem(p_data->>'footer_html'), hr.rich_html_problem(p_data->>'body_html'));
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;
 end if;

 v_out := hr.signing_admin_core(p_action, p_id, p_data);

 if p_action = 'template_save' then
  update hr.sign_templates set
   header_html = case when p_data ? 'header_html' then nullif(btrim(coalesce(p_data->>'header_html', '')), '') else header_html end,
   footer_html = case when p_data ? 'footer_html' then nullif(btrim(coalesce(p_data->>'footer_html', '')), '') else footer_html end,
   bracket_variables = coalesce((p_data->>'bracket_variables')::boolean, bracket_variables)
  where id = (v_out->>'id')::uuid returning * into t;
 elsif p_action = 'template_duplicate' then
  select * into s from hr.sign_templates where id = p_id;
  update hr.sign_templates set header_html = s.header_html, footer_html = s.footer_html, bracket_variables = s.bracket_variables where id = (v_out->>'id')::uuid returning * into t;
 elsif p_action = 'template_restore' then
  select snapshot into v_snapshot from hr.sign_template_versions where template_id = p_id and version = (p_data->>'version')::integer;
  update hr.sign_templates set header_html = v_snapshot->>'header_html', footer_html = v_snapshot->>'footer_html',
   bracket_variables = coalesce((v_snapshot->>'bracket_variables')::boolean, false) where id = p_id returning * into t;
 else
  return v_out;
 end if;
 -- The version the released function just recorded, with the sections in it.
 update hr.sign_template_versions set snapshot = to_jsonb(t) where template_id = t.id and version = t.version;
 return to_jsonb(t);
end $f$;
revoke all on function public.signing_admin(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.signing_admin(text, uuid, jsonb) to authenticated;
