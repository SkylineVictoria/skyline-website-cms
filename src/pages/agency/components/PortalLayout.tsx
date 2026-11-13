import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import StudentMobilePrompt from "@/pages/agency/components/StudentMobilePrompt";
import { ROLE_LABELS } from "@/pages/agency/lib/portalData";
import WorkspaceShell, { type NavEntry } from "@/pages/agency/components/WorkspaceShell";

// Agency roles get a short list: the workspace holds the business profile, agents and candidates.
// Profile, sign-out and notifications live in the header; "Add candidate" lives in the workspace.
const AGENCY_NAV: NavEntry[] = [
  { to: "/agency/workspace", label: "Workspace", icon: "ri-building-2-line" },
  { to: "/agency/applications", label: "Applications", icon: "ri-file-list-3-line", end: true },
  { to: "/agency/documents", label: "Documents", icon: "ri-folder-3-line" },
  { to: "/agency/bookings", label: "Bookings", icon: "ri-calendar-check-line" },
  { to: "/agency/tickets", label: "Support tickets", icon: "ri-customer-service-2-line" },
];

// A student sees their own applications and documents only.
const STUDENT_NAV: NavEntry[] = [
  { to: "/agency/applications", label: "My applications", icon: "ri-file-list-3-line", end: true },
  { to: "/agency/documents", label: "My documents", icon: "ri-folder-3-line" },
  { to: "/agency/bookings", label: "Bookings", icon: "ri-calendar-check-line" },
  { to: "/agency/tickets", label: "Support tickets", icon: "ri-customer-service-2-line" },
];

const SLIT_NAV: NavEntry[] = [
  { to: "/agency/dashboard", label: "Dashboard", icon: "ri-dashboard-3-line" },
  { to: "/agency/agencies", label: "Agencies", icon: "ri-building-2-line" },
  { to: "/agency/all-applications", label: "All Applications", icon: "ri-file-list-3-line" },
  { to: "/agency/notifications", label: "Notifications", icon: "ri-notification-3-line" },
  { to: "/agency/audit-log", label: "Audit Log", icon: "ri-history-line" },
];

const CRUMB_LABELS: Record<string, string> = {
  tickets: "Support tickets",
  bookings: "Bookings",
  dashboard: "Dashboard",
  applications: "Applications",
  new: "Add candidate",
  workspace: "Workspace",
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
  const crumbs: { label: string; to?: string }[] = [{ label: "Agency Portal", to: "/agency" }];
  let acc = "/agency";
  parts.forEach((part, index) => {
    acc += `/${part}`;
    const label = CRUMB_LABELS[part] ?? (index > 0 && parts[index - 1] === "applications" ? "Application" : index > 0 && parts[index - 1] === "tickets" ? "Ticket" : part);
    crumbs.push({ label, to: acc });
  });
  return crumbs;
}

const FOOTER_LINK = "flex items-center gap-2.5 rounded-md px-3 py-2 text-label font-medium text-foreground-700 transition-colors hover:bg-background-100";

export default function PortalLayout() {
  const { authUser, role, profile, agency, signOut, scopeEpoch, selectedScope } = usePortalAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const displayName = profile?.fullName?.trim() || authUser?.name || "User";
  const isSlit = role === "slit_admin";
  const isStudent = role === "student";
  const nav = isSlit ? SLIT_NAV : isStudent ? STUDENT_NAV : role === "agency_admin" ? [...AGENCY_NAV, { to: "/agency/users", label: selectedScope?.tenantId ? "Institution agents" : "Agents", icon: "ri-group-line" }] : AGENCY_NAV;
  const crumbs = buildCrumbs(location.pathname).map((crumb, index) => (index === 0 && isStudent ? { ...crumb, label: "Student Portal" } : crumb));
  const workspaceName = isSlit ? selectedScope?.tenantId ? selectedScope.name : "SLIT Administration" : isStudent ? "My applications" : agency?.name || "Agency";

  const handleSignOut = async () => {
    try { await signOut(); navigate("/login"); }
    catch { /* The active editor displays its save error and retains values. */ }
  };

  return (
    <WorkspaceShell
      portalLabel={isStudent ? "Student Portal" : isSlit ? "Admin · Applications" : "Agency Portal"}
      workspaceName={workspaceName}
      roleLabel={role ? ROLE_LABELS[role] : ""}
      roleSuffix={!isSlit && agency?.code ? <span className="text-foreground-400">&middot; {agency.code}</span> : null}
      nav={nav}
      sidebarFooter={isSlit ? (
        <>
          <Link to="/admin" className={`mb-0.5 ${FOOTER_LINK}`}>
            <i className="ri-shield-keyhole-line text-lg" aria-hidden="true" />
            Back to Admin CMS
          </Link>
          <Link to="/" className={FOOTER_LINK}>
            <i className="ri-external-link-line text-lg" aria-hidden="true" />
            View public website
          </Link>
        </>
      ) : null}
      displayName={displayName}
      email={authUser?.email}
      profileTo="/agency/profile"
      notificationsTo="/agency/notifications"
      crumbs={crumbs}
      onSignOut={() => void handleSignOut()}
    >
      <Outlet key={scopeEpoch} />
      {isStudent ? <StudentMobilePrompt key={authUser?.id ?? ""} onSignOut={() => void handleSignOut()} /> : null}
    </WorkspaceShell>
  );
}
