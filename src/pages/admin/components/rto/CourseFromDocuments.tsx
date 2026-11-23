// Add a course from documents (owner, 2026-11-23): staff drop in course documents (PDF, Word, text, CSV or a ZIP folder of
// them). The text is read in the browser; the qualification code and unit codes in the text and in the file / folder names
// are found, and Training.gov.au says which units are core, elective or from outside the qualification. Each document is
// mapped to its unit (the unit code in its file or folder name, else the one unit its text is about) and can be changed.
// Sync: the draft course with its core units (tga-course-import create_core), the documents' electives (add_units, packaging
// rules checked by the function), each mapped document saved to its unit's Learning content (staff only, not shown to
// students), and the units' SLIT hours confirmed from the nominal hours (40 / 40 / 20). The course then needs only its
// weekly and daily calendars; units or hours open only when the documents could not settle them.
import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { invokeTga } from "@/pages/admin/lib/tga";
import { supabase } from "@/pages/admin/lib/supabase";
import { autoPickElectives, checkElectives, groupSizes, parseElectiveRules, type ElectiveUnit } from "../../../../../supabase/functions/tga-course-import/packaging";
import { bulkAdmin, bulkBucket, categories, categoryLabel, type Audience, type BulkPolicy, type Category, type ImportFile } from "@/pages/admin/lib/bulkResources";
import { loadUnitHours, rto, saveUnitHours, suggestHours, weeksForHours, type CourseDetail, type RtoCourse } from "@/pages/admin/lib/rto";

interface Review {
  code: string; name: string; core: { code: string; name: string }[]; electives: { code: string; name: string; groups: string[] }[];
  packagingRules: string; requiredElectives: number | null; groups: Record<string, unknown>;
}
interface ReadFile { name: string; path: string; text: string; bytes?: Uint8Array; error?: string }
/** What happened to one document at Sync, shown before the dialog closes (owner, 2026-11-23: the files were not mapped). */
type Outcome = { file: string; unit: string; status: "saved" | "already" | "failed" | "unmatched"; reason?: string };
/** Where Sync goes next: the documents settled everything (the weekly calendar), or units / hours are still to choose. */
export type FromDocsNext = "master" | "units" | "hours";

const QUAL = /(?<![A-Z0-9])[A-Z]{3}\d{5}(?![A-Z0-9])/g;
const UNIT = /(?<![A-Z0-9])[A-Z]{5,8}\d{3,4}[A-Z]?(?![A-Z0-9])/g;
const norm = (value: string | null | undefined) => (value ?? "").trim().toUpperCase();
const codesIn = (value: string, re: RegExp) => value.toUpperCase().match(re) ?? [];
const MAX_MB = 20;
/** Text is read from these (to find unit codes); every ACCEPTED file is kept and mapped by its file / folder name too. */
const READABLE = /\.(pdf|docx|txt|csv)$/i;
const ACCEPTED = /\.(pdf|docx?|pptx?|xlsx?|txt|csv|png|jpe?g|webp)$/i;
const ZIP_MAX_FILES = 200;
const ZIP_MAX_MB = 200;
// The types the unit-content bucket accepts (20261117064117); a CSV is stored as plain text (text/csv is not allowed there).
const MIME: Record<string, string> = {
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain", csv: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
};
/** A kept file: its text when it can be read (an unreadable one keeps "" and is mapped by its name). */
async function keep(name: string, path: string, bytes: Uint8Array): Promise<ReadFile> {
  const text = READABLE.test(path) ? await readText(path, bytes).catch(() => "") : "";
  return { name, path, text, bytes };
}
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

/** One chosen file, or every document inside a ZIP folder (folders inside it included; nested ZIPs skipped). */
async function readFile(file: File): Promise<ReadFile[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!/\.zip$/i.test(file.name)) {
    if (!ACCEPTED.test(file.name)) throw new Error("Use PDF, Word, PowerPoint, Excel, text, CSV, image or ZIP files.");
    return [await keep(file.name, file.name, bytes)];
  }
  const { unzipSync } = await import("fflate");
  let total = 0; let count = 0; const skipped: string[] = [];
  const entries = unzipSync(bytes, {
    filter: entry => {
      if (entry.name.endsWith("/") || entry.name.startsWith("__MACOSX/") || /(^|\/)\./.test(entry.name)) return false;
      if (!ACCEPTED.test(entry.name)) { skipped.push(baseName(entry.name)); return false; }
      total += entry.originalSize; count++;
      if (count > ZIP_MAX_FILES || total > ZIP_MAX_MB * 1024 * 1024) throw new Error(`The ZIP holds more than ${ZIP_MAX_FILES} documents or ${ZIP_MAX_MB} MB.`);
      return true;
    },
  });
  const out: ReadFile[] = [];
  for (const [path, data] of Object.entries(entries)) out.push(await keep(`${file.name} › ${path}`, path, data));
  if (!out.length) throw new Error("No documents in this ZIP.");
  if (skipped.length) out.push({ name: `${file.name}: ${skipped.length} file${skipped.length === 1 ? "" : "s"} of another type skipped (${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""})`, path: "", text: "", error: "Type not stored on units." });
  return out;
}

/** The resource category a document is filed under (owner, 2026-11-23: Learning Materials, Assessments, Self-Assessment,
 *  Assessor Resources), guessed from its file name; staff change it before Sync. */
function guessCategory(path: string): Category {
  const name = baseName(path).toLowerCase();
  if (/self[\s_-]*assess/.test(name)) return "self_assessment";
  if (/benchmark|marking|mapping|assessor|observation|instruction|answer|solution|rubric|validation/.test(name)) return "assessor";
  if (/assess|task|quiz|test|exam|project|portfolio/.test(name)) return "assessment";
  return "learning";
}
/** Who may see a resource of each category: learners see learning material and self-assessments; assessment packs staff;
 *  assessor material assessors only (the server holds anything not student-safe for assessors whatever is sent). */
const AUDIENCE: Record<Category, Audience> = { learning: "student_staff", self_assessment: "student_staff", assessment: "staff", assessor: "assessor" };
const pause = (ms: number) => new Promise(done => window.setTimeout(done, ms));
/** How long Sync waits for the AI reader before leaving the rest for AI Bulk Upload. */
const AI_WAIT_MS = 4 * 60 * 1000;

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
  /** The category picked per document (by name); unset = the guess from its file name. */
  const [category, setCategory] = useState<Record<string, Category>>({});
  const [policy, setPolicy] = useState<BulkPolicy | null>(null);
  const categoryOf = (f: ReadFile) => category[f.name] ?? guessCategory(f.path);
  // The AI Bulk Upload policy (file types, sizes, category names); without it (no permission) documents go to Learning content.
  useEffect(() => {
    if (!open) return;
    let live = true;
    bulkAdmin<BulkPolicy>("policy").then(p => { if (live) setPolicy(p); }, () => { if (live) setPolicy(null); });
    return () => { live = false; };
  }, [open]);
  /** Staff confirm the packaging rules the system cannot check by itself (as in Add units). */
  const [attested, setAttested] = useState(false);
  const [done, setDone] = useState<{ courseId: string; next: FromDocsNext; message: string; outcomes: Outcome[] } | null>(null);
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
  const uncheckedRules = useMemo(() => (review ? parseElectiveRules(review.packagingRules, review.requiredElectives, Object.keys(review.groups ?? {}), groupSizes(review.electives)).unchecked : []), [review]);
  const mappedCount = [...docsByUnit.values()].reduce((n, l) => n + l.length, 0);

  function reset() {
    setFiles([]); setQualification(""); setReview(null); setError(""); setNote(""); setIncludeOutside(false); setMapping({}); setCategory({}); setAttested(false); setDone(null);
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

  /** The prerequisite unit codes of each unit, from Training.gov.au, eight at a time (unreadable units have none). */
  async function readPrerequisites(list: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const queue = [...new Set(list)];
    const worker = async () => {
      while (queue.length) {
        const code = queue.shift()!;
        try { out.set(code, (await tga<{ prerequisiteCodes?: string[] }>({ action: "unit_lookup", code })).prerequisiteCodes ?? []); }
        catch { out.set(code, []); }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return out;
  }

  /** Each mapped document into its unit's Learning content (staff only); a file already there by name is not added again. */
  /** The documents as unit Resources under their categories (the AI Bulk Upload pipeline): sent, read by the AI reader,
   *  then approved with the unit and category chosen here. A file the reader has not finished within AI_WAIT_MS is left in
   *  AI Bulk Upload to approve (the Units list shows it as Not approved yet). */
  async function saveResources(targets: { f: ReadFile; code: string; unitId: string }[], out: Outcome[]) {
    if (!policy) return;
    const fits = targets.filter(t => t.f.bytes && policy.formats.includes((t.f.path.split(".").pop() ?? "").toLowerCase())
      && t.f.bytes.byteLength > 0 && t.f.bytes.byteLength <= Math.min(25, policy.max_mib) * 1048576);
    for (const t of targets.filter(t => !fits.includes(t))) out.push({ file: t.f.path, unit: t.code, status: "failed", reason: "file type or size is outside the AI Bulk Upload policy" });
    for (let start = 0; start < fits.length; start += Math.max(1, policy.max_files)) {
      const batch = fits.slice(start, start + Math.max(1, policy.max_files));
      setSyncing(`Uploading ${batch.length} document${batch.length === 1 ? "" : "s"}…`);
      const job = await bulkAdmin<{ id: string; files: ImportFile[] }>("begin", { files: batch.map(t => ({ name: baseName(t.f.path), path: t.f.path, bytes: t.f.bytes!.byteLength })) });
      const rowFor = new Map(job.files.map((row, i) => [row.id, batch[i]]));
      const queue = [...job.files];
      const failed = new Set<string>();
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (queue.length) {
          const row = queue.shift()!;
          const t = rowFor.get(row.id)!;
          try {
            const up = await supabase.storage.from(bulkBucket).upload(row.object_path, new Blob([t.f.bytes!.slice()]), { upsert: false, contentType: "application/octet-stream" });
            if (up.error) throw up.error;
            await bulkAdmin("uploaded", { job: job.id, id: row.id });
          } catch (e) { failed.add(row.id); out.push({ file: t.f.path, unit: t.code, status: "failed", reason: e instanceof Error ? e.message : "upload failed" }); }
        }
      }));
      // Wait for the AI reader (it runs every minute on the server).
      const until = Date.now() + AI_WAIT_MS;
      let rows: ImportFile[] = [];
      for (;;) {
        rows = await bulkAdmin<ImportFile[]>("detail", { job: job.id });
        const waiting = rows.filter(r => !failed.has(r.id) && !["review", "failed", "excluded", "imported"].includes(r.state));
        setSyncing(`The AI reader is reading the documents: ${rows.length - waiting.length - failed.size} of ${rows.length - failed.size} done…`);
        if (!waiting.length || Date.now() > until) break;
        await pause(5000);
      }
      const ready = rows.filter(r => r.state === "review");
      const items = ready.map(r => { const t = rowFor.get(r.id)!; const cat = categoryOf(t.f); return { id: r.id, unit: t.unitId, category: cat, audience: AUDIENCE[cat], reviewed: true, skipExisting: true }; });
      const results = items.length ? await bulkAdmin<{ id: string; ok: boolean; error?: string }[]>("approve", { job: job.id, items }) : [];
      const byId = new Map(results.map(r => [r.id, r]));
      for (const r of rows) {
        if (failed.has(r.id)) continue;
        const t = rowFor.get(r.id)!;
        const label = categoryLabel(categoryOf(t.f), policy);
        const result = byId.get(r.id);
        if (result?.ok) out.push({ file: t.f.path, unit: t.code, status: "saved", reason: label });
        else if (result) out.push({ file: t.f.path, unit: t.code, status: "failed", reason: result.error ?? "not approved" });
        else if (r.state === "failed") out.push({ file: t.f.path, unit: t.code, status: "failed", reason: `the AI reader could not read it${r.failure ? ` (${r.failure})` : ""}: retry in AI Bulk Upload` });
        else if (r.state === "imported" || r.state === "excluded") out.push({ file: t.f.path, unit: t.code, status: "already" });
        else out.push({ file: t.f.path, unit: t.code, status: "failed", reason: `still being read: approve it as ${label} in AI Bulk Upload when it is ready` });
      }
    }
  }

  async function saveDocuments(detail: CourseDetail): Promise<Outcome[]> {
    const ids = new Map(detail.units.filter(u => u.id && u.isActive).map(u => [norm(u.code), u.id as string]));
    const out: Outcome[] = [];
    // A document matched to a unit that did not make it onto the course goes to the course unit it is about instead, if any.
    const onCourse = new Set(ids.keys());
    const byUnit = new Map<string, ReadFile[]>();
    const mapped = new Set<string>();
    for (const [code, list] of docsByUnit) for (const f of list) {
      const target = ids.has(code) ? code : guessUnit(f, onCourse) || code;
      byUnit.set(target, [...(byUnit.get(target) ?? []), f]); mapped.add(f.name);
    }
    // Documents never matched to a unit: matched now against the units actually on the course, else listed.
    for (const f of docs.filter(d => !mapped.has(d.name) && mapping[d.name] === undefined)) {
      const target = guessUnit(f, onCourse);
      if (target) byUnit.set(target, [...(byUnit.get(target) ?? []), f]);
      else out.push({ file: f.path, unit: "", status: "unmatched", reason: "no unit code in its file or folder name or text" });
    }
    const resources: { f: ReadFile; code: string; unitId: string }[] = [];
    for (const [code, list] of byUnit) {
      const unitId = ids.get(code);
      if (!unitId) { out.push(...list.map(f => ({ file: f.path, unit: code, status: "failed" as const, reason: `${code} is not a unit of this course` }))); continue; }
      // With AI Bulk Upload available, every document goes to the unit's Resources under its category.
      if (policy) { resources.push(...list.map(f => ({ f, code, unitId }))); continue; }
      const { data: have } = await supabase.from("unit_contents").select("file_name,sort").eq("unit_id", unitId);
      const names = new Set((have ?? []).map(r => r.file_name as string | null));
      let sort = Math.max(-1, ...(have ?? []).map(r => Number(r.sort) || 0));
      for (const f of list) {
        const fileName = baseName(f.path).slice(0, 200);
        if (names.has(fileName)) { out.push({ file: f.path, unit: code, status: "already" }); continue; }
        if (!f.bytes) { out.push({ file: f.path, unit: code, status: "failed", reason: "the file could not be read" }); continue; }
        const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? null;
        const limit = await supabase.rpc("unit_learning_file_limit", { p_unit_id: unitId, p_extension: extension });
        if (limit.error || typeof limit.data !== "number") { out.push({ file: f.path, unit: code, status: "failed", reason: limit.error?.message ?? "the file limit could not be checked" }); continue; }
        if (f.bytes.byteLength > limit.data) { out.push({ file: f.path, unit: code, status: "failed", reason: `larger than the unit content limit (${Math.round(limit.data / 1048576)} MB)` }); continue; }
        const mime = MIME[extension ?? ""] ?? "application/octet-stream";
        const path = `${unitId}/${crypto.randomUUID().slice(0, 8)}-${safeName(fileName)}`;
        const up = await supabase.storage.from("unit-content").upload(path, new Blob([f.bytes.slice()], { type: mime }), { contentType: mime, upsert: false });
        if (up.error) { out.push({ file: f.path, unit: code, status: "failed", reason: up.error.message }); continue; }
        const { error } = await supabase.from("unit_contents").insert({
          unit_id: unitId, kind: "file", title: fileName.replace(/\.[a-z0-9]+$/i, "").slice(0, 200) || fileName, body: "", url: null, storage_path: path,
          file_name: fileName, mime_type: mime, size_bytes: f.bytes.byteLength, sort: ++sort, visible_to_students: false,
        });
        if (error) { await supabase.storage.from("unit-content").remove([path]); out.push({ file: f.path, unit: code, status: "failed", reason: error.message }); continue; }
        names.add(fileName); out.push({ file: f.path, unit: code, status: "saved", reason: "Learning content" });
      }
    }
    if (resources.length) await saveResources(resources, out);
    return out;
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
      // Electives, as "Let AI select them" in Add units does: every unit's prerequisites are read from Training.gov.au, the
      // packaging rules pick a set (electives with their own documents first, then the others found in the documents, then
      // the rest of the qualification), and prerequisites from outside the qualification are added with them. A course whose
      // electives already meet the rules gets nothing added. Add units opens only when no set can be found or saved.
      let next: FromDocsNext = "master";
      let stuck = "";
      // Electives in their own step (owner, 2026-11-23: the documents were not saved when this step failed): an error here is
      // reported and the Add units step offered; the documents are saved and listed whatever happens.
      try {
        let codes: string[] = []; let outside: string[] = [];
        const before = await rto<CourseDetail>("course_get", { courseId });
        const official = new Map(review.electives.map(u => [norm(u.code), u]));
        const coreCodes = new Set(review.core.map(u => norm(u.code)));
        const isActive = (code: string) => before.units.some(u => u.isActive && norm(u.code) === norm(code));
        const current: ElectiveUnit[] = before.units.filter(u => u.isActive && u.unitType !== "core")
          .map(u => ({ code: norm(u.code), groups: official.get(norm(u.code))?.groups ?? null }));
        const rules = parseElectiveRules(review.packagingRules, review.requiredElectives, Object.keys(review.groups ?? {}), groupSizes(review.electives));
        if (!checkElectives(rules, current).complete) {
          setSyncing("Reading the units' prerequisites…");
          const prereqs = await readPrerequisites(review.electives.map(u => norm(u.code)));
          const found = sorted.electives.map(u => u.code);
          const ordered = [...new Set([...found.filter(c => docsByUnit.has(c)), ...found, ...review.electives.map(u => norm(u.code))])].filter(c => !isActive(c));
          const picks = autoPickElectives(rules, ordered.map(code => ({ code, groups: official.get(code)?.groups ?? [], prerequisites: prereqs.get(code) ?? [] })), current, isActive);
          if (!picks) stuck = `the packaging rules could not be met from ${review.code}'s electives`;
          else {
            codes = picks;
            // Prerequisites of the picked units that are neither in the qualification nor on the course: added as outside units.
            const have = (code: string) => isActive(code) || coreCodes.has(code) || codes.includes(code) || outside.includes(code);
            let queue = picks.flatMap(c => prereqs.get(c) ?? []).map(norm);
            for (let round = 0; queue.length && round < 4; round++) {
              const extra = [...new Set(queue.filter(c => !have(c) && !official.has(c)))];
              outside = [...outside, ...extra];
              queue = [...(await readPrerequisites(extra)).values()].flat().map(norm);
            }
          }
        }
        const chosenOutside = includeOutside ? sorted.outside.filter(c => !isActive(c) && !outside.includes(c)) : [];
        if (!stuck && (codes.length || outside.length || chosenOutside.length)) {
          setSyncing("Adding the units…");
          let failure = "";
          for (const extra of chosenOutside.length ? [chosenOutside, []] : [[]]) {
            try {
              await tga({ action: "add_units", courseId, codes, imported: [...outside, ...extra], attested: rules.unchecked.length > 0 && attested });
              const n = codes.length + outside.length + extra.length;
              lines.push(`${review.code}: core units and ${n} elective${n === 1 ? "" : "s"} saved (${[...codes, ...outside, ...extra].join(", ")}).`);
              failure = ""; break;
            } catch (e) { failure = e instanceof Error ? e.message : "error"; }
          }
          if (failure) stuck = failure;
        } else if (!stuck) lines.push(`${review.code}: units saved (the course's electives already meet the packaging rules).`);
        if (stuck) { next = "units"; lines.push(`${review.code}: core units saved; electives not added: ${stuck}. Choose them in the Add units step.`); }
      } catch (e) {
        next = "units";
        lines.push(`${review.code}: electives not added: ${e instanceof Error ? e.message : "error"}. Choose them in the Add units step.`);
      }
      const detail = await rto<CourseDetail>("course_get", { courseId });
      let outcomes: Outcome[] = [];
      if (docs.length) {
        setSyncing("Saving the documents to their units…");
        outcomes = await saveDocuments(detail);
        const count = (st: Outcome["status"]) => outcomes.filter(o => o.status === st).length;
        lines.push(`Documents: ${count("saved")} saved to their units${count("already") ? `, ${count("already")} already there` : ""}${count("failed") ? `, ${count("failed")} not saved` : ""}${count("unmatched") ? `, ${count("unmatched")} not matched to a unit` : ""}.`);
      }
      if (next === "master") {
        setSyncing("Confirming the unit hours…");
        try {
          if (await confirmHours(courseId, detail)) lines.push("Unit hours confirmed from the nominal hours. Next: the CoE and VoE weekly calendars, then the daily timetables.");
          else { next = "hours"; lines.push("Some units have no nominal hours: enter them in the hours step."); }
        } catch (e) { next = "hours"; lines.push(`Unit hours not confirmed: ${e instanceof Error ? e.message : "error"}.`); }
      }
      setSyncing("");
      // The result per document stays on screen until Continue (problems first).
      const order = { failed: 0, unmatched: 1, saved: 2, already: 3 } as const;
      setDone({ courseId, next, message: lines.join(" "), outcomes: outcomes.sort((x, y) => order[x.status] - order[y.status]) });
    } catch (e) {
      setSyncing("");
      if (courseId) { setDone({ courseId, next: "units", message: `${lines.join(" ")} Stopped: ${e instanceof Error ? e.message : "error"}`.trim(), outcomes: [] }); return; }
      setError(e instanceof Error ? e.message : "The course could not be synced.");
    }
  }

  const finish = () => { if (!done) return; const d = done; reset(); onCreated(d.courseId, d.next, d.message); };
  const close = () => { if (syncing) return; if (done) { finish(); return; } reset(); onClose(); };
  const NEXT_LABEL: Record<FromDocsNext, string> = { master: "Continue: CoE weekly calendar", units: "Continue: choose the electives", hours: "Continue: unit hours" };
  const STATUS_LABEL: Record<Outcome["status"], string> = { saved: "Saved", already: "Already on the unit", failed: "Not saved", unmatched: "No unit found" };
  const busy = !!syncing || checking || reading;

  return <Modal open={open} title="Add a course from documents" width="max-w-5xl" onClose={close}
    footer={<div className="flex flex-wrap items-center justify-end gap-2">
      {syncing ? <span className="mr-auto text-sm text-foreground-600">{syncing}</span> : null}
      {done ? <Button onClick={finish}>{NEXT_LABEL[done.next]}</Button> : <>
      <Button variant="outline" disabled={!!syncing} onClick={close}>Cancel</Button>
      <Button disabled={!review || busy} onClick={() => void sync()}
        title="Saves the course with its units, the documents on their units and the unit hours; then only the weekly and daily calendars remain">
        {syncing ? "Syncing…" : existing ? `Sync into ${existing.code}` : review ? `Sync: save ${review.code}` : "Sync"}</Button></>}
    </div>}>
    {done ? <div className="space-y-3 text-sm">
      <p role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-green-900">{done.message}</p>
      {done.outcomes.length ? <div className="max-h-[55vh] overflow-y-auto rounded-lg border border-background-200">
        <table className="w-full text-left">
          <thead className="sticky top-0 bg-background-50"><tr className="text-xs text-foreground-500"><th className="px-3 py-2">Document</th><th className="px-3 py-2">Unit</th><th className="px-3 py-2">Result</th></tr></thead>
          <tbody>{done.outcomes.map((o, i) => <tr key={i} className="border-t border-background-100 align-top">
            <td className="break-all px-3 py-1.5">{o.file}</td>
            <td className="px-3 py-1.5 font-semibold">{o.unit || "—"}</td>
            <td className={"px-3 py-1.5 " + (o.status === "saved" || o.status === "already" ? "text-green-800" : "text-red-700")}>{STATUS_LABEL[o.status]}{o.reason ? `: ${o.reason}` : ""}</td>
          </tr>)}</tbody>
        </table>
      </div> : null}
      <p className="text-foreground-600">Saved documents are on each unit's Resources under their category (or Learning content when AI Bulk Upload is not available to you). They show in LMS › Units › Documents.</p>
    </div> : <div className="space-y-4 text-sm">
      <p className="text-foreground-600">Upload the course documents (training plan, unit list, learner guides, assessment tools; a ZIP folder works).
        The qualification and its units are found in them and checked against Training.gov.au, and each document is matched to its unit.
        <strong> Sync</strong> saves the course with its units and hours and puts each document on its unit; then only the weekly and daily calendars are left.</p>
      <label className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed border-background-300 p-5 text-center hover:bg-background-50">
        <span className="font-semibold text-foreground-800">{reading ? "Reading…" : files.length ? "Add more files" : "Choose files"}</span>
        <span className="text-xs text-foreground-500">PDF, Word, PowerPoint, Excel, text, CSV, images or a ZIP folder of them · up to {MAX_MB} MB each, ZIP up to {ZIP_MAX_MB} MB</span>
        <input type="file" multiple className="sr-only" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.csv,.png,.jpg,.jpeg,.webp,.zip"
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
              <td className="px-3 py-1.5 text-xs">{(docsByUnit.get(u.code) ?? []).map(f => <div key={f.name}>{baseName(f.path)}{policy ? <span className="text-foreground-500"> · {categoryLabel(categoryOf(f), policy)}</span> : null}</div>)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {sorted.outside.length ? <label className="flex items-center gap-2"><input type="checkbox" checked={includeOutside} disabled={!!syncing} onChange={e => setIncludeOutside(e.target.checked)} />
          Also add {sorted.outside.join(", ")} (outside the qualification) as imported elective{sorted.outside.length === 1 ? "" : "s"}, checked on Training.gov.au</label> : null}
        {uncheckedRules.length ? <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
          <input type="checkbox" className="mt-0.5" checked={attested} disabled={!!syncing} onChange={e => setAttested(e.target.checked)} />
          <span>Part of the packaging rules cannot be checked automatically ({uncheckedRules.join(" ")}). I confirm the electives follow the official packaging rules.</span></label> : null}
      </div> : null}

      {files.length ? <div className="space-y-1">
        <p className="text-xs font-semibold text-foreground-600">Documents and their units</p>
        <ul className="max-h-64 space-y-1 overflow-y-auto">{files.map(f => <li key={f.name} className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 flex-1 break-all">{f.name}</span>
          {f.error ? <span className="text-red-700">{f.error}</span>
            : review ? <span className="flex flex-wrap gap-2">
              <select aria-label={`Unit for ${f.name}`} className="rounded-md border border-background-300 px-2 py-1 text-xs" disabled={!!syncing}
                value={unitOf(f)} onChange={e => setMapping(m => ({ ...m, [f.name]: e.target.value }))}>
                <option value={NONE}>Course document (not on a unit)</option>
                {courseUnits.map(u => <option key={u.code} value={u.code}>{u.code}{u.name ? ` · ${u.name}` : ""}</option>)}
              </select>
              {policy ? <select aria-label={`Category for ${f.name}`} className="rounded-md border border-background-300 px-2 py-1 text-xs" disabled={!!syncing || !unitOf(f)}
                value={categoryOf(f)} onChange={e => setCategory(c => ({ ...c, [f.name]: e.target.value as Category }))}>
                {categories.map(c => <option key={c} value={c}>{categoryLabel(c, policy)}</option>)}
              </select> : null}
            </span>
            : <span className="text-foreground-500">{new Set(codesIn(`${f.path}\n${f.text}`, UNIT)).size} unit codes</span>}
        </li>)}</ul>
      </div> : null}
    </div>}
  </Modal>;
}
