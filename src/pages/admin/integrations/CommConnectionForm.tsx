import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/pages/admin/lib/supabase';
import { Button } from '@/pages/admin/components/ui';
import { inputClass } from './state';
import { checkGoogleMapsConnection } from '@/lib/signingApi';

/** Connectors used by the Communication Hub. Their details are kept here, in Integrations, like every other external account. */
export const COMM_CONNECTORS = ['clicksend', 'whatsapp', 'microsoft_teams'] as const;
/** Connectors whose details this form saves in Vault (integration_comm_credentials_save): the hub's, and Google Maps (business auto-fill). */
export const VAULT_FORM_CONNECTORS = [...COMM_CONNECTORS, 'google_maps'] as const;
/** The browser-side format check of a Google Maps key (the database checks the same). */
const GOOGLE_KEY = /^AIza[0-9A-Za-z_-]{30,}$/;
type Summary = { saved: boolean; username?: string; from?: string | null; phoneNumberId?: string; displayNumber?: string | null; channels?: string[]; keyEnd?: string };
type Channel = { name: string; url: string };

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Save / replace / disconnect the details of a ClickSend, WhatsApp Business, Microsoft Teams channels or Google Maps connection. Values never come back. */
export default function CommConnectionForm({ connectionId, connectorId, busy, perform, onNotice }: {
  connectionId: string; connectorId: string; busy: boolean; perform: (operation: () => Promise<void>) => Promise<void>; onNotice: (text: string) => void;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [editing, setEditing] = useState(false);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [c, setC] = useState('');
  const [channels, setChannels] = useState<Channel[]>([{ name: '', url: '' }]);
  const refresh = useCallback(async () => { try { setSummary(await rpc<Summary>('integration_comm_summary', { p_connection: connectionId })); } catch { setSummary(null); } }, [connectionId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const reset = () => { setA(''); setB(''); setC(''); setChannels([{ name: '', url: '' }]); setEditing(false); };

  const maps = connectorId === 'google_maps';
  const fields = connectorId === 'clicksend' ? { username: a, apiKey: b, from: c }
    : connectorId === 'whatsapp' ? { phoneNumberId: a, token: b, displayNumber: c }
    : maps ? { apiKey: b }
    : { channels: channels.filter(x => x.name.trim() || x.url.trim()) };
  const ready = connectorId === 'microsoft_teams' ? channels.some(x => x.name.trim() && x.url.trim()) : maps ? GOOGLE_KEY.test(b.trim()) : !!a.trim() && !!b.trim();

  const save = () => perform(async () => {
    await rpc('integration_comm_credentials_save', { p_connection: connectionId, p_fields: fields });
    reset(); await refresh();
    onNotice(maps ? 'Google Maps key saved. Use Check connection to test it.' : 'Details saved. The Communication Hub can use this connection now.');
  });
  const clear = () => perform(async () => {
    await rpc('integration_comm_credentials_clear', { p_connection: connectionId });
    reset(); await refresh();
    onNotice(maps ? 'Google Maps disconnected. Add business no longer fills the office from Google Maps (unless the server fallback key is set).' : 'Connection disconnected. The Communication Hub no longer offers it.');
  });

  const saved = summary?.saved === true;
  return (
    <div className="space-y-4">
      {saved && !editing ? (
        <div className="space-y-2 text-sm">
          <p>Details saved{connectorId === 'clicksend' ? ` (username ${summary?.username}${summary?.from ? `, sender ${summary.from}` : ''})`
            : connectorId === 'whatsapp' ? ` (phone number ID ${summary?.phoneNumberId}${summary?.displayNumber ? `, ${summary.displayNumber}` : ''})`
            : maps ? ` (API key ending ${summary?.keyEnd ?? '…'})`
            : `: ${summary?.channels?.join(', ')}`}. Values are never shown again.</p>
          <p className="text-foreground-600">{connectorId === 'microsoft_teams' ? 'Link a staff team to one of these channels in Communication Hub › Teams › Manage.'
            : maps ? 'Add business fills the office address, website and phone from Google Maps with this key.'
            : 'The Communication Hub offers this channel when messaging people. Send a test to check it.'}</p>
          {maps ? <GoogleMapsCheckButton busy={busy} /> : connectorId !== 'microsoft_teams' && <TestSend channel={connectorId === 'clicksend' ? 'sms' : 'whatsapp'} busy={busy} />}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>Replace details</Button>
            <Button variant="outline" disabled={busy} onClick={() => void clear()}>Disconnect</Button>
          </div>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save(); }}>
          {connectorId === 'clicksend' ? <>
            <p className="text-sm">From the ClickSend dashboard: Developers › API Credentials.</p>
            <label className="block">API username<input className={inputClass} value={a} onChange={e => setA(e.target.value)} autoComplete="off" required maxLength={200} /></label>
            <label className="block">API key<input className={inputClass} type="password" autoComplete="new-password" value={b} onChange={e => setB(e.target.value)} required maxLength={200} /></label>
            <label className="block">Sender name (optional)<input className={inputClass} value={c} onChange={e => setC(e.target.value)} maxLength={16} placeholder="e.g. Skyline" /></label>
            <p className="text-xs text-foreground-600">Up to 11 letters or numbers. Register it with ClickSend first for Australian numbers.</p>
          </> : maps ? <>
            <p className="text-sm">Create an API key in Google Cloud: <a className="underline" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">APIs &amp; Services › Credentials</a>. Enable Places API (New) and restrict the key to it.</p>
            <label className="block">API key<input className={inputClass} type="password" autoComplete="new-password" value={b} onChange={e => setB(e.target.value)} required maxLength={200} placeholder="AIza…" data-testid="google-maps-key" /></label>
            {b.trim() && !GOOGLE_KEY.test(b.trim()) && <p className="text-xs text-red-700" role="alert">A Google API key starts with AIza and is about 39 characters long.</p>}
            <p className="text-xs text-foreground-600">The key is kept in the vault and is never shown again; only its last four characters are.</p>
          </> : connectorId === 'whatsapp' ? <>
            <p className="text-sm">From Meta for Developers › your app › WhatsApp › API Setup, and a System User token from Meta Business Settings (permission whatsapp_business_messaging).</p>
            <label className="block">Phone number ID<input className={inputClass} value={a} onChange={e => setA(e.target.value)} inputMode="numeric" autoComplete="off" required maxLength={30} /></label>
            <label className="block">Permanent access token<input className={inputClass} type="password" autoComplete="new-password" value={b} onChange={e => setB(e.target.value)} required maxLength={1000} /></label>
            <label className="block">Business number (optional, for display)<input className={inputClass} value={c} onChange={e => setC(e.target.value)} maxLength={40} /></label>
            <p className="text-xs text-foreground-600">WhatsApp only delivers a free message to someone who messaged your business in the last 24 hours.</p>
          </> : <>
            <p className="text-sm">For each Microsoft Teams channel: open the channel in Teams, choose … › Workflows › “Post to a channel when a webhook request is received”, then copy the link it gives you.{saved ? ' Saving replaces the whole list.' : ''}</p>
            {channels.map((ch, i) => (
              <div key={i} className="grid gap-2 rounded border border-background-300 p-2 sm:grid-cols-[1fr_2fr_auto]">
                <input className={inputClass} placeholder="Channel name, e.g. Admissions" value={ch.name} maxLength={60} aria-label={`Channel ${i + 1} name`}
                  onChange={e => setChannels(list => list.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <input className={inputClass} type="password" autoComplete="new-password" placeholder="Channel link (https://…)" value={ch.url} aria-label={`Channel ${i + 1} link`}
                  onChange={e => setChannels(list => list.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} />
                <Button type="button" variant="ghost" disabled={channels.length === 1} onClick={() => setChannels(list => list.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ))}
            {channels.length < 20 && <Button type="button" variant="outline" onClick={() => setChannels(list => [...list, { name: '', url: '' }])}>Add another channel</Button>}
          </>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !ready}>{saved ? 'Save new details' : 'Save & Connect'}</Button>
            {editing && <Button type="button" variant="outline" onClick={reset}>Cancel</Button>}
          </div>
        </form>
      )}
    </div>
  );
}

/** One tiny Google Maps search with the saved key (document-signing, administrators only): OK, or Google's own error message. */
function GoogleMapsCheckButton({ busy }: { busy: boolean }) {
  const [state, setState] = useState('');
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true); setState('Checking…');
    try {
      const out = await checkGoogleMapsConnection();
      const from = out.source === 'fallback_secret' ? ' (the server fallback key was checked, not a saved one)' : '';
      setState(out.ok ? `Connection OK: Google Maps answered${from}.` : `Google Maps refused the key${from}: ${out.message ?? 'unknown reason'}${out.code ? ` (${out.code})` : ''}`);
    } catch (e) { setState(e instanceof Error ? e.message : 'The check could not run.'); }
    finally { setRunning(false); }
  };
  return (
    <div className="space-y-1">
      <Button variant="outline" disabled={busy || running} onClick={() => void run()} data-testid="google-maps-check">Check connection</Button>
      {state && <p className="text-xs" role="status">{state}</p>}
    </div>
  );
}

/** Sends a test message through the saved account to a phone number and shows the provider's answer. */
function TestSend({ channel, busy }: { channel: 'sms' | 'whatsapp'; busy: boolean }) {
  const [to, setTo] = useState('');
  const [state, setState] = useState('');
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true); setState('Sending test…');
    try {
      const request = await rpc<number>('comm_channel_test', { p_channel: channel, p_phone: to });
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const out = await rpc<{ status: string; reason?: string } | null>('comm_channel_test_result', { p_channel: channel, p_request: request });
        if (out && out.status !== 'sending') { setState(out.status === 'sent' ? 'Test sent. Check the phone.' : `Not delivered: ${out.reason ?? 'unknown reason'}`); return; }
      }
      setState('Still waiting for the provider. Check the phone in a minute.');
    } catch (e) { setState(e instanceof Error ? e.message : 'The test could not be sent.'); }
    finally { setRunning(false); }
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <input className={inputClass + ' min-w-0 flex-1'} type="tel" value={to} onChange={e => setTo(e.target.value)} placeholder="Your mobile, e.g. 0412 345 678" aria-label="Test phone number" />
        <Button variant="outline" disabled={busy || running || !to.trim()} onClick={() => void run()}>Send test</Button>
      </div>
      {state && <p className="text-xs" role="status">{state}</p>}
    </div>
  );
}
