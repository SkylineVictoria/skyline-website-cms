-- CONTACT-VERIFY everyone (owner, 2026-11-26: "same implementation for business, global admin, location employees: always use the same
-- method to onboard phone and email"). The method of 20261126150517 (students), for every other link SLIT sends:
--   * the email and the text message carry DIFFERENT links;
--   * the link that is opened proves its own channel (the email link the email, the text link the mobile);
--   * a person who came by the text link confirms their email with a 6-digit code before they sign / set a password / submit.
-- Scopes: 'sign'  = a signing link (agency application form and agreement, offer letters, employee documents; subject = hr.sign_recipients.id),
--         'staff' = an employee onboarding link (welcome / set password, offer, documents; subject = hr.staff_profiles.id),
--         'cms'   = a CMS user's invitation (Admins / Editors; subject = cms_users.id).
-- The Edge Functions keep the tokens; the database keeps only sha256 hashes. Everything here is service role only.

create table if not exists skyline_private.link_aliases (
  alias_hash text primary key check (alias_hash ~ '^[a-f0-9]{64}$'),
  scope text not null check (scope in ('sign', 'staff', 'cms')),
  subject uuid not null,
  base_hash text check (base_hash is null or base_hash ~ '^[a-f0-9]{64}$'),
  email text not null default '',
  mobile text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists link_aliases_subject on skyline_private.link_aliases(scope, subject);

create table if not exists skyline_private.link_proofs (
  scope text not null check (scope in ('sign', 'staff', 'cms')),
  subject uuid not null,
  kind text not null check (kind in ('email', 'phone')),
  value text not null default '',
  verified_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (scope, subject, kind)
);

create table if not exists skyline_private.link_codes (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('sign', 'staff', 'cms')),
  subject uuid not null,
  code_hash text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  attempts int not null default 0,
  used_at timestamptz
);
create index if not exists link_codes_subject on skyline_private.link_codes(scope, subject, created_at desc);
revoke all on skyline_private.link_aliases, skyline_private.link_proofs, skyline_private.link_codes from public, anon, authenticated;

-- The mobile SLIT holds for the person behind an email (an employee, an agent / agency admin, a student, a business), else ''.
create or replace function skyline_private.mobile_for_email(p_email text) returns text
language sql stable security definer set search_path to '' as $$
  select coalesce(
    (select nullif(btrim(s.phone_e164), '') from hr.staff_profiles s where lower(s.email) = lower(btrim(p_email)) and nullif(btrim(s.phone_e164), '') is not null limit 1),
    (select nullif(btrim(g.phone), '') from public.agents g where lower(g.email) = lower(btrim(p_email)) and nullif(btrim(g.phone), '') is not null limit 1),
    (select nullif(btrim(e.phone), '') from public.enrollment_students e where lower(e.email) = lower(btrim(p_email)) and nullif(btrim(e.phone), '') is not null limit 1),
    (select nullif(btrim(a.phone), '') from public.agencies a where lower(a.business_email) = lower(btrim(p_email)) and nullif(btrim(a.phone), '') is not null limit 1),
    '');
$$;
revoke all on function skyline_private.mobile_for_email(text) from public, anon, authenticated;

-- A proven channel (never downgraded), or a channel still to confirm (never overwrites a proven one).
create or replace function skyline_private.link_proof(p_scope text, p_subject uuid, p_kind text, p_value text, p_verified boolean) returns void
language plpgsql security definer set search_path to '' as $$
begin
  if p_verified then
    insert into skyline_private.link_proofs(scope, subject, kind, value, verified_at) values (p_scope, p_subject, p_kind, coalesce(p_value, ''), clock_timestamp())
    on conflict (scope, subject, kind) do update set value = coalesce(nullif(excluded.value, ''), link_proofs.value),
      verified_at = coalesce(link_proofs.verified_at, excluded.verified_at);
  else
    insert into skyline_private.link_proofs(scope, subject, kind, value, verified_at) values (p_scope, p_subject, p_kind, coalesce(p_value, ''), null)
    on conflict (scope, subject, kind) do nothing;
  end if;
end $$;
revoke all on function skyline_private.link_proof(text, uuid, text, text, boolean) from public, anon, authenticated;

-- Who a text for a signing link goes to (the recipient behind the emailed link's hash): null when SLIT holds no mobile for them.
create or replace function public.sign_sms_target(p_email_hash text) returns jsonb
language sql stable security definer set search_path to '' as $$
  select jsonb_build_object('recipientId', c.id, 'requestId', r.id, 'name', c.name, 'email', c.email, 'title', r.title, 'mobile', m.mobile,
      'expiresAt', coalesce(r.expires_at, clock_timestamp() + interval '30 days'))
  from hr.sign_tokens t join hr.sign_recipients c on c.id = t.recipient_id join hr.sign_requests r on r.id = c.request_id
  cross join lateral (select skyline_private.mobile_for_email(c.email) mobile) m
  where t.token_hash = p_email_hash and c.state in ('pending', 'sent', 'viewed') and m.mobile <> '';
$$;
revoke all on function public.sign_sms_target(text) from public, anon, authenticated;
grant execute on function public.sign_sms_target(text) to service_role;

-- The text gets its own signing link: a second token for the same signer, marked as the text's.
create or replace function public.sign_sms_link_add(p_recipient uuid, p_hash text, p_mobile text) returns boolean
language plpgsql security definer set search_path to '' as $$
declare c hr.sign_recipients; r hr.sign_requests;
begin
  if coalesce(p_hash, '') !~ '^[a-f0-9]{64}$' then return false; end if;
  select * into c from hr.sign_recipients where id = p_recipient and state in ('pending', 'sent', 'viewed');
  if c.id is null then return false; end if;
  select * into r from hr.sign_requests where id = c.request_id;
  insert into hr.sign_tokens(token_hash, recipient_id) values (p_hash, c.id);
  insert into skyline_private.link_aliases(alias_hash, scope, subject, email, mobile, expires_at)
  values (p_hash, 'sign', c.id, c.email, coalesce(p_mobile, ''), coalesce(r.expires_at, clock_timestamp() + interval '30 days'));
  return true;
end $$;
revoke all on function public.sign_sms_link_add(uuid, text, text) from public, anon, authenticated;
grant execute on function public.sign_sms_link_add(uuid, text, text) to service_role;

-- The text's outcome on the signing request's history (last three digits only).
create or replace function public.sign_sms_record(p_recipient uuid, p_outcome text, p_code text, p_last_digits text) returns void
language plpgsql security definer set search_path to '' as $$
declare c hr.sign_recipients;
begin
  if p_outcome not in ('sent', 'failed') then return; end if;
  select * into c from hr.sign_recipients where id = p_recipient;
  if c.id is null then return; end if;
  perform hr.sign_event(c.request_id, 'sms_' || p_outcome, c.id, null, jsonb_strip_nulls(jsonb_build_object(
    'code', nullif(left(regexp_replace(coalesce(p_code, ''), '[^a-z_]', '', 'g'), 40), ''),
    'endsWith', nullif(right(regexp_replace(coalesce(p_last_digits, ''), '[^0-9]', '', 'g'), 3), ''))));
end $$;
revoke all on function public.sign_sms_record(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.sign_sms_record(uuid, text, text, text) to service_role;

-- An employee link or a CMS invitation also goes by text: its alias (base_hash = the emailed link's hash for an employee link).
create or replace function public.link_alias_add(p_scope text, p_subject uuid, p_base_hash text, p_alias_hash text, p_email text, p_mobile text, p_expires timestamptz)
returns boolean language plpgsql security definer set search_path to '' as $$
begin
  if p_scope not in ('staff', 'cms') or coalesce(p_alias_hash, '') !~ '^[a-f0-9]{64}$' or p_subject is null then return false; end if;
  insert into skyline_private.link_aliases(alias_hash, scope, subject, base_hash, email, mobile, expires_at)
  values (p_alias_hash, p_scope, p_subject, p_base_hash, lower(btrim(coalesce(p_email, ''))), coalesce(p_mobile, ''), coalesce(p_expires, clock_timestamp() + interval '7 days'));
  return true;
end $$;
revoke all on function public.link_alias_add(text, uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.link_alias_add(text, uuid, text, text, text, text, timestamptz) to service_role;

-- A link is opened. A text link: its mobile is proven and its email waits for a code. An emailed link of a known person: the email is proven.
-- Answers {via, scope, subject, base, emailPending, emailTo} (via 'email' and base = the hash itself when it is not a text link).
create or replace function public.link_opened(p_hash text, p_scope text default null, p_subject uuid default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare a skyline_private.link_aliases; v_scope text; v_subject uuid; v_pending boolean; v_email text;
begin
  select * into a from skyline_private.link_aliases where alias_hash = p_hash and expires_at > clock_timestamp();
  if a.alias_hash is not null then
    perform skyline_private.link_proof(a.scope, a.subject, 'phone', a.mobile, true);
    perform skyline_private.link_proof(a.scope, a.subject, 'email', a.email, false);
    v_scope := a.scope; v_subject := a.subject;
  elsif p_scope in ('sign', 'staff', 'cms') and p_subject is not null then
    perform skyline_private.link_proof(p_scope, p_subject, 'email', '', true);
    v_scope := p_scope; v_subject := p_subject;
  else
    -- An employee's emailed link: the person is known from the text link sent with it.
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

-- Is the email of this person still to confirm (they came by a text link)?
create or replace function public.link_email_pending(p_scope text, p_subject uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists(select 1 from skyline_private.link_proofs p where p.scope = p_scope and p.subject = p_subject and p.kind = 'email' and p.verified_at is null);
$$;
revoke all on function public.link_email_pending(text, uuid) from public, anon, authenticated;
grant execute on function public.link_email_pending(text, uuid) to service_role;

-- A new code for the pending email (the function emails it). Same limits as the students' codes: 1 a minute, 5 an hour, 10 minutes valid.
create or replace function public.link_code_issue(p_scope text, p_subject uuid, p_code text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare p skyline_private.link_proofs;
begin
  select * into p from skyline_private.link_proofs where scope = p_scope and subject = p_subject and kind = 'email' and verified_at is null;
  if p.subject is null or p.value = '' then raise exception 'Nothing to confirm' using errcode = '22023'; end if;
  if coalesce(p_code, '') !~ '^[0-9]{6}$' then raise exception 'Invalid code' using errcode = '22023'; end if;
  if exists(select 1 from skyline_private.link_codes x where x.scope = p_scope and x.subject = p_subject and x.created_at > clock_timestamp() - interval '1 minute') then
    raise exception 'A code was just sent. Wait a minute before asking for another' using errcode = '22023';
  end if;
  if (select count(*) from skyline_private.link_codes x where x.scope = p_scope and x.subject = p_subject and x.created_at > clock_timestamp() - interval '1 hour') >= 5 then
    raise exception 'Too many codes were asked for. Try again in an hour' using errcode = '22023';
  end if;
  insert into skyline_private.link_codes(scope, subject, code_hash, expires_at)
  values (p_scope, p_subject, encode(sha256(convert_to(p_scope || ':' || p_subject::text || ':' || p_code, 'UTF8')), 'hex'), clock_timestamp() + interval '10 minutes');
  return jsonb_build_object('to', p.value);
end $$;
revoke all on function public.link_code_issue(text, uuid, text) from public, anon, authenticated;
grant execute on function public.link_code_issue(text, uuid, text) to service_role;

-- The code is entered (wrong tries counted: {ok:false} instead of an error). A right code proves the email.
create or replace function public.link_code_verify(p_scope text, p_subject uuid, p_code text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare c skyline_private.link_codes;
begin
  select * into c from skyline_private.link_codes x where x.scope = p_scope and x.subject = p_subject and x.used_at is null order by x.created_at desc limit 1 for update;
  if c.id is null or c.expires_at <= clock_timestamp() then return jsonb_build_object('ok', false, 'reason', 'expired', 'error', 'The code has expired. Ask for a new code'); end if;
  if c.attempts >= 5 then return jsonb_build_object('ok', false, 'reason', 'locked', 'error', 'Too many wrong tries. Ask for a new code'); end if;
  if c.code_hash is distinct from encode(sha256(convert_to(p_scope || ':' || p_subject::text || ':' || coalesce(p_code, ''), 'UTF8')), 'hex') then
    update skyline_private.link_codes set attempts = attempts + 1 where id = c.id;
    return jsonb_build_object('ok', false, 'reason', case when c.attempts + 1 >= 5 then 'locked' else 'wrong' end, 'remaining', greatest(4 - c.attempts, 0),
      'error', 'That code is not right. Check and try again');
  end if;
  update skyline_private.link_codes set used_at = clock_timestamp() where id = c.id;
  perform skyline_private.link_proof(p_scope, p_subject, 'email', '', true);
  if p_scope = 'sign' then
    perform hr.sign_event(r.request_id, 'email_confirmed', r.id, null, '{}'::jsonb) from hr.sign_recipients r where r.id = p_subject;
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.link_code_verify(text, uuid, text) from public, anon, authenticated;
grant execute on function public.link_code_verify(text, uuid, text) to service_role;

-- A signing link opened from the text: the mobile proof on the request's history (once per signer).
create or replace function public.sign_link_opened(p_hash text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v jsonb; c hr.sign_recipients; first boolean;
begin
  select k.* into c from hr.sign_tokens t join hr.sign_recipients k on k.id = t.recipient_id where t.token_hash = p_hash;
  if c.id is null then return jsonb_build_object('via', 'email', 'emailPending', false); end if;
  first := exists(select 1 from skyline_private.link_aliases a where a.alias_hash = p_hash)
    and not exists(select 1 from skyline_private.link_proofs p where p.scope = 'sign' and p.subject = c.id and p.kind = 'phone' and p.verified_at is not null);
  v := public.link_opened(p_hash, 'sign', c.id);
  if first then perform hr.sign_event(c.request_id, 'mobile_confirmed', c.id, null, '{}'::jsonb); end if;
  return v || jsonb_build_object('recipientId', c.id);
end $$;
revoke all on function public.sign_link_opened(text) from public, anon, authenticated;
grant execute on function public.sign_link_opened(text) to service_role;

-- The mobile for an employee (their profile) or a CMS user (cms_users.mobile, new, optional).
alter table public.cms_users add column if not exists mobile text check (mobile is null or mobile ~ '^\+[1-9][0-9]{7,14}$');
create or replace function public.link_person(p_scope text, p_subject uuid) returns jsonb
language sql stable security definer set search_path to '' as $$
  select case p_scope
    when 'staff' then (select jsonb_build_object('email', lower(s.email), 'mobile', coalesce(nullif(btrim(s.phone_e164), ''), ''), 'name', s.first_name) from hr.staff_profiles s where s.id = p_subject)
    when 'cms' then (select jsonb_build_object('email', lower(u.email), 'mobile', coalesce(u.mobile, ''), 'name', split_part(coalesce(u.name, ''), ' ', 1), 'authUserId', u.auth_user_id)
      from public.cms_users u where u.id = p_subject::text) end;
$$;
revoke all on function public.link_person(text, uuid) from public, anon, authenticated;
grant execute on function public.link_person(text, uuid) to service_role;

-- A CMS invitation's text link: used once (it hands out a set-password link).
create or replace function public.link_alias_use(p_hash text) returns boolean
language sql security definer set search_path to '' as $$
  update skyline_private.link_aliases set used_at = clock_timestamp() where alias_hash = p_hash and used_at is null and expires_at > clock_timestamp() returning true;
$$;
revoke all on function public.link_alias_use(text) from public, anon, authenticated;
grant execute on function public.link_alias_use(text) to service_role;
