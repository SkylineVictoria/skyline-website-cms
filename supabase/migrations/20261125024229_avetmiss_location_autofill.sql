-- Pulled from hosted supabase_migrations.schema_migrations (applied on hosted by another session without a repo file; 2026-11-25).
-- NAT00020: a location gets its AVETMISS details automatically when it is created or its address changes.

-- Short, unique location ID from the suburb: "South Melbourne" -> "STH MELB", "Springvale" -> "SPRINGVALE"
create or replace function public.avetmiss_location_id_suggest(p_suburb text, p_name text, p_exclude uuid default null)
returns text language plpgsql stable set search_path = public as $$
declare v_base text; v_try text; n int := 1;
begin
  v_base := upper(regexp_replace(coalesce(nullif(btrim(p_suburb), ''), p_name, 'LOCATION'), '[^A-Za-z0-9 ]', '', 'g'));
  v_base := regexp_replace(v_base, '\mSOUTH\M', 'STH', 'g');
  v_base := regexp_replace(v_base, '\mNORTH\M', 'NTH', 'g');
  v_base := regexp_replace(v_base, '\mEAST\M', 'E', 'g');
  v_base := regexp_replace(v_base, '\mWEST\M', 'W', 'g');
  v_base := regexp_replace(v_base, '\mMELBOURNE\M', 'MELB', 'g');
  v_base := regexp_replace(v_base, '\mMOUNT\M', 'MT', 'g');
  v_base := btrim(regexp_replace(v_base, '\s+', ' ', 'g'));
  if v_base = '' then v_base := 'LOCATION'; end if;
  v_try := btrim(left(v_base, 10));
  while exists (select 1 from locations where upper(avetmiss_location_id) = v_try and id is distinct from p_exclude) loop
    n := n + 1;
    v_try := btrim(left(v_base, 10 - length(n::text))) || n::text;
  end loop;
  return v_try;
end $$;

create or replace function public.locations_avetmiss_fill()
returns trigger language plpgsql set search_path = public as $$
declare v_addr text := btrim(coalesce(new.address, ''));
begin
  -- The ID is reported to NCVER: once a student's unit uses this location it cannot change.
  if tg_op = 'UPDATE' and old.avetmiss_location_id is not null
     and new.avetmiss_location_id is distinct from old.avetmiss_location_id
     and exists (select 1 from lms_unit_students u where u.location_id = new.id) then
    raise exception 'Location ID % is already used in student records and cannot be changed', old.avetmiss_location_id
      using errcode = 'check_violation';
  end if;

  -- Address changed: re-read suburb / postcode / state unless staff typed them in the same save
  if tg_op = 'UPDATE' and new.address is distinct from old.address then
    if new.suburb is not distinct from old.suburb then new.suburb := null; end if;
    if new.postcode is not distinct from old.postcode then new.postcode := null; end if;
    if new.state_code is not distinct from old.state_code then new.state_code := null; end if;
  end if;

  -- "..., South Melbourne VIC 3205" or "..., Springvale VIC"
  if new.state_code is null then
    new.state_code := case upper(substring(v_addr from '(?i)\m(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\M(?:\s+[0-9]{4})?\s*(?:,?\s*Australia)?\s*$'))
      when 'NSW' then '01' when 'VIC' then '02' when 'QLD' then '03' when 'SA' then '04'
      when 'WA' then '05' when 'TAS' then '06' when 'NT' then '07' when 'ACT' then '08' end;
  end if;
  if new.postcode is null then
    new.postcode := substring(v_addr from '(?i)\m(?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s+([0-9]{4})\s*(?:,?\s*Australia)?\s*$');
  end if;
  if new.suburb is null then
    new.suburb := nullif(btrim(substring(v_addr from '(?i),\s*([A-Za-z'' -]+?)\s+(?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\M')), '');
  end if;
  -- Postcode still unknown: take it from another location in the same suburb and state
  if new.postcode is null and new.suburb is not null and new.state_code is not null then
    select l.postcode into new.postcode from locations l
     where l.id is distinct from new.id and lower(l.suburb) = lower(new.suburb)
       and l.state_code = new.state_code and l.postcode is not null limit 1;
  end if;

  if new.avetmiss_location_id is null then
    new.avetmiss_location_id := avetmiss_location_id_suggest(new.suburb, new.name, new.id);
  end if;
  return new;
end $$;

create trigger locations_avetmiss_fill
  before insert or update on public.locations
  for each row execute function public.locations_avetmiss_fill();

-- Rooms: every room belongs to a location (that is what each unit reports as its delivery place).
-- If a room is saved without one, match it by its campus name.
create or replace function public.classrooms_location_fill()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.location_id is null and nullif(btrim(new.campus), '') is not null then
    select l.id into new.location_id from locations l
     where lower(btrim(l.name)) = lower(btrim(new.campus)) and l.is_active limit 1;
  end if;
  return new;
end $$;
create trigger classrooms_location_fill
  before insert or update on public.classrooms
  for each row execute function public.classrooms_location_fill();

-- Fill the existing locations now (fires the trigger)
update public.locations set address = address;
