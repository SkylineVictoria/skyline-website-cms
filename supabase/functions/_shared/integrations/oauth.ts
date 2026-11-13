export const oauthProviders = ['docusign', 'microsoft365', 'xero', 'calendly', 'stripe'];
const defaultCallback = 'https://skyline-website-cms.vercel.app/admin/integrations/credentials';
export type OAuthApp = { clientId: string; clientSecret: string; environment?: 'demo' | 'production' };
export type OAuthEnv = (name: string) => string | undefined;
export type OAuthRpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

export function oauthCallback(env: OAuthEnv) {
 const url = new URL(env('EF_INTEGRATIONS_OAUTH_REDIRECT_URI') || defaultCallback);
 if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/admin/integrations/credentials') {
  throw Error('oauth_callback_invalid');
 }
 return url.href;
}

/** Stored per connection. Legacy rows may still carry an `app` field; it is ignored. */
export type OAuthCredential = { version: 1; app?: OAuthApp; token?: OAuthToken };
export function parseOAuthCredential(secret: string): OAuthCredential {
 const value = JSON.parse(secret);
 return value?.version === 1 ? value : { version: 1, token: value };
}

export async function readOAuthCredential(connectionId: string, rpc: OAuthRpc): Promise<OAuthCredential> {
 const result = await rpc('integration_credential_read', { p_connection: connectionId, p_kind: 'api_key' });
 if (result.error) throw Error('credential_store_unavailable');
 return typeof result.data === 'string' && result.data.startsWith('{') ? parseOAuthCredential(result.data) : { version: 1 };
}

export type Config = { provider:string; authorize:string; token:string; scope:string; clientId:string; clientSecret:string; redirect:string; basic:boolean };
/** Skyline's one-time app registration per provider, read only from Edge Function secrets (EF_<PROVIDER>_CLIENT_ID / _CLIENT_SECRET). */
export function oauthConfig(provider:string, env: OAuthEnv):Config {
 const ds=env('EF_DOCUSIGN_ENVIRONMENT')==='production'?'account.docusign.com':'account-d.docusign.com';
 const providers:Record<string,{authorize:string;token:string;scope:string;basic:boolean}>={
  stripe:{authorize:'https://connect.stripe.com/oauth/authorize',token:'https://connect.stripe.com/oauth/token',scope:'read_only',basic:false},
  calendly:{authorize:'https://auth.calendly.com/oauth/authorize',token:'https://auth.calendly.com/oauth/token',scope:'users:read',basic:true},
  xero:{authorize:'https://login.xero.com/identity/connect/authorize',token:'https://identity.xero.com/connect/token',scope:'openid profile email offline_access accounting.settings.read',basic:true},
  microsoft365:{authorize:'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',token:'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',scope:'openid offline_access https://graph.microsoft.com/User.Read',basic:false},
  docusign:{authorize:`https://${ds}/oauth/auth`,token:`https://${ds}/oauth/token`,scope:'signature extended',basic:true}
 };
 const p=providers[provider];if(!p)throw Error('oauth_not_supported');
 const prefix=`EF_${provider.toUpperCase()}`;
 const clientId=env(`${prefix}_CLIENT_ID`) ?? '';
 const clientSecret=env(`${prefix}_CLIENT_SECRET`) ?? '';
 const redirect=oauthCallback(env);
 if(!clientId||!clientSecret)throw Error('oauth_configuration_missing');
 return {...p,provider,clientId,clientSecret,redirect};
}
export async function stateHash(state:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(state)))).map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function pkceChallenge(verifier:string) {
 const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
 return btoa(String.fromCharCode(...digest)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export function authorizeUrl(c:Config,state:string,challenge?:string){
 const u=new URL(c.authorize);
 u.search=new URLSearchParams({response_type:'code',client_id:c.clientId,redirect_uri:c.redirect,scope:c.scope,state}).toString();
 if(c.provider==='calendly'){
  if(!challenge)throw Error('pkce_required');
  u.searchParams.set('code_challenge',challenge);u.searchParams.set('code_challenge_method','S256');
 }
 return u.toString();
}
export async function exchange(c:Config,code:string,verifier?:string,request:typeof fetch=fetch){
 const body=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:c.redirect});
 const headers:Record<string,string>={'Content-Type':'application/x-www-form-urlencoded'};
 if(c.basic)headers.Authorization=`Basic ${btoa(c.clientId+':'+c.clientSecret)}`;else{body.set('client_id',c.clientId);body.set('client_secret',c.clientSecret);}
 if(c.provider==='calendly'){if(!verifier)throw Error('pkce_required');body.set('code_verifier',verifier);body.set('client_id',c.clientId);}
 const response=await request(c.token,{method:'POST',headers,body,signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!response.ok)throw Error('oauth_exchange_failed');
 const token=await response.json();
 if(c.provider==='stripe'){
  if(typeof token.stripe_user_id!=='string'||!/^acct_[a-zA-Z0-9]+$/.test(token.stripe_user_id))throw Error('oauth_exchange_failed');
  return {access_token:'',refresh_token:null,expires_at:0,stripe_account:token.stripe_user_id};
 }
 if(typeof token.access_token!=='string')throw Error('oauth_exchange_failed');
 return {access_token:token.access_token,refresh_token:typeof token.refresh_token==='string'?token.refresh_token:null,expires_at:Date.now()+Number(token.expires_in??3600)*1000};
}

export type OAuthToken = { access_token:string; refresh_token:string|null; expires_at:number; stripe_account?:string };
export async function refreshToken(c:Config, previous:OAuthToken, request:typeof fetch=fetch):Promise<OAuthToken> {
 if(!previous.refresh_token)throw Error('oauth_reconnect_required');
 const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:previous.refresh_token});
 const headers:Record<string,string>={'Content-Type':'application/x-www-form-urlencoded'};
 if(c.basic)headers.Authorization=`Basic ${btoa(c.clientId+':'+c.clientSecret)}`;else{body.set('client_id',c.clientId);body.set('client_secret',c.clientSecret);}
 const response=await request(c.token,{method:'POST',headers,body,signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!response.ok){await response.body?.cancel();throw Error(response.status===400||response.status===401?'oauth_reconnect_required':'oauth_refresh_unavailable');}
 const token=await response.json();
 if(typeof token.access_token!=='string'||!token.access_token||!Number.isFinite(Number(token.expires_in))||Number(token.expires_in)<=0)throw Error('oauth_refresh_invalid');
 return {access_token:token.access_token,refresh_token:typeof token.refresh_token==='string'?token.refresh_token:previous.refresh_token,expires_at:Date.now()+Number(token.expires_in)*1000};
}

/** Best-effort revocation at the provider on Disconnect. Microsoft 365 and DocuSign offer no token revocation API. */
export async function revokeAtProvider(c:Config, t:OAuthToken, request:typeof fetch=fetch):Promise<'revoked'|'revoke_failed'|'revoke_not_supported'> {
 try{
  let response:Response;
  if(c.provider==='xero'&&t.refresh_token){
   response=await request('https://identity.xero.com/connect/revocation',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:`Basic ${btoa(c.clientId+':'+c.clientSecret)}`},body:new URLSearchParams({token:t.refresh_token}),signal:AbortSignal.timeout(15000),redirect:'error'});
  }else if(c.provider==='calendly'&&t.access_token){
   response=await request('https://auth.calendly.com/oauth/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,token:t.refresh_token||t.access_token}),signal:AbortSignal.timeout(15000),redirect:'error'});
  }else if(c.provider==='stripe'&&t.stripe_account){
   response=await request('https://connect.stripe.com/oauth/deauthorize',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:`Bearer ${c.clientSecret}`},body:new URLSearchParams({client_id:c.clientId,stripe_user_id:t.stripe_account}),signal:AbortSignal.timeout(15000),redirect:'error'});
  }else return 'revoke_not_supported';
  await response.body?.cancel();
  return response.ok?'revoked':'revoke_failed';
 }catch{return 'revoke_failed';}
}
