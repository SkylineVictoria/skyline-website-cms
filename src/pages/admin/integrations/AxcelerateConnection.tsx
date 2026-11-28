import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/pages/admin/lib/supabase';
import { Button } from '@/pages/admin/components/ui';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { inputClass } from './state';
import { integrationRequest } from './api';

/**
 * aXcelerate (Accelerate CRM) connection (AXCELERATE-CONNECTION, owner 2026-11-28): the administrator saves the college's
 * subdomain, Live / Staging, the API token (issued by aXcelerate support) and the web service token (made in aXcelerate for a user
 * whose permissions it takes). Saved in Vault (integration_axcelerate_save); never shown again, only when and by whom they were saved.
 * Check connection goes through integrations-admin (action test, GET only). Imports run in the Import centre (axcelerate-import).
 */
type Summary = { saved: boolean; environment?: 'production' | 'staging'; subdomain?: string; baseUrl?: string; savedAt?: string | null; savedBy?: string | null };


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
      <p>Connected to <span className="font-medium">{summary?.baseUrl}</span> ({summary?.environment === 'staging' ? 'Staging' : 'Live'}). Tokens saved{summary?.savedAt ? ` on ${new Date(summary.savedAt).toLocaleString()}` : ''}{summary?.savedBy ? ` by ${summary.savedBy}` : ''}. Tokens are never shown again.</p>
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
    {saved && <p className="text-sm text-foreground-600">Skyline only reads from aXcelerate (GET requests on a fixed list); nothing is ever sent back. Imports run from the <a className="font-medium text-primary-700 hover:underline" href="/admin/integrations/axcelerate">aXcelerate Import centre</a>.</p>}
  </div>;
}
