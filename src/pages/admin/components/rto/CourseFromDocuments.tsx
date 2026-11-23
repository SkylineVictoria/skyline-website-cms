// Add a course from documents (owner, 2026-11-23): staff drop in course documents (PDF, Word, text, CSV or a ZIP folder of
// them). The text is read in the browser; the qualification code and unit codes in the text and in the file / folder names
// are found, and Training.gov.au says which units are core, elective or from outside the qualification. Each document is
// mapped to its unit (the unit code in its file or folder name, else the one unit its text is about) and can be changed.
// Sync: the draft course with its core units (tga-course-import create_core), the documents' electives (add_units, packaging
// rules checked by the function), each mapped document saved to its unit's Learning content (staff only, not shown to
// students), and the units' SLIT hours confirmed from the nominal hours (40 / 40 / 20). The course then needs only its
// weekly and daily calendars; units or hours open only when the documents could not settle them.
import { useMemo, useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { invokeTga } from "@/pages/admin/lib/tga";
import { supabase } from "@/pages/admin/lib/supabase";
import { autoPickElectives, checkElectives, groupSizes, parseElectiveRules, type ElectiveUnit } from "../../../../../supabase/functions/tga-course-import/packaging";
import { loadUnitHours, rto, saveUnitHours, suggestHours, weeksForHours, type CourseDetail, type RtoCourse } from "@/pages/admin/lib/rto";

interface Review {
  code: string; name: string; core: { code: string; name: string }[]; electives: { code: string; name: string; groups: string[] }[];
  packagingRules: string; requiredElectives: number | null; groups: Record<string, unknown>;
}
interface ReadFile { name: string; path: string; text: string; bytes?: Uint8Array; error?: string }
/** Where Sync goes next: the documents settled everything (the weekly calendar), or units / hours are still to choose. */
export type FromDocsNext = "master" | "units" | "hours";

const QUAL = /(?<![A-Z0-9])[A-Z]{3}\d{5}(?![A-Z0-9])/g;
const UNIT = /(?<![A-Z0-9])[A-Z]{5,8}\d{3,4}[A-Z]?(?![A-Z0-9])/g;
const norm = (value: string | null | undefined) => (value ?? "").trim().toUpperCase();
const codesIn = (value: string, re: RegExp) => value.toUpperCase().match(re) ?? [];
const MAX_MB = 20;
const READABLE = /\.(pdf|docx|txt|csv)$/i;
const ZIP_MAX_FILES = 200;
const ZIP_MAX_MB = 200;
const MIME: Record<string, string> = {
  pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", txt: "text/plain", csv: "text/csv",
};
const NONE = "";
const safeName = (name: string) => name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-120) || "file";
const baseName = (path: string) => path.split("/").pop() ?? path;

async function tga<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await invokeTga<T>(body);
  if (error) {
    let message = error.message;
    try { const detail = await (error as { context?: Response }).context?.json(); if (detail?.error) message = detail.error; } catch { /* keep the generic message */ }
    throw new Error(message);
  }
  if (!data) throw new Error("No answer from Training.gov.au.");
  return data;
}

/** The plain text of a PDF, Word (.docx), text or CSV file, read in the browser. */
async function readText(fileName: string, bytes: Uint8Array): Promise<string> {
  const name = fileName.toLowerCase();
  if (name.endsWith(".pdf")) {
    const [pdf, worker] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")]);
    pdf.GlobalWorkerOptions.workerSrc = worker.default;
    // pdf.js takes over the buffer it is given: it reads a copy, the bytes stay for the upload.
    const doc = await pdf.getDocument({ data: bytes.slice() }).promise;
    const pages: string[] = [];
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const content = await (await doc.getPage(i)).getTextContent();
        pages.push(content.items.map(item => ("str" in item ? item.str : "")).join(" "));
      }
    } finally { void doc.cleanup(); }
    return pages.join("\n");
  }
  if (name.endsWith(".docx")) {
    const imported = await import("mammoth");
    const mammoth = (imported as unknown as { default?: typeof imported }).default ?? imported;
    return (await mammoth.extractRawText({ arrayBuffer: bytes.slice().buffer as ArrayBuffer })).value;
  }
  if (name.endsWith(".txt") || name.endsWith(".csv")) return new TextDecoder().decode(bytes);
  throw new Error("Use a PDF, Word (.docx), text, CSV or ZIP file.");
}

/** One chosen file, or every readable document inside a ZIP folder (folders inside it included; nested ZIPs skipped). */
async function readFile(file: File): Promise<ReadFile[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!/\.zip$/i.test(file.name)) return [{ name: file.name, path: file.name, text: await readText(file.name, bytes), bytes }];
  const { unzipSync } = await import("fflate");
  let total = 0; let count = 0; let skipped = 0;
  const entries = unzipSync(bytes, {
    filter: entry => {
      if (entry.name.endsWith("/") || entry.name.startsWith("__MACOSX/") || /(^|\/)\./.test(entry.name)) return false;
      if (!READABLE.test(entry.name)) { skipped++; return false; }
      total += entry.originalSize; count++;
      if (count > ZIP_MAX_FILES || total > ZIP_MAX_MB * 1024 * 1024) throw new Error(`The ZIP holds more than ${ZIP_MAX_FILES} documents or ${ZIP_MAX_MB} MB.`);
      return true;
    },
  });
  const out: ReadFile[] = [];
  for (const [path, data] of Object.entries(entries)) {
    const name = `${file.name} › ${path}`;
    try { out.push({ name, path, text: await readText(path, data), bytes: data }); }
    catch (e) { out.push({ name, path, text: "", error: e instanceof Error ? e.message : "Could not be read." }); }
  }
  if (!out.length) throw new Error("No PDF, Word, text or CSV documents in this ZIP.");
  if (skipped) out.push({ name: `${file.name}: ${skipped} other file${skipped === 1 ? "" : "s"} skipped`, path: "", text: "", error: "Not a PDF, Word, text or CSV file." });
  return out;
}

/** The unit a document belongs to: a unit code in its file or folder name (the deepest wins), else the one unit its text is
 *  about (mentioned at least twice and twice as often as any other). A document naming many units is a course document. */
function guessUnit(file: ReadFile, units: Set<string>): string {
  const parts = file.path.split("/").reverse();
  for (const part of parts) {
    const hit = codesIn(part, UNIT).find(code => units.has(code));
    if (hit) return hit;
  }
  const counts = new Map<string, number>();
  for (const code of codesIn(file.text, UNIT)) if (units.has(code)) counts.set(code, (counts.get(code) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return NONE;
  if (ranked.length === 1) return ranked[0][0];
  return ranked[0][1] >= 2 && ranked[0][1] >= 2 * ranked[1][1] ? ranked[0][0] : NONE;
}

export default function CourseFromDocuments({ open, courses, onClose, onCreated }: {
  open: boolean; courses: RtoCourse[]; onClose: () => void;
  /** The course was created or updated: open it on the next screen it needs. */
  onCreated: (courseId: string, next: FromDocsNext, message: string) => void;
}) {
  const [files, setFiles] = useState<ReadFile[]>([]);
  const [reading, setReading] = useState(false);
  const [qualification, setQualification] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [checking, setChecking] = useState(false);
  const [includeOutside, setIncludeOutside] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const docs = files.filter(f => f.path && !f.error);
  const allText = files.map(f => `${f.path}\n${f.text}`).join("\n");
  const qualCodes = useMemo(() => [...new Set(codesIn(allText, QUAL))], [allText]);
  const unitCodes = useMemo(() => [...new Set(codesIn(allText, UNIT))], [allText]);
  const existing = courses.find(c => norm(c.code) === norm(qualification)) ?? null;

  const sorted = useMemo(() => {
    const core = new Map((review?.core ?? []).map(u => [norm(u.code), u.name]));
    const electives = new Map((review?.electives ?? []).map(u => [norm(u.code), u.name]));
    return {
      core: unitCodes.filter(c => core.has(c)).map(c => ({ code: c, name: core.get(c)! })),
      electives: unitCodes.filter(c => electives.has(c)).map(c => ({ code: c, name: electives.get(c)! })),
      outside: unitCodes.filter(c => !core.has(c) && !electives.has(c)),
      /** Core units the documents do not mention: they are added anyway (every core unit is). */
      coreOther: (review?.core ?? []).filter(u => !unitCodes.includes(norm(u.code))).map(u => ({ code: norm(u.code), name: u.name })),
    };
  }, [review, unitCodes]);
  /** The course's units once synced: every core unit, the electives found and (when ticked) the outside units. */
  const courseUnits = useMemo(() => [
    ...sorted.core.map(u => ({ ...u, tag: "Core" })), ...sorted.coreOther.map(u => ({ ...u, tag: "Core" })),
    ...sorted.electives.map(u => ({ ...u, tag: "Elective" })), ...(includeOutside ? sorted.outside.map(code => ({ code, name: "", tag: "Outside the qualification" })) : []),
  ], [sorted, includeOutside]);
  const unitSet = useMemo(() => new Set(courseUnits.map(u => u.code)), [courseUnits]);
  const unitOf = (f: ReadFile) => { const picked = mapping[f.name]; return picked !== undefined ? (picked && unitSet.has(picked) ? picked : NONE) : guessUnit(f, unitSet); };
  const docsByUnit = useMemo(() => {
    const out = new Map<string, ReadFile[]>();
    for (const f of files) {
      if (!f.path || f.error) continue;
      const picked = mapping[f.name];
      const u = picked !== undefined ? (picked && unitSet.has(picked) ? picked : NONE) : guessUnit(f, unitSet);
      if (u) out.set(u, [...(out.get(u) ?? []), f]);
    }
    return out;
  }, [files, mapping, unitSet]);
  const mappedCount = [...docsByUnit.values()].reduce((n, l) => n + l.length, 0);

  function reset() {
    setFiles([]); setQualification(""); setReview(null); setError(""); setNote(""); setIncludeOutside(false); setMapping({});
  }

  async function addFiles(list: FileList | null) {
    if (!list?.length) return;
    setReading(true); setError(""); setNote("");
    const read: ReadFile[] = [];
    for (const file of Array.from(list)) {
      const limit = /\.zip$/i.test(file.name) ? ZIP_MAX_MB : MAX_MB;
      if (file.size > limit * 1024 * 1024) { read.push({ name: file.name, path: file.name, text: "", error: `Larger than ${limit} MB.` }); continue; }
      try { read.push(...await readFile(file)); }
      catch (e) { read.push({ name: file.name, path: file.name, text: "", error: e instanceof Error ? e.message : "Could not be read." }); }
    }
    const all = [...files, ...read];
    setFiles(all);
    setReading(false);
    const found = [...new Set(codesIn(all.map(f => `${f.path}\n${f.text}`).join("\n"), QUAL))];
    if (!qualification && found.length) await check(found[0]);
    else if (!found.length && !qualification) setNote("No qualification code (like CPC30220) was found. Type it below.");
  }

  async function check(code: string) {
    const value = norm(code);
    setQualification(value); setReview(null); setError("");
    if (!/^[A-Z]{3}\d{5}$/.test(value)) return;
    setChecking(true);
    try { setReview(await tga<Review>({ action: "details", code: value })); }
    catch (e) { setError(e instanceof Error ? e.message : "Training.gov.au could not be read."); }
    finally { setChecking(false); }
  }

  /** Each mapped document into its unit's Learning content (staff only); a file already there by name is not added again. */
  async function saveDocuments(detail: CourseDetail): Promise<{ saved: number; failed: string[] }> {
    const ids = new Map(detail.units.filter(u => u.id && u.isActive).map(u => [norm(u.code), u.id as string]));
    let saved = 0; const failed: string[] = [];
    // A document matched to a unit that did not make it onto the course goes to the course unit it is about instead, if any.
    const onCourse = new Set(ids.keys());
    const byUnit = new Map<string, ReadFile[]>();
    for (const [code, list] of docsByUnit) for (const f of list) {
      const target = ids.has(code) ? code : guessUnit(f, onCourse) || code;
      byUnit.set(target, [...(byUnit.get(target) ?? []), f]);
    }
    for (const [code, list] of byUnit) {
      const unitId = ids.get(code);
      if (!unitId) { failed.push(...list.map(f => `${baseName(f.path)} (${code} is not a unit of the course)`)); continue; }
      const { data: have } = await supabase.from("unit_contents").select("file_name,sort").eq("unit_id", unitId);
      const names = new Set((have ?? []).map(r => r.file_name as string | null));
      let sort = Math.max(-1, ...(have ?? []).map(r => Number(r.sort) || 0));
      for (const f of list) {
        const fileName = baseName(f.path);
        if (names.has(fileName) || !f.bytes) continue;
        const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? null;
        const limit = await supabase.rpc("unit_learning_file_limit", { p_unit_id: unitId, p_extension: extension });
        if (limit.error || typeof limit.data !== "number") { failed.push(`${fileName} (file limit could not be checked)`); continue; }
        if (f.bytes.byteLength > limit.data) { failed.push(`${fileName} (too large for unit content)`); continue; }
        const mime = MIME[extension ?? ""] ?? "application/octet-stream";
        const path = `${unitId}/${crypto.randomUUID().slice(0, 8)}-${safeName(fileName)}`;
        const up = await supabase.storage.from("unit-content").upload(path, new Blob([f.bytes.slice()], { type: mime }), { contentType: mime, upsert: false });
        if (up.error) { failed.push(`${fileName} (${up.error.message})`); continue; }
        const { error } = await supabase.from("unit_contents").insert({
          unit_id: unitId, kind: "file", title: fileName.replace(/\.[a-z0-9]+$/i, "").slice(0, 200), body: "", url: null, storage_path: path,
          file_name: fileName.slice(0, 200), mime_type: mime, size_bytes: f.bytes.byteLength, sort: ++sort, visible_to_students: false,
        });
        if (error) { await supabase.storage.from("unit-content").remove([path]); failed.push(`${fileName} (${error.message})`); continue; }
        names.add(fileName); saved++;
      }
    }
    return { saved, failed };
  }

  /** Every active unit's SLIT hours confirmed from its nominal hours (as the hours step's suggestion), durations to match.
   *  False when a unit has no nominal hours: the hours step then opens for it. */
  async function confirmHours(courseId: string, detail: CourseDetail): Promise<boolean> {
    const active = detail.units.filter(u => u.isActive && u.id);
    const saved = new Map((await loadUnitHours(courseId)).map(h => [h.unitId, h]));
    const todo = active.filter(u => !saved.get(u.id as string)?.confirmedAt);
    if (todo.some(u => u.nominalHours === null)) return false;
    const weeks = new Map<string, number>();
    for (let i = 0; i < todo.length; i += 6) {
      const done = await Promise.all(todo.slice(i, i + 6).map(u => saveUnitHours(u.id as string, suggestHours(u.nominalHours as number))));
      for (const out of done) weeks.set(out.unitId, weeksForHours(out.slitHours ?? 0));
    }
    if (weeks.size) await rto("units_save", { courseId, units: detail.units.map(u => (u.id && weeks.has(u.id) ? { ...u, defaultWeeks: weeks.get(u.id) } : u)) });
    return true;
  }

  /** Create the course (when new) with its core units, add the documents' electives, save the documents to their units and
   *  confirm the hours; then the course needs only its weekly and daily calendars. */
  async function sync() {
    if (!review || syncing) return;
    setError(""); setNote("");
    let courseId = existing?.id ?? "";
    const lines: string[] = [];
    try {
      setSyncing(existing ? "Checking the course…" : "Creating the course…");
      if (!courseId) courseId = (await tga<{ courseId: string }>({ action: "create_core", code: review.code })).courseId;
      // Electives: the documents often list every elective option, more than the packaging rules allow. When the course's
      // electives already meet the rules nothing is added; otherwise the rules pick from the electives found (those with their
      // own documents first), as Pick for me does. The Add units step opens only when no such set exists.
      const before = await rto<CourseDetail>("course_get", { courseId });
      const official = new Map(review.electives.map(u => [norm(u.code), u]));
      const isActive = (code: string) => before.units.some(u => u.isActive && norm(u.code) === norm(code));
      const current: ElectiveUnit[] = before.units.filter(u => u.isActive && u.unitType !== "core")
        .map(u => ({ code: norm(u.code), groups: official.get(norm(u.code))?.groups ?? null }));
      const rules = parseElectiveRules(review.packagingRules, review.requiredElectives, Object.keys(review.groups ?? {}), groupSizes(review.electives));
      const imported = includeOutside ? sorted.outside.filter(code => !isActive(code)) : [];
      let next: FromDocsNext = "master";
      let picks: string[] | null = [];
      if (!checkElectives(rules, current).complete) {
        const found = sorted.electives.map(u => u.code).filter(code => !isActive(code));
        const ordered = [...found.filter(code => docsByUnit.has(code)), ...found.filter(code => !docsByUnit.has(code))];
        picks = autoPickElectives(rules, ordered.map(code => ({ code, groups: official.get(code)?.groups ?? [], prerequisites: [] })), current, isActive);
      }
      const codes = picks ?? [];
      if (codes.length || imported.length) {
        setSyncing("Adding the units…");
        let done = false; let failure = "";
        for (const extra of imported.length ? [imported, []] : [[]]) {
          if (!codes.length && !extra.length) continue;
          try { await tga({ action: "add_units", courseId, codes, imported: extra }); done = true; lines.push(`${review.code}: core units and ${codes.length + extra.length} elective${codes.length + extra.length === 1 ? "" : "s"} from the documents saved.`); break; }
          catch (e) { failure = e instanceof Error ? e.message : "error"; }
        }
        if (!done) { next = "units"; lines.push(`${review.code}: core units saved; the electives were not added (${failure}) Choose them in the Add units step.`); }
      } else if (picks === null) {
        next = "units"; lines.push(`${review.code}: core units saved. The electives in the documents do not make a set that meets the packaging rules: choose them in the Add units step.`);
      } else lines.push(`${review.code}: units saved (the course's electives already meet the packaging rules).`);
      const detail = await rto<CourseDetail>("course_get", { courseId });
      if (mappedCount) {
        setSyncing("Saving the documents to their units…");
        const { saved, failed } = await saveDocuments(detail);
        lines.push(`${saved} document${saved === 1 ? "" : "s"} saved to ${docsByUnit.size} unit${docsByUnit.size === 1 ? "" : "s"} (Learning content, staff only).`);
        if (failed.length) lines.push(`Not saved: ${failed.join("; ")}.`);
      }
      if (next === "master") {
        setSyncing("Confirming the unit hours…");
        if (await confirmHours(courseId, detail)) lines.push("Unit hours confirmed from the nominal hours. Next: the CoE and VoE weekly calendars, then the daily timetables.");
        else { next = "hours"; lines.push("Some units have no nominal hours: enter them in the hours step."); }
      }
      setSyncing("");
      reset();
      onCreated(courseId, next, lines.join(" "));
    } catch (e) {
      setSyncing("");
      if (courseId && lines.length) { reset(); onCreated(courseId, "units", `${lines.join(" ")} Then stopped: ${e instanceof Error ? e.message : "error"}`); return; }
      setError(e instanceof Error ? e.message : "The course could not be synced.");
    }
  }

  const close = () => { if (!syncing) { reset(); onClose(); } };
  const busy = !!syncing || checking || reading;

  return <Modal open={open} title="Add a course from documents" width="max-w-5xl" onClose={close}
    footer={<div className="flex flex-wrap items-center justify-end gap-2">
      {syncing ? <span className="mr-auto text-sm text-foreground-600">{syncing}</span> : null}
      <Button variant="outline" disabled={!!syncing} onClick={close}>Cancel</Button>
      <Button disabled={!review || busy} onClick={() => void sync()}
        title="Saves the course with its units, the documents on their units and the unit hours; then only the weekly and daily calendars remain">
        {syncing ? "Syncing…" : existing ? `Sync into ${existing.code}` : review ? `Sync: save ${review.code}` : "Sync"}</Button>
    </div>}>
    <div className="space-y-4 text-sm">
      <p className="text-foreground-600">Upload the course documents (training plan, unit list, learner guides, assessment tools; a ZIP folder works).
        The qualification and its units are found in them and checked against Training.gov.au, and each document is matched to its unit.
        <strong> Sync</strong> saves the course with its units and hours and puts each document on its unit; then only the weekly and daily calendars are left.</p>
      <label className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed border-background-300 p-5 text-center hover:bg-background-50">
        <span className="font-semibold text-foreground-800">{reading ? "Reading…" : files.length ? "Add more files" : "Choose files"}</span>
        <span className="text-xs text-foreground-500">PDF, Word (.docx), text, CSV or a ZIP folder of them · up to {MAX_MB} MB each, ZIP up to {ZIP_MAX_MB} MB</span>
        <input type="file" multiple className="sr-only" accept=".pdf,.docx,.txt,.csv,.zip,application/pdf,text/plain,text/csv,application/zip,application/x-zip-compressed"
          disabled={busy} onChange={e => { void addFiles(e.target.files); e.target.value = ""; }} />
      </label>

      {files.length ? <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1"><span className="text-xs font-semibold text-foreground-600">Qualification code</span>
          <input value={qualification} onChange={e => setQualification(e.target.value.toUpperCase())} onBlur={e => { if (norm(e.target.value) !== review?.code) void check(e.target.value); }}
            placeholder="CPC30220" className="w-40 rounded-lg border border-background-300 px-3 py-2" disabled={!!syncing} /></label>
        {qualCodes.length > 1 ? <span className="text-xs text-foreground-500">Found: {qualCodes.map(c => <button key={c} type="button" className="mr-2 underline" onClick={() => void check(c)}>{c}</button>)}</span> : null}
        {checking ? <span className="text-foreground-500">Checking Training.gov.au…</span> : null}
      </div> : null}

      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-700">{error}</p> : null}
      {note ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800">{note}</p> : null}

      {review ? <div className="space-y-3">
        <p><strong>{review.code}</strong> {review.name} · {existing ? <span className="text-emerald-700">already in the CMS: Sync adds the electives and documents found</span> : <span>new course</span>}</p>
        <p className="text-foreground-600">{review.core.length} core units ({sorted.core.length} named in the documents), {sorted.electives.length} electives found, {sorted.outside.length} from outside the qualification · {mappedCount} of {docs.length} documents matched to a unit.</p>
        <div className="max-h-80 overflow-y-auto rounded-lg border border-background-200">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-background-50"><tr className="text-xs text-foreground-500"><th className="px-3 py-2">Unit</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Documents</th></tr></thead>
            <tbody>{courseUnits.map(u => <tr key={u.code} className="border-t border-background-100 align-top">
              <td className="px-3 py-1.5 font-semibold">{u.code}</td><td className="px-3 py-1.5">{u.name}</td>
              <td className="px-3 py-1.5 text-xs text-foreground-500">{u.tag}</td>
              <td className="px-3 py-1.5 text-xs">{(docsByUnit.get(u.code) ?? []).map(f => <div key={f.name}>{baseName(f.path)}</div>)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {sorted.outside.length ? <label className="flex items-center gap-2"><input type="checkbox" checked={includeOutside} disabled={!!syncing} onChange={e => setIncludeOutside(e.target.checked)} />
          Also add {sorted.outside.join(", ")} (outside the qualification) as imported elective{sorted.outside.length === 1 ? "" : "s"}, checked on Training.gov.au</label> : null}
      </div> : null}

      {files.length ? <div className="space-y-1">
        <p className="text-xs font-semibold text-foreground-600">Documents and their units</p>
        <ul className="max-h-64 space-y-1 overflow-y-auto">{files.map(f => <li key={f.name} className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 flex-1 break-all">{f.name}</span>
          {f.error ? <span className="text-red-700">{f.error}</span>
            : review ? <select aria-label={`Unit for ${f.name}`} className="rounded-md border border-background-300 px-2 py-1 text-xs" disabled={!!syncing}
              value={unitOf(f)} onChange={e => setMapping(m => ({ ...m, [f.name]: e.target.value }))}>
              <option value={NONE}>Course document (not on a unit)</option>
              {courseUnits.map(u => <option key={u.code} value={u.code}>{u.code}{u.name ? ` · ${u.name}` : ""}</option>)}
            </select>
            : <span className="text-foreground-500">{new Set(codesIn(`${f.path}\n${f.text}`, UNIT)).size} unit codes</span>}
        </li>)}</ul>
      </div> : null}
    </div>
  </Modal>;
}
