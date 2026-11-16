-- Pulled 2026-11-16 from hosted xcpydisstlvtvcsqnjob (supabase_migrations.schema_migrations.statements, version 20261116070726),
-- applied there by another session; the repo copy exists so a fresh lab replay matches hosted. Do not edit: fixes go in new migrations.
-- The {{institute.*}} sample values used by "Sample application" previews mirror Website Settings (the SLIT row, tenant_id null),
-- so the preview shows the real logo, address, RTO, CRICOS, ABN... and stays in step when the settings change.
create or replace function public.letter_variables_sync_institute()
returns trigger language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare s jsonb;
begin
  if new.tenant_id is not null then return new; end if;
  s := to_jsonb(new);
  update public.letter_variables v set sample = coalesce(nullif(btrim(s->>v.source_ref), ''), v.sample)
   where v.source_kind = 'institute' and s ? v.source_ref and v.sample is distinct from coalesce(nullif(btrim(s->>v.source_ref), ''), v.sample);
  return new;
end $$;
revoke all on function public.letter_variables_sync_institute() from public, anon, authenticated;

drop trigger if exists letter_variables_sync_institute on public.cms_settings;
create trigger letter_variables_sync_institute after insert or update on public.cms_settings
  for each row execute function public.letter_variables_sync_institute();

-- Bring them in line now.
update public.letter_variables v set sample = coalesce(nullif(btrim(to_jsonb(c)->>v.source_ref), ''), v.sample)
from public.cms_settings c
where c.tenant_id is null and v.source_kind = 'institute' and to_jsonb(c) ? v.source_ref;
