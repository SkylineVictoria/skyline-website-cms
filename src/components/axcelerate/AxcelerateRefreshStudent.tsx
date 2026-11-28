import { useEffect, useState } from 'react';
import { Button, Modal } from '@/pages/admin/components/ui';
import { recordBadge, runAxcelerateImport, useImportAllowed, type ImportRun } from '@/lib/axcelerateImport';
import { RunSummary, StudentOutcome } from '@/components/axcelerate/AxcelerateRecordImport';

/**
 * Student page: "Refresh from aXcelerate" (AXCELERATE-IMPORT-SCREENS). For a student imported from aXcelerate, imports them again with
 * everything they have there (details, agent and agency, each course's class and Qualification). Admin edits are kept (conflicts).
 */
export default function AxcelerateRefreshStudent({ studentId, onDone }: { studentId: string; onDone?: () => void }) {
  const allowed = useImportAllowed();
  const [contactId, setContactId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<ImportRun | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!allowed) return;
    let live = true;
    void recordBadge('public.enrollment_students', studentId).then((b) => { if (live) setContactId(b?.entity === 'student' ? b.axcelerateId ?? null : null); });
    return () => { live = false; };
  }, [allowed, studentId]);
  if (!allowed || !contactId) return null;
  const refresh = async () => {
    setBusy(true); setError(''); setRun(null);
    try { setRun(await runAxcelerateImport({ entities: ['students'], mode: 'page', students: { scope: 'one', contactId } }, setRun)); onDone?.(); }
    catch (e) { setError(e instanceof Error ? e.message : 'The import stopped.'); }
    finally { setBusy(false); }
  };
  const result = run?.cursor?.results?.[0];
  return <>
    <Button size="sm" variant="outline" icon="ri-refresh-line" onClick={() => { setOpen(true); setRun(null); setError(''); }} data-testid="axcelerate-refresh-student">Refresh from aXcelerate</Button>
    <Modal open={open} title="Refresh from aXcelerate" keepOpen={busy} onClose={() => { if (!busy) setOpen(false); }}
      footer={<>
        <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Close</Button>
        {!run || run.status !== 'done' ? <Button disabled={busy} onClick={() => void refresh()} data-testid="axcelerate-refresh-start">{busy ? 'Importing…' : 'Refresh now'}</Button> : null}
      </>}>
      <div className="space-y-3 text-sm">
        <p>Skyline reads this student again from aXcelerate (contact {contactId}) with everything they have there: their details, their agent and agency, and each course with its class and Qualification. Nothing is sent to aXcelerate. Fields an admin changed in Skyline are kept (differences go to Conflicts in the Import centre).</p>
        {error && <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p>}
        {result ? <StudentOutcome r={result} /> : run ? <RunSummary run={run} /> : null}
      </div>
    </Modal>
  </>;
}
