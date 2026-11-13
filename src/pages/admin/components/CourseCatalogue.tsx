import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, EmptyState, Field, InlineLoader, Modal, Select, TextInput, Toggle } from "@/pages/admin/components/ui";
import {
  COURSE_TYPE_LABEL,
  NATIONAL_STATUSES,
  activateCatalogueCourse,
  fetchAqfLevels,
  searchCatalogue,
  titleCase,
  useDebouncedValue,
  type CatalogueCourse,
  type SkylineActivation,
} from "@/pages/admin/lib/courseCatalogue";

const PAGE_SIZE = 20;

/** Runs a debounced backend search and ignores responses that arrive out of order. */
function useCatalogueSearch(query: string, filters: { courseType: string; aqfLevel: string; nationalStatus: string; skyline: "" | "active" | "inactive" }, offset: number, limit: number) {
  const debounced = useDebouncedValue(query, 250);
  const [rows, setRows] = useState<CatalogueCourse[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    setLoading(true);
    searchCatalogue({ query: debounced, ...filters, offset, limit })
      .then((r) => {
        if (id !== seq.current) return;
        setRows(r.rows);
        setTotal(r.total);
        setError(null);
      })
      .catch((e: unknown) => {
        if (id !== seq.current) return;
        setError(e instanceof Error ? e.message : "Search failed");
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
  }, [debounced, filters.courseType, filters.aqfLevel, filters.nationalStatus, filters.skyline, offset, limit, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return { rows, total, loading, error, refresh: () => setNonce((n) => n + 1), debounced };
}

export function SkylineStatusBadge({ course }: { course: CatalogueCourse }) {
  if (course.is_active) return <Badge tone="primary">Active</Badge>;
  if (course.cms_course_id) return <Badge tone="warn">Linked, inactive</Badge>;
  return <Badge tone="muted">Inactive</Badge>;
}

/* ------------------------------------------------------------ Autocomplete */

export function CourseCatalogueAutocomplete({ onSelect, autoFocus = false }: { onSelect: (c: CatalogueCourse) => void; autoFocus?: boolean }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const filters = { courseType: "", aqfLevel: "", nationalStatus: "CURRENT", skyline: "" as const };
  const { rows, loading, error, debounced } = useCatalogueSearch(query, filters, 0, 20);
  const showList = open && debounced.trim().length > 0;

  const choose = (c: CatalogueCourse) => {
    onSelect(c);
    setQuery(`${c.course_code} ${c.course_name}`);
    setOpen(false);
  };

  return (
    <div className="relative">
      <i className="ri-search-line absolute left-3 top-1/2 -translate-y-1/2 text-foreground-400" aria-hidden="true" />
      <TextInput
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        autoFocus={autoFocus}
        value={query}
        placeholder="Search by course name or code…"
        className="pl-9"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!showList || rows.length === 0) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, rows.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); choose(rows[highlight]); }
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      {showList ? (
        <ul role="listbox" className="absolute z-[90] mt-1 max-h-80 w-full overflow-y-auto rounded-md border border-background-200 bg-background-50 py-1 shadow-lg">
          {error ? <li className="px-3 py-2 text-sm text-foreground-600">{error}</li> : null}
          {!error && rows.length === 0 && !loading ? <li className="px-3 py-2 text-sm text-foreground-500">No current national courses match.</li> : null}
          {rows.map((c, i) => (
            <li
              key={c.course_code}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => { e.preventDefault(); choose(c); }}
              onMouseEnter={() => setHighlight(i)}
              className={`cursor-pointer px-3 py-2 text-sm ${i === highlight ? "bg-background-100" : ""}`}
            >
              <span className="font-mono text-label font-semibold text-foreground-900">{c.course_code}</span>{" "}
              <span className="text-foreground-800">{c.course_name}</span>
              <span className="block text-xs text-foreground-500">
                {COURSE_TYPE_LABEL[c.course_type]}
                {c.aqf_level ? ` · ${c.aqf_level}` : ""}
                {c.training_package_name ? ` · ${c.training_package_name}` : ""}
                {c.is_active ? " · Active at Skyline" : ""}
              </span>
            </li>
          ))}
          {loading ? <li className="px-3 py-2"><InlineLoader label="Searching…" /></li> : null}
        </ul>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------- Read-only national data */

export function NationalCourseFields({ course }: { course: CatalogueCourse }) {
  const items: [string, string][] = [
    ["Course Code", course.course_code],
    ["Course Name", course.course_name],
    ["Type", COURSE_TYPE_LABEL[course.course_type] ?? course.course_type],
    ["AQF Level", course.aqf_level ?? "—"],
    ["Training Package", course.training_package_name ? `${course.training_package_code ?? ""} ${course.training_package_name}`.trim() : "—"],
    ["National Status", titleCase(course.national_status)],
    ["Release", course.release_number ?? "—"],
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-5 gap-y-3 rounded-md border border-background-200 bg-background-100 p-4 sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs font-medium uppercase tracking-wide text-foreground-500">{label}</dt>
          <dd className="mt-0.5 text-sm text-foreground-900">{value}</dd>
        </div>
      ))}
      <p className="text-xs text-foreground-500 sm:col-span-2">
        National details come from training.gov.au and are read-only.{" "}
        <a className="underline" href={`https://training.gov.au/training/details/${course.course_code}`} target="_blank" rel="noreferrer">
          View on training.gov.au
        </a>
      </p>
    </dl>
  );
}

/* ---------------------------------------------------------- Activation modal */

export function ActivationOptions({ value, onChange }: { value: SkylineActivation; onChange: (v: SkylineActivation) => void }) {
  const opts: [keyof SkylineActivation, string][] = [
    ["active", "Active"],
    ["website", "Show on Website"],
    ["applications", "Accept Applications"],
    ["domestic", "Domestic"],
    ["international", "International"],
  ];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {opts.map(([key, label]) => (
        <Toggle key={key} checked={value[key]} label={label} onChange={(v) => onChange({ ...value, [key]: v })} />
      ))}
    </div>
  );
}

export function ActivateCourseModal({
  course,
  onClose,
  beforeChange,
  onDone,
}: {
  course: CatalogueCourse | null;
  onClose: () => void;
  /** Persist pending CMS edits before the server changes cms_courses. */
  beforeChange: () => Promise<void>;
  onDone: (result: { slug: string | null; created: boolean; active: boolean }) => void;
}) {
  const [value, setValue] = useState<SkylineActivation>({ active: true, website: false, applications: false, domestic: false, international: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!course) return;
    setError(null);
    setValue({
      active: true,
      website: course.website_enabled,
      applications: course.admissions_enabled,
      domestic: course.domestic_enabled,
      international: course.international_enabled,
    });
  }, [course]);

  if (!course) return null;
  const notCurrent = course.national_status !== "CURRENT";

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await beforeChange();
      const r = await activateCatalogueCourse(course.course_code, value);
      onDone({ slug: r.slug, created: r.created, active: value.active });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the course");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={course.is_active ? "Skyline course settings" : "Activate course at Skyline"}
      onClose={busy ? () => undefined : onClose}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy || (notCurrent && value.active)}>
            {busy ? "Saving…" : course.cms_course_id || course.is_active ? "Save" : "Activate"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <NationalCourseFields course={course} />
        {notCurrent ? (
          <p className="text-sm text-foreground-700">This course is not current on the national register and cannot be activated.</p>
        ) : null}
        <Field label="Skyline settings">
          <ActivationOptions value={value} onChange={setValue} />
        </Field>
        <p className="text-xs text-foreground-500">
          {course.cms_course_id
            ? "This course is already managed in Skyline. Its existing content will not be changed."
            : "A Draft Skyline course will be created with the national code, name and training package. CRICOS, duration, delivery, fees, descriptions and media stay editable."}
        </p>
        {error ? <p className="text-sm text-foreground-900">{error}</p> : null}
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------- Catalogue browser */

export function CatalogueBrowser({
  beforeChange,
  onActivated,
  onManage,
}: {
  beforeChange: () => Promise<void>;
  onActivated: (result: { slug: string | null; created: boolean; active: boolean }) => void;
  onManage: (cmsCourseId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [courseType, setCourseType] = useState("");
  const [aqfLevel, setAqfLevel] = useState("");
  const [nationalStatus, setNationalStatus] = useState("CURRENT");
  const [skyline, setSkyline] = useState<"" | "active" | "inactive">("");
  const [page, setPage] = useState(0);
  const [aqfLevels, setAqfLevels] = useState<string[]>([]);
  const [viewing, setViewing] = useState<CatalogueCourse | null>(null);
  const [activating, setActivating] = useState<CatalogueCourse | null>(null);

  const { rows, total, loading, error, refresh } = useCatalogueSearch(
    query,
    { courseType, aqfLevel, nationalStatus, skyline },
    page * PAGE_SIZE,
    PAGE_SIZE,
  );

  useEffect(() => { fetchAqfLevels().then(setAqfLevels).catch(() => setAqfLevels([])); }, []);
  useEffect(() => { setPage(0); }, [query, courseType, aqfLevel, nationalStatus, skyline]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <Card className="mb-5 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <i className="ri-search-line absolute left-3 top-1/2 -translate-y-1/2 text-foreground-400" aria-hidden="true" />
            <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by course name or code…" className="pl-9" />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:flex">
            <Select value={courseType} onChange={(e) => setCourseType(e.target.value)} className="lg:w-44" aria-label="Type">
              <option value="">All types</option>
              <option value="QUALIFICATION">Qualification</option>
              <option value="ACCREDITED_COURSE">Accredited Course</option>
            </Select>
            <Select value={aqfLevel} onChange={(e) => setAqfLevel(e.target.value)} className="lg:w-44" aria-label="AQF level">
              <option value="">All AQF levels</option>
              {aqfLevels.map((l) => <option key={l} value={l}>{l}</option>)}
            </Select>
            <Select value={nationalStatus} onChange={(e) => setNationalStatus(e.target.value)} className="lg:w-40" aria-label="National status">
              <option value="">Any national status</option>
              {NATIONAL_STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </Select>
            <Select value={skyline} onChange={(e) => setSkyline(e.target.value as "" | "active" | "inactive")} className="lg:w-40" aria-label="Skyline status">
              <option value="">Skyline: all</option>
              <option value="active">Skyline active</option>
              <option value="inactive">Skyline inactive</option>
            </Select>
          </div>
        </div>
      </Card>

      <Card>
        {error ? (
          <EmptyState icon="ri-error-warning-line" title="Could not search the catalogue" description={error} />
        ) : rows.length === 0 && !loading ? (
          <EmptyState icon="ri-search-line" title="No national courses match" description="Try a different name, code or filter." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-background-200 text-xs uppercase tracking-wide text-foreground-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Code</th>
                  <th className="px-4 py-3 font-medium">Course</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">AQF</th>
                  <th className="px-4 py-3 font-medium">Training Package</th>
                  <th className="px-4 py-3 font-medium">National Status</th>
                  <th className="px-4 py-3 font-medium">Skyline Status</th>
                  <th className="px-4 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.course_code} className="border-b border-background-200 last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-label font-semibold text-foreground-900">{c.course_code}</td>
                    <td className="px-4 py-3 text-foreground-900">{c.course_name}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-foreground-700">{COURSE_TYPE_LABEL[c.course_type]}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-foreground-700">{c.aqf_level ?? "—"}</td>
                    <td className="px-4 py-3 text-foreground-700">{c.training_package_name ?? "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3"><Badge tone={c.national_status === "CURRENT" ? "secondary" : "muted"}>{titleCase(c.national_status)}</Badge></td>
                    <td className="whitespace-nowrap px-4 py-3"><SkylineStatusBadge course={c} /></td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <div className="inline-flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => setViewing(c)}>View</Button>
                        {c.is_active && c.cms_course_id ? (
                          <Button size="sm" onClick={() => onManage(c.cms_course_id as string)}>Manage</Button>
                        ) : (
                          <Button size="sm" onClick={() => setActivating(c)} disabled={c.national_status !== "CURRENT"}>Activate</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-background-200 px-4 py-3 text-sm text-foreground-600">
          <span>{loading ? "Searching…" : `${total.toLocaleString()} national course${total === 1 ? "" : "s"}`}</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <span>Page {Math.min(page + 1, pages)} of {pages}</span>
            <Button size="sm" variant="outline" disabled={page + 1 >= pages || loading} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      </Card>

      <Modal
        open={viewing !== null}
        title="Australian course"
        onClose={() => setViewing(null)}
        width="max-w-2xl"
        footer={
          viewing ? (
            <>
              <Button variant="outline" onClick={() => setViewing(null)}>Close</Button>
              {viewing.is_active && viewing.cms_course_id ? (
                <Button variant="outline" onClick={() => { setActivating(viewing); setViewing(null); }}>Skyline settings</Button>
              ) : null}
            </>
          ) : null
        }
      >
        {viewing ? (
          <div className="space-y-4">
            <NationalCourseFields course={viewing} />
            <div className="flex items-center gap-2 text-sm text-foreground-700">Skyline status: <SkylineStatusBadge course={viewing} /></div>
          </div>
        ) : null}
      </Modal>

      <ActivateCourseModal
        course={activating}
        onClose={() => setActivating(null)}
        beforeChange={beforeChange}
        onDone={(r) => {
          setActivating(null);
          refresh();
          onActivated(r);
        }}
      />
    </div>
  );
}
