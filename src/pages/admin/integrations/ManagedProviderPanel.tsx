import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Field, TextInput } from '@/pages/admin/components/ui';
import { useDraftRegistry } from '@/pages/admin/lib/draftContext';
import { integrationRequest, type Definition, type Log } from './api';
import { date } from './state';

type Detail = {
  definition: {
    category: string;
    usage: string[];
    fields: { key: string; label: string; secret?: boolean; required?: boolean; kind?: 'sandbox' }[];
    endpoint: string;
    runtime?: boolean;
    note?: string;
  };
  connection: { id: string; managed_state: string | null; status: string; credential_configured: boolean; updated_at: string; last_success_at: string | null } | null;
  source: string;
  lastSync?: string | null;
  canTestEnvironment?: boolean;
  model?: string;
  sender?: string;
  emailDeliveryEnabled?: boolean;
};

function path(provider: string, connection: string | null, tab: string) {
  const params = new URLSearchParams({ provider, tab });
  if (connection) params.set('connection', connection);
  return `/admin/integrations/applications?${params}`;
}

export default function ManagedProviderPanel({ provider, connectionId, tab, logs, onChange }: {
  provider: Definition;
  connectionId: string | null;
  tab: string;
  logs: Log[];
  onChange: () => Promise<void>;
}) {
  const draftKey = useId();
  const draft = useDraftRegistry();
  const [values, setValues] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const selection = { provider: provider.id, connectionId };
  const publicApi = detail?.definition.fields.length === 0;
  const connection = detail?.connection;
  const active = connection?.managed_state === 'active';
  const visibleTab = tab === 'usage' || (tab === 'logs' && connection) ? tab : 'configuration';
  const visibleLogs = logs.filter(log => log.connector_id === provider.id);

  useEffect(() => () => draft?.clear(draftKey), [draft, draftKey]);
  useEffect(() => {
    let current = true;
    void integrationRequest<Detail>('managed_details', { provider: provider.id, connectionId })
      .then(data => { if (current) setDetail(data); })
      .catch(problem => { if (current) setError(problem instanceof Error ? problem.message : 'Configuration unavailable.'); });
    return () => { current = false; };
  }, [provider.id, connectionId, reload]);

  async function perform(action: string, fields?: Record<string, string>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await integrationRequest<{ result?: string }>(action, {
        ...selection,
        connectionId: connection?.id ?? connectionId,
        version: connection?.updated_at,
        fields,
      });
      if (action === 'managed_save') {
        setValues({});
        draft?.clear(draftKey);
        setNotice('Configuration saved. Test the saved configuration before activation.');
      } else if (action === 'managed_test') {
        setNotice(result.result === 'format_only' ? 'Field format validated. Cloudflare has not verified the key pair.'
          : publicApi ? 'Service available.' : 'The provider accepted the saved configuration.');
      } else {
        setNotice(action === 'managed_activate' ? 'Central configuration activated.' : 'Central connection disabled.');
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'The operation failed.');
    } finally {
      setBusy(false);
      setReload(value => value + 1);
      await onChange();
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    const fields = Object.fromEntries(detail.definition.fields.map(field => [
      field.key, field.kind === 'sandbox' ? 'sandbox' : values[field.key] ?? '',
    ]));
    void perform('managed_save', fields);
  }

  return <Card className="min-w-0 space-y-4 p-5">
    <header>
      <h2 className="text-lg font-semibold">{provider.name}</h2>
      <p className="text-sm text-foreground-600">{provider.description}</p>
    </header>
    {!detail && !error && <p role="status">Loading configuration…</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!detail && error && <Button variant="outline" onClick={() => { setError(''); setReload(value => value + 1); }}>Retry</Button>}
    {detail && <>
      <nav aria-label={`${provider.name} details`} className="flex flex-wrap gap-4 border-b border-background-300 pb-2 text-sm">
        {['configuration', 'usage', ...(connection ? ['logs'] : [])].map(item =>
          <Link key={item} to={path(provider.id, connectionId, item)}
            className={visibleTab === item ? 'font-semibold text-primary-700' : 'capitalize text-foreground-600'}
            aria-current={visibleTab === item ? 'page' : undefined}>
            {item[0].toUpperCase() + item.slice(1)}
          </Link>)}
      </nav>
      {visibleTab === 'usage' && <ul className="list-disc space-y-1 ps-5 text-sm">
        {detail.definition.usage.map(label => <li key={label}>{label}</li>)}
      </ul>}
      {visibleTab === 'logs' && <ul className="space-y-2 text-sm">
        {visibleLogs.length === 0 && <li>No activity recorded.</li>}
        {visibleLogs.map(log => <li key={log.id}>{log.code.replaceAll('_', ' ')} · {date(log.created_at)}</li>)}
      </ul>}
      {visibleTab === 'configuration' && <>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="font-medium">Credential source</dt><dd>{detail.source}</dd></div>
          {!publicApi && <div><dt className="font-medium">Saved configuration</dt><dd>{active ? 'Active' :
            connection?.status === 'connected' ? 'Validated' : connection?.status === 'error' ? 'Check failed' :
              connection?.status === 'disabled' ? 'Disabled' : connection?.credential_configured ? 'Awaiting validation' : 'None'}</dd></div>}
          {connection?.last_success_at && <div><dt className="font-medium">Last successful check</dt><dd>{date(connection.last_success_at)}</dd></div>}
          {detail.lastSync && <div><dt className="font-medium">Last recorded successful sync</dt><dd>{date(detail.lastSync)}</dd></div>}
          {detail.model && <div><dt className="font-medium">Document model</dt><dd>{detail.model}</dd></div>}
          {detail.emailDeliveryEnabled !== undefined && <div><dt className="font-medium">Notification email delivery</dt><dd>{detail.emailDeliveryEnabled ? 'Enabled' : 'Disabled'}</dd></div>}
          {detail.sender && <div><dt className="font-medium">HR sender</dt><dd>{detail.sender}</dd></div>}
          <div className="min-w-0 sm:col-span-2"><dt className="font-medium">Service endpoint</dt><dd className="break-all">{detail.definition.endpoint}</dd></div>
        </dl>
        {detail.definition.note && <p className="text-sm text-foreground-600">{detail.definition.note}</p>}
        {!publicApi && !detail.definition.runtime && <p className="text-sm text-foreground-600">Saved credentials are available for validation. Existing SLIT workflows keep using their current configuration.</p>}
        {active && <p className="text-sm">Disable this connection before replacing its credentials. Imports that depend on it will pause until a replacement is validated and activated.</p>}
        {!publicApi && !active && <form className="space-y-3" onSubmit={save}>
          {detail.definition.fields.map(field => <Field key={field.key} label={field.label} required={field.required}>
            <TextInput required={field.required} type={field.secret ? 'password' : 'text'} autoComplete={field.secret ? 'new-password' : 'off'}
              maxLength={field.secret ? 3000 : 250} readOnly={field.kind === 'sandbox'} disabled={busy}
              placeholder={field.secret && connection?.credential_configured ? 'Saved in Vault' : undefined}
              value={field.kind === 'sandbox' ? 'Sandbox' : values[field.key] ?? ''}
              onChange={event => {
                const updated = { ...values, [field.key]: event.target.value };
                setValues(updated);
                draft?.setDirty(draftKey, Object.values(updated).some(Boolean), 'Discard unsaved integration changes?');
              }} />
          </Field>)}
          <Button type="submit" disabled={busy || !Object.values(values).some(Boolean)}>Save Connection</Button>
        </form>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy || (!publicApi && !connection?.credential_configured && !detail.canTestEnvironment) || Object.values(values).some(Boolean)}
            onClick={() => void perform('managed_test')}>
            {publicApi ? 'Test Availability' : provider.id === 'cloudflare_turnstile' ? 'Validate Configuration' : 'Test Connection'}
          </Button>
          {detail.definition.runtime && !active && connection?.status === 'connected' &&
            <Button disabled={busy || Object.values(values).some(Boolean)} onClick={() => {
              if (window.confirm('Use the saved credential for new requests to this integration?')) void perform('managed_activate');
            }}>Activate central connection</Button>}
          {active && <Button variant="outline" disabled={busy} onClick={() => {
            if (window.confirm('Disable the central connection and pause imports that use it?')) void perform('managed_disable');
          }}>Disable central connection</Button>}
        </div>
        </>}
    </>}
  </Card>;
}
