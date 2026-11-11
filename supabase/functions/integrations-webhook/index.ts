import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { verifyStripeSignature } from '../_shared/integrations/signature.ts';
// Public provider endpoint; HMAC authentication replaces user JWT. Stores metadata only.
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
  if(saved.error?.code==='23505')return answer(200);
  return answer(saved.error?503:200);
 }catch{return answer(500);}
});
