-- AXCELERATE-LOCATION-MATCH (owner 2026-11-28: "aXcelerate data is correct ... repair"; decision: overwrite the Skyline campus with
-- aXcelerate's, keep the record and its rooms). Himani's refresh failed: aXcelerate's campus "Melbourne CBD" (code MEL CBD, Level 8,
-- 310 King Street) is Skyline's "King Street campus" (also MEL CBD); the import matched only by name, tried to create a second campus
-- with the same AVETMISS location ID (unique), so her class had no campus and her Qualification could not be placed.
--   * axcelerate_import_location now matches an unlinked Skyline location first by its AVETMISS location ID (aXcelerate CODE), then by
--     name, and takes aXcelerate's name and address for it (aXcelerate is the source of truth for campuses; the location id, its rooms
--     and everything that points at it stay). The code is set on a name match only when no other location uses it.
--   * A location already linked and edited in Skyline after its last import still becomes a conflict (unchanged).
begin;

create or replace function public.axcelerate_import_location(p_connection uuid, p_run uuid, p_actor uuid, p_rec jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ax text := public.axcelerate_text(p_rec, 'ID', 'CONTACTID', 'DELIVERYLOCATIONID');
  v_name text := left(coalesce(public.axcelerate_text(p_rec, 'NAME'), 'aXcelerate location ' || v_ax), 120);
  v_street text := concat_ws(' ', public.axcelerate_text(p_rec, 'UNITNO'), public.axcelerate_text(p_rec, 'STREETNO'), public.axcelerate_text(p_rec, 'STREETNAME'));
  v_suburb text := left(public.axcelerate_text(p_rec, 'CITY', 'SCITY'), 50);
  v_state text := upper(coalesce(public.axcelerate_text(p_rec, 'STATE', 'SSTATE'), ''));
  v_post text := public.axcelerate_text(p_rec, 'POSTCODE', 'SPOSTCODE');
  v_code text := public.axcelerate_text(p_rec, 'CODE');
  v_addr text; v_state_code text; l public.axcelerate_links; v_id uuid; v_new jsonb; v_old jsonb; v_complete boolean;
begin
  if v_ax is null then raise exception 'The location has no aXcelerate ID' using errcode = '22023'; end if;
  perform public.axcelerate_importing(p_actor);
  if public.axcelerate_is_skipped(p_connection, 'location', v_ax) then return public.axcelerate_outcome('skipped', null); end if;
  if btrim(v_street) = '' then v_street := public.axcelerate_text(p_rec, 'ADDRESS1', 'SADDRESS1', 'BUILDINGNAME'); end if;
  v_state_code := case v_state when 'NSW' then '01' when 'VIC' then '02' when 'QLD' then '03' when 'SA' then '04' when 'WA' then '05'
                               when 'TAS' then '06' when 'NT' then '07' when 'ACT' then '08' when 'OTHER' then '09' else null end;
  v_addr := nullif(btrim(concat_ws(', ', nullif(btrim(v_street), ''), concat_ws(' ', v_suburb, v_state, v_post))), '');
  if v_post !~ '^[0-9]{4}$' then v_post := null; end if;
  if v_code !~ '^[A-Za-z0-9 ]{1,10}$' then v_code := null; end if;
  v_complete := v_addr is not null and v_suburb is not null and v_post is not null and v_state_code is not null;
  v_new := jsonb_build_object('name', v_name, 'address', v_addr, 'suburb', v_suburb, 'postcode', v_post, 'state_code', v_state_code);
  l := public.axcelerate_link_find(p_connection, 'location', v_ax);
  if l.id is not null then
    select to_jsonb(x) - 'id' into v_old from (select name, address, suburb, postcode, state_code from public.locations where id = l.target_id::uuid) x;
    if v_old is null then delete from public.axcelerate_links where id = l.id; l := null;
    elsif l.edited_in_skyline_at is not null and l.edited_in_skyline_at > l.last_imported_at then
      perform public.axcelerate_conflicts_record(l.id, p_run, v_old, v_new);
      perform public.axcelerate_link_save(p_connection, p_run, 'location', v_ax, 'public.locations', l.target_id, p_rec);
      return public.axcelerate_outcome('conflict', l.target_id);
    else
      update public.locations set name = v_name, address = coalesce(v_addr, address), suburb = coalesce(v_suburb, suburb),
             postcode = coalesce(v_post, postcode), state_code = coalesce(v_state_code, state_code) where id = l.target_id::uuid;
      perform public.axcelerate_link_save(p_connection, p_run, 'location', v_ax, 'public.locations', l.target_id, p_rec);
      return public.axcelerate_outcome('updated', l.target_id);
    end if;
  end if;
  -- An unlinked Skyline location: the same AVETMISS location ID first (it is the campus's identity in NAT00020), then the same name.
  if v_code is not null then
    select id into v_id from public.locations where upper(btrim(avetmiss_location_id)) = upper(btrim(v_code))
      and not exists (select 1 from public.axcelerate_links x where x.connection_id = p_connection and x.entity = 'location' and x.target_id = locations.id::text)
      order by created_at limit 1;
  end if;
  if v_id is null then
    select id into v_id from public.locations where lower(btrim(name)) = lower(btrim(v_name))
      and not exists (select 1 from public.axcelerate_links x where x.connection_id = p_connection and x.entity = 'location' and x.target_id = locations.id::text)
      order by created_at limit 1;
  end if;
  if v_id is not null then
    -- aXcelerate is the source of truth for campuses (owner 2026-11-28): its name and address replace Skyline's; the record stays.
    update public.locations set name = v_name, address = coalesce(v_addr, address), suburb = coalesce(v_suburb, suburb),
           postcode = coalesce(v_post, postcode), state_code = coalesce(v_state_code, state_code),
           avetmiss_location_id = case when v_code is not null and not exists (select 1 from public.locations o where o.id <> v_id
             and upper(btrim(o.avetmiss_location_id)) = upper(btrim(v_code))) then v_code else avetmiss_location_id end
     where id = v_id;
    perform public.axcelerate_link_save(p_connection, p_run, 'location', v_ax, 'public.locations', v_id::text, p_rec);
    return public.axcelerate_outcome('linked', v_id::text);
  end if;
  -- An incomplete aXcelerate address is still created (switched off) so classes can point at it; an admin completes it to use it.
  insert into public.locations(name, address, suburb, postcode, state_code, country_code, avetmiss_location_id, kind, is_active)
  values (v_name, v_addr, v_suburb, v_post, v_state_code, '1101', v_code, 'theory', v_complete)
  returning id into v_id;
  perform public.axcelerate_link_save(p_connection, p_run, 'location', v_ax, 'public.locations', v_id::text, p_rec);
  return public.axcelerate_outcome('created', v_id::text, jsonb_build_object('active', v_complete));
end $$;

commit;
