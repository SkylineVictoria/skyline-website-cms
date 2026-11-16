-- CLASS-SESSIONS-RESET: remove a batch's whole course calendar, and optionally build it again from the intake start.
-- Unlike rto_class_sessions_generate (which keeps past and hand-changed classes and rebuilds from today), a reset
-- deletes every dated class of the batch, including past, cancelled and hand-changed ones. The weekly class timing
-- (batch_sessions) is not touched. Additive: one new function.

create or replace function public.rto_class_sessions_reset(p_batch uuid, p_regenerate boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_removed int; v_out jsonb := '{}'::jsonb;
begin
 if not public.cms_is_rto_manager() then raise exception 'Only an RTO Manager can remove or recreate a course calendar.' using errcode = '42501'; end if;
 if not exists(select 1 from public.batches where id = p_batch) then raise exception 'Batch not found.' using errcode = 'P0002'; end if;
 delete from public.class_sessions where batch_id = p_batch;
 get diagnostics v_removed = row_count;
 -- With no classes left the generator starts from the intake start date.
 if p_regenerate then v_out := public.rto_class_sessions_generate(p_batch); end if;
 return v_out || jsonb_build_object('removed', v_removed);
end $$;

revoke all on function public.rto_class_sessions_reset(uuid, boolean) from public, anon;
grant execute on function public.rto_class_sessions_reset(uuid, boolean) to authenticated;
