import { useEffect, useState } from 'react';
import { supabase } from '@/pages/admin/lib/supabase';
import { currentTenantSite } from '@/lib/tenantSite';
import { date } from './state';

export default function OpenAIEnvironmentPanel({ isAdmin }: { isAdmin: boolean }) {
  const tenantId = currentTenantSite()?.tenantId ?? null;
  const [activity, setActivity] = useState<{ time: string | null } | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
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
  }, [isAdmin, tenantId]);

  return (
    <div className="space-y-4">
      <dl className="grid gap-3 rounded-md border border-background-200 bg-background-100 p-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-foreground-600">Credential source</dt>
          <dd>Existing server configuration</dd>
        </div>
        {isAdmin && (
          <div>
            <dt className="text-xs text-foreground-600">Last recorded website embedding</dt>
            <dd>{activity ? (activity.time ? date(activity.time) : 'Unavailable for this organization') : 'Loading…'}</dd>
          </div>
        )}
      </dl>
      <section className="space-y-2" aria-label="OpenAI usage">
        <h3 className="font-semibold">Used by</h3>
        <ul className="list-disc space-y-1 ps-5 text-foreground-700">
          <li>Assessment workbook import</li>
          <li>Student AI Tutor and MCQ practice</li>
          <li>Document extraction and staff onboarding</li>
          <li>Website assistant and indexing</li>
          <li>LMS bulk resource classification</li>
        </ul>
      </section>
    </div>
  );
}
