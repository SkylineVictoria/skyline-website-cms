import { Link, useParams } from "react-router-dom";
import { LMS_MENU, type LmsArea } from "./lmsConfig";
import LmsAcademicPage from "./LmsAcademicPage";
import LmsIntakesPage from "./LmsIntakesPage";
import LmsAssessmentsPage from "./LmsAssessmentsPage";
import LmsCoursesPage from "./LmsCoursesPage";

/** LMS entrypoints reuse the authoritative CRM/RTO screens. Never copy master records. */
export default function LmsPage() {
  const { area } = useParams<{ area?: LmsArea }>();
  const selected = LMS_MENU.find(x => x.id === area);
  if (area === "courses") return <LmsCoursesPage />;
  if (area === "intakes") return <LmsIntakesPage />;
  if (area === "assessments") return <LmsAssessmentsPage />;
  if (area === "batches" || area === "unit-delivery" || area === "timetable" || area === "attendance") return <LmsAcademicPage area={area} />;
  const actions: Record<string, { label: string; to: string; note: string }[]> = {
    batches: [{ label: "Find an intake and its batches", to: "/admin/intakes", note: "Batches are managed within their parent intake; no duplicate batch master." }],
    "unit-delivery": [{ label: "Open intake unit schedule", to: "/admin/intakes", note: "The unit schedule belongs to its intake and batch." }],
    timetable: [{ label: "Open batch class timing", to: "/admin/intakes", note: "Class timing is saved through the existing batch workflow." }],
    attendance: [{ label: "Open batch and student list", to: "/admin/intakes", note: "Student attendance requires a dedicated dated-session register before marking can be enabled." }],
  };
  return <div className="mx-auto max-w-5xl space-y-6 pb-10">
    <div><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Learning Management</p>
      <h1 className="mt-1 font-heading text-3xl font-bold text-foreground-950">{selected?.label ?? "Dashboard"}</h1>
      <p className="mt-2 text-sm text-foreground-600">{selected ? "Work with the existing academic records without duplicating CRM or HRMS." : "Choose an academic workflow."}</p>
    </div>
    {selected ? <div className="rounded-xl border border-background-200 bg-background-50 p-5">
      {(actions[selected.id] ?? []).map(a => <div key={a.to} className="space-y-2">
        <p className="text-sm text-foreground-600">{a.note}</p>
        <Link to={a.to} className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-4 py-2 font-semibold text-background-50">{a.label}<i className="ri-arrow-right-line" aria-hidden="true" /></Link>
      </div>)}
    </div> : null}
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {(selected ? LMS_MENU.filter(x => x.id !== selected.id) : LMS_MENU.filter(x => x.id !== "dashboard")).map(item =>
        <Link key={item.id} to={item.route} className="flex items-center gap-3 rounded-xl border border-background-200 bg-background-50 p-4 hover:border-primary-500 hover:bg-background-100">
          <i className={item.icon + " text-xl text-primary-600"} aria-hidden="true" />
          <span className="flex-1 font-semibold text-foreground-900">{item.label}</span><i className="ri-arrow-right-s-line text-foreground-500" aria-hidden="true" />
        </Link>)}
    </div>
  </div>;
}
