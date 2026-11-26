-- Register the server-configured provider without creating a Vault credential or tenant connection.
insert into public.integration_definitions (id, name, auth_type, availability, description)
values ('openai', 'OpenAI', 'api_key', 'environment_managed',
  'AI generation, document extraction, and website assistant indexing.')
on conflict (id) do nothing;
