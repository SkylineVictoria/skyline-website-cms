import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { hadSession, loginUrl } from "@/lib/loginRouting";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import PortalLayout from "@/pages/agency/components/PortalLayout";

function WorkspaceLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background-100">
      <div className="flex flex-col items-center gap-3 text-center" aria-live="polite">
        <i className="ri-loader-4-line animate-spin text-2xl text-primary-600" aria-hidden="true" />
        <p className="text-sm text-foreground-600">Loading your workspace&hellip;</p>
      </div>
    </div>
  );
}

/** The CMS page for a portal address an administrator opened (old links, bookmarks, emails). */
function adminPathFor(pathname: string): string {
  const path = pathname.replace(/\/+$/, "");
  const rules: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    [/^\/agency\/applications\/new$/, () => "/admin/applications/new"],
    [/^\/agency\/applications\/([^/]+)$/, (m) => `/admin/applications/${m[1]}`],
    [/^\/agency(?:\/(?:applications|all-applications|dashboard|workspace|documents))?$/, () => "/admin/applications"],
    [/^\/agency\/tickets\/([^/]+)$/, (m) => `/admin/tickets/${m[1]}`],
    [/^\/agency\/tickets$/, () => "/admin/tickets"],
    [/^\/agency\/(agencies|agency-profile)$/, () => "/admin/businesses"],
    [/^\/agency\/audit-log$/, () => "/admin/audit-log"],
    [/^\/agency\/registrations$/, () => "/admin/registrations"],
    [/^\/agency\/users$/, () => "/admin/portal-users"],
  ];
  for (const [pattern, to] of rules) {
    const match = path.match(pattern);
    if (match) return to(match);
  }
  return "/admin";
}

/**
 * Auth + authorization gate for every /agency workspace route.
 *  - Not signed in            → the portal sign-in page.
 *  - Signed in, no portal role → access-not-granted screen.
 *  - Resolved role            → the workspace shell.
 */
export default function RequirePortal() {
  const { authUser, role, authLoading, identityLoading, identityError, signOut, reloadIdentity } = usePortalAuth();
  const navigate = useNavigate();
  const location = useLocation();

  if (authLoading) return <WorkspaceLoader />;
  if (!authUser) return <Navigate to={loginUrl(location.pathname + location.search, hadSession())} replace />;
  if (identityLoading) return <WorkspaceLoader />;

  if (identityError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background-100 px-5">
        <div className="w-full max-w-md rounded-card border border-background-200 bg-background-50 p-6 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary-50 text-xl text-primary-600">
            <i className="ri-error-warning-line" aria-hidden="true" />
          </span>
          <h1 className="mt-4 font-heading text-lg font-bold text-foreground-950">We couldn&rsquo;t load your access</h1>
          <p className="mt-2 text-sm text-foreground-600">{identityError}</p>
          <div className="mt-5 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => void reloadIdentity()}
              className="cursor-pointer whitespace-nowrap rounded-md bg-primary-500 px-4 py-2.5 text-sm font-semibold text-background-50 hover:bg-primary-600"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => void signOut().then(() => navigate("/login"))}
              className="cursor-pointer whitespace-nowrap rounded-md border border-background-300 px-4 py-2.5 text-sm font-semibold text-foreground-800 hover:bg-background-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!role) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background-100 px-5">
        <div className="w-full max-w-md rounded-card border border-background-200 bg-background-50 p-6 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-secondary-100 text-xl text-secondary-900">
            <i className="ri-shield-user-line" aria-hidden="true" />
          </span>
          <h1 className="mt-4 font-heading text-lg font-bold text-foreground-950">Access not granted</h1>
          <p className="mt-2 text-sm text-foreground-600">
            You are signed in as <strong>{authUser.email}</strong>, but this account is not linked to an active agency.
            Access to the Agency Portal is provisioned by SLIT Administration — please contact them to have your account
            activated.
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => void reloadIdentity()}
              className="cursor-pointer whitespace-nowrap rounded-md border border-background-300 px-4 py-2.5 text-sm font-semibold text-foreground-800 hover:bg-background-100"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void signOut().then(() => navigate("/login"))}
              className="cursor-pointer whitespace-nowrap rounded-md bg-primary-500 px-4 py-2.5 text-sm font-semibold text-background-50 hover:bg-primary-600"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  // SLIT administrators work only in the CMS: any portal address opens its CMS counterpart.
  if (role === "slit_admin") return <Navigate to={adminPathFor(location.pathname) + location.search} replace />;
  return <PortalLayout />;
}