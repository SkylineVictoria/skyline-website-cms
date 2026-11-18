-- Agency onboarding: automatic flow with admin review and a correction loop (owner brief 2026-11-18).
--
--   Application sent -> Awaiting referees -> Ready for review -> (Correction requested -> Resubmitted)* -> Active
--
--   * Add business sends the F04 to the point of contact (POC, the agency admin) at once (unchanged). Both referees back = Ready for
--     review; staff are told by email and on the dashboard (Needs action today).
--   * Staff review the application in the F04 wizard (admin-review mode): edits are saved with an audit line per field (who, old, new)
--     and make a new PDF revision "edited by SLIT staff" (agency_onboarding_revisions; no re-signing); flagged fields with notes and an
--     optional message go back to the POC as a correction request (a new F04 request, prefilled; only flagged fields editable, enforced by
--     document-signing); the POC re-ticks the declaration and re-signs: Resubmitted (new signed PDF kept as a revision). A referee whose
--     details were flagged and changed gets a new F05. The loop repeats until Approve.
--   * Approve and activate agency: the BUSINESS goes Active (agents do not), the P06 goes to the POC (document-signing). The held sign-in
--     invitations (POC and agents added meanwhile) are released automatically when the P06 is signed (owner's choice 2026-11-18: no agent
--     signs in before the agreement is signed; the rule of 20261118023417 stays). Until then the business counts as Onboarding.
-- Additive: two stages, two tables, new functions; existing functions are patched in place (single-line anchors, exact counts).
set local lock_timeout = '5s';

create or replace function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

-- ------------------------------------------------------------------ stages
alter table public.agency_onboarding drop constraint if exists agency_onboarding_stage_check;
alter table public.agency_onboarding add constraint agency_onboarding_stage_check check (stage = any (array['legacy', 'application_sent', 'application_signed', 'references_pending',
 'references_received', 'references_approved', 'declined', 'agreement_sent', 'agreement_signed', 'cancelled', 'expired', 'activated', 'correction_requested', 'resubmitted']));
drop index if exists public.agency_onboarding_business_open_idx;
create unique index agency_onboarding_business_open_idx on public.agency_onboarding(agency_id)
 where kind = 'business' and stage in ('application_sent', 'application_signed', 'references_pending', 'references_received', 'references_approved', 'agreement_sent', 'correction_requested', 'resubmitted');

-- ------------------------------------------------------------------ correction rounds and PDF revisions (history on the business page)
create table if not exists public.agency_onboarding_corrections(
 id uuid primary key default gen_random_uuid(),
 onboarding_id uuid not null references public.agency_onboarding(id) on delete cascade,
 round integer not null check (round between 1 and 100),
 message text check (message is null or length(message) <= 2000),
 flags jsonb not null default '{}'::jsonb check (jsonb_typeof(flags) = 'object'),
 request_id uuid references hr.sign_requests(id) on delete set null,
 previous_request_id uuid references hr.sign_requests(id) on delete set null,
 previous_stage text not null,
 status text not null default 'open' check (status in ('open', 'resubmitted', 'closed')),
 changes jsonb not null default '[]'::jsonb,
 requested_by uuid, requested_by_name text, requested_at timestamptz not null default now(),
 resubmitted_at timestamptz, closed_at timestamptz, closed_reason text,
 unique (onboarding_id, round));
create unique index if not exists agency_onboarding_corrections_open_idx on public.agency_onboarding_corrections(onboarding_id) where status = 'open';
alter table public.agency_onboarding_corrections enable row level security;
revoke all on public.agency_onboarding_corrections from public, anon, authenticated;
comment on table public.agency_onboarding_corrections is 'F04 correction rounds: the fields staff flagged (with notes), the message, the correction request and what the agency admin changed.';

create table if not exists public.agency_onboarding_revisions(
 id uuid primary key default gen_random_uuid(),
 onboarding_id uuid not null references public.agency_onboarding(id) on delete cascade,
 revision integer not null check (revision between 2 and 1000),
 kind text not null check (kind in ('staff_edit', 'resubmitted')),
 request_id uuid references hr.sign_requests(id) on delete set null,
 note text check (note is null or length(note) <= 500),
 changes jsonb not null default '[]'::jsonb,
 content bytea not null check (length(content) between 5 and 15728640),
 sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
 created_by uuid, created_by_name text, created_at timestamptz not null default now(),
 unique (onboarding_id, revision));
alter table public.agency_onboarding_revisions enable row level security;
revoke all on public.agency_onboarding_revisions from public, anon, authenticated;
comment on table public.agency_onboarding_revisions is 'F04 PDF revisions after the first signature: edited by SLIT staff (no re-signing) or re-signed after a correction. Revision 1 is agency_onboarding.form_content.';

create or replace function public.agency_onboarding_next_revision(p_onboarding uuid) returns integer
language sql stable security definer set search_path = pg_catalog, public as $f$
 select coalesce((select max(revision) from public.agency_onboarding_revisions where onboarding_id = p_onboarding), 1) + 1;
$f$;
revoke all on function public.agency_onboarding_next_revision(uuid) from public, anon, authenticated;

-- The answer key of a request field (agent_abn_form -> agent_abn; a tick box -> its question).
create or replace function public.agency_onboarding_answer_key(p_key text) returns text
language sql immutable set search_path = pg_catalog as $f$ select regexp_replace(split_part(coalesce(p_key, ''), ':', 1), '_(form|referee)$', '') $f$;

-- ------------------------------------------------------------------ the business status in words (business page and list)
create or replace function public.agency_onboarding_label(p_business uuid) returns text
language sql stable security definer set search_path = pg_catalog, public as $f$
 select case
  when a.id is null or coalesce(a.is_direct, false) or o.id is null or o.stage = 'legacy' then null
  when o.stage = 'application_sent' then 'Application sent'
  when o.stage in ('application_signed', 'references_pending') then 'Awaiting referees'
  when o.stage = 'references_received' then 'Ready for review'
  when o.stage = 'correction_requested' then 'Correction requested'
  when o.stage = 'resubmitted' then case when exists (select 1 from public.agency_onboarding_referees f where f.onboarding_id = o.id and f.status <> 'received') then 'Awaiting referees' else 'Resubmitted' end
  when a.status = 'Active' and o.stage in ('references_approved', 'agreement_sent', 'agreement_signed', 'activated') then 'Active'
  when o.stage = 'agreement_signed' then 'Ready to activate'
  when o.stage = 'agreement_sent' then 'Agreement sent'
  when o.stage = 'references_approved' then 'Approved'
  when o.stage = 'declined' then 'Declined'
  when o.stage = 'cancelled' then 'Cancelled'
  when o.stage = 'expired' then 'Expired' end
 from public.agencies a left join lateral (select * from public.agency_onboarding x where x.agency_id = a.id and x.kind = 'business' order by x.created_at desc limit 1) o on true
 where a.id = p_business;
$f$;
revoke all on function public.agency_onboarding_label(uuid) from public, anon;
grant execute on function public.agency_onboarding_label(uuid) to authenticated;

-- ------------------------------------------------------------------ approved, agreement not signed yet: still Onboarding (invites held)
create or replace function public.agency_awaiting_agreement(p_business uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $f$
 select exists (select 1 from public.agencies a where a.id = p_business and not coalesce(a.is_direct, false))
  and not public.business_agreement_ready(p_business)
  and coalesce((select o.stage from public.agency_onboarding o where o.agency_id = p_business and o.kind = 'business' order by o.created_at desc limit 1), '') in ('references_approved', 'agreement_sent');
$f$;
revoke all on function public.agency_awaiting_agreement(uuid) from public, anon;
select pg_temp.patch('public.agency_effective_status(public.agencies)',
 $a$when a.status = 'Onboarding' then 'Onboarding'$a$,
 $a$when a.status = 'Onboarding' then 'Onboarding'
  when a.status = 'Active' and public.agency_awaiting_agreement(a.id) then 'Onboarding'$a$);
select pg_temp.patch('public.agency_business_holds_invites(uuid)', $a$a.status = 'Onboarding'$a$, $a$public.agency_effective_status(a) = 'Onboarding'$a$);
select pg_temp.patch('public.agency_gate_reason(public.agencies)',
 $a$when 'Onboarding' then case when public.business_agreement_ready(a.id) then$a$,
 $a$when 'Onboarding' then case when a.status = 'Active' then 'This business is approved: agents can be added now; their sign-in invitations go out when the agent agreement is signed.'
   when public.business_agreement_ready(a.id) then$a$);

-- ------------------------------------------------------------------ the new stages count as an onboarding in progress
select pg_temp.patch('public.agency_onboarding_create(uuid, uuid, uuid, jsonb)', $a$'references_approved', 'agreement_sent')) then$a$,
 $a$'references_approved', 'agreement_sent', 'correction_requested', 'resubmitted')) then$a$);
select pg_temp.patch('public.agency_business_activate(uuid)', $a$'references_approved', 'agreement_sent') then$a$,
 $a$'references_approved', 'agreement_sent', 'correction_requested', 'resubmitted') then$a$);
-- A changed referee of a resubmitted application gets a new referee check.
select pg_temp.patch('public.agency_onboarding_referee_request_create(uuid, jsonb)', $a$if o.stage not in ('application_signed', 'references_pending') then raise exception$a$,
 $a$if o.stage not in ('application_signed', 'references_pending', 'resubmitted') then raise exception$a$);

-- ------------------------------------------------------------------ staff review: read, edit (audited), revisions
create or replace function public.agency_onboarding_review_get(p_onboarding uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; a public.agencies; g public.agents; k public.agency_onboarding_corrections;
begin
 perform hr.require_admin();
 select * into o from public.agency_onboarding where id = p_onboarding;
 if not found or o.kind <> 'business' then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.application_signed_at is null then raise exception 'The application form is not signed yet' using errcode = '22023'; end if;
 select * into a from public.agencies where id = o.agency_id;
 select * into g from public.agents where id = o.agent_id;
 select * into k from public.agency_onboarding_corrections c where c.onboarding_id = o.id and c.status = 'open';
 return jsonb_build_object('onboardingId', o.id, 'stage', o.stage, 'label', public.agency_onboarding_label(a.id),
  'agency', jsonb_build_object('id', a.id, 'name', a.name, 'abn', a.registration_number, 'status', a.status),
  'contact', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email, 'role', g.role),
  'requestId', o.application_request_id, 'signerName', o.signer_name, 'signedAt', o.application_signed_at,
  -- The form's structure comes from the first signed request (a correction request has the same fields).
  'fields', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'key', f.key, 'type', f.type, 'label', f.label, 'required', f.required, 'page', f.page) order by f.page, f.y, f.x)
   from hr.sign_fields f where f.request_id = coalesce((select c.previous_request_id from public.agency_onboarding_corrections c where c.onboarding_id = o.id order by c.round limit 1), o.application_request_id)
    and f.key is not null and f.type in ('text', 'checkbox')), '[]'::jsonb),
  'answers', coalesce(o.answers, '{}'::jsonb), 'facts', a.profile->'abr_facts',
  'attachments', coalesce((select jsonb_object_agg(x.kind, jsonb_build_object('name', x.file_name, 'size', x.size_bytes, 'at', x.uploaded_at))
   from public.agency_onboarding_attachments x where x.request_id = o.application_request_id), '{}'::jsonb),
  'referees', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'position', f.position, 'name', f.contact_name, 'organisation', f.organisation, 'positionTitle', f.position_title,
    'email', f.email, 'phone', f.phone, 'status', f.status, 'receivedAt', f.received_at, 'receivedVia', f.received_via, 'answers', f.answers) order by f.position)
   from public.agency_onboarding_referees f where f.onboarding_id = o.id), '[]'::jsonb),
  'correction', case when k.id is null then null else jsonb_build_object('round', k.round, 'message', k.message, 'flags', k.flags, 'requestedAt', k.requested_at, 'by', k.requested_by_name) end);
end $f$;
revoke all on function public.agency_onboarding_review_get(uuid) from public, anon;
grant execute on function public.agency_onboarding_review_get(uuid) to authenticated;

create or replace function public.agency_onboarding_review_save(p_onboarding uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; e record; v_old text; v_new text; v_answers jsonb; v_profile jsonb := '{}'::jsonb; v_drop text[] := '{}'; v_changes jsonb := '[]'::jsonb; v_keys text[]; v_name text;
begin
 perform hr.require_admin();
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found or o.kind <> 'business' then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.stage not in ('application_signed', 'references_pending', 'references_received', 'resubmitted') then
  raise exception 'The application can be edited once it is signed and before it is approved (not while a correction is with the agency).' using errcode = '22023'; end if;
 if jsonb_typeof(coalesce(p_changes, '{}'::jsonb)) <> 'object' then raise exception 'Nothing to save' using errcode = '22023'; end if;
 select array_agg(distinct public.agency_onboarding_answer_key(f.key)) into v_keys from hr.sign_fields f
  where f.request_id in (o.application_request_id, (select c.previous_request_id from public.agency_onboarding_corrections c where c.onboarding_id = o.id order by c.round limit 1)) and f.key is not null;
 v_keys := coalesce(v_keys, '{}') || array['agent_acn', 'agent_marn'];
 v_answers := coalesce(o.answers, '{}'::jsonb);
 for e in select key, value from jsonb_each_text(p_changes) loop
  if not (e.key = any(v_keys)) or e.key in ('agent_registration_number') then raise exception 'Unknown field: %', left(e.key, 60) using errcode = '22023'; end if;
  v_new := left(btrim(regexp_replace(coalesce(e.value, ''), '[[:cntrl:]]', ' ', 'g')), 500);
  if e.key = 'agent_acn' then v_new := regexp_replace(v_new, '[\s-]', '', 'g'); if v_new <> '' and v_new !~ '^\d{9}$' then raise exception 'The ACN has 9 digits.' using errcode = '22023'; end if; end if;
  if e.key = 'agent_marn' then v_new := regexp_replace(v_new, '\s', '', 'g'); if v_new <> '' and v_new !~ '^\d{1,10}$' then raise exception 'The MARN is a number: digits only.' using errcode = '22023'; end if; end if;
  v_old := coalesce(v_answers->>e.key, '');
  if v_old = v_new then continue; end if;
  v_changes := v_changes || jsonb_build_array(jsonb_build_object('field', e.key, 'old', v_old, 'new', v_new));
  if v_new = '' then v_answers := v_answers - e.key; v_drop := v_drop || e.key; else v_answers := v_answers || jsonb_build_object(e.key, v_new); v_profile := v_profile || jsonb_build_object(e.key, v_new); end if;
 end loop;
 if jsonb_array_length(v_changes) = 0 then return jsonb_build_object('changed', 0, 'changes', v_changes); end if;
 update public.agency_onboarding set answers = v_answers where id = o.id;
 update public.agencies set profile = (coalesce(profile, '{}'::jsonb) - v_drop) || v_profile, updated_at = now() where id = o.agency_id;
 select name into v_name from public.cms_users where auth_user_id = auth.uid() limit 1;
 perform public.agency_onboarding_log(o.id, 'staff_edit', jsonb_build_object('changes', v_changes, 'count', jsonb_array_length(v_changes)));
 perform public.admin_business_audit('agent_application_edited', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'by', v_name, 'changes', v_changes));
 return jsonb_build_object('changed', jsonb_array_length(v_changes), 'changes', v_changes);
end $f$;
revoke all on function public.agency_onboarding_review_save(uuid, jsonb) from public, anon;
grant execute on function public.agency_onboarding_review_save(uuid, jsonb) to authenticated;

-- What document-signing needs to draw a revision: the signed request's original, its fields and its signer (the signature as signed).
create or replace function public.agency_onboarding_revision_source(p_onboarding uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; r hr.sign_requests;
begin
 perform hr.require_admin();
 select * into o from public.agency_onboarding where id = p_onboarding;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 -- The last signed application request (a correction request out for signature is not signed yet).
 select * into r from hr.sign_requests q where q.agency_onboarding_id = o.id and q.state = 'signed'
  and (q.id = o.application_request_id or q.id in (select c.request_id from public.agency_onboarding_corrections c where c.onboarding_id = o.id) or q.id in (select c.previous_request_id from public.agency_onboarding_corrections c where c.onboarding_id = o.id))
  order by q.signed_at desc nulls last limit 1;
 if r.id is null then raise exception 'The application form is not signed yet' using errcode = '22023'; end if;
 return jsonb_build_object('requestId', r.id, 'reference', r.reference, 'title', r.title, 'originalPath', r.original_path, 'originalHash', r.original_hash,
  'nextRevision', public.agency_onboarding_next_revision(o.id), 'answers', coalesce(o.answers, '{}'::jsonb),
  'fields', coalesce((select jsonb_agg(jsonb_build_object('recipient_id', f.recipient_id, 'type', f.type, 'page', f.page, 'x', f.x, 'y', f.y, 'w', f.w, 'h', f.h, 'key', f.key, 'label', f.label, 'value', f.value)) from hr.sign_fields f where f.request_id = r.id), '[]'::jsonb),
  'recipients', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'email', k.email, 'role', k.role_label, 'state', k.state, 'signer_name', k.signer_name, 'signed_at', k.signed_at,
    'signature_kind', k.signature_kind, 'signature_image', k.signature_image)) from hr.sign_recipients k where k.request_id = r.id), '[]'::jsonb));
end $f$;
revoke all on function public.agency_onboarding_revision_source(uuid) from public, anon;
grant execute on function public.agency_onboarding_revision_source(uuid) to authenticated;

create or replace function public.agency_onboarding_revision_add(p_onboarding uuid, p_base64 text, p_note text, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; v_bytes bytea; v_rev integer; v_name text; v_id uuid;
begin
 perform hr.require_admin();
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 begin v_bytes := decode(coalesce(p_base64, ''), 'base64'); exception when others then raise exception 'The revision could not be stored' using errcode = '22023'; end;
 if length(v_bytes) < 5 or substring(v_bytes from 1 for 4) <> '\x25504446'::bytea then raise exception 'The revision could not be stored' using errcode = '22023'; end if;
 v_rev := public.agency_onboarding_next_revision(o.id);
 select name into v_name from public.cms_users where auth_user_id = auth.uid() limit 1;
 insert into public.agency_onboarding_revisions(onboarding_id, revision, kind, request_id, note, changes, content, sha256, created_by, created_by_name)
 values (o.id, v_rev, 'staff_edit', o.application_request_id, left(nullif(btrim(coalesce(p_note, '')), ''), 500), coalesce(p_changes, '[]'::jsonb), v_bytes, encode(sha256(v_bytes), 'hex'), auth.uid(), v_name)
 returning id into v_id;
 perform public.agency_onboarding_log(o.id, 'revision_added', jsonb_build_object('revision', v_rev, 'kind', 'staff_edit'));
 return jsonb_build_object('id', v_id, 'revision', v_rev);
end $f$;
revoke all on function public.agency_onboarding_revision_add(uuid, text, text, jsonb) from public, anon;
grant execute on function public.agency_onboarding_revision_add(uuid, text, text, jsonb) to authenticated;

create or replace function public.agency_onboarding_revision_file(p_revision uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare v public.agency_onboarding_revisions; v_name text;
begin
 perform public.admin_business_require();
 select * into v from public.agency_onboarding_revisions where id = p_revision;
 if not found then raise exception 'File not found' using errcode = 'P0002'; end if;
 select a.name into v_name from public.agency_onboarding o join public.agencies a on a.id = o.agency_id where o.id = v.onboarding_id;
 return jsonb_build_object('name', regexp_replace(coalesce(v_name, 'agency'), '[^A-Za-z0-9]+', '-', 'g') || '-application-revision-' || v.revision || '.pdf', 'base64', encode(v.content, 'base64'));
end $f$;
revoke all on function public.agency_onboarding_revision_file(uuid) from public, anon;
grant execute on function public.agency_onboarding_revision_file(uuid) to authenticated;

-- ------------------------------------------------------------------ send back for correction (a new F04 request to the POC)
create or replace function public.agency_onboarding_correction_request(p_onboarding uuid, p_request uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; g public.agents; r hr.sign_requests; e record; v_flags jsonb := '{}'::jsonb; v_round integer; v_name text; v_id uuid;
begin
 perform hr.require_admin();
 p_data := coalesce(p_data, '{}'::jsonb);
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found or o.kind <> 'business' then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.stage not in ('references_received', 'resubmitted') then raise exception 'An application can be sent back once both referees have replied.' using errcode = '22023'; end if;
 if exists (select 1 from public.agency_onboarding_referees f where f.onboarding_id = o.id and f.status <> 'received') then raise exception 'Wait for both referees before sending the application back.' using errcode = '22023'; end if;
 select * into g from public.agents where id = o.agent_id;
 if g.id is null or g.role <> 'agency_admin' then raise exception 'The correction goes only to the business''s agency admin (point of contact).' using errcode = '22023'; end if;
 if jsonb_typeof(p_data->'flags') <> 'object' then raise exception 'Flag at least one field for correction.' using errcode = '22023'; end if;
 for e in select key, value from jsonb_each_text(p_data->'flags') loop
  if e.key !~ '^[a-z][a-z0-9_]{0,60}$' then raise exception 'Unknown field: %', left(e.key, 60) using errcode = '22023'; end if;
  v_flags := v_flags || jsonb_build_object(e.key, left(btrim(regexp_replace(coalesce(e.value, ''), '[[:cntrl:]]', ' ', 'g')), 500));
 end loop;
 if v_flags = '{}'::jsonb then raise exception 'Flag at least one field for correction.' using errcode = '22023'; end if;
 select * into r from hr.sign_requests where id = p_request for update;
 if not found or r.state <> 'draft' or r.subject_type is distinct from 'agent' or r.subject_id is distinct from g.id or r.agency_onboarding_id is not null then
  raise exception 'The signing request does not match this business''s agency admin'; end if;
 v_round := coalesce((select max(round) from public.agency_onboarding_corrections where onboarding_id = o.id), 0) + 1;
 select name into v_name from public.cms_users where auth_user_id = auth.uid() limit 1;
 insert into public.agency_onboarding_corrections(onboarding_id, round, message, flags, request_id, previous_request_id, previous_stage, requested_by, requested_by_name)
 values (o.id, v_round, nullif(left(btrim(coalesce(p_data->>'message', '')), 2000), ''), v_flags, r.id, o.application_request_id, o.stage, auth.uid(), v_name) returning id into v_id;
 -- The uploads (organisation chart, business profile) carry over; a flagged question can replace them.
 insert into public.agency_onboarding_attachments(request_id, kind, file_name, content_type, size_bytes, sha256, content, uploaded_at)
 select r.id, x.kind, x.file_name, x.content_type, x.size_bytes, x.sha256, x.content, x.uploaded_at from public.agency_onboarding_attachments x where x.request_id = o.application_request_id
 on conflict (request_id, kind) do nothing;
 update public.agency_onboarding set application_request_id = r.id, stage = 'correction_requested' where id = o.id;
 update hr.sign_requests set agency_onboarding_id = o.id where id = r.id;
 perform public.agency_onboarding_log(o.id, 'correction_requested', jsonb_build_object('round', v_round, 'request', r.reference, 'fields', (select jsonb_agg(k) from jsonb_object_keys(v_flags) k), 'message', p_data->>'message'));
 perform public.admin_business_audit('agent_application_correction_requested', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'round', v_round, 'request', r.reference, 'flags', v_flags));
 return jsonb_build_object('id', v_id, 'round', v_round, 'stage', 'correction_requested', 'requestId', r.id, 'reference', r.reference);
end $f$;
revoke all on function public.agency_onboarding_correction_request(uuid, uuid, jsonb) from public, anon;
grant execute on function public.agency_onboarding_correction_request(uuid, uuid, jsonb) to authenticated;

-- The open correction of a request (the wizard's correction mode; document-signing locks every field not flagged).
create or replace function public.agency_onboarding_correction_of(p_request uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public, hr as $f$
 select jsonb_build_object('round', c.round, 'message', c.message, 'flags', c.flags, 'acn', coalesce(o.answers->>'agent_acn', ''), 'marn', coalesce(o.answers->>'agent_marn', ''))
 from public.agency_onboarding o join public.agency_onboarding_corrections c on c.onboarding_id = o.id and c.status = 'open' and c.request_id = p_request
 where o.application_request_id = p_request and o.stage = 'correction_requested';
$f$;
revoke all on function public.agency_onboarding_correction_of(uuid) from public, anon, authenticated;
grant execute on function public.agency_onboarding_correction_of(uuid) to service_role;
select pg_temp.patch('public.agency_onboarding_wizard_get(uuid)', $a$'attachments', coalesce((select jsonb_object_agg(x.kind$a$,
 $a$'correction', public.agency_onboarding_correction_of(p_request), 'attachments', coalesce((select jsonb_object_agg(x.kind$a$);

-- The correction request closed unsigned (expired, voided): the application goes back to where it was.
create or replace function public.agency_onboarding_correction_closed(p_onboarding uuid, p_request uuid, p_state text) returns void
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare c public.agency_onboarding_corrections;
begin
 select * into c from public.agency_onboarding_corrections where onboarding_id = p_onboarding and request_id = p_request and status = 'open' for update;
 if not found then return; end if;
 update public.agency_onboarding_corrections set status = 'closed', closed_at = now(), closed_reason = p_state where id = c.id;
 update public.agency_onboarding set application_request_id = c.previous_request_id, stage = c.previous_stage where id = p_onboarding and stage = 'correction_requested';
 perform public.agency_onboarding_log(p_onboarding, 'correction_closed', jsonb_build_object('round', c.round, 'state', p_state));
end $f$;
revoke all on function public.agency_onboarding_correction_closed(uuid, uuid, text) from public, anon, authenticated;
select pg_temp.patch('public.agency_onboarding_close()', $a$elsif v_kind = 'application' and o.stage = 'application_sent' then$a$,
 $a$elsif v_kind = 'application' and o.stage = 'correction_requested' then
  perform public.agency_onboarding_correction_closed(o.id, new.id, new.state);
 elsif v_kind = 'application' and o.stage = 'application_sent' then$a$);

-- ------------------------------------------------------------------ the agency admin re-signed the corrected form: Resubmitted
create or replace function public.agency_onboarding_resubmitted(p_onboarding uuid, p_request uuid, p_recipient uuid, p_signed bytea, p_certificate bytea, p_answers jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; c public.agency_onboarding_corrections; g public.agents; k hr.sign_recipients; r hr.sign_requests; f public.agency_onboarding_referees; v_key text; v_changes jsonb := '[]'::jsonb;
 v_old text; v_new text; v_n integer; v_emails text[]; v_own text[]; v_resent integer := 0; v_rev integer; v_ref jsonb;
 k_email constant text := '^[^[:space:]@<>,]+@[^[:space:]@<>,]+\.[^[:space:]@<>,]+$';
begin
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 select * into c from public.agency_onboarding_corrections where onboarding_id = o.id and status = 'open' and request_id = p_request for update;
 if c.id is null then raise exception 'This correction is no longer waiting for a signature'; end if;
 select * into g from public.agents where id = o.agent_id;
 select * into k from hr.sign_recipients where id = p_recipient;
 select * into r from hr.sign_requests where id = p_request;
 -- The referees: well-formed, different, not the applicant's own address (the same rule as the first signature).
 v_own := array_remove(array[lower(btrim(coalesce(g.email, ''))), lower(btrim(coalesce(p_answers->>'contact_email', '')))], '');
 v_emails := array[lower(btrim(coalesce(p_answers->>'ref1_email', ''))), lower(btrim(coalesce(p_answers->>'ref2_email', '')))];
 for v_n in 1..2 loop
  if v_emails[v_n] !~ k_email then raise exception 'Enter a valid email address for reference %', v_n; end if;
  if v_emails[v_n] = any(v_own) then raise exception 'Reference % cannot use your own email address', v_n; end if;
 end loop;
 if v_emails[1] = v_emails[2] then raise exception 'The two references need different email addresses'; end if;
 for v_key in select jsonb_object_keys(c.flags) loop
  v_old := coalesce(o.answers->>v_key, ''); v_new := coalesce(p_answers->>v_key, '');
  if v_old <> v_new then v_changes := v_changes || jsonb_build_array(jsonb_build_object('field', v_key, 'old', v_old, 'new', v_new)); end if;
 end loop;
 update public.agency_onboarding set answers = (coalesce(answers, '{}'::jsonb) - array(select jsonb_object_keys(c.flags))) || p_answers, form_content = p_signed,
  application_certificate_content = p_certificate, signer_name = k.signer_name, stage = 'resubmitted' where id = o.id returning * into o;
 update public.agencies set profile = coalesce(profile, '{}'::jsonb) || (p_answers - 'agent_signed_date'), updated_at = now() where id = o.agency_id;
 -- A referee whose details were flagged and changed: their check is closed and a new one goes out (document-signing sends it).
 for v_n in 1..2 loop
  if not exists (select 1 from jsonb_object_keys(c.flags) x where x like 'ref' || v_n || '\_%') then continue; end if;
  select * into f from public.agency_onboarding_referees where onboarding_id = o.id and position = v_n for update;
  v_ref := jsonb_build_object('name', left(btrim(coalesce(p_answers->>('ref' || v_n || '_contact_name'), '')), 150), 'organisation', left(btrim(coalesce(p_answers->>('ref' || v_n || '_organisation'), '')), 200),
   'position', left(btrim(coalesce(p_answers->>('ref' || v_n || '_position'), '')), 150), 'email', v_emails[v_n], 'phone', left(btrim(coalesce(p_answers->>('ref' || v_n || '_phone'), '')), 80),
   'address', left(btrim(coalesce(p_answers->>('ref' || v_n || '_address'), '')), 300));
  if f.id is not null and f.contact_name = v_ref->>'name' and f.organisation = v_ref->>'organisation' and f.position_title = v_ref->>'position' and lower(f.email) = v_ref->>'email'
    and f.phone = v_ref->>'phone' and f.address = v_ref->>'address' then continue; end if;
  if f.id is not null and f.request_id is not null then
   update hr.sign_requests set state = 'void', closed_reason = 'Referee details corrected by the applicant' where id = f.request_id and state in ('draft', 'sending', 'sent', 'viewed', 'partial', 'email_failed');
  end if;
  if f.id is null then
   insert into public.agency_onboarding_referees(onboarding_id, position, contact_name, organisation, position_title, email, phone, address)
   values (o.id, v_n, v_ref->>'name', v_ref->>'organisation', v_ref->>'position', v_ref->>'email', v_ref->>'phone', v_ref->>'address');
  else
   perform public.agency_onboarding_log(o.id, 'referee_corrected', jsonb_build_object('position', v_n, 'from', f.email, 'to', v_ref->>'email', 'previousStatus', f.status, 'previousAnswers', f.answers));
   update public.agency_onboarding_referees set contact_name = v_ref->>'name', organisation = v_ref->>'organisation', position_title = v_ref->>'position', email = v_ref->>'email',
    phone = v_ref->>'phone', address = v_ref->>'address', status = 'pending', request_id = null, received_at = null, received_via = null, answers = '{}'::jsonb,
    form_content = null, certificate_content = null, file_name = null, updated_at = now() where id = f.id;
  end if;
  v_resent := v_resent + 1;
 end loop;
 v_rev := public.agency_onboarding_next_revision(o.id);
 insert into public.agency_onboarding_revisions(onboarding_id, revision, kind, request_id, note, changes, content, sha256, created_by_name)
 values (o.id, v_rev, 'resubmitted', p_request, 'Re-signed by ' || coalesce(k.signer_name, g.full_name) || ' after correction round ' || c.round, v_changes, p_signed, encode(sha256(p_signed), 'hex'), coalesce(k.signer_name, g.full_name));
 update public.agency_onboarding_corrections set status = 'resubmitted', resubmitted_at = coalesce(r.signed_at, now()), changes = v_changes where id = c.id;
 perform public.agency_onboarding_log(o.id, 'resubmitted', jsonb_build_object('round', c.round, 'request', r.reference, 'signer', k.signer_name, 'changes', v_changes, 'refereesResent', v_resent, 'revision', v_rev));
 perform public.admin_business_audit('agent_application_resubmitted', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'round', c.round, 'request', r.reference, 'changes', jsonb_array_length(v_changes)));
end $f$;
revoke all on function public.agency_onboarding_resubmitted(uuid, uuid, uuid, bytea, bytea, jsonb) from public, anon, authenticated;
select pg_temp.patch('public.agency_onboarding_accept_signed(uuid, uuid, uuid, bytea, bytea, jsonb)',
 $a$if o.stage <> 'application_sent' then raise exception 'This application form is no longer waiting for a signature'; end if;$a$,
 $a$if o.stage = 'correction_requested' then perform public.agency_onboarding_resubmitted(o.id, r.id, c.id, p_signed, p_certificate, v_answers); return; end if;
  if o.stage <> 'application_sent' then raise exception 'This application form is no longer waiting for a signature'; end if;$a$);

-- ------------------------------------------------------------------ Approve and activate agency: the business goes Active, the P06 follows
create or replace function public.agency_onboarding_approve(p_onboarding uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; a public.agencies; v_received integer; v_total integer;
begin
 perform hr.require_admin();
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found or o.kind <> 'business' then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.stage = 'references_approved' then
  select * into a from public.agencies where id = o.agency_id;
  return jsonb_build_object('id', o.id, 'stage', o.stage, 'agencyStatus', a.status, 'already', true); end if;
 if o.stage not in ('references_received', 'resubmitted') then raise exception 'The application can be approved once both referees have replied (and a correction, if any, is resubmitted).' using errcode = '22023'; end if;
 select count(*) filter (where status = 'received'), count(*) into v_received, v_total from public.agency_onboarding_referees where onboarding_id = o.id;
 if v_total = 0 or v_received < v_total then raise exception 'Wait for both referees before approving.' using errcode = '22023'; end if;
 update public.agency_onboarding set stage = 'references_approved', approved_by = auth.uid(), approved_at = now() where id = o.id returning * into o;
 update public.agencies set status = 'Active', updated_at = now() where id = o.agency_id and status = 'Onboarding' returning * into a;
 if a.id is null then select * into a from public.agencies where id = o.agency_id; end if;
 perform public.agency_onboarding_log(o.id, 'approved', jsonb_build_object('received', v_received, 'total', v_total,
  'rounds', (select count(*) from public.agency_onboarding_corrections c where c.onboarding_id = o.id)));
 perform public.admin_business_audit('business_approved', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'status', a.status));
 return jsonb_build_object('id', o.id, 'stage', o.stage, 'agencyStatus', a.status);
end $f$;
revoke all on function public.agency_onboarding_approve(uuid) from public, anon;
grant execute on function public.agency_onboarding_approve(uuid) to authenticated;

-- The P06 is signed (service role, document-signing after the signature): the POC and every agent held for the business become Active and
-- get ONE invitation each (no login yet); document-signing emails them. Only for a business approved by staff (already Active).
create or replace function public.agency_business_release(p_onboarding uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; a public.agencies; poc public.agents; g public.agents; inv public.agency_invitations; v_invites jsonb := '[]'::jsonb; v_held integer := 0;
 v_skipped jsonb := '[]'::jsonb; v_contact_inv uuid;
begin
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found or o.kind <> 'business' then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 select * into a from public.agencies where id = o.agency_id for update;
 if a.status <> 'Active' or o.stage <> 'agreement_signed' or not public.business_agreement_ready(a.id) then
  return jsonb_build_object('released', false, 'businessId', a.id, 'name', a.name, 'invitations', '[]'::jsonb, 'skipped', '[]'::jsonb); end if;
 if o.activated_at is not null then return jsonb_build_object('released', false, 'already', true, 'businessId', a.id, 'name', a.name, 'invitations', '[]'::jsonb, 'skipped', '[]'::jsonb); end if;
 select * into poc from public.agents where id = o.agent_id and business_id = a.id;
 for g in select x.* from public.agents x where x.business_id = a.id and (x.id = poc.id or x.status = 'Onboarding') order by (x.id = poc.id) desc, x.created_at loop
  update public.agents set status = 'Active', role = case when g.id = poc.id then 'agency_admin' else role end, status_changed_at = now(), updated_at = now() where id = g.id returning * into g;
  if g.id <> poc.id then v_held := v_held + 1; end if;
  inv := null;
  if g.profile_id is not null then
   update public.portal_profiles set status = 'Active', updated_at = now() where id = g.profile_id and status <> 'Active';
   update public.agency_memberships set status = 'Active', agency_id = a.id, role = case when role = 'student' then role else g.role end, updated_at = now() where user_id = g.profile_id;
  elsif g.email <> '' then
   select * into inv from public.agency_invitations i where i.email = g.email and i.status = 'pending' order by i.created_at desc limit 1;
   if inv.id is not null and inv.agency_id <> a.id then
    v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('email', g.email, 'reason', 'pending invitation for another business')); inv := null;
   elsif inv.id is null then
    if exists (select 1 from public.portal_profiles p join public.agency_memberships m on m.user_id = p.id where lower(p.email) = g.email and m.status = 'Active' and p.status = 'Active') then
     v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('email', g.email, 'reason', 'already signs in'));
    else
     insert into public.agency_invitations(agency_id, email, full_name, role, invited_by, invited_by_name)
     values (a.id, g.email, g.full_name, g.role, o.approved_by, 'Skyline') returning * into inv;
    end if;
   end if;
   if inv.id is not null then
    v_invites := v_invites || jsonb_build_array(jsonb_build_object('id', inv.id, 'email', inv.email, 'name', inv.full_name, 'role', inv.role, 'expiresAt', inv.expires_at,
     'sent', inv.link_sent_at is not null, 'contact', g.id = poc.id, 'agentId', g.id));
    if g.id = poc.id then v_contact_inv := inv.id; end if;
   end if;
  end if;
 end loop;
 update public.agencies set onboarding_completed_at = coalesce(onboarding_completed_at, now()), updated_at = now() where id = a.id;
 update public.agency_onboarding set activated_at = now(), activation_invitation_id = coalesce(v_contact_inv, activation_invitation_id) where id = o.id;
 perform public.agency_onboarding_log(o.id, 'activated', jsonb_build_object('by', 'agreement', 'email', poc.email, 'invitation', v_contact_inv, 'heldAgents', v_held, 'invitations', jsonb_array_length(v_invites)), null);
 perform public.admin_business_audit('business_invitations_released', a.id, a.id, jsonb_build_object('name', a.name, 'contact', poc.email, 'heldAgents', v_held));
 return jsonb_build_object('released', true, 'businessId', a.id, 'name', a.name, 'contact', jsonb_build_object('id', poc.id, 'name', poc.full_name, 'email', poc.email),
  'heldReleased', v_held, 'invitations', v_invites, 'skipped', v_skipped);
end $f$;
revoke all on function public.agency_business_release(uuid) from public, anon, authenticated;
grant execute on function public.agency_business_release(uuid) to service_role;

-- ------------------------------------------------------------------ follow-up (emails), business page, list, dashboard
select pg_temp.patch('public.agency_onboarding_followup(uuid)', $a$'agency', jsonb_build_object('id', a.id, 'name', a.name),$a$,
 $a$'agency', jsonb_build_object('id', a.id, 'name', a.name, 'status', a.status), 'label', public.agency_onboarding_label(a.id),
  'round', (select count(*) from public.agency_onboarding_corrections c where c.onboarding_id = o.id),
  'admins', coalesce((select jsonb_agg(distinct lower(u.email)) from public.cms_users u where u.status = 'Active' and u.role = 'Admin' and coalesce(u.email, '') like '%@%'), '[]'::jsonb),$a$);
select pg_temp.patch('public.agency_onboarding_list(uuid)', $a$'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at$a$,
 $a$'label', public.agency_onboarding_label(o.agency_id),
   'corrections', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'round', c.round, 'message', c.message, 'flags', c.flags, 'status', c.status, 'changes', c.changes, 'by', c.requested_by_name,
     'requestedAt', c.requested_at, 'resubmittedAt', c.resubmitted_at, 'closedReason', c.closed_reason, 'request', public.agency_onboarding_request_json(c.request_id)) order by c.round) from public.agency_onboarding_corrections c where c.onboarding_id = o.id), '[]'::jsonb),
   'revisions', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'revision', v.revision, 'kind', v.kind, 'note', v.note, 'changes', v.changes, 'by', v.created_by_name, 'at', v.created_at) order by v.revision) from public.agency_onboarding_revisions v where v.onboarding_id = o.id), '[]'::jsonb),
   'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at$a$);
select pg_temp.patch('public.admin_business_detail(uuid)', $a$'stage', o.stage, 'onboardingId', o.id,$a$, $a$'stage', o.stage, 'label', public.agency_onboarding_label(a.id), 'onboardingId', o.id,$a$);
select pg_temp.patch('public.admin_business_list(text, text, integer, integer)', $a$'statusCounts', public.admin_status_counts(p.id)$a$,
 $a$'onboardingLabel', public.agency_onboarding_label(p.id), 'statusCounts', public.admin_status_counts(p.id)$a$);

-- Needs action today: applications ready for review or resubmitted (the in-app notice; staff are also emailed).
do $do$
declare d text := pg_get_functiondef('public.admin_today()'::regprocedure); k integer;
begin
 k := (select count(*) from regexp_matches(d, E'r := r \\|\\| jsonb_build_object\\(''references''', 'g'));
 if k <> 1 then raise exception 'admin_today: references item found % times', k; end if;
 d := regexp_replace(d, E'r := r \\|\\| jsonb_build_object\\(''references''[^\\n]*',
  $r$r := r || jsonb_build_object('references', jsonb_build_object('count', (select count(*) from public.agency_onboarding o where o.kind = 'business' and (o.stage = 'references_received' or (o.stage = 'resubmitted' and not exists (select 1 from public.agency_onboarding_referees f where f.onboarding_id = o.id and f.status <> 'received')))), 'items', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'title', a.name, 'detail', case when o.stage = 'resubmitted' then 'Resubmitted: review the corrections' else 'Ready for review: both referees have replied' end, 'at', coalesce(o.references_received_at, o.created_at), 'to', '/admin/businesses/' || a.id::text) order by coalesce(o.references_received_at, o.created_at)) from public.agency_onboarding o join public.agencies a on a.id = o.agency_id where o.kind = 'business' and (o.stage = 'references_received' or (o.stage = 'resubmitted' and not exists (select 1 from public.agency_onboarding_referees f where f.onboarding_id = o.id and f.status <> 'received')))), '[]'::jsonb)));$r$);
 execute d;
end $do$;
