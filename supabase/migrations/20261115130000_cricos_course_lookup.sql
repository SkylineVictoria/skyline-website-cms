-- CRICOS-LOOKUP: every field of the CRICOS register (data.gov.au: Courses, Institutions, Locations, Course Locations)
-- kept on the course, editable. The cricos-lookup Edge Function only reads the register; the CMS saves through
-- rto_course_cricos_save. Columns added by 20261115100000 (cricos_provider_code, cricos_dual_qualification,
-- cricos_course_level, cricos_language, cricos_duration_weeks, cricos_tuition_fee, cricos_non_tuition_fee,
-- cricos_total_cost) are reused. cricos_course_code is the CRICOS code; a trigger copies it to the legacy `cricos`
-- column that the website and letters read. Unique per site when present; not required (domestic-only courses).
-- Extension point: training.gov.au data stays in the tga_* columns (tga-course-import).

alter table public.cms_courses
  add column if not exists cricos_course_code text,
  add column if not exists cricos_course_name text,
  add column if not exists cricos_vet_national_code text,
  add column if not exists cricos_foe1_broad text,
  add column if not exists cricos_foe1_broad_code text,
  add column if not exists cricos_foe1_narrow text,
  add column if not exists cricos_foe1_narrow_code text,
  add column if not exists cricos_foe1_detailed text,
  add column if not exists cricos_foe1_detailed_code text,
  add column if not exists cricos_foe2_broad text,
  add column if not exists cricos_foe2_broad_code text,
  add column if not exists cricos_foe2_narrow text,
  add column if not exists cricos_foe2_narrow_code text,
  add column if not exists cricos_foe2_detailed text,
  add column if not exists cricos_foe2_detailed_code text,
  add column if not exists cricos_foundation_studies boolean,
  add column if not exists cricos_has_work_component boolean,
  add column if not exists cricos_work_component_hours_week integer,
  add column if not exists cricos_work_component_weeks integer,
  add column if not exists cricos_work_component_total_hours integer,
  add column if not exists cricos_expired boolean,
  add column if not exists institution_name text,
  add column if not exists institution_trading_name text,
  add column if not exists institution_type text,
  add column if not exists institution_capacity integer,
  add column if not exists institution_website text,
  add column if not exists institution_postal_address_line_1 text,
  add column if not exists institution_postal_address_line_2 text,
  add column if not exists institution_postal_address_line_3 text,
  add column if not exists institution_postal_address_line_4 text,
  add column if not exists institution_postal_city text,
  add column if not exists institution_postal_state text,
  add column if not exists institution_postal_postcode text,
  add column if not exists cricos_snapshot jsonb,
  add column if not exists cricos_fetched_at timestamptz,
  add column if not exists cricos_edited_fields text[] not null default '{}';

alter table public.cms_courses drop constraint if exists cms_courses_cricos_course_code_format;
alter table public.cms_courses add constraint cms_courses_cricos_course_code_format
  check (cricos_course_code is null or cricos_course_code ~ '^[0-9]{6}[A-Z]$');
create unique index if not exists cms_courses_cricos_course_code_unique
  on public.cms_courses (tenant_id, cricos_course_code) nulls not distinct where cricos_course_code is not null;

create or replace function public.cms_courses_cricos_code() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.cricos_course_code := nullif(upper(btrim(coalesce(new.cricos_course_code, ''))), '');
  if new.cricos_course_code is not null then new.cricos := new.cricos_course_code; end if;
  return new;
end;
$$;
drop trigger if exists cms_courses_cricos_code on public.cms_courses;
create trigger cms_courses_cricos_code before insert or update of cricos_course_code on public.cms_courses
  for each row execute function public.cms_courses_cricos_code();

create table if not exists public.course_locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),
  course_id text not null references public.cms_courses(id) on delete cascade,
  location_name text not null check (length(btrim(location_name)) between 1 and 300),
  location_type text,
  address_line_1 text,
  address_line_2 text,
  address_line_3 text,
  address_line_4 text,
  city text,
  state text,
  postcode text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint course_locations_tenant_parent foreign key (course_id, tenant_id)
    references public.cms_courses(id, tenant_id) deferrable
);
create index if not exists course_locations_course_idx on public.course_locations (course_id, sort_order);
create index if not exists course_locations_tenant_idx on public.course_locations (tenant_id);
drop trigger if exists tenant_bind on public.course_locations;
create trigger tenant_bind before insert or update on public.course_locations
  for each row execute function public.tenant_bind_row('cms_courses', 'course_id');

-- Same policies as cms_course_units (child rows of a course).
alter table public.course_locations enable row level security;
drop policy if exists course_locations_read on public.course_locations;
create policy course_locations_read on public.course_locations for select using (
  public.cms_is_staff() or exists (select 1 from public.cms_courses c where c.id = course_id and c.status = 'Published'));
drop policy if exists course_locations_write on public.course_locations;
create policy course_locations_write on public.course_locations for all using (public.cms_is_staff()) with check (public.cms_is_staff());
drop policy if exists tenant_boundary_read on public.course_locations;
create policy tenant_boundary_read on public.course_locations as restrictive for select to anon, authenticated using (public.tenant_scope(tenant_id));
drop policy if exists tenant_boundary_insert on public.course_locations;
create policy tenant_boundary_insert on public.course_locations as restrictive for insert to authenticated with check (public.tenant_scope_write(tenant_id));
drop policy if exists tenant_boundary_update on public.course_locations;
create policy tenant_boundary_update on public.course_locations as restrictive for update to authenticated using (public.tenant_scope_write(tenant_id)) with check (public.tenant_scope_write(tenant_id));
drop policy if exists tenant_boundary_delete on public.course_locations;
create policy tenant_boundary_delete on public.course_locations as restrictive for delete to authenticated using (public.tenant_scope_write(tenant_id));
drop policy if exists tenant_member_read on public.course_locations;
create policy tenant_member_read on public.course_locations for select to authenticated using (tenant_id is not null and public.tenant_has_role(tenant_id, array['tenant_admin','editor','staff']));
drop policy if exists tenant_member_insert on public.course_locations;
create policy tenant_member_insert on public.course_locations for insert to authenticated with check (tenant_id is not null and public.tenant_has_role(tenant_id, array['tenant_admin','editor']));
drop policy if exists tenant_member_update on public.course_locations;
create policy tenant_member_update on public.course_locations for update to authenticated using (tenant_id is not null and public.tenant_has_role(tenant_id, array['tenant_admin','editor'])) with check (tenant_id is not null and public.tenant_has_role(tenant_id, array['tenant_admin','editor']));
drop policy if exists tenant_member_delete on public.course_locations;
create policy tenant_member_delete on public.course_locations for delete to authenticated using (tenant_id is not null and public.tenant_has_role(tenant_id, array['tenant_admin','editor']));
grant select on public.course_locations to anon, authenticated;
grant insert, update, delete on public.course_locations to authenticated;

-- Saves the CRICOS fields, locations, snapshot and edited-field list of a course in one transaction.
-- p_course_id null creates a draft course from the CRICOS data (code = VET national code, else the CRICOS code).
create or replace function public.rto_course_cricos_save(p_course_id text, p_fields jsonb, p_locations jsonb,
  p_snapshot jsonb default null, p_fetched_at timestamptz default null, p_edited text[] default '{}')
returns text language plpgsql security definer set search_path = '' as $$
declare
  r public.cms_courses;
  v_id text := nullif(btrim(coalesce(p_course_id, '')), '');
  v_tenant uuid;
  v_code text;
  v_slug text;
begin
  if not public.cms_is_rto_manager() then
    raise exception 'Only an RTO Manager can change courses.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_fields) is distinct from 'object' or jsonb_typeof(coalesce(p_locations, '[]'::jsonb)) <> 'array' then
    raise exception 'Invalid CRICOS details.' using errcode = '22023';
  end if;
  r := jsonb_populate_record(null::public.cms_courses, p_fields);
  r.cricos_course_code := nullif(upper(btrim(coalesce(r.cricos_course_code, ''))), '');
  if r.cricos_course_code is not null and r.cricos_course_code !~ '^[0-9]{6}[A-Z]$' then
    raise exception 'A CRICOS course code is six digits and a letter, e.g. 112739C.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_locations, '[]'::jsonb)) l(x)
             where nullif(btrim(coalesce(x->>'location_name', '')), '') is null) then
    raise exception 'Each location needs a name.' using errcode = '22023';
  end if;

  if v_id is null then
    v_tenant := public.tenant_current();
    if not public.tenant_scope_write(v_tenant) then raise exception 'You cannot add courses to this site.' using errcode = '42501'; end if;
    if r.cricos_course_code is null or nullif(btrim(coalesce(r.cricos_course_name, '')), '') is null then
      raise exception 'Fetch a CRICOS course (code and name) before creating the course.' using errcode = '22023';
    end if;
    v_code := upper(coalesce(nullif(btrim(r.cricos_vet_national_code), ''), r.cricos_course_code));
    if exists (select 1 from public.cms_courses where tenant_id is not distinct from v_tenant
               and (upper(btrim(code)) = v_code or cricos_course_code = r.cricos_course_code)) then
      raise exception 'A course with this code or CRICOS code already exists.' using errcode = '23505';
    end if;
    v_id := 'course-' || replace(gen_random_uuid()::text, '-', '');
    v_slug := lower(v_code);
    if exists (select 1 from public.cms_courses where slug = v_slug) then v_slug := v_slug || '-' || lower(r.cricos_course_code); end if;
    insert into public.cms_courses (id, tenant_id, slug, code, name, category, status, is_active)
    values (v_id, v_tenant, v_slug, v_code, btrim(r.cricos_course_name), coalesce(r.cricos_course_level, ''), 'Draft', false);
  else
    perform 1 from public.cms_courses where id = v_id and public.tenant_scope_write(tenant_id) for update;
    if not found then raise exception 'Course not found.' using errcode = 'P0002'; end if;
  end if;

  update public.cms_courses c set
    cricos_course_code = r.cricos_course_code, cricos_provider_code = r.cricos_provider_code,
    cricos_course_name = r.cricos_course_name, cricos_vet_national_code = r.cricos_vet_national_code,
    cricos_dual_qualification = r.cricos_dual_qualification,
    cricos_foe1_broad = r.cricos_foe1_broad, cricos_foe1_broad_code = r.cricos_foe1_broad_code,
    cricos_foe1_narrow = r.cricos_foe1_narrow, cricos_foe1_narrow_code = r.cricos_foe1_narrow_code,
    cricos_foe1_detailed = r.cricos_foe1_detailed, cricos_foe1_detailed_code = r.cricos_foe1_detailed_code,
    cricos_foe2_broad = r.cricos_foe2_broad, cricos_foe2_broad_code = r.cricos_foe2_broad_code,
    cricos_foe2_narrow = r.cricos_foe2_narrow, cricos_foe2_narrow_code = r.cricos_foe2_narrow_code,
    cricos_foe2_detailed = r.cricos_foe2_detailed, cricos_foe2_detailed_code = r.cricos_foe2_detailed_code,
    cricos_course_level = r.cricos_course_level, cricos_foundation_studies = r.cricos_foundation_studies,
    cricos_has_work_component = r.cricos_has_work_component, cricos_work_component_hours_week = r.cricos_work_component_hours_week,
    cricos_work_component_weeks = r.cricos_work_component_weeks, cricos_work_component_total_hours = r.cricos_work_component_total_hours,
    cricos_language = r.cricos_language, cricos_duration_weeks = r.cricos_duration_weeks,
    cricos_tuition_fee = r.cricos_tuition_fee, cricos_non_tuition_fee = r.cricos_non_tuition_fee,
    cricos_total_cost = r.cricos_total_cost, cricos_expired = r.cricos_expired,
    institution_name = r.institution_name, institution_trading_name = r.institution_trading_name,
    institution_type = r.institution_type, institution_capacity = r.institution_capacity, institution_website = r.institution_website,
    institution_postal_address_line_1 = r.institution_postal_address_line_1, institution_postal_address_line_2 = r.institution_postal_address_line_2,
    institution_postal_address_line_3 = r.institution_postal_address_line_3, institution_postal_address_line_4 = r.institution_postal_address_line_4,
    institution_postal_city = r.institution_postal_city, institution_postal_state = r.institution_postal_state,
    institution_postal_postcode = r.institution_postal_postcode,
    cricos_snapshot = coalesce(p_snapshot, c.cricos_snapshot), cricos_fetched_at = coalesce(p_fetched_at, c.cricos_fetched_at),
    cricos_edited_fields = coalesce(p_edited, '{}'), updated_at = now()
  where c.id = v_id;

  delete from public.course_locations where course_id = v_id;
  insert into public.course_locations (course_id, location_name, location_type, address_line_1, address_line_2, address_line_3,
    address_line_4, city, state, postcode, sort_order)
  select v_id, btrim(x->>'location_name'), nullif(btrim(x->>'location_type'), ''), nullif(btrim(x->>'address_line_1'), ''),
    nullif(btrim(x->>'address_line_2'), ''), nullif(btrim(x->>'address_line_3'), ''), nullif(btrim(x->>'address_line_4'), ''),
    nullif(btrim(x->>'city'), ''), nullif(btrim(x->>'state'), ''), nullif(btrim(x->>'postcode'), ''), (n - 1)::integer
  from jsonb_array_elements(coalesce(p_locations, '[]'::jsonb)) with ordinality l(x, n);
  return v_id;
end;
$$;
revoke all on function public.rto_course_cricos_save(text, jsonb, jsonb, jsonb, timestamptz, text[]) from public, anon;
grant execute on function public.rto_course_cricos_save(text, jsonb, jsonb, jsonb, timestamptz, text[]) to authenticated;
