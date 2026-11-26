-- APPLICATION-DRAWN-SIGNATURE (owner, 2026-11-26: "make him sign", a signed copy managed like the business page):
--   * the student draws their signature on the last screen of the application (Declaration and submit); it is sent with the ticked
--     declarations (p_consent.signature, a PNG data URL) and stored in public.application_signatures with name, time, IP, browser;
--     signing without it is refused once the frontend that sends it is live (this migration goes after that frontend);
--   * public.application_signed_copy(application) gives staff, the agency and the student what the signed copy prints: the signature,
--     who signed and when, the declarations ticked (title, time, IP) and a parent / guardian's when there is one.
-- No direct table access. Down: drop public.application_signed_copy, skyline_private.application_signature_store,
-- public.application_signatures; patch student_sign back (remove the two added lines).
begin;

create table if not exists public.application_signatures (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.enrollment_applications(id) on delete cascade,
  signer_role text not null check (signer_role in ('student', 'guardian')),
  signer_name text not null default '',
  signer_user_id uuid,
  png text not null check (png ~ '^data:image/png;base64,[A-Za-z0-9+/=]+$' and length(png) <= 400000),
  ip text,
  user_agent text,
  signed_at timestamptz not null default clock_timestamp()
);
create index if not exists application_signatures_app on public.application_signatures(application_id, signed_at desc);
alter table public.application_signatures enable row level security;
revoke all on public.application_signatures from public, anon, authenticated;

create or replace function skyline_private.application_signature_store(p_application uuid, p_png text, p_role text, p_name text)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if coalesce(p_png, '') !~ '^data:image/png;base64,[A-Za-z0-9+/=]+$' or length(p_png) > 400000 or length(p_png) < 200 then
    raise exception 'Draw your signature in the box to sign' using errcode = '22023';
  end if;
  insert into public.application_signatures(application_id, signer_role, signer_name, signer_user_id, png, ip, user_agent)
  values (p_application, p_role, left(coalesce(p_name, ''), 200), auth.uid(), p_png,
    nullif(skyline_private.request_ip(), ''), nullif(left(coalesce(skyline_private.request_user_agent(), ''), 500), ''));
end $$;
revoke all on function skyline_private.application_signature_store(uuid, text, text, text) from public, anon, authenticated;

-- The student's signature is required and stored with the declarations (patched into the live student_sign).
select public.business_rule_patch_function('skyline_private.student_sign(public.enrollment_applications, text, text, jsonb, text)'::regprocedure,
$old$if p_consent->'declarations' ? 'usi_permission' then perform public.usi_consent_set(a.id, true, false); end if;$old$,
$new$if p_consent->'declarations' ? 'usi_permission' then perform public.usi_consent_set(a.id, true, false); end if;
 perform skyline_private.application_signature_store(a.id, p_consent->>'signature', 'student', v_name);$new$);

-- What the signed copy prints. Staff (SLIT admins), the application's agency / agent and the student themselves.
create or replace function public.application_signed_copy(p_application uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v jsonb;
begin
  if auth.uid() is null or not (public.portal_is_slit_admin() or public.portal_can_access_application(p_application)) then
    raise exception 'You cannot see this application''s signature' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'signatures', coalesce((select jsonb_agg(jsonb_build_object('role', s.signer_role, 'name', s.signer_name, 'png', s.png,
        'signedAt', s.signed_at, 'ip', s.ip) order by s.signed_at) from (
          select distinct on (signer_role) * from public.application_signatures where application_id = p_application order by signer_role, signed_at desc) s), '[]'::jsonb),
    'declarations', coalesce((select jsonb_agg(jsonb_build_object('key', c.declaration_key, 'title', coalesce(t.title, c.declaration_key),
        'role', c.signer_role, 'name', c.recorded_by_name, 'at', c.created_at, 'ip', c.ip, 'guardian', c.guardian_name) order by c.created_at, t.sort)
      from public.enrollment_application_consents c
      left join public.application_declaration_texts t on t.key = c.declaration_key and t.version = c.text_version
      where c.application_id = p_application and c.declaration_key is not null
        and c.created_at >= coalesce((select max(x.created_at) - interval '1 day' from public.enrollment_application_consents x
          where x.application_id = p_application and x.declaration_key is not null), '-infinity')), '[]'::jsonb),
    'handoff', (select jsonb_build_object('state', h.state, 'signedAt', h.signed_at, 'signedBy', h.signed_by_name)
      from skyline_private.application_handoffs h where h.application_id = p_application)) into v;
  return v;
end $$;
revoke all on function public.application_signed_copy(uuid) from public, anon;
grant execute on function public.application_signed_copy(uuid) to authenticated;

commit;
