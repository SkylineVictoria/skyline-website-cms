import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { emailSections } from "@/pages/admin/lib/emailMenu";
import { LMS_MENU } from "@/pages/admin/lms/lmsConfig";
import { supabase } from "@/pages/admin/lib/supabase";
import { useAuth } from "@/pages/admin/lib/authContext";
import { menuActive, menuIcon, menuTree, type AdminMenuItem, type MenuNode } from "@/pages/admin/lib/adminMenu";
import "./AdminMenu.css";

type Entry = {
  id: string;
  label: string;
  icon: string;
  route?: string;
  external?: boolean;
  configured?: MenuNode;
  children?: Entry[];
};

const dashboard: Entry = { id: "dashboard", label: "Dashboard", icon: "ri-dashboard-3-line", route: "/admin" };
const publicWebsite: Entry = { id: "public_website", label: "View public website", icon: "ri-global-line", route: "/" };
const communicationHub: Entry = { id: "shortcut-communication", label: "Communication Hub", icon: "ri-chat-3-line", route: "/admin/communication" };

const timetableEntries = LMS_MENU.filter((entry) => entry.parent === "timetable");
const timetable: Entry = {
  id: "timetable", label: "Timetable", icon: "ri-calendar-2-line",
  children: timetableEntries.map((entry) => ({ ...entry, id: `lms-${entry.id}` })),
};
const learning: Entry = {
  id: "learning-management", label: "Learning Management", icon: "ri-graduation-cap-line",
  children: LMS_MENU.flatMap((entry) => {
    if (!entry.parent) return [{ ...entry, id: `lms-${entry.id}` }];
    return entry === timetableEntries[0] ? [timetable] : [];
  }),
};
const email: Entry = {
  id: "email-management", label: "Email Management", icon: "ri-mail-settings-line",
  children: emailSections.map((section) => ({ ...section, id: `email-${section.id}`, route: `/admin/email-management?section=${section.id}` })),
};

function fromMenu(node: MenuNode): Entry {
  const children = node.children.map(fromMenu);
  if (node.id === "communications" && children.length && !children.some(({ route }) => route === communicationHub.route)) {
    children.push(communicationHub);
  }
  return { id: node.id, label: node.label, icon: menuIcon(node.icon_key), route: node.route ?? undefined, external: node.open_in_new_tab, configured: node, children };
}

// Group the visible menu for browsing. The configured tree still supplies destinations and permissions.
const moduleGroups = [
  { id: "admissions-records", label: "Admissions & Records", icon: "ri-team-line", members: ["admissions", "students", "agencies", "courses", "document_signing"] },
  { id: "communications-support", label: "Communications & Support", icon: "ri-chat-3-line", members: ["communications", "email-management", "support_tickets"] },
  // rule-policy: technical sidebar-system-group Organizes existing system links in the sidebar.
  { id: "system-integrations", label: "Settings & Integrations", icon: "ri-settings-3-line", members: ["administration", "external_integrations", "audit", "automation"] },
];

function groupedModules(modules: Entry[]): Entry[] {
  const groups = moduleGroups.flatMap(({ id, label, icon, members }) => {
    const children = members.flatMap((member) => {
      const entry = modules.find((item) => item.id === member);
      if (!entry) return [];
      // rule-policy: technical sidebar-container-display Shows existing destinations directly in their combined group.
      const mergeContents = member === "admissions" || member === "communications" || member === "administration";
      return mergeContents && !entry.route && entry.children?.length ? entry.children : [entry];
    });
    return children.length ? [{ id, label, icon, children }] : [];
  });
  const bookings = modules.find((item) => item.id === "bookings");
  const learningGroup = bookings ? { ...learning, children: [...(learning.children ?? []), bookings] } : learning;
  const website = modules.find((item) => item.id === "website");
  const standalone = modules.filter((item) => item.id === "staff" || item.id === "finance");
  const other = modules.filter((item) => item.id !== learning.id && item.id !== "website" && item.id !== "bookings"
    && !standalone.includes(item) && !moduleGroups.some((group) => group.members.includes(item.id)));
  return [learningGroup, ...groups, ...standalone, ...(website ? [website] : []), ...(other.length ? [
    { id: "other-modules", label: "Other modules", icon: "ri-more-2-line", children: other },
  ] : [])];
}

function isCurrent(entry: Entry, pathname: string, search: string): boolean {
  if (entry.children?.length) return entry.children.some((child) => isCurrent(child, pathname, search));
  if (entry.configured) return menuActive(entry.configured, pathname);
  const [path, query] = (entry.route ?? "").split("?");
  if (path !== pathname) return false;
  const actual = new URLSearchParams(search);
  if (!query) return entry.id !== "lms-tt-calendar" || actual.get("view") !== "students";
  const expected = new URLSearchParams(query);
  if (path === "/admin/email-management") return expected.get("section") === (actual.get("section") || "accounts");
  return Array.from(expected).every(([key, value]) => actual.get(key) === value);
}

function MenuEntry({ entry, close, trail }: { entry: Entry; close: () => void; trail?: string }) {
  const { pathname, search } = useLocation();
  const current = isCurrent(entry, pathname, search);
  const content = <>
    <i className={`${entry.icon} admin-nav-icon`} aria-hidden="true" />
    <span className="admin-nav-label">{entry.label}{trail ? <small>{trail}</small> : null}</span>
  </>;
  return (
    <li>
      {entry.children?.length ? (
        <>
          <div className="admin-nav-item admin-nav-group" data-current-branch={current} title={entry.label}>
            {content}
          </div>
          <ul className="admin-nav-children" aria-label={entry.label}>
            {entry.children.map((child) => <MenuEntry entry={child} key={child.id} close={close} />)}
          </ul>
        </>
      ) : entry.route ? (
        <Link to={entry.route} className="admin-nav-item" aria-current={current ? "page" : undefined} title={entry.label} onClick={close}
          target={entry.external ? "_blank" : undefined} rel={entry.external ? "noopener noreferrer" : undefined}>
          {content}
          {entry.external ? <i className="ri-arrow-right-up-line admin-nav-chevron" aria-hidden="true" /> : null}
        </Link>
      ) : null}
    </li>
  );
}

function destinations(entries: Entry[], parents: string[] = []): { entry: Entry; trail: string }[] {
  return entries.flatMap((entry) => entry.children?.length
    ? destinations(entry.children, [...parents, entry.label])
    : entry.route ? [{ entry, trail: parents.join(" › ") }] : []);
}

export default function AdminMenu({ close, collapsed = false }: { close: () => void; collapsed?: boolean }) {
  const { user } = useAuth();
  const [query, setQuery] = useState("");
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
    setQuery("");
    void (async () => {
      try {
        // rule-policy: security menu-read Uses the existing permission-filtered menu query.
        const { data, error } = await supabase.from("admin_menu_items")
          .select("id,parent_id,label,route,icon_key,sort_order,is_enabled,open_in_new_tab")
          .order("sort_order").abortSignal(controller.signal);
        if (error) throw error;
        if (!cancelled) setResult({ identity, rows: data ?? [] });
      } catch { if (!cancelled) setFailed(true); }
      finally { window.clearTimeout(timer); }
    })();
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [identity, attempt, user]);

  const nodes = result?.identity === identity ? menuTree(result.rows).map(fromMenu) : null;
  const main = nodes?.filter((entry) => entry.route !== "/") ?? [dashboard];
  const dashboardEntries = main.filter((entry) => entry.route === "/admin");
  const modules = [learning, ...main.filter((entry) => entry.route !== "/admin"), ...(nodes ? [email] : [])];
  const menu = [...dashboardEntries, ...groupedModules(modules)];
  const footer = nodes?.filter((entry) => entry.route === "/") ?? [publicWebsite];
  const terms = collapsed ? [] : query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = terms.length ? destinations([...dashboardEntries, ...modules, ...footer]).filter(({ entry, trail }) =>
    terms.every((term) => `${entry.label} ${trail}`.toLowerCase().includes(term))) : [];
  const open = () => { setQuery(""); close(); };

  return (
    <>
      {collapsed ? null : (
        <div className="admin-nav-search">
          <i className="ri-search-line" aria-hidden="true" />
          <input type="search" aria-label="Search navigation" placeholder="Find a page…" value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.stopPropagation();
                setQuery("");
              }
            }} />
          {query ? <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><i className="ri-close-line" aria-hidden="true" /></button> : null}
        </div>
      )}
      <div className="admin-nav-scroll">
        {terms.length ? (
          matches.length
            ? <ul aria-label="Search results">{matches.map(({ entry, trail }) => <MenuEntry entry={entry} key={entry.id} close={open} trail={trail} />)}</ul>
            : <p className="admin-nav-message" role="status">No pages found.</p> // rule-policy: technical menu-search-empty Reports no matches in navigation search.
        ) : <ul>{menu.map((entry) => <MenuEntry entry={entry} key={entry.id} close={open} />)}</ul>}
        {nodes ? null : <>
          {/* // rule-policy: technical menu-load-feedback Reports a loading or failed request for navigation items. */}
          <p role="status" className="admin-nav-message">{failed ? "Menu unavailable." : "Loading menu…"}</p>
          {failed ? <button type="button" className="admin-nav-item" title="Retry menu" onClick={() => setAttempt((value) => value + 1)}>
            <i className="ri-refresh-line admin-nav-icon" aria-hidden="true" /><span className="admin-nav-label">Retry menu</span>
          </button> : null}
        </>}
      </div>
      {footer.length ? <ul className="admin-nav-footer">{footer.map((entry) => <MenuEntry entry={entry} key={entry.id} close={open} />)}</ul> : null}
    </>
  );
}
