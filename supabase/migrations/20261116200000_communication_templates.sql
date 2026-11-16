-- COMM-TPL: Communication Hub message templates. One template = an email subject + one plain-text body with {{variables}}; the same body
-- is used for email, SMS and WhatsApp (channels says where it may be used). Admin-only (cms_is_admin), like the hub itself. Seeds one
-- template for every message the system sends today (67); seeded templates can be edited or archived but not deleted, and their key is
-- fixed. Templates here do not change any automatic message yet: wiring a sender to a template is a separate step. Additive.
-- Rollback (manual): drop table public.communication_templates; drop function public.communication_templates_touch().
begin;

create table public.communication_templates(
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z][a-z0-9_]{1,59}$'),
  name text not null check (length(btrim(name)) between 1 and 120),
  category text not null check (category in ('Admissions', 'Offer & CoE', 'Documents', 'Accounts & access', 'Staff & HR', 'Signing', 'Support', 'Bookings', 'Assessments', 'General')),
  audience text not null default '' check (length(audience) <= 80),
  description text not null default '' check (length(description) <= 300),
  subject text not null default '' check (length(subject) <= 200),
  body text not null check (length(btrim(body)) between 1 and 4000),
  channels text[] not null default array['email', 'sms', 'whatsapp'] check (cardinality(channels) between 1 and 3 and channels <@ array['email', 'sms', 'whatsapp']),
  status text not null default 'active' check (status in ('active', 'archived')),
  is_system boolean not null default false,
  created_by uuid default auth.uid(),
  updated_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index communication_templates_category on public.communication_templates(category, lower(name));

create function public.communication_templates_touch() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if old.is_system and (new.key is distinct from old.key or not new.is_system) then
      raise exception 'A built-in template keeps its key' using errcode = '22023';
    end if;
    new.created_by := old.created_by; new.created_at := old.created_at;
  elsif new.is_system and auth.uid() is not null then
    raise exception 'Only the system adds built-in templates' using errcode = '42501';
  end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end;
$$;
create trigger communication_templates_touch before insert or update on public.communication_templates
  for each row execute function public.communication_templates_touch();

alter table public.communication_templates enable row level security;
revoke all on public.communication_templates from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.communication_templates to authenticated;
grant select on public.communication_templates to service_role;
create policy communication_templates_admin_read on public.communication_templates for select to authenticated using (public.cms_is_admin());
create policy communication_templates_admin_insert on public.communication_templates for insert to authenticated with check (public.cms_is_admin());
create policy communication_templates_admin_update on public.communication_templates for update to authenticated using (public.cms_is_admin()) with check (public.cms_is_admin());
create policy communication_templates_admin_delete on public.communication_templates for delete to authenticated using (public.cms_is_admin() and not is_system);
revoke all on function public.communication_templates_touch() from public, anon, authenticated;

insert into public.communication_templates(key, name, category, audience, description, subject, body, is_system) values
  ('application_submitted', 'Application submitted', 'Admissions', 'Agent', 'An application moves from draft to submitted.', 'Application {{reference}} was submitted', 'Hi {{first_name}},

Application {{reference}} for {{student_name}} has been submitted to {{institution}}. We will let you know as soon as it is reviewed.

Open the application: {{link}}', true),
  ('application_status_changed', 'Application status changed', 'Admissions', 'Agent', 'Any other change to an application''s status.', 'Application {{reference}} is now {{status}}', 'Hi {{first_name}},

Application {{reference}} for {{student_name}} has moved from {{previous_status}} to *{{status}}*.

Open the application: {{link}}', true),
  ('action_required_reminder', 'Action required reminder', 'Admissions', 'Agent or student', 'Staff send a reminder on an application that needs action.', 'Reminder: application {{reference}} needs action', 'Hi {{first_name}},

Application {{reference}} for {{student_name}} needs your action before {{institution}} can continue.

{{message}}

Open the application: {{link}}', true),
  ('application_received_student', 'Application received (student)', 'Admissions', 'Student', 'Confirmation to the student that their application was received.', 'We received your application {{reference}}', 'Hi {{first_name}},

Thank you for applying to {{institution}} for {{course_name}}. Your application reference is {{reference}}. We will be in touch soon.', true),
  ('application_more_information', 'More information needed', 'Admissions', 'Student or agent', 'Admissions need more information to assess the application.', 'More information needed for application {{reference}}', 'Hi {{first_name}},

To continue assessing application {{reference}} we need a little more information:

{{message}}

Please reply or update the application here: {{link}}', true),
  ('application_withdrawn', 'Application withdrawn', 'Admissions', 'Student or agent', 'An application is withdrawn.', 'Application {{reference}} was withdrawn', 'Hi {{first_name}},

Application {{reference}} for {{student_name}} has been withdrawn. If this was not expected, please contact us.', true),
  ('application_rejected', 'Application unsuccessful', 'Admissions', 'Student or agent', 'An application is not accepted.', 'Update on application {{reference}}', 'Hi {{first_name}},

Thank you for applying to {{institution}}. Unfortunately application {{reference}} for {{course_name}} was not successful this time.

{{message}}

You are welcome to contact us to discuss other options.', true),
  ('offer_letter_issued_student', 'Offer letter issued (student)', 'Offer & CoE', 'Student', 'The student''s offer letter is issued or re-sent.', 'Offer letter for application {{reference}}', 'Hi {{first_name}},

Congratulations! {{institution}} has issued your offer for {{course_name}} (application {{reference}}).

{{message}}

Review and sign your offer (no sign-in needed): {{link}}', true),
  ('offer_letter_issued_agent', 'Offer letter issued (agent)', 'Offer & CoE', 'Agent', 'The agent''s copy when an offer is issued.', 'Offer letter for application {{reference}}', 'Hi {{first_name}},

An offer for {{student_name}} ({{course_name}}, application {{reference}}) has been issued by {{institution}}.

View the offer in the agency portal: {{link}}', true),
  ('offer_accepted', 'Offer accepted', 'Offer & CoE', 'Agent and admissions', 'The offer is accepted, manually or by e-signature.', 'Offer accepted for application {{reference}}', 'Hi {{first_name}},

{{student_name}} has accepted the offer for application {{reference}} at {{institution}}.

Open the application: {{link}}', true),
  ('coe_voe_issued', 'CoE / VoE issued', 'Offer & CoE', 'Student and agent', 'The CoE or VoE is approved and issued.', 'CoE / VoE issued for application {{reference}}', 'Hi {{first_name}},

The CoE / VoE for application {{reference}} ({{course_name}}) has been issued by {{institution}}. It is attached to the email copy of this message.

Open the application: {{link}}', true),
  ('payment_reminder', 'Payment reminder', 'Offer & CoE', 'Student', 'Reminder of a fee payment that is due.', 'Payment reminder for application {{reference}}', 'Hi {{first_name}},

This is a reminder that a payment for {{course_name}} (application {{reference}}) is due by {{due_date}}.

Pay or view details here: {{link}}', true),
  ('orientation_welcome', 'Welcome and orientation', 'Offer & CoE', 'Student', 'Welcome message before the course starts.', 'Welcome to {{institution}}', 'Hi {{first_name}},

Welcome to {{institution}}! Your course {{course_name}} starts on {{intake_date}}.

Orientation: {{date_time}} at {{location}}.

{{message}}', true),
  ('student_document_link', 'Document upload link (student)', 'Documents', 'Student', 'Agent or staff send the student a link to upload documents.', 'Please upload your documents for {{institution}}', 'Hi {{first_name}},

{{agent_name}} has asked you to upload your documents for your application to {{institution}}.

Upload them here (no sign-in needed): {{link}}

The link works until {{expiry_date}}.', true),
  ('student_documents_submitted', 'Student finished uploading', 'Documents', 'Agent', 'The student finishes adding documents through the link.', 'Student finished adding documents for {{reference}}', 'Hi {{first_name}},

{{student_name}} has finished adding documents for application {{reference}}.

Review them here: {{link}}', true),
  ('document_reupload_request', 'Document needs to be uploaded again', 'Documents', 'Student or agent', 'A document is rejected and must be uploaded again.', 'Please upload a document again for {{reference}}', 'Hi {{first_name}},

We could not accept the following document(s) for application {{reference}}:

{{documents_list}}

Please upload a new copy here: {{link}}', true),
  ('document_expiring', 'Document expiring soon', 'Documents', 'Student', 'A document on file (e.g. passport or visa) is about to expire.', 'Your {{document_title}} expires soon', 'Hi {{first_name}},

Our records show your {{document_title}} expires on {{expiry_date}}. Please upload the renewed document here: {{link}}', true),
  ('portal_activation', 'Portal access invitation', 'Accounts & access', 'Agent or student', 'A portal user is invited to activate their access.', 'Activate your {{institution}} portal access', 'Hi {{first_name}},

You have been invited to the {{institution}} portal as {{role}} for {{agency_name}}.

Activate your access: {{link}}

The link works until {{expiry_date}}.', true),
  ('portal_sign_in_code', 'Sign-in code', 'Accounts & access', 'Anyone', 'A one-time code to sign in or verify.', 'Your sign-in code', 'Your {{institution}} sign-in code is {{code}}. It expires in 10 minutes. Do not share this code with anyone.', true),
  ('password_reset', 'Password reset', 'Accounts & access', 'Anyone', 'A password reset link.', 'Reset your password', 'Hi {{first_name}},

We received a request to reset your password. Reset it here: {{link}}

If you did not ask for this, you can ignore this message.', true),
  ('student_email_account', 'Student email account created', 'Accounts & access', 'Student', 'The student''s Microsoft 365 account is created.', 'Your student email account', 'Hi {{first_name}},

Your {{institution}} student email account is ready: {{email}}

Sign in at https://office.com with the temporary password we gave you, then choose a new one.', true),
  ('agent_application_approved', 'Agent account approved', 'Accounts & access', 'Agent', 'A self-registered agent is approved.', 'Your agent account is approved', 'Hi {{first_name}},

Good news: your agent account with {{institution}} for {{agency_name}} is approved.

Sign in here: {{link}}', true),
  ('hr_application_received', 'Job application received', 'Staff & HR', 'Applicant', 'A staff or job application is submitted.', 'We received your application: {{position}}', 'Hi {{first_name}},

Thank you for applying for {{position}} at {{institution}}. We have received your application and will be in touch.', true),
  ('hr_already_applied', 'Already applied', 'Staff & HR', 'Applicant', 'The same email applies again.', 'We already have your staff application', 'Hi {{first_name}},

We already have your application on file, so there is no need to apply again. We will be in touch.', true),
  ('hr_admin_new_application', 'New job application (HR)', 'Staff & HR', 'HR admin', 'Tells HR about a new application.', 'New job application ({{position}}): {{full_name}}', 'A new application for {{position}} was received from {{full_name}} ({{email}}).

Review it: {{link}}', true),
  ('hr_admin_documents_submitted', 'Applicant uploaded documents (HR)', 'Staff & HR', 'HR admin', 'An applicant submits details or documents.', '{{full_name}} has uploaded documents', '{{full_name}} ({{email}}) has submitted their details and documents.

Review them: {{link}}', true),
  ('hr_application_unsuccessful', 'Job application unsuccessful', 'Staff & HR', 'Applicant', 'An application is rejected with notification on.', 'Your staff application', 'Hi {{first_name}},

Thank you for your interest in {{position}} at {{institution}}. We will not be progressing your application at this time. We wish you all the best.', true),
  ('hr_offer_link', 'Job offer to sign', 'Staff & HR', 'Applicant', 'HR send the offer of employment to sign.', 'Your offer letter from {{institution}}', 'Hi {{first_name}},

We are delighted to offer you the position of {{position}} at {{institution}}.

Review and sign your offer: {{link}}

The link works until {{expiry_date}}.', true),
  ('hr_offer_signed_applicant', 'Signed offer copy', 'Staff & HR', 'Applicant', 'The applicant''s copy after signing the offer.', 'Your signed offer letter', 'Hi {{first_name}},

Thank you for signing your offer. A copy of the signed letter is attached to the email version of this message.', true),
  ('hr_offer_signed_admin', 'Offer signed (HR)', 'Staff & HR', 'HR admin', 'Tells HR an applicant signed the offer.', '{{full_name}} signed the offer', '{{full_name}} ({{email}}) has signed the offer for {{position}}.

Open the record: {{link}}', true),
  ('hr_document_request', 'Details and documents request', 'Staff & HR', 'Applicant', 'HR ask the applicant for details and documents.', 'Next step: your details and documents', 'Hi {{first_name}},

The next step is to add your details and documents. Use your private link: {{link}}

The link works until {{expiry_date}}.', true),
  ('hr_document_reupload', 'Staff document re-upload', 'Staff & HR', 'Applicant', 'HR reject a document and ask for it again.', 'Please upload a document again', 'Hi {{first_name}},

Please upload these documents again:

{{documents_list}}

Use your private link: {{link}} (works until {{expiry_date}}).', true),
  ('hr_access_ready', 'Staff access ready', 'Staff & HR', 'Staff', 'A new staff member is given access.', 'Your {{institution}} staff access is ready', 'Hi {{first_name}},

Your staff access is ready. Role: {{role}}. Sign in with {{email}} here: {{link}}', true),
  ('hr_login_link', 'Staff sign-in link', 'Staff & HR', 'Staff', 'HR send a new staff sign-in link.', 'Your {{institution}} staff sign-in', 'Hi {{first_name}},

Here is your sign-in link: {{link}}

It works until {{expiry_date}}.', true),
  ('sign_invite', 'Please sign', 'Signing', 'Signer', 'A signing request is sent or its link re-issued.', 'Please sign: {{document_title}}', 'Hi {{first_name}},

{{institution}} has sent you {{document_title}} to sign.

{{message}}

Sign here: {{link}}

The link works until {{expiry_date}}.', true),
  ('sign_reminder', 'Reminder to sign', 'Signing', 'Signer', 'Repeats until signed or expired.', 'Reminder to sign: {{document_title}}', 'Hi {{first_name}},

A reminder that {{document_title}} is waiting for your signature.

Sign here: {{link}} (works until {{expiry_date}}).', true),
  ('sign_code', 'Signing code', 'Signing', 'Signer', 'A 6-digit code before signing.', 'Your signing code', 'Your code to sign {{document_title}} is {{code}}. It expires in 10 minutes.', true),
  ('sign_completed_recipient', 'Signed copy', 'Signing', 'Signer', 'Everyone has signed; each signer gets a copy.', 'Signed copy: {{document_title}}', 'Hi {{first_name}},

{{document_title}} has been signed by everyone. The signed copy is attached to the email version of this message.', true),
  ('sign_completed_admin', 'Signing completed (sender)', 'Signing', 'Staff', 'Tells the sender all signatures are in.', 'Completed: {{document_title}}', '{{document_title}} has been signed by everyone.

Open it: {{link}}', true),
  ('sign_declined_admin', 'Signing declined (sender)', 'Signing', 'Staff', 'A signer declines.', 'Declined: {{document_title}}', '{{full_name}} declined to sign {{document_title}}.

Reason: {{reason}}

Open it: {{link}}', true),
  ('sign_cancelled', 'Signing cancelled', 'Signing', 'Signer', 'The request is cancelled, declined by someone else, or withdrawn.', 'Signing request cancelled: {{document_title}}', 'Hi {{first_name}},

The request to sign {{document_title}} has been cancelled. You do not need to do anything.', true),
  ('sign_expired', 'Signing link expired', 'Signing', 'Signer or staff', 'The request expires.', 'Signing link expired: {{document_title}}', 'Hi {{first_name}},

The link to sign {{document_title}} has expired. Contact us if you still need to sign it.', true),
  ('sign_link_requested', 'New signing link requested', 'Signing', 'Staff', 'A signer asks for a new link.', 'New signing link requested: {{document_title}}', '{{full_name}} asked for a new link to sign {{document_title}}.

Open it: {{link}}', true),
  ('support_ticket_created', 'Ticket received', 'Support', 'Requester', 'Confirmation that a support ticket was received.', '[{{ticket_ref}}] We received your request: {{ticket_subject}}', 'Hi {{first_name}},

Thanks for contacting us. Your ticket {{ticket_ref}} ({{ticket_subject}}) has been received and our team will reply soon.

View it: {{link}}', true),
  ('support_ticket_reply', 'New reply on ticket', 'Support', 'Requester and staff', 'A reply is added to a ticket.', '[{{ticket_ref}}] New reply: {{ticket_subject}}', 'Hi {{first_name}},

There is a new reply on ticket {{ticket_ref}} ({{ticket_subject}}):

{{message}}

View and reply: {{link}}', true),
  ('support_ticket_note', 'Internal note on ticket', 'Support', 'Staff', 'Staff-only internal note.', '[{{ticket_ref}}] Internal note: {{ticket_subject}}', 'An internal note was added to ticket {{ticket_ref}} ({{ticket_subject}}):

{{message}}

Open it: {{link}}', true),
  ('support_ticket_status', 'Ticket status changed', 'Support', 'Requester and staff', 'A ticket''s status changes.', '[{{ticket_ref}}] Status changed to {{status}}: {{ticket_subject}}', 'Hi {{first_name}},

Ticket {{ticket_ref}} ({{ticket_subject}}) is now *{{status}}*.

View it: {{link}}', true),
  ('booking_confirmed', 'Booking confirmed', 'Bookings', 'Booker', 'A booking is made.', 'Confirmed: {{booking_type}} with {{host_name}}', 'Hi {{first_name}},

Your {{booking_type}} with {{host_name}} is confirmed.

When: {{date_time}}
Where: {{location}}

Reschedule or cancel: {{link}}', true),
  ('booking_new_host', 'New booking (host)', 'Bookings', 'Staff host', 'Tells the host about a new booking.', 'New booking: {{booking_type}} with {{booker_name}}', '{{booker_name}} ({{email}}) booked {{booking_type}}.

When: {{date_time}}
Where: {{location}}', true),
  ('booking_rescheduled', 'Booking rescheduled', 'Bookings', 'Booker and host', 'A booking moves to a new time.', 'New time: {{booking_type}} with {{host_name}}', 'Hi {{first_name}},

Your {{booking_type}} with {{host_name}} has a new time.

When: {{date_time}}
Where: {{location}}

Manage it: {{link}}', true),
  ('booking_cancelled', 'Booking cancelled', 'Bookings', 'Booker and host', 'A booking is cancelled by either side.', 'Cancelled: {{booking_type}} with {{host_name}}', 'Hi {{first_name}},

Your {{booking_type}} on {{date_time}} has been cancelled.

{{reason}}

Book a new time: {{link}}', true),
  ('booking_reminder', 'Booking reminder', 'Bookings', 'Booker and host', '24 hours before the booking.', 'Reminder: {{booking_type}} with {{host_name}}', 'Hi {{first_name}},

A reminder of your {{booking_type}} with {{host_name}} tomorrow.

When: {{date_time}}
Where: {{location}}', true),
  ('assessment_published', 'New assessment', 'Assessments', 'Student', 'An assessment is published to the student''s batch.', 'New assessment: {{assessment_title}}', 'Hi {{first_name}},

A new assessment is available: {{assessment_title}}. It is due on {{due_date}}.

Open it: {{link}}', true),
  ('assessment_assigned_trainer', 'Assessment assigned (trainer)', 'Assessments', 'Trainer', 'An assessment is published to a trainer''s batch.', 'Assessment assigned to your batch: {{assessment_title}}', 'Hi {{first_name}},

{{assessment_title}} has been published to your batch. It is due on {{due_date}}.

Open it: {{link}}', true),
  ('assessment_due_soon', 'Assessment due soon', 'Assessments', 'Student', 'Reminder before the due date.', 'Due soon: {{assessment_title}}', 'Hi {{first_name}},

{{assessment_title}} is due on {{due_date}}. Submit it here: {{link}}', true),
  ('assessment_overdue', 'Assessment overdue', 'Assessments', 'Student', 'The due date has passed.', 'Overdue: {{assessment_title}}', 'Hi {{first_name}},

{{assessment_title}} was due on {{due_date}} and has not been submitted. Please submit it as soon as possible or contact your trainer: {{link}}', true),
  ('assessment_due_date_changed', 'Assessment due date changed', 'Assessments', 'Student', 'The due date is extended or changed.', 'Your due date changed: {{assessment_title}}', 'Hi {{first_name}},

The due date for {{assessment_title}} is now {{due_date}}.', true),
  ('assessment_submission_receipt', 'Submission received', 'Assessments', 'Student', 'Receipt after the student submits.', 'Submission received: {{assessment_title}}', 'Hi {{first_name}},

We received your submission for {{assessment_title}} on {{date_time}}. Your trainer will mark it soon.', true),
  ('assessment_submitted_trainer', 'Student submitted (trainer)', 'Assessments', 'Trainer', 'Tells trainers about a new submission.', 'Submission received: {{assessment_title}}', '{{student_name}} submitted {{assessment_title}} on {{date_time}}.

Mark it: {{link}}', true),
  ('assessment_marked', 'Assessment marked', 'Assessments', 'Student', 'The assessment is marked.', 'Assessment marked: {{outcome}}', 'Hi {{first_name}},

{{assessment_title}} has been marked: *{{outcome}}*.

{{feedback}}

View the details: {{link}}', true),
  ('assessment_resubmission', 'Resubmission required', 'Assessments', 'Student', 'Not yet satisfactory with another attempt, or reopened.', 'Reassessment required: {{assessment_title}}', 'Hi {{first_name}},

{{assessment_title}} needs to be resubmitted by {{due_date}}.

{{feedback}}

Open it: {{link}}', true),
  ('assessment_reassessment_decision', 'Reassessment request decision', 'Assessments', 'Student', 'A reassessment request is approved or declined.', 'Reassessment request: {{assessment_title}}', 'Hi {{first_name}},

Your reassessment request for {{assessment_title}} has been {{status}}.

{{reason}}', true),
  ('unit_outcome', 'Unit outcome recorded', 'Assessments', 'Student', 'A unit outcome (C / NYC) is recorded.', 'Unit outcome recorded', 'Hi {{first_name}},

Your outcome for {{unit_name}} has been recorded: *{{outcome}}*.', true),
  ('general_announcement', 'General announcement', 'General', 'Anyone', 'A general message you can adapt.', '{{institution}}: an update for you', 'Hi {{first_name}},

{{message}}

Kind regards,
{{institution}}', true),
  ('class_reminder', 'Class reminder', 'General', 'Student', 'Reminder about an upcoming class.', 'Class reminder: {{course_name}}', 'Hi {{first_name}},

A reminder that your class for {{course_name}} is on {{date_time}} at {{location}}.', true),
  ('class_cancelled', 'Class cancelled', 'General', 'Student', 'A class is cancelled or moved.', 'Class cancelled: {{course_name}}', 'Hi {{first_name}},

Your class for {{course_name}} on {{date_time}} is cancelled.

{{reason}}

We will let you know the new time.', true),
  ('attendance_warning', 'Attendance warning', 'General', 'Student', 'Attendance has dropped below the required level.', 'Your attendance for {{course_name}}', 'Hi {{first_name}},

Your attendance for {{course_name}} is below the required level. Please contact student support to discuss: {{link}}', true)
on conflict (key) do nothing;

commit;
