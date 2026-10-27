import { Link } from "react-router-dom";
import { useAuth } from "@/pages/admin/lib/authContext";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { Badge, Card, EmptyState, PageHeader, StatCard, StatusBadge } from "@/pages/admin/components/ui";

const QUICK_ACTIONS = [
  { label: "Add Course", to: "/admin/courses", icon: "ri-add-circle-line" },
  { label: "Create Page", to: "/admin/pages", icon: "ri-file-add-line" },
  { label: "Upload Document", to: "/admin/documents", icon: "ri-upload-cloud-line" },
  { label: "Edit Contact Info", to: "/admin/contact", icon: "ri-contacts-line" },
  { label: "Edit Homepage", to: "/admin/pages", icon: "ri-home-4-line" },
  { label: "Manage Forms", to: "/admin/forms", icon: "ri-survey-line" },
];

export default function DashboardPage() {
  const { user } = useAuth();
  const { data } = useAdminData();

  const publishedPages = data.pages.filter((p) => p.status === "Published").length;
  const draftPages = data.pages.filter((p) => p.status !== "Published").length;
  const publishedDocs = data.documents.filter((d) => d.status === "Published").length;
  const featured = data.courses.filter((c) => c.featured).length;

  const recentContent = [...data.courses]
    .map((c) => ({ name: c.name, area: "Courses", status: c.status, at: c.updatedAt, by: c.updatedBy }))
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 4);

  return (
    <div>
      <PageHeader
        title={`Welcome back, ${user?.name.split(" ")[0] ?? "there"}`}
        description="An overview of what's on the Skyline website and what changed recently."
        breadcrumb="Dashboard"
        actions={
          <Link
            to="/"
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-4 py-2 text-sm font-medium text-foreground-800 hover:bg-background-100"
          >
            <i className="ri-external-link-line" aria-hidden="true" />
            View website
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Courses" value={data.courses.length} icon="ri-book-2-line" hint={`${featured} featured on homepage`} />
        <StatCard label="Published Pages" value={publishedPages} icon="ri-file-text-line" hint={`${draftPages} draft`} />
        <StatCard label="Published Documents" value={publishedDocs} icon="ri-file-pdf-2-line" hint={`${data.documents.length} total`} />
        <StatCard label="Forms Available" value={data.forms.length} icon="ri-survey-line" hint={`${data.documents.length} documents`} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-3">
        {/* Quick actions */}
        <Card className="p-5 xl:col-span-1">
          <h2 className="mb-4 font-heading text-base font-semibold text-foreground-950">Quick actions</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1">
            {QUICK_ACTIONS.map((a) => (
              <Link
                key={a.label}
                to={a.to}
                className="flex items-center gap-2.5 rounded-md border border-background-200 px-3 py-2.5 text-[13px] font-medium text-foreground-800 transition-colors hover:border-primary-300 hover:bg-primary-50"
              >
                <i className={`${a.icon} text-lg text-primary-600`} aria-hidden="true" />
                {a.label}
              </Link>
            ))}
          </div>
        </Card>

        {/* Recently modified */}
        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-heading text-base font-semibold text-foreground-950">Recently modified content</h2>
            <Link to="/admin/courses" className="text-[13px] font-medium text-primary-600 hover:underline">
              Manage courses
            </Link>
          </div>
          <div className="divide-y divide-background-200">
            {recentContent.length === 0 ? (
              <EmptyState
                icon="ri-file-edit-line"
                title="Nothing edited yet"
                description="Create or edit a course and it will show up here."
              />
            ) : (
              recentContent.map((c) => (
                <div key={c.name} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-foreground-900">{c.name}</p>
                    <p className="mt-0.5 text-xs text-foreground-500">
                      {c.area} · updated by {c.by} on {c.at}
                    </p>
                  </div>
                  <StatusBadge status={c.status} />
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* Recent activity */}
      <Card className="mt-6 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-heading text-base font-semibold text-foreground-950">Recent activity</h2>
          <Link to="/admin/activity" className="text-[13px] font-medium text-primary-600 hover:underline">
            View full log
          </Link>
        </div>
        <div className="divide-y divide-background-200">
          {data.activity.length === 0 ? (
            <EmptyState
              icon="ri-history-line"
              title="No activity yet"
              description="Actions you take in the CMS will be recorded here."
            />
          ) : (
            data.activity.slice(0, 6).map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-[13px]">
                <Badge tone="secondary">{a.area}</Badge>
                <span className="font-medium text-foreground-900">{a.user}</span>
                <span className="text-foreground-600">{a.action}</span>
                <span className="min-w-0 flex-1 truncate text-foreground-700">{a.item}</span>
                <span className="text-xs text-foreground-400">{a.at}</span>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}