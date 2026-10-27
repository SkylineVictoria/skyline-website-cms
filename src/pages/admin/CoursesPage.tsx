import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { useToast } from "@/pages/admin/components/toastContext";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  PageHeader,
  Select,
  StatusBadge,
  TextInput,
  Toggle,
} from "@/pages/admin/components/ui";
import type { AdminCourse } from "@/pages/admin/lib/types";
import { courseCategories } from "@/pages/admin/lib/seed";

type SortKey = "order" | "name" | "updated";

const FEATURED_LIMIT = 6;

export default function CoursesPage() {
  const { data, update, logActivity } = useAdminData();
  const { push } = useToast();
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [status, setStatus] = useState("All");
  const [featuredOnly, setFeaturedOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("order");
  const [pendingDelete, setPendingDelete] = useState<AdminCourse | null>(null);

  const categories = ["All", ...courseCategories];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = data.courses.filter((c) => {
      const matchesQuery =
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        c.cricos.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q);
      const matchesCat = category === "All" || c.category === category;
      const matchesStatus = status === "All" || c.status === status;
      const matchesFeatured = !featuredOnly || c.featured;
      return matchesQuery && matchesCat && matchesStatus && matchesFeatured;
    });
    list = [...list].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "updated") return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.displayOrder - b.displayOrder;
    });
    return list;
  }, [data.courses, query, category, status, featuredOnly, sort]);

  const move = (course: AdminCourse, dir: -1 | 1) => {
    const ordered = [...data.courses].sort((a, b) => a.displayOrder - b.displayOrder);
    const idx = ordered.findIndex((c) => c.id === course.id);
    const target = idx + dir;
    if (target < 0 || target >= ordered.length) return;
    [ordered[idx], ordered[target]] = [ordered[target], ordered[idx]];
    const reordered = ordered.map((c, i) => ({ ...c, displayOrder: i + 1 }));
    update((d) => ({ ...d, courses: reordered }));
    logActivity("Reordered", course.name, "Courses");
  };

  const toggleFeatured = (course: AdminCourse) => {
    const featuredCount = data.courses.filter((c) => c.featured).length;
    if (!course.featured && featuredCount >= FEATURED_LIMIT) {
      push(
        `The homepage shows up to ${FEATURED_LIMIT} featured courses. Turn one off before featuring another.`,
        "error",
      );
      return;
    }
    update((d) => ({
      ...d,
      courses: d.courses.map((c) => (c.id === course.id ? { ...c, featured: !c.featured } : c)),
    }));
    push(course.featured ? "Removed from homepage" : "Added to homepage");
    logActivity(course.featured ? "Unfeatured" : "Featured", course.name, "Courses");
  };

  const toggleStatus = (course: AdminCourse) => {
    const next = course.status === "Published" ? "Draft" : "Published";
    update((d) => ({
      ...d,
      courses: d.courses.map((c) =>
        c.id === course.id ? { ...c, status: next, updatedAt: "2026-10-12 09:14", updatedBy: "IT Administrator" } : c,
      ),
    }));
    push(`Course ${next.toLowerCase()}`);
    logActivity(next === "Published" ? "Published" : "Unpublished", course.name, "Courses");
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    update((d) => ({ ...d, courses: d.courses.filter((c) => c.id !== pendingDelete.id) }));
    logActivity("Deleted", pendingDelete.name, "Courses");
    push("Course deleted", "info");
    setPendingDelete(null);
  };

  const addCourse = () => {
    const id = `course-${Date.now()}`;
    const slug = `new-course-${Date.now()}`;
    const created: AdminCourse = {
      id,
      slug,
      code: "",
      cricos: "",
      name: "New Course",
      category: courseCategories[0],
      trainingPackage: "",
      duration: "52 Weeks",
      mode: "Face-to-Face",
      shortDescription: "",
      fullDescription: "",
      entryRequirements: "Over 18 years of age",
      career: "",
      fees: "",
      image: "",
      attachments: [],
      links: [],
      sections: [],
      units: [],
      status: "Draft",
      displayOrder: data.courses.length + 1,
      featured: false,
      updatedAt: "2026-10-12 09:14",
      updatedBy: "IT Administrator",
    };
    update((d) => ({ ...d, courses: [...d.courses, created] }));
    logActivity("Created", created.name, "Courses");
    push("New draft course created");
    navigate(`/admin/courses/${slug}`);
  };

  return (
    <div>
      <PageHeader
        title="Courses"
        description="Manage every course, its content, media, ordering and homepage visibility."
        breadcrumb="Content"
        actions={
          <Button icon="ri-add-line" onClick={addCourse}>
            Add Course
          </Button>
        }
      />

      {/* Filters */}
      <Card className="mb-5 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <i className="ri-search-line absolute left-3 top-1/2 -translate-y-1/2 text-foreground-400" aria-hidden="true" />
            <TextInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, code or CRICOS…"
              className="pl-9"
            />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:flex">
            <Select value={category} onChange={(e) => setCategory(e.target.value)} className="lg:w-44">
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c === "All" ? "All categories" : c}
                </option>
              ))}
            </Select>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="lg:w-36">
              <option value="All">All status</option>
              <option value="Published">Published</option>
              <option value="Draft">Draft</option>
            </Select>
            <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="lg:w-40">
              <option value="order">Display order</option>
              <option value="name">Name (A–Z)</option>
              <option value="updated">Recently updated</option>
            </Select>
            <div className="flex items-center px-1">
              <Toggle checked={featuredOnly} onChange={setFeaturedOnly} label="Featured" />
            </div>
          </div>
        </div>
      </Card>

      <Card>
        {filtered.length === 0 ? (
          <EmptyState
            icon="ri-search-line"
            title="No courses match your filters"
            description="Try clearing the search or selecting a different category."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-background-200 text-xs uppercase tracking-wide text-foreground-500">
                  <th className="px-4 py-3 font-medium">Order</th>
                  <th className="px-4 py-3 font-medium">Course</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Homepage</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-background-200">
                {filtered.map((c) => (
                  <tr key={c.id} className="align-middle hover:bg-background-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <span className="w-5 text-center text-[13px] font-semibold text-foreground-700">
                          {c.displayOrder}
                        </span>
                        <div className="flex flex-col">
                          <button
                            type="button"
                            onClick={() => move(c, -1)}
                            aria-label="Move up"
                            className="flex h-4 w-4 cursor-pointer items-center justify-center text-foreground-400 hover:text-primary-600"
                          >
                            <i className="ri-arrow-up-s-fill text-sm" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => move(c, 1)}
                            aria-label="Move down"
                            className="flex h-4 w-4 cursor-pointer items-center justify-center text-foreground-400 hover:text-primary-600"
                          >
                            <i className="ri-arrow-down-s-fill text-sm" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-10 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-background-100">
                          {c.image ? (
                            <img src={c.image} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <i className="ri-image-line text-foreground-400" aria-hidden="true" />
                          )}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium text-foreground-900">{c.name}</p>
                          <p className="mt-0.5 text-xs text-foreground-500">
                            {c.code || "No code"} {c.cricos ? `· CRICOS ${c.cricos}` : ""}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone="secondary">{c.category}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <button type="button" onClick={() => toggleStatus(c)} className="cursor-pointer">
                        <StatusBadge status={c.status} />
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <Toggle checked={c.featured} onChange={() => toggleFeatured(c)} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          to={`/courses/${c.slug}`}
                          target="_blank"
                          aria-label="Preview on website"
                          className="flex h-8 w-8 items-center justify-center rounded-md text-foreground-500 hover:bg-background-100"
                        >
                          <i className="ri-eye-line" aria-hidden="true" />
                        </Link>
                        <Link
                          to={`/admin/courses/${c.slug}`}
                          aria-label="Edit"
                          className="flex h-8 w-8 items-center justify-center rounded-md text-foreground-500 hover:bg-background-100"
                        >
                          <i className="ri-pencil-line" aria-hidden="true" />
                        </Link>
                        <button
                          type="button"
                          onClick={() => setPendingDelete(c)}
                          aria-label="Delete"
                          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-500 hover:bg-background-100"
                        >
                          <i className="ri-delete-bin-line" aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="mt-3 text-xs text-foreground-500">
        Showing {filtered.length} of {data.courses.length} courses. Use the arrows to set display order —
        the public website lists courses in this order.{" "}
        <strong className="font-semibold text-foreground-700">
          {data.courses.filter((c) => c.featured).length}/{FEATURED_LIMIT}
        </strong>{" "}
        courses are featured on the homepage.
      </p>

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete course"
        message={`Delete "${pendingDelete?.name}"? This removes it from the website and cannot be undone.`}
        confirmLabel="Delete course"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}