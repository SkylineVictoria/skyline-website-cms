-- WIZARD SESSION LOCK (owner, 2026-11-21): only one manager runs the course wizard of a course at a time. Starting the
-- wizard acquires a lock on the course; the wizard page keeps it alive with a heartbeat while it is open. Another manager
-- is told who holds the lock and can only watch until it is released (Finish / Discard / page closed) or goes stale after
-- lms.wizard_lock_minutes without a heartbeat, so a crashed laptop never bricks the course. finish / discard of the
-- wizard's hidden draft intakes refuse to run while a different manager holds the lock.
select public.business_rule_add_setting('lms.wizard_lock_minutes', 'Course wizard lock expiry', 'Intakes & Scheduling',
  'lms/intakes', 'course', 'number', '15'::jsonb, '{"min":1,"max":240}'::jsonb,
  'Minutes without a heartbeat before a course wizard lock is released. While a manager runs the course wizard the course is locked to them; another manager can take it over once the lock goes stale.');

alter table public.cms_courses
  add column if not exists wizard_locked_by uuid references auth.users(id) on delete set null,
  add column if not exists wizard_locked_at timestamptz; -- last heartbeat (null: not locked)

-- True when the course is locked to a DIFFERENT signed-in manager with a fresh heartbeat.
create or replace function public.wizard_lock_conflict(p_course text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.cms_courses c
    where c.id = p_course and c.wizard_locked_by is not null
      and c.wizard_locked_by is distinct from auth.uid()
      and c.wizard_locked_at > now() - make_interval(mins => public.rule_int('lms.wizard_lock_minutes', 15)))
$$;
revoke all on function public.wizard_lock_conflict(text) from public, anon, authenticated;

-- The wizard page's lock: acquire / ping (heartbeat) / release / status.
create or replace function public.rto_wizard_session(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_course text := d->>'courseId'; v_uid uuid := auth.uid();
  v_holder uuid; v_at timestamptz; v_by text;
begin
 if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'Only an RTO Manager can use the course wizard.' using errcode = '42501'; end if;
 select c.wizard_locked_by, c.wizard_locked_at into v_holder, v_at from public.cms_courses c where c.id = v_course;
 if p_action = 'acquire' then
  if v_holder is not null and v_holder is distinct from v_uid
     and v_at > now() - make_interval(mins => public.rule_int('lms.wizard_lock_minutes', 15)) then
   select coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', u.email) into v_by from auth.users u where u.id = v_holder;
   return jsonb_build_object('ok', false, 'lockedBy', coalesce(v_by, 'another manager'), 'since', v_at);
  end if;
  update public.cms_courses set wizard_locked_by = v_uid, wizard_locked_at = now() where id = v_course;
  return jsonb_build_object('ok', true);
 elsif p_action = 'ping' then
  if v_holder is not distinct from v_uid and v_holder is not null then
   update public.cms_courses set wizard_locked_at = now() where id = v_course;
   return jsonb_build_object('ok', true);
  end if;
  return jsonb_build_object('ok', false);
 elsif p_action = 'release' then
  if v_holder is null or v_holder is not distinct from v_uid then
   update public.cms_courses set wizard_locked_by = null, wizard_locked_at = null where id = v_course;
  end if;
  return jsonb_build_object('ok', true);
 elsif p_action = 'status' then
  if v_holder is not null then
   select coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', u.email) into v_by from auth.users u where u.id = v_holder;
  end if;
  return jsonb_build_object('locked', v_holder is not null, 'mine', v_holder is not distinct from v_uid, 'lockedBy', v_by, 'since', v_at);
 end if;
 raise exception 'Unknown action' using errcode = '22023';
end $$;
revoke all on function public.rto_wizard_session(text, jsonb) from public, anon;
grant execute on function public.rto_wizard_session(text, jsonb) to authenticated;

-- finish / discard may not run while another manager's wizard session holds the course (their hidden drafts are theirs).
do $$
declare d text;
begin
 d := pg_get_functiondef('public.rto_intake_wizard(text,jsonb)'::regprocedure);
 if position('elsif p_action = ''discard'' then' in d) = 0 or position('elsif p_action = ''finish'' then' in d) = 0 then
  raise exception 'anchor not found in rto_intake_wizard';
 end if;
 d := replace(d, 'elsif p_action = ''discard'' then',
  'elsif p_action = ''discard'' then' || E'\n  if public.wizard_lock_conflict(v_course) then raise exception ''The course wizard is open by another manager. Wait until it is finished or the lock expires (Business Rules › lms.wizard_lock_minutes).'' using errcode = ''42501''; end if;');
 d := replace(d, 'elsif p_action = ''finish'' then',
  'elsif p_action = ''finish'' then' || E'\n  if public.wizard_lock_conflict(v_course) then raise exception ''The course wizard is open by another manager. Wait until it is finished or the lock expires (Business Rules › lms.wizard_lock_minutes).'' using errcode = ''42501''; end if;');
 execute d;
end $$;

-- The pending list also says whether a hidden draft's classes are booked, so the wizard can offer Finish only when both kinds are done.
do $$
declare d text; a constant text := 'jsonb_build_object(''id'', ci.id, ''load'', ci.study_load, ''startDate'', ci.start_date)';
begin
 d := pg_get_functiondef('public.rto_intake_wizard(text,jsonb)'::regprocedure);
 if position(a in d) = 0 then raise exception 'anchor not found in rto_intake_wizard (pending)'; end if;
 execute replace(d, a, a || ', ''classes'', exists (select 1 from public.class_sessions s where s.intake_id = ci.id and s.status <> ''cancelled'')');
end $$;
