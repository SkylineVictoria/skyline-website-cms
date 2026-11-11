import { useCallback, useEffect, useState } from 'react';
import { integrationRequest, type Snapshot } from './api';
export const inputClass = 'rounded-md border border-background-300 bg-white p-2 text-foreground-900 w-full';
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
