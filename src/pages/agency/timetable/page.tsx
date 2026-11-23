import { PageHeading } from "@/pages/agency/components/PortalUI";
import StudentTimetable from "@/components/timetable/StudentTimetable";

/** Student portal > My timetable: the weekly calendar (units by week) and the daily timetable (the week of classes), as staff see them. */
export default function StudentTimetablePage() {
  return (
    <div>
      <PageHeading eyebrow="Timetable" title="My timetable" description="Your weekly calendar (which unit each week) and your daily timetable (your classes, rooms and trainers)." />
      <div className="mt-6"><StudentTimetable /></div>
    </div>
  );
}
