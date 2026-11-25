-- Pulled from hosted supabase_migrations.schema_migrations (applied on hosted by another session without a repo file; 2026-11-25).
create or replace function public.locations_avetmiss_fill()
returns trigger language plpgsql set search_path = public as $$
declare v_addr text := btrim(coalesce(new.address, '')); v_missing text[] := '{}';
begin
  if tg_op = 'UPDATE' and old.avetmiss_location_id is not null
     and new.avetmiss_location_id is distinct from old.avetmiss_location_id
     and exists (select 1 from lms_unit_students u where u.location_id = new.id) then
    raise exception 'Location ID % is already used in student records and cannot be changed', old.avetmiss_location_id
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' and new.address is distinct from old.address then
    if new.suburb is not distinct from old.suburb then new.suburb := null; end if;
    if new.postcode is not distinct from old.postcode then new.postcode := null; end if;
    if new.state_code is not distinct from old.state_code then new.state_code := null; end if;
  end if;

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
  if new.postcode is null and new.suburb is not null and new.state_code is not null then
    select l.postcode into new.postcode from locations l
     where l.id is distinct from new.id and lower(l.suburb) = lower(new.suburb)
       and l.state_code = new.state_code and l.postcode is not null limit 1;
  end if;
  if new.avetmiss_location_id is null and new.suburb is not null then
    new.avetmiss_location_id := avetmiss_location_id_suggest(new.suburb, new.name, new.id);
  end if;

  if coalesce(new.is_active, true) then
    if nullif(btrim(new.name), '') is null then v_missing := array_append(v_missing, 'location name'); end if;
    if v_addr = '' then v_missing := array_append(v_missing, 'street address'); end if;
    if nullif(btrim(new.suburb), '') is null then v_missing := array_append(v_missing, 'suburb'); end if;
    if new.postcode is null then v_missing := array_append(v_missing, 'postcode'); end if;
    if new.state_code is null then v_missing := array_append(v_missing, 'state'); end if;
    if nullif(btrim(new.avetmiss_location_id), '') is null then v_missing := array_append(v_missing, 'AVETMISS location ID'); end if;
    if new.country_code is null then v_missing := array_append(v_missing, 'country'); end if;
    if array_length(v_missing, 1) > 0 then
      raise exception 'Location details are incomplete. Please add: %. (Tip: enter the full address, e.g. "51 Brady St, South Melbourne VIC 3205", and the rest fills in.)',
        array_to_string(v_missing, ', ') using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
