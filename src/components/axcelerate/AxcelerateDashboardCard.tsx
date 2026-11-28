import { Link } from "react-router-dom";
import { Card } from "@/pages/admin/components/ui";
import AxcelerateImportButton from "@/components/axcelerate/AxcelerateImportButton";
import { ALL_ENTITIES, useImportAllowed } from "@/lib/axcelerateImport";

/** Dashboard "Import everything" (AXCELERATE-IMPORT): every page's import, in order, with the same engine. Permission holders only. */
export default function AxcelerateDashboardCard() {
  const allowed = useImportAllowed();
  if (!allowed) return null;
  return (
    <Card className="mb-6 flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between" data-testid="axcelerate-dashboard-card">
      <div>
        <h2 className="font-heading text-base font-semibold text-foreground-950">Import everything from aXcelerate</h2>
        <p className="mt-1 text-sm text-foreground-600">
          Brings campuses, courses, trainers, classes, breaks, agents and students (with their Qualifications) into Skyline, in that order, so every record finds what it needs. Nothing is sent to aXcelerate.{" "}
          <Link className="font-medium text-primary-700 hover:underline" to="/admin/integrations/axcelerate">Import centre</Link>
        </p>
      </div>
      <AxcelerateImportButton entities={ALL_ENTITIES} mode="everything" label="Import everything" variant="primary" />
    </Card>
  );
}
