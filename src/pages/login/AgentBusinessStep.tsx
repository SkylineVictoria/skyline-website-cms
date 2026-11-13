import { useState, type FormEvent, type ReactNode } from "react";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";
import { abnProblem, formatAbn } from "@/lib/enrolForm";
import { checkAbnFree, lookupAbn, type AbnDetails } from "@/lib/selfEnrol";

/** The business an agent chose: from ABN Lookup, or typed by hand when the lookup is unavailable. */
export interface ChosenBusiness { abn: string; businessName: string; details: AbnDetails | null }

/** An ABN that ABN Lookup reports as active (not cancelled). */
function abnIsActive(details: AbnDetails): boolean {
  return /^\s*active/i.test(details.abnStatus);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <dt className="text-foreground-500">{label}</dt>
      <dd className="text-right font-semibold text-foreground-900">{children}</dd>
    </div>
  );
}

/** What ABN Lookup returned, laid out for the agent to confirm. */
function AbnCard({ details }: { details: AbnDetails }) {
  const active = abnIsActive(details);
  const gst = /registered from|^\s*registered/i.test(details.gstStatus) ? "Yes" : /not/i.test(details.gstStatus) || !details.gstStatus ? "No" : details.gstStatus;
  return (
    <div className="rounded-lg border border-background-300 bg-background-50 p-4">
      <p className={`flex items-center gap-1.5 text-sm font-semibold ${active ? "text-emerald-700" : "text-amber-800"}`}>
        <i className={active ? "ri-check-line" : "ri-error-warning-line"} aria-hidden="true" /> {active ? "Found on ABN Lookup" : "Found, but this ABN is not active"}
      </p>
      <dl className="mt-2 text-sm">
        <Row label="Legal entity">{details.legalName || "—"}</Row>
        <Row label="Trading name">{details.businessNames.length ? details.businessNames.join(", ") : "—"}</Row>
        <Row label="Entity type">{details.entityType || "—"}</Row>
        <Row label="ABN status">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${active ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}>{details.abnStatus || "Unknown"}</span>
        </Row>
        <Row label="GST registered">{gst}</Row>
        <Row label="Location">{[details.state, details.postcode].filter(Boolean).join(" ") || "—"}</Row>
      </dl>
    </div>
  );
}

/**
 * "Let's find your business": the agent enters the ABN, sees what the Australian Business Register holds, and confirms it
 * with "Use these details". When the register cannot be reached they may enter the name by hand; SLIT checks the ABN
 * when it reviews the application. A cancelled ABN cannot be used.
 */
export default function AgentBusinessStep({ initial, onChosen }: { initial: ChosenBusiness | null; onChosen: (business: ChosenBusiness) => void }) {
  const [abn, setAbn] = useState(initial ? formatAbn(initial.abn) : "");
  const [found, setFound] = useState<AbnDetails | null>(initial?.details ?? null);
  const [tradingName, setTradingName] = useState(initial?.businessName ?? "");
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState("");
  const [manual, setManual] = useState(Boolean(initial && !initial.details));
  const [manualName, setManualName] = useState(initial && !initial.details ? initial.businessName : "");
  const [checking, setChecking] = useState(false);
  // The ABN is already a business here: nothing else on this step applies, so it is shown on its own.
  const taken = /already exists in our system/i.test(error);

  const search = async (event?: FormEvent) => {
    event?.preventDefault();
    const problem = abnProblem(abn);
    if (problem) { setError(problem); return; }
    setLooking(true); setError(""); setFound(null);
    try {
      const details = await lookupAbn(abn);
      setFound(details);
      setTradingName(details.businessNames[0] || details.legalName);
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      setError(!message || /edge function|failed to fetch|network/i.test(message)
        ? "ABN Lookup is unavailable right now. Try again shortly, or enter your details manually."
        : message);
    } finally { setLooking(false); }
  };

  const useDetails = () => {
    if (!found) return;
    onChosen({ abn: abn.replace(/\s/g, ""), businessName: (tradingName || found.legalName).trim(), details: found });
  };

  const submitManual = async (event: FormEvent) => {
    event.preventDefault();
    const problem = abnProblem(abn);
    if (problem) { setError(problem); return; }
    if (manualName.trim().length < 2) { setError("Enter the agency or company name."); return; }
    setChecking(true); setError("");
    try { await checkAbnFree(abn); }
    catch (e) {
      const message = e instanceof Error ? e.message : "";
      // Only a definite "already exists" stops a hand-entered business; SLIT still checks the ABN in its review.
      if (/already exists in our system/i.test(message)) { setError(message); setChecking(false); return; }
    }
    setChecking(false);
    onChosen({ abn: abn.replace(/\s/g, ""), businessName: manualName.trim(), details: null });
  };

  return (
    <div>
      <p className="text-sm text-foreground-600">Enter your ABN and we'll fill in the rest from the Australian Business Register.</p>
      <form onSubmit={(e) => void (manual ? submitManual(e) : search(e))} noValidate className="mt-4 space-y-4">
        {taken ? (
          <div className="flex items-start gap-2 rounded-md border border-primary-200 bg-primary-50 px-3 py-2.5 text-label text-primary-900" role="alert">
            <i className="ri-error-warning-line mt-0.5 text-base" aria-hidden="true" /><span>{error}</span>
          </div>
        ) : null}
        <Field label="ABN" required>
          <div className="flex gap-2">
            <TextInput inputMode="numeric" value={abn} autoComplete="off" placeholder="12 345 678 901" aria-invalid={Boolean(error)}
              onChange={(e) => { setAbn(formatAbn(e.target.value)); setFound(null); setError(""); }} />
            {manual ? null : <Button type="submit" disabled={looking || !abn.trim()}>{looking ? "Searching…" : "Search"}</Button>}
          </div>
        </Field>

        {manual ? (
          <>
            <Field label="Agency / company name" required hint="As registered against this ABN. SLIT checks it when reviewing your application.">
              <TextInput value={manualName} onChange={(e) => { setManualName(e.target.value); setError(""); }} autoComplete="organization" />
            </Field>
            {error && !taken ? <p className="text-xs text-primary-700" role="alert">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={checking}>{checking ? "Checking…" : "Continue"}</Button>
            <button type="button" onClick={() => { setManual(false); setError(""); }} className="w-full cursor-pointer text-center text-sm font-medium text-primary-700 hover:text-primary-800">
              Search ABN Lookup instead
            </button>
          </>
        ) : (
          <>
            {error && !taken ? <p className="text-xs text-primary-700" role="alert">{error}</p> : null}
            {found ? (
              <>
                <AbnCard details={found} />
                {abnIsActive(found) ? (
                  <>
                    {found.businessNames.length > 1 ? (
                      <Field label="Trading name to use">
                        <select value={tradingName} onChange={(e) => setTradingName(e.target.value)}
                          className="w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-900">
                          {[...found.businessNames, found.legalName].filter((v, i, all) => v && all.indexOf(v) === i).map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                      </Field>
                    ) : null}
                    <Button type="button" className="w-full" onClick={useDetails}>Use these details</Button>
                  </>
                ) : (
                  <p className="text-xs text-amber-800" role="alert">A cancelled ABN cannot be used to register. Check the number, or contact SLIT Administration.</p>
                )}
              </>
            ) : null}
            <button type="button" onClick={() => { setManual(true); setError(""); setFound(null); }} className="w-full cursor-pointer text-center text-sm font-medium text-primary-700 hover:text-primary-800">
              Not your business? Enter details manually
            </button>
          </>
        )}
      </form>
    </div>
  );
}
