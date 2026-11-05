export interface AdminMenuItem {
  id: string;
  parent_id: string | null;
  label: string;
  route: string | null;
  icon_key: string;
  sort_order: number;
  is_enabled: boolean;
  open_in_new_tab: boolean;
}

// Database keys never become class names or executable components.
const icons: Record<string, string> = {
  dashboard: 'ri-dashboard-3-line', courses: 'ri-book-2-line', pages: 'ri-file-text-line',
  navigation: 'ri-menu-line', footer: 'ri-layout-bottom-line', settings: 'ri-settings-3-line',
  documents: 'ri-file-pdf-2-line', knowledge: 'ri-question-answer-line', extraction: 'ri-file-search-line',
  forms: 'ri-survey-line', contact: 'ri-contacts-line', seo: 'ri-search-eye-line',
  users: 'ri-user-settings-line', institution: 'ri-building-line', activity: 'ri-history-line',
  website: 'ri-global-line', admissions: 'ri-file-list-line', agencies: 'ri-team-line',
  communications: 'ri-mail-line', students: 'ri-user-line', external: 'ri-external-link-line',
};
export const menuIcon = (key: string) => Object.hasOwn(icons, key) ? icons[key] : 'ri-folder-line';

// Only implemented internal destinations. Adding a route requires frontend code;
// changing labels, order, enabled state and hierarchy does not.
const routes = new Set([
  '/', '/admin', '/admin/courses', '/admin/pages', '/admin/navigation', '/admin/footer',
  '/admin/settings', '/admin/documents', '/admin/knowledge', '/admin/applications', '/admin/agencies', '/admin/notifications',
  '/admin/forms', '/admin/contact', '/admin/seo', '/admin/users', '/admin/institution', '/admin/activity',
  '/agency/all-applications', '/agency/agencies', '/agency/users',
  '/agency/notifications', '/agency/audit-log','/admin/businesses', '/admin/agents', '/admin/students', '/admin/staff',
]);

export interface MenuNode extends AdminMenuItem { children: MenuNode[] }
export function menuTree(rows: AdminMenuItem[]): MenuNode[] {
  const nodes = new Map<string, MenuNode>();
  for (const row of rows) {
    if (row.is_enabled && (!row.route || routes.has(row.route))) nodes.set(row.id, { ...row, children: [] });
  }
  const visit = (parent: string | null, ancestors: Set<string>): MenuNode[] =>
    [...nodes.values()].filter(n => n.parent_id === parent && !ancestors.has(n.id))
      .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
      .map(n => ({ ...n, children: visit(n.id, new Set([...ancestors, n.id])) }))
      .filter(n => n.route || n.children.length);
  return visit(null, new Set());
}
export function menuActive(node: MenuNode, pathname: string): boolean {
  return Boolean(node.route && (pathname === node.route ||
    (node.route !== '/admin' && node.route !== '/' && pathname.startsWith(node.route + '/')))) ||
    node.children.some(child => menuActive(child, pathname));
}
