import type { ReactNode } from 'react';
import { Badge, Button, Card, PageHeader } from '@/pages/admin/components/ui';
import type { useIntegrations } from './state';
import './workspace.css';

export type IntegrationState = ReturnType<typeof useIntegrations>;

export function Frame({ state, applications, actions, showDetails, children }: {
  actions: ReactNode;
  showDetails: boolean;
  state: IntegrationState;
  applications: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="integration-shell">
      <PageHeader title="External Integrations" actions={actions} />
      {state.error && (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-primary-200 bg-background-50 p-3">
          {state.error} <Button size="sm" variant="outline" onClick={() => void state.load()}>Retry</Button>
        </div>
      )}
      {/* // rule-policy: technical integration-action-announcement Displays the existing action result. */}
      {state.notice && <p role="status" className="mb-3 rounded-md bg-primary-50 p-3 text-primary-800">{state.notice}</p>}
      <div className="integration-workspace overflow-hidden rounded-card border border-background-200 bg-background-50" data-show-details={showDetails}>
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
  const value = status.toLowerCase();
  // rule-policy: technical integration-status-colour Maps existing connection states to display badges.
  if (value === 'connected') {
    return <span className="inline-flex rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-900">Connected</span>;
  }
  // rule-policy: technical integration-status-tone Maps existing operational statuses to visual tones.
  const tone = ['error', 'failed', 'needs attention', 'requires approval'].includes(value) ? 'warn' : 'muted';
  // rule-policy: technical integration-status-label Formats status text for presentation.
  return <Badge tone={tone}>{status.charAt(0).toUpperCase() + status.slice(1)}</Badge>;
}
