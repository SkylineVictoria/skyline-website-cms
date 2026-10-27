import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { ROLE_LABELS } from "@/pages/agency/lib/portalData";

interface NavEntry {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

const AGENCY_NAV: NavEntry[] = [
  { to: "/agency/dashboard", label: "Dashboard", icon: "ri-dashboard-3-line" },
  { to: "/agency/applications", label: "Applications", icon: "ri-file-list-3-line", end: true },
  { to: "/agency/applications/new", label: "Add New Form", icon: "ri-add-circle-line" },
  { to: "/agency/documents", label: "Documents", icon: "ri-folder-3-line" },
  { to: "/agency/notifications", label: "Notifications", icon: "ri-notification-3-line" },
  { to: "/agency/agency-profile", label: "Agency Profile", icon: "ri-building-2-line" },
  { to: "/agency/profile", label: "My Profile", icon: "ri-user-settings-line" },
];

const SLIT_NAV: NavEntry[] = [
  { to: "/agency/dashboard", label: "Dashboard", icon: "ri-dashboard-3-line" },
  { to: "/agency/agencies", label: "Agencies", icon: "ri-building-2-line" },
  { to: "/agency/users", label: "Users", icon: "ri-group-line" },
  { to: "/agency/all-applications", label: "All Applications", icon: "ri-file-list-3-line" },
  { to: "/agency/registrations", label: "Registrations", icon: "ri-file-shield-2-line" },
  { to: "/agency/notifications", label: "Notifications", icon: "ri-notification-3-line" },
  { to: "/agency/audit-log", label: "Audit Log", icon: "ri-history-line" },
];

const CRUMB_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  applications: "Applications",
  new: "Add New Form",
  documents: "Documents",
  notifications: "Notifications",
  "agency-profile": "Agency Profile",
  profile: "My Profile",
  agencies: "Agencies",
  users: "Users",
  "all-applications": "All Applications",
  "audit-log": "Audit Log",
  registrations: "Registrations",
};

function buildCrumbs(pathname: string): { label: string; to?: string }[] {
  const parts = pathname.replace(/^\/agency\/?/, "").split("/").filter(Boolean);
  const crumbs: { label: string; to?: string }[] = [{ label: "Agency Portal", to: "/agency/dashboard" }];
  let acc = "/agency";
  parts.forEach((part, index) => {
    acc += `/${part}`;
    const label = CRUMB_LABELS[part] ?? (index > 0 && parts[index - 1] === "applications" ? "Application" : part);
    crumbs.push({ label, to: acc });
  });
  return crumbs;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export default function PortalLayout() {
  const { authUser, role, profile, agency, signOut, scopeEpoch, selectedScope } = usePortalAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setUserMenu(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
    setUserMenu(false);
  }, [location.pathname]);

  const displayName = profile?.fullName?.trim() || authUser?.name || "User";
  const isSlit = role === "slit_admin";
  const nav = isSlit ? SLIT_NAV : role === "agency_admin" ? [...AGENCY_NAV, { to: "/agency/users", label: selectedScope?.tenantId ? "Institution agents" : "Team", icon: "ri-group-line" }] : AGENCY_NAV;
  const crumbs = buildCrumbs(location.pathname);
  const workspaceName = isSlit ? selectedScope?.tenantId ? selectedScope.name : "SLIT Administration" : agency?.name || "Agency";

  const handleSignOut = async () => {
    try { await signOut(); navigate("/login"); }
    catch { /* The active editor displays its save error and retains values. */ }
  };

  const sidebar = (
    <nav className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-background-200 px-5 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-500 text-background-50">
          <i className="ri-graduation-cap-line text-lg" aria-hidden="true" />
        </span>
        <div className="leading-tight">
          <p className="font-heading text-sm font-bold text-foreground-950">Skyline</p>
          <p className="font-label text-[11px] uppercase tracking-wide text-foreground-500">Agency Portal</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={() => setMenuOpen(false)}
            className={({ isActive }) =>
              `mb-0.5 flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium transition-colors ${
                isActive ? "bg-primary-500 text-background-50" : "text-foreground-700 hover:bg-background-100"
              }`
            }
          >
            <i className={`${item.icon} text-lg`} aria-hidden="true" />
            <span className="truncate">{item.label}</span>
          </NavLink>
        ))}
      </div>
      <div className="border-t border-background-200 px-3 py-3">
        {isSlit ? (
          <Link
            to="/admin"
            className="mb-0.5 flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium text-foreground-700 transition-colors hover:bg-background-100"
          >
            <i className="ri-shield-keyhole-line text-lg" aria-hidden="true" />
            Website CMS
          </Link>
        ) : null}
        <Link
          to="/"
          className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium text-foreground-700 transition-colors hover:bg-background-100"
        >
          <i className="ri-external-link-line text-lg" aria-hidden="true" />
          View public website
        </Link>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen bg-background-100 text-foreground-900">
      <div className="flex">
        <aside className="sticky top-0 hidden h-screen w-[264px] shrink-0 border-r border-background-200 bg-background-50 lg:block">
          {sidebar}
        </aside>

        {menuOpen ? (
          <div className="fixed inset-0 z-[70] lg:hidden">
            <div className="absolute inset-0 bg-foreground-950/40" onClick={() => setMenuOpen(false)} aria-hidden="true" />
            <aside className="absolute left-0 top-0 h-full w-[272px] border-r border-background-200 bg-background-50">
              {sidebar}
            </aside>
          </div>
        ) : null}

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-40 border-b border-background-200 bg-background-50">
            <div className="flex items-center justify-between gap-3 px-4 py-3 md:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  type="button"
                  onClick={() => setMenuOpen(true)}
                  aria-label="Open menu"
                  className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-background-300 text-foreground-700 lg:hidden"
                >
                  <i className="ri-menu-line text-lg" aria-hidden="true" />
                </button>
                <div className="min-w-0">
                  <p className="truncate font-heading text-sm font-bold text-foreground-950">{workspaceName}</p>
                  <p className="flex items-center gap-1.5 text-[11px] text-foreground-500">
                    <i className="ri-shield-user-line text-primary-500" aria-hidden="true" />
                    {role ? ROLE_LABELS[role] : ""}
                    {!isSlit && agency?.code ? <span className="text-foreground-400">&middot; {agency.code}</span> : null}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {!isSlit ? (
                  <Link
                    to="/agency/applications/new"
                    className="hidden items-center gap-1.5 whitespace-nowrap rounded-md bg-primary-500 px-4 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 sm:inline-flex"
                  >
                    <i className="ri-add-line text-base" aria-hidden="true" />
                    Add New Form
                  </Link>
                ) : null}
                <Link
                  to="/agency/notifications"
                  aria-label="Notifications"
                  className="flex h-9 w-9 items-center justify-center rounded-md border border-background-200 text-foreground-600 transition-colors hover:bg-background-100 hover:text-primary-600"
                >
                  <i className="ri-notification-3-line text-lg" aria-hidden="true" />
                </Link>

                <div className="relative" ref={menuRef}>
                  <button
                    type="button"
                    onClick={() => setUserMenu((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={userMenu}
                    className="flex cursor-pointer items-center gap-2.5 rounded-md border border-background-200 px-2.5 py-1.5 transition-colors hover:bg-background-100"
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-100 text-[11px] font-semibold text-accent-900">
                      {initialsOf(displayName)}
                    </span>
                    <span className="hidden text-left leading-tight sm:block">
                      <span className="block text-[13px] font-medium text-foreground-900">{displayName}</span>
                      <span className="block text-[11px] text-foreground-500">{role ? ROLE_LABELS[role] : ""}</span>
                    </span>
                    <i className="ri-arrow-down-s-line text-foreground-500" aria-hidden="true" />
                  </button>
                  {userMenu ? (
                    <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-lg border border-background-200 bg-background-50 py-1.5 shadow-lg">
                      <div className="border-b border-background-100 px-4 py-2.5">
                        <p className="truncate text-sm font-semibold text-foreground-950">{displayName}</p>
                        <p className="truncate text-xs text-foreground-500">{authUser?.email}</p>
                        <p className="mt-1 text-[11px] font-medium text-primary-600">{role ? ROLE_LABELS[role] : ""}</p>
                      </div>
                      <Link
                        to="/agency/profile"
                        onClick={() => setUserMenu(false)}
                        className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-foreground-700 transition-colors hover:bg-background-100"
                      >
                        <i className="ri-user-settings-line text-base" aria-hidden="true" />
                        My profile
                      </Link>
                      <button
                        type="button"
                        onClick={handleSignOut}
                        className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-2.5 text-left text-sm text-primary-700 transition-colors hover:bg-primary-50"
                      >
                        <i className="ri-logout-box-r-line text-base" aria-hidden="true" />
                        Sign out
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <nav aria-label="Breadcrumb" className="border-t border-background-100 px-4 py-2 md:px-6">
              <ol className="flex flex-wrap items-center gap-1.5 text-xs text-foreground-500">
                {crumbs.map((crumb, index) => (
                  <li key={`${crumb.label}-${index}`} className="flex items-center gap-1.5">
                    {index > 0 ? <i className="ri-arrow-right-s-line text-foreground-300" aria-hidden="true" /> : null}
                    {crumb.to && index < crumbs.length - 1 ? (
                      <Link to={crumb.to} className="hover:text-primary-600">
                        {crumb.label}
                      </Link>
                    ) : (
                      <span className={index === crumbs.length - 1 ? "font-medium text-foreground-800" : ""}>{crumb.label}</span>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          </header>

          <main className="px-4 py-6 md:px-6 md:py-7">
            <Outlet key={scopeEpoch} />
          </main>
        </div>
      </div>
    </div>
  );
}
