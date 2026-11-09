import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { Button } from "@/pages/admin/components/ui";
import { claimStaffAccount, getMyStaff, staffDocumentUrl, type MyStaff, type StaffDocument } from "@/lib/staffApi";
import { STAFF_STATUS_LABEL } from "@/lib/staffStatus";

/**
 * /staff: "My HR" for a signed-in staff member (HR-02f): profile, role and joining date, current documents with their expiry,
 * and the signed offer. Files open through short-lived signed URLs (the bucket is private; storage lets an ACTIVE person read
 * only their own folder). A person who set their password but was not yet marked active is claimed here (idempotent).
 */

const ROLE_LABEL: Record<string, string> = { admin: "Admin", trainer: "Trainer" };
const DAY = 86_400_000;

function expiryState(date: string | null): { label: string; tone: "ok" | "soon" | "expired" | "none" } {
  if (!date) return { label: "No expiry", tone: "none" };
  const days = Math.floor((new Date(`${date}T00:00:00`).getTime() - Date.now()) / DAY);
  const when = new Date(`${date}T00:00:00`).toLocaleDateString();
  if (days < 0) return { label: `Expired ${when}`, tone: "expired" };
  if (days <= 60) return { label: `Expires ${when}`, tone: "soon" };
  return { label: `Expires ${when}`, tone: "ok" };
}
const TONE = { ok: "bg-secondary-50 text-secondary-900", soon: "bg-amber-50 text-amber-900", expired: "bg-primary-50 text-primary-900", none: "bg-background-200 text-foreground-700" };

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="mt-6 rounded-card border border-background-200 bg-background-50 p-5" data-testid={testId}>
      <h2 className="font-heading text-lg font-bold text-foreground-950">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}
function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 py-1.5 sm:grid-cols-[180px_1fr]">
      <dt className="text-sm text-foreground-600">{label}</dt>
      <dd className="text-sm text-foreground-900">{value || "—"}</dd>
    </div>
  );
}

export default function StaffHomePage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MyStaff | null | undefined>(undefined);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) { setSignedOut(true); return; }
      try {
        let mine = await getMyStaff();
        if (mine?.status === "offer_signed") mine = await claimStaffAccount().catch(() => mine);
        setMe(mine);
      } catch (e) { setError(e instanceof Error ? e.message : "We could not load your staff record."); }
    });
  }, []);

  // Opens the window first (so the browser does not block it), then sends it to the short-lived link.
  const open = async (path: string) => {
    const win = window.open("", "_blank");
    try {
      const url = await staffDocumentUrl(path, 300);
      if (win) { win.opener = null; win.location.href = url; } else window.location.href = url;
    } catch (e) { win?.close(); setError(e instanceof Error ? e.message : "The file could not be opened."); }
  };

  if (signedOut) return <Navigate to="/login?next=%2Fstaff" replace />;
  const signOut = () => { void supabase.auth.signOut().then(() => navigate("/login", { replace: true })); };
  const p = me?.profile;
  const name = p ? [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ") : "";
  const address = p ? [p.address_street, p.address_line2, p.address_suburb, p.address_state, p.address_postcode, p.address_country].filter(Boolean).join(", ") : "";

  return (
    <div className="min-h-screen bg-background-100 px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-heading text-2xl font-bold text-foreground-950">My HR</h1>
          <Button type="button" variant="outline" onClick={signOut}>Sign out</Button>
        </div>
        {error ? <p role="alert" className="mt-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
        {me === undefined && !error ? <p className="mt-4 text-sm text-foreground-600" role="status">Loading…</p> : null}
        {me === null ? <p className="mt-4 text-sm text-foreground-700" data-testid="staff-home-none">There is no staff record for this login.</p> : null}
        {me && me.status !== "active" ? (
          <p className="mt-4 text-sm text-foreground-700" data-testid="staff-home-status">
            {name || me.profile.email}: <strong>{STAFF_STATUS_LABEL[me.status]}</strong>. My HR opens once your staff account is active.
          </p>
        ) : null}
        {me && me.status === "active" && p ? (
          <>
            <Section title="Your role" testId="my-hr-role">
              <dl>
                <Row label="Name" value={name} />
                <Row label="Role" value={me.role ? ROLE_LABEL[me.role] ?? me.role : ""} />
                <Row label="Joining date" value={me.joiningDate ? new Date(`${me.joiningDate}T00:00:00`).toLocaleDateString() : ""} />
                <Row label="Status" value={STAFF_STATUS_LABEL[me.status]} />
              </dl>
            </Section>
            {me.employment ? (
              <Section title="Your employment" testId="my-hr-employment">
                <dl>
                  <Row label="Job title" value={me.employment.jobTitle} />
                  <Row label="Department" value={me.employment.department} />
                  <Row label="Employment type" value={me.employment.employmentType === "full_time" ? "Full time" : me.employment.employmentType === "part_time" ? "Part time" : ""} />
                  <Row label="Work location" value={me.employment.workLocation} />
                  <Row label="Manager" value={me.employment.managerName ?? ""} />
                </dl>
              </Section>
            ) : null}
            <Section title="Your details" testId="my-hr-profile">
              <dl>
                <Row label="Email" value={p.email} />
                <Row label="Mobile" value={p.phone_e164} />
                <Row label="Date of birth" value={p.date_of_birth ? new Date(`${p.date_of_birth}T00:00:00`).toLocaleDateString() : ""} />
                <Row label="Address" value={address} />
                <Row label="Emergency contact" value={[p.emergency_name, p.emergency_relationship, p.emergency_phone_e164].filter(Boolean).join(" · ")} />
              </dl>
              <p className="mt-2 text-xs text-foreground-500">To change your details, contact HR.</p>
            </Section>
            <Section title="Your documents" testId="my-hr-documents">
              {me.documents.length ? (
                <ul className="divide-y divide-background-200">
                  {me.documents.map((d: StaffDocument) => {
                    const expiry = expiryState(d.expiryDate);
                    return (
                      <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5" data-testid="my-hr-document">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground-900">{d.category}</p>
                          <p className="truncate text-xs text-foreground-600">{d.filename}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[expiry.tone]}`} data-testid="my-hr-expiry">{expiry.label}</span>
                          <button type="button" onClick={() => void open(d.storagePath)} className="cursor-pointer text-sm font-semibold text-primary-700 hover:text-primary-800">View</button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="text-sm text-foreground-600">No documents.</p>}
            </Section>
            <Section title="Signed offer" testId="my-hr-offer">
              {me.signedOffer ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-foreground-800">Signed on {new Date(me.signedOffer.signedAt).toLocaleDateString()}</p>
                  <Button type="button" onClick={() => void open(me.signedOffer!.signedPath)}>Open the signed offer</Button>
                </div>
              ) : <p className="text-sm text-foreground-600">No signed offer on file.</p>}
            </Section>
          </>
        ) : null}
      </div>
    </div>
  );
}
