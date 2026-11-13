import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

export interface NavEntry {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

export interface Crumb {
  label: string;
  to?: string;
}

interface Props {
  /** Small caption under "Skyline" in the sidebar, e.g. "Student Portal". */
  portalLabel: string;
  /** Bold title at the top of the header. */
  workspaceName: string;
  roleLabel: string;
  /** Shown after the role in the header, e.g. the agency code. */
  roleSuffix?: ReactNode;
  nav: NavEntry[];
  sidebarFooter?: ReactNode;
  displayName: string;
  email?: string;
  /** Header links; left out when the workspace has no such page. */
  profileTo?: string;
  notificationsTo?: string;
  crumbs?: Crumb[];
  onSignOut: () => void;
  children: ReactNode;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * The workspace chrome shared by the student / agency portal (PortalLayout) and the staff workspace: sidebar with navigation,
 * sticky header with the workspace name, role and user menu, optional breadcrumb, and the page body. Presentational only;
 * the caller decides who is signed in and what the navigation holds.
 */
export default function WorkspaceShell({ portalLabel, workspaceName, roleLabel, roleSuffix, nav, sidebarFooter, displayName, email, profileTo, notificationsTo, crumbs, onSignOut, children }: Props) {
  const location = useLocation();
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

  const sidebar = (
    <nav className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-background-200 px-5 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-500 text-background-50">
          <i className="ri-graduation-cap-line text-lg" aria-hidden="true" />
        </span>
        <div className="leading-tight">
          <p className="font-heading text-sm font-bold text-foreground-950">Skyline</p>
          <p className="font-label text-2xs uppercase tracking-wide text-foreground-500">{portalLabel}</p>
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
              `mb-0.5 flex items-center gap-2.5 rounded-md px-3 py-2 text-label font-medium transition-colors ${
                isActive ? "bg-primary-500 text-background-50" : "text-foreground-700 hover:bg-background-100"
              }`
            }
          >
            <i className={`${item.icon} text-lg`} aria-hidden="true" />
            <span className="truncate">{item.label}</span>
          </NavLink>
        ))}
      </div>
      <div className="border-t border-background-200 px-3 py-3">{sidebarFooter}</div>
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
                  <p className="flex items-center gap-1.5 text-2xs text-foreground-500">
                    <i className="ri-shield-user-line text-primary-500" aria-hidden="true" />
                    {roleLabel}
                    {roleSuffix}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {notificationsTo ? (
                  <Link
                    to={notificationsTo}
                    aria-label="Notifications"
                    className="flex h-9 w-9 items-center justify-center rounded-md border border-background-200 text-foreground-600 transition-colors hover:bg-background-100 hover:text-primary-600"
                  >
                    <i className="ri-notification-3-line text-lg" aria-hidden="true" />
                  </Link>
                ) : null}

                <div className="relative" ref={menuRef}>
                  <button
                    type="button"
                    onClick={() => setUserMenu((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={userMenu}
                    className="flex cursor-pointer items-center gap-2.5 rounded-md border border-background-200 px-2.5 py-1.5 transition-colors hover:bg-background-100"
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-100 text-2xs font-semibold text-accent-900">
                      {initialsOf(displayName)}
                    </span>
                    <span className="hidden text-left leading-tight sm:block">
                      <span className="block text-label font-medium text-foreground-900">{displayName}</span>
                      <span className="block text-2xs text-foreground-500">{roleLabel}</span>
                    </span>
                    <i className="ri-arrow-down-s-line text-foreground-500" aria-hidden="true" />
                  </button>
                  {userMenu ? (
                    <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-lg border border-background-200 bg-background-50 py-1.5 shadow-lg">
                      <div className="border-b border-background-100 px-4 py-2.5">
                        <p className="truncate text-sm font-semibold text-foreground-950">{displayName}</p>
                        <p className="truncate text-xs text-foreground-500">{email}</p>
                        <p className="mt-1 text-2xs font-medium text-primary-600">{roleLabel}</p>
                      </div>
                      {profileTo ? (
                        <Link
                          to={profileTo}
                          onClick={() => setUserMenu(false)}
                          className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-foreground-700 transition-colors hover:bg-background-100"
                        >
                          <i className="ri-user-settings-line text-base" aria-hidden="true" />
                          My profile
                        </Link>
                      ) : null}
                      <button
                        type="button"
                        onClick={onSignOut}
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

            {crumbs && crumbs.length > 2 ? <nav aria-label="Breadcrumb" className="border-t border-background-100 px-4 py-2 md:px-6">
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
            </nav> : null}
          </header>

          <main className="px-4 py-6 md:px-6 md:py-7">{children}</main>
        </div>
      </div>
    </div>
  );
}
