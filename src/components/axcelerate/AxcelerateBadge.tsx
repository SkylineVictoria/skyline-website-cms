import { useEffect, useState } from "react";
import { Badge } from "@/pages/admin/components/ui";
import { recordBadge } from "@/lib/axcelerateImport";

/**
 * "Imported from aXcelerate on <date>" (AXCELERATE-IMPORT). Information only: it never locks the record or limits what admins can do.
 * table: the Skyline table as the import records it (e.g. "hr.staff_profiles", "public.course_intakes").
 */
export default function AxcelerateBadge({ table, id }: { table: string; id: string | null | undefined }) {
  const [info, setInfo] = useState<{ importedAt: string; editedInSkylineAt: string | null } | null>(null);
  useEffect(() => { let live = true; if (id) void recordBadge(table, id).then((v) => { if (live) setInfo(v); }); return () => { live = false; }; }, [table, id]);
  if (!info) return null;
  const title = `Imported from aXcelerate on ${new Date(info.importedAt).toLocaleDateString()}${info.editedInSkylineAt ? `; changed in Skyline on ${new Date(info.editedInSkylineAt).toLocaleDateString()}` : ""}`;
  return <span title={title} data-testid="axcelerate-badge"><Badge tone="secondary">Imported from aXcelerate {new Date(info.importedAt).toLocaleDateString()}</Badge></span>;
}
