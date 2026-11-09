-- Holding place for business info restored from the OMARA register (owner's decision, 3 Nov 2026).
-- Business contact details are shown to SLIT admins through the admin functions; the single OMARA agent kept per
-- business is reference only and is never returned to any screen. Both live in skyline_private, which browser roles
-- (anon, authenticated) cannot use. Empty until the backup data is copied in.
set local lock_timeout='5s';

create table skyline_private.business_directory_info (
 business_id uuid primary key references public.businesses(id) on delete cascade,
 business_name text not null,
 email text, phone text, website text,
 address text, suburb text, state text, postcode text, country text,
 source text not null default 'omara' check (source in ('omara')),
 restored_at timestamptz not null default now()
);

create table skyline_private.business_omara_agent (
 business_id uuid primary key references public.businesses(id) on delete cascade,
 marn text not null,
 full_name text not null, first_name text, family_name text,
 registration_status text, registration_start_date date, is_active boolean,
 omara_contact_id text, source_url text, last_synced_at timestamptz,
 restored_at timestamptz not null default now()
);
create index business_omara_agent_marn on skyline_private.business_omara_agent(marn);

revoke all on skyline_private.business_directory_info, skyline_private.business_omara_agent from public, anon, authenticated;
grant select, insert, update, delete on skyline_private.business_directory_info, skyline_private.business_omara_agent to service_role;
alter table skyline_private.business_directory_info enable row level security;
alter table skyline_private.business_omara_agent enable row level security;

comment on table skyline_private.business_directory_info is 'Contact details of businesses restored from the OMARA register. Shown to SLIT admins only via admin functions.';
comment on table skyline_private.business_omara_agent is 'One OMARA-registered agent per restored business. Reference only: never returned to any screen.';;
