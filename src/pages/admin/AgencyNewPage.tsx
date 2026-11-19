import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Card, PageHeader } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import AddBusinessForm from "@/pages/admin/components/AddBusinessForm";
import { queryAgencyDirectory, type DirectoryAgency } from "@/pages/agency/lib/portalData";

/**
 * Businesses > Add business. The form itself (ABN lookup, point of contact) is shared with every other place a
 * business is added, so there is one workflow.
 */
export default function AgencyNewPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const directoryKey = params.get("directory") ?? "";
  const { push } = useToast();

  // A link from the Agencies directory points at one listed business: send it to its existing record instead.
  const [directory, setDirectory] = useState<DirectoryAgency | null>(null);
  useEffect(() => {
    if (!directoryKey) return;
    let cancelled = false;
    queryAgencyDirectory({ key: directoryKey, limit: 1, offset: 0 })
      .then(result => { if (!cancelled) setDirectory(result.rows[0] ?? null); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [directoryKey]);

  return (
    <div>
      <PageHeader breadcrumb="Businesses > Add business" title="Add business"
        description="Enter the business's ABN. Its registered details are filled from the government register; then add the point of contact, who becomes the business's administrator. The business is created active." />
      {directory ? (
        <Card className="mb-5 p-5 text-sm">
          <p role="status">{directory.existingAgencyId ? `${directory.name} is already added.` : `${directory.name} is in the OMARA register. Activate it in Businesses so its registered agents stay linked.`}</p>
          <Link className="mt-2 inline-block font-medium text-primary-700 underline" to={directory.existingAgencyId ? `/admin/agencies/${directory.existingAgencyId}` : `/admin/businesses?q=${encodeURIComponent(directory.name)}`}>
            {directory.existingAgencyId ? "Open existing business" : "Open in Businesses"}
          </Link>
        </Card>
      ) : null}
      <AddBusinessForm
        onCreated={({ agencyId, message }) => { push(message); navigate(`/admin/businesses/${agencyId}?prepare=1`, { replace: true }); }}
        cancel={<Link to="/admin/businesses" className="text-sm font-medium text-foreground-600 hover:text-foreground-900">Cancel</Link>}
      />
    </div>
  );
}
