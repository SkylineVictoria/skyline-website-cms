-- Application status configuration (owner brief 2026-11-12, "complete status flow"). LOCAL ONLY until the owner releases it.
-- Idempotent: safe on a database where the tables were made by hand in the SQL Editor, and on one where 20261113260000 made them.
--
--  * application_statuses (key = value): + colour, final, active.
--  * application_status_transitions (PK from_status + action_key): the table 20261113260000 called application_status_actions,
--    renamed, + active, automatic, primary, requires_reason, allowed_roles (the app's real role names), icon. The old name stays as a
--    view of the ACTIVE transitions, so every existing command (offer letter, resend, accept, resubmit, CoE / VoE) checks the same rows.
--  * status_reasons: the reasons offered for Rejected, Withdrawn and Action required ("Other" last, with free text).
--  * change_application_status(application, action_key, payload): the one staff command for status moves, reminders and resends;
--    accept_offer and resubmit stay the applicant's system path; revert_application_status undoes a reason move within 15 seconds.
--  * Admins write the three tables (RLS); every change is in status_config_audit; the tables are in the realtime publication so
--    the pages refresh when they change.
--
-- Roles (allowed_roles), the names the app stores:  Admin (cms_users.role; also Editor exists but has no access to applications),
-- tenant_admin / staff (tenant_memberships.role on a tenant site; editor and viewer have no application review), agent /
-- agency_admin / student (agency_memberships.role, the applicant side). Staff moves: {Admin,tenant_admin,staff}; automatic
-- (applicant) moves: {student,agent,agency_admin}.

/* ------------------------------------------------------------------ statuses */
create table if not exists public.application_statuses (
  value text primary key, label text not null, sort integer not null unique, tone text not null default 'neutral', hint text not null default '',
  editable boolean not null default false, legacy boolean not null default false);
alter table public.application_statuses
  add column if not exists color text not null default '#64748b',
  add column if not exists is_final boolean not null default false,
  add column if not exists is_active boolean not null default true;
do $$ begin
  alter table public.application_statuses add constraint application_statuses_color_check check (color ~ '^#[0-9a-f]{6}$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.application_statuses add constraint application_statuses_value_check check (value ~ '^[a-z][a-z0-9_]{1,40}$');
exception when duplicate_object then null; end $$;

insert into public.application_statuses(value, label, sort, tone, hint, editable, legacy, color, is_final) values
  ('draft', 'Draft', 10, 'neutral', 'Not submitted yet', true, false, '#64748b', false),
  ('submitted', 'Submitted', 20, 'info', 'Ready for offer letter', false, false, '#2563eb', false),
  ('under_review', 'Under review', 25, 'info', 'Ready for offer letter', false, true, '#2563eb', false),
  ('action_required', 'Action required', 30, 'warning', 'Waiting on the student or agent', true, false, '#d97706', false),
  ('offer_issued', 'Offer letter issued', 40, 'info', 'Waiting for the offer to be accepted', false, false, '#7c3aed', false),
  ('offer_accepted', 'Offer accepted', 50, 'success', 'Ready for CoE / VoE', false, false, '#059669', false),
  ('coe_issued', 'CoE / VoE issued', 60, 'success', 'Ready to enrol', false, false, '#0d9488', false),
  ('enrolled', 'Enrolled', 70, 'success', 'Enrolled', false, false, '#15803d', false),
  ('rejected', 'Rejected', 80, 'danger', 'Closed', false, false, '#dc2626', true),
  ('withdrawn', 'Withdrawn', 90, 'muted', 'Closed', false, false, '#6b7280', true)
on conflict (value) do update set label = excluded.label, color = case when public.application_statuses.color = '#64748b' then excluded.color else public.application_statuses.color end,
  is_final = excluded.is_final, hint = excluded.hint;

/* ------------------------------------------------------------------ transitions */
do $$ begin
  if to_regclass('public.application_status_transitions') is null and to_regclass('public.application_status_actions') is not null
     and (select relkind from pg_class where oid = 'public.application_status_actions'::regclass) = 'r' then
    alter table public.application_status_actions rename to application_status_transitions;
    alter table public.application_status_transitions rename column action to action_key;
  end if;
end $$;
create table if not exists public.application_status_transitions (
  from_status text not null references public.application_statuses(value) on update cascade,
  action_key text not null,
  to_status text references public.application_statuses(value) on update cascade,
  actor text not null default 'staff' check (actor in ('staff', 'applicant')),
  label text not null,
  kind text not null default 'status',
  note text not null default 'none' check (note in ('none', 'optional', 'required')),
  tone text not null default 'neutral' check (tone in ('neutral', 'primary', 'danger')),
  sort integer not null default 100,
  primary key (from_status, action_key));
alter table public.application_status_transitions
  add column if not exists is_active boolean not null default true,
  add column if not exists is_automatic boolean not null default false,
  add column if not exists is_primary boolean not null default false,
  add column if not exists requires_reason boolean not null default false,
  add column if not exists allowed_roles text[] not null default '{Admin,tenant_admin,staff}',
  add column if not exists icon text not null default '';
do $$ begin
  alter table public.application_status_transitions add constraint application_status_transitions_key_check check (action_key ~ '^[a-z][a-z0-9_]{1,40}$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.application_status_transitions add constraint application_status_transitions_roles_check
    check (allowed_roles <@ array['Admin', 'Editor', 'tenant_admin', 'staff', 'editor', 'viewer', 'agent', 'agency_admin', 'student']::text[]);
exception when duplicate_object then null; end $$;

-- Kinds: status (a move, maybe with a reason), enrol (a move with the enrolment date), offer_letter / coe (a document first), reminder and
-- resend_offer (no move), accept_offer / resubmit / submit (the applicant).
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.application_status_transitions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%' loop
    execute format('alter table public.application_status_transitions drop constraint %I', c);
  end loop;
  alter table public.application_status_transitions add constraint application_status_transitions_kind_check
    check (kind in ('status', 'enrol', 'offer_letter', 'coe', 'reminder', 'resend_offer', 'accept_offer', 'resubmit', 'submit'));
end $$;

-- The map (must match the pages): primary action first, Reject / Withdraw last (red), the automatic moves locked.
delete from public.application_status_transitions where from_status = 'offer_issued' and action_key = 'mark_accepted';
update public.application_status_transitions set action_key = 'enrol', label = 'Enrol', kind = 'enrol' where from_status = 'coe_issued' and action_key = 'mark_enrolled';
insert into public.application_status_transitions(from_status, action_key, to_status, actor, label, kind, note, tone, sort) values
  ('draft', 'submit', 'submitted', 'applicant', 'Submit application', 'submit', 'none', 'primary', 10),
  ('draft', 'withdraw', 'withdrawn', 'staff', 'Withdraw', 'status', 'required', 'danger', 80),
  ('draft', 'reject', 'rejected', 'staff', 'Reject', 'status', 'required', 'danger', 90),
  ('submitted', 'issue_offer', 'offer_issued', 'staff', 'Issue offer letter', 'offer_letter', 'none', 'primary', 10),
  ('submitted', 'action_required', 'action_required', 'staff', 'Action required', 'status', 'required', 'neutral', 20),
  ('submitted', 'withdraw', 'withdrawn', 'staff', 'Withdraw', 'status', 'required', 'danger', 80),
  ('submitted', 'reject', 'rejected', 'staff', 'Reject', 'status', 'required', 'danger', 90),
  ('under_review', 'issue_offer', 'offer_issued', 'staff', 'Issue offer letter', 'offer_letter', 'none', 'primary', 10),
  ('under_review', 'action_required', 'action_required', 'staff', 'Action required', 'status', 'required', 'neutral', 20),
  ('under_review', 'withdraw', 'withdrawn', 'staff', 'Withdraw', 'status', 'required', 'danger', 80),
  ('under_review', 'reject', 'rejected', 'staff', 'Reject', 'status', 'required', 'danger', 90),
  ('action_required', 'resubmit', 'submitted', 'applicant', 'Resubmitted', 'resubmit', 'optional', 'primary', 5),
  ('action_required', 'send_reminder', null, 'staff', 'Send reminder', 'reminder', 'optional', 'neutral', 10),
  ('action_required', 'withdraw', 'withdrawn', 'staff', 'Withdraw', 'status', 'required', 'danger', 80),
  ('action_required', 'reject', 'rejected', 'staff', 'Reject', 'status', 'required', 'danger', 90),
  ('offer_issued', 'accept_offer', 'offer_accepted', 'applicant', 'Offer accepted', 'accept_offer', 'none', 'primary', 5),
  ('offer_issued', 'resend_offer', null, 'staff', 'Resend offer letter', 'resend_offer', 'optional', 'neutral', 10),
  ('offer_issued', 'withdraw', 'withdrawn', 'staff', 'Withdraw', 'status', 'required', 'danger', 80),
  ('offer_issued', 'reject', 'rejected', 'staff', 'Reject', 'status', 'required', 'danger', 90),
  ('offer_accepted', 'issue_coe', 'coe_issued', 'staff', 'Issue CoE / VoE', 'coe', 'none', 'primary', 10),
  ('offer_accepted', 'withdraw', 'withdrawn', 'staff', 'Withdraw', 'status', 'required', 'danger', 80),
  ('offer_accepted', 'reject', 'rejected', 'staff', 'Reject', 'status', 'required', 'danger', 90),
  ('coe_issued', 'enrol', 'enrolled', 'staff', 'Enrol', 'enrol', 'optional', 'primary', 10),
  ('coe_issued', 'withdraw', 'withdrawn', 'staff', 'Withdraw', 'status', 'required', 'danger', 80),
  ('coe_issued', 'reject', 'rejected', 'staff', 'Reject', 'status', 'required', 'danger', 90),
  ('enrolled', 'withdraw', 'withdrawn', 'staff', 'Withdraw', 'status', 'required', 'danger', 80)
on conflict (from_status, action_key) do update set to_status = excluded.to_status, actor = excluded.actor, label = excluded.label, kind = excluded.kind,
  note = excluded.note, tone = excluded.tone, sort = excluded.sort;
update public.application_status_transitions set
  is_automatic = actor = 'applicant',
  is_primary = action_key in ('issue_offer', 'issue_coe', 'enrol', 'submit', 'resubmit', 'accept_offer'),
  requires_reason = to_status in ('rejected', 'withdrawn', 'action_required') and kind = 'status',
  allowed_roles = case when actor = 'applicant' then '{student,agent,agency_admin}'::text[] else '{Admin,tenant_admin,staff}'::text[] end,
  icon = case action_key when 'issue_offer' then 'ri-mail-send-line' when 'issue_coe' then 'ri-award-line' when 'enrol' then 'ri-graduation-cap-line'
    when 'reject' then 'ri-close-circle-line' when 'withdraw' then 'ri-logout-box-r-line' when 'action_required' then 'ri-error-warning-line'
    when 'send_reminder' then 'ri-notification-3-line' when 'resend_offer' then 'ri-mail-send-line' else icon end;
create unique index if not exists application_status_transitions_one_primary on public.application_status_transitions(from_status) where is_primary and is_active;

-- The old name: the ACTIVE transitions, with the old column name, for every command written against it.
create or replace view public.application_status_actions with (security_invoker = true) as
  select from_status, action_key as action, to_status, actor, label, kind, note, tone, sort from public.application_status_transitions where is_active;
grant select on public.application_status_actions to authenticated;

/* ------------------------------------------------------------------ reasons */
create table if not exists public.status_reasons (
  id uuid primary key default gen_random_uuid(),
  status text not null references public.application_statuses(value) on update cascade on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 120),
  sort integer not null default 100,
  is_other boolean not null default false,
  is_active boolean not null default true);
create unique index if not exists status_reasons_label on public.status_reasons(status, lower(btrim(label)));
create unique index if not exists status_reasons_one_other on public.status_reasons(status) where is_other;
insert into public.status_reasons(status, label, sort, is_other) values
  ('rejected', 'Entry requirements not met', 10, false), ('rejected', 'English language requirement not met', 20, false), ('rejected', 'Incomplete or invalid documents', 30, false),
  ('rejected', 'Genuine student concerns', 40, false), ('rejected', 'Course or intake full', 50, false), ('rejected', 'Other', 1000, true),
  ('withdrawn', 'Student request', 10, false), ('withdrawn', 'Agent request', 20, false), ('withdrawn', 'Enrolled elsewhere', 30, false), ('withdrawn', 'Visa refused', 40, false),
  ('withdrawn', 'No response from the student', 50, false), ('withdrawn', 'Other', 1000, true),
  ('action_required', 'Missing documents', 10, false), ('action_required', 'Passport details to correct', 20, false), ('action_required', 'English test evidence needed', 30, false),
  ('action_required', 'Declaration name and signature do not match', 40, false), ('action_required', 'Other', 1000, true)
on conflict do nothing;

/* ------------------------------------------------------------------ applications.status follows the catalogue */
-- The fixed list of ten values (an older check) would refuse a status added in Settings; the foreign key to application_statuses
-- (20261113260000) is the rule now.
alter table public.enrollment_applications drop constraint if exists enrollment_applications_status_check;

/* ------------------------------------------------------------------ status history: action, reason, payload */
alter table public.enrollment_application_status_history
  add column if not exists action_key text,
  add column if not exists reason text,
  add column if not exists payload jsonb not null default '{}'::jsonb;

/* ------------------------------------------------------------------ access: everyone signed in reads, admins write */
alter table public.application_statuses enable row level security;
alter table public.application_status_transitions enable row level security;
alter table public.status_reasons enable row level security;
grant select on public.application_statuses, public.application_status_transitions, public.status_reasons to authenticated;
grant insert, update, delete on public.application_statuses, public.application_status_transitions, public.status_reasons to authenticated;
do $$
declare t text;
begin
 foreach t in array array['application_statuses', 'application_status_transitions', 'status_reasons'] loop
  execute format('drop policy if exists %I on public.%I', t || '_read', t);
  execute format('drop policy if exists %I on public.%I', t || '_admin_write', t);
  execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
  execute format('create policy %I on public.%I for all to authenticated using (public.cms_is_admin()) with check (public.cms_is_admin())', t || '_admin_write', t);
 end loop;
end $$;
drop policy if exists application_status_actions_read on public.application_status_transitions;

/** Rules the settings page cannot break: a key never changes; a status in use is not deactivated or deleted; automatic moves are locked. */
create or replace function public.application_status_config_guard() returns trigger language plpgsql security definer set search_path = public as $$
declare n integer;
begin
 if tg_table_name = 'application_statuses' then
  if tg_op = 'UPDATE' and new.value <> old.value then raise exception 'A status key cannot change after it is created' using errcode = '22023'; end if;
  if (tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.is_active and not new.is_active)) then
   select count(*) into n from public.enrollment_applications where status = old.value;
   if n > 0 then raise exception '% application(s) are %: the status cannot be % while they use it', n, old.label, case when tg_op = 'DELETE' then 'deleted' else 'deactivated' end using errcode = '23503'; end if;
  end if;
 elsif tg_table_name = 'application_status_transitions' then
  if tg_op <> 'INSERT' and old.is_automatic and (tg_op = 'DELETE' or new.to_status is distinct from old.to_status or new.kind <> old.kind or not new.is_automatic or new.allowed_roles <> old.allowed_roles or not new.is_active) then
   raise exception 'Automatic moves (accept offer, resubmit) are locked' using errcode = '42501';
  end if;
  if tg_op <> 'DELETE' and new.to_status is not null and not exists (select 1 from public.application_statuses s where s.value = new.to_status and s.is_active) then
   raise exception 'The target status is not active' using errcode = '22023';
  end if;
 end if;
 return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists application_statuses_guard on public.application_statuses;
create trigger application_statuses_guard before update or delete on public.application_statuses for each row execute function public.application_status_config_guard();
drop trigger if exists application_status_transitions_guard on public.application_status_transitions;
create trigger application_status_transitions_guard before insert or update or delete on public.application_status_transitions for each row execute function public.application_status_config_guard();

/* ------------------------------------------------------------------ audit of the configuration */
create table if not exists public.status_config_audit (
  id bigint generated always as identity primary key,
  table_name text not null,
  row_key text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  before jsonb,
  after jsonb,
  changed_by uuid,
  changed_by_name text not null default '',
  changed_at timestamptz not null default now());
alter table public.status_config_audit enable row level security;
revoke all on public.status_config_audit from anon, authenticated;
grant select on public.status_config_audit to authenticated;
drop policy if exists status_config_audit_admin_read on public.status_config_audit;
create policy status_config_audit_admin_read on public.status_config_audit for select to authenticated using (public.cms_is_admin());

create or replace function public.status_config_audit_write() returns trigger language plpgsql security definer set search_path = public as $$
declare r jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
begin
 insert into public.status_config_audit(table_name, row_key, action, before, after, changed_by, changed_by_name)
 values (tg_table_name, case tg_table_name when 'application_statuses' then r->>'value' when 'application_status_transitions' then (r->>'from_status') || ':' || (r->>'action_key') else r->>'id' end,
   tg_op, case when tg_op = 'INSERT' then null else to_jsonb(old) end, case when tg_op = 'DELETE' then null else to_jsonb(new) end, auth.uid(),
   coalesce((select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', 'system'));
 return null;
end $$;
do $$
declare t text;
begin
 foreach t in array array['application_statuses', 'application_status_transitions', 'status_reasons'] loop
  execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
  execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.status_config_audit_write()', t || '_audit', t);
 end loop;
end $$;

-- Live refresh: the pages subscribe to changes of the three tables (when the realtime publication exists).
do $$
declare t text;
begin
 if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
  foreach t in array array['application_statuses', 'application_status_transitions', 'status_reasons'] loop
   if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
    execute format('alter publication supabase_realtime add table public.%I', t);
   end if;
  end loop;
 end if;
end $$;

/* ------------------------------------------------------------------ the caller's roles */
/** The signed-in user's role names, as allowed_roles stores them. */
create or replace function public.application_caller_roles() returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct r), '{}') from (
    select c.role as r from public.cms_users c where c.auth_user_id = auth.uid() and c.status = 'Active' and not c.must_change_password
    union all select m.role from public.tenant_memberships m where m.auth_user_id = auth.uid() and m.active and m.tenant_id = public.tenant_current()
    union all select m.role from public.agency_memberships m join public.portal_profiles p on p.id = m.user_id where p.auth_user_id = auth.uid() and m.status = 'Active'
  ) x where r is not null;
$$;
revoke all on function public.application_caller_roles() from public, anon;
grant execute on function public.application_caller_roles() to authenticated;

/* ------------------------------------------------------------------ what the pages read */
create or replace function public.application_status_workflow() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'statuses', coalesce((select jsonb_agg(jsonb_build_object('value', s.value, 'label', s.label, 'sort', s.sort, 'tone', s.tone, 'hint', s.hint, 'editable', s.editable,
      'legacy', s.legacy, 'color', s.color, 'final', s.is_final, 'active', s.is_active) order by s.sort) from public.application_statuses s), '[]'::jsonb),
    'actions', coalesce((select jsonb_agg(jsonb_build_object('from', x.from_status, 'action', x.action_key, 'to', x.to_status, 'actor', x.actor, 'label', x.label, 'kind', x.kind,
      'note', x.note, 'tone', x.tone, 'sort', x.sort, 'primary', x.is_primary, 'automatic', x.is_automatic, 'requiresReason', x.requires_reason, 'roles', to_jsonb(x.allowed_roles),
      'icon', x.icon) order by x.from_status, x.sort, x.action_key) from public.application_status_transitions x where x.is_active), '[]'::jsonb),
    'reasons', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'label', r.label, 'other', r.is_other) order by r.status, r.is_other, r.sort, lower(r.label))
      from public.status_reasons r where r.is_active), '[]'::jsonb),
    'roles', to_jsonb(public.application_caller_roles()));
$$;

-- The application list's status filter: every active status in order.
create or replace function public.portal_application_statuses() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('value', s.value, 'label', s.label) order by s.sort), '[]'::jsonb) from public.application_statuses s where s.is_active and not s.legacy;
$$;

/* ------------------------------------------------------------------ the status command, with "notify" */
-- As in 20261113260000, plus: the email can be skipped (portal.status_notify = off, "Notify student/agent" unticked); the history row
-- gets the action, reason and payload of change_application_status.
create or replace function public.portal_set_application_status(p_application_id uuid, p_status text, p_note text default '') returns void
 language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; allowed boolean; v_config jsonb; v_role text; v_action public.application_status_actions;
begin
 select * into a from public.enrollment_applications where id=p_application_id for update;
 if not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode='42501'; end if;
 if a.status=p_status then return; end if;
 if not public.application_student_active(a.id) then raise exception 'This student is disabled, so their applications are locked' using errcode='42501'; end if;
 select config into v_config from public.tenant_config_versions where id=a.workflow_version_id;
 if v_config is null then
  allowed:=public.portal_legacy_transition_allowed(a.status,p_status);
 else
  select role into v_role from public.tenant_memberships where tenant_id=a.tenant_id and auth_user_id=auth.uid() and active;
  allowed:=public.portal_pinned_transition_allowed(v_config,a.status,p_status,v_role,public.tenant_is_platform_admin());
 end if;
 if not allowed then raise exception 'Invalid admissions transition: % to %',public.portal_status_label(a.status),public.portal_status_label(p_status) using errcode='22023'; end if;
 if p_status='action_required' and nullif(btrim(p_note),'') is null then raise exception 'A correction reason is required' using errcode='22023'; end if;
 if p_status='offer_accepted' then raise exception 'Offer accepted is set when the student or agent accepts the offer' using errcode='22023'; end if;
 if p_status='offer_issued' and current_setting('portal.offer_command',true) is distinct from a.id::text then
  raise exception 'Use Issue offer letter to move this application to Offer letter issued' using errcode='22023';
 end if;
 select * into v_action from public.application_status_actions x where x.actor='staff' and x.from_status=a.status and x.to_status=p_status order by x.sort limit 1;
 if found and v_action.note='required' and nullif(btrim(p_note),'') is null then raise exception '% needs a reason', v_action.label using errcode='22023'; end if;
 perform set_config('portal.status_command',a.id::text,true);
 perform set_config('portal.status_note',coalesce(p_note,''),true);
 update public.enrollment_applications set status=p_status where id=a.id;
 if p_status='offer_accepted' then
  update public.enrollment_offer_letters set accepted_at=now(), accepted_by=auth.uid(), accepted_via='staff', accept_note=left(coalesce(p_note,''),500),
   accepted_by_name=coalesce((select c.name from public.cms_users c where c.auth_user_id=auth.uid() limit 1), auth.jwt()->>'email', '')
  where id=(select z.id from public.enrollment_offer_letters z where z.application_id=a.id and z.accepted_at is null order by z.issued_at desc limit 1);
 end if;
 insert into public.portal_audit_log(actor,actor_name,actor_role,action,target_type,target_id,application_id,detail)
 values(auth.uid(),coalesce(auth.jwt()->>'email','Authorized reviewer'),'slit_admin','status_change','application',a.id::text,a.id,jsonb_build_object('from',a.status,'to',p_status,'note',p_note)||case when v_config is null then '{}'::jsonb else jsonb_build_object('workflowVersion',(select version from public.tenant_config_versions where id=a.workflow_version_id)) end);
 if coalesce(current_setting('portal.status_notify',true),'') <> 'off' then
  insert into public.admission_event_outbox(application_id,tenant_id,event,payload)
  values(a.id,a.tenant_id,case p_status when 'offer_accepted' then 'offer_accepted' when 'coe_issued' then 'coe_voe_issued' when 'offer_issued' then 'offer_letter_issued' else 'application_status_changed' end,
   jsonb_build_object('from',a.status,'to',p_status,'actor',auth.uid())
   || case when p_status='offer_issued' then jsonb_build_object('letter',(select z.id from public.enrollment_offer_letters z where z.application_id=a.id order by z.issued_at desc limit 1)) else '{}'::jsonb end);
 end if;
end; $$;

/* ------------------------------------------------------------------ change_application_status */
/**
 * The staff command for every move the transitions table offers (status moves, Send reminder, Resend offer letter): the transition must
 * exist from the current status and be active, not automatic (accept_offer / resubmit are the applicant's system path), the caller's
 * role must be in allowed_roles and the caller must have access to the application; a reason is required where the transition says so
 * (one of status_reasons, "Other" with its text). Issue offer letter and Issue CoE / VoE carry a document and have their own commands
 * (portal_offer_letter_issue[_template], issue_coe_voe). payload: { reason_id, reason_text, note, notify (default true), enrolment_date }.
 * The history row records who, when, from, to, the action, the reason, the note and the payload; the existing emails follow.
 */
create or replace function public.change_application_status(p_application uuid, p_action text, p_payload jsonb default '{}'::jsonb) returns jsonb
 language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; t public.application_status_transitions; r public.status_reasons; v_reason text := ''; v_note text;
 v_payload jsonb := coalesce(p_payload, '{}'::jsonb); v_hist uuid; v_text text; v_date date;
begin
 select * into a from public.enrollment_applications where id = p_application for update;
 if not found or not public.portal_can_access_application(p_application) then raise exception 'Application not found' using errcode = '42501'; end if;
 select * into t from public.application_status_transitions x where x.from_status = a.status and x.action_key = p_action;
 if not found then raise exception '"%" is not available while the application is %', replace(coalesce(p_action, ''), '_', ' '), public.portal_status_label(a.status) using errcode = '22023'; end if;
 if not t.is_active then raise exception '% is turned off in Settings › Application statuses', t.label using errcode = '22023'; end if;
 if t.is_automatic then raise exception '% happens automatically (%), it cannot be chosen', t.label, case t.kind when 'accept_offer' then 'when the student or agent accepts the offer' else 'when the application is resubmitted' end using errcode = '22023'; end if;
 if not (t.allowed_roles && public.application_caller_roles()) then raise exception 'Your role cannot % this application', lower(t.label) using errcode = '42501'; end if;
 if t.kind = 'offer_letter' then raise exception 'Use Issue offer letter: it needs the letter' using errcode = '22023'; end if;
 if t.kind = 'coe' then raise exception 'Use Issue CoE / VoE: it needs the document' using errcode = '22023'; end if;
 v_note := left(btrim(coalesce(v_payload->>'note', '')), 1000);
 if t.requires_reason then
  begin select * into r from public.status_reasons x where x.id = (v_payload->>'reason_id')::uuid and x.status = t.to_status and x.is_active;
  exception when invalid_text_representation then r := null; end;
  if r.id is null then raise exception 'Choose a reason to %', lower(t.label) using errcode = '22023'; end if;
  v_text := left(btrim(coalesce(v_payload->>'reason_text', '')), 500);
  if r.is_other and v_text = '' then raise exception 'Describe the reason (Other)' using errcode = '22023'; end if;
  v_reason := case when r.is_other then v_text else r.label end;
 end if;
 if t.kind = 'enrol' then
  begin v_date := coalesce(nullif(v_payload->>'enrolment_date', '')::date, current_date); exception when others then raise exception 'Enter the enrolment date as a date' using errcode = '22023'; end;
  v_payload := v_payload || jsonb_build_object('enrolment_date', v_date);
 end if;
 if t.kind = 'reminder' then
  perform public.portal_application_reminder(a.id, v_note);
  return jsonb_build_object('status', a.status, 'label', public.portal_status_label(a.status));
 elsif t.kind = 'resend_offer' then
  perform public.portal_offer_letter_resend(a.id, v_note);
  return jsonb_build_object('status', a.status, 'label', public.portal_status_label(a.status));
 elsif t.kind not in ('status', 'enrol') or t.to_status is null then
  raise exception '% cannot be done from here', t.label using errcode = '22023';
 end if;
 perform set_config('portal.status_notify', case when coalesce((v_payload->>'notify')::boolean, true) then 'on' else 'off' end, true);
 perform public.portal_set_application_status(a.id, t.to_status,
   left(concat_ws(' — ', nullif(v_reason, ''), nullif(v_note, ''), case when t.kind = 'enrol' then 'Enrolment date ' || to_char(v_date, 'DD/MM/YYYY') end), 1000));
 perform set_config('portal.status_notify', '', true);
 select h.id into v_hist from public.enrollment_application_status_history h where h.application_id = a.id and h.new_status = t.to_status order by h.created_at desc limit 1;
 update public.enrollment_application_status_history set action_key = t.action_key, reason = nullif(v_reason, ''), payload = v_payload - 'reason_text' || jsonb_build_object('reason_id', r.id)
  where id = v_hist;
 return jsonb_build_object('status', t.to_status, 'label', public.portal_status_label(t.to_status), 'history', v_hist, 'from', a.status,
   'undoable', t.requires_reason);
end $$;
revoke all on function public.change_application_status(uuid, text, jsonb) from public, anon;
grant execute on function public.change_application_status(uuid, text, jsonb) to authenticated;

/**
 * Undo (the toast, 15 seconds): only the last change of this application, made by the caller with a reason (Reject, Withdraw, Action
 * required); the status goes back, the emails of the change that were not sent yet are cancelled, and the history says it was undone.
 */
create or replace function public.revert_application_status(p_application uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; h public.enrollment_application_status_history;
begin
 select * into a from public.enrollment_applications where id = p_application for update;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 select * into h from public.enrollment_application_status_history x where x.application_id = a.id order by x.created_at desc limit 1;
 if not found or h.new_status <> a.status or h.actor is distinct from auth.uid() or h.created_at < now() - interval '15 seconds'
    or not exists (select 1 from public.application_status_transitions t where t.from_status = h.previous_status and t.action_key = h.action_key and t.requires_reason) then
  raise exception 'This change can no longer be undone' using errcode = '22023';
 end if;
 update public.notification_deliveries d set state = 'suppressed', state_reason = 'undone'
  where d.application_id = a.id and d.state = 'pending' and d.created_at >= h.created_at - interval '1 second';
 perform set_config('portal.status_command', a.id::text, true);
 perform set_config('portal.status_note', 'Undone: back to ' || public.portal_status_label(h.previous_status), true);
 update public.enrollment_applications set status = h.previous_status where id = a.id;
 update public.enrollment_application_status_history set action_key = 'undo', payload = jsonb_build_object('undid', h.id)
  where id = (select x.id from public.enrollment_application_status_history x where x.application_id = a.id order by x.created_at desc limit 1);
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
 values (auth.uid(), coalesce(auth.jwt()->>'email', 'Authorized reviewer'), 'slit_admin', 'status_change_undone', 'application', a.id::text, a.id, jsonb_build_object('from', a.status, 'to', h.previous_status));
 return jsonb_build_object('status', h.previous_status, 'label', public.portal_status_label(h.previous_status));
end $$;
revoke all on function public.revert_application_status(uuid) from public, anon;
grant execute on function public.revert_application_status(uuid) to authenticated;

/* ------------------------------------------------------------------ Issue CoE / VoE in one step */
/**
 * The CoE / VoE drawer: CoE or VoE, its number and issue date, the PDF and an optional note, then issued. Uses the registration
 * workflow's checks (a verified registration, the PDF rules) by calling its commands in order; the number and date are kept on the
 * document row and in the history payload.
 */
alter table public.enrollment_coe_documents add column if not exists document_number text, add column if not exists issue_date date;
-- The document guard (P08) lets the number and the issue date be set while the document is not issued yet; issued ones stay immutable.
create or replace function public.portal_coe_document_guard() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if tg_op = 'DELETE' then raise exception 'CoE / VoE documents are never deleted' using errcode = '42501'; end if;
  if old.issued_at is not null then raise exception 'An issued CoE / VoE document is immutable' using errcode = '42501'; end if;
  if (to_jsonb(new) - array['superseded_at', 'issued_at', 'issued_by', 'document_number', 'issue_date']) is distinct from (to_jsonb(old) - array['superseded_at', 'issued_at', 'issued_by', 'document_number', 'issue_date']) then
    raise exception 'Only the issue and supersede markers can change' using errcode = '42501'; end if;
  return new;
end;
$$;
create or replace function public.issue_coe_voe(p_application uuid, p_kind text, p_number text, p_issue_date date, p_file_name text, p_content text, p_note text default '', p_notify boolean default true)
 returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; reg public.enrollment_registrations; v_out jsonb; v_hist uuid;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 if not exists (select 1 from public.application_status_transitions t where t.from_status = a.status and t.kind = 'coe' and t.is_active and t.allowed_roles && public.application_caller_roles()) then
  raise exception 'Issue CoE / VoE is not available while the application is %', public.portal_status_label(a.status) using errcode = '22023';
 end if;
 if nullif(btrim(coalesce(p_number, '')), '') is null or char_length(btrim(p_number)) > 40 then raise exception 'Enter the CoE / VoE number' using errcode = '22023'; end if;
 if p_issue_date is null or p_issue_date > current_date + 1 then raise exception 'Enter the issue date (today or earlier)' using errcode = '22023'; end if;
 select * into reg from public.enrollment_registrations where application_id = a.id and state = 'verified' order by created_at desc limit 1;
 if not found then raise exception 'The student''s registration must be verified first (Registrations)' using errcode = '22023'; end if;
 perform public.portal_coe_document_upload(reg.id, p_kind, p_file_name, p_content);
 update public.enrollment_coe_documents set document_number = btrim(p_number), issue_date = p_issue_date
  where application_id = a.id and registration_id = reg.id and superseded_at is null and issued_at is null;
 perform set_config('portal.status_notify', case when p_notify then 'on' else 'off' end, true);
 v_out := public.portal_coe_voe_issue(a.id, left(concat_ws(' — ', upper(p_kind) || ' ' || btrim(p_number) || ' issued ' || to_char(p_issue_date, 'DD/MM/YYYY'), nullif(btrim(coalesce(p_note, '')), '')), 300));
 perform set_config('portal.status_notify', '', true);
 select h.id into v_hist from public.enrollment_application_status_history h where h.application_id = a.id and h.new_status = 'coe_issued' order by h.created_at desc limit 1;
 update public.enrollment_application_status_history set action_key = 'issue_coe', payload = jsonb_build_object('kind', p_kind, 'number', btrim(p_number), 'issue_date', p_issue_date, 'document', v_out->>'documentId')
  where id = v_hist;
 return v_out || jsonb_build_object('status', 'coe_issued', 'label', public.portal_status_label('coe_issued'), 'from', a.status);
end $$;
revoke all on function public.issue_coe_voe(uuid, text, text, date, text, text, text, boolean) from public, anon;
grant execute on function public.issue_coe_voe(uuid, text, text, date, text, text, text, boolean) to authenticated;

/* ------------------------------------------------------------------ the applicant's system path */
-- portal_offer_accept and portal_application_resubmit (20261113260000) stay the only way to Offer accepted / back to Submitted: they
-- check the automatic transition through the application_status_actions view (so a deactivated one stops them) and record who and when.
-- Their history rows now name the action.
create or replace function public.application_history_action_stamp() returns trigger language plpgsql security definer set search_path = public as $$
begin
 if new.action_key is null and new.previous_status = 'offer_issued' and new.new_status = 'offer_accepted' and current_setting('portal.status_note', true) = 'Offer accepted in the portal' then
  new.action_key := 'accept_offer';
 elsif new.action_key is null and new.previous_status = 'action_required' and new.new_status = 'submitted' then
  new.action_key := 'resubmit';
 end if;
 return new;
end $$;
drop trigger if exists application_history_action_stamp on public.enrollment_application_status_history;
create trigger application_history_action_stamp before insert on public.enrollment_application_status_history for each row execute function public.application_history_action_stamp();

/* ------------------------------------------------------------------ Settings › Application statuses */
/** History link of each tab: the audit rows of one table, newest first (admins). */
create or replace function public.status_config_history(p_table text, p_limit integer default 100) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
 if not public.cms_is_admin() then raise exception 'Only an administrator can do this.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'rowKey', x.row_key, 'action', x.action, 'before', x.before, 'after', x.after, 'by', x.changed_by_name, 'at', x.changed_at) order by x.id desc)
   from (select * from public.status_config_audit a where a.table_name = p_table order by a.id desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb);
end $$;
revoke all on function public.status_config_history(text, integer) from public, anon;
grant execute on function public.status_config_history(text, integer) to authenticated;

/** How many applications use each status (the settings page blocks deactivating one in use). */
create or replace function public.application_status_usage() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(s.value, (select count(*) from public.enrollment_applications a where a.status = s.value)), '{}'::jsonb)
  from public.application_statuses s where public.cms_is_admin();
$$;
revoke all on function public.application_status_usage() from public, anon;
grant execute on function public.application_status_usage() to authenticated;

insert into public.admin_menu_items(id, parent_id, label, route, icon_key, sort_order, is_enabled, permission_key, permission_scope, is_system, open_in_new_tab)
select 'application_status_settings', m.parent_id, 'Application statuses', '/admin/settings/application-statuses', 'admissions', m.sort_order + 5, true, m.permission_key, m.permission_scope, false, false
from public.admin_menu_items m where m.id = 'settings'
on conflict (id) do nothing;

/* ------------------------------------------------------------------ new tenant workflows: the same map */
-- As 20261113260000, with coe_issued -> rejected and enrolled -> withdrawn added. offer_issued -> offer_accepted stays in the graph (the
-- recipient's acceptance keeps the later statuses reachable); portal_set_application_status refuses it to staff.
create or replace function public.tenant_config_defaults(p_kind text)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case p_kind
    when 'workflow' then jsonb_build_object(
      'statuses', '["draft","submitted","action_required","offer_issued","offer_accepted","coe_issued","enrolled","rejected","withdrawn"]'::jsonb,
      'transitions', '[{"from":"draft","to":"submitted"},
        {"from":"submitted","to":"action_required"},{"from":"submitted","to":"offer_issued"},{"from":"submitted","to":"rejected"},{"from":"submitted","to":"withdrawn"},
        {"from":"action_required","to":"rejected"},{"from":"action_required","to":"withdrawn"},
        {"from":"offer_issued","to":"offer_accepted"},{"from":"offer_issued","to":"rejected"},{"from":"offer_issued","to":"withdrawn"},
        {"from":"offer_accepted","to":"coe_issued"},{"from":"offer_accepted","to":"rejected"},{"from":"offer_accepted","to":"withdrawn"},
        {"from":"coe_issued","to":"enrolled"},{"from":"coe_issued","to":"withdrawn"},{"from":"coe_issued","to":"rejected"},
        {"from":"enrolled","to":"withdrawn"}]'::jsonb)
    when 'roles' then '{"roles":{"tenant_admin":["cms.read","cms.edit","applications.review","members.manage","domains.manage","config.manage"],"editor":["cms.read","cms.edit"],"staff":["cms.read","applications.review"],"viewer":[]}}'::jsonb
    when 'integration' then '{"integrations":[]}'::jsonb
    when 'notifications' then jsonb_build_object(
      'templates', jsonb_build_object(
        'application_submitted', jsonb_build_object('subject', 'Application {{reference}} was submitted', 'body', 'Application {{reference}} has been submitted to {{institution}} and is awaiting review.'),
        'application_status_changed', jsonb_build_object('subject', 'Application {{reference}} is now {{status}}', 'body', 'The status of application {{reference}} changed from {{previousStatus}} to {{status}}.'),
        'offer_accepted', jsonb_build_object('subject', 'Offer accepted for application {{reference}}', 'body', 'The offer for application {{reference}} has been accepted. {{institution}} will now prepare the next steps.'),
        'coe_voe_issued', jsonb_build_object('subject', 'CoE / VoE issued for application {{reference}}', 'body', 'The CoE / VoE for application {{reference}} has been issued by {{institution}}.'),
        'offer_letter_issued', jsonb_build_object('subject', 'Offer letter for application {{reference}}', 'body', '{{institution}} has issued an offer letter for {{student}} (application {{reference}}). The letter is attached.{{message}}'),
        'action_required_reminder', jsonb_build_object('subject', 'Reminder: application {{reference}} needs action', 'body', 'Application {{reference}} for {{student}} still needs action before {{institution}} can continue.{{message}}')),
      'defaults', '{"application_submitted":true,"application_status_changed":true,"offer_accepted":true,"coe_voe_issued":true}'::jsonb)
    when 'branding' then '{"primaryColor":"#2563eb","headingFont":"Arial","bodyFont":"Arial"}'::jsonb
  end;
$function$;

/* ------------------------------------------------------------------ tenant workflow validation from the catalogue */
-- As before, with the statuses and the final ones read from application_statuses (Enrolled is no longer final: it can be withdrawn).
create or replace function public.tenant_config_validate(p_kind text, p_config jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  statuses constant text[] := (select coalesce(array_agg(s.value order by s.sort), '{}') from public.application_statuses s where s.is_active);
  terminal constant text[] := (select coalesce(array_agg(s.value), '{}') from public.application_statuses s where s.is_final);
  tenant_roles constant text[] := array['tenant_admin','editor','staff','viewer'];
  perms constant text[] := array['cms.read','cms.edit','applications.review','members.manage','domains.manage','config.manage'];
  reserved constant text[] := array['members.manage','domains.manage','config.manage'];
  providers constant text[] := array['openai','azure','postmark','stripe'];
  fonts constant text[] := array['Arial','Georgia','Verdana','system-ui'];
  events constant text[] := array['application_submitted','application_status_changed','offer_accepted','coe_voe_issued'];
  vars constant text[] := array['reference','status','previousStatus','institution'];
  tk text; ph text;
  k text; v jsonb; item jsonb; s text[]; r text; seen text[] := '{}'; pair text; pairs text[] := '{}';
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object' then raise exception 'Configuration must be an object' using errcode = '22023'; end if;
  if p_kind = 'workflow' then
    for k in select jsonb_object_keys(p_config) loop if k not in ('statuses', 'transitions') then raise exception 'Unknown workflow field' using errcode = '22023'; end if; end loop;
    if jsonb_typeof(p_config->'statuses') is distinct from 'array' or jsonb_typeof(p_config->'transitions') is distinct from 'array' then raise exception 'Workflow needs statuses and transitions arrays' using errcode = '22023'; end if;
    select array_agg(x) into s from jsonb_array_elements_text(p_config->'statuses') x;
    if s is null or cardinality(s) > 10 or exists (select 1 from unnest(s) x where x <> all (statuses)) then raise exception 'Unknown workflow status' using errcode = '22023'; end if;
    if cardinality(s) <> (select count(distinct x) from unnest(s) x) then raise exception 'Duplicate workflow status' using errcode = '22023'; end if;
    if not (s @> array['draft','submitted']) then raise exception 'Workflow must include draft and submitted' using errcode = '22023'; end if;
    if jsonb_array_length(p_config->'transitions') > 60 then raise exception 'Too many transitions' using errcode = '22023'; end if;
    for item in select * from jsonb_array_elements(p_config->'transitions') loop
      if jsonb_typeof(item) <> 'object' then raise exception 'Invalid transition' using errcode = '22023'; end if;
      for k in select jsonb_object_keys(item) loop if k not in ('from', 'to', 'roles') then raise exception 'Unknown transition field' using errcode = '22023'; end if; end loop;
      if jsonb_typeof(item->'from') is distinct from 'string' or jsonb_typeof(item->'to') is distinct from 'string' then raise exception 'Invalid transition' using errcode = '22023'; end if;
      if (item->>'from') <> all (s) or (item->>'to') <> all (s) or item->>'from' = item->>'to' then raise exception 'Transition uses an unlisted status' using errcode = '22023'; end if;
      if (item->>'from') = any (terminal) then raise exception 'Terminal statuses cannot have transitions' using errcode = '22023'; end if;
      pair := (item->>'from') || '>' || (item->>'to');
      if pair = any (pairs) then raise exception 'Duplicate transition' using errcode = '22023'; end if;
      pairs := pairs || pair;
      if item ? 'roles' then
        if jsonb_typeof(item->'roles') <> 'array' then raise exception 'Invalid transition roles' using errcode = '22023'; end if;
        for r in select jsonb_array_elements_text(item->'roles') loop if r <> all (array['agency','tenant_admin','editor','staff','viewer']) then raise exception 'Unknown transition role' using errcode = '22023'; end if; end loop;
      end if;
    end loop;
    if exists (
      with recursive reach(st) as (
        select 'draft'::text
        union select t->>'to' from reach join jsonb_array_elements(p_config->'transitions') t on t->>'from' = reach.st)
      select 1 from unnest(s) x where x not in (select st from reach)) then
      raise exception 'Every workflow status must be reachable from draft' using errcode = '22023';
    end if;
  elsif p_kind = 'roles' then
    for k in select jsonb_object_keys(p_config) loop if k <> 'roles' then raise exception 'Unknown roles field' using errcode = '22023'; end if; end loop;
    if jsonb_typeof(p_config->'roles') is distinct from 'object' then raise exception 'Roles must be an object' using errcode = '22023'; end if;
    for k, v in select * from jsonb_each(p_config->'roles') loop
      if k <> all (tenant_roles) then raise exception 'Unknown role' using errcode = '22023'; end if;
      if jsonb_typeof(v) <> 'array' then raise exception 'Role permissions must be an array' using errcode = '22023'; end if;
      seen := '{}';
      for r in select jsonb_array_elements_text(v) loop
        if r <> all (perms) then raise exception 'Unknown permission' using errcode = '22023'; end if;
        if r = any (seen) then raise exception 'Duplicate permission' using errcode = '22023'; end if;
        if r = any (reserved) and k <> 'tenant_admin' then raise exception 'Administration permissions are reserved for institution administrators' using errcode = '22023'; end if;
        seen := seen || r;
      end loop;
    end loop;
    if not (p_config->'roles' ? 'tenant_admin') or not ((p_config->'roles'->'tenant_admin') @> '["members.manage","domains.manage","config.manage"]'::jsonb) then
      raise exception 'Institution administrators must keep member, domain and configuration management' using errcode = '22023';
    end if;
  elsif p_kind = 'integration' then
    for k in select jsonb_object_keys(p_config) loop if k <> 'integrations' then raise exception 'Unknown integration field' using errcode = '22023'; end if; end loop;
    if jsonb_typeof(p_config->'integrations') is distinct from 'array' or jsonb_array_length(p_config->'integrations') > 10 then raise exception 'Integrations must be an array of at most 10' using errcode = '22023'; end if;
    for item in select * from jsonb_array_elements(p_config->'integrations') loop
      if jsonb_typeof(item) <> 'object' then raise exception 'Invalid integration' using errcode = '22023'; end if;
      for k in select jsonb_object_keys(item) loop if k not in ('provider', 'enabled', 'secretNames', 'settings') then raise exception 'Unknown integration field' using errcode = '22023'; end if; end loop;
      if jsonb_typeof(item->'provider') is distinct from 'string' or (item->>'provider') <> all (providers) then raise exception 'Unknown integration provider' using errcode = '22023'; end if;
      if (item->>'provider') = any (seen) then raise exception 'Duplicate integration provider' using errcode = '22023'; end if;
      seen := seen || (item->>'provider');
      if jsonb_typeof(item->'enabled') is distinct from 'boolean' then raise exception 'enabled must be true or false' using errcode = '22023'; end if;
      if item ? 'secretNames' then
        if jsonb_typeof(item->'secretNames') <> 'array' or jsonb_array_length(item->'secretNames') > 10 then raise exception 'secretNames must be an array of at most 10' using errcode = '22023'; end if;
        for r in select jsonb_array_elements_text(item->'secretNames') loop
          if r !~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$' or length(r) > 64 then raise exception 'secretNames must be environment variable names, never values' using errcode = '22023'; end if;
        end loop;
      end if;
      if item ? 'settings' then
        if jsonb_typeof(item->'settings') <> 'object' then raise exception 'settings must be an object' using errcode = '22023'; end if;
        for k, v in select * from jsonb_each(item->'settings') loop
          if k !~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$' or k ~* '(secret|password|passwd|token|credential|api[_-]?key|private)' then raise exception 'Setting names must not look like credentials' using errcode = '22023'; end if;
          if jsonb_typeof(v) not in ('string', 'number', 'boolean') then raise exception 'Settings must be plain values' using errcode = '22023'; end if;
          if jsonb_typeof(v) = 'string' and (length(v #>> '{}') > 200 or (v #>> '{}') ~ '^(eyJ|sk[-_]|pk[-_]|sbp_|AKIA|xox[a-z]-)' or (v #>> '{}') ~ '^[A-Za-z0-9+/=_-]{32,}$') then
            raise exception 'Setting values must not look like credentials' using errcode = '22023';
          end if;
        end loop;
      end if;
    end loop;
  elsif p_kind = 'branding' then
    for k, v in select * from jsonb_each(p_config) loop
      if k in ('primaryColor', 'accentColor') then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Colours must be #rrggbb' using errcode = '22023'; end if;
      elsif k in ('headingFont', 'bodyFont') then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') <> all (fonts) then raise exception 'Unsupported font' using errcode = '22023'; end if;
      else raise exception 'Unknown branding field' using errcode = '22023';
      end if;
    end loop;
  elsif p_kind = 'notifications' then
    for k in select jsonb_object_keys(p_config) loop if k not in ('sender', 'templates', 'defaults', 'events') then raise exception 'Unknown notification field' using errcode = '22023'; end if; end loop;
    if p_config ? 'sender' then
      v := p_config->'sender';
      if jsonb_typeof(v) <> 'object' then raise exception 'sender must be an object' using errcode = '22023'; end if;
      for k in select jsonb_object_keys(v) loop if k not in ('name', 'email') then raise exception 'Unknown sender field' using errcode = '22023'; end if; end loop;
      if jsonb_typeof(v->'name') is distinct from 'string' or length(v->>'name') not between 1 and 100 or (v->>'name') ~ '[<>"\r\n]' then raise exception 'Invalid sender name' using errcode = '22023'; end if;
      if jsonb_typeof(v->'email') is distinct from 'string' or length(v->>'email') > 254 or (v->>'email') !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then raise exception 'Invalid sender email' using errcode = '22023'; end if;
    end if;
    if p_config ? 'templates' then
      if jsonb_typeof(p_config->'templates') <> 'object' then raise exception 'templates must be an object' using errcode = '22023'; end if;
      for k, v in select * from jsonb_each(p_config->'templates') loop
        if k <> all (events) then raise exception 'Unknown notification event' using errcode = '22023'; end if;
        if jsonb_typeof(v) <> 'object' then raise exception 'Invalid template' using errcode = '22023'; end if;
        for tk in select jsonb_object_keys(v) loop if tk not in ('subject', 'body') then raise exception 'Unknown template field' using errcode = '22023'; end if; end loop;
        if jsonb_typeof(v->'subject') is distinct from 'string' or jsonb_typeof(v->'body') is distinct from 'string' then raise exception 'Templates need a subject and a body' using errcode = '22023'; end if;
        if length(v->>'subject') not between 1 and 150 or (v->>'subject') ~ '[\r\n]' then raise exception 'Invalid subject' using errcode = '22023'; end if;
        if length(v->>'body') not between 1 and 2000 then raise exception 'Invalid body' using errcode = '22023'; end if;
        if (v->>'subject') ~ '[<>]' or (v->>'body') ~ '[<>]' then raise exception 'Templates are plain text: remove < and >' using errcode = '22023'; end if;
        for ph in select m[1] from regexp_matches((v->>'subject') || ' ' || (v->>'body'), '\{\{([^{}]*)\}\}', 'g') as m loop
          if ph <> all (vars) then raise exception 'Unknown template placeholder' using errcode = '22023'; end if;
        end loop;
        if regexp_replace((v->>'subject') || ' ' || (v->>'body'), '\{\{[^{}]*\}\}', '', 'g') ~ '[{}]' then raise exception 'Malformed template placeholder' using errcode = '22023'; end if;
      end loop;
    end if;
    if p_config ? 'defaults' then
      if jsonb_typeof(p_config->'defaults') <> 'object' then raise exception 'defaults must be an object' using errcode = '22023'; end if;
      for k, v in select * from jsonb_each(p_config->'defaults') loop
        if k <> all (events) or jsonb_typeof(v) <> 'boolean' then raise exception 'Invalid notification default' using errcode = '22023'; end if;
      end loop;
    end if;
    if p_config ? 'events' then perform public.notification_events_check(p_config->'events'); end if;
  else
    raise exception 'Unknown configuration kind' using errcode = '22023';
  end if;
end;
$function$;

/* ------------------------------------------------------------------ accept offer: the recipient only */
-- As 20261113260000; staff no longer have a Mark offer accepted, so the message says who accepts.
create or replace function public.portal_offer_accept(p_application uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.enrollment_applications; l public.enrollment_offer_letters; v_name text;
begin
 select * into a from public.enrollment_applications where id = p_application for update;
 if not found or not public.portal_can_access_application(a.id) then raise exception 'Application not found' using errcode = '42501'; end if;
 if public.portal_is_slit_admin() then raise exception 'Only the student or agent the letter went to accepts an offer' using errcode = '42501'; end if;
 if not exists (select 1 from public.application_status_actions x where x.actor = 'applicant' and x.from_status = a.status and x.kind = 'accept_offer') then
  raise exception 'There is no offer to accept on this application' using errcode = '22023';
 end if;
 if not public.application_student_active(a.id) then raise exception 'This student is disabled, so their applications are locked' using errcode = '42501'; end if;
 select * into l from public.enrollment_offer_letters where application_id = a.id order by issued_at desc limit 1 for update;
 if not found then raise exception 'There is no offer letter to accept' using errcode = '22023'; end if;
 select coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', '') into v_name;
 update public.enrollment_offer_letters set accepted_at = now(), accepted_by = auth.uid(), accepted_by_name = coalesce(v_name, ''), accepted_via = 'portal' where id = l.id;
 perform set_config('portal.status_command', a.id::text, true);
 perform set_config('portal.status_note', 'Offer accepted in the portal', true);
 update public.enrollment_applications set status = 'offer_accepted' where id = a.id;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
 values (auth.uid(), coalesce(v_name, 'Applicant'), case when public.portal_student_id() is not null then 'student' when public.portal_is_agency_admin() then 'agency_admin' else 'agent' end,
   'offer_accepted', 'application', a.id::text, a.id, jsonb_build_object('letter', l.id, 'from', a.status, 'to', 'offer_accepted'));
 insert into public.admission_event_outbox(application_id, tenant_id, event, payload)
 values (a.id, a.tenant_id, 'offer_accepted', jsonb_build_object('from', a.status, 'to', 'offer_accepted', 'actor', auth.uid(), 'via', 'portal'));
end $function$;
