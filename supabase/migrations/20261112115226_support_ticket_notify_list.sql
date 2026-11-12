-- TKT-01: ticket emails go to a managed list (CMS > Tickets > Notification emails) instead of every CMS Admin.
-- The requester and the person who replied / changed the status still get their own copy; the list replaces the admins.
-- An empty list means no extra recipients.
create table if not exists public.support_notification_recipients (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  label text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint support_notification_recipients_email_format check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 254),
  constraint support_notification_recipients_label_len check (char_length(label) <= 100)
);
create unique index if not exists support_notification_recipients_email_key on public.support_notification_recipients(email);
alter table public.support_notification_recipients enable row level security;
-- No policies: read and written only through the functions below.
revoke all on public.support_notification_recipients from anon, authenticated;

create or replace function public.support_notify_list()
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not public.support_is_handler() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'email', r.email, 'label', r.label, 'createdAt', r.created_at) order by r.email)
    from public.support_notification_recipients r), '[]'::jsonb);
end $$;

create or replace function public.support_notify_add(p_email text, p_label text default '')
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_label text := btrim(coalesce(p_label, '')); r public.support_notification_recipients;
begin
  if not public.support_is_handler() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then raise exception 'Enter a valid email address.' using errcode = '22023'; end if;
  if char_length(v_label) > 100 then raise exception 'Keep the name to 100 characters.' using errcode = '22023'; end if;
  if (select count(*) from public.support_notification_recipients) >= 25 then raise exception 'You can add up to 25 emails.' using errcode = '22023'; end if;
  if exists (select 1 from public.support_notification_recipients x where x.email = v_email) then raise exception 'This email is already on the list.' using errcode = '23505'; end if;
  insert into public.support_notification_recipients(email, label, created_by) values (v_email, v_label, auth.uid()) returning * into r;
  return jsonb_build_object('id', r.id, 'email', r.email, 'label', r.label, 'createdAt', r.created_at);
end $$;

create or replace function public.support_notify_remove(p_id uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if not public.support_is_handler() then raise exception 'Not authorized' using errcode = '42501'; end if;
  delete from public.support_notification_recipients where id = p_id;
end $$;

revoke all on function public.support_notify_list(), public.support_notify_add(text, text), public.support_notify_remove(uuid) from public, anon;
grant execute on function public.support_notify_list(), public.support_notify_add(text, text), public.support_notify_remove(uuid) to authenticated;

-- The ticket email trigger: the managed list replaces "every active CMS Admin". List members get the admin link.
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.support_ticket_email_after_message()'::regprocedure);
  n := replace(d,
    $o$select lower(btrim(c.email)), true from public.cms_users c where c.status = 'Active' and c.role = 'Admin'$o$,
    $o$select r.email, true from public.support_notification_recipients r$o$);
  if n = d then raise exception 'support_ticket_email_after_message: admin recipients not found, nothing changed'; end if;
  execute n;
end $mig$;
