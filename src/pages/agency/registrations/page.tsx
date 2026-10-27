import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDate } from "@/pages/agency/lib/portalData";
import CoeVoePanel from "@/pages/agency/components/CoeVoePanel";
import { PageHeading, PortalEmpty, PortalError, PortalLoading, PortalModal, StatusBadge } from "@/pages/agency/components/PortalUI";
import {
  addEvidence, correctCoeNumber, createRegistration, exportRegistrations, getRegistration, listExceptions, listWorkbench, reviewException, transitionRegistration,
  type ExceptionRow, type RegistrationDetail, type WorkbenchRow,
} from "@/pages/agency/lib/portalRegistrations";
import {
  availableActions, EXCEPTION_TEXT, exportCsv, normaliseCoeNumber, registrationChecklist, validateCorrection, verifyBlockers, type RegistrationAction,
} from "@/pages/agency/lib/registrationWorkbench";

const EVIDENCE_KINDS = [
  { value: "external_confirmation", label: "External confirmation" },
  { value: "coe_document", label: "CoE document" },
  { value: "correspondence", label: "Correspondence" },
  { value: "other", label: "Other" },
];
const STATE_LABEL: Record<string, string> = { draft: "Draft", lodged: "Lodged", verified: "Verified", cancelled: "Cancelled" };
const field = "w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-900";
const primary = "cursor-pointer whitespace-nowrap rounded-md bg-primary-600 px-4 py-2 text-sm font-semibold text-background-50 hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
const outline = "cursor-pointer whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-4 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-50";

export default function RegistrationWorkbenchPage() {
  const [rows, setRows] = useState<WorkbenchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<WorkbenchRow | null>(null);
  const [detail, setDetail] = useState<RegistrationDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState(EVIDENCE_KINDS[0].value);
  const [description, setDescription] = useState("");
  const [coe, setCoe] = useState("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState<RegistrationAction | null>(null);
  const [view, setView] = useState<"applications" | "exceptions">("applications");
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);
  const [deciding, setDeciding] = useState<{ row: ExceptionRow; decision: "accept" | "reopen" } | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [fixCoe, setFixCoe] = useState("");
  const [fixReason, setFixReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { const [list, ex] = await Promise.all([listWorkbench(), listExceptions()]); setRows(list); setExceptions(ex); } catch (e) { setError(e instanceof Error ? e.message : "We could not load the workbench."); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const warnings = useMemo(() => rows.filter((r) => r.warning).length, [rows]);

  const openRow = async (row: WorkbenchRow) => {
    setOpen(row); setDetail(null); setMessage(""); setCoe(""); setReason(""); setDescription(""); setConfirm(null);
    if (row.registration && row.registration.state !== "cancelled") {
      try { setDetail(await getRegistration(row.registration.id)); } catch (e) { setMessage(e instanceof Error ? e.message : "Could not load the registration."); }
    }
  };
  const refresh = async (row: WorkbenchRow) => {
    const [next, ex] = await Promise.all([listWorkbench(), listExceptions()]); setRows(next); setExceptions(ex);
    const updated = next.find((r) => r.applicationId === row.applicationId) ?? null;
    setOpen(updated); setDetail(null); setCoe(""); setReason(""); setDescription(""); setConfirm(null); setFixCoe(""); setFixReason("");
    if (updated?.registration) { try { setDetail(await getRegistration(updated.registration.id)); } catch { /* shown on next open */ } }
  };
  const run = async (row: WorkbenchRow, work: () => Promise<void>, done: string) => {
    setBusy(true); setMessage("");
    try { await work(); await refresh(row); setMessage(done); } catch (e) { setMessage(e instanceof Error ? e.message : "The change could not be saved."); } finally { setBusy(false); }
  };

  const doExport = async () => {
    setBusy(true); setError("");
    try {
      const data = await exportRegistrations([...selected]);
      const blob = new Blob([exportCsv(data)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "registration-tracking.csv"; a.click(); URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : "The export could not be created."); } finally { setBusy(false); }
  };

  const reg = open?.registration && open.registration.state !== "cancelled" ? open.registration : null;
  const checklist = open ? registrationChecklist({ applicationStatus: open.status, state: reg?.state, evidenceCount: detail?.evidence.length ?? reg?.evidenceCount ?? 0, coeNumber: reg?.coeNumber }) : [];
  const actions = availableActions(reg?.state);
  const blockers = open && reg ? verifyBlockers({ applicationStatus: open.status, state: reg.state, evidenceCount: detail?.evidence.length ?? reg.evidenceCount, coeNumber: reg.coeNumber, coeInput: coe }) : [];
  const coeCheck = coe ? normaliseCoeNumber(coe) : null;

  return (
    <div>
      <PageHeading
        eyebrow="Registrations"
        title="Manual registration workbench"
        description="Record registrations that were completed by hand in the external system. Nothing here contacts any government system."
        action={<button type="button" className={outline} disabled={busy || selected.size === 0} onClick={() => void doExport()}>Export tracking CSV ({selected.size})</button>}
      />
      <p className="mt-2 text-xs text-foreground-500">The export contains only reference, student name, intake, courses, statuses, CoE number and dates. Every export is recorded in the audit log.</p>
      {warnings > 0 ? (
        <div role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-primary-900">
          <i className="ri-error-warning-line mt-0.5 text-base" aria-hidden="true" />
          <span>{warnings} application{warnings === 1 ? "" : "s"} read{warnings === 1 ? "s" : ""} &ldquo;CoE / VoE issued&rdquo; or enrolled without a verified registration. This is a warning only; nothing is blocked.</span>
        </div>
      ) : null}
      <div role="tablist" aria-label="Workbench views" className="mt-6 flex gap-2">
        <button type="button" role="tab" aria-selected={view === "applications"} className={view === "applications" ? primary : outline} onClick={() => setView("applications")}>Applications ({rows.length})</button>
        <button type="button" role="tab" aria-selected={view === "exceptions"} className={view === "exceptions" ? primary : outline} onClick={() => setView("exceptions")}>Exceptions ({exceptions.filter((x) => !x.accepted).length} open)</button>
      </div>
      {view === "exceptions" && !loading && !error ? (
        <div className="mt-4">
          {exceptions.length === 0 ? <PortalEmpty icon="ri-checkbox-circle-line" title="No exceptions" message="Registrations and application statuses are consistent." /> : (
            <ul className="space-y-3">
              {exceptions.map((x) => (
                <li key={x.kind + x.applicationId} className="rounded-lg border border-background-200 bg-background-50 p-4 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-foreground-950">{EXCEPTION_TEXT[x.kind].label} · {x.reference}</p>
                      <p className="text-foreground-600">{x.studentName || "Student"} · application {x.status.replace(/_/g, " ")}{x.registration ? ` · registration ${STATE_LABEL[x.registration.state]}` : ""}</p>
                      <p className="mt-1 text-foreground-600">{EXCEPTION_TEXT[x.kind].explanation}</p>
                      {x.accepted ? <p className="mt-1 text-foreground-800">Accepted by {x.accepted.by} on {formatDate(x.accepted.at)}: {x.accepted.note}</p> : null}
                    </div>
                    <div className="flex gap-2">
                      <button type="button" className={outline} onClick={() => { const row = rows.find((r) => r.applicationId === x.applicationId); if (row) void openRow(row); }}>Open</button>
                      <button type="button" className={outline} onClick={() => { setDecisionNote(""); setDeciding({ row: x, decision: x.accepted ? "reopen" : "accept" }); }}>{x.accepted ? "Reopen" : "Accept…"}</button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <div className={view === "applications" ? "mt-6" : "hidden"}>
        {loading ? <PortalLoading label="Loading registrations…" /> : error ? <PortalError message={error} onRetry={() => void load()} /> : rows.length === 0 ? (
          <PortalEmpty icon="ri-file-shield-2-line" title="Nothing to register" message="Applications appear here once the offer has been accepted." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-background-200">
            <table className="min-w-full text-left text-sm">
              <caption className="sr-only">Applications ready for manual registration</caption>
              <thead className="bg-background-100 text-xs uppercase text-foreground-600">
                <tr><th scope="col" className="px-3 py-2"><span className="sr-only">Select</span></th><th scope="col" className="px-3 py-2">Reference</th><th scope="col" className="px-3 py-2">Student</th><th scope="col" className="px-3 py-2">Application</th><th scope="col" className="px-3 py-2">Registration</th><th scope="col" className="px-3 py-2"><span className="sr-only">Open</span></th></tr>
              </thead>
              <tbody className="divide-y divide-background-200">
                {rows.map((row) => (
                  <tr key={row.applicationId} className={row.warning ? "bg-primary-50/50" : undefined}>
                    <td className="px-3 py-2"><input type="checkbox" aria-label={`Select ${row.reference} for export`} checked={selected.has(row.applicationId)} onChange={(e) => setSelected((prev) => { const next = new Set(prev); if (e.target.checked) next.add(row.applicationId); else next.delete(row.applicationId); return next; })} /></td>
                    <td className="px-3 py-2 font-medium">{row.reference}</td>
                    <td className="px-3 py-2">{row.studentName || "—"}</td>
                    <td className="px-3 py-2"><StatusBadge status={row.status} /></td>
                    <td className="px-3 py-2">
                      {row.registration ? `${STATE_LABEL[row.registration.state]}${row.registration.coeNumber ? ` · ${row.registration.coeNumber}` : ""}` : "Not started"}
                      {row.warning ? <span className="ml-2 rounded-full bg-primary-100 px-2 py-0.5 text-xs font-semibold text-primary-800">No verified registration</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right"><button type="button" className={outline} onClick={() => void openRow(row)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <PortalModal
        open={deciding !== null}
        title={deciding?.decision === "accept" ? "Accept this exception" : "Reopen this exception"}
        description="The decision, your name and the note are recorded in the audit log."
        onClose={() => setDeciding(null)}
        footer={
          <>
            <button type="button" className={outline} onClick={() => setDeciding(null)}>Cancel</button>
            <button type="button" className={primary} disabled={busy || !decisionNote.trim()} onClick={async () => {
              if (!deciding) return;
              const { row, decision } = deciding;
              setBusy(true); setError("");
              try { await reviewException(row.applicationId, row.kind, decision, decisionNote); setDeciding(null); await load(); } catch (e) { setError(e instanceof Error ? e.message : "The decision could not be saved."); setDeciding(null); } finally { setBusy(false); }
            }}>{deciding?.decision === "accept" ? "Accept exception" : "Reopen"}</button>
          </>
        }
      >
        <label className="mt-4 block text-sm font-semibold" htmlFor="decision-note">Note</label>
        <input id="decision-note" className={field} value={decisionNote} maxLength={500} onChange={(e) => setDecisionNote(e.target.value)} />
      </PortalModal>

      <PortalModal
        open={open !== null}
        title={open ? `Registration · ${open.reference}` : "Registration"}
        description={open ? `${open.studentName || "Student"} · application ${open.status.replace(/_/g, " ")}` : undefined}
        onClose={() => setOpen(null)}
        footer={<button type="button" className={outline} onClick={() => setOpen(null)}>Close</button>}
      >
        {open ? (
          <div className="mt-4 space-y-4 text-sm">
            <ul className="space-y-1" aria-label="Checklist">
              {checklist.map((item) => (
                <li key={item.key} className="flex items-start gap-2"><i className={item.done ? "ri-checkbox-circle-fill text-primary-600" : "ri-checkbox-blank-circle-line text-foreground-400"} aria-hidden="true" /><span>{item.done ? "Done: " : "To do: "}{item.label}</span></li>
              ))}
            </ul>
            {message ? <p role="status" className="rounded-md bg-background-100 px-3 py-2 text-foreground-800">{message}</p> : null}
            {actions.includes("create") ? (
              <button type="button" className={primary} disabled={busy} onClick={() => void run(open, async () => { await createRegistration(open.applicationId, ""); }, "Registration started.")}>Start registration</button>
            ) : null}
            {reg && detail ? (
              <>
                <section aria-label="Evidence">
                  <h3 className="font-semibold">Evidence</h3>
                  {detail.evidence.length === 0 ? <p className="text-foreground-500">None recorded yet.</p> : (
                    <ul className="mt-1 space-y-1">{detail.evidence.map((e) => <li key={e.id}>{EVIDENCE_KINDS.find((k) => k.value === e.kind)?.label ?? e.kind}: {e.description} <span className="text-foreground-500">({e.recordedBy}, {formatDate(e.recordedAt)})</span></li>)}</ul>
                  )}
                  <div className="mt-2 grid gap-2 sm:grid-cols-[180px_1fr_auto]">
                    <select aria-label="Evidence type" className={field} value={kind} onChange={(e) => setKind(e.target.value)}>{EVIDENCE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select>
                    <input aria-label="Evidence description" className={field} value={description} maxLength={500} placeholder="What does this evidence show?" onChange={(e) => setDescription(e.target.value)} />
                    <button type="button" className={outline} disabled={busy || !description.trim()} onClick={() => void run(open, () => addEvidence(reg.id, kind, description), "Evidence recorded.")}>Add</button>
                  </div>
                </section>
                {actions.includes("lodge") ? <button type="button" className={primary} disabled={busy} onClick={() => void run(open, () => transitionRegistration(reg.id, "lodged", null, ""), "Marked as lodged.")}>Mark as lodged (done by hand)</button> : null}
                {actions.includes("verify") ? (
                  <section aria-label="Verify registration" className="space-y-2">
                    <label className="block font-semibold" htmlFor="coe-number">CoE number</label>
                    <input id="coe-number" className={field} value={coe} maxLength={30} onChange={(e) => setCoe(e.target.value)} aria-invalid={coeCheck ? !coeCheck.ok : undefined} aria-describedby="coe-help" />
                    <p id="coe-help" className="text-xs text-foreground-500">{coeCheck && !coeCheck.ok ? coeCheck.error : "6 to 20 letters, digits or hyphens. Stored in upper case."}</p>
                    {blockers.length > 0 && coe ? <ul className="list-disc pl-5 text-foreground-700">{blockers.map((b) => <li key={b}>{b}</li>)}</ul> : null}
                    <button type="button" className={primary} disabled={busy || blockers.length > 0} onClick={() => void run(open, () => transitionRegistration(reg.id, "verified", coe, ""), "Registration verified.")}>Confirm verified registration</button>
                  </section>
                ) : null}
                {reg.state === "verified" ? <CoeVoePanel registrationId={reg.id} applicationId={open.applicationId} applicationStatus={open.status} registrationState={reg.state} onIssued={() => void refresh(open)} /> : null}
                {actions.includes("cancel") ? (
                  <section aria-label="Cancel registration" className="space-y-2">
                    {confirm === "cancel" ? (
                      <>
                        <label className="block font-semibold" htmlFor="cancel-reason">Reason for cancelling</label>
                        <input id="cancel-reason" className={field} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
                        <div className="flex gap-2">
                          <button type="button" className={primary} disabled={busy || !reason.trim()} onClick={() => void run(open, () => transitionRegistration(reg.id, "cancelled", null, reason), "Registration cancelled. Its evidence and history are kept.")}>Cancel registration</button>
                          <button type="button" className={outline} onClick={() => setConfirm(null)}>Keep it</button>
                        </div>
                      </>
                    ) : <button type="button" className={outline} onClick={() => setConfirm("cancel")}>Cancel registration…</button>}
                  </section>
                ) : null}
                {reg.state === "verified" ? (
                  <section aria-label="Correct CoE number" className="space-y-2">
                    <h3 className="font-semibold">Correct the CoE number</h3>
                    <p className="text-xs text-foreground-500">Use this when the external record shows a different number. The old value, the new value, who changed it and why are kept.</p>
                    <input aria-label="Corrected CoE number" className={field} value={fixCoe} maxLength={30} onChange={(e) => setFixCoe(e.target.value)} />
                    <input aria-label="Reason for the correction" className={field} value={fixReason} maxLength={500} placeholder="Reason" onChange={(e) => setFixReason(e.target.value)} />
                    {fixCoe || fixReason ? <ul className="list-disc pl-5 text-foreground-700">{validateCorrection(reg.coeNumber, fixCoe, fixReason).map((p) => <li key={p}>{p}</li>)}</ul> : null}
                    <button type="button" className={outline} disabled={busy || validateCorrection(reg.coeNumber, fixCoe, fixReason).length > 0} onClick={() => void run(open, () => correctCoeNumber(reg.id, fixCoe, fixReason), "CoE number corrected.")}>Record correction</button>
                  </section>
                ) : null}
                <section aria-label="History">
                  <h3 className="font-semibold">History</h3>
                  <ol className="mt-1 space-y-1">{detail.history.map((h, i) => <li key={`${h.at}-${i}`}>{h.from ? `${STATE_LABEL[h.from]} → ` : ""}{STATE_LABEL[h.to]} · {h.actor} · {formatDate(h.at)}{h.note ? ` · ${h.note}` : ""}</li>)}</ol>
                </section>
              </>
            ) : null}
          </div>
        ) : null}
      </PortalModal>
    </div>
  );
}
