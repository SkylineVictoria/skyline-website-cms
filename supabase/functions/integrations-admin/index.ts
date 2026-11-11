import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { oauthConfig, stateHash, authorizeUrl, exchange } from '../_shared/integrations/oauth.ts';
import { testProvider } from '../_shared/integrations/provider.ts';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info, x-tenant-domain','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function check(error:unknown){if(error)throw new Error('database_operation_failed');}
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 if(req.method!=='POST')return json({error:'Method not allowed.'},405);
 try{
  const url=Deno.env.get('SUPABASE_URL')??'', key=Deno.env.get('SUPABASE_ANON_KEY')??'', service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'';
  const authorization=req.headers.get('Authorization')??'';
  if(!authorization.startsWith('Bearer '))return json({error:'Sign in required.'},401);
  const caller=createClient(url,key,{global:{headers:{Authorization:authorization,...(req.headers.get('x-tenant-domain')?{'x-tenant-domain':req.headers.get('x-tenant-domain')!}:{})}},auth:{persistSession:false}});
  const {data:user,error:userError}=await caller.auth.getUser();
  if(userError||!user.user)return json({error:'Sign in required.'},401);
  const raw=await req.text();if(raw.length>12000)return json({error:'Request too large.'},413);
  let body:Record<string,unknown>;try{body=JSON.parse(raw);}catch{return json({error:'Invalid JSON.'},400);}
  const tenant=body.tenantId===null?null:typeof body.tenantId==='string'&&uuid.test(body.tenantId)?body.tenantId:undefined;
  if(tenant===undefined)return json({error:'Valid organization scope required.'},400);
  const {data:allowed,error:accessError}=await caller.rpc('integration_can_manage',{p_tenant:tenant});
  if(accessError||allowed!==true)return json({error:'Administrator access required for this organization.'},403);
  const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const action=String(body.action??'');
  if(action==='snapshot'){
   const tables=['integration_definitions','integration_connections','integration_sync_jobs','integration_logs','integration_webhook_events','integration_settings','integration_webhook_registrations'];
   const results=await Promise.all(tables.map(t=>caller.from(t).select('*').limit(100).order(t==='integration_definitions'?'name':t==='integration_settings'?'updated_at':'created_at',{ascending:t==='integration_definitions'})));
   results.forEach(r=>check(r.error));
   return json({definitions:results[0].data,connections:results[1].data,jobs:results[2].data,logs:results[3].data,events:results[4].data,registrations:results[6].data,settings:results[5].data?.[0]??{timeout_seconds:10,max_retries:1,alerts_enabled:true}});
  }
  if(action==='add'){
   const {data:def,error}=await caller.from('integration_definitions').select('id').eq('id',body.connectorId).maybeSingle();check(error);
   if(!def)return json({error:'Unknown connector.'},400);
   const {error:insertError}=await admin.from('integration_connections').insert({tenant_id:tenant,connector_id:def.id});
   if(insertError?.code==='23505')return json({error:'This connection already exists.'},409);check(insertError);return json({ok:true});
  }
  if(action==='settings'){
   const s=body.settings as Record<string,unknown>;
   if(!s||!Number.isInteger(s.timeout_seconds)||Number(s.timeout_seconds)<3||Number(s.timeout_seconds)>30||!Number.isInteger(s.max_retries)||Number(s.max_retries)<0||Number(s.max_retries)>3||typeof s.alerts_enabled!=='boolean')return json({error:'Invalid settings.'},400);
   const {data:old,error}=await caller.from('integration_settings').select('id').maybeSingle();check(error);
   const values={timeout_seconds:s.timeout_seconds,max_retries:s.max_retries,alerts_enabled:s.alerts_enabled,updated_at:new Date().toISOString()};
   const result=old?await admin.from('integration_settings').update(values).eq('id',old.id):await admin.from('integration_settings').insert({...values,tenant_id:tenant});check(result.error);return json({ok:true});
  }
  let connectionId=body.connectionId;
  if(action==='retry'){
   if(typeof body.jobId!=='string'||!uuid.test(body.jobId))return json({error:'Invalid job.'},400);
   const {data:job,error}=await caller.from('integration_sync_jobs').select('*').eq('id',body.jobId).maybeSingle();check(error);
   if(!job||job.status!=='failed'||job.operation!=='connection_test')return json({error:'Job cannot be retried.'},409);
   connectionId=job.connection_id;
  }
  if(typeof connectionId!=='string'||!uuid.test(connectionId))return json({error:'Select a connection.'},400);
  const {data:c,error:ce}=await caller.from('integration_connections').select('*').eq('id',connectionId).maybeSingle();check(ce);
  if(!c||c.tenant_id!==tenant)return json({error:'Connection not found.'},404);
  const correlation=crypto.randomUUID();
  const log=async(code:string,severity='info')=>{const {error}=await admin.from('integration_logs').insert({connection_id:c.id,connector_id:c.connector_id,severity,code,correlation_id:correlation});check(error);};
  if(action==='webhook_register'){
   if(c.connector_id!=='stripe'||c.status!=='connected')return json({error:'Verify a Stripe connection first.'},409);
   const existing=await caller.from('integration_webhook_registrations').select('id').eq('connection_id',c.id).maybeSingle();check(existing.error);
   if(existing.data)return json({error:'A registration already exists. Manage the endpoint in Stripe.'},409);
   const token=await admin.rpc('integration_credential_read',{p_connection:c.id,p_kind:'api_key'});check(token.error);
   if(!token.data)return json({error:'Stripe credential missing.'},409);
   const endpoint=`${url}/functions/v1/integrations-webhook?connection=${c.id}`;
   const events=['invoice.paid','invoice.payment_failed','customer.subscription.updated','customer.subscription.deleted'];
   const payload=new URLSearchParams({url:endpoint});events.forEach(e=>payload.append('enabled_events[]',e));
   const response=await fetch('https://api.stripe.com/v1/webhook_endpoints',{method:'POST',headers:{Authorization:`Bearer ${token.data}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':`crm-webhook-${c.id}`},body:payload,signal:AbortSignal.timeout(15000),redirect:'error'});
   if(!response.ok)return json({error:'Stripe could not register the endpoint. Verify API key permissions and retry.'},409);
   const registration=await response.json();
   if(typeof registration.id!=='string'||typeof registration.secret!=='string')return json({error:'Unexpected provider registration response.'},502);
   const stored=await admin.rpc('integration_credential_write',{p_connection:c.id,p_kind:'webhook_secret',p_secret:registration.secret});check(stored.error);
   const saved=await admin.from('integration_webhook_registrations').insert({connection_id:c.id,provider_id:registration.id,endpoint_url:endpoint,event_types:events});check(saved.error);
   await log('webhook_registered');return json({ok:true});
  }
  if(action==='oauth_start'||action==='oauth_complete'){
   if(c.status==='disabled')return json({error:'Enable the connection first.'},409);
   let config;try{config=oauthConfig(c.connector_id,n=>Deno.env.get(n));}catch{return json({error:'OAuth application registration is missing. Configure the provider client ID, client secret and approved callback URL on the server.'},409);}
   if(action==='oauth_start'){
    const state=crypto.randomUUID()+crypto.randomUUID();
    const r=await admin.rpc('integration_oauth_state',{p_hash:await stateHash(state),p_connection:c.id,p_user:user.user.id,p_consume:false});check(r.error);
    if(!r.data)return json({error:'Connection changed. Reload and retry.'},409);
    return json({url:authorizeUrl(config,state),state});
   }
   if(typeof body.state!=='string'||typeof body.code!=='string'||body.state.length>200||body.code.length>4000)return json({error:'Invalid authorization response.'},400);
   const r=await admin.rpc('integration_oauth_state',{p_hash:await stateHash(body.state),p_connection:c.id,p_user:user.user.id,p_consume:true});check(r.error);
   if(!r.data)return json({error:'Authorization expired, already used, or belongs to a different session. Reconnect.'},409);
   let token;try{token=await exchange(config,body.code);}catch{return json({error:'Provider authorization failed. Start Reconnect again.'},409);}
   const saved=await admin.rpc('integration_credential_write',{p_connection:c.id,p_kind:'api_key',p_secret:JSON.stringify(token),p_version:c.updated_at});check(saved.error);
   await log('oauth_authorized');return json({ok:true});
  }
  if(action==='disable'||action==='enable'){
   const {error}=await admin.from('integration_connections').update({status:action==='disable'?'disabled':'not_connected',updated_at:new Date().toISOString()}).eq('id',c.id);check(error);await log(action==='disable'?'connection_disabled':'connection_enabled');return json({ok:true});
  }
  if(action==='credential'||action==='revoke'){
   if(action==='credential'&&!['stripe','calendly'].includes(c.connector_id))return json({error:'Provider authorization adapter is not configured.'},409);
   const kind=String(body.kind??'api_key'),secret=action==='revoke'?'':String(body.secret??'').trim();
   if(action==='credential'&&(!['api_key','webhook_secret'].includes(kind)||secret.length<20||secret.length>8000||/[\r\n]/.test(secret)))return json({error:'Invalid credential format.'},400);
   if(c.connector_id==='stripe'&&action==='credential'&&!(kind==='webhook_secret'?/^whsec_/.test(secret):/^(sk|rk)_(test|live)_/.test(secret)))return json({error:'Enter a Stripe secret/restricted API key or webhook signing secret.'},400);
   if(c.connector_id==='calendly'){
    if(kind!=='api_key')return json({error:'Unsupported credential type.'},400);
    const r=await caller.rpc('cms_integration_secret_set',{p_provider:'calendly',p_tenant:tenant,p_secret:secret});check(r.error);
    const r2=await admin.from('integration_connections').update({credential_configured:secret!=='',status:c.status==='disabled'?'disabled':'not_connected',updated_at:new Date().toISOString()}).eq('id',c.id);check(r2.error);
   }else{for(const k of action==='revoke'?['api_key','webhook_secret']:[kind]){const {error}=await admin.rpc('integration_credential_write',{p_connection:c.id,p_kind:k,p_secret:secret});check(error);}}
   await log(action==='revoke'?'credentials_revoked':'credential_rotated');return json({ok:true});
  }
  if(action==='test'||action==='retry'){
   if(c.status==='disabled')return json({error:'Enable this connection before testing.'},409);
   const {data:settings,error:se}=await caller.from('integration_settings').select('*').maybeSingle();check(se);
   let secret='';
   if(c.connector_id==='calendly'){
    let q=admin.from('cms_integration_secrets').select('secret').eq('provider','calendly');q=tenant?q.eq('tenant_id',tenant):q.is('tenant_id',null);const r=await q.maybeSingle();check(r.error);secret=r.data?.secret??'';
   }else{const r=await admin.rpc('integration_credential_read',{p_connection:c.id,p_kind:'api_key'});check(r.error);secret=r.data??'';}
   const {data:job,error:je}=await admin.from('integration_sync_jobs').insert({connection_id:c.id,operation:'connection_test',status:'running',correlation_id:correlation}).select('id').single();check(je);
   if(['xero','microsoft365','docusign'].includes(c.connector_id)&&secret){try{const token=JSON.parse(secret);secret=token.expires_at>Date.now()?token.access_token:'';}catch{secret='';}}
   const result=await testProvider(c.connector_id,secret,settings?.timeout_seconds??10,settings?.max_retries??1,fetch,Deno.env.get('EF_DOCUSIGN_ENVIRONMENT')==='production');
   const now=new Date().toISOString();
   const jr=await admin.from('integration_sync_jobs').update({status:result.ok?'succeeded':'failed',completed_at:now,attempts:result.attempts}).eq('id',job!.id);check(jr.error);
   // Fence stale results against credential rotation / disable / concurrent edits.
   const cr=await admin.from('integration_connections').update({status:result.ok?'connected':secret?'error':'not_connected',...(result.ok?{last_success_at:now}:{}),updated_at:now}).eq('id',c.id).eq('updated_at',c.updated_at).neq('status','disabled');check(cr.error);
   await log(result.code,result.ok?'info':'error');
   const messages:Record<string,string>={credentials_missing:'No credential configured. Save a credential first.',credentials_rejected:'Provider rejected the credential. Check its permissions or rotate it.',adapter_not_available:'This provider requires its approved authorization adapter before testing.',provider_unavailable:'Provider is temporarily unavailable. Retry later.',provider_unreachable:'Provider could not be reached within the timeout.'};
   return result.ok?json({ok:true}):json({error:messages[result.code]??'Connection test failed.',correlationId:correlation},409);
  }
  return json({error:'Unknown action.'},400);
 }catch{return json({error:'Integration operation could not be completed. Check backend configuration and retry.'},500);}
});
