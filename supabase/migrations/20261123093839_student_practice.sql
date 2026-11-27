begin;

-- Only the two student and worker RPCs below can read or change practice records.
create table public.lms_practice_requests (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.enrollment_students(id) on delete cascade,
  unit_id text not null references public.cms_course_units(id) on delete cascade,
  assignment_id uuid references public.asm_assignments(id) on delete cascade,
  difficulty text not null check (difficulty in ('easy','medium','advanced')),
  focus text,
  source_key text not null,
  source_version text not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index lms_practice_request_student on public.lms_practice_requests(student_id, created_at desc);
create table public.lms_practice_questions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.lms_practice_requests(id) on delete cascade,
  student_id uuid not null references public.enrollment_students(id) on delete cascade,
  unit_id text not null references public.cms_course_units(id) on delete cascade,
  prompt text not null check (length(prompt) between 1 and 700),
  prompt_key text not null,
  choices jsonb not null check (jsonb_typeof(choices)='array' and jsonb_array_length(choices)=4),
  correct smallint not null check (correct between 0 and 3),
  explanation text not null check (length(explanation) between 1 and 1000),
  topic text not null check (length(topic) between 1 and 90),
  evidence text not null check (length(evidence) between 1 and 420),
  created_at timestamptz not null default now(),
  served_at timestamptz,
  answered_at timestamptz,
  selected smallint check (selected between 0 and 3),
  saved boolean not null default false,
  unique(student_id,unit_id,prompt_key)
);
create index lms_practice_question_student_unit on public.lms_practice_questions(student_id,unit_id);
alter table public.lms_practice_requests enable row level security;
alter table public.lms_practice_questions enable row level security;
revoke all on public.lms_practice_requests, public.lms_practice_questions from public, anon, authenticated, service_role;

do $$
declare item record; registration jsonb; rule_id uuid; version_id uuid; category_id uuid; definition jsonb;
  today date := (statement_timestamp() at time zone 'Australia/Melbourne')::date;
begin
  insert into public.business_rule_categories(scope_key,name) values ('','Student Practice') on conflict do nothing;
  select c.id into strict category_id from public.business_rule_categories c where c.scope_key='' and c.name='Student Practice';
  for item in select * from (values
    ('lms.practice_enabled','Enable AI student practice','boolean','true','{}'),
    ('lms.practice_daily_batches','Daily AI question batches per student (0 for unlimited)','number','0','{"min":0,"max":100}'),
    ('lms.practice_level_evidence','Answered questions needed to demonstrate a difficulty level','number','10','{"min":1,"max":100}'),
    ('lms.practice_level_accuracy','Accuracy needed to demonstrate a difficulty level (%)','number','75','{"min":1,"max":100}')
  ) as settings(key,label,kind,initial,limits)
  loop
    registration := jsonb_build_object('scope','lms/courses','entity','student_practice','value_type',item.kind,'schema_version',1,'handler','setting') || item.limits::jsonb;
    rule_id := public.business_rule_register('',item.key,registration);
    definition := jsonb_build_object('identifier',item.key,'name',item.label,'category_id',category_id,
      'scope','lms/courses','entity','student_practice','value_type',item.kind,'value',item.initial::jsonb,'description',item.label,
      'options','[]'::jsonb,'groups','[]'::jsonb,'match','all','then_action','use_value','else_action','none','priority',0,
      'starts_on',today,'ends_on','','enabled',true,'approval_required',false,'source_url','','notes','SLIT must publish before first use.');
    perform public.business_rule_validate(definition,registration);
    insert into public.business_rule_versions(rule_id,version,state,origin,definition,starts_on)
      values (rule_id,1,'draft','migration',definition,today) returning id into version_id;
    perform public.business_rule_index_version(version_id,definition);
    insert into public.business_rule_audit_logs(scope_key,rule_id,action,reason,after_data)
      values ('',rule_id,'migration','Initial student practice settings for SLIT approval.',definition);
  end loop;
end $$;

create function public.lms_practice_rule(p_tenant uuid,p_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(public.business_rule_evaluate(coalesce(p_tenant::text,''),p_key,'{}'),'null'),
    nullif(public.business_rule_evaluate('',p_key,'{}'),'null'));
$$;

create function public.lms_practice_settings(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('enabled',public.lms_practice_rule(p_tenant,'lms.practice_enabled'),
    'batches',public.lms_practice_rule(p_tenant,'lms.practice_daily_batches'),
    'evidence',public.lms_practice_rule(p_tenant,'lms.practice_level_evidence'),
    'accuracy',public.lms_practice_rule(p_tenant,'lms.practice_level_accuracy'));
$$;

-- Only learner-visible materials. Formal assessments and their marking data are never supplied to the model.
create function public.lms_practice_sources(p_unit text) returns table (
  key text, version text, title text, bucket text, path text, filename text, bytes integer, body text
) language sql stable security definer set search_path = '' as $$
  select 'bulk:'||r.id, r.published_at::text, r.title, 'lms-bulk-resources', f.object_path, f.name, f.bytes, null::text
  from public.lms_unit_resources r join public.lms_resource_import_files f on f.id=r.file_id
  where r.unit_id=p_unit and r.published_at is not null and r.audience='student_staff'
    and r.category in ('learning','self_assessment') and not r.security_hold and r.assessment_id is null
    and f.extension in ('pdf','docx','pptx','txt','png','jpg','jpeg','webp') and f.bytes<=8388608
  union all
  select 'unit:'||x.id,x.updated_at::text,x.title,'unit-content',x.storage_path,x.file_name,x.size_bytes,
    case when x.kind='text' then left(x.body,16000) end
  from public.unit_contents x join public.cms_course_units u on u.id=x.unit_id
  where x.unit_id=p_unit and x.visible_to_students and (
    (x.kind='text' and nullif(btrim(x.body),'') is not null)
    or (x.kind='file' and x.storage_path is not null and x.size_bytes<=8388608
      and lower(x.file_name) ~ '\.(pdf|docx|pptx|txt|png|jpe?g|webp)$')
  ) and not exists (
    select 1 from unnest(array['Assessments','Assessor Resources',
      public.lms_practice_rule(u.tenant_id,'lms.bulk_assessment_label') #>> '{}',
      public.lms_practice_rule(u.tenant_id,'lms.bulk_assessor_label') #>> '{}']) as label
    where label is not null and starts_with(lower(btrim(x.title)),lower(btrim(label))||':')
  );
$$;

create function public.lms_practice_question_view(q public.lms_practice_questions) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',q.id,'prompt',q.prompt,'choices',q.choices,'topic',q.topic,'saved',q.saved,
    'feedback',case when q.answered_at is not null then jsonb_build_object('selected',q.selected,'correct',q.correct,
    'explanation',q.explanation,'evidence',q.evidence) end);
$$;

create function public.student_practice(p_action text,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare student uuid := public.portal_student_id(); target text := nullif(p_data->>'unitId','');
  assignment uuid := nullif(p_data->>'assignmentId','')::uuid; assignment_title text;
  wanted_difficulty text := p_data->>'difficulty'; wanted_focus text := nullif(btrim(p_data->>'focus'),'');
  tenant uuid; settings jsonb; question public.lms_practice_questions; source record; request_id uuid;
  answer_index smallint; evidence_min integer; accuracy_min numeric; day_start timestamptz;
  stats jsonb; level text;
begin
  if auth.uid() is null or student is null then raise exception 'Sign in as a student to practise.' using errcode='42501'; end if;
  if p_action='catalogue' then
    return jsonb_build_object(
      'units',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'code',u.code,'name',u.name,
        'enabled',public.lms_practice_settings(u.tenant_id) @> '{"enabled":true}'
          and not jsonb_path_exists(public.lms_practice_settings(u.tenant_id),'$.* ? (@ == null)'),
        'hasMaterials',exists(select 1 from public.lms_practice_sources(u.id))) order by u.code,u.name)
        from public.cms_course_units u where u.id in (select public.student_enrolled_unit_ids(student))
          and public.tenant_scope(u.tenant_id)),'[]'),
      'assessments',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'title',s.title,'unitId',s.unit_id) order by a.due_at)
        from public.asm_assignments a join public.asm_assessments s on s.id=a.assessment_id
        join public.cms_course_units u on u.id=s.unit_id
        where a.status<>'cancelled' and public.tenant_scope(a.tenant_id) and public.tenant_scope(u.tenant_id)
          and s.unit_id in (select public.student_enrolled_unit_ids(student))
          and student in (select public.asm_assignment_eligible(a.id))),'[]'));
  end if;
  if assignment is not null then
    select s.unit_id,s.title into target,assignment_title
    from public.asm_assignments a join public.asm_assessments s on s.id=a.assessment_id
    where a.id=assignment and a.status<>'cancelled' and public.tenant_scope(a.tenant_id)
      and student in (select public.asm_assignment_eligible(a.id));
    if not found then raise exception 'This assessment is not assigned to you.' using errcode='42501'; end if;
  end if;
  select u.tenant_id into tenant from public.cms_course_units u
  where u.id=target and u.id in (select public.student_enrolled_unit_ids(student)) and public.tenant_scope(u.tenant_id);
  if not found then raise exception 'Choose an enrolled unit to practise.' using errcode='42501'; end if;

  settings:=public.lms_practice_settings(tenant);
  if not coalesce((settings->>'enabled')::boolean,false)
    or settings->>'batches' is null or settings->>'evidence' is null or settings->>'accuracy' is null then
    raise exception 'Practice has not been enabled for this unit. Contact your trainer.' using errcode='22023';
  end if;

  if p_action='progress' then
    evidence_min:=floor((settings->>'evidence')::numeric)::integer;
    accuracy_min:=(settings->>'accuracy')::numeric;
    with answered as (
      select q.topic,q.selected=q.correct as correct,r.difficulty
      from public.lms_practice_questions q join public.lms_practice_requests r on r.id=q.request_id
      where q.student_id=student and q.unit_id=target and q.answered_at is not null
    ), topics as (
      select topic,count(*) as total,round(100.0*avg(correct::int)) as accuracy from answered group by topic
    )
    select jsonb_build_object('answered',count(*),'accuracy',round(100.0*avg(correct::int)),
      'topics',coalesce((select jsonb_agg(to_jsonb(t) order by t.total desc,t.topic) from (select * from topics order by total desc,topic limit 12) t),'[]'))
    into stats from answered;
    select case
      when (stats->>'answered')::integer=0 then 'Getting started'
      when q.advanced then 'Expert' when q.medium then 'Advanced' when q.easy then 'Intermediate'
      else 'Beginner' end
    into level
    from (
      select
        coalesce(bool_or(difficulty='advanced' and total>=evidence_min and accuracy>=accuracy_min),false) as advanced,
        coalesce(bool_or(difficulty='medium' and total>=evidence_min and accuracy>=accuracy_min),false) as medium,
        coalesce(bool_or(difficulty='easy' and total>=evidence_min and accuracy>=accuracy_min),false) as easy
      from (
        select r.difficulty,count(*) as total,100.0*avg((q.selected=q.correct)::int) as accuracy
        from public.lms_practice_questions q join public.lms_practice_requests r on r.id=q.request_id
        where q.student_id=student and q.unit_id=target and q.answered_at is not null group by r.difficulty
      ) by_difficulty
    ) q;
    return stats || jsonb_build_object('level',level,'saved',coalesce((
      select jsonb_agg(jsonb_build_object('id',bookmarked.id,'prompt',bookmarked.prompt) order by bookmarked.created_at desc)
      from (select q.id,q.prompt,q.created_at from public.lms_practice_questions q
        join public.lms_practice_requests r on r.id=q.request_id
        join public.lms_practice_sources(target) s on s.key=r.source_key and s.version=r.source_version
        where q.student_id=student and q.unit_id=target and q.saved and r.assignment_id is not distinct from assignment
        order by q.created_at desc limit 30) bookmarked
    ),'[]'));
  end if;

  if p_action in ('answer','bookmark','recall') then
    select q.* into question from public.lms_practice_questions q
      join public.lms_practice_requests r on r.id=q.request_id
      join public.lms_practice_sources(target) s on s.key=r.source_key and s.version=r.source_version
    where q.id=(p_data->>'questionId')::uuid and q.student_id=student and q.unit_id=target
      and q.served_at is not null and r.assignment_id is not distinct from assignment for update of q;
    if not found then raise exception 'This question is no longer available.' using errcode='42501'; end if;
    if p_action='answer' and question.answered_at is null then
      answer_index:=(p_data->>'selected')::smallint;
      if answer_index is null or answer_index not between 0 and 3 then raise exception 'Choose one answer.' using errcode='22023'; end if;
      update public.lms_practice_questions set selected=answer_index,answered_at=now() where id=question.id returning * into question;
    elsif p_action='bookmark' then
      update public.lms_practice_questions set saved=coalesce((p_data->>'saved')::boolean,false) where id=question.id returning * into question;
    end if;
    return public.lms_practice_question_view(question);
  end if;

  if p_action not in ('next','prepare') or wanted_difficulty is null or wanted_difficulty not in ('easy','medium','advanced') then
    raise exception 'Choose a practice difficulty.' using errcode='22023';
  end if;
  if wanted_focus is not null and not exists (select 1 from public.lms_practice_questions q
    where q.student_id=student and q.unit_id=target and q.answered_at is not null and q.topic=wanted_focus) then
    raise exception 'Choose a topic from your progress.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(student::text,129));
  select q.* into question from public.lms_practice_questions q join public.lms_practice_requests r on r.id=q.request_id
    join public.lms_practice_sources(target) s on s.key=r.source_key and s.version=r.source_version
    where q.student_id=student and q.unit_id=target and q.answered_at is null
      and r.assignment_id is not distinct from assignment and r.difficulty=wanted_difficulty and r.focus is not distinct from wanted_focus
    order by q.served_at nulls last,q.created_at,q.id limit 1 for update of q;
  if found then
    update public.lms_practice_questions set served_at=coalesce(served_at,now()) where id=question.id returning * into question;
    return jsonb_build_object('question',public.lms_practice_question_view(question));
  end if;
  select s.* into source from public.lms_practice_sources(target) s
  order by (select count(*) from public.lms_practice_requests r where r.student_id=student
    and r.unit_id=target and r.source_key=s.key and r.difficulty=wanted_difficulty),s.key limit 1;
  if not found then return jsonb_build_object('state','no_materials'); end if;
  if p_action='next' then return jsonb_build_object('state','generate'); end if;
  if exists (select 1 from public.lms_practice_requests r where r.student_id=student and r.finished_at is null
    and r.created_at>now()-interval '2 minutes') then return jsonb_build_object('state','generating'); end if;
  day_start:=date_trunc('day',now() at time zone 'Australia/Melbourne') at time zone 'Australia/Melbourne';
  if (settings->>'batches')::numeric>=1
    and (select count(*) from public.lms_practice_requests r where r.student_id=student and r.created_at>=day_start)
    >= floor((settings->>'batches')::numeric) then return jsonb_build_object('state','daily_limit'); end if;
  insert into public.lms_practice_requests(student_id,unit_id,assignment_id,difficulty,focus,source_key,source_version)
    values(student,target,assignment,wanted_difficulty,wanted_focus,source.key,source.version) returning id into request_id;
  return jsonb_build_object('state','reserved','requestId',request_id,'source',to_jsonb(source),
    'unitTitle',(select u.name from public.cms_course_units u where u.id=target),'assessmentTitle',assignment_title,'focus',wanted_focus,
    'recent',coalesce((select jsonb_agg(recent.prompt) from (select q.prompt from public.lms_practice_questions q
      where q.student_id=student and q.unit_id=target order by q.created_at desc limit 18) recent),'[]'));
end $$;

create function public.lms_practice_finish(p_request uuid,p_questions jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare req public.lms_practice_requests; candidate jsonb; added integer; inserted integer := 0;
begin
  select * into req from public.lms_practice_requests where id=p_request and finished_at is null for update;
  if not found then return 0; end if;
  update public.lms_practice_requests set finished_at=now() where id=req.id;
  if req.created_at <= now()-interval '2 minutes'
    or not exists(select 1 from public.lms_practice_sources(req.unit_id) where key=req.source_key and version=req.source_version)
    or req.unit_id not in (select public.student_enrolled_unit_ids(req.student_id))
    or (req.assignment_id is not null and not exists(select 1 from public.asm_assignments a
      where a.id=req.assignment_id and a.status<>'cancelled'
      and req.student_id in (select public.asm_assignment_eligible(a.id))))
    or (select public.lms_practice_rule(u.tenant_id,'lms.practice_enabled') from public.cms_course_units u where u.id=req.unit_id) is distinct from 'true'::jsonb
  then return 0; end if;
  for candidate in select value from jsonb_array_elements(coalesce(p_questions,'[]')) limit 6 loop
    insert into public.lms_practice_questions(request_id,student_id,unit_id,prompt,prompt_key,choices,correct,explanation,topic,evidence)
    values (req.id,req.student_id,req.unit_id,btrim(candidate->>'prompt'),
      md5(regexp_replace(lower(candidate->>'prompt'),'[^a-z0-9]','','g')),candidate->'choices',
      (candidate->>'correct')::smallint,btrim(candidate->>'explanation'),coalesce(req.focus,btrim(candidate->>'topic')),btrim(candidate->>'evidence'))
    on conflict (student_id,unit_id,prompt_key) do nothing;
    get diagnostics added=row_count;
    inserted:=inserted+added;
  end loop;
  return inserted;
end $$;

revoke all on function public.lms_practice_rule(uuid,text),public.lms_practice_settings(uuid),public.lms_practice_sources(text),
  public.lms_practice_question_view(public.lms_practice_questions),public.student_practice(text,jsonb),public.lms_practice_finish(uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.student_practice(text,jsonb) to authenticated;
grant execute on function public.lms_practice_finish(uuid,jsonb) to service_role;

commit;
