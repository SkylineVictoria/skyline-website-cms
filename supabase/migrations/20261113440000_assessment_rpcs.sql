-- ASSESSMENT MANAGEMENT (ASM-01, part 2 of 2): the command surface. No Edge Function (DECISIONS.md D-04): three security-definer
-- RPCs with explicit role checks (asm_admin for CMS Admins / RTO Managers, asm_trainer for active HR staff on the batch or named on
-- the assignment, asm_student for the signed-in student), the calendar RPC, generic response validation driven by each question's
-- responseSchema (D-07), auto-check that only suggests (D-08), the batch reassignment trigger and the due-date sweep.
-- Every write is audited in asm_audit_log; every row change goes through here because no asm_* table has a client write policy.

-- ------------------------------------------------------------------ helpers
create or replace function public.asm_log(p_role text, p_action text, p_target_type text, p_target_id text, p_detail jsonb default '{}', p_tenant uuid default null) returns void
language sql security definer set search_path = public as $$
 insert into public.asm_audit_log(tenant_id, actor, actor_role, action, target_type, target_id, detail)
 values (p_tenant, auth.uid(), p_role, p_action, coalesce(p_target_type, ''), coalesce(p_target_id, ''), coalesce(p_detail, '{}'));
$$;
revoke all on function public.asm_log(text, text, text, text, jsonb, uuid) from public, anon, authenticated;

-- Login, email and display name of a student / trainer / admin, for notifications.
create or replace function public.asm_student_contact(p_student uuid) returns table (auth_user uuid, email text, name text)
language sql stable security definer set search_path = public as $$
 select p.auth_user_id, lower(coalesce(nullif(s.email, ''), p.email)), coalesce(nullif(s.full_name, ''), p.full_name)
 from public.enrollment_students s
 left join public.agency_memberships m on m.student_id = s.id and m.role = 'student' and m.status = 'Active'
 left join public.portal_profiles p on p.id = m.user_id and p.status = 'Active'
 where s.id = p_student limit 1;
$$;
create or replace function public.asm_trainer_contact(p_staff uuid) returns table (auth_user uuid, email text, name text)
language sql stable security definer set search_path = public as $$
 select p.auth_user_id, p.email, btrim(p.first_name || ' ' || p.last_name) from hr.staff_profiles p where p.id = p_staff and p.status = 'active';
$$;
revoke all on function public.asm_student_contact(uuid), public.asm_trainer_contact(uuid) from public, anon, authenticated;

-- In-app row + email through the existing outbox (D-11). Nothing is sent when the recipient has no login or email.
create or replace function public.asm_notify(p_user uuid, p_role text, p_event text, p_title text, p_body text, p_email text,
                                             p_attempt uuid default null, p_assignment uuid default null, p_tenant uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
 if p_user is null then return null; end if;
 insert into public.asm_notifications(tenant_id, recipient_auth_user, recipient_role, event, title, body, attempt_id, assignment_id)
 values (p_tenant, p_user, p_role, p_event, left(p_title, 200), left(coalesce(p_body, ''), 4000), p_attempt, p_assignment) returning id into v_id;
 if p_email is not null and p_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
  insert into public.notification_deliveries(tenant_id, recipient_user, recipient_email, event, template_source, subject, body, assessment_event_id, next_attempt_at)
  values (p_tenant, p_user, p_email, 'assessment_' || p_event, 'default', left(p_title, 200), coalesce(p_body, ''), v_id, now());
 end if;
 return v_id;
end $$;
revoke all on function public.asm_notify(uuid, text, text, text, text, text, uuid, uuid, uuid) from public, anon, authenticated;

-- Tenant settings merged with an assessment's overrides (D-09).
create or replace function public.asm_effective_settings(p_assessment uuid) returns jsonb
language sql stable security definer set search_path = public as $$
 select to_jsonb(s) - 'id' - 'tenant_id' - 'updated_by' - 'updated_at' || coalesce(a.settings_override, '{}')
 from public.asm_assessments a
 join public.asm_settings s on coalesce(s.tenant_id, '00000000-0000-0000-0000-000000000000') = coalesce(a.tenant_id, '00000000-0000-0000-0000-000000000000')
 where a.id = p_assessment;
$$;
revoke all on function public.asm_effective_settings(uuid) from public, anon;
grant execute on function public.asm_effective_settings(uuid) to authenticated;

create or replace function public.asm_json_text(p jsonb, p_key text) returns text language sql immutable as $$ select nullif(btrim(p->>p_key), '') $$;
create or replace function public.asm_json_ts(p jsonb, p_key text) returns timestamptz language plpgsql immutable as $$
begin return nullif(btrim(p->>p_key), '')::timestamptz; exception when others then raise exception '% is not a valid date/time', p_key using errcode = '22023'; end $$;
create or replace function public.asm_json_uuid(p jsonb, p_key text) returns uuid language plpgsql immutable as $$
begin return nullif(btrim(p->>p_key), '')::uuid; exception when others then raise exception '% is not a valid id', p_key using errcode = '22023'; end $$;

-- ------------------------------------------------------------------ definition validation (structure only; types live in the client registry)
create or replace function public.asm_validate_definition(p_def jsonb) returns jsonb
language plpgsql immutable as $$
declare errs jsonb := '[]'; ids text[] := '{}'; q record; t jsonb; s jsonb; v_tasks integer := 0;
begin
 if p_def is null or jsonb_typeof(p_def) <> 'object' or jsonb_typeof(p_def->'tasks') <> 'array' then
  return jsonb_build_array(jsonb_build_object('code', 'shape', 'message', 'The definition must be an object with a tasks array.'));
 end if;
 if public.asm_jsonb_forbidden_key(p_def) is not null then
  errs := errs || jsonb_build_object('code', 'assessor_data', 'message', 'Assessor-only data (' || public.asm_jsonb_forbidden_key(p_def) || ') must be kept in the keys, not in the definition.');
 end if;
 for t in select * from jsonb_array_elements(p_def->'tasks') loop
  v_tasks := v_tasks + 1;
  if nullif(btrim(t->>'id'), '') is null then errs := errs || jsonb_build_object('code', 'task_id', 'message', 'Every task needs an id.'); end if;
  if jsonb_typeof(t->'sections') <> 'array' then errs := errs || jsonb_build_object('code', 'task_sections', 'taskId', t->>'id', 'message', 'A task needs a sections array.'); continue; end if;
  for s in select * from jsonb_array_elements(t->'sections') loop
   if nullif(btrim(s->>'id'), '') is null then errs := errs || jsonb_build_object('code', 'section_id', 'taskId', t->>'id', 'message', 'Every section needs an id.'); end if;
   if jsonb_typeof(s->'questions') <> 'array' then errs := errs || jsonb_build_object('code', 'section_questions', 'sectionId', s->>'id', 'message', 'A section needs a questions array.'); end if;
  end loop;
 end loop;
 for q in select * from public.asm_definition_questions(p_def) loop
  if q.question_id is null or q.question_id !~ '^[A-Za-z0-9_.-]{1,80}$' then
   errs := errs || jsonb_build_object('code', 'question_id', 'message', 'Every question needs an id of letters, digits, dot, dash or underscore.');
  elsif q.question_id = any(ids) then
   errs := errs || jsonb_build_object('code', 'duplicate_id', 'questionId', q.question_id, 'message', 'Question id ' || q.question_id || ' is used twice.');
  else ids := ids || q.question_id;
  end if;
  if q.question_type is null or q.question_type !~ '^[a-z][a-z0-9_]{1,40}$' then
   errs := errs || jsonb_build_object('code', 'question_type', 'questionId', q.question_id, 'message', 'Every question needs a type.');
  end if;
  if q.marking_mode not in ('none', 'auto', 'criteria', 'rubric', 'observation') then
   errs := errs || jsonb_build_object('code', 'marking_mode', 'questionId', q.question_id, 'message', 'Unknown marking mode ' || q.marking_mode || '.');
  end if;
 end loop;
 return errs;
end $$;

-- ------------------------------------------------------------------ conditional logic: showIf
-- {"questionId","op","value"} with op in eq, neq, in, notIn, gt, gte, lt, lte, contains, empty, notEmpty; or {"all":[...]} / {"any":[...]}.
create or replace function public.asm_condition_met(p_cond jsonb, p_responses jsonb) returns boolean
language plpgsql immutable as $$
declare v jsonb; c jsonb; op text; want jsonb; r boolean;
begin
 if p_cond is null or jsonb_typeof(p_cond) <> 'object' then return true; end if;
 if p_cond ? 'all' then
  for c in select * from jsonb_array_elements(coalesce(p_cond->'all', '[]')) loop if not public.asm_condition_met(c, p_responses) then return false; end if; end loop;
  return true;
 end if;
 if p_cond ? 'any' then
  r := false;
  for c in select * from jsonb_array_elements(coalesce(p_cond->'any', '[]')) loop if public.asm_condition_met(c, p_responses) then r := true; end if; end loop;
  return r or jsonb_array_length(coalesce(p_cond->'any', '[]')) = 0;
 end if;
 v := p_responses->(p_cond->>'questionId'); op := coalesce(p_cond->>'op', 'eq'); want := p_cond->'value';
 case op
  when 'empty' then return v is null or v = 'null'::jsonb or v = '""'::jsonb or v = '[]'::jsonb or v = '{}'::jsonb;
  when 'notEmpty' then return not (v is null or v = 'null'::jsonb or v = '""'::jsonb or v = '[]'::jsonb or v = '{}'::jsonb);
  when 'eq' then return v is not null and v = want;
  when 'neq' then return v is null or v <> want;
  when 'in' then return v is not null and jsonb_typeof(want) = 'array' and want @> jsonb_build_array(v);
  when 'notIn' then return v is null or jsonb_typeof(want) <> 'array' or not (want @> jsonb_build_array(v));
  when 'contains' then return v is not null and ((jsonb_typeof(v) = 'array' and v @> jsonb_build_array(want)) or (jsonb_typeof(v) = 'string' and jsonb_typeof(want) = 'string' and position((want#>>'{}') in (v#>>'{}')) > 0));
  when 'gt' then return jsonb_typeof(v) = 'number' and jsonb_typeof(want) = 'number' and (v#>>'{}')::numeric > (want#>>'{}')::numeric;
  when 'gte' then return jsonb_typeof(v) = 'number' and jsonb_typeof(want) = 'number' and (v#>>'{}')::numeric >= (want#>>'{}')::numeric;
  when 'lt' then return jsonb_typeof(v) = 'number' and jsonb_typeof(want) = 'number' and (v#>>'{}')::numeric < (want#>>'{}')::numeric;
  when 'lte' then return jsonb_typeof(v) = 'number' and jsonb_typeof(want) = 'number' and (v#>>'{}')::numeric <= (want#>>'{}')::numeric;
  else return true;
 end case;
end $$;

-- ------------------------------------------------------------------ response validation against responseSchema (D-07)
-- Schema subset: type (string|number|boolean|array|object|integer), enum, items{type,enum}, minItems, maxItems, uniqueItems, minLength,
-- maxLength, minWords, maxWords, minimum, maximum, format (date|url|email|time), properties{k:{type}}, requiredKeys[], minFiles, maxFiles.
create or replace function public.asm_schema_check(p_schema jsonb, p_v jsonb) returns text
language plpgsql immutable as $$
declare t text := p_schema->>'type'; n numeric; s text; k text; w integer; e jsonb; it jsonb;
begin
 if p_schema is null or jsonb_typeof(p_schema) <> 'object' then return null; end if;
 if p_v is null or p_v = 'null'::jsonb then return null; end if;
 if t is not null then
  if t = 'integer' then if jsonb_typeof(p_v) <> 'number' or (p_v#>>'{}')::numeric <> floor((p_v#>>'{}')::numeric) then return 'type'; end if;
  elsif t = 'string' and jsonb_typeof(p_v) <> 'string' then return 'type';
  elsif t = 'number' and jsonb_typeof(p_v) <> 'number' then return 'type';
  elsif t = 'boolean' and jsonb_typeof(p_v) <> 'boolean' then return 'type';
  elsif t = 'array' and jsonb_typeof(p_v) <> 'array' then return 'type';
  elsif t = 'object' and jsonb_typeof(p_v) <> 'object' then return 'type';
  end if;
 end if;
 if p_schema ? 'enum' and jsonb_typeof(p_schema->'enum') = 'array' and jsonb_typeof(p_v) <> 'array' and not (p_schema->'enum' @> jsonb_build_array(p_v)) then return 'enum'; end if;
 if jsonb_typeof(p_v) = 'string' then
  s := p_v#>>'{}';
  if p_schema ? 'minLength' and char_length(s) < (p_schema->>'minLength')::integer then return 'minLength'; end if;
  if p_schema ? 'maxLength' and char_length(s) > (p_schema->>'maxLength')::integer then return 'maxLength'; end if;
  if p_schema ? 'minWords' or p_schema ? 'maxWords' then
   w := coalesce(array_length(regexp_split_to_array(btrim(s), '\s+'), 1), 0); if btrim(s) = '' then w := 0; end if;
   if p_schema ? 'minWords' and w < (p_schema->>'minWords')::integer then return 'minWords'; end if;
   if p_schema ? 'maxWords' and w > (p_schema->>'maxWords')::integer then return 'maxWords'; end if;
  end if;
  if p_schema->>'format' = 'date' and s !~ '^\d{4}-\d{2}-\d{2}$' then return 'format'; end if;
  if p_schema->>'format' = 'time' and s !~ '^\d{2}:\d{2}$' then return 'format'; end if;
  if p_schema->>'format' = 'url' and s !~* '^https?://[^[:space:]]+$' then return 'format'; end if;
  if p_schema->>'format' = 'email' and s !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return 'format'; end if;
 end if;
 if jsonb_typeof(p_v) = 'number' then
  n := (p_v#>>'{}')::numeric;
  if p_schema ? 'minimum' and n < (p_schema->>'minimum')::numeric then return 'minimum'; end if;
  if p_schema ? 'maximum' and n > (p_schema->>'maximum')::numeric then return 'maximum'; end if;
 end if;
 if jsonb_typeof(p_v) = 'array' then
  if p_schema ? 'minItems' and jsonb_array_length(p_v) < (p_schema->>'minItems')::integer then return 'minItems'; end if;
  if p_schema ? 'maxItems' and jsonb_array_length(p_v) > (p_schema->>'maxItems')::integer then return 'maxItems'; end if;
  if p_schema ? 'minFiles' and jsonb_array_length(p_v) < (p_schema->>'minFiles')::integer then return 'minFiles'; end if;
  if p_schema ? 'maxFiles' and jsonb_array_length(p_v) > (p_schema->>'maxFiles')::integer then return 'maxFiles'; end if;
  if coalesce((p_schema->>'uniqueItems')::boolean, false) and (select count(*) from jsonb_array_elements(p_v)) <> (select count(distinct x) from jsonb_array_elements(p_v) x) then return 'uniqueItems'; end if;
  it := p_schema->'items';
  if it is not null then
   for e in select * from jsonb_array_elements(p_v) loop
    if public.asm_schema_check(it, e) is not null then return 'items'; end if;
   end loop;
  end if;
 end if;
 if jsonb_typeof(p_v) = 'object' then
  if p_schema ? 'requiredKeys' then
   for k in select * from jsonb_array_elements_text(p_schema->'requiredKeys') loop
    if not (p_v ? k) or p_v->k = 'null'::jsonb or p_v->k = '""'::jsonb then return 'requiredKeys'; end if;
   end loop;
  end if;
  if p_schema ? 'properties' then
   for k in select * from jsonb_object_keys(p_schema->'properties') loop
    if p_v ? k and public.asm_schema_check(p_schema->'properties'->k, p_v->k) is not null then return 'properties'; end if;
   end loop;
  end if;
 end if;
 return null;
end $$;

create or replace function public.asm_value_present(p jsonb) returns boolean language sql immutable as $$
 select p is not null and p <> 'null'::jsonb and p <> '""'::jsonb and p <> '[]'::jsonb and p <> '{}'::jsonb
   and not (jsonb_typeof(p) = 'string' and btrim(p#>>'{}') = '');
$$;

-- Walks the questions of one list with the responses in scope; nested lists (case study, repeating group) recurse.
create or replace function public.asm_validate_questions(p_questions jsonb, p_responses jsonb, p_role text, p_prefix text) returns jsonb
language plpgsql immutable as $$
declare errs jsonb := '[]'; q jsonb; v jsonb; qid text; qtype text; req boolean; ao boolean; item jsonb; i integer; code text;
begin
 for q in select * from jsonb_array_elements(coalesce(p_questions, '[]')) loop
  qid := q->>'id'; qtype := q->>'type';
  if qtype in ('instruction', 'content') then continue; end if;
  if not public.asm_condition_met(q->'showIf', p_responses) then continue; end if;
  ao := coalesce((q->>'assessorOnly')::boolean, qtype in ('observation_checklist', 'third_party_report'));
  if ao and p_role = 'student' then continue; end if;
  if not ao and p_role = 'assessor' then continue; end if;
  req := coalesce((q->>'required')::boolean, false);
  v := p_responses->qid;
  if qtype = 'repeating_group' then
   if req and not public.asm_value_present(v) then errs := errs || jsonb_build_object('questionId', p_prefix || qid, 'code', 'required', 'message', 'Add at least one entry.'); continue; end if;
   if v is not null and v <> 'null'::jsonb then
    if jsonb_typeof(v) <> 'array' then errs := errs || jsonb_build_object('questionId', p_prefix || qid, 'code', 'type', 'message', 'Entries must be a list.'); continue; end if;
    code := public.asm_schema_check(q->'responseSchema', v);
    if code is not null then errs := errs || jsonb_build_object('questionId', p_prefix || qid, 'code', code, 'message', 'Entries do not meet the rule ' || code || '.'); end if;
    i := 0;
    for item in select * from jsonb_array_elements(v) loop
     errs := errs || public.asm_validate_questions(q->'children', case when jsonb_typeof(item) = 'object' then item else '{}'::jsonb end, p_role, p_prefix || qid || '[' || i || '].');
     i := i + 1;
    end loop;
   end if;
   continue;
  end if;
  if qtype = 'case_study' then
   errs := errs || public.asm_validate_questions(q->'children', case when jsonb_typeof(v) = 'object' then v else '{}'::jsonb end, p_role, p_prefix || qid || '.');
   continue;
  end if;
  if req and not public.asm_value_present(v) then
   errs := errs || jsonb_build_object('questionId', p_prefix || qid, 'code', 'required', 'message', 'This question is required.');
   continue;
  end if;
  code := public.asm_schema_check(q->'responseSchema', v);
  if code is not null then errs := errs || jsonb_build_object('questionId', p_prefix || qid, 'code', code, 'message', 'The answer does not meet the rule ' || code || '.'); end if;
 end loop;
 return errs;
end $$;

-- p_role: 'student' validates the student's questions; 'assessor' the assessor-only ones (observation checklist, third-party report).
create or replace function public.asm_validate_responses(p_definition jsonb, p_responses jsonb, p_role text default 'student') returns jsonb
language plpgsql immutable as $$
declare errs jsonb := '[]'; t jsonb; s jsonb;
begin
 if p_responses is null or jsonb_typeof(p_responses) <> 'object' then return jsonb_build_array(jsonb_build_object('code', 'shape', 'message', 'Responses must be an object keyed by question id.')); end if;
 for t in select * from jsonb_array_elements(coalesce(p_definition->'tasks', '[]')) loop
  for s in select * from jsonb_array_elements(coalesce(t->'sections', '[]')) loop
   if not public.asm_condition_met(s->'showIf', p_responses) then continue; end if;
   errs := errs || public.asm_validate_questions(s->'questions', p_responses, p_role, '');
  end loop;
 end loop;
 return errs;
end $$;

-- ------------------------------------------------------------------ auto-check: suggestions only (D-08)
create or replace function public.asm_autocheck_one(p_type text, p_key jsonb, p_v jsonb) returns text
language plpgsql immutable as $$
declare a text[]; b text[]; k text;
begin
 if p_key is null or p_v is null or p_v = 'null'::jsonb then return null; end if;
 case p_type
  when 'single_choice', 'true_false', 'likert', 'rating', 'date' then
   return case when lower(coalesce(p_v#>>'{}', '')) = lower(coalesce(p_key#>>'{}', '')) then 'S' else 'NYS' end;
  when 'number' then
   if jsonb_typeof(p_v) <> 'number' then return 'NYS'; end if;
   if jsonb_typeof(p_key) = 'object' and p_key ? 'min' and p_key ? 'max' then
    return case when (p_v#>>'{}')::numeric between (p_key->>'min')::numeric and (p_key->>'max')::numeric then 'S' else 'NYS' end;
   end if;
   return case when (p_v#>>'{}')::numeric = (p_key#>>'{}')::numeric then 'S' else 'NYS' end;
  when 'multi_choice' then
   if jsonb_typeof(p_v) <> 'array' or jsonb_typeof(p_key) <> 'array' then return 'NYS'; end if;
   select array_agg(x order by x) into a from jsonb_array_elements_text(p_v) x; select array_agg(x order by x) into b from jsonb_array_elements_text(p_key) x;
   return case when coalesce(a, '{}') = coalesce(b, '{}') then 'S' else 'NYS' end;
  when 'ordering' then
   if jsonb_typeof(p_v) <> 'array' or jsonb_typeof(p_key) <> 'array' then return 'NYS'; end if;
   return case when p_v = p_key then 'S' else 'NYS' end;
  when 'matching' then
   if jsonb_typeof(p_v) <> 'object' or jsonb_typeof(p_key) <> 'object' then return 'NYS'; end if;
   for k in select * from jsonb_object_keys(p_key) loop
    if lower(coalesce(p_v->>k, '')) <> lower(coalesce(p_key->>k, '')) then return 'NYS'; end if;
   end loop;
   return 'S';
  when 'fill_blanks' then
   -- key: ["answer" | ["alt1","alt2"], ...] per blank, compared case- and space-insensitively
   if jsonb_typeof(p_v) <> 'array' or jsonb_typeof(p_key) <> 'array' or jsonb_array_length(p_v) <> jsonb_array_length(p_key) then return 'NYS'; end if;
   for k in select i::text from generate_series(0, jsonb_array_length(p_key) - 1) i loop
    if jsonb_typeof(p_key->k::integer) = 'array' then
     if not exists (select 1 from jsonb_array_elements_text(p_key->k::integer) alt where lower(btrim(alt)) = lower(btrim(coalesce(p_v->>k::integer, '')))) then return 'NYS'; end if;
    elsif lower(btrim(coalesce(p_v->>k::integer, ''))) <> lower(btrim(coalesce(p_key->>k::integer, ''))) then return 'NYS';
    end if;
   end loop;
   return 'S';
  else return null;
 end case;
end $$;

create or replace function public.asm_autocheck(p_attempt uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare t public.asm_attempts; v public.asm_versions; q record; k public.asm_question_keys; sug text; n integer := 0;
begin
 select * into t from public.asm_attempts where id = p_attempt; if t.id is null then return 0; end if;
 select * into v from public.asm_versions where id = t.version_id;
 for q in select * from public.asm_definition_questions(v.definition) x where x.marking_mode = 'auto' and x.depth = 0 loop
  select * into k from public.asm_question_keys where version_id = v.id and question_id = q.question_id;
  if k.id is null or k.answer_key is null then continue; end if;
  sug := public.asm_autocheck_one(q.question_type, k.answer_key, t.responses->q.question_id);
  if sug is null then continue; end if;
  insert into public.asm_results(attempt_id, question_id, suggested_outcome, suggested_detail)
  values (t.id, q.question_id, sug, jsonb_build_object('checkedAt', now(), 'type', q.question_type))
  on conflict (attempt_id, question_id, coalesce(criterion_id, '')) do update set suggested_outcome = excluded.suggested_outcome, suggested_detail = excluded.suggested_detail;
  n := n + 1;
 end loop;
 return n;
end $$;
revoke all on function public.asm_autocheck(uuid) from public, anon, authenticated;

-- Suggested task outcomes from the question / criterion outcomes (the assessor decides the stored outcome).
create or replace function public.asm_rollup(p_attempt uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t public.asm_attempts; v public.asm_versions; tk record; v_rule text; v_sug text;
begin
 select * into t from public.asm_attempts where id = p_attempt; if t.id is null then return; end if;
 select * into v from public.asm_versions where id = t.version_id;
 v_rule := coalesce((select s->>'rollup_rule' from public.asm_effective_settings((select assessment_id from public.asm_assignments where id = t.assignment_id)) s), 'all_satisfactory');
 for tk in select distinct q.task_id from public.asm_definition_questions(v.definition) q where q.marking_mode <> 'none' loop
  if v_rule = 'assessor_only' then v_sug := null;
  else
   select case when count(*) filter (where coalesce(r.outcome, r.suggested_outcome) is null) > 0 then null
               when count(*) filter (where coalesce(r.outcome, r.suggested_outcome) = 'NYS') > 0 then 'NYS' else 'S' end
   into v_sug
   from public.asm_definition_questions(v.definition) q
   left join public.asm_results r on r.attempt_id = t.id and r.question_id = q.question_id and r.criterion_id is null
   where q.task_id = tk.task_id and q.marking_mode <> 'none' and q.depth = 0;
  end if;
  insert into public.asm_task_results(attempt_id, task_id, rollup_suggested) values (t.id, tk.task_id, v_sug)
  on conflict (attempt_id, task_id) do update set rollup_suggested = excluded.rollup_suggested;
 end loop;
end $$;
revoke all on function public.asm_rollup(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ attempt payloads
create or replace function public.asm_attempt_json(p_attempt uuid, p_role text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t public.asm_attempts; v_results jsonb; v_show boolean;
begin
 select * into t from public.asm_attempts where id = p_attempt; if t.id is null then return null; end if;
 v_show := p_role <> 'student' or t.state in ('returned', 'final');
 v_results := case when v_show then coalesce((select jsonb_agg(jsonb_build_object('questionId', r.question_id, 'criterionId', r.criterion_id,
   'suggestedOutcome', case when p_role = 'student' then null else r.suggested_outcome end, 'outcome', r.outcome, 'score', r.score, 'rubricLevelId', r.rubric_level_id,
   'feedback', r.feedback, 'markedAt', r.marked_at) order by r.question_id, r.criterion_id) from public.asm_results r where r.attempt_id = t.id), '[]') else '[]'::jsonb end;
 return jsonb_build_object(
  'id', t.id, 'assignmentId', t.assignment_id, 'versionId', t.version_id, 'studentId', t.student_id, 'attemptNo', t.attempt_no, 'state', t.state,
  'responses', t.responses, 'assessorResponses', case when v_show then t.assessor_responses else '{}'::jsonb end,
  'responsesHash', t.responses_hash, 'declaration', t.declaration, 'receiptNo', t.receipt_no, 'dueAt', t.due_at,
  'outcome', case when v_show then t.outcome end, 'overallFeedback', case when v_show then t.overall_feedback else '' end,
  'startedAt', t.started_at, 'submittedAt', t.submitted_at, 'returnedAt', t.returned_at, 'finalisedAt', t.finalised_at, 'rowVersion', t.row_version,
  'evidence', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'questionId', f.question_id, 'groupIndex', f.group_index, 'byAssessor', f.by_assessor,
     'path', f.object_path, 'fileName', f.file_name, 'mime', f.mime, 'bytes', f.bytes, 'createdAt', f.created_at) order by f.created_at) from public.asm_evidence_files f where f.attempt_id = t.id), '[]'),
  'results', v_results,
  'taskResults', case when v_show then coalesce((select jsonb_agg(jsonb_build_object('taskId', x.task_id, 'rollupSuggested', case when p_role = 'student' then null else x.rollup_suggested end,
     'outcome', x.outcome, 'feedback', x.feedback, 'signedAt', x.signed_at) order by x.task_id) from public.asm_task_results x where x.attempt_id = t.id), '[]') else '[]'::jsonb end,
  'feedback', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'questionId', f.question_id, 'role', f.author_role, 'body', f.body, 'createdAt', f.created_at) order by f.created_at) from public.asm_feedback f where f.attempt_id = t.id), '[]'),
  'reassessments', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'role', r.requested_role, 'reason', r.reason, 'state', r.state, 'newDueAt', r.new_due_at, 'nextAttemptId', r.next_attempt_id, 'createdAt', r.created_at) order by r.created_at) from public.asm_reassessments r where r.attempt_id = t.id), '[]'));
end $$;
revoke all on function public.asm_attempt_json(uuid, text) from public, anon, authenticated;

create or replace function public.asm_assignment_json(a public.asm_assignments) returns jsonb
language sql stable security definer set search_path = public as $$
 select jsonb_build_object('id', a.id, 'assessmentId', a.assessment_id, 'versionId', a.version_id, 'batchId', a.batch_id, 'batchName', b.name,
  'intakeId', b.intake_id, 'intake', public.course_intake_display(i), 'courseId', i.course_id, 'courseName', public.course_label(c.code, c.name, c.variant_label),
  'assessmentTitle', s.title, 'assessmentCode', s.code, 'unitId', s.unit_id, 'unitCode', u.code, 'unitName', u.name, 'versionNo', v.version_no,
  'availableFrom', a.available_from, 'dueAt', a.due_at, 'lateUntil', a.late_until, 'status', a.status, 'reassignRule', a.reassign_rule, 'notes', a.notes,
  'trainers', coalesce((select jsonb_agg(jsonb_build_object('staffId', p.id, 'name', btrim(p.first_name || ' ' || p.last_name), 'source', x.source) order by p.first_name)
    from (select bt.staff_id, 'batch' as source from public.batch_trainers bt where bt.batch_id = a.batch_id
          union select at.staff_id, 'assignment' from public.asm_assignment_trainers at where at.assignment_id = a.id) x join hr.staff_profiles p on p.id = x.staff_id), '[]'),
  'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'title', e.title, 'startsAt', e.starts_at, 'endsAt', e.ends_at, 'roomId', e.room_id, 'trainerStaffId', e.trainer_staff_id, 'notes', e.notes) order by e.starts_at)
    from public.asm_schedule_events e where e.assignment_id = a.id), '[]'),
  'eligibleCount', (select count(*) from public.asm_assignment_eligible(a.id)))
 from public.batches b join public.course_intakes i on i.id = b.intake_id join public.cms_courses c on c.id = i.course_id
 join public.asm_assessments s on s.id = a.assessment_id left join public.cms_course_units u on u.id = s.unit_id join public.asm_versions v on v.id = a.version_id
 where b.id = a.batch_id;
$$;
revoke all on function public.asm_assignment_json(public.asm_assignments) from public, anon, authenticated;

-- The student's due date for an assignment: their override, else the assignment's.
create or replace function public.asm_due_for(p_assignment uuid, p_student uuid) returns timestamptz
language sql stable security definer set search_path = public as $$
 select coalesce((select s.due_at from public.asm_assignment_students s where s.assignment_id = p_assignment and s.student_id = p_student), a.due_at)
 from public.asm_assignments a where a.id = p_assignment;
$$;
revoke all on function public.asm_due_for(uuid, uuid) from public, anon, authenticated;

create or replace function public.asm_open_attempt(p_assignment uuid, p_student uuid, p_attempt_no integer, p_due timestamptz, p_copy_from uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare a public.asm_assignments; v_id uuid; prev public.asm_attempts;
begin
 select * into a from public.asm_assignments where id = p_assignment;
 if p_copy_from is not null then select * into prev from public.asm_attempts where id = p_copy_from; end if;
 insert into public.asm_attempts(assignment_id, version_id, student_id, attempt_no, due_at, responses)
 values (a.id, a.version_id, p_student, p_attempt_no, p_due, coalesce(prev.responses, '{}'::jsonb)) returning id into v_id;
 if prev.id is not null then
  insert into public.asm_evidence_files(attempt_id, question_id, group_index, by_assessor, object_path, file_name, mime, bytes, sha256, uploaded_by)
  select v_id, question_id, group_index, by_assessor, object_path, file_name, mime, bytes, sha256, uploaded_by from public.asm_evidence_files where attempt_id = prev.id and not by_assessor;
 end if;
 return v_id;
end $$;
revoke all on function public.asm_open_attempt(uuid, uuid, integer, timestamptz, uuid) from public, anon, authenticated;

-- Notify every trainer of an assignment (batch trainers + named assessors).
create or replace function public.asm_notify_trainers(p_assignment uuid, p_event text, p_title text, p_body text, p_attempt uuid default null) returns integer
language plpgsql security definer set search_path = public as $$
declare x record; n integer := 0; a public.asm_assignments;
begin
 select * into a from public.asm_assignments where id = p_assignment;
 for x in select distinct s.staff_id from (select bt.staff_id from public.batch_trainers bt where bt.batch_id = a.batch_id
                                            union select at.staff_id from public.asm_assignment_trainers at where at.assignment_id = a.id) s loop
  perform public.asm_notify(c.auth_user, 'trainer', p_event, p_title, p_body, c.email, p_attempt, p_assignment, a.tenant_id) from public.asm_trainer_contact(x.staff_id) c;
  n := n + 1;
 end loop;
 return n;
end $$;
revoke all on function public.asm_notify_trainers(uuid, text, text, text, uuid) from public, anon, authenticated;

create or replace function public.asm_notify_student(p_student uuid, p_event text, p_title text, p_body text, p_attempt uuid default null, p_assignment uuid default null, p_tenant uuid default null) returns uuid
language sql security definer set search_path = public as $$
 select public.asm_notify(c.auth_user, 'student', p_event, p_title, p_body, c.email, p_attempt, p_assignment, p_tenant) from public.asm_student_contact(p_student) c;
$$;
revoke all on function public.asm_notify_student(uuid, text, text, text, uuid, uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ ADMIN
create or replace function public.asm_admin(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_id uuid; v_ver public.asm_versions; v_as public.asm_assessments; v_set public.asm_settings; v_tenant uuid;
 x jsonb; n integer := 0; v_errs jsonb; v_defn jsonb; v_keys jsonb; v_maps jsonb; v_bid uuid; v_a public.asm_assignments; v_att public.asm_attempts; v_student uuid;
 v_rv integer; v_unit text; v_elem uuid; v_next uuid; v_due timestamptz; v_text text; v_role text := 'admin';
begin
 if not public.cms_is_staff() then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 if p_action = 'me' then
  return jsonb_build_object('admin', public.cms_is_admin(), 'rtoManager', public.cms_is_rto_manager(), 'assessmentAdmin', public.asm_is_admin(), 'trainerProfileId', public.asm_trainer_profile());
 end if;
 if not public.asm_is_admin() then raise exception 'Only an Admin or an RTO Manager can manage assessments.' using errcode = '42501'; end if;

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
   declaration_text = coalesce(public.asm_json_text(d, 'declarationText'), declaration_text), instructions = coalesce(d->>'instructions', instructions),
   evidence_max_mb = coalesce((d->>'evidenceMaxMb')::integer, evidence_max_mb),
   evidence_allowed_types = case when jsonb_typeof(d->'evidenceAllowedTypes') = 'array' then (select coalesce(array_agg(ta.v), '{}') from jsonb_array_elements_text(d->'evidenceAllowedTypes') as ta(v)) else evidence_allowed_types end,
   updated_by = auth.uid(), updated_at = now()
  where id = v_set.id returning * into v_set;
  perform public.asm_log(v_role, 'settings_save', 'settings', v_set.id::text, d, v_set.tenant_id);
  return to_jsonb(v_set);

 -- ---------------------------------------------------------------- unit elements
 elsif p_action = 'unit_elements_list' then
  v_unit := public.asm_json_text(d, 'unitId'); if v_unit is null then raise exception 'unitId is required' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'parentId', e.parent_id, 'code', e.code, 'text', e.text, 'sort', e.sort, 'isActive', e.is_active) order by e.kind, e.sort, e.code)
    from public.asm_unit_elements e where e.unit_id = v_unit), '[]');
 elsif p_action = 'unit_elements_save' then
  v_unit := public.asm_json_text(d, 'unitId'); if v_unit is null then raise exception 'unitId is required' using errcode = '22023'; end if;
  if not exists (select 1 from public.cms_course_units where id = v_unit) then raise exception 'Unit not found' using errcode = 'P0002'; end if;
  -- items: [{id?, kind, parentId?, parentCode?, code, text, sort}]; items left out are deactivated (mappings keep pointing at them)
  create temp table if not exists asm_tmp_keep(id uuid) on commit drop; delete from asm_tmp_keep;
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
 elsif p_action = 'bank_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'title', b.title, 'tags', b.tags, 'type', b.question_type, 'unitId', b.unit_id, 'courseId', b.course_id,
    'versionNo', b.current_version_no, 'updatedAt', b.updated_at) order by b.updated_at desc)
   from public.asm_question_bank b where b.archived_at is null
    and (public.asm_json_text(d, 'unitId') is null or b.unit_id = d->>'unitId')
    and (public.asm_json_text(d, 'q') is null or b.title ilike '%' || (d->>'q') || '%' or exists (select 1 from unnest(b.tags) t where t ilike '%' || (d->>'q') || '%'))), '[]');
 elsif p_action = 'bank_get' then
  v_id := public.asm_json_uuid(d, 'id');
  return (select jsonb_build_object('id', b.id, 'title', b.title, 'tags', b.tags, 'type', b.question_type, 'unitId', b.unit_id, 'courseId', b.course_id, 'versionNo', b.current_version_no,
    'definition', v.definition, 'keys', v.keys, 'versions', (select jsonb_agg(jsonb_build_object('no', x.version_no, 'createdAt', x.created_at) order by x.version_no) from public.asm_question_bank_versions x where x.bank_id = b.id))
   from public.asm_question_bank b left join public.asm_question_bank_versions v on v.bank_id = b.id and v.version_no = b.current_version_no where b.id = v_id);
 elsif p_action = 'bank_save' then
  v_defn := d->'definition'; if v_defn is null or jsonb_typeof(v_defn) <> 'object' or nullif(v_defn->>'type', '') is null then raise exception 'A bank question needs a definition with a type' using errcode = '22023'; end if;
  if public.asm_jsonb_forbidden_key(v_defn) is not null then raise exception 'Keep assessor data in keys, not in the definition' using errcode = '22023'; end if;
  v_id := public.asm_json_uuid(d, 'id');
  if v_id is null then
   insert into public.asm_question_bank(course_id, unit_id, title, tags, question_type, created_by)
   values (public.asm_json_text(d, 'courseId'), public.asm_json_text(d, 'unitId'), coalesce(public.asm_json_text(d, 'title'), coalesce(v_defn->>'label', 'Question')),
           case when jsonb_typeof(d->'tags') = 'array' then (select coalesce(array_agg(ta.v), '{}') from jsonb_array_elements_text(d->'tags') as ta(v)) else '{}' end, v_defn->>'type', auth.uid()) returning id into v_id;
  else
   update public.asm_question_bank set title = coalesce(public.asm_json_text(d, 'title'), title), unit_id = coalesce(public.asm_json_text(d, 'unitId'), unit_id), question_type = v_defn->>'type',
     tags = case when jsonb_typeof(d->'tags') = 'array' then (select coalesce(array_agg(ta.v), '{}') from jsonb_array_elements_text(d->'tags') as ta(v)) else tags end where id = v_id;
   if not found then raise exception 'Bank question not found' using errcode = 'P0002'; end if;
  end if;
  update public.asm_question_bank set current_version_no = current_version_no + 1 where id = v_id returning current_version_no into n;
  insert into public.asm_question_bank_versions(bank_id, version_no, definition, keys, created_by) values (v_id, n, v_defn, coalesce(d->'keys', '{}'::jsonb), auth.uid());
  perform public.asm_log(v_role, 'bank_save', 'question_bank', v_id::text, jsonb_build_object('versionNo', n));
  return public.asm_admin('bank_get', jsonb_build_object('id', v_id));
 elsif p_action = 'bank_archive' then
  v_id := public.asm_json_uuid(d, 'id');
  update public.asm_question_bank set archived_at = now() where id = v_id and archived_at is null;
  perform public.asm_log(v_role, 'bank_archive', 'question_bank', v_id::text);
  return jsonb_build_object('ok', true);

 -- ---------------------------------------------------------------- assessments
 elsif p_action = 'assessment_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'courseId', a.course_id, 'courseName', public.course_label(c.code, c.name, c.variant_label), 'unitId', a.unit_id, 'unitCode', u.code, 'unitName', u.name,
     'code', a.code, 'title', a.title, 'description', a.description, 'isTemplate', a.is_template, 'archivedAt', a.archived_at, 'updatedAt', a.updated_at,
     'currentVersionNo', v.version_no, 'currentVersionStatus', v.status, 'hasDraft', exists (select 1 from public.asm_versions x where x.assessment_id = a.id and x.status = 'draft'),
     'assignments', (select count(*) from public.asm_assignments g where g.assessment_id = a.id and g.status <> 'cancelled')) order by a.updated_at desc)
   from public.asm_assessments a join public.cms_courses c on c.id = a.course_id left join public.cms_course_units u on u.id = a.unit_id left join public.asm_versions v on v.id = a.current_version_id
   where (coalesce((d->>'includeArchived')::boolean, false) or a.archived_at is null)
     and (public.asm_json_text(d, 'courseId') is null or a.course_id = d->>'courseId') and (public.asm_json_text(d, 'unitId') is null or a.unit_id = d->>'unitId')
     and (d->'isTemplate' is null or a.is_template = (d->>'isTemplate')::boolean)
     and (public.asm_json_text(d, 'q') is null or a.title ilike '%' || (d->>'q') || '%' or coalesce(a.code, '') ilike '%' || (d->>'q') || '%')), '[]');

 elsif p_action = 'assessment_create' then
  -- from scratch, as a clone (fromAssessmentId: current version's definition, keys and mappings), or from an export (import: {definition, keys, mappings, elements})
  if public.asm_json_text(d, 'courseId') is null then raise exception 'courseId is required' using errcode = '22023'; end if;
  if not exists (select 1 from public.cms_courses where id = d->>'courseId') then raise exception 'Course not found' using errcode = 'P0002'; end if;
  v_unit := public.asm_json_text(d, 'unitId');
  if v_unit is not null and not exists (select 1 from public.cms_course_units where id = v_unit and course_id = d->>'courseId') then raise exception 'The unit does not belong to the course' using errcode = '22023'; end if;
  v_defn := '{"tasks": []}'::jsonb; v_keys := '[]'::jsonb; v_maps := '[]'::jsonb;
  if public.asm_json_uuid(d, 'fromAssessmentId') is not null then
   select * into v_as from public.asm_assessments where id = public.asm_json_uuid(d, 'fromAssessmentId');
   if v_as.id is null then raise exception 'Source assessment not found' using errcode = 'P0002'; end if;
   select * into v_ver from public.asm_versions where id = coalesce(v_as.current_version_id, (select id from public.asm_versions where assessment_id = v_as.id order by version_no desc limit 1));
   if v_ver.id is not null then
    v_defn := v_ver.definition;
    v_keys := coalesce((select jsonb_agg(jsonb_build_object('questionId', k.question_id, 'modelAnswer', k.model_answer, 'answerKey', k.answer_key, 'assessorGuidance', k.assessor_guidance, 'rubricLevels', k.rubric_levels)) from public.asm_question_keys k where k.version_id = v_ver.id), '[]');
    v_maps := coalesce((select jsonb_agg(jsonb_build_object('questionId', m.question_id, 'criterionId', m.criterion_id, 'elementId', m.element_id)) from public.asm_unit_mappings m where m.version_id = v_ver.id), '[]');
   end if;
  elsif d ? 'import' then
   v_defn := coalesce(d->'import'->'definition', v_defn); v_keys := coalesce(d->'import'->'keys', v_keys);
  end if;
  v_errs := public.asm_validate_definition(v_defn);
  if jsonb_array_length(v_errs) > 0 then return jsonb_build_object('ok', false, 'errors', v_errs); end if;
  insert into public.asm_assessments(course_id, unit_id, code, title, description, is_template, created_by)
  values (d->>'courseId', v_unit, public.asm_json_text(d, 'code'), coalesce(public.asm_json_text(d, 'title'), 'Untitled assessment'), coalesce(d->>'description', ''), coalesce((d->>'isTemplate')::boolean, false), auth.uid())
  returning * into v_as;
  insert into public.asm_versions(assessment_id, version_no, definition, created_by) values (v_as.id, 1, v_defn, auth.uid()) returning * into v_ver;
  for x in select * from jsonb_array_elements(v_keys) loop
   insert into public.asm_question_keys(version_id, question_id, model_answer, answer_key, assessor_guidance, rubric_levels, updated_by)
   values (v_ver.id, x->>'questionId', x->>'modelAnswer', x->'answerKey', x->>'assessorGuidance', x->'rubricLevels', auth.uid()) on conflict do nothing;
  end loop;
  -- mappings by element id (clone within the same unit) or by element kind + code (import; missing elements are created on the unit)
  for x in select * from jsonb_array_elements(coalesce(v_maps, '[]') || coalesce(d->'import'->'mappings', '[]')) loop
   v_elem := public.asm_json_uuid(x, 'elementId');
   if v_elem is null and v_unit is not null and public.asm_json_text(x, 'elementCode') is not null then
    select id into v_elem from public.asm_unit_elements where unit_id = v_unit and kind = coalesce(x->>'elementKind', 'element') and code = x->>'elementCode' limit 1;
    if v_elem is null then
     insert into public.asm_unit_elements(unit_id, kind, code, text) values (v_unit, coalesce(x->>'elementKind', 'element'), x->>'elementCode', coalesce(public.asm_json_text(x, 'elementText'), x->>'elementCode')) returning id into v_elem;
    end if;
   end if;
   if v_elem is not null and exists (select 1 from public.asm_unit_elements e where e.id = v_elem and (v_unit is null or e.unit_id = v_unit)) then
    insert into public.asm_unit_mappings(version_id, question_id, criterion_id, element_id) values (v_ver.id, x->>'questionId', public.asm_json_text(x, 'criterionId'), v_elem) on conflict do nothing;
   end if;
  end loop;
  perform public.asm_log(v_role, 'assessment_create', 'assessment', v_as.id::text, jsonb_build_object('from', d->>'fromAssessmentId', 'import', d ? 'import'), v_as.tenant_id);
  return public.asm_admin('assessment_get', jsonb_build_object('id', v_as.id));

 elsif p_action = 'assessment_get' then
  v_id := public.asm_json_uuid(d, 'id');
  select * into v_as from public.asm_assessments where id = v_id; if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  select * into v_ver from public.asm_versions where assessment_id = v_as.id and status = 'draft';
  if v_ver.id is null then select * into v_ver from public.asm_versions where id = v_as.current_version_id; end if;
  return jsonb_build_object('id', v_as.id, 'courseId', v_as.course_id, 'unitId', v_as.unit_id, 'code', v_as.code, 'title', v_as.title, 'description', v_as.description,
   'isTemplate', v_as.is_template, 'settingsOverride', v_as.settings_override, 'archivedAt', v_as.archived_at, 'currentVersionId', v_as.current_version_id, 'updatedAt', v_as.updated_at,
   'effectiveSettings', public.asm_effective_settings(v_as.id),
   'editing', case when v_ver.id is null then null else jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no, 'status', v_ver.status, 'definition', v_ver.definition, 'updatedAt', v_ver.updated_at,
     'keys', coalesce((select jsonb_agg(jsonb_build_object('questionId', k.question_id, 'modelAnswer', k.model_answer, 'answerKey', k.answer_key, 'assessorGuidance', k.assessor_guidance, 'rubricLevels', k.rubric_levels)) from public.asm_question_keys k where k.version_id = v_ver.id), '[]'),
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
 elsif p_action = 'assessment_export' then
  v_id := public.asm_json_uuid(d, 'id');
  select * into v_as from public.asm_assessments where id = v_id; if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  select * into v_ver from public.asm_versions where id = coalesce(public.asm_json_uuid(d, 'versionId'), (select id from public.asm_versions where assessment_id = v_as.id and status = 'draft'), v_as.current_version_id);
  if v_ver.id is null then raise exception 'Nothing to export' using errcode = 'P0002'; end if;
  return jsonb_build_object('format', 'skyline-assessment/1', 'exportedAt', now(), 'title', v_as.title, 'code', v_as.code, 'description', v_as.description,
   'unitCode', (select code from public.cms_course_units where id = v_as.unit_id), 'versionNo', v_ver.version_no, 'versionStatus', v_ver.status, 'checksum', v_ver.checksum,
   'definition', v_ver.definition,
   'keys', coalesce((select jsonb_agg(jsonb_build_object('questionId', k.question_id, 'modelAnswer', k.model_answer, 'answerKey', k.answer_key, 'assessorGuidance', k.assessor_guidance, 'rubricLevels', k.rubric_levels)) from public.asm_question_keys k where k.version_id = v_ver.id), '[]'),
   'mappings', coalesce((select jsonb_agg(jsonb_build_object('questionId', m.question_id, 'criterionId', m.criterion_id, 'elementKind', e.kind, 'elementCode', e.code, 'elementText', e.text)) from public.asm_unit_mappings m join public.asm_unit_elements e on e.id = m.element_id where m.version_id = v_ver.id), '[]'),
   'settingsOverride', v_as.settings_override);

 -- ---------------------------------------------------------------- draft editing and publishing (D-06)
 elsif p_action = 'draft_save' then
  v_id := public.asm_json_uuid(d, 'assessmentId');
  select * into v_as from public.asm_assessments where id = v_id; if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  if v_as.archived_at is not null then raise exception 'An archived assessment cannot be edited' using errcode = '42501'; end if;
  v_defn := coalesce(d->'definition', '{"tasks": []}'::jsonb);
  v_errs := public.asm_validate_definition(v_defn);
  if jsonb_array_length(v_errs) > 0 then return jsonb_build_object('ok', false, 'errors', v_errs); end if;
  select * into v_ver from public.asm_versions where assessment_id = v_as.id and status = 'draft';
  if v_ver.id is null then
   -- the next draft starts from the published snapshot (its keys and mappings are copied so nothing is lost)
   select * into v_ver from public.asm_versions where id = v_as.current_version_id;
   insert into public.asm_versions(assessment_id, version_no, definition, created_by)
   values (v_as.id, coalesce((select max(version_no) from public.asm_versions where assessment_id = v_as.id), 0) + 1, coalesce(v_ver.definition, '{"tasks": []}'::jsonb), auth.uid()) returning id into v_next;
   if v_ver.id is not null then
    insert into public.asm_question_keys(version_id, question_id, model_answer, answer_key, assessor_guidance, rubric_levels, updated_by)
    select v_next, question_id, model_answer, answer_key, assessor_guidance, rubric_levels, auth.uid() from public.asm_question_keys where version_id = v_ver.id;
    insert into public.asm_unit_mappings(version_id, question_id, criterion_id, element_id) select v_next, question_id, criterion_id, element_id from public.asm_unit_mappings where version_id = v_ver.id;
   end if;
   select * into v_ver from public.asm_versions where id = v_next;
  elsif d ? 'expectedUpdatedAt' and public.asm_json_ts(d, 'expectedUpdatedAt') is distinct from v_ver.updated_at then
   raise exception 'This draft was changed by someone else; reload before saving.' using errcode = '40001';
  end if;
  update public.asm_versions set definition = v_defn where id = v_ver.id;
  if jsonb_typeof(d->'keys') = 'array' then
   delete from public.asm_question_keys where version_id = v_ver.id;
   for x in select * from jsonb_array_elements(d->'keys') loop
    if public.asm_json_text(x, 'questionId') is null then continue; end if;
    insert into public.asm_question_keys(version_id, question_id, model_answer, answer_key, assessor_guidance, rubric_levels, updated_by)
    values (v_ver.id, x->>'questionId', x->>'modelAnswer', x->'answerKey', x->>'assessorGuidance', x->'rubricLevels', auth.uid()) on conflict (version_id, question_id) do update
     set model_answer = excluded.model_answer, answer_key = excluded.answer_key, assessor_guidance = excluded.assessor_guidance, rubric_levels = excluded.rubric_levels, updated_by = auth.uid(), updated_at = now();
   end loop;
  end if;
  if jsonb_typeof(d->'mappings') = 'array' then
   delete from public.asm_unit_mappings where version_id = v_ver.id;
   for x in select * from jsonb_array_elements(d->'mappings') loop
    v_elem := public.asm_json_uuid(x, 'elementId');
    if v_elem is null or public.asm_json_text(x, 'questionId') is null then continue; end if;
    if v_as.unit_id is not null and not exists (select 1 from public.asm_unit_elements e where e.id = v_elem and e.unit_id = v_as.unit_id) then raise exception 'Mapping to an element of another unit' using errcode = '23503'; end if;
    insert into public.asm_unit_mappings(version_id, question_id, criterion_id, element_id) values (v_ver.id, x->>'questionId', public.asm_json_text(x, 'criterionId'), v_elem) on conflict do nothing;
   end loop;
  end if;
  update public.asm_assessments set updated_at = now() where id = v_as.id;
  perform public.asm_log(v_role, 'draft_save', 'version', v_ver.id::text, jsonb_build_object('questions', (select count(*) from public.asm_definition_questions(v_defn))), v_as.tenant_id);
  return jsonb_build_object('ok', true, 'versionId', v_ver.id, 'versionNo', v_ver.version_no, 'updatedAt', (select updated_at from public.asm_versions where id = v_ver.id));

 elsif p_action = 'version_publish' then
  v_id := public.asm_json_uuid(d, 'assessmentId');
  select * into v_as from public.asm_assessments where id = v_id; if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  select * into v_ver from public.asm_versions where assessment_id = v_as.id and status = 'draft';
  if v_ver.id is null then raise exception 'There is no draft to publish' using errcode = 'P0002'; end if;
  v_errs := public.asm_validate_definition(v_ver.definition);
  if jsonb_array_length(coalesce(v_ver.definition->'tasks', '[]')) = 0 then v_errs := v_errs || jsonb_build_object('code', 'no_tasks', 'message', 'Add at least one task before publishing.'); end if;
  if not exists (select 1 from public.asm_definition_questions(v_ver.definition) q where q.marking_mode <> 'none') then v_errs := v_errs || jsonb_build_object('code', 'no_questions', 'message', 'Add at least one assessable question.'); end if;
  if jsonb_array_length(v_errs) > 0 then return jsonb_build_object('ok', false, 'errors', v_errs); end if;
  update public.asm_versions set status = 'published', checksum = encode(sha256(convert_to(definition::text, 'UTF8')), 'hex'), published_at = now(), published_by = auth.uid() where id = v_ver.id returning * into v_ver;
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
  return jsonb_build_object('id', v_ver.id, 'assessmentId', v_ver.assessment_id, 'versionNo', v_ver.version_no, 'status', v_ver.status, 'definition', v_ver.definition, 'checksum', v_ver.checksum, 'publishedAt', v_ver.published_at,
   'keys', coalesce((select jsonb_agg(jsonb_build_object('questionId', k.question_id, 'modelAnswer', k.model_answer, 'answerKey', k.answer_key, 'assessorGuidance', k.assessor_guidance, 'rubricLevels', k.rubric_levels)) from public.asm_question_keys k where k.version_id = v_ver.id), '[]'),
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
   'unmappedQuestions', coalesce((select jsonb_agg(q.question_id) from public.asm_definition_questions(v_ver.definition) q where q.marking_mode <> 'none' and not exists (select 1 from public.asm_unit_mappings m where m.version_id = v_ver.id and m.question_id = q.question_id)), '[]'));

 -- ---------------------------------------------------------------- assignments (brief section 7)
 elsif p_action = 'assignment_create' then
  v_id := public.asm_json_uuid(d, 'assessmentId');
  select * into v_as from public.asm_assessments where id = v_id; if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  select * into v_ver from public.asm_versions where id = coalesce(public.asm_json_uuid(d, 'versionId'), v_as.current_version_id) and status = 'published';
  if v_ver.id is null or v_ver.assessment_id <> v_as.id then raise exception 'Publish the assessment before assigning it' using errcode = '23503'; end if;
  v_due := public.asm_json_ts(d, 'dueAt'); if v_due is null then raise exception 'dueAt is required' using errcode = '22023'; end if;
  v_errs := '[]';
  for v_bid in select ta.v::uuid from jsonb_array_elements_text(coalesce(d->'batchIds', '[]')) as ta(v) loop
   if not exists (select 1 from public.batches b join public.course_intakes i on i.id = b.intake_id where b.id = v_bid and i.course_id = v_as.course_id) then
    raise exception 'Batch % is not on this course', v_bid using errcode = '23503';
   end if;
   insert into public.asm_assignments(assessment_id, version_id, batch_id, available_from, due_at, late_until, reassign_rule, notes, created_by)
   values (v_as.id, v_ver.id, v_bid, coalesce(public.asm_json_ts(d, 'availableFrom'), now()), v_due, public.asm_json_ts(d, 'lateUntil'), coalesce(d->>'reassignRule', 'follow_batch'), coalesce(d->>'notes', ''), auth.uid())
   on conflict (version_id, batch_id) do nothing returning * into v_a;
   if v_a.id is null then v_errs := v_errs || jsonb_build_object('batchId', v_bid, 'code', 'exists', 'message', 'This version is already assigned to the batch.'); continue; end if;
   insert into public.asm_assignment_trainers(assignment_id, staff_id) select v_a.id, ta.v::uuid from jsonb_array_elements_text(coalesce(d->'trainerStaffIds', '[]')) as ta(v) on conflict do nothing;
   insert into public.asm_schedule_events(assignment_id, kind, title, starts_at, ends_at, room_id, trainer_staff_id, notes)
   select v_a.id, coalesce(e->>'kind', 'practical'), coalesce(public.asm_json_text(e, 'title'), v_as.title), public.asm_json_ts(e, 'startsAt'), public.asm_json_ts(e, 'endsAt'), public.asm_json_uuid(e, 'roomId'), public.asm_json_uuid(e, 'trainerStaffId'), coalesce(e->>'notes', '')
   from jsonb_array_elements(coalesce(d->'events', '[]')) e where public.asm_json_ts(e, 'startsAt') is not null;
   insert into public.asm_schedule_events(assignment_id, kind, title, starts_at) values (v_a.id, 'due', v_as.title || ': due', v_due);
   for v_student in select * from public.asm_assignment_eligible(v_a.id) loop
    perform public.asm_notify_student(v_student, 'published', 'New assessment: ' || v_as.title, 'Due ' || to_char(v_due at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '. Open My Assessments to start.', null, v_a.id, v_as.tenant_id);
   end loop;
   perform public.asm_notify_trainers(v_a.id, 'published', 'Assessment assigned to your batch: ' || v_as.title, 'Due ' || to_char(v_due at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.');
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
    perform public.asm_notify_student(v_student, 'extended', 'Due date changed', 'The due date is now ' || to_char(v_a.due_at at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.', null, v_id, v_a.tenant_id);
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
  return coalesce((select jsonb_agg(public.asm_assignment_json(a) order by a.due_at desc) from public.asm_assignments a join public.batches b on b.id = a.batch_id join public.course_intakes i on i.id = b.intake_id
   where (public.asm_json_uuid(d, 'assessmentId') is null or a.assessment_id = public.asm_json_uuid(d, 'assessmentId'))
     and (public.asm_json_uuid(d, 'batchId') is null or a.batch_id = public.asm_json_uuid(d, 'batchId'))
     and (public.asm_json_uuid(d, 'intakeId') is null or b.intake_id = public.asm_json_uuid(d, 'intakeId'))
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
   perform public.asm_notify_student(v_student, 'extended', 'Your due date changed', 'The due date is now ' || to_char(public.asm_due_for(v_id, v_student) at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.', null, v_id, v_a.tenant_id);
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
  create temp table if not exists asm_tmp_scope(id uuid) on commit drop; delete from asm_tmp_scope;
  insert into asm_tmp_scope select a.id from public.asm_assignments a join public.batches b on b.id = a.batch_id join public.course_intakes i on i.id = b.intake_id
   where a.status <> 'cancelled' and (public.asm_json_uuid(d, 'batchId') is null or a.batch_id = public.asm_json_uuid(d, 'batchId'))
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
      'state', t.state, 'submittedAt', t.submitted_at, 'assessmentTitle', x.title, 'batchName', b.name) order by t.submitted_at)
     from public.asm_attempts t join public.asm_assignments g on g.id = t.assignment_id join public.asm_assessments x on x.id = g.assessment_id join public.batches b on b.id = g.batch_id
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
  v_due := coalesce(public.asm_json_ts(d, 'dueAt'), now() + interval '7 days');
  v_next := public.asm_open_attempt(v_att.assignment_id, v_att.student_id, (select max(attempt_no) + 1 from public.asm_attempts where assignment_id = v_att.assignment_id and student_id = v_att.student_id), v_due, v_att.id);
  insert into public.asm_reassessments(attempt_id, student_id, requested_role, reason, state, new_due_at, next_attempt_id, decided_by, decided_at)
  values (v_att.id, v_att.student_id, 'admin', coalesce(d->>'reason', 'reopened by administrator'), 'opened', v_due, v_next, auth.uid(), now());
  perform public.asm_notify_student(v_att.student_id, 'reassessment', 'Your assessment has been reopened', 'A further attempt is open until ' || to_char(v_due at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.', v_next, v_att.assignment_id, v_att.tenant_id);
  perform public.asm_log(v_role, 'attempt_reopen', 'attempt', v_id::text, jsonb_build_object('nextAttemptId', v_next, 'dueAt', v_due, 'reason', d->>'reason'), v_att.tenant_id);
  return jsonb_build_object('ok', true, 'attemptId', v_next);
 elsif p_action = 'reassessment_decide' then
  v_id := public.asm_json_uuid(d, 'id');
  select t.* into v_att from public.asm_reassessments r join public.asm_attempts t on t.id = r.attempt_id where r.id = v_id and r.state = 'requested';
  if v_att.id is null then raise exception 'Request not found or already decided' using errcode = 'P0002'; end if;
  if coalesce((d->>'approve')::boolean, false) then
   if exists (select 1 from public.asm_attempts where assignment_id = v_att.assignment_id and student_id = v_att.student_id and state = 'draft') then raise exception 'The student already has an open attempt' using errcode = '23505'; end if;
   v_due := coalesce(public.asm_json_ts(d, 'dueAt'), now() + make_interval(days => coalesce((public.asm_effective_settings((select assessment_id from public.asm_assignments where id = v_att.assignment_id))->>'reassessment_days')::integer, 5)));
   v_next := public.asm_open_attempt(v_att.assignment_id, v_att.student_id, (select max(attempt_no) + 1 from public.asm_attempts where assignment_id = v_att.assignment_id and student_id = v_att.student_id), v_due, v_att.id);
   update public.asm_reassessments set state = 'opened', new_due_at = v_due, next_attempt_id = v_next, decided_by = auth.uid(), decided_at = now() where id = v_id;
   perform public.asm_notify_student(v_att.student_id, 'reassessment', 'Reassessment approved', 'A further attempt is open until ' || to_char(v_due at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.', v_next, v_att.assignment_id, v_att.tenant_id);
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
    'batchId', o.batch_id, 'outcome', o.outcome, 'signedName', o.signed_name, 'signedRole', o.signed_role, 'signedAt', o.signed_at, 'notes', o.notes, 'supersedesId', o.supersedes_id,
    'current', not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = o.id)) order by o.signed_at desc)
   from public.asm_unit_outcomes o join public.enrollment_students s on s.id = o.student_id join public.cms_course_units u on u.id = o.unit_id
   where (public.asm_json_uuid(d, 'studentId') is null or o.student_id = public.asm_json_uuid(d, 'studentId')) and (public.asm_json_text(d, 'unitId') is null or o.unit_id = d->>'unitId')
     and (public.asm_json_uuid(d, 'batchId') is null or o.batch_id = public.asm_json_uuid(d, 'batchId'))), '[]');
 elsif p_action = 'student_progress' then
  return public.asm_student_progress(public.asm_json_uuid(d, 'studentId'));
 elsif p_action = 'staff_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', btrim(s.first_name || ' ' || s.last_name), 'email', s.email,
    'isTrainer', exists (select 1 from hr.staff_roles r where r.profile_id = s.id and r.role = 'trainer' and r.revoked_at is null)) order by s.first_name, s.last_name)
   from hr.staff_profiles s where s.status = 'active'), '[]');
 elsif p_action = 'batch_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'intakeId', b.intake_id, 'intake', public.course_intake_display(i), 'courseId', i.course_id, 'courseName', public.course_label(c.code, c.name, c.variant_label),
    'students', (select count(*) from public.batch_enrolments e where e.batch_id = b.id and e.status = 'active'), 'isActive', b.is_active) order by i.start_date desc, b.name)
   from public.batches b join public.course_intakes i on i.id = b.intake_id join public.cms_courses c on c.id = i.course_id
   where (public.asm_json_text(d, 'courseId') is null or i.course_id = d->>'courseId') and (coalesce((d->>'includeInactive')::boolean, false) or b.is_active)), '[]');
 elsif p_action = 'audit_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'actor', l.actor, 'role', l.actor_role, 'action', l.action, 'targetType', l.target_type, 'targetId', l.target_id, 'detail', l.detail, 'at', l.created_at) order by l.id desc)
   from (select * from public.asm_audit_log l where (public.asm_json_text(d, 'targetType') is null or l.target_type = d->>'targetType') and (public.asm_json_text(d, 'targetId') is null or l.target_id = d->>'targetId')
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
end $$;
revoke all on function public.asm_admin(text, jsonb) from public, anon;
grant execute on function public.asm_admin(text, jsonb) to authenticated;

-- Unit outcome with sign-off: never automatic (brief 8); the signer is the caller, recorded by name and role.
create or replace function public.asm_record_unit_outcome(d jsonb, p_role text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_student uuid := public.asm_json_uuid(d, 'studentId'); v_unit text := public.asm_json_text(d, 'unitId'); v_out text := upper(coalesce(d->>'outcome', ''));
 v_prev uuid; v_id uuid; v_staff uuid := public.asm_trainer_profile(); v_name text; v_ids uuid[]; v_batch uuid := public.asm_json_uuid(d, 'batchId'); v_tenant uuid;
begin
 if v_student is null or v_unit is null then raise exception 'studentId and unitId are required' using errcode = '22023'; end if;
 if v_out not in ('C', 'NYC') then raise exception 'outcome must be C or NYC' using errcode = '22023'; end if;
 if p_role = 'trainer' then
  if v_staff is null then raise exception 'Only an active trainer can sign off' using errcode = '42501'; end if;
  if not exists (select 1 from public.batch_enrolments e join public.batch_trainers bt on bt.batch_id = e.batch_id where e.student_id = v_student and bt.staff_id = v_staff and e.status in ('active', 'completed'))
     and not exists (select 1 from public.asm_assignments a join public.asm_assignment_trainers at on at.assignment_id = a.id join public.asm_attempts t on t.assignment_id = a.id
                     where at.staff_id = v_staff and t.student_id = v_student) then
   raise exception 'You are not the assessor of this student' using errcode = '42501';
  end if;
  select btrim(first_name || ' ' || last_name) into v_name from hr.staff_profiles where id = v_staff;
 else
  if not public.asm_is_admin() then raise exception 'Not authorised' using errcode = '42501'; end if;
  select name into v_name from public.cms_users where auth_user_id = auth.uid();
 end if;
 if not coalesce((d->>'signOff')::boolean, false) then raise exception 'Tick the sign-off declaration to record the outcome' using errcode = '22023'; end if;
 select coalesce(array_agg(ta.v::uuid), '{}') into v_ids from jsonb_array_elements_text(coalesce(d->'attemptIds', '[]')) as ta(v);
 if exists (select 1 from unnest(v_ids) i where not exists (select 1 from public.asm_attempts t where t.id = i and t.student_id = v_student)) then raise exception 'An attempt does not belong to the student' using errcode = '23503'; end if;
 select id into v_prev from public.asm_unit_outcomes o where o.student_id = v_student and o.unit_id = v_unit and not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = o.id) order by signed_at desc limit 1;
 select tenant_id into v_tenant from public.cms_course_units where id = v_unit;
 insert into public.asm_unit_outcomes(student_id, unit_id, assessment_id, batch_id, outcome, evidence_attempt_ids, signed_by, signed_staff_id, signed_role, signed_name, notes, supersedes_id)
 values (v_student, v_unit, public.asm_json_uuid(d, 'assessmentId'), v_batch, v_out, v_ids, auth.uid(), v_staff, p_role, coalesce(nullif(v_name, ''), 'Assessor'), coalesce(d->>'notes', ''), v_prev) returning id into v_id;
 perform public.asm_notify_student(v_student, 'outcome', 'Unit outcome recorded', 'The outcome for ' || (select code || ' ' || name from public.cms_course_units where id = v_unit) || ' is ' || case v_out when 'C' then 'Competent' else 'Not Yet Competent' end || '.', null, null, v_tenant);
 perform public.asm_log(p_role, 'unit_outcome_record', 'unit_outcome', v_id::text, jsonb_build_object('studentId', v_student, 'unitId', v_unit, 'outcome', v_out, 'supersedes', v_prev), v_tenant);
 return jsonb_build_object('ok', true, 'id', v_id);
end $$;
revoke all on function public.asm_record_unit_outcome(jsonb, text) from public, anon, authenticated;

-- Competency progress of one student: every unit of the courses of their batches, with the latest attempt and the current outcome.
create or replace function public.asm_student_progress(p_student uuid) returns jsonb
language sql stable security definer set search_path = public as $$
 select jsonb_build_object('studentId', p_student,
  'units', coalesce((select jsonb_agg(jsonb_build_object('unitId', u.id, 'unitCode', u.code, 'unitName', u.name, 'courseId', u.course_id,
    'outcome', (select o.outcome from public.asm_unit_outcomes o where o.student_id = p_student and o.unit_id = u.id and not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = o.id) order by o.signed_at desc limit 1),
    'outcomeAt', (select o.signed_at from public.asm_unit_outcomes o where o.student_id = p_student and o.unit_id = u.id and not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = o.id) order by o.signed_at desc limit 1),
    'assessments', coalesce((select jsonb_agg(jsonb_build_object('assessmentId', s.id, 'title', s.title, 'assignmentId', a.id, 'dueAt', public.asm_due_for(a.id, p_student),
       'latest', (select jsonb_build_object('id', t.id, 'attemptNo', t.attempt_no, 'state', t.state, 'outcome', t.outcome, 'submittedAt', t.submitted_at) from public.asm_attempts t
                  where t.assignment_id = a.id and t.student_id = p_student and t.state <> 'void' order by t.attempt_no desc limit 1)) order by a.due_at)
      from public.asm_assignments a join public.asm_assessments s on s.id = a.assessment_id where s.unit_id = u.id and a.status <> 'cancelled' and p_student in (select public.asm_assignment_eligible(a.id))), '[]')) order by u.course_id, u.sort)
   from (select distinct u.* from public.cms_course_units u join public.course_intakes i on i.course_id = u.course_id join public.batches b on b.intake_id = i.id
         join public.batch_enrolments e on e.batch_id = b.id and e.student_id = p_student and e.status in ('active', 'completed') where u.is_active) u), '[]'));
$$;
revoke all on function public.asm_student_progress(uuid) from public, anon, authenticated;

-- Report rows (the client turns them into CSV): cohort (per student per assessment of a batch), assessment (per batch), student (one student).
create or replace function public.asm_report(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare kind text := coalesce(d->>'kind', 'cohort'); v_batch uuid := public.asm_json_uuid(d, 'batchId'); v_as uuid := public.asm_json_uuid(d, 'assessmentId');
begin
 if kind = 'cohort' then
  if v_batch is null then raise exception 'batchId is required' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('studentId', s.id, 'student', s.full_name, 'email', s.email, 'assessmentId', x.id, 'assessment', x.title, 'unitCode', u.code,
    'dueAt', public.asm_due_for(a.id, s.id), 'attempts', (select count(*) from public.asm_attempts t where t.assignment_id = a.id and t.student_id = s.id and t.state <> 'void'),
    'state', (select t.state from public.asm_attempts t where t.assignment_id = a.id and t.student_id = s.id and t.state <> 'void' order by t.attempt_no desc limit 1),
    'outcome', (select t.outcome from public.asm_attempts t where t.assignment_id = a.id and t.student_id = s.id and t.state <> 'void' order by t.attempt_no desc limit 1),
    'submittedAt', (select t.submitted_at from public.asm_attempts t where t.assignment_id = a.id and t.student_id = s.id and t.state <> 'void' order by t.attempt_no desc limit 1),
    'unitOutcome', (select o.outcome from public.asm_unit_outcomes o where o.student_id = s.id and o.unit_id = x.unit_id and not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = o.id) order by o.signed_at desc limit 1)) order by s.full_name, x.title)
   from public.asm_assignments a join public.asm_assessments x on x.id = a.assessment_id left join public.cms_course_units u on u.id = x.unit_id
   cross join lateral public.asm_assignment_eligible(a.id) e join public.enrollment_students s on s.id = e
   where a.batch_id = v_batch and a.status <> 'cancelled' and (v_as is null or a.assessment_id = v_as)), '[]');
 elsif kind = 'assessment' then
  if v_as is null then raise exception 'assessmentId is required' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('assignmentId', a.id, 'batch', b.name, 'intake', public.course_intake_display(i), 'versionNo', v.version_no, 'dueAt', a.due_at, 'status', a.status,
    'eligible', (select count(*) from public.asm_assignment_eligible(a.id)),
    'submitted', (select count(distinct t.student_id) from public.asm_attempts t where t.assignment_id = a.id and t.state in ('submitted', 'marking', 'returned', 'final')),
    'satisfactory', (select count(distinct t.student_id) from public.asm_attempts t where t.assignment_id = a.id and t.state = 'final' and t.outcome = 'S'),
    'notYetSatisfactory', (select count(distinct t.student_id) from public.asm_attempts t where t.assignment_id = a.id and t.state = 'final' and t.outcome = 'NYS'),
    'reassessments', (select count(*) from public.asm_reassessments r join public.asm_attempts t on t.id = r.attempt_id where t.assignment_id = a.id and r.state = 'opened')) order by a.due_at desc)
   from public.asm_assignments a join public.batches b on b.id = a.batch_id join public.course_intakes i on i.id = b.intake_id join public.asm_versions v on v.id = a.version_id where a.assessment_id = v_as), '[]');
 elsif kind = 'student' then
  return public.asm_student_progress(public.asm_json_uuid(d, 'studentId'));
 end if;
 raise exception 'Unknown report %', kind using errcode = '22023';
end $$;
revoke all on function public.asm_report(jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------ TRAINER / ASSESSOR
create or replace function public.asm_trainer(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_staff uuid := public.asm_trainer_profile(); v_id uuid; v_att public.asm_attempts; v_a public.asm_assignments; v_as public.asm_assessments; v_ver public.asm_versions;
 x jsonb; n integer := 0; v_set jsonb; v_out text; v_due timestamptz; v_next uuid; v_rv integer; v_errs jsonb; v_path text; v_max integer;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if p_action = 'me' then
  return jsonb_build_object('staffId', v_staff, 'name', (select btrim(first_name || ' ' || last_name) from hr.staff_profiles where id = v_staff),
   'isTrainer', exists (select 1 from hr.staff_roles r where r.profile_id = v_staff and r.role = 'trainer' and r.revoked_at is null),
   'batches', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'intake', public.course_intake_display(i), 'courseName', public.course_label(c.code, c.name, c.variant_label)) order by i.start_date desc, b.name)
     from public.batch_trainers bt join public.batches b on b.id = bt.batch_id join public.course_intakes i on i.id = b.intake_id join public.cms_courses c on c.id = i.course_id where bt.staff_id = v_staff), '[]'));
 end if;
 if v_staff is null then raise exception 'Only active staff can assess' using errcode = '42501'; end if;

 if p_action = 'my_assignments' then
  return coalesce((select jsonb_agg(public.asm_assignment_json(a) || jsonb_build_object(
    'toMark', (select count(*) from public.asm_attempts t where t.assignment_id = a.id and t.state in ('submitted', 'marking')),
    'submitted', (select count(distinct t.student_id) from public.asm_attempts t where t.assignment_id = a.id and t.state <> 'draft' and t.state <> 'void'),
    'final', (select count(distinct t.student_id) from public.asm_attempts t where t.assignment_id = a.id and t.state = 'final')) order by a.due_at desc)
   from public.asm_assignments a where a.status <> 'cancelled' and public.asm_trainer_on_assignment(a.id, v_staff)
     and (public.asm_json_uuid(d, 'batchId') is null or a.batch_id = public.asm_json_uuid(d, 'batchId'))), '[]');
 elsif p_action = 'pending_marking' then
  return coalesce((select jsonb_agg(jsonb_build_object('attemptId', t.id, 'assignmentId', t.assignment_id, 'studentId', t.student_id, 'studentName', s.full_name, 'attemptNo', t.attempt_no, 'state', t.state,
    'submittedAt', t.submitted_at, 'receiptNo', t.receipt_no, 'assessmentTitle', x.title, 'unitCode', u.code, 'batchName', b.name, 'dueAt', t.due_at) order by t.submitted_at)
   from public.asm_attempts t join public.asm_assignments a on a.id = t.assignment_id join public.asm_assessments x on x.id = a.assessment_id left join public.cms_course_units u on u.id = x.unit_id
   join public.batches b on b.id = a.batch_id join public.enrollment_students s on s.id = t.student_id
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
  return public.asm_attempt_json(v_id, 'trainer') || jsonb_build_object('definition', v_ver.definition, 'assessmentTitle', v_as.title, 'unitId', v_as.unit_id,
   'studentName', (select full_name from public.enrollment_students where id = v_att.student_id),
   'settings', public.asm_effective_settings(v_as.id),
   'keys', coalesce((select jsonb_agg(jsonb_build_object('questionId', k.question_id, 'modelAnswer', k.model_answer, 'answerKey', k.answer_key, 'assessorGuidance', k.assessor_guidance, 'rubricLevels', k.rubric_levels)) from public.asm_question_keys k where k.version_id = v_ver.id), '[]'),
   'mappings', coalesce((select jsonb_agg(jsonb_build_object('questionId', m.question_id, 'criterionId', m.criterion_id, 'elementId', m.element_id, 'elementKind', e.kind, 'elementCode', e.code, 'elementText', e.text)) from public.asm_unit_mappings m join public.asm_unit_elements e on e.id = m.element_id where m.version_id = v_ver.id), '[]'));
 elsif p_action = 'mark_save' then
  -- results per question / criterion, task outcomes, assessor-filled responses (observation checklist, third-party report), overall feedback
  v_id := public.asm_json_uuid(d, 'id');
  if not public.asm_trainer_on_attempt(v_id) then raise exception 'Not your student' using errcode = '42501'; end if;
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
  perform public.asm_rollup(v_id);
  for x in select * from jsonb_array_elements(coalesce(d->'taskResults', '[]')) loop
   if public.asm_json_text(x, 'taskId') is null then continue; end if;
   insert into public.asm_task_results(attempt_id, task_id, outcome, feedback, signed_by, signed_at)
   values (v_id, x->>'taskId', nullif(upper(x->>'outcome'), ''), coalesce(x->>'feedback', ''), auth.uid(), now())
   on conflict (attempt_id, task_id) do update set outcome = excluded.outcome, feedback = excluded.feedback, signed_by = auth.uid(), signed_at = now();
  end loop;
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
  select * into v_att from public.asm_attempts where id = v_id for update;
  if v_att.state not in ('submitted', 'marking') then raise exception 'This attempt is not open for marking' using errcode = '42501'; end if;
  if d ? 'rowVersion' and (d->>'rowVersion')::integer <> v_att.row_version then raise exception 'This attempt was changed by someone else; reload before saving.' using errcode = '40001'; end if;
  select * into v_a from public.asm_assignments where id = v_att.assignment_id; select * into v_as from public.asm_assessments where id = v_a.assessment_id;
  select * into v_ver from public.asm_versions where id = v_att.version_id;
  v_errs := public.asm_validate_responses(v_ver.definition, v_att.assessor_responses, 'assessor');
  if jsonb_array_length(v_errs) > 0 then return jsonb_build_object('ok', false, 'errors', v_errs); end if;
  -- every assessable task needs a recorded outcome before the decision
  if exists (select 1 from (select distinct q.task_id from public.asm_definition_questions(v_ver.definition) q where q.marking_mode <> 'none') tk
             where not exists (select 1 from public.asm_task_results r where r.attempt_id = v_id and r.task_id = tk.task_id and r.outcome is not null)) then
   return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object('code', 'task_outcomes', 'message', 'Record Satisfactory / Not Yet Satisfactory for every task first.')));
  end if;
  v_set := public.asm_effective_settings(v_as.id); v_max := coalesce((v_set->>'max_attempts')::integer, 3);
  if v_out = 'S' then
   update public.asm_attempts set state = 'final', outcome = 'S', overall_feedback = coalesce(d->>'overallFeedback', overall_feedback), marked_by = auth.uid(), returned_at = now(), finalised_at = now() where id = v_id;
   perform public.asm_notify_student(v_att.student_id, 'marked', 'Assessment marked: Satisfactory', v_as.title || ' has been marked Satisfactory. Open My Assessments to read the feedback.', v_id, v_a.id, v_att.tenant_id);
  elsif v_att.attempt_no < v_max and v_a.status = 'open' then
   v_due := coalesce(public.asm_json_ts(d, 'dueAt'), now() + make_interval(days => coalesce((v_set->>'reassessment_days')::integer, 5)));
   update public.asm_attempts set state = 'returned', outcome = 'NYS', overall_feedback = coalesce(d->>'overallFeedback', overall_feedback), marked_by = auth.uid(), returned_at = now() where id = v_id;
   v_next := public.asm_open_attempt(v_a.id, v_att.student_id, v_att.attempt_no + 1, v_due, v_id);
   insert into public.asm_reassessments(attempt_id, student_id, requested_role, reason, state, new_due_at, next_attempt_id, decided_by, decided_at)
   values (v_id, v_att.student_id, 'trainer', coalesce(d->>'overallFeedback', 'Not yet satisfactory'), 'opened', v_due, v_next, auth.uid(), now());
   perform public.asm_notify_student(v_att.student_id, 'reassessment', 'Reassessment required: ' || v_as.title, 'Attempt ' || v_att.attempt_no || ' was Not Yet Satisfactory. Attempt ' || (v_att.attempt_no + 1) || ' is open until ' || to_char(v_due at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.', v_next, v_a.id, v_att.tenant_id);
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
  if v_path is null or split_part(v_path, '/', 1) <> v_id::text or split_part(v_path, '/', 2) <> 'assessor' then raise exception 'The file must be under <attempt>/assessor/' using errcode = '22023'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'assessment-evidence' and o.name = v_path) then raise exception 'Upload the file first' using errcode = 'P0002'; end if;
  insert into public.asm_evidence_files(attempt_id, question_id, by_assessor, object_path, file_name, mime, bytes, sha256)
  values (v_id, coalesce(public.asm_json_text(d, 'questionId'), 'assessor'), true, v_path, coalesce(public.asm_json_text(d, 'fileName'), split_part(v_path, '/', 3)), coalesce(d->>'mime', 'application/octet-stream'), coalesce((d->>'bytes')::integer, 0), public.asm_json_text(d, 'sha256'))
  on conflict (attempt_id, object_path) do nothing;
  return jsonb_build_object('ok', true);
 elsif p_action = 'unit_outcome_record' then
  return public.asm_record_unit_outcome(d, 'trainer');
 elsif p_action = 'student_progress' then
  v_id := public.asm_json_uuid(d, 'studentId');
  if not exists (select 1 from public.batch_enrolments e join public.batch_trainers bt on bt.batch_id = e.batch_id where e.student_id = v_id and bt.staff_id = v_staff) then raise exception 'Not your student' using errcode = '42501'; end if;
  return public.asm_student_progress(v_id);
 elsif p_action = 'my_students' then
  return coalesce((select jsonb_agg(jsonb_build_object('studentId', s.id, 'name', s.full_name, 'email', s.email, 'batchId', b.id, 'batchName', b.name, 'courseName', public.course_label(c.code, c.name, c.variant_label)) order by b.name, s.full_name)
   from public.batch_trainers bt join public.batches b on b.id = bt.batch_id join public.course_intakes i on i.id = b.intake_id join public.cms_courses c on c.id = i.course_id
   join public.batch_enrolments e on e.batch_id = b.id and e.status = 'active' join public.enrollment_students s on s.id = e.student_id where bt.staff_id = v_staff), '[]');
 elsif p_action = 'unit_elements' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'parentId', e.parent_id, 'code', e.code, 'text', e.text, 'sort', e.sort) order by e.kind, e.sort, e.code)
    from public.asm_unit_elements e where e.unit_id = d->>'unitId' and e.is_active), '[]');
 elsif p_action = 'notifications' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'event', x.event, 'title', x.title, 'body', x.body, 'attemptId', x.attempt_id, 'assignmentId', x.assignment_id, 'readAt', x.read_at, 'createdAt', x.created_at) order by x.created_at desc)
   from (select * from public.asm_notifications where recipient_auth_user = auth.uid() order by created_at desc limit 50) x), '[]');
 elsif p_action = 'notification_read' then
  update public.asm_notifications set read_at = coalesce(read_at, now()) where recipient_auth_user = auth.uid() and (public.asm_json_uuid(d, 'id') is null or id = public.asm_json_uuid(d, 'id'));
  return jsonb_build_object('ok', true);
 end if;
 raise exception 'Unknown action %', p_action using errcode = '22023';
end $$;
revoke all on function public.asm_trainer(text, jsonb) from public, anon;
grant execute on function public.asm_trainer(text, jsonb) to authenticated;

-- ------------------------------------------------------------------ STUDENT
create or replace function public.asm_student(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_student uuid := public.asm_student_id(); v_id uuid; v_att public.asm_attempts; v_a public.asm_assignments; v_as public.asm_assessments; v_ver public.asm_versions;
 v_set jsonb; v_errs jsonb; v_resp jsonb; v_hash text; v_receipt text; v_decl jsonb; v_path text; v_due timestamptz; v_now timestamptz := now(); v_sig text;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if p_action = 'me' then return jsonb_build_object('studentId', v_student); end if;
 if v_student is null then raise exception 'Only a signed-in student can do this' using errcode = '42501'; end if;

 if p_action = 'my_assessments' then
  return coalesce((select jsonb_agg(jsonb_build_object('assignmentId', a.id, 'assessmentId', s.id, 'title', s.title, 'code', s.code, 'description', s.description, 'unitCode', u.code, 'unitName', u.name,
    'courseName', public.course_label(c.code, c.name, c.variant_label), 'batchName', b.name, 'availableFrom', a.available_from, 'dueAt', public.asm_due_for(a.id, v_student), 'lateUntil', a.late_until, 'status', a.status,
    'maxAttempts', (public.asm_effective_settings(s.id)->>'max_attempts')::integer,
    'attempts', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'attemptNo', t.attempt_no, 'state', t.state, 'outcome', case when t.state in ('returned', 'final') then t.outcome end, 'submittedAt', t.submitted_at, 'dueAt', t.due_at, 'receiptNo', t.receipt_no) order by t.attempt_no)
       from public.asm_attempts t where t.assignment_id = a.id and t.student_id = v_student and t.state <> 'void'), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'title', e.title, 'startsAt', e.starts_at, 'endsAt', e.ends_at, 'room', r.name) order by e.starts_at) from public.asm_schedule_events e left join public.classrooms r on r.id = e.room_id where e.assignment_id = a.id and e.kind <> 'due'), '[]')) order by a.due_at)
   from public.asm_assignments a join public.asm_assessments s on s.id = a.assessment_id left join public.cms_course_units u on u.id = s.unit_id join public.batches b on b.id = a.batch_id
   join public.course_intakes i on i.id = b.intake_id join public.cms_courses c on c.id = i.course_id
   where a.status <> 'cancelled' and v_student in (select public.asm_assignment_eligible(a.id))), '[]');
 elsif p_action = 'assessment_open' then
  -- the student's current attempt (attempt 1 is created on first open); the view never contains assessor keys (D-05)
  v_id := public.asm_json_uuid(d, 'assignmentId');
  select * into v_a from public.asm_assignments where id = v_id;
  if v_a.id is null or v_a.status = 'cancelled' or v_student not in (select public.asm_assignment_eligible(v_id)) then raise exception 'This assessment is not assigned to you' using errcode = '42501'; end if;
  if v_now < v_a.available_from then raise exception 'This assessment opens on %', to_char(v_a.available_from at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') using errcode = '42501'; end if;
  select * into v_as from public.asm_assessments where id = v_a.assessment_id; select * into v_ver from public.asm_versions where id = v_a.version_id;
  select * into v_att from public.asm_attempts where assignment_id = v_id and student_id = v_student and state <> 'void' order by attempt_no desc limit 1;
  if v_att.id is null then
   if v_a.status <> 'open' then raise exception 'This assessment is closed' using errcode = '42501'; end if;
   v_att.id := public.asm_open_attempt(v_id, v_student, 1, public.asm_due_for(v_id, v_student));
   perform public.asm_log('student', 'attempt_open', 'attempt', v_att.id::text, jsonb_build_object('assignmentId', v_id), v_a.tenant_id);
  end if;
  v_set := public.asm_effective_settings(v_as.id);
  return jsonb_build_object('assignment', jsonb_build_object('id', v_a.id, 'title', v_as.title, 'description', v_as.description, 'dueAt', public.asm_due_for(v_id, v_student), 'lateUntil', v_a.late_until, 'status', v_a.status,
    'unitCode', (select code from public.cms_course_units where id = v_as.unit_id), 'unitName', (select name from public.cms_course_units where id = v_as.unit_id)),
   'version', jsonb_build_object('id', v_ver.id, 'versionNo', v_ver.version_no, 'definition', v_ver.definition),
   'settings', jsonb_build_object('declarationText', v_set->>'declaration_text', 'instructions', v_set->>'instructions', 'maxAttempts', (v_set->>'max_attempts')::integer,
     'lateSubmission', v_set->>'late_submission', 'evidenceMaxMb', (v_set->>'evidence_max_mb')::integer, 'evidenceAllowedTypes', v_set->'evidence_allowed_types'),
   'attempt', public.asm_attempt_json(v_att.id, 'student'),
   'history', coalesce((select jsonb_agg(public.asm_attempt_json(t.id, 'student') order by t.attempt_no) from public.asm_attempts t where t.assignment_id = v_id and t.student_id = v_student and t.state <> 'void' and t.id <> v_att.id), '[]'));
 elsif p_action = 'draft_save' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student for update;
  if v_att.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  if v_att.state <> 'draft' then raise exception 'This attempt has been submitted and is locked' using errcode = '42501'; end if;
  if d ? 'rowVersion' and (d->>'rowVersion')::integer <> v_att.row_version then raise exception 'This draft was saved from another window; reload before saving.' using errcode = '40001'; end if;
  v_resp := d->'responses';
  if v_resp is null or jsonb_typeof(v_resp) <> 'object' then raise exception 'responses must be an object' using errcode = '22023'; end if;
  update public.asm_attempts set responses = v_resp where id = v_id returning row_version into v_att.row_version;
  return jsonb_build_object('ok', true, 'rowVersion', v_att.row_version, 'savedAt', now());
 elsif p_action = 'evidence_register' then
  v_id := public.asm_json_uuid(d, 'attemptId'); v_path := public.asm_json_text(d, 'path');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student;
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
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student for update;
  if v_att.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  if v_att.state <> 'draft' then raise exception 'This attempt has already been submitted' using errcode = '42501'; end if;
  if d ? 'rowVersion' and (d->>'rowVersion')::integer <> v_att.row_version then raise exception 'This draft was saved from another window; reload before submitting.' using errcode = '40001'; end if;
  select * into v_a from public.asm_assignments where id = v_att.assignment_id; select * into v_as from public.asm_assessments where id = v_a.assessment_id; select * into v_ver from public.asm_versions where id = v_att.version_id;
  if v_a.status <> 'open' then raise exception 'This assessment is closed' using errcode = '42501'; end if;
  v_set := public.asm_effective_settings(v_as.id);
  v_due := coalesce(v_att.due_at, public.asm_due_for(v_a.id, v_student));
  if v_now > v_due and (v_set->>'late_submission') = 'block' and (v_a.late_until is null or v_now > v_a.late_until) then
   return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object('code', 'late', 'message', 'The due date has passed and late submissions are not accepted. Ask your trainer for an extension.')));
  end if;
  if jsonb_typeof(d->'responses') = 'object' then update public.asm_attempts set responses = d->'responses' where id = v_id; v_att.responses := d->'responses'; end if;
  v_errs := public.asm_validate_responses(v_ver.definition, v_att.responses, 'student');
  if jsonb_array_length(v_errs) > 0 then return jsonb_build_object('ok', false, 'errors', v_errs); end if;
  v_sig := public.asm_json_text(d->'declaration', 'signature');
  if v_sig is null or char_length(v_sig) < 2 or not coalesce((d->'declaration'->>'agreed')::boolean, false) then
   return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object('code', 'declaration', 'message', 'Type your full name and tick the declaration to submit.')));
  end if;
  v_hash := encode(sha256(convert_to(v_att.responses::text, 'UTF8')), 'hex');
  v_receipt := 'ASM-' || to_char(v_now at time zone 'Australia/Melbourne', 'YYYY') || '-' || lpad(nextval('public.asm_receipt_seq')::text, 6, '0');
  v_decl := jsonb_build_object('signature', left(v_sig, 200), 'agreed', true, 'text', v_set->>'declaration_text', 'textSha256', encode(sha256(convert_to(coalesce(v_set->>'declaration_text', ''), 'UTF8')), 'hex'),
    'responsesSha256', v_hash, 'signedAt', v_now, 'late', v_now > v_due);
  update public.asm_attempts set state = 'submitted', submitted_at = v_now, responses_hash = v_hash, declaration = v_decl, receipt_no = v_receipt where id = v_id;
  perform public.asm_autocheck(v_id); perform public.asm_rollup(v_id);
  perform public.asm_notify_trainers(v_a.id, 'submitted', 'Submission received: ' || v_as.title, (select full_name from public.enrollment_students where id = v_student) || ' submitted attempt ' || v_att.attempt_no || ' (receipt ' || v_receipt || ').', v_id);
  perform public.asm_notify_student(v_student, 'submitted', 'Submission receipt ' || v_receipt, v_as.title || ' was submitted on ' || to_char(v_now at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '. Keep this receipt number.', v_id, v_a.id, v_att.tenant_id);
  perform public.asm_log('student', 'submit', 'attempt', v_id::text, jsonb_build_object('receiptNo', v_receipt, 'responsesSha256', v_hash, 'late', v_now > v_due), v_att.tenant_id);
  return jsonb_build_object('ok', true, 'receiptNo', v_receipt, 'submittedAt', v_now, 'responsesSha256', v_hash);
 elsif p_action = 'results' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  if not exists (select 1 from public.asm_attempts where id = v_id and student_id = v_student) then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  return public.asm_attempt_json(v_id, 'student');
 elsif p_action = 'reassessment_request' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student;
  if v_att.id is null or v_att.state <> 'final' or v_att.outcome <> 'NYS' then raise exception 'A reassessment can be requested for a finalised Not Yet Satisfactory attempt' using errcode = '42501'; end if;
  if exists (select 1 from public.asm_reassessments where attempt_id = v_id and state = 'requested') then raise exception 'A request is already waiting' using errcode = '23505'; end if;
  insert into public.asm_reassessments(attempt_id, student_id, requested_role, reason) values (v_id, v_student, 'student', coalesce(public.asm_json_text(d, 'reason'), '')) returning id into v_id;
  perform public.asm_notify_trainers(v_att.assignment_id, 'reassessment', 'Reassessment requested', (select full_name from public.enrollment_students where id = v_student) || ' asked for a reassessment.', v_att.id);
  perform public.asm_log('student', 'reassessment_request', 'reassessment', v_id::text, jsonb_build_object('attemptId', v_att.id), v_att.tenant_id);
  return jsonb_build_object('ok', true, 'id', v_id);
 elsif p_action = 'feedback_post' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student;
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
end $$;
revoke all on function public.asm_student(text, jsonb) from public, anon;
grant execute on function public.asm_student(text, jsonb) to authenticated;

-- ------------------------------------------------------------------ CALENDAR (D-10): assessment events merged with the batch's weekly classes
create or replace function public.asm_calendar(p_from date, p_to date, p_batch uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_student uuid := public.asm_student_id(); v_staff uuid := public.asm_trainer_profile(); v_admin boolean := public.asm_is_admin(); v_batches uuid[]; v_assignments uuid[];
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 370 then raise exception 'Choose a range of up to a year' using errcode = '22023'; end if;
 if v_admin and p_batch is not null then
  v_batches := array[p_batch];
  select coalesce(array_agg(id), '{}') into v_assignments from public.asm_assignments where batch_id = p_batch and status <> 'cancelled';
 elsif v_admin then
  v_batches := '{}';
  select coalesce(array_agg(id), '{}') into v_assignments from public.asm_assignments where status <> 'cancelled';
 elsif v_staff is not null and (v_student is null or coalesce(p_batch::text, '') <> 'student') then
  select coalesce(array_agg(batch_id), '{}') into v_batches from public.batch_trainers where staff_id = v_staff;
  select coalesce(array_agg(id), '{}') into v_assignments from public.asm_assignments a where status <> 'cancelled' and public.asm_trainer_on_assignment(a.id, v_staff);
 elsif v_student is not null then
  select coalesce(array_agg(batch_id), '{}') into v_batches from public.batch_enrolments where student_id = v_student and status = 'active';
  select coalesce(array_agg(a.id), '{}') into v_assignments from public.asm_assignments a where a.status <> 'cancelled' and a.batch_id = any(v_batches) and v_student in (select public.asm_assignment_eligible(a.id));
 else
  return '[]'::jsonb;
 end if;
 return coalesce((select jsonb_agg(e order by e->>'startsAt') from (
  -- assessment events (the student's own due date where overridden)
  select jsonb_build_object('kind', case when e.kind = 'due' then 'assessment_due' else 'assessment_' || e.kind end, 'title', e.title, 'assignmentId', e.assignment_id, 'assessmentTitle', s.title, 'batchName', b.name,
    'startsAt', case when e.kind = 'due' and v_student is not null and not v_admin and v_staff is null then public.asm_due_for(e.assignment_id, v_student) else e.starts_at end, 'endsAt', e.ends_at,
    'room', r.name, 'trainer', case when p.id is null then null else btrim(p.first_name || ' ' || p.last_name) end, 'notes', e.notes) as e
  from public.asm_schedule_events e join public.asm_assignments a on a.id = e.assignment_id join public.asm_assessments s on s.id = a.assessment_id join public.batches b on b.id = a.batch_id
  left join public.classrooms r on r.id = e.room_id left join hr.staff_profiles p on p.id = e.trainer_staff_id
  where e.assignment_id = any(v_assignments) and (e.starts_at at time zone 'Australia/Melbourne')::date between p_from and p_to
  union all
  -- weekly classes of the batches in scope, on the days the batch runs
  select jsonb_build_object('kind', 'class', 'title', b.name || ' · ' || initcap(bs.session_type), 'batchId', b.id, 'batchName', b.name, 'sessionType', bs.session_type,
    'startsAt', (day.d + bs.start_time) at time zone 'Australia/Melbourne', 'endsAt', (day.d + bs.end_time) at time zone 'Australia/Melbourne', 'room', r.name)
  from public.batches b join public.batch_sessions bs on bs.batch_id = b.id left join public.classrooms r on r.id = bs.room_id
  cross join lateral (select d::date from generate_series(greatest(p_from, lower(public.rto_batch_span(b.id))), least(p_to, upper(public.rto_batch_span(b.id)) - 1), interval '1 day') d) day
  where b.id = any(v_batches) and b.is_active and extract(isodow from day.d) = bs.weekday and public.rto_is_working_day(day.d)
 ) x), '[]'::jsonb);
end $$;
revoke all on function public.asm_calendar(date, date, uuid) from public, anon;
grant execute on function public.asm_calendar(date, date, uuid) to authenticated;

-- ------------------------------------------------------------------ batch membership changes (brief 7, step 9)
-- follow_batch: a student who leaves the batch loses open drafts (voided, kept for history) and a student who joins is told about open work;
-- keep: nothing changes for existing attempts, new students are eligible from now on.
create or replace function public.asm_batch_enrolment_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare a record; v_student uuid := coalesce(new.student_id, old.student_id);
begin
 if tg_op in ('UPDATE', 'DELETE') and (tg_op = 'DELETE' or old.status = 'active' and (new.status <> 'active' or new.batch_id <> old.batch_id)) then
  for a in select x.* , s.title from public.asm_assignments x join public.asm_assessments s on s.id = x.assessment_id where x.batch_id = old.batch_id and x.status = 'open' and x.reassign_rule = 'follow_batch' loop
   update public.asm_attempts set state = 'void', voided_at = now(), void_reason = 'left the batch' where assignment_id = a.id and student_id = v_student and state = 'draft';
   perform public.asm_log('system', 'reassign_leave', 'assignment', a.id::text, jsonb_build_object('studentId', v_student, 'batchId', old.batch_id), a.tenant_id);
  end loop;
 end if;
 if tg_op in ('INSERT', 'UPDATE') and new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active' or new.batch_id <> old.batch_id) then
  for a in select x.*, s.title from public.asm_assignments x join public.asm_assessments s on s.id = x.assessment_id where x.batch_id = new.batch_id and x.status = 'open' loop
   perform public.asm_notify_student(v_student, 'reassigned', 'Assessment available: ' || a.title, 'You joined ' || (select name from public.batches where id = new.batch_id) || '. ' || a.title || ' is due ' || to_char(public.asm_due_for(a.id, v_student) at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.', null, a.id, a.tenant_id);
   perform public.asm_log('system', 'reassign_join', 'assignment', a.id::text, jsonb_build_object('studentId', v_student, 'batchId', new.batch_id), a.tenant_id);
  end loop;
 end if;
 return coalesce(new, old);
end $$;
revoke all on function public.asm_batch_enrolment_change() from public, anon, authenticated;
drop trigger if exists asm_batch_enrolment_change on public.batch_enrolments;
create trigger asm_batch_enrolment_change after insert or update of status, batch_id or delete on public.batch_enrolments for each row execute function public.asm_batch_enrolment_change();

-- ------------------------------------------------------------------ due-soon / overdue sweep (one notification per student per assignment per kind)
create or replace function public.asm_due_sweep() returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0; v_days integer;
begin
 for r in select a.id as assignment_id, a.tenant_id, s.title, e as student_id, public.asm_due_for(a.id, e) as due_at, c.auth_user
   from public.asm_assignments a join public.asm_assessments s on s.id = a.assessment_id cross join lateral public.asm_assignment_eligible(a.id) e
   cross join lateral public.asm_student_contact(e) c
   where a.status = 'open' and not exists (select 1 from public.asm_attempts t where t.assignment_id = a.id and t.student_id = e and t.state not in ('draft', 'void')) loop
  v_days := coalesce((public.asm_effective_settings((select assessment_id from public.asm_assignments where id = r.assignment_id))->>'due_soon_days')::integer, 3);
  if r.due_at < now() and not exists (select 1 from public.asm_notifications x where x.assignment_id = r.assignment_id and x.recipient_auth_user = r.auth_user and x.event = 'overdue') then
   perform public.asm_notify_student(r.student_id, 'overdue', 'Overdue: ' || r.title, 'The due date ' || to_char(r.due_at at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || ' has passed. Submit as soon as you can or contact your trainer.', null, r.assignment_id, r.tenant_id);
   n := n + 1;
  elsif r.due_at >= now() and r.due_at < now() + make_interval(days => v_days) and not exists (select 1 from public.asm_notifications x where x.assignment_id = r.assignment_id and x.recipient_auth_user = r.auth_user and x.event = 'due_soon') then
   perform public.asm_notify_student(r.student_id, 'due_soon', 'Due soon: ' || r.title, 'Due ' || to_char(r.due_at at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.', null, r.assignment_id, r.tenant_id);
   n := n + 1;
  end if;
 end loop;
 return n;
end $$;
revoke all on function public.asm_due_sweep() from public, anon, authenticated;
-- Daily at 21:00 UTC (07:00 Melbourne in summer); pg_cron is present on hosted and in the lab.
do $$
begin
 if exists (select 1 from pg_extension where extname = 'pg_cron') then
  perform cron.unschedule(jobid) from cron.job where jobname = 'asm-due-sweep';
  perform cron.schedule('asm-due-sweep', '0 21 * * *', 'select public.asm_due_sweep();');
 end if;
end $$;
