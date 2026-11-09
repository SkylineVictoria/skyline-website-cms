-- Link existing Skyline cms_courses to the full national catalogue by code.
-- Sets the Skyline link only; is_active and other Skyline flags are preserved.
update public.australian_course_catalogue a
   set cms_course_id = c.id
  from (select distinct on (upper(code)) id, upper(code) as code
          from public.cms_courses where tenant_id is null and code <> '' order by upper(code), display_order, id) c
 where a.course_code = c.code and a.cms_course_id is null;;
