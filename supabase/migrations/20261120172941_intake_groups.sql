-- INTAKE-GROUPS (2026-11-20, owner): every intake has one communication group.
--   * Microsoft 365 group (address <course>-<mon><year>@ the student domain): created and kept in sync by the intake-groups Edge
--     Function (Graph app permissions); students join with their SLIT Microsoft 365 account, trainers by work account or as guests.
--   * WhatsApp group: a real WhatsApp group; its invite link is stored on the group and sent to every new member by email and
--     text. Members are tracked as invited / joined (ticked by staff: WhatsApp gives no join events for ordinary groups).
--   * Text list: the members' mobiles; texts go out through the ClickSend connection (Integrations), off until connected.
-- Students join and leave with the intake (intake_enrolments active / deferred); trainers are added by Admins / RTO Managers.
-- Admins and RTO Managers manage; the group's trainers may also send. Messages are emailed to each member's usual address and
-- texted to each mobile; every send and delivery is kept.
begin;

create table if not exists public.intake_groups (
  intake_id uuid primary key references public.course_intakes(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'closed')),
  mail_nickname text not null,
  m365_group_id text,
  m365_address text,
  m365_status text not null default 'pending' check (m365_status in ('pending', 'ready', 'not_configured', 'failed')),
  m365_error text,
  m365_synced_at timestamptz,
  whatsapp_invite_link text check (whatsapp_invite_link is null or whatsapp_invite_link ~ '^https://chat\.whatsapp\.com/[A-Za-z0-9]{10,40}$'),
  sms_enabled boolean not null default true,
  welcome_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists public.intake_group_members (
  intake_id uuid not null references public.intake_groups(intake_id) on delete cascade,
  person_kind text not null check (person_kind in ('student', 'staff')),
  person_id uuid not null,
  active boolean not null default true,
  m365_status text not null default 'pending' check (m365_status in ('pending', 'member', 'no_account', 'removed', 'failed')),
  m365_user_id text,
  m365_error text,
  whatsapp_invited_at timestamptz,
  whatsapp_joined boolean not null default false,
  sms_opt_out boolean not null default false,
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (intake_id, person_kind, person_id)
);
create index if not exists intake_group_members_person_idx on public.intake_group_members(person_kind, person_id);

create table if not exists public.intake_group_messages (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null references public.intake_groups(intake_id) on delete cascade,
  kind text not null default 'message' check (kind in ('message', 'welcome', 'invite')),
  channels text[] not null,
  subject text,
  body text not null check (char_length(body) between 1 and 4000),
  sent_by uuid default auth.uid(),
  sender_name text,
  created_at timestamptz not null default now()
);
create index if not exists intake_group_messages_intake_idx on public.intake_group_messages(intake_id, created_at desc);

create table if not exists public.intake_group_deliveries (
  id bigint generated always as identity primary key,
  message_id uuid not null references public.intake_group_messages(id) on delete cascade,
  person_kind text not null,
  person_id uuid not null,
  channel text not null check (channel in ('email', 'sms')),
  to_address text,
  email_delivery_id uuid,
  provider_request_id bigint,
  status text not null default 'queued' check (status in ('queued', 'skipped', 'not_connected'))
);
create index if not exists intake_group_deliveries_message_idx on public.intake_group_deliveries(message_id);

alter table public.intake_groups enable row level security;
alter table public.intake_group_members enable row level security;
alter table public.intake_group_messages enable row level security;
alter table public.intake_group_deliveries enable row level security;
revoke all on public.intake_groups, public.intake_group_members, public.intake_group_messages, public.intake_group_deliveries from anon, authenticated;

-- Group emails are their own event.
alter table public.notification_deliveries drop constraint if exists notification_deliveries_subject_ref;
alter table public.notification_deliveries add constraint notification_deliveries_subject_ref check (
  application_id is not null or support_ticket_id is not null or booking_id is not null or assessment_event_id is not null
  or event like 'support_ticket%' or hub_message_id is not null or event like 'ops\_%' or event like 'intake\_group%') not valid;

-- Name and address of an intake's group.
create or replace function public.intake_group_nickname(p_intake uuid) returns text
language sql stable security definer set search_path = public as $$
  select left(regexp_replace(lower(coalesce(nullif(btrim(c.code), ''), 'intake') || '-' || to_char(i.start_date, 'monyyyy')
           || case when (select count(*) from public.course_intakes x where x.course_id = i.course_id and date_trunc('month', x.start_date) = date_trunc('month', i.start_date)) > 1
                   then '-' || left(replace(i.id::text, '-', ''), 4) else '' end), '[^a-z0-9-]', '', 'g'), 60)
  from public.course_intakes i join public.cms_courses c on c.id = i.course_id where i.id = p_intake;
$$;
create or replace function public.intake_group_title(p_intake uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim(c.code), ''), c.name) || ' · ' || to_char(i.start_date, 'Mon YYYY')
  from public.course_intakes i join public.cms_courses c on c.id = i.course_id where i.id = p_intake;
$$;

create or replace function public.intake_group_ensure(p_intake uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.intake_groups(intake_id, mail_nickname) values (p_intake, public.intake_group_nickname(p_intake))
  on conflict (intake_id) do nothing;
$$;

-- Who may manage (Admins, RTO Managers) and who may send (also the group's trainers).
create or replace function public.intake_group_can_manage() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.cms_is_admin(), false) or coalesce(public.cms_is_rto_manager(), false);
$$;
create or replace function public.intake_group_can_send(p_intake uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.intake_group_can_manage() or exists (
    select 1 from public.intake_group_members m where m.intake_id = p_intake and m.person_kind = 'staff' and m.active
      and m.person_id = public.asm_trainer_profile());
$$;

-- Contact details of a member.
create or replace function public.intake_group_contact(p_kind text, p_id uuid, out name text, out email text, out phone text)
language sql stable security definer set search_path = public as $$
  select s.full_name, nullif(lower(btrim(s.email)), ''), public.notification_normalize_phone(s.phone)
    from public.enrollment_students s where p_kind = 'student' and s.id = p_id
  union all
  select btrim(p.first_name || ' ' || p.last_name), p.email, p.phone_e164
    from hr.staff_profiles p where p_kind = 'staff' and p.id = p_id
  limit 1;
$$;

-- Queues one message to the given members (null = every active member) by email and / or text. Returns the message id.
create or replace function public.intake_group_queue(p_intake uuid, p_kind text, p_channels text[], p_subject text, p_body text,
  p_people jsonb default null, p_sender_name text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare g public.intake_groups; v_msg uuid; m record; ct record; v_del uuid; v_req bigint; v_sms_ok boolean;
begin
  select * into g from public.intake_groups where intake_id = p_intake;
  if g.intake_id is null then raise exception 'Group not found.' using errcode = 'P0002'; end if;
  v_sms_ok := (public.comm_channel_secret('sms') is not null);
  insert into public.intake_group_messages(intake_id, kind, channels, subject, body, sender_name)
    values (p_intake, p_kind, p_channels, p_subject, p_body,
            coalesce(p_sender_name, (select name from public.cms_users where auth_user_id = auth.uid()), 'SLIT'))
    returning id into v_msg;
  for m in select * from public.intake_group_members gm where gm.intake_id = p_intake and gm.active
             and (p_people is null or exists (select 1 from jsonb_array_elements(p_people) x
                   where x->>'kind' = gm.person_kind and (x->>'id')::uuid = gm.person_id)) loop
    select * into ct from public.intake_group_contact(m.person_kind, m.person_id);
    if 'email' = any(p_channels) then
      if ct.email is null then
        insert into public.intake_group_deliveries(message_id, person_kind, person_id, channel, status) values (v_msg, m.person_kind, m.person_id, 'email', 'skipped');
      else
        insert into public.notification_deliveries(tenant_id, recipient_email, event, template_source, subject, body)
          values (null, ct.email, 'intake_group_' || p_kind, 'default', coalesce(nullif(btrim(p_subject), ''), public.intake_group_title(p_intake)), p_body)
          returning id into v_del;
        insert into public.intake_group_deliveries(message_id, person_kind, person_id, channel, to_address, email_delivery_id)
          values (v_msg, m.person_kind, m.person_id, 'email', ct.email, v_del);
      end if;
    end if;
    if 'sms' = any(p_channels) then
      if ct.phone is null or m.sms_opt_out or not g.sms_enabled then
        insert into public.intake_group_deliveries(message_id, person_kind, person_id, channel, to_address, status)
          values (v_msg, m.person_kind, m.person_id, 'sms', ct.phone, 'skipped');
      elsif not v_sms_ok then
        insert into public.intake_group_deliveries(message_id, person_kind, person_id, channel, to_address, status)
          values (v_msg, m.person_kind, m.person_id, 'sms', ct.phone, 'not_connected');
      else
        v_req := public.comm_channel_post('sms', ct.phone, left(p_body, 1600), 'intake_group:' || v_msg);
        insert into public.intake_group_deliveries(message_id, person_kind, person_id, channel, to_address, provider_request_id)
          values (v_msg, m.person_kind, m.person_id, 'sms', ct.phone, v_req);
      end if;
    end if;
  end loop;
  return v_msg;
end $$;
revoke all on function public.intake_group_queue(uuid, text, text[], text, text, jsonb, text) from public, anon, authenticated;

-- The welcome / WhatsApp invite for members who have not had it yet.
create or replace function public.intake_group_invite(p_intake uuid, p_people jsonb default null, p_force boolean default false) returns integer
language plpgsql security definer set search_path = public as $$
declare g public.intake_groups; v_people jsonb; v_body text;
begin
  select * into g from public.intake_groups where intake_id = p_intake;
  if g.intake_id is null or g.status <> 'active' or (not g.welcome_enabled and not p_force) then return 0; end if;
  select jsonb_agg(jsonb_build_object('kind', m.person_kind, 'id', m.person_id)) into v_people
    from public.intake_group_members m
   where m.intake_id = p_intake and m.active and not m.whatsapp_joined
     and (p_force or m.whatsapp_invited_at is null)
     and (p_people is null or exists (select 1 from jsonb_array_elements(p_people) x where x->>'kind' = m.person_kind and (x->>'id')::uuid = m.person_id));
  if v_people is null then return 0; end if;
  v_body := 'Welcome to ' || public.intake_group_title(p_intake) || ' at SLIT.'
    || case when g.m365_address is not null then E'\n\nYour class email group: ' || g.m365_address || ' (everyone in the class gets what is sent there).' else '' end
    || case when g.whatsapp_invite_link is not null then E'\n\nJoin the class WhatsApp group: ' || g.whatsapp_invite_link else '' end;
  perform public.intake_group_queue(p_intake, 'invite', array['email', 'sms'], 'Welcome to ' || public.intake_group_title(p_intake), v_body, v_people, 'SLIT');
  if g.whatsapp_invite_link is not null then
    update public.intake_group_members m set whatsapp_invited_at = now()
     where m.intake_id = p_intake and exists (select 1 from jsonb_array_elements(v_people) x where x->>'kind' = m.person_kind and (x->>'id')::uuid = m.person_id);
  end if;
  return jsonb_array_length(v_people);
end $$;
revoke all on function public.intake_group_invite(uuid, jsonb, boolean) from public, anon, authenticated;

-- A new intake gets its group.
create or replace function public.course_intakes_make_group() returns trigger
language plpgsql security definer set search_path = public as $$
begin perform public.intake_group_ensure(new.id); return null; end $$;
drop trigger if exists course_intakes_make_group on public.course_intakes;
create trigger course_intakes_make_group after insert on public.course_intakes
  for each row execute function public.course_intakes_make_group();

-- Students join and leave with the intake.
create or replace function public.intake_enrolments_group_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_in boolean; v_intake uuid; v_student uuid;
begin
  if tg_op = 'DELETE' then
    update public.intake_group_members set active = false, removed_at = now()
     where intake_id = old.intake_id and person_kind = 'student' and person_id = old.student_id and active;
    return null;
  end if;
  if tg_op = 'UPDATE' and old.intake_id is distinct from new.intake_id then
    update public.intake_group_members set active = false, removed_at = now()
     where intake_id = old.intake_id and person_kind = 'student' and person_id = old.student_id and active;
  end if;
  v_intake := new.intake_id; v_student := new.student_id; v_in := new.status in ('active', 'deferred');
  perform public.intake_group_ensure(v_intake);
  if v_in then
    insert into public.intake_group_members(intake_id, person_kind, person_id) values (v_intake, 'student', v_student)
    on conflict (intake_id, person_kind, person_id) do update set active = true, removed_at = null,
      m365_status = case when intake_group_members.m365_status = 'member' then 'member' else 'pending' end
      where not intake_group_members.active;
    perform public.intake_group_invite(v_intake, jsonb_build_array(jsonb_build_object('kind', 'student', 'id', v_student)));
  else
    update public.intake_group_members set active = false, removed_at = now()
     where intake_id = v_intake and person_kind = 'student' and person_id = v_student and active;
  end if;
  return null;
end $$;
drop trigger if exists intake_enrolments_group_sync on public.intake_enrolments;
create trigger intake_enrolments_group_sync after insert or update of status, intake_id or delete on public.intake_enrolments
  for each row execute function public.intake_enrolments_group_sync();

-- Existing intakes and students (no welcome messages for them).
select public.intake_group_ensure(id) from public.course_intakes;
insert into public.intake_group_members(intake_id, person_kind, person_id)
  select e.intake_id, 'student', e.student_id from public.intake_enrolments e where e.status in ('active', 'deferred')
  on conflict do nothing;

-- One row per group for the lists.
create or replace function public.intake_group_row(g public.intake_groups) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('intakeId', g.intake_id, 'title', public.intake_group_title(g.intake_id),
    'courseId', i.course_id, 'courseName', c.name, 'startDate', i.start_date, 'endDate', i.end_date, 'status', g.status,
    'm365Status', g.m365_status, 'm365Address', g.m365_address, 'm365Error', g.m365_error, 'mailNickname', g.mail_nickname,
    'whatsappLink', g.whatsapp_invite_link, 'smsEnabled', g.sms_enabled, 'welcomeEnabled', g.welcome_enabled,
    'students', (select count(*) from public.intake_group_members m where m.intake_id = g.intake_id and m.active and m.person_kind = 'student'),
    'trainers', (select count(*) from public.intake_group_members m where m.intake_id = g.intake_id and m.active and m.person_kind = 'staff'),
    'm365Members', (select count(*) from public.intake_group_members m where m.intake_id = g.intake_id and m.active and m.m365_status = 'member'),
    'whatsappJoined', (select count(*) from public.intake_group_members m where m.intake_id = g.intake_id and m.active and m.whatsapp_joined),
    'textable', (select count(*) from public.intake_group_members m cross join lateral public.intake_group_contact(m.person_kind, m.person_id) ct
                  where m.intake_id = g.intake_id and m.active and not m.sms_opt_out and ct.phone is not null),
    'lastMessage', (select jsonb_build_object('at', x.created_at, 'by', x.sender_name, 'text', left(coalesce(x.subject, x.body), 80))
                      from public.intake_group_messages x where x.intake_id = g.intake_id order by x.created_at desc limit 1))
  from public.course_intakes i join public.cms_courses c on c.id = i.course_id where i.id = g.intake_id;
$$;

-- list | get {intakeId} | send {intakeId, channels, subject, body, people?} | trainer_add / trainer_remove {intakeId, staffId}
-- | settings {intakeId, smsEnabled?, welcomeEnabled?, whatsappLink?} | member {intakeId, kind, id, whatsappJoined?, smsOptOut?}
-- | invite {intakeId, people?} | close / reopen {intakeId}
create or replace function public.intake_group(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_intake uuid := nullif(p_data->>'intakeId', '')::uuid; g public.intake_groups; v_channels text[]; v_n int; v_old_link text;
begin
  if p_action = 'list' then
    if not public.intake_group_can_manage() then raise exception 'Only Admins and RTO Managers can see the groups.' using errcode = '42501'; end if;
    return coalesce((select jsonb_agg(public.intake_group_row(g2) order by i.start_date desc)
                       from public.intake_groups g2 join public.course_intakes i on i.id = g2.intake_id), '[]'::jsonb);
  end if;

  if v_intake is null then raise exception 'Choose an intake.' using errcode = '22023'; end if;
  perform public.intake_group_ensure(v_intake);
  select * into g from public.intake_groups where intake_id = v_intake;
  if g.intake_id is null then raise exception 'Intake not found.' using errcode = 'P0002'; end if;
  if not public.intake_group_can_send(v_intake) then raise exception 'You cannot see this group.' using errcode = '42501'; end if;

  if p_action = 'send' then
    select array_agg(distinct x) into v_channels from jsonb_array_elements_text(coalesce(p_data->'channels', '[]'::jsonb)) x where x in ('email', 'sms');
    if v_channels is null then raise exception 'Choose email and / or text.' using errcode = '22023'; end if;
    if char_length(btrim(coalesce(p_data->>'body', ''))) = 0 then raise exception 'Write the message.' using errcode = '22023'; end if;
    if g.status <> 'active' then raise exception 'This group is closed.' using errcode = '23514'; end if;
    perform public.intake_group_queue(v_intake, 'message', v_channels, nullif(btrim(p_data->>'subject'), ''), btrim(p_data->>'body'),
      case when jsonb_typeof(p_data->'people') = 'array' and jsonb_array_length(p_data->'people') > 0 then p_data->'people' end);
  elsif p_action <> 'get' then
    if not public.intake_group_can_manage() then raise exception 'Only Admins and RTO Managers can change the group.' using errcode = '42501'; end if;
    if p_action = 'trainer_add' then
      if not exists (select 1 from hr.staff_profiles where id = (p_data->>'staffId')::uuid and status = 'active') then
        raise exception 'Choose an active staff member.' using errcode = '22023';
      end if;
      insert into public.intake_group_members(intake_id, person_kind, person_id) values (v_intake, 'staff', (p_data->>'staffId')::uuid)
      on conflict (intake_id, person_kind, person_id) do update set active = true, removed_at = null,
        m365_status = case when intake_group_members.m365_status = 'member' then 'member' else 'pending' end;
      perform public.intake_group_invite(v_intake, jsonb_build_array(jsonb_build_object('kind', 'staff', 'id', (p_data->>'staffId')::uuid)));
    elsif p_action = 'trainer_remove' then
      update public.intake_group_members set active = false, removed_at = now()
       where intake_id = v_intake and person_kind = 'staff' and person_id = (p_data->>'staffId')::uuid;
    elsif p_action = 'settings' then
      v_old_link := g.whatsapp_invite_link;
      update public.intake_groups set
        sms_enabled = coalesce((p_data->>'smsEnabled')::boolean, sms_enabled),
        welcome_enabled = coalesce((p_data->>'welcomeEnabled')::boolean, welcome_enabled),
        whatsapp_invite_link = case when p_data ? 'whatsappLink' then nullif(btrim(p_data->>'whatsappLink'), '') else whatsapp_invite_link end
       where intake_id = v_intake returning * into g;
      -- A new WhatsApp link goes to everyone who has not joined.
      if g.whatsapp_invite_link is not null and g.whatsapp_invite_link is distinct from v_old_link then
        update public.intake_group_members set whatsapp_invited_at = null where intake_id = v_intake and not whatsapp_joined;
        perform public.intake_group_invite(v_intake, null, true);
      end if;
    elsif p_action = 'member' then
      update public.intake_group_members set
        whatsapp_joined = coalesce((p_data->>'whatsappJoined')::boolean, whatsapp_joined),
        sms_opt_out = coalesce((p_data->>'smsOptOut')::boolean, sms_opt_out)
       where intake_id = v_intake and person_kind = p_data->>'kind' and person_id = (p_data->>'id')::uuid;
    elsif p_action = 'invite' then
      if g.whatsapp_invite_link is null then raise exception 'Add the WhatsApp group link first.' using errcode = '23514'; end if;
      v_n := public.intake_group_invite(v_intake, case when jsonb_typeof(p_data->'people') = 'array' then p_data->'people' end, true);
    elsif p_action = 'close' then
      update public.intake_groups set status = 'closed', closed_at = now() where intake_id = v_intake;
    elsif p_action = 'reopen' then
      update public.intake_groups set status = 'active', closed_at = null where intake_id = v_intake;
    else
      raise exception 'Unknown action %', p_action using errcode = '22023';
    end if;
  end if;

  select * into g from public.intake_groups where intake_id = v_intake;
  return public.intake_group_row(g) || jsonb_build_object(
    'canManage', public.intake_group_can_manage(),
    'members', coalesce((select jsonb_agg(jsonb_build_object('kind', m.person_kind, 'id', m.person_id, 'name', ct.name, 'email', ct.email,
        'phone', ct.phone, 'm365Status', m.m365_status, 'm365Error', m.m365_error, 'whatsappInvitedAt', m.whatsapp_invited_at,
        'whatsappJoined', m.whatsapp_joined, 'smsOptOut', m.sms_opt_out, 'addedAt', m.added_at)
        order by m.person_kind desc, ct.name)
      from public.intake_group_members m cross join lateral public.intake_group_contact(m.person_kind, m.person_id) ct
      where m.intake_id = v_intake and m.active), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'at', x.created_at, 'by', x.sender_name,
        'channels', x.channels, 'subject', x.subject, 'body', x.body,
        'emailSent', (select count(*) from public.intake_group_deliveries d join public.notification_deliveries n on n.id = d.email_delivery_id
                       where d.message_id = x.id and n.state in ('sent', 'delivered')),
        'emailFailed', (select count(*) from public.intake_group_deliveries d join public.notification_deliveries n on n.id = d.email_delivery_id
                       where d.message_id = x.id and n.state in ('failed', 'bounced', 'suppressed', 'complained')),
        'emailQueued', (select count(*) from public.intake_group_deliveries d where d.message_id = x.id and d.channel = 'email' and d.status = 'queued'),
        'smsQueued', (select count(*) from public.intake_group_deliveries d where d.message_id = x.id and d.channel = 'sms' and d.status = 'queued'),
        'smsNotConnected', (select count(*) from public.intake_group_deliveries d where d.message_id = x.id and d.channel = 'sms' and d.status = 'not_connected'),
        'skipped', (select count(*) from public.intake_group_deliveries d where d.message_id = x.id and d.status = 'skipped'))
        order by x.created_at desc)
      from (select * from public.intake_group_messages where intake_id = v_intake order by created_at desc limit 50) x), '[]'::jsonb),
    'smsConnected', (public.comm_channel_secret('sms') is not null));
end $$;
revoke all on function public.intake_group(text, jsonb) from public, anon;
grant execute on function public.intake_group(text, jsonb) to authenticated;

-- Microsoft 365 sync for the intake-groups Edge Function (service role only): what to do, then what happened.
create or replace function public.intake_group_m365_work(p_intake uuid default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('intakeId', g.intake_id, 'groupId', g.m365_group_id, 'mailNickname', g.mail_nickname,
      'displayName', public.intake_group_title(g.intake_id), 'closed', g.status = 'closed',
      'members', coalesce((select jsonb_agg(jsonb_build_object('kind', m.person_kind, 'id', m.person_id, 'active', m.active and g.status = 'active',
          'status', m.m365_status, 'msUserId', m.m365_user_id,
          'upn', case when m.person_kind = 'student' then (select a.upn from public.student_office365_accounts a where a.student_id = m.person_id and a.status = 'active') end,
          'studentMsUserId', case when m.person_kind = 'student' then (select a.ms_user_id from public.student_office365_accounts a where a.student_id = m.person_id and a.status = 'active') end,
          'email', (select ct.email from public.intake_group_contact(m.person_kind, m.person_id) ct)))
        from public.intake_group_members m where m.intake_id = g.intake_id
          and ((m.active and g.status = 'active' and m.m365_status in ('pending', 'no_account', 'failed'))
               or ((not m.active or g.status = 'closed') and m.m365_status = 'member'))), '[]'::jsonb))), '[]'::jsonb)
  from public.intake_groups g
  where (p_intake is null or g.intake_id = p_intake)
    and (g.m365_group_id is null and g.status = 'active'
         or exists (select 1 from public.intake_group_members m where m.intake_id = g.intake_id
                     and ((m.active and g.status = 'active' and m.m365_status in ('pending', 'no_account', 'failed'))
                          or ((not m.active or g.status = 'closed') and m.m365_status = 'member'))));
$$;
revoke all on function public.intake_group_m365_work(uuid) from public, anon, authenticated;
grant execute on function public.intake_group_m365_work(uuid) to service_role;

-- {intakeId, groupId?, address?, groupStatus?, error?, members: [{kind, id, status, msUserId?, error?}]}
create or replace function public.intake_group_m365_record(p_data jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_intake uuid := (p_data->>'intakeId')::uuid; x jsonb;
begin
  update public.intake_groups set
    m365_group_id = coalesce(nullif(p_data->>'groupId', ''), m365_group_id),
    m365_address = coalesce(nullif(p_data->>'address', ''), m365_address),
    m365_status = coalesce(nullif(p_data->>'groupStatus', ''), m365_status),
    m365_error = case when p_data ? 'error' then nullif(p_data->>'error', '') else m365_error end,
    m365_synced_at = now()
   where intake_id = v_intake;
  for x in select * from jsonb_array_elements(coalesce(p_data->'members', '[]'::jsonb)) loop
    update public.intake_group_members set
      m365_status = x->>'status',
      m365_user_id = coalesce(nullif(x->>'msUserId', ''), m365_user_id),
      m365_error = nullif(x->>'error', '')
     where intake_id = v_intake and person_kind = x->>'kind' and person_id = (x->>'id')::uuid;
  end loop;
end $$;
revoke all on function public.intake_group_m365_record(jsonb) from public, anon, authenticated;
grant execute on function public.intake_group_m365_record(jsonb) to service_role;

-- Every 15 minutes the intake-groups function syncs the Microsoft 365 groups with work (same key and URL scheme as holiday-sync;
-- does nothing until the function is deployed and the URL resolves).
create or replace function public.intake_groups_dispatch() returns bigint
language plpgsql security definer set search_path = public, vault, net, pg_temp as $$
declare v_key text; v_url text;
begin
  if not pg_try_advisory_xact_lock(9342, 20261120) then return null; end if;
  if not exists (select 1 from public.intake_groups g where g.status = 'active' and (g.m365_group_id is null and g.m365_status <> 'not_configured'
                   or exists (select 1 from public.intake_group_members m where m.intake_id = g.intake_id and m.active and m.m365_status = 'pending'))
                 or exists (select 1 from public.intake_group_members m where not m.active and m.m365_status = 'member')) then
    return null;
  end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'hr_retention_service_role_key' limit 1;
  select regexp_replace(decrypted_secret, '/staff-admin$', '/intake-groups') into v_url from vault.decrypted_secrets where name = 'hr_retention_function_url' limit 1;
  if nullif(v_key, '') is null or nullif(v_url, '') is null or v_url !~ '^https?://[^/]+/functions/v1/intake-groups$' then return null; end if;
  return public.cron_http_post('intake-groups', url := v_url, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{}'::jsonb, timeout_milliseconds := 55000);
end $$;
revoke all on function public.intake_groups_dispatch() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from cron.job where jobname = 'intake-groups') then perform cron.unschedule('intake-groups'); end if;
  perform cron.schedule('intake-groups', '*/15 * * * *', 'select public.intake_groups_dispatch();');
end $$;

insert into supabase_migrations.schema_migrations(version, name, statements)
  values ('20261120172941', 'intake_groups', array['see repo file']) on conflict do nothing;
commit;
