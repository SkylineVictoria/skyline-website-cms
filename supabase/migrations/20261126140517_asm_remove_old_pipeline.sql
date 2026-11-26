-- ASM-PDF-TEMPLATE phase 4 (owner 2026-11-26): the old assessment pipeline is removed; an assessment is its workbook PDF template.
-- Hosted had 0 assessments when this was written (re-checked right before it is applied), so nothing is converted.
--  * import pipeline: asm_import_jobs, the asm_import_* functions (asm_import_unit_check stays: the unit-mismatch audit), the
--    asm-import-worker cron job and the asm-imports bucket's policies (the bucket itself is emptied and removed with the Storage API);
--  * the questions JSON: asm_definition_questions / asm_question_tree, the validators, autocheck, rollup, overview save, the
--    asm_version_questions view, model answers (asm_question_keys) and the question bank;
--  * asm_admin, asm_admin_scope_check, asm_trainer, asm_student, asm_task_outcome_auto, asm_versions_guard and asm_template_save are
--    replaced by their current bodies without those branches: assessment_create (new or copy: template + mapping), draft_save (the
--    unit mapping, keyed by the template's printed question numbers), version_publish (needs the PDF template; checksum of the
--    template), coverage (unmapped template questions), no export / bank / keys.
-- asm_versions.definition stays (not null, '{"tasks": []}') so existing rows and the versions guard keep their shape.

CREATE OR REPLACE FUNCTION public.asm_admin(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_id uuid; v_ver public.asm_versions; v_as public.asm_assessments; v_set public.asm_settings; v_tenant uuid;
 x jsonb; n integer := 0; v_errs jsonb; v_defn jsonb; v_keys jsonb; v_maps jsonb; v_bid uuid; v_a public.asm_assignments; v_att public.asm_attempts; v_student uuid;
 v_rv integer; v_unit text; v_elem uuid; v_next uuid; v_due timestamptz; v_text text; v_role text := 'admin';
begin
 if not public.cms_is_staff() then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 if p_action = 'me' then
  return jsonb_build_object('admin', public.cms_is_admin(), 'rtoManager', public.cms_is_rto_manager(), 'assessmentAdmin', public.asm_is_admin(), 'trainerProfileId', public.asm_trainer_profile());
 end if;
 if not public.asm_is_admin() then raise exception 'Only an Admin or an RTO Manager can manage assessments.' using errcode = '42501'; end if;
 perform public.asm_admin_scope_check(p_action, d);

 -- ---------------------------------------------------------------- settings
 if p_action = 'settings_get' then
  v_tenant := public.tenant_current();
  select * into v_set from public.asm_settings where coalesce(tenant_id, '00000000-0000-0000-0000-000000000000') = coalesce(v_tenant, '00000000-0000-0000-0000-000000000000');
  if v_set.id is null then insert into public.asm_settings(tenant_id) values (v_tenant) returning * into v_set; end if;
  return to_jsonb(v_set);
 elsif p_action = 'settings_save' then
  v_tenant := public.tenant_current();
  select * into v_set from public.asm_settings where coalesce(tenant_id, '00000000-0000-0000-0000-000000000000') = coalesce(v_tenant, '00000000-0000-0000-0000-000000000000');
  if v_set.id is null then insert into public.asm_settings(tenant_id) values (v_tenant) returning * into v_set; end if;
  update public.asm_settings set
   max_attempts = coalesce((d->>'maxAttempts')::integer, max_attempts), reassessment_days = coalesce((d->>'reassessmentDays')::integer, reassessment_days),
   late_submission = coalesce(d->>'lateSubmission', late_submission), rollup_rule = coalesce(d->>'rollupRule', rollup_rule), due_soon_days = coalesce((d->>'dueSoonDays')::integer, due_soon_days),
   require_trainer_role = require_trainer_role,
   declaration_text = declaration_text, instructions = coalesce(d->>'instructions', instructions),
   evidence_max_mb = evidence_max_mb,
   evidence_allowed_types = evidence_allowed_types,
   updated_by = auth.uid(), updated_at = now()
  where id = v_set.id returning * into v_set;
  perform public.asm_log(v_role, 'settings_save', 'settings', v_set.id::text, d, v_set.tenant_id);
  return to_jsonb(v_set);

 -- ---------------------------------------------------------------- unit elements
 elsif p_action = 'unit_elements_list' then
  v_unit := public.asm_json_text(d, 'unitId'); if v_unit is null then raise exception 'unitId is required' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'parentId', e.parent_id, 'code', e.code, 'text', e.text, 'sort', e.sort, 'isActive', e.is_active) order by e.kind, e.sort, e.code)
    from public.asm_unit_elements e where e.unit_id = v_unit and public.tenant_scope(e.tenant_id)), '[]');
 elsif p_action = 'unit_elements_save' then
  v_unit := public.asm_json_text(d, 'unitId'); if v_unit is null then raise exception 'unitId is required' using errcode = '22023'; end if;
  if not exists (select 1 from public.cms_course_units where id = v_unit) then raise exception 'Unit not found' using errcode = 'P0002'; end if;
  -- items: [{id?, kind, parentId?, parentCode?, code, text, sort}]; items left out are deactivated (mappings keep pointing at them)
  create temp table if not exists asm_tmp_keep(id uuid) on commit drop; delete from asm_tmp_keep where true;
  for x in select * from jsonb_array_elements(coalesce(d->'items', '[]')) loop
   v_elem := public.asm_json_uuid(x, 'id');
   if v_elem is not null and exists (select 1 from public.asm_unit_elements where id = v_elem and unit_id = v_unit) then
    update public.asm_unit_elements set kind = coalesce(x->>'kind', kind), parent_id = public.asm_json_uuid(x, 'parentId'), code = coalesce(x->>'code', code), text = coalesce(public.asm_json_text(x, 'text'), text),
      sort = coalesce((x->>'sort')::integer, sort), is_active = true where id = v_elem;
   else
    insert into public.asm_unit_elements(unit_id, kind, parent_id, code, text, sort)
    values (v_unit, coalesce(x->>'kind', 'element'), public.asm_json_uuid(x, 'parentId'), coalesce(x->>'code', ''), coalesce(public.asm_json_text(x, 'text'), '-'), coalesce((x->>'sort')::integer, 0)) returning id into v_elem;
   end if;
   insert into asm_tmp_keep values (v_elem); n := n + 1;
  end loop;
  update public.asm_unit_elements set is_active = false where unit_id = v_unit and id not in (select id from asm_tmp_keep);
  perform public.asm_log(v_role, 'unit_elements_save', 'unit', v_unit, jsonb_build_object('count', n));
  return public.asm_admin('unit_elements_list', jsonb_build_object('unitId', v_unit));

 -- ---------------------------------------------------------------- question bank
 elsif p_action = 'assessment_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'courseId', a.course_id, 'courseName', public.course_label(c.code, c.name, c.variant_label), 'unitId', a.unit_id, 'unitCode', u.code, 'unitName', u.name,
     'code', a.code, 'title', a.title, 'description', a.description, 'isTemplate', a.is_template, 'archivedAt', a.archived_at, 'updatedAt', a.updated_at,
     'currentVersionNo', v.version_no, 'currentVersionStatus', v.status, 'hasDraft', exists (select 1 from public.asm_versions x where x.assessment_id = a.id and x.status = 'draft'),
     'assignments', (select count(*) from public.asm_assignments g where g.assessment_id = a.id and g.status <> 'cancelled')) order by a.updated_at desc)
   from public.asm_assessments a join public.cms_courses c on c.id = a.course_id left join public.cms_course_units u on u.id = a.unit_id left join public.asm_versions v on v.id = a.current_version_id
   where public.tenant_scope(a.tenant_id) and (coalesce((d->>'includeArchived')::boolean, false) or a.archived_at is null)
     and (public.asm_json_text(d, 'courseId') is null or a.course_id = d->>'courseId') and (public.asm_json_text(d, 'unitId') is null or a.unit_id = d->>'unitId')
     and (d->'isTemplate' is null or a.is_template = (d->>'isTemplate')::boolean)
     and (public.asm_json_text(d, 'q') is null or a.title ilike '%' || (d->>'q') || '%' or coalesce(a.code, '') ilike '%' || (d->>'q') || '%')), '[]');

 elsif p_action = 'assessment_create' then
  -- a new assessment (its workbook PDF is uploaded next, on the PDF template tab), or a copy of one (fromAssessmentId: its workbook
  -- PDF template, pointed at the new assessment's folder, and its unit mapping; the browser copies the PDF file there: copyPdf)
  if public.asm_json_text(d, 'courseId') is null then raise exception 'courseId is required' using errcode = '22023'; end if;
  if not exists (select 1 from public.cms_courses where id = d->>'courseId') then raise exception 'Course not found' using errcode = 'P0002'; end if;
  v_unit := public.asm_json_text(d, 'unitId');
  if v_unit is not null and not exists (select 1 from public.cms_course_units where id = v_unit and course_id = d->>'courseId') then raise exception 'The unit does not belong to the course' using errcode = '22023'; end if;
  v_defn := null; v_keys := null; v_maps := '[]'::jsonb;
  if public.asm_json_uuid(d, 'fromAssessmentId') is not null then
   select * into v_as from public.asm_assessments where id = public.asm_json_uuid(d, 'fromAssessmentId') and public.tenant_scope(tenant_id);
   if v_as.id is null then raise exception 'Source assessment not found' using errcode = 'P0002'; end if;
   select * into v_ver from public.asm_versions where id = coalesce(v_as.current_version_id, (select id from public.asm_versions where assessment_id = v_as.id order by version_no desc limit 1));
   if v_ver.id is not null then
    v_defn := v_ver.template; v_keys := to_jsonb(v_ver.template->'pdf'->>'path');
    v_maps := coalesce((select jsonb_agg(jsonb_build_object('questionId', m.question_id, 'criterionId', m.criterion_id, 'elementId', m.element_id)) from public.asm_unit_mappings m where m.version_id = v_ver.id), '[]');
   end if;
  end if;
  insert into public.asm_assessments(course_id, unit_id, code, title, description, is_template, created_by)
  values (d->>'courseId', v_unit, public.asm_json_text(d, 'code'), coalesce(public.asm_json_text(d, 'title'), 'Untitled assessment'), coalesce(d->>'description', ''), coalesce((d->>'isTemplate')::boolean, false), auth.uid())
  returning * into v_as;
  if v_defn is not null then v_defn := jsonb_set(v_defn, '{pdf,path}', to_jsonb(v_as.id::text || '/' || (v_defn->'pdf'->>'sha256') || '.pdf')); end if;
  insert into public.asm_versions(assessment_id, version_no, definition, template, created_by) values (v_as.id, 1, '{"tasks": []}'::jsonb, v_defn, auth.uid()) returning * into v_ver;
  -- the copied mapping keeps the elements of the same unit only
  for x in select * from jsonb_array_elements(v_maps) loop
   v_elem := public.asm_json_uuid(x, 'elementId');
   if v_elem is not null and exists (select 1 from public.asm_unit_elements e where e.id = v_elem and (v_unit is null or e.unit_id = v_unit)) then
    insert into public.asm_unit_mappings(version_id, question_id, criterion_id, element_id) values (v_ver.id, x->>'questionId', public.asm_json_text(x, 'criterionId'), v_elem) on conflict do nothing;
   end if;
  end loop;
  perform public.asm_log(v_role, 'assessment_create', 'assessment', v_as.id::text, jsonb_build_object('from', d->>'fromAssessmentId', 'pdf', v_defn->'pdf'->>'path'), v_as.tenant_id);
  return public.asm_admin('assessment_get', jsonb_build_object('id', v_as.id))
   || jsonb_build_object('copyPdf', case when v_defn is null then null else jsonb_build_object('from', v_keys #>> '{}', 'to', v_defn->'pdf'->>'path') end);

 elsif p_action = 'assessment_get' then
  v_id := public.asm_json_uuid(d, 'id');
  select * into v_as from public.asm_assessments where id = v_id; if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  select * into v_ver from public.asm_versions where assessment_id = v_as.id and status = 'draft';
  if v_ver.id is null then select * into v_ver from public.asm_versions where id = v_as.current_version_id; end if;
  return jsonb_build_object('id', v_as.id, 'courseId', v_as.course_id, 'unitId', v_as.unit_id, 'code', v_as.code, 'title', v_as.title, 'description', v_as.description,
   'isTemplate', v_as.is_template, 'settingsOverride', v_as.settings_override, 'archivedAt', v_as.archived_at, 'currentVersionId', v_as.current_version_id, 'updatedAt', v_as.updated_at,
   'effectiveSettings', public.asm_effective_settings(v_as.id),
   'editing', case when v_ver.id is null then null else jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no, 'status', v_ver.status, 'updatedAt', v_ver.updated_at,
     'hasTemplate', v_ver.template is not null, 'questions', coalesce(jsonb_array_length(v_ver.template->'questions'), 0),
     'mappings', coalesce((select jsonb_agg(jsonb_build_object('questionId', m.question_id, 'criterionId', m.criterion_id, 'elementId', m.element_id)) from public.asm_unit_mappings m where m.version_id = v_ver.id), '[]')) end,
   'versions', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'versionNo', v.version_no, 'status', v.status, 'publishedAt', v.published_at, 'checksum', v.checksum, 'createdAt', v.created_at,
     'assignments', (select count(*) from public.asm_assignments g where g.version_id = v.id), 'attempts', (select count(*) from public.asm_attempts t where t.version_id = v.id)) order by v.version_no desc) from public.asm_versions v where v.assessment_id = v_as.id), '[]'),
   'elements', case when v_as.unit_id is null then '[]'::jsonb else public.asm_admin('unit_elements_list', jsonb_build_object('unitId', v_as.unit_id)) end,
   'assignments', coalesce((select jsonb_agg(public.asm_assignment_json(g) order by g.due_at desc) from public.asm_assignments g where g.assessment_id = v_as.id), '[]'));

 elsif p_action = 'assessment_update' then
  v_id := public.asm_json_uuid(d, 'id');
  update public.asm_assessments set title = coalesce(public.asm_json_text(d, 'title'), title), description = coalesce(d->>'description', description),
    code = case when d ? 'code' then public.asm_json_text(d, 'code') else code end, is_template = coalesce((d->>'isTemplate')::boolean, is_template),
    settings_override = case when jsonb_typeof(d->'settingsOverride') = 'object' then d->'settingsOverride' else settings_override end,
    unit_id = case when d ? 'unitId' then public.asm_json_text(d, 'unitId') else unit_id end
  where id = v_id;
  if not found then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  perform public.asm_log(v_role, 'assessment_update', 'assessment', v_id::text, d - 'id');
  return public.asm_admin('assessment_get', jsonb_build_object('id', v_id));
 elsif p_action = 'assessment_archive' then
  v_id := public.asm_json_uuid(d, 'id');
  if exists (select 1 from public.asm_assignments where assessment_id = v_id and status = 'open') then raise exception 'Close or cancel its open assignments first' using errcode = '23503'; end if;
  update public.asm_assessments set archived_at = coalesce(archived_at, now()) where id = v_id;
  perform public.asm_log(v_role, 'assessment_archive', 'assessment', v_id::text);
  return jsonb_build_object('ok', true);
 -- ---------------------------------------------------------------- draft editing and publishing (D-06)
 elsif p_action = 'draft_save' then
  -- the draft's unit mapping, keyed by the template's printed question numbers (the workbook PDF template itself is saved by
  -- asm_template_save); a published assessment gets its next draft here, its template carried over (asm_versions_template_carry)
  -- and its mapping copied
  v_id := public.asm_json_uuid(d, 'assessmentId');
  select * into v_as from public.asm_assessments where id = v_id; if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  if v_as.archived_at is not null then raise exception 'An archived assessment cannot be edited' using errcode = '42501'; end if;
  select * into v_ver from public.asm_versions where assessment_id = v_as.id and status = 'draft';
  if v_ver.id is null then
   select * into v_ver from public.asm_versions where id = v_as.current_version_id;
   insert into public.asm_versions(assessment_id, version_no, definition, created_by)
   values (v_as.id, coalesce((select max(version_no) from public.asm_versions where assessment_id = v_as.id), 0) + 1, '{"tasks": []}'::jsonb, auth.uid()) returning id into v_next;
   if v_ver.id is not null then
    insert into public.asm_unit_mappings(version_id, question_id, criterion_id, element_id) select v_next, question_id, criterion_id, element_id from public.asm_unit_mappings where version_id = v_ver.id;
   end if;
   select * into v_ver from public.asm_versions where id = v_next;
  elsif d ? 'expectedUpdatedAt' and public.asm_json_ts(d, 'expectedUpdatedAt') is distinct from v_ver.updated_at then
   raise exception 'This draft was changed by someone else; reload before saving.' using errcode = '40001';
  end if;
  if jsonb_typeof(d->'mappings') = 'array' then
   delete from public.asm_unit_mappings where version_id = v_ver.id;
   for x in select * from jsonb_array_elements(d->'mappings') loop
    v_elem := public.asm_json_uuid(x, 'elementId');
    if v_elem is null or public.asm_json_text(x, 'questionId') is null then continue; end if;
    if v_as.unit_id is not null and not exists (select 1 from public.asm_unit_elements e where e.id = v_elem and e.unit_id = v_as.unit_id) then raise exception 'Mapping to an element of another unit' using errcode = '23503'; end if;
    if not exists (select 1 from jsonb_array_elements(coalesce(v_ver.template->'questions', '[]'::jsonb)) q where q->>'key' = x->>'questionId') then
     raise exception 'Question % is not in the workbook PDF', x->>'questionId' using errcode = '22023';
    end if;
    insert into public.asm_unit_mappings(version_id, question_id, criterion_id, element_id) values (v_ver.id, x->>'questionId', public.asm_json_text(x, 'criterionId'), v_elem) on conflict do nothing;
   end loop;
  end if;
  update public.asm_versions set updated_at = now() where id = v_ver.id;
  update public.asm_assessments set updated_at = now() where id = v_as.id;
  perform public.asm_log(v_role, 'draft_save', 'version', v_ver.id::text, jsonb_build_object('mappings', (select count(*) from public.asm_unit_mappings m where m.version_id = v_ver.id)), v_as.tenant_id);
  return jsonb_build_object('ok', true, 'versionId', v_ver.id, 'versionNo', v_ver.version_no, 'updatedAt', (select updated_at from public.asm_versions where id = v_ver.id));

 elsif p_action = 'version_publish' then
  v_id := public.asm_json_uuid(d, 'assessmentId');
  select * into v_as from public.asm_assessments where id = v_id; if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  select * into v_ver from public.asm_versions where assessment_id = v_as.id and status = 'draft';
  if v_ver.id is null then raise exception 'There is no draft to publish' using errcode = 'P0002'; end if;
  -- an assessment is its workbook PDF: publishing needs the PDF template with its questions
  v_errs := '[]'::jsonb;
  if v_ver.template is null then v_errs := v_errs || jsonb_build_object('code', 'no_template', 'message', 'Upload the workbook PDF before publishing.');
  elsif jsonb_array_length(coalesce(v_ver.template->'questions', '[]')) = 0 then v_errs := v_errs || jsonb_build_object('code', 'no_questions', 'message', 'The workbook PDF has no questions yet.'); end if;
  if jsonb_array_length(v_errs) > 0 then return jsonb_build_object('ok', false, 'errors', v_errs); end if;
  update public.asm_versions set status = 'published', checksum = encode(sha256(convert_to(template::text, 'UTF8')), 'hex'), published_at = now(), published_by = auth.uid() where id = v_ver.id returning * into v_ver;
  update public.asm_assessments set current_version_id = v_ver.id, updated_at = now() where id = v_as.id;
  perform public.asm_log(v_role, 'version_publish', 'version', v_ver.id::text, jsonb_build_object('versionNo', v_ver.version_no, 'checksum', v_ver.checksum), v_as.tenant_id);
  return jsonb_build_object('ok', true, 'versionId', v_ver.id, 'versionNo', v_ver.version_no, 'checksum', v_ver.checksum);
 elsif p_action = 'version_retire' then
  v_id := public.asm_json_uuid(d, 'versionId');
  update public.asm_versions set status = 'retired', retired_at = now() where id = v_id and status = 'published';
  if not found then raise exception 'Only a published version can be retired' using errcode = 'P0002'; end if;
  update public.asm_assignments set status = 'closed' where version_id = v_id and status = 'open';
  perform public.asm_log(v_role, 'version_retire', 'version', v_id::text);
  return jsonb_build_object('ok', true);
 elsif p_action = 'draft_discard' then
  v_id := public.asm_json_uuid(d, 'assessmentId');
  delete from public.asm_versions where assessment_id = v_id and status = 'draft' and version_no > 1;
  perform public.asm_log(v_role, 'draft_discard', 'assessment', v_id::text);
  return jsonb_build_object('ok', true);
 elsif p_action = 'version_get' then
  v_id := public.asm_json_uuid(d, 'versionId');
  select * into v_ver from public.asm_versions where id = v_id; if v_ver.id is null then raise exception 'Version not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', v_ver.id, 'assessmentId', v_ver.assessment_id, 'versionNo', v_ver.version_no, 'status', v_ver.status, 'checksum', v_ver.checksum, 'publishedAt', v_ver.published_at,
   'template', v_ver.template,
   'mappings', coalesce((select jsonb_agg(jsonb_build_object('questionId', m.question_id, 'criterionId', m.criterion_id, 'elementId', m.element_id)) from public.asm_unit_mappings m where m.version_id = v_ver.id), '[]'));
 elsif p_action = 'coverage' then
  v_id := public.asm_json_uuid(d, 'versionId');
  select * into v_ver from public.asm_versions where id = v_id; if v_ver.id is null then raise exception 'Version not found' using errcode = 'P0002'; end if;
  select unit_id into v_unit from public.asm_assessments where id = v_ver.assessment_id;
  return jsonb_build_object('versionId', v_ver.id, 'unitId', v_unit,
   'elements', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'code', e.code, 'text', e.text, 'parentId', e.parent_id,
     'mapped', coalesce((select jsonb_agg(jsonb_build_object('questionId', m.question_id, 'criterionId', m.criterion_id)) from public.asm_unit_mappings m where m.version_id = v_ver.id and m.element_id = e.id), '[]')) order by e.kind, e.sort, e.code)
     from public.asm_unit_elements e where e.unit_id = v_unit and e.is_active), '[]'),
   'gaps', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'code', e.code, 'text', e.text) order by e.kind, e.sort, e.code) from public.asm_unit_elements e
     where e.unit_id = v_unit and e.is_active and not exists (select 1 from public.asm_unit_mappings m where m.version_id = v_ver.id and m.element_id = e.id)), '[]'),
   'unmappedQuestions', coalesce((select jsonb_agg(q->>'key' order by o) from jsonb_array_elements(coalesce(v_ver.template->'questions', '[]'::jsonb)) with ordinality as t(q, o) where not exists (select 1 from public.asm_unit_mappings m where m.version_id = v_ver.id and m.question_id = q->>'key')), '[]'));

 -- ---------------------------------------------------------------- assignments (brief section 7)
 elsif p_action = 'assignment_create' then
  v_id := public.asm_json_uuid(d, 'assessmentId');
  select * into v_as from public.asm_assessments where id = v_id; if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  select * into v_ver from public.asm_versions where id = coalesce(public.asm_json_uuid(d, 'versionId'), v_as.current_version_id) and status = 'published';
  if v_ver.id is null or v_ver.assessment_id <> v_as.id then raise exception 'Publish the assessment before assigning it' using errcode = '23503'; end if;
  v_due := public.asm_json_ts(d, 'dueAt');
  v_errs := '[]';
  for v_bid in select ta.v::uuid from jsonb_array_elements_text(coalesce(d->'batchIds', d->'intakeIds', '[]')) as ta(v) loop
   if not exists (select 1 from public.course_intakes i where i.id = v_bid and i.course_id = v_as.course_id) then
    raise exception 'Intake % is not on this course', v_bid using errcode = '23503';
   end if;
   insert into public.asm_assignments(assessment_id, version_id, intake_id, available_from, due_at, late_until, reassign_rule, notes, created_by)
   values (v_as.id, v_ver.id, v_bid, public.asm_json_ts(d, 'availableFrom'), v_due, public.asm_json_ts(d, 'lateUntil'), case when d->>'reassignRule' = 'keep' then 'keep' else 'follow_master' end, coalesce(d->>'notes', ''), auth.uid())
   on conflict (version_id, intake_id) do nothing returning * into v_a;
   if v_a.id is null then v_errs := v_errs || jsonb_build_object('batchId', v_bid, 'code', 'exists', 'message', 'This version is already assigned to the intake.'); continue; end if;
   insert into public.asm_assignment_trainers(assignment_id, staff_id) select v_a.id, ta.v::uuid from jsonb_array_elements_text(coalesce(d->'trainerStaffIds', '[]')) as ta(v) on conflict do nothing;
   insert into public.asm_schedule_events(assignment_id, kind, title, starts_at, ends_at, room_id, trainer_staff_id, notes)
   select v_a.id, coalesce(e->>'kind', 'practical'), coalesce(public.asm_json_text(e, 'title'), v_as.title), public.asm_json_ts(e, 'startsAt'), public.asm_json_ts(e, 'endsAt'), public.asm_json_uuid(e, 'roomId'), public.asm_json_uuid(e, 'trainerStaffId'), coalesce(e->>'notes', '')
   from jsonb_array_elements(coalesce(d->'events', '[]')) e where public.asm_json_ts(e, 'startsAt') is not null;
   insert into public.asm_schedule_events(assignment_id, kind, title, starts_at) values (v_a.id, 'due', v_as.title || ': due', coalesce(v_a.due_at, v_due));
   for v_student in select * from public.asm_assignment_eligible(v_a.id) loop
    perform public.asm_notify_student(v_student, 'published', 'New assessment: ' || v_as.title, 'Due ' || to_char(v_due at time zone (select public.institution_tz()), 'DD Mon YYYY HH24:MI') || '. Open My Assessments to start.', null, v_a.id, v_as.tenant_id);
   end loop;
   perform public.asm_notify_trainers(v_a.id, 'published', 'Assessment assigned to your intake: ' || v_as.title, 'Due ' || to_char(v_due at time zone (select public.institution_tz()), 'DD Mon YYYY HH24:MI') || '.');
   perform public.asm_log(v_role, 'assignment_create', 'assignment', v_a.id::text, jsonb_build_object('batchId', v_bid, 'versionId', v_ver.id, 'dueAt', v_due), v_as.tenant_id);
   n := n + 1;
  end loop;
  return jsonb_build_object('ok', n > 0 or jsonb_array_length(v_errs) = 0, 'created', n, 'errors', v_errs);

 elsif p_action = 'assignment_update' then
  v_id := public.asm_json_uuid(d, 'id');
  select * into v_a from public.asm_assignments where id = v_id; if v_a.id is null then raise exception 'Assignment not found' using errcode = 'P0002'; end if;
  update public.asm_assignments set available_from = coalesce(public.asm_json_ts(d, 'availableFrom'), available_from), due_at = coalesce(public.asm_json_ts(d, 'dueAt'), due_at),
    late_until = case when d ? 'lateUntil' then public.asm_json_ts(d, 'lateUntil') else late_until end, status = coalesce(d->>'status', status), reassign_rule = coalesce(d->>'reassignRule', reassign_rule),
    notes = coalesce(d->>'notes', notes) where id = v_id returning * into v_a;
  if jsonb_typeof(d->'trainerStaffIds') = 'array' then
   delete from public.asm_assignment_trainers where assignment_id = v_id;
   insert into public.asm_assignment_trainers(assignment_id, staff_id) select v_id, ta.v::uuid from jsonb_array_elements_text(d->'trainerStaffIds') as ta(v) on conflict do nothing;
  end if;
  if public.asm_json_ts(d, 'dueAt') is not null then
   update public.asm_schedule_events set starts_at = v_a.due_at where assignment_id = v_id and kind = 'due';
   update public.asm_attempts set due_at = v_a.due_at where assignment_id = v_id and state = 'draft' and attempt_no = 1
     and not exists (select 1 from public.asm_assignment_students s where s.assignment_id = v_id and s.student_id = asm_attempts.student_id and s.due_at is not null);
   for v_student in select * from public.asm_assignment_eligible(v_id) loop
    perform public.asm_notify_student(v_student, 'extended', 'Due date changed', 'The due date is now ' || to_char(v_a.due_at at time zone (select public.institution_tz()), 'DD Mon YYYY HH24:MI') || '.', null, v_id, v_a.tenant_id);
   end loop;
  end if;
  perform public.asm_log(v_role, 'assignment_update', 'assignment', v_id::text, d - 'id', v_a.tenant_id);
  return public.asm_assignment_json(v_a);
 elsif p_action = 'assignment_cancel' then
  v_id := public.asm_json_uuid(d, 'id');
  update public.asm_assignments set status = 'cancelled' where id = v_id returning * into v_a;
  if v_a.id is null then raise exception 'Assignment not found' using errcode = 'P0002'; end if;
  update public.asm_attempts set state = 'void', voided_at = now(), void_reason = 'assignment cancelled' where assignment_id = v_id and state = 'draft';
  perform public.asm_log(v_role, 'assignment_cancel', 'assignment', v_id::text, jsonb_build_object('reason', d->>'reason'), v_a.tenant_id);
  return jsonb_build_object('ok', true);
 elsif p_action = 'assignment_list' then
  return coalesce((select jsonb_agg(public.asm_assignment_json(a) order by a.due_at desc) from public.asm_assignments a join public.course_intakes i on i.id = a.intake_id
   where public.tenant_scope(a.tenant_id) and (public.asm_json_uuid(d, 'assessmentId') is null or a.assessment_id = public.asm_json_uuid(d, 'assessmentId'))
     and (public.asm_json_uuid(d, 'batchId') is null or a.intake_id = public.asm_json_uuid(d, 'batchId'))
     and (public.asm_json_uuid(d, 'intakeId') is null or a.intake_id = public.asm_json_uuid(d, 'intakeId'))
     and (public.asm_json_text(d, 'courseId') is null or i.course_id = d->>'courseId')
     and (public.asm_json_text(d, 'unitId') is null or exists (select 1 from public.asm_assessments s where s.id = a.assessment_id and s.unit_id = d->>'unitId'))
     and (coalesce((d->>'includeCancelled')::boolean, false) or a.status <> 'cancelled')), '[]');
 elsif p_action = 'assignment_get' then
  v_id := public.asm_json_uuid(d, 'id');
  select * into v_a from public.asm_assignments where id = v_id; if v_a.id is null then raise exception 'Assignment not found' using errcode = 'P0002'; end if;
  return public.asm_assignment_json(v_a) || jsonb_build_object('students', public.asm_admin('assignment_students', jsonb_build_object('id', v_id)));
 elsif p_action = 'assignment_students' then
  v_id := public.asm_json_uuid(d, 'id');
  return coalesce((select jsonb_agg(jsonb_build_object('studentId', s.id, 'name', s.full_name, 'email', s.email, 'dueAt', public.asm_due_for(v_id, s.id),
    'excluded', coalesce(x.excluded, false), 'addedManually', coalesce(x.added_manually, false), 'note', coalesce(x.note, ''),
    'attempts', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'attemptNo', t.attempt_no, 'state', t.state, 'outcome', t.outcome, 'submittedAt', t.submitted_at, 'dueAt', t.due_at, 'receiptNo', t.receipt_no) order by t.attempt_no)
       from public.asm_attempts t where t.assignment_id = v_id and t.student_id = s.id), '[]')) order by s.full_name)
   from (select public.asm_assignment_eligible(v_id) as id union select student_id from public.asm_assignment_students where assignment_id = v_id) e
   join public.enrollment_students s on s.id = e.id left join public.asm_assignment_students x on x.assignment_id = v_id and x.student_id = s.id), '[]');
 elsif p_action = 'assignment_student_set' then
  v_id := public.asm_json_uuid(d, 'id'); v_student := public.asm_json_uuid(d, 'studentId');
  if v_student is null or not exists (select 1 from public.enrollment_students where id = v_student and status = 'Active') then raise exception 'Student not found' using errcode = 'P0002'; end if;
  select * into v_a from public.asm_assignments where id = v_id; if v_a.id is null then raise exception 'Assignment not found' using errcode = 'P0002'; end if;
  insert into public.asm_assignment_students(assignment_id, student_id, excluded, added_manually, due_at, note, updated_by)
  values (v_id, v_student, coalesce((d->>'excluded')::boolean, false), coalesce((d->>'addedManually')::boolean, false), public.asm_json_ts(d, 'dueAt'), coalesce(d->>'note', ''), auth.uid())
  on conflict (assignment_id, student_id) do update set excluded = coalesce((d->>'excluded')::boolean, asm_assignment_students.excluded),
   added_manually = coalesce((d->>'addedManually')::boolean, asm_assignment_students.added_manually),
   due_at = case when d ? 'dueAt' then public.asm_json_ts(d, 'dueAt') else asm_assignment_students.due_at end, note = coalesce(d->>'note', asm_assignment_students.note), updated_by = auth.uid(), updated_at = now();
  if d ? 'dueAt' then
   update public.asm_attempts set due_at = public.asm_due_for(v_id, v_student) where assignment_id = v_id and student_id = v_student and state = 'draft';
   perform public.asm_notify_student(v_student, 'extended', 'Your due date changed', 'The due date is now ' || to_char(public.asm_due_for(v_id, v_student) at time zone (select public.institution_tz()), 'DD Mon YYYY HH24:MI') || '.', null, v_id, v_a.tenant_id);
  end if;
  if coalesce((d->>'excluded')::boolean, false) then
   update public.asm_attempts set state = 'void', voided_at = now(), void_reason = 'excluded from the assignment' where assignment_id = v_id and student_id = v_student and state = 'draft';
  end if;
  perform public.asm_log(v_role, 'assignment_student_set', 'assignment', v_id::text, d - 'id', v_a.tenant_id);
  return jsonb_build_object('ok', true);
 elsif p_action = 'events_save' then
  v_id := public.asm_json_uuid(d, 'assignmentId');
  select * into v_a from public.asm_assignments where id = v_id; if v_a.id is null then raise exception 'Assignment not found' using errcode = 'P0002'; end if;
  delete from public.asm_schedule_events where assignment_id = v_id and kind <> 'due';
  insert into public.asm_schedule_events(assignment_id, kind, title, starts_at, ends_at, room_id, trainer_staff_id, notes)
  select v_id, coalesce(e->>'kind', 'practical'), coalesce(public.asm_json_text(e, 'title'), 'Assessment session'), public.asm_json_ts(e, 'startsAt'), public.asm_json_ts(e, 'endsAt'), public.asm_json_uuid(e, 'roomId'), public.asm_json_uuid(e, 'trainerStaffId'), coalesce(e->>'notes', '')
  from jsonb_array_elements(coalesce(d->'events', '[]')) e where public.asm_json_ts(e, 'startsAt') is not null and coalesce(e->>'kind', 'practical') <> 'due';
  perform public.asm_log(v_role, 'events_save', 'assignment', v_id::text, jsonb_build_object('count', jsonb_array_length(coalesce(d->'events', '[]'))), v_a.tenant_id);
  return public.asm_assignment_json(v_a);

 -- ---------------------------------------------------------------- monitoring, overrides, outcomes
 elsif p_action = 'overview' then
  create temp table if not exists asm_tmp_scope(id uuid) on commit drop; delete from asm_tmp_scope where true;
  insert into asm_tmp_scope select a.id from public.asm_assignments a join public.course_intakes i on i.id = a.intake_id
   where public.tenant_scope(a.tenant_id) and a.status <> 'cancelled' and (public.asm_json_uuid(d, 'batchId') is null or a.intake_id = public.asm_json_uuid(d, 'batchId'))
     and (public.asm_json_uuid(d, 'assessmentId') is null or a.assessment_id = public.asm_json_uuid(d, 'assessmentId'))
     and (public.asm_json_text(d, 'courseId') is null or i.course_id = d->>'courseId');
  return jsonb_build_object(
   'assignments', (select count(*) from asm_tmp_scope),
   'eligible', (select count(*) from asm_tmp_scope f cross join lateral public.asm_assignment_eligible(f.id) e),
   'notStarted', (select count(*) from asm_tmp_scope f cross join lateral public.asm_assignment_eligible(f.id) e where not exists (select 1 from public.asm_attempts t where t.assignment_id = f.id and t.student_id = e)),
   'draft', (select count(*) from public.asm_attempts t where t.assignment_id in (select id from asm_tmp_scope) and t.state = 'draft'),
   'submitted', (select count(*) from public.asm_attempts t where t.assignment_id in (select id from asm_tmp_scope) and t.state in ('submitted', 'marking')),
   'returned', (select count(*) from public.asm_attempts t where t.assignment_id in (select id from asm_tmp_scope) and t.state = 'returned'),
   'final', (select count(*) from public.asm_attempts t where t.assignment_id in (select id from asm_tmp_scope) and t.state = 'final'),
   'overdue', (select count(*) from asm_tmp_scope f cross join lateral public.asm_assignment_eligible(f.id) e where public.asm_due_for(f.id, e) < now()
      and not exists (select 1 from public.asm_attempts t where t.assignment_id = f.id and t.student_id = e and t.state <> 'draft')),
   'reassessmentsOpen', (select count(*) from public.asm_reassessments r join public.asm_attempts t on t.id = r.attempt_id where t.assignment_id in (select id from asm_tmp_scope) and r.state = 'requested'),
   'pendingMarking', coalesce((select jsonb_agg(jsonb_build_object('attemptId', t.id, 'assignmentId', t.assignment_id, 'studentId', t.student_id, 'studentName', s.full_name, 'attemptNo', t.attempt_no,
      'state', t.state, 'submittedAt', t.submitted_at, 'assessmentTitle', x.title, 'batchName', public.intake_group_name(g.intake_id)) order by t.submitted_at)
     from public.asm_attempts t join public.asm_assignments g on g.id = t.assignment_id join public.asm_assessments x on x.id = g.assessment_id
     join public.enrollment_students s on s.id = t.student_id where t.assignment_id in (select id from asm_tmp_scope) and t.state in ('submitted', 'marking')), '[]'));
 elsif p_action = 'attempt_get' then
  v_id := public.asm_json_uuid(d, 'id');
  return public.asm_attempt_json(v_id, 'admin');
 elsif p_action = 'attempt_void' then
  v_id := public.asm_json_uuid(d, 'id');
  update public.asm_attempts set state = 'void', voided_at = now(), void_reason = coalesce(public.asm_json_text(d, 'reason'), 'voided by administrator') where id = v_id and state <> 'void' returning * into v_att;
  if v_att.id is null then raise exception 'Attempt not found or already void' using errcode = 'P0002'; end if;
  perform public.asm_log(v_role, 'attempt_void', 'attempt', v_id::text, jsonb_build_object('reason', v_att.void_reason), v_att.tenant_id);
  return jsonb_build_object('ok', true);
 elsif p_action = 'attempt_reopen' then
  -- an authorised override: a further attempt for the student, carrying the previous responses, with a new due date
  v_id := public.asm_json_uuid(d, 'id');
  select * into v_att from public.asm_attempts where id = v_id; if v_att.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  if v_att.state not in ('returned', 'final', 'submitted', 'marking') then raise exception 'Only a submitted attempt can be reopened' using errcode = '42501'; end if;
  if exists (select 1 from public.asm_attempts where assignment_id = v_att.assignment_id and student_id = v_att.student_id and state = 'draft') then raise exception 'The student already has an open attempt' using errcode = '23505'; end if;
  v_due := coalesce(public.asm_json_ts(d, 'dueAt'), now() + make_interval(days => public.rule_int('lms.assessment_assignment_default_days', 7)));
  v_next := public.asm_next_attempt(v_att.assignment_id, v_att.student_id, v_due, v_att.id, coalesce((d->>'overrideLimit')::boolean, false));
  insert into public.asm_reassessments(attempt_id, student_id, requested_role, reason, state, new_due_at, next_attempt_id, decided_by, decided_at)
  values (v_att.id, v_att.student_id, 'admin', coalesce(d->>'reason', 'reopened by administrator'), 'opened', v_due, v_next, auth.uid(), now());
  perform public.asm_notify_student(v_att.student_id, 'reassessment', 'Your assessment has been reopened', 'A further attempt is open until ' || to_char(v_due at time zone (select public.institution_tz()), 'DD Mon YYYY HH24:MI') || '.', v_next, v_att.assignment_id, v_att.tenant_id);
  perform public.asm_log(v_role, 'attempt_reopen', 'attempt', v_id::text, jsonb_build_object('nextAttemptId', v_next, 'dueAt', v_due, 'reason', d->>'reason'), v_att.tenant_id);
  return jsonb_build_object('ok', true, 'attemptId', v_next);
 elsif p_action = 'reassessment_decide' then
  v_id := public.asm_json_uuid(d, 'id');
  select t.* into v_att from public.asm_reassessments r join public.asm_attempts t on t.id = r.attempt_id where r.id = v_id and r.state = 'requested';
  if v_att.id is null then raise exception 'Request not found or already decided' using errcode = 'P0002'; end if;
  if coalesce((d->>'approve')::boolean, false) then
   if exists (select 1 from public.asm_attempts where assignment_id = v_att.assignment_id and student_id = v_att.student_id and state = 'draft') then raise exception 'The student already has an open attempt' using errcode = '23505'; end if;
   v_due := coalesce(public.asm_json_ts(d, 'dueAt'), now() + make_interval(days => coalesce((public.asm_effective_settings((select assessment_id from public.asm_assignments where id = v_att.assignment_id))->>'reassessment_days')::integer, public.rule_int('assessment.reassessment_window_default', 5))));
   v_next := public.asm_next_attempt(v_att.assignment_id, v_att.student_id, v_due, v_att.id, coalesce((d->>'overrideLimit')::boolean, false));
   update public.asm_reassessments set state = 'opened', new_due_at = v_due, next_attempt_id = v_next, decided_by = auth.uid(), decided_at = now() where id = v_id;
   perform public.asm_notify_student(v_att.student_id, 'reassessment', 'Reassessment approved', 'A further attempt is open until ' || to_char(v_due at time zone (select public.institution_tz()), 'DD Mon YYYY HH24:MI') || '.', v_next, v_att.assignment_id, v_att.tenant_id);
  else
   update public.asm_reassessments set state = 'declined', decided_by = auth.uid(), decided_at = now() where id = v_id;
   perform public.asm_notify_student(v_att.student_id, 'reassessment', 'Reassessment request declined', coalesce(d->>'reason', ''), v_att.id, v_att.assignment_id, v_att.tenant_id);
  end if;
  perform public.asm_log(v_role, 'reassessment_decide', 'reassessment', v_id::text, d - 'id', v_att.tenant_id);
  return jsonb_build_object('ok', true, 'attemptId', v_next);
 elsif p_action = 'unit_outcome_record' then
  return public.asm_record_unit_outcome(d, 'admin');
 elsif p_action = 'outcomes_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'studentId', o.student_id, 'studentName', s.full_name, 'unitId', o.unit_id, 'unitCode', u.code, 'unitName', u.name, 'assessmentId', o.assessment_id,
    'batchId', o.intake_id, 'outcome', o.outcome, 'signedName', o.signed_name, 'signedRole', o.signed_role, 'signedAt', o.signed_at, 'notes', o.notes, 'supersedesId', o.supersedes_id,
    'current', not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = o.id)) order by o.signed_at desc)
   from public.asm_unit_outcomes o join public.enrollment_students s on s.id = o.student_id join public.cms_course_units u on u.id = o.unit_id
   where public.tenant_scope(o.tenant_id) and (public.asm_json_uuid(d, 'studentId') is null or o.student_id = public.asm_json_uuid(d, 'studentId')) and (public.asm_json_text(d, 'unitId') is null or o.unit_id = d->>'unitId')
     and (public.asm_json_uuid(d, 'batchId') is null or o.intake_id = public.asm_json_uuid(d, 'batchId'))), '[]');
 elsif p_action = 'student_progress' then
  return public.asm_student_progress(public.asm_json_uuid(d, 'studentId'));
 elsif p_action = 'staff_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', btrim(s.first_name || ' ' || s.last_name), 'email', s.email,
    'isTrainer', exists (select 1 from hr.staff_roles r where r.profile_id = s.id and r.role = 'trainer' and r.revoked_at is null)) order by s.first_name, s.last_name)
   from hr.staff_profiles s where s.status = 'active'), '[]');
 elsif p_action = 'batch_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', public.intake_group_name(i.id), 'intakeId', i.id, 'intake', public.course_intake_display(i), 'courseId', i.course_id, 'courseName', public.course_label(c.code, c.name, c.variant_label),
    'students', (select count(*) from public.intake_enrolments e where e.intake_id = i.id and e.status = 'active'), 'isActive', public.intake_has_group(i.id)) order by i.start_date desc, public.intake_group_name(i.id))
   from public.course_intakes i join public.cms_courses c on c.id = i.course_id
   where public.tenant_scope(c.tenant_id) and (public.asm_json_text(d, 'courseId') is null or i.course_id = d->>'courseId') and (coalesce((d->>'includeInactive')::boolean, false) or public.intake_has_group(i.id))), '[]');
 elsif p_action = 'audit_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'actor', l.actor, 'role', l.actor_role, 'action', l.action, 'targetType', l.target_type, 'targetId', l.target_id, 'detail', l.detail, 'at', l.created_at) order by l.id desc)
   from (select * from public.asm_audit_log l where public.tenant_scope(l.tenant_id) and (public.asm_json_text(d, 'targetType') is null or l.target_type = d->>'targetType') and (public.asm_json_text(d, 'targetId') is null or l.target_id = d->>'targetId')
         order by l.id desc limit least(coalesce((d->>'limit')::integer, 100), 500)) l), '[]');
 elsif p_action = 'report' then
  return public.asm_report(d);
 elsif p_action = 'notifications' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'event', x.event, 'title', x.title, 'body', x.body, 'attemptId', x.attempt_id, 'assignmentId', x.assignment_id, 'readAt', x.read_at, 'createdAt', x.created_at) order by x.created_at desc)
   from (select * from public.asm_notifications where recipient_auth_user = auth.uid() order by created_at desc limit 50) x), '[]');
 elsif p_action = 'notification_read' then
  update public.asm_notifications set read_at = coalesce(read_at, now()) where recipient_auth_user = auth.uid() and (public.asm_json_uuid(d, 'id') is null or id = public.asm_json_uuid(d, 'id'));
  return jsonb_build_object('ok', true);
 end if;
 raise exception 'Unknown action %', p_action using errcode = '22023';
end $function$;

CREATE OR REPLACE FUNCTION public.asm_admin_scope_check(p_action text, d jsonb)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v uuid; v_text text;
begin
 v := public.asm_json_uuid(d, 'id');
 if v is not null then
  if p_action like 'assessment\_%' and not exists (select 1 from public.asm_assessments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Assessment not found' using errcode = 'P0002';
  elsif p_action like 'assignment\_%' and not exists (select 1 from public.asm_assignments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Assignment not found' using errcode = 'P0002';
  elsif p_action like 'attempt\_%' and not exists (select 1 from public.asm_attempts x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Attempt not found' using errcode = 'P0002';
  elsif p_action like 'version\_%' and not exists (select 1 from public.asm_versions x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Version not found' using errcode = 'P0002';
  elsif p_action like 'reassessment\_%' and not exists (select 1 from public.asm_reassessments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Request not found' using errcode = 'P0002';
  end if;
 end if;
 v := public.asm_json_uuid(d, 'assessmentId');
 if v is not null and not exists (select 1 from public.asm_assessments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
 v := public.asm_json_uuid(d, 'fromAssessmentId');
 if v is not null and not exists (select 1 from public.asm_assessments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Source assessment not found' using errcode = 'P0002'; end if;
 v := public.asm_json_uuid(d, 'versionId');
 if v is not null and not exists (select 1 from public.asm_versions x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Version not found' using errcode = 'P0002'; end if;
 v := public.asm_json_uuid(d, 'assignmentId');
 if v is not null and not exists (select 1 from public.asm_assignments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Assignment not found' using errcode = 'P0002'; end if;
 v := public.asm_json_uuid(d, 'batchId');
 if v is not null and not exists (select 1 from public.course_intakes i join public.cms_courses c on c.id = i.course_id where i.id = v and public.tenant_scope(c.tenant_id)) then raise exception 'Intake not found' using errcode = 'P0002'; end if;
 v_text := public.asm_json_text(d, 'courseId');
 if v_text is not null and not exists (select 1 from public.cms_courses c where c.id = v_text and public.tenant_scope(c.tenant_id)) then raise exception 'Course not found' using errcode = 'P0002'; end if;
 v_text := public.asm_json_text(d, 'unitId');
 if v_text is not null and not exists (select 1 from public.cms_course_units u where u.id = v_text and public.tenant_scope(u.tenant_id)) then raise exception 'Unit not found' using errcode = 'P0002'; end if;
end $function$;

CREATE OR REPLACE FUNCTION public.asm_trainer(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_staff uuid := public.asm_trainer_profile(); v_id uuid; v_att public.asm_attempts; v_a public.asm_assignments; v_as public.asm_assessments; v_ver public.asm_versions;
 x jsonb; n integer := 0; v_set jsonb; v_out text; v_due timestamptz; v_next uuid; v_rv integer; v_errs jsonb; v_path text; v_max integer;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if p_action = 'me' then
  return jsonb_build_object('staffId', v_staff, 'name', (select btrim(first_name || ' ' || last_name) from hr.staff_profiles where id = v_staff),
   'isTrainer', public.asm_has_trainer_role(v_staff), 'requireTrainerRole', coalesce((select s.require_trainer_role from public.asm_settings s where coalesce(s.tenant_id, '00000000-0000-0000-0000-000000000000') = coalesce(public.tenant_current(), '00000000-0000-0000-0000-000000000000')), true),
   'batches', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', public.intake_group_name(i.id), 'intake', public.course_intake_display(i), 'courseName', public.course_label(c.code, c.name, c.variant_label)) order by i.start_date desc, public.intake_group_name(i.id))
     from public.intake_trainers bt join public.course_intakes i on i.id = bt.intake_id join public.cms_courses c on c.id = i.course_id where bt.staff_id = v_staff), '[]'));
 end if;
 if v_staff is null then raise exception 'Only active staff can assess' using errcode = '42501'; end if;

 if p_action = 'my_assignments' then
  return coalesce((select jsonb_agg(public.asm_assignment_json(a) || jsonb_build_object(
    'canAssess', public.asm_can_assess(a.id, v_staff), 'toMark', (select count(*) from public.asm_attempts t where t.assignment_id = a.id and t.state in ('submitted', 'marking')),
    'submitted', (select count(distinct t.student_id) from public.asm_attempts t where t.assignment_id = a.id and t.state <> 'draft' and t.state <> 'void'),
    'final', (select count(distinct t.student_id) from public.asm_attempts t where t.assignment_id = a.id and t.state = 'final')) order by a.due_at desc)
   from public.asm_assignments a where a.status <> 'cancelled' and public.asm_trainer_on_assignment(a.id, v_staff)
     and (coalesce(public.asm_json_uuid(d, 'batchId'), public.asm_json_uuid(d, 'intakeId')) is null or a.intake_id = coalesce(public.asm_json_uuid(d, 'batchId'), public.asm_json_uuid(d, 'intakeId')))), '[]');
 elsif p_action = 'pending_marking' then
  return coalesce((select jsonb_agg(jsonb_build_object('attemptId', t.id, 'assignmentId', t.assignment_id, 'studentId', t.student_id, 'studentName', s.full_name, 'attemptNo', t.attempt_no, 'state', t.state,
    'submittedAt', t.submitted_at, 'receiptNo', t.receipt_no, 'assessmentTitle', x.title, 'unitCode', u.code, 'batchName', public.intake_group_name(a.intake_id), 'dueAt', t.due_at) order by t.submitted_at)
   from public.asm_attempts t join public.asm_assignments a on a.id = t.assignment_id join public.asm_assessments x on x.id = a.assessment_id left join public.cms_course_units u on u.id = x.unit_id
   join public.enrollment_students s on s.id = t.student_id
   where t.state in ('submitted', 'marking') and public.asm_trainer_on_assignment(a.id, v_staff)), '[]');
 elsif p_action = 'assignment_students' then
  v_id := public.asm_json_uuid(d, 'id');
  if not public.asm_trainer_on_assignment(v_id, v_staff) then raise exception 'Not your assignment' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('studentId', s.id, 'name', s.full_name, 'email', s.email, 'dueAt', public.asm_due_for(v_id, s.id),
    'attempts', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'attemptNo', t.attempt_no, 'state', t.state, 'outcome', t.outcome, 'submittedAt', t.submitted_at, 'dueAt', t.due_at) order by t.attempt_no)
       from public.asm_attempts t where t.assignment_id = v_id and t.student_id = s.id), '[]')) order by s.full_name)
   from public.asm_assignment_eligible(v_id) e join public.enrollment_students s on s.id = e), '[]');
 elsif p_action = 'attempt_get' then
  v_id := public.asm_json_uuid(d, 'id');
  if not public.asm_trainer_on_attempt(v_id) then raise exception 'Not your student' using errcode = '42501'; end if;
  select * into v_att from public.asm_attempts where id = v_id;
  select * into v_ver from public.asm_versions where id = v_att.version_id;
  select * into v_as from public.asm_assessments where id = v_ver.assessment_id;
  return public.asm_attempt_json(v_id, 'trainer') || jsonb_build_object('canAssess', public.asm_can_assess(v_att.assignment_id, v_staff), 'assessmentTitle', v_as.title, 'unitId', v_as.unit_id,
   'studentName', (select full_name from public.enrollment_students where id = v_att.student_id),
   'settings', public.asm_effective_settings(v_as.id),
   'mappings', coalesce((select jsonb_agg(jsonb_build_object('questionId', m.question_id, 'criterionId', m.criterion_id, 'elementId', m.element_id, 'elementKind', e.kind, 'elementCode', e.code, 'elementText', e.text)) from public.asm_unit_mappings m join public.asm_unit_elements e on e.id = m.element_id where m.version_id = v_ver.id), '[]'));
 elsif p_action = 'mark_save' then
  -- results per question / criterion, task outcomes, assessor-filled responses (observation checklist, third-party report), overall feedback
  v_id := public.asm_json_uuid(d, 'id');
  if not public.asm_trainer_on_attempt(v_id) then raise exception 'Not your student' using errcode = '42501'; end if;
  if not public.asm_can_assess_attempt(v_id) then raise exception 'Only a trainer with the trainer role, a named assessor or an administrator can mark this attempt' using errcode = '42501'; end if;
  select * into v_att from public.asm_attempts where id = v_id for update;
  if v_att.state not in ('submitted', 'marking') then raise exception 'This attempt is not open for marking' using errcode = '42501'; end if;
  if d ? 'rowVersion' and (d->>'rowVersion')::integer <> v_att.row_version then raise exception 'This attempt was changed by someone else; reload before saving.' using errcode = '40001'; end if;
  for x in select * from jsonb_array_elements(coalesce(d->'results', '[]')) loop
   if public.asm_json_text(x, 'questionId') is null then continue; end if;
   insert into public.asm_results(attempt_id, question_id, criterion_id, outcome, score, rubric_level_id, feedback, marked_by, marked_at)
   values (v_id, x->>'questionId', public.asm_json_text(x, 'criterionId'), nullif(upper(x->>'outcome'), ''), (x->>'score')::numeric, public.asm_json_text(x, 'rubricLevelId'), coalesce(x->>'feedback', ''), auth.uid(), now())
   on conflict (attempt_id, question_id, coalesce(criterion_id, '')) do update set outcome = excluded.outcome, score = excluded.score, rubric_level_id = excluded.rubric_level_id, feedback = excluded.feedback, marked_by = auth.uid(), marked_at = now();
   n := n + 1;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(d->'taskResults', '[]')) loop
   if public.asm_json_text(x, 'taskId') is null then continue; end if;
   insert into public.asm_task_results(attempt_id, task_id, outcome, feedback, signed_by, signed_at)
   values (v_id, x->>'taskId', nullif(upper(x->>'outcome'), ''), coalesce(x->>'feedback', ''), auth.uid(), now())
   on conflict (attempt_id, task_id) do update set outcome = excluded.outcome, feedback = excluded.feedback, signed_by = auth.uid(), signed_at = now();
  end loop;
  insert into public.asm_task_results(attempt_id, task_id, feedback, signed_by, signed_at)
  select v_id, (tq->>'number'), '', auth.uid(), now() from public.asm_versions vv cross join lateral jsonb_array_elements(coalesce(vv.template->'tasks', '[]'::jsonb)) tq
  where vv.id = v_att.version_id and vv.template is not null on conflict (attempt_id, task_id) do nothing;
  update public.asm_task_results set outcome = outcome where attempt_id = v_id;
  update public.asm_attempts set state = 'marking', marking_started_at = coalesce(marking_started_at, now()), marked_by = auth.uid(),
    assessor_responses = case when jsonb_typeof(d->'assessorResponses') = 'object' then assessor_responses || (d->'assessorResponses') else assessor_responses end,
    overall_feedback = coalesce(d->>'overallFeedback', overall_feedback) where id = v_id;
  perform public.asm_log('trainer', 'mark_save', 'attempt', v_id::text, jsonb_build_object('results', n), v_att.tenant_id);
  return public.asm_trainer('attempt_get', jsonb_build_object('id', v_id));
 elsif p_action = 'mark_return' then
  -- the decision: S finalises the attempt; NYS opens a reassessment attempt while attempts remain, else finalises as NYS
  v_id := public.asm_json_uuid(d, 'id'); v_out := upper(coalesce(d->>'outcome', ''));
  if v_out not in ('S', 'NYS') then raise exception 'outcome must be S or NYS' using errcode = '22023'; end if;
  if not public.asm_trainer_on_attempt(v_id) then raise exception 'Not your student' using errcode = '42501'; end if;
  if not public.asm_can_assess_attempt(v_id) then raise exception 'Only a trainer with the trainer role, a named assessor or an administrator can mark this attempt' using errcode = '42501'; end if;
  select * into v_att from public.asm_attempts where id = v_id for update;
  if v_att.state not in ('submitted', 'marking') then raise exception 'This attempt is not open for marking' using errcode = '42501'; end if;
  if d ? 'rowVersion' and (d->>'rowVersion')::integer <> v_att.row_version then raise exception 'This attempt was changed by someone else; reload before saving.' using errcode = '40001'; end if;
  select * into v_a from public.asm_assignments where id = v_att.assignment_id; select * into v_as from public.asm_assessments where id = v_a.assessment_id;
  select * into v_ver from public.asm_versions where id = v_att.version_id;
  if v_ver.template is null then raise exception 'This assessment has no workbook PDF' using errcode = '22023'; end if;
  v_errs := public.asm_template_marking_missing(v_ver.template, v_id);
  if jsonb_array_length(v_errs) > 0 then return jsonb_build_object('ok', false, 'errors', v_errs); end if;
  -- every assessable task needs a recorded outcome before the decision
  if exists (select 1 from (select distinct (tq->>'task')::numeric::integer::text as task_id from jsonb_array_elements(coalesce(v_ver.template->'questions', '[]'::jsonb)) tq where jsonb_typeof(tq->'task') = 'number') tk
             where not exists (select 1 from public.asm_task_results r where r.attempt_id = v_id and r.task_id = tk.task_id and r.outcome is not null)) then
   return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object('code', 'task_outcomes', 'message', 'Record Satisfactory / Not Yet Satisfactory for every task first.')));
  end if;
  v_set := public.asm_effective_settings(v_as.id); v_max := coalesce((v_set->>'max_attempts')::integer, public.rule_int('assessment.attempts_default', 3));
  if v_out = 'S' then
   update public.asm_attempts set state = 'final', outcome = 'S', overall_feedback = coalesce(d->>'overallFeedback', overall_feedback), marked_by = auth.uid(), returned_at = now(), finalised_at = now() where id = v_id;
   perform public.asm_notify_student(v_att.student_id, 'marked', 'Assessment marked: Satisfactory', v_as.title || ' has been marked Satisfactory. Open My Assessments to read the feedback.', v_id, v_a.id, v_att.tenant_id);
  elsif public.asm_attempt_count(v_a.id, v_att.student_id) < v_max and v_a.status = 'open' then
   v_due := coalesce(public.asm_json_ts(d, 'dueAt'), now() + make_interval(days => coalesce((v_set->>'reassessment_days')::integer, public.rule_int('assessment.reassessment_window_default', 5))));
   update public.asm_attempts set state = 'returned', outcome = 'NYS', overall_feedback = coalesce(d->>'overallFeedback', overall_feedback), marked_by = auth.uid(), returned_at = now() where id = v_id;
   v_next := public.asm_next_attempt(v_a.id, v_att.student_id, v_due, v_id, false);
   insert into public.asm_reassessments(attempt_id, student_id, requested_role, reason, state, new_due_at, next_attempt_id, decided_by, decided_at)
   values (v_id, v_att.student_id, 'trainer', coalesce(d->>'overallFeedback', 'Not yet satisfactory'), 'opened', v_due, v_next, auth.uid(), now());
   perform public.asm_notify_student(v_att.student_id, 'reassessment', 'Reassessment required: ' || v_as.title, 'Attempt ' || v_att.attempt_no || ' was Not Yet Satisfactory. Attempt ' || (v_att.attempt_no + 1) || ' is open until ' || to_char(v_due at time zone (select public.institution_tz()), 'DD Mon YYYY HH24:MI') || '.', v_next, v_a.id, v_att.tenant_id);
  else
   update public.asm_attempts set state = 'final', outcome = 'NYS', overall_feedback = coalesce(d->>'overallFeedback', overall_feedback), marked_by = auth.uid(), returned_at = now(), finalised_at = now() where id = v_id;
   perform public.asm_notify_student(v_att.student_id, 'marked', 'Assessment marked: Not Yet Satisfactory', v_as.title || ' was marked Not Yet Satisfactory and no further attempt is available. Contact your trainer.', v_id, v_a.id, v_att.tenant_id);
  end if;
  perform public.asm_log('trainer', 'mark_return', 'attempt', v_id::text, jsonb_build_object('outcome', v_out, 'nextAttemptId', v_next), v_att.tenant_id);
  return jsonb_build_object('ok', true, 'outcome', v_out, 'nextAttemptId', v_next);
 elsif p_action = 'feedback_post' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  if not public.asm_trainer_on_attempt(v_id) then raise exception 'Not your student' using errcode = '42501'; end if;
  insert into public.asm_feedback(attempt_id, question_id, author_role, body) values (v_id, public.asm_json_text(d, 'questionId'), 'trainer', coalesce(public.asm_json_text(d, 'body'), '-'));
  select * into v_att from public.asm_attempts where id = v_id;
  perform public.asm_notify_student(v_att.student_id, 'marked', 'New feedback from your assessor', left(d->>'body', 400), v_id, v_att.assignment_id, v_att.tenant_id);
  return jsonb_build_object('ok', true);
 elsif p_action = 'evidence_register' then
  v_id := public.asm_json_uuid(d, 'attemptId'); v_path := public.asm_json_text(d, 'path');
  if not public.asm_trainer_on_attempt(v_id) then raise exception 'Not your student' using errcode = '42501'; end if;
  if not public.asm_can_assess_attempt(v_id) then raise exception 'Only a trainer with the trainer role, a named assessor or an administrator can attach assessor files' using errcode = '42501'; end if;
  if v_path is null or split_part(v_path, '/', 1) <> v_id::text or split_part(v_path, '/', 2) <> 'assessor' then raise exception 'The file must be under <attempt>/assessor/' using errcode = '22023'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'assessment-evidence' and o.name = v_path) then raise exception 'Upload the file first' using errcode = 'P0002'; end if;
  insert into public.asm_evidence_files(attempt_id, question_id, by_assessor, object_path, file_name, mime, bytes, sha256)
  values (v_id, coalesce(public.asm_json_text(d, 'questionId'), 'assessor'), true, v_path, coalesce(public.asm_json_text(d, 'fileName'), split_part(v_path, '/', 3)), coalesce(d->>'mime', 'application/octet-stream'), coalesce((d->>'bytes')::integer, 0), public.asm_json_text(d, 'sha256'))
  on conflict (attempt_id, object_path) do nothing;
  return jsonb_build_object('ok', true);
 elsif p_action = 'attempt_void' then
  v_id := public.asm_json_uuid(d, 'id');
  if not public.asm_can_assess_attempt(v_id) then raise exception 'Only an assessor of this assignment or an administrator can void an attempt' using errcode = '42501'; end if;
  update public.asm_attempts set state = 'void', voided_at = now(), void_reason = coalesce(public.asm_json_text(d, 'reason'), 'voided by assessor') where id = v_id and state <> 'void' returning * into v_att;
  if v_att.id is null then raise exception 'Attempt not found or already void' using errcode = 'P0002'; end if;
  perform public.asm_log('trainer', 'attempt_void', 'attempt', v_id::text, jsonb_build_object('reason', v_att.void_reason), v_att.tenant_id);
  return jsonb_build_object('ok', true);
 elsif p_action = 'attempt_reopen' then
  v_id := public.asm_json_uuid(d, 'id');
  if not public.asm_can_assess_attempt(v_id) then raise exception 'Only an assessor of this assignment or an administrator can reopen an attempt' using errcode = '42501'; end if;
  select * into v_att from public.asm_attempts where id = v_id;
  if v_att.state not in ('returned', 'final') then raise exception 'Only a returned or finalised attempt can be reopened' using errcode = '42501'; end if;
  select * into v_a from public.asm_assignments where id = v_att.assignment_id; select * into v_as from public.asm_assessments where id = v_a.assessment_id;
  v_set := public.asm_effective_settings(v_as.id);
  v_due := coalesce(public.asm_json_ts(d, 'dueAt'), now() + make_interval(days => coalesce((v_set->>'reassessment_days')::integer, public.rule_int('assessment.reassessment_window_default', 5))));
  v_next := public.asm_next_attempt(v_a.id, v_att.student_id, v_due, v_att.id, false);
  insert into public.asm_reassessments(attempt_id, student_id, requested_role, reason, state, new_due_at, next_attempt_id, decided_by, decided_at)
  values (v_att.id, v_att.student_id, 'trainer', coalesce(d->>'reason', 'reopened by assessor'), 'opened', v_due, v_next, auth.uid(), now());
  perform public.asm_notify_student(v_att.student_id, 'reassessment', 'Your assessment has been reopened', 'A further attempt is open until ' || to_char(v_due at time zone (select public.institution_tz()), 'DD Mon YYYY HH24:MI') || '.', v_next, v_a.id, v_att.tenant_id);
  perform public.asm_log('trainer', 'attempt_reopen', 'attempt', v_id::text, jsonb_build_object('nextAttemptId', v_next, 'dueAt', v_due, 'reason', d->>'reason'), v_att.tenant_id);
  return jsonb_build_object('ok', true, 'attemptId', v_next);
 elsif p_action = 'unit_outcome_record' then
  return public.asm_record_unit_outcome(d, 'trainer');
 elsif p_action = 'student_progress' then
  v_id := public.asm_json_uuid(d, 'studentId');
  if not exists (select 1 from public.intake_enrolments e join public.intake_trainers bt on bt.intake_id = e.intake_id where e.student_id = v_id and bt.staff_id = v_staff) then raise exception 'Not your student' using errcode = '42501'; end if;
  return public.asm_student_progress(v_id);
 elsif p_action = 'my_students' then
  return coalesce((select jsonb_agg(jsonb_build_object('studentId', s.id, 'name', s.full_name, 'email', s.email, 'batchId', i.id, 'batchName', public.intake_group_name(i.id), 'courseName', public.course_label(c.code, c.name, c.variant_label)) order by public.intake_group_name(i.id), s.full_name)
   from public.intake_trainers bt join public.course_intakes i on i.id = bt.intake_id join public.cms_courses c on c.id = i.course_id
   join public.intake_enrolments e on e.intake_id = i.id and e.status = 'active' join public.enrollment_students s on s.id = e.student_id where bt.staff_id = v_staff), '[]');
 elsif p_action = 'unit_elements' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'parentId', e.parent_id, 'code', e.code, 'text', e.text, 'sort', e.sort) order by e.kind, e.sort, e.code)
    from public.asm_unit_elements e where e.unit_id = d->>'unitId' and e.is_active and public.tenant_scope(e.tenant_id)), '[]');
 elsif p_action = 'notifications' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'event', x.event, 'title', x.title, 'body', x.body, 'attemptId', x.attempt_id, 'assignmentId', x.assignment_id, 'readAt', x.read_at, 'createdAt', x.created_at) order by x.created_at desc)
   from (select * from public.asm_notifications where recipient_auth_user = auth.uid() order by created_at desc limit 50) x), '[]');
 elsif p_action = 'notification_read' then
  update public.asm_notifications set read_at = coalesce(read_at, now()) where recipient_auth_user = auth.uid() and (public.asm_json_uuid(d, 'id') is null or id = public.asm_json_uuid(d, 'id'));
  return jsonb_build_object('ok', true);
 end if;
 raise exception 'Unknown action %', p_action using errcode = '22023';
end $function$;

CREATE OR REPLACE FUNCTION public.asm_student(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_student uuid := public.asm_student_id(); v_id uuid; v_att public.asm_attempts; v_a public.asm_assignments; v_as public.asm_assessments; v_ver public.asm_versions;
 v_set jsonb; v_errs jsonb; v_resp jsonb; v_hash text; v_receipt text; v_decl jsonb; v_path text; v_due timestamptz; v_now timestamptz := now(); v_sig text;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if p_action = 'me' then return jsonb_build_object('studentId', v_student); end if;
 if v_student is null then raise exception 'Only a signed-in student can do this' using errcode = '42501'; end if;

 if p_action = 'my_assessments' then
  return coalesce((select jsonb_agg(jsonb_build_object('assignmentId', a.id, 'assessmentId', s.id, 'title', s.title, 'code', s.code, 'description', s.description, 'unitCode', u.code, 'unitName', u.name,
    'courseName', public.course_label(c.code, c.name, c.variant_label), 'batchName', public.intake_group_name(i.id), 'availableFrom', a.available_from, 'dueAt', public.asm_due_for(a.id, v_student), 'lateUntil', a.late_until, 'status', a.status,
    'maxAttempts', (public.asm_effective_settings(s.id)->>'max_attempts')::integer,
    'attempts', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'attemptNo', t.attempt_no, 'state', t.state, 'outcome', case when t.state in ('returned', 'final') then t.outcome end, 'submittedAt', t.submitted_at, 'dueAt', t.due_at, 'receiptNo', t.receipt_no, 'acknowledgedAt', t.acknowledged_at) order by t.attempt_no)
       from public.asm_attempts t where t.assignment_id = a.id and t.student_id = v_student and t.state <> 'void'), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'title', e.title, 'startsAt', e.starts_at, 'endsAt', e.ends_at, 'room', r.name) order by e.starts_at) from public.asm_schedule_events e left join public.classrooms r on r.id = e.room_id where e.assignment_id = a.id and e.kind <> 'due'), '[]')) order by a.due_at)
   from public.asm_assignments a join public.asm_assessments s on s.id = a.assessment_id left join public.cms_course_units u on u.id = s.unit_id 
   join public.course_intakes i on i.id = a.intake_id join public.cms_courses c on c.id = i.course_id
   where a.status <> 'cancelled' and public.tenant_scope(a.tenant_id) and v_student in (select public.asm_assignment_eligible(a.id))), '[]');
 elsif p_action = 'assessment_open' then
  -- the student's current attempt (attempt 1 is created on first open); the view never contains assessor keys (D-05)
  v_id := public.asm_json_uuid(d, 'assignmentId');
  select * into v_a from public.asm_assignments where id = v_id;
  if v_a.id is null or v_a.status = 'cancelled' or not public.tenant_scope(v_a.tenant_id) or v_student not in (select public.asm_assignment_eligible(v_id)) then raise exception 'This assessment is not assigned to you' using errcode = '42501'; end if;
  if v_now < v_a.available_from then raise exception 'This assessment opens on %', to_char(v_a.available_from at time zone (select public.institution_tz()), 'DD Mon YYYY HH24:MI') using errcode = '42501'; end if;
  select * into v_as from public.asm_assessments where id = v_a.assessment_id; select * into v_ver from public.asm_versions where id = v_a.version_id;
  select * into v_att from public.asm_attempts where assignment_id = v_id and student_id = v_student and state <> 'void' order by attempt_no desc limit 1;
  if v_att.id is null then
   if v_a.status <> 'open' then raise exception 'This assessment is closed' using errcode = '42501'; end if;
   v_att.id := public.asm_start_attempt(v_id, v_student, v_a.tenant_id);
  end if;
  v_set := public.asm_effective_settings(v_as.id);
  return jsonb_build_object('assignment', jsonb_build_object('id', v_a.id, 'title', v_as.title, 'description', v_as.description, 'dueAt', public.asm_due_for(v_id, v_student), 'lateUntil', v_a.late_until, 'status', v_a.status,
    'unitCode', (select code from public.cms_course_units where id = v_as.unit_id), 'unitName', (select name from public.cms_course_units where id = v_as.unit_id)),
   'version', jsonb_build_object('id', v_ver.id, 'versionNo', v_ver.version_no),
   'settings', jsonb_build_object('declarationText', v_set->>'declaration_text', 'instructions', v_set->>'instructions', 'maxAttempts', (v_set->>'max_attempts')::integer,
     'lateSubmission', v_set->>'late_submission', 'evidenceMaxMb', (v_set->>'evidence_max_mb')::integer, 'evidenceAllowedTypes', v_set->'evidence_allowed_types'),
   'attempt', public.asm_attempt_json(v_att.id, 'student'),
   'history', coalesce((select jsonb_agg(public.asm_attempt_json(t.id, 'student') order by t.attempt_no) from public.asm_attempts t where t.assignment_id = v_id and t.student_id = v_student and t.state <> 'void' and t.id <> v_att.id), '[]'));
 elsif p_action = 'draft_save' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student and public.tenant_scope(tenant_id) for update;
  if v_att.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  if v_att.state <> 'draft' then raise exception 'This attempt has been submitted and is locked' using errcode = '42501'; end if;
  if d ? 'rowVersion' and (d->>'rowVersion')::integer <> v_att.row_version then raise exception 'This draft was saved from another window; reload before saving.' using errcode = '40001'; end if;
  v_resp := d->'responses';
  if v_resp is null or jsonb_typeof(v_resp) <> 'object' then raise exception 'responses must be an object' using errcode = '22023'; end if;
  update public.asm_attempts set responses = v_resp where id = v_id returning row_version into v_att.row_version;
  return jsonb_build_object('ok', true, 'rowVersion', v_att.row_version, 'savedAt', now());
 elsif p_action = 'evidence_register' then
  v_id := public.asm_json_uuid(d, 'attemptId'); v_path := public.asm_json_text(d, 'path');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student and public.tenant_scope(tenant_id);
  if v_att.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  if v_att.state <> 'draft' then raise exception 'This attempt is locked' using errcode = '42501'; end if;
  if v_path is null or split_part(v_path, '/', 1) <> v_id::text or split_part(v_path, '/', 2) = 'assessor' then raise exception 'The file must be under your attempt folder' using errcode = '22023'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'assessment-evidence' and o.name = v_path) then raise exception 'Upload the file first' using errcode = 'P0002'; end if;
  insert into public.asm_evidence_files(attempt_id, question_id, group_index, object_path, file_name, mime, bytes, sha256)
  values (v_id, coalesce(public.asm_json_text(d, 'questionId'), split_part(v_path, '/', 2)), (d->>'groupIndex')::integer, v_path, coalesce(public.asm_json_text(d, 'fileName'), split_part(v_path, '/', 3)), coalesce(d->>'mime', 'application/octet-stream'), coalesce((d->>'bytes')::integer, 0), public.asm_json_text(d, 'sha256'))
  on conflict (attempt_id, object_path) do update set file_name = excluded.file_name, mime = excluded.mime, bytes = excluded.bytes, sha256 = excluded.sha256
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
 elsif p_action = 'evidence_remove' then
  v_id := public.asm_json_uuid(d, 'id');
  delete from public.asm_evidence_files f using public.asm_attempts t where f.id = v_id and t.id = f.attempt_id and t.student_id = v_student and t.state = 'draft' and not f.by_assessor;
  return jsonb_build_object('ok', found);
 elsif p_action = 'submit' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student and public.tenant_scope(tenant_id) for update;
  if v_att.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  if v_att.state <> 'draft' and v_att.submit_request_id is not null and v_att.submit_request_id = public.asm_json_text(d, 'requestId') then
   return jsonb_build_object('ok', true, 'receiptNo', v_att.receipt_no, 'submittedAt', v_att.submitted_at, 'responsesSha256', v_att.responses_hash, 'idempotent', true);
  end if;
  if v_att.state <> 'draft' then raise exception 'This attempt has already been submitted' using errcode = '42501'; end if;
  if d ? 'rowVersion' and (d->>'rowVersion')::integer <> v_att.row_version then raise exception 'This draft was saved from another window; reload before submitting.' using errcode = '40001'; end if;
  select * into v_a from public.asm_assignments where id = v_att.assignment_id; select * into v_as from public.asm_assessments where id = v_a.assessment_id; select * into v_ver from public.asm_versions where id = v_att.version_id;
  if v_a.status <> 'open' then raise exception 'This assessment is closed' using errcode = '42501'; end if;
  v_set := public.asm_effective_settings(v_as.id);
  v_due := coalesce(v_att.due_at, public.asm_due_for(v_a.id, v_student));
  if v_now > v_due and (((v_set->>'late_submission') = 'block' and (v_a.late_until is null or v_now > v_a.late_until)) or (v_a.late_until is not null and v_now > v_a.late_until)) then
   return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object('code', 'late', 'message', 'The due date has passed and late submissions are not accepted. Ask your trainer for an extension.')));
  end if;
  if jsonb_typeof(d->'responses') = 'object' then update public.asm_attempts set responses = d->'responses' where id = v_id; v_att.responses := d->'responses'; end if;
  if v_ver.template is null then raise exception 'This assessment has no workbook PDF' using errcode = '22023'; end if;
  v_errs := public.asm_template_missing(v_ver.template, v_att.responses, array(select s.slot from public.asm_pdf_signatures s where s.attempt_id = v_id));
  if jsonb_array_length(v_errs) > 0 then return jsonb_build_object('ok', false, 'errors', v_errs); end if;
  v_sig := public.asm_json_text(d->'declaration', 'signature');
  if v_sig is null or char_length(v_sig) < 2 or not coalesce((d->'declaration'->>'agreed')::boolean, false) then
   return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object('code', 'declaration', 'message', 'Type your full name and tick the declaration to submit.')));
  end if;
  v_hash := encode(sha256(convert_to(v_att.responses::text, 'UTF8')), 'hex');
  v_receipt := 'ASM-' || to_char(v_now at time zone (select public.institution_tz()), 'YYYY') || '-' || lpad(nextval('public.asm_receipt_seq')::text, 6, '0');
  v_decl := jsonb_build_object('signature', left(v_sig, 200), 'agreed', true, 'text', coalesce(public.asm_template_declaration_text(v_ver.template), v_set->>'declaration_text'), 'textSha256', encode(sha256(convert_to(coalesce(public.asm_template_declaration_text(v_ver.template), v_set->>'declaration_text', ''), 'UTF8')), 'hex'),
    'responsesSha256', v_hash, 'signedAt', v_now, 'late', v_now > v_due);
  update public.asm_attempts set state = 'submitted', submitted_at = v_now, responses_hash = v_hash, declaration = v_decl, receipt_no = v_receipt, submit_request_id = public.asm_json_text(d, 'requestId') where id = v_id;
  perform public.asm_pdf_snapshot_take(v_id);
  perform public.asm_notify_trainers(v_a.id, 'submitted', 'Submission received: ' || v_as.title, (select full_name from public.enrollment_students where id = v_student) || ' submitted attempt ' || v_att.attempt_no || ' (receipt ' || v_receipt || ').', v_id);
  perform public.asm_notify_student(v_student, 'submitted', 'Submission receipt ' || v_receipt, v_as.title || ' was submitted on ' || to_char(v_now at time zone (select public.institution_tz()), 'DD Mon YYYY HH24:MI') || '. Keep this receipt number.', v_id, v_a.id, v_att.tenant_id);
  perform public.asm_log('student', 'submit', 'attempt', v_id::text, jsonb_build_object('receiptNo', v_receipt, 'responsesSha256', v_hash, 'late', v_now > v_due), v_att.tenant_id);
  return jsonb_build_object('ok', true, 'receiptNo', v_receipt, 'submittedAt', v_now, 'responsesSha256', v_hash);
 elsif p_action = 'result_acknowledge' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student and public.tenant_scope(tenant_id) and state in ('returned', 'final');
  if v_att.id is null then raise exception 'There is no returned result to acknowledge' using errcode = 'P0002'; end if;
  if v_att.acknowledged_at is null then
   update public.asm_attempts set acknowledged_at = now() where id = v_id returning * into v_att;
   perform public.asm_log('student', 'result_acknowledge', 'attempt', v_id::text, jsonb_build_object('outcome', v_att.outcome, 'acknowledgedAt', v_att.acknowledged_at), v_att.tenant_id);
  end if;
  return jsonb_build_object('ok', true, 'acknowledgedAt', v_att.acknowledged_at);
 elsif p_action = 'results' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  if not exists (select 1 from public.asm_attempts where id = v_id and student_id = v_student and public.tenant_scope(tenant_id)) then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  return public.asm_attempt_json(v_id, 'student');
 elsif p_action = 'reassessment_request' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student and public.tenant_scope(tenant_id);
  if v_att.id is null or v_att.state <> 'final' or v_att.outcome <> 'NYS' then raise exception 'A reassessment can be requested for a finalised Not Yet Satisfactory attempt' using errcode = '42501'; end if;
  if exists (select 1 from public.asm_reassessments where attempt_id = v_id and state = 'requested') then raise exception 'A request is already waiting' using errcode = '23505'; end if;
  insert into public.asm_reassessments(attempt_id, student_id, requested_role, reason) values (v_id, v_student, 'student', coalesce(public.asm_json_text(d, 'reason'), '')) returning id into v_id;
  perform public.asm_notify_trainers(v_att.assignment_id, 'reassessment', 'Reassessment requested', (select full_name from public.enrollment_students where id = v_student) || ' asked for a reassessment.', v_att.id);
  perform public.asm_log('student', 'reassessment_request', 'reassessment', v_id::text, jsonb_build_object('attemptId', v_att.id), v_att.tenant_id);
  return jsonb_build_object('ok', true, 'id', v_id);
 elsif p_action = 'feedback_post' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student and public.tenant_scope(tenant_id);
  if v_att.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  insert into public.asm_feedback(attempt_id, question_id, author_role, body) values (v_id, public.asm_json_text(d, 'questionId'), 'student', coalesce(public.asm_json_text(d, 'body'), '-'));
  perform public.asm_notify_trainers(v_att.assignment_id, 'marked', 'Student reply on an assessment', left(d->>'body', 400), v_id);
  return jsonb_build_object('ok', true);
 elsif p_action = 'progress' then
  return public.asm_student_progress(v_student);
 elsif p_action = 'notifications' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'event', x.event, 'title', x.title, 'body', x.body, 'attemptId', x.attempt_id, 'assignmentId', x.assignment_id, 'readAt', x.read_at, 'createdAt', x.created_at) order by x.created_at desc)
   from (select * from public.asm_notifications where recipient_auth_user = auth.uid() order by created_at desc limit 50) x), '[]');
 elsif p_action = 'notification_read' then
  update public.asm_notifications set read_at = coalesce(read_at, now()) where recipient_auth_user = auth.uid() and (public.asm_json_uuid(d, 'id') is null or id = public.asm_json_uuid(d, 'id'));
  return jsonb_build_object('ok', true);
 end if;
 raise exception 'Unknown action %', p_action using errcode = '22023';
end $function$;

CREATE OR REPLACE FUNCTION public.asm_task_outcome_auto(p_attempt uuid, p_task text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 with v as (
  select ver.template from public.asm_attempts a join public.asm_versions ver on ver.id = a.version_id where a.id = p_attempt
 ), qs as (
  select tq->>'key' as question_id from v cross join lateral jsonb_array_elements(coalesce(v.template->'questions', '[]'::jsonb)) tq
  where v.template is not null and jsonb_typeof(tq->'task') = 'number' and (tq->>'task')::numeric::integer::text = p_task
 ), marks as (
  select qs.question_id, r.outcome from qs
  left join public.asm_results r on r.attempt_id = p_attempt and r.question_id = qs.question_id and r.criterion_id is null
 )
 select case
  when not exists (select 1 from marks) then null
  when exists (select 1 from marks where outcome is null) then null
  when exists (select 1 from marks where outcome = 'NYS') then 'NYS'
  else 'S' end;
$function$;

CREATE OR REPLACE FUNCTION public.asm_versions_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
 if tg_op = 'DELETE' then
  if old.status <> 'draft' then raise exception 'A published version cannot be deleted' using errcode = '42501'; end if;
  return old;
 end if;
 if new.assessment_id <> old.assessment_id or new.version_no <> old.version_no then raise exception 'Version identity is immutable' using errcode = '42501'; end if;
 if old.status in ('published', 'retired') then
  if new.definition is distinct from old.definition or new.template is distinct from old.template or new.checksum is distinct from old.checksum or new.published_at is distinct from old.published_at or new.published_by is distinct from old.published_by then
   raise exception 'A published version is immutable; edit creates a new draft' using errcode = '42501';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then raise exception 'A retired version stays retired' using errcode = '42501'; end if;
  if old.status = 'published' and new.status = 'draft' then raise exception 'A published version cannot go back to draft' using errcode = '42501'; end if;
 end if;
 if new.status = 'published' and old.status = 'draft' then
  if new.template is null then raise exception 'Upload the workbook PDF before publishing' using errcode = '23514'; end if;
  if new.checksum is distinct from encode(sha256(convert_to(new.template::text, 'UTF8')), 'hex') then raise exception 'Checksum does not match the workbook PDF template' using errcode = '23514'; end if;
 end if;
 return new;
end $function$;

CREATE OR REPLACE FUNCTION public.asm_template_save(p_assessment uuid, p_template jsonb, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_as public.asm_assessments; v_ver public.asm_versions; v_errs jsonb; v_out jsonb;
begin
 if not public.asm_is_admin() then raise exception 'Only an Admin or an RTO Manager can manage assessments.' using errcode = '42501'; end if;
 select * into v_as from public.asm_assessments where id = p_assessment and public.tenant_scope(tenant_id);
 if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
 if v_as.archived_at is not null then raise exception 'An archived assessment cannot be edited' using errcode = '42501'; end if;
 v_errs := public.asm_template_validate(p_template);
 if jsonb_array_length(v_errs) = 0 and split_part(p_template->'pdf'->>'path', '/', 1) <> v_as.id::text then
  v_errs := jsonb_build_array('The template''s PDF belongs to another assessment.');
 end if;
 if jsonb_array_length(v_errs) = 0 and not exists (select 1 from storage.objects o where o.bucket_id = 'assessment-templates' and o.name = p_template->'pdf'->>'path') then
  v_errs := jsonb_build_array('Upload the PDF before saving its template.');
 end if;
 if jsonb_array_length(v_errs) > 0 then return jsonb_build_object('ok', false, 'errors', v_errs); end if;
 select * into v_ver from public.asm_versions where assessment_id = v_as.id and status = 'draft' for update;
 if v_ver.id is null then
  -- a published assessment: its next draft (template carried over, mapping copied by draft_save)
  v_out := public.asm_admin('draft_save', jsonb_build_object('assessmentId', v_as.id));
  if not coalesce((v_out->>'ok')::boolean, false) then return v_out; end if;
  select * into v_ver from public.asm_versions where id = (v_out->>'versionId')::uuid for update;
 elsif p_expected_updated_at is not null and p_expected_updated_at is distinct from v_ver.updated_at then
  raise exception 'This draft was changed by someone else; reload before saving.' using errcode = '40001';
 end if;
 update public.asm_versions set template = p_template where id = v_ver.id returning * into v_ver;
 update public.asm_assessments set updated_at = now() where id = v_as.id;
 perform public.asm_log('admin', 'template_save', 'version', v_ver.id::text,
  jsonb_build_object('assessmentId', v_as.id, 'versionNo', v_ver.version_no, 'sha256', p_template->'pdf'->>'sha256', 'pages', (p_template->'pdf'->>'pages')::integer,
   'questions', jsonb_array_length(p_template->'questions'), 'fields', jsonb_array_length(p_template->'fields')), v_as.tenant_id);
 return jsonb_build_object('ok', true, 'versionId', v_ver.id, 'versionNo', v_ver.version_no, 'updatedAt', v_ver.updated_at);
end $function$;

-- ------------------------------------------------------------------ the import pipeline
do $$ begin
 if exists (select 1 from pg_namespace where nspname = 'cron') and exists (select 1 from cron.job where jobname = 'asm-import-worker') then perform cron.unschedule('asm-import-worker'); end if;
end $$;
drop policy if exists asm_import_upload on storage.objects;
drop policy if exists asm_import_read on storage.objects;
drop policy if exists asm_import_boundary_update on storage.objects;
drop policy if exists asm_import_boundary_delete on storage.objects;
drop function if exists public.asm_import_start(text, text, text, bigint, integer, integer[], boolean, integer);
drop function if exists public.asm_import_queue(uuid);
drop function if exists public.asm_import_claim();
drop function if exists public.asm_import_dispatch();
drop function if exists public.asm_import_status(uuid);
drop function if exists public.asm_import_recent();
drop function if exists public.asm_import_json(public.asm_import_jobs, boolean);
drop function if exists public.asm_import_storage_allowed(text, boolean);
drop function if exists public.asm_import_key_trace(uuid, jsonb);
drop function if exists public.asm_import_auto_resolved(uuid, jsonb);
drop table if exists public.asm_import_jobs;

-- ------------------------------------------------------------------ the questions JSON, model answers, the question bank
drop view if exists public.asm_version_questions;
drop function if exists public.asm_overview_save(uuid, jsonb);
drop function if exists public.asm_rollup(uuid);
drop function if exists public.asm_autocheck(uuid);
drop function if exists public.asm_autocheck_one(text, jsonb, jsonb);
drop function if exists public.asm_validate_responses(jsonb, jsonb, text);
drop function if exists public.asm_validate_questions(jsonb, jsonb, text, text);
drop function if exists public.asm_validate_definition(jsonb);
drop function if exists public.asm_condition_met(jsonb, jsonb);
drop function if exists public.asm_value_present(jsonb);
drop function if exists public.asm_definition_questions(jsonb);
drop function if exists public.asm_question_tree(jsonb, text, integer);
drop table if exists public.asm_question_keys;
drop table if exists public.asm_question_bank_versions;
drop table if exists public.asm_question_bank;
drop function if exists public.asm_question_bank_tenant();
