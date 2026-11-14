import { LMS_MENU } from "@/pages/admin/lms/lmsConfig";
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { supabase } from '@/pages/admin/lib/supabase';
import { useAuth } from '@/pages/admin/lib/authContext';
import { menuActive, menuIcon, menuTree, type AdminMenuItem, type MenuNode } from '@/pages/admin/lib/adminMenu';

const linkClass = 'mb-0.5 flex items-center gap-2.5 rounded-md px-3 py-[calc(var(--control-py)*0.9)] text-label font-medium transition-colors duration-fast';
function MenuEntry({ node, close, collapsed }: { node: MenuNode; close: () => void; collapsed: boolean }) {
  const { pathname } = useLocation();
  const active = menuActive(node, pathname);
  const [expanded, setExpanded] = useState(active);
  useEffect(() => { if (active) setExpanded(true); }, [active, pathname]);
  // Icons only: the label becomes the tooltip and the accessible name; a group's items follow it, set off by a line.
  const content = <><i className={`${menuIcon(node.icon_key)} text-lg`} aria-hidden="true" />{collapsed ? <span className="sr-only">{node.label}</span> : <span className="truncate">{node.label}</span>}</>;
  const shape = collapsed ? 'justify-center px-0' : '';
  return <li>
    {node.children.length ? <>
      <button type="button" aria-expanded={expanded} title={collapsed ? node.label : undefined} onClick={() => setExpanded(v => !v)} className={`${linkClass} ${shape} w-full ${collapsed && active ? 'text-primary-600' : 'text-foreground-700'} hover:bg-background-100`}>
        {content}{collapsed ? null : <i className={expanded ? 'ri-arrow-up-s-line ml-auto' : 'ri-arrow-down-s-line ml-auto'} aria-hidden="true" />}
      </button>
      {expanded ? <ul className={collapsed ? 'mb-1 border-b border-background-200 pb-1' : 'ml-3 border-l border-background-200 pl-2'}>{node.children.map(child => <MenuEntry key={child.id} node={child} close={close} collapsed={collapsed} />)}</ul> : null}
    </> : node.route ? <NavLink to={node.route} end={node.route === '/admin' || node.route === '/'} onClick={close}
      target={node.open_in_new_tab ? '_blank' : undefined} rel={node.open_in_new_tab ? 'noopener noreferrer' : undefined} title={collapsed ? node.label : undefined}
      className={() => `${linkClass} ${shape} ${pathname === node.route ? 'bg-primary-500 text-background-50' : 'text-foreground-700 hover:bg-background-100'}`}>
      {content}
    </NavLink> : null}
  </li>;
}

export default function AdminMenu({ close, collapsed = false }: { close: () => void; collapsed?: boolean }) {
  const { user } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ identity: string; rows: AdminMenuItem[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const identity = `${user?.id}:${user?.role}:${user?.mustChangePassword}`;
  useEffect(() => {
    if (!user || user.mustChangePassword) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10000);
    setFailed(false);
    setResult(null);
    void (async () => {
      try {
        const { data, error } = await supabase.from('admin_menu_items')
          .select('id,parent_id,label,route,icon_key,sort_order,is_enabled,open_in_new_tab')
          .order('sort_order').abortSignal(controller.signal);
        if (error) throw error;
        if (!cancelled) setResult({ identity, rows: data ?? [] });
      } catch { if (!cancelled) setFailed(true); }
      finally { window.clearTimeout(timer); }
    })();
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [identity, attempt, user]);
  const nodes = result?.identity === identity ? menuTree(result.rows) : null;
  return <>
    <div className={`flex-1 overflow-y-auto py-3 ${collapsed ? 'px-2' : 'px-3'}`}>
      {nodes ? <><ul>{nodes.filter(n => n.route !== '/').map(node => <MenuEntry key={node.id} node={node} close={close} collapsed={collapsed} />)}</ul><LmsNavigation close={close} collapsed={collapsed} /><Link to="/admin/communication" onClick={close} title={collapsed ? "Communication Hub" : undefined} className={linkClass + " mt-2 text-foreground-700 hover:bg-background-100"}><i className="ri-chat-3-line text-lg" aria-hidden="true" />{collapsed ? <span className="sr-only">Communication Hub</span> : "Communication Hub"}</Link></> : <>
        <NavLink to="/admin" end onClick={close} className={linkClass}><i className="ri-dashboard-3-line" aria-hidden="true" />Dashboard</NavLink>
        <p role="status" className="px-3 text-xs text-foreground-500">{failed ? 'Menu unavailable.' : 'Loading menu…'}</p>
        {failed ? <button type="button" onClick={() => setAttempt(v => v + 1)} className={linkClass}>Retry menu</button> : null}
      </>}
    </div>
    <div className={`border-t border-background-200 py-3 ${collapsed ? 'px-2' : 'px-3'}`}>
      {nodes ? <ul>{nodes.filter(n => n.route === '/').map(node => <MenuEntry key={node.id} node={node} close={close} collapsed={collapsed} />)}</ul> :
        <NavLink to="/" onClick={close} className={linkClass}>View public website</NavLink>}
    </div>
  </>;
}

/** LMS is additive navigation; it does not mutate the DB-driven Master Data menu. */
function LmsNavigation({ close, collapsed }: { close: () => void; collapsed: boolean }) {
  const { pathname } = useLocation();
  const [expanded, setExpanded] = useState(() => pathname.startsWith("/admin/lms"));
  useEffect(() => { if (pathname.startsWith("/admin/lms")) setExpanded(true); }, [pathname]);
  return <div className="mt-3 border-t border-background-200 pt-3">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}
      title={collapsed ? "Learning Management" : undefined}
      className={linkClass + " w-full " + (collapsed ? "justify-center px-0" : "")}>
      <i className="ri-graduation-cap-line text-lg" aria-hidden="true" />
      {collapsed ? <span className="sr-only">Learning Management</span> : <><span className="flex-1 text-left">Learning Management</span><i className={expanded ? "ri-arrow-up-s-line" : "ri-arrow-down-s-line"} aria-hidden="true" /></>}
    </button>
    {expanded ? <ul className={collapsed ? "border-b border-background-200 pb-1" : "ml-3 border-l border-background-200 pl-2"}>
      {LMS_MENU.map(item => <li key={item.id}>
        <NavLink to={item.route} end onClick={close}
          title={collapsed ? item.label : undefined}
          className={linkClass + " " + (collapsed ? "justify-center px-0 " : "") + (pathname === item.route ? "bg-primary-500 text-background-50" : "text-foreground-700 hover:bg-background-100")}>
          <i className={item.icon + " text-lg"} aria-hidden="true" />
          {collapsed ? <span className="sr-only">{item.label}</span> : <span className="truncate">{item.label}</span>}
        </NavLink>
      </li>)}
    </ul> : null}
  </div>;
}
