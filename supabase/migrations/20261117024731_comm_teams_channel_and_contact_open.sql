-- COMM-ONE-PLACE: every "contact this person" shortcut opens the Messages popup, and Teams is a channel in it.
-- 1. comm_find_or_open(name, email, phone): finds the person behind a contact (student, agent login or agent record, staff /
--    applicant, agency; by email, then by mobile number) and opens their conversation; an unknown contact gets an 'other'
--    conversation. Used by the chat icons that replace the old WhatsApp / email shortcuts, so nothing is sent outside the log.
-- 2. Teams channel: comm_send_to_team(conversation, team, body) shares a message about the person into a staff team chat the
--    sender belongs to (and, when that team is linked, on to Microsoft Teams) and records it in the person's conversation.
-- Admin only, like the rest of the hub. Additive.
-- Rollback (manual): drop the two functions; alter table public.comm_messages drop column team_id; restore
-- comm_messages_channel_check without 'teams' (after removing 'teams' rows).
begin;

alter table public.comm_messages drop constraint comm_messages_channel_check;
alter table public.comm_messages add constraint comm_messages_channel_check check (channel in ('email', 'sms', 'whatsapp', 'note', 'teams'));
alter table public.comm_messages add column team_id uuid references public.comm_teams(id) on delete set null;

create function public.comm_find_or_open(p_name text, p_email text, p_phone text) returns uuid
language plpgsql security definer set search_path = public, hr as $$
declare v_email text := lower(nullif(btrim(coalesce(p_email, '')), '')); v_phone text := public.notification_normalize_phone(p_phone);
  v_kind text; v_ref uuid; v_id uuid;
begin
  perform public.comm_require_admin();
  if v_email is null and v_phone is null then raise exception 'This person has no email or mobile number' using errcode = '22023'; end if;
  -- Known person, by email first.
  if v_email is not null then
    select 'student', id into v_kind, v_ref from public.enrollment_students where lower(btrim(email)) = v_email limit 1;
    if v_ref is null then select 'agent', p.id into v_kind, v_ref from public.portal_profiles p join public.agency_memberships m on m.user_id = p.id and m.role <> 'student' where lower(p.email) = v_email limit 1; end if;
    if v_ref is null then select 'agent', id into v_kind, v_ref from public.agents where lower(btrim(email)) = v_email and profile_id is null limit 1; end if;
    if v_ref is null then select case when status in ('active', 'inactive') then 'staff' else 'applicant' end, id into v_kind, v_ref from hr.staff_profiles where email = v_email limit 1; end if;
    if v_ref is null then select 'agency', id into v_kind, v_ref from public.agencies where lower(btrim(business_email)) = v_email limit 1; end if;
  end if;
  -- Then by mobile number.
  if v_ref is null and v_phone is not null then
    select 'student', id into v_kind, v_ref from public.enrollment_students where public.notification_normalize_phone(phone) = v_phone limit 1;
    if v_ref is null then select 'agent', p.id into v_kind, v_ref from public.portal_profiles p join public.agency_memberships m on m.user_id = p.id and m.role <> 'student' where public.notification_normalize_phone(p.phone) = v_phone limit 1; end if;
    if v_ref is null then select 'agent', id into v_kind, v_ref from public.agents where profile_id is null and public.notification_normalize_phone(phone) = v_phone limit 1; end if;
    if v_ref is null then select case when status in ('active', 'inactive') then 'staff' else 'applicant' end, id into v_kind, v_ref from hr.staff_profiles where phone_e164 = v_phone limit 1; end if;
  end if;
  if v_ref is not null then return public.comm_open_conversation(v_kind, v_ref); end if;
  -- Someone we only know by contact details: reuse their conversation when there is one.
  select id into v_id from public.comm_conversations
  where (v_email is not null and lower(email) = v_email) or (v_phone is not null and public.notification_normalize_phone(phone) = v_phone)
  order by last_message_at desc nulls last limit 1;
  if v_id is not null then return v_id; end if;
  return public.comm_open_conversation('other', null, coalesce(nullif(btrim(p_name), ''), v_email, p_phone), v_email, coalesce(v_phone, nullif(btrim(p_phone), '')));
end;
$$;

/** Shares a message about the conversation's person into a staff team chat (members only) and records it in the conversation. */
create function public.comm_send_to_team(p_conversation uuid, p_team uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare c public.comm_conversations; t public.comm_teams; v_me text := public.comm_me(); v_name text; v_body text := btrim(coalesce(p_body, '')); v_id uuid;
begin
  perform public.comm_require_admin();
  select * into c from public.comm_conversations where id = p_conversation for update;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;
  select * into t from public.comm_teams where id = p_team and archived_at is null;
  if not found then raise exception 'Team not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.comm_team_members where team_id = p_team and cms_user_id = v_me) then
    raise exception 'You can only share into a team you belong to' using errcode = '42501';
  end if;
  if v_body = '' or length(v_body) > 3800 then raise exception 'Write a message (up to 3800 characters)' using errcode = '22023'; end if;
  select name into v_name from public.cms_users where id = v_me;
  insert into public.comm_team_messages(team_id, author_cms_user_id, author_name, body)
  values (p_team, v_me, coalesce(v_name, 'Staff'), 'About ' || c.display_name || ': ' || v_body);
  insert into public.comm_messages(conversation_id, direction, channel, subject, body, to_address, status, sent_by, sent_by_name, team_id)
  values (c.id, 'out', 'teams', '', v_body, t.name, 'recorded', auth.uid(), v_name, t.id) returning id into v_id;
  update public.comm_conversations set last_message_at = now(), updated_at = now() where id = c.id;
  return v_id;
end;
$$;

revoke all on function public.comm_find_or_open(text, text, text), public.comm_send_to_team(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.comm_find_or_open(text, text, text), public.comm_send_to_team(uuid, uuid, text) to authenticated;

commit;
