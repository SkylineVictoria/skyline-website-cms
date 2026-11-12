import { useCallback, useEffect, useMemo, useState } from "react";
import ResponsiveTable from "@/components/ui/ResponsiveTable";
import { Button, Card, Field, Modal, PageHeader, TextInput } from "@/pages/admin/components/ui";
import { ListMessage, SearchBox } from "@/pages/admin/components/ListControls";
import { useToast } from "@/pages/admin/components/toastContext";
import { supabase } from "@/pages/admin/lib/supabase";

interface CourseRow {
  courseId: string; slug: string; code: string; cricos: string; name: string; duration: string; category: string;
  total: number | null; initial: number | null; enrolment: number | null;
}
type Form = { total: string; initial: string; enrolment: string };

const aud = (n: number | null) => (n === null || n === undefined ? "—" : `AUD$${Number(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const str = (n: number | null) => (n === null || n === undefined ? "" : String(n));

/** Master Data > Courses: the active (published) courses and the three fees offer letters and enrolment forms fill in from. Edit only. */
export default function CourseFeesPage() {
  const toast = useToast();
  const [rows, setRows] = useState<CourseRow[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<{ row: CourseRow; form: Form } | null>(null);
  const [saveError, setSaveError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.rpc("cms_course_fee_list");
    if (e) { setError(e.message); setRows([]); return; }
    setError(""); setRows((data ?? []) as CourseRow[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows ?? []).filter((r) => !q || `${r.code} ${r.name} ${r.cricos} ${r.category}`.toLowerCase().includes(q));
  }, [rows, search]);

  const open = (row: CourseRow) => { setSaveError(""); setEdit({ row, form: { total: str(row.total), initial: str(row.initial), enrolment: str(row.enrolment) } }); };
  const set = (key: keyof Form, value: string) => setEdit((e) => (e ? { ...e, form: { ...e.form, [key]: value } } : e));

  const save = async () => {
    if (!edit || busy) return;
    setBusy(true); setSaveError("");
    const { error: e } = await supabase.rpc("cms_course_fee_save_main", { p_course: edit.row.courseId, p_total: edit.form.total, p_initial: edit.form.initial, p_enrolment: edit.form.enrolment });
    setBusy(false);
    if (e) { setSaveError(e.message); return; }
    toast.push(`Fees for ${edit.row.code || edit.row.name} were saved.`);
    setEdit(null);
    void load();
  };

  return (
    <div data-testid="course-fees-page">
      <PageHeader title="Courses" description="Active courses and their fees. Offer letters and enrolment forms fill these in automatically. Add or publish courses from Website › Courses." />
      <div className="mb-4"><SearchBox label="Search courses" value={search} onSearch={setSearch} placeholder="Search code, name, CRICOS or category" /></div>
      <Card>
        {error ? (
          <ListMessage icon="ri-error-warning-line" title="Courses did not load" text={error} action={<Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>} />
        ) : rows && shown.length === 0 ? (
          <ListMessage icon="ri-book-2-line" title={search ? "No courses match" : "No active courses"} text={search ? "Check the spelling." : "Published courses appear here."} />
        ) : (
          <ResponsiveTable aria-busy={!rows}>
            <thead>
              <tr>
                <th className="w-[46%]">Course</th>
                <th className="w-[15%] text-right">Total fee</th>
                <th className="w-[15%] text-right">Initial fee</th>
                <th className="w-[15%] text-right">Enrolment fee</th>
                <th className="w-[9%]"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {!rows ? <tr><td colSpan={5} className="py-10 text-center text-foreground-500">Loading courses…</td></tr> : shown.map((r) => (
                <tr key={r.courseId} className="align-top" data-testid="course-fee-row">
                  <td>
                    <p className="font-medium text-foreground-900">{r.code ? `${r.code} ` : ""}{r.name}</p>
                    <p className="text-xs text-foreground-500">{[r.cricos && `CRICOS ${r.cricos}`, r.duration].filter(Boolean).join(" · ")}</p>
                  </td>
                  <td className="whitespace-nowrap text-right font-semibold tabular-nums">{aud(r.total)}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">{aud(r.initial)}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">{aud(r.enrolment)}</td>
                  <td className="text-right"><Button variant="outline" size="sm" icon="ri-edit-line" onClick={() => open(r)}>Edit</Button></td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
      </Card>

      {edit ? (
        <Modal open title={`Edit fees · ${edit.row.code || edit.row.name}`} onClose={() => setEdit(null)}
          footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save"}</Button></>}>
          <div className="space-y-4">
            <p className="text-sm text-foreground-600">{edit.row.name}. Amounts in AUD, e.g. 14500 or 14500.00. Leave blank if it does not apply.</p>
            {saveError ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{saveError}</p> : null}
            <Field label="Total fee"><TextInput inputMode="decimal" value={edit.form.total} onChange={(e) => set("total", e.target.value)} /></Field>
            <Field label="Initial fee"><TextInput inputMode="decimal" value={edit.form.initial} onChange={(e) => set("initial", e.target.value)} /></Field>
            <Field label="Enrolment fee"><TextInput inputMode="decimal" value={edit.form.enrolment} onChange={(e) => set("enrolment", e.target.value)} /></Field>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
