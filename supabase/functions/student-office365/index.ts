// student-office365: creates a student's Office 365 mailbox on an administrator's request.
// Actions: state { studentId } -> account status for the student page; create { studentId } -> create/retry.
// Flow: admin check (student_o365_prepare, admin_business_require) -> app-only Microsoft Graph token (client credentials,
// Skyline's own Microsoft 365 tenant) -> free firstname.lastname@domain -> reserve it (student_o365_claim) -> create user with a
// temporary password (change at first sign-in) -> assign the student licence -> email login details to the student's personal
// address from Skyline's own mailbox (Graph sendMail, not saved to Sent Items) -> record the outcome (student_o365_finish).
// The temporary password is never stored or returned to the browser. A failed run can be retried: it resets the password,
// completes the licence and resends the email.
// Secrets: EF_MICROSOFT365_CLIENT_ID, EF_MICROSOFT365_CLIENT_SECRET, EF_MICROSOFT365_TENANT_ID, EF_MICROSOFT365_STUDENT_DOMAIN,
// EF_MICROSOFT365_WELCOME_SENDER; optional EF_MICROSOFT365_STUDENT_SKU (default STANDARDWOFFPACK_STUDENT = Office 365 A1 for
// students), EF_MICROSOFT365_USAGE_LOCATION (default AU).
// Microsoft app permissions (Application, admin consent): User.ReadWrite.All, LicenseAssignment.ReadWrite.All,
// Organization.Read.All, Mail.Send.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info, x-tenant-domain','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRAPH='https://graph.microsoft.com/v1.0';
const env=(n:string)=>(Deno.env.get(n)??'').trim();
const emailRe=/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const domainRe=/^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const messages:Record<string,string>={
 microsoft_not_configured:'Microsoft 365 is not set up for student emails yet. Add the Microsoft settings in Supabase secrets.',
 microsoft_auth_failed:'Skyline could not sign in to Microsoft 365. Check the app ID, secret and tenant ID.',
 microsoft_permission_missing:'The Skyline Microsoft app is missing a permission or admin consent.',
 licence_not_found:'Your Microsoft 365 has no Office 365 A1 for students licence.',
 no_licences_available:'No free student licences are left. Add more in the Microsoft 365 admin centre, then retry.',
 microsoft_rejected_user:'Microsoft 365 rejected the new account. Check the student domain is verified in Microsoft 365.',
 licence_assignment_failed:'The account was created but the licence could not be assigned. Retry.',
 welcome_email_failed:'The account was created but the login email could not be sent. Check the sender mailbox, then retry.',
 microsoft_unavailable:'Microsoft 365 could not be reached. Retry shortly.'
};
function slug(s:string){return s.normalize('NFKD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'');}
function localPart(fullName:string){const p=fullName.trim().split(/\s+/).map(slug).filter(Boolean);if(!p.length)return '';return (p.length===1?p[0]:`${p[0]}.${p[p.length-1]}`).slice(0,56).replace(/\.+$/,'');}
function names(fullName:string){const p=fullName.trim().split(/\s+/).filter(Boolean);return {given:p[0]??'',surname:p.length>1?p[p.length-1]:''};}
function tempPassword(){
 const sets=['ABCDEFGHJKLMNPQRSTUVWXYZ','abcdefghijkmnopqrstuvwxyz','23456789','!@#$%*?'];const all=sets.join('');
 const r=crypto.getRandomValues(new Uint32Array(32));const c=sets.map((s,i)=>s[r[i]%s.length]);
 for(let i=4;i<16;i++)c.push(all[r[i]%all.length]);
 for(let i=c.length-1;i>0;i--){const j=r[16+i]%(i+1);[c[i],c[j]]=[c[j],c[i]];}
 return c.join('');
}
function configured(){return !!(env('EF_MICROSOFT365_CLIENT_ID')&&env('EF_MICROSOFT365_CLIENT_SECRET')&&env('EF_MICROSOFT365_TENANT_ID')&&domainRe.test(env('EF_MICROSOFT365_STUDENT_DOMAIN').toLowerCase())&&emailRe.test(env('EF_MICROSOFT365_WELCOME_SENDER')));}
async function appToken(){
 const r=await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env('EF_MICROSOFT365_TENANT_ID'))}/oauth2/v2.0/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env('EF_MICROSOFT365_CLIENT_ID'),client_secret:env('EF_MICROSOFT365_CLIENT_SECRET'),grant_type:'client_credentials',scope:'https://graph.microsoft.com/.default'}),signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!r.ok){await r.body?.cancel();throw Error('microsoft_auth_failed');}
 const t=await r.json();if(typeof t.access_token!=='string')throw Error('microsoft_auth_failed');return t.access_token as string;
}
function graph(token:string,method:string,path:string,body?:unknown,extra:Record<string,string>={}){
 return fetch(GRAPH+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000),redirect:'error'});
}
function graphError(status:number,fallback:string){return status===401||status===403?'microsoft_permission_missing':status>=500||status===429?'microsoft_unavailable':fallback;}
async function addressTaken(token:string,upn:string){
 const a=await graph(token,'GET',`/users/${encodeURIComponent(upn)}?$select=id`);
 await a.body?.cancel();
 if(a.ok)return true;
 if(a.status!==404)throw Error(graphError(a.status,'microsoft_unavailable'));
 const filter=encodeURIComponent(`proxyAddresses/any(x:x eq 'smtp:${upn}')`);
 const b=await graph(token,'GET',`/users?$filter=${filter}&$count=true&$select=id`,undefined,{ConsistencyLevel:'eventual'});
 if(!b.ok){await b.body?.cancel();throw Error(graphError(b.status,'microsoft_unavailable'));}
 const v=await b.json();return Array.isArray(v.value)&&v.value.length>0;
}
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
  const action=String(body.action??''),studentId=String(body.studentId??'');
  if(!['state','create'].includes(action))return json({error:'Unknown action.'},400);
  if(!uuid.test(studentId))return json({error:'Select a student.'},400);
  const prep=await caller.rpc('student_o365_prepare',{p_student:studentId});
  if(prep.error)return json({error:prep.error.code==='42501'?'Administrator access required.':prep.error.code==='P0002'?'Student not found.':'Student could not be loaded.'},prep.error.code==='42501'?403:prep.error.code==='P0002'?404:500);
  const p=prep.data as {fullName:string;personalEmail:string|null;account:null|{email:string;status:string;lastError:string|null;welcomeSentAt:string|null;hasMicrosoftUser:boolean}};
  if(action==='state')return json({configured:configured(),account:p.account?{...p.account,message:p.account.lastError?messages[p.account.lastError]??null:null}:null});
  if(p.account?.status==='active')return json({error:'This student already has an Office 365 email.',email:p.account.email},409);
  const personal=String(p.personalEmail??'').trim();
  if(!emailRe.test(personal))return json({error:"Add the student's personal email first; the login details are sent there."},400);
  if(!configured())return json({error:messages.microsoft_not_configured,code:'microsoft_not_configured'},503);
  const domain=env('EF_MICROSOFT365_STUDENT_DOMAIN').toLowerCase(),sender=env('EF_MICROSOFT365_WELCOME_SENDER'),skuName=env('EF_MICROSOFT365_STUDENT_SKU')||'STANDARDWOFFPACK_STUDENT';
  let token:string;
  try{token=await appToken();}catch{return json({error:messages.microsoft_auth_failed,code:'microsoft_auth_failed'},502);}
  // Reserve the address (or resume the earlier failed attempt with its address).
  let claim:{upn:string;msUserId:string|null}|null=null;
  const claimErr=(e:{code?:string})=>json({error:e.code==='23505'?'This student already has an Office 365 email.':e.code==='55P03'?'Creation is already in progress. Wait a moment and reload.':'The address could not be reserved.'},409);
  if(p.account){
   const c=await caller.rpc('student_o365_claim',{p_student:studentId,p_upn:p.account.email});if(c.error)return claimErr(c.error);claim=c.data;
  }else{
   const base=localPart(p.fullName??'');
   if(!base)return json({error:"The student's name has no letters that can be used in an email address. Edit the name first."},400);
   for(let n=1;n<=30&&!claim;n++){
    const upn=`${n===1?base:base+n}@${domain}`;
    try{if(await addressTaken(token,upn))continue;}catch(e){const code=e instanceof Error?e.message:'microsoft_unavailable';return json({error:messages[code]??messages.microsoft_unavailable,code},502);}
    const c=await caller.rpc('student_o365_claim',{p_student:studentId,p_upn:upn});if(c.error)return claimErr(c.error);
    if(!c.data?.conflict)claim=c.data;
   }
   if(!claim)return json({error:'No free email address was found for this name.'},409);
  }
  const upn=claim!.upn;let msUser=claim!.msUserId;let welcome=false;
  try{
   const skus=await graph(token,'GET','/subscribedSkus?$select=skuId,skuPartNumber,prepaidUnits,consumedUnits');
   if(!skus.ok){await skus.body?.cancel();throw Error(graphError(skus.status,'microsoft_unavailable'));}
   const sku=((await skus.json()).value??[]).find((s:{skuPartNumber:string})=>s.skuPartNumber===skuName);
   if(!sku)throw Error('licence_not_found');
   const password=tempPassword(),nm=names(p.fullName);
   const usage=env('EF_MICROSOFT365_USAGE_LOCATION')||'AU';
   if(!msUser){
    const r=await graph(token,'POST','/users',{accountEnabled:true,displayName:p.fullName.trim().slice(0,256),...(nm.given?{givenName:nm.given.slice(0,64)}:{}),...(nm.surname?{surname:nm.surname.slice(0,64)}:{}),mailNickname:upn.split('@')[0],userPrincipalName:upn,usageLocation:usage,passwordProfile:{forceChangePasswordNextSignIn:true,password}});
    if(!r.ok){await r.body?.cancel();throw Error(graphError(r.status,'microsoft_rejected_user'));}
    msUser=(await r.json()).id;
   }else{
    const r=await graph(token,'PATCH',`/users/${encodeURIComponent(msUser)}`,{accountEnabled:true,usageLocation:usage,passwordProfile:{forceChangePasswordNextSignIn:true,password}});
    await r.body?.cancel();if(!r.ok)throw Error(graphError(r.status,'microsoft_rejected_user'));
   }
   const has=await graph(token,'GET',`/users/${encodeURIComponent(msUser!)}/licenseDetails?$select=skuId`);
   if(!has.ok){await has.body?.cancel();throw Error(graphError(has.status,'microsoft_unavailable'));}
   const assigned=((await has.json()).value??[]).some((l:{skuId:string})=>l.skuId===sku.skuId);
   if(!assigned){
    if(Number(sku.prepaidUnits?.enabled??0)-Number(sku.consumedUnits??0)<=0)throw Error('no_licences_available');
    const r=await graph(token,'POST',`/users/${encodeURIComponent(msUser!)}/assignLicense`,{addLicenses:[{skuId:sku.skuId,disabledPlans:[]}],removeLicenses:[]});
    await r.body?.cancel();if(!r.ok)throw Error(graphError(r.status,'licence_assignment_failed'));
   }
   const content=`Hello ${nm.given||'there'},\n\nYour student email account has been created.\n\nEmail: ${upn}\nTemporary password: ${password}\n\nSign in at https://www.office.com. You will be asked to choose a new password the first time you sign in.\n\nIf you did not expect this email, please contact us.`;
   const m=await graph(token,'POST',`/users/${encodeURIComponent(sender)}/sendMail`,{message:{subject:'Your student email account',body:{contentType:'Text',content},toRecipients:[{emailAddress:{address:personal}}]},saveToSentItems:false});
   await m.body?.cancel();
   if(m.status!==202)throw Error('welcome_email_failed');
   welcome=true;
   const f=await caller.rpc('student_o365_finish',{p_student:studentId,p_ms_user:msUser,p_ok:true,p_error:null,p_sku:skuName,p_welcome:true});
   if(f.error)return json({ok:true,email:upn,welcomeSent:true,warning:'Created, but the result could not be recorded. Reload the student.'});
   return json({ok:true,email:upn,welcomeSent:true});
  }catch(e){
   const raw=e instanceof Error?e.message:'';const code=/^[a-z_]{1,60}$/.test(raw)&&messages[raw]?raw:'microsoft_unavailable';
   await caller.rpc('student_o365_finish',{p_student:studentId,p_ms_user:msUser??'',p_ok:false,p_error:code,p_sku:'',p_welcome:welcome});
   return json({error:messages[code],code,email:upn,canRetry:true},code==='microsoft_unavailable'?502:409);
  }
 }catch{return json({error:'The request could not be completed. Retry.'},500);}
});
