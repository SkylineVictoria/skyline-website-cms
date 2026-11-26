import { Button } from '@/pages/admin/components/ui';
import type { Connection } from './api';
import { ConnectionStatus, Empty, type IntegrationState } from './shared';
import { date } from './state';

export default function SyncHistoryPage({ state, connection }: { state: IntegrationState; connection?: Connection }) {
  const jobs = state.data?.jobs.filter(job => !connection || job.connection_id === connection.id) ?? [];
  return (
    <div className="space-y-2">
      <p className="pb-1 text-sm text-foreground-600">Connection checks are recorded separately from business data synchronization. No payment or student records are synchronized automatically.</p>
      {jobs.map(job => <div key={job.id} className="space-y-1 rounded-md border border-background-200 p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{job.operation.replaceAll('_', ' ')}</h3>
          <ConnectionStatus status={job.status} />
        </div>
        <p className="text-foreground-600">{date(job.created_at)} — {date(job.completed_at)}</p>
        <p>Successful records: {job.success_count} · Failed records: {job.failure_count} · Attempts: {job.attempts}</p>
        <p className="break-all text-xs text-foreground-600">Correlation ID: {job.correlation_id}</p>
        {/* // rule-policy: security integration-retry-job Reuses the existing retryable job and operator checks. */}
        {job.status === 'failed' && job.operation === 'connection_test' && <Button size="sm" variant="outline"
          disabled={state.busy || !state.data?.connections.find(item => item.id === job.connection_id)?.can_operate}
          onClick={() => void state.run('retry', { jobId: job.id }, 'Retry completed.')}>Retry connection check</Button>}
      </div>)}
      {!jobs.length && <Empty>No jobs recorded.</Empty>}
    </div>
  );
}
