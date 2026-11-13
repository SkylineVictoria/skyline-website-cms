import { oauthConfig,oauthProviders,parseOAuthCredential,refreshToken } from './oauth.ts';
type Rpc = (name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:unknown}>;
/** Internal server-only accessor. Serialized refresh and version fencing prevent stale writes after revoke/disable. */
export async function accessToken(connection:{id:string;connector_id:string;updated_at:string},rpc:Rpc,env:(key:string)=>string|undefined,request:typeof fetch=fetch):Promise<{token:string;version:string;docusignProduction?:boolean;stripeAccount?:string}> {
 const saved=await rpc('integration_credential_read',{p_connection:connection.id,p_kind:'api_key'});
 if(saved.error)throw Error('credential_store_unavailable');
 if(!saved.data)return {token:'',version:connection.updated_at};
 if(!oauthProviders.includes(connection.connector_id) || (connection.connector_id==='stripe' && !String(saved.data).startsWith('{')))return {token:String(saved.data),version:connection.updated_at};
 let stored;
 try{stored=parseOAuthCredential(String(saved.data));}catch{throw Error('oauth_reconnect_required');}
 const {token}=stored;
 const docusignProduction=connection.connector_id==='docusign' && env('EF_DOCUSIGN_ENVIRONMENT')==='production';
 if(!token)return {token:'',version:connection.updated_at,docusignProduction};
 if(connection.connector_id==='stripe'&&token.stripe_account){
  if(!/^acct_[a-zA-Z0-9]+$/.test(token.stripe_account))throw Error('oauth_reconnect_required');
  const config=oauthConfig('stripe',env);
  return {token:config.clientSecret,version:connection.updated_at,stripeAccount:token.stripe_account};
 }
 if(typeof token.access_token!=='string'||!Number.isFinite(token.expires_at))throw Error('oauth_reconnect_required');
 if(token.expires_at>Date.now()+60000)return {token:token.access_token,version:connection.updated_at,docusignProduction};
 const config=oauthConfig(connection.connector_id,env);
 const claim=await rpc('integration_refresh_claim',{p_connection:connection.id,p_version:connection.updated_at});
 if(claim.error||typeof claim.data!=='string')throw Error('oauth_refresh_busy');
 try{
  const next=await refreshToken(config,token,request);
  const finished=await rpc('integration_refresh_finish',{p_connection:connection.id,p_lease:claim.data,p_secret:JSON.stringify({version:1,token:next})});
  if(finished.error||typeof finished.data!=='string')throw Error('connection_changed');
  return {token:next.access_token,version:finished.data,docusignProduction};
 }catch(error){await rpc('integration_refresh_finish',{p_connection:connection.id,p_lease:claim.data,p_secret:null});throw error;}
}
