import { useState } from 'react';
import { BROUGHT, countsText, ENTITY_LABEL, notBroughtReason, runTotals, type ImportRun } from '@/lib/axcelerateImport';

const ACTION: Record<string, string> = { created: 'created', updated: 'updated', linked: 'matched to an existing record', unchanged: 'unchanged', done: 'done' };

/**
 * What one aXcelerate import run did (AXCELERATE-IMPORT): how many records came in and how many did not, the run's notes
 * (why nothing came, when that happens), and the per-record log: each record brought in, and each one not brought in with its reason.
 */
// rule-policy: technical axcelerate-import-log 2026-11-28 owner (AXCELERATE-IMPORT-LOG): import result wording and log size; no configurable value.
export default function AxcelerateRunLog({ run, compact = false }: { run: ImportRun; compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  const { brought, notBrought } = runTotals(run);
  const log = run.cursor?.log ?? [];
  const missed = log.filter((e) => !BROUGHT.has(e.action));
  const came = log.filter((e) => BROUGHT.has(e.action));
  const notes = run.cursor?.notes ?? [];
  // rule-policy: technical axcelerate-import-log 2026-11-28 owner (AXCELERATE-IMPORT-LOG): import result wording and log size; no configurable value.
  const nothing = run.status !== 'running' && !brought && !notBrought;
  return <div className="space-y-1" data-testid="axcelerate-run-log">
    <p className={nothing ? 'font-medium text-amber-800' : 'font-medium'}>
      {nothing ? 'Nothing was imported.' : `${brought} brought in, ${notBrought} not brought in.`}
    </p>
    {Object.entries(run.counts ?? {}).map(([k, c]) => <div key={k}>{ENTITY_LABEL[k] ?? k}: {countsText(c)}</div>)}
    {notes.map((n) => <p key={n} className="text-foreground-600">{n}</p>)}
    {run.last_error && <p className="text-red-700">{run.last_error}</p>}
    {log.length > 0 && <>
      {compact && <button type="button" className="text-primary-700 hover:underline" onClick={() => setOpen((v) => !v)}>{open ? 'Hide log' : `Show log (${log.length})`}</button>}
      {open && <div className="mt-1 max-h-72 space-y-2 overflow-y-auto rounded border border-background-200 p-2">
        {missed.length > 0 && <div>
          <p className="font-medium text-red-700">Not brought in ({missed.length})</p>
          <ul className="list-disc pl-5">{missed.map((e, i) => <li key={`m${i}`}>{ENTITY_LABEL[e.entity] ?? e.entity}: {e.label || e.ax} — {notBroughtReason(e)}</li>)}</ul>
        </div>}
        {came.length > 0 && <div>
          <p className="font-medium text-green-800">Brought in ({came.length})</p>
          <ul className="list-disc pl-5">{came.map((e, i) => <li key={`c${i}`}>{ENTITY_LABEL[e.entity] ?? e.entity}: {e.label || e.ax} — {ACTION[e.action] ?? e.action}</li>)}</ul>
        </div>}
        {log.length >= 1000 && <p className="text-foreground-500">Only the first 1000 records are listed; the totals above are complete.</p>}
      </div>}
    </>}
  </div>;
}
