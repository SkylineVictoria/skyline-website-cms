create table if not exists public.abr_businesses (
  abn                  text primary key,
  abn_status           text not null,            -- ACT / CAN
  abn_status_from      date,
  record_last_updated  date not null,
  replaced             boolean not null default false,
  entity_type_code     text,
  entity_type          text,
  main_name            text,
  other_names          text[],                   -- trading / business names
  acn                  text,
  gst_status           text,
  gst_status_from      date,
  state                text,
  postcode             text,
  synced_at            timestamptz not null default now()
);

create index if not exists abr_businesses_acn_idx on public.abr_businesses (acn) where acn is not null;
create index if not exists abr_businesses_state_postcode_idx on public.abr_businesses (state, postcode);
create index if not exists abr_businesses_updated_idx on public.abr_businesses (record_last_updated);

create table if not exists public.abr_sync_runs (
  id                bigserial primary key,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  status            text not null default 'running',  -- running / success / failed
  mode              text,                              -- full / incremental
  cutoff_date       date,
  records_seen      bigint default 0,
  records_upserted  bigint default 0,
  error             text
);

-- Service-role only: no policies, so anon/authenticated can't read 19M rows via the API
alter table public.abr_businesses enable row level security;
alter table public.abr_sync_runs  enable row level security;;
