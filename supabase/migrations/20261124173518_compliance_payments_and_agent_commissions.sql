-- Pulled from hosted supabase_migrations.schema_migrations (applied on hosted by another session without a repo file; 2026-11-25).
-- TPS levy: which payments are overseas tuition, and for whom
alter table public.payments
  add column fee_type text check (fee_type in ('tuition','enrolment','materials','oshc','other')),
  add column student_id uuid references public.enrollment_students(id) on delete set null,
  add column intake_enrolment_id uuid references public.intake_enrolments(id) on delete set null,
  add column course_id text references public.cms_courses(id) on delete set null,
  add column source text not null default 'stripe' check (source in ('stripe','xero','manual')),
  add column external_reference text check (char_length(external_reference) <= 200);
create index payments_student_idx on public.payments (student_id);
create index payments_fee_type_paid_idx on public.payments (fee_type, paid_at);

-- Education agent commission data collection (Department of Education, via PRISMS)
create table public.agent_commissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete restrict,
  agency_id uuid not null references public.agencies(id) on delete restrict,
  agent_id uuid references public.agents(id) on delete set null,
  student_id uuid references public.enrollment_students(id) on delete set null,
  intake_enrolment_id uuid references public.intake_enrolments(id) on delete set null,
  payment_id uuid references public.payments(id) on delete set null,
  benefit_type text not null check (benefit_type in ('monetary_direct','monetary_indirect','non_monetary')),
  description text check (char_length(description) <= 1000),
  amount_cents integer not null check (amount_cents >= 0),
  gst_cents integer not null default 0 check (gst_cents >= 0),
  currency text not null default 'aud',
  paid_on date not null,
  source text not null default 'manual' check (source in ('manual','xero')),
  external_reference text check (char_length(external_reference) <= 200),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.agent_commissions is 'Commissions and other benefits given to education agencies, per student where known: what the Department''s agent commission collection asks for.';
create index agent_commissions_agency_paid_idx on public.agent_commissions (agency_id, paid_on);
create index agent_commissions_student_idx on public.agent_commissions (student_id);

alter table public.agent_commissions enable row level security;
create policy agent_commissions_admin on public.agent_commissions for all
  using (public.cms_is_admin() and public.tenant_scope(tenant_id))
  with check (public.cms_is_admin() and public.tenant_scope(tenant_id));

create or replace function public.agent_commissions_touch()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
create trigger agent_commissions_touch before update on public.agent_commissions
  for each row execute function public.agent_commissions_touch();
