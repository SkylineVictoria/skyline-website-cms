import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import BookingShell from "./BookingShell";
import BookingsHub from "./BookingsHub";

/** /bookings: the booking module on its own page, for any signed-in staff member, agent or student. */
export default function BookingsPage() {
  const [state, setState] = useState<"loading" | "in" | "out">("loading");
  useEffect(() => { void supabase.auth.getUser().then(({ data }) => setState(data.user ? "in" : "out")); }, []);
  if (state === "out") return <Navigate to="/login?next=%2Fbookings" replace />;
  return (
    <BookingShell wide>
      {state === "loading" ? <p role="status" className="text-sm text-foreground-600">Loading…</p> : <>
        <BookingsHub />
        <p className="mt-8 text-sm text-foreground-600">
          Back to: <Link to="/agency" className="text-primary-700 underline">Portal</Link> · <Link to="/staff" className="text-primary-700 underline">My HR</Link> · <Link to="/admin" className="text-primary-700 underline">CMS</Link>
        </p>
      </>}
    </BookingShell>
  );
}
