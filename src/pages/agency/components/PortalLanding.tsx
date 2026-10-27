import { Navigate } from "react-router-dom";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { portalLanding } from "@/pages/agency/lib/applicationAccess";

/** Index of /agency (inside RequirePortal, so the role is already resolved from the database). */
export default function PortalLanding() {
  const { role } = usePortalAuth();
  return <Navigate to={portalLanding(role)} replace />;
}
