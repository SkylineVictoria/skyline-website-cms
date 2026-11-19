// student-office365: Office 365 accounts for SLIT people, on an administrator's request (SLIT administrators only: admin_business_require
// inside every RPC). Despite the name it serves students and staff since 2026-11-20.
// Actions:
//   state { studentId }                      -> the student page's account status
//   create { studentId }                     -> the student page's create / retry (kind student)
//   m365_status {}                           -> the one Microsoft 365 status (Email Management and Connections; read-only Graph calls)
//   people { personType, q }                 -> Create Email "Existing person" list (email_mgmt_people)
//   lookup { personType, personId }          -> existing Microsoft 365 accounts for the person, the address, the licence and its free seats
//   create { personType, personId, dryRun?, differentPerson? } -> create (or with dryRun: every check, nothing written or created)
//   link { personType, personId, msUserId }  -> link an existing Microsoft 365 account to the record (o365_link)
//   resend { personType, personId, dryRun? } -> new temporary password + login email for an account already created (never a second account)
//   groups {}                                -> the tenant's groups (for the owner to map to person types)
// Person types: student -> EF_MICROSOFT365_STUDENT_DOMAIN + STANDARDWOFFPACK_STUDENT; employee / trainer / agent -> slit.edu.au +
// STANDARDWOFFPACK_FACULTY (owner 2026-11-20; EF_MICROSOFT365_STAFF_DOMAIN / _STAFF_SKU override).
// The flow lives in _shared/office365-provision.ts (tested offline). The temporary password is never stored or returned.
// Secrets: EF_MICROSOFT365_CLIENT_ID, _CLIENT_SECRET, _TENANT_ID, _STUDENT_DOMAIN, _WELCOME_SENDER; optional _STUDENT_SKU, _STAFF_DOMAIN,
// _STAFF_SKU, _USAGE_LOCATION (default AU). App permissions (Application, admin consent): User.ReadWrite.All, LicenseAssignment.ReadWrite.All,
// Organization.Read.All, Domain.Read.All, Mail.Send.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { microsoft365Status } from '../_shared/microsoft365.ts';
import { KINDS, LICENCE_RULE_IDS, link, listGroups, lookup, MESSAGES, provision, resend, type PersonKind, type Ports } from '../_shared/office365-provision.ts';
import { loadRules } from '../_shared/business-rules.ts';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info, x-tenant-domain','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const env=(n:string)=>(Deno.env.get(n)??'').trim();
const domainRe=/^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const emailRe=/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
function configured(){return !!(env('EF_MICROSOFT365_CLIENT_ID')&&env('EF_MICROSOFT365_CLIENT_SECRET')&&env('EF_MICROSOFT365_TENANT_ID')&&domainRe.test(env('EF_MICROSOFT365_STUDENT_DOMAIN').toLowerCase())&&emailRe.test(env('EF_MICROSOFT365_WELCOME_SENDER')));}
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 if(req.method!=='POST')return json({error:'Method not allowed.'},405);
 try{
  const url=env('SUPABASE_URL'),anon=env('SUPABASE_ANON_KEY');
  const authorization=req.headers.get('Authorization')??'';
  if(!authorization.startsWith('Bearer '))return json({error:'Sign in required.'},401);
  const caller=createClient(url,anon,{global:{headers:{Authorization:authorization,...(req.headers.get('x-tenant-domain')?{'x-tenant-domain':req.headers.get('x-tenant-domain')!}:{})}},auth:{persistSession:false,autoRefreshToken:false}});
  const {data:user,error:userError}=await caller.auth.getUser();
  if(userError||!user.user)return json({error:'Sign in required.'},401);
  const raw=await req.text();if(raw.length>2000)return json({error:'Request too large.'},413);
  let body:Record<string,unknown>;try{body=JSON.parse(raw);}catch{return json({error:'Invalid JSON.'},400);}
  const action=String(body.action??'');
  // Business Rules: the licence used when EF_MICROSOFT365_*_SKU is not set (office365.*_license_fallback).
  const ports:Ports={env:(n)=>Deno.env.get(n),fetch,rpc:(name,args)=>caller.rpc(name,args),rules:await loadRules(caller,LICENCE_RULE_IDS)};
  if(action==='m365_status'||action==='people'||action==='groups'){
   const gate=await caller.rpc('admin_business_require');
   if(gate.error)return json({error:gate.error.code==='42501'?'Administrator access required.':'Access could not be checked.'},gate.error.code==='42501'?403:500);
   if(action==='groups'){const g=await listGroups(ports);return json(g.body,g.status);}
   if(action==='people'){
    const r=await caller.rpc('email_mgmt_people',{p_type:String(body.personType??''),p_query:String(body.q??'').slice(0,80)});
    if(r.error)return json({error:r.error.code==='22023'?r.error.message:'The people could not be loaded.'},r.error.code==='22023'?400:500);
    return json({people:r.data??[]});
   }
   const s=await microsoft365Status((n)=>Deno.env.get(n));
   // One status for both screens: the Connections page's Microsoft 365 entry is set from this same check.
   const service=createClient(url,env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
   const now=new Date().toISOString();
   await service.from('integration_connections').update({status:s.ready?'connected':s.configured?'error':'not_connected',...(s.ready?{last_success_at:now}:{}),updated_at:now})
    .eq('connector_id','microsoft365').is('tenant_id',null).neq('status','disabled');
   return json(s);
  }
  // The student page (studentId) or Create Email (personType + personId).
  const kind=(body.studentId!==undefined?'student':String(body.personType??'')) as PersonKind;
  const personId=String(body.studentId??body.personId??'');
  if(!['state','create','lookup','link','resend'].includes(action))return json({error:'Unknown action.'},400);
  if(!KINDS.includes(kind))return json({error:'Choose Student, Employee, Trainer or Agent.'},400);
  if(!uuid.test(personId))return json({error:'Choose a person.'},400);
  if(action==='state'){
   if(kind!=='student')return json({error:'Unknown action.'},400);
   const prep=await caller.rpc('student_o365_prepare',{p_student:personId});
   if(prep.error)return json({error:prep.error.code==='42501'?'Administrator access required.':prep.error.code==='P0002'?'Student not found.':'Student could not be loaded.'},prep.error.code==='42501'?403:prep.error.code==='P0002'?404:500);
   const p=prep.data as {account:null|{email:string;status:string;lastError:string|null;welcomeSentAt:string|null;hasMicrosoftUser:boolean}};
   return json({configured:configured(),account:p.account?{...p.account,message:p.account.lastError?MESSAGES[p.account.lastError]??null:null}:null});
  }
  const r=action==='lookup'?await lookup(ports,kind,personId)
   :action==='resend'?await resend(ports,kind,personId,{dryRun:body.dryRun===true})
   :action==='link'?await link(ports,kind,personId,String(body.msUserId??''))
   :await provision(ports,kind,personId,{dryRun:body.dryRun===true,differentPerson:body.differentPerson===true,domain:typeof body.domain==='string'?body.domain.slice(0,100):undefined});
  return json(r.body,r.status);
 }catch{return json({error:'The request could not be completed. Retry.'},500);}
});
