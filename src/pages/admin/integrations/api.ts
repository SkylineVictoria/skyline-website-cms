import { supabase } from '@/pages/admin/lib/supabase';
import { currentTenantSite } from '@/lib/tenantSite';
export type Definition = { id: string; name: string; auth_type: string; availability: string; description: string };
export type Connection = { id: string; connector_id: string; status: string; last_success_at: string | null; updated_at: string; credential_configured: boolean; webhook_configured: boolean; can_operate: boolean };
export type Job = { id: string; connection_id: string; status: string; created_at: string; completed_at: string | null; success_count: number; failure_count: number; attempts: number; operation: string; correlation_id: string };
export type Log = { id: string; connector_id: string; severity: string; code: string; created_at: string; correlation_id: string };
export type Event = { id: string; connection_id: string; event_type: string; provider_event_id: string; status: string; attempts: number; retry_count: number; verified_at: string|null; created_at: string };
export type Settings = { timeout_seconds: number; max_retries: number; alerts_enabled: boolean };
export type Snapshot = { isAdmin: boolean; eligibleUsers: {id:string;label:string}[]; permissions: {connection_id:string;user_id:string;role:string}[]; eventAttempts: {id:string;event_id:string;status:string;code:string;created_at:string;correlation_id:string}[]; definitions: Definition[]; connections: Connection[]; jobs: Job[]; logs: Log[]; events: Event[]; registrations: { id:string; connection_id:string; provider_id:string; endpoint_url:string; event_types:string[] }[]; settings: Settings };
export async function integrationRequest<T>(action: string, values: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke('integrations-admin', { body: { ...values, action, tenantId: currentTenantSite()?.tenantId ?? null } });
  if (error) {
    let message = error.message;
    if (error.context instanceof Response) { try { message = (await error.context.clone().json()).error || message; } catch { /* preserve transport error */ } }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data as T;
}

/** Access details for USI / VEVO / PRISMS / DataZoo, stored ahead of their connectors (integrations-credentials). Values never come back. */
export type PendingCredentialFields = { apiKey: string; accountId: string; organisationCode: string; environment: 'test' | 'production' };
export async function pendingCredentialRequest(action: 'save' | 'clear', connectionId: string, fields?: PendingCredentialFields): Promise<void> {
  const { data, error } = await supabase.functions.invoke('integrations-credentials', { body: { action, connectionId, fields, tenantId: currentTenantSite()?.tenantId ?? null } });
  if (error) {
    let message = error.message;
    if (error.context instanceof Response) { try { message = (await error.context.clone().json()).error || message; } catch { /* preserve transport error */ } }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
}
