-- ASM-AI-IMPORT stage 3 (2026-11-25, owner): signatures on an assessment attempt, and a saved signature per person.
--
-- asm_attempt_signatures: one row per attempt and kind, never changed afterwards:
--   student_declaration      the student signs the declaration before starting (attempt still a draft)
--   assessor_signoff         the assessor signs off the results (stage 4)
--   student_acknowledgement  the student signs that they have read the feedback (returned / final; also sets acknowledged_at)
-- Each row records the picture (PNG, base64 as the signing page makes it), the name, who signed (auth user), when, and the login
-- details of the request (email and session from the JWT, the client address and browser from the request headers). The workbook
-- PDF stamps them where the workbook expects them (stage 5).
-- asm_saved_signatures: a person's own signature, drawn or uploaded once and applied with one click (trainers' sign-off; students
-- may use it too). A CMS user's existing cms_users.signature_png is offered when they have not saved one here.

create table public.asm_attempt_signatures (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete restrict,
 attempt_id uuid not null references public.asm_attempts(id) on delete cascade,
 kind text not null check (kind in ('student_declaration', 'assessor_signoff', 'student_acknowledgement')),
 signer_user uuid not null,
 signer_role text not null check (signer_role in ('student', 'assessor')),
 signer_name text not null check (char_length(btrim(signer_name)) between 1 and 200),
 method text not null check (method in ('drawn', 'uploaded', 'saved', 'typed')),
 signature_png text check (signature_png is null or (length(signature_png) between 100 and 400000 and signature_png ~ '^[A-Za-z0-9+/]+=*$')),
 statement text not null default '',
 signed_at timestamptz not null default now(),
 login jsonb not null default '{}',
 unique (attempt_id, kind),
 check (method = 'typed' or signature_png is not null)
);
create index asm_attempt_signatures_attempt on public.asm_attempt_signatures(attempt_id);
create trigger asm_attempt_signatures_tenant before insert or update on public.asm_attempt_signatures for each row execute function public.asm_bind_tenant('public.asm_attempts', 'attempt_id');
create or replace function public.asm_attempt_signatures_frozen() returns trigger language plpgsql set search_path = '' as $$
begin
 raise exception 'A signature is never changed or removed' using errcode = '42501';
end $$;
create trigger asm_attempt_signatures_frozen before update or delete on public.asm_attempt_signatures for each row when (pg_trigger_depth() = 0) execute function public.asm_attempt_signatures_frozen();
revoke all on function public.asm_attempt_signatures_frozen() from public, anon, authenticated;
alter table public.asm_attempt_signatures enable row level security;
revoke all on public.asm_attempt_signatures from anon, authenticated;

create table public.asm_saved_signatures (
 user_id uuid primary key,
 signature_png text not null check (length(signature_png) between 100 and 400000 and signature_png ~ '^[A-Za-z0-9+/]+=*$'),
 method text not null default 'drawn' check (method in ('drawn', 'uploaded')),
 updated_at timestamptz not null default now()
);
alter table public.asm_saved_signatures enable row level security;
revoke all on public.asm_saved_signatures from anon, authenticated;

-- The request's login details (never a secret: no token, only who / where from).
create or replace function public.asm_login_details() returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_strip_nulls(jsonb_build_object(
  'userId', auth.uid(),
  'email', auth.jwt()->>'email',
  'sessionId', auth.jwt()->>'session_id',
  'authMethod', (auth.jwt()->'amr'->0->>'method'),
  'ip', nullif(btrim(split_part(coalesce(current_setting('request.headers', true)::jsonb->>'x-forwarded-for', ''), ',', 1)), ''),
  'userAgent', left(current_setting('request.headers', true)::jsonb->>'user-agent', 300)));
$$;
revoke all on function public.asm_login_details() from public, anon;
grant execute on function public.asm_login_details() to authenticated;

create or replace function public.asm_signature_json(s public.asm_attempt_signatures) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('id', s.id, 'attemptId', s.attempt_id, 'kind', s.kind, 'signerRole', s.signer_role, 'signerName', s.signer_name, 'method', s.method,
  'signaturePng', s.signature_png, 'statement', s.statement, 'signedAt', s.signed_at, 'signerUser', s.signer_user);
$$;
revoke all on function public.asm_signature_json(public.asm_attempt_signatures) from public, anon, authenticated;

/**
 * Signs an attempt. p_method 'saved' uses the caller's saved signature; 'drawn' / 'uploaded' take p_png; 'typed' only the name.
 * Who may sign: the attempt's student (declaration on a draft, acknowledgement on a returned / final attempt with an assessor
 * sign-off or a decided outcome); an assessor of the attempt or an admin (sign-off on a marked attempt). Returns the signature.
 */
create or replace function public.asm_sign(p_attempt uuid, p_kind text, p_method text, p_png text default null, p_statement text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.asm_attempts; v_student uuid := public.asm_student_id(); v_png text; v_name text; v_role text; s public.asm_attempt_signatures;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if p_kind not in ('student_declaration', 'assessor_signoff', 'student_acknowledgement') then raise exception 'Unknown signature' using errcode = '22023'; end if;
 if p_method not in ('drawn', 'uploaded', 'saved', 'typed') then raise exception 'Unknown signing method' using errcode = '22023'; end if;
 select * into t from public.asm_attempts where id = p_attempt and public.tenant_scope(tenant_id) for update;
 if t.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
 if p_kind in ('student_declaration', 'student_acknowledgement') then
  if v_student is null or t.student_id <> v_student then raise exception 'Only the student signs this' using errcode = '42501'; end if;
  if p_kind = 'student_declaration' and t.state <> 'draft' then raise exception 'The declaration is signed before the work is submitted' using errcode = '22023'; end if;
  if p_kind = 'student_acknowledgement' and t.state not in ('returned', 'final') then raise exception 'There are no results to acknowledge yet' using errcode = '22023'; end if;
  v_role := 'student';
  select full_name into v_name from public.enrollment_students where id = t.student_id;
 else
  if not (public.asm_is_admin() or public.asm_can_assess_attempt(p_attempt)) then raise exception 'Only an assessor of this attempt signs it off' using errcode = '42501'; end if;
  if t.state not in ('submitted', 'marking', 'returned', 'final') then raise exception 'Mark the attempt before signing it off' using errcode = '22023'; end if;
  v_role := 'assessor';
  v_name := public.asm_person_name(auth.uid());
 end if;
 -- signed already: the first signature stands (after the checks above: only someone allowed to sign it sees it)
 select * into s from public.asm_attempt_signatures where attempt_id = p_attempt and kind = p_kind;
 if s.id is not null then return public.asm_signature_json(s); end if;
 if p_method = 'saved' then
  select signature_png into v_png from public.asm_saved_signatures where user_id = auth.uid();
  if v_png is null then select signature_png into v_png from public.cms_users where auth_user_id = auth.uid() and signature_png is not null limit 1; end if;
  if v_png is null then raise exception 'You have no saved signature yet' using errcode = 'P0002'; end if;
 elsif p_method in ('drawn', 'uploaded') then
  v_png := p_png;
  if v_png is null then raise exception 'Draw or upload your signature' using errcode = '22023'; end if;
 end if;
 insert into public.asm_attempt_signatures(attempt_id, kind, signer_user, signer_role, signer_name, method, signature_png, statement, login)
 values (p_attempt, p_kind, auth.uid(), v_role, coalesce(nullif(btrim(v_name), ''), auth.jwt()->>'email', 'Signed'), p_method, v_png, left(coalesce(p_statement, ''), 2000), public.asm_login_details())
 returning * into s;
 if p_kind = 'student_acknowledgement' and t.acknowledged_at is null then update public.asm_attempts set acknowledged_at = s.signed_at where id = p_attempt; end if;
 perform public.asm_log(case when v_role = 'assessor' then (case when public.asm_is_admin() then 'admin' else 'trainer' end) else v_role end, 'sign_' || p_kind, 'attempt', p_attempt::text, jsonb_build_object('signatureId', s.id, 'method', p_method), t.tenant_id);
 return public.asm_signature_json(s);
end $$;

create or replace function public.asm_signatures(p_attempt uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.asm_attempts;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 select * into t from public.asm_attempts where id = p_attempt and public.tenant_scope(tenant_id);
 if t.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
 if not (public.asm_is_admin() or public.asm_trainer_on_attempt(p_attempt) or t.student_id = public.asm_student_id()) then raise exception 'Not allowed' using errcode = '42501'; end if;
 -- every attempt of this student and assignment (later attempts fill further rows on the PDF)
 return coalesce((select jsonb_agg(public.asm_signature_json(s) || jsonb_build_object('attemptNo', a.attempt_no) order by a.attempt_no, s.signed_at)
   from public.asm_attempt_signatures s join public.asm_attempts a on a.id = s.attempt_id
   where a.assignment_id = t.assignment_id and a.student_id = t.student_id), '[]'::jsonb);
end $$;

create or replace function public.asm_my_signature() returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('signaturePng', coalesce((select signature_png from public.asm_saved_signatures where user_id = auth.uid()),
   (select signature_png from public.cms_users where auth_user_id = auth.uid() and signature_png is not null limit 1)),
  'name', public.asm_person_name(auth.uid()), 'updatedAt', (select updated_at from public.asm_saved_signatures where user_id = auth.uid()));
$$;

create or replace function public.asm_my_signature_save(p_png text, p_method text default 'drawn') returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if p_png is null then delete from public.asm_saved_signatures where user_id = auth.uid(); return public.asm_my_signature(); end if;
 insert into public.asm_saved_signatures(user_id, signature_png, method) values (auth.uid(), p_png, coalesce(p_method, 'drawn'))
 on conflict (user_id) do update set signature_png = excluded.signature_png, method = excluded.method, updated_at = now();
 return public.asm_my_signature();
end $$;

revoke all on function public.asm_sign(uuid, text, text, text, text), public.asm_signatures(uuid), public.asm_my_signature(), public.asm_my_signature_save(text, text) from public, anon;
grant execute on function public.asm_sign(uuid, text, text, text, text), public.asm_signatures(uuid), public.asm_my_signature(), public.asm_my_signature_save(text, text) to authenticated;
