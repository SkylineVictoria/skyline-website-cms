import { useEffect, useState } from "react";
import { createMemoryRouter, RouterProvider, Outlet, Navigate } from "react-router-dom";
import routes from "@/router/config";
import { authenticatedSupabase } from "./lib/supabase";
import { requestWebsiteDomain } from "@/lib/tenantHost";
import { previewFrameView, PREVIEW_READ_ONLY, type PreviewView } from "@/lib/portalPreview";
import { PortalAuthContext, type PortalAuthValue } from "@/pages/agency/lib/portalAuthContext";
import PortalLayout from "@/pages/agency/components/PortalLayout";
import WorkspaceShell from "@/pages/agency/components/WorkspaceShell";
import { ToastProvider } from "./components/ui";

const blocked = async () => ({ ok: false, error: PREVIEW_READ_ONLY });
function sampleIdentity(view: PreviewView): PortalAuthValue {
  const name = view === "student" ? "Sample Student" : "Sample Agent";
  const id = "00000000-0000-4000-8000-000000000001";
  return {
    scopes: [], selectedScope: null, scopeEpoch: 0, selectScope: async () => {},
    authUser: { id, name, email: `${view}@example.invalid` }, role: view === "student" ? "student" : "agent", studentId: view === "student" ? id : null,
    profile: { id, fullName: name, email: `${view}@example.invalid`, phone: "", jobTitle: "", status: "Active" },
    agency: view === "agent" ? { id, name: "Sample Agency", code: "SAMPLE", registrationNumber: "", businessEmail: "agent@example.invalid", phone: "", address: "", country: "", primaryContact: "", status: "Active", isPermanent: false } : null,
    membership: null, authLoading: false, identityLoading: false, identityError: "",
    signIn: blocked, signOut: async () => { throw new Error(PREVIEW_READ_ONLY); }, requestReset: blocked, reloadIdentity: async () => {}, updateOwnProfile: blocked, changeOwnPassword: blocked,
  };
}

function StaffPreviewShell() {
  return <WorkspaceShell portalLabel="Staff workspace" workspaceName="My HR" roleLabel="Staff preview" displayName="Sample Staff"
    nav={[{ to: "/staff", label: "My HR", icon: "ri-user-line", end: true }, { to: "/staff/assessments", label: "Assessments", icon: "ri-edit-box-line" }, { to: "/bookings", label: "Bookings", icon: "ri-calendar-check-line" }]}
    onSignOut={() => {}}><Outlet /></WorkspaceShell>;
}

function PreviewUnavailable() { return <p className="p-6" role="status">This action is unavailable in the read-only sample preview. Use the portal navigation to continue.</p>; }

function makeRouter(view: PreviewView) {
  // Reuse the actual route elements. No copied portal pages or parallel mock UI.
  const portal = routes.find(route => route.path === "/agency")?.children?.find(route => !route.path)?.children ?? [];
  const allowed = new Set(["applications", "workspace", "documents", "assessments", "notifications", "profile", "tickets", "bookings"]);
  const children = view === "staff"
    ? routes.filter(route => ["/staff", "/staff/assessments", "/bookings"].includes(route.path ?? "")).map(route => ({ ...route, path: route.path === "/bookings" ? "/bookings" : route.path, children: undefined }))
    : [{ path: "/agency", element: <PortalLayout />, children: [
      { index: true, element: <Navigate to={view === "student" ? "/agency/applications" : "/agency/workspace"} replace /> },
      ...portal.filter(route => allowed.has(route.path ?? "") && (view !== "student" || route.path !== "workspace")),
      { path: "*", element: <PreviewUnavailable /> },
    ] }];
  return createMemoryRouter([{ element: <ToastProvider><PortalAuthContext.Provider value={sampleIdentity(view)}><Outlet /></PortalAuthContext.Provider></ToastProvider>, children: [
    ...(view === "staff" ? [{ element: <StaffPreviewShell />, children }] : children),
    { path: "*", element: <PreviewUnavailable /> },
  ] }], { initialEntries: [view === "staff" ? "/staff" : view === "student" ? "/agency/applications" : "/agency/workspace"] });
}

/** Separate document and data client keep caches, navigation and form state out of
 * the administrator workspace. Authorization still uses the REAL session and RLS. */
export default function PortalPreviewFrame() {
  const view = previewFrameView();
  const [allowed, setAllowed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [router] = useState(() => view ? makeRouter(view) : null);
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const { data, error } = await authenticatedSupabase.auth.getUser();
        if (error || !data.user) throw new Error("No session");
        const result = requestWebsiteDomain()
          ? await authenticatedSupabase.rpc("tenant_cms_identity")
          : await authenticatedSupabase.from("cms_users").select("role,status,must_change_password").eq("auth_user_id", data.user.id).maybeSingle();
        const u = result.data;
        const ok = !result.error && u?.role === "Admin" && u.status !== "Inactive" && !u.must_change_password && !u.mustChangePassword;
        if (active) { setAllowed(Boolean(ok)); setChecked(true); }
      } catch { if (active) { setAllowed(false); setChecked(true); } }
    };
    void check();
    const timer = window.setInterval(() => void check(), 60000);
    const { data: sub } = authenticatedSupabase.auth.onAuthStateChange(event => {
      if (event === "SIGNED_OUT") { setAllowed(false); setChecked(true); }
    });
    return () => { active = false; window.clearInterval(timer); sub.subscription.unsubscribe(); };
  }, []);
  if (!checked) return <p role="status" className="p-6">Checking administrator access…</p>;
  if (!allowed || !router) return <p role="alert" className="p-6">Administrator access is required for Switch View.</p>;
  return <><div className="border-b bg-amber-50 px-4 py-2 text-xs text-amber-950">Sample data · Read-only. Named-user previews are not enabled.</div><RouterProvider router={router} /></>;
}
