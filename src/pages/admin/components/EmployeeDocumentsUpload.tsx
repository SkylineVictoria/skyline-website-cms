import { useRef, useState, type DragEvent } from "react";
import { Button, Select } from "@/pages/admin/components/ui";
import {
  EMPLOYEE_DOC_ACCEPT, EMPLOYEE_DOC_CATEGORIES, duplicateCategories, employeeFileProblem, guessDocCategory, uploadEmployeeDocument,
  type EmployeeDocCategory,
} from "@/lib/employeesApi";

interface Item { key: string; file: File; category: EmployeeDocCategory; problem: string; state: "ready" | "uploading" | "done" | "failed" }
const size = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * Several documents in one go: choose or drop the files, check the type guessed for each, then Upload all. Each file is uploaded on
 * its own, so one failure never loses the others; failed files stay in the list with the reason to try again.
 */
export default function EmployeeDocumentsUpload({ employeeId, onUploaded }: { employeeId: string; onUploaded: (message: string) => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const add = (files: FileList | File[]) => {
    setError("");
    setItems((current) => {
      const next = [...current.filter((i) => i.state !== "done")];
      for (const file of Array.from(files)) {
        if (next.some((i) => i.file.name === file.name && i.file.size === file.size)) continue; // the same file twice
        next.push({ key: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file, category: guessDocCategory(file.name, next.map((i) => i.category)),
          problem: employeeFileProblem(file) ?? "", state: "ready" });
      }
      return next;
    });
    if (input.current) input.current.value = "";
  };
  const patch = (key: string, next: Partial<Item>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...next } : i)));
  const pending = items.filter((i) => i.state !== "done");
  const duplicates = duplicateCategories(pending.map((i) => i.category));

  const uploadAll = async () => {
    if (busy) return;
    const todo = pending;
    if (!todo.length) { setError("Choose at least one file."); return; }
    if (todo.some((i) => employeeFileProblem(i.file))) { setError("Remove the files marked in red first."); return; }
    if (duplicates.length) { setError(`Each type once per upload: ${duplicates.join(", ")} is chosen for more than one file.`); return; }
    setBusy(true); setError("");
    let done = 0;
    for (const item of todo) {
      patch(item.key, { state: "uploading", problem: "" });
      try { await uploadEmployeeDocument(employeeId, item.category, item.file); patch(item.key, { state: "done" }); done += 1; }
      catch (e) { patch(item.key, { state: "failed", problem: e instanceof Error ? e.message : "The file could not be uploaded." }); }
    }
    setBusy(false);
    const failed = todo.length - done;
    if (done) onUploaded(failed ? `${done} uploaded; ${failed} could not be uploaded (see below).` : `${done} ${done === 1 ? "document" : "documents"} uploaded.`);
    setItems((list) => list.filter((i) => i.state !== "done"));
  };

  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); if (!busy && e.dataTransfer.files.length) add(e.dataTransfer.files); };

  return (
    <div className="mb-4" data-testid="employee-upload">
      <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
        className={`flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-6 text-center text-sm ${dragging ? "border-primary-500 bg-primary-50" : "border-background-300"}`}>
        <i className="ri-upload-cloud-2-line text-2xl text-foreground-500" aria-hidden="true" />
        <p className="text-foreground-700">Drop files here, or</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()} icon="ri-folder-open-line">Choose files</Button>
        <p className="text-xs text-foreground-500">Pick several at once. PDF, JPG, PNG or Word, up to 10 MB each.</p>
        <input ref={input} type="file" multiple accept={EMPLOYEE_DOC_ACCEPT} className="sr-only" tabIndex={-1} aria-label="Choose files"
          onChange={(e) => { if (e.target.files?.length) add(e.target.files); }} data-testid="employee-files" />
      </div>

      {pending.length ? (
        <>
          <ul className="mt-3 divide-y divide-background-200 rounded-md border border-background-200" data-testid="employee-upload-list">
            {pending.map((i) => (
              <li key={i.key} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block break-all font-medium text-foreground-950">{i.file.name}</span>
                  <span className="text-xs text-foreground-500">{size(i.file.size)}</span>
                  {i.problem ? <span role="alert" className="block text-xs text-primary-700">{i.problem}</span> : null}
                  {duplicates.includes(i.category) && !i.problem ? <span className="block text-xs text-primary-700">Another file has this type too.</span> : null}
                </span>
                <div className="w-48"><Select aria-label={`Document type for ${i.file.name}`} value={i.category} disabled={busy}
                  onChange={(e) => patch(i.key, { category: e.target.value as EmployeeDocCategory })}>
                  {EMPLOYEE_DOC_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select></div>
                {i.state === "uploading" ? <span className="text-xs text-foreground-600">Uploading…</span>
                  : <Button size="sm" variant="ghost" disabled={busy} onClick={() => setItems((list) => list.filter((x) => x.key !== i.key))} aria-label={`Remove ${i.file.name} from the list`}>Remove</Button>}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button onClick={() => void uploadAll()} disabled={busy} icon="ri-upload-2-line" data-testid="employee-upload-button">
              {busy ? "Uploading…" : `Upload ${pending.length} ${pending.length === 1 ? "file" : "files"}`}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setItems([]); setError(""); }}>Clear</Button>
          </div>
        </>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-sm text-primary-700">{error}</p> : null}
    </div>
  );
}
