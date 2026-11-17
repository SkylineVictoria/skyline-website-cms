-- The installed onboarding templates listed by key include the Agent Referee Check Form (F05); 20261117150000 let it register, this lets
-- the function find it (found on hosted 2026-11-17 while starting an onboarding with the staged flow).
create or replace function public.agency_onboarding_templates() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, hr, public as $f$
begin
 perform hr.require_admin();
 return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'systemKey', t.system_key, 'name', t.name, 'title', t.title, 'status', t.status, 'sourcePath', t.source_path,
   'sourceHash', t.source_hash, 'sourcePages', t.source_pages, 'fields', t.fields, 'expiryDays', t.expiry_days, 'reminderDays', t.reminder_days, 'version', t.version) order by t.system_key)
  from hr.sign_templates t where t.system_key in ('agent_application_form', 'agent_agreement', 'agent_referee_check_form') and t.deleted_at is null), '[]'::jsonb);
end $f$;
