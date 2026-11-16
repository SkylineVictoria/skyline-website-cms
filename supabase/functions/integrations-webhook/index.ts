import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
// Public provider endpoint; HMAC authentication replaces user JWT. Stores event metadata, and applies payment events to public.payments
// (payment_apply_stripe: idempotent, so Stripe's retries leave a settled payment as it is). The signature check is inlined so the
// function deploys as one file; it is the same check as ../_shared/integrations/signature.ts.
const PAYMENT_EVENTS=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired','payment_intent.succeeded','payment_intent.payment_failed','charge.succeeded','charge.updated','charge.refunded'];
async function verifyStripeSignature(raw:string, header:string, secret:string, now=Date.now()):Promise<boolean>{
 const entries=header.split(',').map(x=>x.split('='));const timestamps=entries.filter(([k])=>k==='t');
 if(timestamps.length!==1||!/^\d+$/.test(timestamps[0][1]??''))return false;
 const timestamp=Number(timestamps[0][1]);if(Math.abs(now/1000-timestamp)>300)return false;
 const signatures=entries.filter(([k,v])=>k==='v1'&&/^[a-f0-9]{64}$/i.test(v)).map(([,v])=>Uint8Array.from(v.match(/../g)!.map(b=>parseInt(b,16))));
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 for(const signature of signatures)if(await crypto.subtle.verify('HMAC',key,signature,new TextEncoder().encode(`${timestamp}.${raw}`)))return true;
 return false;
}
Deno.serve(async(req:Request)=>{
 const answer=(status:number)=>new Response(JSON.stringify({received:status===200}),{status,headers:{'Content-Type':'application/json'}});
 if(req.method!=='POST')return answer(405);
 try{
  const id=new URL(req.url).searchParams.get('connection');
  if(!id||! /^[0-9a-f-]{36}$/i.test(id))return answer(400);
  if(Number(req.headers.get('content-length')??0)>1048576)return answer(413);
  const reader=req.body?.getReader();if(!reader)return answer(400);const chunks:Uint8Array[]=[];let length=0;
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>1048576){await reader.cancel();return answer(413);}chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const raw=new TextDecoder().decode(bytes);
  const db=createClient(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'',{auth:{persistSession:false}});
  const {data:c,error}=await db.from('integration_connections').select('id,status,connector_id,webhook_configured').eq('id',id).maybeSingle();
  if(error||!c||c.connector_id!=='stripe'||c.status==='disabled'||!c.webhook_configured)return answer(401);
  const secret=await db.rpc('integration_credential_read',{p_connection:id,p_kind:'webhook_secret'});
  if(secret.error||!secret.data||!await verifyStripeSignature(raw,req.headers.get('stripe-signature')??'',secret.data))return answer(401);
  const event=JSON.parse(raw);
  if(typeof event.id!=='string'||!/^evt_[A-Za-z0-9]+$/.test(event.id)||typeof event.type!=='string'||! /^[a-z0-9_.]{1,120}$/.test(event.type))return answer(400);
  const saved=await db.rpc('integration_receive_event',{p_connection:id,p_id:event.id,p_type:event.type});
  if(saved.error&&saved.error.code!=='23505')return answer(503);
  if(PAYMENT_EVENTS.includes(event.type)&&event.data?.object&&typeof event.data.object==='object'){
   // Idempotent: applying the same event twice leaves the payment as it is. A failure makes Stripe retry.
   const applied=await db.rpc('payment_apply_stripe',{p_connection:id,p_type:event.type,p_object:event.data.object});
   if(applied.error)return answer(503);
   await db.from('integration_webhook_events').update({status:'processed',verified_at:new Date().toISOString()}).eq('connection_id',id).eq('provider_event_id',event.id);
  }
  return answer(200);
 }catch{return answer(500);}
});
