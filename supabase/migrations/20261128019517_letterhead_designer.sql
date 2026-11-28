-- LETTERHEAD-DESIGNER (owner, 2026-11-28): the admin picks one of five letterhead designs (AI or the built-in designer, every design
-- checked against fixed rules in code) and chooses where it applies (Application form, Letter of Offer, Document templates, Workbook
-- added pages; "Select all"). Applying is one command that keeps the choice and puts the letterhead in place as new template versions
-- (earlier versions stay restorable; documents already made keep their own copy).
-- 1. Templates can have a smaller header for pages 2 and on (hr.sign_templates.header_later_html); the Application form keeps it per
--    submission like the rest of the form; the readers return it.
-- 2. public.brand_letterheads: every applied letterhead (the design, who chose it, where it went); one is active.
-- 3. letterhead_apply(design, targets): admins only; validates the HTML as template saves do.
-- 4. letter_standard_header / letter_standard_footer (what a new Letter of Offer starts with) follow the active letterhead when it was
--    applied to the Letter of Offer.
-- 5. brand_letterhead_active(): the active letterhead for the designer page and for workbook added pages.
begin;

-- 1. The later-page header.
alter table hr.sign_templates add column if not exists header_later_html text
  check (header_later_html is null or char_length(header_later_html) between 1 and 400000);
alter table public.application_form_used add column if not exists header_later_html text;

create or replace function pg_temp.lh_patch(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_fn);
begin
  if position(p_to in v_def) > 0 then return; end if; -- already patched (a re-run)
  if position(p_from in v_def) = 0 then raise exception 'LETTERHEAD-DESIGNER patch: % does not contain %', p_fn, p_from; end if;
  execute replace(v_def, p_from, p_to);
end $$;
select pg_temp.lh_patch('public.application_signed_copy(uuid)'::regprocedure,
  $f$'header_html', u.header_html, 'body_html', u.body_html, 'footer_html', u.footer_html)$f$,
  $t$'header_html', u.header_html, 'body_html', u.body_html, 'footer_html', u.footer_html, 'header_later_html', u.header_later_html)$t$);
select pg_temp.lh_patch('public.notification_delivery_submission(uuid,uuid)'::regprocedure,
  $f$'header_html', u.header_html, 'body_html', u.body_html, 'footer_html', u.footer_html)$f$,
  $t$'header_html', u.header_html, 'body_html', u.body_html, 'footer_html', u.footer_html, 'header_later_html', u.header_later_html)$t$);
select pg_temp.lh_patch('public.application_form_default(uuid)'::regprocedure,
  $f$'footer_html', t.footer_html, 'institute'$f$,
  $t$'footer_html', t.footer_html, 'header_later_html', t.header_later_html, 'institute'$t$);
select pg_temp.lh_patch('public.letter_templates()'::regprocedure,
  $f$'footerHtml', t.footer_html,$f$,
  $t$'footerHtml', t.footer_html, 'headerLaterHtml', t.header_later_html,$t$);

create or replace function skyline_private.application_form_record() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  -- rule-policy: technical application-form-record The default Application form at the moment of submission prints that submission, always.
  insert into public.application_form_used(application_id, version, template_id, template_version, template_name, title, header_html, header_later_html, body_html, footer_html)
  select new.application_id, new.version, t.id, t.version, t.name, t.title, t.header_html, t.header_later_html, coalesce(t.body_html, ''), t.footer_html
    from hr.sign_templates t where t.category = 'application_form' and t.is_default and t.status = 'active' and t.deleted_at is null and coalesce(t.body_html, '') <> ''
  on conflict do nothing;
  return null;
end $$;

-- 2. The letterheads applied.
create table if not exists public.brand_letterheads (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  style text not null check (style in ('classic', 'modern', 'minimal', 'bold', 'formal')),
  designer text not null check (designer in ('ai', 'built-in')),
  spec jsonb not null,
  html jsonb not null,
  targets text[] not null check (targets <@ array['application_form', 'letter_of_offer', 'document_templates', 'workbooks'] and cardinality(targets) >= 1),
  active boolean not null default true,
  applied_by uuid,
  applied_at timestamptz not null default now()
);
create unique index if not exists brand_letterheads_one_active on public.brand_letterheads((true)) where active;
alter table public.brand_letterheads enable row level security;
revoke all on public.brand_letterheads from public, anon, authenticated;

-- 3. Apply.
create or replace function public.letterhead_apply(p_design jsonb, p_targets text[]) returns jsonb
language plpgsql security definer set search_path to 'pg_catalog', 'hr', 'public', 'pg_temp' as $$
declare v_admin uuid := hr.require_admin(); h jsonb := coalesce(p_design->'html', '{}'::jsonb); v_id uuid; v_key text; v_problem text; t hr.sign_templates;
  v_title text; v_ver text; v_old text; v_done jsonb := '{}'::jsonb; v_n integer;
begin
  -- rule-policy: technical letterhead-apply The admin chooses where the letterhead goes (owner 2026-11-28); every HTML part is checked like a template save.
  if p_targets is null or cardinality(p_targets) = 0 or not (p_targets <@ array['application_form', 'letter_of_offer', 'document_templates', 'workbooks']) then
    raise exception 'Choose where to use the letterhead' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(h) loop
    v_problem := hr.rich_html_problem(h->>v_key);
    if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;
    if char_length(h->>v_key) > 400000 then raise exception 'The letterhead is too large' using errcode = '22023'; end if;
  end loop;
  update public.brand_letterheads set active = false where active;
  insert into public.brand_letterheads(name, style, designer, spec, html, targets, applied_by)
  values (left(coalesce(nullif(btrim(p_design->>'name'), ''), 'Letterhead'), 80), p_design->>'style', coalesce(p_design->>'designer', 'built-in'), coalesce(p_design->'spec', '{}'::jsonb), h, p_targets, v_admin)
  returning id into v_id;

  if 'application_form' = any(p_targets) then
    if coalesce(h->>'app_header', '') = '' or coalesce(h->>'app_footer', '') = '' then raise exception 'The Application form letterhead is missing' using errcode = '22023'; end if;
    for t in select * from hr.sign_templates where category = 'application_form' and is_default and deleted_at is null for update loop
      update hr.sign_templates set header_html = h->>'app_header', header_later_html = nullif(h->>'app_header_later', ''), footer_html = h->>'app_footer',
        version = version + 1, updated_at = now() where id = t.id returning * into t;
      insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), v_admin);
    end loop;
    v_done := v_done || jsonb_build_object('application_form', true);
  end if;

  if 'letter_of_offer' = any(p_targets) then
    if coalesce(h->>'loo_header', '') = '' or coalesce(h->>'loo_footer', '') = '' then raise exception 'The Letter of Offer letterhead is missing' using errcode = '22023'; end if;
    v_n := 0;
    for t in select * from hr.sign_templates where category = 'student_offer_letter' and deleted_at is null and status = 'active' for update loop
      v_old := regexp_replace(coalesce(t.footer_html, ''), '<[^>]*>', '', 'g');
      v_title := coalesce(nullif(btrim(substring(v_old from '^\s*([^·|]+?)\s*[·|]')), ''), 'LETTER OF OFFER AND WRITTEN AGREEMENT');
      v_ver := coalesce(nullif(btrim(substring(v_old from '[·|]\s*(Version[^·|]*?)\s*[·|]')), ''), 'Version 1.0');
      update hr.sign_templates set header_html = h->>'loo_header', header_later_html = nullif(h->>'loo_header_later', ''),
        footer_html = replace(replace(h->>'loo_footer', '{{document.title}}', v_title), '{{document.version}}', v_ver),
        version = version + 1, updated_at = now() where id = t.id returning * into t;
      insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), v_admin);
      v_n := v_n + 1;
    end loop;
    v_done := v_done || jsonb_build_object('letter_of_offer', v_n);
  end if;

  if 'document_templates' = any(p_targets) then
    if coalesce(h->>'preset_header', '') = '' or coalesce(h->>'preset_footer', '') = '' then raise exception 'The document template letterhead is missing' using errcode = '22023'; end if;
    update hr.sign_template_parts set html = h->>'preset_header', updated_at = now() where deleted_at is null and kind = 'header' and lower(btrim(name)) = 'slit house letterhead';
    if not found then insert into hr.sign_template_parts(kind, name, html, created_by) values ('header', 'SLIT house letterhead', h->>'preset_header', v_admin); end if;
    update hr.sign_template_parts set html = h->>'preset_footer', updated_at = now() where deleted_at is null and kind = 'footer' and lower(btrim(name)) = 'slit house footer';
    if not found then insert into hr.sign_template_parts(kind, name, html, created_by) values ('footer', 'SLIT house footer', h->>'preset_footer', v_admin); end if;
    v_done := v_done || jsonb_build_object('document_templates', true);
  end if;

  if 'workbooks' = any(p_targets) then v_done := v_done || jsonb_build_object('workbooks', true); end if;
  return jsonb_build_object('id', v_id, 'applied', v_done);
end $$;
revoke all on function public.letterhead_apply(jsonb, text[]) from public, anon;
grant execute on function public.letterhead_apply(jsonb, text[]) to authenticated;

-- 4. What a new Letter of Offer starts with follows the active letterhead (when it was applied to the Letter of Offer).
create or replace function public.letter_standard_header() returns text
language sql stable security definer set search_path to '' as $$
  select coalesce((select b.html->>'loo_header' from public.brand_letterheads b where b.active and 'letter_of_offer' = any(b.targets) and coalesce(b.html->>'loo_header', '') <> '' limit 1),
    '<table style="border:none;width:100%"><tr>'
    || '<td style="width:50%;vertical-align:middle;padding:0pt 0pt">{{institute.logo|h46}}</td>'
    || '<td style="width:50%;vertical-align:middle;text-align:right;padding:0pt 0pt">'
    || '<p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">{{institute.address}}</span></span></p>'
    || '<p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">{{institute.phone}}  |  {{institute.email}}  |  {{institute.website}}</span></span></p>'
    || '<p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">RTO {{institute.rto}}  |  CRICOS {{institute.cricos}}</span></span></p>'
    || '</td></tr>'
    || '<tr><td colspan="2" style="border-bottom:2.5pt solid #ea6619;padding:0pt 0pt"><p style="margin-bottom:0pt"><span style="font-size:3pt">&nbsp;</span></p></td></tr></table>');
$$;
create or replace function public.letter_standard_footer(p_title text default 'LETTER OF OFFER AND WRITTEN AGREEMENT', p_version text default 'Version Oct 2024') returns text
language sql stable security definer set search_path to '' as $$
  select coalesce((select replace(replace(b.html->>'loo_footer', '{{document.title}}', coalesce(p_title, '')), '{{document.version}}', coalesce(p_version, ''))
      from public.brand_letterheads b where b.active and 'letter_of_offer' = any(b.targets) and coalesce(b.html->>'loo_footer', '') <> '' limit 1),
    '<table style="border:none;width:100%"><tr><td style="border-top:0.5pt solid #d1d5db;padding:4pt 0pt 0pt 0pt">'
    || '<p style="text-align:center;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">' || coalesce(p_title, '') || '  |  ' || coalesce(p_version, '')
    || '  |  Student Initial ______________  |  Page {{page.number}} of {{page.total}}</span></span></p>'
    || '<p style="text-align:center;margin-bottom:0pt"><span style="font-size:6.5pt"><span style="color:#9ca3af">{{institute.legal_name}}  |  ABN {{institute.abn}}  |  RTO {{institute.rto}}  |  CRICOS {{institute.cricos}}</span></span></p>'
    || '</td></tr></table>');
$$;

-- 5. The active letterhead.
create or replace function public.brand_letterhead_active() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if auth.uid() is null or not (public.cms_is_staff() or public.portal_is_slit_admin()) then raise exception 'Only staff can do this.' using errcode = '42501'; end if;
  return (select jsonb_build_object('id', b.id, 'name', b.name, 'style', b.style, 'designer', b.designer, 'spec', b.spec, 'targets', to_jsonb(b.targets), 'appliedAt', b.applied_at,
      'workbookHeader', case when 'workbooks' = any(b.targets) then b.html->>'workbook_header' end)
    from public.brand_letterheads b where b.active limit 1);
end $$;
revoke all on function public.brand_letterhead_active() from public, anon;
grant execute on function public.brand_letterhead_active() to authenticated;

-- 6. The Edge Function allowlist (browser error reports, daily health check) gains letterhead-designer.
do $do$
declare names text[] := public.edge_function_names();
begin
 if not ('letterhead-designer' = any(names)) then
  names := array(select x from unnest(names || array['letterhead-designer']) x order by x);
  execute format('create or replace function public.edge_function_names() returns text[] language sql immutable as $f$ select %L::text[] $f$', names);
 end if;
end $do$;

commit;
