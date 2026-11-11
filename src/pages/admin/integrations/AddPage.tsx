import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card } from '@/pages/admin/components/ui';
import { integrationRequest, type Definition, type Snapshot } from './api';
import { Frame } from './shared';
import { useIntegrations, inputClass } from './state';

export default function AddPage() {
  const state = useIntegrations();
  const navigate = useNavigate();
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  async function configure(definition: Definition) {
    setError('');
    setAdding(definition.id);
    try {
      let connection = state.data?.connections.find(c => c.connector_id === definition.id);
      if (!connection) {
        try {
          await integrationRequest('add', { connectorId: definition.id });
        } catch (e) {
          // Another tab may have created it while this catalogue was open.
          const latest = await integrationRequest<Snapshot>('snapshot');
          connection = latest.connections.find(c => c.connector_id === definition.id);
          if (!connection) throw e;
        }
        if (!connection) {
          const latest = await integrationRequest<Snapshot>('snapshot');
          connection = latest.connections.find(c => c.connector_id === definition.id);
        }
      }
      if (!connection) throw new Error('The connection could not be loaded. Reload and try again.');
      navigate(`/admin/integrations/credentials?connection=${encodeURIComponent(connection.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to add this connection.');
    } finally {
      setAdding(null);
    }
  }

  return <Frame title="Add Connection" state={state}>
    <p className="mb-4">Choose an application, configure its API credential or authorize access, then test the connection. Adding an application alone does not connect it.</p>
    {error && <p role="alert" className="mb-4 rounded border border-primary-200 p-3">{error}</p>}
    <label className="mb-5 block max-w-lg">Find an application
      <input className={inputClass} type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search applications" />
    </label>
    <div className="grid gap-4 md:grid-cols-2">
      {state.data?.definitions.filter(d => d.name.toLowerCase().includes(search.toLowerCase())).map(d => {
        const connection = state.data?.connections.find(c => c.connector_id === d.id);
        return <Card className="p-5" key={d.id}>
          <h2 className="font-bold">{d.name}</h2>
          <p className="my-2">{d.description}</p>
          <p className="mb-3 text-sm">{connection ? `Status: ${connection.status.replaceAll('_', ' ')}` : 'Not added'}</p>
          {d.auth_type === 'oauth2' && <p className="mb-3 text-sm">Requires an OAuth application registration on the server before authorization.</p>}
          {d.availability === 'requires_approval' && <p className="mb-3 text-sm">Provider approval and an API adapter are required. Adding this entry will not enable connectivity.</p>}
          <Button disabled={adding !== null || !state.data?.isAdmin} onClick={() => void configure(d)}>
            {adding === d.id ? 'Opening setup…' : connection ? 'Continue setup / Manage' : 'Add and configure'}
          </Button>
        </Card>;
      })}
    </div>
    {state.data && !state.data.definitions.some(d => d.name.toLowerCase().includes(search.toLowerCase())) && <p className="my-4">No supported application matches your search.</p>}
    <Card className="mt-5 p-5"><h2 className="font-bold">Other third-party applications</h2><p className="mt-2">Applications outside this catalogue require a connector for their API and authentication method. A website address or account password cannot establish an API connection.</p></Card>
  </Frame>;
}
