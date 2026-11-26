-- ASM-PDF-TEMPLATE phase 3 (owner 2026-11-26): marking on the workbook PDF and its output.
--
-- 1. asm_task_outcome_auto: for a version answered on its workbook PDF, a task's result comes from the marks of the template's
--    questions of that task (asm_results.question_id = the question's key): every question Satisfactory = S, any No = NYS, a question
--    not marked yet = no result. asm_trainer mark_return asks for a result of every task of the template (not the old definition).
-- 2. asm_pdf_attempt(attempt): what draws the attempt's PDF: the template, the record, and each attempt of the student on that
--    assignment up to this one (its locked snapshot, its marks / task results / trainer fields once the student may see them, the
--    assessor's sign-off and the student's acknowledgement), and the stored final PDF. Trainers of the attempt, admins, its student
--    (once submitted).
-- 3. Private bucket assessment-output: <attempt id>/final-<sha256>.pdf, written by an assessor of the attempt once it is final, read
--    by them, admins and the student. asm_attempt_outputs records it with the snapshot hash it was drawn from (never changed).

create or replace function public.asm_task_outcome_auto(p_attempt uuid, p_task text) returns text
language sql stable security definer set search_path = '' as $$
 with v as (
  select ver.definition, ver.template from public.asm_attempts a join public.asm_versions ver on ver.id = a.version_id where a.id = p_attempt
 ), qs as (
  select q.question_id from v cross join lateral public.asm_definition_questions(v.definition) q
  where v.template is null and q.task_id = p_task and q.depth = 0 and q.marking_mode <> 'none' and q.question_type not in ('declaration', 'adjustment_record')
  union all
  select tq->>'key' from v cross join lateral jsonb_array_elements(coalesce(v.template->'questions', '[]'::jsonb)) tq
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
$$;

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

select pg_temp.asm_patch('public.asm_trainer(text,jsonb)'::regprocedure, array[
  $a$if exists (select 1 from (select distinct q.task_id from public.asm_definition_questions(v_ver.definition) q where q.marking_mode <> 'none') tk$a$],
 $b$if exists (select 1 from (select distinct q.task_id from public.asm_definition_questions(v_ver.definition) q where v_ver.template is null and q.marking_mode <> 'none'
             union select distinct (tq->>'task')::numeric::integer::text from jsonb_array_elements(case when v_ver.template is null then '[]'::jsonb else v_ver.template->'questions' end) tq where jsonb_typeof(tq->'task') = 'number') tk$b$,
 'asm_trainer mark_return tasks');
-- asm_trainer mark_save: a workbook attempt has a task result for every task of its template, recomputed from the marks on every save
-- (a question marked in a later save updates its task's result even when the save names no task)
select pg_temp.asm_patch('public.asm_trainer(text,jsonb)'::regprocedure, array[
  $a$  update public.asm_attempts set state = 'marking', marking_started_at = coalesce(marking_started_at, now()), marked_by = auth.uid(),$a$],
 $b$  insert into public.asm_task_results(attempt_id, task_id, feedback, signed_by, signed_at)
  select v_id, (tq->>'number'), '', auth.uid(), now() from public.asm_versions vv cross join lateral jsonb_array_elements(coalesce(vv.template->'tasks', '[]'::jsonb)) tq
  where vv.id = v_att.version_id and vv.template is not null on conflict (attempt_id, task_id) do nothing;
  update public.asm_task_results set outcome = outcome where attempt_id = v_id;
  update public.asm_attempts set state = 'marking', marking_started_at = coalesce(marking_started_at, now()), marked_by = auth.uid(),$b$,
 'asm_trainer mark_save task results');

/**
 * What must be answered before a workbook attempt's result is released (the same rules and words as output.ts markingMissing): every
 * question marked (the Performance Outcome rows follow these marks) and every checklist row the trainer ticks (Evidence Outcome rows;
 * Performance rows naming activities, not questions), in this attempt's own marks.
 */
create or replace function public.asm_template_marking_missing(p_t jsonb, p_attempt uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare out jsonb := '[]'::jsonb; q jsonb; f jsonb; v_name text; v_choice jsonb; v_seen text[] := '{}';
begin
 select coalesce(assessor_responses->'pdfChoice', '{}'::jsonb) into v_choice from public.asm_attempts where id = p_attempt;
 for q in select * from jsonb_array_elements(coalesce(p_t->'questions', '[]'::jsonb)) loop
  if exists (select 1 from public.asm_results r where r.attempt_id = p_attempt and r.question_id = q->>'key' and r.criterion_id is null and r.outcome is not null) then continue; end if;
  v_name := coalesce(nullif(q->>'display', ''), q->>'seq');
  if jsonb_typeof(q->'task') = 'number' and (select count(*) from jsonb_array_elements(p_t->'questions') o where coalesce(nullif(o->>'display', ''), o->>'seq') = v_name) > 1 then
   v_name := format('Task %s · %s', q->>'task', v_name);
  end if;
  out := out || jsonb_build_object('code', 'unmarked', 'questionKey', q->>'key', 'message', v_name || ' is not marked yet.');
 end loop;
 for f in select x from jsonb_array_elements(coalesce(p_t->'fields', '[]'::jsonb)) x order by (x->>'page')::numeric, (x->>'y')::numeric loop
  if f->>'role' <> 'trainer' or f->>'kind' <> 'yes_no' or coalesce(f->>'group', '') = '' or (f->>'group') = any(v_seen) then continue; end if;
  if not coalesce(f->>'checklist' = 'evidence' or (f->>'checklist' = 'performance' and coalesce(f->>'questionKey', '') = ''), false) then continue; end if;
  v_seen := v_seen || (f->>'group');
  if coalesce(v_choice->>(f->>'group'), '') = '' then
   out := out || jsonb_build_object('code', 'checklist', 'group', f->>'group', 'message', format('Marking checklist, page %s: "%s" has no Yes / No.', (f->>'page')::numeric::integer, f->>'label'));
  end if;
 end loop;
 return out;
end $$;
revoke all on function public.asm_template_marking_missing(jsonb, uuid) from public, anon;
grant execute on function public.asm_template_marking_missing(jsonb, uuid) to authenticated;

-- a workbook version: instead of the old definition's assessor answers, the release needs every question marked and every checklist
-- row the trainer ticks answered (asm_template_marking_missing); refused with the list of what is missing
select pg_temp.asm_patch('public.asm_trainer(text,jsonb)'::regprocedure, array[
  $a$v_errs := public.asm_validate_responses(v_ver.definition, v_att.assessor_responses, 'assessor');$a$,
  $a$v_errs := case when v_ver.template is null then public.asm_validate_responses(v_ver.definition, v_att.assessor_responses, 'assessor') else '[]'::jsonb end;$a$],
 $b$v_errs := case when v_ver.template is null then public.asm_validate_responses(v_ver.definition, v_att.assessor_responses, 'assessor') else public.asm_template_marking_missing(v_ver.template, v_id) end;$b$,
 'asm_trainer mark_return assessor answers');

-- ------------------------------------------------------------------ the final PDF
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('assessment-output', 'assessment-output', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;

create table if not exists public.asm_attempt_outputs (
 attempt_id uuid not null references public.asm_attempts(id) on delete cascade,
 -- final = stored at the trainer's final sign-off; acknowledged = stored again once the student has acknowledged the result
 -- (the official record when it exists); both kept, each with the hashes it was drawn from
 kind text not null check (kind in ('final', 'acknowledged')),
 tenant_id uuid references public.tenants(id) on delete restrict,
 path text not null,
 pdf_sha256 text not null check (pdf_sha256 ~ '^[a-f0-9]{64}$'),
 snapshot_hash text not null check (snapshot_hash ~ '^[a-f0-9]{64}$'),
 created_by uuid not null,
 created_at timestamptz not null default now(),
 primary key (attempt_id, kind)
);
-- what was marked when the PDF was stored: the marks, task results, outcome, feedback, the trainer's fields and the sign-off, and its hash
alter table public.asm_attempt_outputs add column if not exists marking jsonb not null default '{}'::jsonb;
alter table public.asm_attempt_outputs add column if not exists marking_hash text not null default '' check (marking_hash = '' or marking_hash ~ '^[a-f0-9]{64}$');
alter table public.asm_attempt_outputs drop constraint if exists asm_attempt_outputs_kind_check;
alter table public.asm_attempt_outputs add constraint asm_attempt_outputs_kind_check check (kind in ('final', 'acknowledged'));
-- the acknowledged copy also records the acknowledgement it printed, and its hash
alter table public.asm_attempt_outputs add column if not exists acknowledgement jsonb not null default '{}'::jsonb;
alter table public.asm_attempt_outputs add column if not exists acknowledgement_hash text not null default '' check (acknowledgement_hash = '' or acknowledgement_hash ~ '^[a-f0-9]{64}$');
alter table public.asm_attempt_outputs enable row level security;
revoke all on public.asm_attempt_outputs from anon, authenticated;
create or replace function public.asm_attempt_outputs_frozen() returns trigger
language plpgsql set search_path = '' as $$
begin
 raise exception 'A stored final PDF is never changed or removed' using errcode = '42501';
end $$;
drop trigger if exists asm_attempt_outputs_frozen on public.asm_attempt_outputs;
create trigger asm_attempt_outputs_frozen before update or delete on public.asm_attempt_outputs for each row
 when (pg_trigger_depth() = 0) execute function public.asm_attempt_outputs_frozen();
revoke all on function public.asm_attempt_outputs_frozen() from public, anon, authenticated;

create or replace function public.asm_output_storage_allowed(p_name text, p_write boolean) returns boolean
language sql stable security definer set search_path = '' as $$
 select p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(final|acknowledged)-[a-f0-9]{64}\.pdf$' and exists (
  select 1 from public.asm_attempts t where t.id::text = split_part(p_name, '/', 1) and public.tenant_scope(t.tenant_id)
   and case when not p_write then public.asm_is_admin() or public.asm_trainer_on_attempt(t.id) or t.student_id = public.asm_student_id()
            when split_part(p_name, '/', 2) like 'final-%' then t.state = 'final' and (public.asm_is_admin() or public.asm_can_assess_attempt(t.id))
            -- the acknowledged copy: once the sign-off copy is stored and the student has acknowledged; drawn by the student's browser
            else t.state = 'final' and (public.asm_is_admin() or public.asm_can_assess_attempt(t.id) or t.student_id = public.asm_student_id())
             and exists (select 1 from public.asm_attempt_outputs o where o.attempt_id = t.id and o.kind = 'final')
             and exists (select 1 from public.asm_attempt_signatures x where x.attempt_id = t.id and x.kind = 'student_acknowledgement') end);
$$;
revoke all on function public.asm_output_storage_allowed(text, boolean) from public, anon;
grant execute on function public.asm_output_storage_allowed(text, boolean) to authenticated;
drop policy if exists asm_output_upload on storage.objects;
create policy asm_output_upload on storage.objects for insert to authenticated with check (bucket_id = 'assessment-output' and public.asm_output_storage_allowed(name, true));
drop policy if exists asm_output_read on storage.objects;
create policy asm_output_read on storage.objects for select to authenticated using (bucket_id = 'assessment-output' and public.asm_output_storage_allowed(name, false));
drop policy if exists asm_output_boundary_update on storage.objects;
create policy asm_output_boundary_update on storage.objects as restrictive for update to authenticated using (bucket_id <> 'assessment-output') with check (bucket_id <> 'assessment-output');
drop policy if exists asm_output_boundary_delete on storage.objects;
create policy asm_output_boundary_delete on storage.objects as restrictive for delete to authenticated using (bucket_id <> 'assessment-output');

-- ------------------------------------------------------------------ the trainer's side locks once the result is released
-- (question marks and task results were already locked by asm_results_guard; signatures by their own triggers)
create or replace function public.asm_attempts_decided_lock() returns trigger
language plpgsql set search_path = '' as $$
begin
 if old.state in ('returned', 'final') and new.state <> 'void' and (
    new.outcome is distinct from old.outcome or new.overall_feedback is distinct from old.overall_feedback
    or new.assessor_responses is distinct from old.assessor_responses or new.marked_by is distinct from old.marked_by
    or new.returned_at is distinct from old.returned_at or (old.finalised_at is not null and new.finalised_at is distinct from old.finalised_at)) then
  raise exception 'A released result is locked: its outcome, feedback and trainer fields cannot change' using errcode = '42501';
 end if;
 return new;
end $$;
drop trigger if exists asm_attempts_decided_lock on public.asm_attempts;
create trigger asm_attempts_decided_lock before update on public.asm_attempts for each row execute function public.asm_attempts_decided_lock();
revoke all on function public.asm_attempts_decided_lock() from public, anon, authenticated;

/** The attempt's marking as released: question marks, task results, outcome, feedback, the trainer's fields, the sign-off. */
create or replace function public.asm_attempt_marking(p_attempt uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'results', coalesce((select jsonb_agg(jsonb_build_object('questionId', r.question_id, 'outcome', r.outcome, 'feedback', r.feedback) order by r.question_id) from public.asm_results r where r.attempt_id = t.id and r.criterion_id is null), '[]'::jsonb),
  'taskResults', coalesce((select jsonb_agg(jsonb_build_object('taskId', x.task_id, 'outcome', x.outcome, 'feedback', x.feedback, 'signedAt', x.signed_at) order by x.task_id) from public.asm_task_results x where x.attempt_id = t.id), '[]'::jsonb),
  'outcome', t.outcome, 'overallFeedback', t.overall_feedback, 'assessor', jsonb_build_object('pdf', coalesce(t.assessor_responses->'pdf', '{}'::jsonb), 'pdfChoice', coalesce(t.assessor_responses->'pdfChoice', '{}'::jsonb)),
  'signoff', (select jsonb_build_object('signerName', x.signer_name, 'signedAt', x.signed_at, 'png', encode(sha256(convert_to(coalesce(x.signature_png, ''), 'UTF8')), 'hex')) from public.asm_attempt_signatures x where x.attempt_id = t.id and x.kind = 'assessor_signoff'))
 from public.asm_attempts t where t.id = p_attempt;
$$;
revoke all on function public.asm_attempt_marking(uuid) from public, anon, authenticated;

/** The student's acknowledgement as printed: who, when, the statement, and the SHA-256 of the signature picture. */
create or replace function public.asm_attempt_acknowledgement(p_attempt uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce((select jsonb_build_object('signerName', x.signer_name, 'signedAt', x.signed_at, 'statement', x.statement,
   'png', encode(sha256(convert_to(coalesce(x.signature_png, ''), 'UTF8')), 'hex'))
  from public.asm_attempt_signatures x where x.attempt_id = p_attempt and x.kind = 'student_acknowledgement'), '{}'::jsonb);
$$;
revoke all on function public.asm_attempt_acknowledgement(uuid) from public, anon, authenticated;

/**
 * Records a stored PDF of a final attempt (drawn from its snapshot, uploaded first under its SHA-256); the first of each kind stands.
 *  final         at the trainer's final sign-off (an assessor of the attempt or an admin);
 *  acknowledged  once the student has acknowledged the result, after the sign-off copy (the student, an assessor or an admin):
 *                the official record from then on. Each copy keeps the snapshot, marking and acknowledgement hashes it was drawn from.
 */
drop function if exists public.asm_pdf_output_record(uuid, text, text);
create or replace function public.asm_pdf_output_record(p_attempt uuid, p_path text, p_sha256 text, p_kind text default 'final') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.asm_attempts; s public.asm_attempt_snapshots; o public.asm_attempt_outputs; v_marking jsonb; v_ack jsonb := '{}'::jsonb; v_actor text;
begin
 if p_kind is null or p_kind not in ('final', 'acknowledged') then raise exception 'Unknown PDF kind' using errcode = '22023'; end if;
 select * into t from public.asm_attempts where id = p_attempt and public.tenant_scope(tenant_id);
 if t.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
 v_actor := case when public.asm_is_admin() then 'admin' when public.asm_can_assess_attempt(p_attempt) then 'trainer'
                 when p_kind = 'acknowledged' and t.student_id = public.asm_student_id() then 'student' end;
 if v_actor is null then raise exception 'Only an assessor of this attempt stores its PDF' using errcode = '42501'; end if;
 if t.state <> 'final' then raise exception 'The PDF is stored when the result is final' using errcode = '22023'; end if;
 select * into o from public.asm_attempt_outputs where attempt_id = p_attempt and kind = p_kind;
 if o.attempt_id is not null then return to_jsonb(o); end if;
 if p_kind = 'acknowledged' then
  if not exists (select 1 from public.asm_attempt_outputs x where x.attempt_id = p_attempt and x.kind = 'final') then raise exception 'The sign-off copy is stored first' using errcode = '22023'; end if;
  v_ack := public.asm_attempt_acknowledgement(p_attempt);
  if v_ack = '{}'::jsonb then raise exception 'The student has not acknowledged the result yet' using errcode = '22023'; end if;
 end if;
 select * into s from public.asm_attempt_snapshots where attempt_id = p_attempt;
 if s.attempt_id is null then raise exception 'The attempt has no submitted snapshot' using errcode = 'P0002'; end if;
 if coalesce(p_sha256, '') !~ '^[a-f0-9]{64}$' or p_path <> p_attempt::text || '/' || p_kind || '-' || p_sha256 || '.pdf' then raise exception 'The file name must be its SHA-256' using errcode = '22023'; end if;
 if not exists (select 1 from storage.objects x where x.bucket_id = 'assessment-output' and x.name = p_path) then raise exception 'Upload the PDF first' using errcode = 'P0002'; end if;
 v_marking := public.asm_attempt_marking(p_attempt);
 insert into public.asm_attempt_outputs(attempt_id, kind, tenant_id, path, pdf_sha256, snapshot_hash, created_by, marking, marking_hash, acknowledgement, acknowledgement_hash)
 values (p_attempt, p_kind, t.tenant_id, p_path, p_sha256, s.hash, auth.uid(), v_marking, encode(sha256(convert_to(v_marking::text, 'UTF8')), 'hex'),
  v_ack, case when v_ack = '{}'::jsonb then '' else encode(sha256(convert_to(v_ack::text, 'UTF8')), 'hex') end) returning * into o;
 perform public.asm_log(v_actor, case when p_kind = 'final' then 'final_pdf_store' else 'acknowledged_pdf_store' end, 'attempt', p_attempt::text,
  jsonb_build_object('path', p_path, 'pdfSha256', p_sha256, 'snapshotHash', s.hash, 'markingHash', o.marking_hash, 'acknowledgementHash', o.acknowledgement_hash), t.tenant_id);
 return to_jsonb(o);
end $$;
revoke all on function public.asm_pdf_output_record(uuid, text, text, text) from public, anon;
grant execute on function public.asm_pdf_output_record(uuid, text, text, text) to authenticated;

-- ------------------------------------------------------------------ everything that draws an attempt's PDF
create or replace function public.asm_pdf_attempt(p_attempt uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.asm_attempts; v public.asm_versions; v_role text;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 select * into t from public.asm_attempts where id = p_attempt and public.tenant_scope(tenant_id);
 if t.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
 if public.asm_is_admin() or public.asm_trainer_on_attempt(p_attempt) then v_role := 'trainer';
 elsif t.student_id = public.asm_student_id() and t.state <> 'draft' then v_role := 'student';
 else raise exception 'Not your attempt' using errcode = '42501';
 end if;
 select * into v from public.asm_versions where id = t.version_id;
 if v.template is null then return null; end if;
 return jsonb_build_object(
  'attemptId', t.id, 'attemptNo', t.attempt_no, 'role', v_role, 'canAssess', v_role = 'trainer' and (public.asm_is_admin() or public.asm_can_assess_attempt(p_attempt)),
  'template', v.template,
  'attempts', coalesce((select jsonb_agg(public.asm_attempt_json(a.id, v_role) || jsonb_build_object(
     'snapshot', (select jsonb_build_object('answers', s.answers, 'signatures', s.signatures, 'record', s.record, 'hash', s.hash, 'createdAt', s.created_at) from public.asm_attempt_snapshots s where s.attempt_id = a.id),
     'signoff', (select public.asm_signature_json(x) from public.asm_attempt_signatures x where x.attempt_id = a.id and x.kind = 'assessor_signoff'),
     'acknowledgement', (select public.asm_signature_json(x) from public.asm_attempt_signatures x where x.attempt_id = a.id and x.kind = 'student_acknowledgement'),
     -- output = the official record: the acknowledged copy when there is one, else the sign-off copy; outputs = both
     'output', (select jsonb_build_object('kind', o.kind, 'path', o.path, 'pdfSha256', o.pdf_sha256, 'snapshotHash', o.snapshot_hash, 'markingHash', o.marking_hash, 'acknowledgementHash', o.acknowledgement_hash, 'createdAt', o.created_at)
       from public.asm_attempt_outputs o where o.attempt_id = a.id order by (o.kind = 'acknowledged') desc limit 1),
     'outputs', coalesce((select jsonb_agg(jsonb_build_object('kind', o.kind, 'path', o.path, 'pdfSha256', o.pdf_sha256, 'snapshotHash', o.snapshot_hash, 'markingHash', o.marking_hash, 'acknowledgementHash', o.acknowledgement_hash, 'createdAt', o.created_at) order by o.created_at)
       from public.asm_attempt_outputs o where o.attempt_id = a.id), '[]'::jsonb))
    order by a.attempt_no)
   from public.asm_attempts a where a.assignment_id = t.assignment_id and a.student_id = t.student_id and a.state <> 'void' and a.attempt_no <= t.attempt_no), '[]'::jsonb));
end $$;
revoke all on function public.asm_pdf_attempt(uuid) from public, anon;
grant execute on function public.asm_pdf_attempt(uuid) to authenticated;
