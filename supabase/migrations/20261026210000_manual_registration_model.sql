-- P08-01: manual external-registration (CoE) model. No automated government interaction: an operator registers the
-- student in the external system by hand and records the result here.
-- `coe_issued` (the application's internal admissions status) is deliberately separate from a VERIFIED external
-- registration (this table): neither command changes the other, and verification needs an application that already
-- reads coe_issued/enrolled, a well-formed CoE number and recorded evidence.
-- Lifecycle: draft -> lodged -> verified; draft/lodged/verified -> cancelled (reason required, terminal). A cancelled
-- registration frees the application and its CoE number for a replacement; nothing is ever deleted or rewritten.
-- Authority: the same reviewers as the admissions status command (portal_is_slit_admin + portal_can_access_application,
-- which follow the pinned role configuration). Agency users and editors cannot act or read this data.
-- History and evidence are append-only (trigger-enforced). All writes go through the commands below; browser roles have
-- read-only access limited to reviewers of the application.
--
-- Rollback / compensation (additive; run manually, only before any registration data must be kept):
--   drop function if exists public.portal_registration_create(uuid, text), public.portal_registration_add_evidence(uuid, text, text, uuid),
--     public.portal_registration_transition(uuid, text, text, text), public.portal_registration_authority(uuid), public.portal_registration_guard();
--   drop table if exists public.enrollment_registration_history, public.enrollment_registration_evidence, public.enrollment_registrations;
-- Never applied to the hosted project without release approval.
begin;

create table public.enrollment_registrations(
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.enrollment_applications(id) on delete restrict,
  tenant_id uuid,
  state text not null default 'draft' check (state in ('draft', 'lodged', 'verified', 'cancelled')),
  coe_number text check (coe_number ~ '^[A-Z0-9-]{6,20}$'),
  created_by uuid,
  created_at timestamptz not null default now(),
  lodged_at timestamptz,
  lodged_by uuid,
  verified_at timestamptz,
  verified_by uuid,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text,
  updated_at timestamptz not null default now(),
  foreign key (application_id, tenant_id) references public.enrollment_applications(id, tenant_id),
  unique (id, tenant_id),
  check (state not in ('lodged', 'verified') or (lodged_at is not null and lodged_by is not null)),
  check (state <> 'verified' or (coe_number is not null and verified_at is not null and verified_by is not null)),
  check (state <> 'cancelled' or (cancelled_at is not null and cancelled_by is not null and length(trim(coalesce(cancel_reason, ''))) > 0))
);
create unique index enrollment_registrations_one_active on public.enrollment_registrations(application_id) where state <> 'cancelled';
create unique index enrollment_registrations_coe on public.enrollment_registrations((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), coe_number) where coe_number is not null and state <> 'cancelled';

create table public.enrollment_registration_evidence(
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.enrollment_registrations(id) on delete restrict,
  tenant_id uuid,
  kind text not null check (kind in ('external_confirmation', 'coe_document', 'correspondence', 'other')),
  description text not null check (length(trim(description)) between 1 and 500),
  document_id uuid references public.enrollment_application_documents(id) on delete restrict,
  recorded_by uuid,
  recorded_at timestamptz not null default now(),
  foreign key (registration_id, tenant_id) references public.enrollment_registrations(id, tenant_id)
);
create index enrollment_registration_evidence_registration on public.enrollment_registration_evidence(registration_id);

create table public.enrollment_registration_history(
  id bigint generated always as identity primary key,
  registration_id uuid not null references public.enrollment_registrations(id) on delete restrict,
  tenant_id uuid,
  from_state text,
  to_state text not null,
  actor uuid,
  actor_name text not null default '',
  note text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  foreign key (registration_id, tenant_id) references public.enrollment_registrations(id, tenant_id)
);
create index enrollment_registration_history_registration on public.enrollment_registration_history(registration_id, id);

create function public.portal_registration_guard() returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'Registration history and evidence are append-only' using errcode = '55000';
end;
$$;
create trigger registration_history_append_only before update or delete on public.enrollment_registration_history for each row execute function public.portal_registration_guard();
create trigger registration_evidence_append_only before update or delete on public.enrollment_registration_evidence for each row execute function public.portal_registration_guard();

alter table public.enrollment_registrations enable row level security;
alter table public.enrollment_registration_evidence enable row level security;
alter table public.enrollment_registration_history enable row level security;
revoke all on public.enrollment_registrations, public.enrollment_registration_evidence, public.enrollment_registration_history from public, anon, authenticated, service_role;
grant select on public.enrollment_registrations, public.enrollment_registration_evidence, public.enrollment_registration_history to authenticated, service_role;
create policy registration_read on public.enrollment_registrations for select to authenticated
  using (public.portal_is_slit_admin() and public.portal_can_access_application(application_id));
create policy registration_evidence_read on public.enrollment_registration_evidence for select to authenticated
  using (exists (select 1 from public.enrollment_registrations r where r.id = registration_id and public.portal_is_slit_admin() and public.portal_can_access_application(r.application_id)));
create policy registration_history_read on public.enrollment_registration_history for select to authenticated
  using (exists (select 1 from public.enrollment_registrations r where r.id = registration_id and public.portal_is_slit_admin() and public.portal_can_access_application(r.application_id)));

-- Locks the application (same order as the admissions status command) and proves the caller is a reviewer of it.
create function public.portal_registration_authority(p_application uuid) returns public.enrollment_applications
language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications;
begin
  select * into a from public.enrollment_applications where id = p_application for update;
  if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
  return a;
end;
$$;

create function public.portal_registration_create(p_application uuid, p_note text default '') returns uuid
language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; v_id uuid; v_name text;
begin
  a := public.portal_registration_authority(p_application);
  if a.status not in ('offer_accepted', 'coe_issued', 'enrolled') then raise exception 'Registration starts after the offer is accepted' using errcode = '22023'; end if;
  if exists (select 1 from public.enrollment_registrations where application_id = a.id and state <> 'cancelled') then raise exception 'This application already has an active registration' using errcode = '23505'; end if;
  insert into public.enrollment_registrations(application_id, tenant_id, created_by) values (a.id, a.tenant_id, auth.uid()) returning id into v_id;
  v_name := coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', 'Reviewer');
  insert into public.enrollment_registration_history(registration_id, tenant_id, from_state, to_state, actor, actor_name, note) values (v_id, a.tenant_id, null, 'draft', auth.uid(), v_name, left(coalesce(p_note, ''), 500));
  return v_id;
end;
$$;

create function public.portal_registration_add_evidence(p_registration uuid, p_kind text, p_description text, p_document uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare r public.enrollment_registrations; a public.enrollment_applications; v_id uuid;
begin
  select * into r from public.enrollment_registrations where id = p_registration;
  if not found then raise exception 'Registration not found' using errcode = 'P0002'; end if;
  a := public.portal_registration_authority(r.application_id);
  select * into r from public.enrollment_registrations where id = p_registration for update;
  if r.state = 'cancelled' then raise exception 'A cancelled registration accepts no evidence' using errcode = '22023'; end if;
  if p_kind is null or p_kind not in ('external_confirmation', 'coe_document', 'correspondence', 'other') then raise exception 'Unknown evidence kind' using errcode = '22023'; end if;
  if nullif(trim(coalesce(p_description, '')), '') is null or length(trim(p_description)) > 500 then raise exception 'A description of 1-500 characters is required' using errcode = '22023'; end if;
  if p_document is not null and not exists (select 1 from public.enrollment_application_documents d where d.id = p_document and d.application_id = a.id and d.is_current) then
    raise exception 'The document does not belong to this application' using errcode = '22023';
  end if;
  insert into public.enrollment_registration_evidence(registration_id, tenant_id, kind, description, document_id, recorded_by) values (r.id, r.tenant_id, p_kind, trim(p_description), p_document, auth.uid()) returning id into v_id;
  return v_id;
end;
$$;

create function public.portal_registration_transition(p_registration uuid, p_to text, p_coe_number text default null, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare r public.enrollment_registrations; a public.enrollment_applications; v_coe text; v_name text; v_note text := left(trim(coalesce(p_note, '')), 500);
begin
  select * into r from public.enrollment_registrations where id = p_registration;
  if not found then raise exception 'Registration not found' using errcode = 'P0002'; end if;
  a := public.portal_registration_authority(r.application_id);
  select * into r from public.enrollment_registrations where id = p_registration for update;
  if not ((r.state, p_to) in (('draft', 'lodged'), ('lodged', 'verified'), ('draft', 'cancelled'), ('lodged', 'cancelled'), ('verified', 'cancelled'))) then
    raise exception 'Invalid registration transition: % to %', r.state, p_to using errcode = '22023';
  end if;
  if p_to = 'lodged' then
    update public.enrollment_registrations set state = 'lodged', lodged_at = now(), lodged_by = auth.uid(), updated_at = now() where id = r.id;
  elsif p_to = 'verified' then
    if a.status not in ('coe_issued', 'enrolled') then raise exception 'The application must show coe_issued before registration can be verified' using errcode = '22023'; end if;
    v_coe := upper(trim(coalesce(p_coe_number, '')));
    if v_coe !~ '^[A-Z0-9-]{6,20}$' then raise exception 'A CoE number of 6-20 letters, digits or hyphens is required' using errcode = '22023'; end if;
    if not exists (select 1 from public.enrollment_registration_evidence e where e.registration_id = r.id) then raise exception 'Evidence is required before verification' using errcode = '22023'; end if;
    update public.enrollment_registrations set state = 'verified', coe_number = v_coe, verified_at = now(), verified_by = auth.uid(), updated_at = now() where id = r.id;
  else
    if v_note = '' then raise exception 'A reason is required to cancel' using errcode = '22023'; end if;
    update public.enrollment_registrations set state = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = v_note, updated_at = now() where id = r.id;
  end if;
  v_name := coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', 'Reviewer');
  insert into public.enrollment_registration_history(registration_id, tenant_id, from_state, to_state, actor, actor_name, note) values (r.id, r.tenant_id, r.state, p_to, auth.uid(), v_name, v_note);
end;
$$;

revoke all on function public.portal_registration_guard(), public.portal_registration_authority(uuid), public.portal_registration_create(uuid, text),
  public.portal_registration_add_evidence(uuid, text, text, uuid), public.portal_registration_transition(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.portal_registration_create(uuid, text), public.portal_registration_add_evidence(uuid, text, text, uuid),
  public.portal_registration_transition(uuid, text, text, text) to authenticated;

commit;
