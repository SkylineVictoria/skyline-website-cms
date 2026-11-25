-- Pulled from hosted supabase_migrations.schema_migrations (applied on hosted by another session without a repo file; 2026-11-25).
-- NAT00010: the RTO as reported to NCVER
alter table public.cms_settings
  add column avetmiss_toid text check (avetmiss_toid ~ '^[0-9A-Za-z]{1,10}$'),
  add column avetmiss_legal_name text check (char_length(avetmiss_legal_name) <= 100),
  add column avetmiss_org_type_code text default '91' check (public.avetmiss_is_code('org_type', avetmiss_org_type_code)),
  add column avetmiss_address_line1 text check (char_length(avetmiss_address_line1) <= 50),
  add column avetmiss_address_line2 text check (char_length(avetmiss_address_line2) <= 50),
  add column avetmiss_suburb text check (char_length(avetmiss_suburb) <= 50),
  add column avetmiss_postcode text check (avetmiss_postcode ~ '^[0-9]{4}$'),
  add column avetmiss_state_code text check (public.avetmiss_is_code('state', avetmiss_state_code)),
  add column avetmiss_contact_name text check (char_length(avetmiss_contact_name) <= 60),
  add column avetmiss_contact_phone text check (char_length(avetmiss_contact_phone) <= 20),
  add column avetmiss_contact_email text check (char_length(avetmiss_contact_email) <= 80);

-- Values as SLIT reported them in its 2024 NCVER submission
update public.cms_settings
   set avetmiss_toid = '45989',
       avetmiss_legal_name = 'INDOPACIFIC GLOBAL PTY LTD'
 where avetmiss_toid is null;

-- NAT00020: training delivery locations
alter table public.locations
  add column avetmiss_location_id text check (avetmiss_location_id ~ '^[A-Za-z0-9 ]{1,10}$'),
  add column suburb text check (char_length(suburb) <= 50),
  add column postcode text check (postcode ~ '^[0-9]{4}$'),
  add column state_code text check (public.avetmiss_is_code('state', state_code)),
  add column country_code text not null default '1101' check (country_code ~ '^[0-9]{4}$');
create unique index locations_avetmiss_location_id_key on public.locations (upper(avetmiss_location_id)) where avetmiss_location_id is not null;
comment on column public.locations.avetmiss_location_id is 'NAT00020 Training organisation delivery location identifier. Keep the ID used in earlier NCVER submissions (King Street = MEL CBD).';
comment on column public.locations.country_code is 'SACC country code; 1101 = Australia.';

-- Suburb / postcode / state where the address states them plainly
update public.locations
   set suburb = substring(address from ',\s*([A-Za-z ]+?)\s+VIC\s+[0-9]{4}\s*$'),
       postcode = substring(address from 'VIC\s+([0-9]{4})\s*$'),
       state_code = '02'
 where address ~ ',\s*[A-Za-z ]+\s+VIC\s+[0-9]{4}\s*$';
update public.locations set avetmiss_location_id = 'MEL CBD' where address ilike '%310 King St%Melbourne%';
