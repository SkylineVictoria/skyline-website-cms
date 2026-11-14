import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { sendUnitDocument, unitDocuments, type UnitDocumentTemplate } from "@/lib/unitDocuments";
import type { BatchStudent } from "@/pages/admin/lib/rto";

// hr.sign_status: draft, sent, viewed, partial, signed, declined, expired, void. A closed request can be sent again.
const SIGNED = new Set(["signed"]);
const CLOSED = new Set(["declined", "void", "expired"]);

/** UNIT-DOCS: the selected unit's document templates (Sign › Templates › Units), sent to each active student of the batch to sign. */
export default function UnitDocumentsPanel({ batchId, batchName, unitId, students, disabled }: {
  batchId: string; batchName: string; unitId: string; students: BatchStudent[]; disabled?: boolean;
}) {
  const [templates, setTemplates] = useState<UnitDocumentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try { setTemplates(await unitDocuments<UnitDocumentTemplate[]>("batch_status", { batchId, unitId })); setError(""); }
    catch (e) { setTemplates([]); setError(e instanceof Error ? e.message : "Unable to load unit documents"); }
    finally { setLoading(false); }
  }, [batchId, unitId]);
  useEffect(() => { setNotice(""); void load(); }, [load]);
  const active = students.filter((s) => s.status === "active");

  const send = async (template: UnitDocumentTemplate) => {
    if (sending) return;
    const sent = new Set(template.sends.filter((s) => s.requestId && !CLOSED.has(String(s.state))).map((s) => s.studentId));
    const todo = active.filter((s) => !sent.has(s.id));
    const noEmail = todo.filter((s) => !s.email);
    const targets = todo.filter((s) => s.email);
    if (!targets.length) { setNotice(noEmail.length ? `${noEmail.length} student(s) have no email address, so nothing was sent.` : "Every active student already has this document."); return; }
    if (!window.confirm(`Send "${template.name}" to ${targets.length} student${targets.length === 1 ? "" : "s"} in ${batchName} to sign? Each gets an email with their own signing link.`)) return;
    setSending(template.templateId); setError(""); setNotice("");
    const failed: string[] = [];
    for (const [i, s] of targets.entries()) {
      setProgress(`Sending ${i + 1} of ${targets.length}…`);
      try { await sendUnitDocument(template, batchId, s); }
      catch (e) { failed.push(`${s.name}: ${e instanceof Error ? e.message : "not sent"}`); if (failed.length === 1 && /signers/.test(String((e as Error)?.message))) break; }
    }
    setProgress(""); setSending(null);
    const ok = targets.length - failed.length;
    setNotice(`${ok} of ${targets.length} sent.${noEmail.length ? ` ${noEmail.length} without an email address skipped.` : ""}`);
    if (failed.length) setError(failed.slice(0, 5).join(" · ") + (failed.length > 5 ? ` · and ${failed.length - 5} more` : ""));
    await load();
  };

  return <div className="rounded-lg border border-background-200 p-3" data-testid="unit-documents">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">Unit documents to sign</h3>
      <Link className="text-sm font-semibold text-primary-600 underline" to="/admin/signing/templates">Manage templates</Link>
    </div>
    {error && <p role="alert" className="mb-2 break-words rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-800">{error}</p>}
    {notice && <p role="status" className="mb-2 rounded-lg border border-green-200 bg-green-50 p-2 text-sm text-green-800">{notice}</p>}
    {loading ? <p className="text-sm text-foreground-500">Loading unit documents…</p>
      : !templates.length ? <p className="text-sm text-foreground-500">No document templates for this unit. Create one in Sign › Templates › New template › Units / Assessments.</p>
      : <ul className="divide-y divide-background-100">{templates.map((t) => {
        const live = t.sends.filter((s) => s.requestId && !CLOSED.has(String(s.state)));
        const signed = live.filter((s) => SIGNED.has(String(s.state))).length;
        const pending = active.filter((s) => !live.some((x) => x.studentId === s.id)).length;
        return <li key={t.templateId} className="flex flex-wrap items-center justify-between gap-2 py-3">
          <div className="min-w-0"><p className="break-words font-medium">{t.name}</p>
            <p className="text-xs text-foreground-500">v{t.version} · Sent {live.length} · Signed {signed} · Not sent {pending}</p></div>
          <button type="button" className="rounded-lg bg-primary-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={disabled || !!sending || !pending}
            onClick={() => void send(t)}>{sending === t.templateId ? progress || "Sending…" : pending ? `Send to ${pending} student${pending === 1 ? "" : "s"}` : "All sent"}</button>
        </li>;
      })}</ul>}
  </div>;
}
