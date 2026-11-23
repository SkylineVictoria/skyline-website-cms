-- ASM-HEADER (2026-11-23, owner): the workbook header image is an institution setting (Assessments > Settings), not hard-coded.
--
-- asm_settings.workbook_header_url: the picture drawn on the left of every workbook page header (the Review step's page view,
-- the student view and "Export as workbook PDF"); the address block on the right still comes from Website Settings.
-- The picture is uploaded to the existing public bucket template-assets (its own policies: CMS admins / tenant editors), so no
-- new bucket. Allowed values: a public template-assets URL, or the bundled Skyline logo /templates/image.png.
--   asm_workbook_header()          -> {url} for the current tenant (any signed-in user: students export their own workbook)
--   asm_workbook_header_set(url)   -> Admins / RTO Managers (asm_is_admin); null clears it; logged in the assessment audit.
-- Additive: one nullable column with a check, two functions; no data changes.

alter table public.asm_settings add column if not exists workbook_header_url text;
do $$ begin
 if not exists (select 1 from pg_constraint where conname = 'asm_settings_workbook_header_url_check') then
  alter table public.asm_settings add constraint asm_settings_workbook_header_url_check check (
   workbook_header_url is null or (length(workbook_header_url) <= 1000
    and (workbook_header_url = '/templates/image.png' or workbook_header_url ~ '^https?://[^/]+/storage/v1/object/public/template-assets/[A-Za-z0-9/_.-]+\.(png|jpg)$')));
 end if;
end $$;

create or replace function public.asm_workbook_header() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid := public.tenant_current(); v_url text;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 select s.workbook_header_url into v_url from public.asm_settings s
  where coalesce(s.tenant_id, '00000000-0000-0000-0000-000000000000') = coalesce(v_tenant, '00000000-0000-0000-0000-000000000000');
 if v_url is null and v_tenant is not null then
  select s.workbook_header_url into v_url from public.asm_settings s where s.tenant_id is null;
 end if;
 return jsonb_build_object('url', v_url);
end $$;
revoke all on function public.asm_workbook_header() from public, anon;
grant execute on function public.asm_workbook_header() to authenticated;

create or replace function public.asm_workbook_header_set(p_url text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.tenant_current(); v_set public.asm_settings; v_url text := nullif(btrim(coalesce(p_url, '')), '');
begin
 if not public.asm_is_admin() then raise exception 'Only an Admin or an RTO Manager can change the workbook header.' using errcode = '42501'; end if;
 select * into v_set from public.asm_settings
  where coalesce(tenant_id, '00000000-0000-0000-0000-000000000000') = coalesce(v_tenant, '00000000-0000-0000-0000-000000000000');
 if v_set.id is null then insert into public.asm_settings(tenant_id) values (v_tenant) returning * into v_set; end if;
 -- the check constraint refuses anything but a template-assets picture or the bundled logo
 update public.asm_settings set workbook_header_url = v_url, updated_by = auth.uid(), updated_at = now() where id = v_set.id;
 perform public.asm_log('admin', 'workbook_header_set', 'settings', v_set.id::text, jsonb_build_object('url', v_url), v_set.tenant_id);
 return jsonb_build_object('url', v_url);
end $$;
revoke all on function public.asm_workbook_header_set(text) from public, anon;
grant execute on function public.asm_workbook_header_set(text) to authenticated;
