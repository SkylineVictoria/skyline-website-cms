import { Navigate, useLocation } from "react-router-dom";
import { legacyLoginTarget } from "@/lib/loginRouting";

/** Old sign-in URLs (/admin/login, /agency/login) now lead to the single /login, keeping a validated return path. */
export default function LoginRedirect() {
  const location = useLocation();
  return <Navigate to={legacyLoginTarget(location.search, (location.state as { from?: string } | null)?.from)} replace />;
}
