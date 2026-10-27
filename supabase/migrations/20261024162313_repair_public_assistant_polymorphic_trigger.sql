-- Preserve dispatch/approval behavior while supporting all three trigger tables.
-- PostgreSQL resolves record fields before boolean short-circuit evaluation;
-- pages/courses do not have the document-only approval column.
create or replace function public.public_assistant_queue_cms_source()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_type text := tg_argv[0]; v_key text; v_dispatch boolean := false;
begin
  v_key := case when tg_op = 'DELETE' then old.id else new.id end;
  delete from public.public_assistant_answer_cache where cache_key is not null;
  if tg_op = 'DELETE' or coalesce(new.status, 'Draft') <> 'Published'
     or (v_type = 'document' and not coalesce((to_jsonb(new)->>'assistant_publication_approved')::boolean, false)) then
    update public.public_assistant_sources set publication_status = 'unpublished', updated_at = clock_timestamp()
      where source_type = v_type and source_key = v_key and publication_status = 'published';
    update public.public_assistant_index_jobs set state = 'cancelled', lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
      where source_type = v_type and source_key = v_key and state = 'queued';
    return coalesce(new, old);
  end if;
  v_dispatch := public.public_assistant_enqueue_index_job(v_type, v_key);
  if v_dispatch then perform public.public_assistant_dispatch_index_worker(); end if;
  return new;
end;
$$;
revoke all on function public.public_assistant_queue_cms_source() from public, anon, authenticated;
