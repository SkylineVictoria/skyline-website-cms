import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Card, Modal, PageHeader } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import {
  addQualificationDocument, closeQualificationTask, copyPendingDocuments, DOCUMENT_KIND_LABELS, formatQualificationDate, getQualification,
  openQualificationDocument, qualificationTone, setQualificationStatus, TASK_KIND_LABELS, undoQualification, type QualificationDetail, type QualificationTask,
} from "@/lib/qualification";

const INPUT = "w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm";
const LABEL = "mb-1 block text-xs font-medium text-foreground-600";
const today = () => new Date().toISOString().slice(0, 10);

/** Admissions › Qualifications › one Qualification: status and reason, dates, units with results, documents, history and tasks. */
export default function QualificationDetailPage() {
  const { id = "" } = useParams();
  const { push } = useToast();
  const [q, setQ] = useState<QualificationDetail | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [changing, setChanging] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [closing, setClosing] = useState<QualificationTask | null>(null);
  const [uploading, setUploading] = useState(false);
  const copied = useRef(false);

  const refresh = useCallback(() => setReload((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    getQualification(id).then((data) => { if (live) { setQ(data); setError(""); } }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [id, reload]);

  // The application's files waiting to be copied onto the Qualification are copied once when staff open it.
  useEffect(() => {
    if (!q || copied.current || !q.documents.some((d) => d.copyState === "pending")) return;
    copied.current = true;
    void copyPendingDocuments(q.documents).then((n) => { if (n) refresh(); }, () => undefined);
  }, [q, refresh]);

  if (error) return <div><PageHeader title="Qualification" /><p role="alert" className="text-sm text-red-700">{error}</p><Link to="/admin/qualifications" className="text-sm font-semibold text-primary-700 underline">Back to Qualifications</Link></div>;
  if (!q) return <p className="p-6 text-sm text-foreground-600">Loading Qualification…</p>;

  const open = (docId: string) => { void openQualificationDocument(docId).catch((e) => push(e instanceof Error ? e.message : String(e), "error")); };
  const missing = q.units.filter((u) => !u.hasResult).length;

  return (
    <div data-testid="qualification-detail">
      <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap gap-1.5 text-sm text-foreground-600">
        <Link to="/admin/qualifications" className="hover:text-foreground-900">Qualifications</Link><span aria-hidden="true">/</span>
        <Link to={`/admin/students/${q.studentId}`} className="hover:text-foreground-900">{q.studentName || "Student"}</Link>
      </nav>
      <PageHeader title={`Qualification: ${[q.courseCode, q.courseName].filter(Boolean).join(" ")}`}
        titleSuffix={<span className={`ml-3 inline-block rounded-full border px-2.5 py-0.5 align-middle text-sm font-semibold ${qualificationTone(q.status)}`} data-testid="qualification-status">{q.label}</span>}
        description={`${q.studentName ?? ""}${q.studentNumber ? ` (${q.studentNumber})` : ""} · ${q.intakeName ?? ""} · ${q.type}`}
        actions={<>
          {q.canChange && q.moves.length ? <Button icon="ri-loop-right-line" onClick={() => setChanging(true)} data-testid="qualification-change">Change status</Button> : null}
          {q.canUndo ? <Button variant="outline" icon="ri-arrow-go-back-line" onClick={() => setUndoing(true)}>Undo {q.label}</Button> : null}
        </>} />

      <div className="flex flex-wrap items-start gap-5">
        <Card className="min-w-0 flex-[1_1_320px] p-5">
          <h2 className="mb-3 font-heading text-[15px] font-semibold text-foreground-900">Status and dates</h2>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Row label="Status" value={q.label} />
            <Row label="Reason" value={q.reason ?? ""} />
            <Row label="Course start" value={formatQualificationDate(q.startDate)} />
            <Row label="Course end" value={formatQualificationDate(q.endDate)} />
            <Row label="Joined on" value={formatQualificationDate(q.enrolledOn)} />
            {q.resumeDate ? <Row label="Resumes" value={formatQualificationDate(q.resumeDate)} /> : null}
            {q.withdrawnOn ? <Row label="Cancelled on" value={formatQualificationDate(q.withdrawnOn)} /> : null}
            <Row label={q.voeNumber ? "VoE number" : "CoE number"} value={q.voeNumber ?? q.coeNumber ?? ""} />
            <div className="col-span-2"><dt className="text-xs text-foreground-500">Internal note</dt><dd className="whitespace-pre-wrap text-foreground-900">{q.note || <span className="text-foreground-500">None</span>}</dd></div>
            <div className="col-span-2"><dt className="text-xs text-foreground-500">Application</dt><dd>{q.applicationId
              ? <Link to={`/admin/applications/${q.applicationId}`} className="text-primary-700 hover:underline">{q.applicationReference || "Open application"}</Link>
              : <span className="text-foreground-500">Placed by hand</span>}</dd></div>
          </dl>
        </Card>
        <Card className="min-w-0 flex-[2_1_480px]">
          <div className="flex items-center justify-between border-b border-background-200 px-4 py-3">
            <h2 className="font-heading text-[15px] font-semibold text-foreground-900">Units <span className="font-normal text-foreground-500">{q.units.length}</span></h2>
            <span className="text-xs text-foreground-600">{missing ? `${missing} without a result` : "Every unit has a result"}</span>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-foreground-500"><tr><th className="px-4 py-2 font-medium">Unit</th><th className="px-4 py-2 font-medium">Dates</th><th className="px-4 py-2 font-medium">Result</th></tr></thead>
            <tbody>{q.units.map((u) => (
              <tr key={u.unitId} className="border-t border-background-100">
                <td className="px-4 py-2"><span className="font-mono text-xs">{u.code}</span> {u.name}</td>
                <td className="px-4 py-2 text-xs text-foreground-600">{formatQualificationDate(u.startDate)} – {formatQualificationDate(u.endDate)}</td>
                <td className="px-4 py-2 text-xs">{u.hasResult
                  ? <span className="text-foreground-900">{u.assessment ? `${u.assessment}${u.assessmentOn ? ` (${formatQualificationDate(u.assessmentOn)})` : ""}` : ""}{u.avetmissOutcome ? ` · AVETMISS ${u.avetmissOutcome}` : ""}</span>
                  : <span className="text-foreground-500">No result yet</span>}</td>
              </tr>))}
            </tbody>
          </table>
        </Card>
      </div>

      <TasksCard tasks={q.tasks} onClose={setClosing} />

      <Card className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-background-200 px-4 py-3">
          <h2 className="font-heading text-[15px] font-semibold text-foreground-900">Documents <span className="font-normal text-foreground-500">{q.documents.length}</span></h2>
          {q.canChange ? <Button size="sm" variant="outline" icon="ri-upload-2-line" onClick={() => setUploading(true)}>Add document</Button> : null}
        </div>
        {q.documents.length ? (
          <ul className="divide-y divide-background-100">{q.documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
              <span><b className="font-medium text-foreground-900">{d.title}</b> <span className="text-xs text-foreground-500">{DOCUMENT_KIND_LABELS[d.kind] ?? d.kind}{d.studentVisible ? "" : " · staff only"} · {formatQualificationDate(d.createdAt)}</span></span>
              {d.copyState === "copied" ? <Button size="sm" variant="ghost" icon="ri-download-line" onClick={() => open(d.id)}>Open</Button>
                : <span className="text-xs text-amber-800">{d.copyState === "pending" ? "Copying from the application…" : "Copy failed: open the application and add it again"}</span>}
            </li>))}
          </ul>
        ) : <p className="px-4 py-3 text-sm text-foreground-500">No documents yet.</p>}
      </Card>

      <Card className="mt-4">
        <h2 className="border-b border-background-200 px-4 py-3 font-heading text-[15px] font-semibold text-foreground-900">History</h2>
        <ol className="divide-y divide-background-100" data-testid="qualification-history">{q.history.map((h) => (
          <li key={h.id} className="px-4 py-2.5 text-sm">
            <p className="text-foreground-900">{h.from ? <>{h.fromLabel} <i className="ri-arrow-right-line" aria-hidden="true" /> </> : null}<b>{h.toLabel}</b>
              <span className="ml-2 text-xs text-foreground-500">effective {formatQualificationDate(h.effectiveOn)} · {h.by || "System"} · {new Date(h.at).toLocaleString("en-AU")}</span></p>
            {h.reason ? <p className="text-xs text-foreground-700">{h.reason}</p> : null}
            {h.note ? <p className="whitespace-pre-wrap text-xs text-foreground-600">{h.note}</p> : null}
            {h.evidenceId ? <button type="button" className="text-xs font-semibold text-primary-700 hover:underline" onClick={() => open(h.evidenceId!)}>Evidence</button> : null}
          </li>))}
        </ol>
      </Card>

      {changing ? <ChangeStatusDialog q={q} onClose={() => setChanging(false)} onDone={(msg) => { setChanging(false); push(msg); refresh(); }} /> : null}
      {undoing ? <UndoDialog q={q} onClose={() => setUndoing(false)} onDone={() => { setUndoing(false); push("Undone."); refresh(); }} /> : null}
      {closing ? <CloseTaskDialog task={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); push("Task closed."); refresh(); }} /> : null}
      {uploading ? <UploadDialog id={q.id} onClose={() => setUploading(false)} onDone={() => { setUploading(false); push("Document added."); refresh(); }} /> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-foreground-500">{label}</dt><dd className={value ? "text-foreground-900" : "text-foreground-500"}>{value || "Not recorded"}</dd></div>;
}

function TasksCard({ tasks, onClose }: { tasks: QualificationTask[]; onClose: (t: QualificationTask) => void }) {
  if (!tasks.length) return null;
  return (
    <Card className="mt-4">
      <h2 className="border-b border-background-200 px-4 py-3 font-heading text-[15px] font-semibold text-foreground-900">Tasks</h2>
      <ul className="divide-y divide-background-100" data-testid="qualification-tasks">{tasks.map((t) => (
        <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
          <span>
            <b className="font-medium text-foreground-900">{t.title}</b>
            <span className="ml-2 text-xs text-foreground-500">{TASK_KIND_LABELS[t.kind]}{t.dueOn ? ` · due ${formatQualificationDate(t.dueOn)}` : ""}</span>
            {t.detail ? <span className="block text-xs text-foreground-600">{t.detail}</span> : null}
            {t.prismsReference ? <span className="block text-xs text-foreground-600">PRISMS reference {t.prismsReference}</span> : null}
          </span>
          {t.status === "open" ? <Button size="sm" variant="outline" onClick={() => onClose(t)}>Close task</Button> : <span className="text-xs text-green-800">Done {t.closedAt ? new Date(t.closedAt).toLocaleDateString("en-AU") : ""}</span>}
        </li>))}
      </ul>
    </Card>
  );
}

function ChangeStatusDialog({ q, onClose, onDone }: { q: QualificationDetail; onClose: () => void; onDone: (msg: string) => void }) {
  const [to, setTo] = useState(q.moves[0]?.status ?? "");
  const [reasonId, setReasonId] = useState("");
  const [note, setNote] = useState("");
  const [effectiveOn, setEffectiveOn] = useState(today());
  const [resumeDate, setResumeDate] = useState("");
  const [evidence, setEvidence] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reasons = q.reasons.filter((r) => r.status === to);
  const reason = reasons.find((r) => r.id === reasonId);
  const needsResume = to === "deferred" || to === "suspended";
  const ready = Boolean(to) && (!reasons.length || (reason && (!reason.isOther || note.trim()))) && (!needsResume || resumeDate);
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true); setError("");
    try {
      const evidenceId = evidence ? await addQualificationDocument({ id: q.id, kind: "evidence", title: `Evidence: ${q.moves.find((m) => m.status === to)?.label ?? to}`, file: evidence, studentVisible: false }) : undefined;
      const row = await setQualificationStatus({ id: q.id, status: to, reason: reason ? (reason.isOther ? note.trim().slice(0, 200) : reason.label) : undefined,
        note: note.trim(), effectiveOn, resumeDate: needsResume ? resumeDate : undefined, evidenceId });
      onDone(`Qualification is now ${row.label}.`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return (
    <Modal open title="Change Qualification status" onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={() => void save()} disabled={!ready || busy} data-testid="qualification-change-save">{busy ? "Saving…" : "Save"}</Button></>}>
      <div className="space-y-3">
        <div><label className={LABEL} htmlFor="q-to">New status</label>
          <select id="q-to" className={INPUT} value={to} onChange={(e) => { setTo(e.target.value); setReasonId(""); }} data-testid="qualification-change-to">
            {q.moves.map((m) => <option key={m.status} value={m.status}>{m.label}</option>)}
          </select></div>
        {reasons.length ? <div><label className={LABEL} htmlFor="q-reason">Reason</label>
          <select id="q-reason" className={INPUT} value={reasonId} onChange={(e) => setReasonId(e.target.value)} data-testid="qualification-change-reason">
            <option value="">Choose a reason</option>
            {reasons.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select></div> : null}
        <div><label className={LABEL} htmlFor="q-effective">Effective date</label><input id="q-effective" type="date" className={INPUT} value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} /></div>
        {needsResume ? <div><label className={LABEL} htmlFor="q-resume">Resume date</label><input id="q-resume" type="date" className={INPUT} value={resumeDate} onChange={(e) => setResumeDate(e.target.value)} data-testid="qualification-change-resume" /></div> : null}
        <div><label className={LABEL} htmlFor="q-note">{reason?.isOther ? "Reason (required)" : "Internal note (optional)"}</label><textarea id="q-note" rows={3} maxLength={2000} className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div><label className={LABEL} htmlFor="q-evidence">Evidence (optional, staff only)</label><input id="q-evidence" type="file" onChange={(e) => setEvidence(e.target.files?.[0] ?? null)} className="text-sm" /></div>
        {q.type === "CoE" && ["deferred", "suspended", "withdrawn"].includes(to) ? <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">This is a CoE student: a &ldquo;Report in PRISMS within 14 days&rdquo; task is created.</p> : null}
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      </div>
    </Modal>
  );
}

function UndoDialog({ q, onClose, onDone }: { q: QualificationDetail; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true); setError("");
    try { await undoQualification(q.id, reason.trim()); onDone(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return (
    <Modal open title={`Undo ${q.label}`} onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={() => void save()} disabled={busy || reason.trim().length < 3}>Undo</Button></>}>
      <p className="mb-3 text-sm text-foreground-700">{q.label} is final. An Admin can undo it with a reason; the Qualification goes back to In Progress (or Tentative) and the undo is kept in the history.</p>
      <label className={LABEL} htmlFor="q-undo">Reason</label>
      <textarea id="q-undo" rows={3} maxLength={200} className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} />
      {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
    </Modal>
  );
}

function CloseTaskDialog({ task, onClose, onDone }: { task: QualificationTask; onClose: () => void; onDone: () => void }) {
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const prisms = task.kind === "prisms_report";
  const save = async () => {
    setBusy(true); setError("");
    try { await closeQualificationTask(task.id, reference.trim(), note.trim()); onDone(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return (
    <Modal open title={`Close: ${task.title}`} onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={() => void save()} disabled={busy || (prisms && !reference.trim())}>Close task</Button></>}>
      <div className="space-y-3">
        {prisms ? <div><label className={LABEL} htmlFor="t-ref">PRISMS reference</label><input id="t-ref" className={INPUT} maxLength={60} value={reference} onChange={(e) => setReference(e.target.value)} /></div> : null}
        <div><label className={LABEL} htmlFor="t-note">Note (optional)</label><textarea id="t-note" rows={2} maxLength={1000} className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      </div>
    </Modal>
  );
}

function UploadDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState("evidence");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!file) return;
    setBusy(true); setError("");
    try { await addQualificationDocument({ id, kind, title: title.trim() || file.name, file, studentVisible: visible }); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return (
    <Modal open title="Add a document" onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={() => void save()} disabled={busy || !file}>{busy ? "Uploading…" : "Add"}</Button></>}>
      <div className="space-y-3">
        <div><label className={LABEL} htmlFor="d-kind">Kind</label>
          <select id="d-kind" className={INPUT} value={kind} onChange={(e) => { setKind(e.target.value); setVisible(e.target.value !== "evidence"); }}>
            {["evidence", "certificate", "coe", "voe", "other"].map((k) => <option key={k} value={k}>{DOCUMENT_KIND_LABELS[k]}</option>)}
          </select></div>
        <div><label className={LABEL} htmlFor="d-title">Title</label><input id="d-title" className={INPUT} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div><label className={LABEL} htmlFor="d-file">File</label><input id="d-file" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />The student and agent can see it</label>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      </div>
    </Modal>
  );
}
