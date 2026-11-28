import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Modal } from '@/pages/admin/components/ui';
import {
  runAxcelerateImport, searchAxcelerateStudents, STUDENT_OUTCOME, useImportAllowed,
  type ImportRun, type StudentResult, type StudentSearchResult,
} from '@/lib/axcelerateImport';

type Step = 'choose' | 'one' | 'all';
const NEEDS_REVIEW = new Set(['duplicate', 'conflict']);

/** One outcome line: the owner's wording, the student, and what needs attention. */
function Outcome({ r }: { r: StudentResult }) {
  const review = NEEDS_REVIEW.has(r.action);
  const bad = r.action === 'error' || r.action === 'skipped';
  return <div className={`rounded border p-3 text-sm ${bad ? 'border-red-300' : review ? 'border-amber-300' : 'border-green-300'}`} role="status" data-testid="axcelerate-student-outcome">
    <p className="font-medium">{STUDENT_OUTCOME[r.action] ?? r.action}{r.name ? `: ${r.name}` : ''}</p>
    {r.message && <p className="text-red-700">{r.message}</p>}
    {r.id && !bad && <p><Link className="text-primary-700 hover:underline" to={`/admin/students/${r.id}`}>Open the student</Link></p>}
    {review && <p><Link className="text-primary-700 hover:underline" to="/admin/integrations/axcelerate">Review it in the Import centre</Link></p>}
    {(r.warnings ?? []).length > 0 && <ul className="mt-1 list-disc pl-5 text-foreground-600">{r.warnings!.map((w) => <li key={w}>{w}</li>)}</ul>}
  </div>;
}

/**
 * Students page: "Import from aXcelerate" (AXCELERATE-STUDENTS, owner 2026-11-28). Import one student (search aXcelerate by name,
 * email or mobile) or all students enrolled in aXcelerate (optionally only those changed since the last import). Shown only to
 * holders of the aXcelerate import permission; the Edge Function checks it again. Nothing is sent to aXcelerate.
 */
export default function AxcelerateStudentsImport({ onDone }: { onDone?: () => void }) {
  const allowed = useImportAllowed();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('choose');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StudentSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, StudentResult>>({});
  const [changedOnly, setChangedOnly] = useState(true);
  const [run, setRun] = useState<ImportRun | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (step !== 'one') return;
    const q = query.trim();
    if (q.length < 3) { setResults(null); return; }
    let live = true;
    const timer = window.setTimeout(() => {
      setSearching(true); setError('');
      searchAxcelerateStudents(q)
        .then((rows) => { if (live) setResults(rows); })
        .catch((e: unknown) => { if (live) { setResults([]); setError(e instanceof Error ? e.message : 'aXcelerate could not be searched.'); } })
        .finally(() => { if (live) setSearching(false); });
    }, 400);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query, step]);

  if (!allowed) return null;
  const reset = () => { setStep('choose'); setQuery(''); setResults(null); setOutcomes({}); setRun(null); setError(''); setBusy(null); };
  const working = busy !== null;

  const importOne = async (contactId: string) => {
    setBusy(contactId); setError('');
    try {
      const done = await runAxcelerateImport({ entities: ['students'], mode: 'page', students: { scope: 'one', contactId } });
      const r = done.cursor?.results?.[0] ?? { contactId, action: done.status === 'done' ? 'unchanged' : 'error', message: done.last_error ?? undefined };
      setOutcomes((o) => ({ ...o, [contactId]: r }));
      if (r.action === 'created' || r.action === 'updated') onDone?.();
    } catch (e) {
      setOutcomes((o) => ({ ...o, [contactId]: { contactId, action: 'error', message: e instanceof Error ? e.message : 'The import stopped.' } }));
    } finally { setBusy(null); }
  };

  const importAll = async () => {
    setBusy('all'); setError(''); setRun(null);
    try { setRun(await runAxcelerateImport({ entities: ['students'], mode: 'page', students: { scope: 'all', changedOnly } }, setRun)); onDone?.(); }
    catch (e) { setError(e instanceof Error ? e.message : 'The import stopped.'); }
    finally { setBusy(null); }
  };

  const counts = run?.counts?.student ?? {};
  const total = run?.cursor?.contacts?.length;
  const done = run?.cursor?.contactIndex ?? 0;
  const card = 'flex w-full flex-col items-start gap-1 rounded-lg border border-background-200 p-5 text-left transition-colors hover:border-primary-400 hover:bg-primary-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400';

  return <>
    <Button variant="outline" icon="ri-download-cloud-2-line" onClick={() => { reset(); setOpen(true); }} data-testid="axcelerate-students-import">Import from aXcelerate</Button>
    <Modal open={open} title="Import students from aXcelerate" width="max-w-2xl" keepOpen={working} onClose={() => { if (!working) setOpen(false); }}
      footer={<>
        {step !== 'choose' && <Button variant="outline" disabled={working} onClick={reset}>Back</Button>}
        <Button variant="outline" disabled={working} onClick={() => setOpen(false)}>Close</Button>
        {step === 'all' && run?.status !== 'done' && <Button disabled={working} onClick={() => void importAll()} data-testid="axcelerate-students-all-start">
          {busy === 'all' ? 'Importing…' : 'Start importing all students'}</Button>}
      </>}>
      <div className="space-y-4" data-testid="axcelerate-students-dialog">
        {step === 'choose' && <div className="grid gap-3 sm:grid-cols-2">
          <button type="button" className={card} onClick={() => setStep('one')} data-testid="axcelerate-students-one">
            <i className="ri-user-search-line text-2xl text-primary-600" aria-hidden="true" />
            <span className="font-semibold">Import one student</span>
            <span className="text-sm text-foreground-600">Search by name and bring in a single student.</span>
          </button>
          <button type="button" className={card} onClick={() => setStep('all')} data-testid="axcelerate-students-all">
            <i className="ri-group-line text-2xl text-primary-600" aria-hidden="true" />
            <span className="font-semibold">Import all students</span>
            <span className="text-sm text-foreground-600">Bring in every student enrolled in aXcelerate.</span>
          </button>
        </div>}

        {step === 'one' && <div className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="axcelerate-student-search">Search aXcelerate by student name</label>
          <input id="axcelerate-student-search" className="w-full rounded-md border border-background-300 px-3 py-2 text-sm" value={query} autoFocus autoComplete="off"
            onChange={(e) => setQuery(e.target.value)} aria-describedby="axcelerate-student-search-hint" maxLength={100} data-testid="axcelerate-student-search" />
          <p id="axcelerate-student-search-hint" className="text-xs text-foreground-600">Type at least 3 letters. You can also use email or mobile.</p>
          {error && <p role="alert" className="rounded border border-red-300 p-3 text-sm text-red-700">{error}</p>}
          {searching && <p className="text-sm text-foreground-600" role="status">Searching aXcelerate…</p>}
          {results && !searching && !results.length && !error && <p className="text-sm text-foreground-600">No student in aXcelerate matches “{query.trim()}”.</p>}
          {results && results.length > 0 && <ul className="divide-y divide-background-200 rounded border border-background-200" data-testid="axcelerate-student-results">
            {results.map((r) => <li key={r.contactId} className="space-y-2 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{r.name || `Contact ${r.contactId}`}</p>
                  <p className="text-foreground-600">{[r.email, r.mobile, r.dob].filter(Boolean).join(' · ') || `aXcelerate contact ${r.contactId}`}</p>
                  {r.studentId && !outcomes[r.contactId] && <p className="text-xs text-foreground-500">Already in Skyline: <Link className="text-primary-700 hover:underline" to={`/admin/students/${r.studentId}`}>open the student</Link>. Importing again updates them.</p>}
                </div>
                <Button size="sm" disabled={working} onClick={() => void importOne(r.contactId)} data-testid="axcelerate-student-import">
                  {busy === r.contactId ? 'Importing…' : 'Import this student'}</Button>
              </div>
              {outcomes[r.contactId] && <Outcome r={outcomes[r.contactId]} />}
            </li>)}
          </ul>}
        </div>}

        {step === 'all' && <div className="space-y-3 text-sm">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={changedOnly} disabled={working || !!run} onChange={(e) => setChangedOnly(e.target.checked)} data-testid="axcelerate-students-changed-only" />
            <span>Only students changed since the last import</span>
          </label>
          <p className="text-foreground-600">Skyline reads every student enrolled in aXcelerate and creates or updates them. Nothing is sent to aXcelerate. Students an admin changed in Skyline are not overwritten, and possible duplicates wait for review in the Import centre.</p>
          {error && <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p>}
          {run && <div className="space-y-2 rounded border border-background-200 p-3" role="status" data-testid="axcelerate-students-progress">
            <p className="font-medium">{run.status === 'running'
              ? (run.cursor?.stage === 'students' && total ? `Importing… ${done} of ${total} students` : 'Finding the students enrolled in aXcelerate…')
              : run.status === 'done' ? 'Import finished.' : run.status === 'cancelled' ? 'Import cancelled.' : 'Import stopped.'}</p>
            {Object.keys(counts).length > 0 && <ul className="space-y-0.5">
              {(['created', 'updated', 'unchanged', 'duplicate', 'conflict', 'skipped', 'error'] as const).filter((k) => counts[k]).map((k) =>
                <li key={k}>{STUDENT_OUTCOME[k]}: {counts[k]}</li>)}
            </ul>}
            {(run.cursor?.notes ?? []).map((n) => <p key={n} className="text-foreground-600">{n}</p>)}
            {run.status !== 'running' && (run.cursor?.results ?? []).length > 0 && <details>
              <summary className="cursor-pointer font-medium">Students that need attention ({run.cursor!.results!.length})</summary>
              <div className="mt-2 max-h-72 space-y-2 overflow-y-auto">{run.cursor!.results!.map((r) => <Outcome key={r.contactId} r={r} />)}</div>
            </details>}
            {run.status !== 'running' && <p><Link className="font-medium text-primary-700 hover:underline" to="/admin/integrations/axcelerate">Open the Import centre</Link> for possible duplicates, conflicts and errors.</p>}
          </div>}
        </div>}
      </div>
    </Modal>
  </>;
}
