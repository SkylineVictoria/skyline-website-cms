-- Register existing server-managed integrations without creating credentials or tenant connections.
insert into public.integration_definitions (id, name, auth_type, availability, description)
values
  ('postmark', 'Postmark', 'api_key', 'environment_managed', 'Transactional email delivery.'),
  ('geoscape', 'Geoscape', 'api_key', 'environment_managed', 'Australian address autocomplete.'),
  ('training_gov_au', 'Training.gov.au', 'username_password', 'environment_managed', 'Sandbox SOAP access for course and qualification imports.'),
  ('cloudflare_turnstile', 'Cloudflare Turnstile', 'site_secret_key', 'environment_managed', 'Verification for public staff and careers applications.'),
  ('azure_document_intelligence', 'Azure Document Intelligence', 'api_key', 'environment_managed', 'Document extraction for categories routed to Azure.')
on conflict (id) do nothing;
