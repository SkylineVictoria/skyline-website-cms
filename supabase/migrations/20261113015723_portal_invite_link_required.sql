-- INV-LINK: an invitation sent by an administrator (agency_invitations.invited_by set) gives portal access only after the
-- invited person opens a link from the invitation email. Before this, an email that already had a confirmed login got no email
-- and was let in at its next sign-in. Self-registration invitations (invited_by null) keep their behaviour.
--
-- How the link is proved:
--  * New login (or an unconfirmed one): the Supabase Auth invite / set-password email. Opening it confirms the email, so
--    auth.users.email_confirmed_at is on or after the time that email was sent (link_sent_at, or last_sent_at for invitations
--    sent before this migration).
--  * Existing confirmed login: portal-admin-users emails an "Activate access" link carrying a one-time token; only its SHA-256
--    is stored (link_token_hash). /agency/accept-invite calls portal_invitation_link_confirm(token), which sets link_confirmed_at.
-- portal_resolve_access accepts an administrator's invitation only when one of the two holds; otherwise it reports
-- 'invite_link_required' and creates no profile or membership.

alter table public.agency_invitations add column if not exists link_token_hash text;
alter table public.agency_invitations add column if not exists link_sent_at timestamptz;
alter table public.agency_invitations add column if not exists link_confirmed_at timestamptz;
create unique index if not exists agency_invitations_link_token_hash_key on public.agency_invitations(link_token_hash) where link_token_hash is not null;

-- True when an administrator's invitation has had its emailed link opened by the person with this email confirmation time.
create or replace function public.portal_invitation_link_ok(p_inv public.agency_invitations, p_confirmed timestamptz)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
 select p_inv.invited_by is null
  or p_inv.link_confirmed_at is not null
  or (p_confirmed is not null and coalesce(p_inv.link_sent_at, p_inv.last_sent_at, p_inv.created_at) is not null
      and p_confirmed >= coalesce(p_inv.link_sent_at, p_inv.last_sent_at, p_inv.created_at));
$$;

-- portal-admin-users (service role): a new one-time link for a pending invitation, replacing any earlier one.
create or replace function public.portal_invitation_link_issue(p_invitation uuid, p_token_hash text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare inv public.agency_invitations; v_agency text;
begin
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid link' using errcode = '22023'; end if;
 update public.agency_invitations set link_token_hash = p_token_hash, link_sent_at = now(), link_confirmed_at = null
 where id = p_invitation and status = 'pending' returning * into inv;
 if not found then raise exception 'Invitation not found' using errcode = 'P0002'; end if;
 select a.name into v_agency from public.agencies a where a.id = inv.agency_id;
 return jsonb_build_object('email', inv.email, 'name', inv.full_name, 'role', inv.role, 'agencyName', v_agency, 'expiresAt', inv.expires_at);
end $$;

-- /agency/accept-invite: the token from the email is the proof (256 random bits); no sign-in needed. Generic error on any miss.
create or replace function public.portal_invitation_link_confirm(p_token text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare inv public.agency_invitations; v_hash text;
begin
 if p_token is null or p_token !~ '^[A-Za-z0-9_-]{40,100}$' then raise exception 'This invitation link is not valid or has expired.' using errcode = '22023'; end if;
 v_hash := encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
 select * into inv from public.agency_invitations where link_token_hash = v_hash for update;
 if not found or inv.status not in ('pending', 'accepted') or (inv.status = 'pending' and inv.expires_at < now()) then
  raise exception 'This invitation link is not valid or has expired.' using errcode = '22023';
 end if;
 if inv.status = 'pending' and inv.link_confirmed_at is null then
  update public.agency_invitations set link_confirmed_at = now() where id = inv.id;
 end if;
 return jsonb_build_object('ok', true, 'email', inv.email, 'alreadyAccepted', inv.status = 'accepted');
end $$;

-- Same as 20261104270000's version except: an administrator's invitation is accepted only when portal_invitation_link_ok, and a
-- signed-in person whose only pending invitation still needs its link gets the state 'invite_link_required'.
create or replace function public.portal_resolve_access()
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid(); v_email text; v_confirmed timestamptz; inv public.agency_invitations; p public.portal_profiles; m public.agency_memberships; a public.agencies;
 v_accepted boolean := false; v_state text; v_link_needed boolean := false;
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 if public.cms_is_admin() then return jsonb_build_object('state', 'org_admin', 'accepted', false); end if;
 select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_uid;
 select * into p from public.portal_profiles where auth_user_id = v_uid;
 select * into m from public.agency_memberships where user_id = p.id;
 if v_confirmed is not null then
  select * into inv from public.agency_invitations i where i.email = v_email and i.status = 'pending' for update;
  if found and inv.expires_at >= now()
   and exists (select 1 from public.agencies x where x.id = inv.agency_id
    and (x.status = 'Active' or (x.registration_requested_at is not null and x.registration_reviewed_at is null)))
   and (inv.student_id is null or exists (select 1 from public.enrollment_students s where s.id = inv.student_id and s.status = 'Active' and s.agency_id = inv.agency_id))
   and not coalesce(m.status = 'Active' and p.status = 'Active' and m.agency_id <> inv.agency_id, false) then
   if not public.portal_invitation_link_ok(inv, v_confirmed) then
    v_link_needed := true;
   else
    if p.id is null then
     insert into public.portal_profiles(auth_user_id, email, full_name, status) values (v_uid, v_email, coalesce(nullif(inv.full_name, ''), split_part(v_email, '@', 1)), 'Active') returning * into p;
    else
     update public.portal_profiles set status = 'Active', updated_at = now() where id = p.id returning * into p;
    end if;
    insert into public.agency_memberships(user_id, agency_id, role, status, student_id) values (p.id, inv.agency_id, inv.role, 'Active', inv.student_id)
    on conflict (user_id) do update set agency_id = excluded.agency_id, role = excluded.role, status = 'Active', student_id = excluded.student_id, updated_at = now() returning * into m;
    update public.agency_invitations set status = 'accepted', accepted_at = now() where id = inv.id;
    perform public.portal_user_audit(v_uid, jsonb_build_object('name', p.full_name, 'role', inv.role), 'accept_invitation', p.id::text, inv.agency_id, jsonb_build_object('email', v_email, 'role', inv.role, 'student', inv.student_id));
    v_accepted := true;
   end if;
  end if;
 end if;
 if m.user_id is null then
  v_state := case when v_link_needed then 'invite_link_required'
   when exists (select 1 from public.agency_invitations i where i.email = v_email and i.status = 'pending' and i.expires_at < now()) then 'invite_expired' else 'no_access' end;
 else
  select * into a from public.agencies where id = m.agency_id;
  v_state := case when p.status <> 'Active' or m.status <> 'Active' then 'user_suspended'
   when m.role = 'student' and not exists (select 1 from public.enrollment_students s where s.id = m.student_id and s.status = 'Active') then 'user_suspended'
   when a.registration_requested_at is not null and a.registration_reviewed_at is null then 'pending_review'
   when a.registration_decision = 'declined' and a.status <> 'Active' then 'registration_declined'
   when coalesce(a.status, '') <> 'Active' then 'agency_suspended' else 'active' end;
 end if;
 return jsonb_build_object('state', v_state, 'accepted', v_accepted);
end; $function$;

revoke all on function public.portal_invitation_link_ok(public.agency_invitations, timestamptz) from public, anon, authenticated;
revoke all on function public.portal_invitation_link_issue(uuid, text) from public, anon, authenticated;
grant execute on function public.portal_invitation_link_issue(uuid, text) to service_role;
revoke all on function public.portal_invitation_link_confirm(text) from public;
grant execute on function public.portal_invitation_link_confirm(text) to anon, authenticated;
