-- A corrected blank replaces the installed agent onboarding template in place (2026-11-17): the Agent Agreement (P06) blank was re-laid
-- out (pages 3-7, 9 and 10 moved below the header logo; agent_organisation_name on page 10 moved). public.agency_onboarding_template_install
-- with p_data->>'refresh' = 'true' updates the template holding the key (source file, hash, page count, the fields re-read from the new
-- PDF's widgets; version + 1 with a version snapshot) instead of reusing it untouched. No new row; requests already sent keep their own
-- PDFs (hr.sign_requests.original_path) and their template_version.
create or replace function public.agency_onboarding_template_install(p_key text, p_data jsonb default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, hr, public as $f$
declare t hr.sign_templates; v_admin uuid; v_roles jsonb; v_reused boolean := true; v_refreshed boolean := false;
begin
 v_admin := hr.require_admin();
 if coalesce(p_key, '') not in ('agent_application_form', 'agent_agreement', 'agent_referee_check_form') then raise exception 'Unknown onboarding template'; end if;
 select * into t from hr.sign_templates where system_key = p_key and deleted_at is null for update;
 if not found then
  if p_data is null then return null; end if;
  v_roles := hr.sign_roles(p_data->'roles');
  insert into hr.sign_templates(id, name, title, kind, audience, category, roles, fields, signing_mode, expiry_days, reminder_days, source_path, source_hash, source_pages, system_key, created_by)
   values (coalesce((p_data->>'id')::uuid, gen_random_uuid()), coalesce(nullif(btrim(coalesce(p_data->>'name', '')), ''), p_key), coalesce(p_data->>'title', p_data->>'name', p_key), 'pdf', 'agent',
    coalesce(p_data->>'category', 'other'), v_roles, hr.sign_template_fields(p_data->'fields', v_roles), coalesce(p_data->>'signing_mode', 'sequential'),
    coalesce((p_data->>'expiry_days')::integer, 30), coalesce((p_data->>'reminder_days')::integer, 3), p_data->>'source_path', p_data->>'source_hash', (p_data->>'source_pages')::integer, p_key, v_admin)
   on conflict (system_key) where system_key is not null and deleted_at is null do nothing
   returning * into t;
  if found then
   v_reused := false;
   insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), v_admin);
  else
   -- A concurrent install won the key between the lookup and the insert: use its row.
   select * into t from hr.sign_templates where system_key = p_key and deleted_at is null;
   if not found then raise exception 'The onboarding template could not be installed'; end if;
  end if;
 elsif p_data is not null and coalesce((p_data->>'refresh')::boolean, false) then
  -- The blank shipped with the site changed: the same template takes the new file and the fields read from it.
  if coalesce(p_data->>'source_path', '') = '' or coalesce(p_data->>'source_hash', '') = '' then raise exception 'The refreshed template needs its source file'; end if;
  v_roles := hr.sign_roles(coalesce(p_data->'roles', t.roles));
  update hr.sign_templates set roles = v_roles, fields = hr.sign_template_fields(coalesce(p_data->'fields', fields), v_roles), source_path = p_data->>'source_path', source_hash = p_data->>'source_hash',
   source_pages = coalesce((p_data->>'source_pages')::integer, source_pages), title = coalesce(p_data->>'title', title), version = version + 1, updated_at = now()
   where id = t.id returning * into t;
  insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), v_admin);
  v_reused := false; v_refreshed := true;
 end if;
 if t.status = 'archived' then update hr.sign_templates set status = 'active', updated_at = now() where id = t.id returning * into t; end if;
 return jsonb_build_object('id', t.id, 'systemKey', p_key, 'reused', v_reused, 'refreshed', v_refreshed, 'status', t.status, 'sourcePath', t.source_path, 'sourceHash', t.source_hash,
  'fields', coalesce(jsonb_array_length(t.fields), 0), 'pages', t.source_pages, 'version', t.version);
end $f$;
revoke all on function public.agency_onboarding_template_install(text, jsonb) from public, anon;
grant execute on function public.agency_onboarding_template_install(text, jsonb) to authenticated;
