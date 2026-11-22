import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/pages/admin/lib/authContext";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { AdminLoading, AdminError } from "@/pages/admin/components/ui";
import { DraftProvider } from "@/pages/admin/lib/draft";
import { requestWebsiteDomain } from "@/lib/tenantHost";
import AdminMenu from "@/pages/admin/components/AdminMenu";
import { hadSession, loginUrl } from "@/lib/loginRouting";
import { useUiPrefs, type Density } from "@/pages/admin/lib/uiPrefs";
import { VIEW_LABELS, type ViewKind } from "@/lib/viewAs";
import ViewAsPicker from "@/components/base/ViewAsPicker";
import ManageRulesLink from "@/pages/admin/businessRules/ManageRulesLink";
import CommPopup from "@/pages/admin/components/CommPopup";
import MasterTimetableDue from "@/pages/admin/components/MasterTimetableDue";

/** Form and text pages read better at a set width; tables, timelines and boards use the full width. */
const NARROW = [/^\/admin\/(settings|institution|set-password|seo|contact|navigation|footer)\/?$/, /^\/admin\/integrations\/(settings|credentials|add)\/?$/];

function initials(name: string) {
  return name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export default function AdminLayout() {
  const { user, authLoading, logout } = useAuth();
  const { data, status, error, reload } = useAdminData();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [switching, setSwitching] = useState<ViewKind | "">("");
  const [switchError, setSwitchError] = useState("");
  const [picking, setPicking] = useState<ViewKind | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [prefs, setPrefs] = useUiPrefs(user?.id);
  const icons = prefs.sidebar === "icons";
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background-100">
        <AdminLoading label="Checking your session…" />
      </div>
    );
  }

  if (!user) return <Navigate to={loginUrl(location.pathname + location.search, hadSession())} replace />;

  // Force a password rotation before any CMS content is reachable.
  if (user.mustChangePassword && location.pathname !== "/admin/set-password") {
    return <Navigate to="/admin/set-password" replace />;
  }

  const tenant = requestWebsiteDomain();
  const sidebar = (collapsed: boolean, mobile = false) => (
    <nav className="admin-nav" data-collapsed={collapsed} aria-label="Admin"
      onKeyDown={(event) => { if (mobile && event.key === "Escape") setMenuOpen(false); }}>
      <div className="admin-nav-brand">
        <span className="admin-nav-mark" title={collapsed ? "Skyline CMS" : undefined}>
          <i className="ri-building-2-line" aria-hidden="true" />
        </span>
        {collapsed ? null : <div className="admin-nav-name" title={tenant ? data.settings.name : "Skyline CMS"}>
          <span>{tenant ? data.settings.shortName || data.settings.name : "Skyline"}</span>
          <small>Admin workspace</small>
        </div>}
        {collapsed ? null : <button type="button" className="admin-nav-toggle"
          title={mobile ? "Close menu" : "Collapse sidebar"} aria-label={mobile ? "Close menu" : "Collapse sidebar"}
          onClick={() => mobile ? setMenuOpen(false) : setPrefs({ sidebar: "icons" })}>
          <i className={mobile ? "ri-close-line" : "ri-side-bar-line"} aria-hidden="true" />
        </button>}
      </div>
      <AdminMenu close={() => setMenuOpen(false)} collapsed={collapsed} />
    </nav>
  );
  const narrow = NARROW.some((r) => r.test(location.pathname));

  // Quiet by default: a small status dot. A banner appears only for problems (offline, a failed save), can be dismissed and offers a retry.
  const problem = !online ? "You are offline. Changes you make stay in this browser as a draft until the connection returns." : status === "ready" && error ? `Could not save: ${error}` : null;
  const showBanner = problem !== null && dismissed !== problem;
  const connection = problem ? { tone: "bg-red-500", label: problem } : status === "loading" ? { tone: "bg-amber-500", label: "Loading content…" } : { tone: "bg-emerald-500", label: "Connected: changes are saved to your website database." };

  return (
    <DraftProvider>
    <div className="min-h-screen bg-background-100 text-sm text-foreground-900" data-density={prefs.density}>
      <div className="flex">
        {/* // rule-policy: technical sidebar-width Changes visual width when the sidebar uses icons. */}
        <aside className={`sticky top-0 hidden h-[calc(100vh-44px)] shrink-0 bg-[#faf9f6] transition-[width] duration-slow ease-out lg:block ${icons ? "w-16" : "w-[var(--sidebar-w)]"}`}>
          {sidebar(icons)}
        </aside>

        {/* Mobile drawer */}
        {menuOpen ? (
          <div className="fixed inset-0 z-[70] lg:hidden">
            <div className="absolute inset-0 bg-foreground-950/40" onClick={() => setMenuOpen(false)} aria-hidden="true" />
            <aside className="drawer-in-left absolute left-0 top-0 h-full w-[min(300px,85vw)] bg-[#faf9f6]">
              {sidebar(false, true)}
            </aside>
          </div>
        ) : null}

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-40 flex items-center justify-between border-b border-background-200 bg-background-50 px-4 py-2.5 md:px-6">
            <div className="flex items-center gap-3">
              {icons ? <button
                type="button"
                onClick={() => setPrefs({ sidebar: "full" })}
                aria-label="Show the menu with labels"
                title="Expand sidebar"
                className="hidden h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-600 transition-colors duration-fast hover:bg-background-100 lg:flex"
              >
                <i className="ri-menu-unfold-line text-lg" aria-hidden="true" />
              </button> : null}
              <button
                type="button"
                onClick={() => setMenuOpen(true)}
                aria-label="Open menu"
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-background-300 text-foreground-700 lg:hidden"
              >
                <i className="ri-menu-line text-lg" aria-hidden="true" />
              </button>
              <span role="status" title={connection.label} aria-label={connection.label} className="flex h-5 w-5 items-center justify-center" tabIndex={0}>
                <span className={`h-2.5 w-2.5 rounded-full ${connection.tone}`} />
              </span>
              <div className="hidden items-center gap-2 text-label text-foreground-500 sm:flex">
                <i className="ri-shield-check-line text-primary-500" aria-hidden="true" />
                <span>{data.settings.shortName} content management</span>
              </div>
            </div>

            <div className="relative flex items-center gap-2">
              {user.role === "Admin" ? <><ManageRulesLink /><CommPopup /></> : null}
              {/* Weekly: courses whose last scheduled cycle ends within a year. */}
              {user.role === "Admin" ? <MasterTimetableDue weeklyPopup /> : null}
              <button
                type="button"
                onClick={() => setUserMenu((v) => !v)}
                className="flex cursor-pointer items-center gap-2.5 rounded-md border border-background-200 px-2.5 py-1.5 hover:bg-background-100"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-500 text-2xs font-semibold text-background-50">
                  {initials(user.name)}
                </span>
                <span className="hidden text-left leading-tight sm:block">
                  <span className="block text-label font-medium text-foreground-900">{user.name}</span>
                  <span className="block text-2xs text-foreground-500">{user.role}</span>
                </span>
                <i className="ri-arrow-down-s-line text-foreground-500" aria-hidden="true" />
              </button>
              {userMenu ? (
                <div className="absolute right-0 top-full z-50 mt-2 w-56 rounded-md border border-background-200 bg-background-50 py-1.5">
                  <div className="border-b border-background-200 px-3 py-2">
                    <p className="text-label font-medium text-foreground-900">{user.name}</p>
                    <p className="truncate text-xs text-foreground-500">{user.email}</p>
                  </div>
                  <div className="border-b border-background-200 px-3 py-2.5">
                    <p className="mb-1.5 text-xs font-medium text-foreground-600">Display density</p>
                    <div className="grid grid-cols-2 gap-0.5 rounded-md border border-background-300 p-0.5" role="radiogroup" aria-label="Display density">
                      {(["compact", "comfortable"] as Density[]).map((d) => (
                        <button key={d} type="button" role="radio" aria-checked={prefs.density === d} onClick={() => setPrefs({ density: d })}
                          className={`rounded px-2 py-1 text-xs font-medium transition-colors duration-fast ${prefs.density === d ? "bg-primary-500 text-background-50" : "text-foreground-700 hover:bg-background-100"}`}>
                          {d === "compact" ? "Compact" : "Comfortable"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {user.role === "Admin" ? (
                    <div className="border-b border-background-200 px-3 py-2.5" data-testid="switch-view">
                      <p className="mb-1.5 text-xs font-medium text-foreground-600">Sign in as</p>
                      <div className="grid grid-cols-3 gap-1">
                        {(Object.keys(VIEW_LABELS) as ViewKind[]).map((k) => (
                          <button key={k} type="button" disabled={switching !== ""} onClick={() => { setSwitchError(""); setPicking(k); setUserMenu(false); }}
                            className="rounded border border-background-300 px-1.5 py-1 text-xs font-medium text-foreground-800 hover:border-primary-300 hover:bg-primary-50 disabled:opacity-60">
                            {switching === k ? "Opening…" : VIEW_LABELS[k]}
                          </button>
                        ))}
                      </div>
                      {switchError ? <p role="alert" className="mt-1.5 text-xs text-primary-800">{switchError}</p> : null}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setUserMenu(false);
                      logout();
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-label text-foreground-700 hover:bg-background-100"
                  >
                    <i className="ri-logout-box-r-line text-base" aria-hidden="true" />
                    Sign out
                  </button>
                </div>
              ) : null}
            </div>
          </header>

          {showBanner ? (
            <div role="alert" className="flex items-center gap-3 border-b border-red-200 bg-red-50 px-4 py-2.5 text-label text-red-900 md:px-6">
              <i className="ri-error-warning-line text-base" aria-hidden="true" />
              <span className="flex-1">{problem}</span>
              {online ? <button type="button" onClick={reload} className="cursor-pointer rounded border border-red-300 bg-background-50 px-2.5 py-1 font-medium hover:bg-red-100">Retry</button> : null}
              <button type="button" aria-label="Dismiss" onClick={() => setDismissed(problem)} className="flex h-6 w-6 cursor-pointer items-center justify-center rounded hover:bg-red-100"><i className="ri-close-line" aria-hidden="true" /></button>
            </div>
          ) : null}
          <main className={`min-w-0 overflow-x-clip px-4 py-[var(--page-pad-y)] md:px-6 ${narrow ? "[&>*]:mx-auto [&>*]:max-w-5xl" : ""}`}>
            {status === "loading" ? (
              <AdminLoading />
            ) : status === "error" ? (
              <AdminError message={error ?? undefined} onRetry={reload} />
            ) : (
              <Outlet />
            )}
          </main>
        </div>
      </div>
      {picking ? <ViewAsPicker kind={picking} onClose={() => setPicking(null)} /> : null}
    </div>
    </DraftProvider>
  );
}
