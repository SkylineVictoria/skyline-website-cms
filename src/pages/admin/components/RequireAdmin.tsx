import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/pages/admin/lib/authContext";
import { hadSession, loginUrl } from "@/lib/loginRouting";

/**
 * Role authorization gate for Admin-only CMS routes.
 * - Not signed in  → send to the CMS login page.
 * - Signed in but not an Admin → send to the dashboard (no access to this area).
 */
export default function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, authLoading } = useAuth();

  if (authLoading) return null;
  if (!user) return <Navigate to={loginUrl("/admin", hadSession())} replace />;
  if (user.role !== "Admin") return <Navigate to="/admin" replace />;

  return <>{children}</>;
}