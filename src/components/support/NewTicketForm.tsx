import { useEffect, useState } from "react";
import { CATEGORY_LABEL, PRIORITY_LABEL, createTicket, ticketStudents, uploadTicketFiles, type TicketCategory, type TicketPriority } from "@/lib/supportTickets";

/** New ticket form for students and agents. Agents can say which student the ticket is about. */
export default function NewTicketForm({ isStudent, onCreated, onCancel }: { isStudent: boolean; onCreated: (id: string, ref: string) => void; onCancel: () => void }) {
  const [category, setCategory] = useState<TicketCategory>("enrolment_documents");
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [students, setStudents] = useState<{ id: string; name: string }[]>([]);
  const [studentId, setStudentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { if (!isStudent) ticketStudents().then(setStudents).catch(() => setStudents([])); }, [isStudent]);

  const submit = async () => {
    setError("");
    if (subject.trim().length < 3) { setError("Add a short subject."); return; }
    if (!body.trim()) { setError("Describe the issue."); return; }
    setBusy(true);
    try {
      const attachments = await uploadTicketFiles(files);
      const r = await createTicket({ category, subject: subject.trim(), body: body.trim(), priority, attachments, studentId: isStudent ? null : studentId || null });
      onCreated(r.id, r.ref);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The ticket could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const field = "mt-1 block w-full rounded-md border border-background-300 px-3 py-2 text-sm";
  return (
    <form className="space-y-4 rounded-lg border border-background-200 bg-background-50 p-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="font-heading text-lg font-semibold text-foreground-900">New ticket</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium text-foreground-800">Category
          <select className={field} value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)}>
            {(Object.keys(CATEGORY_LABEL) as TicketCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium text-foreground-800">Priority
          <select className={field} value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
            {(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </label>
      </div>
      {!isStudent && students.length ? (
        <label className="block text-sm font-medium text-foreground-800">About a student (optional)
          <select className={field} value={studentId} onChange={(e) => setStudentId(e.target.value)}>
            <option value="">Not about a specific student</option>
            {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      ) : null}
      <label className="block text-sm font-medium text-foreground-800">Subject
        <input className={field} maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. CoE not received" />
      </label>
      <label className="block text-sm font-medium text-foreground-800">Description
        <textarea className={`${field} min-h-[140px]`} maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What do you need help with?" />
      </label>
      <label className="block text-sm font-medium text-foreground-800">Attachments (optional, up to 5 files, 10 MB each)
        <input type="file" multiple className="mt-1 block w-full text-sm" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.doc,.docx,.xls,.xlsx"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 5))} />
      </label>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className="rounded-md bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">
          {busy ? "Sending…" : "Submit ticket"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-md border border-background-300 px-4 py-2 text-sm font-semibold text-foreground-800">Cancel</button>
      </div>
    </form>
  );
}
