import { PageHeading } from "@/pages/agency/components/PortalUI";
import ClassTimetable from "@/components/timetable/ClassTimetable";

/** Student portal > My timetable: this week's classes with unit, room and trainer. */
export default function StudentTimetablePage() {
  return (
    <div>
      <PageHeading eyebrow="Timetable" title="My timetable" description="Your classes for the week: time, unit, room and trainer. Cancelled classes are marked." />
      <div className="mt-6"><ClassTimetable who="student" /></div>
    </div>
  );
}
