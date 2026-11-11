import { Card } from '@/pages/admin/components/ui';
import { Frame } from './shared';
import { useIntegrations, date } from './state';
export default function OverviewPage() {
  const state = useIntegrations(); const d = state.data;
  return <Frame title="Integration Overview" state={state}>{d && <><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[
    ['Connected applications', d.connections.filter(c => c.status === 'connected').length], ['Connections needing attention', d.connections.filter(c => c.status === 'error' || c.status === 'not_connected').length], ['Recent failed webhooks', d.events.filter(e => e.status === 'failed').length], ['Recent integration errors', d.settings.alerts_enabled ? d.logs.filter(l => l.severity === 'error').length : 'Alerts off']
  ].map(([label,value]) => <Card className="p-5" key={label}><p>{label}</p><strong className="text-3xl">{value}</strong></Card>)}</div><Card className="mt-5 p-5"><h2 className="font-bold">Recent synchronization activity</h2>{d.jobs.length ? d.jobs.slice(0,10).map(j => <p className="py-2" key={j.id}>{j.operation}: {j.status} · {date(j.created_at)}</p>) : <p>No synchronization jobs have run.</p>}<p className="mt-3 text-sm">Activity totals cover the latest 100 entries. A saved credential alone does not establish a connection.</p></Card></>}</Frame>;
}
