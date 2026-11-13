import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, SectionTabs } from "@/pages/admin/components/ui";
import { PageHeading, PortalEmpty, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
import CalendarView from "@/components/assessment/CalendarView";
import ProgressList, { type Progress } from "@/components/assessment/ProgressList";
import { asmStudent, fmtDateTime, OUTCOME_LABEL, STATE_LABEL } from "@/lib/assessment/api";

export interface MyAssessment {
  assignmentId: string; assessmentId: string; title: string; code: string | null; description: string; unitCode: string | null; unitName: string | null; courseName: string; batchName: string;
  availableFrom: string; dueAt: string; lateUntil: string | null; status: string; maxAttempts: number;
  attempts: { id: string; attemptNo: number; state: string; outcome: string | null; submittedAt: string | null; dueAt: string | null; receiptNo: string | null; acknowledgedAt?: string | null }[];
  events: { kind: string; title: string; startsAt: string; endsAt: string | null; room: string | null }[];
}
interface Notification { id: string; event: string; title: string; body: string; attemptId: string | null; assignmentId: string | null; readAt: string | null; createdAt: string }

const TABS = [{ id: "assessments", label: "My assessments", icon: "ri-file-list-3-line" }, { id: "progress", label: "Results & progress", icon: "ri-award-line" }, { id: "calendar", label: "Calendar", icon: "ri-calendar-2-line" }, { id: "notifications", label: "Notifications", icon: "ri-notification-3-line" }];

function statusOf(a: MyAssessment): { label: string; tone: "primary" | "accent" | "success" | "warn" | "muted" } {
  const last = a.attempts[a.attempts.length - 1];
  const now = Date.now();
  if (!last) return now < new Date(a.availableFrom).getTime() ? { label: `Opens ${fmtDateTime(a.availableFrom)}`, tone: "muted" } : now > new Date(a.dueAt).getTime() ? { label: "Overdue · not started", tone: "warn" } : { label: "Not started", tone: "accent" };
  if (last.state === "draft") return now > new Date(last.dueAt ?? a.dueAt).getTime() ? { label: `Overdue · attempt ${last.attemptNo} in progress`, tone: "warn" } : { label: `Attempt ${last.attemptNo} in progress`, tone: "accent" };
  if (last.state === "final") return { label: last.outcome ? OUTCOME_LABEL[last.outcome] : "Final", tone: last.outcome === "S" ? "success" : "warn" };
  return { label: STATE_LABEL[last.state] ?? last.state, tone: "primary" };
}

/** Student portal: assessments resolved through enrolment > batch > assignment; results and competency; calendar; notifications. */
export default function StudentAssessmentsPage() {
  const [tab, setTab] = useState("assessments");
  const [rows, setRows] = useState<MyAssessment[] | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [notes, setNotes] = useState<Notification[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setRows(await asmStudent<MyAssessment[]>("my_assessments")); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Your assessments did not load."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (tab === "progress") void asmStudent<Progress>("progress").then(setProgress).catch(() => setProgress(null)); if (tab === "notifications") void asmStudent<Notification[]>("notifications").then(setNotes).catch(() => setNotes([])); }, [tab]);
  const unread = notes?.filter((n) => !n.readAt).length ?? 0;
  const toAcknowledge = (rows ?? []).flatMap((a) => a.attempts.filter((t) => (t.state === "returned" || t.state === "final") && !t.acknowledgedAt).map((t) => ({ a, t })));
  const acknowledge = async (attemptId: string) => { try { await asmStudent("result_acknowledge", { attemptId }); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Not recorded."); } };
  return (
    <div>
      <PageHeading eyebrow="Assessments" title="My assessments" description="Complete your assessments online, upload evidence, submit with your declaration and read your assessor's feedback." />
      <div className="mt-6"><SectionTabs tabs={TABS.map((t) => (t.id === "notifications" && unread ? { ...t, label: `Notifications (${unread})` } : t))} active={tab} onChange={setTab} /></div>
      {error ? <PortalError message={error} onRetry={() => void load()} /> : null}
      {tab === "assessments" && toAcknowledge.length ? (
        <div role="status" className="mt-4 rounded-card border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Results to acknowledge ({toAcknowledge.length})</p>
          <ul className="mt-2 space-y-1">{toAcknowledge.map(({ a, t }) => <li key={t.id} className="flex flex-wrap items-center justify-between gap-2"><span>{a.title}: attempt {t.attemptNo} is {t.outcome ? OUTCOME_LABEL[t.outcome as keyof typeof OUTCOME_LABEL] : STATE_LABEL[t.state] ?? t.state}</span><Button size="sm" variant="outline" icon="ri-check-line" onClick={() => void acknowledge(t.id)}>I have read this result</Button></li>)}</ul>
        </div>
      ) : null}
      {tab === "assessments" ? (rows === null ? <PortalLoading label="Loading your assessments…" /> : rows.length === 0 ? <PortalEmpty icon="ri-file-list-3-line" title="No assessments yet" message="When your trainer assigns an assessment to your batch it appears here." /> : (
        <ul className="space-y-3">{rows.map((a) => { const s = statusOf(a); return (
          <li key={a.assignmentId} className="rounded-card border border-background-200 bg-background-50 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-heading text-base font-semibold text-foreground-950">{a.title}</h2>
                <p className="text-xs text-foreground-600">{a.unitCode ? `${a.unitCode} ${a.unitName} · ` : ""}{a.courseName} · {a.batchName}</p>
                {a.description ? <p className="mt-1 text-sm text-foreground-700">{a.description}</p> : null}
                <p className="mt-1 text-sm text-foreground-800"><i className="ri-calendar-event-line mr-1 text-foreground-500" aria-hidden="true" />Due {fmtDateTime(a.dueAt)}{a.attempts.length ? ` · ${a.attempts.length} of ${a.maxAttempts} attempts used` : ""}</p>
                {a.events.length ? <ul className="mt-1 text-xs text-foreground-600">{a.events.map((e, i) => <li key={i}><i className="ri-map-pin-line mr-1" aria-hidden="true" />{e.title}: {fmtDateTime(e.startsAt)}{e.room ? ` · ${e.room}` : ""}</li>)}</ul> : null}
              </div>
              <div className="flex flex-col items-end gap-2"><Badge tone={s.tone}>{s.label}</Badge><Link to={`/agency/assessments/${a.assignmentId}`}><Button size="sm" icon="ri-arrow-right-line">{a.attempts.length ? "Open" : "Start"}</Button></Link></div>
            </div>
          </li>); })}</ul>
      )) : null}
      {tab === "progress" ? (progress ? <ProgressList progress={progress} onOpenAssignment={(id) => { window.location.href = `/agency/assessments/${id}`; }} /> : <PortalLoading label="Loading your progress…" />) : null}
      {tab === "calendar" ? <div className="rounded-card border border-background-200 bg-background-50 p-4"><CalendarView /></div> : null}
      {tab === "notifications" ? (notes === null ? <PortalLoading /> : notes.length === 0 ? <PortalEmpty icon="ri-notification-3-line" title="No notifications" message="Due dates, feedback and outcomes appear here." /> : (
        <div><div className="mb-2 flex justify-end"><Button size="sm" variant="outline" onClick={() => void asmStudent("notification_read").then(() => setNotes((n) => (n ?? []).map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() }))))}>Mark all read</Button></div>
        <ul className="divide-y divide-background-100 rounded-card border border-background-200 bg-background-50">{notes.map((n) => <li key={n.id} className={`px-4 py-2.5 ${n.readAt ? "" : "bg-primary-50/40"}`}><p className="text-sm font-medium text-foreground-900">{n.title}</p><p className="text-sm text-foreground-700">{n.body}</p><p className="text-xs text-foreground-500">{fmtDateTime(n.createdAt)}{n.assignmentId ? <> · <Link className="underline" to={`/agency/assessments/${n.assignmentId}`}>Open</Link></> : null}</p></li>)}</ul></div>
      )) : null}
    </div>
  );
}
