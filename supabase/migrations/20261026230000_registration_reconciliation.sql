-- P08-03: reconciliation and exception handling for manual registrations. Reviewed manual actions only; nothing here
-- reads from or writes to any external or government system, and no external API behaviour is assumed.
-- Exceptions are COMPUTED from current data (never stored), so they cannot drift from the records:
--   enrolled_without_verified   the application reads enrolled but has no verified registration (owner decision: listed, not blocked)
--   lodged_stale                a registration has been lodged for more than 14 days without verification
--   verified_application_closed a verified registration belongs to an application that is now withdrawn or rejected
--   possible_duplicate          two applications of one institution with the same student name and date of birth both hold a verified registration
-- A reviewer can accept an exception with a note (or reopen it); the decision is an append-only review row and an audit entry,
-- and the exception stays visible, marked as accepted. Corrections never overwrite history: a CoE number is corrected through
-- portal_registration_correct_coe, which records old value, new value, reason and actor in an append-only corrections table, adds a
-- history entry and an audit entry, and keeps all evidence. Cancelling and replacing a registration remains the other correction path.
-- Every action requires the admissions-reviewer authority of P08-01 and the caller's tenant scope.
--
-- Rollback / compensation (additive; run manually, only if no review or correction data must be kept):
--   drop function if exists public.portal_registration_exceptions(), public.portal_registration_review_exception(uuid, text, text, text),
--     public.portal_registration_correct_coe(uuid, text, text), public.portal_registration_exception_kinds(uuid);
--   drop table if exists public.enrollment_registration_reviews, public.enrollment_registration_corrections;
-- Never applied to the hosted project without release approval.
begin;

create table public.enrollment_registration_corrections(
  id bigint generated always as identity primary key,
  registration_id uuid not null references public.enrollment_registrations(id) on delete restrict,
  tenant_id uuid,
  field text not null check (field in ('coe_number')),
  old_value text,
  new_value text not null,
  reason text not null check (length(trim(reason)) between 1 and 500),
  actor uuid,
  actor_name text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  foreign key (registration_id, tenant_id) references public.enrollment_registrations(id, tenant_id)
);
create table public.enrollment_registration_reviews(
  id bigint generated always as identity primary key,
  application_id uuid not null references public.enrollment_applications(id) on delete restrict,
  tenant_id uuid,
  kind text not null check (kind in ('enrolled_without_verified', 'lodged_stale', 'verified_application_closed', 'possible_duplicate')),
  decision text not null check (decision in ('accept', 'reopen')),
  note text not null check (length(trim(note)) between 1 and 500),
  actor uuid,
  actor_name text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  foreign key (application_id, tenant_id) references public.enrollment_applications(id, tenant_id)
);
create index enrollment_registration_reviews_lookup on public.enrollment_registration_reviews(application_id, kind, id desc);
create trigger registration_corrections_append_only before update or delete on public.enrollment_registration_corrections for each row execute function public.portal_registration_guard();
create trigger registration_reviews_append_only before update or delete on public.enrollment_registration_reviews for each row execute function public.portal_registration_guard();
alter table public.enrollment_registration_corrections enable row level security;
alter table public.enrollment_registration_reviews enable row level security;
revoke all on public.enrollment_registration_corrections, public.enrollment_registration_reviews from public, anon, authenticated, service_role;
grant select on public.enrollment_registration_corrections, public.enrollment_registration_reviews to service_role;

create function public.portal_registration_exception_kinds(p_application uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_remove(array[
    case when a.status = 'enrolled' and not exists (select 1 from public.enrollment_registrations v where v.application_id = a.id and v.state = 'verified') then 'enrolled_without_verified' end,
    case when exists (select 1 from public.enrollment_registrations l where l.application_id = a.id and l.state = 'lodged' and l.lodged_at < now() - interval '14 days') then 'lodged_stale' end,
    case when a.status in ('withdrawn', 'rejected') and exists (select 1 from public.enrollment_registrations v where v.application_id = a.id and v.state = 'verified') then 'verified_application_closed' end,
    case when exists (select 1 from public.enrollment_registrations v where v.application_id = a.id and v.state = 'verified')
      and nullif(lower(trim(a.student_name)), '') is not null and nullif(a.data #>> '{values,dob}', '') is not null
      and exists (select 1 from public.enrollment_applications b join public.enrollment_registrations rb on rb.application_id = b.id and rb.state = 'verified'
        where b.id <> a.id and b.tenant_id is not distinct from a.tenant_id and lower(trim(b.student_name)) = lower(trim(a.student_name)) and (b.data #>> '{values,dob}') = (a.data #>> '{values,dob}')) then 'possible_duplicate' end
  ], null), '{}'::text[])
  from public.enrollment_applications a where a.id = p_application;
$$;

create function public.portal_registration_exceptions() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.portal_is_slit_admin() then raise exception 'Reviewer access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x.item order by x.reference, x.kind) from (
    select k.kind, coalesce(nullif(a.reference, ''), left(a.id::text, 8)) as reference,
      jsonb_build_object('kind', k.kind, 'applicationId', a.id, 'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)), 'studentName', a.student_name, 'status', a.status,
        'registration', (select jsonb_build_object('id', r.id, 'state', r.state, 'coeNumber', r.coe_number, 'lodgedAt', r.lodged_at)
          from public.enrollment_registrations r where r.application_id = a.id order by (r.state <> 'cancelled') desc, r.created_at desc limit 1),
        'accepted', (select jsonb_build_object('by', rv.actor_name, 'at', rv.created_at, 'note', rv.note) from public.enrollment_registration_reviews rv
          where rv.application_id = a.id and rv.kind = k.kind and rv.decision = 'accept'
            and not exists (select 1 from public.enrollment_registration_reviews later where later.application_id = rv.application_id and later.kind = rv.kind and later.id > rv.id)
          order by rv.id desc limit 1)) as item
    from public.enrollment_applications a
    cross join lateral unnest(public.portal_registration_exception_kinds(a.id)) as k(kind)
    where a.status in ('offer_accepted', 'coe_issued', 'enrolled', 'withdrawn', 'rejected') and public.portal_can_access_application(a.id)
    limit 500) x), '[]'::jsonb);
end;
$$;

create function public.portal_registration_review_exception(p_application uuid, p_kind text, p_decision text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; v_name text;
begin
  a := public.portal_registration_authority(p_application);
  if p_kind is null or p_kind not in ('enrolled_without_verified', 'lodged_stale', 'verified_application_closed', 'possible_duplicate') then raise exception 'Unknown exception' using errcode = '22023'; end if;
  if p_decision is null or p_decision not in ('accept', 'reopen') then raise exception 'Unknown decision' using errcode = '22023'; end if;
  if nullif(trim(coalesce(p_note, '')), '') is null then raise exception 'A note is required' using errcode = '22023'; end if;
  if p_decision = 'accept' and not (p_kind = any (public.portal_registration_exception_kinds(a.id))) then raise exception 'This application has no such exception' using errcode = '22023'; end if;
  if p_decision = 'reopen' and not exists (select 1 from public.enrollment_registration_reviews where application_id = a.id and kind = p_kind and decision = 'accept') then raise exception 'There is no accepted exception to reopen' using errcode = '22023'; end if;
  v_name := coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', 'Reviewer');
  insert into public.enrollment_registration_reviews(application_id, tenant_id, kind, decision, note, actor, actor_name) values (a.id, a.tenant_id, p_kind, p_decision, left(trim(p_note), 500), auth.uid(), v_name);
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
  values (auth.uid(), v_name, 'slit_admin', 'registration_exception_' || p_decision, 'registration', a.id::text, a.id, jsonb_build_object('kind', p_kind, 'note', left(trim(p_note), 500)));
end;
$$;

create function public.portal_registration_correct_coe(p_registration uuid, p_new_coe text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r public.enrollment_registrations; a public.enrollment_applications; v_new text := upper(trim(coalesce(p_new_coe, ''))); v_name text; v_reason text := left(trim(coalesce(p_reason, '')), 500);
begin
  select * into r from public.enrollment_registrations where id = p_registration;
  if not found then raise exception 'Registration not found' using errcode = 'P0002'; end if;
  a := public.portal_registration_authority(r.application_id);
  select * into r from public.enrollment_registrations where id = p_registration for update;
  if r.state <> 'verified' then raise exception 'Only a verified registration has a CoE number to correct' using errcode = '22023'; end if;
  if v_new !~ '^[A-Z0-9-]{6,20}$' then raise exception 'A CoE number of 6-20 letters, digits or hyphens is required' using errcode = '22023'; end if;
  if v_new = r.coe_number then raise exception 'The CoE number is unchanged' using errcode = '22023'; end if;
  if v_reason = '' then raise exception 'A reason is required' using errcode = '22023'; end if;
  v_name := coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', 'Reviewer');
  update public.enrollment_registrations set coe_number = v_new, updated_at = now() where id = r.id;
  insert into public.enrollment_registration_corrections(registration_id, tenant_id, field, old_value, new_value, reason, actor, actor_name) values (r.id, r.tenant_id, 'coe_number', r.coe_number, v_new, v_reason, auth.uid(), v_name);
  insert into public.enrollment_registration_history(registration_id, tenant_id, from_state, to_state, actor, actor_name, note) values (r.id, r.tenant_id, 'verified', 'verified', auth.uid(), v_name, left('CoE number corrected: ' || v_reason, 500));
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
  values (auth.uid(), v_name, 'slit_admin', 'registration_corrected', 'registration', r.id::text, a.id, jsonb_build_object('field', 'coe_number', 'from', r.coe_number, 'to', v_new, 'reason', v_reason));
end;
$$;

revoke all on function public.portal_registration_exception_kinds(uuid), public.portal_registration_exceptions(), public.portal_registration_review_exception(uuid, text, text, text),
  public.portal_registration_correct_coe(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.portal_registration_exceptions(), public.portal_registration_review_exception(uuid, text, text, text), public.portal_registration_correct_coe(uuid, text, text) to authenticated;

commit;
