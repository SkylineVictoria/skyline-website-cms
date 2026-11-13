import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { supabase } from '@/pages/admin/lib/supabase';
import { useAuth } from '@/pages/admin/lib/authContext';
import { menuActive, menuIcon, menuTree, type AdminMenuItem, type MenuNode } from '@/pages/admin/lib/adminMenu';

const linkClass = 'mb-0.5 flex items-center gap-2.5 rounded-md px-3 py-2 text-label font-medium transition-colors';
function MenuEntry({ node, close }: { node: MenuNode; close: () => void }) {
  const { pathname } = useLocation();
  const active = menuActive(node, pathname);
  const [expanded, setExpanded] = useState(active);
  useEffect(() => { if (active) setExpanded(true); }, [active, pathname]);
  const content = <><i className={`${menuIcon(node.icon_key)} text-lg`} aria-hidden="true" /><span className="truncate">{node.label}</span></>;
  return <li>
    {node.children.length ? <>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)} className={`${linkClass} w-full text-foreground-700 hover:bg-background-100`}>
        {content}<i className={expanded ? 'ri-arrow-up-s-line ml-auto' : 'ri-arrow-down-s-line ml-auto'} aria-hidden="true" />
      </button>
      
      {expanded ? <ul className="ml-3 border-l border-background-200 pl-2">{node.children.map(child => <MenuEntry key={child.id} node={child} close={close} />)}</ul> : null}
    </> : node.route ? <NavLink to={node.route} end={node.route === '/admin' || node.route === '/'} onClick={close}
      target={node.open_in_new_tab ? '_blank' : undefined} rel={node.open_in_new_tab ? 'noopener noreferrer' : undefined}
      className={() => `${linkClass} ${pathname === node.route ? 'bg-primary-500 text-background-50' : 'text-foreground-700 hover:bg-background-100'}`}>
      {content}
    </NavLink> : null}
  </li>;
}

export default function AdminMenu({ close }: { close: () => void }) {
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
    <div className="flex-1 overflow-y-auto px-3 py-3">
      {nodes ? <ul>{nodes.filter(n => n.route !== '/').map(node => <MenuEntry key={node.id} node={node} close={close} />)}</ul> : <>
        <NavLink to="/admin" end onClick={close} className={linkClass}><i className="ri-dashboard-3-line" aria-hidden="true" />Dashboard</NavLink>
        <p role="status" className="px-3 text-xs text-foreground-500">{failed ? 'Menu unavailable.' : 'Loading menu…'}</p>
        {failed ? <button type="button" onClick={() => setAttempt(v => v + 1)} className={linkClass}>Retry menu</button> : null}
      </>}
    </div>
    <div className="border-t border-background-200 px-3 py-3">
      {nodes ? <ul>{nodes.filter(n => n.route === '/').map(node => <MenuEntry key={node.id} node={node} close={close} />)}</ul> :
        <NavLink to="/" onClick={close} className={linkClass}>View public website</NavLink>}
    </div>
  </>;
}
