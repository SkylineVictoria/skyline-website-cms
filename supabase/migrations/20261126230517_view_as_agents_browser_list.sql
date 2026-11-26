-- VIEW-AS-ALL-AGENTS, browser list (owner, 2026-11-26: "I still don't see the business nor its agents"): the Sign in as > Agent
-- picker reads the grouped list straight from the database for the signed-in administrator (admin_view_as_agents of 20261126210517
-- with auth.uid() as the admin), so the list does not wait for the admin-view-as deploy. Non-admins are refused (42501). Same fields
-- only: business id / name, agent id / name / email / status / hasLogin.
-- Down: drop function public.admin_view_as_agents_list(text).
begin;

create or replace function public.admin_view_as_agents_list(p_query text default '') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Administrator access required' using errcode = '42501'; end if;
  return public.admin_view_as_agents(p_query, auth.uid());
end $$;
revoke all on function public.admin_view_as_agents_list(text) from public, anon;
grant execute on function public.admin_view_as_agents_list(text) to authenticated;

commit;
