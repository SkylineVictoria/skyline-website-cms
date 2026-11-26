import { TextInput } from '@/pages/admin/components/ui';
import SearchableSelect from '@/components/ui/SearchableSelect';
import type { Connection, Definition, Snapshot } from './api';
import { ConnectionStatus, Empty } from './shared';
import { date, inputClass } from './state';

const authLabels: Record<string, string> = {
  api_key: 'API key',
  // rule-policy: technical integration-auth-label Provider metadata is formatted for display.
  oauth2: 'OAuth',
  approved_api: 'Approved API',
};
const authLabel = (kind: string) => authLabels[kind] ?? kind.replaceAll('_', ' ');
function availabilityLabel(isAdmin: boolean, definition?: Definition) {
  // rule-policy: security integration-snapshot-access Restricted accounts only see connection status for visible records.
  if (!isAdmin) return 'No accessible connection';
  return definition?.availability === 'requires_approval' ? 'Requires approval' : 'Not connected';
}

export type Application = {
  id: string;
  name: string;
  description: string;
  definition?: Definition;
  managed?: { category: string; status: string };
  connections: Connection[];
};

export function ProviderIcon({ application }: { application: Application }) {
  // rule-policy: technical integration-provider-icon Existing auth metadata selects the display icon.
  const icon = application.definition?.auth_type === 'approved_api' ? 'ri-government-line'
    : application.definition?.auth_type === 'oauth2' ? 'ri-shield-keyhole-line'
    : 'ri-plug-2-line';
  return <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-100 text-primary-800">
    <i className={icon + ' text-base'} aria-hidden="true" />
  </span>;
}

export function Applications({ applications, selected, query, setQuery, category, setCategory, auth, setAuth, choose, statusOf, isAdmin, busy }: {
  applications: Application[];
  selected: string;
  query: string;
  setQuery: (value: string) => void;
  category: string;
  setCategory: (value: string) => void;
  auth: string;
  setAuth: (value: string) => void;
  choose: (application: Application) => void;
  statusOf: (connection: Connection) => string;
  isAdmin: boolean;
  busy: boolean;
}) {
  const methods = [...new Set(applications.flatMap(app => app.definition?.auth_type ? [app.definition.auth_type] : []))];
  const categories = [...new Set(applications.map(app => app.managed?.category ?? 'Other'))].sort();
  const phrase = query.trim().toLowerCase();
  const visible = applications.filter(app => (!auth || app.definition?.auth_type === auth) &&
    (!category || (app.managed?.category ?? 'Other') === category) &&
    [app.name, app.id, app.description].some(value => value.toLowerCase().includes(phrase)));
  return (
    <>
      <div className="space-y-2 border-b border-background-200 p-3">
        <h2 className="font-semibold text-foreground-950">Applications</h2>
        <div className="relative">
          <i className="ri-search-line pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-500" aria-hidden="true" />
          <TextInput type="search" aria-label="Search applications" placeholder="Search applications" className="pl-8" value={query} onChange={event => setQuery(event.target.value)} />
        </div>
        {categories.length > 1 && <SearchableSelect aria-label="Filter by category" className={inputClass} value={category} onChange={event => setCategory(event.target.value)}>
          <option value="">All categories</option>
          {categories.map(name => <option key={name} value={name}>{name}</option>)}
        </SearchableSelect>}
        {methods.length > 1 && <SearchableSelect aria-label="Filter by authentication" className={inputClass} value={auth} onChange={event => setAuth(event.target.value)}>
          <option value="">All authentication types</option>
          {methods.map(method => <option key={method} value={method}>{authLabel(method)}</option>)}
        </SearchableSelect>}
      </div>
      <ul className="integration-list divide-y divide-background-200">
        {visible.map(app => {
          const current = app.id === selected;
          const item = app.connections[0];
          return (
            <li key={app.id} data-testid={item ? `connection-${app.id}` : undefined}>
              <button type="button" disabled={busy} aria-pressed={current}
                className={`flex w-full items-start gap-2.5 border-l-2 px-3 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-500 disabled:cursor-wait ${current ? 'border-primary-500 bg-primary-50' : 'border-transparent hover:bg-background-100'}`}
                onClick={() => choose(app)}>
                <ProviderIcon application={app} />
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-semibold text-foreground-950">{app.name}</span>
                  {app.description && <span className="mb-1 block line-clamp-2 text-xs text-foreground-600">{app.description}</span>}
                  {/* // rule-policy: technical integration-status-view Renders the current snapshot status. */}
                  <span data-testid={item ? `connection-status-${app.id}` : undefined}>
                    <ConnectionStatus status={app.managed?.status ?? (item ? statusOf(item) : availabilityLabel(isAdmin, app.definition))} />
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {!visible.length && <li className="p-3 text-sm text-foreground-600">{applications.length ? 'No applications match your filters.' : 'No applications to display.'}</li>}
      </ul>
    </>
  );
}

export function ApplicationHeader({ application, connection, statusOf, isAdmin }: {
  application: Application;
  connection?: Connection;
  isAdmin: boolean;
  statusOf: (connection: Connection) => string;
}) {
  return (
    <header className="flex items-start gap-3">
      <ProviderIcon application={application} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="break-words font-heading text-xl font-bold text-foreground-950">{application.name}</h2>
          <ConnectionStatus status={application.managed?.status ?? (connection ? statusOf(connection) : availabilityLabel(isAdmin, application.definition))} />
        </div>
        {application.description && <p className="mt-1 text-sm text-foreground-600">{application.description}</p>}
      </div>
    </header>
  );
}

export function Overview({ data, statusOf }: { data: Snapshot; statusOf: (connection: Connection) => string }) {
  // rule-policy: technical integration-overview-counts Counts actual connection states returned by the existing service.
  const connected = new Set(data.connections.filter(connection => statusOf(connection).toLowerCase() === 'connected').map(connection => connection.connector_id));
  const errors = data.connections.filter(connection => connection.status === 'error').length;
  // rule-policy: technical integration-overview-attention Counts visible error and attention statuses by application.
  const attention = new Set(data.connections.filter(connection =>
    connection.status === 'error' || statusOf(connection).toLowerCase() === 'needs attention').map(connection => connection.connector_id));
  const names = new Map(data.definitions.map(definition => [definition.id, definition.name]));
  const metrics = [
    { label: 'Registered applications', value: data.definitions.length },
    { label: 'Connected applications', value: connected.size },
    { label: 'Require attention', value: attention.size },
    { label: 'Failed connections', value: errors },
  ];
  return (
    <div className="space-y-5">
      <h2 className="font-heading text-xl font-bold text-foreground-950">Overview</h2>
      {/* // rule-policy: technical integration-overview-alert Reflects the saved alert preference and recorded connection errors. */}
      {data.settings.alerts_enabled && errors > 0 && <p className="rounded-md border border-primary-200 bg-primary-50 p-3 text-primary-900">
        {errors} {errors === 1 ? 'connection needs' : 'connections need'} attention. See Integration Logs for details.
      </p>}
      <dl className="grid grid-cols-2 gap-2">
        {metrics.map(metric => <div key={metric.label} className="rounded-md border border-background-200 bg-background-100 p-3">
          <dt className="text-xs text-foreground-700">{metric.label}</dt>
          <dd className="mt-1 font-heading text-xl font-bold tabular-nums text-foreground-950">{metric.value}</dd>
        </div>)}
      </dl>
      <section aria-label="Recent integration activity">
        <h3 className="mb-2 font-semibold text-foreground-950">Recent integration activity</h3>
        {/* // rule-policy: technical integration-overview-preview The overview previews the newest available log entries. */}
        {data.logs.length ? <ul className="divide-y divide-background-200 rounded-md border border-background-200">
          {data.logs.slice(0, 5).map(log => <li key={log.id} className="flex flex-wrap items-center justify-between gap-1 px-3 py-2 text-xs">
            <span className="min-w-0 break-words">
              <span className="font-semibold text-foreground-950">{names.get(log.connector_id) ?? log.connector_id}</span>
              <span className="ml-2 text-foreground-600">{log.code}</span>
            </span>
            <time dateTime={log.created_at} className="text-foreground-600">{date(log.created_at)}</time>
          </li>)}
        </ul> : <Empty>No integration activity recorded.</Empty>}
      </section>
    </div>
  );
}
