import { useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { integrationRequest, type Snapshot } from './api';
import { Button } from '@/pages/admin/components/ui';
import { useToast } from '@/pages/admin/components/toastContext';
import { paymentsAction } from '@/lib/signingApi';
import { currentTenantSite } from '@/lib/tenantSite';
import { Empty, Frame } from './shared';
import { ApplicationHeader, Applications, Overview, type Application } from './Applications';
import LogsPage from './LogsPage';
import SettingsPage from './SettingsPage';
import SyncHistoryPage from './SyncHistoryPage';
import WebhooksPage from './WebhooksPage';
import { useDraftRegistry } from '@/pages/admin/lib/draftContext';
import { useIntegrations, date, inputClass, sections, type Section } from './state';
import PendingCredentialsForm from './PendingCredentialsForm';
import CommConnectionForm, { VAULT_FORM_CONNECTORS } from './CommConnectionForm';
import Microsoft365Panel from '@/pages/admin/components/Microsoft365Panel';
import { m365Label, useMicrosoft365 } from '@/pages/admin/lib/microsoft365';
import SearchableSelect from "@/components/ui/SearchableSelect";

/** Microsoft 365 (2026-11-20) is its own entry, first, with the one status Email Management shows (app-only Microsoft Graph checks). */
const M365 = 'microsoft365';
/** Connectors set up with CommConnectionForm (details in Vault): the Communication Hub's, Google Maps and the OMARA search APIs. */
const isVaultFormConnector = (id: string | null | undefined) => !!id && (VAULT_FORM_CONNECTORS as readonly string[]).includes(id);
/** What each entry is for, where the name alone is not enough. */
const PURPOSE: Record<string, string> = {
  microsoft365: 'Email Management and student emails (Skyline\u2019s Entra app).',
  microsoft_teams: 'Posts Communication Hub messages to Teams channels (channel links). Separate from Microsoft 365 email.',
  google_maps: 'Fills a business\u2019s office address, website and phone on Add business (Places API (New)).',
  brave_search: 'Finds a business\u2019s registered migration agents on the public OMARA register (Add business).',
  tavily: 'Finds a business\u2019s registered migration agents on the public OMARA register (alternative to Brave Search).',
};

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

const DRAFT = 'integration-form';

export default function ConnectionsPage() {
  const { pathname } = useLocation();
  const section = sections.find(item => item.to === pathname)?.id ?? 'overview';
  return <Workspace key={section} section={section} />;
}

function Workspace({ section }: { section: Section }) {
  const state = useIntegrations();
  const { load } = state;
  const [params] = useSearchParams();
  const [provider, setProvider] = useState('');
  const [query, setQuery] = useState('');
  const [auth, setAuth] = useState('');
  const [tab, setTab] = useState('configuration');
  const draft = useDraftRegistry();
  const dirty = useRef(false);
  function setDirty(value: boolean) {
    dirty.current = value;
    draft?.setDirty(DRAFT, value, 'Unsaved integration changes will be discarded. Leave this page?');
  }
  useEffect(() => () => draft?.clear(DRAFT), [draft]);
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
  const { push } = useToast();
  /** A success shows on the page and as a toast; the page's own snapshot is re-read by `perform` right after. */
  const announce = (text: string) => { setNotice(text); push(text); };

  const connection = state.data?.connections.find(item => item.id === selected);
  const providerId = connection?.connector_id ?? provider;
  const definition = state.data?.definitions.find(item => item.id === providerId);
  const app = definition && appSettings[definition.id];
  const isOAuth = definition?.auth_type === 'oauth2';
  const isAdmin = state.data?.isAdmin === true;
  const catalog = section === 'overview' || section === 'applications' || section === 'add' || section === 'credentials';
  const m365 = useMicrosoft365(catalog && state.data?.connections.some(item => item.connector_id === M365) === true);
  const nameOf = (connectorId: string | undefined) => state.data?.definitions.find(provider => provider.id === connectorId)?.name ?? connectorId ?? 'The';
  /** The single status per entry: Microsoft 365 shows the same check as Email Management. */
  const statusOf = (item: { connector_id: string; status: string }) => item.connector_id === M365 && (m365.status || m365.loading) ? m365Label(m365.status, m365.loading) : item.status.replaceAll('_', ' ');
  const applications = new Map<string, Application>();
  for (const item of state.data?.definitions ?? []) {
    applications.set(item.id, { id: item.id, name: item.name, description: PURPOSE[item.id] ?? item.description, definition: item, connections: [] });
  }
  for (const item of state.data?.connections ?? []) {
    const application = applications.get(item.connector_id);
    if (application) application.connections.push(item);
    else applications.set(item.connector_id, { id: item.connector_id, name: item.connector_id, description: '', connections: [item] });
  }
  const selectedApp = applications.get(providerId);
  const listed = Array.from(applications.values()).sort((a, b) => Number(b.id === M365) - Number(a.id === M365));

  useEffect(() => {
    if (!catalog || !selected || !isOAuth || !isAdmin || definition?.id === M365) return;
    let current = true;
    void integrationRequest<OAuthSetup>('oauth_setup', { connectionId: selected }).then(result => {
      if (!current) return;
      setSetup(result);
      setEditing(!result.configured);
      setEnvironment(result.configured ? result.environment : 'production');
    }).catch(problem => { if (current) setError(errorMessage(problem)); });
    return () => { current = false; };
  }, [catalog, selected, isOAuth, isAdmin, definition?.id]);

  useEffect(() => {
    const code = params.get('code');
    const returnedState = params.get('state');
    const providerError = params.get('error');
    if (!catalog || handled.current || (!code && !providerError)) return;
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
        const latest = await integrationRequest<Snapshot>('snapshot');
        const connectorId = latest.connections.find(item => item.id === connectionId)?.connector_id;
        setNotice(`${latest.definitions.find(provider => provider.id === connectorId)?.name ?? 'The'} connection verified.`);
      } catch (problem) {
        setError(errorMessage(problem));
      } finally {
        await load();
        setBusy(false);
      }
    })();
  }, [catalog, params, load]);

  function selectConnection(id: string) {
    setDirty(false);
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

  // Every action, successful or not, is followed by a fresh snapshot so the status line and the list card show the connection as the backend now sees it.
  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try { await operation(); } catch (problem) { const message = errorMessage(problem); setError(message); push(message, 'error'); }
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
      setTab('credentials');
    });
  }

  const disabled = connection?.status === 'disabled';
  // Apps whose connector is not built yet: their details can be stored, but there is nothing to test or disconnect.
  const pendingApp = definition?.availability === 'requires_approval' && Object.hasOwn(australianEducationApps, definition.id);
  // Communication Hub accounts (ClickSend, WhatsApp Business, Microsoft Teams channels) and Google Maps: saved here in Vault, used server side.
  const commApp = isVaultFormConnector(definition?.id);
  const wrongDomain = setup && new URL(setup.callbackUrl).origin !== window.location.origin;
  // rule-policy: security integration-credential-access Reuses existing administrator and provider form availability.
  const hasCredentials = isAdmin && !!connection && !disabled && !!definition && definition.id !== M365 &&
    (pendingApp || commApp || (isOAuth ? !!app : definition.availability !== 'requires_approval'));
  // rule-policy: security integration-stripe-webhook Reuses the existing administrator and connected-state checks.
  const paymentWebhook = isAdmin && definition?.id === 'stripe' && connection?.status === 'connected';
  const data = state.data;
  const globalView = section === 'webhooks' || section === 'sync-history' || section === 'logs' || section === 'settings';

  function confirmDiscard() {
    return !dirty.current || window.confirm('Discard unsaved integration changes?');
  }
  function choose(application: Application) {
    if (application.id === providerId || !confirmDiscard()) return;
    setProvider(application.id);
    const next = application.connections[0];
    selectConnection(next?.id ?? '');
    setTab(isAdmin ? 'credentials' : 'configuration');
    requestAnimationFrame(() => {
      const details = document.getElementById('integration-details');
      const applicationList = details?.previousElementSibling;
      if (details && applicationList && details.getBoundingClientRect().top > applicationList.getBoundingClientRect().top + 1) {
        details.focus();
      }
    });
  }

  const tabs = [
    { id: 'configuration', label: 'Configuration', visible: true },
    { id: 'credentials', label: 'Credentials', visible: hasCredentials },
    { id: 'webhooks', label: 'Webhooks', visible: connection && (definition?.id === 'stripe' || connection.webhook_configured ||
      data?.registrations.some(item => item.connection_id === connection.id) || data?.events.some(item => item.connection_id === connection.id)) },
    { id: 'sync-history', label: 'Sync History', visible: connection && data?.jobs.some(item => item.connection_id === connection.id) },
    { id: 'logs', label: 'Logs', visible: connection && data?.logs.some(item => item.connector_id === connection.connector_id) },
  ].filter(item => item.visible);
  const activeTab = tabs.some(item => item.id === tab) ? tab : 'configuration';

  const education = definition && Object.hasOwn(australianEducationApps, definition.id) ? australianEducationApps[definition.id] : undefined;
  // rule-policy: security integration-add-access Reuses the existing administrator and provider availability checks.
  const addable = isAdmin && definition && !selectedApp?.connections.length &&
    (definition.availability !== 'requires_approval' || education);
  const visibleApps = section === 'add' ? listed.filter(item => !item.connections.length || item.id === providerId) : listed;

  const configurationActions = isAdmin && connection && (
    <>
      {/* // rule-policy: security integration-test-access Reuses the existing restrictions on retrying a connection. */}
      {!pendingApp && !commApp && definition?.id !== M365 && connection.credential_configured && (!isOAuth || setup?.authorized) && !disabled && connection.status !== 'connected' && (
        <Button variant="outline" disabled={busy} onClick={() => void perform(async () => {
          await integrationRequest('test', { connectionId: selected });
          announce(`${nameOf(definition?.id)} connection verified.`);
        })}>Retry connection check</Button>
      )}
      {!pendingApp && !commApp && definition?.id !== M365 && (connection.credential_configured || connection.webhook_configured) && (
        <Button variant="outline" disabled={busy} onClick={() => void perform(async () => {
          await integrationRequest('revoke', { connectionId: selected });
          if (isOAuth) {
            const updated = await integrationRequest<OAuthSetup>('oauth_setup', { connectionId: selected });
            setSetup(updated);
            setEditing(!updated.configured);
          }
          announce('Connection disconnected.');
        })}>Disconnect</Button>
      )}
      {!disabled && <details>
        <summary className="cursor-pointer text-sm">Connection controls</summary>
        <Button variant="outline" className="mt-2" disabled={busy} onClick={() => void perform(async () => {
          await integrationRequest('disable', { connectionId: selected });
          announce('Connection disabled.');
        })}>Disable connection</Button>
      </details>}
    </>
  );

  const credentialsPanel = connection && isAdmin && !disabled && (definition?.id === M365 ? (
    <Microsoft365Panel />
  ) : isOAuth && app ? (
    setup ? (wrongDomain ? (
      <a className="underline" href={`${setup.callbackUrl}?connection=${encodeURIComponent(selected)}`}>Open CRM on the sign-in domain</a>
    ) : editing ? (
      <form className="space-y-4" onChangeCapture={() => setDirty(true)} onSubmit={event => {
        event.preventDefault();
        const value = secret;
        setSecret('');
        void perform(async () => {
          await integrationRequest('oauth_app_save', { connectionId: selected, clientId, clientSecret: value, environment });
          setSetup({ ...setup, configured: true, authorized: false, environment });
          setEditing(false);
          setClientId('');
          setDirty(false);
          await authorize();
        });
      }}>
        <p>{app.instruction} <a className="underline" href={app.link} target="_blank" rel="noreferrer">Open provider setup</a></p>
        <label className="block">Redirect URL<input className={inputClass} value={setup.callbackUrl} readOnly /></label>
        {/* // rule-policy: security integration-oauth-input Existing input bounds and masking stay in force. */}
        <label className="block">{app.label}<input className={inputClass} value={clientId} onChange={event => setClientId(event.target.value)} required maxLength={300} /></label>
        <label className="block">Client secret<input className={inputClass} type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} required maxLength={3000} /></label>
        {definition.id === 'docusign' && <label className="block">DocuSign environment
          <SearchableSelect className={inputClass} value={environment} onChange={event => setEnvironment(event.target.value === 'demo' ? 'demo' : 'production')}>
            <option value="production">Live</option>
            <option value="demo">Demo</option>
          </SearchableSelect>
        </label>}
        <Button type="submit" disabled={busy || !clientId.trim() || !secret.trim()}>Save &amp; sign in</Button>
        {setup.configured && <Button type="button" variant="outline" disabled={busy} onClick={() => {
          setClientId('');
          setSecret('');
          setEnvironment(setup.environment);
          setEditing(false);
          setDirty(false);
        }}>Cancel</Button>}
      </form>
    ) : (
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void perform(authorize)}>
          {setup.authorized ? 'Reconnect' : 'Sign in'}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>Update app credentials</Button>
      </div>
    )) : error ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform(async () => {
      const result = await integrationRequest<OAuthSetup>('oauth_setup', { connectionId: selected });
      setSetup(result);
      setEditing(!result.configured);
      setEnvironment(result.configured ? result.environment : 'production');
    })}>Retry setup</Button> : (
      // rule-policy: technical integration-oauth-loading Shows progress while reading existing setup metadata.
      <p role="status">Loading provider setup…</p>
    )
  ) : commApp && definition ? (
    <CommConnectionForm key={connection.id} connectionId={connection.id} connectorId={definition.id} busy={busy} perform={perform} onNotice={announce} onDraftChange={setDirty} />
  ) : pendingApp && definition ? (
    <PendingCredentialsForm key={connection.id} connectionId={connection.id} name={definition.name} saved={connection.credential_configured}
      busy={busy} perform={perform} onNotice={setNotice} onDraftChange={setDirty} />
  // rule-policy: security integration-provider-availability Preserves the existing unsupported-provider handling.
  ) : definition?.availability === 'requires_approval' || isOAuth ? (
    <p>This application needs provider approval and a supported connector before you can connect it.</p>
  ) : definition && (
    <form className="space-y-4" onChangeCapture={() => setDirty(true)} onSubmit={event => {
      event.preventDefault();
      const value = secret;
      setSecret('');
      void perform(async () => {
        await integrationRequest('credential', { connectionId: selected, kind, secret: value });
        setDirty(false);
        if (kind === 'api_key' || connection.credential_configured) {
          announce(`${definition.name} ${kind === 'api_key' ? 'API key' : 'webhook secret'} saved. Checking the connection…`);
          await integrationRequest('test', { connectionId: selected });
          await load();
          announce(`${definition.name} is connected.`);
        } else {
          announce('Webhook signing secret saved.');
        }
      });
    }}>
      {definition.id === 'stripe' && <label className="block">Credential type
        <SearchableSelect className={inputClass} value={kind} onChange={event => { setKind(event.target.value); setSecret(''); }}>
          <option value="api_key">API key</option>
          <option value="webhook_secret">Webhook signing secret</option>
        </SearchableSelect>
      </label>}
      {/* // rule-policy: security integration-api-key-input Existing input bounds and masking stay in force. */}
      <label className="block">{kind === 'webhook_secret' ? 'Webhook signing secret' : definition.id === 'stripe' ? 'Stripe secret or restricted API key' : 'API key'}
        <input className={inputClass} type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} required maxLength={8000} />
      </label>
      <Button type="submit" disabled={busy || !secret.trim()}>{kind === 'api_key' ? 'Save & Connect' : 'Save'}</Button>
    </form>
  ));

  const stripeControls = paymentWebhook && (
    <section className="space-y-2 rounded border border-background-300 p-3 text-sm" data-testid="stripe-payment-webhook">
      <p className="font-semibold">Payments on document signing</p>
      {/* // rule-policy: technical integration-payment-webhook-status Formats the current webhook state. */}
      <p>Payment webhook: {connection.webhook_configured ? 'ready (Stripe tells Skyline when a payment is received, fails or is refunded).' : 'not set up. Stripe payments are only confirmed when a signer returns to the signing page or an administrator refreshes the request.'}</p>
      <Button variant="outline" disabled={busy} data-testid="stripe-webhook-sync" onClick={() => void perform(async () => {
        await paymentsAction<{ ok: boolean; created?: boolean; updated?: boolean }>({ action: 'webhook_sync', tenantId: currentTenantSite()?.tenantId ?? null });
        announce('Payment webhook ready.');
      })}>{connection.webhook_configured ? 'Update payment webhook' : 'Set up payment webhook'}</Button>
    </section>
  );

  return (
    <Frame section={section} state={state} applications={
      // rule-policy: technical integration-settings-list The application picker stays read-only in global Settings.
      <Applications applications={visibleApps} selected={providerId} query={query} setQuery={setQuery}
        auth={auth} setAuth={setAuth} choose={choose} statusOf={statusOf} isAdmin={isAdmin} busy={busy || state.busy || section === 'settings'} />
    }>
      <div className="space-y-4">
        {error && <p className="rounded-md border border-primary-200 p-3" role="alert">{error}</p>}
        {/* // rule-policy: technical integration-action-feedback Announces the result of the existing action. */}
        {notice && <p className="rounded-md bg-primary-50 p-3 text-primary-800" role="status">{notice}</p>}
        {globalView ? (
          <>
            <h2 className="font-heading text-xl font-bold text-foreground-950">{sections.find(item => item.id === section)?.label}</h2>
            {selectedApp && section !== 'settings' && <div className="flex flex-wrap items-start justify-between gap-2">
              <ApplicationHeader application={selectedApp} connection={connection} statusOf={statusOf} isAdmin={isAdmin} />
              <Button size="sm" variant="ghost" onClick={() => { setProvider(''); selectConnection(''); }}>Show all</Button>
            </div>}
            {section === 'webhooks' && (selectedApp && !connection ? <Empty>No webhooks for this application.</Empty> : <WebhooksPage state={state} connection={connection} />)}
            {section === 'sync-history' && (selectedApp && !connection ? <Empty>No jobs for this application.</Empty> : <SyncHistoryPage state={state} connection={connection} />)}
            {section === 'logs' && <LogsPage state={state} connectorId={selectedApp?.id} />}
            {section === 'settings' && isAdmin && <div onChangeCapture={() => setDirty(true)}>
              <SettingsPage state={state} />
            </div>}
          </>
        ) : selectedApp ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <ApplicationHeader application={selectedApp} connection={connection} statusOf={statusOf} isAdmin={isAdmin} />
              {section === 'overview' && <Button size="sm" variant="ghost" onClick={() => {
                if (confirmDiscard()) { setProvider(''); selectConnection(''); }
              }}>Back to overview</Button>}
            </div>
            {selectedApp.connections.length > 1 && <label className="block text-sm">Connection
              <SearchableSelect className={inputClass} value={selected} disabled={busy} onChange={event => {
                if (confirmDiscard()) selectConnection(event.target.value);
              }}>
                {selectedApp.connections.map(item => <option key={item.id} value={item.id}>{statusOf(item)} · {item.id}</option>)}
              </SearchableSelect>
            </label>}
            {tabs.length > 1 && <nav aria-label="Application details" className="flex flex-wrap gap-1 border-b border-background-200 pb-2">
              {tabs.map(item => <Button key={item.id} size="sm" variant={activeTab === item.id ? 'secondary' : 'ghost'}
                aria-pressed={activeTab === item.id} onClick={() => setTab(item.id)}>{item.label}</Button>)}
            </nav>}
            <div hidden={activeTab !== 'configuration'} className="space-y-4">
              {connection ? (
                <>
                  <dl className="grid grid-cols-2 gap-2 rounded-md border border-background-200 bg-background-100 p-3 text-sm">
                    <div><dt className="text-xs text-foreground-600">Last successful check</dt><dd>{date(connection.last_success_at)}</dd></div>
                    <div><dt className="text-xs text-foreground-600">Credentials</dt><dd>{connection.credential_configured ? 'Configured' : 'Not configured'}</dd></div>
                  </dl>
                  {isAdmin && disabled && <Button disabled={busy} onClick={() => void perform(async () => {
                    await integrationRequest('enable', { connectionId: selected });
                    announce('Connection enabled.');
                  })}>Enable connection</Button>}
                  {!isAdmin && connection.can_operate && !isVaultFormConnector(connection.connector_id) && <Button variant="outline" disabled={busy || disabled}
                    onClick={() => void perform(async () => {
                      await integrationRequest('test', { connectionId: connection.id });
                      if (connection.connector_id === M365) await m365.refresh();
                      announce(`${nameOf(connection.connector_id)} connection verified.`);
                    })}>Check connection</Button>}
                  {configurationActions}
                </>
              ) : (
                <div className="space-y-3">
                  {/* // rule-policy: technical integration-approval-copy Displays existing provider availability and guidance. */}
                  {education && definition?.availability === 'requires_approval' && <>
                    <p>{education.purpose}</p>
                    {/* // rule-policy: technical integration-approval-guidance Renders the existing provider access guidance. */}
                    <p className="text-foreground-600">{education.nextStep} Until approved access and a supported connector are available, use the provider’s own website.</p>
                  </>}
                  {/* // rule-policy: technical integration-add-label Labels the existing add action based on provider availability. */}
                  {addable ? <Button disabled={busy} onClick={() => void addConnection(definition.id)}>
                    {definition.availability === 'requires_approval' ? 'Store access details' : 'Add connection'}
                  </Button> : <Empty>No connection is available for this application.</Empty>}
                </div>
              )}
            </div>
            <div key={selected} hidden={activeTab !== (hasCredentials ? 'credentials' : 'configuration')} className="max-w-2xl space-y-3">
              {credentialsPanel}
            </div>
            {activeTab === 'webhooks' && <WebhooksPage state={state} connection={connection} paymentControls={stripeControls} />}
            {activeTab === 'sync-history' && <SyncHistoryPage state={state} connection={connection} />}
            {activeTab === 'logs' && <LogsPage state={state} connectorId={providerId} />}
          </>
        ) : section === 'overview' && data ? (
          <Overview data={data} statusOf={statusOf} />
        ) : (
          <Empty>{section === 'add' ? 'Choose an application to add a connection.' : 'Select an application to view its connection details.'}</Empty>
        )}
      </div>
    </Frame>
  );
}
