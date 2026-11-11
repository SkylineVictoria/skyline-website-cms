export async function verifyStripeSignature(raw:string, header:string, secret:string, now=Date.now()):Promise<boolean>{
 const entries=header.split(',').map(x=>x.split('='));const timestamps=entries.filter(([k])=>k==='t');
 if(timestamps.length!==1||!/^\d+$/.test(timestamps[0][1]??''))return false;
 const timestamp=Number(timestamps[0][1]);if(Math.abs(now/1000-timestamp)>300)return false;
 const signatures=entries.filter(([k,v])=>k==='v1'&&/^[a-f0-9]{64}$/i.test(v)).map(([,v])=>Uint8Array.from(v.match(/../g)!.map(b=>parseInt(b,16))));
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 for(const signature of signatures)if(await crypto.subtle.verify('HMAC',key,signature,new TextEncoder().encode(`${timestamp}.${raw}`)))return true;
 return false;
}
