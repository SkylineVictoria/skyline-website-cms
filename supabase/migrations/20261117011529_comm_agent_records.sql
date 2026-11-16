-- COMM-AGENT-RECORDS: the Communication Hub can open a conversation from any agent page. An agent may be a portal login
-- (portal_profiles) or only an agent record (public.agents, e.g. added before they have a login). comm_open_conversation('agent', id)
-- now accepts either id; an agent record that has a login opens the login's conversation (one conversation per person), one without a
-- login opens its own. comm_people also lists agent records without a login. Replaces both functions from 20261116210000. Additive.
begin;

create or replace function public.comm_people(p_search text default '', p_kind text default '', p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = public, hr as $$
declare q text := lower(btrim(coalesce(p_search, ''))); v jsonb;
begin
  perform public.comm_require_admin();
  with people as (
    select 'student'::text kind, s.id ref, s.full_name name, s.email, s.phone, coalesce(s.status, '') detail from public.enrollment_students s
    union all
    select 'agent', p.id, p.full_name, p.email, p.phone, coalesce(a.name, '') from public.portal_profiles p
      join public.agency_memberships m on m.user_id = p.id and m.role <> 'student' left join public.agencies a on a.id = m.agency_id
      where coalesce(p.is_test, false) = false
    union all
    select 'agent', ag.id, ag.full_name, nullif(ag.email, ''), nullif(ag.phone, ''), coalesce(b.name, '') from public.agents ag
      left join public.agencies b on b.id = ag.business_id
      where ag.profile_id is null
    union all
    select case when sp.status in ('active', 'inactive') then 'staff' else 'applicant' end, sp.id,
      btrim(concat_ws(' ', sp.first_name, sp.last_name)), sp.email, sp.phone_e164, sp.status from hr.staff_profiles sp
    union all
    select 'agency', ag.id, ag.name, ag.business_email, ag.phone, coalesce(ag.primary_contact, '') from public.agencies ag
  ), found as (
    select distinct on (pp.kind, pp.ref) pp.*, c.id conversation_id, c.last_message_at from people pp
    left join public.comm_conversations c on c.person_kind = pp.kind and c.person_ref = pp.ref
    where (coalesce(p_kind, '') = '' or pp.kind = p_kind)
      and (q = '' or lower(coalesce(pp.name, '')) like '%' || q || '%' or lower(coalesce(pp.email, '')) like '%' || q || '%' or coalesce(pp.phone, '') like '%' || q || '%')
      and coalesce(btrim(pp.name), '') <> ''
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'ref', ref, 'name', name, 'email', email, 'phone', phone, 'detail', detail,
    'conversationId', conversation_id, 'lastMessageAt', last_message_at) order by last_message_at desc nulls last, lower(name)), '[]'::jsonb)
  into v from (select * from found order by last_message_at desc nulls last, lower(name) limit greatest(1, least(coalesce(p_limit, 50), 200))) x;
  return v;
end;
$$;


create or replace function public.comm_open_conversation(p_kind text, p_ref uuid, p_name text default null, p_email text default null, p_phone text default null) returns uuid
language plpgsql security definer set search_path = public, hr as $$
declare v_name text; v_email text; v_phone text; v_id uuid; v_ref uuid;
begin
  perform public.comm_require_admin();
  if p_kind = 'student' then select full_name, email, phone into v_name, v_email, v_phone from public.enrollment_students where id = p_ref;
  elsif p_kind = 'agent' then
    select full_name, email, phone into v_name, v_email, v_phone from public.portal_profiles where id = p_ref;
    if not found then
      -- An agent record: use its portal login when it has one, so there is one conversation per person.
      select coalesce(ag.profile_id, ag.id) into v_ref from public.agents ag where ag.id = p_ref;
      if v_ref is not null and v_ref <> p_ref then
        p_ref := v_ref; select full_name, email, phone into v_name, v_email, v_phone from public.portal_profiles where id = p_ref;
      elsif v_ref is not null then
        select full_name, nullif(email, ''), nullif(phone, '') into v_name, v_email, v_phone from public.agents where id = p_ref;
      end if;
    end if;
  elsif p_kind in ('staff', 'applicant') then select btrim(concat_ws(' ', first_name, last_name)), email, phone_e164 into v_name, v_email, v_phone from hr.staff_profiles where id = p_ref;
  elsif p_kind = 'agency' then select name, business_email, phone into v_name, v_email, v_phone from public.agencies where id = p_ref;
  elsif p_kind = 'other' then v_name := btrim(coalesce(p_name, '')); v_email := nullif(btrim(coalesce(p_email, '')), ''); v_phone := nullif(btrim(coalesce(p_phone, '')), '');
    if v_name = '' or (v_email is null and v_phone is null) then raise exception 'Give a name and an email or phone number' using errcode = '22023'; end if;
  else raise exception 'Unknown person type' using errcode = '22023';
  end if;
  if coalesce(btrim(v_name), '') = '' then raise exception 'Person not found' using errcode = 'P0002'; end if;
  v_email := nullif(btrim(coalesce(v_email, '')), '');
  if v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_email := null; end if;
  v_phone := nullif(btrim(coalesce(v_phone, '')), '');
  if p_kind <> 'other' then
    select id into v_id from public.comm_conversations where person_kind = p_kind and person_ref = p_ref;
  end if;
  if v_id is null then
    insert into public.comm_conversations(person_kind, person_ref, display_name, email, phone)
    values (p_kind, case when p_kind = 'other' then null else p_ref end, left(v_name, 200), v_email, left(v_phone, 32)) returning id into v_id;
  else
    update public.comm_conversations set display_name = left(v_name, 200), email = v_email, phone = left(v_phone, 32), updated_at = now() where id = v_id;
  end if;
  return v_id;
end;
$$;


commit;
