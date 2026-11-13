// integrations-refresh: keeps OAuth connections alive. Called by pg_cron (integration-token-refresh ->
// public.integration_refresh_dispatch -> pg_net, Bearer = service-role token from Vault). verify_jwt = true: the gateway
// verifies the token; serviceRoleStatus then requires role service_role for this project. For each enabled OAuth
// connection with a stored token, accessToken() renews it when the access token has expired, rotating the refresh token
// so idle connections do not lapse. A revoked/expired grant marks the connection 'error' (Reconnect needed).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { oauthProviders } from '../_shared/integrations/oauth.ts';
import { accessToken } from '../_shared/integrations/credentials.ts';
import { serviceRoleStatus } from '../_shared/service-role.ts';
const json=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
Deno.serve(async(req:Request)=>{
 if(req.method!=='POST')return json({error:'Method not allowed.'},405);
 const url=Deno.env.get('SUPABASE_URL')??'',service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'';
 const status=serviceRoleStatus(req.headers.get('Authorization'),url);
 if(status!==200)return json({error:'Worker access only.'},status);
 if(!url||!service)return json({error:'The function is not configured.'},503);
 const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data,error}=await admin.from('integration_connections').select('id,connector_id,updated_at,status').in('connector_id',oauthProviders.filter(p=>p!=='stripe')).neq('status','disabled').limit(500);
 if(error)return json({error:'database_operation_failed'},500);
 let renewed=0,unchanged=0,failed=0;
 for(const c of data??[]){
  const correlation=crypto.randomUUID();
  try{
   const r=await accessToken(c,(n,a)=>admin.rpc(n,a),n=>Deno.env.get(n));
   if(r.token&&r.version!==c.updated_at){renewed++;await admin.from('integration_logs').insert({connection_id:c.id,connector_id:c.connector_id,severity:'info',code:'token_renewed',correlation_id:correlation});}
   else unchanged++;
  }catch(e){
   failed++;
   const code=e instanceof Error?e.message:'';
   if(code==='oauth_reconnect_required')await admin.from('integration_connections').update({status:'error',updated_at:new Date().toISOString()}).eq('id',c.id).eq('updated_at',c.updated_at).neq('status','disabled');
   await admin.from('integration_logs').insert({connection_id:c.id,connector_id:c.connector_id,severity:code==='oauth_refresh_busy'?'warn':'error',code:code==='oauth_reconnect_required'?'reconnect_required':code==='oauth_refresh_busy'?'refresh_busy':'credential_refresh_failed',correlation_id:correlation});
  }
 }
 return json({ok:true,checked:(data??[]).length,renewed,unchanged,failed});
});
