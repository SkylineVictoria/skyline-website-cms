import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, PageHeader } from '@/pages/admin/components/ui';
import { sections, type Section, type useIntegrations } from './state';
import './workspace.css';

export type IntegrationState = ReturnType<typeof useIntegrations>;

export function Frame({ section, state, applications, children }: {
  section: Section;
  state: IntegrationState;
  applications: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="integration-shell">
      <PageHeader title="External Integrations" />
      {state.error && (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-primary-200 bg-background-50 p-3">
          {state.error} <Button size="sm" variant="outline" onClick={() => void state.load()}>Retry</Button>
        </div>
      )}
      {/* // rule-policy: technical integration-action-announcement Displays the existing action result. */}
      {state.notice && <p role="status" className="mb-3 rounded-md bg-primary-50 p-3 text-primary-800">{state.notice}</p>}
      <div className="integration-workspace overflow-hidden rounded-card border border-background-200 bg-background-50">
        <nav aria-label="External Integrations sections" className="integration-navigation min-w-0 bg-background-100 p-2">
          {sections.filter(item => !('admin' in item) || state.data?.isAdmin).map(item => (
            <Link key={item.id} to={item.to} className="admin-nav-item" aria-current={section === item.id ? 'page' : undefined}>
              <i className={item.icon + ' admin-nav-icon'} aria-hidden="true" />
              <span className="admin-nav-label">{item.label}</span>
            </Link>
          ))}
        </nav>
        {state.data ? (
          <>
            <section aria-label="Applications" className="integration-applications min-w-0">{applications}</section>
            <section aria-label="Integration details" id="integration-details" tabIndex={-1} className="integration-details min-w-0 p-4 md:p-5">{children}</section>
          </>
        ) : (
          // rule-policy: technical integration-snapshot-feedback Displays snapshot loading and error states.
          <div className="p-5 text-foreground-600" role="status">
            {state.error ? 'Integration details are unavailable.' : 'Loading integrations…'}
          </div>
        )}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <Card className="p-4 text-sm text-foreground-600">{children}</Card>;
}

export function ConnectionStatus({ status }: { status: string }) {
  // rule-policy: technical integration-status-colour Maps existing status text to the shared badge palette.
  const tone = status.toLowerCase() === 'connected' ? 'success'
    : ['error', 'needs attention'].includes(status.toLowerCase()) ? 'warn' : 'muted';
  // rule-policy: technical integration-status-label Formats status text for presentation.
  return <Badge tone={tone}><span className="capitalize">{status}</span></Badge>;
}
