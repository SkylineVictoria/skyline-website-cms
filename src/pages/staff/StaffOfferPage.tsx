import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { offerApiForLink, takeLinkToken } from "@/lib/staffOnboardingApi";
import OfferPanel from "./components/OfferPanel";

/**
 * /staff/offer#t=<token>: an offer letter opened by a private link (HR-02e). The link is the credential and is re-checked by the
 * staff-onboarding function on every call. The reading and signing live in OfferPanel, shared with the signed-in person's page
 * (/staff), which is how an offer sent with a login is signed. The page sends no Referer.
 */

function useNoReferrer() {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.appendChild(meta);
    return () => { meta.remove(); };
  }, []);
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background-100 px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">{children}</div>
    </div>
  );
}

export default function StaffOfferPage() {
  useNoReferrer();
  const [token] = useState(() => takeLinkToken("offer"));
  const [invalid, setInvalid] = useState(!token);
  const api = useMemo(() => (token ? offerApiForLink(token) : null), [token]);
  const onInvalid = useCallback(() => setInvalid(true), []);

  if (invalid || !api) {
    return (
      <Shell>
        <section className="rounded-card border border-background-200 bg-background-50 p-6" data-testid="staff-link-invalid">
          <h1 className="font-heading text-xl font-bold text-foreground-950">This link cannot be used</h1>
          <p className="mt-2 text-sm text-foreground-700">The link has expired, was replaced by a newer one, or the offer was withdrawn. If you have a staff login, sign in to see your offer. Otherwise please contact us.</p>
        </section>
      </Shell>
    );
  }
  return <Shell><OfferPanel api={api} onInvalid={onInvalid} /></Shell>;
}
