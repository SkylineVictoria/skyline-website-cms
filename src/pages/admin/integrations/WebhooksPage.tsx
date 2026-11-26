import { Button } from '@/pages/admin/components/ui';
import type { Connection } from './api';
import { ConnectionStatus, Empty, type IntegrationState } from './shared';
import { date } from './state';

export default function WebhooksPage({ state, connection, paymentControls }: {
  state: IntegrationState;
  connection?: Connection;
  paymentControls?: React.ReactNode;
}) {
  const { data, busy, run } = state;
  if (!data) return null;
  const connections = connection ? [connection] : data.connections;
  const registrations = data.registrations.filter(item => !connection || item.connection_id === connection.id);
  const events = data.events.filter(item => !connection || item.connection_id === connection.id);
  const canRegister = connections.filter(item => item.connector_id === 'stripe' && !data.registrations.some(row => row.connection_id === item.id));
  return (
    <div className="space-y-4">
      {paymentControls}
      <section aria-label="Webhook registrations" className="space-y-2 rounded-md border border-background-200 p-3">
        <h3 className="font-semibold">Webhook registrations</h3>
        {registrations.map(row => <div key={row.id} className="border-b border-background-200 pb-2 text-sm">
          <p className="break-all font-medium">{row.endpoint_url}</p>
          <p>{row.event_types.join(', ')}</p>
          <p className="break-words text-foreground-600">Provider registration: {row.provider_id}</p>
        </div>)}
        {/* // rule-policy: security integration-webhook-access Reuses the existing administrator and connection checks. */}
        {canRegister.map(item => <Button key={item.id} size="sm" disabled={busy || !data.isAdmin || item.status !== 'connected'}
          onClick={() => void run('webhook_register', { connectionId: item.id }, 'Stripe webhook endpoint registered.')}>Register Stripe webhook</Button>)}
        {(!connection || connection.connector_id === 'stripe') && <p className="text-sm text-foreground-600">Stripe deliveries require a signing secret and a registered endpoint. Verified event metadata is retained for operational review.</p>}
        {connections.filter(item => item.webhook_configured).map(item => <p key={item.id} className="text-sm">
          {item.connector_id}: signing secret configured. Register this endpoint in Stripe: <code className="break-all">{import.meta.env.VITE_PUBLIC_SUPABASE_URL}/functions/v1/integrations-webhook?connection={item.id}</code>
        </p>)}
        {!registrations.length && !canRegister.length && !connections.some(item => item.webhook_configured) && <p className="text-sm text-foreground-600">No webhook registrations.</p>}
      </section>
      <section aria-label="Webhook events" className="space-y-2">
        <h3 className="font-semibold">Webhook events</h3>
        {events.map(event => <div key={event.id} className="space-y-1 rounded-md border border-background-200 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all font-medium">{event.event_type}</span>
            <ConnectionStatus status={event.status} />
          </div>
          <p className="text-foreground-600">{date(event.created_at)} · Last rechecked {date(event.verified_at)}</p>
          <p className="break-words">Provider deliveries: {event.attempts} · Rechecks: {event.retry_count} · Event: {event.provider_event_id}</p>
          {/* // rule-policy: security integration-webhook-operator Reuses the existing operator permission on rechecks. */}
          <Button size="sm" variant="outline" disabled={busy || !connections.find(item => item.id === event.connection_id)?.can_operate}
            onClick={() => void run('event_recheck', { eventId: event.id }, 'Provider event verified. No business workflow was executed.')}>
            {/* // rule-policy: technical integration-webhook-retry-label Reflects the current webhook event state. */}
            {event.status === 'failed' ? 'Retry verification' : 'Recheck event'}
          </Button>
          {/* // rule-policy: technical integration-webhook-attempts Displays existing webhook delivery records. */}
          {data.eventAttempts.filter(attempt => attempt.event_id === event.id).map(attempt =>
            <p className="break-words text-xs text-foreground-600" key={attempt.id}>{date(attempt.created_at)} · {attempt.status} · {attempt.code}</p>)}
        </div>)}
        {!events.length && <Empty>No verified webhook events received.</Empty>}
      </section>
    </div>
  );
}
