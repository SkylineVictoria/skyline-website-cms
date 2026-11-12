// integrations-credentials: stores access details for the Australian education apps (USI, VEVO, PRISMS, DataZoo) ahead of
// their connectors, so an administrator can paste them the day the provider issues them. Actions: save, clear.
// verify_jwt = true; the same checks as integrations-admin (integration_can_manage, integration_module_access, the connection
// must belong to the caller's organization scope). The values go to Vault through integration_credential_write as one JSON
// document ({version:1,fields:{...}}) and are never returned or logged. Nothing is sent to any provider from here.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info, x-tenant-domain','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const providers=['usi','vevo','prisms','datazoo'];
const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length<=max?v.trim():null;
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 if(req.method!=='POST')return json({error:'Method not allowed.'},405);
 try{
  const url=Deno.env.get('SUPABASE_URL')??'',key=Deno.env.get('SUPABASE_ANON_KEY')??'',service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'';
  const authorization=req.headers.get('Authorization')??'';
  if(!authorization.startsWith('Bearer '))return json({error:'Sign in required.'},401);
  const caller=createClient(url,key,{global:{headers:{Authorization:authorization,...(req.headers.get('x-tenant-domain')?{'x-tenant-domain':req.headers.get('x-tenant-domain')!}:{})}},auth:{persistSession:false}});
  const {data:user,error:userError}=await caller.auth.getUser();
  if(userError||!user.user)return json({error:'Sign in required.'},401);
  const raw=await req.text();if(raw.length>12000)return json({error:'Request too large.'},413);
  let body:Record<string,unknown>;try{body=JSON.parse(raw);}catch{return json({error:'Invalid JSON.'},400);}
  const tenant=body.tenantId===null?null:typeof body.tenantId==='string'&&uuid.test(body.tenantId)?body.tenantId:undefined;
  if(tenant===undefined)return json({error:'Valid organization scope required.'},400);
  const allowed=await caller.rpc('integration_can_manage',{p_tenant:tenant});
  if(allowed.error)return json({error:'Integration database setup is not complete.'},503);
  if(allowed.data!==true)return json({error:'Administrator access required.'},403);
  const moduleAccess=await caller.rpc('integration_module_access');
  if(moduleAccess.error||moduleAccess.data!==true)return json({error:'Integration access is not granted for this organization.'},403);
  const action=String(body.action??'');
  if(action!=='save'&&action!=='clear')return json({error:'Unknown action.'},400);
  if(typeof body.connectionId!=='string'||!uuid.test(body.connectionId))return json({error:'Select a connection.'},400);
  const {data:c,error:ce}=await caller.from('integration_connections').select('id,tenant_id,connector_id,status').eq('id',body.connectionId).maybeSingle();
  if(ce)return json({error:'Connection could not be loaded.'},500);
  if(!c||c.tenant_id!==tenant)return json({error:'Connection not found.'},404);
  if(!providers.includes(c.connector_id))return json({error:'This application is connected from its own setup screen.'},400);
  if(c.status==='disabled')return json({error:'Enable the connection first.'},409);
  let secret='';
  if(action==='save'){
   const f=(body.fields??{}) as Record<string,unknown>;
   const apiKey=text(f.apiKey,6000),accountId=text(f.accountId,300),organisationCode=text(f.organisationCode,100);
   const environment=f.environment==='production'?'production':'test';
   if(!apiKey||apiKey.length<8||accountId===null||organisationCode===null)return json({error:'Enter the API key or secret (at least 8 characters). The other fields are optional.'},400);
   secret=JSON.stringify({version:1,fields:{apiKey,accountId,organisationCode,environment}});
   if(secret.length>8000)return json({error:'These details are too long to store.'},400);
  }
  const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const saved=await admin.rpc('integration_credential_write',{p_connection:c.id,p_kind:'api_key',p_secret:secret});
  if(saved.error)return json({error:'The details could not be saved. Reload and try again.'},409);
  await admin.from('integration_logs').insert({connection_id:c.id,connector_id:c.connector_id,severity:'info',code:action==='save'?'credential_rotated':'credentials_revoked',correlation_id:crypto.randomUUID()});
  return json({ok:true,saved:action==='save'});
 }catch{return json({error:'The request could not be completed. Retry.'},500);}
});
