import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { supabase } from "@/pages/admin/lib/supabase";
import { avetmissLabel, avetmissOptions, useAvetmissCodes, type AvetmissCodeSet, type AvetmissCodes } from "@/lib/avetmissCodes";
import { usiState, type UsiState } from "@/lib/usi";
import { DisabilityTypesInput, PriorEducationInput } from "./AvetmissInputs";
import { parseCodeList, parsePriorEducation, priorEducationProblem, type PriorEducationRow } from "./avetmissValues";

/**
 * AVETMISS-UI (2026-11-25, owner): a student's AVETMISS details on the CMS student page. Every code field with its label, missing
 * values marked, and staff can fix them inline:
 *  - enrollment_students code columns (written directly; the trigger only derives them from details when details change),
 *  - student_disabilities (types, when the disability flag is Yes) and student_prior_education (rows, when the flag is Yes),
 *  - intake_enrolments.study_reason_code / funding_source_code per enrolment,
 *  - the USI and its last check (usi_state of the latest application).
 * Answers given in the application wizard but not saved to the student yet (an agent cannot write these tables) are shown as
 * "From the application, not saved yet" with Save.
 */
type Student = {
  id: string; student_number: string | null; sex_code: string | null; birth_country_code: string | null; home_language_code: string | null;
  english_proficiency_code: string | null; indigenous_status_code: string | null; school_level_code: string | null; school_level_year: string | null;
  labour_force_code: string | null; disability_flag: string | null; prior_education_flag: string | null; at_school_flag: string | null;
};
type Enrolment = { id: string; status: string; study_reason_code: string | null; funding_source_code: string | null; intakeName: string; course: string };
type AppValues = Record<string, unknown>;

const STUDENT_COLUMNS = "id, student_number, sex_code, birth_country_code, home_language_code, english_proficiency_code, indigenous_status_code, school_level_code, school_level_year, labour_force_code, disability_flag, prior_education_flag, at_school_flag";
const ENGLISH_ONLY = "1201";

/** Coded fields on the student record: column, label, code set (or a pattern for free codes without a code list). */
const FIELDS: Array<{ column: keyof Student; label: string; set?: AvetmissCodeSet; pattern?: RegExp; hint?: string; when?: (s: Student) => boolean }> = [
  { column: "sex_code", label: "Sex", set: "sex" },
  { column: "indigenous_status_code", label: "Indigenous status", set: "indigenous_status" },
  { column: "labour_force_code", label: "Labour force status", set: "labour_force" },
  { column: "school_level_code", label: "Highest school level completed", set: "school_level" },
  { column: "school_level_year", label: "Year school level completed", pattern: /^\d{4}$/, hint: "4 digits, e.g. 2018" },
  { column: "at_school_flag", label: "Still at school", set: "flag" },
  { column: "home_language_code", label: "Language spoken at home (ASCL code)", pattern: /^\d{4}$/, hint: "4 digits, 1201 = English only" },
  { column: "english_proficiency_code", label: "English proficiency", set: "english_proficiency", when: (s) => Boolean(s.home_language_code) && s.home_language_code !== ENGLISH_ONLY },
  { column: "birth_country_code", label: "Country of birth (SACC code)", pattern: /^(\d{4}|@@@@)$/, hint: "4 digits, e.g. 1101 = Australia" },
  { column: "disability_flag", label: "Disability", set: "flag" },
  { column: "prior_education_flag", label: "Prior educational achievement", set: "flag" },
];

const missingBadge = <span className="ml-2 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-2xs font-semibold uppercase text-amber-900">Missing</span>;
const BOX = "rounded-md border border-background-300 bg-background-50 px-2 py-1 text-sm text-foreground-900 focus:border-primary-500 focus:outline-none";

export default function StudentAvetmissPanel({ studentId }: { studentId: string }) {
  const { codes, error: codesError } = useAvetmissCodes();
  const { push } = useToast();
  const [student, setStudent] = useState<Student | null>(null);
  const [disabilities, setDisabilities] = useState<string[]>([]);
  const [prior, setPrior] = useState<PriorEducationRow[]>([]);
  const [enrolments, setEnrolments] = useState<Enrolment[]>([]);
  const [app, setApp] = useState<{ id: string; reference: string | null; values: AppValues } | null>(null);
  const [usi, setUsi] = useState<UsiState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [typesDraft, setTypesDraft] = useState<string[] | null>(null);
  const [priorDraft, setPriorDraft] = useState<PriorEducationRow[] | null>(null);

  const load = useCallback(async () => {
    setError("");
    const [s, d, p, e, a] = await Promise.all([
      supabase.from("enrollment_students").select(STUDENT_COLUMNS).eq("id", studentId).maybeSingle(),
      supabase.from("student_disabilities").select("disability_type_code").eq("student_id", studentId),
      supabase.from("student_prior_education").select("prior_education_code, recognition_code, qualification_name").eq("student_id", studentId).order("created_at"),
      supabase.from("intake_enrolments").select("id, status, study_reason_code, funding_source_code, intake:course_intakes(name, label, start_date, course:cms_courses(code, name))").eq("student_id", studentId),
      supabase.from("enrollment_applications").select("id, reference, data").eq("student_id", studentId).order("updated_at", { ascending: false }).limit(1),
    ]);
    const failed = [s, d, p, e, a].find((r) => r.error);
    if (failed?.error) { setError(failed.error.message); return; }
    setStudent((s.data as Student | null) ?? null);
    setDisabilities(((d.data ?? []) as { disability_type_code: string }[]).map((r) => r.disability_type_code));
    setPrior(((p.data ?? []) as { prior_education_code: string; recognition_code: string; qualification_name: string | null }[])
      .map((r) => ({ code: r.prior_education_code, recognition: r.recognition_code, name: r.qualification_name ?? "" })));
    type Raw = { id: string; status: string; study_reason_code: string | null; funding_source_code: string | null; intake: { name: string | null; label: string | null; start_date: string | null; course: { code: string; name: string } | null } | null };
    setEnrolments(((e.data ?? []) as unknown as Raw[]).map((r) => ({
      id: r.id, status: r.status, study_reason_code: r.study_reason_code, funding_source_code: r.funding_source_code,
      intakeName: r.intake?.name || r.intake?.label || r.intake?.start_date || "Intake", course: r.intake?.course ? `${r.intake.course.code} ${r.intake.course.name}` : "",
    })));
    const latest = ((a.data ?? []) as { id: string; reference: string | null; data: { values?: AppValues } | null }[])[0];
    setApp(latest ? { id: latest.id, reference: latest.reference, values: latest.data?.values ?? {} } : null);
    setUsi(latest ? await usiState(latest.id).catch(() => null) : null);
  }, [studentId]);
  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, work: () => Promise<{ error: { message: string } | null } | void>, done: string): Promise<boolean> => {
    setBusy(key);
    try {
      const result = await work();
      if (result && result.error) throw new Error(result.error.message);
      push(done);
      setEditing(null);
      await load();
      return true;
    } catch (e) { push(friendly(e instanceof Error ? e.message : "The change could not be saved."), "error"); return false; }
    finally { setBusy(""); }
  };
  const saveColumn = (column: keyof Student, value: string) =>
    run(`col-${column}`, async () => supabase.from("enrollment_students").update({ [column]: value || null }).eq("id", studentId), "Saved.");
  const saveDisabilities = (next: string[]) => run("disabilities", async () => {
    const gone = disabilities.filter((c) => !next.includes(c));
    const added = next.filter((c) => !disabilities.includes(c));
    if (gone.length) { const r = await supabase.from("student_disabilities").delete().eq("student_id", studentId).in("disability_type_code", gone); if (r.error) return r; }
    if (added.length) return supabase.from("student_disabilities").insert(added.map((code) => ({ student_id: studentId, disability_type_code: code })));
  }, "Disability types saved.");
  const savePrior = (next: PriorEducationRow[]) => run("prior", async () => {
    const problem = priorEducationProblem(next);
    if (problem) throw new Error(problem);
    const del = await supabase.from("student_prior_education").delete().eq("student_id", studentId);
    if (del.error) return del;
    return supabase.from("student_prior_education").insert(next.map((r) => ({ student_id: studentId, prior_education_code: r.code, recognition_code: r.recognition, qualification_name: r.name.trim() || null })));
  }, "Prior education saved.");
  const saveEnrolment = (id: string, column: "study_reason_code" | "funding_source_code", value: string) =>
    run(`enr-${id}-${column}`, async () => supabase.from("intake_enrolments").update({ [column]: value || null }).eq("id", id), "Saved.");

  if (error) return <Card className="p-5"><h2 className="font-heading text-base font-semibold text-foreground-900">AVETMISS details</h2><p role="alert" className="mt-2 text-sm text-red-700">{error}</p></Card>;
  if (!student) return <Card className="p-5"><p className="text-sm text-foreground-600" role="status">Loading AVETMISS details…</p></Card>;

  const shown = FIELDS.filter((f) => !f.when || f.when(student));
  const pendingEnglish = app ? String(app.values.english_proficiency_code ?? "") : "";
  const pendingTypes = app ? parseCodeList(app.values.disability_types) : [];
  const pendingPrior = app ? parsePriorEducation(app.values.prior_education) : [];
  const missingCount = shown.filter((f) => !student[f.column]).length
    + (student.disability_flag === "Y" && !disabilities.length ? 1 : 0) + (student.prior_education_flag === "Y" && !prior.length ? 1 : 0)
    + enrolments.filter((e) => !e.study_reason_code).length + (usi?.usi || app?.values.usi_number ? 0 : 1);

  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base font-semibold text-foreground-900">AVETMISS details</h2>
        {missingCount ? <Badge tone="warn">{missingCount} missing</Badge> : <Badge tone="success">Complete</Badge>}
      </div>
      {codesError ? <p role="alert" className="mb-2 text-sm text-red-700">The AVETMISS code lists could not be loaded: {codesError}</p> : null}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2" data-testid="avetmiss-fields">
        <div><dt className="text-xs text-foreground-500">Student number</dt><dd className="font-mono text-foreground-900" data-testid="avetmiss-student-number">{student.student_number || "—"}</dd></div>
        <div>
          <dt className="text-xs text-foreground-500">USI</dt>
          <dd className="text-foreground-900" data-testid="avetmiss-usi">
            {usi?.usi || String(app?.values.usi_number ?? "") ? <span className="font-mono">{usi?.usi || String(app?.values.usi_number ?? "")}</span> : <span className="text-foreground-500">Not given</span>}
            {!usi?.usi && !app?.values.usi_number ? missingBadge : null}
            {usi?.status ? <span className="ml-2"><Badge tone={usi.status === "valid" ? "success" : usi.status === "stale" ? "muted" : "warn"}>{USI_LABEL[usi.status] ?? usi.status}</Badge></span>
              : usi?.usi || app?.values.usi_number ? <span className="ml-2 text-xs text-foreground-500">not checked yet</span> : null}
            {usi?.verifiedAt ? <span className="block text-xs text-foreground-500">Checked {new Date(usi.verifiedAt).toLocaleDateString("en-AU")}{usi.environment === "test" ? " (test service)" : ""}</span> : null}
          </dd>
        </div>
        {shown.map((f) => {
          const value = student[f.column] ?? "";
          const key = `col-${f.column}`;
          return (
            <div key={f.column} data-testid={`avetmiss-field-${f.column}`}>
              <dt className="text-xs text-foreground-500">{f.label}</dt>
              {editing === key ? (
                <dd className="mt-1 flex flex-wrap items-center gap-2">
                  {f.set ? (
                    <select aria-label={f.label} className={BOX} value={draft} onChange={(e) => setDraft(e.target.value)}>
                      <option value="">Not recorded</option>
                      {avetmissOptions(codes, f.set, value).map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                    </select>
                  ) : <input aria-label={f.label} className={`${BOX} w-28`} value={draft} maxLength={4} placeholder={f.hint} onChange={(e) => setDraft(e.target.value.toUpperCase())} />}
                  <Button size="sm" disabled={busy === key || Boolean(draft && f.pattern && !f.pattern.test(draft))} onClick={() => void saveColumn(f.column, draft)}>{busy === key ? "Saving…" : "Save"}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  {draft && f.pattern && !f.pattern.test(draft) ? <span className="w-full text-xs text-red-700">{f.hint}</span> : null}
                </dd>
              ) : (
                <dd className="flex flex-wrap items-center gap-1 text-foreground-900">
                  {value ? <span>{f.set ? `${avetmissLabel(codes, f.set, value)}` : value}{f.set ? <span className="ml-1 text-xs text-foreground-500">({value})</span> : null}</span> : <span className="text-foreground-500">Not recorded</span>}
                  {!value ? missingBadge : null}
                  <button type="button" className="ml-1 cursor-pointer rounded p-0.5 text-foreground-500 hover:bg-background-100 hover:text-foreground-900" aria-label={`Edit ${f.label}`}
                    onClick={() => { setEditing(key); setDraft(value); }} data-testid={`avetmiss-edit-${f.column}`}><i className="ri-pencil-line" aria-hidden="true" /></button>
                  {f.column === "english_proficiency_code" && !value && pendingEnglish ? (
                    <PendingNote text={`From the application: ${avetmissLabel(codes, "english_proficiency", pendingEnglish)}`} busy={busy === key} onSave={() => void saveColumn("english_proficiency_code", pendingEnglish)} />
                  ) : null}
                </dd>
              )}
            </div>
          );
        })}
      </dl>

      {student.disability_flag === "Y" || disabilities.length ? (
        <section className="mt-5 border-t border-background-200 pt-4" data-testid="avetmiss-disabilities">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground-900">Disability types {student.disability_flag === "Y" && !disabilities.length ? missingBadge : null}</h3>
            {typesDraft === null ? <Button size="sm" variant="outline" onClick={() => setTypesDraft(disabilities)}>Edit</Button> : null}
          </div>
          {typesDraft !== null ? (
            <div className="space-y-2">
              <DisabilityTypesInput codes={codes} value={typesDraft} onChange={setTypesDraft} idPrefix="panel-disability" />
              <div className="flex gap-2"><Button size="sm" disabled={busy === "disabilities"} onClick={() => void saveDisabilities(typesDraft).then((ok) => { if (ok) setTypesDraft(null); })}>{busy === "disabilities" ? "Saving…" : "Save"}</Button><Button size="sm" variant="ghost" onClick={() => setTypesDraft(null)}>Cancel</Button></div>
            </div>
          ) : disabilities.length ? (
            <ul className="flex flex-wrap gap-1.5 text-sm">{disabilities.map((c) => <li key={c} className="rounded border border-background-300 px-2 py-0.5">{avetmissLabel(codes, "disability_type", c)}</li>)}</ul>
          ) : <p className="text-sm text-foreground-500">No disability types recorded.</p>}
          {!disabilities.length && pendingTypes.length && typesDraft === null ? (
            <PendingNote text={`From the application: ${pendingTypes.map((c) => avetmissLabel(codes, "disability_type", c)).join(", ")}`} busy={busy === "disabilities"} onSave={() => void saveDisabilities(pendingTypes)} />
          ) : null}
        </section>
      ) : null}

      {student.prior_education_flag === "Y" || prior.length ? (
        <section className="mt-5 border-t border-background-200 pt-4" data-testid="avetmiss-prior">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground-900">Prior education {student.prior_education_flag === "Y" && !prior.length ? missingBadge : null}</h3>
            {priorDraft === null ? <Button size="sm" variant="outline" onClick={() => setPriorDraft(prior.length ? prior : [{ code: "", recognition: "", name: "" }])}>{prior.length ? "Edit" : "Add"}</Button> : null}
          </div>
          {priorDraft !== null ? (
            <div className="space-y-2">
              <PriorEducationInput codes={codes} rows={priorDraft} onChange={setPriorDraft} />
              {priorDraft.length && priorEducationProblem(priorDraft) ? <p className="text-xs text-amber-800">{priorEducationProblem(priorDraft)}</p> : null}
              <div className="flex gap-2"><Button size="sm" disabled={busy === "prior" || Boolean(priorEducationProblem(priorDraft))} onClick={() => void savePrior(priorDraft).then((ok) => { if (ok) setPriorDraft(null); })}>{busy === "prior" ? "Saving…" : "Save"}</Button><Button size="sm" variant="ghost" onClick={() => setPriorDraft(null)}>Cancel</Button></div>
            </div>
          ) : prior.length ? (
            <ul className="space-y-1 text-sm">{prior.map((r) => <li key={`${r.code}|${r.recognition}`}>{avetmissLabel(codes, "prior_education", r.code)} · {avetmissLabel(codes, "prior_education_recognition", r.recognition)}{r.name ? ` · ${r.name}` : ""}</li>)}</ul>
          ) : <p className="text-sm text-foreground-500">No prior education recorded.</p>}
          {!prior.length && pendingPrior.length && priorDraft === null ? (
            <PendingNote text={`From the application: ${pendingPrior.map((r) => `${avetmissLabel(codes, "prior_education", r.code)}${r.name ? ` (${r.name})` : ""}`).join("; ")}`}
              busy={busy === "prior"} onSave={() => void savePrior(pendingPrior)} />
          ) : null}
        </section>
      ) : null}

      <section className="mt-5 border-t border-background-200 pt-4" data-testid="avetmiss-enrolments">
        <h3 className="mb-2 text-sm font-semibold text-foreground-900">Enrolments</h3>
        {!enrolments.length ? <p className="text-sm text-foreground-500">No intake enrolments yet. The study reason and funding source are recorded once the student is placed in an intake{app?.values.study_reason ? ` (the application says: ${String(app.values.study_reason)})` : ""}.</p> : (
          <ul className="space-y-3">{enrolments.map((e) => (
            <li key={e.id} className="rounded-md border border-background-200 p-3 text-sm">
              <p className="font-medium text-foreground-900">{e.course || "Course"} · {e.intakeName} <span className="text-xs font-normal text-foreground-500">({e.status})</span></p>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <CodeSelect label="Study reason" set="study_reason" codes={codes} value={e.study_reason_code} busy={busy === `enr-${e.id}-study_reason_code`} onSave={(v) => void saveEnrolment(e.id, "study_reason_code", v)} />
                <CodeSelect label="Funding source" set="funding_source" codes={codes} value={e.funding_source_code} busy={busy === `enr-${e.id}-funding_source_code`} onSave={(v) => void saveEnrolment(e.id, "funding_source_code", v)} optional />
              </div>
            </li>
          ))}</ul>
        )}
      </section>
    </Card>
  );
}

const USI_LABEL: Record<string, string> = { valid: "Verified", mismatch: "Details do not match", not_found: "Not found", deactivated: "Deactivated", stale: "Needs a new check" };

function PendingNote({ text, busy, onSave }: { text: string; busy: boolean; onSave: () => void }) {
  return (
    <span className="mt-1 flex w-full flex-wrap items-center gap-2 rounded border border-sky-200 bg-sky-50 px-2 py-1 text-xs text-sky-900" data-testid="avetmiss-pending">
      <span>{text} <em className="not-italic text-sky-700">(not saved yet)</em></span>
      <Button size="sm" variant="outline" disabled={busy} onClick={onSave}>{busy ? "Saving…" : "Save"}</Button>
    </span>
  );
}

function CodeSelect({ label, set, codes, value, busy, onSave, optional = false }: {
  label: string; set: AvetmissCodeSet; codes: AvetmissCodes; value: string | null; busy: boolean; onSave: (value: string) => void; optional?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs text-foreground-500">{label}{!value && !optional ? missingBadge : null}</span>
      <select aria-label={label} className={`${BOX} mt-1 w-full`} disabled={busy} value={value ?? ""} onChange={(e) => onSave(e.target.value)}>
        <option value="">Not recorded</option>
        {avetmissOptions(codes, set, value).map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
      </select>
    </label>
  );
}

/** Database refusals in plain words. */
function friendly(message: string): string {
  if (/row-level security|permission denied/i.test(message)) return "You do not have permission to change this.";
  if (/_check|violates check/i.test(message)) return "That value is not accepted. Choose one from the list.";
  if (/duplicate key/i.test(message)) return "That entry is already recorded.";
  return message;
}
