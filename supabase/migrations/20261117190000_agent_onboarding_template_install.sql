-- Agent onboarding templates install once (2026-11-17). Installing a blank (document-signing agent_onboarding_install) made a new
-- hr.sign_templates row on every call and agency_onboarding_template_register then moved the key to the new row, leaving the old copy on
-- the Templates page without a key: 17 copies of the three blanks were found on hosted after the staged onboarding's retries. Now:
--   * public.agency_onboarding_template_install(p_key, p_data) looks the key up and reuses the row (an archived one comes back active);
--     a missing one is inserted with "on conflict do nothing" on the unique index sign_templates_system_key_idx (one live row per key),
--     then selected, so two concurrent sends end with the same template and the loser throws its upload away. Without p_data it only
--     looks up (null when nothing is installed), so the function uploads a blank only when needed.
--   * agency_onboarding_template_register (the de-keying path) is dropped.
--   * The copies on hosted are merged: per key one canonical template (the one with staff edits, otherwise the newest live one) keeps
--     the key; every sign request, batch send, unit template, offer letter and onboarding file that pointed at a copy is re-pointed; the
--     copies are deleted (their version rows cascade; the storage objects are removed by hand). Only the three agent blanks (PDF, audience
--     agent, their names or keys) are touched: student offer letters and every other template stay as they are.
create unique index if not exists sign_templates_system_key_idx on hr.sign_templates(system_key) where system_key is not null and deleted_at is null;

create or replace function public.agency_onboarding_template_install(p_key text, p_data jsonb default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, hr, public as $f$
declare t hr.sign_templates; v_admin uuid; v_roles jsonb; v_reused boolean := true;
begin
 v_admin := hr.require_admin();
 if coalesce(p_key, '') not in ('agent_application_form', 'agent_agreement', 'agent_referee_check_form') then raise exception 'Unknown onboarding template'; end if;
 select * into t from hr.sign_templates where system_key = p_key and deleted_at is null;
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
 end if;
 if t.status = 'archived' then update hr.sign_templates set status = 'active', updated_at = now() where id = t.id returning * into t; end if;
 return jsonb_build_object('id', t.id, 'systemKey', p_key, 'reused', v_reused, 'status', t.status, 'sourcePath', t.source_path, 'sourceHash', t.source_hash,
  'fields', coalesce(jsonb_array_length(t.fields), 0), 'pages', t.source_pages, 'version', t.version);
end $f$;
revoke all on function public.agency_onboarding_template_install(text, jsonb) from public, anon;
grant execute on function public.agency_onboarding_template_install(text, jsonb) to authenticated;

drop function if exists public.agency_onboarding_template_register(uuid, text);

-- Merge the copies already made: one canonical template per key.
do $d$
declare k record; v_keep hr.sign_templates; v_dups uuid[];
begin
 for k in select * from (values ('agent_application_form', 'Agent Application Form'), ('agent_referee_check_form', 'Agent Referee Check Form'), ('agent_agreement', 'Agent Agreement')) as v(key, name) loop
  select * into v_keep from hr.sign_templates t
   where t.kind = 'pdf' and t.audience = 'agent' and (t.system_key = k.key or (t.system_key is null and t.name = k.name))
   order by (t.deleted_at is null) desc, (t.version > 1 or t.updated_at > t.created_at) desc, (t.system_key is not null) desc, t.created_at desc
   limit 1;
  if v_keep.id is null then continue; end if;
  select coalesce(array_agg(t.id), '{}') into v_dups from hr.sign_templates t
   where t.id <> v_keep.id and t.kind = 'pdf' and t.audience = 'agent' and (t.system_key = k.key or (t.system_key is null and t.name = k.name));
  if v_keep.deleted_at is null then
   update hr.sign_templates set system_key = null where id = any(v_dups) and system_key is not null;
   update hr.sign_templates set system_key = k.key where id = v_keep.id and system_key is distinct from k.key;
  end if;
  if cardinality(v_dups) = 0 then continue; end if;
  update hr.sign_requests set template_id = v_keep.id where template_id = any(v_dups);
  update hr.staff_offer_letters set template_id = v_keep.id where template_id = any(v_dups);
  update public.enrollment_offer_letters set template_id = v_keep.id where template_id = any(v_dups);
  update public.sign_batch_sends set template_id = v_keep.id where template_id = any(v_dups);
  update public.sign_template_units u set template_id = v_keep.id where u.template_id = any(v_dups) and not exists (select 1 from public.sign_template_units x where x.template_id = v_keep.id);
  delete from hr.sign_templates where id = any(v_dups);
  raise notice 'agent onboarding template %: kept %, removed % cop(y/ies)', k.key, v_keep.id, cardinality(v_dups);
 end loop;
end $d$;
