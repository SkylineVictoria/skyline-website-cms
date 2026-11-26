-- CLICKSEND-AUTH-FIX (owner, 2026-11-26: Communication Hub SMS "Not delivered: Authorization failed"): the hub sends SMS from the
-- database (comm_channel_post, pg_net) with an HTTP Basic header built by encode(..., 'base64'). PostgreSQL's base64 breaks its
-- output with a newline every 76 characters, so a username + API key longer than 56 characters (an email username plus ClickSend's
-- 36-character key is) put a newline inside the header and ClickSend answered 401. The newlines are now removed. The Edge Functions
-- (invitation / signing texts) build the header with btoa and were not affected.
-- Down: patch translate(...) back to the plain encode(...).
begin;

select public.business_rule_patch_function('public.comm_channel_post(text, text, text, text)'::regprocedure,
$old$'Basic ' || encode(convert_to((s->>'username') || ':' || (s->>'apiKey'), 'UTF8'), 'base64')$old$,
$new$'Basic ' || translate(encode(convert_to((s->>'username') || ':' || (s->>'apiKey'), 'UTF8'), 'base64'), E'\n\r', '')$new$);

commit;
