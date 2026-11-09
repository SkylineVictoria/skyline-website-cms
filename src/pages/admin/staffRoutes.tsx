import { Navigate, useParams } from "react-router-dom";
import { staffCandidatePath, staffEmployeePath } from "@/pages/admin/lib/staffRoutes";

/** The old Agencies > Staff detail address (/admin/staff/:id) now lives under Staff > Employees. */
export function LegacyStaffDetailRedirect() {
  const { id = "" } = useParams();
  return <Navigate to={staffEmployeePath(id)} replace />;
}
/** The Master Data addresses of 20261109153953 (/admin/candidates/:id, /admin/employees/:id) now live under Staff. */
export function LegacyCandidateRedirect() {
  const { id = "" } = useParams();
  return <Navigate to={staffCandidatePath(id)} replace />;
}
export function LegacyEmployeeRedirect() {
  const { id = "" } = useParams();
  return <Navigate to={staffEmployeePath(id)} replace />;
}
