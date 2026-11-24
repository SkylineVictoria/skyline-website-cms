-- BUSINESS-RULES-LIVE batch 5 (owner 2026-11-20/24: no rule hard-coded; 'do all'): 71 more fixed values become live Business Rules at
-- today's value (admissions / finance / agents / signing / support / notifications, HR / CMS / Office 365 / ops, LMS /
-- bookings / assessment), one institution time zone (general.time_zone, Melbourne everywhere), and the branded email layout
-- for database-built emails (email_html_wrap, support tickets). Patches use exact snippets of the live definitions.
begin;

-- ===== batch5-admissions =====
-- ===== BUSINESS-RULES-LIVE batch 5: admissions, finance, agents, signing, support, notifications (agent: admissions area) =====
-- Every new rule starts at the value the system uses today. Function patches use the LIVE bodies (checked 2026-11-20 read-only:
-- every old snippet below occurs exactly the stated number of times on hosted).

-- ---------------------------------------------------------------- new rules
-- Admissions
select public.business_rule_add_setting('admissions.offer_validity_days', 'Offer letter valid for', 'CRM & Admissions',
  'applications', 'offer', 'days', '30'::jsonb, '{"min":1,"max":365}'::jsonb,
  'Days an offer letter stays open: its "valid until" date and the signing link expiry are the issue date plus this many days. Replaces Website settings › Offer validity (now read-only there).');
select public.business_rule_add_setting('admissions.offer_link_minimum_days', 'Offer signing link works at least', 'CRM & Admissions',
  'applications', 'offer', 'days', '1'::jsonb, '{"min":1,"max":30}'::jsonb,
  'When an offer signing link is sent or sent again close to its expiry, it is kept open at least this many days from that moment.');
select public.business_rule_add_setting('admissions.guest_link_default_days', 'Document upload link: default length', 'CRM & Admissions',
  'applications', 'documents', 'days', '7'::jsonb, '{"min":1,"max":90}'::jsonb,
  'Days a document upload link for a student (no login) works when staff do not choose a length.');
select public.business_rule_add_setting('admissions.guest_link_max_days', 'Document upload link: longest length', 'CRM & Admissions',
  'applications', 'documents', 'days', '30'::jsonb, '{"min":1,"max":90}'::jsonb,
  'The longest a document upload link for a student may work.');
select public.business_rule_add_setting('admissions.guest_link_emails_per_application_hour', 'Upload link emails per application an hour', 'CRM & Admissions',
  'applications', 'documents', 'number', '3'::jsonb, '{"min":1,"max":50}'::jsonb,
  'How many document upload link emails one application may send in an hour.');
select public.business_rule_add_setting('admissions.guest_link_emails_per_sender_hour', 'Upload link emails per staff member an hour', 'CRM & Admissions',
  'applications', 'documents', 'number', '10'::jsonb, '{"min":1,"max":200}'::jsonb,
  'How many document upload link emails one person may send in an hour, across all applications.');
select public.business_rule_add_setting('admissions.guest_link_rate_limits', 'Document upload link: request limits', 'CRM & Admissions',
  'applications', 'documents', 'json', '{"perAddressPer10Min":300,"badLinksPer10Min":20,"perLinkPer10Min":200,"uploadsPerHour":60}'::jsonb,
  '{"keys":["perAddressPer10Min","badLinksPer10Min","perLinkPer10Min","uploadsPerHour"]}'::jsonb,
  'Abuse limits on the student upload page (no login): requests per internet address and per link every 10 minutes, wrong links per address every 10 minutes, files uploaded per link an hour.');
select public.business_rule_add_setting('admissions.document_uploads_per_hour', 'Checked document uploads per person an hour', 'CRM & Admissions',
  'applications', 'documents', 'number', '60'::jsonb, '{"min":1,"max":1000}'::jsonb,
  'How many application or employee documents one signed-in person may upload in an hour.');
select public.business_rule_add_setting('admissions.self_register_rate_limits', 'Online sign-up limits', 'CRM & Admissions',
  'applications', 'student', 'json', '{"signupsPer10Min":8,"abnChecksPer10Min":20,"perEmailPerHour":3}'::jsonb,
  '{"keys":["signupsPer10Min","abnChecksPer10Min","perEmailPerHour"]}'::jsonb,
  'Abuse limits on the public sign-up form: sign-ups and ABN checks per internet address every 10 minutes, sign-ups per email address an hour.');
select public.business_rule_add_setting('admissions.draft_bulk_delete_max', 'Drafts deleted at once (most)', 'CRM & Admissions',
  'applications', 'application', 'number', '50'::jsonb, '{"min":1,"max":200}'::jsonb,
  'The most draft applications that can be deleted together in one go.');
select public.business_rule_add_setting('admissions.document_delete_states', 'Application documents can be deleted at', 'CRM & Admissions',
  'applications', 'documents', 'list', '["Draft","Action required"]'::jsonb, '{"allowed":["Draft","Action required"]}'::jsonb,
  'Application statuses at which an uploaded document can still be deleted for good. At any other status documents are kept.');
select public.business_rule_add_setting('admissions.retained_document_categories', 'Documents never deleted from an application', 'CRM & Admissions',
  'applications', 'documents', 'list', '["Consent","Offer","CoE"]'::jsonb, '{}'::jsonb,
  'Document types that are always kept, even on a draft application.');

-- Finance
select public.business_rule_add_setting('finance.gst_rate_percent', 'GST rate', 'Finance & Payments',
  'finance', 'fee_line', 'percentage', '10'::jsonb, '{"min":0,"max":50}'::jsonb,
  'GST on fee lines: a GST-exclusive line adds this percentage; a GST-inclusive line contains rate / (100 + rate) of its amount.');

-- Agents
select public.business_rule_add_setting('agents.onboarding_reason_min_chars', 'Shortest reason on agent onboarding', 'Agents',
  'agency_agents', 'agent_onboarding', 'number', '5'::jsonb, '{"min":1,"max":200}'::jsonb,
  'Characters a typed reason needs: sending the agreement before the references, declining an application, recording a signed copy.');
select public.business_rule_add_setting('agents.invitation_valid_days', 'Agency sign-in invitation valid for', 'Agents',
  'agency_agents', 'invitation', 'days', '7'::jsonb, '{"min":1,"max":60}'::jsonb,
  'Days an agency or agent sign-in invitation works after it is sent or sent again.');
select public.business_rule_add_setting('agents.invitation_self_resend_daily_cap', 'Invitation resends a person may ask for a day', 'Agents',
  'agency_agents', 'invitation', 'number', '10'::jsonb, '{"min":1,"max":100}'::jsonb,
  'How many times in a day someone may ask for their sign-in invitation again from the sign-in page.');
select public.business_rule_add_setting('agents.invitation_self_resend_wait_minutes', 'Wait between invitation resends', 'Agents',
  'agency_agents', 'invitation', 'number', '2'::jsonb, '{"min":1,"max":120}'::jsonb,
  'Minutes before someone may ask for their sign-in invitation again.');
select public.business_rule_add_setting('agents.abn_cache_days', 'Saved ABN register answer reused for', 'Agents',
  'agency_agents', 'business', 'days', '30'::jsonb, '{"min":1,"max":365}'::jsonb,
  'Days a saved answer from the ABN register is reused to prefill forms before it is looked up again.');
select public.business_rule_add_setting('agents.abn_lookup_fresh_days', 'ABN lookup counts as fresh for', 'Agents',
  'agency_agents', 'business', 'days', '1'::jsonb, '{"min":1,"max":30}'::jsonb,
  'Days an ABN lookup can be attached to a business after it was made.');

-- Signing
select public.business_rule_add_setting('signing.code_digits', 'Signing code length', 'Documents & Signatures',
  'signing', 'signing_request', 'number', '6'::jsonb, '{"min":4,"max":8}'::jsonb,
  'Digits in the one-time code emailed before an offer letter is signed.');
select public.business_rule_add_setting('signing.code_attempts', 'Wrong signing codes allowed', 'Documents & Signatures',
  'signing', 'signing_request', 'number', '5'::jsonb, '{"min":1,"max":20}'::jsonb,
  'Wrong tries of one code before it is locked and a new code is needed.');
select public.business_rule_add_setting('signing.codes_per_hour', 'Signing codes a signer may ask for an hour', 'Documents & Signatures',
  'signing', 'signing_request', 'number', '5'::jsonb, '{"min":1,"max":50}'::jsonb,
  'How many one-time codes one signer may ask for in an hour.');
select public.business_rule_add_setting('signing.code_valid_minutes', 'Signing code works for', 'Documents & Signatures',
  'signing', 'signing_request', 'number', '10'::jsonb, '{"min":1,"max":120}'::jsonb,
  'Minutes a one-time signing code works after it is emailed.');
select public.business_rule_add_setting('signing.code_session_minutes', 'Time to sign after the code', 'Documents & Signatures',
  'signing', 'signing_request', 'number', '30'::jsonb, '{"min":5,"max":240}'::jsonb,
  'Minutes the signer has to sign after confirming the code.');
select public.business_rule_add_setting('signing.code_resend_wait_seconds', 'Wait before another signing code', 'Documents & Signatures',
  'signing', 'signing_request', 'number', '60'::jsonb, '{"min":10,"max":3600}'::jsonb,
  'Seconds before a signer may ask for another one-time code.');
select public.business_rule_add_setting('signing.offer_link_request_wait_minutes', 'Wait before an offer link is sent again on request', 'Documents & Signatures',
  'signing', 'signing_request', 'number', '60'::jsonb, '{"min":1,"max":1440}'::jsonb,
  'Minutes before a student who asks for a new offer signing link can be sent another one.');
select public.business_rule_add_setting('signing.link_rate_limits', 'Signing page request limits', 'Documents & Signatures',
  'signing', 'signing_request', 'json', '{"perAddressPer10Min":120,"perLinkPer10Min":60,"addressSearchesPerMinute":40,"attachmentUploadsPer10Min":20}'::jsonb,
  '{"keys":["perAddressPer10Min","perLinkPer10Min","addressSearchesPerMinute","attachmentUploadsPer10Min"]}'::jsonb,
  'Abuse limits on emailed signing links: requests per internet address and per link every 10 minutes, address searches a minute, files uploaded on the agent application every 10 minutes.');
select public.business_rule_add_setting('signing.pdf_upload_max_mib', 'PDF sent for signing (MB)', 'Documents & Signatures',
  'signing', 'signing_template', 'number', '7'::jsonb, '{"min":1,"max":7}'::jsonb,
  'The largest PDF that can be uploaded as a signing template or a one-off document to sign. 7 MB is the most the signing service reads.');
select public.business_rule_add_setting('signing.word_template_max_mib', 'Word document imported into a template (MB)', 'Documents & Signatures',
  'signing', 'signing_template', 'number', '5'::jsonb, '{"min":1,"max":20}'::jsonb,
  'The largest Word document (.docx) whose text can be imported into a signing template.');

-- Support and notifications
select public.business_rule_add_setting('support.tickets_per_hour', 'Tickets a person may open an hour', 'Other',
  'support', 'ticket', 'number', '10'::jsonb, '{"min":1,"max":100}'::jsonb,
  'How many support tickets one person may open in an hour.');
select public.business_rule_add_setting('comms.invalid_recipient_lookback_days', 'Bad email addresses listed for', 'Communications',
  'notifications', 'delivery', 'days', '60'::jsonb, '{"min":1,"max":365}'::jsonb,
  'Days back the notification settings list emails that bounced as invalid addresses.');
select public.business_rule_add_setting('comms.notification_overview_days', 'Email delivery overview covers', 'Communications',
  'notifications', 'delivery', 'days', '30'::jsonb, '{"min":1,"max":365}'::jsonb,
  'Days back the delivery counts on Notifications cover.');
select public.business_rule_add_setting('comms.document_link_days', 'Document links in emails work for', 'Communications',
  'notifications', 'delivery', 'days', '7'::jsonb, '{"min":1,"max":7}'::jsonb,
  'Days the document links in the submitted-application PDF work. 7 days is the most a private storage link may last.');
select public.business_rule_add_setting('comms.submission_pdf_attach_mib', 'Submitted application attached up to (MB)', 'Communications',
  'notifications', 'delivery', 'number', '2'::jsonb, '{"min":1,"max":8}'::jsonb,
  'The largest submitted-application PDF attached to the email; a larger one is sent as a link instead.');

-- ---------------------------------------------------------------- helper
create or replace function public.signing_code_digits() returns integer
language sql stable security definer set search_path = '' as $$
  select greatest(4, least(8, public.rule_int('signing.code_digits', 6)));
$$;
revoke all on function public.signing_code_digits() from public, anon, authenticated;
grant execute on function public.signing_code_digits() to service_role;

-- ---------------------------------------------------------------- function patches
-- agents.signed_copy_upload_max_mb (existing rule): signed agreement / referee check copies.
select public.business_rule_patch_function('public.agency_onboarding_agent_agreement_upload(uuid,text,text,text,boolean)'::regprocedure,
  $o$ if length(v) < 5 or length(v) > 15 * 1024 * 1024 or substring(v from 1 for 4) <> '\x25504446'::bytea then raise exception 'Upload the signed agreement as a PDF (up to 15 MB)'; end if;$o$,
  $n$ if length(v) < 5 or length(v) > greatest(1, public.rule_int('agents.signed_copy_upload_max_mb', 15))::bigint * 1048576 or substring(v from 1 for 4) <> '\x25504446'::bytea then raise exception 'Upload the signed agreement as a PDF (up to % MB)', greatest(1, public.rule_int('agents.signed_copy_upload_max_mb', 15)); end if;$n$, 1);
select public.business_rule_patch_function('public.agency_onboarding_referee_upload(uuid,text,text)'::regprocedure,
  $o$ if length(v) < 5 or length(v) > 15 * 1024 * 1024 or substring(v from 1 for 4) <> '\x25504446'::bytea then raise exception 'Upload the signed referee check as a PDF (up to 15 MB)'; end if;$o$,
  $n$ if length(v) < 5 or length(v) > greatest(1, public.rule_int('agents.signed_copy_upload_max_mb', 15))::bigint * 1048576 or substring(v from 1 for 4) <> '\x25504446'::bytea then raise exception 'Upload the signed referee check as a PDF (up to % MB)', greatest(1, public.rule_int('agents.signed_copy_upload_max_mb', 15)); end if;$n$, 1);

-- agents.onboarding_reason_min_chars
select public.business_rule_patch_function('public.agency_onboarding_agent_agreement_upload(uuid,text,text,text,boolean)'::regprocedure,
  $o$ if v_reason is null or length(v_reason) < 5 then$o$,
  $n$ if v_reason is null or length(v_reason) < greatest(1, public.rule_int('agents.onboarding_reason_min_chars', 5)) then$n$, 1);
select public.business_rule_patch_function('public.agency_onboarding_agreement_create(uuid,uuid,jsonb)'::regprocedure,
  $o$if v_reason is null or length(v_reason) < 5 then$o$,
  $n$if v_reason is null or length(v_reason) < greatest(1, public.rule_int('agents.onboarding_reason_min_chars', 5)) then$n$, 1);
select public.business_rule_patch_function('public.agency_onboarding_decline(uuid,text)'::regprocedure,
  $o$if v_reason is null or length(v_reason) < 5 then$o$,
  $n$if v_reason is null or length(v_reason) < greatest(1, public.rule_int('agents.onboarding_reason_min_chars', 5)) then$n$, 1);
select public.business_rule_patch_function('public.admin_business_document_add(uuid,text,text,text,bigint,text)'::regprocedure,
  $o$(v_reason is null or length(v_reason) < 5) then$o$,
  $n$(v_reason is null or length(v_reason) < greatest(1, public.rule_int('agents.onboarding_reason_min_chars', 5))) then$n$, 1);

-- agents.invitation_valid_days (column default + the three functions that renew an invitation)
alter table public.agency_invitations alter column expires_at set default (now() + make_interval(days => greatest(1, public.rule_int('agents.invitation_valid_days', 7))));
select public.business_rule_patch_function('public.admin_business_set_status(uuid,text)'::regprocedure,
  $o$now() + interval '7 days'$o$, $n$now() + make_interval(days => greatest(1, public.rule_int('agents.invitation_valid_days', 7)))$n$, 1);
select public.business_rule_patch_function('public.portal_invitation_resend(uuid,uuid)'::regprocedure,
  $o$now() + interval '7 days'$o$, $n$now() + make_interval(days => greatest(1, public.rule_int('agents.invitation_valid_days', 7)))$n$, 1);
select public.business_rule_patch_function('public.portal_self_register(text,jsonb)'::regprocedure,
  $o$now() + interval '7 days'$o$, $n$now() + make_interval(days => greatest(1, public.rule_int('agents.invitation_valid_days', 7)))$n$, 1);

-- agents.invitation_self_resend_daily_cap / _wait_minutes
select public.business_rule_patch_function('public.portal_invitation_self_resend(text,text)'::regprocedure,
  $o$inv.link_sent_at > now() - interval '2 minutes' then$o$,
  $n$inv.link_sent_at > now() - make_interval(mins => greatest(1, public.rule_int('agents.invitation_self_resend_wait_minutes', 2))) then$n$, 1);
select public.business_rule_patch_function('public.portal_invitation_self_resend(text,text)'::regprocedure,
  $o$if coalesce(inv.sent_count, 0) >= 10 and$o$,
  $n$if coalesce(inv.sent_count, 0) >= greatest(1, public.rule_int('agents.invitation_self_resend_daily_cap', 10)) and$n$, 1);

-- agents.abn_cache_days / agents.abn_lookup_fresh_days
select public.business_rule_patch_function('public.abr_business_cache_get(text)'::regprocedure,
  $o$b.synced_at > now() - interval '30 days'$o$,
  $n$b.synced_at > now() - make_interval(days => greatest(1, public.rule_int('agents.abn_cache_days', 30)))$n$, 1);
select public.business_rule_patch_function('public.agency_abr_attach(uuid,jsonb)'::regprocedure,
  $o$and fetched_at > now() - interval '1 day';$o$,
  $n$and fetched_at > now() - make_interval(days => greatest(1, public.rule_int('agents.abn_lookup_fresh_days', 1)));$n$, 1);

-- support.tickets_per_hour
select public.business_rule_patch_function('public.support_ticket_create(text,text,text,text,jsonb,uuid)'::regprocedure,
  $o$and created_at > now() - interval '1 hour') >= 10 then$o$,
  $n$and created_at > now() - interval '1 hour') >= greatest(1, public.rule_int('support.tickets_per_hour', 10)) then$n$, 1);

-- admissions.guest_link_default_days / _max_days, admissions.guest_link_emails_per_application_hour / _per_sender_hour
select public.business_rule_patch_function('public.portal_create_guest_link(uuid,integer)'::regprocedure,
  $o$make_interval(days => greatest(1, least(coalesce(p_days, 7), 30)))$o$,
  $n$make_interval(days => greatest(1, least(coalesce(p_days, public.rule_int('admissions.guest_link_default_days', 7)), public.rule_int('admissions.guest_link_max_days', 30))))$n$, 1);
select public.business_rule_patch_function('public.portal_send_guest_link_email(uuid,text,text,text)'::regprocedure,
  $o$sent_at > now() - interval '1 hour') >= 3$o$,
  $n$sent_at > now() - interval '1 hour') >= greatest(1, public.rule_int('admissions.guest_link_emails_per_application_hour', 3))$n$, 1);
select public.business_rule_patch_function('public.portal_send_guest_link_email(uuid,text,text,text)'::regprocedure,
  $o$sent_at > now() - interval '1 hour') >= 10 then$o$,
  $n$sent_at > now() - interval '1 hour') >= greatest(1, public.rule_int('admissions.guest_link_emails_per_sender_hour', 10)) then$n$, 1);

-- admissions.offer_validity_days (was cms_settings.offer_validity_days, still the fallback) / admissions.offer_link_minimum_days
select public.business_rule_patch_function('public.application_letter_values(uuid)'::regprocedure,
  $o$coalesce(st.offer_validity_days, 30)$o$, $n$public.rule_int('admissions.offer_validity_days', coalesce(st.offer_validity_days, 30))$n$, 2);
select public.business_rule_patch_function('public.application_letter_values(uuid)'::regprocedure,
  $o$' days (Website settings › Offer validity)'$o$, $n$' days (Business Rules › Offer letter valid for)'$n$, 1);
select public.business_rule_patch_function('public.notification_delivery_offer_signing(uuid,uuid,integer,boolean,text)'::regprocedure,
  $o$v_days := least(greatest(coalesce(st.offer_validity_days, 30), 1), 365);$o$,
  $n$v_days := greatest(public.rule_int('admissions.offer_validity_days', coalesce(st.offer_validity_days, 30)), 1);$n$, 1);
select public.business_rule_patch_function('public.notification_delivery_offer_signing(uuid,uuid,integer,boolean,text)'::regprocedure,
  $o$now() + interval '1 day'$o$, $n$now() + make_interval(days => greatest(1, public.rule_int('admissions.offer_link_minimum_days', 1)))$n$, 2);

-- finance.gst_rate_percent (both helpers become stable: they read a rule; no index, default or constraint uses them)
select public.business_rule_patch_function('public.course_fee_item_gst_cents(bigint,text)'::regprocedure,
  $o$ IMMUTABLE$o$, $n$ STABLE$n$, 1);
select public.business_rule_patch_function('public.course_fee_item_gst_cents(bigint,text)'::regprocedure,
  $o$when 'exclusive' then round(p_amount / 10.0)::bigint when 'inclusive' then round(p_amount / 11.0)::bigint$o$,
  $n$when 'exclusive' then round(p_amount * public.rule_num('finance.gst_rate_percent', 10) / 100.0)::bigint when 'inclusive' then round(p_amount * public.rule_num('finance.gst_rate_percent', 10) / (100.0 + public.rule_num('finance.gst_rate_percent', 10)))::bigint$n$, 1);
select public.business_rule_patch_function('public.course_fee_item_total_cents(bigint,text)'::regprocedure,
  $o$ IMMUTABLE$o$, $n$ STABLE$n$, 1);
select public.business_rule_patch_function('public.course_fee_item_total_cents(bigint,text)'::regprocedure,
  $o$p_amount + round(p_amount / 10.0)::bigint$o$,
  $n$p_amount + public.course_fee_item_gst_cents(p_amount, 'exclusive')$n$, 1);

-- comms.invalid_recipient_lookback_days / comms.notification_overview_days
select public.business_rule_patch_function('public.notification_invalid_recipients(uuid)'::regprocedure,
  $o$d.created_at > now() - interval '60 days'$o$, $n$d.created_at > now() - make_interval(days => greatest(1, public.rule_int('comms.invalid_recipient_lookback_days', 60)))$n$, 1);
select public.business_rule_patch_function('public.tenant_notification_overview(uuid)'::regprocedure,
  $o$created_at > now() - interval '30 days'$o$, $n$created_at > now() - make_interval(days => greatest(1, public.rule_int('comms.notification_overview_days', 30)))$n$, 1);

-- signing.* one-time code and link rules (signing_service body uses CRLF line ends: every snippet stays on one line)
select public.business_rule_patch_function('public.signing_service(text,text,uuid,jsonb)'::regprocedure,
  $o$q.created_at > v_now - interval '60 seconds') then$o$,
  $n$q.created_at > v_now - make_interval(secs => greatest(10, public.rule_int('signing.code_resend_wait_seconds', 60)))) then$n$, 1);
select public.business_rule_patch_function('public.signing_service(text,text,uuid,jsonb)'::regprocedure,
  $o$q.created_at > v_now - interval '1 hour') >= 5 then$o$,
  $n$q.created_at > v_now - interval '1 hour') >= greatest(1, public.rule_int('signing.codes_per_hour', 5)) then$n$, 1);
select public.business_rule_patch_function('public.signing_service(text,text,uuid,jsonb)'::regprocedure,
  $o$::bit(32)::bigint) % 1000000)::text, 6, '0');$o$,
  $n$::bit(32)::bigint) % (10::bigint ^ public.signing_code_digits())::bigint)::text, public.signing_code_digits(), '0');$n$, 1);
select public.business_rule_patch_function('public.signing_service(text,text,uuid,jsonb)'::regprocedure,
  $o$v_now + interval '10 minutes', left(p_data->>'ip', 64));$o$,
  $n$v_now + make_interval(mins => greatest(1, public.rule_int('signing.code_valid_minutes', 10))), left(p_data->>'ip', 64));$n$, 1);
select public.business_rule_patch_function('public.signing_service(text,text,uuid,jsonb)'::regprocedure,
  $o$'expires_in_minutes', 10);$o$, $n$'expires_in_minutes', greatest(1, public.rule_int('signing.code_valid_minutes', 10)));$n$, 1);
select public.business_rule_patch_function('public.signing_service(text,text,uuid,jsonb)'::regprocedure,
  $o$if kc.attempts >= 5 then return$o$, $n$if kc.attempts >= greatest(1, public.rule_int('signing.code_attempts', 5)) then return$n$, 1);
select public.business_rule_patch_function('public.signing_service(text,text,uuid,jsonb)'::regprocedure,
  $o$coalesce(p_data->>'code', '') !~ '^[0-9]{6}$'$o$, $n$coalesce(p_data->>'code', '') !~ ('^[0-9]{' || public.signing_code_digits() || '}$')$n$, 1);
select public.business_rule_patch_function('public.signing_service(text,text,uuid,jsonb)'::regprocedure,
  $o$case when kc.attempts >= 5 then 'locked' else 'wrong' end, 'remaining', greatest(5 - kc.attempts, 0)$o$,
  $n$case when kc.attempts >= greatest(1, public.rule_int('signing.code_attempts', 5)) then 'locked' else 'wrong' end, 'remaining', greatest(greatest(1, public.rule_int('signing.code_attempts', 5)) - kc.attempts, 0)$n$, 1);
select public.business_rule_patch_function('public.signing_service(text,text,uuid,jsonb)'::regprocedure,
  $o$session_expires_at = v_now + interval '30 minutes',$o$,
  $n$session_expires_at = v_now + make_interval(mins => greatest(5, public.rule_int('signing.code_session_minutes', 30))),$n$, 1);
select public.business_rule_patch_function('public.signing_service(text,text,uuid,jsonb)'::regprocedure,
  $o$'session', v_session, 'expires_in_minutes', 30);$o$,
  $n$'session', v_session, 'expires_in_minutes', greatest(5, public.rule_int('signing.code_session_minutes', 30)));$n$, 1);
select public.business_rule_patch_function('public.signing_service(text,text,uuid,jsonb)'::regprocedure,
  $o$g.action = 'offer_signing_link_requested' and g.created_at > v_now - interval '1 hour');$o$,
  $n$g.action = 'offer_signing_link_requested' and g.created_at > v_now - make_interval(mins => greatest(1, public.rule_int('signing.offer_link_request_wait_minutes', 60))));$n$, 1);

-- ===== batch5-hr =====
-- ===== BUSINESS-RULES-LIVE batch 5: HR, sign-in, CMS uploads, Office 365 / intake groups, public assistant, ops logs =====
-- Every rule starts at the value the system used on 2026-11-20 (nothing changes on the day).
-- Functions patched here: public.hr_svc_apply, public.hr_svc_email_claim, public.hr_svc_email_result, public.hr_retention_dispatch,
-- public.hr_admin_holidays_add, public.hr_admin_employee_pay_save, public.hr_admin_staff_signed_upload_add, public.cron_http_collect,
-- public.cron_http_health_check, public.edge_function_error_report.

-- ---------- the rules ----------
-- Staff recruitment and onboarding.
select public.business_rule_add_setting('hrms.job_application_rate_limits', 'Job applications allowed', 'HRMS', 'staff_candidates', 'applicant', 'json',
  '{"perVisitorPer10Minutes":5,"perEmailPerHour":3}'::jsonb, '{"keys":["perVisitorPer10Minutes","perEmailPerHour"]}'::jsonb,
  'How many job applications the Careers / staff form takes: perVisitorPer10Minutes from one device in 10 minutes, perEmailPerHour for one email address in an hour. More are asked to wait.');
select public.business_rule_add_setting('hrms.already_applied_email_hours', '"Already applied" email at most every', 'HRMS', 'staff_candidates', 'applicant', 'hours',
  '1'::jsonb, '{"min":1,"max":168}'::jsonb,
  'Someone who applies again while their application is open is emailed that they already applied, at most once in this many hours.');
select public.business_rule_add_setting('hrms.staff_email_attempts', 'Staff email tries before failed', 'HRMS', 'staff', 'staff_email', 'number',
  '3'::jsonb, '{"min":1,"max":10}'::jsonb,
  'How many times an HR email (application received, links, offer, rejection) is tried before it is marked failed and shown for a manual retry.');
select public.business_rule_add_setting('hrms.retention_purge_batch', 'Rejected applications cleared per run', 'HRMS', 'staff_candidates', 'applicant', 'number',
  '50'::jsonb, '{"min":1,"max":200}'::jsonb,
  'How many rejected applications past the retention period have their files deleted in one run of the daily clean-up.');
select public.business_rule_add_setting('hrms.signed_copy_upload_max_mib', 'Paper-signed staff document size limit (MB)', 'HRMS', 'staff', 'staff_document', 'number',
  '15'::jsonb, '{"min":1,"max":15}'::jsonb,
  'The largest copy signed on paper (PDF, image or Word) staff can upload against a staff member, in MB.');
-- Public holidays.
select public.business_rule_add_setting('hrms.holiday_range_max_days', 'Longest holiday range', 'HRMS', 'public_holidays', 'holiday', 'days',
  '31'::jsonb, '{"min":1,"max":366}'::jsonb,
  'The most days one holiday added by hand may cover (first day to last day).');
select public.business_rule_add_setting('hrms.holiday_import_max_mib', 'Holiday import file size limit (MB)', 'HRMS', 'public_holidays', 'holiday', 'number',
  '2'::jsonb, '{"min":1,"max":10}'::jsonb,
  'The largest Excel or CSV file of public holidays that can be imported, in MB.');
select public.business_rule_add_setting('hrms.holidays_list_days_ahead', 'Holidays shown to staff', 'HRMS', 'public_holidays', 'holiday', 'days',
  '365'::jsonb, '{"min":30,"max":730}'::jsonb,
  'How many days ahead My HR › Holidays lists the coming public holidays.');
-- CMS uploads.
select public.business_rule_add_setting('cms.image_upload_limit_mib', 'Website image size limit (MB)', 'CMS Website', 'cms', 'image', 'number',
  '5'::jsonb, '{"min":1,"max":20}'::jsonb,
  'The largest PNG, JPEG, WebP or GIF picture staff can upload for the website, in MB.');
select public.business_rule_add_setting('cms.letter_picture_limit_mib', 'Letter picture size limit (MB)', 'Documents & Signatures', 'templates', 'template_asset', 'number',
  '2'::jsonb, '{"min":1,"max":2}'::jsonb,
  'The largest picture (for example a logo) that can be placed in a letter template, in MB.');
select public.business_rule_add_setting('cms.word_import_limit_mib', 'Word import size limit (MB)', 'Documents & Signatures', 'templates', 'template', 'number',
  '10'::jsonb, '{"min":1,"max":50}'::jsonb,
  'The largest Word (.docx) document that can be imported as the body of a document template, in MB.');
-- Office 365 and intake groups.
select public.business_rule_add_setting('office365.sign_in_url', 'Office 365 sign-in address', 'Other', 'email_management/create', 'mailbox', 'text',
  '"https://www.office.com"'::jsonb, '{}'::jsonb,
  'The web address the login email of a new SLIT email account tells the person to sign in at (must start with https://).');
select public.business_rule_add_setting('office365.intake_group_visibility', 'Intake group visibility', 'Communications', 'intake_groups', 'group', 'dropdown',
  '"Private"'::jsonb, '{"allowed":["Private","Public"]}'::jsonb,
  'Private: only the members of an intake''s Microsoft 365 group see it. Public: anyone in the SLIT tenant can find and read it. Applies to groups created from now on.',
  '["Private","Public"]'::jsonb);
select public.business_rule_add_setting('office365.intake_group_description', 'Intake group description', 'Communications', 'intake_groups', 'group', 'text',
  '"SLIT class group: {name}"'::jsonb, '{}'::jsonb,
  'The description given to a new intake''s Microsoft 365 group. {name} is replaced by the group''s name.');
-- Website assistant.
select public.business_rule_add_setting('website.assistant_requests_per_minute', 'Website assistant questions per minute', 'CMS Website', 'public_assistant', 'assistant', 'number',
  '20'::jsonb, '{"min":1,"max":600}'::jsonb,
  'How many questions one visitor can ask the website assistant in a minute before being asked to wait.');
-- Institution named in automated emails (HR emails now; other senders can read the same rule).
select public.business_rule_add_setting('comms.email_institution_name', 'Institution name in automated emails', 'Communications', 'notifications', 'email', 'text',
  '"Skyline Institute of Technology"'::jsonb, '{}'::jsonb,
  'The name that signs off automated emails (staff applications, links, offers and rejections today).');
-- Operations monitoring.
select public.business_rule_add_setting('ops.monitoring_log_days', 'Scheduled call and error logs kept for', 'Other', 'settings', 'monitoring', 'days',
  '30'::jsonb, '{"min":7,"max":365}'::jsonb,
  'Days the log of scheduled calls (public.cron_http_calls) and the Edge Function errors people saw (public.edge_function_errors) are kept.');
select public.business_rule_add_setting('ops.cron_call_lost_after_minutes', 'Scheduled call counted as lost after', 'Other', 'settings', 'monitoring', 'number',
  '60'::jsonb, '{"min":10,"max":1440}'::jsonb,
  'Minutes after which a scheduled call with no answer is counted as failed (no response).');
select public.business_rule_add_setting('ops.error_report_limits', 'Edge Function error reports kept', 'Other', 'settings', 'monitoring', 'json',
  '{"perReporterPerHour":30,"perFunctionPerDay":300}'::jsonb, '{"keys":["perReporterPerHour","perFunctionPerDay"]}'::jsonb,
  'The most error reports recorded from one browser in an hour (perReporterPerHour) and for one Edge Function in a day (perFunctionPerDay); more are dropped.');

-- ---------- patches ----------
-- "Already applied" email interval.
select public.business_rule_patch_function('public.hr_svc_apply(text, text, text, text, uuid, text)'::regprocedure,
$o$e.created_at > now() - interval '1 hour')$o$,
$n$e.created_at > now() - make_interval(hours => public.rule_int('hrms.already_applied_email_hours', 1)))$n$, 1);
-- HR email tries.
select public.business_rule_patch_function('public.hr_svc_email_claim(integer, integer, text[])'::regprocedure,
$o$e.attempts < 3$o$, $n$e.attempts < public.rule_int('hrms.staff_email_attempts', 3)$n$, 1);
select public.business_rule_patch_function('public.hr_svc_email_result(bigint, text, text, text)'::regprocedure,
$o$attempts >= 3 then 'failed'$o$, $n$attempts >= public.rule_int('hrms.staff_email_attempts', 3) then 'failed'$n$, 1);
-- Retention job: called only when an application is past the retention period itself (was: any rejection older than a month).
select public.business_rule_patch_function('public.hr_retention_dispatch()'::regprocedure,
$o$p.status_changed_at < now() - interval '1 month')$o$,
$n$p.status_changed_at < now() - make_interval(months => least(greatest(public.rule_int('hrms.onboarding_file_retention_fallback', 6), 1), 120)))$n$, 1);
-- Holiday range.
select public.business_rule_patch_function('public.hr_admin_holidays_add(jsonb)'::regprocedure,
$o$elsif v_end - v_start > 30 then problems := problems || format('holiday %s: a range can cover up to 31 days', i);$o$,
$n$elsif v_end - v_start + 1 > public.rule_int('hrms.holiday_range_max_days', 31) then problems := problems || format('holiday %s: a range can cover up to %s days', i, public.rule_int('hrms.holiday_range_max_days', 31));$n$, 1);
-- Ordinary hours per week on a staff member's pay (the table check stays at 80, the rule's maximum).
select public.business_rule_patch_function('public.hr_admin_employee_pay_save(uuid, jsonb)'::regprocedure,
$o$if v_schedule is not null and not exists (select 1 from hr.pay_schedules s where s.id = v_schedule) then raise exception 'Schedule not found.' using errcode = 'P0002'; end if;$o$,
$n$if v_schedule is not null and not exists (select 1 from hr.pay_schedules s where s.id = v_schedule) then raise exception 'Schedule not found.' using errcode = 'P0002'; end if;
 if nullif(p_pay->>'ordinaryHoursWeek', '')::numeric > public.rule_num('hrms.staff_weekly_hours_cap', 80) then
  raise exception 'Ordinary hours per week can be at most % hours.', public.rule_num('hrms.staff_weekly_hours_cap', 80) using errcode = '22023'; end if;$n$, 1);
-- Paper-signed copy size (the bucket staff-signed-documents keeps its 15 MB ceiling, the rule's maximum).
select public.business_rule_patch_function('public.hr_admin_staff_signed_upload_add(uuid, text, text, text, bigint)'::regprocedure,
$o$  raise exception 'Upload the file first' using errcode = '22023'; end if;$o$,
$n$  raise exception 'Upload the file first' using errcode = '22023'; end if;
 if coalesce((select (o.metadata->>'size')::bigint from storage.objects o where o.bucket_id = 'staff-signed-documents' and o.name = p_path), p_size, 0)
    > public.rule_int('hrms.signed_copy_upload_max_mib', 15)::bigint * 1048576 then
  raise exception 'The file is larger than % MB.', public.rule_int('hrms.signed_copy_upload_max_mib', 15) using errcode = '22023'; end if;$n$, 1);
-- Scheduled call log.
select public.business_rule_patch_function('public.cron_http_collect()'::regprocedure,
$o$detail = 'no response within an hour', collected_at = now()$o$,
$n$detail = 'no response within ' || public.rule_int('ops.cron_call_lost_after_minutes', 60) || ' minutes', collected_at = now()$n$, 1);
select public.business_rule_patch_function('public.cron_http_collect()'::regprocedure,
$o$where collected_at is null and called_at < now() - interval '1 hour';$o$,
$n$where collected_at is null and called_at < now() - make_interval(mins => public.rule_int('ops.cron_call_lost_after_minutes', 60));$n$, 1);
select public.business_rule_patch_function('public.cron_http_collect()'::regprocedure,
$o$where called_at < now() - interval '30 days';$o$,
$n$where called_at < now() - make_interval(days => public.rule_int('ops.monitoring_log_days', 30));$n$, 1);
select public.business_rule_patch_function('public.cron_http_health_check(integer, integer)'::regprocedure,
$o$delete from public.edge_function_errors where last_at < now() - interval '30 days';$o$,
$n$delete from public.edge_function_errors where last_at < now() - make_interval(days => public.rule_int('ops.monitoring_log_days', 30));$n$, 1);
-- Error report limits.
select public.business_rule_patch_function('public.edge_function_error_report(text, integer, text)'::regprocedure,
$o$e.last_at > now() - interval '1 hour') >= 30 then return;$o$,
$n$e.last_at > now() - interval '1 hour') >= coalesce((public.rule_json('ops.error_report_limits', '{}'::jsonb)->>'perReporterPerHour')::integer, 30) then return;$n$, 1);
select public.business_rule_patch_function('public.edge_function_error_report(text, integer, text)'::regprocedure,
$o$e.first_at > now() - interval '1 day') >= 300 then return;$o$,
$n$e.first_at > now() - interval '1 day') >= coalesce((public.rule_json('ops.error_report_limits', '{}'::jsonb)->>'perFunctionPerDay')::integer, 300) then return;$n$, 1);

-- ---------- check ----------
do $$ declare r text; begin
  foreach r in array array['hrms.job_application_rate_limits', 'hrms.already_applied_email_hours', 'hrms.staff_email_attempts',
    'hrms.retention_purge_batch', 'hrms.signed_copy_upload_max_mib', 'hrms.holiday_range_max_days', 'hrms.holiday_import_max_mib',
    'hrms.holidays_list_days_ahead', 'cms.image_upload_limit_mib', 'cms.letter_picture_limit_mib', 'cms.word_import_limit_mib',
    'office365.sign_in_url', 'office365.intake_group_visibility', 'office365.intake_group_description', 'website.assistant_requests_per_minute',
    'ops.monitoring_log_days', 'ops.cron_call_lost_after_minutes', 'ops.error_report_limits', 'comms.email_institution_name'] loop
    if not exists (select 1 from public.business_rules b join public.business_rule_versions v on v.rule_id = b.id and v.state = 'published'
                    where b.scope_key = '' and b.identifier = r) then
      raise exception 'BUSINESS-RULES-LIVE batch 5 (HR): rule % is missing or not published', r;
    end if;
  end loop;
  if public.rule_int('hrms.staff_email_attempts', -1) <> 3 or public.rule_int('hrms.holiday_range_max_days', -1) <> 31
     or public.rule_int('ops.monitoring_log_days', -1) <> 30 or public.rule_int('ops.cron_call_lost_after_minutes', -1) <> 60
     or public.rule_text('office365.intake_group_visibility', '') <> 'Private'
     or (public.rule_json('ops.error_report_limits', '{}'::jsonb)->>'perFunctionPerDay')::integer <> 300 then
    raise exception 'BUSINESS-RULES-LIVE batch 5 (HR): a rule does not read back at today''s value';
  end if;
end $$;

-- ===== batch5-lms =====
-- ===== BUSINESS-RULES-LIVE batch 5: LMS (parts of the day, master timetable plan, VoE calendar, rescheduling), assessment
-- settings and attempts, Bookings. Every rule starts at the value the system uses today. (Assembled by the coordinator.)

-- ----- helpers -----
-- Parts of the day (lms.day_part_times / lms.day_part_cutoffs), with the old fixed times when a value is missing or malformed.
create or replace function public.lms_day_part_cutoff(p_key text) returns time
language plpgsql stable security definer set search_path = '' as $$
declare v text := public.rule_json('lms.day_part_cutoffs', '{"afternoonFrom":"12:00","eveningFrom":"16:00"}'::jsonb)->>p_key;
begin
  if v ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then return v::time; end if;
  return case p_key when 'afternoonFrom' then time '12:00' else time '16:00' end;
end $$;
create or replace function public.lms_day_part_time(p_slot text, p_end boolean) returns time
language plpgsql stable security definer set search_path = '' as $$
declare k text := case p_slot when 'morning' then 'morning' when 'afternoon' then 'afternoon' else 'evening' end;
  v text := public.rule_json('lms.day_part_times', '{"morning":"09:00-13:00","afternoon":"13:00-17:00","evening":"17:00-21:00"}'::jsonb)->>k;
begin
  if v !~ '^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$' then
    v := case k when 'morning' then '09:00-13:00' when 'afternoon' then '13:00-17:00' else '17:00-21:00' end;
  end if;
  return split_part(v, '-', case when p_end then 2 else 1 end)::time;
end $$;
-- The weekdays of lms.reschedule_new_day_weekdays as day numbers (Sunday 0), Monday to Friday when the rule is empty.
create or replace function public.lms_reschedule_weekdays() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_agg(n order by n) from (select distinct array_position(array['sunday','monday','tuesday','wednesday','thursday','friday','saturday'], lower(btrim(x))) - 1 as n
      from jsonb_array_elements_text(public.rule_json('lms.reschedule_new_day_weekdays', '["Monday","Tuesday","Wednesday","Thursday","Friday"]'::jsonb)) x) d where n is not null),
    '[1,2,3,4,5]'::jsonb);
$$;
revoke all on function public.lms_day_part_cutoff(text) from public, anon;
revoke all on function public.lms_day_part_time(text, boolean) from public, anon;
revoke all on function public.lms_reschedule_weekdays() from public, anon;
grant execute on function public.lms_day_part_cutoff(text), public.lms_day_part_time(text, boolean), public.lms_reschedule_weekdays() to authenticated, service_role;

-- Values the registration limits cannot check are refused on save.
create or replace function public.business_rule_versions_lms5_check() returns trigger
language plpgsql set search_path = '' as $$
declare v jsonb := new.definition->'value'; v_id text := new.definition->>'identifier'; k text; e jsonb;
begin
  if v_id = 'lms.day_part_times' then
    foreach k in array array['morning','afternoon','evening'] loop
      if coalesce(v->>k, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$' or split_part(v->>k, '-', 1) >= split_part(v->>k, '-', 2) then
        raise exception 'Enter each part of the day as HH:MM-HH:MM, the start before the end (for example 09:00-13:00).' using errcode = '22023';
      end if;
    end loop;
  elsif v_id = 'lms.day_part_cutoffs' then
    if coalesce(v->>'afternoonFrom', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(v->>'eveningFrom', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or v->>'afternoonFrom' >= v->>'eveningFrom' then
      raise exception 'Enter afternoonFrom and eveningFrom as HH:MM, afternoonFrom first.' using errcode = '22023';
    end if;
  elsif v_id = 'assessment.attempts_allowed_range' then
    if jsonb_typeof(v->'minimum') is distinct from 'number' or jsonb_typeof(v->'maximum') is distinct from 'number'
       or (v->>'minimum')::numeric < 1 or (v->>'maximum')::numeric > 10 or (v->>'minimum')::numeric > (v->>'maximum')::numeric then
      raise exception 'Enter whole numbers: minimum at least 1, maximum at most 10, the minimum not above the maximum.' using errcode = '22023';
    end if;
  elsif v_id = 'assessment.student_declaration' then
    if jsonb_typeof(v) is distinct from 'string' or char_length(btrim(v #>> '{}')) < 10 then
      raise exception 'Enter the declaration students sign (at least 10 characters).' using errcode = '22023';
    end if;
  elsif v_id = 'assessment.evidence_allowed_types' then
    if jsonb_typeof(v) is distinct from 'array' or jsonb_array_length(v) = 0
       or exists (select 1 from jsonb_array_elements(v) x where jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ '^[a-z]+/[A-Za-z0-9.+*-]+$') then
      raise exception 'Enter at least one file type as a MIME type, one per line (for example application/pdf).' using errcode = '22023';
    end if;
  elsif v_id = 'booking.type_choices' then
    foreach k in array array['lengths','buffers','noticeHours','daysAhead'] loop
      if jsonb_typeof(v->k) is distinct from 'array' or jsonb_array_length(v->k) = 0 then
        raise exception 'Give at least one choice for %.', k using errcode = '22023';
      end if;
      for e in select x from jsonb_array_elements(v->k) x loop
        if jsonb_typeof(e) <> 'number' or (e #>> '{}')::numeric <> trunc((e #>> '{}')::numeric)
           or (e #>> '{}')::numeric < case k when 'lengths' then 5 when 'daysAhead' then 1 else 0 end
           or (e #>> '{}')::numeric > case k when 'lengths' then 480 when 'buffers' then 120 when 'noticeHours' then 720 else 365 end then
          raise exception 'Use whole numbers: lengths 5 to 480 minutes, buffers 0 to 120 minutes, noticeHours 0 to 720, daysAhead 1 to 365.' using errcode = '22023';
        end if;
      end loop;
    end loop;
  elsif v_id = 'booking.slot_lookup_days' then
    if jsonb_typeof(v->'default') is distinct from 'number' or jsonb_typeof(v->'max') is distinct from 'number'
       or (v->>'default')::numeric < 1 or (v->>'max')::numeric > 365 or (v->>'default')::numeric > (v->>'max')::numeric then
      raise exception 'Enter whole days: default at least 1, max at most 365, the default not above max.' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create or replace trigger business_rule_versions_lms5_check before insert or update on public.business_rule_versions
  for each row execute function public.business_rule_versions_lms5_check();

-- ----- rules -----
select public.business_rule_add_setting('lms.day_part_times', 'Parts of the day: class times', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'json', '{"morning":"09:00-13:00","afternoon":"13:00-17:00","evening":"17:00-21:00"}'::jsonb, '{"keys":["morning","afternoon","evening"]}'::jsonb,
  'The start and end time a new class gets when staff pick Morning, Afternoon or Evening (HH:MM-HH:MM each).', '[]'::jsonb);
select public.business_rule_add_setting('lms.day_part_cutoffs', 'Parts of the day: where they split', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'json', '{"afternoonFrom":"12:00","eveningFrom":"16:00"}'::jsonb, '{"keys":["afternoonFrom","eveningFrom"]}'::jsonb,
  'A class starting before afternoonFrom counts as Morning, before eveningFrom as Afternoon, otherwise Evening (room and trainer no-clash checks, rooms board).', '[]'::jsonb);
select public.business_rule_add_setting('lms.voe_max_units_together', 'VoE units studied at the same time', 'Intakes & Scheduling',
  'lms/courses', 'course', 'number', '2'::jsonb, '{"min":1,"max":4}'::jsonb,
  'The VoE weekly calendar lets at most this many units run at the same time; their hours a week add up to no more than the VoE weekly study hours.', '[]'::jsonb);
select public.business_rule_add_setting('lms.master_plan_max_years', 'Master timetable planned at most this many years ahead', 'Intakes & Scheduling',
  'lms/courses', 'course', 'number', '10'::jsonb, '{"min":1,"max":20}'::jsonb,
  'Qualification cycles of a course''s master timetable may be scheduled up to this many years after the current cycle starts.', '[]'::jsonb);
select public.business_rule_add_setting('lms.master_plan_alert_months', 'Weekly reminder to schedule more cycles from', 'Intakes & Scheduling',
  'lms/courses', 'course', 'number', '12'::jsonb, '{"min":1,"max":36}'::jsonb,
  'RTO Managers get a weekly reminder once the last scheduled cycle of a course ends within this many months.', '[]'::jsonb);
select public.business_rule_add_setting('lms.master_plan_lock_months', 'Course locked this many months before its plan ends', 'Intakes & Scheduling',
  'lms/courses', 'course', 'number', '3'::jsonb, '{"min":0,"max":24}'::jsonb,
  'Within this many months of the last scheduled cycle''s end, the course takes no new intakes, enrolments or class time changes until more cycles are scheduled.', '[]'::jsonb);
select public.business_rule_add_setting('lms.reschedule_spread_step_minutes', 'Spread a missed class in steps of', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'number', '15'::jsonb, '{"min":5,"max":60}'::jsonb,
  'When a missed class is spread over the next classes, the minutes added to each class are rounded up to this step.', '[]'::jsonb);
select public.business_rule_add_setting('assessment.who_may_mark', 'Who may mark and sign off', 'Assessments',
  'lms/assessments', 'assessment', 'dropdown', '"Intake trainers with the Trainer role, named assessors, admins"'::jsonb, '{"allowed": ["Intake trainers with the Trainer role, named assessors, admins", "Any active intake trainer, named assessors, admins"]}'::jsonb,
  'Who may mark assessments and sign off unit outcomes besides named assessors and admins.', '["Intake trainers with the Trainer role, named assessors, admins", "Any active intake trainer, named assessors, admins"]'::jsonb);
select public.business_rule_add_setting('assessment.student_declaration', 'Student declaration at submission', 'Assessments',
  'lms/assessments', 'assessment', 'text', '"I declare that the work submitted is my own, that I have not copied it from any other person or source, that no part of it has been written for me by another person, and that I understand reassessment and appeal arrangements. I consent to this submission being checked for plagiarism and kept as an assessment record."'::jsonb, '{}'::jsonb,
  'Shown to the student and signed when they submit; its hash is kept with every submission.', '[]'::jsonb);
select public.business_rule_add_setting('assessment.evidence_allowed_types', 'Allowed evidence file types', 'Assessments',
  'lms/assessments', 'assessment', 'list', '["application/pdf", "image/png", "image/jpeg", "image/webp", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "text/plain", "video/mp4", "audio/mpeg", "audio/mp4", "application/zip"]'::jsonb, '{}'::jsonb,
  'The file types (MIME) students and assessors may upload as evidence, one per line, when a question does not name its own.', '[]'::jsonb);
select public.business_rule_add_setting('booking.type_choices', 'Meeting type choices', 'Other',
  'bookings', 'booking', 'json', '{"lengths":[15,20,30,45,60,90,120],"buffers":[0,5,10,15,30,60],"noticeHours":[0,1,2,4,12,24,48],"daysAhead":[7,14,30,60,90]}'::jsonb, '{"keys":["lengths","buffers","noticeHours","daysAhead"]}'::jsonb,
  'The lengths (minutes), gaps (minutes), shortest notice (hours) and booking windows (days) offered when a meeting type is set up.', '[]'::jsonb);
select public.business_rule_add_setting('booking.meeting_types_per_host', 'Meeting types per person', 'Other',
  'bookings', 'booking', 'number', '20'::jsonb, '{"min":1,"max":200}'::jsonb,
  'A person''s booking page can have at most this many meeting types.', '[]'::jsonb);
select public.business_rule_add_setting('booking.availability_rows_max', 'Weekly hours rows per booking page', 'Other',
  'bookings', 'booking', 'number', '42'::jsonb, '{"min":7,"max":200}'::jsonb,
  'A booking page, room or trainer can have at most this many weekly available-time rows.', '[]'::jsonb);
select public.business_rule_add_setting('booking.time_off_rows_max', 'Time-off rows per booking page', 'Other',
  'bookings', 'booking', 'number', '50'::jsonb, '{"min":1,"max":500}'::jsonb,
  'A booking page can have at most this many time-off rows.', '[]'::jsonb);
select public.business_rule_add_setting('booking.guest_bookings_per_hour', 'Bookings by people not signed in, per host per hour', 'Other',
  'bookings', 'booking', 'number', '20'::jsonb, '{"min":1,"max":1000}'::jsonb,
  'A host''s page takes at most this many bookings an hour from people who are not signed in (spam protection); the next one is asked to try later.', '[]'::jsonb);
select public.business_rule_add_setting('booking.slot_lookup_days', 'Days of free times listed', 'Other',
  'bookings', 'booking', 'json', '{"default":31,"max":62}'::jsonb, '{"keys":["default","max"]}'::jsonb,
  'Free booking times are listed for this many days (default) and never more than max days from the day asked for.', '[]'::jsonb);
select public.business_rule_add_setting('booking.history_days', 'Past bookings shown for', 'Other',
  'bookings', 'booking', 'days', '30'::jsonb, '{"min":1,"max":365}'::jsonb,
  'The Bookings page lists past and cancelled bookings from this many days back.', '[]'::jsonb);

-- ----- structural limits replaced by the rules -----
-- Attempt numbers and the institution's maximum attempts: the cap of 10 is now assessment.attempts_allowed_range (checked on publish).
-- The table checks keep attempts within 1 to 10, so the range rule's maximum is at most 10 (checked on publish).

-- ----- functions follow the rules -----
-- Parts of the day follow lms.day_part_cutoffs (rto_slot reads a rule, so it becomes STABLE; no index or constraint uses it).
select public.business_rule_patch_function('public.rto_slot(time)'::regprocedure,
  $o$ IMMUTABLE$o$,
  $n$ STABLE$n$);
select public.business_rule_patch_function('public.rto_slot(time)'::regprocedure,
  $o$p_start < time '12:00'$o$,
  $n$p_start < public.lms_day_part_cutoff('afternoonFrom')$n$);
select public.business_rule_patch_function('public.rto_slot(time)'::regprocedure,
  $o$p_start < time '16:00'$o$,
  $n$p_start < public.lms_day_part_cutoff('eveningFrom')$n$);
-- A class time from a part of the day follows lms.day_part_times.
select public.business_rule_patch_function('public.rto_course_flow(text, jsonb)'::regprocedure,
  $o$case d->>'slot' when 'morning' then time '09:00' when 'afternoon' then time '13:00' else time '17:00' end$o$,
  $n$public.lms_day_part_time(d->>'slot', false)$n$);
select public.business_rule_patch_function('public.rto_course_flow(text, jsonb)'::regprocedure,
  $o$case d->>'slot' when 'morning' then time '13:00' when 'afternoon' then time '17:00' else time '21:00' end$o$,
  $n$public.lms_day_part_time(d->>'slot', true)$n$);
-- Master timetable cycle plan: reminder months, most years ahead.
select public.business_rule_patch_function('public.rto_master_cycles(text, jsonb)'::regprocedure,
  $o$(v_today + interval '12 months')::date$o$,
  $n$(v_today + make_interval(months => public.rule_int('lms.master_plan_alert_months', 12)))::date$n$, 2);
select public.business_rule_patch_function('public.rto_master_cycles(text, jsonb)'::regprocedure,
  $o$v_n > 60 then$o$,
  $n$v_n > 6 * public.rule_int('lms.master_plan_max_years', 10) then$n$);
select public.business_rule_patch_function('public.rto_master_cycles(text, jsonb)'::regprocedure,
  $o$+ interval '10 years')::date then$o$,
  $n$+ make_interval(years => public.rule_int('lms.master_plan_max_years', 10)))::date then$n$);
select public.business_rule_patch_function('public.rto_master_cycles(text, jsonb)'::regprocedure,
  $o$raise exception 'Too many cycles: the calendar can be planned at most 10 years ahead.' using$o$,
  $n$raise exception 'Too many cycles: the calendar can be planned at most % years ahead.', public.rule_int('lms.master_plan_max_years', 10) using$n$);
-- Course locked before its plan ends.
select public.business_rule_patch_function('public.course_master_locked(text)'::regprocedure,
  $o$interval '3 months'$o$,
  $n$make_interval(months => public.rule_int('lms.master_plan_lock_months', 3))$n$);
-- VoE calendar: hours a week and units at the same time.
select public.business_rule_patch_function('public.rto_voe_calendar(text, jsonb)'::regprocedure,
  $o$q <= 0 or q > 40)$o$,
  $n$q <= 0 or q > public.rule_num('lms.voe_weekly_study_hours', 40))$n$);
select public.business_rule_patch_function('public.rto_voe_calendar(text, jsonb)'::regprocedure,
  $o$where x.n > 2 or (v_method = 'manual' and x.hrs > 40) limit 1;$o$,
  $n$where x.n > public.rule_int('lms.voe_max_units_together', 2) or (v_method = 'manual' and x.hrs > public.rule_num('lms.voe_weekly_study_hours', 40)) limit 1;$n$);
select public.business_rule_patch_function('public.rto_voe_calendar(text, jsonb)'::regprocedure,
  $o$'On % the VoE calendar has more than two units or more than 40 hours.', v_bad using$o$,
  $n$'On % the VoE calendar has more than % units or more than % hours.', v_bad, public.rule_int('lms.voe_max_units_together', 2), public.rule_num('lms.voe_weekly_study_hours', 40) using$n$);
-- The default rescheduling rules (no saved set) start from the Business Rules (as a new step on the screen does).
select public.business_rule_patch_function('public.class_reschedule_default_rules()'::regprocedure,
  $o$'earliest', '08:00', 'latest', '21:00'$o$,
  $n$'earliest', public.rule_json('lms.reschedule_new_day_hours', '{"earliest":"08:00","latest":"21:00"}'::jsonb)->>'earliest', 'latest', public.rule_json('lms.reschedule_new_day_hours', '{"earliest":"08:00","latest":"21:00"}'::jsonb)->>'latest'$n$, 8);
select public.business_rule_patch_function('public.class_reschedule_default_rules()'::regprocedure,
  $o$'days', jsonb_build_array(1, 2, 3, 4, 5), 'withinDays', 14$o$,
  $n$'days', public.lms_reschedule_weekdays(), 'withinDays', public.rule_int('lms.reschedule_new_day_search_days', 14)$n$, 4);
select public.business_rule_patch_function('public.class_reschedule_default_rules()'::regprocedure,
  $o$'maxExtraSeats', 6$o$,
  $n$'maxExtraSeats', public.rule_int('lms.reschedule_join_extra_seats', 6)$n$, 2);
select public.business_rule_patch_function('public.class_reschedule_default_rules()'::regprocedure,
  $o$'maxExtraMinutes', 60, 'maxClasses', 4, 'addAt', 'end'$o$,
  $n$'maxExtraMinutes', coalesce((public.rule_json('lms.reschedule_spread_limits', '{"addAt":"end","classes":4,"extraMinutes":60}'::jsonb)->>'extraMinutes')::int, 60), 'maxClasses', coalesce((public.rule_json('lms.reschedule_spread_limits', '{"addAt":"end","classes":4,"extraMinutes":60}'::jsonb)->>'classes')::int, 4), 'addAt', case when public.rule_json('lms.reschedule_spread_limits', '{"addAt":"end","classes":4,"extraMinutes":60}'::jsonb)->>'addAt' = 'start' then 'start' else 'end' end$n$, 2);
-- A saved step without a limit uses the Business Rule, as the screen shows.
select public.business_rule_patch_function('public.class_reschedule_candidates(uuid, text, integer)'::regprocedure,
  $o$coalesce(nullif(st->>'earliest', '')::time, '08:00')$o$,
  $n$coalesce(nullif(st->>'earliest', '')::time, (public.rule_json('lms.reschedule_new_day_hours', '{"earliest":"08:00","latest":"21:00"}'::jsonb)->>'earliest')::time, '08:00')$n$);
select public.business_rule_patch_function('public.class_reschedule_candidates(uuid, text, integer)'::regprocedure,
  $o$coalesce(nullif(st->>'latest', '')::time, '21:00')$o$,
  $n$coalesce(nullif(st->>'latest', '')::time, (public.rule_json('lms.reschedule_new_day_hours', '{"earliest":"08:00","latest":"21:00"}'::jsonb)->>'latest')::time, '21:00')$n$);
select public.business_rule_patch_function('public.class_reschedule_candidates(uuid, text, integer)'::regprocedure,
  $o$s.session_date + coalesce((st->>'withinDays')::int, 14)$o$,
  $n$s.session_date + coalesce((st->>'withinDays')::int, public.rule_int('lms.reschedule_new_day_search_days', 14))$n$);
select public.business_rule_patch_function('public.class_reschedule_candidates(uuid, text, integer)'::regprocedure,
  $o$array[1, 2, 3, 4, 5]$o$,
  $n$(select array_agg(x::int) from jsonb_array_elements_text(public.lms_reschedule_weekdays()) x)$n$);
select public.business_rule_patch_function('public.class_reschedule_candidates(uuid, text, integer)'::regprocedure,
  $o$coalesce((st->>'maxExtraSeats')::int, 6)$o$,
  $n$coalesce((st->>'maxExtraSeats')::int, public.rule_int('lms.reschedule_join_extra_seats', 6))$n$, 2);
select public.business_rule_patch_function('public.class_reschedule_candidates(uuid, text, integer)'::regprocedure,
  $o$coalesce((st->>'maxExtraMinutes')::int, 60)$o$,
  $n$coalesce((st->>'maxExtraMinutes')::int, (public.rule_json('lms.reschedule_spread_limits', '{"addAt":"end","classes":4,"extraMinutes":60}'::jsonb)->>'extraMinutes')::int, 60)$n$, 2);
select public.business_rule_patch_function('public.class_reschedule_candidates(uuid, text, integer)'::regprocedure,
  $o$coalesce((st->>'maxClasses')::int, 4)$o$,
  $n$coalesce((st->>'maxClasses')::int, (public.rule_json('lms.reschedule_spread_limits', '{"addAt":"end","classes":4,"extraMinutes":60}'::jsonb)->>'classes')::int, 4)$n$);
select public.business_rule_patch_function('public.class_reschedule_candidates(uuid, text, integer)'::regprocedure,
  $o$coalesce(st->>'addAt', 'end')$o$,
  $n$coalesce(st->>'addAt', public.rule_json('lms.reschedule_spread_limits', '{"addAt":"end","classes":4,"extraMinutes":60}'::jsonb)->>'addAt', 'end')$n$);
select public.business_rule_patch_function('public.class_reschedule_candidates(uuid, text, integer)'::regprocedure,
  $o$/ v_n / 15) * 15)::int$o$,
  $n$/ v_n / greatest(public.rule_int('lms.reschedule_spread_step_minutes', 15), 1)) * greatest(public.rule_int('lms.reschedule_spread_step_minutes', 15), 1))::int$n$);
-- Attempts: the range rule is the only limit (its maximum is checked on publish, at most 20).
select public.business_rule_patch_function('public.asm_attempts_range()'::regprocedure,
  $o$lo := greatest(1, least(10, lo));$o$,
  $n$lo := greatest(1, lo);$n$);
select public.business_rule_patch_function('public.asm_attempts_range()'::regprocedure,
  $o$hi := greatest(lo, least(10, hi));$o$,
  $n$hi := greatest(lo, hi);$n$);
select public.business_rule_patch_function('public.asm_next_attempt(uuid, uuid, timestamp with time zone, uuid, boolean)'::regprocedure,
  $o$if v_no > 10 then$o$,
  $n$if v_no > (select r.hi from public.asm_attempts_range() r) then$n$);
-- Who may mark, the student declaration and the allowed evidence types are Business Rules written to asm_settings (their screen fields are read-only).
select public.business_rule_patch_function('public.asm_settings_rules_sync()'::regprocedure,
  $o$'assessment.late_submission_default', 'assessment.result_rollup_default']) x(id) loop$o$,
  $n$'assessment.late_submission_default', 'assessment.result_rollup_default', 'assessment.who_may_mark', 'assessment.student_declaration', 'assessment.evidence_allowed_types']) x(id) loop$n$);
select public.business_rule_patch_function('public.asm_settings_rules_sync()'::regprocedure,
  $o$if t in ('assessment.late_submission_default', 'assessment.result_rollup_default') then$o$,
  $n$if t = 'assessment.evidence_allowed_types' then
        if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) = 0 then continue; end if;
      elsif t in ('assessment.late_submission_default', 'assessment.result_rollup_default', 'assessment.who_may_mark', 'assessment.student_declaration') then$n$);
select public.business_rule_patch_function('public.asm_settings_rules_sync()'::regprocedure,
  $o$      elsif t = 'assessment.result_rollup_default' and$o$,
  $n$      elsif t = 'assessment.who_may_mark' then
        update public.asm_settings set require_trainer_role = (v #>> '{}') <> 'Any active intake trainer, named assessors, admins' where require_trainer_role is distinct from ((v #>> '{}') <> 'Any active intake trainer, named assessors, admins');
      elsif t = 'assessment.student_declaration' and btrim(v #>> '{}') <> '' then
        update public.asm_settings set declaration_text = v #>> '{}' where declaration_text is distinct from (v #>> '{}');
      elsif t = 'assessment.evidence_allowed_types' then
        update public.asm_settings set evidence_allowed_types = array(select jsonb_array_elements_text(v)) where evidence_allowed_types is distinct from array(select jsonb_array_elements_text(v));
      elsif t = 'assessment.result_rollup_default' and$n$);
select public.business_rule_patch_function('public.business_rule_versions_asm_settings_sync()'::regprocedure,
  $o$'assessment.attempts_allowed_range')) then$o$,
  $n$'assessment.attempts_allowed_range', 'assessment.who_may_mark', 'assessment.student_declaration', 'assessment.evidence_allowed_types')) then$n$);
-- Settings › Save keeps the rule-backed fields (Business Rules write them); only the instructions are saved there.
select public.business_rule_patch_function('public.asm_admin(text, jsonb)'::regprocedure,
  $o$require_trainer_role = coalesce((d->>'requireTrainerRole')::boolean, require_trainer_role),$o$,
  $n$require_trainer_role = require_trainer_role,$n$);
select public.business_rule_patch_function('public.asm_admin(text, jsonb)'::regprocedure,
  $o$declaration_text = coalesce(public.asm_json_text(d, 'declarationText'), declaration_text), instructions$o$,
  $n$declaration_text = declaration_text, instructions$n$);
select public.business_rule_patch_function('public.asm_admin(text, jsonb)'::regprocedure,
  $o$evidence_max_mb = coalesce((d->>'evidenceMaxMb')::integer, evidence_max_mb),$o$,
  $n$evidence_max_mb = evidence_max_mb,$n$);
select public.business_rule_patch_function('public.asm_admin(text, jsonb)'::regprocedure,
  $o$evidence_allowed_types = case when jsonb_typeof(d->'evidenceAllowedTypes') = 'array' then (select coalesce(array_agg(ta.v), '{}') from jsonb_array_elements_text(d->'evidenceAllowedTypes') as ta(v)) else evidence_allowed_types end,$o$,
  $n$evidence_allowed_types = evidence_allowed_types,$n$);
-- Bookings limits.
select public.business_rule_patch_function('public.booking_type_save(jsonb)'::regprocedure,
  $o$>= 20 then raise exception 'You can have up to 20 meeting types.' using$o$,
  $n$>= public.rule_int('booking.meeting_types_per_host', 20) then raise exception 'You can have up to % meeting types.', public.rule_int('booking.meeting_types_per_host', 20) using$n$);
select public.business_rule_patch_function('public.booking_host_save(jsonb)'::regprocedure,
  $o$if v_n > 42 then$o$,
  $n$if v_n > public.rule_int('booking.availability_rows_max', 42) then$n$);
select public.business_rule_patch_function('public.booking_host_save(jsonb)'::regprocedure,
  $o$if v_n > 50 then$o$,
  $n$if v_n > public.rule_int('booking.time_off_rows_max', 50) then$n$);
select public.business_rule_patch_function('public.booking_create(text, text, timestamp with time zone, text, text, text, text, text)'::regprocedure,
  $o$now() - interval '1 hour') >= 20 then$o$,
  $n$now() - interval '1 hour') >= public.rule_int('booking.guest_bookings_per_hour', 20) then$n$);
select public.business_rule_patch_function('public.booking_slots(text, text, date, integer, text)'::regprocedure,
  $o$least(greatest(coalesce(p_days, 31), 1), 62)$o$,
  $n$least(greatest(coalesce(p_days, (public.rule_json('booking.slot_lookup_days', '{"default":31,"max":62}'::jsonb)->>'default')::integer, 31), 1), coalesce((public.rule_json('booking.slot_lookup_days', '{"default":31,"max":62}'::jsonb)->>'max')::integer, 62))$n$);
select public.business_rule_patch_function('public.booking_me()'::regprocedure,
  $o$b.starts_at > now() - interval '30 days'$o$,
  $n$b.starts_at > now() - make_interval(days => public.rule_int('booking.history_days', 30))$n$, 2);

-- The rule-backed assessment settings now match the published rules (values unchanged today).
select public.asm_settings_rules_sync();

-- Every batch-5 LMS rule exists and is published.
do $$
declare v_missing text;
begin
  select string_agg(x, ', ') into v_missing from unnest(array['lms.day_part_times', 'lms.day_part_cutoffs', 'lms.voe_max_units_together', 'lms.master_plan_max_years', 'lms.master_plan_alert_months', 'lms.master_plan_lock_months', 'lms.reschedule_spread_step_minutes', 'assessment.who_may_mark', 'assessment.student_declaration', 'assessment.evidence_allowed_types', 'booking.type_choices', 'booking.meeting_types_per_host', 'booking.availability_rows_max', 'booking.time_off_rows_max', 'booking.guest_bookings_per_hour', 'booking.slot_lookup_days', 'booking.history_days']) x
  where not exists (select 1 from public.business_rules r join public.business_rule_versions v on v.rule_id = r.id and v.state = 'published'
                    where r.scope_key = '' and r.identifier = x);
  if v_missing is not null then raise exception 'BUSINESS-RULES-LIVE batch 5 (LMS): rules missing: %', v_missing; end if;
end $$;


-- ===== batch5-email =====
-- BATCH5-EMAIL (2026-11-24, owner: "every email to users looks professional"): the queued emails (public.notification_deliveries,
-- html_body made by the trigger notification_delivery_html -> public.email_html_wrap, also used by the offer signing link, the deposit
-- reminder, Payment received and the payment-copy follow-up) get the same branded layout as the Edge Function emails
-- (supabase/functions/_shared/email-html.ts brandedEmailHtml / textEmailHtml): 5 px brand bar, logo header (Website settings logo, https
-- only; else the institution as a wordmark), heading, paragraphs, "- " lists, "Label: value" detail table, "Label: <link>" buttons with the
-- copy-this-link fallback, "Message from ...:" note box, "Kind regards" when the email greets the person, footer with legal name, address,
-- phone, email, website, ABN, RTO, CRICOS and the automated-message line; hidden preheader; dark-mode and phone styles. Words unchanged.
-- The mark <!--email-note--> is where email-sender adds "The CoE is attached as a PDF." (email-sender keeps the earlier mark for old rows:
-- redeploy email-sender BEFORE applying this file, or that sentence is missing from the HTML part until it is redeployed).
-- Support ticket emails keep their own layout; their header and footer use the branding (patched below).
-- Signatures and grants: unchanged (email_html_wrap(uuid, text, text) STABLE SECURITY DEFINER, search_path public).

-- 1. Branding of a tenant (its Website settings row, else the first row), with a button colour white text reads on (WCAG AA 4.5:1).
create or replace function public.email_brand(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  s jsonb; v_color text; v_button text; r numeric; g numeric; b numeric; lum numeric; i integer; v_logo text; v_site text;
  lin numeric[];
begin
  select to_jsonb(c) into s from public.cms_settings c where c.tenant_id is not distinct from p_tenant order by c.id limit 1;
  if s is null then select to_jsonb(c) into s from public.cms_settings c order by c.id limit 1; end if;
  s := coalesce(s, '{}'::jsonb);
  v_color := case when coalesce(s->>'primary_color', '') ~ '^#[0-9A-Fa-f]{6}$' then lower(s->>'primary_color') else '#ea6619' end;
  v_button := v_color;
  for i in 1..20 loop
    r := ('x' || substr(v_button, 2, 2))::bit(8)::integer / 255.0;
    g := ('x' || substr(v_button, 4, 2))::bit(8)::integer / 255.0;
    b := ('x' || substr(v_button, 6, 2))::bit(8)::integer / 255.0;
    lin := array[r, g, b];
    lum := 0;
    for j in 1..3 loop
      lin[j] := case when lin[j] <= 0.03928 then lin[j] / 12.92 else power((lin[j] + 0.055) / 1.055, 2.4) end;
    end loop;
    lum := 0.2126 * lin[1] + 0.7152 * lin[2] + 0.0722 * lin[3];
    exit when 1.05 / (lum + 0.05) >= 4.5;
    v_button := '#' || lpad(to_hex(round(r * 255 * 0.92)::integer), 2, '0') || lpad(to_hex(round(g * 255 * 0.92)::integer), 2, '0') || lpad(to_hex(round(b * 255 * 0.92)::integer), 2, '0');
  end loop;
  v_logo := nullif(btrim(coalesce(s->>'logo', '')), '');
  if v_logo !~ '^https://[^\s"''<>]+$' then v_logo := null; end if;
  v_site := nullif(btrim(coalesce(s->>'website', '')), '');
  if v_site !~ '^https://[^\s"''<>]+$' then v_site := null; end if;
  return jsonb_build_object(
    'name', coalesce(nullif(btrim(public.rule_text('comms.email_institution_name', null)), ''), 'Skyline Institute of Technology'),
    'legal', coalesce(nullif(btrim(s->>'legal_name'), ''), nullif(btrim(s->>'name'), ''), 'Skyline Institute of Technology'),
    'logo', v_logo, 'color', v_color, 'button', v_button,
    'address', nullif(btrim(coalesce(s->>'address', '')), ''), 'phone', nullif(btrim(coalesce(s->>'phone', '')), ''),
    'email', nullif(btrim(coalesce(s->>'email', '')), ''), 'website', v_site,
    'abn', nullif(btrim(coalesce(s->>'abn', '')), ''), 'rto', nullif(btrim(coalesce(s->>'rto', '')), ''), 'cricos', nullif(btrim(coalesce(s->>'cricos', '')), ''));
end $function$;

-- 2. The header row (brand bar + logo / wordmark) and the footer lines, shared by email_html_wrap and the support ticket emails.
create or replace function public.email_brand_header(p_brand jsonb)
returns text
language sql
immutable
as $function$
  select '<tr><td height="5" style="height:5px;line-height:5px;font-size:0;background:' || (p_brand->>'color') || '" bgcolor="' || (p_brand->>'color') || '">&nbsp;</td></tr>'
    || '<tr><td class="em-pad em-head" style="padding:22px 32px 18px;background:#ffffff;border-bottom:1px solid #e5e7eb">'
    || case when p_brand->>'logo' is not null
         then '<img src="' || public.support_html(p_brand->>'logo') || '" alt="' || public.support_html(p_brand->>'name') || '" height="44" style="display:block;height:44px;width:auto;max-width:240px;border:0;outline:none;text-decoration:none">'
         else '<span style="font-size:20px;font-weight:800;letter-spacing:-.01em;color:' || (p_brand->>'button') || '">' || public.support_html(p_brand->>'name') || '</span>' end
    || '</td></tr>'
$function$;

create or replace function public.email_brand_footer(p_brand jsonb)
returns text
language sql
immutable
as $function$
  select '<strong style="color:#374151" class="em-text">' || public.support_html(p_brand->>'legal') || '</strong>'
    || case when p_brand->>'address' is not null then '<br>' || public.support_html(p_brand->>'address') else '' end
    || coalesce('<br>' || nullif(concat_ws(' &nbsp;&middot;&nbsp; ',
         case when p_brand->>'phone' is not null then 'Phone ' || public.support_html(p_brand->>'phone') end,
         case when p_brand->>'email' is not null then '<a href="mailto:' || public.support_html(p_brand->>'email') || '" style="color:#6b7280;text-decoration:underline">' || public.support_html(p_brand->>'email') || '</a>' end,
         case when p_brand->>'website' is not null then '<a href="' || public.support_html(p_brand->>'website') || '" style="color:#6b7280;text-decoration:underline">'
           || public.support_html(regexp_replace(regexp_replace(p_brand->>'website', '^https?://', ''), '/$', '')) || '</a>' end), ''), '')
    || coalesce('<br>' || nullif(concat_ws(' &nbsp;&middot;&nbsp; ',
         case when p_brand->>'abn' is not null then 'ABN ' || public.support_html(p_brand->>'abn') end,
         case when p_brand->>'rto' is not null then 'RTO ' || public.support_html(p_brand->>'rto') end,
         case when p_brand->>'cricos' is not null then 'CRICOS ' || public.support_html(p_brand->>'cricos') end), ''), '')
    || '<br><br><span style="color:#9ca3af">This is an automated message from ' || public.support_html(p_brand->>'name') || '.'
    || case when p_brand->>'email' is not null then ' If you have a question, contact us at ' || public.support_html(p_brand->>'email')
         || case when p_brand->>'phone' is not null then ' or ' || public.support_html(p_brand->>'phone') else '' end || '.' else '' end
    || '</span>'
$function$;

-- 3. The document around a body (the same markup as brandedEmailHtml).
create or replace function public.email_brand_document(p_brand jsonb, p_heading text, p_body_html text, p_preheader text)
returns text
language sql
immutable
as $function$
  select '<!doctype html><html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    || '<meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">'
    || '<meta name="format-detection" content="telephone=no,address=no,email=no,date=no"><title>' || public.support_html(p_heading) || '</title>'
    || '<style>body{margin:0!important;padding:0!important;width:100%!important}a{color:' || (p_brand->>'button') || '}'
    || '@media only screen and (max-width:620px){.em-card{border-radius:0!important}.em-pad{padding-left:20px!important;padding-right:20px!important}.em-outer{padding:0!important}.em-dlabel{width:40%!important}}'
    || '@media (prefers-color-scheme:dark){.em-bg{background:#111827!important}.em-card{background:#1f2937!important;border-color:#374151!important}.em-text{color:#f3f4f6!important}.em-muted{color:#9ca3af!important}'
    || '.em-box{background:#111827!important;border-color:#374151!important}.em-foot{background:#111827!important;color:#9ca3af!important;border-color:#374151!important}.em-head{background:#ffffff!important}}</style>'
    || '<!--[if mso]><style>table,td,p,a,span{font-family:Arial,Helvetica,sans-serif!important}</style><![endif]--></head>'
    || '<body class="em-bg" style="margin:0;padding:0;background:#f1f3f6;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">'
    || '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f1f3f6;opacity:0">'
    || public.support_html(left(regexp_replace(coalesce(p_preheader, ''), '\s+', ' ', 'g'), 140)) || repeat('&nbsp;&zwnj;', 30) || '</div>'
    || '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="em-bg" style="background:#f1f3f6"><tr><td align="center" class="em-outer" style="padding:28px 12px">'
    || '<!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->'
    || '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="em-card" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;border-collapse:separate;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,''Segoe UI'',Roboto,Helvetica,Arial,sans-serif">'
    || public.email_brand_header(p_brand)
    || '<tr><td class="em-pad" style="padding:28px 32px 12px">'
    || '<h1 class="em-text" style="margin:0 0 20px;font-size:22px;line-height:1.3;font-weight:700;color:#111827">' || public.support_html(p_heading) || '</h1>'
    || coalesce(p_body_html, '')
    || '</td></tr>'
    || '<tr><td class="em-pad em-foot em-muted" style="padding:20px 32px 24px;background:#f8fafc;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280">' || public.email_brand_footer(p_brand) || '</td></tr>'
    || '</table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>'
$function$;

-- 4. A plain-text queued email in the layout (same rules as textEmailBlocks in _shared/email-html.ts).
create or replace function public.email_html_wrap(p_tenant uuid, p_subject text, p_body text)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  br jsonb; v_btn text; v_html text := ''; v_paras text[]; v_para text; v_lines text[]; v_line text; v_buf text[]; v_m text[];
  v_greeting boolean := false; v_signed boolean := false; v_last text[]; v_all boolean; v_pre text := ''; v_label text; v_url text; k integer;
  v_p constant text := '<p class="em-text" style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#1f2937">';
  v_names text[];
begin
  br := public.email_brand(p_tenant);
  v_btn := br->>'button';
  v_names := array[lower(br->>'name'), lower(br->>'legal'), 'skyline institute of technology', 'skyline', 'the skyline team', 'this is an automated message.', 'this is an automated message'];
  v_paras := array(select x from unnest(regexp_split_to_array(btrim(replace(coalesce(p_body, ''), E'\r', ''), E' \n\t'), E'\\n[ \\t]*\\n+')) x where btrim(x) <> '');
  -- The plain-text sign-off ("Skyline Institute of Technology" / "This is an automated message.") becomes the signature and footer.
  if coalesce(array_length(v_paras, 1), 0) > 1 then
    v_last := array(select lower(btrim(l)) from unnest(string_to_array(v_paras[array_length(v_paras, 1)], E'\n')) l where btrim(l) <> '');
    if not exists (select 1 from unnest(v_last) l where l <> all (v_names)) then
      v_paras := v_paras[1:array_length(v_paras, 1) - 1]; v_signed := true;
    end if;
  end if;
  v_greeting := coalesce(v_paras[1], '') ~* '^\s*(hello|hi|dear)\M';

  foreach v_para in array coalesce(v_paras, '{}'::text[]) loop
    v_lines := array(select btrim(l) from unnest(string_to_array(v_para, E'\n')) l where btrim(l) <> '');
    if v_pre = '' and not (v_lines[1] ~* '^(hello|hi|dear)\M') then v_pre := array_to_string(v_lines, ' '); end if;
    -- A list: every line a "- " bullet; or a "Heading:" line then bullets.
    select bool_and(l ~ '^[-*•]\s+') into v_all from unnest(v_lines[2:]) l;
    if v_lines[1] ~ '^[-*•]\s+' and coalesce(v_all, true) or (array_length(v_lines, 1) >= 2 and v_lines[1] ~ ':$' and v_lines[1] !~ '^[-*•]\s+' and v_all) then
      if v_lines[1] !~ '^[-*•]\s+' then
        v_html := v_html || v_p || public.support_html(v_lines[1]) || '</p>';
        v_lines := v_lines[2:];
      end if;
      v_html := v_html || '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 16px">';
      foreach v_line in array v_lines loop
        v_html := v_html || '<tr><td valign="top" style="padding:0 10px 6px 2px;font-size:15px;line-height:1.6;color:' || v_btn || '">&#8226;</td><td class="em-text" style="padding:0 0 6px;font-size:15px;line-height:1.6;color:#1f2937">'
          || regexp_replace(public.support_html(regexp_replace(v_line, '^[-*•]\s+', '')), '(https?://[^\s<>"'']+)', '<a href="\1" style="color:' || v_btn || ';word-break:break-all">\1</a>', 'g') || '</td></tr>';
      end loop;
      v_html := v_html || '</table>';
      continue;
    end if;
    -- A detail table: two or more "Label: value" lines, no link.
    select bool_and(l ~ '^[A-Z][A-Za-z0-9 /&().,''-]{0,38}:\s+\S' and l !~* 'https?://') into v_all from unnest(v_lines) l;
    if array_length(v_lines, 1) >= 2 and v_all then
      v_html := v_html || '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="em-box" style="margin:4px 0 20px;border:1px solid #e5e7eb;border-radius:8px;background:#f8fafc;border-collapse:separate">';
      k := 0;
      foreach v_line in array v_lines loop
        v_m := regexp_match(v_line, '^([^:]+):\s+(.*)$');
        v_html := v_html || '<tr><td class="em-muted em-dlabel" valign="top" style="padding:10px 14px;' || case when k > 0 then 'border-top:1px solid #e5e7eb;' else '' end || 'width:36%;font-size:13px;line-height:1.5;color:#6b7280">' || public.support_html(v_m[1]) || '</td>'
          || '<td class="em-text" valign="top" style="padding:10px 14px;' || case when k > 0 then 'border-top:1px solid #e5e7eb;' else '' end || 'font-size:14px;line-height:1.5;color:#1f2937;font-weight:600;word-break:break-word">' || public.support_html(btrim(v_m[2])) || '</td></tr>';
        k := k + 1;
      end loop;
      v_html := v_html || '</table>';
      continue;
    end if;
    -- "Message from admissions:" then free text: a note box.
    if array_length(v_lines, 1) >= 2 and v_lines[1] ~* '^(message from [^:]{1,60}|note|notes|reason given|comments?):$' then
      v_html := v_html || '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:4px 0 20px"><tr><td class="em-box" style="padding:14px 16px;border-left:4px solid ' || v_btn || ';border-radius:6px;background:#f8fafc">'
        || '<p class="em-text" style="margin:0 0 6px;font-size:13px;font-weight:700;line-height:1.4;color:#1f2937">' || public.support_html(regexp_replace(v_lines[1], ':$', '')) || '</p>'
        || '<p class="em-text" style="margin:0;font-size:14px;line-height:1.6;color:#1f2937">'
        || replace(regexp_replace(public.support_html(array_to_string(v_lines[2:], E'\n')), '(https?://[^\s<>"'']+)', '<a href="\1" style="color:' || v_btn || ';word-break:break-all">\1</a>', 'g'), E'\n', '<br>')
        || '</p></td></tr></table>';
      continue;
    end if;
    -- Lines: "Label (note): <link>" and "Label:" + "<link>" become a button; other links are made clickable.
    v_buf := '{}';
    foreach v_line in array v_lines loop
      v_url := null; v_label := null;
      v_m := regexp_match(v_line, '^(.*[.!?]\s+)?([^.!?:]{2,60}?)\s*(\(([^)]{1,60})\))?\s*:\s*(https://[^\s<>"'']+)\s*$');
      if v_m is not null and v_m[2] !~* 'https?://' then
        if nullif(btrim(coalesce(v_m[1], '')), '') is not null then v_buf := v_buf || btrim(v_m[1]); end if;
        v_url := v_m[5]; v_label := initcap(left(btrim(v_m[2]), 1)) || substr(btrim(v_m[2]), 2);
      elsif v_line ~ '^https://[^\s<>"'']+$' then
        v_url := v_line;
        if array_length(v_buf, 1) > 0 and v_buf[array_length(v_buf, 1)] ~ ':$' and length(v_buf[array_length(v_buf, 1)]) <= 35 and v_buf[array_length(v_buf, 1)] !~ '[.!?]\s' then
          v_label := regexp_replace(v_buf[array_length(v_buf, 1)], ':$', '');
          v_buf := v_buf[1:array_length(v_buf, 1) - 1];
        else
          v_label := 'Open link';
        end if;
      end if;
      if v_url is null then v_buf := v_buf || v_line; continue; end if;
      if array_length(v_buf, 1) > 0 then
        v_html := v_html || v_p || regexp_replace(public.support_html(array_to_string(v_buf, E'\n')), '(https?://[^\s<>"'']+)', '<a href="\1" style="color:' || v_btn || ';text-decoration:underline;word-break:break-all">\1</a>', 'g') || '</p>';
        v_buf := '{}';
      end if;
      v_html := v_html || '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 12px"><tr><td align="center" bgcolor="' || v_btn || '" style="border-radius:8px;background:' || v_btn || '">'
        || '<a href="' || public.support_html(v_url) || '" target="_blank" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:8px">' || public.support_html(v_label) || '</a></td></tr></table>'
        || case when v_m is not null and v_m[4] is not null then '<p class="em-muted" style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#6b7280">' || public.support_html(initcap(left(v_m[4], 1)) || substr(v_m[4], 2)) || '</p>' else '' end
        || '<p class="em-muted" style="margin:0 0 20px;font-size:12px;line-height:1.5;color:#6b7280;word-break:break-all">If the button does not work, copy this link into your browser:<br><a href="' || public.support_html(v_url) || '" style="color:' || v_btn || ';word-break:break-all">' || public.support_html(v_url) || '</a></p>';
    end loop;
    if array_length(v_buf, 1) > 0 then
      v_html := v_html || v_p || replace(regexp_replace(public.support_html(array_to_string(v_buf, E'\n')), '(https?://[^\s<>"'']+)', '<a href="\1" style="color:' || v_btn || ';text-decoration:underline;word-break:break-all">\1</a>', 'g'), E'\n', '<br>') || '</p>';
    end if;
  end loop;

  v_html := v_html || '<!--email-note-->'
    || case when v_greeting or v_signed then '<p class="em-text" style="margin:8px 0 0;font-size:15px;line-height:1.6;color:#1f2937">Kind regards,<br><strong>' || public.support_html(br->>'name') || '</strong></p>' else '' end;
  return public.email_brand_document(br, coalesce(nullif(btrim(p_subject), ''), br->>'name'), v_html, v_pre);
end $function$;

-- 5. Support ticket emails: the branded header (logo) and footer (legal name, address, contact, RTO / CRICOS) in their own layout.
select public.business_rule_patch_function('public.support_ticket_email_after_message()'::regprocedure,
$o$      || '<tr><td style="background:#ea6619;padding:18px 24px;color:#ffffff;font-size:18px;font-weight:700;">Skyline Institute of Technology<div style="font-size:13px;font-weight:400;opacity:.9;margin-top:2px;">Support ticket update</div></td></tr>'$o$,
$n$      || public.email_brand_header(public.email_brand(t.tenant_id))
      || '<tr><td style="padding:16px 24px 0;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:' || (public.email_brand(t.tenant_id)->>'button') || ';">Support ticket update</td></tr>'$n$, 1);
select public.business_rule_patch_function('public.support_ticket_email_after_message()'::regprocedure,
$o$      || '<br>Skyline Institute of Technology &middot; RTO 45989 &middot; CRICOS 04114B</td></tr>'$o$,
$n$      || '<br><br>' || public.email_brand_footer(public.email_brand(t.tenant_id)) || '</td></tr>'$n$, 1);

-- ===== batch5-tz =====
-- ===== TIME ZONE (batch 5): the institution time zone is ONE Business Rule, general.time_zone (owner: Melbourne everywhere) =====
-- Every database function that named Australia/Melbourne or Australia/Sydney reads it through public.institution_tz().
-- The Business Rules engine itself (business_rule_evaluate / _add_setting / business_rules_admin) cannot call rule_text
-- (rule_text -> business_rule_evaluate -> ...), so it reads the published value directly through public.institution_tz_raw().
-- Sydney readers (support ticket mail, student document link mail, submitted-application PDF via cms_settings.timezone,
-- default 'Australia/Sydney') now follow the rule too: an intended fix (Melbourne everywhere).
-- Functions are hosted bodies patched by exact snippet (business_rule_patch_function); none of them is IMMUTABLE or used by an
-- index, constraint, generated column or default (checked in pg_depend), so no volatility change is needed.

-- Published value of general.time_zone read straight from the rule tables (no business_rule_evaluate). The rule's own start
-- date is read in Melbourne time (Australian zones differ by a few hours at most). An invalid or missing value -> Melbourne.
create or replace function public.institution_tz_raw() returns text
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  select v2.definition->>'value' into v from public.business_rules r
    join public.business_rule_versions v2 on v2.rule_id = r.id
   where r.scope_key = '' and r.identifier = 'general.time_zone' and v2.state = 'published'
     and coalesce((v2.definition->>'enabled')::boolean, true)
     and v2.starts_on <= (statement_timestamp() at time zone 'Australia/Melbourne')::date
     and (v2.ends_on is null or v2.ends_on >= (statement_timestamp() at time zone 'Australia/Melbourne')::date)
   order by v2.starts_on desc, v2.version desc limit 1;
  if v is null or btrim(v) = '' then return 'Australia/Melbourne'; end if;
  begin perform statement_timestamp() at time zone v; exception when others then return 'Australia/Melbourne'; end;
  return v;
exception when others then
  return 'Australia/Melbourne';
end $$;
revoke all on function public.institution_tz_raw() from public, anon, authenticated, service_role;

-- The institution time zone for everything else (tenant-scoped like every rule; Melbourne when missing or invalid).
-- Callers write (select public.institution_tz()) so a query evaluates it once, not per row.
create or replace function public.institution_tz() returns text
language plpgsql stable security definer set search_path = '' as $$
declare v text := public.rule_text('general.time_zone', 'Australia/Melbourne');
begin
  begin perform statement_timestamp() at time zone v; exception when others then v := 'Australia/Melbourne'; end;
  return v;
end $$;
revoke all on function public.institution_tz() from public;
grant execute on function public.institution_tz() to anon, authenticated, service_role;

-- The rule.
select public.business_rule_add_setting('general.time_zone', 'Institution time zone', 'Other',
  'institution', 'time zone', 'dropdown', '"Australia/Melbourne"'::jsonb,
  '{"allowed":["Australia/Melbourne","Australia/Sydney","Australia/Brisbane","Australia/Adelaide","Australia/Darwin","Australia/Perth","Australia/Hobart","Australia/Canberra"]}'::jsonb,
  'The time zone of the institution: "today", due dates, signing dates, timesheets, letters, emails and PDFs all use it (daylight saving follows the zone).',
  '["Australia/Melbourne","Australia/Sydney","Australia/Brisbane","Australia/Adelaide","Australia/Darwin","Australia/Perth","Australia/Hobart","Australia/Canberra"]'::jsonb);

-- A saved value must be a real time zone (on top of the registration's allowed list); published values are copied into the
-- old settings columns (hr.settings.timezone, cms_settings.timezone), which nothing reads any more but screens may show.
create or replace function public.business_rule_versions_time_zone_check() returns trigger
language plpgsql set search_path = '' as $$
declare v jsonb := new.definition->'value';
begin
  if new.definition->>'identifier' = 'general.time_zone' then
    if jsonb_typeof(v) is distinct from 'string' or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v #>> '{}') then
      raise exception 'Choose a time zone from the list (for example Australia/Melbourne).' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create or replace trigger business_rule_versions_time_zone_check before insert or update on public.business_rule_versions
  for each row execute function public.business_rule_versions_time_zone_check();

create or replace function public.business_rule_versions_time_zone_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare z text;
begin
  if new.definition->>'identifier' = 'general.time_zone' and new.state = 'published' then
    z := public.institution_tz_raw();
    update hr.settings set timezone = z where timezone is distinct from z;
    update public.cms_settings set timezone = z where timezone is distinct from z;
  end if;
  return null;
exception when others then
  raise warning 'Institution time zone could not be copied to the settings: %', sqlerrm;
  return null;
end $$;
create or replace trigger business_rule_versions_time_zone_sync after insert or update on public.business_rule_versions
  for each row execute function public.business_rule_versions_time_zone_sync();

update hr.settings set timezone = public.institution_tz_raw() where timezone is distinct from public.institution_tz_raw();
update public.cms_settings set timezone = public.institution_tz_raw() where timezone is distinct from public.institution_tz_raw();

-- Column defaults.
alter table hr.settings alter column timezone set default public.institution_tz();
alter table public.cms_settings alter column timezone set default public.institution_tz();
alter table public.booking_hosts alter column timezone set default public.institution_tz();
alter table public.bookings alter column booker_timezone set default public.institution_tz();

-- ----- Business Rules engine (raw read, no recursion) -----
select public.business_rule_patch_function('public.business_rule_evaluate(text,text,jsonb)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$public.institution_tz_raw()$n$, 1);
select public.business_rule_patch_function('public.business_rule_add_setting(text,text,text,text,text,text,jsonb,jsonb,text,jsonb,boolean)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$public.institution_tz_raw()$n$, 1);
select public.business_rule_patch_function('public.business_rules_admin(text,jsonb)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$public.institution_tz_raw()$n$, 1);

-- ----- every other function: the rule -----
select public.business_rule_patch_function('public.admin_today()'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 2);
select public.business_rule_patch_function('public.agency_onboarding_presend_send(uuid,uuid,jsonb)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 2);
select public.business_rule_patch_function('public.application_letter_values(uuid)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 2);
select public.business_rule_patch_function('public.asm_admin(text,jsonb)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 6);
select public.business_rule_patch_function('public.asm_batch_enrolment_change()'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('public.asm_calendar(date,date,uuid)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 3);
select public.business_rule_patch_function('public.asm_due_sweep()'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 2);
select public.business_rule_patch_function('public.asm_student(text,jsonb)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 3);
select public.business_rule_patch_function('public.asm_trainer(text,jsonb)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 2);
select public.business_rule_patch_function('public.course_completion_number(text)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('public.course_intake_today()'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('hr.sign_auto_value(uuid,text,text,text)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('hr.sign_subject(text,uuid)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('hr.template_values(uuid)'::regprocedure, $o$coalesce((select s.timezone from hr.settings s limit 1), 'Australia/Melbourne')$o$, $n$(select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('hr.tz()'::regprocedure, $o$coalesce((select s.timezone from hr.settings s where s.id), 'Australia/Melbourne')$o$, $n$(select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('hr.settings_json()'::regprocedure, $o$'timezone', s.timezone$o$, $n$'timezone', (select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('public.hr_admin_settings_save(jsonb)'::regprocedure, $o$timezone = coalesce(v_tz, timezone),$o$, $n$timezone = (select public.institution_tz()),$n$, 1);
select public.business_rule_patch_function('lms_allocation_private.plan_student(uuid,uuid)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('public.notification_delivery_offer_signing(uuid,uuid,integer,boolean,text)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('public.notification_delivery_submission(uuid,uuid)'::regprocedure, $o$'timezone', v_site->>'timezone'$o$, $n$'timezone', (select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('public.offer_letter_payment_copy_source(uuid)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('public.portal_send_guest_link_email(uuid,text,text,text)'::regprocedure, $o$coalesce((select s.timezone from public.cms_settings s where s.tenant_id is not distinct from a.tenant_id limit 1), 'Australia/Sydney')$o$, $n$(select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('public.rto_lms_place_student()'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('public.rto_unit_outcome(uuid,text)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('public.signing_service(text,text,uuid,jsonb)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 1);
select public.business_rule_patch_function('public.student_practice(text,jsonb)'::regprocedure, $o$'Australia/Melbourne'$o$, $n$(select public.institution_tz())$n$, 2);
select public.business_rule_patch_function('public.support_ticket_email_after_message()'::regprocedure, $o$coalesce((select s.timezone from public.cms_settings s where s.tenant_id is not distinct from t.tenant_id limit 1), 'Australia/Sydney')$o$, $n$(select public.institution_tz())$n$, 1);

-- Check: no function outside the two helpers (and their check trigger) still names an Australian zone.
do $$
declare n integer;
begin
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname not in ('pg_catalog', 'information_schema') and s.nspname not like 'pg\_%'
     and p.prosrc ~ 'Australia/(Melbourne|Sydney)'
     and p.oid not in ('public.institution_tz_raw()'::regprocedure, 'public.institution_tz()'::regprocedure,
                       'public.business_rule_versions_time_zone_check()'::regprocedure);
  if n > 0 then raise exception 'TIME ZONE: % function(s) still name an Australian time zone.', n; end if;
end $$;

commit;
