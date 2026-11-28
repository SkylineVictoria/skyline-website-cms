-- LETTERHEAD-ON-DOCUMENTS (owner, 2026-11-28: "letterhead is a variable coming from the logo and RTO details; AI gives 5 options, the user
-- selects one; for any document in Sign and its templates ask the user to put the document on the letterhead"). Owner choices: ticked by
-- default for new documents; an uploaded PDF is shrunk to fit between the letterhead header and footer (done in the browser before upload).
-- 1. hr.sign_templates.use_letterhead: a text template "on the letterhead" takes its header, later-page header and footer from the active
--    letterhead, on every save and whenever the admin applies another letterhead (a new template version each time it changes).
-- 2. hr.letterhead_fill(template): the letterhead parts for that template (Application form, Letter of Offer with its own title / version
--    in the footer, any other document: the document letterhead).
-- 3. letterhead_apply: the Application form and Letter of Offer targets tick use_letterhead on those templates; every template on the
--    letterhead follows the new one; the document letterhead (preset_*) is always part of a design.
-- 4. sign_template_use_letterhead(id, on): the tick in the template editor (admins). Turning it off keeps the current header and footer as
--    the template's own (editable) copy.
begin;

alter table hr.sign_templates add column if not exists use_letterhead boolean not null default false;

create or replace function hr.letterhead_fill(t hr.sign_templates) returns hr.sign_templates
language plpgsql stable security definer set search_path to '' as $$
declare h jsonb; v_old text; v_title text; v_ver text;
begin
  -- rule-policy: technical letterhead-fill A template on the letterhead prints the active letterhead (owner 2026-11-28).
  select b.html into h from public.brand_letterheads b where b.active limit 1;
  if h is null or t.kind is distinct from 'text' then return t; end if;
  if t.category = 'application_form' and coalesce(h->>'app_header', '') <> '' then
    t.header_html := h->>'app_header'; t.header_later_html := nullif(h->>'app_header_later', ''); t.footer_html := nullif(h->>'app_footer', '');
  elsif t.category = 'student_offer_letter' and coalesce(h->>'loo_header', '') <> '' then
    v_old := regexp_replace(coalesce(t.footer_html, ''), '<[^>]*>', '', 'g');
    v_title := coalesce(nullif(btrim(substring(v_old from '^\s*([^·|]+?)\s*[·|]')), ''), 'LETTER OF OFFER AND WRITTEN AGREEMENT');
    v_ver := coalesce(nullif(btrim(substring(v_old from '[·|]\s*(Version[^·|]*?)\s*[·|]')), ''), 'Version 1.0');
    t.header_html := h->>'loo_header'; t.header_later_html := nullif(h->>'loo_header_later', '');
    t.footer_html := replace(replace(h->>'loo_footer', '{{document.title}}', v_title), '{{document.version}}', v_ver);
  elsif coalesce(h->>'preset_header', '') <> '' then
    t.header_html := h->>'preset_header'; t.header_later_html := nullif(h->>'preset_header_later', ''); t.footer_html := nullif(h->>'preset_footer', '');
  end if;
  return t;
end $$;
revoke all on function hr.letterhead_fill(hr.sign_templates) from public, anon, authenticated;

create or replace function skyline_private.sign_template_letterhead() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.use_letterhead and new.kind = 'text' then new := hr.letterhead_fill(new); end if;
  return new;
end $$;
drop trigger if exists sign_template_letterhead on hr.sign_templates;
create trigger sign_template_letterhead before insert or update on hr.sign_templates
  for each row execute function skyline_private.sign_template_letterhead();

-- The templates on the letterhead that differ from it get a new version (restorable from Versions).
create or replace function hr.letterhead_follow(p_admin uuid) returns integer
language plpgsql security definer set search_path to '' as $$
declare t hr.sign_templates; f hr.sign_templates; v_n integer := 0;
begin
  for t in select * from hr.sign_templates where use_letterhead and kind = 'text' and deleted_at is null for update loop
    f := hr.letterhead_fill(t);
    if f.header_html is distinct from t.header_html or f.header_later_html is distinct from t.header_later_html or f.footer_html is distinct from t.footer_html then
      update hr.sign_templates set version = version + 1, updated_at = now() where id = t.id returning * into t;
      insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), p_admin);
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;
revoke all on function hr.letterhead_follow(uuid) from public, anon, authenticated;

-- Puts the Application form (the default) or the active Letters of Offer on the letterhead, each as a new version.
create or replace function hr.letterhead_tick(p_admin uuid, p_category text) returns void
language plpgsql security definer set search_path to '' as $$
declare t hr.sign_templates;
begin
  for t in select * from hr.sign_templates x where x.category = p_category and x.kind = 'text' and x.deleted_at is null and not x.use_letterhead
      and (case when p_category = 'application_form' then x.is_default else x.status = 'active' end) for update loop
    update hr.sign_templates set use_letterhead = true, version = version + 1, updated_at = now() where id = t.id returning * into t;
    insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), p_admin);
  end loop;
end $$;
revoke all on function hr.letterhead_tick(uuid, text) from public, anon, authenticated;

create or replace function public.letterhead_apply(p_design jsonb, p_targets text[]) returns jsonb
language plpgsql security definer set search_path to 'pg_catalog', 'hr', 'public', 'pg_temp' as $$
declare v_admin uuid := hr.require_admin(); h jsonb := coalesce(p_design->'html', '{}'::jsonb); v_id uuid; v_key text; v_problem text; v_done jsonb := '{}'::jsonb;
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
  if coalesce(h->>'preset_header', '') = '' or coalesce(h->>'preset_footer', '') = '' then raise exception 'The document letterhead is missing' using errcode = '22023'; end if;
  if 'application_form' = any(p_targets) and (coalesce(h->>'app_header', '') = '' or coalesce(h->>'app_footer', '') = '') then raise exception 'The Application form letterhead is missing' using errcode = '22023'; end if;
  if 'letter_of_offer' = any(p_targets) and (coalesce(h->>'loo_header', '') = '' or coalesce(h->>'loo_footer', '') = '') then raise exception 'The Letter of Offer letterhead is missing' using errcode = '22023'; end if;

  update public.brand_letterheads set active = false where active;
  insert into public.brand_letterheads(name, style, designer, spec, html, targets, applied_by)
  values (left(coalesce(nullif(btrim(p_design->>'name'), ''), 'Letterhead'), 80), p_design->>'style', coalesce(p_design->>'designer', 'built-in'), coalesce(p_design->'spec', '{}'::jsonb), h, p_targets, v_admin)
  returning id into v_id;

  -- The chosen targets go on the letterhead (the trigger fills them; hr.letterhead_follow below makes the versions).
  if 'application_form' = any(p_targets) then
    perform hr.letterhead_tick(v_admin, 'application_form');
    v_done := v_done || jsonb_build_object('application_form', true);
  end if;
  if 'letter_of_offer' = any(p_targets) then
    perform hr.letterhead_tick(v_admin, 'student_offer_letter');
    v_done := v_done || jsonb_build_object('letter_of_offer', true);
  end if;
  if 'document_templates' = any(p_targets) then
    update hr.sign_template_parts set html = h->>'preset_header', updated_at = now() where deleted_at is null and kind = 'header' and lower(btrim(name)) = 'slit house letterhead';
    if not found then insert into hr.sign_template_parts(kind, name, html, created_by) values ('header', 'SLIT house letterhead', h->>'preset_header', v_admin); end if;
    update hr.sign_template_parts set html = h->>'preset_footer', updated_at = now() where deleted_at is null and kind = 'footer' and lower(btrim(name)) = 'slit house footer';
    if not found then insert into hr.sign_template_parts(kind, name, html, created_by) values ('footer', 'SLIT house footer', h->>'preset_footer', v_admin); end if;
    v_done := v_done || jsonb_build_object('document_templates', true);
  end if;
  if 'workbooks' = any(p_targets) then v_done := v_done || jsonb_build_object('workbooks', true); end if;
  -- Every template on the letterhead follows it (each one that changed becomes a new, restorable version).
  v_done := v_done || jsonb_build_object('templates_updated', hr.letterhead_follow(v_admin));
  return jsonb_build_object('id', v_id, 'applied', v_done);
end $$;
revoke all on function public.letterhead_apply(jsonb, text[]) from public, anon;
grant execute on function public.letterhead_apply(jsonb, text[]) to authenticated;

create or replace function public.sign_template_use_letterhead(p_id uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path to 'pg_catalog', 'hr', 'public', 'pg_temp' as $$
declare v_admin uuid := hr.require_admin(); t hr.sign_templates;
begin
  -- rule-policy: technical sign-template-letterhead "Put on letterhead" in the template editor (owner 2026-11-28).
  select * into t from hr.sign_templates where id = p_id and deleted_at is null for update;
  if not found then raise exception 'Template not found' using errcode = 'P0002'; end if;
  if t.kind <> 'text' then raise exception 'Only a written template takes the letterhead this way; a PDF is put on the letterhead when it is uploaded' using errcode = '22023'; end if;
  if t.use_letterhead is distinct from coalesce(p_on, false) then
    update hr.sign_templates set use_letterhead = coalesce(p_on, false), version = version + 1, updated_at = now() where id = p_id returning * into t;
    insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), v_admin);
  end if;
  return to_jsonb(t);
end $$;
revoke all on function public.sign_template_use_letterhead(uuid, boolean) from public, anon;
grant execute on function public.sign_template_use_letterhead(uuid, boolean) to authenticated;

commit;
