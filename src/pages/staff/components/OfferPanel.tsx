import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";
import { LinkInvalidError, NoOfferError, type OfferApi, type OfferView } from "@/lib/staffOnboardingApi";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";

/**
 * The offer letter: read the PDF, type your full name, tick the agreement (wording from the server, stored with the signature) and
 * sign. Afterwards it shows the signed copy. Used by /staff/offer (a private link, `api` carries the token) and by the signed-in
 * person's page before they are Active (`api` uses their session). The staff-onboarding function re-checks every call.
 */
export default function OfferPanel({ api, onInvalid, onSigned, heading = true }: { api: OfferApi; onInvalid: () => void; onSigned?: (view: OfferView) => void; heading?: boolean }) {
  const [view, setView] = useState<OfferView | null>(null);
  const [consentText, setConsentText] = useState("");
  const [error, setError] = useState("");
  const [pdfUrl, setPdfUrl] = useState("");
  const [name, setName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<{ name?: string; consent?: string }>({});

  const handle = useCallback((e: unknown) => {
    if (e instanceof LinkInvalidError || e instanceof NoOfferError) { onInvalid(); return; }
    setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
  }, [onInvalid]);

  const loadPdf = useCallback((v: OfferView) => {
    // A short-lived (5 minute) link to the private file: the offer, or the signed copy once signed.
    void api.viewUrl(v.offer.signedAt ? "signed" : "offer").then(setPdfUrl, handle);
  }, [api, handle]);

  useEffect(() => {
    void api.open().then((r) => { setView(r.view); setConsentText(r.consent); loadPdf(r.view); }, handle);
  }, [api, handle, loadPdf]);

  const sign = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const problems: { name?: string; consent?: string } = {};
    if (!name.trim()) problems.name = "Type your full name to sign.";
    if (!agreed) problems.consent = "Tick the box to agree.";
    setFieldError(problems);
    if (problems.name || problems.consent) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.sign(name.trim());
      setView(r.view);
      loadPdf(r.view);
      onSigned?.(r.view);
    } catch (e) { handle(e); } finally { setBusy(false); }
  };

  if (!view) return error ? <p role="alert" className={ALERT}>{error}</p> : <p className="text-sm text-foreground-600" role="status">Opening your offer…</p>;

  const signed = Boolean(view.offer.signedAt);
  return (
    <>
      {heading ? <>
        <h1 className="font-heading text-2xl font-bold text-foreground-950">{signed ? "Your signed offer" : "Your offer letter"}</h1>
        <p className="mt-1 text-sm text-foreground-600">
          {signed
            ? `Thank you, ${view.offer.signerName ?? view.name}. You signed on ${new Date(view.offer.signedAt!).toLocaleString()}. We will email you a copy of the signed letter.`
            : `Hello ${view.name}. Please read the offer letter below. This private link works until ${new Date(view.expiresAt).toLocaleDateString()}.`}
        </p>
      </> : (
        <p className="text-sm text-foreground-700" data-testid="offer-status-line">
          {signed ? `You signed this offer on ${new Date(view.offer.signedAt!).toLocaleString()}. A copy was emailed to you.` : "Please read the letter, then sign it below."}
        </p>
      )}
      {error ? <p role="alert" className={`mt-4 ${ALERT}`}>{error}</p> : null}

      <section className={`${heading ? "mt-6" : "mt-3"} rounded-card border border-background-200 bg-background-50 p-4`} data-testid="offer-document">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 break-words text-sm font-semibold text-foreground-900">{signed ? "Signed offer letter" : view.offer.filename}</p>
          {/* Mobile Safari often shows nothing for a PDF inside a frame: this always opens it in a new tab. */}
          {pdfUrl ? (
            <a href={pdfUrl} target="_blank" rel="noopener noreferrer" data-testid="offer-open-pdf"
              className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-4 py-2 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600">
              <i className="ri-file-pdf-2-line" aria-hidden="true" />
              {signed ? "Open the signed offer PDF" : "Open the offer PDF"}
            </a>
          ) : null}
        </div>
        {pdfUrl ? (
          <iframe title={signed ? "Signed offer letter" : "Offer letter"} src={pdfUrl} referrerPolicy="no-referrer" className="mt-3 h-[70vh] w-full rounded-md border border-background-200 bg-background-100" />
        ) : (
          <p className="mt-3 text-sm text-foreground-600" role="status">Loading the letter…</p>
        )}
        <button type="button" onClick={() => loadPdf(view)} className="mt-2 cursor-pointer text-xs text-foreground-600 hover:text-foreground-900">Letter not showing? Load it again</button>
      </section>

      {signed || view.readOnly ? null : (
        <form onSubmit={(e) => void sign(e)} className="mt-6 rounded-card border border-background-200 bg-background-50 p-6" data-testid="offer-sign-form" noValidate>
          <h2 className="font-heading text-lg font-bold text-foreground-950">Sign the offer</h2>
          <div className="mt-4 max-w-md">
            <Field label="Your full name" required>
              <TextInput value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={200} aria-invalid={Boolean(fieldError.name)} />
            </Field>
            {fieldError.name ? <p className="mt-1 text-xs text-primary-700" role="alert">{fieldError.name}</p> : null}
          </div>
          <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm text-foreground-800">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-background-400 text-primary-600 focus:ring-primary-200" />
            <span>{consentText}</span>
          </label>
          {fieldError.consent ? <p className="mt-1 text-xs text-primary-700" role="alert">{fieldError.consent}</p> : null}
          <Button type="submit" className="mt-6" disabled={busy}>{busy ? "Signing…" : "Sign the offer"}</Button>
        </form>
      )}
    </>
  );
}
