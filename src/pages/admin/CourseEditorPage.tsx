import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import DraftStatus from "@/pages/admin/components/DraftStatus";
import { useDraft } from "@/pages/admin/lib/useDraft";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { Button, Card, Field, Select, StatusBadge, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { WorkflowActions } from "@/pages/admin/components/workflow";
import RichTextEditor from "@/pages/admin/components/RichTextEditor";
import type { AdminCourse } from "@/pages/admin/lib/types";
import { removeCmsObject, uploadCmsDocument } from "@/pages/admin/lib/storage";
import { NationalCourseFields, SkylineStatusBadge } from "@/pages/admin/components/CourseCatalogue";
import { fetchCatalogueCourse, type CatalogueCourse } from "@/pages/admin/lib/courseCatalogue";

// One page with sections (the old twelve tabs). Facts are read-only here: they are edited in Master Data › Courses.
const SECTIONS = [
  { id: "overview", label: "Overview", icon: "ri-file-text-line" },
  { id: "requirements", label: "Requirements & Career", icon: "ri-checkbox-multiple-line" },
  { id: "media", label: "Media & Files", icon: "ri-image-line" },
  { id: "facts", label: "Facts", icon: "ri-information-line" },
  { id: "publishing", label: "Publishing", icon: "ri-upload-cloud-line" },
];

function Section({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="scroll-mt-16 p-5 md:p-6">
      <section id={`course-${id}`} aria-label={title}>
        <div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-heading text-lg font-semibold text-foreground-950">{title}</h2>{action}</div>
        {children}
      </section>
    </Card>
  );
}

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
  const [uploading, setUploading] = useState(false);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const [national, setNational] = useState<CatalogueCourse | null>(null);
  const savedCode = original?.code ?? "";

  // National reference record for the saved course code (read-only; owned by training.gov.au sync).
  useEffect(() => {
    let live = true;
    setNational(null);
    fetchCatalogueCourse(savedCode)
      .then((c) => { if (live) setNational(c); })
      .catch(() => { if (live) setNational(null); });
    return () => { live = false; };
  }, [savedCode]);

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

  const courseLink = (tab: string) => `/admin/course-fees/${encodeURIComponent(draft.id)}?tab=${tab}`;

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

      <nav className="sticky top-0 z-10 -mx-1 mb-4 flex flex-wrap gap-2 bg-background-100/95 px-1 py-2 backdrop-blur" aria-label="Sections">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" onClick={() => document.getElementById(`course-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="inline-flex items-center gap-1.5 rounded-full border border-background-300 bg-background-50 px-3.5 py-1.5 text-[13px] font-medium text-foreground-700 hover:bg-background-100">
            <i className={`${s.icon} text-sm`} aria-hidden="true" />{s.label}
          </button>
        ))}
      </nav>

      <div className="space-y-5">
        <Section id="overview" title="Overview">
          <div className="space-y-5">
            <Field label="Short Description" hint="Appears on course cards and in listings.">
              <TextArea rows={3} value={draft.shortDescription} onChange={(e) => set("shortDescription", e.target.value)} />
            </Field>
            <Field label="Full Description" hint="Main description shown on the course detail page. Use the toolbar for headings, bold, links and images.">
              <RichTextEditor value={draft.fullDescription} onChange={(html) => set("fullDescription", html)} minHeight={260} />
            </Field>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-heading text-base font-semibold text-foreground-950">Content Sections</h3>
                <p className="text-sm text-foreground-500">Structured sections shown on the course page. Empty sections are hidden on the website.</p>
              </div>
              <Button variant="outline" size="sm" icon="ri-add-line" onClick={() => set("sections", [...draft.sections, { id: `sec-${Date.now()}`, title: "", body: "" }])}>Add section</Button>
            </div>
            {draft.sections.map((s, i) => (
              <div key={s.id} className="rounded-md border border-background-200 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <TextInput value={s.title} placeholder="Section title" onChange={(e) => set("sections", draft.sections.map((x, xi) => (xi === i ? { ...x, title: e.target.value } : x)))} />
                  <Button variant="ghost" size="sm" aria-label="Remove section" onClick={() => set("sections", draft.sections.filter((_, xi) => xi !== i))}><i className="ri-delete-bin-line" aria-hidden="true" /></Button>
                </div>
                <RichTextEditor value={s.body} placeholder="Section content" minHeight={120} onChange={(html) => set("sections", draft.sections.map((x, xi) => (xi === i ? { ...x, body: html } : x)))} />
              </div>
            ))}
          </div>
        </Section>

        <Section id="requirements" title="Requirements & Career">
          <div className="space-y-5">
            <Field label="Entry Requirements"><TextArea rows={6} value={draft.entryRequirements} onChange={(e) => set("entryRequirements", e.target.value)} /></Field>
            <Field label="Career / Pathway Information"><TextArea rows={4} value={draft.career} onChange={(e) => set("career", e.target.value)} placeholder="Career outcomes and further study pathways" /></Field>
          </div>
        </Section>

        <Section id="media" title="Media & Files">
          <div className="space-y-6">
            <div className="space-y-4">
              <Field label="Course Image URL" hint="Used on the course card and detail page. Pull from the Media Library.">
                <TextInput value={draft.image} onChange={(e) => set("image", e.target.value)} placeholder="https://…" />
              </Field>
              <div className="flex aspect-[16/7] w-full max-w-md items-center justify-center overflow-hidden rounded-md border border-background-200 bg-background-100">
                {draft.image ? <img src={draft.image} alt="" className="h-full w-full object-cover" /> : <span className="flex flex-col items-center gap-1 text-sm text-foreground-400"><i className="ri-image-line text-2xl" aria-hidden="true" />No image selected</span>}
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div><h3 className="font-heading text-base font-semibold text-foreground-950">Attachments / PDFs</h3><p className="text-sm text-foreground-500">Course outlines, fee schedules and other downloads.</p></div>
                <input ref={attachmentInput} type="file" className="hidden" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.rtf,.csv" onChange={(event) => void uploadAttachment(event.target.files?.[0])} />
                <Button variant="outline" size="sm" icon={uploading ? "ri-loader-4-line animate-spin" : "ri-upload-2-line"} disabled={uploading} onClick={() => attachmentInput.current?.click()}>{uploading ? "Uploading…" : "Upload file"}</Button>
              </div>
              {draft.attachments.length === 0 ? <p className="rounded-md border border-dashed border-background-300 px-4 py-4 text-center text-sm text-foreground-500">No attachments. The website will not show a downloads section.</p> : draft.attachments.map((a) => (
                <div key={a.id} className="flex items-center gap-2">
                  <i className="ri-file-pdf-2-line text-lg text-primary-600" aria-hidden="true" />
                  <div className="min-w-0 flex-1"><a href={a.url} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium text-primary-600 hover:underline">{a.name}</a><p className="text-xs text-foreground-500">{a.mimeType || "Document"}{a.fileSize ? ` · ${(a.fileSize / 1024).toFixed(1)} KB` : ""}</p></div>
                  <Button variant="ghost" size="sm" aria-label="Remove" onClick={() => void deleteAttachment(a)}><i className="ri-delete-bin-line" aria-hidden="true" /></Button>
                </div>
              ))}
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div><h3 className="font-heading text-base font-semibold text-foreground-950">Course Links</h3><p className="text-sm text-foreground-500">Related pages or external links for this course.</p></div>
                <Button variant="outline" size="sm" icon="ri-add-line" onClick={() => set("links", [...draft.links, { id: `lnk-${Date.now()}`, label: "", url: "", external: false }])}>Add link</Button>
              </div>
              {draft.links.map((l, i) => (
                <div key={l.id} className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_2fr_auto]">
                  <TextInput value={l.label} placeholder="Label" onChange={(e) => set("links", draft.links.map((x, xi) => (xi === i ? { ...x, label: e.target.value } : x)))} />
                  <TextInput value={l.url} placeholder="URL" onChange={(e) => set("links", draft.links.map((x, xi) => (xi === i ? { ...x, url: e.target.value } : x)))} />
                  <div className="flex items-center gap-2">
                    <Toggle checked={l.external} onChange={(v) => set("links", draft.links.map((x, xi) => (xi === i ? { ...x, external: v } : x)))} label="External" />
                    <Button variant="ghost" size="sm" aria-label="Remove" onClick={() => set("links", draft.links.filter((_, xi) => xi !== i))}><i className="ri-delete-bin-line" aria-hidden="true" /></Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Section>

        <Section id="facts" title="Facts" action={<Link to={courseLink("course")} className="text-sm font-medium text-primary-600 hover:underline">Edit in Course</Link>}>
          <div className="space-y-4">
            <p className="text-sm text-foreground-500">Name, codes, units, duration, fees and intakes come from the course record and are shown on the website as they are there.</p>
            {national ? <div className="space-y-2"><div className="flex items-center gap-2 text-sm font-medium text-foreground-800">Australian course <SkylineStatusBadge course={national} /></div><NationalCourseFields course={national} /></div> : null}
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2">
              {([["Course name", draft.name, "course"], ["Course code", draft.code, "course"], ["CRICOS code", draft.cricos, "course"], ["Category", draft.category, "course"],
                ["Training package", draft.trainingPackage, "course"], ["Duration", draft.duration, "course"], ["Mode of study", draft.mode, "course"],
                ["Units", `${draft.units.length} units`, "units"], ["Fees", "Line items with a calculated total", "fees"], ["Intakes", "Upcoming open intakes are listed automatically", "intakes"]] as const).map(([label, value, tab]) => (
                <div key={label} className="flex items-start justify-between gap-3 border-b border-background-200 pb-2">
                  <div><dt className="text-xs text-foreground-500">{label}</dt><dd className="text-foreground-900">{value || "—"}</dd></div>
                  <Link to={courseLink(tab)} className="whitespace-nowrap text-xs font-medium text-primary-600 hover:underline">Edit in Course</Link>
                </div>
              ))}
            </dl>
          </div>
        </Section>

        <Section id="publishing" title="Publishing" action={<Link to={courseLink("website")} className="text-sm font-medium text-primary-600 hover:underline">Fees on website, SEO & checklist</Link>}>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div className="space-y-4">
              <Field label="Display Order" hint="Lower numbers appear first on the website.">
                <TextInput type="number" min={1} value={draft.displayOrder} onChange={(e) => set("displayOrder", Number(e.target.value))} />
              </Field>
              <div className="rounded-md border border-background-200 p-4">
                <Toggle checked={draft.featured} onChange={(v) => set("featured", v)} label="Featured on homepage" />
                <p className="mt-1.5 text-xs text-foreground-500">Featured courses appear in the homepage course carousel.</p>
              </div>
            </div>
            <div className="space-y-4">
              <Field label="Status">
                <Select value={draft.status} onChange={(e) => set("status", e.target.value as AdminCourse["status"])}>
                  <option value="Published">Published</option>
                  <option value="Draft">Draft</option>
                </Select>
              </Field>
              <p className="text-xs text-foreground-500">Last updated by {draft.updatedBy} on {draft.updatedAt}.</p>
            </div>
          </div>
        </Section>
      </div>

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
