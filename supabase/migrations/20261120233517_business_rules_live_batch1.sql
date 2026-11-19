-- BUSINESS-RULES-LIVE batch 1 (owner, 2026-11-20: "make all changeable"): the reference entries in Business Rules
-- become live settings. Each one starts published at today's value (nothing changes on the day), and the code reads
-- it through public.rule_value / rule_int / rule_bool / rule_text / rule_json, falling back to the old value if a
-- rule is switched off or cannot be read. SLIT then changes the value on Administration › Business Rules.
--
-- This batch: the engine pieces and the rules held in the database or the frontend for Finance, Signing, Support and
-- Agents. Rules inside Edge Functions and offer-letter wording follow in later batches.
begin;

-- 1. Reading a live value.
create or replace function public.rule_value(p_id text, p_default jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_scope text := '';
begin
  begin v_scope := coalesce(public.tenant_current()::text, ''); exception when others then v_scope := ''; end;
  begin v := public.business_rule_evaluate(v_scope, p_id, '{}'::jsonb); exception when others then v := null; end;
  if (v is null or v = 'null'::jsonb) and v_scope <> '' then
    begin v := public.business_rule_evaluate('', p_id, '{}'::jsonb); exception when others then v := null; end;
  end if;
  if v is null or v = 'null'::jsonb then return p_default; end if;
  return v;
end $$;

create or replace function public.rule_int(p_id text, p_default integer) returns integer
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := public.rule_value(p_id, to_jsonb(p_default));
begin
  if jsonb_typeof(v) = 'number' then return round((v #>> '{}')::numeric)::integer; end if;
  return p_default;
end $$;

create or replace function public.rule_num(p_id text, p_default numeric) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := public.rule_value(p_id, to_jsonb(p_default));
begin
  if jsonb_typeof(v) = 'number' then return (v #>> '{}')::numeric; end if;
  return p_default;
end $$;

create or replace function public.rule_bool(p_id text, p_default boolean) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := public.rule_value(p_id, to_jsonb(p_default));
begin
  if jsonb_typeof(v) = 'boolean' then return (v #>> '{}')::boolean; end if;
  return p_default;
end $$;

create or replace function public.rule_text(p_id text, p_default text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := public.rule_value(p_id, to_jsonb(p_default));
begin
  if jsonb_typeof(v) = 'string' then return v #>> '{}'; end if;
  return p_default;
end $$;

create or replace function public.rule_json(p_id text, p_default jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public.rule_value(p_id, p_default);
$$;

-- Several values at once for the screens and Edge Functions: { identifier: value } for live rules only.
create or replace function public.business_rule_values(p_ids text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(r.identifier, public.rule_value(r.identifier, null)) filter (where public.rule_value(r.identifier, null) is not null), '{}'::jsonb)
    from public.business_rules r
   where r.scope_key = '' and r.identifier = any(p_ids) and coalesce(r.registration->>'handler', '') in ('setting', 'upload_size')
     and cardinality(p_ids) <= 200;
$$;

do $$ declare f text; begin
  foreach f in array array['rule_value(text, jsonb)', 'rule_int(text, integer)', 'rule_num(text, numeric)', 'rule_bool(text, boolean)',
    'rule_text(text, text)', 'rule_json(text, jsonb)', 'business_rule_values(text[])'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated, service_role', f);
  end loop;
end $$;

-- 2. A tool for this and later batches: change one exact piece of a live function and refuse if it is not found
-- exactly the expected number of times (so a function changed elsewhere is never overwritten blindly).
create or replace function public.business_rule_patch_function(p_fn regprocedure, p_old text, p_new text, p_times integer default 1) returns void
language plpgsql security definer set search_path = '' as $$
declare d text; n integer;
begin
  d := pg_get_functiondef(p_fn);
  n := (length(d) - length(replace(d, p_old, ''))) / greatest(length(p_old), 1);
  if n <> p_times then
    raise exception 'BUSINESS-RULES-LIVE: expected % occurrence(s) of "%" in %, found %', p_times, p_old, p_fn, n;
  end if;
  execute replace(d, p_old, p_new);
end $$;
revoke all on function public.business_rule_patch_function(regprocedure, text, text, integer) from public, anon, authenticated, service_role;

-- 3. The "setting" handler: a live value, optionally limited by the registration (min, max, allowed values).
select public.business_rule_patch_function('public.business_rule_validate(jsonb, jsonb)'::regprocedure,
$old$    else
      raise exception 'Unknown registered workflow handler.' using errcode = '22023';$old$,
$new$    elsif p_registration->>'handler' = 'setting' then
      if p_registration ? 'min' and jsonb_typeof(d->'value') = 'number' and (d->>'value')::numeric < (p_registration->>'min')::numeric then
        raise exception 'The value must be at least %.', p_registration->>'min' using errcode = '22023';
      end if;
      if p_registration ? 'max' and jsonb_typeof(d->'value') = 'number' and (d->>'value')::numeric > (p_registration->>'max')::numeric then
        raise exception 'The value must be at most %.', p_registration->>'max' using errcode = '22023';
      end if;
      if p_registration ? 'allowed' and jsonb_typeof(d->'value') = 'string' and not (p_registration->'allowed') @> jsonb_build_array(d->'value') then
        raise exception 'Choose one of: %.', (select string_agg(x, ', ') from jsonb_array_elements_text(p_registration->'allowed') x) using errcode = '22023';
      end if;
      if p_registration ? 'allowed' and jsonb_typeof(d->'value') = 'array' and not (p_registration->'allowed') @> (d->'value') then
        raise exception 'Use only: %.', (select string_agg(x, ', ') from jsonb_array_elements_text(p_registration->'allowed') x) using errcode = '22023';
      end if;
      if p_registration ? 'keys' and jsonb_typeof(d->'value') = 'object' and not (d->'value') ?& array(select jsonb_array_elements_text(p_registration->'keys')) then
        raise exception 'Keep every part of this setting: %.', (select string_agg(x, ', ') from jsonb_array_elements_text(p_registration->'keys') x) using errcode = '22023';
      end if;
    else
      raise exception 'Unknown registered workflow handler.' using errcode = '22023';$new$);

-- Turns a reference entry into a live setting published at its catalogued value (= what the code does today).
create or replace function public.business_rule_go_live(p_id text, p_limits jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.business_rules; v public.business_rule_versions; d jsonb;
begin
  select * into r from public.business_rules where scope_key = '' and identifier = p_id for update;
  if r.id is null then raise exception 'BUSINESS-RULES-LIVE: rule % is not in Business Rules.', p_id; end if;
  if r.registration->>'handler' = 'setting' then return; end if;
  if r.registration->>'handler' is distinct from 'inventory_only' then raise exception 'BUSINESS-RULES-LIVE: rule % is not a reference entry.', p_id; end if;
  select * into v from public.business_rule_versions where rule_id = r.id and state = 'reference' order by version desc limit 1;
  if v.id is null then raise exception 'BUSINESS-RULES-LIVE: rule % has no reference version.', p_id; end if;
  update public.business_rules set registration = (registration - 'handler') || jsonb_build_object('handler', 'setting') || coalesce(p_limits, '{}'::jsonb)
   where id = r.id returning * into r;
  d := v.definition || jsonb_build_object('enabled', true,
    'notes', 'Live setting: the system uses this value. It started at the value the system already used.');
  perform public.business_rule_validate(d, r.registration);
  update public.business_rule_versions set state = 'published', definition = d, published_at = clock_timestamp() where id = v.id;
  delete from public.business_rule_conditions where version_id = v.id;
  delete from public.business_rule_actions where version_id = v.id;
  perform public.business_rule_index_version(v.id, d);
  insert into public.business_rule_audit_logs(scope_key, rule_id, action, reason, before_data, after_data)
    values ('', r.id, 'publish', 'Made live: the system now reads this value from Business Rules. The value is unchanged.', v.definition, d);
end $$;
revoke all on function public.business_rule_go_live(text, jsonb) from public, anon, authenticated, service_role;

-- 4. Finance: deposit reminders.
select public.business_rule_go_live('finance.deposit_manual_reminder_cooldown', '{"min":0,"max":720}');
select public.business_rule_go_live('finance.deposit_automatic_reminder_cap', '{"min":0,"max":50}');
select public.business_rule_go_live('finance.deposit_automatic_reminder_interval', '{"min":1,"max":60}');
select public.business_rule_go_live('finance.deposit_reminder_default_enabled');

select public.business_rule_patch_function('public.offer_deposit_reminder_send(uuid, boolean)'::regprocedure,
  $o$p.last_reminder_at > now() - interval '24 hours'$o$,
  $n$p.last_reminder_at > now() - make_interval(hours => public.rule_int('finance.deposit_manual_reminder_cooldown', 24))$n$);
select public.business_rule_patch_function('public.offer_deposit_reminder_send(uuid, boolean)'::regprocedure,
  $o$raise exception 'A reminder was sent less than 24 hours ago' using errcode = 'P0024';$o$,
  $n$raise exception 'A reminder was sent less than % hours ago', public.rule_int('finance.deposit_manual_reminder_cooldown', 24) using errcode = 'P0024';$n$);
select public.business_rule_patch_function('public.offer_deposit_reminders_tick()'::regprocedure,
  $o$p.reminder_count >= 3 or coalesce(p.last_reminder_at, l.accepted_at) > now() - interval '3 days'$o$,
  $n$p.reminder_count >= public.rule_int('finance.deposit_automatic_reminder_cap', 3)
      or coalesce(p.last_reminder_at, l.accepted_at) > now() - make_interval(days => public.rule_int('finance.deposit_automatic_reminder_interval', 3))$n$);
alter table public.enrollment_offer_letters alter column deposit_auto_remind set default public.rule_bool('finance.deposit_reminder_default_enabled', false);

-- Finance: course fee defaults (read by the screens).
select public.business_rule_go_live('finance.course_fee_deposit_cap', '{"min":0}');
select public.business_rule_go_live('finance.course_fee_nonrefundable_defaults',
  '{"allowed":["Application","Registration","Enrolment","Material","Tuition","Other","OSHC","Initial deposit"]}');
select public.business_rule_go_live('finance.course_fee_suggestions', '{"keys":["application","registration","initialDeposit"]}');
select public.business_rule_go_live('finance.course_total_excluded_default',
  '{"allowed":["Application","Registration","Enrolment","Material","Tuition","Other","OSHC","Initial deposit"]}');

-- 5. Signing: new request defaults and the reminder cap.
select public.business_rule_go_live('signing.request_expiry_default', '{"min":1,"max":365}');
select public.business_rule_go_live('signing.request_reminder_default', '{"min":0,"max":60}');
select public.business_rule_go_live('signing.default_signer_order', '{"allowed":["Sequential","Parallel"]}');
select public.business_rule_go_live('signing.recipient_reminder_cap', '{"min":0,"max":100}');

alter table hr.sign_requests alter column expiry_days set default public.rule_int('signing.request_expiry_default', 14);
alter table hr.sign_requests alter column reminder_days set default public.rule_int('signing.request_reminder_default', 3);
alter table hr.sign_requests alter column signing_mode set default lower(public.rule_text('signing.default_signer_order', 'Sequential'));
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$k.reminder_count < 10$o$, $n$k.reminder_count < public.rule_int('signing.recipient_reminder_cap', 10)$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('signing_dispatch', 'signing_service');

-- 6. Support tickets.
select public.business_rule_go_live('support.ticket_priority_default', '{"allowed":["Low","Normal","High","Urgent"]}');
select public.business_rule_go_live('support.ticket_reply_status_moves', '{"keys":["staff","requester"]}');
select public.business_rule_go_live('support.ticket_attachment_limit_mib', '{"min":1,"max":50}');

alter table public.support_tickets alter column priority set default lower(public.rule_text('support.ticket_priority_default', 'Normal'));
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$set status = case when status in ('open','in_progress') then 'waiting' else status end$o$,
  $n$set status = coalesce(public.rule_json('support.ticket_reply_status_moves', '{"staff":{"open":"waiting","in_progress":"waiting"},"requester":{"waiting":"open","resolved":"open"}}'::jsonb)->'staff'->>status, status)$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'support_ticket_reply';
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$set status = case when status in ('waiting','resolved') then 'open' else status end$o$,
  $n$set status = coalesce(public.rule_json('support.ticket_reply_status_moves', '{"staff":{"open":"waiting","in_progress":"waiting"},"requester":{"waiting":"open","resolved":"open"}}'::jsonb)->'requester'->>status, status)$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'support_ticket_reply';

-- 7. Agents: references needed before an agent can be activated.
select public.business_rule_go_live('agents.activation_reference_minimum', '{"min":0,"max":5}');
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$if v_total < 2 or v_received < v_total then$o$,
  $n$if v_total < public.rule_int('agents.activation_reference_minimum', 2) or v_received < v_total then$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'agency_onboarding_agent_activate';

commit;
