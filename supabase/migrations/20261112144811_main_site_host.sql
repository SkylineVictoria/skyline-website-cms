-- Links in application emails pointed at slit.edu.au, which still serves the old WordPress site (404 for /agency/... and /admin/...).
-- One place for the main site's address; change it here when the app moves to slit.edu.au.
create or replace function public.main_site_host() returns text language sql immutable as $$ select 'skyline-website-cms.vercel.app' $$;
grant execute on function public.main_site_host() to anon, authenticated, service_role;

create or replace function public.support_site_origin() returns text language sql immutable as $$ select 'https://' || public.main_site_host() $$;

do $mig$
declare fn regprocedure; d text; n text;
begin
  foreach fn in array array['public.notification_enqueue_deliveries()'::regprocedure, 'public.notification_delivery_submission(uuid, uuid)'::regprocedure] loop
    d := pg_get_functiondef(fn);
    if (length(d) - length(replace(d, $o$'slit.edu.au'$o$, ''))) / length($o$'slit.edu.au'$o$) <> 1 then
      raise exception '%: expected exactly one slit.edu.au host, nothing changed', fn;
    end if;
    n := replace(d, $o$'slit.edu.au'$o$, 'public.main_site_host()');
    execute n;
  end loop;
end $mig$;
