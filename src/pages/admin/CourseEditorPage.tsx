import { useMemo, useRef, useState } from "react";
import DraftStatus from "@/pages/admin/components/DraftStatus";
import { useDraft } from "@/pages/admin/lib/useDraft";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { Button, Card, Field, SectionTabs, Select, StatusBadge, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { WorkflowActions } from "@/pages/admin/components/workflow";
import RichTextEditor from "@/pages/admin/components/RichTextEditor";
import { courseCategories } from "@/pages/admin/lib/seed";
import type { AdminCourse } from "@/pages/admin/lib/types";
import { removeCmsObject, uploadCmsDocument } from "@/pages/admin/lib/storage";

const TABS = [
  { id: "basic", label: "Basic Info", icon: "ri-information-line" },
  { id: "overview", label: "Overview", icon: "ri-file-text-line" },
  { id: "requirements", label: "Entry Requirements", icon: "ri-checkbox-multiple-line" },
  { id: "structure", label: "Course Structure", icon: "ri-list-check-2" },
  { id: "units", label: "Units of Competency", icon: "ri-book-2-line" },
  { id: "delivery", label: "Duration / Delivery", icon: "ri-time-line" },
  { id: "fees", label: "Fees / Career", icon: "ri-money-dollar-circle-line" },
  { id: "media", label: "Media", icon: "ri-image-line" },
  { id: "attachments", label: "Attachments", icon: "ri-attachment-line" },
  { id: "links", label: "Links", icon: "ri-link-m" },
  { id: "publishing", label: "Publishing", icon: "ri-upload-cloud-line" },
];

export default function CourseEditorPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { data, update, saveNow, logActivity, recordRevision } = useAdminData();
  const { push } = useToast();

  const original = useMemo(() => data.courses.find((c) => c.slug === slug), [data.courses, slug]);
  const draftApi = useDraft<AdminCourse | null>("course", slug ?? "new", original ?? null);
  const draft = draftApi.value;
  const setDraft = draftApi.setValue;
  const dirty = draftApi.dirty;
  const [tab, setTab] = useState("basic");
  const [uploading, setUploading] = useState(false);
  const attachmentInput = useRef<HTMLInputElement>(null);

  if (!original || !draft) {
    return (
      <Card className="p-8 text-center">
        <p className="font-heading text-lg font-semibold text-foreground-900">Course not found</p>
        <p className="mt-1 text-sm text-foreground-500">It may have been deleted.</p>
        <div className="mt-4">
          <Button variant="outline" onClick={() => navigate("/admin/courses")}>
            Back to Courses
          </Button>
        </div>
      </Card>
    );
  }

  const set = <K extends keyof AdminCourse>(key: K, value: AdminCourse[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  const moveUnit = (index: number, dir: -1 | 1) => {
    if (!draft) return;
    const target = index + dir;
    if (target < 0 || target >= draft.units.length) return;
    const next = [...draft.units];
    [next[index], next[target]] = [next[target], next[index]];
    set("units", next);
  };

  const save = (publish?: boolean) => {
    if (!draft) return;
    const next: AdminCourse = {
      ...draft,
      status: publish === undefined ? draft.status : publish ? "Published" : "Draft",
      updatedAt: "2026-10-12 09:14",
      updatedBy: "IT Administrator",
    };
    update((d) => ({ ...d, courses: d.courses.map((c) => (c.id === next.id ? next : c)) }));
    recordRevision({
      entity: "course",
      entityId: next.id,
      title: next.name,
      action: publish === undefined ? "Updated" : publish ? "Published" : "Saved draft",
      status: next.status,
      snapshot: next,
    });
    logActivity(publish === undefined ? "Updated" : publish ? "Published" : "Saved draft", next.name, "Courses");
    draftApi.markSaved(next);
    push(publish === undefined ? "Course saved" : publish ? "Course published" : "Draft saved");
  };

  const uploadAttachment = async (file?: File) => {
    if (!file || !draft) return;
    setUploading(true);
    let stored: Awaited<ReturnType<typeof uploadCmsDocument>> | undefined;
    try {
      stored = await uploadCmsDocument(file, "courses", draft.id);
      const attachment = { id: stored.id, name: stored.originalFileName, url: stored.url, originalFileName: stored.originalFileName, storageFileName: stored.storageFileName, bucketName: stored.bucketName, storagePath: stored.storagePath, mimeType: stored.mimeType, fileSize: stored.fileSize };
      const next = { ...draft, attachments: [...draft.attachments, attachment] };
      await saveNow((state) => ({ ...state, courses: state.courses.map((course) => course.id === next.id ? next : course) }));
      draftApi.markSaved(next);
      push("File uploaded and attachment record verified.");
    } catch (error) {
      // Storage succeeded but row persistence failed: never leave a silent orphan.
      if (stored) await removeCmsObject(stored.bucketName, stored.storagePath).catch(() => undefined);
      push(error instanceof Error ? error.message : "Upload failed.", "error");
    }
    finally { setUploading(false); if (attachmentInput.current) attachmentInput.current.value = ""; }
  };

  const deleteAttachment = async (attachment: AdminCourse["attachments"][number]) => {
    if (!draft) return;
    try {
      const next = { ...draft, attachments: draft.attachments.filter((item) => item.id !== attachment.id) };
      await saveNow((state) => ({ ...state, courses: state.courses.map((course) => course.id === next.id ? next : course) }));
      try { await removeCmsObject(attachment.bucketName, attachment.storagePath); }
      catch (error) {
        await saveNow((state) => ({ ...state, courses: state.courses.map((course) => course.id === draft.id ? draft : course) }));
        throw error;
      }
      draftApi.markSaved(next);
      push("Attachment removed from Storage and the CMS.", "info");
    } catch (error) { push(error instanceof Error ? error.message : "Could not remove attachment.", "error"); }
  };

  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 border-b border-background-200 pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <Link to="/admin/courses" className="mb-1 inline-flex items-center gap-1 text-[13px] font-medium text-foreground-500 hover:text-primary-600">
            <i className="ri-arrow-left-line" aria-hidden="true" />
            Courses
          </Link>
          <h1 className="font-heading text-xl font-bold text-foreground-950">{draft.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <StatusBadge status={draft.status} />
            <DraftStatus draft={draftApi} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <WorkflowActions
            entity="course"
            entityId={draft.id}
            title={draft.name}
            dirty={dirty}
            previewHref={`/courses/${draft.slug}`}
            onSaveDraft={() => save(false)}
            onPublish={() => save(true)}
            onRestore={(snap) => {
              setDraft(snap as AdminCourse);
            }}
          />
        </div>
      </div>

      <SectionTabs tabs={TABS} active={tab} onChange={setTab} />

      <Card className="p-5 md:p-6">
        {tab === "basic" ? (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div className="md:col-span-2">
              <Field label="Course Name" required>
                <TextInput value={draft.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
            </div>
            <Field label="Course Code">
              <TextInput value={draft.code} onChange={(e) => set("code", e.target.value)} placeholder="e.g. MSF30422" />
            </Field>
            <Field label="CRICOS Code">
              <TextInput value={draft.cricos} onChange={(e) => set("cricos", e.target.value)} placeholder="e.g. 119813H" />
            </Field>
            <Field label="Category" required>
              <Select value={draft.category} onChange={(e) => set("category", e.target.value)}>
                {courseCategories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Training Package">
              <TextInput value={draft.trainingPackage} onChange={(e) => set("trainingPackage", e.target.value)} />
            </Field>
          </div>
        ) : null}

        {tab === "overview" ? (
          <div className="space-y-5">
            <Field label="Short Description" hint="Appears on course cards and in listings.">
              <TextArea rows={3} value={draft.shortDescription} onChange={(e) => set("shortDescription", e.target.value)} />
            </Field>
            <Field label="Full Description" hint="Main description shown on the course detail page. Use the toolbar for headings, bold, links and images.">
              <RichTextEditor value={draft.fullDescription} onChange={(html) => set("fullDescription", html)} minHeight={260} />
            </Field>
          </div>
        ) : null}

        {tab === "requirements" ? (
          <Field label="Entry Requirements">
            <TextArea rows={6} value={draft.entryRequirements} onChange={(e) => set("entryRequirements", e.target.value)} />
          </Field>
        ) : null}

        {tab === "structure" ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-heading text-base font-semibold text-foreground-950">Content Sections</h3>
                <p className="text-sm text-foreground-500">Structured sections shown on the course page. Empty sections are hidden on the website.</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                icon="ri-add-line"
                onClick={() => set("sections", [...draft.sections, { id: `sec-${Date.now()}`, title: "", body: "" }])}
              >
                Add section
              </Button>
            </div>
            {draft.sections.length === 0 ? (
              <p className="rounded-md border border-dashed border-background-300 px-4 py-6 text-center text-sm text-foreground-500">
                No sections yet. Add one to build out the course content.
              </p>
            ) : (
              draft.sections.map((s, i) => (
                <div key={s.id} className="rounded-md border border-background-200 p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <TextInput
                      value={s.title}
                      placeholder="Section title"
                      onChange={(e) =>
                        set("sections", draft.sections.map((x, xi) => (xi === i ? { ...x, title: e.target.value } : x)))
                      }
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Remove section"
                      onClick={() => set("sections", draft.sections.filter((_, xi) => xi !== i))}
                    >
                      <i className="ri-delete-bin-line" aria-hidden="true" />
                    </Button>
                  </div>
                  <RichTextEditor
                    value={s.body}
                    placeholder="Section content"
                    minHeight={120}
                    onChange={(html) =>
                      set("sections", draft.sections.map((x, xi) => (xi === i ? { ...x, body: html } : x)))
                    }
                  />
                </div>
              ))
            )}
          </div>
        ) : null}

        {tab === "units" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-heading text-base font-semibold text-foreground-950">Units of Competency</h3>
                <p className="text-sm text-foreground-500">
                  Structured unit list shown on the course page.{" "}
                  <strong className="font-semibold text-foreground-700">{draft.units.length}</strong> units.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                icon="ri-add-line"
                onClick={() =>
                  set("units", [...draft.units, { id: `unit-${Date.now()}`, code: "", name: "", category: "Core" }])
                }
              >
                Add unit
              </Button>
            </div>
            {draft.units.length === 0 ? (
              <p className="rounded-md border border-dashed border-background-300 px-4 py-6 text-center text-sm text-foreground-500">
                No units yet. Add the first unit of competency — it appears on the public course page immediately.
              </p>
            ) : (
              <div className="space-y-2">
                {draft.units.map((unit, index) => (
                  <div
                    key={unit.id}
                    className="grid grid-cols-1 gap-2 rounded-md border border-background-200 p-3 md:grid-cols-[28px_150px_1fr_150px_auto] md:items-center"
                  >
                    <div className="flex md:flex-col">
                      <button
                        type="button"
                        onClick={() => moveUnit(index, -1)}
                        aria-label="Move unit up"
                        className="flex h-5 w-5 cursor-pointer items-center justify-center text-foreground-400 hover:text-primary-600"
                      >
                        <i className="ri-arrow-up-s-fill" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveUnit(index, 1)}
                        aria-label="Move unit down"
                        className="flex h-5 w-5 cursor-pointer items-center justify-center text-foreground-400 hover:text-primary-600"
                      >
                        <i className="ri-arrow-down-s-fill" aria-hidden="true" />
                      </button>
                    </div>
                    <TextInput
                      value={unit.code}
                      placeholder="Unit code"
                      onChange={(e) =>
                        set("units", draft.units.map((x, xi) => (xi === index ? { ...x, code: e.target.value } : x)))
                      }
                    />
                    <TextInput
                      value={unit.name}
                      placeholder="Unit title / name"
                      onChange={(e) =>
                        set("units", draft.units.map((x, xi) => (xi === index ? { ...x, name: e.target.value } : x)))
                      }
                    />
                    <Select
                      value={unit.category}
                      onChange={(e) =>
                        set("units", draft.units.map((x, xi) => (xi === index ? { ...x, category: e.target.value } : x)))
                      }
                    >
                      <option value="Core">Core</option>
                      <option value="Elective">Elective</option>
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Remove unit"
                      onClick={() => set("units", draft.units.filter((_, xi) => xi !== index))}
                    >
                      <i className="ri-delete-bin-line" aria-hidden="true" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {tab === "delivery" ? (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <Field label="Duration">
              <TextInput value={draft.duration} onChange={(e) => set("duration", e.target.value)} placeholder="e.g. 52 Weeks" />
            </Field>
            <Field label="Mode of Study">
              <TextInput value={draft.mode} onChange={(e) => set("mode", e.target.value)} placeholder="e.g. Face-to-Face" />
            </Field>
          </div>
        ) : null}

        {tab === "fees" ? (
          <div className="space-y-5">
            <Field label="Fees Information">
              <TextArea rows={4} value={draft.fees} onChange={(e) => set("fees", e.target.value)} />
            </Field>
            <Field label="Career / Pathway Information">
              <TextArea rows={4} value={draft.career} onChange={(e) => set("career", e.target.value)} placeholder="Career outcomes and further study pathways" />
            </Field>
          </div>
        ) : null}

        {tab === "media" ? (
          <div className="space-y-4">
            <Field label="Course Image URL" hint="Used on the course card and detail page. Pull from the Media Library.">
              <TextInput value={draft.image} onChange={(e) => set("image", e.target.value)} placeholder="https://…" />
            </Field>
            <div className="flex aspect-[16/7] w-full max-w-md items-center justify-center overflow-hidden rounded-md border border-background-200 bg-background-100">
              {draft.image ? (
                <img src={draft.image} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="flex flex-col items-center gap-1 text-sm text-foreground-400">
                  <i className="ri-image-line text-2xl" aria-hidden="true" />
                  No image selected
                </span>
              )}
            </div>
          </div>
        ) : null}

        {tab === "attachments" ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-heading text-base font-semibold text-foreground-950">Attachments / PDFs</h3>
                <p className="text-sm text-foreground-500">Course outlines, fee schedules and other downloads.</p>
              </div>
              <input ref={attachmentInput} type="file" className="hidden" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.rtf,.csv" onChange={(event) => void uploadAttachment(event.target.files?.[0])} />
              <Button
                variant="outline"
                size="sm"
                icon={uploading ? "ri-loader-4-line animate-spin" : "ri-upload-2-line"}
                disabled={uploading}
                onClick={() => attachmentInput.current?.click()}
              >
                {uploading ? "Uploading…" : "Upload file"}
              </Button>
            </div>
            {draft.attachments.length === 0 ? (
              <p className="rounded-md border border-dashed border-background-300 px-4 py-6 text-center text-sm text-foreground-500">
                No attachments. The website will not show a downloads section.
              </p>
            ) : (
              draft.attachments.map((a, i) => (
                <div key={a.id} className="flex items-center gap-2">
                  <i className="ri-file-pdf-2-line text-lg text-primary-600" aria-hidden="true" />
                  <div className="min-w-0 flex-1"><a href={a.url} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium text-primary-600 hover:underline">{a.name}</a><p className="text-xs text-foreground-500">{a.mimeType || "Document"}{a.fileSize ? ` · ${(a.fileSize / 1024).toFixed(1)} KB` : ""}</p></div>
                  <Button variant="ghost" size="sm" aria-label="Remove" onClick={() => void deleteAttachment(a)}>
                    <i className="ri-delete-bin-line" aria-hidden="true" />
                  </Button>
                </div>
              ))
            )}
          </div>
        ) : null}

        {tab === "links" ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-heading text-base font-semibold text-foreground-950">Course Links</h3>
                <p className="text-sm text-foreground-500">Related pages or external links for this course.</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                icon="ri-add-line"
                onClick={() => set("links", [...draft.links, { id: `lnk-${Date.now()}`, label: "", url: "", external: false }])}
              >
                Add link
              </Button>
            </div>
            {draft.links.length === 0 ? (
              <p className="rounded-md border border-dashed border-background-300 px-4 py-6 text-center text-sm text-foreground-500">
                No links. Empty link blocks are hidden on the website.
              </p>
            ) : (
              draft.links.map((l, i) => (
                <div key={l.id} className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_2fr_auto]">
                  <TextInput value={l.label} placeholder="Label" onChange={(e) => set("links", draft.links.map((x, xi) => (xi === i ? { ...x, label: e.target.value } : x)))} />
                  <TextInput value={l.url} placeholder="URL" onChange={(e) => set("links", draft.links.map((x, xi) => (xi === i ? { ...x, url: e.target.value } : x)))} />
                  <div className="flex items-center gap-2">
                    <Toggle checked={l.external} onChange={(v) => set("links", draft.links.map((x, xi) => (xi === i ? { ...x, external: v } : x)))} label="External" />
                    <Button variant="ghost" size="sm" aria-label="Remove" onClick={() => set("links", draft.links.filter((_, xi) => xi !== i))}>
                      <i className="ri-delete-bin-line" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}

        {tab === "publishing" ? (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div className="space-y-4">
              <Field label="Display Order" hint="Lower numbers appear first on the website.">
                <TextInput type="number" min={1} value={draft.displayOrder} onChange={(e) => set("displayOrder", Number(e.target.value))} />
              </Field>
              <div className="rounded-md border border-background-200 p-4">
                <Toggle checked={draft.featured} onChange={(v) => set("featured", v)} label="Featured on homepage" />
                <p className="mt-1.5 text-xs text-foreground-500">Featured courses appear in the homepage course section.</p>
              </div>
            </div>
            <div className="space-y-4">
              <Field label="Status">
                <Select value={draft.status} onChange={(e) => set("status", e.target.value as AdminCourse["status"])}>
                  <option value="Published">Published</option>
                  <option value="Draft">Draft</option>
                </Select>
              </Field>
              <p className="text-xs text-foreground-500">
                Last updated by {draft.updatedBy} on {draft.updatedAt}.
              </p>
            </div>
          </div>
        ) : null}
      </Card>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => save(false)}>
          Save draft
        </Button>
        <Button icon="ri-check-line" onClick={() => save(true)}>
          Publish
        </Button>
      </div>
    </div>
  );
}
