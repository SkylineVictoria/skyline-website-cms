-- ASM-ANY-LAYOUT (owner 2026-11-27): workbooks of any layout. The fields are found by code (candidates + rules, in the browser); the AI
-- only classifies the areas the rules cannot settle (asm-import classify_fields). This migration keeps:
--  * public.asm_ai_usage: every classifier call per workbook (its PDF's sha256): model, tokens, cost in USD. A workbook stops at
--    US$2 (asm-import checks the sum before each page); the admin screen shows the total.
--  * public.asm_layout_profiles: an admin's corrections saved as a profile, recognised by the workbook's running header / footer
--    (numbers ignored) and applied by itself to later workbooks of the same layout (before any AI).
-- Admins and RTO Managers only (asm_is_admin), within their institution (tenant_scope). Additive. Down: drop the two tables and the
-- three functions.

create table public.asm_ai_usage (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete restrict,
  assessment_id uuid references public.asm_assessments(id) on delete set null,
  pdf_sha256 text not null check (pdf_sha256 ~ '^[a-f0-9]{64}$'),
  action text not null check (action in ('classify_fields')),
  model text not null check (char_length(model) between 1 and 80),
  page integer check (page between 1 and 600),
  candidates integer not null default 0 check (candidates >= 0),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cost_usd numeric(10, 6) not null default 0 check (cost_usd >= 0),
  refused integer not null default 0 check (refused >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index asm_ai_usage_pdf on public.asm_ai_usage(pdf_sha256);
create index asm_ai_usage_assessment on public.asm_ai_usage(assessment_id);
alter table public.asm_ai_usage enable row level security;
revoke all on public.asm_ai_usage from public, anon, authenticated;
comment on table public.asm_ai_usage is 'ASM-ANY-LAYOUT: AI classifier calls per workbook (tokens, USD); written by asm-import (service role), read through asm_ai_usage_summary.';

create table public.asm_layout_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete restrict,
  signature text not null check (signature ~ '^[a-f0-9]{64}$'),
  chrome jsonb not null default '[]'::jsonb check (jsonb_typeof(chrome) = 'array'),
  corrections jsonb not null default '[]'::jsonb check (jsonb_typeof(corrections) = 'array' and jsonb_array_length(corrections) <= 4000),
  sample_assessment_id uuid references public.asm_assessments(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index asm_layout_profiles_signature on public.asm_layout_profiles(coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), signature);
alter table public.asm_layout_profiles enable row level security;
revoke all on public.asm_layout_profiles from public, anon, authenticated;
comment on table public.asm_layout_profiles is 'ASM-ANY-LAYOUT: admin corrections per workbook layout (running header / footer signature), applied to later workbooks of that layout.';

-- The AI usage of an assessment's workbooks: total and per call (admins).
create or replace function public.asm_ai_usage_summary(p_assessment uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.asm_is_admin() then raise exception 'Admin or RTO Manager access is required.' using errcode = '42501'; end if;
  return (select jsonb_build_object(
      'calls', count(*), 'inputTokens', coalesce(sum(u.input_tokens), 0), 'outputTokens', coalesce(sum(u.output_tokens), 0),
      'costUsd', coalesce(sum(u.cost_usd), 0), 'models', coalesce(jsonb_agg(distinct u.model), '[]'::jsonb), 'limitUsd', 2)
    from public.asm_ai_usage u
    where u.assessment_id = p_assessment and public.tenant_scope(u.tenant_id));
end $$;
revoke all on function public.asm_ai_usage_summary(uuid) from public, anon;
grant execute on function public.asm_ai_usage_summary(uuid) to authenticated;

-- The saved profile of a layout (null when none).
create or replace function public.asm_layout_profile_get(p_signature text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.asm_is_admin() then raise exception 'Admin or RTO Manager access is required.' using errcode = '42501'; end if;
  return (select jsonb_build_object('id', p.id, 'signature', p.signature, 'chrome', p.chrome, 'corrections', p.corrections, 'updatedAt', p.updated_at)
    from public.asm_layout_profiles p where p.signature = p_signature and public.tenant_scope(p.tenant_id)
    order by p.updated_at desc limit 1);
end $$;
revoke all on function public.asm_layout_profile_get(text) from public, anon;
grant execute on function public.asm_layout_profile_get(text) to authenticated;

-- Saves (merges) an admin's corrections into the layout's profile: a correction for the same area key replaces the older one.
create or replace function public.asm_layout_profile_save(p_signature text, p_chrome jsonb, p_corrections jsonb, p_assessment uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_id uuid; v_merged jsonb;
begin
  if not public.asm_is_admin() then raise exception 'Admin or RTO Manager access is required.' using errcode = '42501'; end if;
  if coalesce(p_signature, '') !~ '^[a-f0-9]{64}$' then raise exception 'The layout signature is not valid.' using errcode = '22023'; end if;
  if jsonb_typeof(p_corrections) <> 'array' or jsonb_typeof(coalesce(p_chrome, '[]'::jsonb)) <> 'array' then raise exception 'Corrections must be a list.' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_corrections) c where jsonb_typeof(c) <> 'object' or coalesce(c->>'key', '') = '' or char_length(c->>'key') > 600) then
    raise exception 'Each correction needs its area key.' using errcode = '22023';
  end if;
  select a.tenant_id into v_tenant from public.asm_assessments a where a.id = p_assessment and public.tenant_scope(a.tenant_id);
  select p.id into v_id from public.asm_layout_profiles p where p.signature = p_signature and coalesce(p.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(v_tenant, '00000000-0000-0000-0000-000000000000'::uuid) for update;
  if v_id is null then
    insert into public.asm_layout_profiles(tenant_id, signature, chrome, corrections, sample_assessment_id, updated_by)
    values (v_tenant, p_signature, coalesce(p_chrome, '[]'::jsonb), p_corrections, p_assessment, auth.uid()) returning id into v_id;
  else
    select coalesce(jsonb_agg(x.c order by x.k), '[]'::jsonb) into v_merged from (
      select distinct on (c->>'key') c->>'key' as k, c from (
        select c, 1 as o from jsonb_array_elements(p_corrections) c
        union all select c, 2 from jsonb_array_elements((select corrections from public.asm_layout_profiles where id = v_id)) c
      ) s order by c->>'key', o) x;
    if jsonb_array_length(v_merged) > 4000 then raise exception 'The profile is too large.' using errcode = '22023'; end if;
    update public.asm_layout_profiles set corrections = v_merged, chrome = coalesce(p_chrome, chrome), updated_by = auth.uid(), updated_at = now(),
      sample_assessment_id = coalesce(p_assessment, sample_assessment_id) where id = v_id;
  end if;
  return public.asm_layout_profile_get(p_signature);
end $$;
revoke all on function public.asm_layout_profile_save(text, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.asm_layout_profile_save(text, jsonb, jsonb, uuid) to authenticated;

-- An AI-set field (template field review = pending) waits for the admin's Accept or Reject: Publish is refused until none is left, and
-- the editing summary says how many are left (patched in place, single-line anchors).
do $$
declare d text;
  a1 constant text := $a$  elsif jsonb_array_length(coalesce(v_ver.template->'questions', '[]')) = 0 then v_errs := v_errs || jsonb_build_object('code', 'no_questions', 'message', 'The workbook PDF has no questions yet.'); end if;$a$;
  a2 constant text := $a$'hasTemplate', v_ver.template is not null, 'questions', coalesce(jsonb_array_length(v_ver.template->'questions'), 0),$a$;
begin
  d := pg_get_functiondef('public.asm_admin(text,jsonb)'::regprocedure);
  if position(a1 in d) = 0 then raise exception 'anchor not found in asm_admin (publish)'; end if;
  if position(a2 in d) = 0 then raise exception 'anchor not found in asm_admin (editing summary)'; end if;
  d := replace(d, a1, a1 || E'\n  if exists (select 1 from jsonb_array_elements(coalesce(v_ver.template->''fields'', ''[]'')) f where f->>''review'' = ''pending'') then v_errs := v_errs || jsonb_build_object(''code'', ''ai_pending'', ''message'', ''Accept or reject the fields set by AI before publishing.''); end if;');
  d := replace(d, a2, a2 || $b$ 'aiPending', (select count(*) from jsonb_array_elements(coalesce(v_ver.template->'fields', '[]')) f where f->>'review' = 'pending'),$b$);
  execute d;
end $$;
