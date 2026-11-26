-- ASM-PDF-TEMPLATE phase 2 (owner 2026-11-26): the student answers on the workbook PDF.
--
-- 1. asm_student_template(attempt): the attempt's template as the student may see it (their own fields and the record's; never the
--    trainer's fields or the summary sheet's acknowledgement row); also for its trainers and admins (preview).
-- 2. The workbook PDF is readable by the students and trainers of a version that uses it (asm_template_storage_allowed, read only).
-- 3. asm_pdf_signatures: the student's declarations, each signed on its own with its own date, at its moment: "decl:<task>" at the
--    end of the task, "pack" (the whole-pack declaration) on the submit step. One tap with the saved signature (asm_pdf_sign
--    method saved); never changed once signed, never added after the submission. The assessor's sign-off and the student's
--    acknowledgement of the result stay in asm_attempt_signatures (assessor_signoff, student_acknowledgement), one per attempt.
-- 4. asm_template_missing(template, responses, signed slots): what blocks the submission (the same rules and words as
--    src/lib/assessment/pdfTemplate/student.ts missingItems): every question answered; each required text box / "Short answer" part
--    filled; a table with printed rows: every cell; a table of blank rows: at least one complete row; each task's declaration and
--    the whole-pack declaration signed; Appendix B optional. Answers: responses.pdf {fieldId: text}, responses.pdfChoice {group: option}.
-- 5. asm_attempt_snapshots: at submission, a locked copy of the student's answers, their signatures and the record values, with its
--    SHA-256 (never changed or deleted). Every PDF of the attempt (preview, marking, final) is drawn from it.
-- 6. asm_student submit: a version with a PDF template is checked with asm_template_missing (not the old definition), takes the
--    snapshot, and keeps the workbook's own declaration wording; asm_admin version_publish publishes such a version on its template.

create or replace function public.asm_template_declaration_text(p_t jsonb) returns text
language sql immutable set search_path = '' as $$
 select nullif(string_agg(x->>'text', E'\n\n' order by (x->>'page')::integer), '')
 from jsonb_array_elements(case when jsonb_typeof(p_t->'declarations') = 'array' then p_t->'declarations' else '[]'::jsonb end) x;
$$;
revoke all on function public.asm_template_declaration_text(jsonb) from public, anon;
grant execute on function public.asm_template_declaration_text(jsonb) to authenticated;

-- ------------------------------------------------------------------ the student's declaration signatures
create table if not exists public.asm_pdf_signatures (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 attempt_id uuid not null references public.asm_attempts(id) on delete cascade,
 slot text not null check (slot ~ '^(decl:[0-9]{1,2}|pack)$'),
 signer_user uuid not null,
 signer_name text not null check (char_length(btrim(signer_name)) between 1 and 200),
 method text not null check (method in ('drawn', 'uploaded', 'saved', 'typed')),
 signature_png text check (signature_png is null or (length(signature_png) between 100 and 400000 and signature_png ~ '^[A-Za-z0-9+/]+=*$')),
 statement text not null default '' check (char_length(statement) <= 4000),
 login jsonb,
 signed_at timestamptz not null default now(),
 unique (attempt_id, slot),
 check (method = 'typed' or signature_png is not null)
);
alter table public.asm_pdf_signatures enable row level security;
revoke all on public.asm_pdf_signatures from anon, authenticated;

create or replace function public.asm_pdf_signatures_frozen() returns trigger
language plpgsql set search_path = '' as $$
begin
 raise exception 'A signature is never changed or removed' using errcode = '42501';
end $$;
drop trigger if exists asm_pdf_signatures_frozen on public.asm_pdf_signatures;
create trigger asm_pdf_signatures_frozen before update or delete on public.asm_pdf_signatures for each row
 when (pg_trigger_depth() = 0) execute function public.asm_pdf_signatures_frozen();
revoke all on function public.asm_pdf_signatures_frozen() from public, anon, authenticated;

create or replace function public.asm_pdf_signature_json(s public.asm_pdf_signatures) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('slot', s.slot, 'signerName', s.signer_name, 'method', s.method, 'signaturePng', s.signature_png, 'statement', s.statement, 'signedAt', s.signed_at);
$$;
revoke all on function public.asm_pdf_signature_json(public.asm_pdf_signatures) from public, anon;

/** The student signs one declaration of their draft attempt ('saved': their saved signature, one tap). The first signature stands. */
create or replace function public.asm_pdf_sign(p_attempt uuid, p_slot text, p_method text, p_png text default null, p_statement text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.asm_attempts; v_png text; v_name text; s public.asm_pdf_signatures;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if coalesce(p_slot, '') !~ '^(decl:[0-9]{1,2}|pack)$' then raise exception 'Unknown declaration' using errcode = '22023'; end if;
 if p_method not in ('drawn', 'uploaded', 'saved', 'typed') then raise exception 'Unknown signing method' using errcode = '22023'; end if;
 select * into t from public.asm_attempts where id = p_attempt and public.tenant_scope(tenant_id) for update;
 if t.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
 if t.student_id is distinct from public.asm_student_id() then raise exception 'Only the student signs this' using errcode = '42501'; end if;
 if t.state <> 'draft' then raise exception 'The declarations are signed before the work is submitted' using errcode = '22023'; end if;
 select * into s from public.asm_pdf_signatures where attempt_id = p_attempt and slot = p_slot;
 if s.id is not null then return public.asm_pdf_signature_json(s); end if;
 if p_method = 'saved' then
  select signature_png into v_png from public.asm_saved_signatures where user_id = auth.uid();
  if v_png is null then raise exception 'You have no saved signature yet' using errcode = 'P0002'; end if;
 elsif p_method in ('drawn', 'uploaded') then
  v_png := p_png;
  if v_png is null then raise exception 'Draw or upload your signature' using errcode = '22023'; end if;
 end if;
 select full_name into v_name from public.enrollment_students where id = t.student_id;
 insert into public.asm_pdf_signatures(tenant_id, attempt_id, slot, signer_user, signer_name, method, signature_png, statement, login)
 values (t.tenant_id, p_attempt, p_slot, auth.uid(), coalesce(nullif(btrim(v_name), ''), auth.jwt()->>'email', 'Student'), p_method, v_png, left(coalesce(p_statement, ''), 4000), public.asm_login_details())
 returning * into s;
 perform public.asm_log('student', 'sign_declaration', 'attempt', p_attempt::text, jsonb_build_object('slot', p_slot, 'signatureId', s.id), t.tenant_id);
 return public.asm_pdf_signature_json(s);
end $$;
revoke all on function public.asm_pdf_sign(uuid, text, text, text, text) from public, anon;
grant execute on function public.asm_pdf_sign(uuid, text, text, text, text) to authenticated;

create or replace function public.asm_pdf_signatures_of(p_attempt uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.asm_attempts;
begin
 select * into t from public.asm_attempts where id = p_attempt and public.tenant_scope(tenant_id);
 if t.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
 if t.student_id is distinct from public.asm_student_id() and not (public.asm_is_admin() or public.asm_trainer_on_attempt(p_attempt)) then raise exception 'Not your attempt' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(public.asm_pdf_signature_json(s) order by s.signed_at) from public.asm_pdf_signatures s where s.attempt_id = p_attempt), '[]'::jsonb);
end $$;
revoke all on function public.asm_pdf_signatures_of(uuid) from public, anon;
grant execute on function public.asm_pdf_signatures_of(uuid) to authenticated;

-- ------------------------------------------------------------------ what blocks the submission
drop function if exists public.asm_template_missing(jsonb, jsonb, boolean);
create or replace function public.asm_template_missing(p_t jsonb, p_r jsonb, p_signed text[]) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare out jsonb := '[]'::jsonb; q jsonb; f jsonb; v_name text; v_kind text; v_task text; v_mine jsonb := '[]'::jsonb; v_r jsonb := coalesce(p_r, '{}'::jsonb);
 v_groups text[]; v_group text; i integer; v_which text; v_empty integer; v_pack integer;
begin
 if p_t is null then return out; end if;
 -- the student's own fields of the submission (not Appendix B, not signatures, not the acknowledgement row), each with whether it is filled
 for f in select * from jsonb_array_elements(coalesce(p_t->'fields', '[]'::jsonb)) loop
  if f->>'role' <> 'student' or coalesce(f->>'step', 'submit') = 'acknowledge' then continue; end if;
  select p->>'kind' into v_kind from jsonb_array_elements(coalesce(p_t->'pages', '[]'::jsonb)) p where (p->>'page')::numeric = (f->>'page')::numeric limit 1;
  if coalesce(v_kind, '') = 'appendix_b' then continue; end if;
  if f->>'kind' = 'signature' then
   if f->>'slot' = 'pack' then v_pack := (f->>'page')::numeric::integer; end if;
   continue;
  end if;
  v_mine := v_mine || jsonb_build_object('id', f->>'id', 'q', f->'questionKey', 'label', f->>'label', 'page', f->'page', 'kind', f->>'kind',
   'required', coalesce((f->>'required')::boolean, false), 'group', f->'table'->>'group', 'row', coalesce(f->'table'->>'rowKey', f->>'id'),
   'fixed', coalesce((f->'table'->>'fixed')::boolean, false),
   'filled', case when f->>'kind' in ('yes_no', 'rating') and coalesce(f->>'group', '') <> '' then (v_r->'pdfChoice'->>(f->>'group')) is not distinct from (f->>'option')
                  else btrim(coalesce(v_r->'pdf'->>(f->>'id'), '')) <> '' end);
 end loop;
 for q in select * from jsonb_array_elements(coalesce(p_t->'questions', '[]'::jsonb)) loop
  if not exists (select 1 from jsonb_array_elements(v_mine) m where m->>'q' = q->>'key') then continue; end if;
  v_name := coalesce(nullif(q->>'display', ''), q->>'seq');
  -- the same printed number in another task (CPC restarts at Q1 per task): named with its task, as the browser names it
  if jsonb_typeof(q->'task') = 'number' and (select count(*) from jsonb_array_elements(p_t->'questions') o where coalesce(nullif(o->>'display', ''), o->>'seq') = v_name) > 1 then
   v_name := format('Task %s · %s', q->>'task', v_name);
  end if;
  if not exists (select 1 from jsonb_array_elements(v_mine) m where m->>'q' = q->>'key' and (m->>'filled')::boolean) then
   out := out || jsonb_build_object('code', 'unanswered', 'questionKey', q->>'key', 'message', v_name || ' is not answered yet.');
   continue;
  end if;
  out := out || coalesce((select jsonb_agg(jsonb_build_object('code', 'required', 'questionKey', q->>'key', 'fieldId', m->>'id', 'message', format('%s: "%s" is empty.', v_name, m->>'label')) order by ord)
   from jsonb_array_elements(v_mine) with ordinality x(m, ord) where m->>'q' = q->>'key' and m->>'kind' <> 'table_cell' and (m->>'required')::boolean and not (m->>'filled')::boolean), '[]'::jsonb);
  select array_agg(g order by o) into v_groups from (select m->>'group' g, min(ord) o from jsonb_array_elements(v_mine) with ordinality x(m, ord)
   where m->>'q' = q->>'key' and m->>'kind' = 'table_cell' and m->>'group' is not null group by m->>'group') gg;
  i := 0;
  foreach v_group in array coalesce(v_groups, '{}'::text[]) loop
   i := i + 1;
   v_which := case when cardinality(v_groups) > 1 then format(' (table %s of %s)', i, cardinality(v_groups)) else '' end;
   if exists (select 1 from jsonb_array_elements(v_mine) m where m->>'group' = v_group and (m->>'fixed')::boolean) then
    select count(*) into v_empty from jsonb_array_elements(v_mine) m where m->>'group' = v_group and not (m->>'filled')::boolean;
    if v_empty > 0 then out := out || jsonb_build_object('code', 'table', 'questionKey', q->>'key', 'message', format('%s: %s empty cell%s in the table%s.', v_name, v_empty, case when v_empty = 1 then '' else 's' end, v_which)); end if;
   elsif not exists (select 1 from (select m->>'row' r, bool_and((m->>'filled')::boolean) full_row from jsonb_array_elements(v_mine) m where m->>'group' = v_group group by m->>'row') rr where rr.full_row) then
    out := out || jsonb_build_object('code', 'table', 'questionKey', q->>'key', 'message', format('%s: fill in at least one complete row of the table%s.', v_name, v_which));
   end if;
  end loop;
 end loop;
 out := out || coalesce((select jsonb_agg(jsonb_build_object('code', 'required', 'fieldId', m->>'id', 'message', format('"%s" (page %s) is empty.', m->>'label', m->>'page')))
  from jsonb_array_elements(v_mine) m where jsonb_typeof(m->'q') <> 'string' and (m->>'required')::boolean and not (m->>'filled')::boolean), '[]'::jsonb);
 for v_task in select distinct (p->>'task')::numeric::integer::text from jsonb_array_elements(coalesce(p_t->'pages', '[]'::jsonb)) p where p->>'kind' = 'declaration' and jsonb_typeof(p->'task') = 'number' order by 1 loop
  if not (('decl:' || v_task) = any(coalesce(p_signed, '{}'::text[]))) then
   out := out || jsonb_build_object('code', 'declaration', 'task', v_task::integer, 'slot', 'decl:' || v_task, 'message', format('Sign the Task %s declaration.', v_task));
  end if;
 end loop;
 if v_pack is not null and not ('pack' = any(coalesce(p_signed, '{}'::text[]))) then
  out := out || jsonb_build_object('code', 'signature', 'slot', 'pack', 'message', format('Sign the student declaration (page %s).', v_pack));
 end if;
 return out;
end $$;
revoke all on function public.asm_template_missing(jsonb, jsonb, text[]) from public, anon;
grant execute on function public.asm_template_missing(jsonb, jsonb, text[]) to authenticated;

create or replace function public.asm_student_template(p_attempt uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.asm_attempts; v jsonb;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 select * into t from public.asm_attempts where id = p_attempt and public.tenant_scope(tenant_id);
 if t.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
 if t.student_id is distinct from public.asm_student_id() and not (public.asm_is_admin() or public.asm_trainer_on_attempt(p_attempt)) then
  raise exception 'Not your attempt' using errcode = '42501';
 end if;
 select template into v from public.asm_versions where id = t.version_id;
 if v is null then return null; end if;
 return jsonb_set(v, '{fields}', coalesce((select jsonb_agg(f) from jsonb_array_elements(v->'fields') f
   where f->>'role' in ('student', 'auto') and coalesce(f->>'step', 'submit') <> 'acknowledge'), '[]'::jsonb));
end $$;
revoke all on function public.asm_student_template(uuid) from public, anon;
grant execute on function public.asm_student_template(uuid) to authenticated;

-- the workbook PDF: admins of the tenant write and read; the students and trainers of a version that uses it read
create or replace function public.asm_template_storage_allowed(p_name text, p_write boolean) returns boolean
language sql stable security definer set search_path = '' as $$
 select p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[a-f0-9]{64}\.pdf$' and (
  (public.asm_is_admin() and exists (select 1 from public.asm_assessments a where a.id::text = split_part(p_name, '/', 1) and public.tenant_scope(a.tenant_id)
              and (not p_write or a.archived_at is null)))
  or (not p_write and exists (select 1 from public.asm_versions v where v.assessment_id::text = split_part(p_name, '/', 1) and v.template->'pdf'->>'path' = p_name
              and (public.asm_student_on_version(v.id) or public.asm_trainer_on_version(v.id)))));
$$;

-- ------------------------------------------------------------------ the locked snapshot of a submission
create table if not exists public.asm_attempt_snapshots (
 attempt_id uuid primary key references public.asm_attempts(id) on delete cascade,
 tenant_id uuid references public.tenants(id) on delete restrict,
 version_id uuid not null references public.asm_versions(id) on delete restrict,
 template_sha256 text not null check (template_sha256 ~ '^[a-f0-9]{64}$'),
 answers jsonb not null,
 signatures jsonb not null,
 record jsonb not null,
 hash text not null check (hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now()
);
alter table public.asm_attempt_snapshots enable row level security;
revoke all on public.asm_attempt_snapshots from anon, authenticated;
create or replace function public.asm_attempt_snapshots_frozen() returns trigger
language plpgsql set search_path = '' as $$
begin
 raise exception 'A submitted snapshot is never changed or removed' using errcode = '42501';
end $$;
drop trigger if exists asm_attempt_snapshots_frozen on public.asm_attempt_snapshots;
create trigger asm_attempt_snapshots_frozen before update or delete on public.asm_attempt_snapshots for each row
 when (pg_trigger_depth() = 0) execute function public.asm_attempt_snapshots_frozen();
revoke all on function public.asm_attempt_snapshots_frozen() from public, anon, authenticated;

/** The hash of a snapshot: SHA-256 of its answers, signatures, record values and template (jsonb text, keys in jsonb order). */
create or replace function public.asm_snapshot_hash(p_answers jsonb, p_signatures jsonb, p_record jsonb, p_template_sha256 text) returns text
language sql immutable set search_path = '' as $$
 select encode(sha256(convert_to(jsonb_build_object('answers', p_answers, 'signatures', p_signatures, 'record', p_record, 'template', p_template_sha256)::text, 'UTF8')), 'hex');
$$;

create or replace function public.asm_pdf_snapshot_take(p_attempt uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare t public.asm_attempts; v public.asm_versions; v_answers jsonb; v_sigs jsonb; v_rec jsonb; v_tsha text; v_hash text;
begin
 select * into t from public.asm_attempts where id = p_attempt;
 select * into v from public.asm_versions where id = t.version_id;
 if v.template is null then return null; end if;
 if exists (select 1 from public.asm_attempt_snapshots where attempt_id = p_attempt) then return (select hash from public.asm_attempt_snapshots where attempt_id = p_attempt); end if;
 v_answers := jsonb_build_object('pdf', coalesce(t.responses->'pdf', '{}'::jsonb), 'pdfChoice', coalesce(t.responses->'pdfChoice', '{}'::jsonb));
 v_sigs := coalesce((select jsonb_object_agg(s.slot, public.asm_pdf_signature_json(s) - 'slot') from public.asm_pdf_signatures s where s.attempt_id = p_attempt), '{}'::jsonb);
 v_rec := jsonb_build_object(
  'studentName', (select s.full_name from public.enrollment_students s where s.id = t.student_id),
  'studentRef', (select coalesce(nullif(btrim(to_jsonb(s)->>'student_number'), ''), upper(left(s.id::text, 8))) from public.enrollment_students s where s.id = t.student_id),
  'studentEmail', (select s.email from public.enrollment_students s where s.id = t.student_id),
  'trainers', coalesce((select jsonb_agg(n order by n) from (select distinct btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) as n from hr.staff_profiles p where p.id in (
     select x.staff_id from public.asm_assignment_trainers x where x.assignment_id = t.assignment_id
     union select it.staff_id from public.intake_trainers it join public.asm_assignments g on g.intake_id = it.intake_id where g.id = t.assignment_id)) names where n <> ''), '[]'::jsonb),
  'unitCode', (select u.code from public.asm_assessments a join public.cms_course_units u on u.id = a.unit_id where a.id = v.assessment_id),
  'unitName', (select u.name from public.asm_assessments a join public.cms_course_units u on u.id = a.unit_id where a.id = v.assessment_id),
  'qualificationCode', (select c.code from public.asm_assessments a join public.cms_courses c on c.id = a.course_id where a.id = v.assessment_id),
  'qualificationName', (select c.name from public.asm_assessments a join public.cms_courses c on c.id = a.course_id where a.id = v.assessment_id),
  'attemptNo', t.attempt_no, 'startedAt', t.created_at, 'submittedAt', coalesce(t.submitted_at, now()));
 v_tsha := encode(sha256(convert_to(v.template::text, 'UTF8')), 'hex');
 v_hash := public.asm_snapshot_hash(v_answers, v_sigs, v_rec, v_tsha);
 insert into public.asm_attempt_snapshots(attempt_id, tenant_id, version_id, template_sha256, answers, signatures, record, hash)
 values (p_attempt, t.tenant_id, v.id, v_tsha, v_answers, v_sigs, v_rec, v_hash);
 return v_hash;
end $$;
revoke all on function public.asm_snapshot_hash(jsonb, jsonb, jsonb, text), public.asm_pdf_snapshot_take(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ in-place patches (each anchor exactly once; the block can run again)
create or replace function pg_temp.asm_patch(p_fn regprocedure, p_anchors text[], p_new text, p_what text) returns void
language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); a text; n integer;
begin
 if position(p_new in d) > 0 then return; end if;
 foreach a in array p_anchors loop
  n := (length(d) - length(replace(d, a, ''))) / length(a);
  if n = 1 then execute replace(d, a, p_new); return; end if;
 end loop;
 raise exception '% anchor not found exactly once', p_what;
end $$;

-- asm_student submit: the template's checks, the snapshot, and the workbook's declaration wording
select pg_temp.asm_patch('public.asm_student(text,jsonb)'::regprocedure, array[
  $a$v_errs := public.asm_validate_responses(v_ver.definition, v_att.responses, 'student');$a$,
  $a$v_errs := case when v_ver.template is null then public.asm_validate_responses(v_ver.definition, v_att.responses, 'student')
   else public.asm_template_missing(v_ver.template, v_att.responses, exists (select 1 from public.asm_attempt_signatures s where s.attempt_id = v_id and s.kind = 'student_declaration')) end;$a$],
 $b$v_errs := case when v_ver.template is null then public.asm_validate_responses(v_ver.definition, v_att.responses, 'student')
   else public.asm_template_missing(v_ver.template, v_att.responses, array(select s.slot from public.asm_pdf_signatures s where s.attempt_id = v_id)) end;$b$, 'asm_student validate');
select pg_temp.asm_patch('public.asm_student(text,jsonb)'::regprocedure, array[
  $a$'text', v_set->>'declaration_text', 'textSha256', encode(sha256(convert_to(coalesce(v_set->>'declaration_text', ''), 'UTF8')), 'hex'),$a$],
 $b$'text', coalesce(public.asm_template_declaration_text(v_ver.template), v_set->>'declaration_text'), 'textSha256', encode(sha256(convert_to(coalesce(public.asm_template_declaration_text(v_ver.template), v_set->>'declaration_text', ''), 'UTF8')), 'hex'),$b$, 'asm_student declaration text');
select pg_temp.asm_patch('public.asm_student(text,jsonb)'::regprocedure, array[
  $a$perform public.asm_autocheck(v_id); perform public.asm_rollup(v_id);$a$],
 $b$if v_ver.template is not null then perform public.asm_pdf_snapshot_take(v_id); end if;
  perform public.asm_autocheck(v_id); perform public.asm_rollup(v_id);$b$, 'asm_student snapshot');

-- asm_admin version_publish: a version answered on its workbook PDF is published on its template (it needs questions there)
select pg_temp.asm_patch('public.asm_admin(text,jsonb)'::regprocedure, array[
  $a$if jsonb_array_length(coalesce(v_ver.definition->'tasks', '[]')) = 0 then v_errs := v_errs || jsonb_build_object('code', 'no_tasks', 'message', 'Add at least one task before publishing.'); end if;$a$],
 $b$if v_ver.template is null and jsonb_array_length(coalesce(v_ver.definition->'tasks', '[]')) = 0 then v_errs := v_errs || jsonb_build_object('code', 'no_tasks', 'message', 'Add at least one task before publishing.'); end if;
  if v_ver.template is not null and jsonb_array_length(coalesce(v_ver.template->'questions', '[]')) = 0 then v_errs := v_errs || jsonb_build_object('code', 'no_questions', 'message', 'The workbook PDF has no questions yet.'); end if;$b$, 'asm_admin no_tasks');
select pg_temp.asm_patch('public.asm_admin(text,jsonb)'::regprocedure, array[
  $a$if not exists (select 1 from public.asm_definition_questions(v_ver.definition) q where q.marking_mode <> 'none') then$a$],
 $b$if v_ver.template is null and not exists (select 1 from public.asm_definition_questions(v_ver.definition) q where q.marking_mode <> 'none') then$b$, 'asm_admin no_questions');
