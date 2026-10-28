

create or replace function public.portal_strip_document_qualifications(p_quals jsonb, p_document_id uuid)
returns jsonb language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(s.kept order by s.ord), '[]'::jsonb)
  from (
    select t.ord,
      case when jsonb_typeof(t.e->'documentIds') = 'array' then jsonb_set(t.e, '{documentIds}', l.ids) else t.e end as kept,
      l.ids,
      coalesce(jsonb_typeof(t.e->'documentIds') = 'array', false) as tagged
    from jsonb_array_elements(case when jsonb_typeof(p_quals) = 'array' then p_quals else '[]'::jsonb end) with ordinality as t(e, ord)
    cross join lateral (
      select coalesce(jsonb_agg(x.id), '[]'::jsonb) as ids
      from jsonb_array_elements_text(case when jsonb_typeof(t.e->'documentIds') = 'array' then t.e->'documentIds' else '[]'::jsonb end) as x(id)
      where x.id <> p_document_id::text
    ) l
  ) s
  where not s.tagged or jsonb_array_length(s.ids) > 0;
$$;
revoke all on function public.portal_strip_document_qualifications(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.portal_strip_document_qualifications(jsonb, uuid) to service_role;

create or replace function public.portal_apply_document_candidates(p_document_id uuid, p_fields jsonb, p_source jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_document record; v_pcat text; v_pcur boolean; v_pat timestamptz; v_data jsonb; v_values jsonb; v_provenance jsonb; v_quals jsonb; v_entry jsonb;
  v_key text; v_value text; v_existing text; v_state text; v_result jsonb := '{}'::jsonb;
  v_prior uuid; v_last text; v_replace boolean; v_dup bigint;
begin
  select d.id, d.application_id, d.category, d.created_at into v_document
  from public.enrollment_application_documents d join public.enrollment_applications a on a.id = d.application_id
  where d.id = p_document_id and d.is_current and a.status in ('draft','action_required') for update of d, a;
  if not found then return jsonb_build_object('stale', true); end if;
  select data into v_data from public.enrollment_applications where id = v_document.application_id for update;
  v_values := coalesce(v_data->'values', '{}'::jsonb); v_provenance := coalesce(v_data->'fieldProvenance', '{}'::jsonb);
  for v_key, v_value in select key, value #>> '{}' from jsonb_each(coalesce(p_fields, '{}'::jsonb)) loop
    if nullif(btrim(v_value), '') is null then continue; end if;
    v_existing := nullif(btrim(v_values->>v_key), '');
    if v_existing is null then
      v_values := jsonb_set(v_values, array[v_key], to_jsonb(v_value), true);
      v_provenance := jsonb_set(v_provenance, array[v_key], jsonb_build_object('kind','ai_unverified','documentId',p_document_id,'updatedAt',now()), true);
      v_state := 'auto_applied';
    elsif lower(v_existing) = lower(v_value) then v_state := 'corroborated';
    elsif v_key like 'academic\_%' then continue; -- further qualifications go to the list below
    else
      v_replace := false;
      if v_provenance->v_key->>'kind' = 'ai_unverified' and v_provenance->v_key->>'documentId' ~* '^[0-9a-f-]{36}$' then
        v_prior := (v_provenance->v_key->>'documentId')::uuid;
        if v_prior <> p_document_id then
          -- Unedited means the form still holds exactly what the last extraction wrote.
          select r.final_value into v_last from public.enrollment_document_field_reviews r
          where r.application_id = v_document.application_id and r.field_identifier = v_key and r.state = 'auto_applied'
          order by r.created_at desc, r.audit_revision desc limit 1;
          if v_last is not null and lower(btrim(v_last)) = lower(v_existing) then
            select d.category, d.is_current, d.created_at into v_pcat, v_pcur, v_pat from public.enrollment_application_documents d where d.id = v_prior;
            v_replace := v_pcur is null or not v_pcur
              or (v_pcat = v_document.category and v_pat <= v_document.created_at);
          end if;
        end if;
      end if;
      if v_replace then
        v_values := jsonb_set(v_values, array[v_key], to_jsonb(v_value), true);
        v_provenance := jsonb_set(v_provenance, array[v_key], jsonb_build_object('kind','ai_unverified','documentId',p_document_id,'updatedAt',now()), true);
        v_state := 'auto_applied';
      else v_state := 'conflict'; end if;
    end if;
    insert into public.enrollment_document_field_reviews(application_id, document_id, field_identifier, candidate_value, existing_value, final_value, state, source)
    values (v_document.application_id, p_document_id, v_key, v_value, v_existing, case when v_state in ('auto_applied') then v_value else v_existing end, v_state, p_source);
    v_result := jsonb_set(v_result, array[v_key], to_jsonb(v_state), true);
  end loop;

  v_data := jsonb_set(jsonb_set(v_data, '{values}', v_values, true), '{fieldProvenance}', v_provenance, true);

  if v_document.category = 'Academic' then
    v_quals := public.portal_strip_document_qualifications(v_data->'academicQualifications', p_document_id);
    v_entry := jsonb_strip_nulls(jsonb_build_object(
      'institution', nullif(btrim(p_fields->>'academic_institution'), ''), 'qualification', nullif(btrim(p_fields->>'academic_qualification'), ''),
      'program', nullif(btrim(p_fields->>'academic_program'), ''), 'year', nullif(btrim(p_fields->>'academic_year'), ''),
      'result', nullif(btrim(p_fields->>'academic_result'), '')));
    if v_entry ?| array['institution','qualification','program'] then
      select t.ord into v_dup from jsonb_array_elements(v_quals) with ordinality as t(e, ord)
      where lower(coalesce(t.e->>'institution','')) = lower(coalesce(v_entry->>'institution',''))
        and lower(coalesce(t.e->>'qualification','')) = lower(coalesce(v_entry->>'qualification',''))
        and lower(coalesce(t.e->>'program','')) = lower(coalesce(v_entry->>'program',''))
        and lower(coalesce(t.e->>'year','')) = lower(coalesce(v_entry->>'year',''))
        and lower(coalesce(t.e->>'result','')) = lower(coalesce(v_entry->>'result',''))
      limit 1;
      if v_dup is null then
        v_quals := v_quals || jsonb_build_array(v_entry || jsonb_build_object('documentIds', jsonb_build_array(p_document_id)));
      elsif jsonb_typeof(v_quals->(v_dup::int - 1)->'documentIds') = 'array' then
        v_quals := jsonb_set(v_quals, array[(v_dup - 1)::text, 'documentIds'], (v_quals->(v_dup::int - 1)->'documentIds') || to_jsonb(p_document_id::text));
      end if;
    end if;
    v_data := jsonb_set(v_data, '{academicQualifications}', v_quals, true);
  end if;

  update public.enrollment_applications set data = v_data, updated_at = now() where id = v_document.application_id;
  return v_result;
end;
$$;
revoke all on function public.portal_apply_document_candidates(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.portal_apply_document_candidates(uuid, jsonb, jsonb) to service_role;

create or replace function public.portal_remove_document_qualifications()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_data jsonb;
begin
  select data into v_data from public.enrollment_applications where id = old.application_id for update;
  if found and jsonb_typeof(v_data->'academicQualifications') = 'array' then
    update public.enrollment_applications
    set data = jsonb_set(data, '{academicQualifications}', public.portal_strip_document_qualifications(data->'academicQualifications', old.id), true)
    where id = old.application_id;
  end if;
  return old;
end;
$$;
revoke all on function public.portal_remove_document_qualifications() from public, anon, authenticated;

drop trigger if exists portal_remove_document_qualifications on public.enrollment_application_documents;
create trigger portal_remove_document_qualifications before delete on public.enrollment_application_documents
  for each row execute function public.portal_remove_document_qualifications();
