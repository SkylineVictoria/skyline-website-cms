-- HOUSE-STYLE batch 2a (owner, 2026-11-28: every form in the same design). Documents & Signatures › Header & footer presets gain the
-- house letterhead and footer, so every document template (consent forms, agreements, unit documents) can carry the same design as the
-- Application form and the Letter of Offer; a new document template starts with them (frontend). Document templates have no institute
-- variables (an unknown [token] would become a field for the signer), so the details are written in from Website Settings when this runs,
-- and the logo is the one the Letter of Offer already uses from the template picture store. Page numbers use [Page Number] / [Total Pages].
-- Presets are copies: editing them later never changes a template that used them.
begin;

do $$
declare c record; v_logo text; v_header text; v_footer text; v_contact text; v_reg text;
begin
  select * into c from public.cms_settings where tenant_id is null order by id limit 1;
  -- the logo already in the template picture store (the Letter of Offer's letterhead)
  select (regexp_match(v.snapshot->>'header_html', 'src="(https://[^"]+/template-assets/[^"]+)"'))[1] into v_logo
    from hr.sign_template_versions v join hr.sign_templates t on t.id = v.template_id
   where v.snapshot->>'header_html' ~ 'template-assets/' order by v.created_at desc limit 1;
  v_contact := concat_ws('  |  ', nullif(btrim(c.phone), ''), nullif(btrim(c.email), ''), nullif(regexp_replace(regexp_replace(coalesce(c.website, ''), '^https?://', ''), '/$', ''), ''));
  v_reg := concat_ws('  |  ', case when nullif(btrim(c.rto), '') is not null then 'RTO ' || c.rto end, case when nullif(btrim(c.cricos), '') is not null then 'CRICOS ' || c.cricos end);
  v_header := '<table style="border:none;width:100%"><tr>'
    || '<td style="width:50%;vertical-align:middle;padding:0pt 0pt">'
    || case when v_logo is not null then '<p style="margin-bottom:0pt"><img src="' || v_logo || '" height="46"></p>'
            else '<p style="margin-bottom:0pt"><span style="font-size:14pt"><strong>' || coalesce(c.name, 'Skyline Institute of Technology') || '</strong></span></p>' end
    || '</td><td style="width:50%;vertical-align:middle;text-align:right;padding:0pt 0pt">'
    || '<p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">' || coalesce(c.address, '') || '</span></span></p>'
    || '<p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">' || v_contact || '</span></span></p>'
    || '<p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">' || v_reg || '</span></span></p>'
    || '</td></tr><tr><td colspan="2" style="border-bottom:2.5pt solid #ea6619;padding:0pt 0pt"><p style="margin-bottom:0pt"><span style="font-size:3pt">&nbsp;</span></p></td></tr></table>';
  v_footer := '<table style="border:none;width:100%"><tr><td style="border-top:0.5pt solid #d1d5db;padding:4pt 0pt 0pt 0pt">'
    || '<p style="text-align:center;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">Page [Page Number] of [Total Pages]</span></span></p>'
    || '<p style="text-align:center;margin-bottom:0pt"><span style="font-size:6.5pt"><span style="color:#9ca3af">'
    || concat_ws('  |  ', nullif(btrim(coalesce(c.legal_name, c.name)), ''), case when nullif(btrim(c.abn), '') is not null then 'ABN ' || c.abn end, nullif(v_reg, ''))
    || '</span></span></p></td></tr></table>';
  insert into hr.sign_template_parts(kind, name, html) select 'header', 'SLIT house letterhead', v_header
   where not exists (select 1 from hr.sign_template_parts p where p.deleted_at is null and p.kind = 'header' and lower(btrim(p.name)) = 'slit house letterhead');
  insert into hr.sign_template_parts(kind, name, html) select 'footer', 'SLIT house footer', v_footer
   where not exists (select 1 from hr.sign_template_parts p where p.deleted_at is null and p.kind = 'footer' and lower(btrim(p.name)) = 'slit house footer');
end $$;

commit;
