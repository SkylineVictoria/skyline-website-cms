import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import WhatsAppLink from "@/components/base/WhatsAppLink";
import SubjectSigningPanel from "./components/signing/SubjectSigningPanel";
import { Button, Card, PageHeader } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import StudentLoginCell from "@/pages/admin/components/StudentLoginCell";
import StudentOffice365Panel from "@/pages/admin/components/StudentOffice365Panel";
import { AgencyStatusBadge, ApplicationStatusPills } from "@/pages/admin/components/AgencyStatus";
import ApplicationsList from "@/pages/admin/components/ApplicationsList";
import { ListMessage } from "@/pages/admin/components/ListControls";
import { getStudent, sendStudentInvitation, studentLoginLabel, type StudentDetail } from "@/pages/admin/lib/businessData";
import { formatDate } from "@/pages/agency/lib/portalData";

/** Agencies > Students > {name}: every application this student has, across statuses. */
export default function StudentDetailPage() {
  const { id = "" } = useParams();
  const { push } = useToast();
  const [student, setStudent] = useState<StudentDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [error, setError] = useState("");
  const [inviting, setInviting] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    if (reload === 0) setState("loading");
    getStudent(id).then((s) => { if (active) { setStudent(s); setState(s ? "ready" : "missing"); } })
      .catch((e) => { if (active) { setError(e instanceof Error ? e.message : "We could not load this student."); setState("error"); } });
    return () => { active = false; };
  }, [id, reload]);

  const invite = async () => {
    if (!student) return;
    setInviting(true);
    try {
      push(await sendStudentInvitation({ id: student.id, email: student.email, name: student.name, agencyId: student.agencyId, login: student.login }));
      setReload((n) => n + 1);
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not send the invitation.", "error");
    } finally {
      setInviting(false);
    }
  };

  if (state === "loading") return <p className="p-6 text-sm text-foreground-600">Loading student&hellip;</p>;
  if (!student) {
    return (
      <div>
        <PageHeader title="Student not found" />
        <p role="alert" className="text-sm text-red-700">{state === "error" ? error : "This student could not be found."}</p>
        <Link to="/admin/students" className="mt-3 inline-block text-sm font-semibold text-primary-700 underline">Back to Students</Link>
      </div>
    );
  }

  const counts: Record<string, number> = {};
  for (const a of student.applications) counts[a.status] = (counts[a.status] ?? 0) + 1;

  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap gap-1.5 text-sm text-foreground-600">
        <Link to="/admin/businesses" className="hover:text-foreground-900">Businesses</Link><span aria-hidden="true">/</span>
        <Link to={`/admin/businesses/${student.business.id}`} className="hover:text-foreground-900">{student.business.name}</Link><span aria-hidden="true">/</span>
        <span className="text-foreground-900">Student</span>
      </nav>
      <PageHeader title={student.name || "Unnamed student"} titleSuffix={<WhatsAppLink phone={student.phone} name={student.name} />}
        description={`Student of ${student.business.name}${student.agent ? `, looked after by ${student.agent.name}` : ""}${student.selfEnrolled ? ", enrolled themselves from the website" : ""}. Sign-in: ${studentLoginLabel(student.login)}.`}
        actions={student.login?.status === "active" ? undefined : (
          <Button icon="ri-mail-send-line" disabled={inviting || !student.email} onClick={() => void invite()}>
            {inviting ? "Sending…" : student.login?.invitationId ? "Resend invite" : "Invite to sign in"}
          </Button>
        )} />

      <div className="flex flex-wrap items-start gap-5">
        <Card className="min-w-0 flex-[999_1_560px]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-background-200 px-4 py-3">
            <h2 className="font-heading text-base font-semibold text-foreground-900">Applications <span className="font-normal text-foreground-500">{student.applications.length}</span></h2>
            <ApplicationStatusPills counts={counts} />
          </div>
          {student.applications.length ? <ApplicationsList rows={student.applications} showAgent />
            : <ListMessage icon="ri-file-list-3-line" title="No applications" text="This student has no applications yet." />}
        </Card>
        <Card className="flex-[1_1_260px] p-5">
          <h2 className="mb-3 font-heading text-[15px] font-semibold text-foreground-900">Student details</h2>
          <dl className="space-y-3 text-sm">
            <Row label="Email" value={student.email} />
            <Row label="Phone" value={student.phone} />
            <Row label="Date of birth" value={student.dateOfBirth ? formatDate(student.dateOfBirth) : ""} />
            <Row label="Passport number" value={student.passportNumber} />
            <Row label="Nationality" value={student.nationality} />
            {student.courseOfInterest ? <Row label="Course of interest" value={student.courseOfInterest} /> : null}
            <div><dt className="text-xs text-foreground-500">Sign-in</dt><dd><StudentLoginCell login={student.login} email={student.email} busy={inviting} onInvite={() => void invite()} /></dd></div>
            <div><dt className="text-xs text-foreground-500">Business</dt><dd className="flex flex-wrap items-center gap-2"><Link to={`/admin/businesses/${student.business.id}`} className="text-foreground-900 hover:text-primary-700">{student.business.name}</Link><AgencyStatusBadge status={student.business.status} /></dd></div>
            <div><dt className="text-xs text-foreground-500">Agent</dt><dd>{student.agent ? <Link to={`/admin/agents/${student.agent.id}`} className="text-foreground-900 hover:text-primary-700">{student.agent.name}</Link> : <span className="text-foreground-500">Not assigned</span>}</dd></div>
            <Row label="First recorded" value={formatDate(student.createdAt)} />
          </dl>
        </Card>
      </div>
      <div className="mt-4"><StudentOffice365Panel studentId={id} personalEmail={student.email} /></div>
      <div className="mt-4"><SubjectSigningPanel type="student" id={id} name={student.name} /></div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-foreground-500">{label}</dt><dd className={value ? "text-foreground-900" : "text-foreground-500"}>{value || "Not recorded"}</dd></div>;
}
