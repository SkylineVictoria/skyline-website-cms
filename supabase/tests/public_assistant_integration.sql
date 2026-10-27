-- Run with: npx supabase test db supabase/tests/public_assistant_integration.sql
-- Requires the CMS migrations plus pgTAP in an isolated local/test project.
begin; select plan(29);
select has_table('public','public_assistant_sources','knowledge source table exists');
select has_table('public','public_assistant_answer_cache','versioned cache exists');
select has_table('public','public_assistant_document_text','original and cleaned public document text exists');
select has_table('public','public_assistant_document_pages','page-level extraction state exists');
select has_function('public','public_assistant_finish_index_job',array['uuid','uuid','uuid'],'atomic activation function exists');
select has_function('public','public_assistant_enqueue_index_job',array['text','text'],'event-driven enqueue function exists');
select has_function('public','public_assistant_cms_source_version',array['text','text'],'content-aware source version function exists');
select is((select has_table_privilege('anon','public.public_assistant_sources','select'))::text,'false','anon cannot read knowledge sources');
-- P02-08 grants SELECT for tenant editors; row authorization is verified by the
-- native tenant worker boundary suite with real own/foreign tenant JWTs.
select is((select has_table_privilege('authenticated','public.public_assistant_chunks','select'))::text,'true','tenant chunk reads have a table grant before restrictive RLS');
select is((select has_table_privilege('anon','public.public_assistant_document_text','select'))::text,'false','anon cannot read original extracted public-document text');
select is((select has_function_privilege('anon','public.public_assistant_search_chunks(extensions.vector,text,text,integer)','execute'))::text,'false','anon cannot execute retrieval RPC');
select is((select has_function_privilege('authenticated','public.public_assistant_finish_index_job(uuid,uuid,uuid)','execute'))::text,'false','staff cannot activate an index version');
select is((select has_function_privilege('anon','public.public_assistant_enqueue_index_job(text,text)','execute'))::text,'false','anonymous callers cannot enqueue indexing work');
select is(public.public_assistant_content_version(),public.public_assistant_content_version(),'content-version reads are deterministic');
select lives_ok($$select public.public_assistant_take_rate_limit('pgtap-rate',2,60)$$,'first rate-limit claim works');
select is(public.public_assistant_take_rate_limit('pgtap-rate',2,60),true,'second request remains in budget');
select is(public.public_assistant_take_rate_limit('pgtap-rate',2,60),false,'third rate-limited request is denied');
select is(public.public_assistant_take_rate_limit('pgtap-window',1,0),true,'short rate-limit window allows first request');
select is(public.public_assistant_take_rate_limit('pgtap-window',1,0),true,'expired rate-limit window resets');

delete from public.public_assistant_generation_requests;
delete from public.public_assistant_generation_budgets;
update public.public_assistant_generation_slots set lease_token=null, lease_expires_at=null;
select ok(public.public_assistant_take_generation_slot(1) is not null,'generation reserves an available slot');
update public.public_assistant_generation_slots set lease_token=null, lease_expires_at=null;
select is(public.public_assistant_take_generation_slot(1) is null,true,'daily budget denial occurs after a released slot only');
update public.public_assistant_generation_slots set lease_token=gen_random_uuid(), lease_expires_at=clock_timestamp()+interval '1 minute';
delete from public.public_assistant_generation_budgets;
select is(public.public_assistant_take_generation_slot(10) is null,true,'concurrency denial returns no lease');
select is((select count(*)::integer from public.public_assistant_generation_budgets),0,'concurrency denial does not consume budget');
update public.public_assistant_generation_slots set lease_token=null, lease_expires_at=null;
delete from public.public_assistant_generation_requests;
delete from public.public_assistant_generation_budgets;
select ok(public.public_assistant_take_generation_slot(10) is not null,'generation lease is granted for settlement');
select ok(public.public_assistant_release_generation_slot((select lease_token from public.public_assistant_generation_requests where settled_at is null),7,11),'first settlement succeeds');
select is(public.public_assistant_release_generation_slot((select lease_token from public.public_assistant_generation_requests where settled_at is not null),7,11),false,'duplicate settlement is rejected');
select is((select input_tokens from public.public_assistant_generation_budgets where period_start=current_date),7,'usage is counted once');
select is((select has_table_privilege('authenticated','public.public_assistant_faqs','select'))::text,'true','staff FAQ role has table grant before RLS');
select is((select has_table_privilege('authenticated','public.public_assistant_document_text','select'))::text,'true','staff document-review role has table grant before RLS');
select * from finish(); rollback;
