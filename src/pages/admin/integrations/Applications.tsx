import { Button, TextInput } from '@/pages/admin/components/ui';
import { isEnvironmentManaged, type Connection, type Definition } from './api';
import { ConnectionStatus } from './shared';

function availabilityLabel(isAdmin: boolean, definition?: Definition) {
  if (isEnvironmentManaged(definition)) return 'Server-managed';
  // rule-policy: security integration-snapshot-access Restricted accounts only see connection status for visible records.
  if (!isAdmin) return 'No accessible connection';
  return definition?.availability === 'requires_approval' ? 'Requires approval' : 'Not connected';
}

export type Application = {
  id: string;
  name: string;
  description: string;
  definition?: Definition;
  connections: Connection[];
};

const icons: Record<string, string> = {
  openai: 'ri-sparkling-2-line bg-emerald-100 text-emerald-800',
  microsoft365: 'ri-microsoft-fill bg-blue-100 text-blue-700',
  stripe: 'ri-bank-card-fill bg-indigo-100 text-indigo-700',
  google_maps: 'ri-map-pin-2-fill bg-primary-100 text-primary-800',
  docusign: 'ri-quill-pen bg-lime-100 text-lime-800',
  clicksend: 'ri-chat-3-fill bg-sky-100 text-sky-800',
  whatsapp: 'ri-whatsapp-line bg-emerald-100 text-emerald-800',
  microsoft_teams: 'ri-group-fill bg-indigo-100 text-indigo-700',
  brave_search: 'ri-search-eye-line bg-orange-100 text-orange-800',
  tavily: 'ri-search-line bg-sky-100 text-sky-800',
  calendly: 'ri-calendar-line bg-blue-100 text-blue-700',
  xero: 'ri-bank-line bg-sky-100 text-sky-800',
  usi: 'ri-fingerprint-line bg-secondary-100 text-secondary-800',
  vevo: 'ri-shield-user-line bg-secondary-100 text-secondary-800',
  prisms: 'ri-government-line bg-secondary-100 text-secondary-800',
  datazoo: 'ri-shield-check-line bg-secondary-100 text-secondary-800',
};

export function ProviderIcon({ application, large = false }: { application: Application; large?: boolean }) {
  const icon = icons[application.id] ?? 'ri-plug-2-line bg-primary-100 text-primary-800';
  return <i className={`flex shrink-0 items-center justify-center rounded-md ${large ? 'h-11 w-11 text-2xl' : 'h-8 w-8 text-lg'} ${icon}`} aria-hidden="true" />;
}

const filters = ['All', 'Connected', 'Needs attention'] as const;
type Filter = typeof filters[number];

export function Applications({ applications, selected, query, setQuery, filter, setFilter, choose, statusOf, isAdmin, busy }: {
  applications: Application[];
  selected: string;
  query: string;
  setQuery: (value: string) => void;
  filter: Filter;
  setFilter: (value: Filter) => void;
  choose: (application: Application) => void;
  statusOf: (connection: Connection) => string;
  isAdmin: boolean;
  busy: boolean;
}) {
  const phrase = query.trim().toLowerCase();
  const visible = applications.filter(app => {
    const matches = [app.name, app.id, app.description].some(value => value.toLowerCase().includes(phrase));
    if (!matches || filter === 'All') return matches;
    // rule-policy: technical integration-status-filter Filters by existing visible connection states.
    return app.connections.some(item => {
      // rule-policy: technical integration-status-filter-label Matches actual registry status to the derived filter.
      const status = statusOf(item).toLowerCase();
      return filter === 'Connected' ? status === 'connected' : ['error', 'needs attention'].includes(status);
    });
  });
  return (
    <>
      <div className="space-y-2.5 border-b border-background-200 p-3 md:p-4">
        <h2 className="font-heading text-lg font-bold text-foreground-950">Applications</h2>
        <div className="relative">
          <i className="ri-search-line pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-500" aria-hidden="true" />
          <TextInput type="search" aria-label="Search applications" placeholder="Search applications" className="pl-8" value={query} onChange={event => setQuery(event.target.value)} />
        </div>
        <div className="flex flex-wrap gap-1" aria-label="Filter applications">
          {filters.map(item => <Button key={item} size="sm" variant={filter === item ? 'secondary' : 'outline'}
            className={filter === item ? '!bg-primary-100 !text-primary-800' : ''} aria-pressed={filter === item}
            onClick={() => setFilter(item)}>{item}</Button>)}
        </div>
      </div>
      <ul className="integration-list divide-y divide-background-200">
        {visible.map(app => {
          const current = app.id === selected;
          const item = app.connections[0];
          return (
            <li key={app.id} data-testid={item ? `connection-${app.id}` : undefined}>
              <button type="button" disabled={busy} aria-pressed={current}
                className={`flex w-full items-center gap-2.5 border-l-2 px-3 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-500 disabled:cursor-wait ${current ? 'border-primary-500 bg-primary-50' : 'border-transparent hover:bg-background-100'}`}
                onClick={() => choose(app)}>
                <ProviderIcon application={app} />
                <span className="min-w-0 flex-1 break-words font-semibold text-foreground-950">{app.name}</span>
                {/* // rule-policy: technical integration-status-view Renders the current snapshot status. */}
                <span className="text-right" data-testid={item ? `connection-status-${app.id}` : undefined}>
                  <ConnectionStatus status={item ? statusOf(item) : availabilityLabel(isAdmin, app.definition)} />
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
      <ProviderIcon application={application} large />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="break-words font-heading text-xl font-bold text-foreground-950">{application.name}</h2>
          <ConnectionStatus status={connection ? statusOf(connection) : availabilityLabel(isAdmin, application.definition)} />
        </div>
        {application.description && <p className="mt-1 text-sm text-foreground-600">{application.description}</p>}
      </div>
    </header>
  );
}
