import { Link } from "react-router-dom";
import ClassTimetable from "@/components/timetable/ClassTimetable";

/** Staff > My classes: the week's classes of the batches and units this trainer teaches. */
export default function StaffTimetablePage() {
  return (
    <div className="min-h-screen bg-background-100 px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-heading text-2xl font-bold text-foreground-950">My classes</h1>
          <Link to="/staff" className="inline-flex items-center gap-1.5 rounded-md border border-background-300 px-4 py-2 text-sm font-medium text-foreground-800 hover:bg-background-100"><i className="ri-arrow-left-line" aria-hidden="true" /> My HR</Link>
        </div>
        <div className="mt-6"><ClassTimetable who="trainer" /></div>
      </div>
    </div>
  );
}
