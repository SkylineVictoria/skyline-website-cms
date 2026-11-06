-- A student whose record was created by an agent or SLIT (New application / Add student) claims it from the Sign up
-- page with the same email and mobile, then a one-time code emailed to them, then their own password: no invitation
-- email is needed. portal_self_register already reuses the record found by email and keeps its pending invitation;
-- now it also refuses when the mobile given does not match the record's (same number, with or without the country
-- code), so the email alone never claims a record. Patched in place from the live definition (20261105150000 style).
-- Rollback (manual): remove the mobile check that follows the 'This student record is disabled' line.
set local lock_timeout='5s';
set local statement_timeout='30s';

do $do$
declare f text := 'public.portal_self_register(text, jsonb)'; v_src text; v_new text;
 v_old text := $a$if s.status <> 'Active' then raise exception 'This student record is disabled. Please contact SLIT Administration.' using errcode = '22023'; end if;$a$;
 v_add text := $a$
   -- The mobile must match the record (same digits, with or without the country code): the email alone claims nothing.
   if public.student_phone_key(s.phone) is distinct from public.student_phone_key(v_phone) and not (
     char_length(regexp_replace(coalesce(s.phone, ''), '[^0-9]', '', 'g')) >= 9 and char_length(regexp_replace(v_phone, '[^0-9]', '', 'g')) >= 9
     and right(regexp_replace(coalesce(s.phone, ''), '[^0-9]', '', 'g'), 9) = right(regexp_replace(v_phone, '[^0-9]', '', 'g'), 9)) then
    raise exception 'This email is already on a student record, but the mobile number does not match it. Check both, or ask your agent or SLIT Administration.' using errcode = '23505'; end if;$a$;
begin
 if to_regprocedure(f) is null then raise exception '% does not exist; apply migration 20261105090000 first', f; end if;
 select pg_get_functiondef(f::regprocedure) into v_src;
 if strpos(v_src, 'the mobile number does not match it') > 0 then return; end if;
 if strpos(v_src, v_old) = 0 then raise exception '% has changed; update this migration', f; end if;
 v_new := replace(v_src, v_old, v_old || v_add);
 execute v_new;
end $do$;
