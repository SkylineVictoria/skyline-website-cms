import { useState } from 'react';
import { Button } from '@/pages/admin/components/ui';
import { pendingCredentialRequest } from './api';
import { inputClass } from './state';

/**
 * Setup for an app whose connector is not built yet (USI, VEVO, PRISMS, DataZoo): the administrator can store the access
 * details the provider issues, so they are ready the day the connector is added. Nothing is sent to the provider.
 */
export default function PendingCredentialsForm({ connectionId, name, saved, busy, perform, onNotice }: {
  connectionId: string; name: string; saved: boolean; busy: boolean;
  perform: (operation: () => Promise<void>) => Promise<void>; onNotice: (text: string) => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [accountId, setAccountId] = useState('');
  const [organisationCode, setOrganisationCode] = useState('');
  const [environment, setEnvironment] = useState<'test' | 'production'>('test');
  return (
    <form className="space-y-4" onSubmit={event => {
      event.preventDefault();
      const fields = { apiKey, accountId, organisationCode, environment };
      setApiKey('');
      void perform(async () => {
        await pendingCredentialRequest('save', connectionId, fields);
        setAccountId(''); setOrganisationCode('');
        onNotice(`${name} details saved. They will be used once the ${name} connector is added to Skyline.`);
      });
    }}>
      <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        {name} cannot connect yet: it needs provider approval and a connector. You can store the details here when the provider issues them. Saving does not contact {name}.
      </p>
      <p className="text-sm">{saved ? 'Details are saved (hidden). Enter new ones to replace them.' : 'No details saved yet.'}</p>
      <label className="block">API key or secret<input className={inputClass} type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} required minLength={8} maxLength={6000} /></label>
      <label className="block">Account or client ID (optional)<input className={inputClass} autoComplete="off" value={accountId} onChange={event => setAccountId(event.target.value)} maxLength={300} /></label>
      <label className="block">Organisation or provider code (optional)<input className={inputClass} autoComplete="off" value={organisationCode} onChange={event => setOrganisationCode(event.target.value)} maxLength={100} /></label>
      <label className="block">Environment
        <select className={inputClass} value={environment} onChange={event => setEnvironment(event.target.value === 'production' ? 'production' : 'test')}>
          <option value="test">Test</option>
          <option value="production">Live</option>
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>{saved ? 'Replace details' : 'Save details'}</Button>
        {saved && <Button type="button" variant="outline" disabled={busy} onClick={() => void perform(async () => {
          await pendingCredentialRequest('clear', connectionId);
          onNotice(`${name} details removed.`);
        })}>Remove saved details</Button>}
      </div>
    </form>
  );
}
