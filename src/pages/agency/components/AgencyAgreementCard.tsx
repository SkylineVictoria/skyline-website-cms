import { useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { formatAuDate, openOnboardingFile, ONBOARDING_FILE_LABEL, type OnboardingFileKind } from "@/pages/admin/lib/agentOnboarding";

interface PortalAgreement {
  agreementStatus: "none" | "sent" | "signed"; commencementDate: string | null; expiryDate: string | null;
  documents: Array<{ id: string; status: "sent" | "signed"; createdAt: string; signedAt: string | null; commencementDate: string; expiryDate: string; files: Record<OnboardingFileKind, boolean> }>;
}

/**
 * Agency portal: the agency's agent agreement (sent through the onboarding documents), its two-year term and the signed copies. Only
 * active members of the agency can read it (public.portal_agency_onboarding). Nothing is shown until something was sent.
 */
export default function AgencyAgreementCard({ agencyId, className = "" }: { agencyId: string; className?: string }) {
  const [data, setData] = useState<PortalAgreement | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  useEffect(() => {
    let live = true;
    void supabase.rpc("portal_agency_onboarding", { p_agency: agencyId }).then(({ data: row, error: problem }) => { if (live && !problem && row) setData(row as PortalAgreement); });
    return () => { live = false; };
  }, [agencyId]);
  if (!data || (data.agreementStatus === "none" && !data.documents.length)) return null;
  const open = async (id: string, kind: OnboardingFileKind) => {
    setBusy(`${id}:${kind}`); setError("");
    try { await openOnboardingFile(id, kind); } catch (e) { setError(e instanceof Error ? e.message : "The document could not be opened."); } finally { setBusy(""); }
  };
  const signed = data.documents.filter((d) => d.status === "signed");
  return <section className={`rounded-xl border border-background-300 bg-background-50 p-5 ${className}`} data-testid="agency-agreement">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold">Agent agreement</h2>
      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${data.agreementStatus === "signed" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
        {data.agreementStatus === "signed" ? "Signed" : "Waiting for your signature"}</span>
    </div>
    {data.agreementStatus === "signed" && data.commencementDate
      ? <p className="mt-1 text-sm text-foreground-700">In force from {formatAuDate(data.commencementDate)} to {formatAuDate(data.expiryDate)}.</p>
      : <p className="mt-1 text-sm text-foreground-700">Open the onboarding documents under "Documents to sign" above, complete the application form and sign the agreement.</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    {signed.length > 0 && <ul className="mt-2 divide-y divide-background-200 text-sm">{signed.map((d) => <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span>Signed {d.signedAt ? new Date(d.signedAt).toLocaleDateString() : ""} · {formatAuDate(d.commencementDate)} to {formatAuDate(d.expiryDate)}</span>
      <span className="flex flex-wrap gap-1.5">{(["form", "agreement", "certificate"] as OnboardingFileKind[]).filter((k) => d.files[k]).map((k) =>
        <button key={k} type="button" disabled={busy === `${d.id}:${k}`} onClick={() => void open(d.id, k)} className="rounded-md border border-background-300 bg-white px-3 py-1 text-xs font-medium hover:bg-background-100">
          <i className="ri-file-pdf-2-line mr-1" aria-hidden="true" />{ONBOARDING_FILE_LABEL[k]}</button>)}</span>
    </li>)}</ul>}
  </section>;
}
