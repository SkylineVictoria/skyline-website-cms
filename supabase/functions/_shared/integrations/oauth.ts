export const oauthProviders = ['docusign', 'microsoft365', 'xero'];
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

export type OAuthCredential = { version: 1; app?: OAuthApp; token?: OAuthToken };
export function parseOAuthCredential(secret: string): OAuthCredential {
 const value = JSON.parse(secret);
 return value?.version === 1 ? value : { version: 1, token: value };
}

export async function readOAuthCredential(connectionId: string, rpc: OAuthRpc): Promise<OAuthCredential> {
 const result = await rpc('integration_credential_read', { p_connection: connectionId, p_kind: 'api_key' });
 if (result.error) throw Error('credential_store_unavailable');
 return typeof result.data === 'string' ? parseOAuthCredential(result.data) : { version: 1 };
}

type Config = { authorize:string; token:string; scope:string; clientId:string; clientSecret:string; redirect:string; basic:boolean };
export function oauthConfig(provider:string, env: OAuthEnv, app?: OAuthApp):Config {
 const ds=(app?.environment ?? env('EF_DOCUSIGN_ENVIRONMENT'))==='production'?'account.docusign.com':'account-d.docusign.com';
 const providers:Record<string,{authorize:string;token:string;scope:string;basic:boolean}>={
  xero:{authorize:'https://login.xero.com/identity/connect/authorize',token:'https://identity.xero.com/connect/token',scope:'openid profile email offline_access accounting.settings.read',basic:true},
  microsoft365:{authorize:'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',token:'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',scope:'openid offline_access https://graph.microsoft.com/User.Read',basic:false},
  docusign:{authorize:`https://${ds}/oauth/auth`,token:`https://${ds}/oauth/token`,scope:'signature extended',basic:true}
 };
 const p=providers[provider];if(!p)throw Error('oauth_not_supported');
 const prefix=`EF_${provider.toUpperCase()}`;
 const clientId=app?.clientId ?? env(`${prefix}_CLIENT_ID`) ?? '';
 const clientSecret=app?.clientSecret ?? env(`${prefix}_CLIENT_SECRET`) ?? '';
 const redirect=oauthCallback(env);
 if(!clientId||!clientSecret)throw Error('oauth_configuration_missing');
 return {...p,clientId,clientSecret,redirect};
}
export async function stateHash(state:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(state)))).map(x=>x.toString(16).padStart(2,'0')).join('');}
export function authorizeUrl(c:Config,state:string){const u=new URL(c.authorize);u.search=new URLSearchParams({response_type:'code',client_id:c.clientId,redirect_uri:c.redirect,scope:c.scope,state}).toString();return u.toString();}
export async function exchange(c:Config,code:string){
 const body=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:c.redirect});
 const headers:Record<string,string>={'Content-Type':'application/x-www-form-urlencoded'};
 if(c.basic)headers.Authorization=`Basic ${btoa(c.clientId+':'+c.clientSecret)}`;else{body.set('client_id',c.clientId);body.set('client_secret',c.clientSecret);}
 const response=await fetch(c.token,{method:'POST',headers,body,signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!response.ok)throw Error('oauth_exchange_failed');
 const token=await response.json();
 if(typeof token.access_token!=='string')throw Error('oauth_exchange_failed');
 return {access_token:token.access_token,refresh_token:typeof token.refresh_token==='string'?token.refresh_token:null,expires_at:Date.now()+Number(token.expires_in??3600)*1000};
}

export type OAuthToken = { access_token:string; refresh_token:string|null; expires_at:number };
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
