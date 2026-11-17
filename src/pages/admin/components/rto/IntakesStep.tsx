// Course wizard › Intakes: the course's intakes as cards. A card opens the intake (timeline, batches, students) in a sheet.
import { IntakesView } from "@/pages/admin/components/rto/IntakeCards";
import ClassDefaults from "@/pages/admin/components/rto/ClassDefaults";
import NeedsBatch from "@/pages/admin/components/rto/NeedsBatch";
import { sortIntakes, type CourseDetail } from "@/pages/admin/lib/rto";

export default function IntakesStep({ detail, canEdit, canEnrol, onChanged }: { detail: CourseDetail; canEdit: boolean; canEnrol: boolean; onChanged: () => void }) {
  return (
    <div className="w-full min-w-0">
      <NeedsBatch courseId={detail.course.id} canEnrol={canEnrol} onPlaced={onChanged} />
      <ClassDefaults courseId={detail.course.id} canEdit={canEdit} />
      <IntakesView intakes={sortIntakes(detail.intakes)} loading={false} courseId={detail.course.id} canEdit={canEdit} canEnrol={canEnrol} showCourse={false} onReload={onChanged}
        empty={{ title: "No intakes yet", text: canEdit ? "Create the first intake: pick a start date and the timeline is laid out from this course's units." : "An RTO Manager creates intakes." }} />
    </div>
  );
}
