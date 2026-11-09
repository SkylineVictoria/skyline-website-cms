create or replace function public.agent_picker_options(p_business uuid, p_search text default '')
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare v_words text[] := public.admin_search_words(p_search);
begin
  if auth.uid() is null then
    raise exception 'Sign-in required' using errcode = '42501';
  end if;
  if p_business is null then
    return '[]'::jsonb;
  end if;
  -- Same access rule as the business_agents read policy
  if not (public.portal_is_slit_admin()
          or exists (select 1 from public.agencies a
                     where a.business_id = p_business and a.id = public.portal_agency_id())) then
    raise exception 'Not allowed to view agents for this business' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'agentId', g.id,
             'profileId', g.profile_id,
             'name', g.full_name,
             'email', g.email)
           order by lower(g.full_name), g.id)
    from public.business_agents g
    where g.business_id = p_business
      and g.status = 'Active'
      and g.profile_id is not null
      and exists (select 1 from public.agency_memberships m
                  join public.portal_profiles pp on pp.id = m.user_id
                  where m.user_id = g.profile_id and m.status = 'Active' and pp.status = 'Active')
      and not exists (select 1 from unnest(v_words) w
                      where strpos(lower(concat_ws(' ', g.full_name, g.email)), w) = 0)
  ), '[]'::jsonb);
end $function$;

revoke all on function public.agent_picker_options(uuid, text) from public, anon;
grant execute on function public.agent_picker_options(uuid, text) to authenticated;;
