-- ASM-OVERVIEW (2026-11-25, owner): the assessment page's read-only Overview, its block editing and the Add assessment waiting screen.
--
-- 1. asm_overview_save(assessment, payload): a block edited in the Overview's side drawer (learner instructions, a question, its
--    parts / table rows, a template, a supporting material) is saved exactly like the Builder's autosave (asm_admin draft_save: a
--    draft saves in place, a published version starts the next draft; attempts keep the version they began with) and, in the same
--    transaction, one asm_audit_log row (action overview_edit, target the version) records who, when, which block and the text
--    before / after (each at most 4000 characters). Nothing is logged when the save is refused.
-- 2. asm_import_start reattaches to a job of the same file, kind and reader version that is still queued or running (another tab,
--    or the admin came back after leaving the Add assessment screen) instead of reading the file a second time.
-- 3. asm_import_recent(): the caller's imports of the last 24 hours (no result body) for "Resume" on the Assessments list.

create or replace function public.asm_overview_save(p_assessment uuid, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_block jsonb := coalesce(p_payload->'block', '{}'::jsonb); v_kind text := v_block->>'kind'; v_out jsonb; v_tenant uuid;
begin
 if not public.asm_is_admin() then raise exception 'Only admins and RTO managers can edit assessments' using errcode = '42501'; end if;
 if jsonb_typeof(coalesce(p_payload, 'null'::jsonb)) <> 'object' then raise exception 'The payload must be an object' using errcode = '22023'; end if;
 if coalesce(v_kind, '') not in ('instructions', 'question', 'parts', 'template', 'material', 'roleplay', 'steps') then
  raise exception 'Unknown block kind' using errcode = '22023';
 end if;
 select tenant_id into v_tenant from public.asm_assessments where id = p_assessment;
 if not found then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
 v_out := public.asm_admin('draft_save', jsonb_strip_nulls(jsonb_build_object('assessmentId', p_assessment, 'definition', p_payload->'definition',
   'keys', p_payload->'keys', 'expectedUpdatedAt', p_payload->'expectedUpdatedAt')));
 if coalesce((v_out->>'ok')::boolean, false) then
  perform public.asm_log('admin', 'overview_edit', 'version', coalesce(v_out->>'versionId', ''),
    jsonb_build_object('assessmentId', p_assessment, 'versionNo', (v_out->>'versionNo')::integer, 'block', v_kind,
      'blockId', left(coalesce(v_block->>'id', ''), 80), 'label', left(coalesce(v_block->>'label', ''), 200),
      'before', left(coalesce(v_block->>'before', ''), 4000), 'after', left(coalesce(v_block->>'after', ''), 4000)),
    v_tenant);
 end if;
 return v_out;
end $$;
revoke all on function public.asm_overview_save(uuid, jsonb) from public, anon;
grant execute on function public.asm_overview_save(uuid, jsonb) to authenticated;

-- Start an import: the finished one for the same file, kind and reader version; else one still being read; else a new job.
create or replace function public.asm_import_start(p_kind text, p_sha256 text, p_file_name text, p_bytes bigint, p_pages integer, p_scanned integer[] default '{}',
  p_force boolean default false, p_reader integer default 1)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.asm_import_jobs;
begin
 if not public.asm_is_admin() then raise exception 'Only admins and RTO managers can import assessments' using errcode = '42501'; end if;
 if p_kind not in ('workbook', 'guide') then raise exception 'Unknown import kind' using errcode = '22023'; end if;
 if coalesce(p_sha256, '') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid file fingerprint' using errcode = '22023'; end if;
 if coalesce(p_reader, 0) not between 1 and 1000 then raise exception 'Invalid reader version' using errcode = '22023'; end if;
 if not coalesce(p_force, false) then
  select * into j from public.asm_import_jobs
  where kind = p_kind and sha256 = p_sha256 and reader_version = p_reader and state = 'done' order by finished_at desc limit 1;
  if found then return public.asm_import_json(j, true); end if;
  -- the same file still being read (queued / running, started in the last two hours): watch that job, never pay twice
  select * into j from public.asm_import_jobs
  where kind = p_kind and sha256 = p_sha256 and reader_version = p_reader and state in ('queued', 'running') and created_at > now() - interval '2 hours'
  order by created_at desc limit 1;
  if found then return public.asm_import_json(j, false); end if;
 end if;
 insert into public.asm_import_jobs(kind, sha256, file_name, bytes, page_count, scanned_pages, reader_version)
 values (p_kind, p_sha256, left(coalesce(nullif(btrim(p_file_name), ''), 'upload.pdf'), 255), p_bytes, p_pages, coalesce(p_scanned, '{}'), p_reader)
 returning * into j;
 return public.asm_import_json(j, false);
end $$;
revoke all on function public.asm_import_start(text, text, text, bigint, integer, integer[], boolean, integer) from public, anon, authenticated, service_role;
grant execute on function public.asm_import_start(text, text, text, bigint, integer, integer[], boolean, integer) to authenticated;

-- The caller's imports of the last day, newest first, without the result (the Assessments list offers Resume).
create or replace function public.asm_import_recent() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
 if not public.asm_is_admin() then raise exception 'Only admins and RTO managers can import assessments' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', j.id, 'kind', j.kind, 'state', j.state, 'fileName', j.file_name, 'pages', j.page_count,
   'progress', j.progress, 'error', j.error, 'readerVersion', j.reader_version, 'createdAt', j.created_at, 'finishedAt', j.finished_at) order by j.created_at desc)
  from (select * from public.asm_import_jobs where created_by = auth.uid() and created_at > now() - interval '24 hours' and state <> 'uploading'
        order by created_at desc limit 10) j), '[]'::jsonb);
end $$;
revoke all on function public.asm_import_recent() from public, anon;
grant execute on function public.asm_import_recent() to authenticated;
