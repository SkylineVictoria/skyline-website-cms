import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { Button } from "@/pages/admin/components/ui";
import { getMyStaff, type MyStaff } from "@/lib/staffApi";
import { STAFF_STATUS_LABEL } from "@/lib/staffStatus";

/**
 * /staff for a signed-in person. Applicants never sign in any more (they work through emailed links), so this page is for
 * activated staff; "My HR" (profile, documents with expiry, signed offer) and the account claim after the Auth invite arrive
 * with HR-02f. Until then it shows who is signed in and their staff status.
 */
export default function StaffHomePage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MyStaff | null | undefined>(undefined);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) { setSignedOut(true); return; }
      try { setMe(await getMyStaff()); } catch (e) { setError(e instanceof Error ? e.message : "We could not load your staff record."); }
    });
  }, []);

  if (signedOut) return <Navigate to="/login?next=%2Fstaff" replace />;
  const signOut = () => { void supabase.auth.signOut().then(() => navigate("/login", { replace: true })); };
  return (
    <div className="flex min-h-screen items-center justify-center bg-background-100 px-5 py-10">
      <div className="w-full max-w-md rounded-card border border-background-200 bg-background-50 p-6 shadow-sm">
        <h1 className="font-heading text-xl font-bold text-foreground-950">Staff</h1>
        {error ? <p role="alert" className="mt-3 text-sm text-primary-900">{error}</p> : null}
        {me === undefined && !error ? <p className="mt-3 text-sm text-foreground-600" role="status">Loading…</p> : null}
        {me === null ? <p className="mt-3 text-sm text-foreground-700">There is no staff record for this login. Staff applications are made from <Link to="/login?mode=enroll&as=staff" className="font-semibold text-primary-700">Enroll now &gt; Staff</Link>.</p> : null}
        {me ? (
          <p className="mt-3 text-sm text-foreground-700" data-testid="staff-home-status">
            {[me.profile.first_name, me.profile.last_name].filter(Boolean).join(" ") || me.profile.email}: <strong>{STAFF_STATUS_LABEL[me.status]}</strong>
          </p>
        ) : null}
        <Button type="button" variant="outline" className="mt-5 w-full" onClick={signOut}>Sign out</Button>
      </div>
    </div>
  );
}
