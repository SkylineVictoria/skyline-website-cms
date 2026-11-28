-- HOUSE-STYLE batch 1 (owner, 2026-11-28: "make all forms in the whole application use this type of form so it is the same everywhere").
-- 1. The standard letterhead and footer (letter_standard_header / letter_standard_footer, what a new Letter of Offer starts with) take
--    the house design of the Application form: logo with the contact block on the right and an orange rule; a footer with a hairline,
--    the document title, version, the student's initials line and the page count, then the legal name, ABN, RTO and CRICOS.
-- 2. The active Letter of Offer templates get that header and footer as a new version (their body, the letter itself, is unchanged;
--    every earlier version stays restorable from the editor; letters already issued keep their own copy).
-- 3. application_form_default(application): the default Application form and the institute's details, so an application not signed
--    yet prints in the same design ("Not signed yet") from the application's PDF button.
begin;

create or replace function public.letter_standard_header() returns text
language sql immutable set search_path to 'pg_catalog' as $$
  select '<table style="border:none;width:100%"><tr>'
    || '<td style="width:50%;vertical-align:middle;padding:0pt 0pt">{{institute.logo|h46}}</td>'
    || '<td style="width:50%;vertical-align:middle;text-align:right;padding:0pt 0pt">'
    || '<p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">{{institute.address}}</span></span></p>'
    || '<p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">{{institute.phone}}  |  {{institute.email}}  |  {{institute.website}}</span></span></p>'
    || '<p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">RTO {{institute.rto}}  |  CRICOS {{institute.cricos}}</span></span></p>'
    || '</td></tr>'
    || '<tr><td colspan="2" style="border-bottom:2.5pt solid #ea6619;padding:0pt 0pt"><p style="margin-bottom:0pt"><span style="font-size:3pt">&nbsp;</span></p></td></tr></table>';
$$;

create or replace function public.letter_standard_footer(p_title text default 'LETTER OF OFFER AND WRITTEN AGREEMENT', p_version text default 'Version Oct 2024') returns text
language sql immutable set search_path to 'pg_catalog' as $$
  select '<table style="border:none;width:100%"><tr><td style="border-top:0.5pt solid #d1d5db;padding:4pt 0pt 0pt 0pt">'
    || '<p style="text-align:center;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">' || coalesce(p_title, '') || '  |  ' || coalesce(p_version, '')
    || '  |  Student Initial ______________  |  Page {{page.number}} of {{page.total}}</span></span></p>'
    || '<p style="text-align:center;margin-bottom:0pt"><span style="font-size:6.5pt"><span style="color:#9ca3af">{{institute.legal_name}}  |  ABN {{institute.abn}}  |  RTO {{institute.rto}}  |  CRICOS {{institute.cricos}}</span></span></p>'
    || '</td></tr></table>';
$$;

-- 2. The active Letter of Offer templates: the house header and footer, as a new version (keeping each letter's title and version line).
do $$
declare t hr.sign_templates; v_title text; v_ver text; v_old text;
begin
  for t in select * from hr.sign_templates where category = 'student_offer_letter' and deleted_at is null and status = 'active' for update loop
    v_old := coalesce(t.footer_html, '');
    -- the footer's "TITLE · Version …" line as the letter had it
    v_title := coalesce(nullif(btrim(substring(regexp_replace(v_old, '<[^>]*>', '', 'g') from '^\s*([^·|]+?)\s*[·|]')), ''), 'LETTER OF OFFER AND WRITTEN AGREEMENT');
    v_ver := coalesce(nullif(btrim(substring(regexp_replace(v_old, '<[^>]*>', '', 'g') from '[·|]\s*(Version[^·|]*?)\s*[·|]')), ''), 'Version 1.0');
    update hr.sign_templates set header_html = public.letter_standard_header(), footer_html = public.letter_standard_footer(v_title, v_ver),
      version = version + 1, updated_at = now() where id = t.id returning * into t;
    insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), t.created_by);
  end loop;
end $$;

-- 3. The default Application form, for printing an application not signed yet.
create or replace function public.application_form_default(p_application uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare a public.enrollment_applications;
begin
  if auth.uid() is null or not (public.portal_is_slit_admin() or public.portal_can_access_application(p_application)) then
    raise exception 'You cannot see this application' using errcode = '42501';
  end if;
  select * into a from public.enrollment_applications where id = p_application;
  return (select jsonb_build_object('id', t.id, 'version', t.version, 'name', t.name, 'title', t.title, 'header_html', t.header_html, 'body_html', t.body_html,
      'footer_html', t.footer_html, 'institute', skyline_private.application_form_institute(a.tenant_id))
    from hr.sign_templates t where t.category = 'application_form' and t.is_default and t.status = 'active' and t.deleted_at is null limit 1);
end $$;
revoke all on function public.application_form_default(uuid) from public, anon;
grant execute on function public.application_form_default(uuid) to authenticated;

commit;
