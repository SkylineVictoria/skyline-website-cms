import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { integrationRequest, type Snapshot } from './api';
import { Button, Card } from '@/pages/admin/components/ui';
import { Frame } from './shared';
import { useIntegrations, inputClass } from './state';

type OAuthSetup = {
  callbackUrl: string;
  configured: boolean;
  authorized: boolean;
  environment: 'demo' | 'production';
};

const appSettings: Record<string, { label: string; link: string; instruction: string }> = {
  docusign: {
    label: 'Integration Key',
    link: 'https://developers.docusign.com/platform/configure-app/',
    instruction: 'In DocuSign Apps and Keys, create or open your app. Add this redirect URL, then copy the Integration Key and client secret.',
  },
  microsoft365: {
    label: 'Application (client) ID',
    link: 'https://learn.microsoft.com/en-us/graph/auth-register-app-v2',
    instruction: 'In Microsoft Entra App registrations, create or open an app for accounts in any organizational directory. Add this redirect URL under Web. Copy the Application (client) ID and the client secret Value.',
  },
  xero: {
    label: 'Client ID',
    link: 'https://developer.xero.com/app/manage',
    instruction: 'In Xero My Apps, create or open your web app. Add this redirect URL, then copy the client ID and client secret.',
  },
};

const australianEducationApps: Record<string, { name: string; purpose: string; nextStep: string }> = {
  usi: {
    name: 'USI',
    purpose: 'Verify a student’s Unique Student Identifier.',
    nextStep: 'Confirm SLIT’s access to the USI web services.',
  },
  vevo: {
    name: 'VEVO',
    purpose: 'Check a student’s visa details and conditions.',
    nextStep: 'Confirm what automated access Home Affairs can provide to SLIT.',
  },
  prisms: {
    name: 'PRISMS',
    purpose: 'Manage Confirmations of Enrolment (CoEs).',
    nextStep: 'Confirm whether SLIT can use an approved API for its CoE workflows.',
  },
  datazoo: {
    name: 'DataZoo',
    purpose: 'Verify student identity through a commercial provider.',
    nextStep: 'Confirm the DataZoo products and API environment covered by SLIT’s account.',
  },
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The connection could not be updated.';
}

export default function ConnectionsPage() {
  const state = useIntegrations();
  const { load } = state;
  const [params] = useSearchParams();
  const [adding, setAdding] = useState(() => window.location.pathname.endsWith('/add'));
  const [selected, setSelected] = useState(params.get('connection') ?? '');
  const [secret, setSecret] = useState('');
  const [kind, setKind] = useState('api_key');
  const [clientId, setClientId] = useState('');
  const [environment, setEnvironment] = useState<'demo' | 'production'>('production');
  const [setup, setSetup] = useState<OAuthSetup>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const handled = useRef(false);

  const connection = state.data?.connections.find(item => item.id === selected);
  const definition = state.data?.definitions.find(item => item.id === connection?.connector_id);
  const app = definition && appSettings[definition.id];
  const isOAuth = definition?.auth_type === 'oauth2';
  const isAdmin = state.data?.isAdmin === true;

  useEffect(() => {
    if (!selected || !isOAuth || !isAdmin) return;
    let current = true;
    void integrationRequest<OAuthSetup>('oauth_setup', { connectionId: selected }).then(result => {
      if (!current) return;
      setSetup(result);
      setEditing(!result.configured);
      setEnvironment(result.configured ? result.environment : 'production');
    }).catch(problem => { if (current) setError(errorMessage(problem)); });
    return () => { current = false; };
  }, [selected, isOAuth, isAdmin]);

  useEffect(() => {
    const code = params.get('code');
    const returnedState = params.get('state');
    const providerError = params.get('error');
    if (handled.current || (!code && !providerError)) return;
    handled.current = true;
    const saved = sessionStorage.getItem('integration_oauth');
    sessionStorage.removeItem('integration_oauth');
    window.history.replaceState(window.history.state, '', window.location.pathname);
    if (providerError) {
      setError('Authorization was declined. Select the application to try again.');
      return;
    }
    let pending: { connectionId?: string; state?: string } | null;
    try { pending = JSON.parse(saved ?? 'null'); } catch { pending = null; }
    if (!pending?.connectionId || pending.state !== returnedState) {
      setError('This sign-in session expired. Select the application and try again.');
      return;
    }
    const connectionId = pending.connectionId;
    setSelected(connectionId);
    setBusy(true);
    void (async () => {
      try {
        await integrationRequest('oauth_complete', { connectionId, state: returnedState, code });
        await integrationRequest('test', { connectionId });
        setSetup(await integrationRequest<OAuthSetup>('oauth_setup', { connectionId }));
        setNotice('Connection verified.');
      } catch (problem) {
        setError(errorMessage(problem));
      } finally {
        await load();
        setBusy(false);
      }
    })();
  }, [params, load]);

  function selectConnection(id: string) {
    setSelected(id);
    setSetup(undefined);
    setEditing(false);
    setClientId('');
    setSecret('');
    setKind('api_key');
    setError('');
    setNotice('');
  }

  async function authorize() {
    const result = await integrationRequest<{ url: string; state: string }>('oauth_start', { connectionId: selected });
    sessionStorage.setItem('integration_oauth', JSON.stringify({ state: result.state, connectionId: selected }));
    window.location.assign(result.url);
  }

  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try { await operation(); } catch (problem) { setError(errorMessage(problem)); }
    finally { await load(); setBusy(false); }
  }

  async function addConnection(connectorId: string) {
    await perform(async () => {
      let addError: unknown;
      try { await integrationRequest('add', { connectorId }); } catch (problem) { addError = problem; }
      const latest = await integrationRequest<Snapshot>('snapshot');
      const created = latest.connections.find(item => item.connector_id === connectorId);
      if (!created) throw addError ?? new Error('The connection could not be loaded. Try again.');
      selectConnection(created.id);
      setAdding(false);
    });
  }

  const disabled = connection?.status === 'disabled';
  const wrongDomain = setup && new URL(setup.callbackUrl).origin !== window.location.origin;
  const available = state.data?.definitions.filter(provider =>
    provider.availability !== 'requires_approval' &&
    !state.data?.connections.some(item => item.connector_id === provider.id)
  ) ?? [];

  const pendingEducationApps = state.data?.definitions.filter(provider =>
    provider.availability === 'requires_approval' && Object.hasOwn(australianEducationApps, provider.id)
  ) ?? [];

  return (
    <Frame title="Connections" state={state} showNavigation={false}>
      <div className="mb-4 flex flex-wrap gap-2">
        {isAdmin && <Button disabled={busy} onClick={() => {
          selectConnection('');
          setAdding(!adding);
        }}>{adding ? 'Cancel' : 'Add Connection'}</Button>}
      </div>
      {error && <p className="mb-3" role="alert">{error}</p>}
      {notice && <p className="mb-3" role="status">{notice}</p>}
      {adding && isAdmin && <Card className="mb-4 max-w-2xl space-y-3 p-5">
        <h2 className="font-semibold">Choose an application</h2>
        {available.length ? <div className="flex flex-wrap gap-2">
          {available.map(provider => <Button key={provider.id} variant="outline" disabled={busy}
            onClick={() => void addConnection(provider.id)}>{provider.name}</Button>)}
        </div> : <p>All available applications are already listed in Connections.</p>}
        {pendingEducationApps.length > 0 && <section className="space-y-3 border-t border-background-300 pt-4" aria-labelledby="education-apps-title">
          <h3 id="education-apps-title" className="font-semibold">Australian education integrations</h3>
          <p className="text-sm">These apps need confirmed provider access and a connector before you can enter credentials.</p>
          <ul className="space-y-3">
            {pendingEducationApps.map(provider => {
              const details = australianEducationApps[provider.id];
              return <li key={provider.id} className="rounded border border-background-300 p-3">
                <p className="font-semibold">{details.name}</p>
                <p className="text-sm">{details.purpose}</p>
                <p className="text-sm">{details.nextStep}</p>
              </li>;
            })}
          </ul>
        </section>}
      </Card>}
      {state.data && !state.data.connections.length && !adding && <p>No connections yet.</p>}
      <ul className="mb-4 max-w-2xl space-y-2">
        {state.data?.connections.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-background-300 p-3">
          <div>
            <p className="font-semibold">{state.data?.definitions.find(provider => provider.id === item.connector_id)?.name ?? item.connector_id}</p>
            <p className="text-sm capitalize">{item.status.replaceAll('_', ' ')}</p>
          </div>
          {isAdmin && <Button variant="outline" disabled={busy} onClick={() => {
            setAdding(false);
            selectConnection(item.id === selected ? '' : item.id);
          }}>{item.id === selected ? 'Close setup' : 'Manage'}</Button>}
          {!isAdmin && item.can_operate && <Button variant="outline" disabled={busy || item.status === 'disabled'} onClick={() => void perform(async () => {
            await integrationRequest('test', { connectionId: item.id });
            setNotice('Connection verified.');
          })}>Check connection</Button>}
        </li>)}
      </ul>
      {connection && isAdmin && <Card className="mb-4 max-w-2xl space-y-4 p-5">
        <h2 className="font-semibold">{definition?.name} setup</h2>
        {connection && <p>Status: {connection.status.replaceAll('_', ' ')}</p>}
        {connection && isAdmin && (disabled ? (
          <Button disabled={busy} onClick={() => void perform(async () => {
            await integrationRequest('enable', { connectionId: selected });
          })}>Enable connection</Button>
        ) : isOAuth && app ? (
          setup && (wrongDomain ? (
            <a className="underline" href={`${setup.callbackUrl}?connection=${encodeURIComponent(selected)}`}>Open CRM on the sign-in domain</a>
          ) : editing ? (
            <form className="space-y-4" onSubmit={event => {
              event.preventDefault();
              const value = secret;
              setSecret('');
              void perform(async () => {
                await integrationRequest('oauth_app_save', { connectionId: selected, clientId, clientSecret: value, environment });
                setSetup({ ...setup, configured: true, authorized: false, environment });
                setEditing(false);
                setClientId('');
                await authorize();
              });
            }}>
              <p>{app.instruction} <a className="underline" href={app.link} target="_blank" rel="noreferrer">Open provider setup</a></p>
              <label className="block">Redirect URL<input className={inputClass} value={setup.callbackUrl} readOnly /></label>
              <label className="block">{app.label}<input className={inputClass} value={clientId} onChange={event => setClientId(event.target.value)} required maxLength={300} /></label>
              <label className="block">Client secret<input className={inputClass} type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} required maxLength={3000} /></label>
              {definition.id === 'docusign' && <label className="block">DocuSign environment
                <select className={inputClass} value={environment} onChange={event => setEnvironment(event.target.value === 'demo' ? 'demo' : 'production')}>
                  <option value="production">Live</option>
                  <option value="demo">Demo</option>
                </select>
              </label>}
              <Button type="submit" disabled={busy || !clientId.trim() || !secret.trim()}>Save &amp; sign in</Button>
              {setup.configured && <Button type="button" variant="outline" disabled={busy} onClick={() => {
                setClientId('');
                setSecret('');
                setEnvironment(setup.environment);
                setEditing(false);
              }}>Cancel</Button>}
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void perform(authorize)}>
                {setup.authorized ? 'Reconnect' : 'Sign in'}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>Update app credentials</Button>
            </div>
          ))
        ) : definition?.availability === 'requires_approval' || isOAuth ? (
          <p>This application needs provider approval and a supported connector before you can connect it.</p>
        ) : definition && (
          <form className="space-y-4" onSubmit={event => {
            event.preventDefault();
            const value = secret;
            setSecret('');
            void perform(async () => {
              await integrationRequest('credential', { connectionId: selected, kind, secret: value });
              if (kind === 'api_key' || connection.credential_configured) {
                await integrationRequest('test', { connectionId: selected });
                setNotice('Connection verified.');
              } else {
                setNotice('Webhook signing secret saved.');
              }
            });
          }}>
            {definition.id === 'stripe' && <label className="block">Credential type
              <select className={inputClass} value={kind} onChange={event => { setKind(event.target.value); setSecret(''); }}>
                <option value="api_key">API key</option>
                <option value="webhook_secret">Webhook signing secret</option>
              </select>
            </label>}
            <label className="block">{kind === 'webhook_secret' ? 'Webhook signing secret' : definition.id === 'stripe' ? 'Stripe secret or restricted API key' : 'API key'}
              <input className={inputClass} type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} required maxLength={8000} />
            </label>
            <Button type="submit" disabled={busy || !secret.trim()}>{kind === 'api_key' ? 'Save & Connect' : 'Save'}</Button>
          </form>
        ))}
        {connection?.credential_configured && (!isOAuth || setup?.authorized) && isAdmin && !disabled && connection.status !== 'connected' && (
          <Button variant="outline" disabled={busy} onClick={() => void perform(async () => {
            await integrationRequest('test', { connectionId: selected });
            setNotice('Connection verified.');
          })}>Retry connection check</Button>
        )}
        {connection && isAdmin && (connection.credential_configured || connection.webhook_configured) && (
          <Button variant="outline" disabled={busy} onClick={() => void perform(async () => {
            await integrationRequest('revoke', { connectionId: selected });
            if (isOAuth) {
              const updated = await integrationRequest<OAuthSetup>('oauth_setup', { connectionId: selected });
              setSetup(updated);
              setEditing(!updated.configured);
            }
            setNotice('Connection disconnected.');
          })}>Disconnect</Button>
        )}
        {!disabled && <details>
          <summary className="cursor-pointer text-sm">Connection controls</summary>
          <Button variant="outline" className="mt-2" disabled={busy} onClick={() => void perform(async () => {
            await integrationRequest('disable', { connectionId: selected });
            setNotice('Connection disabled.');
          })}>Disable connection</Button>
        </details>}
      </Card>}
      {state.data && <details className="mt-6">
        <summary className="cursor-pointer text-sm">Advanced</summary>
        <div className="mt-2 flex flex-wrap gap-3 text-sm">
          <Link className="underline" to="/admin/integrations/webhooks">Webhooks &amp; Events</Link>
          <Link className="underline" to="/admin/integrations/sync-history">Sync History</Link>
          <Link className="underline" to="/admin/integrations/logs">Integration Logs</Link>
          {isAdmin && <Link className="underline" to="/admin/integrations/settings">Settings</Link>}
        </div>
      </details>}
    </Frame>
  );
}
