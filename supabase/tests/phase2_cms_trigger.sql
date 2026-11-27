begin;
-- Hosted guard: test suites run on a local stack only (set skyline.allow_hosted = on in the session to override; see scripts/lab/hosted-guard.mjs).
do $hosted_guard$ begin if (select system_identifier from pg_control_system()) = 7692130048193495360 and coalesce(current_setting('skyline.allow_hosted', true), '') <> 'on' then raise exception 'Refusing to run a test suite on the hosted project (xcpydisstlvtvcsqnjob); set skyline.allow_hosted = on to override.'; end if; end $hosted_guard$;
select plan(8);
select lives_ok($$insert into cms_pages(id,slug,title,status) values('native-trigger-page','native-trigger-page','Fixture','Published')$$,'published page insert queues without document-only field');
-- A course is published only when reportable (20261126124153: code, field of education, ANZSCO code, qualification level, delivery mode)
-- with an active unit and an open intake (cms_courses_needs_intake stores an insert without them as Draft): insert as Draft, add both, publish.
insert into cms_courses(id,slug,code,name,status,mode,tga_field_of_education_code,tga_anzsco_code,tga_qualification_level) values('native-trigger-course','native-trigger-course','NTC01','Fixture','Draft','Face to Face','0403','331212','Certificate III');
insert into cms_course_units(id,course_id,code,name) values('native-trigger-unit','native-trigger-course','NTCU01','Fixture unit');
insert into course_intakes(course_id,start_date,end_date,label) values('native-trigger-course',current_date + 30,current_date + 400,'Fixture');
select lives_ok($$update cms_courses set status='Published' where id='native-trigger-course'$$,'published course queues without document-only field');
select is((select count(*)::int from public_assistant_index_jobs where source_key in ('native-trigger-page','native-trigger-course') and state='queued'),2,'both published source types enqueue');
select lives_ok($$insert into cms_documents(id,name,status,assistant_publication_approved) values('native-trigger-doc','Private fixture','Published',false)$$,'unapproved published document remains excluded');
select is((select count(*)::int from public_assistant_index_jobs where source_key='native-trigger-doc'),0,'unapproved document does not enqueue');
select lives_ok($$update cms_pages set status='Draft' where id='native-trigger-page'$$,'page unpublication succeeds');
-- LMS rows block deleting a course (archive, not delete, 20261125030517+): the fixture removes its own intake and unit first.
delete from intake_groups where intake_id in (select id from course_intakes where course_id='native-trigger-course');
delete from intake_batches where intake_id in (select id from course_intakes where course_id='native-trigger-course');
delete from course_intakes where course_id='native-trigger-course';
delete from cms_course_units where course_id='native-trigger-course';
select lives_ok($$delete from cms_courses where id='native-trigger-course'$$,'course deletion succeeds');
select is((select count(*)::int from public_assistant_index_jobs where source_key in ('native-trigger-page','native-trigger-course') and state='queued'),0,'unpublish/delete cancel queued indexing');
select * from finish();
rollback;
