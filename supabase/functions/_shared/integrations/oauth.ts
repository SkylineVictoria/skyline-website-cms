type Config = { authorize:string; token:string; scope:string; clientId:string; clientSecret:string; redirect:string; basic:boolean };
export function oauthConfig(provider:string, env:(name:string)=>string|undefined):Config {
 const ds=env('EF_DOCUSIGN_ENVIRONMENT')==='production'?'account.docusign.com':'account-d.docusign.com';
 const providers:Record<string,{authorize:string;token:string;scope:string;basic:boolean}>={
  xero:{authorize:'https://login.xero.com/identity/connect/authorize',token:'https://identity.xero.com/connect/token',scope:'openid profile email offline_access accounting.settings.read',basic:true},
  microsoft365:{authorize:'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',token:'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',scope:'openid offline_access https://graph.microsoft.com/User.Read',basic:false},
  docusign:{authorize:`https://${ds}/oauth/auth`,token:`https://${ds}/oauth/token`,scope:'signature extended',basic:true}
 };
 const p=providers[provider];if(!p)throw Error('oauth_not_supported');
 const prefix=`EF_${provider.toUpperCase()}`;
 const clientId=env(`${prefix}_CLIENT_ID`)??'',clientSecret=env(`${prefix}_CLIENT_SECRET`)??'',redirect=env('EF_INTEGRATIONS_OAUTH_REDIRECT_URI')??'';
 if(!clientId||!clientSecret||!/^https:\/\//.test(redirect)||new URL(redirect).pathname!=='/admin/integrations/credentials')throw Error('oauth_configuration_missing');
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
