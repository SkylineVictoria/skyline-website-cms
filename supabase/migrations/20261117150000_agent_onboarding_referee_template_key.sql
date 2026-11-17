-- The Agent Referee Check Form (F05) is the third blank an administrator installs (document-signing agent_onboarding_install):
-- the register step must accept its key too (found on hosted 2026-11-17 while starting an onboarding with the staged flow).
create or replace function public.agency_onboarding_template_register(p_template uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, hr, public as $f$
declare t hr.sign_templates;
begin
 perform hr.require_admin();
 if coalesce(p_key, '') not in ('agent_application_form', 'agent_agreement', 'agent_referee_check_form') then raise exception 'Unknown onboarding template'; end if;
 select * into t from hr.sign_templates where id = p_template and deleted_at is null and kind = 'pdf';
 if not found then raise exception 'Template not found'; end if;
 update hr.sign_templates set system_key = null where system_key = p_key and id <> p_template;
 update hr.sign_templates set system_key = p_key, audience = 'agent' where id = p_template;
 return jsonb_build_object('id', t.id, 'systemKey', p_key);
end $f$;
