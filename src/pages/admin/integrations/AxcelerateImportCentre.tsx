import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, PageHeader, SectionTabs } from '@/pages/admin/components/ui';
import AxcelerateImportButton from '@/components/axcelerate/AxcelerateImportButton';
import {
  cancelImport, continueAxcelerateImport, countsText, decideConflict, ENTITY_LABEL, importOverview, resolveImportError, runAxcelerateImport,
  setImportPermission, surveyAxcelerate, undoSkip, useImportAllowed, type ImportOverview, type Survey,
} from '@/lib/axcelerateImport';

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '');
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '(empty)' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const ACTION_LABEL: Record<string, string> = {
  axcelerate_import_started: 'Import started', axcelerate_import_retried: 'Import retried', axcelerate_import_cancelled: 'Import cancelled',
  axcelerate_survey: 'Survey run', axcelerate_blocked_call: 'Blocked request (security)', axcelerate_connection_saved: 'Connection saved',
  axcelerate_connection_removed: 'Connection removed', axcelerate_conflict_decided: 'Conflict decided', axcelerate_skip_undone: 'Skipped record restored',
  permission_granted: 'Permission granted', permission_removed: 'Permission removed',
};

/**
 * aXcelerate Import centre (AXCELERATE-IMPORT, /admin/integrations/axcelerate). Holders of the aXcelerate import permission only;
 * every database function behind it checks the permission again. Nothing here sends anything to aXcelerate.
 */
export default function AxcelerateImportCentre() {
  const allowed = useImportAllowed();
  const [tab, setTab] = useState('imports');
  const [data, setData] = useState<ImportOverview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [survey, setSurvey] = useState<Survey | null>(null);
  const load = useCallback(async () => { try { setData(await importOverview()); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load the Import centre.'); } }, []);
  useEffect(() => { if (allowed) void load(); }, [allowed, load]);
  const act = async (work: () => Promise<unknown>, message = '') => {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await work(); setNotice(message); } catch (e) { setError(e instanceof Error ? e.message : 'Please try again.'); } finally { setBusy(false); void load(); }
  };

  if (!allowed) return <div><PageHeader title="aXcelerate Import centre" breadcrumb="External Integrations" />
    <EmptyState icon="ri-lock-line" title="Not available" description="The aXcelerate import is for SLIT admins with the aXcelerate import permission." /></div>;

  const tabs = [
    { id: 'imports', label: 'Imports' },
    { id: 'errors', label: `Errors${data?.errors.length ? ` (${data.errors.length})` : ''}` },
    { id: 'conflicts', label: `Conflicts${data?.conflicts.length ? ` (${data.conflicts.length})` : ''}` },
    { id: 'skipped', label: `Skipped${data?.skipped.length ? ` (${data.skipped.length})` : ''}` },
    { id: 'audit', label: 'Audit' },
    { id: 'permission', label: 'Permission' },
  ];
  const conn = data?.connection;
  const running = data?.runs.find((r) => r.status === 'running');

  return <div data-testid="axcelerate-import-centre">
    <PageHeader title="aXcelerate Import centre" breadcrumb="External Integrations"
      description="Brings data from aXcelerate into Skyline, one way only: Skyline reads aXcelerate and never sends anything back. Imported records are ordinary Skyline records: edit, delete or merge them as usual."
      actions={<AxcelerateImportButton entities={['trainers', 'classes', 'breaks']} mode="everything" label="Import everything" variant="primary" onDone={() => void load()} />} />
    {error && <p role="alert" className="mb-4 rounded border border-red-300 p-3 text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="mb-4 rounded border border-green-300 p-3 text-sm">{notice}</p>}
    {!conn || !conn.saved ? <Card className="mb-4 p-4 text-sm">
      The aXcelerate connection is not set up yet. Add it in <Link className="font-medium text-primary-700 hover:underline" to="/admin/integrations/applications">External Integrations › aXcelerate (Accelerate CRM)</Link> (subdomain, API token, web service token), then come back.
    </Card> : null}
    <SectionTabs tabs={tabs} active={tab} onChange={setTab} />
    <div className="mt-4 space-y-4">
      {tab === 'imports' && <>
        <Card className="space-y-3 p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Connection:</span>
            <Badge tone={conn?.status === 'connected' ? 'success' : 'muted'}>{conn?.status === 'connected' ? 'Connected' : conn ? conn.status.replace('_', ' ') : 'Not added'}</Badge>
            {conn?.lastSuccessAt && <span className="text-foreground-600">last checked {when(conn.lastSuccessAt)}</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" icon="ri-search-eye-line" disabled={busy || !conn?.saved} onClick={() => void act(async () => setSurvey(await surveyAxcelerate()), 'Survey finished.')} data-testid="axcelerate-survey">Run survey</Button>
            <AxcelerateImportButton entities={['trainers']} label="Import trainers" size="sm" onDone={() => void load()} />
            <AxcelerateImportButton entities={['classes']} label="Import classes" size="sm" onDone={() => void load()} />
            <AxcelerateImportButton entities={['breaks']} label="Import breaks" size="sm" onDone={() => void load()} />
          </div>
          {survey && <div className="rounded border border-background-200 p-3" data-testid="axcelerate-survey-result">
            <p className="font-medium">In aXcelerate ({when(survey.at)}):</p>
            <ul className="mt-1 list-disc pl-5">
              <li>Qualifications (courses): {survey.courses}</li>
              <li>Workshops: {survey.workshops ?? 'could not be read'}</li>
              <li>Delivery locations: {survey.deliveryLocations ?? 'could not be read'}</li>
              <li>Custom fields: {survey.customFields ? survey.customFields.length : 'could not be read'}</li>
            </ul>
            {survey.customFields?.length ? <p className="mt-2 text-foreground-600">Custom fields: {survey.customFields.map((f) => f.label || f.variable).join(', ')}</p> : null}
          </div>}
          <p className="text-foreground-600">Imported so far: {data && Object.keys(data.linked).length ? Object.entries(data.linked).map(([k, n]) => `${ENTITY_LABEL[k] ?? k} ${n}`).join(', ') : 'nothing yet'}.</p>
        </Card>
        <Card className="overflow-x-auto p-0">
          {!data?.runs.length ? <p className="p-4 text-sm text-foreground-600">No imports yet.</p> : <table className="w-full text-left text-sm" data-testid="axcelerate-runs">
            <thead className="text-xs text-foreground-500"><tr><th className="p-3">Started</th><th>What</th><th>By</th><th>Status</th><th>Result</th><th /></tr></thead>
            <tbody>{data.runs.map((r) => <tr key={r.id} className="border-t border-background-200 align-top">
              <td className="p-3 whitespace-nowrap">{when(r.started_at)}</td>
              <td className="pr-3">{r.mode === 'everything' ? 'Everything' : r.entities.map((e) => ENTITY_LABEL[e] ?? e).join(', ')}</td>
              <td className="pr-3">{r.startedByName ?? ''}</td>
              <td className="pr-3"><Badge tone={r.status === 'done' ? 'success' : r.status === 'running' ? 'accent' : 'muted'}>{r.status}</Badge>{r.openErrors ? <span className="ml-1 text-red-700">{r.openErrors} error{r.openErrors > 1 ? 's' : ''}</span> : null}</td>
              <td className="pr-3 text-xs">{Object.entries(r.counts ?? {}).map(([k, c]) => <div key={k}>{ENTITY_LABEL[k] ?? k}: {countsText(c)}</div>)}{r.last_error && <div className="text-red-700">{r.last_error}</div>}</td>
              <td className="p-3 text-right"><div className="flex justify-end gap-2">
                {r.status === 'running' && <>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => continueAxcelerateImport(r.id), 'Import continued.')}>Continue</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => cancelImport(r.id), 'Cancel requested: the import stops at its next step.')}>Cancel</Button>
                </>}
                {(r.status === 'failed' || r.status === 'cancelled') && !running && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => runAxcelerateImport({ retry: r.id }), 'Retry finished.')}>Retry</Button>}
              </div></td>
            </tr>)}</tbody>
          </table>}
        </Card>
      </>}

      {tab === 'errors' && <Card className="overflow-x-auto p-0">
        {!data?.errors.length ? <p className="p-4 text-sm text-foreground-600">No open import errors.</p> : <table className="w-full text-left text-sm" data-testid="axcelerate-errors">
          <thead className="text-xs text-foreground-500"><tr><th className="p-3">When</th><th>What</th><th>aXcelerate record</th><th>Problem</th><th /></tr></thead>
          <tbody>{data.errors.map((e) => <tr key={e.id} className="border-t border-background-200 align-top">
            <td className="p-3 whitespace-nowrap">{when(e.created_at)}</td><td className="pr-3">{ENTITY_LABEL[e.entity] ?? e.entity}</td>
            <td className="pr-3">{e.label ?? ''}{e.axcelerate_id ? <span className="block text-xs text-foreground-500">ID {e.axcelerate_id}</span> : null}</td>
            <td className="pr-3">{e.message}</td>
            <td className="p-3 text-right"><Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => resolveImportError(e.id), 'Marked as fixed.')}>Mark fixed</Button></td>
          </tr>)}</tbody>
        </table>}
        <p className="p-3 text-xs text-foreground-500">Fix the record in Skyline (or in aXcelerate), then import that page again. Mark fixed only hides the message.</p>
      </Card>}

      {tab === 'conflicts' && <Card className="overflow-x-auto p-0">
        {!data?.conflicts.length ? <p className="p-4 text-sm text-foreground-600">No conflicts. A conflict appears when aXcelerate changed a record an admin had already changed in Skyline.</p> : <table className="w-full text-left text-sm" data-testid="axcelerate-conflicts">
          <thead className="text-xs text-foreground-500"><tr><th className="p-3">Record</th><th>Field</th><th>Skyline</th><th>aXcelerate</th><th /></tr></thead>
          <tbody>{data.conflicts.map((k) => <tr key={k.id} className="border-t border-background-200 align-top">
            <td className="p-3">{ENTITY_LABEL[k.entity] ?? k.entity}: {k.label}</td><td className="pr-3">{k.field.replace(/_/g, ' ')}</td>
            <td className="pr-3">{show(k.skyline)}</td><td className="pr-3">{show(k.axcelerate)}</td>
            <td className="p-3 text-right"><div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => decideConflict(k.id, false), 'Skyline value kept.')}>Keep Skyline</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => decideConflict(k.id, true), 'aXcelerate value taken.')}>Take aXcelerate</Button>
            </div></td>
          </tr>)}</tbody>
        </table>}
      </Card>}

      {tab === 'skipped' && <Card className="overflow-x-auto p-0">
        {!data?.skipped.length ? <p className="p-4 text-sm text-foreground-600">Nothing skipped. Records an admin deletes in Skyline are listed here so later imports do not bring them back.</p> : <table className="w-full text-left text-sm" data-testid="axcelerate-skipped">
          <thead className="text-xs text-foreground-500"><tr><th className="p-3">Record</th><th>aXcelerate ID</th><th>Deleted</th><th /></tr></thead>
          <tbody>{data.skipped.map((s) => <tr key={`${s.entity}:${s.axcelerate_id}`} className="border-t border-background-200">
            <td className="p-3">{ENTITY_LABEL[s.entity] ?? s.entity}: {s.label ?? ''}</td><td className="pr-3">{s.axcelerate_id}</td><td className="pr-3">{when(s.skipped_at)}</td>
            <td className="p-3 text-right"><Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => undoSkip(s.connection_id, s.entity, s.axcelerate_id), 'Restored: the next import brings it back.')}>Undo</Button></td>
          </tr>)}</tbody>
        </table>}
      </Card>}

      {tab === 'audit' && <Card className="overflow-x-auto p-0">
        {!data?.audit.length ? <p className="p-4 text-sm text-foreground-600">No audit entries yet.</p> : <table className="w-full text-left text-sm" data-testid="axcelerate-audit">
          <thead className="text-xs text-foreground-500"><tr><th className="p-3">When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
          <tbody>{data.audit.map((a, i) => <tr key={i} className="border-t border-background-200 align-top">
            <td className="p-3 whitespace-nowrap">{when(a.at)}</td><td className="pr-3">{a.who}</td>
            <td className="pr-3">{a.action === 'axcelerate_blocked_call' ? <span className="font-medium text-red-700">{ACTION_LABEL[a.action]}</span> : ACTION_LABEL[a.action] ?? a.action}</td>
            <td className="pr-3 text-xs text-foreground-600">{Object.entries(a.detail ?? {}).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `${k}: ${show(v)}`).join(' · ')}</td>
          </tr>)}</tbody>
        </table>}
        <p className="p-3 text-xs text-foreground-500">The audit log cannot be edited or deleted.</p>
      </Card>}

      {tab === 'permission' && <Card className="overflow-x-auto p-0">
        <table className="w-full text-left text-sm" data-testid="axcelerate-permission">
          <thead className="text-xs text-foreground-500"><tr><th className="p-3">SLIT admin</th><th>Email</th><th>aXcelerate import</th><th /></tr></thead>
          <tbody>{(data?.permission ?? []).map((p) => <tr key={p.userId} className="border-t border-background-200">
            <td className="p-3">{p.name}</td><td className="pr-3">{p.email}</td><td className="pr-3">{p.granted ? <Badge tone="success">Allowed</Badge> : <Badge tone="muted">No</Badge>}</td>
            <td className="p-3 text-right"><Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => setImportPermission(p.userId, !p.granted), p.granted ? 'Permission removed.' : 'Permission granted.')}>{p.granted ? 'Remove' : 'Allow'}</Button></td>
          </tr>)}</tbody>
        </table>
        <p className="p-3 text-xs text-foreground-500">Only SLIT admins can hold this permission. Staff, trainers, agents and students never see the import controls.</p>
      </Card>}
    </div>
  </div>;
}
