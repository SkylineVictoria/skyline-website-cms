import { Navigate, useParams } from "react-router-dom";
import { staffEmployeePath } from "@/pages/admin/lib/staffRoutes";

/** The old Agencies > Staff detail address (/admin/staff/:id) now lives under Staff > Employees. */
export function LegacyStaffDetailRedirect() {
  const { id = "" } = useParams();
  return <Navigate to={staffEmployeePath(id)} replace />;
}
