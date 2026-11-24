-- BUSINESS-DOCUMENT-ACTIONS (2026-11-24, owner): the business page's Documents tab gets four staff actions, every one checked here
-- (SLIT administrators only: public.admin_business_require) and logged in public.agency_onboarding_events on the business's latest
-- onboarding (when it has one) as well as in the business audit:
--   1. Upload document: kinds Agreement (agent_agreement) / ID / Insurance / Other, an optional reason (an Agreement still needs one:
--      it stands in for the online agreement, rule agents.onboarding_reason_min_chars); event document_uploaded.
--   2. View: uploaded files open from a 60-second signed URL (the bucket's own policy already allows SLIT administrators only); the
--      signed application form and agreement through public.agency_onboarding_file, which never returns a certificate (unchanged).
--   3. Resend application (admin_business_resend_prepare, called by document-signing agent_onboarding_business_resend): an unsigned
--      application form is emailed again from the same signing request (no new request, the saved draft kept); an expired request gets
--      a new expiry and its old links are revoked; event application_resent. A signed one: document-signing emails the signed form and
--      agreement (never a certificate) and logs signed_copy_sent (admin_business_signed_copy_logged). One send per business per
--      agents.document_resend_cooldown_minutes (2).
--   4. Change email (admin_business_contact_email_change, called twice by document-signing agent_onboarding_contact_email: a check, then
--      the change): unique among agents only (the same email may belong to a student or staff member); the agent, the business email /
--      contact email where they were the old address, the waiting signing recipients (old links revoked, a new link queued), pending
--      agent invitations revoked (the screen sends a new one to the new address); the Auth login's email is changed by the function with
--      the service role; event email_changed {old, new, reason}.
-- Additive (one check constraint widened). Rollback: re-create admin_business_document_add from 20261121002517 and the kind check with
-- ('agent_agreement', 'other'); drop the new functions; delete the rule agents.document_resend_cooldown_minutes.
begin;

-- 1. Upload ------------------------------------------------------------------------------------------------------------------------
alter table public.business_documents drop constraint if exists business_documents_kind_check;
alter table public.business_documents add constraint business_documents_kind_check check (kind in ('agent_agreement', 'id', 'insurance', 'other'));

/** The business's latest onboarding (the events table is keyed by onboarding), or null. */
create or replace function public.business_latest_onboarding(p_business uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select x.id from public.agency_onboarding x where x.agency_id = p_business order by x.created_at desc limit 1;
$$;
revoke all on function public.business_latest_onboarding(uuid) from public, anon, authenticated;

create or replace function public.admin_business_document_add(p_business uuid, p_kind text, p_path text, p_name text, p_size bigint, p_reason text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'storage'
as $function$
declare d public.business_documents; v_reason text; v_onb uuid;
begin
 perform public.admin_business_require();
 if not exists (select 1 from public.agencies where id = p_business) then raise exception 'Business not found' using errcode = 'P0002'; end if;
 if coalesce(p_kind, '') not in ('agent_agreement', 'id', 'insurance', 'other') then raise exception 'Unknown document type' using errcode = '22023'; end if;
 v_reason := nullif(left(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]', ' ', 'g')), 1000), '');
 if p_kind = 'agent_agreement' and (v_reason is null or length(v_reason) < greatest(1, public.rule_int('agents.onboarding_reason_min_chars', 5))) then
  raise exception 'Give the reason for recording a signed copy instead of the online agreement (kept on the record)' using errcode = '22023'; end if;
 if coalesce(p_path, '') not like p_business::text || '/%' or p_path like '%..%'
  or not exists (select 1 from storage.objects o where o.bucket_id = 'business-documents' and o.name = p_path) then
  raise exception 'Upload the file first' using errcode = '22023'; end if;
 if coalesce((select (o.metadata->>'size')::bigint from storage.objects o where o.bucket_id = 'business-documents' and o.name = p_path), p_size, 0)
   > least(15, greatest(1, public.rule_int('agents.signed_copy_upload_max_mb', 15)))::bigint * 1048576 then
  raise exception 'The file is larger than % MB.', least(15, greatest(1, public.rule_int('agents.signed_copy_upload_max_mb', 15))) using errcode = '22023'; end if;
 insert into public.business_documents(business_id, kind, file_name, storage_path, size_bytes, uploaded_by, reason)
 values (p_business, p_kind, left(coalesce(nullif(btrim(regexp_replace(p_name, '[[:cntrl:]]', '', 'g')), ''), 'document'), 200), p_path, greatest(coalesce(p_size, 0), 0), auth.uid(), v_reason)
 returning * into d;
 perform public.admin_business_audit(case when d.kind = 'agent_agreement' then 'agent_agreement_uploaded' else 'business_document_added' end, p_business, p_business, jsonb_build_object('kind', d.kind, 'file', d.file_name, 'reason', v_reason));
 v_onb := public.business_latest_onboarding(p_business);
 if v_onb is not null then
  if d.kind = 'agent_agreement' then
   perform public.agency_onboarding_log(v_onb, 'agreement_uploaded', jsonb_build_object('file', d.file_name, 'reason', v_reason, 'document', d.id));
  end if;
  perform public.agency_onboarding_log(v_onb, 'document_uploaded', jsonb_build_object('kind', d.kind, 'file', d.file_name, 'size', d.size_bytes, 'reason', v_reason, 'document', d.id));
 end if;
 return jsonb_build_object('id', d.id, 'reason', v_reason);
end $function$;

-- 3. Resend application / email the signed copy ---------------------------------------------------------------------------------
select public.business_rule_add_setting('agents.document_resend_cooldown_minutes', 'Wait between resends of a business''s application (minutes)', 'Agents',
  'agency_agents', 'business', 'number', '2'::jsonb, '{"min":0,"max":60}'::jsonb,
  'After Resend application or Email signed copy on a business''s Documents tab, the next one waits this many minutes.');

/** The agency admin (point of contact): the latest onboarding's agent, else the business's first agency admin. */
create or replace function public.business_contact_agent(p_business uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select x.agent_id from public.agency_onboarding x join public.agents g on g.id = x.agent_id and g.business_id = p_business
      where x.agency_id = p_business and x.agent_id is not null order by x.created_at desc limit 1),
    (select g.id from public.agents g where g.business_id = p_business and g.role = 'agency_admin' order by g.created_at limit 1));
$$;
revoke all on function public.business_contact_agent(uuid) from public, anon, authenticated;

/** Seconds until the next resend is allowed (0 = now) and when the last one went. */
create or replace function public.business_resend_wait(p_business uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  with last as (
    select max(e.at) as at from public.agency_onboarding_events e join public.agency_onboarding x on x.id = e.onboarding_id
    where x.agency_id = p_business and e.event in ('application_resent', 'signed_copy_sent'))
  select jsonb_build_object('lastSentAt', last.at,
    'waitSeconds', greatest(0, ceil(extract(epoch from (last.at + make_interval(mins => greatest(0, public.rule_int('agents.document_resend_cooldown_minutes', 2))) - now()))))::int)
  from last;
$$;
revoke all on function public.business_resend_wait(uuid) from public, anon, authenticated;

/** What the Documents tab shows next to its buttons: the contact, whether the application is signed, the last send. */
create or replace function public.admin_business_document_status(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o public.agency_onboarding; g public.agents; v_login boolean;
begin
 perform public.admin_business_require();
 if not exists (select 1 from public.agencies where id = p_business) then raise exception 'Business not found' using errcode = 'P0002'; end if;
 select * into o from public.agency_onboarding x where x.agency_id = p_business and x.application_request_id is not null order by x.created_at desc limit 1;
 select * into g from public.agents where id = public.business_contact_agent(p_business);
 v_login := g.profile_id is not null and exists (select 1 from public.portal_profiles p where p.id = g.profile_id and p.auth_user_id is not null);
 return jsonb_build_object(
  'onboardingId', o.id,
  'applicationSent', o.id is not null,
  'applicationSigned', o.application_signed_at is not null,
  'hasAgreement', o.agreement_content is not null,
  'contact', case when g.id is null then null else jsonb_build_object('agentId', g.id, 'name', g.full_name, 'email', g.email, 'hasLogin', v_login) end
 ) || public.business_resend_wait(p_business);
end $$;
revoke all on function public.admin_business_document_status(uuid) from public, anon;
grant execute on function public.admin_business_document_status(uuid) to authenticated;

create or replace function public.admin_business_resend_prepare(p_business uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $$
declare o public.agency_onboarding; r hr.sign_requests; c hr.sign_recipients; g public.agents; v_wait jsonb; v_rotated boolean := false;
begin
 perform public.admin_business_require();
 perform 1 from public.agencies where id = p_business for update;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 v_wait := public.business_resend_wait(p_business);
 if (v_wait->>'waitSeconds')::int > 0 then
  raise exception 'Sent a moment ago. Try again in % seconds.', v_wait->>'waitSeconds' using errcode = '55000'; end if;
 select * into o from public.agency_onboarding x where x.agency_id = p_business and x.application_request_id is not null order by x.created_at desc limit 1;
 if o.id is null then raise exception 'No application has been sent to this business yet.' using errcode = '22023'; end if;
 if o.application_signed_at is not null then
  if o.form_content is null and o.agreement_content is null then raise exception 'The signed documents are not stored yet. Try again in a minute.' using errcode = '55000'; end if;
  select * into g from public.agents where id = coalesce(o.agent_id, public.business_contact_agent(p_business));
  if coalesce(btrim(g.email), '') = '' then raise exception 'The agency admin has no email address.' using errcode = '22023'; end if;
  return jsonb_build_object('mode', 'signed', 'onboardingId', o.id, 'to', g.email, 'name', g.full_name,
   'businessName', (select a.name from public.agencies a where a.id = p_business), 'hasForm', o.form_content is not null, 'hasAgreement', o.agreement_content is not null);
 end if;
 -- Unsigned: the same request and its saved draft (agency_onboarding_drafts is keyed by request and recipient, so nothing is lost).
 select * into r from hr.sign_requests where id = o.application_request_id for update;
 if not found or r.state in ('draft', 'signed', 'void', 'declined') then
  raise exception 'This application request is closed. Prepare and send the application again.' using errcode = '22023'; end if;
 select * into c from hr.sign_recipients where request_id = r.id and state in ('sent', 'viewed') order by signing_order, id limit 1 for update;
 if not found then raise exception 'Nobody is waiting to sign this application.' using errcode = '22023'; end if;
 if hr.sign_status(r) = 'expired' or r.state = 'expired' then
  -- An expired link is rotated: a new expiry, and every link emailed before stops working (each email makes its own token).
  update hr.sign_requests set state = case when state = 'expired' then 'sent' else state end,
   expires_at = now() + make_interval(days => greatest(1, coalesce(nullif(r.expiry_days, 0), public.rule_int('signing.request_expiry_default', 14))))
  where id = r.id returning * into r;
  delete from hr.sign_tokens where recipient_id = c.id;
  perform hr.sign_event(r.id, 'expiry_extended', c.id, auth.uid(), jsonb_build_object('expires_at', r.expires_at, 'reason', 'Resend application'));
  v_rotated := true;
 end if;
 perform hr.sign_queue(r.id, c.id, 'invite', 'invite:' || c.id || ':' || (1 + (select count(*) from hr.sign_notifications where recipient_id = c.id and kind = 'invite')));
 update hr.sign_recipients set last_notified_at = now(), delivery_error = null where id = c.id;
 perform hr.sign_event(r.id, 'resent', c.id, auth.uid(), '{}'::jsonb);
 perform public.agency_onboarding_log(o.id, 'application_resent', jsonb_build_object('to', c.email, 'request', r.reference, 'linkRotated', v_rotated, 'expiresAt', r.expires_at));
 return jsonb_build_object('mode', 'resent', 'onboardingId', o.id, 'to', c.email, 'linkRotated', v_rotated, 'expiresAt', r.expires_at);
end $$;
revoke all on function public.admin_business_resend_prepare(uuid) from public, anon;
grant execute on function public.admin_business_resend_prepare(uuid) to authenticated;

/** document-signing emailed the signed copies: the event that also starts the wait. */
create or replace function public.admin_business_signed_copy_logged(p_business uuid, p_onboarding uuid, p_to text, p_files text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
 perform public.admin_business_require();
 if not exists (select 1 from public.agency_onboarding where id = p_onboarding and agency_id = p_business) then raise exception 'Onboarding not found' using errcode = 'P0002'; end if;
 perform public.agency_onboarding_log(p_onboarding, 'signed_copy_sent', jsonb_build_object('to', left(coalesce(p_to, ''), 254), 'files', to_jsonb(coalesce(p_files, '{}'::text[]))));
end $$;
revoke all on function public.admin_business_signed_copy_logged(uuid, uuid, text, text[]) from public, anon;
grant execute on function public.admin_business_signed_copy_logged(uuid, uuid, text, text[]) to authenticated;

-- 4. Change the agency admin's email ----------------------------------------------------------------------------------------------
create or replace function public.admin_business_contact_email_change(p_business uuid, p_email text, p_reason text, p_apply boolean default false) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr, auth as $$
declare g public.agents; a public.agencies; v_old text; v_new text := lower(btrim(coalesce(p_email, '')));
 v_reason text := left(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]', ' ', 'g')), 500);
 v_auth uuid; v_onb uuid; c record; v_links int := 0; v_reinvite jsonb := '[]'::jsonb; inv public.agency_invitations; r hr.sign_requests;
begin
 perform public.admin_business_require();
 select * into a from public.agencies where id = p_business for update;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 select * into g from public.agents where id = public.business_contact_agent(p_business) for update;
 if g.id is null then raise exception 'This business has no agency admin.' using errcode = '22023'; end if;
 v_old := lower(btrim(coalesce(g.email, '')));
 if v_new = '' or length(v_new) > 254 or v_new !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then raise exception 'Enter a valid email address' using errcode = '22023'; end if;
 if v_new = v_old then raise exception 'That is already the agency admin''s email.' using errcode = '22023'; end if;
 if length(v_reason) < greatest(1, public.rule_int('agents.onboarding_reason_min_chars', 5)) then raise exception 'Give the reason for the change (kept on the record).' using errcode = '22023'; end if;
 -- Unique among agents only: a student or staff member may use the same address.
 if exists (select 1 from public.agents x where lower(btrim(x.email)) = v_new and x.id <> g.id)
  or exists (select 1 from public.agency_invitations i where i.email = v_new and i.status = 'pending' and i.role in ('agency_admin', 'agent') and lower(i.email) <> v_old) then
  raise exception 'This email is already in use' using errcode = '23505'; end if;
 -- The login to change: the agent's portal profile, or an account made with the password chosen while signing (not linked yet).
 select p.auth_user_id into v_auth from public.portal_profiles p where p.id = g.profile_id and p.auth_user_id is not null;
 if v_auth is null then
  select u.id into v_auth from auth.users u where lower(u.email) = v_old and coalesce(u.raw_user_meta_data->>'portal_password_set_at_signing', '') <> '' limit 1;
 end if;
 if not coalesce(p_apply, false) then
  return jsonb_build_object('old', v_old, 'new', v_new, 'agentId', g.id, 'name', g.full_name, 'authUserId', v_auth);
 end if;

 update public.agents set email = v_new, updated_at = now() where id = g.id;
 update public.agencies set business_email = case when lower(btrim(coalesce(business_email, ''))) = v_old then v_new else business_email end,
  profile = case when lower(btrim(coalesce(profile->>'contact_email', ''))) = v_old then coalesce(profile, '{}'::jsonb) || jsonb_build_object('contact_email', v_new) else profile end,
  updated_at = now()
 where id = p_business;
 if g.profile_id is not null then update public.portal_profiles set email = v_new, updated_at = now() where id = g.profile_id and lower(coalesce(email, '')) = v_old; end if;

 -- Waiting signing recipients of this business's onboarding requests: new address, old links revoked, a new link emailed.
 for c in select k.* from hr.sign_recipients k join hr.sign_requests q on q.id = k.request_id
   where lower(k.email) = v_old and k.state in ('pending', 'sent', 'viewed') and q.state in ('draft', 'sent', 'viewed', 'partial')
     and q.id in (select unnest(array[x.application_request_id, x.agreement_request_id, x.request_id]) from public.agency_onboarding x where x.agency_id = p_business)
   for update of k loop
  update hr.sign_recipients set email = v_new, delivery_error = null where id = c.id;
  delete from hr.sign_tokens where recipient_id = c.id;
  perform hr.sign_event(c.request_id, 'recipient_email_changed', c.id, auth.uid(), jsonb_build_object('from', v_old, 'to', v_new, 'reason', v_reason));
  if c.state in ('sent', 'viewed') then
   select * into r from hr.sign_requests where id = c.request_id for update;
   if hr.sign_status(r) = 'expired' then
    update hr.sign_requests set expires_at = now() + make_interval(days => greatest(1, coalesce(nullif(r.expiry_days, 0), public.rule_int('signing.request_expiry_default', 14))))
    where id = r.id;
   end if;
   perform hr.sign_queue(c.request_id, c.id, 'invite', 'invite:' || c.id || ':' || (1 + (select count(*) from hr.sign_notifications where recipient_id = c.id and kind = 'invite')));
   update hr.sign_recipients set last_notified_at = now() where id = c.id;
   v_links := v_links + 1;
  end if;
 end loop;

 -- A sign-in invitation still waiting at the old address is withdrawn; the screen sends a new one to the new address.
 for inv in select * from public.agency_invitations i where i.agency_id = p_business and i.status = 'pending' and i.email = v_old and i.role in ('agency_admin', 'agent') for update loop
  update public.agency_invitations set status = 'revoked', revoked_at = now() where id = inv.id;
  v_reinvite := v_reinvite || jsonb_build_object('role', inv.role, 'name', coalesce(nullif(inv.full_name, ''), g.full_name), 'revokedId', inv.id);
 end loop;

 perform public.admin_business_audit('contact_email_changed', p_business, p_business, jsonb_build_object('old', v_old, 'new', v_new, 'reason', v_reason));
 v_onb := public.business_latest_onboarding(p_business);
 if v_onb is not null then
  perform public.agency_onboarding_log(v_onb, 'email_changed', jsonb_build_object('old', v_old, 'new', v_new, 'reason', v_reason, 'signingLinks', v_links, 'invitationsRevoked', jsonb_array_length(v_reinvite)));
 end if;
 return jsonb_build_object('old', v_old, 'new', v_new, 'agentId', g.id, 'name', g.full_name, 'authUserId', v_auth, 'signingLinks', v_links, 'reinvite', v_reinvite);
end $$;
revoke all on function public.admin_business_contact_email_change(uuid, text, text, boolean) from public, anon;
grant execute on function public.admin_business_contact_email_change(uuid, text, text, boolean) to authenticated;

grant execute on function public.admin_business_document_add(uuid, text, text, text, bigint, text) to authenticated;

commit;
