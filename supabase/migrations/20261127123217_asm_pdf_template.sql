-- ASM-PDF-TEMPLATE phase 1 (owner 2026-11-26): an assessment is its workbook PDF used as it is, like an e-sign template. The uploaded
-- PDF is the document; the version's template only says where answers and marks go on it (fields as fractions of the page, as in
-- hr.sign_template_fields). Nothing is rebuilt from the PDF's text.
--
-- 1. asm_versions.template (jsonb, null = no PDF template yet): { version 1, pdf {path, sha256, pages, fileName}, pages [{page, kind,
--    audience, task}], tasks [...], questions [{key (the printed number), seq, label, task, header, areas}], fields [{id, page, x, y, w,
--    h, role student | trainer | auto, kind, questionKey, label, dataKey, option, group, attempt, table, step}], detected {by, at} }.
--    The "Assessment Submission Method" tick boxes are auto fields (dataKey submission_method, option hand | email | lms | other):
--    the "Online submission via LMS" one is ticked. step acknowledge = the summary sheet's student signature and its date, filled
--    when the student acknowledges the released result (asm_sign student_acknowledgement), not in the submission wizard.
--    A new version starts with the template of the version it follows (trigger); a published or retired version's template never
--    changes (trigger), so attempts keep the layout they began with.
-- 2. Private bucket assessment-templates: <assessment id>/<sha256>.pdf, written by admins of the assessment's tenant, read by them;
--    never replaced or deleted from the browser (a changed PDF is a new file with its own hash).
-- 3. asm_template_validate(template): the problems a template has (the same rules as src/lib/assessment/pdfTemplate/model.ts).
-- 4. asm_template_get(assessment): the draft's template, else the published one, with its version (admins).
-- 5. asm_template_save(assessment, template, expected updated_at): saved on the draft (a published assessment starts its next draft
--    through asm_admin draft_save, keys and mappings copied), refused on a concurrent change (40001), logged (template_save).
--
-- Mappings (asm_unit_mappings) and keys stay as they are: their question_id is the question's key, which for a PDF template is the
-- printed question number of that version (nothing uses them yet: 0 rows on hosted 2026-11-26).

alter table public.asm_versions add column if not exists template jsonb
 check (template is null or (jsonb_typeof(template) = 'object' and (template->>'version') = '1' and jsonb_typeof(template->'fields') = 'array'));

-- ------------------------------------------------------------------ validation
create or replace function public.asm_template_validate(p_t jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare out text[] := '{}'; f jsonb; q jsonb; v_pages integer; v_ids text[] := '{}'; v_keys text[] := '{}'; v_id text; v_where text;
 v_auto constant text[] := array['student_name','student_id','student_email','trainer_name','unit_code','unit_name','unit_code_name',
  'qualification_code','qualification_name','start_date','end_date','submission_date','signoff_date','acknowledged_date','signed_date','today','submission_method'];
 x numeric; y numeric; w numeric; h numeric;
begin
 if p_t is null or jsonb_typeof(p_t) <> 'object' or coalesce(p_t->>'version', '') <> '1' then return jsonb_build_array('The template version is not supported.'); end if;
 if jsonb_typeof(p_t->'fields') <> 'array' or jsonb_typeof(p_t->'questions') <> 'array' or jsonb_typeof(coalesce(p_t->'pages', '[]')) <> 'array' then
  return jsonb_build_array('The template is incomplete.');
 end if;
 v_pages := case when jsonb_typeof(p_t->'pdf'->'pages') = 'number' then (p_t->'pdf'->>'pages')::numeric::integer end;
 if coalesce(p_t->'pdf'->>'path', '') = '' or coalesce(p_t->'pdf'->>'sha256', '') !~ '^[a-f0-9]{64}$' or v_pages is null or v_pages < 1 or v_pages > 600 then
  out := out || 'The template''s PDF is missing or unreadable.'::text;
 end if;
 if jsonb_array_length(p_t->'fields') > 4000 then out := out || 'Too many fields (4000 at most).'::text; end if;
 for q in select * from jsonb_array_elements(p_t->'questions') loop
  v_id := coalesce(q->>'key', '');
  if v_id !~ '^[A-Za-z0-9_.-]{1,80}$' then out := out || format('Question "%s": a number of letters, digits, dot, dash or underscore.', left(v_id, 80));
  elsif v_id = any(v_keys) then out := out || 'Two questions have the same number.'::text;
  end if;
  v_keys := v_keys || v_id;
 end loop;
 for f in select * from jsonb_array_elements(p_t->'fields') loop
  v_id := coalesce(f->>'id', '');
  v_where := format('Field %s (page %s)', left(v_id, 80), coalesce(f->>'page', '?'));
  if v_id !~ '^[A-Za-z0-9_.-]{1,80}$' or v_id = any(v_ids) then out := out || (v_where || ': its id is missing or used twice.'); end if;
  v_ids := v_ids || v_id;
  if jsonb_typeof(f->'page') <> 'number' or (f->>'page')::numeric <> floor((f->>'page')::numeric) or (f->>'page')::numeric < 1 or (f->>'page')::numeric > coalesce(v_pages, 0) then
   out := out || (v_where || ': not on a page of the PDF.');
  end if;
  if jsonb_typeof(f->'x') <> 'number' or jsonb_typeof(f->'y') <> 'number' or jsonb_typeof(f->'w') <> 'number' or jsonb_typeof(f->'h') <> 'number' then
   out := out || (v_where || ': outside the page.');
  else
   x := (f->>'x')::numeric; y := (f->>'y')::numeric; w := (f->>'w')::numeric; h := (f->>'h')::numeric;
   if least(x, y, w, h) < 0 or greatest(x, y, w, h) > 1 or x + w > 1.0001 or y + h > 1.0001 or w <= 0 or h <= 0 then out := out || (v_where || ': outside the page.'); end if;
  end if;
  if coalesce(f->>'role', '') not in ('student', 'trainer', 'auto') then out := out || (v_where || ': unknown role.'); end if;
  if coalesce(f->>'kind', '') not in ('text', 'table_cell', 'yes_no', 'checkbox', 'signature', 'date', 'rating', 'auto') then out := out || (v_where || ': unknown kind.'); end if;
  if (f->>'role' = 'auto') is distinct from (f->>'kind' = 'auto') then out := out || (v_where || ': an auto field is filled from the record (role and kind auto together).'); end if;
  if f->>'kind' = 'auto' and not (coalesce(f->>'dataKey', '') = any(v_auto)) then out := out || (v_where || ': choose which record value fills it.'); end if;
  if coalesce(f->>'questionKey', '') <> '' and not (f->>'questionKey' = any(v_keys)) then out := out || format('%s: its question %s is not in the template.', v_where, left(f->>'questionKey', 80)); end if;
  if f->>'kind' in ('yes_no', 'rating') and (coalesce(f->>'group', '') = '' or coalesce(f->>'option', '') = '') then out := out || (v_where || ': a choice needs its group and option.'); end if;
  if f->>'dataKey' = 'submission_method' and coalesce(f->>'option', '') not in ('hand', 'email', 'lms', 'other') then out := out || (v_where || ': say which submission method this box is.'); end if;
  if coalesce(f->>'step', '') not in ('', 'submit', 'acknowledge') then out := out || (v_where || ': unknown step.'); end if;
  if f->>'step' = 'acknowledge' and not coalesce((f->>'role' = 'student' and f->>'kind' = 'signature') or f->>'dataKey' in ('acknowledged_date', 'signed_date'), false) then
   out := out || (v_where || ': only the student''s signature and its date are filled when the result is acknowledged.');
  end if;
  if coalesce(f->>'slot', '') <> '' and f->>'slot' !~ '^(decl:[0-9]{1,2}|pack|ack|signoff)$' then out := out || (v_where || ': unknown signature.'); end if;
  if f->>'dataKey' = 'signed_date' and coalesce(f->>'slot', '') = '' then out := out || (v_where || ': say which signature this date belongs to.'); end if;
  exit when cardinality(out) >= 50;
 end loop;
 return to_jsonb(out);
end $$;
revoke all on function public.asm_template_validate(jsonb) from public, anon;
grant execute on function public.asm_template_validate(jsonb) to authenticated;

-- ------------------------------------------------------------------ a new version carries the template; a published one keeps it
create or replace function public.asm_versions_template_carry() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if new.template is null then
  select v.template into new.template from public.asm_assessments a join public.asm_versions v on v.id = a.current_version_id where a.id = new.assessment_id;
 end if;
 return new;
end $$;
drop trigger if exists asm_versions_template_carry on public.asm_versions;
create trigger asm_versions_template_carry before insert on public.asm_versions for each row execute function public.asm_versions_template_carry();

create or replace function public.asm_versions_template_frozen() returns trigger
language plpgsql set search_path = '' as $$
begin
 if old.status in ('published', 'retired') and new.template is distinct from old.template then
  raise exception 'A published version''s PDF template cannot change; edit the draft.' using errcode = '42501';
 end if;
 return new;
end $$;
drop trigger if exists asm_versions_template_frozen on public.asm_versions;
create trigger asm_versions_template_frozen before update of template on public.asm_versions for each row execute function public.asm_versions_template_frozen();
revoke all on function public.asm_versions_template_carry(), public.asm_versions_template_frozen() from public, anon, authenticated;

-- ------------------------------------------------------------------ storage: assessment-templates/<assessment id>/<sha256>.pdf
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('assessment-templates', 'assessment-templates', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;

create or replace function public.asm_template_storage_allowed(p_name text, p_write boolean) returns boolean
language sql stable security definer set search_path = '' as $$
 select public.asm_is_admin()
  and p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[a-f0-9]{64}\.pdf$'
  and exists (select 1 from public.asm_assessments a where a.id::text = split_part(p_name, '/', 1) and public.tenant_scope(a.tenant_id)
              and (not p_write or a.archived_at is null));
$$;
revoke all on function public.asm_template_storage_allowed(text, boolean) from public, anon;
grant execute on function public.asm_template_storage_allowed(text, boolean) to authenticated;

drop policy if exists asm_template_upload on storage.objects;
create policy asm_template_upload on storage.objects for insert to authenticated
with check (bucket_id = 'assessment-templates' and public.asm_template_storage_allowed(name, true));
drop policy if exists asm_template_read on storage.objects;
create policy asm_template_read on storage.objects for select to authenticated
using (bucket_id = 'assessment-templates' and public.asm_template_storage_allowed(name, false));
drop policy if exists asm_template_boundary_update on storage.objects;
create policy asm_template_boundary_update on storage.objects as restrictive for update to authenticated
using (bucket_id <> 'assessment-templates') with check (bucket_id <> 'assessment-templates');
drop policy if exists asm_template_boundary_delete on storage.objects;
create policy asm_template_boundary_delete on storage.objects as restrictive for delete to authenticated
using (bucket_id <> 'assessment-templates');

-- ------------------------------------------------------------------ read and save
create or replace function public.asm_template_get(p_assessment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_as public.asm_assessments; v_ver public.asm_versions;
begin
 if not public.asm_is_admin() then raise exception 'Only an Admin or an RTO Manager can manage assessments.' using errcode = '42501'; end if;
 select * into v_as from public.asm_assessments where id = p_assessment and public.tenant_scope(tenant_id);
 if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
 select * into v_ver from public.asm_versions where assessment_id = v_as.id and status = 'draft';
 if v_ver.id is null then select * into v_ver from public.asm_versions where id = v_as.current_version_id; end if;
 return jsonb_build_object('assessmentId', v_as.id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no, 'status', v_ver.status,
  'updatedAt', v_ver.updated_at, 'template', v_ver.template);
end $$;
revoke all on function public.asm_template_get(uuid) from public, anon;
grant execute on function public.asm_template_get(uuid) to authenticated;

create or replace function public.asm_template_save(p_assessment uuid, p_template jsonb, p_expected_updated_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
  -- a published assessment: its next draft starts from the published definition (keys and mappings copied by draft_save)
  v_out := public.asm_admin('draft_save', jsonb_build_object('assessmentId', v_as.id,
    'definition', coalesce((select v.definition from public.asm_versions v where v.id = v_as.current_version_id), '{"tasks": []}'::jsonb)));
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
end $$;
revoke all on function public.asm_template_save(uuid, jsonb, timestamptz) from public, anon;
grant execute on function public.asm_template_save(uuid, jsonb, timestamptz) to authenticated;
