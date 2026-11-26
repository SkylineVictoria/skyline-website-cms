import { useCallback, useEffect, useState } from 'react';
import { integrationRequest, type Snapshot } from './api';
const root = '/admin/integrations';
export const sections = [
  { id: 'overview', label: 'Overview', icon: 'ri-dashboard-line', to: root },
  { id: 'applications', label: 'Connected Applications', icon: 'ri-apps-2-line', to: root + '/applications' },
  { id: 'add', label: 'Add Connection', icon: 'ri-add-circle-line', to: root + '/add', admin: true },
  { id: 'credentials', label: 'Credentials & Secrets', icon: 'ri-key-2-line', to: root + '/credentials' },
  { id: 'webhooks', label: 'Webhooks & Events', icon: 'ri-webhook-line', to: root + '/webhooks' },
  { id: 'sync-history', label: 'Sync History', icon: 'ri-history-line', to: root + '/sync-history' },
  { id: 'logs', label: 'Integration Logs', icon: 'ri-file-list-3-line', to: root + '/logs' },
  { id: 'settings', label: 'Settings', icon: 'ri-settings-3-line', to: root + '/settings', admin: true },
] as const;
export type Section = typeof sections[number]['id'];

export const inputClass = 'rounded-md border border-background-300 bg-background-50 p-2 text-foreground-900 w-full';
export const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Never';
export function useIntegrations() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => { setError(''); try { setData(await integrationRequest<Snapshot>('snapshot')); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load integrations.'); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function run(action: string, values: Record<string, unknown>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { await integrationRequest(action, values); setNotice(message); await load(); } catch (e) { await load(); setError(e instanceof Error ? e.message : 'The operation failed.'); } finally { setBusy(false); }
  }
  return { data, error, busy, notice, load, run };
}
