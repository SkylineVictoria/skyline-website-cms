import { useCallback, useEffect, useState } from "react";
import { normalizeUsi, validateUsi } from "../../../../supabase/functions/_shared/validation/identifiers";
import { cleanUsiDocument, USI_DOCUMENTS, usiDocument, usiDocumentProblems, type UsiDocumentField } from "../../../../supabase/functions/_shared/validation/usi-documents";
import { UsiCallError, usiConsent, usiCountries, usiCreate, usiLocate, usiState, usiVerify, type Match, type UsiState } from "@/lib/usi";
import SearchableSelect from "@/components/ui/SearchableSelect";

type Tone = "ok" | "warn" | "bad" | "info";
const TONE: Record<Tone, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warn: "border-amber-200 bg-amber-50 text-amber-950",
  bad: "border-red-200 bg-red-50 text-red-900",
  info: "border-background-200 bg-background-100 text-foreground-800",
};
const BUTTON = "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-background-300 bg-background-50 px-3 text-xs font-medium text-foreground-800 transition-colors hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY = "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-primary-500 px-3 text-xs font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50";
const INPUT = "h-9 w-full rounded-lg border border-background-300 bg-background-50 px-3 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40";
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Melbourne" }) : "";

/** "Match" / "NoMatch" per field as the Registry returns it. */
function MatchRow({ label, value }: { label: string; value: Match }) {
  if (!value) return null;
  const ok = value === "Match";
  return (
    <li className="flex items-center gap-1.5" data-testid={`usi-match-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <i className={`${ok ? "ri-checkbox-circle-fill text-emerald-600" : "ri-close-circle-fill text-red-600"} text-base leading-none`} aria-hidden="true" />
      <span>{label}: {ok ? "matches" : "does not match the USI record"}</span>
    </li>
  );
}

/**
 * The USI checks under the USI field (USI-SERVICE, 2026-11-23): Verify against the USI Registry, "I don't know my USI" (Locate, with the
 * student's permission) and "I don't have a USI" (Create by SLIT staff with the student's permission and an identity document).
 * The name and date of birth checked are the application's saved answers (the server reads them), so `beforeCall` saves the form first.
 * Document numbers live only in this component's state until the request is sent, and are cleared right after.
 */
export default function UsiPanel({ applicationId, usi, onUsi, beforeCall, readOnly = false, documentPrefill }: {
  applicationId: string;
  /** The USI field's current value. */
  usi: string;
  /** Puts a found or created USI into the USI field. */
  onUsi: (usi: string) => void;
  /** Saves the form so the server checks the latest answers. */
  beforeCall?: () => Promise<unknown>;
  readOnly?: boolean;
  /** Values to start a document with (e.g. the passport number already on the application), per document type. */
  documentPrefill?: () => Partial<Record<string, Record<string, string>>>;
}) {
  const [state, setState] = useState<UsiState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<"" | "verify" | "locate" | "create" | "consent">("");
  const [note, setNote] = useState<{ tone: Tone; text: string; items?: string[] } | null>(null);
  const [path, setPath] = useState<"" | "locate" | "create">("");
  const [docType, setDocType] = useState("visa");
  const [docValues, setDocValues] = useState<Record<string, string>>({});
  const [docErrors, setDocErrors] = useState<Record<string, string>>({});
  const [town, setTown] = useState("");
  const [countries, setCountries] = useState<{ code: string; name: string }[] | null>(null);
  const [countryCode, setCountryCode] = useState("");
  const [needCountry, setNeedCountry] = useState(false);

  const reload = useCallback(() => usiState(applicationId).then((s) => { setState(s); setLoadError(""); }, (e: Error) => setLoadError(e.message)), [applicationId]);
  useEffect(() => { void reload(); }, [reload]);

  const current = normalizeUsi(usi);
  const formatProblem = current ? validateUsi(current) : "";
  const forThisUsi = !!state?.usi && state.usi === current;
  const permitted = !!state?.consentAt;
  const isStaff = state?.role === "staff";
  const canAct = !readOnly && !!state && state.role !== "viewer";

  const run = async <T,>(kind: typeof busy, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(kind); setNote(null);
    try { await beforeCall?.(); return await fn(); }
    catch (e) {
      const err = e as UsiCallError;
      setNote({ tone: err.code === "rate_limited" ? "warn" : "bad", text: err.message || "That could not be done.", items: Array.isArray(err.body?.missing) ? err.body.missing as string[] : undefined });
      if (err.body?.problems && typeof err.body.problems === "object") setDocErrors(err.body.problems as Record<string, string>);
      if (Array.isArray(err.body?.errors) && err.body.errors.length) setNote({ tone: "bad", text: "The USI Registry did not create the USI.", items: (err.body.errors as { code: string; message: string }[]).map((x) => `${x.message} (USI ${x.code})`) });
      if (Array.isArray(err.body?.missing) && (err.body.missing as string[]).includes("the country of birth")) { setNeedCountry(true); if (!countries) void usiCountries().then(setCountries, () => undefined); }
      return null;
    } finally { setBusy(""); void reload(); }
  };

  const verify = () => void run("verify", async () => {
    const r = await usiVerify(applicationId, current);
    const text = r.outcome === "valid" ? "Verified: the USI matches the student's name and date of birth."
      : r.outcome === "mismatch" ? "The USI exists, but some details do not match the USI record (see below). Check the name and date of birth on the application, or the USI."
      : r.outcome === "deactivated" ? "This USI has been deactivated by the USI Registry. The student must use their current USI, or contact the Registry."
      : "No USI record was found for this number. Check the 10 characters.";
    setNote({ tone: r.outcome === "valid" ? "ok" : r.outcome === "mismatch" ? "warn" : "bad", text });
  });

  const setPermission = (given: boolean, requestCreate = false) => void (async () => {
    setBusy("consent"); setNote(null);
    try { setState(await usiConsent(applicationId, given, requestCreate)); }
    catch (e) { setNote({ tone: "bad", text: (e as Error).message }); }
    finally { setBusy(""); }
  })();

  const locate = () => void run("locate", async () => {
    const r = await usiLocate(applicationId);
    if (r.outcome === "exact" && r.usi) {
      onUsi(r.usi);
      setPath("");
      setNote({ tone: r.verified?.outcome === "valid" ? "ok" : "warn", text: `USI found: ${r.usi}. It has been put in the USI field${r.verified?.outcome === "valid" ? " and verified" : ""}.` });
    } else {
      const text = r.outcome === "multiple" ? "More than one USI record matches these details. Add the student's middle name, town or city of birth, or check the email address, then try again."
        : r.outcome === "contact_mismatch" ? "A USI record matches the name and date of birth, but not the email or mobile on the application."
        : r.outcome === "partial" ? "No exact match was found. Check the spelling of the name and the date of birth."
        : "No USI was found for these details. If the student has never had a USI, choose \"I don't have a USI\".";
      setNote({ tone: "warn", text, items: [r.message ?? "", ...r.errors.map((x) => x.message)].filter(Boolean) });
    }
  });

  const openCreate = () => {
    setPath("create");
    const pre = documentPrefill?.() ?? {};
    setDocValues(pre[docType] ?? {});
  };
  const create = () => {
    const problems = usiDocumentProblems(docType, docValues);
    setDocErrors(problems);
    if (Object.keys(problems).length) return;
    const doc = { type: docType, values: cleanUsiDocument(docType, docValues) };
    void run("create", async () => {
      const r = await usiCreate(applicationId, doc, { townCityOfBirth: town.trim() || undefined, countryOfBirthCode: countryCode || undefined });
      setDocValues({}); setDocErrors({});   // the document number is never kept
      if (r.usi) {
        onUsi(r.usi);
        setPath("");
        setNote({ tone: "ok", text: `USI created: ${r.usi}${r.verified?.outcome === "valid" ? ", verified" : ""}. It has been put in the USI field.` });
      }
    }).finally(() => setDocValues({}));
  };

  const badge = (): { tone: Tone; text: string } => {
    if (!current) return { tone: "info", text: "No USI entered" };
    if (formatProblem) return { tone: "bad", text: "Not a valid USI" };
    if (!forThisUsi || !state?.status) return { tone: "info", text: "Not verified yet" };
    if (state.status === "stale") return state.reverifyStopped ? { tone: "warn", text: "Details changed: verify again" } : { tone: "warn", text: "Details changed: re-checking" };
    if (state.detailsChanged) return { tone: "warn", text: "Details changed since the check" };
    if (state.status === "valid") return { tone: "ok", text: "Verified" };
    if (state.status === "mismatch") return { tone: "warn", text: [state.matches.firstName === "NoMatch" || state.matches.familyName === "NoMatch" || state.matches.singleName === "NoMatch" ? "Name mismatch" : "", state.matches.dateOfBirth === "NoMatch" ? "Date of birth mismatch" : ""].filter(Boolean).join(" · ") || "Details do not match" };
    if (state.status === "deactivated") return { tone: "bad", text: "Deactivated" };
    return { tone: "bad", text: "Not found" };
  };
  const b = badge();
  const def = usiDocument(docType);
  const fieldInput = (f: UsiDocumentField) => {
    const id = `usi-doc-${f.key}`;
    const value = docValues[f.key] ?? "";
    const set = (v: string) => setDocValues((prev) => ({ ...prev, [f.key]: v }));
    const required = typeof f.required === "function" ? f.required(docValues) : f.required;
    return (
      <label key={f.key} htmlFor={id} className="block text-xs font-medium text-foreground-700">
        {f.label}{required ? <span className="text-primary-600"> *</span> : null}
        {f.kind === "select"
          ? <SearchableSelect id={id} className={`${INPUT} mt-1`} value={value} onChange={(e) => set(e.target.value)}><option value="">Choose…</option>{f.options?.map((o) => <option key={o} value={o}>{o}</option>)}</SearchableSelect>
          : <input id={id} type={f.kind === "date" ? "date" : "text"} autoComplete="off" className={`${INPUT} mt-1`} value={value} onChange={(e) => set(f.upper ? e.target.value.toUpperCase() : e.target.value)} />}
        {f.help ? <span className="mt-0.5 block font-normal text-foreground-500">{f.help}</span> : null}
        {docErrors[f.key] ? <span role="alert" className="mt-0.5 block font-normal text-red-700">{docErrors[f.key]}</span> : null}
      </label>
    );
  };

  if (loadError) return <p className="text-xs text-foreground-500 md:col-span-2" data-testid="usi-panel-error">USI check unavailable: {loadError}</p>;
  return (
    <section className="space-y-3 rounded-lg border border-background-200 p-3 text-sm md:col-span-2" aria-label="USI check" data-testid="usi-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE[b.tone]}`} data-testid="usi-status">{b.text}</span>
        {forThisUsi && state?.environment === "test" ? <span className="rounded-full border border-amber-300 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800" title="Checked against the USI test environment (3PT), not the live Registry">Test environment</span> : null}
        <span className="ml-auto" />
        {canAct && state?.canVerify ? (
          <button type="button" className={PRIMARY} disabled={!!busy || !current || !!formatProblem} onClick={verify} data-testid="usi-verify">
            <i className={busy === "verify" ? "ri-loader-4-line animate-spin" : "ri-shield-check-line"} aria-hidden="true" />{busy === "verify" ? "Checking…" : "Verify"}
          </button>
        ) : null}
      </div>

      {forThisUsi && state?.verifiedAt && state.status !== "stale" ? (
        <div className="text-xs text-foreground-700">
          <ul className="space-y-0.5">
            <MatchRow label="First name" value={state.matches.firstName} />
            <MatchRow label="Family name" value={state.matches.familyName} />
            <MatchRow label="Single name" value={state.matches.singleName} />
            <MatchRow label="Date of birth" value={state.matches.dateOfBirth} />
          </ul>
          <p className="mt-1 text-foreground-500">Checked {when(state.verifiedAt)}{state.verifiedByName ? ` by ${state.verifiedByName}` : ""}{state.verifiedByRole === "automatic" ? " (automatic re-check)" : ""}.</p>
        </div>
      ) : null}
      {forThisUsi && state?.status === "stale" ? (
        <p className="text-xs text-amber-900">{state.reverifyStopped
          ? `The name or date of birth changed and the automatic re-check could not finish${state.reverifyLastError ? ` (${state.reverifyLastError})` : ""}. Press Verify.`
          : "The name or date of birth changed after the USI was checked. It is being checked again automatically."}</p>
      ) : null}

      {note ? (
        <div role="status" className={`rounded-md border p-2.5 text-xs ${TONE[note.tone]}`} data-testid="usi-note">
          {note.text}
          {note.items?.length ? <ul className="mt-1 list-disc pl-4">{note.items.map((i) => <li key={i}>{i}</li>)}</ul> : null}
        </div>
      ) : null}

      {canAct && state?.canConsent ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <button type="button" className="cursor-pointer font-medium text-primary-700 hover:underline" onClick={() => setPath(path === "locate" ? "" : "locate")} aria-expanded={path === "locate"} data-testid="usi-dont-know">I don't know my USI</button>
          <button type="button" className="cursor-pointer font-medium text-primary-700 hover:underline" onClick={() => path === "create" ? setPath("") : openCreate()} aria-expanded={path === "create"} data-testid="usi-dont-have">I don't have a USI</button>
        </div>
      ) : null}

      {canAct && path ? (
        <div className="space-y-3 rounded-md border border-background-200 bg-background-100/60 p-3">
          <label className="flex items-start gap-2 text-xs text-foreground-800">
            <input type="checkbox" className="mt-0.5" checked={permitted} disabled={busy === "consent"} onChange={(e) => setPermission(e.target.checked)} data-testid="usi-consent" />
            <span>
              {state?.role === "student" ? "I permit Skyline Institute of Technology to find or create my USI on my behalf with the USI Registry, using the details in this application."
                : "The student permits Skyline Institute of Technology to find or create their USI on their behalf with the USI Registry, using the details in this application."}
              {permitted && state?.consentByName ? <span className="block text-foreground-500">Recorded {when(state.consentAt)} by {state.consentByName}.</span> : null}
            </span>
          </label>

          {path === "locate" ? (
            <div className="space-y-1">
              <p className="text-xs text-foreground-600">Skyline searches the USI Registry with the student's name, date of birth, gender, town or city of birth and email from this application.</p>
              <button type="button" className={PRIMARY} disabled={!permitted || !!busy || !state?.canLocate} onClick={locate} data-testid="usi-locate">
                <i className={busy === "locate" ? "ri-loader-4-line animate-spin" : "ri-search-line"} aria-hidden="true" />{busy === "locate" ? "Searching…" : "Find the USI"}
              </button>
            </div>
          ) : null}

          {path === "create" && !isStaff ? (
            <div className="space-y-1 text-xs text-foreground-700">
              <p>SLIT staff create the USI with the student's identity document when they review the application. Add the student's town or city of birth to the application.</p>
              {state?.createRequestedAt ? <p className="font-medium text-emerald-800">Requested {when(state.createRequestedAt)}.</p>
                : <button type="button" className={BUTTON} disabled={!permitted || !!busy} onClick={() => setPermission(true, true)} data-testid="usi-request-create">Ask Skyline to create the USI</button>}
            </div>
          ) : null}

          {path === "create" && isStaff ? (
            <div className="space-y-3">
              {state?.createRequestedAt ? <p className="text-xs text-foreground-600">The student / agency asked for a USI on {when(state.createRequestedAt)}.</p> : null}
              <p className="text-xs text-foreground-600">An identity document is always required. Names and date of birth must match the document exactly. The document number is sent to the USI Registry once and never stored.</p>
              <label className="block text-xs font-medium text-foreground-700" htmlFor="usi-doc-type">Identity document
                <SearchableSelect id="usi-doc-type" className={`${INPUT} mt-1`} value={docType} onChange={(e) => { setDocType(e.target.value); setDocErrors({}); setDocValues((documentPrefill?.() ?? {})[e.target.value] ?? {}); }} data-testid="usi-doc-type">
                  {USI_DOCUMENTS.map((d) => <option key={d.type} value={d.type}>{d.label}</option>)}
                </SearchableSelect>
                {def?.help ? <span className="mt-0.5 block font-normal text-foreground-500">{def.help}</span> : null}
              </label>
              <div className="grid gap-3 sm:grid-cols-2">{def?.fields.map(fieldInput)}</div>
              <label className="block text-xs font-medium text-foreground-700" htmlFor="usi-town">Town / city of birth (only if not on the application)
                <input id="usi-town" className={`${INPUT} mt-1`} value={town} maxLength={50} onChange={(e) => setTown(e.target.value)} autoComplete="off" />
              </label>
              {needCountry ? (
                <label className="block text-xs font-medium text-foreground-700" htmlFor="usi-country">Country of birth (USI list)
                  <SearchableSelect id="usi-country" className={`${INPUT} mt-1`} value={countryCode} onChange={(e) => setCountryCode(e.target.value)}>
                    <option value="">{countries ? "Choose…" : "Loading…"}</option>{countries?.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                  </SearchableSelect>
                </label>
              ) : null}
              <button type="button" className={PRIMARY} disabled={!permitted || !!busy || !state?.canCreate} onClick={create} data-testid="usi-create">
                <i className={busy === "create" ? "ri-loader-4-line animate-spin" : "ri-user-add-line"} aria-hidden="true" />{busy === "create" ? "Creating…" : "Create the USI"}
              </button>
              {!permitted ? <p className="text-xs text-foreground-500">Tick the student's permission above first.</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
