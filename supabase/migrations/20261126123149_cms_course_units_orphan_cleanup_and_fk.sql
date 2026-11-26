-- Applied on hosted 20261126123149 (cms_course_units_orphan_cleanup_and_fk) outside this repo; pulled from supabase_migrations.schema_migrations.statements so the lab replays what hosted has.
-- 1. Rescue unit content uploaded against units of deleted courses:
--    move the newest copy of each file to the same unit code in a live course.
with orphan as (
  select u.id, u.code from cms_course_units u
  where not exists (select 1 from cms_courses c where c.id = u.course_id)
), ranked as (
  select uc.id, o.code, uc.title,
         row_number() over (partition by o.code, uc.title order by uc.created_at desc) rn
  from unit_contents uc join orphan o on o.id = uc.unit_id
), target as (
  select distinct on (lu.code) lu.code, lu.id
  from cms_course_units lu join cms_courses c on c.id = lu.course_id
  where lu.archived_at is null
  order by lu.code, c.archived_at nulls first
)
update unit_contents uc set unit_id = t.id
from ranked r join target t on t.code = r.code
where uc.id = r.id and r.rn = 1
  and not exists (select 1 from unit_contents x where x.unit_id = t.id and x.title = r.title);

-- 2. Queue the files of the duplicate copies that will be deleted with their orphan units.
insert into storage_cleanup_queue (bucket_name, storage_path, reason)
select 'unit-content', uc.storage_path, 'Duplicate unit content on a unit of a deleted course'
from unit_contents uc
where uc.storage_path is not null
  and not exists (select 1 from cms_course_units u join cms_courses c on c.id = u.course_id where u.id = uc.unit_id)
  and not exists (select 1 from unit_contents k where k.storage_path = uc.storage_path and k.id <> uc.id);

-- 3. Delete units whose course no longer exists (cascades to their unit elements and leftover content).
delete from cms_course_units u
where not exists (select 1 from cms_courses c where c.id = u.course_id);

-- 4. Stop it recurring. The (course_id, tenant_id) FK is not enforced while tenant_id is null,
--    so add a plain FK: deleting a course deletes its units, unless something still blocks it
--    (intakes, CoE/VoE units, enrolments, assessments use ON DELETE RESTRICT).
alter table cms_course_units
  add constraint cms_course_units_course_id_fkey
  foreign key (course_id) references cms_courses(id) on delete cascade;
