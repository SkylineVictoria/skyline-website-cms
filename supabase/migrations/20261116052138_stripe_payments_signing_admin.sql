-- Pulled 2026-11-16 from hosted xcpydisstlvtvcsqnjob (supabase_migrations.schema_migrations.statements, version 20261116052138),
-- applied there by another session; the repo copy exists so a fresh lab replay matches hosted. Do not edit: fixes go in new migrations.
CREATE OR REPLACE FUNCTION public.signing_admin(p_action text, p_id uuid DEFAULT NULL::uuid, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'hr', 'public', 'pg_temp'
AS $function$
declare v_admin uuid := hr.require_admin(); v_out jsonb; t hr.sign_templates; s hr.sign_templates; p hr.sign_template_parts; v_problem text; v_kind text; v_category text;
 v_snapshot jsonb; v_sections boolean; v_pay jsonb; v_pay_enabled boolean; v_req uuid; v_tpl hr.sign_templates;
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

 -- ------------------------------------------------------------ payments on a request (Stripe)
 -- payment_set: p_data.payment = {amount | amount_cents, currency, description, timing, payer_email} to set, or null to remove.
 if p_action = 'payment_set' then
  return jsonb_build_object('payment', hr.sign_payment_set(p_id, case when jsonb_typeof(p_data->'payment') = 'object' then p_data->'payment' end, v_admin));
 elsif p_action = 'payment_get' then
  return jsonb_build_object('payment', hr.sign_payment_json(p_id));
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
  -- Payment settings: p_data.payment = {enabled, amount | amount_cents, currency, description, timing}; absent = unchanged.
  if jsonb_typeof(p_data->'payment') = 'object' then
   v_pay_enabled := coalesce((p_data->'payment'->>'enabled')::boolean, true);
   if v_pay_enabled then v_pay := hr.sign_payment_input(p_data->'payment', p_data->>'title'); end if;
  end if;
 elsif p_action = 'create' then
  -- p_data.payment: an object sets this request's payment, null/false means none; absent = the template's payment, if it has one.
  if p_data ? 'payment' then
   if jsonb_typeof(p_data->'payment') = 'object' then v_pay := hr.sign_payment_input(p_data->'payment', p_data->>'title'); end if;
  elsif nullif(p_data->>'template_id', '') is not null then
   select * into v_tpl from hr.sign_templates where id = (p_data->>'template_id')::uuid;
   if v_tpl.payment_enabled and v_tpl.payment_amount_cents is not null then
    v_pay := jsonb_build_object('amount_cents', v_tpl.payment_amount_cents, 'currency', v_tpl.payment_currency, 'timing', v_tpl.payment_timing,
     'description', coalesce(v_tpl.payment_description, p_data->>'title'));
   end if;
  end if;
 end if;

 v_out := hr.signing_admin_core(p_action, p_id, p_data);

 if p_action = 'create' then
  v_req := (v_out->>'id')::uuid;
  if v_pay is not null then perform hr.sign_payment_set(v_req, v_pay, v_admin); end if;
  return v_out || jsonb_build_object('payment', hr.sign_payment_json(v_req));
 elsif p_action = 'detail' then
  return v_out || jsonb_build_object('payment', hr.sign_payment_json(p_id));
 elsif p_action = 'list' then
  return jsonb_set(v_out, '{requests}', coalesce((select jsonb_agg(x.value || jsonb_build_object('payment', hr.sign_payment_json((x.value->>'id')::uuid)) order by x.ord)
   from jsonb_array_elements(v_out->'requests') with ordinality x(value, ord)), '[]'::jsonb));
 elsif p_action = 'template_save' then
  update hr.sign_templates set
   header_html = case when p_data ? 'header_html' then nullif(btrim(coalesce(p_data->>'header_html', '')), '') else header_html end,
   footer_html = case when p_data ? 'footer_html' then nullif(btrim(coalesce(p_data->>'footer_html', '')), '') else footer_html end,
   bracket_variables = coalesce((p_data->>'bracket_variables')::boolean, bracket_variables),
   payment_enabled = coalesce(v_pay_enabled, payment_enabled),
   payment_amount_cents = case when v_pay is not null then (v_pay->>'amount_cents')::integer else payment_amount_cents end,
   payment_currency = case when v_pay is not null then v_pay->>'currency' else payment_currency end,
   payment_timing = case when v_pay is not null then v_pay->>'timing' else payment_timing end,
   payment_description = case when v_pay is not null then nullif(btrim(coalesce(p_data->'payment'->>'description', '')), '') else payment_description end
  where id = (v_out->>'id')::uuid returning * into t;
 elsif p_action = 'template_duplicate' then
  select * into s from hr.sign_templates where id = p_id;
  update hr.sign_templates set header_html = s.header_html, footer_html = s.footer_html, bracket_variables = s.bracket_variables,
   payment_enabled = s.payment_enabled, payment_amount_cents = s.payment_amount_cents, payment_currency = s.payment_currency,
   payment_description = s.payment_description, payment_timing = s.payment_timing
  where id = (v_out->>'id')::uuid returning * into t;
 elsif p_action = 'template_restore' then
  select snapshot into v_snapshot from hr.sign_template_versions where template_id = p_id and version = (p_data->>'version')::integer;
  update hr.sign_templates set header_html = v_snapshot->>'header_html', footer_html = v_snapshot->>'footer_html',
   bracket_variables = coalesce((v_snapshot->>'bracket_variables')::boolean, false),
   payment_enabled = coalesce((v_snapshot->>'payment_enabled')::boolean, false),
   payment_amount_cents = (v_snapshot->>'payment_amount_cents')::integer,
   payment_currency = coalesce(v_snapshot->>'payment_currency', 'aud'),
   payment_description = v_snapshot->>'payment_description',
   payment_timing = coalesce(v_snapshot->>'payment_timing', 'before_sign')
  where id = p_id returning * into t;
 else
  return v_out;
 end if;
 -- The version the released function just recorded, with the sections and payment settings in it.
 update hr.sign_template_versions set snapshot = to_jsonb(t) where template_id = t.id and version = t.version;
 return to_jsonb(t);
end $function$;
