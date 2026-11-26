import { useEffect, useState } from 'react';
import { supabase } from '@/pages/admin/lib/supabase';
import { currentTenantSite } from '@/lib/tenantSite';
import { date } from './state';
import type { ServerSecret } from './api';

const usage: Record<string, readonly string[]> = {
  openai: [
    'Assessment workbook import',
    'Student AI Tutor and MCQ practice',
    'Document extraction and staff onboarding',
    'Website assistant and indexing',
    'LMS bulk resource classification',
  ],
  postmark: ['Transactional email delivery', 'Support ticket emails', 'Staff onboarding and document signing emails'],
  geoscape: ['Student application address search', 'Staff onboarding address autocomplete', 'Document signing onboarding address search'],
  training_gov_au: ['Qualification search and course import through the Training.gov.au sandbox SOAP service'],
  cloudflare_turnstile: ['CAPTCHA verification on public staff and careers applications'],
  azure_document_intelligence: ['Document extraction when the document category is routed to Azure'],
};

function OpenAIActivity() {
  const tenantId = currentTenantSite()?.tenantId ?? null;
  const [activity, setActivity] = useState<{ time: string | null } | null>(null);

  useEffect(() => {
    let current = true;
    async function loadActivity() {
      // rule-policy: security integration-usage-metadata Existing tenant policies govern read-only usage timestamps.
      const query = supabase.from('public_assistant_usage_events')
        .select('created_at').eq('kind', 'embedding').order('created_at', { ascending: false }).limit(1);
      const result = await (tenantId ? query.eq('tenant_id', tenantId) : query.is('tenant_id', null)).maybeSingle();
      if (current) setActivity({ time: result.error ? null : result.data?.created_at ?? null });
    }
    void loadActivity();
    return () => { current = false; };
  }, [tenantId]);

  return (
    <div>
      <dt className="text-xs text-foreground-600">Last recorded website embedding</dt>
      <dd>{activity ? (activity.time ? date(activity.time) : 'Unavailable for this organization') : 'Loading…'}</dd>
    </div>
  );
}

/** The website's own build setting a service needs besides its server secrets (public values, read from this build). */
function websiteSettings(providerId: string): ServerSecret[] {
  if (providerId !== 'cloudflare_turnstile') return [];
  const siteKey = ((import.meta.env.VITE_CAPTCHA_SITE_KEY as string | undefined) ?? '').trim();
  return [{ name: 'VITE_CAPTCHA_SITE_KEY', required: true, note: 'Turnstile site key, set in the website hosting (Vercel) environment variables', set: !!siteKey }];
}

function SecretRows({ rows }: { rows: ServerSecret[] }) {
  return (
    <ul className="divide-y divide-background-200 rounded-md border border-background-200">
      {rows.map(row => (
        <li key={row.name} className="flex flex-wrap items-start justify-between gap-2 p-2.5 text-sm">
          <span className="min-w-0 flex-1">
            <code className="break-all font-mono text-xs font-semibold text-foreground-950">{row.name}</code>
            {!row.required && <span className="ms-2 text-xs text-foreground-500">optional</span>}
            <span className="block text-xs text-foreground-600">{row.note}</span>
          </span>
          {row.set
            ? <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-900">Set</span>
            : <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${row.required ? 'bg-amber-100 text-amber-900' : 'bg-background-200 text-foreground-700'}`}>Not set</span>}
        </li>
      ))}
    </ul>
  );
}

export default function ServerManagedPanel({ providerId, isAdmin, secrets }: { providerId: string; isAdmin: boolean; secrets?: ServerSecret[] }) {
  const workflows = Object.hasOwn(usage, providerId) ? usage[providerId] : undefined;
  const site = websiteSettings(providerId);
  const missing = [...(secrets ?? []), ...site].filter(row => row.required && !row.set).length;
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 rounded-md border border-background-200 bg-background-100 p-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-foreground-600">Credential source</dt>
          <dd>Supabase › Edge Functions › Secrets</dd>
        </div>
        {secrets?.length ? <div>
          <dt className="text-xs text-foreground-600">Status</dt>
          <dd>{missing ? `${missing} required setting${missing === 1 ? '' : 's'} missing` : 'Every required setting is set'}</dd>
        </div> : null}
        {providerId === 'openai' && isAdmin && <OpenAIActivity />}
      </dl>
      {isAdmin && (secrets?.length ? (
        <section className="space-y-2" aria-label="Secrets to set">
          <h3 className="font-semibold">Settings to enter at handover</h3>
          <p className="text-sm text-foreground-600">SLIT enters these names and their values in the Supabase project (Edge Functions › Secrets). Only whether each one is set is shown here, never its value.</p>
          <SecretRows rows={secrets} />
          {site.length > 0 && <>
            <p className="text-sm text-foreground-600">And in the website hosting (Vercel › Settings › Environment Variables), then redeploy:</p>
            <SecretRows rows={site} />
          </>}
        </section>
      ) : <p className="text-sm text-foreground-600">The secret check is not available yet (the integrations service has not been updated).</p>)}
      {workflows && <section className="space-y-2" aria-label="Provider usage">
        <h3 className="font-semibold">Used by</h3>
        <ul className="list-disc space-y-1 ps-5 text-foreground-700">
          {workflows.map(workflow => <li key={workflow}>{workflow}</li>)}
        </ul>
      </section>}
    </div>
  );
}
