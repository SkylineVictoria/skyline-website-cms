-- Office 365 mailboxes for students, created on an administrator's request by the student-office365 Edge Function.
-- Only the account record is kept here; temporary passwords are never stored (they go straight to the student by email).
-- Applied on hosted 2026-11-11 as version 20261111143429.
create table if not exists public.student_office365_accounts (
 student_id uuid primary key references public.enrollment_students(id) on delete cascade,
 upn text not null unique check (upn ~ '^[a-z0-9]([a-z0-9.]*[a-z0-9])?@[a-z0-9.-]+$'),
 ms_user_id text,
 status text not null default 'creating' check (status in ('creating','active','failed')),
 licence_sku text,
 last_error text check (last_error is null or last_error ~ '^[a-z_]{1,60}$'),
 welcome_sent_at timestamptz,
 created_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.student_office365_accounts enable row level security;
revoke all on public.student_office365_accounts from anon, authenticated;

-- State for the student page (and the first step of creation).
create or replace function public.student_o365_prepare(p_student uuid)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare s public.enrollment_students; a public.student_office365_accounts;
begin
 perform public.admin_business_require();
 select * into s from public.enrollment_students where id = p_student;
 if not found then raise exception 'Student not found' using errcode = 'P0002'; end if;
 select * into a from public.student_office365_accounts where student_id = p_student;
 return jsonb_build_object('studentId', s.id, 'fullName', s.full_name, 'personalEmail', s.email, 'studentStatus', s.status,
  'account', case when a.student_id is null then null else jsonb_build_object('email', a.upn, 'status', a.status,
   'lastError', a.last_error, 'welcomeSentAt', a.welcome_sent_at, 'createdAt', a.created_at, 'hasMicrosoftUser', a.ms_user_id is not null) end);
end $$;

-- Reserves an address (or resumes a failed attempt with its existing address). Returns conflict=true when the address is taken.
create or replace function public.student_o365_claim(p_student uuid, p_upn text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare a public.student_office365_accounts; v_upn text := lower(btrim(coalesce(p_upn, '')));
begin
 perform public.admin_business_require();
 perform 1 from public.enrollment_students where id = p_student for update;
 if not found then raise exception 'Student not found' using errcode = 'P0002'; end if;
 select * into a from public.student_office365_accounts where student_id = p_student for update;
 if found then
  if a.status = 'active' then raise exception 'This student already has an Office 365 email' using errcode = '23505'; end if;
  if a.status = 'creating' and a.updated_at > now() - interval '5 minutes' then raise exception 'Creation is already in progress' using errcode = '55P03'; end if;
  update public.student_office365_accounts set status = 'creating', last_error = null, updated_at = now() where student_id = p_student returning * into a;
  return jsonb_build_object('conflict', false, 'upn', a.upn, 'msUserId', a.ms_user_id);
 end if;
 if exists (select 1 from public.student_office365_accounts where upn = v_upn) then return jsonb_build_object('conflict', true); end if;
 insert into public.student_office365_accounts(student_id, upn, created_by) values (p_student, v_upn, auth.uid()) returning * into a;
 return jsonb_build_object('conflict', false, 'upn', a.upn, 'msUserId', null);
end $$;

-- Records the outcome and audits it.
create or replace function public.student_o365_finish(p_student uuid, p_ms_user text, p_ok boolean, p_error text, p_sku text, p_welcome boolean)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare a public.student_office365_accounts; v_agency uuid;
begin
 perform public.admin_business_require();
 update public.student_office365_accounts set
  ms_user_id = coalesce(nullif(p_ms_user, ''), ms_user_id),
  status = case when p_ok then 'active' else 'failed' end,
  last_error = case when p_ok then null else p_error end,
  licence_sku = coalesce(nullif(p_sku, ''), licence_sku),
  welcome_sent_at = case when p_welcome then now() else welcome_sent_at end,
  updated_at = now()
 where student_id = p_student and status = 'creating' returning * into a;
 if not found then raise exception 'No creation in progress for this student' using errcode = 'P0002'; end if;
 select agency_id into v_agency from public.enrollment_students where id = p_student;
 perform public.admin_business_audit(case when p_ok then 'student_office365_created' else 'student_office365_failed' end, v_agency, v_agency,
  jsonb_build_object('student', p_student, 'email', a.upn, 'error', a.last_error, 'welcomeSent', p_welcome));
 return jsonb_build_object('email', a.upn, 'status', a.status, 'lastError', a.last_error, 'welcomeSentAt', a.welcome_sent_at);
end $$;

revoke all on function public.student_o365_prepare(uuid), public.student_o365_claim(uuid, text),
 public.student_o365_finish(uuid, text, boolean, text, text, boolean) from public, anon;
grant execute on function public.student_o365_prepare(uuid), public.student_o365_claim(uuid, text),
 public.student_o365_finish(uuid, text, boolean, text, text, boolean) to authenticated;
