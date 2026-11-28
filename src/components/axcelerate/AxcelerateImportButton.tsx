import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Modal } from '@/pages/admin/components/ui';
import { ENTITY_LABEL, runAxcelerateImport, runTotals, useImportAllowed, type ImportEntity, type ImportRun } from '@/lib/axcelerateImport';
import AxcelerateRunLog from './AxcelerateRunLog';

const WHAT: Record<string, string> = {
  trainers: 'the trainers named on aXcelerate’s classes, as Active staff with the trainer role (no sign-in invitation is sent)',
  classes: 'aXcelerate’s classes as intakes, with their units, trainer and location; a course, unit, location or trainer that Skyline does not have yet is created',
  breaks: 'aXcelerate’s calendar events as term breaks of the courses that have classes from aXcelerate',
};

/**
 * "Import from aXcelerate" (AXCELERATE-IMPORT): imports only this page's data, with the same engine as the dashboard's Import
 * everything. Shown only to holders of the aXcelerate import permission (the server checks it again).
 * mode "everything" runs every entity in order (the dashboard card).
 */
export default function AxcelerateImportButton({ entities, mode = 'page', label, onDone, variant = 'outline', size = 'md' }: {
  entities: ImportEntity[]; mode?: 'page' | 'everything'; label?: string; onDone?: () => void; variant?: 'outline' | 'primary'; size?: 'sm' | 'md';
}) {
  const allowed = useImportAllowed();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<ImportRun | null>(null);
  const [error, setError] = useState('');
  if (!allowed) return null;
  const list = mode === 'everything' ? (['trainers', 'classes', 'breaks'] as ImportEntity[]) : entities;
  const start = async () => {
    setBusy(true); setError(''); setRun(null);
    try { setRun(await runAxcelerateImport({ entities: list, mode }, setRun)); onDone?.(); }
    catch (e) { setError(e instanceof Error ? e.message : 'The import stopped.'); }
    finally { setBusy(false); }
  };
  const totals = run ? runTotals(run) : null;
  return <>
    <Button variant={variant} size={size} icon="ri-download-cloud-2-line" onClick={() => { setOpen(true); setRun(null); setError(''); }} data-testid={`axcelerate-import-${mode}`}>
      {label ?? 'Import from aXcelerate'}
    </Button>
    <Modal open={open} title={mode === 'everything' ? 'Import everything from aXcelerate' : 'Import from aXcelerate'} keepOpen={busy} onClose={() => { if (!busy) setOpen(false); }}
      footer={<>
        <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{run && !busy ? 'Close' : 'Cancel'}</Button>
        {!run || run.status !== 'done' ? <Button disabled={busy} onClick={() => void start()} data-testid="axcelerate-import-start">{busy ? 'Importing…' : 'Start import'}</Button> : null}
      </>}>
      <div className="space-y-3 text-sm" data-testid="axcelerate-import-dialog">
        <p>Skyline reads from aXcelerate and creates or updates:</p>
        <ul className="list-disc space-y-1 pl-5">{list.map((e) => <li key={e}><strong>{ENTITY_LABEL[e]}:</strong> {WHAT[e]}.</li>)}</ul>
        <p className="text-foreground-600">Nothing is sent to aXcelerate. Records an admin changed in Skyline are kept (differences go to Conflicts); records deleted in Skyline are not brought back.</p>
        {error && <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p>}
        {run && <div className="rounded border border-background-200 p-3" role="status" data-testid="axcelerate-import-progress">
          {/* // rule-policy: technical axcelerate-import-log 2026-11-28 owner (AXCELERATE-IMPORT-LOG): import result wording and log size; no configurable value. */}
          <p className="font-medium">{run.status === 'running' ? `Working… (${run.cursor?.stage ?? 'starting'})` : run.status === 'done' ? (totals && !totals.brought && !totals.notBrought ? 'Import finished, but nothing came from aXcelerate.' : 'Import finished.') : run.status === 'cancelled' ? 'Import cancelled.' : 'Import stopped.'}</p>
          <div className="mt-2"><AxcelerateRunLog run={run} /></div>
          {run.status !== 'running' && <p className="mt-2"><Link className="font-medium text-primary-700 hover:underline" to="/admin/integrations/axcelerate">Open the Import centre</Link> for errors, conflicts and the audit log.</p>}
        </div>}
      </div>
    </Modal>
  </>;
}
