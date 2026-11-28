import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Modal } from '@/pages/admin/components/ui';
import {
  countsText, ENTITY_LABEL, runAxcelerateImport, searchAxcelerateAgents, searchAxcelerateCourses, searchAxcelerateStudents, STUDENT_OUTCOME,
  useImportAllowed, type ImportEntity, type ImportRun, type StudentResult,
} from '@/lib/axcelerateImport';

/** Which records a screen imports (AXCELERATE-IMPORT-SCREENS, owner 2026-11-28: "import button on all screens, individually or all together"). */
export type RecordKind = 'students' | 'courses' | 'agents' | 'locations';

type Hit = { id: string; title: string; detail: string; linkedTo?: string | null };
type Kind = {
  title: string; one?: { label: string; text: string; search: string; hint: string; min: number; button: string };
  all: { label: string; text: string; button: string; explain: string }; entities: ImportEntity[];
};
const KINDS: Record<RecordKind, Kind> = {
  students: {
    title: 'Import students from aXcelerate', entities: ['students'],
    one: { label: 'Import one student', text: 'Search by name and bring in a single student.', search: 'Search aXcelerate by student name',
      hint: 'Type at least 3 letters. You can also use email or mobile.', min: 3, button: 'Import this student' },
    all: { label: 'Import all students', text: 'Bring in every student enrolled in aXcelerate.', button: 'Start importing all students',
      explain: 'Skyline reads every student enrolled in aXcelerate and creates or updates them, with what each one needs first: their agent and agency, and for each course their campus, course, class (units, trainer) and then the Qualification with its application. Nothing is sent to aXcelerate. Students an admin changed in Skyline are not overwritten, and possible duplicates wait for review in the Import centre.' },
  },
  courses: {
    title: 'Import courses from aXcelerate', entities: ['classes'],
    one: { label: 'Import one course', text: 'Search by code or name and bring in one course with its classes.', search: 'Search aXcelerate by course code or name',
      hint: 'Type at least 2 letters, e.g. BSB80120.', min: 2, button: 'Import this course' },
    all: { label: 'Import all courses', text: 'Bring in every course in aXcelerate with its classes.', button: 'Start importing all courses',
      explain: 'Skyline reads aXcelerate’s courses and creates or updates them with their campuses, units, classes and trainers (a missing course is created as a Draft). Nothing is sent to aXcelerate.' },
  },
  agents: {
    title: 'Import agents from aXcelerate', entities: ['students'],
    one: { label: 'Import one agent', text: 'Search by name and bring in one agent with their agency.', search: 'Search aXcelerate by agent name',
      hint: 'Type at least 3 letters. You can also use email or mobile.', min: 3, button: 'Import this agent' },
    all: { label: 'Import all agents', text: 'Every agent comes with their students: this imports all students and their agents.', button: 'Start importing all students and agents',
      explain: 'aXcelerate lists agents through their students, so this runs the students import: every student enrolled in aXcelerate, with their agent and agency. Imported agents stay Inactive (no portal access) until their agent agreement is signed. Nothing is sent to aXcelerate.' },
  },
  locations: {
    title: 'Import campuses from aXcelerate', entities: ['locations'],
    all: { label: 'Import all campuses', text: 'Bring in aXcelerate’s delivery locations as campuses.', button: 'Start importing campuses',
      explain: 'Skyline reads aXcelerate’s delivery locations and creates or updates them as campuses. An incomplete location is created switched off until its address is complete (AVETMISS). Nothing is sent to aXcelerate.' },
  },
};
const NEEDS_REVIEW = new Set(['duplicate', 'conflict']);
const AGENT_LINK: Record<string, string> = {
  moved: 'The student moved to this agent and business.', linked: 'The student is linked to this agent.',
  kept: 'The student keeps their current business (they already have applications there).', unchanged: '',
};
const QUAL_LABEL: Record<string, string> = { created: 'imported', linked: 'matched to the Qualification already in Skyline', unchanged: 'already up to date', updated: 'updated', skipped: 'skipped (deleted in Skyline)', error: 'not imported' };

/** AVETMISS outcome codes as staff read them (NAT00120). */
const OUTCOME_LABEL: Record<string, string> = { '20': 'Competent', '30': 'Not yet competent', '40': 'Withdrawn', '41': 'Incomplete', '51': 'RPL granted', '52': 'RPL not granted', '60': 'Credit transfer', '61': 'Superseded', '70': 'Continuing', '85': 'Not yet started' };
const UNIT_ACTION: Record<string, string> = { created: 'imported', updated: 'updated', unchanged: 'up to date', kept: 'kept from Skyline', open: 'no result yet', error: 'not imported' };

/** One student's outcome: the owner's wording, the agent, the Qualifications (with unit results), and what needs attention. */
export function StudentOutcome({ r }: { r: StudentResult }) {
  const review = NEEDS_REVIEW.has(r.action);
  const bad = r.action === 'error' || r.action === 'skipped';
  return <div className={`rounded border p-3 text-sm ${bad ? 'border-red-300' : review ? 'border-amber-300' : 'border-green-300'}`} role="status" data-testid="axcelerate-student-outcome">
    <p className="font-medium">{STUDENT_OUTCOME[r.action] ?? r.action}{r.name ? `: ${r.name}` : ''}</p>
    {r.message && <p className="text-red-700">{r.message}</p>}
    {r.id && !bad && <p><Link className="text-primary-700 hover:underline" to={`/admin/students/${r.id}`}>Open the student</Link></p>}
    {review && <p><Link className="text-primary-700 hover:underline" to="/admin/integrations/axcelerate">Review it in the Import centre</Link></p>}
    {r.agent && <p className="text-foreground-700">
      Agent: {r.agent.action === 'error' ? <span className="text-red-700">{r.agent.message ?? 'not imported'}</span> : <>
        {r.agent.name ?? 'imported'}{r.agent.business ? ` (${r.agent.business})` : ''}, Inactive until their agent agreement is signed.
        {AGENT_LINK[r.agent.student ?? ''] ? ` ${AGENT_LINK[r.agent.student ?? '']}` : ''}</>}
    </p>}
    {(r.qualifications ?? []).length > 0 && <ul className="mt-1 space-y-0.5" data-testid="axcelerate-student-qualifications">
      {r.qualifications!.map((q, n) => <li key={`${q.name}-${n}`} className={q.action === 'error' ? 'text-red-700' : 'text-foreground-700'}>
        Qualification {q.name}: {QUAL_LABEL[q.action] ?? q.action}{q.status && q.action !== 'error' ? ` (${q.status === 'active' ? 'In Progress' : q.status})` : ''}{q.message ? `: ${q.message}` : ''}
        {(q.warnings ?? []).map((w) => <span key={w} className="block text-foreground-600">{w}</span>)}
        {(q.units ?? []).length > 0 && <span className="block text-foreground-600" data-testid="axcelerate-unit-results">
          Unit results: {q.units!.map((u) => `${u.code}${u.outcome ? ` ${OUTCOME_LABEL[u.outcome] ?? u.outcome}` : ''} (${UNIT_ACTION[u.action] ?? u.action}${u.message ? `: ${u.message}` : ''})`).join('; ')}
        </span>}
      </li>)}
    </ul>}
    {(r.warnings ?? []).length > 0 && <ul className="mt-1 list-disc pl-5 text-foreground-600">{r.warnings!.map((w) => <li key={w}>{w}</li>)}</ul>}
  </div>;
}

/** The run's result in words: counts per record type, notes, the students that need attention. */
export function RunSummary({ run }: { run: ImportRun }) {
  const keys = Object.keys(run.counts ?? {});
  const total = run.cursor?.contacts?.length;
  return <div className="space-y-2 rounded border border-background-200 p-3 text-sm" role="status" data-testid="axcelerate-run-summary">
    <p className="font-medium">{run.status === 'running'
      ? (run.cursor?.stage === 'students' && total ? `Importing… ${run.cursor?.contactIndex ?? 0} of ${total} students` : `Working… (${ENTITY_LABEL[run.cursor?.stage ?? ''] ?? run.cursor?.stage ?? 'starting'})`)
      : run.status === 'done' ? 'Import finished.' : run.status === 'cancelled' ? 'Import cancelled.' : 'Import stopped.'}</p>
    {keys.length > 0 && <ul className="space-y-0.5">{keys.map((k) => <li key={k}>{ENTITY_LABEL[k] ?? k}: {countsText(run.counts[k])}</li>)}</ul>}
    {(run.cursor?.notes ?? []).map((n) => <p key={n} className="text-foreground-600">{n}</p>)}
    {run.status !== 'running' && (run.cursor?.results ?? []).length > 0 && <details open={run.cursor?.scope === 'one'}>
      <summary className="cursor-pointer font-medium">{run.cursor?.scope === 'one' ? 'Result' : `Students that need attention (${run.cursor!.results!.length})`}</summary>
      <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">{run.cursor!.results!.map((r) => <StudentOutcome key={r.contactId} r={r} />)}</div>
    </details>}
    {run.status !== 'running' && <p><Link className="font-medium text-primary-700 hover:underline" to="/admin/integrations/axcelerate">Open the Import centre</Link> for possible duplicates, conflicts and errors.</p>}
  </div>;
}

/**
 * "Import from aXcelerate" for a screen (students, courses, agents, campuses): import one record (search aXcelerate) or all of them.
 * Every record comes with what it needs first (the engine imports dependencies before the record), so nothing fails for a missing
 * reference. Shown only to holders of the aXcelerate import permission; the Edge Function checks it again. Nothing is sent to aXcelerate.
 */
export default function AxcelerateRecordImport({ kind, label, onDone }: { kind: RecordKind; label?: string; onDone?: () => void }) {
  const cfg = KINDS[kind];
  const allowed = useImportAllowed();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'choose' | 'one' | 'all'>(cfg.one ? 'choose' : 'all');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, ImportRun>>({});
  const [changedOnly, setChangedOnly] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (step !== 'one' || !cfg.one) return;
    const q = query.trim();
    if (q.length < cfg.one.min) { setHits(null); return; }
    let live = true;
    const timer = window.setTimeout(() => {
      setSearching(true); setError('');
      const find = kind === 'courses'
        ? searchAxcelerateCourses(q).then((rows) => rows.map((r) => ({ id: r.courseId, title: `${r.code} ${r.name}`.trim(), detail: `aXcelerate course ${r.courseId}` })))
        : (kind === 'agents' ? searchAxcelerateAgents(q) : searchAxcelerateStudents(q)).then((rows) => rows.map((r) => ({
            id: r.contactId, title: r.name || `Contact ${r.contactId}`, detail: [r.email, r.mobile, r.dob].filter(Boolean).join(' · ') || `aXcelerate contact ${r.contactId}`, linkedTo: r.studentId })));
      find.then((rows) => { if (live) setHits(rows); })
        .catch((e: unknown) => { if (live) { setHits([]); setError(e instanceof Error ? e.message : 'aXcelerate could not be searched.'); } })
        .finally(() => { if (live) setSearching(false); });
    }, 400);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query, step, kind, cfg.one]);

  if (!allowed) return null;
  const reset = () => { setStep(cfg.one ? 'choose' : 'all'); setQuery(''); setHits(null); setRuns({}); setError(''); setBusy(null); };
  const working = busy !== null;
  const start = async (key: string, req: Parameters<typeof runAxcelerateImport>[0]) => {
    setBusy(key); setError('');
    try { const run = await runAxcelerateImport(req, (r) => setRuns((m) => ({ ...m, [key]: r }))); setRuns((m) => ({ ...m, [key]: run })); onDone?.(); }
    catch (e) { setError(e instanceof Error ? e.message : 'The import stopped.'); }
    finally { setBusy(null); }
  };
  const importOne = (id: string) => start(id, kind === 'courses' ? { entities: ['classes'], mode: 'page', courses: { courseId: id } }
    : kind === 'agents' ? { entities: ['agents'], mode: 'page', agents: { contactId: id } }
    : { entities: ['students'], mode: 'page', students: { scope: 'one', contactId: id } });
  const importAll = () => start('all', kind === 'students' || kind === 'agents'
    ? { entities: ['students'], mode: 'page', students: { scope: 'all', changedOnly } } : { entities: cfg.entities, mode: 'page' });
  const card = 'flex w-full flex-col items-start gap-1 rounded-lg border border-background-200 p-5 text-left transition-colors hover:border-primary-400 hover:bg-primary-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400';
  const allRun = runs.all;

  return <>
    <Button variant="outline" icon="ri-download-cloud-2-line" onClick={() => { reset(); setOpen(true); }} data-testid={`axcelerate-import-${kind}`}>{label ?? 'Import from aXcelerate'}</Button>
    <Modal open={open} title={cfg.title} width="max-w-2xl" keepOpen={working} onClose={() => { if (!working) setOpen(false); }}
      footer={<>
        {cfg.one && step !== 'choose' && <Button variant="outline" disabled={working} onClick={reset}>Back</Button>}
        <Button variant="outline" disabled={working} onClick={() => setOpen(false)}>Close</Button>
        {step === 'all' && allRun?.status !== 'done' && <Button disabled={working} onClick={() => void importAll()} data-testid="axcelerate-import-all-start">
          {busy === 'all' ? 'Importing…' : cfg.all.button}</Button>}
      </>}>
      <div className="space-y-4" data-testid={`axcelerate-import-${kind}-dialog`}>
        {step === 'choose' && cfg.one && <div className="grid gap-3 sm:grid-cols-2">
          <button type="button" className={card} onClick={() => setStep('one')} data-testid="axcelerate-import-one-card">
            <i className="ri-search-line text-2xl text-primary-600" aria-hidden="true" />
            <span className="font-semibold">{cfg.one.label}</span>
            <span className="text-sm text-foreground-600">{cfg.one.text}</span>
          </button>
          <button type="button" className={card} onClick={() => setStep('all')} data-testid="axcelerate-import-all-card">
            <i className="ri-stack-line text-2xl text-primary-600" aria-hidden="true" />
            <span className="font-semibold">{cfg.all.label}</span>
            <span className="text-sm text-foreground-600">{cfg.all.text}</span>
          </button>
        </div>}

        {step === 'one' && cfg.one && <div className="space-y-3">
          <label className="block text-sm font-medium" htmlFor={`axcelerate-search-${kind}`}>{cfg.one.search}</label>
          <input id={`axcelerate-search-${kind}`} className="w-full rounded-md border border-background-300 px-3 py-2 text-sm" value={query} autoFocus autoComplete="off"
            onChange={(e) => setQuery(e.target.value)} aria-describedby={`axcelerate-search-${kind}-hint`} maxLength={100} data-testid="axcelerate-search" />
          <p id={`axcelerate-search-${kind}-hint`} className="text-xs text-foreground-600">{cfg.one.hint}</p>
          {error && <p role="alert" className="rounded border border-red-300 p-3 text-sm text-red-700">{error}</p>}
          {searching && <p className="text-sm text-foreground-600" role="status">Searching aXcelerate…</p>}
          {hits && !searching && !hits.length && !error && <p className="text-sm text-foreground-600">Nothing in aXcelerate matches “{query.trim()}”.</p>}
          {hits && hits.length > 0 && <ul className="divide-y divide-background-200 rounded border border-background-200" data-testid="axcelerate-search-results">
            {hits.map((h) => <li key={h.id} className="space-y-2 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{h.title}</p>
                  <p className="text-foreground-600">{h.detail}</p>
                  {h.linkedTo && !runs[h.id] && <p className="text-xs text-foreground-500">Already in Skyline: <Link className="text-primary-700 hover:underline" to={`/admin/students/${h.linkedTo}`}>open the student</Link>. Importing again updates them.</p>}
                </div>
                <Button size="sm" disabled={working} onClick={() => void importOne(h.id)} data-testid="axcelerate-import-one">{busy === h.id ? 'Importing…' : cfg.one!.button}</Button>
              </div>
              {runs[h.id] && (kind === 'students' && runs[h.id].cursor?.results?.[0] ? <StudentOutcome r={runs[h.id].cursor.results![0]} />
                : kind === 'agents' && runs[h.id].cursor?.agentResult ? <p className="rounded border border-green-300 p-3" role="status">
                    Agent {runs[h.id].cursor.agentResult!.action === 'error' ? <span className="text-red-700">not imported: {runs[h.id].cursor.agentResult!.message}</span>
                      : <>{runs[h.id].cursor.agentResult!.name}{runs[h.id].cursor.agentResult!.business ? ` (${runs[h.id].cursor.agentResult!.business})` : ''}: {runs[h.id].cursor.agentResult!.action}. Inactive until their agent agreement is signed.</>}</p>
                : <RunSummary run={runs[h.id]} />)}
            </li>)}
          </ul>}
        </div>}

        {step === 'all' && <div className="space-y-3 text-sm">
          {(kind === 'students' || kind === 'agents') && <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={changedOnly} disabled={working || !!allRun} onChange={(e) => setChangedOnly(e.target.checked)} data-testid="axcelerate-changed-only" />
            <span>Only students changed since the last import</span>
          </label>}
          <p className="text-foreground-600">{cfg.all.explain}</p>
          {error && <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p>}
          {allRun && <RunSummary run={allRun} />}
        </div>}
      </div>
    </Modal>
  </>;
}
