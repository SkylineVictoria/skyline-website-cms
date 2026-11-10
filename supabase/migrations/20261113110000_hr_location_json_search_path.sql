begin;

-- After the 2026-11-11 release the advisors named two new objects: hr.location_json had no fixed search_path (the only function of
-- 20261113090000 without one) and hr.employment.location_id had no index. Both fixed here; nothing else changes.
create or replace function hr.location_json(l hr.locations) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $fn$
 select jsonb_build_object('id', l.id, 'name', l.name, 'address', l.address, 'isActive', l.is_active, 'updatedAt', l.updated_at);
$fn$;
revoke all on function hr.location_json(hr.locations) from public, anon, authenticated;

create index if not exists employment_location_idx on hr.employment(location_id) where location_id is not null;

commit;
