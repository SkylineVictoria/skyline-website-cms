import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, PageHeader } from '@/pages/admin/components/ui';
import { sections, useIntegrations } from './state';
export function Frame({ title, state, children }: { title: string; state: ReturnType<typeof useIntegrations>; children: ReactNode }) {
  return <div><PageHeader title={title} description="External Integrations" /><nav aria-label="External Integrations" className="mb-5 flex flex-wrap gap-3">{sections.filter(([path]) => state.data?.isAdmin || !['add','credentials','settings'].includes(path)).map(([path,label]) => <Link className="text-sm text-primary-700 underline" key={path} to={`/admin/integrations/${path}`}>{label}</Link>)}</nav>
    {state.error && <div role="alert" className="mb-4 rounded border border-primary-200 p-3">{state.error} <Button variant="outline" onClick={() => void state.load()}>Reload</Button></div>}
    {state.notice && <p role="status" className="mb-4">{state.notice}</p>}
    {!state.data && !state.error ? <p role="status">Loading integrations…</p> : children}</div>;
}
export function Empty({ children }: { children: ReactNode }) { return <Card className="p-6 text-foreground-600">{children}</Card>; }
