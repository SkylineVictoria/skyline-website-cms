-- Internal notification recipients per event: the cap rises from 10 to 20 (the validator is otherwise unchanged).
-- Applies to both the legacy table (notification_save_legacy_event) and the published tenant 'notifications' configuration, which both call this check.
-- Rollback / compensation: re-create public.notification_event_check from 20261027060000 (limit 10); events already saved with 11-20 recipients
-- stay valid data but could no longer be re-saved until trimmed. Apply with the normal reviewed release process; it must not be assumed applied.
begin;

create or replace function public.notification_event_check(p_settings jsonb) returns void language plpgsql immutable set search_path = public as $$
declare k text; e jsonb; seen text[] := '{}'; addr text;
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then raise exception 'Event settings must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_settings) loop
    if k not in ('recipients', 'notifyAgent', 'notifyAgencyAdmins', 'notifyStudent') then raise exception 'Unknown event setting' using errcode = '22023'; end if;
  end loop;
  foreach k in array array['notifyAgent', 'notifyAgencyAdmins', 'notifyStudent'] loop
    if p_settings ? k and jsonb_typeof(p_settings->k) <> 'boolean' then raise exception 'Recipient toggles must be true or false' using errcode = '22023'; end if;
  end loop;
  if p_settings ? 'recipients' then
    if jsonb_typeof(p_settings->'recipients') <> 'array' then raise exception 'Recipients must be a list of email addresses' using errcode = '22023'; end if;
    if jsonb_array_length(p_settings->'recipients') > 20 then raise exception 'At most 20 internal recipients per event' using errcode = '22023'; end if;
    for e in select * from jsonb_array_elements(p_settings->'recipients') loop
      if jsonb_typeof(e) <> 'string' then raise exception 'Each recipient must be an email address' using errcode = '22023'; end if;
      addr := lower(btrim(e #>> '{}'));
      if length(addr) > 254 or addr ~ '[[:cntrl:]]' or addr !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then raise exception 'Invalid recipient email address' using errcode = '22023'; end if;
      if addr = any (seen) then raise exception 'Duplicate recipient email address' using errcode = '22023'; end if;
      seen := seen || addr;
    end loop;
  end if;
end;
$$;

commit;
