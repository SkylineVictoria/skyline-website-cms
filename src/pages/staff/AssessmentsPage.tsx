import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { Badge, Button, SectionTabs } from "@/pages/admin/components/ui";
import CalendarView from "@/components/assessment/CalendarView";
import ProgressList, { type Progress } from "@/components/assessment/ProgressList";
import { asmTrainer, fmtDateTime, STATE_LABEL } from "@/lib/assessment/api";
import type { AssignmentRow, PendingRow } from "@/pages/admin/lib/assessments";

interface Me { staffId: string | null; name: string | null; isTrainer: boolean; batches: { id: string; name: string; intake: string; courseName: string }[] }
interface MyStudent { studentId: string; name: string; email: string; batchId: string; batchName: string; courseName: string }
interface Notification { id: string; event: string; title: string; body: string; attemptId: string | null; assignmentId: string | null; readAt: string | null; createdAt: string }
const TABS = [{ id: "marking", label: "Pending marking", icon: "ri-inbox-line" }, { id: "assignments", label: "My assessments", icon: "ri-file-list-3-line" }, { id: "students", label: "My students", icon: "ri-group-line" }, { id: "calendar", label: "Calendar", icon: "ri-calendar-2-line" }, { id: "notifications", label: "Notifications", icon: "ri-notification-3-line" }];

/** /staff/assessments: the trainer's assessment workspace (pending marking, assigned assessments, students' progress, calendar). */
export default function StaffAssessmentsPage() {
  const navigate = useNavigate();
  const [signedOut, setSignedOut] = useState(false);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [tab, setTab] = useState("marking");
  const [pending, setPending] = useState<PendingRow[] | null>(null);
  const [assignments, setAssignments] = useState<AssignmentRow[] | null>(null);
  const [students, setStudents] = useState<MyStudent[] | null>(null);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [notes, setNotes] = useState<Notification[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const m = await asmTrainer<Me>("me"); setMe(m);
      if (!m.staffId) return;
      const [p, a] = await Promise.all([asmTrainer<PendingRow[]>("pending_marking"), asmTrainer<AssignmentRow[]>("my_assignments")]);
      setPending(p); setAssignments(a); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Your assessments did not load."); setMe(null); }
  }, []);
  useEffect(() => { void supabase.auth.getUser().then(({ data }) => { if (!data.user) setSignedOut(true); else void load(); }); }, [load]);
  useEffect(() => { if (tab === "students" && students === null) void asmTrainer<MyStudent[]>("my_students").then(setStudents).catch(() => setStudents([])); if (tab === "notifications") void asmTrainer<Notification[]>("notifications").then(setNotes).catch(() => setNotes([])); }, [tab, students]);
  if (signedOut) return <Navigate to="/login?next=%2Fstaff%2Fassessments" replace />;
  const showProgress = async (studentId: string) => { if (progress[studentId]) { setProgress((p) => { const n = { ...p }; delete n[studentId]; return n; }); return; } try { const pr = await asmTrainer<Progress>("student_progress", { studentId }); setProgress((p) => ({ ...p, [studentId]: pr })); } catch (e) { setError(e instanceof Error ? e.message : "Not loaded."); } };
  return (
    <div className="min-h-screen bg-background-100 px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-heading text-2xl font-bold text-foreground-950">Assessments</h1>
          <div className="flex gap-2"><Link to="/staff" className="inline-flex items-center gap-1.5 rounded-md border border-background-300 px-4 py-2 text-sm font-medium text-foreground-800 hover:bg-background-100"><i className="ri-arrow-left-line" aria-hidden="true" />My HR</Link></div>
        </div>
        {error ? <p role="alert" className="mt-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
        {me === undefined ? <p className="mt-4 text-sm text-foreground-600" role="status">Loading…</p> : null}
        {me && !me.staffId ? <p className="mt-4 text-sm text-foreground-700">There is no active staff record for this login, so there is nothing to assess.</p> : null}
        {me?.staffId ? (
          <div className="mt-6">
            <p className="mb-4 text-sm text-foreground-700">{me.name}{me.batches.length ? ` · ${me.batches.map((b) => `${b.name} (${b.courseName})`).join(", ")}` : " · not on any batch yet"}</p>
            <SectionTabs tabs={TABS.map((t) => (t.id === "marking" && pending?.length ? { ...t, label: `Pending marking (${pending.length})` } : t))} active={tab} onChange={setTab} />
            {tab === "marking" ? (pending === null ? <p className="text-sm text-foreground-600">Loading…</p> : pending.length === 0 ? <p className="rounded-card border border-background-200 bg-background-50 p-6 text-center text-sm text-foreground-600">Nothing is waiting for you.</p> : (
              <ul className="divide-y divide-background-100 rounded-card border border-background-200 bg-background-50">{pending.map((p) => <li key={p.attemptId} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm"><button type="button" className="min-w-0 flex-1 text-left" onClick={() => navigate(`/staff/assessments/attempts/${p.attemptId}`)}><span className="block font-medium text-foreground-900">{p.studentName} · {p.assessmentTitle}</span><span className="block text-xs text-foreground-600">{p.batchName} · attempt {p.attemptNo} · submitted {fmtDateTime(p.submittedAt)} · receipt {p.receiptNo}</span></button><Badge tone={p.state === "marking" ? "accent" : "warn"}>{STATE_LABEL[p.state] ?? p.state}</Badge><Button size="sm" icon="ri-edit-line" onClick={() => navigate(`/staff/assessments/attempts/${p.attemptId}`)}>Mark</Button></li>)}</ul>
            )) : null}
            {tab === "assignments" ? (assignments === null ? <p className="text-sm text-foreground-600">Loading…</p> : assignments.length === 0 ? <p className="rounded-card border border-background-200 bg-background-50 p-6 text-center text-sm text-foreground-600">No assessment is assigned to your batches yet.</p> : (
              <ul className="space-y-2">{assignments.map((a) => <li key={a.id} className="rounded-card border border-background-200 bg-background-50 p-4 text-sm"><div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 font-medium text-foreground-900">{a.assessmentTitle}{a.unitCode ? <span className="ml-2 text-xs text-foreground-500">{a.unitCode}</span> : null}</span><Badge tone={a.status === "open" ? "success" : "muted"}>{a.status}</Badge></div><p className="text-xs text-foreground-600">{a.batchName} · {a.courseName} · v{a.versionNo} · due {fmtDateTime(a.dueAt)}</p><p className="mt-1 text-xs text-foreground-700">{a.eligibleCount} students · {a.submitted ?? 0} submitted · {a.toMark ?? 0} to mark · {a.final ?? 0} final</p><AssignmentStudents assignmentId={a.id} /></li>)}</ul>
            )) : null}
            {tab === "students" ? (students === null ? <p className="text-sm text-foreground-600">Loading…</p> : students.length === 0 ? <p className="text-sm text-foreground-600">No students in your batches.</p> : (
              <ul className="divide-y divide-background-100 rounded-card border border-background-200 bg-background-50">{students.map((s) => <li key={`${s.batchId}-${s.studentId}`} className="px-4 py-2 text-sm"><div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 font-medium text-foreground-900">{s.name}</span><span className="text-xs text-foreground-600">{s.batchName} · {s.courseName}</span><Button size="sm" variant="outline" onClick={() => void showProgress(s.studentId)}>{progress[s.studentId] ? "Hide progress" : "Competency progress"}</Button></div>{progress[s.studentId] ? <div className="mt-2"><ProgressList progress={progress[s.studentId]} onOpenAttempt={(id) => navigate(`/staff/assessments/attempts/${id}`)} /></div> : null}</li>)}</ul>
            )) : null}
            {tab === "calendar" ? <div className="rounded-card border border-background-200 bg-background-50 p-4"><CalendarView /></div> : null}
            {tab === "notifications" ? (notes === null ? <p className="text-sm text-foreground-600">Loading…</p> : notes.length === 0 ? <p className="text-sm text-foreground-600">No notifications.</p> : (
              <div><div className="mb-2 flex justify-end"><Button size="sm" variant="outline" onClick={() => void asmTrainer("notification_read").then(() => setNotes((n) => (n ?? []).map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() }))))}>Mark all read</Button></div><ul className="divide-y divide-background-100 rounded-card border border-background-200 bg-background-50">{notes.map((n) => <li key={n.id} className={`px-4 py-2.5 ${n.readAt ? "" : "bg-primary-50/40"}`}><p className="text-sm font-medium text-foreground-900">{n.title}</p><p className="text-sm text-foreground-700">{n.body}</p><p className="text-xs text-foreground-500">{fmtDateTime(n.createdAt)}{n.attemptId ? <> · <Link className="underline" to={`/staff/assessments/attempts/${n.attemptId}`}>Open</Link></> : null}</p></li>)}</ul></div>
            )) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssignmentStudents({ assignmentId }: { assignmentId: string }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<{ studentId: string; name: string; dueAt: string; attempts: { id: string; attemptNo: number; state: string; outcome: string | null }[] }[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open && rows === null) void asmTrainer<typeof rows>("assignment_students", { id: assignmentId }).then(setRows).catch(() => setRows([])); }, [open, rows, assignmentId]);
  return (
    <div className="mt-2">
      <Button size="sm" variant="ghost" icon={open ? "ri-arrow-up-s-line" : "ri-arrow-down-s-line"} onClick={() => setOpen((v) => !v)}>{open ? "Hide students" : "Students"}</Button>
      {open ? (rows === null ? <p className="text-xs text-foreground-600">Loading…</p> : <ul className="mt-1 divide-y divide-background-100 rounded-md border border-background-200">{rows.map((s) => <li key={s.studentId} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs"><span className="min-w-0 flex-1 text-foreground-900">{s.name}</span><span className="text-foreground-500">due {fmtDateTime(s.dueAt)}</span>{s.attempts.length === 0 ? <span className="text-foreground-500">not started</span> : s.attempts.map((t) => <button key={t.id} type="button" className="rounded border border-background-300 px-1.5 py-0.5 hover:bg-background-100" onClick={() => navigate(`/staff/assessments/attempts/${t.id}`)}>Attempt {t.attemptNo}: {STATE_LABEL[t.state] ?? t.state}{t.outcome ? ` · ${t.outcome}` : ""}</button>)}</li>)}</ul>) : null}
    </div>
  );
}
