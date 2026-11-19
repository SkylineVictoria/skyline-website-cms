-- BUSINESS-RULES-LIVE batch: Bookings, website (CMS) limits and the offer-letter terms. Every reference entry below becomes a
-- live setting at today's value (nothing changes on the day); SLIT then changes it on Administration › Business Rules.
--  * booking.*  : read by the booking functions (rule_*) and by the Bookings screen through booking_me() ('newType', 'initialHours').
--                 booking.initial_host_availability ("Monday to Friday", 09:00-17:00) becomes a real setting: a list of weekdays + times.
--  * cms.*      : website editor limits held by the screens (src/config/cmsLimits.ts, src/pages/admin/lib/storage.ts); the database
--                 has no validator for them. The upload limit cannot go above the tenant-public-media bucket limit (20 MiB).
--  * finance.offer_* : words of the Student Offer Letter. The live template gets {{offer.*}} variables filled from the rules by
--                 application_letter_values (SQL), so the rendered letter reads exactly as today. No Edge Function change.
begin;

/* ------------------------------------------------------------------ 1. Bookings */
select public.business_rule_go_live('booking.new_type_duration', '{"min":5,"max":480}');
select public.business_rule_go_live('booking.new_type_buffer', '{"min":0,"max":120}');
select public.business_rule_go_live('booking.new_type_min_notice', '{"min":0,"max":720}');
select public.business_rule_go_live('booking.new_type_max_days_ahead', '{"min":1,"max":365}');
select public.business_rule_go_live('booking.new_type_requires_login');
select public.business_rule_go_live('booking.reminder_hours', '{"min":1,"max":168}');
select public.business_rule_go_live('booking.reschedule_cap', '{"min":0,"max":50}');
select public.business_rule_go_live('booking.upcoming_per_host_cap', '{"min":1,"max":50}');
select public.business_rule_go_live_as('booking.initial_host_availability', '{"keys":["days","start","end"]}',
  '{"days":["Monday","Tuesday","Wednesday","Thursday","Friday"],"start":"09:00","end":"17:00"}');

-- New meeting types: the column defaults and the values booking_type_save uses when the screen sends none.
alter table public.booking_types alter column buffer_min set default public.rule_int('booking.new_type_buffer', 0);
alter table public.booking_types alter column min_notice_hours set default public.rule_int('booking.new_type_min_notice', 4);
alter table public.booking_types alter column max_days_ahead set default public.rule_int('booking.new_type_max_days_ahead', 60);
alter table public.booking_types alter column requires_login set default public.rule_bool('booking.new_type_requires_login', false);

create or replace function public.booking_new_type_defaults() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'duration', least(480, greatest(5, public.rule_int('booking.new_type_duration', 30))),
    'buffer', least(120, greatest(0, public.rule_int('booking.new_type_buffer', 0))),
    'minNoticeHours', least(720, greatest(0, public.rule_int('booking.new_type_min_notice', 4))),
    'maxDaysAhead', least(365, greatest(1, public.rule_int('booking.new_type_max_days_ahead', 60))),
    'requiresLogin', public.rule_bool('booking.new_type_requires_login', false));
$$;

-- The hours a new booking page starts with: [{weekday (Sunday = 0), start, end}]. A value that cannot be read gives today's hours.
create or replace function public.booking_initial_hours() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb := public.rule_json('booking.initial_host_availability', '{"days":["Monday","Tuesday","Wednesday","Thursday","Friday"],"start":"09:00","end":"17:00"}'::jsonb);
  wd text[] := array['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  v_start text := v->>'start'; v_end text := v->>'end'; v_out jsonb;
begin
  if jsonb_typeof(v->'days') <> 'array' or coalesce(v_start, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(v_end, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or v_start >= v_end then
    v := '{"days":["Monday","Tuesday","Wednesday","Thursday","Friday"],"start":"09:00","end":"17:00"}'::jsonb; v_start := '09:00'; v_end := '17:00';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('weekday', d.n, 'start', v_start, 'end', v_end) order by d.n), '[]'::jsonb) into v_out
    from (select distinct array_position(wd, lower(btrim(x))) - 1 n from jsonb_array_elements_text(v->'days') x) d where d.n is not null;
  return v_out;
end $$;

-- "A reminder of your booking tomorrow." keeps its words at 24 hours; another lead time says when.
create or replace function public.booking_reminder_when() returns text
language sql stable security definer set search_path = '' as $$
  select case when h = 24 then 'tomorrow' when h = 1 then 'in 1 hour' when h % 24 = 0 then 'in ' || (h / 24) || ' days' else 'in ' || h || ' hours' end
    from (select greatest(1, public.rule_int('booking.reminder_hours', 24)) h) x;
$$;

do $$ declare f text; begin
  foreach f in array array['booking_new_type_defaults()', 'booking_initial_hours()', 'booking_reminder_when()'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

select public.business_rule_patch_function('public.booking_me()'::regprocedure,
  $o$return jsonb_build_object('identity', v_id, 'origin', public.support_site_origin(),$o$,
  $n$return jsonb_build_object('identity', v_id, 'origin', public.support_site_origin(), 'newType', public.booking_new_type_defaults(), 'initialHours', public.booking_initial_hours(),$n$);

select public.business_rule_patch_function('public.booking_type_save(jsonb)'::regprocedure,
  $o$coalesce((p->>'duration')::integer, 30)$o$, $n$coalesce((p->>'duration')::integer, (public.booking_new_type_defaults()->>'duration')::integer)$n$);
select public.business_rule_patch_function('public.booking_type_save(jsonb)'::regprocedure,
  $o$coalesce((p->>'buffer')::integer, 0)$o$, $n$coalesce((p->>'buffer')::integer, (public.booking_new_type_defaults()->>'buffer')::integer)$n$);
select public.business_rule_patch_function('public.booking_type_save(jsonb)'::regprocedure,
  $o$coalesce((p->>'minNoticeHours')::integer, 4)$o$, $n$coalesce((p->>'minNoticeHours')::integer, (public.booking_new_type_defaults()->>'minNoticeHours')::integer)$n$);
select public.business_rule_patch_function('public.booking_type_save(jsonb)'::regprocedure,
  $o$coalesce((p->>'maxDaysAhead')::integer, 60)$o$, $n$coalesce((p->>'maxDaysAhead')::integer, (public.booking_new_type_defaults()->>'maxDaysAhead')::integer)$n$);
select public.business_rule_patch_function('public.booking_type_save(jsonb)'::regprocedure,
  $o$coalesce((p->>'requiresLogin')::boolean, false)$o$, $n$coalesce((p->>'requiresLogin')::boolean, public.rule_bool('booking.new_type_requires_login', false))$n$);

select public.business_rule_patch_function(p.oid::regprocedure,
  $o$x.starts_at > now()) >= 3 then$o$, $n$x.starts_at > now()) >= public.rule_int('booking.upcoming_per_host_cap', 3) then$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'booking_create';
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$'You already have 3 upcoming bookings with %. Cancel one to book another.', h.display_name$o$,
  $n$'You already have % upcoming bookings with %. Cancel one to book another.', public.rule_int('booking.upcoming_per_host_cap', 3), h.display_name$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'booking_create';

select public.business_rule_patch_function(p.oid::regprocedure,
  $o$if b.reschedule_count >= 5 then$o$, $n$if b.reschedule_count >= public.rule_int('booking.reschedule_cap', 5) then$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'booking_reschedule';

select public.business_rule_patch_function(p.oid::regprocedure,
  $o$interval '25 hours'$o$, $n$make_interval(hours => greatest(1, public.rule_int('booking.reminder_hours', 24)) + 1)$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'booking_notify';
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$interval '24 hours'$o$, $n$make_interval(hours => greatest(1, public.rule_int('booking.reminder_hours', 24)))$n$, 2)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'booking_notify';
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$your booking tomorrow.$o$, $n$your booking ' || public.booking_reminder_when() || E'.$n$, 2)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'booking_notify';

/* ------------------------------------------------------------------ 2. Website (CMS) limits, read by the screens */
select public.business_rule_go_live('cms.cms_document_limit_mib', '{"min":1,"max":20}');
select public.business_rule_go_live('cms.footer_label_char_cap', '{"min":5,"max":60}');
select public.business_rule_go_live('cms.footer_links_per_column', '{"min":1,"max":20}');
select public.business_rule_go_live('cms.homepage_course_cap', '{"min":1,"max":50}');
select public.business_rule_go_live('cms.navigation_child_cap', '{"min":1,"max":12}');
select public.business_rule_go_live('cms.navigation_label_char_cap', '{"min":5,"max":40}');
select public.business_rule_go_live('cms.navigation_top_level_cap', '{"min":1,"max":12}');

/* ------------------------------------------------------------------ 3. Offer letter terms */
select public.business_rule_go_live('finance.offer_late_fee_template_amount', '{"min":0,"max":10000}');
select public.business_rule_go_live('finance.offer_overdue_notice_template_days', '{"min":1,"max":365}');
select public.business_rule_go_live('finance.offer_refund_template_processing_days', '{"min":1,"max":365}');
-- The catalogue summarised the clause as "Chief Executive approval"; the letter prints these exact words.
select public.business_rule_go_live_as('finance.offer_refund_request_approval', '{}',
  '"the Chief Executive Officer or the Finance Manager"');
select public.business_rule_go_live('finance.offer_refund_offshore_withdrawal', '{"keys":["cutoffWeeks","lessThanCutoffPercent","moreThanCutoffPercent"]}');

-- "four (4)" as the letter writes a number of weeks.
create or replace function public.letter_number_words(p_n integer) returns text
language sql immutable set search_path = '' as $$
  select case when p_n between 1 and 20 then (array['one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen',
    'fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty'])[p_n] || ' (' || p_n || ')' else p_n::text end;
$$;

-- The words of the letter that come from Business Rules: { variable key: printed text }.
create or replace function public.offer_letter_terms() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_fee numeric := greatest(0, public.rule_num('finance.offer_late_fee_template_amount', 100));
  w jsonb := public.rule_json('finance.offer_refund_offshore_withdrawal', '{"cutoffWeeks":4,"lessThanCutoffPercent":50,"moreThanCutoffPercent":80}'::jsonb);
  pct numeric; v_weeks integer; v_more numeric; v_less numeric;
begin
  v_weeks := case when jsonb_typeof(w->'cutoffWeeks') = 'number' and (w->>'cutoffWeeks')::numeric between 1 and 52 then round((w->>'cutoffWeeks')::numeric)::integer else 4 end;
  v_more := case when jsonb_typeof(w->'moreThanCutoffPercent') = 'number' and (w->>'moreThanCutoffPercent')::numeric between 0 and 100 then (w->>'moreThanCutoffPercent')::numeric else 80 end;
  v_less := case when jsonb_typeof(w->'lessThanCutoffPercent') = 'number' and (w->>'lessThanCutoffPercent')::numeric between 0 and 100 then (w->>'lessThanCutoffPercent')::numeric else 50 end;
  return jsonb_build_object(
    'offer.late_fee', case when v_fee = trunc(v_fee) then trunc(v_fee)::text else to_char(v_fee, 'FM9999999990.00') end,
    'offer.overdue_notice_days', greatest(1, public.rule_int('finance.offer_overdue_notice_template_days', 14))::text,
    'offer.refund_processing_days', greatest(1, public.rule_int('finance.offer_refund_template_processing_days', 28))::text,
    'offer.refund_approver', coalesce(nullif(btrim(public.rule_text('finance.offer_refund_request_approval', 'the Chief Executive Officer or the Finance Manager')), ''),
      'the Chief Executive Officer or the Finance Manager'),
    'offer.offshore_cutoff_weeks', public.letter_number_words(v_weeks),
    'offer.offshore_refund_more', trim_scale(v_more)::text || '%',
    'offer.offshore_refund_less', trim_scale(v_less)::text || '%');
end $$;
revoke all on function public.offer_letter_terms() from public;
grant execute on function public.offer_letter_terms() to authenticated, service_role;

insert into public.letter_variables(key, grp, label, description, source_kind, source_ref, source_label, format, input_type, required, editable_source, aliases, sample, sort) values
 ('offer.late_fee', 'Application', 'Late payment fee per week', 'Amount without the currency sign, e.g. 100', 'computed', 'business_rule',
  'Business Rules › Offer template late fee wording', 'text', 'text', false, false, '{}', '100', 545),
 ('offer.overdue_notice_days', 'Application', 'Overdue notice days', 'Days fees may stay overdue before the student is told about a report to DHA', 'computed', 'business_rule',
  'Business Rules › Offer template overdue notice wording', 'text', 'text', false, false, '{}', '14', 546),
 ('offer.refund_processing_days', 'Application', 'Refund processing days', 'Days within which a refund is honoured', 'computed', 'business_rule',
  'Business Rules › Offer template refund processing wording', 'text', 'text', false, false, '{}', '28', 547),
 ('offer.refund_approver', 'Application', 'Refund approver', 'Who authorises refund applications', 'computed', 'business_rule',
  'Business Rules › Offer template refund approval wording', 'text', 'text', false, false, '{}', 'the Chief Executive Officer or the Finance Manager', 548),
 ('offer.offshore_cutoff_weeks', 'Application', 'Off-shore withdrawal cut-off (weeks)', 'Written as in the letter, e.g. four (4)', 'computed', 'business_rule',
  'Business Rules › Offer template offshore withdrawal wording', 'text', 'text', false, false, '{}', 'four (4)', 549),
 ('offer.offshore_refund_more', 'Application', 'Off-shore refund before the cut-off', 'Percentage refunded when withdrawing more than the cut-off before the CoE start date', 'computed', 'business_rule',
  'Business Rules › Offer template offshore withdrawal wording', 'text', 'text', false, false, '{}', '80%', 550),
 ('offer.offshore_refund_less', 'Application', 'Off-shore refund after the cut-off', 'Percentage refunded when withdrawing less than the cut-off before the CoE start date', 'computed', 'business_rule',
  'Business Rules › Offer template offshore withdrawal wording', 'text', 'text', false, false, '{}', '50%', 551)
on conflict (key) do nothing;

select public.business_rule_patch_function('public.application_letter_values(uuid)'::regprocedure,
  $o$    elsif r.key = 'fees.combined_total' then$o$,
  $n$    elsif r.source_ref = 'business_rule' and public.offer_letter_terms() ? r.key then raw := public.offer_letter_terms() ->> r.key;
    elsif r.key = 'fees.combined_total' then$n$);

-- The live offer letter template: the seven terms become variables (body_html and its plain-text copy). Every piece must be found exactly
-- once in each text of the default template, so a template SLIT changed in the meantime is never rewritten blindly.
do $$
declare
  t record; pair text[]; n_html integer; n_body integer; v_html text; v_body text; v_default_done boolean := false;
  pairs text[][] := array[
    array['AUD$100 per week in fines', 'AUD${{offer.late_fee}} per week in fines'],
    array['A late payment fee of $100 will be applied', 'A late payment fee of ${{offer.late_fee}} will be applied'],
    array['overdue for more than 14 days SLIT', 'overdue for more than {{offer.overdue_notice_days}} days SLIT'],
    array['honoured by SLIT within 28 days of the request', 'honoured by SLIT within {{offer.refund_processing_days}} days of the request'],
    array['authorised by the Chief Executive Officer or the Finance Manager.', 'authorised by {{offer.refund_approver}}.'],
    array['more than four (4) weeks before the CoE start date, 80% of the tuition', 'more than {{offer.offshore_cutoff_weeks}} weeks before the CoE start date, {{offer.offshore_refund_more}} of the tuition'],
    array['less than four (4) weeks before the CoE start date, 50% of the tuition', 'less than {{offer.offshore_cutoff_weeks}} weeks before the CoE start date, {{offer.offshore_refund_less}} of the tuition']];
begin
  for t in select id, body_html, body, is_default and status = 'active' as live from hr.sign_templates
            where category = 'student_offer_letter' and deleted_at is null and body_html like '%A late payment fee of $100 will be applied%' for update loop
    v_html := t.body_html; v_body := coalesce(t.body, '');
    foreach pair slice 1 in array pairs loop
      n_html := (length(v_html) - length(replace(v_html, pair[1], ''))) / length(pair[1]);
      n_body := (length(v_body) - length(replace(v_body, pair[1], ''))) / length(pair[1]);
      if n_html <> 1 or n_body not in (0, 1) then
        raise exception 'BUSINESS-RULES-LIVE: offer letter template % has "%" % time(s) (plain text %), expected once.', t.id, pair[1], n_html, n_body;
      end if;
      v_html := replace(v_html, pair[1], pair[2]);
      v_body := replace(v_body, pair[1], pair[2]);
    end loop;
    update hr.sign_templates set body_html = v_html, body = case when t.body is null then null else v_body end, updated_at = now() where id = t.id;
    if t.live then v_default_done := true; end if;
  end loop;
  if not v_default_done and exists (select 1 from hr.sign_templates where category = 'student_offer_letter' and deleted_at is null and is_default and status = 'active') then
    raise exception 'BUSINESS-RULES-LIVE: the default offer letter template does not hold the expected late fee wording; check it before making the letter terms live.';
  end if;
end $$;

-- Nothing must be left behind in this area.
do $$ begin
  if exists (select 1 from public.business_rules where scope_key = '' and registration->>'handler' = 'inventory_only'
              and (identifier like 'booking.%' or identifier like 'cms.%' or identifier in ('finance.offer_late_fee_template_amount',
                'finance.offer_overdue_notice_template_days', 'finance.offer_refund_offshore_withdrawal', 'finance.offer_refund_request_approval',
                'finance.offer_refund_template_processing_days'))) then
    raise exception 'BUSINESS-RULES-LIVE: reference entries remain: %',
      (select string_agg(identifier, ', ') from public.business_rules where scope_key = '' and registration->>'handler' = 'inventory_only'
        and (identifier like 'booking.%' or identifier like 'cms.%' or identifier like 'finance.offer\_%'));
  end if;
end $$;

commit;
