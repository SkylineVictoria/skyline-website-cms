-- USI-SERVICE (2026-11-23): the Edge Function allowlist for browser error reports and the daily health check (migration
-- 20261120101733) gains usi-service, and lms-bulk-worker (deployed 2026-11-23 without being added). Same list otherwise.
create or replace function public.edge_function_names() returns text[] language sql immutable as $f$
 select array['address-search', 'admin-view-as', 'calendly-admin', 'cms-admin-users', 'cricos-lookup', 'document-signing', 'email-sender', 'guest-documents',
  'holiday-sync', 'intake-groups', 'integrations-admin', 'integrations-credentials', 'integrations-refresh', 'integrations-webhook', 'lms-bulk-worker', 'notification-delivery', 'omara-abr-enrich',
  'omara-ingest', 'payments', 'portal-admin-users', 'portal-application-delete', 'portal-document-delete', 'portal-document-extract', 'portal-invite-activate',
  'portal-self-register', 'public-assistant', 'public-assistant-index', 'staff-admin', 'staff-onboarding', 'staff-register', 'student-office365',
  'support-ticket-mail', 'tga-course-import', 'usi-service', 'validated-document-upload', 'xero-push']::text[]
$f$;
