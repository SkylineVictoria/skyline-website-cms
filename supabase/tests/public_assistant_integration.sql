-- Run with: npx supabase test db supabase/tests/public_assistant_integration.sql
-- Requires the CMS migrations plus pgTAP in an isolated local/test project.
begin; select plan(67);
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

-- P09-01: knowledge, cache, search, budgets and indexing are bound to the verified public tenant.
-- Synthetic institutions A, B (active) and C (deactivated below); the legacy institution is tenant null.
insert into public.tenants(id,slug,name,status) values
 ('9a000000-0000-4000-8000-000000000001','p9-tenant-a','P9 Institute A','active'),
 ('9b000000-0000-4000-8000-000000000002','p9-tenant-b','P9 Institute B','active'),
 ('9c000000-0000-4000-8000-000000000003','p9-tenant-c','P9 Institute C','active');
insert into public.tenant_domains(hostname,tenant_id,verified_at,verification_evidence) values
 ('p9-a.example.test','9a000000-0000-4000-8000-000000000001',now(),'pgtap'),
 ('p9-b.example.test','9b000000-0000-4000-8000-000000000002',now(),'pgtap'),
 ('p9-a-unverified.example.test','9a000000-0000-4000-8000-000000000001',null,null),
 ('p9-c.example.test','9c000000-0000-4000-8000-000000000003',now(),'pgtap');
insert into public.cms_courses(id,slug,code,name,fees,status,tenant_id) values
 ('p9-course-a','p9-course-a','P9A01','Alpha Secret Diploma','AUD 11,111','Published','9a000000-0000-4000-8000-000000000001'),
 ('p9-course-b','p9-course-b','P9B01','Bravo Certificate','AUD 22,222','Published','9b000000-0000-4000-8000-000000000002'),
 ('p9-course-b-draft','p9-course-b-draft','P9B02','Bravo Unpublished Course','AUD 1','Draft','9b000000-0000-4000-8000-000000000002'),
 ('p9-course-c','p9-course-c','P9C01','Charlie Course','AUD 3','Published','9c000000-0000-4000-8000-000000000003');
insert into public.public_assistant_faqs(question,normalized_question,answer,source_url,status,tenant_id) values
 ('What is the refund policy?','what is the refund policy','Alpha refunds within 7 days','/refunds','published','9a000000-0000-4000-8000-000000000001'),
 ('What is the refund policy?','what is the refund policy','Bravo refunds within 30 days','/refunds','published','9b000000-0000-4000-8000-000000000002'),
 ('Bravo draft question','bravo draft question','Bravo draft answer','/refunds','draft','9b000000-0000-4000-8000-000000000002');
select is(public.tenant_resolve('p9-a.example.test'),'9a000000-0000-4000-8000-000000000001'::uuid,'P09-01: a verified domain resolves to its tenant');
select is(public.tenant_resolve('p9-a-unverified.example.test'),null,'P09-01: an unverified domain does not resolve');
select is(public.tenant_resolve('p9-unknown.example.test'),null,'P09-01: an unknown host does not resolve (no default tenant)');
select is((select count(*)::integer from public.public_assistant_faqs where normalized_question='what is the refund policy' and tenant_id in ('9a000000-0000-4000-8000-000000000001','9b000000-0000-4000-8000-000000000002')),2,'P09-01: two institutions may publish the same FAQ question');
select throws_ok($$insert into public.public_assistant_faqs(question,normalized_question,answer,source_url,status,tenant_id) values('Dup','what is the refund policy','x','/x','draft','9a000000-0000-4000-8000-000000000001')$$,'23505',null,'P09-01: a question stays unique within one institution');
select is(public.tenant_assistant_context('9b000000-0000-4000-8000-000000000002')->>'institution','P9 Institute B','P09-01: answers name the tenant institution');
select ok((public.tenant_assistant_context('9b000000-0000-4000-8000-000000000002')->'faqs')::text like '%Bravo refunds%'
  and (public.tenant_assistant_context('9b000000-0000-4000-8000-000000000002')->'faqs')::text not like '%Alpha%'
  and (public.tenant_assistant_context('9b000000-0000-4000-8000-000000000002')->'faqs')::text not like '%Bravo draft%','P09-01: tenant B FAQs exclude A and unpublished');
select ok((public.tenant_assistant_context('9b000000-0000-4000-8000-000000000002')->'courses')::text like '%Bravo Certificate%'
  and (public.tenant_assistant_context('9b000000-0000-4000-8000-000000000002')->'courses')::text not like '%Alpha Secret%'
  and (public.tenant_assistant_context('9b000000-0000-4000-8000-000000000002')->'courses')::text not like '%Unpublished%','P09-01: tenant B courses exclude A and unpublished');
select ok((public.tenant_assistant_context('9a000000-0000-4000-8000-000000000001'))::text not like '%Bravo%','P09-01: tenant A context has nothing of B');
select ok((public.tenant_assistant_context(null))::text not like '%Alpha%' and (public.tenant_assistant_context(null))::text not like '%Bravo%'
  and public.tenant_assistant_context(null)->>'institution'='SLIT','P09-01: the legacy institution never sees tenant content');

-- Vector/lexical search over published chunks only, per tenant.
insert into public.public_assistant_sources(id,source_type,source_key,canonical_url,title,publication_status,source_version,content_hash) values
 ('9a100000-0000-4000-8000-000000000001','course','p9-course-a','/courses/p9-course-a','Alpha Secret Diploma','published','p9v1','p9ha'),
 ('9b100000-0000-4000-8000-000000000002','course','p9-course-b','/courses/p9-course-b','Bravo Certificate','published','p9v1','p9hb'),
 ('9b200000-0000-4000-8000-000000000002','course','p9-course-b-draft','/courses/p9-course-b-draft','Bravo Unpublished Course','staged','p9v1','p9hb2');
insert into public.public_assistant_chunks(source_id,ordinal,heading,content,content_hash,embedding) values
 ('9a100000-0000-4000-8000-000000000001',0,'h','Alpha secret evacuation assembly point at the north lawn','p9ha',array_fill(0.1::real,array[1536])::extensions.vector(1536)),
 ('9b100000-0000-4000-8000-000000000002',0,'h','Bravo evacuation assembly point at the east gate','p9hb',array_fill(0.1::real,array[1536])::extensions.vector(1536)),
 ('9b200000-0000-4000-8000-000000000002',0,'h','Bravo staged evacuation draft text','p9hb2',array_fill(0.1::real,array[1536])::extensions.vector(1536));
select is((select tenant_id from public.public_assistant_chunks where source_id='9b100000-0000-4000-8000-000000000002'),'9b000000-0000-4000-8000-000000000002'::uuid,'P09-01: a chunk inherits its source tenant');
select is((select string_agg(content,'|') from public.tenant_assistant_search('9b000000-0000-4000-8000-000000000002',array_fill(0.1::real,array[1536])::extensions.vector(1536),'evacuation assembly',null,8)),
  'Bravo evacuation assembly point at the east gate','P09-01: tenant B search returns only B published chunks');
select is((select string_agg(content,'|') from public.tenant_assistant_search('9a000000-0000-4000-8000-000000000001',array_fill(0.1::real,array[1536])::extensions.vector(1536),'evacuation assembly',null,8)),
  'Alpha secret evacuation assembly point at the north lawn','P09-01: tenant A search returns only A chunks');
select is((select count(*)::integer from public.tenant_assistant_search(null,array_fill(0.1::real,array[1536])::extensions.vector(1536),'evacuation assembly',null,8) where content like 'Alpha%' or content like 'Bravo%'),0,'P09-01: legacy search never returns tenant chunks');

-- Answer cache: tenant-bound reads and writes.
select is(public.tenant_assistant_cache_put('9a000000-0000-4000-8000-000000000001',repeat('a',64),'p9ver','{"answer":"Alpha cached"}'::jsonb,300),true,'P09-01: tenant A caches an answer');
select is(public.tenant_assistant_cache_get('9b000000-0000-4000-8000-000000000002',repeat('a',64),'p9ver'),null,'P09-01: tenant B cannot read A''s cached answer by key');
select is(public.tenant_assistant_cache_get(null,repeat('a',64),'p9ver'),null,'P09-01: the legacy institution cannot read A''s cached answer');
select is(public.tenant_assistant_cache_put('9b000000-0000-4000-8000-000000000002',repeat('a',64),'p9ver','{"answer":"Bravo overwrite"}'::jsonb,300),false,'P09-01: tenant B cannot overwrite A''s cache key');
select is(public.tenant_assistant_cache_get('9a000000-0000-4000-8000-000000000001',repeat('a',64),'p9ver')->>'answer','Alpha cached','P09-01: A''s cached answer is unchanged');
select is(public.tenant_assistant_cache_get('9a000000-0000-4000-8000-000000000001',repeat('a',64),'other-version'),null,'P09-01: a stale content version is not served');
select throws_ok($$select public.tenant_assistant_cache_put(null,'not-a-hash','v','{}'::jsonb,300)$$,'22023',null,'P09-01: malformed cache keys are refused');

-- Budgets: request limits are independent per tenant.
select is(public.tenant_assistant_rate_limit('9a000000-0000-4000-8000-000000000001','p9-client',1,60),true,'P09-01: A first request within its budget');
select is(public.tenant_assistant_rate_limit('9a000000-0000-4000-8000-000000000001','p9-client',1,60),false,'P09-01: A second request over its budget');
select is(public.tenant_assistant_rate_limit('9b000000-0000-4000-8000-000000000002','p9-client',1,60),true,'P09-01: B budget is not consumed by A');
select is((select has_function_privilege('anon','public.tenant_assistant_context(uuid)','execute'))::text,'false','P09-01: anon cannot call the knowledge context directly');
select is((select has_function_privilege('authenticated','public.tenant_assistant_cache_put(uuid,text,text,jsonb,integer)','execute'))::text,'false','P09-01: signed-in users cannot write the answer cache');

-- Indexing: tenant jobs are claimed and committed for their own tenant; inactive tenants and foreign storage are refused.
insert into public.cms_documents(id,name,url,status,assistant_publication_approved,bucket_name,storage_path,mime_type,file_size,tenant_id) values
 ('p9-doc-b-legacy-media','Borrowed legacy policy','/documents/borrowed','Published',true,'cms-media','policies/p9-borrowed.pdf','application/pdf',10,'9b000000-0000-4000-8000-000000000002'),
 ('p9-doc-b-own-media','Bravo policy','/documents/bravo','Published',true,'tenant-public-media','9b000000-0000-4000-8000-000000000002/policies/p9-bravo.pdf','application/pdf',10,'9b000000-0000-4000-8000-000000000002');
select is((select tenant_id from public.public_assistant_index_jobs where source_type='course' and source_key='p9-course-b' and state='queued'),'9b000000-0000-4000-8000-000000000002'::uuid,'P09-01: a tenant CMS change queues a job owned by that tenant');
update public.public_assistant_index_jobs set next_attempt_at='2999-01-01' where source_key like 'p9-%' and state='queued';
update public.public_assistant_index_jobs set next_attempt_at='1980-01-01' where source_key='p9-course-c' and state='queued';
update public.tenants set status='inactive' where id='9c000000-0000-4000-8000-000000000003';
select is(public.tenant_resolve('p9-c.example.test'),null,'P09-01: a deactivated tenant''s domain no longer resolves');
select is(public.tenant_assistant_context('9c000000-0000-4000-8000-000000000003'),null,'P09-01: a deactivated tenant gets no knowledge context');
select is(public.tenant_assistant_rate_limit('9c000000-0000-4000-8000-000000000003','p9-client',5,60),false,'P09-01: a deactivated tenant gets no request budget');
update public.public_assistant_index_jobs set next_attempt_at='1990-01-01' where source_type='course' and source_key='p9-course-b' and state='queued';
create temp table p9_claim as select * from public.public_assistant_claim_index_job();
select is((select source_key from p9_claim),'p9-course-b','P09-01: claim skips the deactivated tenant''s older job and takes the active tenant''s job');
select is((select state from public.public_assistant_index_jobs where source_key='p9-course-c' and next_attempt_at='1980-01-01'),'queued','P09-01: the deactivated tenant''s job is left untouched');
update public.public_assistant_index_jobs set next_attempt_at='1990-01-01' where source_key='p9-doc-b-legacy-media' and state='queued';
create temp table p9_claim_bad as select * from public.public_assistant_claim_index_job();
select is(public.public_assistant_commit_index((select id from p9_claim_bad),(select lease_token from p9_claim_bad),
  jsonb_build_object('type','document','key','p9-doc-b-legacy-media','version',(select source_version from p9_claim_bad),'url','/documents/borrowed','title','Borrowed','hash','p9hash-bad','model','m','tokens',1),
  jsonb_build_array(jsonb_build_object('ordinal',0,'heading','h','content','Borrowed legacy text','embedding',(select jsonb_agg(0.1) from generate_series(1,1536)))),
  jsonb_build_object('original','x','cleaned','x','method','m','warnings','[]'::jsonb,'corrections','[]'::jsonb,'pages',jsonb_build_array(jsonb_build_object('number',1,'original','x','cleaned','x','status','digital','warnings','[]'::jsonb)))),
  false,'P09-01: a tenant document stored in the legacy institution''s media is never indexed');
update public.public_assistant_index_jobs set next_attempt_at='1990-01-01' where source_key='p9-doc-b-own-media' and state='queued';
create temp table p9_claim_good as select * from public.public_assistant_claim_index_job();
select is(public.public_assistant_commit_index((select id from p9_claim_good),(select lease_token from p9_claim_good),
  jsonb_build_object('type','document','key','p9-doc-b-own-media','version',(select source_version from p9_claim_good),'url','/documents/bravo','title','Bravo policy','hash','p9hash-good','model','m','tokens',3),
  jsonb_build_array(jsonb_build_object('ordinal',0,'heading','h','content','Bravo indexed policy text','embedding',(select jsonb_agg(0.1) from generate_series(1,1536)))),
  jsonb_build_object('original','x','cleaned','x','method','m','warnings','[]'::jsonb,'corrections','[]'::jsonb,'pages',jsonb_build_array(jsonb_build_object('number',1,'original','x','cleaned','x','status','digital','warnings','[]'::jsonb)))),
  true,'P09-01: a tenant document in its own public media is committed');
select is((select tenant_id from public.public_assistant_sources where source_key='p9-doc-b-own-media' and publication_status='published'),'9b000000-0000-4000-8000-000000000002'::uuid,'P09-01: the committed source belongs to the tenant');
select is((select tenant_id from public.public_assistant_usage_events where request_key=(select id::text from p9_claim_good) and kind='embedding'),'9b000000-0000-4000-8000-000000000002'::uuid,'P09-01: indexing usage is charged to the tenant');
select is((select count(*)::integer from public.tenant_assistant_search('9a000000-0000-4000-8000-000000000001',array_fill(0.1::real,array[1536])::extensions.vector(1536),'Bravo indexed policy',null,8) where content like 'Bravo%'),0,'P09-01: the newly indexed B document is not searchable by A');
select is((select count(*)::integer from public.tenant_assistant_search('9b000000-0000-4000-8000-000000000002',array_fill(0.1::real,array[1536])::extensions.vector(1536),'Bravo indexed policy',null,8) where content='Bravo indexed policy text'),1,'P09-01: the newly indexed B document is searchable by B');
select * from finish(); rollback;
