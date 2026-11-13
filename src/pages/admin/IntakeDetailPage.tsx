import { Navigate, useParams } from "react-router-dom";

/** The old address of an intake (/admin/intakes/:id): it opens in Courses › Intakes, in the intake sheet. */
export default function IntakeDetailPage() {
  const { id = "" } = useParams();
  return <Navigate to={`/admin/course-fees?view=intakes#${encodeURIComponent(id)}`} replace />;
}
