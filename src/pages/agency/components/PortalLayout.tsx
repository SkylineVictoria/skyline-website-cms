import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useState } from "react";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { discardDrafts, unsavedDraftKeys } from "@/lib/assessment/autosave";
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
  { to: "/agency/learning", label: "My learning", icon: "ri-book-open-line" },
  { to: "/agency/timetable", label: "My timetable", icon: "ri-calendar-2-line" },
  { to: "/agency/assessments", label: "My assessments", icon: "ri-edit-box-line" },
  { to: "/agency/documents", label: "My documents", icon: "ri-folder-3-line" },
  { to: "/agency/messages", label: "Messages", icon: "ri-chat-3-line" },
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
  students: "Students",
  new: "Add candidate",
  workspace: "Workspace",
  documents: "Documents",
  assessments: "Assessments",
  learning: "My learning",
  timetable: "My timetable",
  messages: "Messages",
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
  // PORTAL-MY-STUDENTS (owner 2026-11-27): the business admin agent sees "Our <business> Students / Applications" (the whole
  // business); an agent sees "My students / My applications" (only their own).
  const ours = agency?.name ?? "";
  const agencyNav: NavEntry[] = AGENCY_NAV.flatMap((entry) => entry.to === "/agency/applications" ? [
    { to: "/agency/students", label: role === "agency_admin" ? `${ours} Students`.trim() : "My students", icon: "ri-user-3-line" },
    { ...entry, label: role === "agency_admin" ? `${ours} Applications`.trim() : "My applications" },
  ] : [entry]);
  const nav = isSlit ? SLIT_NAV : isStudent ? STUDENT_NAV : role === "agency_admin" ? [...agencyNav, { to: "/agency/users", label: selectedScope?.tenantId ? "Institution agents" : "Agents", icon: "ri-group-line" }] : agencyNav;
  const crumbs = buildCrumbs(location.pathname).map((crumb, index) => (index === 0 && isStudent ? { ...crumb, label: "Student Portal" } : crumb));
  const workspaceName = isSlit ? selectedScope?.tenantId ? selectedScope.name : "SLIT Administration" : isStudent ? "My applications" : agency?.name || "Agency";

  // assessment answers still waiting to be saved (kept in this browser): the student is asked before signing out (owner 2026-11-26)
  const [unsavedAsk, setUnsavedAsk] = useState(false);
  const handleSignOut = async (discard = false) => {
    if (!discard && authUser?.id && unsavedDraftKeys(authUser.id).length) { setUnsavedAsk(true); return; }
    if (discard && authUser?.id) discardDrafts(authUser.id);
    setUnsavedAsk(false);
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
      {unsavedAsk ? <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="signout-unsaved-title" data-testid="signout-unsaved">
        <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
          <h2 id="signout-unsaved-title" className="text-base font-semibold text-foreground-900">You have unsaved answers</h2>
          <p className="mt-2 text-sm text-foreground-700">You have unsaved answers. Reconnect to save them, or they'll be lost when you sign out.</p>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button type="button" className="min-h-[44px] rounded-lg border border-red-300 px-4 text-sm font-semibold text-red-700" onClick={() => void handleSignOut(true)} data-testid="signout-discard">Discard them and sign out</button>
            <button type="button" className="min-h-[44px] rounded-lg bg-primary-600 px-4 text-sm font-semibold text-white" onClick={() => setUnsavedAsk(false)} data-testid="signout-cancel" autoFocus>Cancel</button>
          </div>
        </div>
      </div> : null}
    </WorkspaceShell>
  );
}
