import PermissionsForm from './PermissionsForm';
import { useState } from 'react';
import { Button, Card } from '@/pages/admin/components/ui';
import type { Settings } from './api';
import type { IntegrationState } from './shared';
import { inputClass } from './state';
// rule-policy: security integration-settings-input Reuses the existing server-validated settings fields and bounds.
function SettingsForm({ initial, state }: { initial: Settings; state: IntegrationState }) { const [settings,setSettings]=useState(initial);return <form className="space-y-4" onSubmit={e=>{e.preventDefault();void state.run('settings',{settings},'Settings saved.');}}><label className="block">Connection timeout (seconds)<input className={inputClass} type="number" min={3} max={30} required value={settings.timeout_seconds} onChange={e=>setSettings({...settings,timeout_seconds:Number(e.target.value)})}/></label><label className="block">Maximum retries for transient errors<input className={inputClass} type="number" min={0} max={3} required value={settings.max_retries} onChange={e=>setSettings({...settings,max_retries:Number(e.target.value)})}/></label><label className="flex gap-2"><input type="checkbox" checked={settings.alerts_enabled} onChange={e=>setSettings({...settings,alerts_enabled:e.target.checked})}/>Show error alerts in the integration overview</label><p>These preferences apply to connection operations. Error alerts appear in the overview; operational logs remain available when alerts are off.</p><Button disabled={state.busy}>Save settings</Button></form>; }
export default function SettingsPage({ state }: { state: IntegrationState }) {
  return state.data && <Card className="space-y-4 p-4">
    <SettingsForm initial={state.data.settings} state={state} />
    <PermissionsForm state={state} />
  </Card>;
}
