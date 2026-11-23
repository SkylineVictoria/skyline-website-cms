-- STUDENT-MESSAGES (owner, 2026-11-23): "communication hub like SLIT for the student, so they can also communicate from here".
-- A new channel 'portal' in the Communication Hub: a student writes from the student portal (Messages) into their own hub
-- conversation (one per student, person_kind 'student'); staff answer in the hub with "Student portal". The student sees their
-- conversation's messages on every channel except internal notes and Teams shares (email, SMS, WhatsApp, portal).
-- Rollback: drop function public.student_comm_thread(), public.student_comm_send(text), public.comm_send_portal(uuid, text);
--   delete from public.comm_messages where channel = 'portal'; restore the channel check without 'portal'.
begin;

alter table public.comm_messages drop constraint if exists comm_messages_channel_check;
alter table public.comm_messages add constraint comm_messages_channel_check check (channel in ('email', 'sms', 'whatsapp', 'note', 'teams', 'portal'));

-- The student's conversation, made on first use from the student record (the same row the hub's Message button opens).
create or replace function public.student_comm_conversation(p_create boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_student uuid := public.portal_student_id(); v_id uuid; s record;
begin
  if auth.uid() is null or v_student is null then raise exception 'Sign in as a student first' using errcode = '42501'; end if;
  select id into v_id from public.comm_conversations where person_kind = 'student' and person_ref = v_student;
  if v_id is null and p_create then
    select full_name, email, phone into s from public.enrollment_students where id = v_student;
    insert into public.comm_conversations(person_kind, person_ref, display_name, email, phone)
    values ('student', v_student, left(coalesce(nullif(btrim(s.full_name), ''), nullif(btrim(s.email), ''), 'Student'), 200),
      case when s.email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then s.email end, left(nullif(btrim(coalesce(s.phone, '')), ''), 32))
    on conflict do nothing returning id into v_id;
    if v_id is null then select id into v_id from public.comm_conversations where person_kind = 'student' and person_ref = v_student; end if;
  end if;
  return v_id;
end $$;
revoke all on function public.student_comm_conversation(boolean) from public, anon, authenticated;

-- What the student sees: every message of their conversation except internal notes and Teams shares, oldest first.
create or replace function public.student_comm_thread() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_conv uuid := public.student_comm_conversation(false);
begin
  if v_conv is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'direction', m.direction, 'channel', m.channel, 'subject', m.subject,
      'body', m.body, 'at', m.created_at, 'by', case when m.direction = 'out' then coalesce(nullif(m.sent_by_name, ''), 'SLIT') end) order by m.created_at)
    from public.comm_messages m where m.conversation_id = v_conv and m.channel not in ('note', 'teams')), '[]'::jsonb);
end $$;
revoke all on function public.student_comm_thread() from public, anon;
grant execute on function public.student_comm_thread() to authenticated;

-- The student writes to SLIT (at most 20 messages an hour).
create or replace function public.student_comm_send(p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_body text := btrim(coalesce(p_body, '')); v_conv uuid; v_id uuid;
begin
  if length(v_body) not between 1 and 4000 then raise exception 'Write a message (up to 4000 characters).' using errcode = '22023'; end if;
  v_conv := public.student_comm_conversation(true);
  if (select count(*) from public.comm_messages where conversation_id = v_conv and direction = 'in' and channel = 'portal'
      and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'You have sent many messages in the last hour. Please wait a little before sending more.' using errcode = '54000';
  end if;
  insert into public.comm_messages(conversation_id, direction, channel, subject, body, to_address, status)
  values (v_conv, 'in', 'portal', '', v_body, 'SLIT', 'received') returning id into v_id;
  update public.comm_conversations set last_message_at = now(), updated_at = now() where id = v_conv;
  return v_id;
end $$;
revoke all on function public.student_comm_send(text) from public, anon;
grant execute on function public.student_comm_send(text) to authenticated;

-- Staff answer a student in the portal (no email or text is sent; the student sees it under Messages).
create or replace function public.comm_send_portal(p_conversation uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare c public.comm_conversations; v_body text := btrim(coalesce(p_body, '')); v_name text; v_id uuid;
begin
  perform public.comm_require_admin();
  select * into c from public.comm_conversations where id = p_conversation for update;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;
  if c.person_kind <> 'student' or c.person_ref is null then raise exception 'Student portal messages go to students only' using errcode = '22023'; end if;
  if length(v_body) not between 1 and 4000 then raise exception 'Write a message (up to 4000 characters).' using errcode = '22023'; end if;
  select name into v_name from public.cms_users where auth_user_id = auth.uid();
  insert into public.comm_messages(conversation_id, direction, channel, subject, body, to_address, status, sent_by, sent_by_name)
  values (c.id, 'out', 'portal', '', v_body, 'Student portal', 'recorded', auth.uid(), v_name) returning id into v_id;
  update public.comm_conversations set last_message_at = now(), updated_at = now() where id = c.id;
  return v_id;
end $$;
revoke all on function public.comm_send_portal(uuid, text) from public, anon;
grant execute on function public.comm_send_portal(uuid, text) to authenticated;

commit;
