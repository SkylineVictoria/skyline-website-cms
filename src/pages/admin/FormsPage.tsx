import { Link, useNavigate } from "react-router-dom";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { Badge, Button, Card, PageHeader, StatusBadge } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import type { AdminForm } from "@/pages/admin/lib/types";
import { HistoryButton } from "@/pages/admin/components/workflow";

export default function FormsPage() {
  const { data, update, logActivity } = useAdminData();
  const { push } = useToast();
  const navigate = useNavigate();

  const createForm = () => {
    const id = `form-${Date.now()}`;
    const next: AdminForm = {
      id,
      name: "New Form",
      description: "Describe what this form is for.",
      fields: [],
      status: "Draft",
      updatedAt: "2026-10-12 09:14",
    };
    update((d) => ({ ...d, forms: [...d.forms, next] }));
    logActivity("Created", next.name, "Forms");
    push("New form created");
    navigate(`/admin/forms/${id}`);
  };

  return (
    <div>
      <PageHeader
        title="Forms"
        description="The forms published on the website — Enroll Now, Become an Agent, Contact Us and any you add here."
        breadcrumb="Content"
        actions={
          <Button icon="ri-add-line" onClick={createForm}>
            Create form
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.forms.map((f) => (
          <Card key={f.id} className="flex flex-col p-5">
            <div className="flex items-start justify-between gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
                <i className="ri-survey-line text-xl" aria-hidden="true" />
              </span>
              <StatusBadge status={f.status} />
            </div>
            <h2 className="mt-3 font-heading text-base font-semibold text-foreground-950">{f.name}</h2>
            <p className="mt-1 flex-1 text-[13px] text-foreground-600">{f.description}</p>
            <div className="mt-4 flex items-center justify-between border-t border-background-200 pt-3">
              <Badge tone="secondary">
                <i className="ri-list-check-2" aria-hidden="true" />
                {f.fields.length} fields
              </Badge>
              <div className="flex items-center gap-1">
                <HistoryButton entity="form" entityId={f.id} title={f.name} />
                {f.status === "Published" ? (
                  <Link
                    to={`/forms/${f.id}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="View on website"
                    title={`Live at /forms/${f.id}`}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-foreground-500 hover:bg-background-100"
                  >
                    <i className="ri-external-link-line" aria-hidden="true" />
                  </Link>
                ) : (
                  <span
                    title="Draft — not visible on the website"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-foreground-300"
                  >
                    <i className="ri-eye-off-line" aria-hidden="true" />
                  </span>
                )}
                <Link
                  to={`/admin/forms/${f.id}`}
                  className="inline-flex items-center gap-1 text-[13px] font-medium text-primary-600 hover:underline"
                >
                  Edit form
                  <i className="ri-arrow-right-line" aria-hidden="true" />
                </Link>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}