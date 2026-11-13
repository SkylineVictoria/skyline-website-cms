-- Master Data menu: Businesses, Agents, Students, Courses, Intakes, Classrooms, Jobs, Candidates (sort 10..50).
-- Only label and order of existing rows change (system menu identity and access are protected); Classrooms is new, for Admins
-- (RTO Managers edit inside the page; Admins view).
update public.admin_menu_items set label = 'Intakes', sort_order = 36 where id = 'rto_intakes';
update public.admin_menu_items set sort_order = 35 where id = 'agency_course_fees' and sort_order <> 35;
insert into public.admin_menu_items (id, parent_id, label, route, icon_key, sort_order, permission_key, permission_scope, is_system)
select 'rto_classrooms', m.parent_id, 'Classrooms', '/admin/classrooms', 'institution', 37, 'cms.admin', 'current', true
from public.admin_menu_items m where m.id = 'rto_intakes'
on conflict (id) do nothing;
