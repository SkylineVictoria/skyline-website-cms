import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { pkceChallenge, oauthCallback, oauthConfig, oauthProviders, readOAuthCredential, stateHash, authorizeUrl, exchange, revokeAtProvider } from '../_shared/integrations/oauth.ts';
import { accessToken } from '../_shared/integrations/credentials.ts';
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
  if(accessError)return json({error:'Integration database setup is not complete.'},503);
  const isAdmin=allowed===true;
  const moduleAccess=await caller.rpc('integration_module_access');
  if(moduleAccess.error||moduleAccess.data!==true)return json({error:'Integration access is not granted for this organization.'},403);
  const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const action=String(body.action??'');
  if(!isAdmin&&!['snapshot','test','retry','event_recheck'].includes(action))return json({error:'Administrator access required.'},403);
  if(action==='snapshot'){
   const tables=['integration_definitions','integration_connections','integration_sync_jobs','integration_logs','integration_webhook_events','integration_settings','integration_webhook_registrations','integration_permissions','integration_event_attempts'];
   const results=await Promise.all(tables.map(t=>caller.from(t).select('*').limit(100).order(t==='integration_definitions'?'name':t==='integration_settings'?'updated_at':'created_at',{ascending:t==='integration_definitions'})));
   results.forEach(r=>check(r.error));
   const eligible=isAdmin?await caller.rpc('integration_eligible_users',{p_tenant:tenant}):{data:[],error:null};check(eligible.error);
   const connections=await Promise.all((results[1].data??[]).map(async(c)=>({...c,can_operate:isAdmin||(await caller.rpc('integration_access',{p_connection:c.id,p_operate:true})).data===true})));
   return json({isAdmin,eligibleUsers:eligible.data,permissions:results[7].data,eventAttempts:results[8].data,definitions:results[0].data,connections,jobs:results[2].data,logs:results[3].data,events:results[4].data,registrations:results[6].data,settings:results[5].data?.[0]??{timeout_seconds:10,max_retries:1,alerts_enabled:true}});
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
  let selectedEvent: {id:string;connection_id:string;provider_event_id:string;event_type:string}|null=null;
  if(action==='event_recheck'){
   if(typeof body.eventId!=='string'||!uuid.test(body.eventId))return json({error:'Invalid event.'},400);
   const r=await caller.from('integration_webhook_events').select('id,connection_id,provider_event_id,event_type').eq('id',body.eventId).maybeSingle();check(r.error);selectedEvent=r.data;
   if(!selectedEvent)return json({error:'Event not found.'},404);connectionId=selectedEvent.connection_id;
  }
  if(action==='retry'){
   if(typeof body.jobId!=='string'||!uuid.test(body.jobId))return json({error:'Invalid job.'},400);
   const {data:job,error}=await caller.from('integration_sync_jobs').select('*').eq('id',body.jobId).maybeSingle();check(error);
   if(!job||job.status!=='failed'||job.operation!=='connection_test')return json({error:'Job cannot be retried.'},409);
   connectionId=job.connection_id;
  }
  if(typeof connectionId!=='string'||!uuid.test(connectionId))return json({error:'Select a connection.'},400);
  const {data:c,error:ce}=await caller.from('integration_connections').select('*').eq('id',connectionId).maybeSingle();check(ce);
  if(!c||c.tenant_id!==tenant)return json({error:'Connection not found.'},404);
  if(!isAdmin){const a=await caller.rpc('integration_access',{p_connection:c.id,p_operate:true});if(a.error||a.data!==true)return json({error:'Operator permission required.'},403);}
  const correlation=crypto.randomUUID();
  const log=async(code:string,severity='info')=>{const {error}=await admin.from('integration_logs').insert({connection_id:c.id,connector_id:c.connector_id,severity,code,correlation_id:correlation});check(error);};
  if(action==='permission'){
   if(typeof body.userId!=='string'||!uuid.test(body.userId)||!['viewer','operator','revoke'].includes(String(body.role)))return json({error:'Select an eligible user and permission.'},400);
   const r=await caller.rpc('integration_permission_set',{p_connection:c.id,p_user:body.userId,p_role:body.role});
   if(r.error)return json({error:'Permission could not be saved. The user must be an active member of this organization.'},409);return json({ok:true});
  }
  if(action==='event_recheck'&&selectedEvent){
   if(c.connector_id!=='stripe'||c.status==='disabled')return json({error:'Enable the Stripe connection first.'},409);
   const stored=await accessToken(c,(name,args)=>admin.rpc(name,args),n=>Deno.env.get(n));
   if(!stored.token)return json({error:'Save and test a Stripe API credential first.'},409);
   let ok=false,code='provider_unreachable';
   try{
    const response=await fetch('https://api.stripe.com/v1/events/'+encodeURIComponent(selectedEvent.provider_event_id),{headers:{Authorization:`Bearer ${stored.token}`,...(stored.stripeAccount?{'Stripe-Account':stored.stripeAccount}:{})},signal:AbortSignal.timeout(10000),redirect:'error'});
    code=response.status===404?'event_not_available':response.ok?'event_verified':'provider_rejected';
    if(response.ok){const event=await response.json();ok=event.id===selectedEvent.provider_event_id&&event.type===selectedEvent.event_type;if(!ok)code='event_mismatch';}else{await response.body?.cancel();}
   }catch{/* persist a safe failure code */}
   const r=await admin.rpc('integration_event_recheck',{p_event:selectedEvent.id,p_ok:ok,p_code:code,p_correlation:correlation});check(r.error);await log(code,ok?'info':'error');
   return ok?json({ok:true}):json({error:'The provider event could not be verified. Check credentials or provider event retention, then retry.'},409);
  }
  if(action==='webhook_register'){
   if(c.connector_id!=='stripe'||c.status!=='connected')return json({error:'Verify a Stripe connection first.'},409);
   const existing=await caller.from('integration_webhook_registrations').select('id').eq('connection_id',c.id).maybeSingle();check(existing.error);
   if(existing.data)return json({error:'A registration already exists. Manage the endpoint in Stripe.'},409);
   const token=await accessToken(c,(name,args)=>admin.rpc(name,args),n=>Deno.env.get(n));
   if(token.stripeAccount)return json({error:'This Stripe sign-in grants read-only access. Use a restricted API key with webhook permissions to register webhooks.'},409);
   if(!token.token)return json({error:'Stripe credential missing.'},409);
   const endpoint=`${url}/functions/v1/integrations-webhook?connection=${c.id}`;
   const events=['invoice.paid','invoice.payment_failed','customer.subscription.updated','customer.subscription.deleted'];
   const payload=new URLSearchParams({url:endpoint});events.forEach(e=>payload.append('enabled_events[]',e));
   const response=await fetch('https://api.stripe.com/v1/webhook_endpoints',{method:'POST',headers:{Authorization:`Bearer ${token.token}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':`crm-webhook-${c.id}`},body:payload,signal:AbortSignal.timeout(15000),redirect:'error'});
   if(!response.ok)return json({error:'Stripe could not register the endpoint. Verify API key permissions and retry.'},409);
   const registration=await response.json();
   if(typeof registration.id!=='string'||typeof registration.secret!=='string')return json({error:'Unexpected provider registration response.'},502);
   const stored=await admin.rpc('integration_credential_write',{p_connection:c.id,p_kind:'webhook_secret',p_secret:registration.secret});check(stored.error);
   const saved=await admin.from('integration_webhook_registrations').insert({connection_id:c.id,provider_id:registration.id,endpoint_url:endpoint,event_types:events});check(saved.error);
   await log('webhook_registered');return json({ok:true});
  }
  if(['oauth_setup','oauth_app_save','oauth_start','oauth_complete'].includes(action)){
   if(!oauthProviders.includes(c.connector_id))return json({error:'This application does not use sign-in authorization.'},400);
   const env=(name:string)=>Deno.env.get(name);
   const callbackUrl=oauthCallback(env);
   // Skyline is registered once per provider; app credentials come only from Edge Function secrets.
   if(action==='oauth_app_save')return json({error:'App credentials are managed by Skyline. Click Connect to sign in with your account.'},410);
   const {token:existingToken}=await readOAuthCredential(c.id,(name,args)=>admin.rpc(name,args));
   let config;
   try{config=oauthConfig(c.connector_id,env);}catch{/* Report missing platform app registration below. */}
   if(action==='oauth_setup')return json({callbackUrl,configured:!!config,authorized:!!existingToken,environment:env('EF_DOCUSIGN_ENVIRONMENT')==='production'?'production':'demo'});
   if(c.status==='disabled')return json({error:'Enable the connection first.'},409);
   if(!config)return json({error:'Skyline is not yet registered with this provider. Ask the platform administrator to add the app registration.'},409);
   if(action==='oauth_start'){
    if(req.headers.get('origin') && req.headers.get('origin')!==new URL(callbackUrl).origin){
     return json({error:'Open the CRM at the domain shown in the redirect URL to sign in.'},409);
    }
    const verifier=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
    const state=crypto.randomUUID()+'.'+await stateHash(verifier);
    const r=await admin.rpc('integration_oauth_state',{p_hash:await stateHash(state),p_connection:c.id,p_user:user.user.id,p_consume:false});check(r.error);
    const latest=await caller.from('integration_connections').select('updated_at').eq('id',c.id).maybeSingle();check(latest.error);
    if(!r.data||latest.data?.updated_at!==c.updated_at)return json({error:'Connection changed. Reload and retry.'},409);
    return json({url:authorizeUrl(config,state,await pkceChallenge(verifier)),state,verifier});
   }
   if(typeof body.state!=='string'||typeof body.code!=='string'||body.state.length>200||body.code.length>4000)return json({error:'Invalid authorization response.'},400);
   if(c.connector_id==='calendly' && (typeof body.verifier!=='string'||!/^[a-zA-Z0-9_-]{43,128}$/.test(body.verifier)||!body.state.endsWith('.'+await stateHash(body.verifier))))return json({error:'Sign-in session could not be verified. Reconnect.'},409);
   const r=await admin.rpc('integration_oauth_state',{p_hash:await stateHash(body.state),p_connection:c.id,p_user:user.user.id,p_consume:true});check(r.error);
   if(!r.data)return json({error:'Authorization expired, already used, or belongs to a different session. Reconnect.'},409);
   let token;try{token=await exchange(config,body.code,typeof body.verifier==='string'?body.verifier:undefined);}catch{return json({error:'Provider authorization failed. Start Reconnect again.'},409);}
   const saved=await admin.rpc('integration_credential_write',{p_connection:c.id,p_kind:'api_key',p_secret:JSON.stringify({version:1,token}),p_version:c.updated_at});check(saved.error);
   await log('oauth_authorized');return json({ok:true});
  }
  if(action==='disable'||action==='enable'){
   const {error}=await admin.from('integration_connections').update({status:action==='disable'?'disabled':'not_connected',updated_at:new Date().toISOString()}).eq('id',c.id);check(error);await log(action==='disable'?'connection_disabled':'connection_enabled');return json({ok:true});
  }
  if(action==='credential'||action==='revoke'){
   if(action==='credential'&&c.connector_id!=='stripe')return json({error:'Use Connect to sign in to this provider.'},409);
   const kind=String(body.kind??'api_key'),secret=action==='revoke'?'':String(body.secret??'').trim();
   if(action==='credential'&&(!['api_key','webhook_secret'].includes(kind)||secret.length<20||secret.length>8000||/[\r\n]/.test(secret)))return json({error:'Invalid credential format.'},400);
   if(c.connector_id==='stripe'&&action==='credential'&&!(kind==='webhook_secret'?/^whsec_/.test(secret):/^(sk|rk)_(test|live)_/.test(secret)))return json({error:'Enter a Stripe secret/restricted API key or webhook signing secret.'},400);
   // Disconnect: revoke Skyline's access at the provider first (best effort), then delete the stored token.
   let revokeCode='';
   if(action==='revoke'&&oauthProviders.includes(c.connector_id)){
    try{
     const {token:t}=await readOAuthCredential(c.id,(name,args)=>admin.rpc(name,args));
     if(t)revokeCode=await revokeAtProvider(oauthConfig(c.connector_id,n=>Deno.env.get(n)),t);
    }catch{revokeCode='revoke_failed';}
   }
   if(c.connector_id==='calendly'){
    const r=await caller.rpc('cms_integration_secret_set',{p_provider:'calendly',p_tenant:tenant,p_secret:''});check(r.error);
    const cleared=await admin.rpc('integration_credential_write',{p_connection:c.id,p_kind:'api_key',p_secret:''});check(cleared.error);
   }else{for(const k of action==='revoke'?['api_key','webhook_secret']:[kind]){const {error}=await admin.rpc('integration_credential_write',{p_connection:c.id,p_kind:k,p_secret:secret});check(error);}}
   if(action==='revoke'){
    const r2=await admin.from('integration_connections').update({credential_configured:false,status:c.status==='disabled'?'disabled':'not_connected',updated_at:new Date().toISOString()}).eq('id',c.id);check(r2.error);
    if(revokeCode)await log(revokeCode,revokeCode==='revoke_failed'?'warn':'info');
   }
   await log(action==='revoke'?'credentials_revoked':'credential_rotated');
   if(action==='revoke'&&revokeCode==='revoke_not_supported')return json({ok:true,providerRevoked:false,message:'Disconnected in Skyline. This provider has no revoke API: remove Skyline from the account\'s connected apps there if required.'});
   if(action==='revoke'&&revokeCode==='revoke_failed')return json({ok:true,providerRevoked:false,message:'Disconnected in Skyline, but the provider did not confirm revocation. Remove Skyline from the account\'s connected apps there.'});
   return json({ok:true,...(action==='revoke'?{providerRevoked:revokeCode==='revoked'}:{})});
  }
  if(action==='test'||action==='retry'){
   if(c.status==='disabled')return json({error:'Enable this connection before testing.'},409);
   const {data:settings,error:se}=await caller.from('integration_settings').select('*').maybeSingle();check(se);
   let secret='';
   let docusignProduction=false;
   let stripeAccount:string|undefined;
   const calendlyOAuth=c.connector_id==='calendly' ? await readOAuthCredential(c.id,(name,args)=>admin.rpc(name,args)) : undefined;
   if(c.connector_id==='calendly'&&!calendlyOAuth?.token){
    let q=admin.from('cms_integration_secrets').select('secret').eq('provider','calendly');q=tenant?q.eq('tenant_id',tenant):q.is('tenant_id',null);const r=await q.maybeSingle();check(r.error);secret=r.data?.secret??'';
   }else{
    try{const credential=await accessToken(c,(name,args)=>admin.rpc(name,args),n=>Deno.env.get(n));secret=credential.token;c.updated_at=credential.version;docusignProduction=credential.docusignProduction??false;stripeAccount=credential.stripeAccount;}
    catch(e){const code=e instanceof Error?e.message:'';await log('credential_refresh_failed','error');return json({error:code==='oauth_reconnect_required'?'Provider authorization expired or was revoked. Use Reconnect.':code==='oauth_refresh_busy'?'Another authorization refresh is running. Retry shortly.':'Authorization could not be renewed. Check OAuth app settings or reconnect.'},409);}
   }
   const {data:job,error:je}=await admin.from('integration_sync_jobs').insert({connection_id:c.id,operation:'connection_test',status:'running',correlation_id:correlation}).select('id').single();check(je);
   const result=await testProvider(c.connector_id,secret,settings?.timeout_seconds??10,settings?.max_retries??1,fetch,docusignProduction,stripeAccount);
   const now=new Date().toISOString();
   const jr=await admin.from('integration_sync_jobs').update({status:result.ok?'succeeded':'failed',completed_at:now,attempts:result.attempts}).eq('id',job!.id);check(jr.error);
   // Fence stale results against credential rotation / disable / concurrent edits.
   const cr=await admin.from('integration_connections').update({status:result.ok?'connected':secret?'error':'not_connected',...(result.ok?{last_success_at:now}:{}),updated_at:now}).eq('id',c.id).eq('updated_at',c.updated_at).neq('status','disabled');check(cr.error);
   await log(result.code,result.ok?'info':'error');
   const messages:Record<string,string>={credentials_missing:'Not connected yet. Click Connect to sign in.',credentials_rejected:'Provider rejected the authorization. Use Reconnect.',adapter_not_available:'This provider requires its approved authorization adapter before testing.',provider_unavailable:'Provider is temporarily unavailable. Retry later.',provider_unreachable:'Provider could not be reached within the timeout.'};
   return result.ok?json({ok:true}):json({error:messages[result.code]??'Connection test failed.',correlationId:correlation},409);
  }
  return json({error:'Unknown action.'},400);
 }catch{return json({error:'Integration operation could not be completed. Check backend configuration and retry.'},500);}
});
