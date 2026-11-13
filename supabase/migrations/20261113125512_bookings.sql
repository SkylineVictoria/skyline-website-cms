-- BOOK-01: in-house meeting bookings (a Calendly-like module, no outside service). Any active staff member, agent or student can
-- become a host: weekly hours, time off, meeting types and a booking page at /book/<handle>. Anyone with the link (signed in
-- or not) picks a free slot; a meeting type can ask for a sign-in. Free slots leave out existing bookings (with the type's
-- buffer), the host's time off and, for staff, approved leave and confirmed public holidays. Confirmation, change, cancel
-- and 24-hour reminder emails go through notification_deliveries (sent by email-sender); the reminder is queued at booking
-- time with a later next_attempt_at, so no new cron job. A booking is managed without a login through a one-time token in
-- the email link (only its SHA-256 is stored). Every table is RLS-closed; all access is through the functions below.

create table if not exists public.booking_hosts (
 user_id uuid primary key references auth.users(id) on delete cascade,
 handle text not null unique check (handle ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
 display_name text not null check (char_length(display_name) between 2 and 100),
 email text not null,
 kind text not null default 'other' check (kind in ('staff', 'agent', 'student', 'other')),
 headline text not null default '' check (char_length(headline) <= 300),
 timezone text not null default 'Australia/Melbourne',
 is_enabled boolean not null default true,
 is_listed boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists public.booking_availability (
 id bigint generated always as identity primary key,
 user_id uuid not null references public.booking_hosts(user_id) on delete cascade,
 weekday smallint not null check (weekday between 0 and 6),
 start_time time not null,
 end_time time not null,
 check (start_time < end_time)
);
create index if not exists booking_availability_user_idx on public.booking_availability(user_id);
create table if not exists public.booking_time_off (
 id bigint generated always as identity primary key,
 user_id uuid not null references public.booking_hosts(user_id) on delete cascade,
 start_date date not null,
 end_date date not null,
 note text not null default '' check (char_length(note) <= 200),
 check (end_date >= start_date)
);
create index if not exists booking_time_off_user_idx on public.booking_time_off(user_id);
create table if not exists public.booking_types (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.booking_hosts(user_id) on delete cascade,
 slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$'),
 name text not null check (char_length(name) between 2 and 100),
 description text not null default '' check (char_length(description) <= 1000),
 duration_min integer not null check (duration_min between 5 and 480),
 location_kind text not null check (location_kind in ('phone', 'video', 'in_person', 'teams')),
 location_detail text not null default '' check (char_length(location_detail) <= 500),
 location_id uuid references hr.locations(id) on delete set null,
 buffer_min integer not null default 0 check (buffer_min between 0 and 120),
 min_notice_hours integer not null default 4 check (min_notice_hours between 0 and 720),
 max_days_ahead integer not null default 60 check (max_days_ahead between 1 and 365),
 requires_login boolean not null default false,
 is_active boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (user_id, slug)
);
create table if not exists public.bookings (
 id uuid primary key default gen_random_uuid(),
 type_id uuid not null references public.booking_types(id) on delete cascade,
 host_user uuid not null references auth.users(id) on delete cascade,
 starts_at timestamptz not null,
 ends_at timestamptz not null,
 status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
 booker_user uuid references auth.users(id) on delete set null,
 booker_name text not null check (char_length(booker_name) between 2 and 100),
 booker_email text not null check (char_length(booker_email) <= 254),
 booker_phone text not null default '' check (char_length(booker_phone) <= 40),
 booker_timezone text not null default 'Australia/Melbourne',
 note text not null default '' check (char_length(note) <= 1000),
 type_name text not null,
 location_text text not null default '',
 token_hash text not null unique,
 cancelled_at timestamptz,
 cancelled_by text check (cancelled_by in ('host', 'booker')),
 cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 500),
 reschedule_count integer not null default 0,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (ends_at > starts_at)
);
create index if not exists bookings_host_idx on public.bookings(host_user, starts_at) where status = 'confirmed';
create index if not exists bookings_booker_idx on public.bookings(booker_user);
create index if not exists bookings_booker_email_idx on public.bookings(lower(booker_email));

alter table public.booking_hosts enable row level security;
alter table public.booking_availability enable row level security;
alter table public.booking_time_off enable row level security;
alter table public.booking_types enable row level security;
alter table public.bookings enable row level security;
revoke all on public.booking_hosts, public.booking_availability, public.booking_time_off, public.booking_types, public.bookings from anon, authenticated;

-- Booking emails ride the existing queue: a delivery may now belong to a booking instead of an application or a ticket.
alter table public.notification_deliveries add column if not exists booking_id uuid references public.bookings(id) on delete set null;
create index if not exists notification_deliveries_booking_idx on public.notification_deliveries(booking_id) where booking_id is not null;
alter table public.notification_deliveries drop constraint if exists notification_deliveries_subject_ref;
alter table public.notification_deliveries add constraint notification_deliveries_subject_ref
 check (application_id is not null or support_ticket_id is not null or booking_id is not null or event like 'support_ticket%') not valid;

-- ------------------------------------------------------------------ helpers (never callable from the API)

-- Who a login is: an active staff member / CMS user, an agent or a student. 'other' may book but not host.
create or replace function public.booking_identity(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, auth as $f$
declare v_email text; v_name text; v_kind text := 'other'; v_role text;
begin
 select lower(btrim(coalesce(u.email, ''))) into v_email from auth.users u where u.id = p_user and u.email_confirmed_at is not null;
 if v_email is null then return null; end if;
 select nullif(btrim(concat_ws(' ', s.first_name, s.last_name)), '') into v_name from hr.staff_profiles s where s.auth_user_id = p_user and s.status = 'active' limit 1;
 if v_name is not null then v_kind := 'staff'; end if;
 if v_kind = 'other' then
  select nullif(btrim(c.name), '') into v_name from public.cms_users c where c.auth_user_id = p_user and c.status = 'Active' limit 1;
  if found then v_kind := 'staff'; end if;
 end if;
 if v_kind = 'other' then
  select nullif(btrim(p.full_name), ''), m.role into v_name, v_role from public.portal_profiles p join public.agency_memberships m on m.user_id = p.id
   where p.auth_user_id = p_user and p.status = 'Active' and m.status = 'Active' order by m.created_at limit 1;
  if found then v_kind := case when v_role = 'student' then 'student' else 'agent' end; end if;
 end if;
 return jsonb_build_object('name', coalesce(v_name, split_part(v_email, '@', 1)), 'email', v_email, 'kind', v_kind);
end $f$;

create or replace function public.booking_when(p_at timestamptz, p_tz text) returns text
language sql stable set search_path = pg_catalog as $f$
 select to_char(p_at at time zone p_tz, 'FMDay, FMDD FMMonth YYYY "at" FMHH12:MI am') || ' (' || replace(p_tz, '_', ' ') || ' time)';
$f$;

create or replace function public.booking_location_text(t public.booking_types) returns text
language sql stable security definer set search_path = public, hr as $f$
 select case t.location_kind
  when 'phone' then 'Phone call' || case when btrim(t.location_detail) <> '' then ': ' || btrim(t.location_detail) else '' end
  when 'video' then 'Video call' || case when btrim(t.location_detail) <> '' then ': ' || btrim(t.location_detail) else '' end
  when 'in_person' then 'In person' || coalesce(': ' || (select l.name || case when btrim(coalesce(l.address, '')) <> '' then ', ' || l.address else '' end from hr.locations l where l.id = t.location_id),
   case when btrim(t.location_detail) <> '' then ': ' || btrim(t.location_detail) else '' end)
  else 'Microsoft Teams' end;
$f$;

-- Free start times of one meeting type between two dates (host's calendar days). p_ignore: the booking being moved.
create or replace function public.booking_free_slots(t public.booking_types, h public.booking_hosts, p_from date, p_to date, p_ignore uuid default null)
returns setof timestamptz language sql stable security definer set search_path = public, hr as $f$
 select distinct x.s
 from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
 join public.booking_availability a on a.user_id = h.user_id and a.weekday = extract(dow from d)::int
 cross join lateral generate_series(d::date + a.start_time, d::date + a.end_time - make_interval(mins => t.duration_min),
  make_interval(mins => case when t.duration_min <= 30 then t.duration_min else 30 end)) local_ts
 cross join lateral (select local_ts at time zone h.timezone as s) x
 where x.s >= now() + make_interval(hours => t.min_notice_hours)
  and d::date <= (now() at time zone h.timezone)::date + t.max_days_ahead
  and not exists (select 1 from public.booking_time_off o where o.user_id = h.user_id and d::date between o.start_date and o.end_date)
  and not exists (select 1 from hr.staff_profiles sp where sp.auth_user_id = h.user_id and (
       exists (select 1 from hr.public_holidays ph where ph.holiday_date = d::date and ph.status = 'confirmed' and not ph.is_optional)
    or exists (select 1 from hr.leave_requests lr where lr.profile_id = sp.id and lr.status = 'approved' and d::date between lr.start_date and lr.end_date)))
  and not exists (select 1 from public.bookings b where b.host_user = h.user_id and b.status = 'confirmed' and b.id is distinct from p_ignore
       and b.starts_at < x.s + make_interval(mins => t.duration_min + t.buffer_min) and b.ends_at > x.s - make_interval(mins => t.buffer_min))
 order by 1;
$f$;

create or replace function public.booking_mail(p_booking uuid, p_to text, p_event text, p_subject text, p_body text, p_at timestamptz default now()) returns void
language plpgsql security definer set search_path = public as $f$
begin
 if coalesce(p_to, '') !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then return; end if;
 insert into public.notification_deliveries(recipient_email, event, template_source, subject, body, booking_id, next_attempt_at)
 values (lower(p_to), p_event, 'default', left(p_subject, 200), p_body, p_booking, greatest(p_at, now()));
end $f$;

-- Queues the emails for a booking event ('created', 'rescheduled', 'cancelled'); p_token only on creation (the manage link).
create or replace function public.booking_notify(b public.bookings, p_event text, p_token text default null) returns void
language plpgsql security definer set search_path = public as $f$
declare h public.booking_hosts; v_origin text := public.support_site_origin(); v_booker_when text; v_host_when text; v_what text; v_manage text; v_details text;
begin
 select * into h from public.booking_hosts where user_id = b.host_user;
 v_booker_when := public.booking_when(b.starts_at, b.booker_timezone);
 v_host_when := public.booking_when(b.starts_at, h.timezone);
 v_what := b.type_name || ' with ' || h.display_name;
 v_manage := case when p_token is not null then E'\n\nChange or cancel this booking: ' || v_origin || '/booking#t=' || p_token else '' end;
 v_details := E'\nWhere: ' || b.location_text || case when b.note <> '' then E'\nNote: ' || b.note else '' end;
 -- Reminders of an earlier time or a cancelled meeting never go out.
 update public.notification_deliveries set state = 'suppressed', state_reason = 'booking changed', updated_at = now()
  where booking_id = b.id and event = 'booking_reminder' and state = 'pending';
 if p_event = 'cancelled' then
  perform public.booking_mail(b.id, b.booker_email, 'booking_cancelled', 'Cancelled: ' || v_what,
   'Hello ' || b.booker_name || E',\n\nYour booking was cancelled' || case when b.cancelled_by = 'host' then ' by ' || h.display_name else '' end || E'.\n\nWhat: ' || v_what || E'\nWhen: ' || v_booker_when
   || case when coalesce(b.cancel_reason, '') <> '' then E'\nReason: ' || b.cancel_reason else '' end || E'\n\nBook another time: ' || v_origin || '/book/' || h.handle);
  perform public.booking_mail(b.id, h.email, 'booking_cancelled', 'Cancelled: ' || b.type_name || ' with ' || b.booker_name,
   'Hello ' || h.display_name || E',\n\nThis booking was cancelled' || case when b.cancelled_by = 'booker' then ' by ' || b.booker_name else '' end || E'.\n\nWhat: ' || b.type_name || E'\nWho: ' || b.booker_name || ' (' || b.booker_email || E')\nWhen: ' || v_host_when
   || case when coalesce(b.cancel_reason, '') <> '' then E'\nReason: ' || b.cancel_reason else '' end || E'\n\nView your bookings: ' || v_origin || '/bookings');
  return;
 end if;
 perform public.booking_mail(b.id, b.booker_email, 'booking_' || p_event, case when p_event = 'created' then 'Confirmed: ' else 'New time: ' end || v_what,
  'Hello ' || b.booker_name || E',\n\n' || case when p_event = 'created' then 'Your booking is confirmed.' else 'Your booking has a new time.' end
  || E'\n\nWhat: ' || v_what || E'\nWhen: ' || v_booker_when || v_details || coalesce(v_manage, ''));
 perform public.booking_mail(b.id, h.email, 'booking_' || p_event, case when p_event = 'created' then 'New booking: ' else 'New time: ' end || b.type_name || ' with ' || b.booker_name,
  'Hello ' || h.display_name || E',\n\n' || b.booker_name || case when p_event = 'created' then ' booked a time with you.' else '''s booking has a new time.' end
  || E'\n\nWhat: ' || b.type_name || E'\nWho: ' || b.booker_name || ' (' || b.booker_email || ')' || case when b.booker_phone <> '' then ', ' || b.booker_phone else '' end
  || E'\nWhen: ' || v_host_when || v_details || E'\n\nView your bookings: ' || v_origin || '/bookings');
 if b.starts_at > now() + interval '25 hours' then
  perform public.booking_mail(b.id, b.booker_email, 'booking_reminder', 'Reminder: ' || v_what,
   'Hello ' || b.booker_name || E',\n\nA reminder of your booking tomorrow.\n\nWhat: ' || v_what || E'\nWhen: ' || v_booker_when || v_details, b.starts_at - interval '24 hours');
  perform public.booking_mail(b.id, h.email, 'booking_reminder', 'Reminder: ' || b.type_name || ' with ' || b.booker_name,
   'Hello ' || h.display_name || E',\n\nA reminder of your booking tomorrow.\n\nWhat: ' || b.type_name || E'\nWho: ' || b.booker_name || ' (' || b.booker_email || E')\nWhen: ' || v_host_when || v_details,
   b.starts_at - interval '24 hours');
 end if;
end $f$;

create or replace function public.booking_row(b public.bookings, p_side text) returns jsonb
language sql stable security definer set search_path = public as $f$
 select jsonb_build_object('id', b.id, 'status', b.status, 'startsAt', b.starts_at, 'endsAt', b.ends_at, 'typeName', b.type_name, 'location', b.location_text,
  'note', b.note, 'bookerName', b.booker_name, 'bookerEmail', case when p_side = 'host' then b.booker_email end, 'bookerPhone', case when p_side = 'host' then b.booker_phone end,
  'hostName', h.display_name, 'hostHandle', h.handle, 'hostTimezone', h.timezone, 'typeSlug', t.slug, 'cancelledBy', b.cancelled_by, 'cancelReason', b.cancel_reason,
  'side', p_side)
 from public.booking_hosts h, public.booking_types t where h.user_id = b.host_user and t.id = b.type_id;
$f$;

revoke all on function public.booking_identity(uuid), public.booking_when(timestamptz, text), public.booking_location_text(public.booking_types),
 public.booking_free_slots(public.booking_types, public.booking_hosts, date, date, uuid), public.booking_mail(uuid, text, text, text, text, timestamptz),
 public.booking_notify(public.bookings, text, text), public.booking_row(public.bookings, text) from public, anon, authenticated;

-- ------------------------------------------------------------------ signed-in: my booking page

create or replace function public.booking_me() returns jsonb
language plpgsql stable security definer set search_path = public, hr as $f$
declare v_uid uuid := auth.uid(); v_id jsonb; h public.booking_hosts;
begin
 if v_uid is null then raise exception 'Sign in to use bookings.' using errcode = '42501'; end if;
 v_id := public.booking_identity(v_uid);
 if v_id is null then raise exception 'Confirm your email first.' using errcode = '42501'; end if;
 select * into h from public.booking_hosts where user_id = v_uid;
 return jsonb_build_object('identity', v_id, 'origin', public.support_site_origin(),
  'host', case when h.user_id is null then null else jsonb_build_object('handle', h.handle, 'displayName', h.display_name, 'headline', h.headline, 'timezone', h.timezone,
   'enabled', h.is_enabled, 'listed', h.is_listed) end,
  'availability', coalesce((select jsonb_agg(jsonb_build_object('weekday', a.weekday, 'start', to_char(a.start_time, 'HH24:MI'), 'end', to_char(a.end_time, 'HH24:MI')) order by a.weekday, a.start_time)
   from public.booking_availability a where a.user_id = v_uid), '[]'::jsonb),
  'timeOff', coalesce((select jsonb_agg(jsonb_build_object('start', o.start_date, 'end', o.end_date, 'note', o.note) order by o.start_date)
   from public.booking_time_off o where o.user_id = v_uid and o.end_date >= current_date - 1), '[]'::jsonb),
  'types', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'slug', t.slug, 'name', t.name, 'description', t.description, 'duration', t.duration_min,
    'locationKind', t.location_kind, 'locationDetail', t.location_detail, 'locationId', t.location_id, 'buffer', t.buffer_min, 'minNoticeHours', t.min_notice_hours,
    'maxDaysAhead', t.max_days_ahead, 'requiresLogin', t.requires_login, 'active', t.is_active) order by t.created_at)
   from public.booking_types t where t.user_id = v_uid), '[]'::jsonb),
  'locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'address', l.address) order by l.name) from hr.locations l where l.is_active), '[]'::jsonb),
  'bookings', coalesce((select jsonb_agg(x.row order by x.at) from (
    select public.booking_row(b, 'host') as row, b.starts_at as at from public.bookings b where b.host_user = v_uid and b.starts_at > now() - interval '30 days'
    union all
    select public.booking_row(b, 'booker'), b.starts_at from public.bookings b
     where b.host_user <> v_uid and (b.booker_user = v_uid or lower(b.booker_email) = v_id->>'email') and b.starts_at > now() - interval '30 days') x), '[]'::jsonb));
end $f$;

create or replace function public.booking_host_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $f$
declare v_uid uuid := auth.uid(); v_id jsonb; v_handle text := lower(btrim(coalesce(p->>'handle', ''))); v_name text := btrim(coalesce(p->>'displayName', ''));
 v_tz text := btrim(coalesce(p->>'timezone', '')); r jsonb; v_n integer := 0;
begin
 if v_uid is null then raise exception 'Sign in to use bookings.' using errcode = '42501'; end if;
 v_id := public.booking_identity(v_uid);
 if v_id is null or v_id->>'kind' = 'other' then raise exception 'Only active staff, agents and students can offer bookings.' using errcode = '42501'; end if;
 if v_handle !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' then raise exception 'The link name needs 3 to 40 lowercase letters, numbers or hyphens.' using errcode = '22023'; end if;
 if v_name ~ '[[:cntrl:]]' or char_length(v_name) not between 2 and 100 then raise exception 'Enter the name people will see (2 to 100 characters).' using errcode = '22023'; end if;
 if not exists (select 1 from pg_timezone_names where name = v_tz) then raise exception 'Choose a time zone.' using errcode = '22023'; end if;
 if exists (select 1 from public.booking_hosts where handle = v_handle and user_id <> v_uid) then raise exception 'That link name is taken. Choose another.' using errcode = '23505'; end if;
 insert into public.booking_hosts(user_id, handle, display_name, email, kind, headline, timezone, is_enabled, is_listed)
 values (v_uid, v_handle, v_name, v_id->>'email', v_id->>'kind', left(btrim(coalesce(p->>'headline', '')), 300), v_tz, coalesce((p->>'enabled')::boolean, true), coalesce((p->>'listed')::boolean, false))
 on conflict (user_id) do update set handle = excluded.handle, display_name = excluded.display_name, email = excluded.email, kind = excluded.kind, headline = excluded.headline,
  timezone = excluded.timezone, is_enabled = excluded.is_enabled, is_listed = excluded.is_listed, updated_at = now();
 if p ? 'availability' then
  delete from public.booking_availability where user_id = v_uid;
  for r in select * from jsonb_array_elements(coalesce(p->'availability', '[]'::jsonb)) loop
   v_n := v_n + 1;
   if v_n > 42 then raise exception 'Too many availability rows.' using errcode = '22023'; end if;
   begin
    insert into public.booking_availability(user_id, weekday, start_time, end_time) values (v_uid, (r->>'weekday')::smallint, (r->>'start')::time, (r->>'end')::time);
   exception when check_violation or not_null_violation or invalid_datetime_format or datetime_field_overflow or invalid_text_representation then
    raise exception 'Each available time needs a start before its end.' using errcode = '22023';
   end;
  end loop;
 end if;
 if p ? 'timeOff' then
  delete from public.booking_time_off where user_id = v_uid;
  v_n := 0;
  for r in select * from jsonb_array_elements(coalesce(p->'timeOff', '[]'::jsonb)) loop
   v_n := v_n + 1;
   if v_n > 50 then raise exception 'Too many time-off rows.' using errcode = '22023'; end if;
   begin
    insert into public.booking_time_off(user_id, start_date, end_date, note) values (v_uid, (r->>'start')::date, (r->>'end')::date, left(btrim(coalesce(r->>'note', '')), 200));
   exception when check_violation or not_null_violation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'Each time off needs a first day on or before its last day.' using errcode = '22023';
   end;
  end loop;
 end if;
 return public.booking_me();
end $f$;

create or replace function public.booking_type_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr as $f$
declare v_uid uuid := auth.uid(); v_id uuid := nullif(p->>'id', '')::uuid; v_name text := btrim(coalesce(p->>'name', '')); v_kind text := coalesce(p->>'locationKind', '');
 v_slug text := lower(btrim(coalesce(p->>'slug', ''))); v_detail text := btrim(coalesce(p->>'locationDetail', '')); v_loc uuid := nullif(p->>'locationId', '')::uuid; v_base text; v_i integer := 1;
begin
 if v_uid is null or not exists (select 1 from public.booking_hosts where user_id = v_uid) then raise exception 'Set up your booking page first.' using errcode = '42501'; end if;
 if v_name ~ '[[:cntrl:]]' or char_length(v_name) not between 2 and 100 then raise exception 'Name the meeting (2 to 100 characters).' using errcode = '22023'; end if;
 if v_kind = 'teams' then raise exception 'Automatic Teams links need the Microsoft 365 connection, which is not set up yet. Choose Video call and paste your meeting link for now.' using errcode = '22023'; end if;
 if v_kind not in ('phone', 'video', 'in_person') then raise exception 'Choose where the meeting happens.' using errcode = '22023'; end if;
 if v_kind = 'video' and v_detail !~ '^https://[^\s<>"]+$' then raise exception 'Paste the video meeting link (it starts with https://).' using errcode = '22023'; end if;
 if v_kind = 'in_person' then
  if v_loc is not null and not exists (select 1 from hr.locations where id = v_loc and is_active) then raise exception 'Choose a location.' using errcode = '22023'; end if;
  if v_loc is null and v_detail = '' then raise exception 'Choose a location or type the address.' using errcode = '22023'; end if;
 else v_loc := null; end if;
 if v_detail ~ '[[:cntrl:]]' then raise exception 'The location has characters that are not allowed.' using errcode = '22023'; end if;
 if v_slug = '' then v_slug := btrim(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), '-'); end if;
 v_slug := left(v_slug, 50);
 if v_slug !~ '^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$' then v_slug := 'meeting'; end if;
 v_base := left(v_slug, 46);
 while exists (select 1 from public.booking_types where user_id = v_uid and slug = v_slug and id is distinct from v_id) loop
  v_i := v_i + 1; v_slug := v_base || '-' || v_i;
 end loop;
 if v_id is null then
  if (select count(*) from public.booking_types where user_id = v_uid) >= 20 then raise exception 'You can have up to 20 meeting types.' using errcode = '22023'; end if;
  insert into public.booking_types(user_id, slug, name, description, duration_min, location_kind, location_detail, location_id, buffer_min, min_notice_hours, max_days_ahead, requires_login, is_active)
  values (v_uid, v_slug, v_name, left(btrim(coalesce(p->>'description', '')), 1000), coalesce((p->>'duration')::integer, 30), v_kind, v_detail, v_loc, coalesce((p->>'buffer')::integer, 0),
   coalesce((p->>'minNoticeHours')::integer, 4), coalesce((p->>'maxDaysAhead')::integer, 60), coalesce((p->>'requiresLogin')::boolean, false), coalesce((p->>'active')::boolean, true));
 else
  update public.booking_types set slug = v_slug, name = v_name, description = left(btrim(coalesce(p->>'description', '')), 1000), duration_min = coalesce((p->>'duration')::integer, duration_min),
   location_kind = v_kind, location_detail = v_detail, location_id = v_loc, buffer_min = coalesce((p->>'buffer')::integer, buffer_min),
   min_notice_hours = coalesce((p->>'minNoticeHours')::integer, min_notice_hours), max_days_ahead = coalesce((p->>'maxDaysAhead')::integer, max_days_ahead),
   requires_login = coalesce((p->>'requiresLogin')::boolean, requires_login), is_active = coalesce((p->>'active')::boolean, is_active), updated_at = now()
  where id = v_id and user_id = v_uid;
  if not found then raise exception 'Meeting type not found.' using errcode = 'P0002'; end if;
 end if;
 return public.booking_me();
exception when check_violation or invalid_text_representation or numeric_value_out_of_range then
 raise exception 'Check the length (5 to 480 minutes), buffer (0 to 120), notice (0 to 720 hours) and booking window (1 to 365 days).' using errcode = '22023';
end $f$;

-- A type with bookings is switched off (its bookings stay); one without is deleted.
create or replace function public.booking_type_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $f$
declare v_uid uuid := auth.uid();
begin
 if v_uid is null then raise exception 'Sign in to use bookings.' using errcode = '42501'; end if;
 if exists (select 1 from public.bookings b join public.booking_types t on t.id = b.type_id where t.id = p_id and t.user_id = v_uid) then
  update public.booking_types set is_active = false, updated_at = now() where id = p_id and user_id = v_uid;
 else
  delete from public.booking_types where id = p_id and user_id = v_uid;
 end if;
 return public.booking_me();
end $f$;

-- People who chose to be listed, for "Book someone".
create or replace function public.booking_directory(p_search text default '') returns jsonb
language plpgsql stable security definer set search_path = public as $f$
declare q text := '%' || replace(replace(lower(btrim(coalesce(p_search, ''))), '%', ''), '_', '') || '%';
begin
 if auth.uid() is null then raise exception 'Sign in to use bookings.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('handle', h.handle, 'name', h.display_name, 'kind', h.kind, 'headline', h.headline) order by h.display_name)
  from (select * from public.booking_hosts h where h.is_enabled and h.is_listed and h.user_id <> auth.uid() and (lower(h.display_name) like q or lower(h.headline) like q)
   and exists (select 1 from public.booking_types t where t.user_id = h.user_id and t.is_active)
   and exists (select 1 from public.booking_availability a where a.user_id = h.user_id) order by h.display_name limit 100) h), '[]'::jsonb);
end $f$;

-- ------------------------------------------------------------------ anyone with the link

create or replace function public.booking_public_host(p_handle text) returns jsonb
language plpgsql stable security definer set search_path = public as $f$
declare h public.booking_hosts;
begin
 select * into h from public.booking_hosts where handle = lower(btrim(coalesce(p_handle, ''))) and is_enabled;
 if not found then return null; end if;
 return jsonb_build_object('handle', h.handle, 'name', h.display_name, 'headline', h.headline, 'timezone', h.timezone, 'kind', h.kind, 'isSelf', h.user_id = auth.uid(),
  'signedIn', auth.uid() is not null,
  'viewer', case when auth.uid() is not null then public.booking_identity(auth.uid()) end,
  'types', coalesce((select jsonb_agg(jsonb_build_object('slug', t.slug, 'name', t.name, 'description', t.description, 'duration', t.duration_min,
    'location', public.booking_location_text(t), 'requiresLogin', t.requires_login) order by t.duration_min, t.name)
   from public.booking_types t where t.user_id = h.user_id and t.is_active), '[]'::jsonb));
end $f$;

create or replace function public.booking_slots(p_handle text, p_type text, p_from date, p_days integer default 31, p_token text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $f$
declare h public.booking_hosts; t public.booking_types; v_ignore uuid; v_from date;
begin
 select * into h from public.booking_hosts where handle = lower(btrim(coalesce(p_handle, ''))) and is_enabled;
 if not found then return '[]'::jsonb; end if;
 select * into t from public.booking_types where user_id = h.user_id and slug = lower(btrim(coalesce(p_type, ''))) and is_active;
 if not found then return '[]'::jsonb; end if;
 if p_token is not null then select id into v_ignore from public.bookings where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex'); end if;
 v_from := greatest(coalesce(p_from, current_date), (now() at time zone h.timezone)::date - 1);
 return coalesce((select jsonb_agg(s order by s) from public.booking_free_slots(t, h, v_from, v_from + least(greatest(coalesce(p_days, 31), 1), 62), v_ignore) s), '[]'::jsonb);
end $f$;

create or replace function public.booking_create(p_handle text, p_type text, p_start timestamptz, p_name text default null, p_email text default null,
 p_phone text default '', p_note text default '', p_timezone text default null) returns jsonb
language plpgsql security definer set search_path = public as $f$
declare v_uid uuid := auth.uid(); h public.booking_hosts; t public.booking_types; b public.bookings; v_id jsonb; v_day date;
 v_name text := btrim(coalesce(p_name, '')); v_email text := lower(btrim(coalesce(p_email, ''))); v_phone text := btrim(coalesce(p_phone, '')); v_note text := btrim(coalesce(p_note, ''));
 v_tz text; v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
 select * into h from public.booking_hosts where handle = lower(btrim(coalesce(p_handle, ''))) and is_enabled;
 if not found then raise exception 'This booking page is not available.' using errcode = 'P0002'; end if;
 select * into t from public.booking_types where user_id = h.user_id and slug = lower(btrim(coalesce(p_type, ''))) and is_active;
 if not found then raise exception 'This meeting type is not available.' using errcode = 'P0002'; end if;
 if v_uid = h.user_id then raise exception 'This is your own booking page.' using errcode = '22023'; end if;
 if t.requires_login and v_uid is null then raise exception 'Sign in to book this meeting.' using errcode = '42501'; end if;
 if v_uid is not null then
  v_id := public.booking_identity(v_uid);
  if v_id is null then raise exception 'Confirm your email first.' using errcode = '42501'; end if;
  v_email := v_id->>'email';
  if v_name = '' then v_name := v_id->>'name'; end if;
 end if;
 if v_name ~ '[[:cntrl:]]' or char_length(v_name) not between 2 and 100 then raise exception 'Enter your name (2 to 100 characters).' using errcode = '22023'; end if;
 if char_length(v_email) > 254 or v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then raise exception 'Enter a valid email address.' using errcode = '22023'; end if;
 if v_phone ~ '[[:cntrl:]]' or char_length(v_phone) > 40 then raise exception 'Enter a valid phone number.' using errcode = '22023'; end if;
 if char_length(v_note) > 1000 then raise exception 'Keep the note under 1000 characters.' using errcode = '22023'; end if;
 if p_start is null then raise exception 'Choose a time.' using errcode = '22023'; end if;
 v_tz := coalesce((select name from pg_timezone_names where name = p_timezone), h.timezone);
 -- One booking at a time per host: the slot check and the insert cannot interleave.
 perform pg_advisory_xact_lock(hashtextextended('booking:' || h.user_id::text, 0));
 if (select count(*) from public.bookings x where x.host_user = h.user_id and lower(x.booker_email) = v_email and x.status = 'confirmed' and x.starts_at > now()) >= 3 then
  raise exception 'You already have 3 upcoming bookings with %. Cancel one to book another.', h.display_name using errcode = '23514'; end if;
 if v_uid is null and (select count(*) from public.bookings x where x.host_user = h.user_id and x.booker_user is null and x.created_at > now() - interval '1 hour') >= 20 then
  raise exception 'This page is busy. Please try again later.' using errcode = '23514'; end if;
 v_day := (p_start at time zone h.timezone)::date;
 if not exists (select 1 from public.booking_free_slots(t, h, v_day, v_day) s where s = p_start) then
  raise exception 'That time was just taken or is no longer offered. Please choose another.' using errcode = '23514', hint = 'slot_taken'; end if;
 insert into public.bookings(type_id, host_user, starts_at, ends_at, booker_user, booker_name, booker_email, booker_phone, booker_timezone, note, type_name, location_text, token_hash)
 values (t.id, h.user_id, p_start, p_start + make_interval(mins => t.duration_min), v_uid, v_name, v_email, v_phone, v_tz, v_note, t.name, public.booking_location_text(t),
  encode(sha256(convert_to(v_token, 'UTF8')), 'hex')) returning * into b;
 perform public.booking_notify(b, 'created', v_token);
 return public.booking_row(b, 'booker') || jsonb_build_object('token', v_token);
end $f$;

-- The booking a caller may act on: by the emailed token (the person who booked), or signed in as its host or its booker.
create or replace function public.booking_find(p_token text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $f$
declare b public.bookings; v_uid uuid := auth.uid(); v_email text;
begin
 if coalesce(p_token, '') <> '' then
  select * into b from public.bookings where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if found then return jsonb_build_object('id', b.id, 'side', 'booker'); end if;
  return null;
 end if;
 if p_id is null or v_uid is null then return null; end if;
 select * into b from public.bookings where id = p_id;
 if not found then return null; end if;
 if b.host_user = v_uid then return jsonb_build_object('id', b.id, 'side', 'host'); end if;
 v_email := public.booking_identity(v_uid)->>'email';
 if b.booker_user = v_uid or (v_email is not null and lower(b.booker_email) = v_email) then return jsonb_build_object('id', b.id, 'side', 'booker'); end if;
 return null;
end $f$;
revoke all on function public.booking_find(text, uuid) from public, anon, authenticated;

create or replace function public.booking_manage(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $f$
declare f jsonb := public.booking_find(p_token, null); b public.bookings;
begin
 if f is null then raise exception 'This booking link is not valid.' using errcode = 'P0002'; end if;
 select * into b from public.bookings where id = (f->>'id')::uuid;
 return public.booking_row(b, 'booker');
end $f$;

create or replace function public.booking_cancel(p_token text default null, p_id uuid default null, p_reason text default '') returns jsonb
language plpgsql security definer set search_path = public as $f$
declare f jsonb := public.booking_find(p_token, p_id); b public.bookings;
begin
 if f is null then raise exception 'Booking not found.' using errcode = 'P0002'; end if;
 select * into b from public.bookings where id = (f->>'id')::uuid for update;
 if b.status = 'cancelled' then return public.booking_row(b, f->>'side'); end if;
 if b.ends_at < now() then raise exception 'This meeting is already over.' using errcode = '23514'; end if;
 update public.bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = f->>'side', cancel_reason = nullif(left(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]', ' ', 'g')), 500), ''),
  updated_at = now() where id = b.id returning * into b;
 perform public.booking_notify(b, 'cancelled');
 return public.booking_row(b, f->>'side');
end $f$;

create or replace function public.booking_reschedule(p_start timestamptz, p_token text default null, p_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $f$
declare f jsonb := public.booking_find(p_token, p_id); b public.bookings; h public.booking_hosts; t public.booking_types; v_day date;
begin
 if f is null then raise exception 'Booking not found.' using errcode = 'P0002'; end if;
 select * into b from public.bookings where id = (f->>'id')::uuid;
 select * into h from public.booking_hosts where user_id = b.host_user;
 select * into t from public.booking_types where id = b.type_id;
 perform pg_advisory_xact_lock(hashtextextended('booking:' || h.user_id::text, 0));
 select * into b from public.bookings where id = b.id for update;
 if b.status <> 'confirmed' then raise exception 'This booking was cancelled. Make a new booking instead.' using errcode = '23514'; end if;
 if b.starts_at < now() then raise exception 'This meeting has already started.' using errcode = '23514'; end if;
 if b.reschedule_count >= 5 then raise exception 'This booking has been moved too many times. Cancel it and book again.' using errcode = '23514'; end if;
 if p_start is null or p_start = b.starts_at then raise exception 'Choose a different time.' using errcode = '22023'; end if;
 v_day := (p_start at time zone h.timezone)::date;
 if not h.is_enabled or not exists (select 1 from public.booking_free_slots(t, h, v_day, v_day, b.id) s where s = p_start) then
  raise exception 'That time was just taken or is no longer offered. Please choose another.' using errcode = '23514', hint = 'slot_taken'; end if;
 update public.bookings set starts_at = p_start, ends_at = p_start + make_interval(mins => t.duration_min), reschedule_count = reschedule_count + 1, updated_at = now()
  where id = b.id returning * into b;
 perform public.booking_notify(b, 'rescheduled');
 return public.booking_row(b, f->>'side');
end $f$;

revoke all on function public.booking_me(), public.booking_host_save(jsonb), public.booking_type_save(jsonb), public.booking_type_delete(uuid), public.booking_directory(text),
 public.booking_public_host(text), public.booking_slots(text, text, date, integer, text), public.booking_create(text, text, timestamptz, text, text, text, text, text),
 public.booking_manage(text), public.booking_cancel(text, uuid, text), public.booking_reschedule(timestamptz, text, uuid) from public, anon;
grant execute on function public.booking_me(), public.booking_host_save(jsonb), public.booking_type_save(jsonb), public.booking_type_delete(uuid), public.booking_directory(text) to authenticated;
grant execute on function public.booking_public_host(text), public.booking_slots(text, text, date, integer, text), public.booking_create(text, text, timestamptz, text, text, text, text, text),
 public.booking_manage(text), public.booking_cancel(text, uuid, text), public.booking_reschedule(timestamptz, text, uuid) to anon, authenticated;

-- CMS menu: Bookings (top level, after Tickets). The same module as /bookings, inside the CMS shell.
insert into public.admin_menu_items(id, parent_id, label, route, icon_key, sort_order, permission_key, permission_scope, is_system)
values ('bookings', null, 'Bookings', '/admin/bookings', 'calendar', 26, 'cms.admin', 'current', true)
on conflict (id) do nothing;
