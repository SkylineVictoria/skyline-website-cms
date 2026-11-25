-- ORG-BUSINESS-DETAILS (2026-11-25, owner: "add all fields which you bring from Google Maps and the ABN API"): Settings & Policies ›
-- AVETMISS settings keeps everything Look up ABN returns about SLIT itself on the one settings row. Additive columns only; the existing
-- website columns (name, legal_name, address, phone, website) are not touched by the lookup. Same row-level policies as the rest of
-- cms_settings (read by everyone: these are public register / Google Maps facts; written by admins).
begin;
alter table public.cms_settings
  add column if not exists org_acn text,
  add column if not exists org_entity_name text,
  add column if not exists org_entity_type text,
  add column if not exists org_trading_names text,
  add column if not exists org_abn_status text,
  add column if not exists org_abn_status_from date,
  add column if not exists org_gst_status text,
  add column if not exists org_gst_from date,
  add column if not exists org_register_state text,
  add column if not exists org_register_postcode text,
  add column if not exists org_abr_url text,
  add column if not exists org_abr_checked_at timestamptz,
  add column if not exists org_place_name text,
  add column if not exists org_place_address text,
  add column if not exists org_place_street text,
  add column if not exists org_place_suburb text,
  add column if not exists org_place_state text,
  add column if not exists org_place_postcode text,
  add column if not exists org_place_country text,
  add column if not exists org_place_website text,
  add column if not exists org_place_phone text,
  add column if not exists org_place_phone_international text,
  add column if not exists org_place_maps_url text,
  add column if not exists org_place_id text,
  add column if not exists org_place_business_status text,
  add column if not exists org_place_match_percent smallint,
  add column if not exists org_place_checked_at timestamptz;
alter table public.cms_settings
  add constraint cms_settings_org_acn_check check (org_acn is null or org_acn ~ '^[0-9]{9}$') not valid,
  add constraint cms_settings_org_place_match_check check (org_place_match_percent is null or org_place_match_percent between 0 and 100) not valid,
  add constraint cms_settings_org_text_len_check check (
    coalesce(length(org_entity_name), 0) <= 200 and coalesce(length(org_trading_names), 0) <= 1000 and coalesce(length(org_place_address), 0) <= 300
    and coalesce(length(org_place_website), 0) <= 300 and coalesce(length(org_place_maps_url), 0) <= 500 and coalesce(length(org_abr_url), 0) <= 500) not valid;
commit;
