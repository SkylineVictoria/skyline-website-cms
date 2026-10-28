import { Outlet } from "react-router-dom";
import { PortalAuthProvider } from "@/pages/agency/lib/portalAuth";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { ApplicationPathsContext, cmsPaths } from "@/pages/agency/lib/applicationPaths";
import { PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";

function Gate() {
  const { authLoading, identityLoading, identityError, role, reloadIdentity } = usePortalAuth();
  if (authLoading || identityLoading) return <PortalLoading label="Opening applications…" />;
  if (identityError) return <PortalError message={identityError} onRetry={() => void reloadIdentity()} />;
  if (!role) return <PortalError message="This account has no access to applications." onRetry={() => void reloadIdentity()} />;
  return <Outlet />;
}

/**
 * Applications inside the CMS (administrators only; the route sits behind RequireAdmin and the database policies
 * independently refuse everyone who is not an administrator or an agency member). The pages are the agency portal's own,
 * with their links pointed at /admin/applications.
 */
export default function ApplicationsArea() {
  return (
    <PortalAuthProvider>
      <ApplicationPathsContext.Provider value={cmsPaths}>
        <Gate />
      </ApplicationPathsContext.Provider>
    </PortalAuthProvider>
  );
}
