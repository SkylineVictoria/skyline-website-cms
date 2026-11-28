import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/pages/admin/lib/supabase';
import { Button } from '@/pages/admin/components/ui';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { inputClass } from './state';
import { integrationRequest } from './api';

/**
 * aXcelerate (Accelerate CRM) connection (AXCELERATE-CONNECTION, owner 2026-11-28): the administrator saves the college's
 * subdomain, Live / Staging, the API token (issued by aXcelerate support) and the web service token (made in aXcelerate for a user
 * whose permissions it takes). Saved in Vault (integration_axcelerate_save); never shown again. Check connection and every API
 * call go through integrations-admin (actions test / axcelerate_call), so the tokens never reach the browser.
 */
type Summary = { saved: boolean; environment?: 'production' | 'staging'; subdomain?: string; baseUrl?: string; apiTokenEnd?: string; wsTokenEnd?: string };
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Param = { name: string; value: string };
type CallResult = { ok: boolean; status: number; data: unknown; truncated: boolean; retryAfter?: string };

/** Common aXcelerate endpoints (developer.axcelerate.com Guides). Any other path can be typed in. */
const PRESETS: { label: string; method: Method; path: string; params: Param[] }[] = [
  { label: 'Search contacts', method: 'GET', path: '/contacts/search', params: [{ name: 'search', value: '' }, { name: 'displayLength', value: '100' }, { name: 'offsetRows', value: '0' }] },
  { label: 'Contact by ID', method: 'GET', path: '/contact/', params: [] },
  { label: 'Courses (qualifications)', method: 'GET', path: '/courses', params: [{ name: 'type', value: 'p' }, { name: 'isActive', value: 'true' }] },
  { label: 'Courses (workshops)', method: 'GET', path: '/courses', params: [{ name: 'type', value: 'w' }] },
  { label: 'Course detail', method: 'GET', path: '/course/detail', params: [{ name: 'ID', value: '' }, { name: 'type', value: 'p' }] },
  { label: 'Course instances', method: 'GET', path: '/course/instances', params: [{ name: 'ID', value: '' }, { name: 'type', value: 'p' }, { name: 'public', value: 'false' }] },
  { label: 'Search course instances', method: 'POST', path: '/course/instance/search', params: [{ name: 'type', value: 'p' }, { name: 'startDate_min', value: '' }, { name: 'startDate_max', value: '' }] },
  { label: 'Enrolments of a contact', method: 'GET', path: '/course/enrolments', params: [{ name: 'contactID', value: '' }] },
  { label: 'User roles', method: 'GET', path: '/user/roles', params: [] },
  { label: 'Reports list', method: 'GET', path: '/report/list', params: [] },
  { label: 'Saved reports', method: 'GET', path: '/report/saved/list', params: [] },
  { label: 'Run saved report', method: 'POST', path: '/report/saved/run', params: [{ name: 'reportId', value: '' }, { name: 'displayLength', value: '1000' }, { name: 'offsetRows', value: '0' }] },
];

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export default function AxcelerateConnection({ connectionId, ensureConnection, busy, perform, onNotice, onDraftChange }: {
  connectionId?: string; ensureConnection: () => Promise<string>; busy: boolean; perform: (operation: () => Promise<void>) => Promise<void>;
  onNotice: (text: string) => void; onDraftChange: (dirty: boolean) => void;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [editing, setEditing] = useState(false);
  const [environment, setEnvironment] = useState<'production' | 'staging'>('production');
  const [subdomain, setSubdomain] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [wsToken, setWsToken] = useState('');
  const refresh = useCallback(async (id: string) => {
    try { setSummary(await rpc<Summary>('integration_axcelerate_summary', { p_connection: id })); } catch { setSummary(null); }
  }, []);
  useEffect(() => { if (connectionId) void refresh(connectionId); }, [connectionId, refresh]);
  const reset = () => { setSubdomain(''); setApiToken(''); setWsToken(''); setEditing(false); onDraftChange(false); };
  const ready = !!subdomain.trim() && apiToken.trim().length >= 8 && wsToken.trim().length >= 8;

  const save = () => perform(async () => {
    const id = await ensureConnection();
    await rpc('integration_axcelerate_save', { p_connection: id, p_fields: { environment, subdomain, apiToken, wsToken } });
    reset(); await refresh(id);
    try { await integrationRequest('test', { connectionId: id }); onNotice('aXcelerate details saved and the connection works.'); }
    catch (e) { onNotice(`aXcelerate details saved, but the check failed: ${e instanceof Error ? e.message : 'try Check connection again.'}`); }
  });
  const check = () => perform(async () => {
    if (!connectionId) return;
    await integrationRequest('test', { connectionId });
    onNotice('aXcelerate connection verified.');
  });
  const clear = () => perform(async () => {
    if (!connectionId || !window.confirm('Disconnect aXcelerate? The saved tokens are deleted from Skyline (nothing changes in aXcelerate).')) return;
    await rpc('integration_axcelerate_clear', { p_connection: connectionId });
    reset(); await refresh(connectionId);
    onNotice('aXcelerate disconnected.');
  });

  const saved = summary?.saved === true;
  return <div className="space-y-6" data-testid="axcelerate-connection">
    {saved && !editing ? <div className="space-y-3 text-sm">
      <p>Connected to <span className="font-medium">{summary?.baseUrl}</span> ({summary?.environment === 'staging' ? 'Staging' : 'Live'}). API token ending {summary?.apiTokenEnd}, web service token ending {summary?.wsTokenEnd}. Tokens are never shown again.</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void check()} data-testid="axcelerate-check">Check connection</Button>
        <Button variant="outline" disabled={busy} onClick={() => { setEnvironment(summary?.environment ?? 'production'); setSubdomain(summary?.subdomain ?? ''); setEditing(true); }}>Replace details</Button>
        <Button variant="outline" disabled={busy} onClick={() => void clear()}>Disconnect</Button>
      </div>
    </div> : <form className="space-y-4" onChangeCapture={() => onDraftChange(true)} onSubmit={(event) => { event.preventDefault(); void save(); }} data-testid="axcelerate-form">
      <p className="text-sm text-foreground-600">
        aXcelerate needs two tokens. The <strong>API token</strong> is issued by aXcelerate support. The <strong>web service token</strong> is
        made in aXcelerate for one user, and has that user&apos;s permissions, so use a user who may read everything you want to import.
        Test against Staging first if aXcelerate gave you a staging site.
      </p>
      <label className="block text-sm">Environment
        <SearchableSelect className={inputClass} value={environment} onChange={(e) => setEnvironment(e.target.value === 'staging' ? 'staging' : 'production')}>
          <option value="production">Live (yourcollege.app.axcelerate.com)</option>
          <option value="staging">Staging (yourcollege.stg.axcelerate.com)</option>
        </SearchableSelect>
      </label>
      <label className="block text-sm">Subdomain (the first part of your aXcelerate address)
        <input className={inputClass} value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="yourcollege" autoComplete="off" required maxLength={200} data-testid="axcelerate-subdomain" />
      </label>
      <label className="block text-sm">API token
        <input className={inputClass} type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} autoComplete="new-password" required minLength={8} maxLength={500} data-testid="axcelerate-apitoken" />
      </label>
      <label className="block text-sm">Web service token
        <input className={inputClass} type="password" value={wsToken} onChange={(e) => setWsToken(e.target.value)} autoComplete="new-password" required minLength={8} maxLength={500} data-testid="axcelerate-wstoken" />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !ready} data-testid="axcelerate-save">Save and check</Button>
        {saved && <Button type="button" variant="outline" disabled={busy} onClick={reset}>Cancel</Button>}
      </div>
    </form>}
    {saved && connectionId && <ApiCaller connectionId={connectionId} />}
  </div>;
}

/** Call any aXcelerate API path with the saved tokens and see (or download) the answer. Changing calls ask first. */
function ApiCaller({ connectionId }: { connectionId: string }) {
  const [method, setMethod] = useState<Method>('GET');
  const [path, setPath] = useState('/contacts/search');
  const [params, setParams] = useState<Param[]>(PRESETS[0].params);
  const [result, setResult] = useState<CallResult | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);

  const applyPreset = (label: string) => {
    const p = PRESETS.find((x) => x.label === label);
    if (!p) return;
    setMethod(p.method); setPath(p.path); setParams(p.params.map((x) => ({ ...x }))); setResult(null); setError('');
  };
  const run = async () => {
    if (method !== 'GET' && !window.confirm(`${method} ${path} can create, change or delete records in aXcelerate. Send it?`)) return;
    setRunning(true); setError(''); setResult(null);
    try {
      const values = Object.fromEntries(params.filter((p) => p.name.trim() && p.value !== '').map((p) => [p.name.trim(), p.value]));
      setResult(await integrationRequest<CallResult>('axcelerate_call', { connectionId, method, path: path.trim(), params: values }));
    } catch (e) { setError(e instanceof Error ? e.message : 'The call failed.'); } finally { setRunning(false); }
  };
  const text = result ? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)) : '';
  const rows = result && Array.isArray(result.data) ? result.data.length : null;
  const download = () => {
    const blob = new Blob([text], { type: typeof result?.data === 'string' ? 'text/plain' : 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `axcelerate${path.replace(/[^A-Za-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.${typeof result?.data === 'string' ? 'txt' : 'json'}`;
    a.click(); URL.revokeObjectURL(a.href);
  };

  return <section className="space-y-3 border-t border-background-200 pt-4" data-testid="axcelerate-api">
    <div>
      <h3 className="font-semibold">Use the aXcelerate API</h3>
      <p className="text-sm text-foreground-600">Pick a common call or type any path from the aXcelerate API reference. GET reads only; POST, PUT and DELETE change aXcelerate and ask first. Limit: 200 calls a minute. Each call is recorded (who, path, status).</p>
    </div>
    <label className="block text-sm">Common calls
      <SearchableSelect className={inputClass} value="" onChange={(e) => applyPreset(e.target.value)} data-testid="axcelerate-preset">
        <option value="">Choose a call…</option>
        {PRESETS.map((p) => <option key={p.label} value={p.label}>{p.label} ({p.method} {p.path})</option>)}
      </SearchableSelect>
    </label>
    <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
      <label className="block text-sm">Method
        <SearchableSelect className={inputClass} value={method} onChange={(e) => setMethod(e.target.value as Method)} data-testid="axcelerate-method">
          {(['GET', 'POST', 'PUT', 'DELETE'] as Method[]).map((m) => <option key={m} value={m}>{m}</option>)}
        </SearchableSelect>
      </label>
      <label className="block text-sm">Path (after /api)
        <input className={`${inputClass} font-mono`} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/contacts/search" data-testid="axcelerate-path" />
      </label>
    </div>
    <div className="space-y-2">
      <p className="text-sm font-medium">Parameters</p>
      {params.map((p, i) => <div key={i} className="flex gap-2">
        <input className={`${inputClass} font-mono`} value={p.name} placeholder="name" aria-label="Parameter name" onChange={(e) => setParams((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
        <input className={inputClass} value={p.value} placeholder="value" aria-label="Parameter value" onChange={(e) => setParams((list) => list.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
        <Button type="button" variant="ghost" size="sm" aria-label="Remove parameter" onClick={() => setParams((list) => list.filter((_, j) => j !== i))}><i className="ri-close-line" aria-hidden="true" /></Button>
      </div>)}
      <Button type="button" variant="outline" size="sm" icon="ri-add-line" onClick={() => setParams((list) => [...list, { name: '', value: '' }])}>Add parameter</Button>
    </div>
    <Button disabled={running || !path.trim()} onClick={() => void run()} data-testid="axcelerate-run">{running ? 'Calling aXcelerate…' : `Send ${method}`}</Button>
    {error && <p role="alert" className="rounded border border-red-300 p-3 text-sm text-red-700">{error}</p>}
    {result && <div className="space-y-2" data-testid="axcelerate-result">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className={result.ok ? 'font-medium text-green-700' : 'font-medium text-red-700'}>HTTP {result.status}</span>
        {rows !== null && <span>{rows} record{rows === 1 ? '' : 's'}</span>}
        {result.retryAfter && <span>Rate limited: try again in {result.retryAfter} s</span>}
        {result.truncated && <span className="text-amber-700">Answer cut at 1.5 MB: use displayLength / offsetRows to page through it.</span>}
        <Button size="sm" variant="outline" icon="ri-download-2-line" onClick={download}>Download</Button>
      </div>
      <pre className="max-h-[28rem] overflow-auto rounded border border-background-200 bg-background-50 p-3 text-xs">{text}</pre>
    </div>}
  </section>;
}
