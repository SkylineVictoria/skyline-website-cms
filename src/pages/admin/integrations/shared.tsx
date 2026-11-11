import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, PageHeader } from '@/pages/admin/components/ui';
import { useIntegrations } from './state';
export function Frame({ title, state, children, showNavigation = true }: { title: string; state: ReturnType<typeof useIntegrations>; children: ReactNode; showNavigation?: boolean }) {
  return <div><PageHeader title={title} description="External Integrations" />{showNavigation && <Link className="mb-5 inline-block text-sm text-primary-700 underline" to="/admin/integrations">Back to Connections</Link>}
    {state.error && <div role="alert" className="mb-4 rounded border border-primary-200 p-3">{state.error} <Button variant="outline" onClick={() => void state.load()}>Reload</Button></div>}
    {state.notice && <p role="status" className="mb-4">{state.notice}</p>}
    {!state.data && !state.error ? <p role="status">Loading integrations…</p> : children}</div>;
}
export function Empty({ children }: { children: ReactNode }) { return <Card className="p-6 text-foreground-600">{children}</Card>; }
