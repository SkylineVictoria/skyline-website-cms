-- CONTACT-VERIFY portal invitations (owner, 2026-11-26: "allow both"): an agent's (and an agency admin's / a student's) portal
-- invitation also goes by text, the same method as 20261126170517 (scope 'portal', subject = public.agency_invitations.id):
--   * the email keeps its /agency/accept-invite link (it proves the email);
--   * the text carries its own link (/agency/text-invite#t=), which proves the mobile; the person then confirms their email with a
--     6-digit code and gets a fresh accept-invite link (portal_invitation_link_issue), exactly as the emailed one.
-- The mobile is the one SLIT holds for the invited email (skyline_private.mobile_for_email: agent, student, business, employee).
-- Down: restore the three scope checks without 'portal'; re-run link_alias_add, link_opened, link_person from 20261126170517.
begin;

alter table skyline_private.link_aliases drop constraint if exists link_aliases_scope_check;
alter table skyline_private.link_aliases add constraint link_aliases_scope_check check (scope in ('sign', 'staff', 'cms', 'portal'));
alter table skyline_private.link_proofs drop constraint if exists link_proofs_scope_check;
alter table skyline_private.link_proofs add constraint link_proofs_scope_check check (scope in ('sign', 'staff', 'cms', 'portal'));
alter table skyline_private.link_codes drop constraint if exists link_codes_scope_check;
alter table skyline_private.link_codes add constraint link_codes_scope_check check (scope in ('sign', 'staff', 'cms', 'portal'));

create or replace function public.link_alias_add(p_scope text, p_subject uuid, p_base_hash text, p_alias_hash text, p_email text, p_mobile text, p_expires timestamptz)
returns boolean language plpgsql security definer set search_path to '' as $$
begin
  if p_scope not in ('staff', 'cms', 'portal') or coalesce(p_alias_hash, '') !~ '^[a-f0-9]{64}$' or p_subject is null then return false; end if;
  insert into skyline_private.link_aliases(alias_hash, scope, subject, base_hash, email, mobile, expires_at)
  values (p_alias_hash, p_scope, p_subject, p_base_hash, lower(btrim(coalesce(p_email, ''))), coalesce(p_mobile, ''), coalesce(p_expires, clock_timestamp() + interval '7 days'));
  return true;
end $$;
revoke all on function public.link_alias_add(text, uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.link_alias_add(text, uuid, text, text, text, text, timestamptz) to service_role;

create or replace function public.link_opened(p_hash text, p_scope text default null, p_subject uuid default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare a skyline_private.link_aliases; v_scope text; v_subject uuid; v_pending boolean; v_email text;
begin
  select * into a from skyline_private.link_aliases where alias_hash = p_hash and expires_at > clock_timestamp();
  if a.alias_hash is not null then
    perform skyline_private.link_proof(a.scope, a.subject, 'phone', a.mobile, true);
    perform skyline_private.link_proof(a.scope, a.subject, 'email', a.email, false);
    v_scope := a.scope; v_subject := a.subject;
  elsif p_scope in ('sign', 'staff', 'cms', 'portal') and p_subject is not null then
    perform skyline_private.link_proof(p_scope, p_subject, 'email', '', true);
    v_scope := p_scope; v_subject := p_subject;
  else
    select x.scope, x.subject into v_scope, v_subject from skyline_private.link_aliases x where x.base_hash = p_hash limit 1;
    if v_subject is not null then perform skyline_private.link_proof(v_scope, v_subject, 'email', '', true); end if;
  end if;
  select p.verified_at is null, p.value into v_pending, v_email from skyline_private.link_proofs p
   where p.scope = v_scope and p.subject = v_subject and p.kind = 'email';
  return jsonb_build_object('via', case when a.alias_hash is not null then 'sms' else 'email' end, 'scope', v_scope, 'subject', v_subject,
    'base', coalesce(a.base_hash, p_hash), 'emailPending', coalesce(v_pending, false),
    'emailTo', case when coalesce(v_pending, false) then regexp_replace(coalesce(v_email, ''), '^(.)[^@]*(@.*)$', '\1•••\2') end);
end $$;
revoke all on function public.link_opened(text, text, uuid) from public, anon, authenticated;
grant execute on function public.link_opened(text, text, uuid) to service_role;

-- 'portal': the invitation's email, first name and the mobile SLIT holds for that email; pending invitations only.
create or replace function public.link_person(p_scope text, p_subject uuid) returns jsonb
language sql stable security definer set search_path to '' as $$
  select case p_scope
    when 'staff' then (select jsonb_build_object('email', lower(s.email), 'mobile', coalesce(nullif(btrim(s.phone_e164), ''), ''), 'name', s.first_name) from hr.staff_profiles s where s.id = p_subject)
    when 'cms' then (select jsonb_build_object('email', lower(u.email), 'mobile', coalesce(u.mobile, ''), 'name', split_part(coalesce(u.name, ''), ' ', 1), 'authUserId', u.auth_user_id)
      from public.cms_users u where u.id = p_subject::text)
    when 'portal' then (select jsonb_build_object('email', lower(i.email), 'mobile', skyline_private.mobile_for_email(i.email),
        'name', split_part(coalesce(i.full_name, ''), ' ', 1), 'expiresAt', i.expires_at)
      from public.agency_invitations i where i.id = p_subject and i.status = 'pending' and i.expires_at > now()) end;
$$;
revoke all on function public.link_person(text, uuid) from public, anon, authenticated;
grant execute on function public.link_person(text, uuid) to service_role;

commit;
