import { useState } from "react";
import { Button, PageHeader } from "@/pages/admin/components/ui";
import StudentsTable from "@/pages/admin/components/StudentsTable";
import AddStudentDialog from "@/pages/admin/components/AddStudentDialog";
import AxcelerateStudentsImport from "@/components/axcelerate/AxcelerateStudentsImport";

/** Agencies > Students: every student across businesses, with their applications by status. */
export default function StudentsPage() {
  const [adding, setAdding] = useState(false);
  const [refresh, setRefresh] = useState(0);
  return (
    <div>
      <PageHeader title="Students" description="Every student, with their business and agent. Add a student here; start their applications from Applications."
        actions={<div className="flex flex-wrap gap-2"><AxcelerateStudentsImport onDone={() => setRefresh((n) => n + 1)} /><Button icon="ri-user-add-line" onClick={() => setAdding(true)}>Add student</Button></div>} />
      <StudentsTable refreshKey={refresh} />
      <AddStudentDialog open={adding} onClose={() => setAdding(false)} onAdded={() => setRefresh((n) => n + 1)} />
    </div>
  );
}
