-- Application statuses and their workflow come from the database (the frontend reads them through
-- application_status_workflow()); a new status "Offer letter issued" (offer_issued, until now a legacy value) between
-- Submitted / Action required and Offer accepted; the offer letter (issue, resend, accept) and the applicant's
-- resubmission as commands that check the workflow here. Additive: no existing row is changed.
--
-- Transition map (staff unless marked):
--   draft            -> withdrawn, rejected;  applicant: submitted (portal_submit_v2, unchanged)
--   submitted        -> offer_issued (offer letter command only), action_required, rejected, withdrawn
--   under_review     -> (legacy rows) as submitted
--   action_required  -> rejected, withdrawn;  applicant: submitted (resubmit); staff: send reminder (no status change)
--   offer_issued     -> offer_accepted (manual, note required), withdrawn, rejected;  applicant: offer_accepted (accept);
--                       staff: resend offer letter (no status change)
--   offer_accepted   -> coe_issued (CoE / VoE issue flow), rejected, withdrawn
--   coe_issued       -> enrolled, withdrawn
-- Removed from the default graph: submitted / action_required -> offer_accepted (an offer is now accepted from an issued
-- letter) and the administrator's action_required -> submitted (the applicant resubmits).

/* --------------------------------------------------------------------- the catalogue */

create table public.application_statuses (
  value text primary key,
  label text not null,
  sort integer not null unique,
  tone text not null check (tone in ('neutral', 'info', 'warning', 'success', 'danger', 'muted')),
  hint text not null default '',
  editable boolean not null default false,
  legacy boolean not null default false
);
comment on table public.application_statuses is 'Application statuses: value (stored), label, order, badge tone, the staff hint for what comes next, whether the applicant can still edit.';

insert into public.application_statuses(value, label, sort, tone, hint, editable, legacy) values
  ('draft', 'Draft', 10, 'neutral', 'Not submitted yet', true, false),
  ('submitted', 'Submitted', 20, 'info', 'Ready for offer letter', false, false),
  ('under_review', 'Under review', 25, 'info', 'Ready for offer letter', false, true),
  ('action_required', 'Action required', 30, 'warning', 'Waiting on the student or agent', true, false),
  ('offer_issued', 'Offer letter issued', 40, 'info', 'Waiting for the offer to be accepted', false, false),
  ('offer_accepted', 'Offer accepted', 50, 'success', 'Ready for CoE / VoE', false, false),
  ('coe_issued', 'CoE / VoE issued', 60, 'success', 'Ready to enrol', false, false),
  ('enrolled', 'Enrolled', 70, 'success', 'Enrolled', false, false),
  ('rejected', 'Rejected', 80, 'danger', 'Closed', false, false),
  ('withdrawn', 'Withdrawn', 90, 'muted', 'Closed', false, false);

create table public.application_status_actions (
  from_status text not null references public.application_statuses(value),
  action text not null,
  to_status text references public.application_statuses(value),
  actor text not null check (actor in ('staff', 'applicant')),
  label text not null,
  kind text not null check (kind in ('status', 'offer_letter', 'coe', 'reminder', 'resend_offer', 'accept_offer', 'resubmit', 'submit')),
  note text not null default 'none' check (note in ('none', 'optional', 'required')),
  tone text not null default 'neutral' check (tone in ('neutral', 'primary', 'danger')),
  sort integer not null,
  primary key (from_status, action)
);
comment on table public.application_status_actions is 'What can be done from each status and by whom: status moves (to_status) and the actions that keep the status (reminder, resend). The status commands check this table.';

insert into public.application_status_actions(from_status, action, to_status, actor, label, kind, note, tone, sort) values
  ('draft', 'submit', 'submitted', 'applicant', 'Submit application', 'submit', 'none', 'primary', 10),
  ('draft', 'withdraw', 'withdrawn', 'staff', 'Withdraw', 'status', 'optional', 'neutral', 80),
  ('draft', 'reject', 'rejected', 'staff', 'Reject', 'status', 'required', 'danger', 90),
  ('submitted', 'issue_offer', 'offer_issued', 'staff', 'Issue offer letter', 'offer_letter', 'none', 'primary', 10),
  ('submitted', 'action_required', 'action_required', 'staff', 'Action required', 'status', 'required', 'neutral', 20),
  ('submitted', 'withdraw', 'withdrawn', 'staff', 'Withdraw', 'status', 'optional', 'neutral', 80),
  ('submitted', 'reject', 'rejected', 'staff', 'Reject', 'status', 'required', 'danger', 90),
  ('under_review', 'issue_offer', 'offer_issued', 'staff', 'Issue offer letter', 'offer_letter', 'none', 'primary', 10),
  ('under_review', 'action_required', 'action_required', 'staff', 'Action required', 'status', 'required', 'neutral', 20),
  ('under_review', 'withdraw', 'withdrawn', 'staff', 'Withdraw', 'status', 'optional', 'neutral', 80),
  ('under_review', 'reject', 'rejected', 'staff', 'Reject', 'status', 'required', 'danger', 90),
  ('action_required', 'resubmit', 'submitted', 'applicant', 'Resubmit application', 'resubmit', 'optional', 'primary', 10),
  ('action_required', 'send_reminder', null, 'staff', 'Send reminder', 'reminder', 'optional', 'neutral', 10),
  ('action_required', 'withdraw', 'withdrawn', 'staff', 'Withdraw', 'status', 'optional', 'neutral', 80),
  ('action_required', 'reject', 'rejected', 'staff', 'Reject', 'status', 'required', 'danger', 90),
  ('offer_issued', 'accept_offer', 'offer_accepted', 'applicant', 'Accept offer', 'accept_offer', 'none', 'primary', 10),
  ('offer_issued', 'resend_offer', null, 'staff', 'Resend offer letter', 'resend_offer', 'optional', 'neutral', 10),
  ('offer_issued', 'mark_accepted', 'offer_accepted', 'staff', 'Mark offer accepted', 'status', 'required', 'neutral', 20),
  ('offer_issued', 'withdraw', 'withdrawn', 'staff', 'Withdraw', 'status', 'optional', 'neutral', 80),
  ('offer_issued', 'reject', 'rejected', 'staff', 'Reject', 'status', 'required', 'danger', 90),
  ('offer_accepted', 'issue_coe', 'coe_issued', 'staff', 'Issue CoE / VoE', 'coe', 'none', 'primary', 10),
  ('offer_accepted', 'withdraw', 'withdrawn', 'staff', 'Withdraw', 'status', 'optional', 'neutral', 80),
  ('offer_accepted', 'reject', 'rejected', 'staff', 'Reject', 'status', 'required', 'danger', 90),
  ('coe_issued', 'mark_enrolled', 'enrolled', 'staff', 'Mark enrolled', 'status', 'optional', 'primary', 10),
  ('coe_issued', 'withdraw', 'withdrawn', 'staff', 'Withdraw', 'status', 'optional', 'neutral', 80);

alter table public.application_statuses enable row level security;
alter table public.application_status_actions enable row level security;
create policy application_statuses_read on public.application_statuses for select to authenticated using (true);
create policy application_status_actions_read on public.application_status_actions for select to authenticated using (true);
grant select on public.application_statuses, public.application_status_actions to authenticated;

-- Stored values that are not catalogue keys are mapped first (case, spacing, old spellings such as "Submitted" or "offer_accept"),
-- through the status command guard so the history records it; a value with no key stops the migration. Application data is never deleted.
do $$
declare r record; v_to text; v_id uuid;
begin
 for r in select distinct status from public.enrollment_applications where status is not null and status not in (select s.value from public.application_statuses s) loop
  v_to := regexp_replace(lower(btrim(r.status)), '[^a-z]+', '_', 'g');
  v_to := case v_to when 'offer_accept' then 'offer_accepted' when 'accepted' then 'offer_accepted' when 'offer_letter_issued' then 'offer_issued' when 'offer_sent' then 'offer_issued'
    when 'coe_voe_issued' then 'coe_issued' when 'coe' then 'coe_issued' when 'enroled' then 'enrolled' when 'withdraw' then 'withdrawn' when 'reject' then 'rejected'
    when 'in_review' then 'under_review' when 'new' then 'submitted' else v_to end;
  if not exists (select 1 from public.application_statuses s where s.value = v_to) then raise exception 'Application status "%" has no catalogue key; map it before this migration', r.status; end if;
  raise notice 'status mapping: % -> %', r.status, v_to;
  for v_id in select id from public.enrollment_applications where status = r.status loop
   perform set_config('portal.status_command', v_id::text, true);
   perform set_config('portal.status_note', 'Status value normalised: ' || r.status || ' -> ' || v_to, true);
   update public.enrollment_applications set status = v_to where id = v_id;
  end loop;
 end loop;
 perform set_config('portal.status_command', '', true);
end $$;

-- Every stored status is one of the catalogue's.
alter table public.enrollment_applications add constraint enrollment_applications_status_catalogue_fk foreign key (status) references public.application_statuses(value);

/** The catalogue in one read: statuses in order, and every action with who may take it. */
create function public.application_status_workflow() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'statuses', coalesce((select jsonb_agg(jsonb_build_object('value', s.value, 'label', s.label, 'sort', s.sort, 'tone', s.tone, 'hint', s.hint, 'editable', s.editable, 'legacy', s.legacy) order by s.sort) from public.application_statuses s), '[]'::jsonb),
    'actions', coalesce((select jsonb_agg(jsonb_build_object('from', x.from_status, 'action', x.action, 'to', x.to_status, 'actor', x.actor, 'label', x.label, 'kind', x.kind, 'note', x.note, 'tone', x.tone, 'sort', x.sort) order by x.from_status, x.sort, x.action) from public.application_status_actions x), '[]'::jsonb));
$$;
revoke all on function public.application_status_workflow() from public;
grant execute on function public.application_status_workflow() to authenticated;

-- The label from the catalogue (notifications, history), the value itself when unknown.
create or replace function public.portal_status_label(p_status text) returns text language sql stable set search_path = public as $$
  select coalesce((select s.label from public.application_statuses s where s.value = p_status), replace(coalesce(p_status, ''), '_', ' '));
$$;

-- The application list of the status catalogue: from the table (current statuses, in order).
create or replace function public.portal_application_statuses() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('value', s.value, 'label', s.label) order by s.sort), '[]'::jsonb) from public.application_statuses s where not s.legacy;
$$;

-- The default graph (applications without a pinned workflow version): the staff moves of the table.
create or replace function public.portal_legacy_transition_allowed(p_from text, p_to text) returns boolean language sql stable set search_path = public as $$
  select exists (select 1 from public.application_status_actions x where x.actor = 'staff' and x.from_status = p_from and x.to_status = p_to);
$$;

-- The moves offered to the signed-in reviewer, in catalogue order.
create or replace function public.application_next_statuses(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a public.enrollment_applications; v_config jsonb; v_role text; v_platform boolean; out jsonb := '[]'::jsonb; t text;
begin
 if not public.portal_is_slit_admin() then return '[]'::jsonb; end if;
 if not public.application_student_active(p_application) then return '[]'::jsonb; end if;
 select * into a from public.enrollment_applications where id = p_application;
 if not found then return '[]'::jsonb; end if;
 select config into v_config from public.tenant_config_versions where id = a.workflow_version_id;
 if v_config is not null then
  select role into v_role from public.tenant_memberships where tenant_id = a.tenant_id and auth_user_id = auth.uid() and active;
  v_platform := public.tenant_is_platform_admin();
 end if;
 for t in select s.value from public.application_statuses s where s.value <> 'draft' and not s.legacy order by s.sort loop
  if t = a.status then continue; end if;
  if (v_config is null and public.portal_legacy_transition_allowed(a.status, t))
   or (v_config is not null and public.portal_pinned_transition_allowed(v_config, a.status, t, v_role, v_platform)) then
   out := out || to_jsonb(t);
  end if;
 end loop;
 return out;
end $$;

/* ------------------------------------------------------------------- the offer letter */

create table public.enrollment_offer_letters (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.enrollment_applications(id) on delete cascade,
  tenant_id uuid,
  source text not null check (source in ('template', 'upload')),
  template_id uuid,
  file_name text not null,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 3145728),
  sha256 text not null,
  content bytea not null,
  message text not null default '',
  override_note text not null default '',
  recipient_kind text not null check (recipient_kind in ('agent', 'student')),
  recipient_name text not null default '',
  recipient_email text not null default '',
  issued_by uuid,
  issued_by_name text not null default '',
  issued_at timestamptz not null default now(),
  resent_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid,
  accepted_by_name text not null default '',
  accepted_via text check (accepted_via in ('portal', 'staff')),
  accept_note text not null default ''
);
create index enrollment_offer_letters_application_idx on public.enrollment_offer_letters(application_id, issued_at desc);
alter table public.enrollment_offer_letters enable row level security;
-- No direct access: the RPCs below read and write it.
revoke all on public.enrollment_offer_letters from anon, authenticated;
comment on table public.enrollment_offer_letters is 'Offer letters (LOO) issued for applications: the PDF, who it went to and why, and when and how it was accepted.';

/**
 * Who the offer letter goes to: an application started by an agent goes to its agent (the assigned agent, else the one who
 * started it); one the student started, or one staff created for the student, goes to the student.
 */
create function public.application_offer_recipient(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a public.enrollment_applications; v_agent boolean; p public.portal_profiles; v_name text; v_email text;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found then return null; end if;
 v_agent := a.created_by is not null and exists (select 1 from public.agency_memberships m where m.user_id = a.created_by and m.role in ('agent', 'agency_admin'));
 if v_agent then
  select * into p from public.portal_profiles x where x.id = a.assigned_agent_id and x.status = 'Active' and coalesce(btrim(x.email), '') <> '';
  if not found then select * into p from public.portal_profiles x where x.id = a.created_by; end if;
  return jsonb_build_object('kind', 'agent', 'name', coalesce(p.full_name, ''), 'email', lower(btrim(coalesce(p.email, ''))), 'user', p.auth_user_id,
    'reason', 'An agent started this application, so the letter goes to the agent');
 end if;
 select coalesce(nullif(btrim(s.full_name), ''), a.student_name), coalesce(nullif(lower(btrim(a.student_email)), ''), lower(btrim(coalesce(s.email, ''))))
   into v_name, v_email from (select 1) one left join public.enrollment_students s on s.id = a.student_id;
 return jsonb_build_object('kind', 'student', 'name', coalesce(v_name, ''), 'email', coalesce(v_email, ''), 'user', null,
   'reason', case when a.created_by is null then 'Staff created this application for the student, so the letter goes to the student'
     else 'The student applied directly, so the letter goes to the student' end);
end $$;
revoke all on function public.application_offer_recipient(uuid) from public, anon, authenticated;

/** The declarant name and digital signature must match (the review's declaration check), case and spacing aside. */
create function public.application_declaration_mismatch(p_application uuid) returns boolean language sql stable security definer set search_path = public as $$
  with v as (select public.application_values(p_application) as x)
  select coalesce(nullif(btrim(x->>'declaration_name'), ''), nullif(btrim(x->>'digital_signature'), '')) is not null
     and lower(regexp_replace(btrim(coalesce(x->>'declaration_name', '')), '\s+', ' ', 'g')) <> lower(regexp_replace(btrim(coalesce(x->>'digital_signature', '')), '\s+', ' ', 'g'))
  from v;
$$;
revoke all on function public.application_declaration_mismatch(uuid) from public, anon, authenticated;

/** For the staff drawer: who the letter will go to and why, and the declaration check. */
create function public.portal_offer_letter_recipient(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
 if not public.portal_is_slit_admin() or not public.portal_can_access_application(p_application) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 return public.application_offer_recipient(p_application) || jsonb_build_object('declarationMismatch', public.application_declaration_mismatch(p_application));
end $$;
revoke all on function public.portal_offer_letter_recipient(uuid) from public;
grant execute on function public.portal_offer_letter_recipient(uuid) to authenticated;

/**
 * Send offer letter: stores the PDF (made from a template or uploaded), moves the application to Offer letter issued through
 * the status command (workflow check, history, audit) and queues the email to the recipient. A declaration whose name and
 * signature do not match needs a staff note to go ahead (kept in the history).
 */
create function public.portal_offer_letter_issue(p_application uuid, p_source text, p_file_name text, p_content_base64 text, p_template uuid default null,
  p_message text default '', p_override_note text default '') returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; v_bytes bytea; v_route jsonb; v_id uuid; v_name text; v_mismatch boolean;
begin
 select * into a from public.enrollment_applications where id = p_application for update;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 if p_source not in ('template', 'upload') then raise exception 'Choose a template or upload the letter' using errcode = '22023'; end if;
 if not exists (select 1 from public.application_status_actions x where x.actor = 'staff' and x.from_status = a.status and x.kind = 'offer_letter') then
  raise exception 'An offer letter cannot be issued while the application is %', public.portal_status_label(a.status) using errcode = '22023';
 end if;
 begin v_bytes := decode(coalesce(p_content_base64, ''), 'base64'); exception when others then raise exception 'The letter is not a PDF' using errcode = '22023'; end;
 if v_bytes is null or length(v_bytes) < 5 or substring(v_bytes from 1 for 5) <> '\x255044462d'::bytea then raise exception 'The letter is not a PDF' using errcode = '22023'; end if;
 if length(v_bytes) > 3145728 then raise exception 'The letter is larger than 3 MB' using errcode = '22023'; end if;
 v_mismatch := public.application_declaration_mismatch(a.id);
 if v_mismatch and nullif(btrim(coalesce(p_override_note, '')), '') is null then
  raise exception 'The declarant name and digital signature do not match. Add a note to issue the offer letter anyway' using errcode = '22023';
 end if;
 v_route := public.application_offer_recipient(a.id);
 if coalesce(v_route->>'email', '') = '' then raise exception 'There is no email address to send the offer letter to' using errcode = '22023'; end if;
 select coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', '') into v_name;
 insert into public.enrollment_offer_letters(application_id, tenant_id, source, template_id, file_name, size_bytes, sha256, content, message, override_note,
   recipient_kind, recipient_name, recipient_email, issued_by, issued_by_name)
 values (a.id, a.tenant_id, p_source, p_template, left(coalesce(nullif(btrim(p_file_name), ''), 'Offer letter.pdf'), 200), length(v_bytes), encode(extensions.digest(v_bytes, 'sha256'), 'hex'), v_bytes,
   left(coalesce(p_message, ''), 2000), left(coalesce(p_override_note, ''), 500), v_route->>'kind', coalesce(v_route->>'name', ''), v_route->>'email', auth.uid(), coalesce(v_name, ''))
 returning id into v_id;
 perform set_config('portal.offer_command', a.id::text, true);
 perform public.portal_set_application_status(a.id, 'offer_issued',
   left(concat_ws(' · ', 'Offer letter sent to ' || (v_route->>'kind') || ' ' || (v_route->>'email'), nullif(btrim(p_message), ''),
     case when v_mismatch then 'Declaration mismatch accepted: ' || btrim(p_override_note) end), 1000));
 perform set_config('portal.offer_command', '', true);
 return jsonb_build_object('id', v_id, 'recipient', v_route);
end $$;
revoke all on function public.portal_offer_letter_issue(uuid, text, text, text, uuid, text, text) from public;
grant execute on function public.portal_offer_letter_issue(uuid, text, text, text, uuid, text, text) to authenticated;

/** Resend offer letter: the same letter to the same recipient again (no status change), recorded in the audit log. */
create function public.portal_offer_letter_resend(p_application uuid, p_note text default '') returns void language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; l public.enrollment_offer_letters;
begin
 select * into a from public.enrollment_applications where id = p_application for update;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 if not exists (select 1 from public.application_status_actions x where x.actor = 'staff' and x.from_status = a.status and x.kind = 'resend_offer') then
  raise exception 'The offer letter can only be resent while it waits for acceptance' using errcode = '22023';
 end if;
 select * into l from public.enrollment_offer_letters where application_id = a.id order by issued_at desc limit 1;
 if not found then raise exception 'No offer letter was issued for this application' using errcode = '22023'; end if;
 update public.enrollment_offer_letters set resent_at = now() where id = l.id;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
 values (auth.uid(), coalesce(auth.jwt()->>'email', 'Authorized reviewer'), 'slit_admin', 'offer_letter_resent', 'application', a.id::text, a.id, jsonb_build_object('letter', l.id, 'note', left(coalesce(p_note, ''), 500)));
 insert into public.admission_event_outbox(application_id, tenant_id, event, payload)
 values (a.id, a.tenant_id, 'offer_letter_issued', jsonb_build_object('letter', l.id, 'resend', true, 'note', left(coalesce(p_note, ''), 500), 'actor', auth.uid()));
end $$;
revoke all on function public.portal_offer_letter_resend(uuid, text) from public;
grant execute on function public.portal_offer_letter_resend(uuid, text) to authenticated;

/** The current offer letter of an application (no content), for anyone who can see the application. */
create function public.portal_offer_letter_current(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare l public.enrollment_offer_letters;
begin
 if not public.portal_can_access_application(p_application) then raise exception 'Application not found' using errcode = '42501'; end if;
 select * into l from public.enrollment_offer_letters where application_id = p_application order by issued_at desc limit 1;
 if not found then return null; end if;
 return jsonb_build_object('id', l.id, 'fileName', l.file_name, 'sizeBytes', l.size_bytes, 'source', l.source, 'message', l.message, 'recipientKind', l.recipient_kind,
   'recipientName', l.recipient_name, 'recipientEmail', l.recipient_email, 'issuedAt', l.issued_at, 'issuedByName', l.issued_by_name, 'resentAt', l.resent_at,
   'acceptedAt', l.accepted_at, 'acceptedByName', l.accepted_by_name, 'acceptedVia', l.accepted_via);
end $$;
revoke all on function public.portal_offer_letter_current(uuid) from public;
grant execute on function public.portal_offer_letter_current(uuid) to authenticated;

/** Every offer letter of an application (the Documents tab), newest first, without content. */
create function public.portal_offer_letter_list(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
 if not public.portal_can_access_application(p_application) then raise exception 'Application not found' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'fileName', l.file_name, 'sizeBytes', l.size_bytes, 'issuedAt', l.issued_at, 'acceptedAt', l.accepted_at,
   'recipientKind', l.recipient_kind, 'recipientEmail', l.recipient_email) order by l.issued_at desc) from public.enrollment_offer_letters l where l.application_id = p_application), '[]'::jsonb);
end $$;
revoke all on function public.portal_offer_letter_list(uuid) from public;
grant execute on function public.portal_offer_letter_list(uuid) to authenticated;

/** The PDF of one offer letter (base64), for anyone who can see the application. */
create function public.portal_offer_letter_content(p_letter uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare l public.enrollment_offer_letters;
begin
 select * into l from public.enrollment_offer_letters where id = p_letter;
 if not found or not public.portal_can_access_application(l.application_id) then raise exception 'Offer letter not found' using errcode = '42501'; end if;
 return jsonb_build_object('fileName', l.file_name, 'contentBase64', encode(l.content, 'base64'));
end $$;
revoke all on function public.portal_offer_letter_content(uuid) from public;
grant execute on function public.portal_offer_letter_content(uuid) to authenticated;

/**
 * Accept offer: the student, or the agent on the student's behalf, confirms in the portal (no signature). The time and who are
 * recorded on the letter; the application moves to Offer accepted (history, audit, the offer_accepted email).
 */
create function public.portal_offer_accept(p_application uuid) returns void language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; l public.enrollment_offer_letters; v_name text;
begin
 select * into a from public.enrollment_applications where id = p_application for update;
 if not found or not public.portal_can_access_application(a.id) then raise exception 'Application not found' using errcode = '42501'; end if;
 if public.portal_is_slit_admin() then raise exception 'Staff record an acceptance with Mark offer accepted' using errcode = '42501'; end if;
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
end $$;
revoke all on function public.portal_offer_accept(uuid) from public;
grant execute on function public.portal_offer_accept(uuid) to authenticated;

/** Resubmit: the student or agent sends an application back from Action required once it is corrected. */
create function public.portal_application_resubmit(p_application uuid, p_note text default '') returns void language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; v_name text;
begin
 select * into a from public.enrollment_applications where id = p_application for update;
 if not found or not public.portal_can_edit_application(a.id) then raise exception 'Application not found' using errcode = '42501'; end if;
 if public.portal_is_slit_admin() then raise exception 'The student or agent resubmits the application' using errcode = '42501'; end if;
 if not exists (select 1 from public.application_status_actions x where x.actor = 'applicant' and x.from_status = a.status and x.kind = 'resubmit') then
  raise exception 'Only an application that needs action can be resubmitted' using errcode = '22023';
 end if;
 select coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', '') into v_name;
 perform set_config('portal.status_command', a.id::text, true);
 perform set_config('portal.status_note', left(coalesce(nullif(btrim(p_note), ''), 'Resubmitted after corrections'), 500), true);
 update public.enrollment_applications set status = 'submitted' where id = a.id;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
 values (auth.uid(), coalesce(v_name, 'Applicant'), case when public.portal_student_id() is not null then 'student' when public.portal_is_agency_admin() then 'agency_admin' else 'agent' end,
   'status_change', 'application', a.id::text, a.id, jsonb_build_object('from', a.status, 'to', 'submitted', 'note', left(coalesce(p_note, ''), 500)));
 insert into public.admission_event_outbox(application_id, tenant_id, event, payload)
 values (a.id, a.tenant_id, 'application_status_changed', jsonb_build_object('from', a.status, 'to', 'submitted', 'actor', auth.uid()));
end $$;
revoke all on function public.portal_application_resubmit(uuid, text) from public;
grant execute on function public.portal_application_resubmit(uuid, text) to authenticated;

/** Send reminder: emails the offer letter's would-be recipient (agent or student) what Action required still asks for. */
create function public.portal_application_reminder(p_application uuid, p_note text default '') returns void language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; v_reason text;
begin
 select * into a from public.enrollment_applications where id = p_application for update;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 if not exists (select 1 from public.application_status_actions x where x.actor = 'staff' and x.from_status = a.status and x.kind = 'reminder') then
  raise exception 'A reminder is only sent while the application needs action' using errcode = '22023';
 end if;
 select h.note into v_reason from public.enrollment_application_status_history h where h.application_id = a.id and h.new_status = 'action_required' order by h.created_at desc limit 1;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
 values (auth.uid(), coalesce(auth.jwt()->>'email', 'Authorized reviewer'), 'slit_admin', 'action_required_reminder', 'application', a.id::text, a.id, jsonb_build_object('note', left(coalesce(p_note, ''), 500)));
 insert into public.admission_event_outbox(application_id, tenant_id, event, payload)
 values (a.id, a.tenant_id, 'action_required_reminder', jsonb_build_object('reason', coalesce(v_reason, ''), 'note', left(coalesce(p_note, ''), 500), 'actor', auth.uid()));
end $$;
revoke all on function public.portal_application_reminder(uuid, text) from public;
grant execute on function public.portal_application_reminder(uuid, text) to authenticated;

/** For the email worker: the PDF of the letter an offer_letter_issued delivery is about (lease-checked). */
create function public.notification_delivery_offer_letter(p_id uuid, p_lease uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare x public.notification_deliveries; o public.admission_event_outbox; l public.enrollment_offer_letters;
begin
 select * into x from public.notification_deliveries y where y.id = p_id and y.lease_token = p_lease and y.state = 'sending' and y.event = 'offer_letter_issued';
 if not found then return null; end if;
 select * into o from public.admission_event_outbox b where b.id = x.outbox_id;
 select * into l from public.enrollment_offer_letters c where c.id = coalesce((o.payload->>'letter')::uuid, (select z.id from public.enrollment_offer_letters z where z.application_id = x.application_id order by z.issued_at desc limit 1));
 if not found then return null; end if;
 return jsonb_build_object('fileName', l.file_name, 'sizeBytes', l.size_bytes, 'contentBase64', encode(l.content, 'base64'));
end $$;
revoke all on function public.notification_delivery_offer_letter(uuid, uuid) from public, anon, authenticated;
grant execute on function public.notification_delivery_offer_letter(uuid, uuid) to service_role;

/* --------------------------------------------------------- the status command, updated */

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
 if not allowed then raise exception 'Invalid admissions transition: % to %',a.status,p_status using errcode='22023'; end if;
 if p_status='action_required' and nullif(btrim(p_note),'') is null then raise exception 'A correction reason is required' using errcode='22023'; end if;
 -- Offer letter issued only through Send offer letter (the letter is stored and sent with it).
 if p_status='offer_issued' and current_setting('portal.offer_command',true) is distinct from a.id::text then
  raise exception 'Use Issue offer letter to move this application to Offer letter issued' using errcode='22023';
 end if;
 select * into v_action from public.application_status_actions x where x.actor='staff' and x.from_status=a.status and x.to_status=p_status order by x.sort limit 1;
 if found and v_action.note='required' and nullif(btrim(p_note),'') is null then raise exception '% needs a note', v_action.label using errcode='22023'; end if;
 perform set_config('portal.status_command',a.id::text,true);
 perform set_config('portal.status_note',coalesce(p_note,''),true);
 update public.enrollment_applications set status=p_status where id=a.id;
 -- An offer marked accepted by staff (e.g. accepted by email) is recorded on the letter too.
 if p_status='offer_accepted' then
  update public.enrollment_offer_letters set accepted_at=now(), accepted_by=auth.uid(), accepted_via='staff', accept_note=left(coalesce(p_note,''),500),
   accepted_by_name=coalesce((select c.name from public.cms_users c where c.auth_user_id=auth.uid() limit 1), auth.jwt()->>'email', '')
  where id=(select z.id from public.enrollment_offer_letters z where z.application_id=a.id and z.accepted_at is null order by z.issued_at desc limit 1);
 end if;
 insert into public.portal_audit_log(actor,actor_name,actor_role,action,target_type,target_id,application_id,detail)
 values(auth.uid(),coalesce(auth.jwt()->>'email','Authorized reviewer'),'slit_admin','status_change','application',a.id::text,a.id,jsonb_build_object('from',a.status,'to',p_status,'note',p_note)||case when v_config is null then '{}'::jsonb else jsonb_build_object('workflowVersion',(select version from public.tenant_config_versions where id=a.workflow_version_id)) end);
 insert into public.admission_event_outbox(application_id,tenant_id,event,payload)
 values(a.id,a.tenant_id,case p_status when 'offer_accepted' then 'offer_accepted' when 'coe_issued' then 'coe_voe_issued' when 'offer_issued' then 'offer_letter_issued' else 'application_status_changed' end,
  jsonb_build_object('from',a.status,'to',p_status,'actor',auth.uid())
  || case when p_status='offer_issued' then jsonb_build_object('letter',(select z.id from public.enrollment_offer_letters z where z.application_id=a.id order by z.issued_at desc limit 1)) else '{}'::jsonb end);
end; $$;

-- In-portal notifications and history read the catalogue's labels ("Offer letter issued", not "offer issued").
create or replace function public.portal_on_application_change() returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_note text := coalesce(current_setting('portal.status_note', true), '');
  v_name text;
  v_role text;
  v_app_ref text;
begin
  new.updated_at := now();

  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.status is distinct from old.status then
    select coalesce(
             (select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1),
             (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1),
             auth.jwt()->>'email',
             'System'
           ) into v_name;

    v_role := case
      when public.portal_is_slit_admin() then 'slit_admin'
      when public.portal_is_agency_admin() then 'agency_admin'
      when public.portal_is_agent() then 'agent'
      when public.portal_student_id() is not null then 'student'
      else 'system'
    end;

    insert into public.enrollment_application_status_history
      (application_id, previous_status, new_status, actor, actor_name, actor_role, note)
    values (new.id, old.status, new.status, auth.uid(), v_name, v_role, v_note);

    -- Notify the assigned agent + the agency's admins.
    v_app_ref := coalesce(new.reference, left(new.id::text, 8));
    insert into public.portal_notifications (recipient, application_id, reference, event, title, message)
    select p.auth_user_id, new.id, v_app_ref, 'status_change',
           'Application ' || v_app_ref || ' is now ' || public.portal_status_label(new.status),
           'Status changed from ' || public.portal_status_label(old.status) || ' to ' || public.portal_status_label(new.status) || '.'
    from public.portal_profiles p
    where p.status = 'Active' and p.auth_user_id is not null
      and (
        p.id = new.assigned_agent_id
        or exists (
          select 1 from public.agency_memberships m
          where m.user_id = p.id and m.agency_id = new.agency_id
            and m.status = 'Active' and m.role = 'agency_admin'
        )
      );
  end if;

  return new;
end;
$$;

/* ------------------------------------------------------------------- notifications */

-- Defaults gain the two new emails, and new tenant workflows start from the same graph as the table.
create or replace function public.tenant_config_defaults(p_kind text) returns jsonb language sql immutable set search_path = public as $$
  select case p_kind
    when 'workflow' then jsonb_build_object(
      'statuses', '["draft","submitted","action_required","offer_issued","offer_accepted","coe_issued","enrolled","rejected","withdrawn"]'::jsonb,
      'transitions', '[{"from":"draft","to":"submitted"},
        {"from":"submitted","to":"action_required"},{"from":"submitted","to":"offer_issued"},{"from":"submitted","to":"rejected"},{"from":"submitted","to":"withdrawn"},
        {"from":"action_required","to":"rejected"},{"from":"action_required","to":"withdrawn"},
        {"from":"offer_issued","to":"offer_accepted"},{"from":"offer_issued","to":"rejected"},{"from":"offer_issued","to":"withdrawn"},
        {"from":"offer_accepted","to":"coe_issued"},{"from":"offer_accepted","to":"rejected"},{"from":"offer_accepted","to":"withdrawn"},
        {"from":"coe_issued","to":"enrolled"},{"from":"coe_issued","to":"withdrawn"}]'::jsonb)
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
$$;

-- The offer letter and the reminder go to one routed recipient (agent or student, application_offer_recipient) with a link to
-- the application; every other event is queued exactly as before.
create or replace function public.notification_enqueue_deliveries()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  a public.enrollment_applications; v_id uuid; v_cfg jsonb; v_defaults jsonb := public.tenant_config_defaults('notifications');
  v_tpl jsonb; v_vars jsonb; v_enabled boolean; v_pref boolean; v_sender jsonb; r record; v_active boolean; v_set jsonb; v_source text;
  v_subject text; v_body text; v_addr text; v_state text; v_reason text; v_route jsonb; v_host text; v_link text; v_extra text; v_valid boolean;
begin
  if new.event in ('offer_letter_issued', 'action_required_reminder') then
    select * into a from public.enrollment_applications where id = new.application_id;
    select id, config into v_id, v_cfg from public.tenant_config_versions where tenant_id = new.tenant_id and kind = 'notifications' and state = 'published';
    v_tpl := coalesce(v_cfg->'templates'->new.event, v_defaults->'templates'->new.event);
    v_sender := case when v_cfg->'sender' is not null and public.notification_sender_allowed(new.tenant_id, v_cfg->'sender'->>'email') then v_cfg->'sender' else null end;
    v_active := exists (select 1 from public.notification_activation act where act.revoked_at is null and act.tenant_id is not distinct from new.tenant_id);
    v_source := case when v_cfg is null then 'default' else 'published' end;
    v_route := public.application_offer_recipient(a.id);
    v_host := case when a.tenant_id is null then 'slit.edu.au' else (select min(t.hostname) from public.tenant_domains t where t.tenant_id = a.tenant_id and t.verified_at is not null) end;
    v_link := case when v_host is null then '' else 'https://' || v_host || '/agency/applications/' || a.id::text end;
    v_extra := case when new.event = 'offer_letter_issued'
      then coalesce(E'\n\n' || nullif(btrim(coalesce((select l.message from public.enrollment_offer_letters l where l.id = (new.payload->>'letter')::uuid), '')), ''), '')
        || case when v_link <> '' then E'\n\nView and accept the offer (sign-in required): ' || v_link else '' end
      else coalesce(E'\n\nWhat is needed: ' || nullif(btrim(coalesce(new.payload->>'reason', '')), ''), '') || coalesce(E'\n\n' || nullif(btrim(coalesce(new.payload->>'note', '')), ''), '')
        || case when v_link <> '' then E'\n\nOpen the application (sign-in required): ' || v_link else '' end end;
    v_vars := jsonb_build_object(
      'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)),
      'student', coalesce(nullif(btrim(a.student_name), ''), 'the student'),
      'status', public.portal_status_label(a.status),
      'previousStatus', '',
      'message', v_extra,
      'institution', coalesce((select name from public.tenants where id = new.tenant_id), 'Skyline'));
    v_subject := public.notification_render(v_tpl->>'subject', v_vars);
    v_body := public.notification_render(v_tpl->>'body', v_vars);
    v_addr := lower(btrim(coalesce(v_route->>'email', '')));
    v_valid := v_addr ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' and length(v_addr) <= 254;
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (new.id, new.tenant_id, new.application_id, nullif(v_route->>'user', '')::uuid, left(v_addr, 254), new.event, v_source, v_id, v_sender, v_subject, v_body,
      case when not v_valid then 'suppressed' when v_active then 'pending' else 'suppressed' end,
      case when not v_valid then 'invalid_recipient' when v_active then null else 'legacy_scope_not_activated' end, clock_timestamp())
    on conflict do nothing;
    return new;
  end if;
  if new.event not in ('application_submitted', 'application_status_changed', 'offer_accepted', 'coe_voe_issued') then return new; end if;
  select * into a from public.enrollment_applications where id = new.application_id;
  select id, config into v_id, v_cfg from public.tenant_config_versions where tenant_id = new.tenant_id and kind = 'notifications' and state = 'published';
  v_enabled := coalesce((v_cfg->'defaults'->>new.event)::boolean, (v_defaults->'defaults'->>new.event)::boolean, true);
  if not v_enabled then return new; end if;
  v_tpl := coalesce(v_cfg->'templates'->new.event, v_defaults->'templates'->new.event);
  v_sender := case when v_cfg->'sender' is not null and public.notification_sender_allowed(new.tenant_id, v_cfg->'sender'->>'email') then v_cfg->'sender' else null end;
  v_active := exists (select 1 from public.notification_activation act where act.revoked_at is null and act.tenant_id is not distinct from new.tenant_id);
  v_set := public.notification_event_settings(new.tenant_id, new.event);
  v_source := case when v_cfg is null then 'default' else 'published' end;
  v_vars := jsonb_build_object(
    'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)),
    'status', public.portal_status_label(coalesce(new.payload->>'to', a.status)),
    'previousStatus', public.portal_status_label(coalesce(new.payload->>'from', case when new.event = 'application_submitted' then 'draft' else '' end)),
    'institution', coalesce((select name from public.tenants where id = new.tenant_id), 'Skyline'));
  v_subject := public.notification_render(v_tpl->>'subject', v_vars);
  v_body := public.notification_render(v_tpl->>'body', v_vars);
  -- Portal users: the assigned agent and / or the agency admins, per the event settings; per-user opt-outs apply.
  for r in
    select p.auth_user_id, lower(trim(coalesce(p.email, ''))) as email from public.portal_profiles p
    where p.status = 'Active' and p.auth_user_id is not null
      and ((coalesce((v_set->>'notifyAgent')::boolean, false) and p.id = a.assigned_agent_id)
        or (coalesce((v_set->>'notifyAgencyAdmins')::boolean, false) and exists (select 1 from public.agency_memberships m where m.user_id = p.id and m.agency_id = a.agency_id and m.status = 'Active' and m.role = 'agency_admin')))
  loop
    -- A selected user without a usable address is recorded as a visible suppressed delivery, never skipped silently.
    if r.email = '' or length(r.email) > 254 or r.email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then
      insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
      values (new.id, new.tenant_id, new.application_id, r.auth_user_id, left(r.email, 254), new.event, v_source, v_id, v_sender, v_subject, v_body, 'suppressed', 'invalid_recipient', clock_timestamp())
      on conflict do nothing;
      continue;
    end if;
    v_pref := coalesce((select email_enabled from public.notification_preferences where auth_user_id = r.auth_user_id and event = new.event), true);
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (new.id, new.tenant_id, new.application_id, r.auth_user_id, r.email, new.event, v_source, v_id, v_sender, v_subject, v_body,
      case when v_active and v_pref then 'pending' else 'suppressed' end,
      case when not v_active then 'legacy_scope_not_activated' when v_pref then null else 'recipient_opted_out' end, clock_timestamp())
    on conflict do nothing;
  end loop;
  -- Recipients without a portal account: the configured internal addresses and, when enabled, the student. One delivery per address per event.
  v_state := case when v_active then 'pending' else 'suppressed' end;
  v_reason := case when v_active then null else 'legacy_scope_not_activated' end;
  if coalesce((v_set->>'notifyStudent')::boolean, false)
     and not (a.student_email ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' and length(a.student_email) <= 254) then
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (new.id, new.tenant_id, new.application_id, null, left(lower(btrim(coalesce(a.student_email, ''))), 254), new.event, v_source, v_id, v_sender, v_subject, v_body, 'suppressed', 'invalid_recipient', clock_timestamp())
    on conflict do nothing;
  end if;
  for v_addr in
    select distinct x from (
      select lower(btrim(e)) as x from jsonb_array_elements_text(coalesce(v_set->'recipients', '[]'::jsonb)) e
      union all
      select lower(btrim(a.student_email)) where coalesce((v_set->>'notifyStudent')::boolean, false) and a.student_email ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' and length(a.student_email) <= 254
    ) s where x is not null and x <> ''
  loop
    if exists (select 1 from public.notification_deliveries d where d.outbox_id = new.id and lower(d.recipient_email) = v_addr) then continue; end if;
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (new.id, new.tenant_id, new.application_id, null, v_addr, new.event, v_source, v_id, v_sender, v_subject, v_body, v_state, v_reason, clock_timestamp())
    on conflict do nothing;
  end loop;
  return new;
end;
$function$;
