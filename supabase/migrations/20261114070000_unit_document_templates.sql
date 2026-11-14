-- UNIT-DOCS: document templates for a course unit, sent to a batch for signature.
-- A Sign template (hr.sign_templates, audience student) can be linked to one course unit. In Batch Allocation the unit's
-- templates are sent to every active student of the batch: one signing request each (created by document-signing), and
-- each send is logged here so a student is not sent the same template twice for the same batch.
-- Additive only. Access through public.unit_documents (hr.require_admin, as signing_admin). Tables have RLS and no policies.

create table if not exists public.sign_template_units (
 template_id uuid primary key references hr.sign_templates(id) on delete cascade,
 course_id text not null references public.cms_courses(id) on delete cascade,
 unit_id text not null references public.cms_course_units(id) on delete cascade,
 created_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists sign_template_units_unit_idx on public.sign_template_units(unit_id);
alter table public.sign_template_units enable row level security;
revoke all on public.sign_template_units from anon, authenticated;

create table if not exists public.sign_batch_sends (
 id uuid primary key default gen_random_uuid(),
 template_id uuid not null references hr.sign_templates(id) on delete cascade,
 batch_id uuid not null references public.batches(id) on delete cascade,
 student_id uuid not null references public.enrollment_students(id) on delete cascade,
 request_id uuid references hr.sign_requests(id) on delete set null,
 created_by uuid,
 created_at timestamptz not null default now(),
 unique (template_id, batch_id, student_id)
);
create index if not exists sign_batch_sends_batch_idx on public.sign_batch_sends(batch_id);
alter table public.sign_batch_sends enable row level security;
revoke all on public.sign_batch_sends from anon, authenticated;

create or replace function public.unit_documents(p_action text, p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, hr, pg_temp as $f$
declare v_admin uuid := hr.require_admin(); d jsonb := coalesce(p_data, '{}'::jsonb); v_template uuid; v_unit text; v_course text; v_batch uuid;
begin
 if p_action = 'links' then
  -- Every unit link, for the Sign › Templates list.
  return coalesce((select jsonb_agg(jsonb_build_object('templateId', l.template_id, 'courseId', l.course_id, 'unitId', l.unit_id, 'unitCode', u.code, 'unitName', u.name))
   from public.sign_template_units l join public.cms_course_units u on u.id = l.unit_id), '[]'::jsonb);

 elsif p_action = 'link_set' then
  v_template := nullif(d->>'templateId', '')::uuid; v_unit := nullif(d->>'unitId', '');
  if v_template is null or not exists (select 1 from hr.sign_templates t where t.id = v_template and t.deleted_at is null) then raise exception 'Template not found' using errcode = 'P0002'; end if;
  if v_unit is null then
   delete from public.sign_template_units where template_id = v_template;
   return jsonb_build_object('ok', true, 'templateId', v_template, 'unitId', null);
  end if;
  select u.course_id into v_course from public.cms_course_units u where u.id = v_unit;
  if v_course is null then raise exception 'Unit not found' using errcode = 'P0002'; end if;
  if nullif(d->>'courseId', '') is not null and d->>'courseId' <> v_course then raise exception 'The unit does not belong to the course' using errcode = '22023'; end if;
  insert into public.sign_template_units(template_id, course_id, unit_id, created_by) values (v_template, v_course, v_unit, v_admin)
  on conflict (template_id) do update set course_id = excluded.course_id, unit_id = excluded.unit_id, updated_at = now();
  return jsonb_build_object('ok', true, 'templateId', v_template, 'courseId', v_course, 'unitId', v_unit);

 elsif p_action = 'batch_status' then
  -- The active templates of one unit, with who in the batch was sent each and the state of that request.
  v_batch := nullif(d->>'batchId', '')::uuid; v_unit := nullif(d->>'unitId', '');
  if v_batch is null or v_unit is null then raise exception 'batchId and unitId are required' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('templateId', t.id, 'name', t.name, 'title', t.title, 'version', t.version, 'roles', t.roles,
    'sends', coalesce((select jsonb_agg(jsonb_build_object('studentId', s.student_id, 'requestId', s.request_id, 'sentAt', s.created_at,
       'state', case when r.id is null then null else hr.sign_status(r) end, 'reference', r.reference))
      from public.sign_batch_sends s left join hr.sign_requests r on r.id = s.request_id where s.template_id = t.id and s.batch_id = v_batch), '[]'::jsonb))
    order by lower(t.name))
   from hr.sign_templates t join public.sign_template_units l on l.template_id = t.id
   where l.unit_id = v_unit and t.deleted_at is null and t.status = 'active'), '[]'::jsonb);

 elsif p_action = 'send_record' then
  v_template := nullif(d->>'templateId', '')::uuid; v_batch := nullif(d->>'batchId', '')::uuid;
  if v_template is null or v_batch is null or nullif(d->>'studentId', '') is null then raise exception 'templateId, batchId and studentId are required' using errcode = '22023'; end if;
  if not exists (select 1 from public.batch_enrolments e where e.batch_id = v_batch and e.student_id = (d->>'studentId')::uuid) then
   raise exception 'The student is not in this batch' using errcode = '22023'; end if;
  insert into public.sign_batch_sends(template_id, batch_id, student_id, request_id, created_by)
  values (v_template, v_batch, (d->>'studentId')::uuid, nullif(d->>'requestId', '')::uuid, v_admin)
  on conflict (template_id, batch_id, student_id) do update set request_id = excluded.request_id, created_at = now(), created_by = excluded.created_by;
  return jsonb_build_object('ok', true);
 end if;
 raise exception 'Unknown unit documents action' using errcode = '22023';
end $f$;
revoke all on function public.unit_documents(text, jsonb) from public, anon;
grant execute on function public.unit_documents(text, jsonb) to authenticated;
