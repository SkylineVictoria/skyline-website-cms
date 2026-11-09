-- Course Catalogue moves under the Website group; the now-empty Courses group is hidden.
-- Only parent, order and enabled state change, which admin_menu_protect allows for system items.
update public.admin_menu_items set parent_id = 'website', sort_order = 5 where id = 'course_catalogue';
update public.admin_menu_items set is_enabled = false where id = 'courses';;
