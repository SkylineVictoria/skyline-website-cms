-- AGENCY-KEY-PEOPLE (owner, 2026-11-24: "allow me to add [people by hand], I think that is better"): Add business has a People list
-- (the CEO, directors, staff the search did not find), each with name, role, email, mobile and an optional MARN. They are offered in
-- the Full name search for the business admin agent and kept on the business (agencies.profile.key_people, at most 50).
-- Rollback: drop function public.agency_people_set(uuid, jsonb); the profile key can stay.
begin;

create or replace function public.agency_people_set(p_agency uuid, p_people jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare out jsonb := '[]'::jsonb; e jsonb; o jsonb; k text;
begin
 perform public.admin_business_require();
 if jsonb_typeof(p_people) is distinct from 'array' then raise exception 'The people could not be read.' using errcode = '22023'; end if;
 if jsonb_array_length(p_people) > 50 or length(p_people::text) > 40000 then raise exception 'A business can keep at most 50 people.' using errcode = '22023'; end if;
 for e in select value from jsonb_array_elements(p_people) loop
  o := jsonb_strip_nulls(jsonb_build_object(
   'fullName', nullif(left(btrim(regexp_replace(coalesce(e->>'fullName', ''), '\s+', ' ', 'g')), 120), ''),
   'role', nullif(left(btrim(regexp_replace(coalesce(e->>'role', ''), '\s+', ' ', 'g')), 80), ''),
   'email', case when lower(btrim(coalesce(e->>'email', ''))) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then left(lower(btrim(e->>'email')), 200) end,
   'phone', nullif(left(btrim(regexp_replace(coalesce(e->>'phone', ''), '[^0-9+() -]', '', 'g')), 40), ''),
   'marn', case when regexp_replace(coalesce(e->>'marn', ''), '\s', '', 'g') ~ '^\d{1,10}$' then regexp_replace(e->>'marn', '\s', '', 'g') end));
  for k in select jsonb_object_keys(o) loop
   if (o->>k) ~ '[[:cntrl:]]' then raise exception 'The people details contain characters that cannot be printed.' using errcode = '22023'; end if;
  end loop;
  if o ? 'fullName' then out := out || jsonb_build_array(o); end if;
 end loop;
 update public.agencies set profile = coalesce(profile, '{}'::jsonb) || jsonb_build_object('key_people', out), updated_at = now() where id = p_agency;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 return out;
end $$;
revoke all on function public.agency_people_set(uuid, jsonb) from public, anon;
grant execute on function public.agency_people_set(uuid, jsonb) to authenticated;

commit;
