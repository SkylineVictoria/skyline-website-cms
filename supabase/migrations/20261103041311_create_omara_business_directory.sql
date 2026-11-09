create table public.omara_business_directory (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  normalized_business_name text,
  legal_entity_name text,
  trading_name text,
  abn text,
  acn text,
  entity_type text,
  abn_status text,
  abn_status_effective_from date,
  gst_status text,
  gst_effective_from date,
  business_email text,
  business_phone text,
  business_website text,
  business_address text,
  suburb text,
  state text,
  postcode text,
  country text default 'Australia',
  marn text,
  agent_first_name text,
  agent_family_name text,
  agent_full_name text,
  agent_registration_status text,
  agent_registration_start_date date,
  agent_phone text,
  agent_email text,
  agent_website text,
  omara_contact_id text,
  omara_source_url text,
  omara_is_active boolean,
  abr_source_url text,
  abr_match_status text,
  abr_match_score numeric(5,2),
  abr_matched_name text,
  source text default 'OMARA',
  last_checked_at timestamptz,
  omara_last_synced_at timestamptz,
  abr_last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.omara_business_directory enable row level security;

create index omara_business_directory_marn_idx on public.omara_business_directory (marn);
create index omara_business_directory_abn_idx on public.omara_business_directory (abn);
create index omara_business_directory_normalized_name_idx on public.omara_business_directory (normalized_business_name);
create index omara_business_directory_business_name_idx on public.omara_business_directory (business_name);;
