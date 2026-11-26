import { useEffect, useState } from 'react';
import { supabase } from '@/pages/admin/lib/supabase';
import { currentTenantSite } from '@/lib/tenantSite';
import { date } from './state';

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

export default function ServerManagedPanel({ providerId, isAdmin }: { providerId: string; isAdmin: boolean }) {
  const workflows = Object.hasOwn(usage, providerId) ? usage[providerId] : undefined;
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 rounded-md border border-background-200 bg-background-100 p-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-foreground-600">Credential source</dt>
          <dd>Existing server configuration</dd>
        </div>
        {providerId === 'openai' && isAdmin && <OpenAIActivity />}
      </dl>
      {workflows && <section className="space-y-2" aria-label="Provider usage">
        <h3 className="font-semibold">Used by</h3>
        <ul className="list-disc space-y-1 ps-5 text-foreground-700">
          {workflows.map(workflow => <li key={workflow}>{workflow}</li>)}
        </ul>
      </section>}
    </div>
  );
}
