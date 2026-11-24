-- SLIT-SIGNATORY-DEFAULTS (owner, 2026-11-24: "SLIT sign authority will be Hardik Amin as CEO; in witness from SLIT use Chanpreet Kaur"):
-- Prepare the application starts with these (Business Rules, Agents; editable in Settings & Policies). Staff can still change them on the
-- form. The witness still draws their own signature (it is never typed); the signatory's signature starts as their typed name.
begin;

select public.business_rule_add_setting('agents.slit_signatory_name', 'SLIT signatory on agreements', 'Agents',
  'agency_agents', 'agent_onboarding', 'text', '"Hardik Amin"'::jsonb, '{}'::jsonb,
  'Who signs agent agreements for SLIT: Prepare the application starts with this name (staff can change it on the form).');
select public.business_rule_add_setting('agents.slit_signatory_position', 'SLIT signatory position', 'Agents',
  'agency_agents', 'agent_onboarding', 'text', '"CEO"'::jsonb, '{}'::jsonb,
  'The SLIT signatory''s position printed on the agreement (CEO, Director, Manager, Owner or another title).');
select public.business_rule_add_setting('agents.slit_witness_name', 'SLIT witness on agreements', 'Agents',
  'agency_agents', 'agent_onboarding', 'text', '"Chanpreet Kaur"'::jsonb, '{}'::jsonb,
  'Prepare the application starts with this SLIT witness name; the witness still draws their own signature before sending.');

commit;
