import { useState } from 'react';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { ConnectionStatus, Empty, type IntegrationState } from './shared';
import { date, inputClass } from './state';

export default function LogsPage({ state, connectorId }: { state: IntegrationState; connectorId?: string }) {
  const [connector, setConnector] = useState('');
  const [severity, setSeverity] = useState('');
  const [correlation, setCorrelation] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const provider = connectorId ?? connector;
  const rows = state.data?.logs.filter(row => (!provider || row.connector_id === provider) &&
    (!severity || row.severity === severity) && (!correlation || row.correlation_id.includes(correlation)) &&
    (!since || row.created_at >= since) && (!until || row.created_at < until + 'T23:59:59.999Z')) ?? [];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-xs">
        {!connectorId && <label className="col-span-2">Connector
          <SearchableSelect className={inputClass} value={connector} onChange={event => setConnector(event.target.value)}>
            <option value="">All</option>
            {state.data?.definitions.map(definition => <option key={definition.id} value={definition.id}>{definition.name}</option>)}
          </SearchableSelect>
        </label>}
        <label>Severity
          <SearchableSelect className={inputClass} value={severity} onChange={event => setSeverity(event.target.value)}>
            <option value="">All</option><option>info</option><option>error</option><option>warn</option>
          </SearchableSelect>
        </label>
        <label>Correlation ID<input className={inputClass} value={correlation} onChange={event => setCorrelation(event.target.value)} /></label>
        <label>From (UTC)<input className={inputClass} type="date" value={since} onChange={event => setSince(event.target.value)} /></label>
        <label>Through (UTC)<input className={inputClass} type="date" value={until} onChange={event => setUntil(event.target.value)} /></label>
      </div>
      <p className="text-xs text-foreground-600">Filtering the latest 100 operational entries. Logs display event codes.</p>
      {rows.length ? <ul className="divide-y divide-background-200 rounded-md border border-background-200">
        {rows.map(row => <li key={row.id} className="space-y-1 px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <ConnectionStatus status={row.severity} />
            <span className="break-all font-medium">{row.connector_id} · {row.code}</span>
          </div>
          <p className="break-all text-xs text-foreground-600">{date(row.created_at)} · {row.correlation_id}</p>
        </li>)}
      </ul> : <Empty>No matching logs.</Empty>}
    </div>
  );
}
